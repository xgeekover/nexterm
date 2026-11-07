/**
 * The page's half of the local control API (stage 7, spec D4–D6): what a
 * `control-request` from the backend does, and the answer it gets.
 *
 * The backend has checked the token, the frame, its size and the caller's
 * rate (src-tauri/src/control/) and hands over `{ id, session_id, cmd, args,
 * other_terminals, type_and_read }` — never the token. The page then:
 *
 *   1. finds the calling terminal by its shell's session — one this page
 *      does not hold is `unauthorized`;
 *   2. checks the command and its arguments (`validateRequest`) and what the
 *      settings allow (`checkPolicy`): typing and reading are `disabled`
 *      without their setting, even for the caller itself;
 *   3. resolves the target (`resolveTarget`): the caller, a terminal it
 *      opened with `new-split`, or — with "control other terminals" on —
 *      any terminal of this window;
 *   4. carries it out through the store's own paths, so every rule a
 *      terminal already has holds for a program too: a notification is
 *      rate-limited and routed as an OSC 9 is, a key goes through `writeRaw`
 *      and never into a password prompt, a split inherits as a split does;
 *   5. answers with `control_reply { id, ok, result, error }` — ALWAYS, and
 *      within REPLY_BUDGET_MS: the backend gives up after 3 s and says
 *      "not responding", and a handler that threw or hung must not leave a
 *      CLI waiting for that. Whatever goes wrong becomes an error code.
 *
 * Seen and logged (D6): a terminal a program acts on — `send`,
 * `read-screen`, `focus`, a split it opens; its own terminal too for `send`
 * and `focus` (`SEEN`) — has its pane's ring flashed and its tab chip
 * marked for 10 s naming the caller (`noteControlled`); every call goes into
 * an in-memory log of the last 500 (src/stores/controlLogStore.js) — what
 * was asked of whom and the answer's code, never what was typed or read.
 *
 * Bounded (review rounds 2 and 3): `focus` never moves the keyboard or
 * switches terminals — it points, at most every 5 s; `send` needs a shown
 * terminal (its prompt is read) and cannot finish an escape sequence the
 * last send began; splits a program opened, at most 8 open per caller and
 * 32 in all, 10 a minute, closed again when made too late; desktop
 * notifications from the API and from the terminals it opened, 10 a minute
 * in all; a terminal's notifications share one allowance with its OSC
 * ones; nothing is carried out past the request's `deadline_at`.
 *
 * Children: the terminals a caller opened with `new-split`, by the SESSION
 * that opened them — the shell whose token asked. A restarted shell is a
 * new session with a new token, and a program in it has not opened them.
 *
 * Nothing here imports xterm: the registry's pieces are handed in
 * (src/lib/controlBridge.js wires the real ones), so the suites drive this
 * with `@xterm/headless` and the browser mock.
 */
import { invoke as ipcInvoke, isTauri } from './ipc.js';
import { CONTROL_ERROR, checkPolicy, cleanStatusText, resolveTarget, validateRequest } from './controlScope.js';
import { encodeKeys, encodeText } from './controlKeys.js';
import { createRateLimiter, makeNote, windowAttention } from './programNotifications.js';
import { readScreen, secretPromptOnScreen } from './controlScreen.js';
import { sanitizeStartupCommand } from './startupCommands.js';
import { isNetworkPath } from './terminalLinks.js';
import { expandHome } from './paths.js';
import { agentRuns, terminalStatus } from './terminalStatus.js';
import { unreadCountByTab } from './attention.js';
import { utf8Length } from './scrollbackSnapshot.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useSystemStore } from '../stores/systemStore.js';
import { useControlLogStore } from '../stores/controlLogStore.js';

/**
 * How long a request may take on the page before it is answered as not
 * responding: inside the backend's 3 s, so the answer is the page's own and
 * reaches the CLI before the backend gives up on it.
 */
export const REPLY_BUDGET_MS = 2500;

/** The most terminals `list` returns (spec D4). */
export const LIST_MAX = 200;

/** The event the backend hands a request over with, and the command that answers it (spec D3). */
export const CONTROL_REQUEST_EVENT = 'control-request';
export const CONTROL_REPLY_COMMAND = 'control_reply';
export const CONTROL_SETTINGS_COMMAND = 'control_set_settings';

const { BAD_REQUEST, UNAUTHORIZED, DISABLED, NOT_FOUND, REFUSED, RATE_LIMITED, NOT_RENDERED, NOT_RESPONDING, INTERNAL } = CONTROL_ERROR;

const fail = (code, message) => ({ error: { code, message } });

/** What a request past its deadline is answered — and logged — with: nothing was done. */
const LATE = Object.freeze(fail(NOT_RESPONDING, 'NexTerm took too long: nothing was done'));

/** `{ answered: true, value }` once `promise` settles with a value; `{ answered: false }` if it rejects or takes longer than `ms`. */
function askWithin(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ answered: true, value }),
      () => ({ answered: false })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ answered: false }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The commands whose target is seen (D6): its pane's ring flashes and its
 * chip is marked, naming the caller. For another terminal, every one of
 * them — a split a program opens included; for the caller's own terminal,
 * `send` and `focus` too (review F2, F3): a program typing into the very
 * terminal the user may be typing in, or asking to be looked at, is shown.
 * A program reading its own screen is not news.
 */
const SEEN = new Set(['send', 'read-screen', 'focus', 'new-split']);
const SEEN_ON_SELF = new Set(['send', 'focus']);

/**
 * How far one terminal's programs may fan out (review F4): terminals opened
 * with `new-split` still open, per calling shell and in all, and new splits
 * a minute per terminal. A runaway loop of `new-split` stops at these,
 * rather than at the machine's process limit.
 */
export const CHILDREN_MAX = 8;
export const OPENED_MAX = 32;
export const SPLITS_PER_MINUTE = 10;

/** `focus` from one terminal at most once in this long (review F2). */
export const FOCUS_INTERVAL_MS = 5000;

/**
 * Desktop notifications from `nexterm-cli notify` across all terminals, a
 * minute (review F4): each terminal has stage 1's allowance, and many
 * terminals' programs together must not bury the desktop. Past it a note
 * is still listed in the bell.
 */
export const API_DESKTOP_PER_MINUTE = 10;

/**
 * How long after a `send` that ended in a bare ESC the next one to the same
 * terminal is read as following it (re-verification F5): a program reads
 * ESC and what comes right after it as one sequence, so `send --keys
 * Escape` and then `send "[201~"` would spell an end of paste between them.
 */
export const ESCAPE_JOIN_MS = 1000;

/** How long the backend is given to say who owns a terminal's foreground; past it `send` is refused. */
export const FOREGROUND_ASK_MS = 500;

const monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Every leaf (pane) of a group's split tree, in order. */
function leavesOf(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else for (const child of node.children || []) leavesOf(child, acc);
  return acc;
}

/** Where `tabId` is placed: `{ group, paneId }`, or null for a tab in no pane. */
function placeOf(state, tabId) {
  for (const group of state.groups || []) {
    for (const leaf of leavesOf(group.tree)) {
      if (Array.isArray(leaf.tabIds) && leaf.tabIds.includes(tabId)) return { group, paneId: leaf.id };
    }
  }
  return null;
}

/** A terminal's name as the UI shows it. */
const titleOf = (tab) => (tab ? tab.title || tab.defaultTitle || 'Terminal' : '');

/** A path in an error message: the caller's own text, but short and on one line. */
const shown = (path) => {
  const one = String(path).replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}]/gu, '?');
  return one.length > 120 ? `${one.slice(0, 119)}\u{2026}` : one;
};

/** Absolute on either family of systems: `/…`, `C:\…` or `C:/…`. */
const isAbsolutePath = (path) => /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);

/**
 * What the settings allow for one request: the page's own setting AND what
 * the backend said with the request. They agree but for the moment a setting
 * is being changed, and in that moment the stricter one is right.
 */
function allowed(settings, payload) {
  return {
    enabled: settings.terminalControl !== false,
    typeAndRead: settings.terminalControlTypeAndRead === true && payload.type_and_read === true,
    otherTerminals: settings.terminalControlOtherTerminals === true && payload.other_terminals === true,
  };
}

/**
 * Settle `work` within `ms`, or answer that NexTerm took too long.
 *
 * `ctx` is the request's: when the time is up, `ctx.gaveUp` is set — from
 * then on the work's `late()` says so whatever the clock reads, as the timer
 * can fire at the very millisecond of the deadline (re-verification round 4:
 * a split resolving then was answered "not responding" and still made). A
 * request that has already committed to its act (`ctx.committed`: the keys
 * are being written, the split is being kept) is waited for instead: its
 * answer is what was done.
 */
function withinBudget(work, ms, ctx) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (ctx.committed) return;
      ctx.gaveUp = true;
      resolve(fail(NOT_RESPONDING, 'NexTerm took too long to carry this out'));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Ask the OS to draw the user to the window — a Dock bounce, a taskbar flash — without raising it (spec Q4). */
async function requestWindowAttention() {
  if (!isTauri()) return false;
  const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
  await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  return true;
}

/**
 * The dispatcher. Every dependency has the app's own default but those the
 * registry would supply (`readTerminal`, `modesOf`), which are handed in by
 * src/lib/controlBridge.js — without them no terminal reads as shown.
 *
 *   store            the terminal store
 *   settings         the settings store
 *   invoke           the backend (`fs_dir_exists`)
 *   reply(message)   sends the answer (`control_reply`)
 *   readTerminal(id) a Promise of the tab's xterm once it has read its output, or null
 *   modesOf(id)      the tab's key modes (`terminalModes`), or null
 *   attention()      the window's `{ focused, visible }`
 *   requestAttention() ask for the user's attention without raising the window
 *   log(entry)       keep one call (`useControlLogStore.record`)
 *   homeDir()        for a `~` in `new-split --cwd`
 *   clock()          monotonic, for the notification rate limit
 */
export function createControlDispatcher({
  store = useTerminalStore,
  settings = useSettingsStore,
  invoke = ipcInvoke,
  reply = (message) => ipcInvoke(CONTROL_REPLY_COMMAND, message),
  readTerminal = async () => null,
  modesOf = () => null,
  attention = () => windowAttention(),
  requestAttention = requestWindowAttention,
  log = (entry) => useControlLogStore.getState().record(entry),
  homeDir = () => useSystemStore.getState().homeDir ?? null,
  clock = monotonicNow,
  budgetMs = REPLY_BUDGET_MS,
  typingWaitMs,
} = {}) {
  /** session id of the shell that asked -> the tab ids it opened with `new-split`. */
  const childrenBySession = new Map();
  /** Every tab opened with `new-split` that is still open, whoever opened it (OPENED_MAX). */
  const openedByApi = new Set();
  /** target tab id -> when the last `send` to it ended in a bare ESC (ESCAPE_JOIN_MS). */
  const escapeAt = new Map();
  /** caller tab id -> its `new-split` and `focus` rate limits. */
  const splitLimiters = new Map();
  const focusLimiters = new Map();
  /** Desktop notifications from the API, all terminals together (API_DESKTOP_PER_MINUTE). */
  const desktopLimiter = createRateLimiter({ intervalMs: 0, perMinute: API_DESKTOP_PER_MINUTE });

  /** `map`'s limiter for `tabId`, made on first use with `options`. */
  const limiterIn = (map, tabId, options) => {
    let limiter = map.get(tabId);
    if (!limiter) {
      limiter = createRateLimiter(options);
      map.set(tabId, limiter);
    }
    return limiter;
  };

  const childrenOf = (sessionId) => childrenBySession.get(sessionId) ?? new Set();

  /**
   * Forget what is kept about terminals and shells that are gone: a child
   * that closed, a caller whose shell ended. Run on every change to the
   * tabs (controlBridge.js) and before every request, so a closed terminal's
   * id handed out again later is nobody's child.
   */
  const prune = (state = store.getState()) => {
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const live = new Set(tabs.map((t) => t.id));
    const sessions = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
    for (const [sessionId, kids] of childrenBySession) {
      if (!sessions.has(sessionId)) {
        childrenBySession.delete(sessionId);
        continue;
      }
      for (const id of kids) if (!live.has(id)) kids.delete(id);
    }
    for (const id of openedByApi) if (!live.has(id)) openedByApi.delete(id);
    for (const map of [splitLimiters, focusLimiters, escapeAt]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
  };

  const target = (caller, wanted, scope) =>
    resolveTarget({
      tabs: store.getState().tabs,
      callerTabId: caller.id,
      target: wanted,
      children: new Map([[caller.id, childrenOf(caller.sessionId)]]),
      otherTerminals: scope.otherTerminals,
    });

  /** The caller acted on a terminal: its ring flashes and its chip is marked, naming the caller (D6, `SEEN`). */
  const seen = (tabId, caller, cmd) => {
    if (!SEEN.has(cmd) || (tabId === caller.id && !SEEN_ON_SELF.has(cmd))) return;
    try {
      store.getState().noteControlled?.(tabId, { by: caller.id, cmd });
    } catch (err) {
      console.warn('[control] could not mark the terminal as controlled:', err);
    }
  };

  /** Aim at `args.target`, and say who it is in the log. */
  const aim = (caller, args, scope, entry) => {
    const resolved = target(caller, args.target, scope);
    if (resolved.error) return resolved;
    entry.target = resolved.self ? 'self' : resolved.tabId;
    entry.targetTitle = titleOf(store.getState().tabs.find((t) => t.id === resolved.tabId));
    return resolved;
  };

  /**
   * A folder a new split may start in, or `{ error }`: `~` expanded, never on
   * another machine (starting a shell there signs in to it, as everywhere
   * else in NexTerm), absolute — a relative one would be relative to a
   * folder the caller cannot see — and one the backend itself would start a
   * shell in (`fs_dir_exists`, the spawn's own check).
   */
  const startFolder = async (raw) => {
    const path = expandHome(raw.trim(), homeDir());
    if (isNetworkPath(path)) return fail(REFUSED, `new-split: ${shown(path)} is on another machine, and a terminal never starts in one`);
    if (!isAbsolutePath(path)) return fail(BAD_REQUEST, 'new-split: cwd must be an absolute path, or start with ~');
    let exists = false;
    try {
      exists = (await invoke('fs_dir_exists', { path })) === true;
    } catch {
      exists = false;
    }
    if (!exists) return fail(NOT_FOUND, `new-split: no folder ${shown(path)} a terminal can start in`);
    return { cwd: path };
  };

  const HANDLERS = {
    notify: ({ caller, args }) => {
      if (settings.getState().terminalProgramNotifications === false) {
        return fail(DISABLED, 'Notifications from Programs is off (Settings ▸ Terminal)');
      }
      const note = makeNote(args.title, args.body ?? '', args.occasion ?? 'always');
      if (!note) return fail(BAD_REQUEST, 'notify: nothing is left to show once control characters are removed');
      // The terminal's one allowance, which what its program prints as OSC
      // 9, 99 or 777 counts against too (integration review 6).
      if (!store.getState().allowProgramNote(caller.id, clock())) {
        return fail(RATE_LIMITED, 'a terminal may notify at most once every 2 seconds, and 10 times a minute');
      }
      const route = store.getState().notifyFromProgram(caller.id, note, undefined, {
        allowDesktop: () => desktopLimiter.allow(clock()),
      });
      return { result: { listed: Boolean(route?.inApp), desktop: Boolean(route?.desktop) } };
    },

    'set-status': ({ caller, args }) => {
      if (args.text === null) {
        store.getState().setReportedStatus(caller.id, null);
        return { result: { text: null } };
      }
      const text = cleanStatusText(args.text);
      if (!text) return fail(BAD_REQUEST, 'set-status: nothing is left to show once control characters are removed');
      const tone = args.tone ?? 'info';
      store.getState().setReportedStatus(caller.id, { text, tone });
      return { result: { text, tone } };
    },

    'set-progress': ({ caller, args }) => {
      if (settings.getState().terminalProgress === false) return fail(DISABLED, 'Progress Bars is off (Settings ▸ Terminal)');
      store.getState().setTabProgress(caller.id, { state: args.state, value: args.value ?? null });
      return { result: { state: args.state, value: args.value ?? null } };
    },

    list: ({ caller }) => {
      const state = store.getState();
      const kids = childrenOf(caller.sessionId);
      const unread = unreadCountByTab(state.notifications);
      const byId = new Map(state.tabs.map((t) => [t.id, t]));
      // In the order the window shows them: group by group, pane by pane,
      // tab by tab — then any tab in no pane (one still being placed).
      const groupOf = new Map();
      const order = [];
      for (const group of state.groups || []) {
        for (const leaf of leavesOf(group.tree)) {
          for (const id of leaf.tabIds || []) {
            if (groupOf.has(id) || !byId.has(id)) continue;
            groupOf.set(id, group);
            order.push(id);
          }
        }
      }
      for (const tab of state.tabs) if (!groupOf.has(tab.id)) order.push(tab.id);
      const rows = order.slice(0, LIST_MAX).map((id) => {
        const tab = byId.get(id);
        return {
          id,
          title: titleOf(tab),
          cwd: typeof tab.cwd === 'string' ? tab.cwd : null,
          group: groupOf.get(id)?.name ?? null,
          active: state.activeTabId === id,
          agent: agentRuns(tab) ? tab.agent.kind : null,
          status: terminalStatus(tab, { unread: unread[id] ?? 0, progress: state.progress?.[id] ?? null }).state,
          self: id === caller.id,
          child: kids.has(id),
        };
      });
      return { result: rows };
    },

    'new-split': async ({ caller, args, entry, late, commit }) => {
      const place = placeOf(store.getState(), caller.id);
      if (!place) return fail(REFUSED, 'the calling terminal is in no pane to split beside');
      if (childrenOf(caller.sessionId).size >= CHILDREN_MAX) {
        return fail(REFUSED, `this terminal's programs have ${CHILDREN_MAX} splits open already: close one first`);
      }
      if (openedByApi.size >= OPENED_MAX) {
        return fail(REFUSED, `programs have ${OPENED_MAX} terminals open already: close some first`);
      }
      if (!limiterIn(splitLimiters, caller.id, { intervalMs: 0, perMinute: SPLITS_PER_MINUTE }).allow(clock())) {
        return fail(RATE_LIMITED, `a terminal may open at most ${SPLITS_PER_MINUTE} splits a minute`);
      }
      let cwd = null;
      if (args.cwd !== undefined) {
        const folder = await startFolder(args.cwd);
        if (folder.error) return folder;
        cwd = folder.cwd;
      }
      let command = null;
      if (args.command !== undefined) {
        const cleaned = sanitizeStartupCommand(args.command);
        if (!cleaned.ok) return fail(BAD_REQUEST, `new-split: ${cleaned.reason}`);
        if (!cleaned.command) return fail(BAD_REQUEST, 'new-split: the command is empty once control characters are removed');
        command = cleaned.command;
      }
      if (late()) return LATE;
      const direction = args.direction === 'down' ? 'vertical' : 'horizontal';
      // Beside the caller's pane, and continuing the CALLER — its folder and
      // its shell — not whichever tab its pane happens to show (integration
      // review 3): the program asked from its own terminal.
      const paneId = await store.getState().splitPane(place.paneId, direction, place.group.id, { cwd, sourceTabId: caller.id });
      const made = paneId
        ? (store.getState().groups || []).flatMap((g) => leavesOf(g.tree)).find((leaf) => leaf.id === paneId)
        : null;
      const tabId = made?.activeTabId ?? null;
      if (!tabId) return fail(INTERNAL, 'the new terminal could not be started');
      // Starting a shell can take seconds (re-verification F4). Done after
      // the caller stopped waiting, the split is closed again and its
      // command never typed: the caller has been told nothing was done.
      if (!commit()) {
        Promise.resolve(store.getState().closeTab?.(tabId)).catch((err) =>
          console.warn('[control] could not close a split made too late:', err)
        );
        return LATE;
      }
      // The caller's child from now on — recorded before anything else can
      // fail, so a split that exists is always one the caller can drive.
      if (!childrenBySession.has(caller.sessionId)) childrenBySession.set(caller.sessionId, new Set());
      childrenBySession.get(caller.sessionId).add(tabId);
      openedByApi.add(tabId);
      entry.target = tabId;
      entry.targetTitle = titleOf(store.getState().tabs.find((t) => t.id === tabId));
      // Marked as the caller's doing, as every terminal a program acts on is.
      seen(tabId, caller, 'new-split');
      // Typed as a startup command is (stage 5): once the new shell has drawn
      // its first prompt, never into a password prompt, the terminal saying
      // why when it cannot be. That wait is up to 3 s, past the answer's own
      // budget, so the answer does not wait for it. The keyboard stays where
      // the user has it: a split a program opens must not take the keys the
      // user is typing into another terminal.
      if (command) {
        Promise.resolve(store.getState().typeStartupCommand(tabId, command)).catch((err) =>
          console.warn('[control] could not type the new split\'s command:', err)
        );
      }
      const tab = store.getState().tabs.find((t) => t.id === tabId);
      return { result: { id: tabId, cwd: tab?.cwd ?? null, typing: Boolean(command) } };
    },

    send: async ({ caller, args, scope, entry, commit }) => {
      const aimed = aim(caller, args, scope, entry);
      if (aimed.error) return aimed;
      const tab = store.getState().tabs.find((t) => t.id === aimed.tabId);
      if (!tab) return fail(NOT_FOUND, `no terminal ${aimed.tabId}`);
      if (tab.exited) return fail(REFUSED, 'the shell in that terminal has exited');
      // Encoded for the TARGET's modes, as its program set them — read once
      // its xterm has caught up with its output.
      const term = await readTerminal(aimed.tabId);
      // A terminal never shown has no xterm: nothing reads what it asks for,
      // so nothing could see a password prompt there — and on Windows the
      // screen is the only way to (re-verification F3). Shown once, it can.
      if (!term) return fail(NOT_RENDERED, 'that terminal has not been shown yet, so what it is asking for cannot be checked — open that terminal once first');
      const modes = { applicationCursorKeys: false, bracketedPaste: false, modifyOtherKeys: 0, ...(modesOf(aimed.tabId) ?? {}) };
      let data = '';
      // Whether the last thing sent here ended in a bare ESC a moment ago:
      // this send must not finish the sequence it began (`ESCAPE_JOIN_MS`).
      let afterEscape = clock() - (escapeAt.get(aimed.tabId) ?? -Infinity) < ESCAPE_JOIN_MS;
      if (args.text !== undefined) {
        const text = encodeText(args.text, { bracketedPaste: modes.bracketedPaste, raw: args.raw === true, afterEscape });
        if (text.error) return text;
        data += text.data;
        // Text never holds an ESC (encodeText refuses one).
        afterEscape = false;
      }
      if (args.keys !== undefined) {
        const keys = encodeKeys(args.keys, modes, { afterEscape });
        if (keys.error) return keys;
        data += keys.data;
        afterEscape = keys.endsWithEscape === true;
      }
      entry.size = utf8Length(data);
      seen(aimed.tabId, caller, 'send');
      const outcome = await store.getState().typeForProgram(aimed.tabId, data, {
        ...(typingWaitMs === undefined ? {} : { waitMs: typingWaitMs }),
        // Who runs in the foreground (review F3): a `sudo` or `su` there runs
        // as another user, and what is typed is theirs — a root shell's
        // command line. The backend can tell on macOS and Linux; its `null`
        // (Windows: it cannot tell) is no word, and the rest decides. No
        // answer at all — an error, or none within FOREGROUND_ASK_MS — is
        // refused: a security check that could not be made fails closed.
        ask: async () => {
          const owner = await askWithin(invoke('pty_foreground_owner', { session_id: tab.sessionId }), FOREGROUND_ASK_MS);
          if (!owner.answered) return 'could not check what runs in that terminal; try again';
          return owner.value?.same_user === false
            ? 'something running as another user (sudo, su) is in the foreground of that terminal: nothing was typed'
            : null;
        },
        // The prompt on screen (review F8): a password prompt says so in
        // words even where the terminal's echo cannot be read — and on
        // Windows, where the backend reports no hidden typing at all, this
        // is all there is. Read last, right before the keys go.
        check: () =>
          secretPromptOnScreen(term)
            ? 'that terminal shows a password prompt: nothing was typed'
            : null,
        commit,
      });
      if (outcome?.status === 'typed') {
        if (afterEscape) escapeAt.set(aimed.tabId, clock());
        else escapeAt.delete(aimed.tabId);
      }
      switch (outcome?.status) {
        case 'typed':
          return { result: { bytes: entry.size } };
        case 'hidden':
          return fail(REFUSED, 'that terminal is asking for a password, and typing there is hidden: nothing was typed');
        case 'starting':
          return fail(REFUSED, 'the shell in that terminal has not drawn its first prompt yet: nothing was typed — try again in a moment');
        case 'exited':
          return fail(REFUSED, 'the shell in that terminal has exited');
        case 'refused':
          return fail(REFUSED, outcome.reason);
        case 'late':
          return LATE;
        default:
          return fail(NOT_FOUND, `no terminal ${aimed.tabId}`);
      }
    },

    'read-screen': async ({ caller, args, scope, entry }) => {
      const aimed = aim(caller, args, scope, entry);
      if (aimed.error) return aimed;
      const term = await readTerminal(aimed.tabId);
      if (!term) return fail(NOT_RENDERED, 'that terminal has not been shown yet, so it has no screen to read — open that terminal once first');
      seen(aimed.tabId, caller, 'read-screen');
      const screen = readScreen(term, { lines: args.lines ?? 0, mask: args.mask !== false });
      entry.lines = screen.lines.length;
      return { result: screen };
    },

    /**
     * `focus` (spec D4; review F2, re-verification F1): point the user at a
     * terminal — and NOTHING more. It never switches group, pane or tab, in
     * any state of the window: a program that could move the keyboard could
     * wait for the user to step away (to fetch a password, say) and have
     * what they type on their return land in its own terminal. The target's
     * ring flashes and its chip is marked, naming the caller, so the user
     * sees where they are asked to look; while the window is in the
     * background the OS asks for the user's attention as well (a Dock
     * bounce, a taskbar flash), the window never raised over other
     * applications (spec Q4). The answer is `{ switched: false }` and
     * nothing else, so polling it says nothing about where the user is. At most once every FOCUS_INTERVAL_MS
     * from one terminal.
     */
    focus: async ({ caller, args, scope, entry }) => {
      const aimed = aim(caller, args, scope, entry);
      if (aimed.error) return aimed;
      if (!placeOf(store.getState(), aimed.tabId)) return fail(REFUSED, 'that terminal is in no pane to point to');
      if (!limiterIn(focusLimiters, caller.id, { intervalMs: FOCUS_INTERVAL_MS, perMinute: 60_000 / FOCUS_INTERVAL_MS }).allow(clock())) {
        return fail(RATE_LIMITED, `a terminal may ask for focus at most once every ${FOCUS_INTERVAL_MS / 1000} seconds`);
      }
      seen(aimed.tabId, caller, 'focus');
      const behind = !attention()?.focused;
      if (behind) {
        Promise.resolve()
          .then(() => requestAttention())
          .catch((err) => console.warn('[control] could not ask for attention:', err));
      }
      // Nothing about the window in the answer: whether the user is looking
      // is not the program's to learn (re-verification round 4).
      return { result: { switched: false } };
    },
  };

  /**
   * One request, start to finish but for the answer: `{ result }` or
   * `{ error }`. `deadline` (epoch ms) is when the caller stops waiting —
   * the backend's `deadline_at`, or this page's own budget if sooner — and
   * nothing is carried out past it (integration review 2). `late` is asked
   * right before the handler runs, which covers every handler that acts
   * without awaiting anything first (notify, set-status, set-progress,
   * focus); one that awaits asks again right before it acts (`new-split`
   * after its folder check, `send` in `typeForProgram`, before the write).
   */
  const carryOut = async (payload, entry, deadline, ctx) => {
    // Past the deadline — or the answer already given as not responding.
    const late = () => ctx.gaveUp || Date.now() >= deadline;
    // The last word before an act: false when it is too late; otherwise the
    // request is committed, and its answer waits for the act (`withinBudget`).
    const commit = () => {
      if (late()) return false;
      ctx.committed = true;
      return true;
    };
    const state = store.getState();
    const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
    const caller = sessionId ? state.tabs.find((t) => t.sessionId === sessionId) : null;
    if (!caller) return fail(UNAUTHORIZED, 'no terminal of this NexTerm window runs that shell');
    // A tab keeps its ended shell's session id until it is restarted; the
    // backend drops that shell's token as it ends, and nothing it ran is
    // left to be asking. Should a request still arrive, it speaks for nobody.
    if (caller.exited) return fail(UNAUTHORIZED, 'the shell that asked has ended');
    entry.caller = caller.id;
    entry.callerTitle = titleOf(caller);
    const scope = allowed(settings.getState(), payload);
    if (!scope.enabled) return fail(DISABLED, 'programs controlling NexTerm is off (Settings ▸ Terminal ▸ Control)');
    const valid = validateRequest(payload.cmd, payload.args);
    if (valid.error) return valid;
    entry.cmd = valid.cmd;
    const refused = checkPolicy(valid.cmd, valid.args, scope);
    if (refused) return refused;
    prune(state);
    if (late()) return LATE;
    return HANDLERS[valid.cmd]({ caller, args: valid.args, scope, entry, late, commit });
  };

  /**
   * Handle one `control-request` and answer it. Resolves with the message
   * sent; never rejects — a request that broke anything is answered
   * `internal`, one that took too long `not_responding`, and the log keeps it
   * either way.
   */
  const handle = async (raw) => {
    const payload = raw && typeof raw === 'object' ? raw : {};
    const id = payload.id ?? null;
    const entry = {
      at: Date.now(),
      caller: null,
      callerTitle: null,
      cmd: typeof payload.cmd === 'string' ? payload.cmd : null,
      target: null,
      targetTitle: null,
      size: null,
      lines: null,
      result: null,
    };
    const deadlineAt = typeof payload.deadline_at === 'number' && Number.isFinite(payload.deadline_at) ? payload.deadline_at : Infinity;
    const deadline = Math.min(deadlineAt, Date.now() + budgetMs);
    const ctx = { gaveUp: false, committed: false };
    let outcome;
    try {
      outcome = await withinBudget(
        Promise.resolve().then(() => carryOut(payload, entry, deadline, ctx)),
        Math.max(0, deadline - Date.now()),
        ctx
      );
    } catch (err) {
      console.warn('[control] a request failed:', err);
      outcome = fail(INTERNAL, 'NexTerm could not carry this out');
    }
    const error = outcome && typeof outcome === 'object' && outcome.error ? outcome.error : null;
    const message = error
      ? { id, ok: false, result: null, error: { code: String(error.code), message: String(error.message ?? '') } }
      : { id, ok: true, result: outcome?.result ?? null, error: null };
    // A copy: a handler still running past its budget must not edit the
    // entry after it was kept.
    try {
      log({ ...entry, result: message.ok ? 'ok' : message.error.code });
    } catch (err) {
      console.warn('[control] could not log a request:', err);
    }
    try {
      await reply(message);
    } catch (err) {
      console.warn('[control] could not answer a request:', err);
    }
    return message;
  };

  /**
   * Whether a program's note from terminal `tabId` may go to the desktop
   * (`setProgramDesktopGate`): a terminal opened through the API counts
   * against the API's cap, as `nexterm-cli notify` does; any other is not
   * the API's to limit.
   */
  const desktopAllowedFor = (tabId) => (openedByApi.has(tabId) ? desktopLimiter.allow(clock()) : true);

  return {
    handle,
    prune,
    desktopAllowedFor,
    /** For the suites and the log: the tabs `sessionId`'s shell opened. */
    childrenOf: (sessionId) => new Set(childrenOf(sessionId)),
  };
}

// ---- Telling the backend what the settings allow ---------------------------------

/**
 * Every settings report to the backend, one after another in the order they
 * were made — as useUnsavedGuard.js keeps its own: a report must never land
 * after a later one, or the backend would hold the setting the user left.
 */
let reports = Promise.resolve();

/**
 * Settles once every settings report made so far has been answered (or
 * refused) — what the first shells wait for (`holdSpawnsUntil` in
 * terminalStore.js): the backend listens from its own start with the spec's
 * defaults, and a user's "off" must hold before the first shell gets a token.
 */
export function controlSettingsReported() {
  return reports;
}

/** The three settings as the backend takes them (`control_set_settings`). */
export function controlSettingsOf(state) {
  return {
    enabled: state?.terminalControl !== false,
    type_and_read: state?.terminalControlTypeAndRead === true,
    other_terminals: state?.terminalControlOtherTerminals === true,
  };
}

/**
 * Tell the backend the settings. It answers `{ enabled, listening, error }`:
 * with the API on and no listener — a socket folder that is not the user's,
 * a pipe name taken — `error` says why, and nexterm-cli cannot reach this
 * window. Said in the console; the CLI says it to whoever runs it.
 */
async function sendControlSettings(values) {
  const status = await ipcInvoke(CONTROL_SETTINGS_COMMAND, values);
  if (values.enabled && status && typeof status === 'object' && status.error) {
    console.warn('[control] nexterm-cli cannot reach this window:', status.error);
  }
  return status;
}

/**
 * Keep the backend told what Settings ▸ Terminal ▸ Control allows: now, and
 * on every change to one of the three, in order. Turning the first off is
 * how the backend closes its listener and drops every token (D5).
 *
 * Returns the stop. It tells the backend NOTHING: a stop is a page going away
 * (a reload, React's development double effects) — not the user turning the
 * API off — and "off" would cut every running shell's token for good.
 */
export function reportControlSettings(store = useSettingsStore, send = sendControlSettings) {
  let last = null;
  const report = (state) => {
    const values = controlSettingsOf(state);
    const key = `${values.enabled}|${values.type_and_read}|${values.other_terminals}`;
    if (key === last) return;
    last = key;
    reports = reports
      .then(() => send(values))
      .catch((err) => console.warn('[control] could not tell the backend the control settings:', err));
  };
  report(store.getState());
  return store.subscribe(report);
}
