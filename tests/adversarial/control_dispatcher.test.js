/**
 * Stage 7: the page's half of the control API (src/lib/controlDispatcher.js)
 * — what each `control-request` does in the store, whom it may touch, what
 * it answers, what the user sees of it and what the log keeps — and the
 * pieces it needs from the store: a program's status line, the "controlled"
 * mark, typing for a program, and the backend kept told the settings.
 *
 * The store is the real one on the browser mock, as project_commands_run
 * drives it: real shells' events (`pty-command-done`, `pty-echo`), real
 * splits. Terminals are `@xterm/headless`, handed in where the registry
 * would hand in the app's.
 */
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';
import { useControlLogStore, LOG_LIMIT, logEntry } from '../../src/stores/controlLogStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { installModifyOtherKeys } from '../../src/lib/modifyOtherKeys.js';
import {
  API_DESKTOP_PER_MINUTE,
  CHILDREN_MAX,
  CONTROL_REPLY_COMMAND,
  ESCAPE_JOIN_MS,
  LIST_MAX,
  OPENED_MAX,
  SPLITS_PER_MINUTE,
  controlSettingsOf,
  controlSettingsReported,
  createControlDispatcher,
  reportControlSettings,
} from '../../src/lib/controlDispatcher.js';
import { readScreen, READ_MAX_BYTES, secretPromptOnScreen } from '../../src/lib/controlScreen.js';
import { installProgramNotifications } from '../../src/lib/programNotifications.js';

const { Terminal } = headless;
const S = terminalStore.useTerminalStore;
const settings = () => useSettingsStore.getState();

/**
 * Secret fixtures carry a `·` inside the word a secret scanner keys on, and
 * `fx` takes it out: the repository is public, and push protection takes
 * fakes for leaks (scrollback_snapshot.test.js says more).
 */
const fx = (text) => text.replace(/\u{b7}/gu, '');

// ---- the store on the mock, started fresh -------------------------------------

let previousWait = null;
let previousInfers = null;
let previousAttention = null;
let previousMark = null;
let unsink = null;
const notices = [];
const backing = new Map();
let previousStorage;
let hadStorage = false;

async function freshStart() {
  S.getState().dispose();
  hadStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  previousStorage = globalThis.localStorage;
  backing.clear();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  previousWait = terminalStore.__setAgentPromptWaitMs(300);
  previousInfers = terminalStore.__setSubmitInfersRunning(false);
  // Nobody is looking: a notification goes to the bell, nothing is held back.
  previousAttention = terminalStore.__setAttentionSource(() => ({ focused: false, visible: true }));
  notices.length = 0;
  unsink = setTerminalNoticeSink((tabId, message) => {
    notices.push({ tabId, message });
    return true;
  });
  settings().resetSettings();
  useControlLogStore.setState({ entries: [], open: false });
  S.getState().forgetInputHidden();
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    secretInput: {},
    reportedStatus: {},
    controlled: {},
    notifications: [],
    progress: {},
  });
  await S.getState().init();
}

function teardown() {
  S.getState().dispose();
  unsink?.();
  unsink = null;
  if (previousWait !== null) terminalStore.__setAgentPromptWaitMs(previousWait);
  if (previousInfers !== null) terminalStore.__setSubmitInfersRunning(previousInfers);
  if (previousAttention !== null) terminalStore.__setAttentionSource(previousAttention);
  if (previousMark !== null) terminalStore.__setControlledMarkMs(previousMark);
  previousWait = null;
  previousInfers = null;
  previousAttention = null;
  previousMark = null;
  settings().resetSettings();
  if (hadStorage) globalThis.localStorage = previousStorage;
  else delete globalThis.localStorage;
}

async function inStore(fn) {
  await freshStart();
  try {
    await fn();
  } finally {
    teardown();
  }
}

const tabById = (id) => S.getState().tabs.find((t) => t.id === id);
const sessionOf = (tabId) => tabById(tabId).sessionId;
const prompt = (tabId) => mockBridge.emit('pty-command-done', { session_id: sessionOf(tabId), exit_code: 0 });
const echo = (tabId, secret) => mockBridge.emit('pty-echo', { session_id: sessionOf(tabId), secret });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Three terminals in the first pane, each with its first prompt drawn: `[a, b, c]`. */
async function threeTerminals() {
  const a = S.getState().activeTabId;
  const b = (await S.getState().createTab()).id;
  const c = (await S.getState().createTab()).id;
  for (const id of [a, b, c]) await prompt(id);
  return [a, b, c];
}

/** Every pty_write while `fn` runs, as `[sessionId, data]`, answered at once. */
async function writes(fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') {
      typed.push([args?.session_id, args?.data]);
      return Promise.resolve(null);
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

/** A shown terminal: a headless xterm, its modifyOtherKeys followed as the app's is. */
function shownTerminal({ cols = 60, rows = 8 } = {}) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const keys = installModifyOtherKeys(term);
  return { term, keys };
}

let requestId = 0;

/**
 * A dispatcher with the registry's pieces handed in: `shown` maps a tab id to
 * its terminal (`shownTerminal`). With `showAll` (the default) any other tab
 * reads as shown too, on an empty terminal of its own; without it, a tab not
 * in `shown` was never shown.
 */
function harness({ shown = new Map(), showAll = true, focused = true, budgetMs, typingWaitMs, reply, readTerminal, clock } = {}) {
  const terminalOf = (id) => {
    if (!shown.has(id) && showAll) shown.set(id, shownTerminal());
    return shown.get(id) ?? null;
  };
  const replies = [];
  const attentionAsked = [];
  const focusedViews = [];
  const dispatcher = createControlDispatcher({
    reply: reply ?? (async (message) => replies.push(message)),
    readTerminal: readTerminal ?? (async (id) => terminalOf(id)?.term ?? null),
    modesOf: (id) => {
      const entry = terminalOf(id);
      if (!entry) return null;
      return {
        applicationCursorKeys: entry.term.modes.applicationCursorKeysMode,
        bracketedPaste: entry.term.modes.bracketedPasteMode,
        modifyOtherKeys: entry.keys?.level ?? 0,
      };
    },
    focusView: (id) => {
      focusedViews.push(id);
      return true;
    },
    attention: () => ({ focused, visible: true }),
    requestAttention: async () => {
      attentionAsked.push(Date.now());
    },
    later: (fn) => fn(),
    ...(clock === undefined ? {} : { clock }),
    ...(budgetMs === undefined ? {} : { budgetMs }),
    ...(typingWaitMs === undefined ? {} : { typingWaitMs }),
  });
  const ask = (tabId, cmd, args, { typeAndRead = false, other = false, session = null, deadlineAt } = {}) =>
    dispatcher.handle({
      id: ++requestId,
      session_id: session ?? sessionOf(tabId),
      cmd,
      args,
      type_and_read: typeAndRead,
      other_terminals: other,
      ...(deadlineAt === undefined ? {} : { deadline_at: deadlineAt }),
    });
  return { dispatcher, ask, replies, attentionAsked, focusedViews };
}

/** Turn on what typing and reading need, on the page and in what the backend says. */
const TYPE_AND_READ = { typeAndRead: true };
const allowTyping = () => settings().setSetting('terminalControlTypeAndRead', true);
const allowOthers = () => settings().setSetting('terminalControlOtherTerminals', true);

const errorCode = (message) => (message.ok ? 'ok' : message.error.code);

// ---- every request is answered ----------------------------------------------------

describe('Control requests: every one is answered, whatever happens', () => {
  test('CD-01: a session no terminal holds is unauthorized — answered with its id, logged, nothing done', async () => {
    await inStore(async () => {
      const { ask, replies } = harness();
      const tab = S.getState().activeTabId;
      const answer = await ask(tab, 'set-status', { text: 'hi' }, { session: 'pty-nobody' });
      assert.equal(errorCode(answer), 'unauthorized');
      assert.equal(replies.length, 1);
      assert.deepEqual(replies[0], answer);
      assert.equal(typeof replies[0].id, 'number');
      assert.deepEqual(S.getState().reportedStatus, {});
      const [entry] = useControlLogStore.getState().entries;
      assert.equal(entry.result, 'unauthorized');
      assert.equal(entry.caller, null);
    });
  });

  test('CD-02: the API turned off answers disabled; a bad request is bad_request, an unknown command unknown_command', async () => {
    await inStore(async () => {
      const { ask } = harness();
      const tab = S.getState().activeTabId;
      settings().setSetting('terminalControl', false);
      assert.equal(errorCode(await ask(tab, 'set-status', { text: 'hi' })), 'disabled');
      settings().setSetting('terminalControl', true);
      assert.equal(errorCode(await ask(tab, 'set-status', { text: 'hi', colour: 'red' })), 'bad_request');
      assert.equal(errorCode(await ask(tab, 'self-destruct', {})), 'unknown_command');
      assert.equal(errorCode(await ask(tab, 'set-status', { text: 'hi' })), 'ok');
    });
  });

  test('CD-03: a handler that throws is answered internal, one that hangs not_responding within the budget, and a reply that fails never throws', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      allowTyping();
      // Throws: the store's notification path breaks.
      const original = S.getState().notifyFromProgram;
      S.setState({
        notifyFromProgram: () => {
          throw new Error('boom');
        },
      });
      try {
        const { ask, replies } = harness();
        assert.equal(errorCode(await ask(tab, 'notify', { title: 'x' })), 'internal');
        assert.equal(replies.length, 1, 'answered all the same');
      } finally {
        S.setState({ notifyFromProgram: original });
      }
      // Hangs: the terminal never says it has caught up.
      const { ask: askHung, replies: hungReplies } = harness({ budgetMs: 60, readTerminal: () => new Promise(() => {}) });
      const started = Date.now();
      const hung = await askHung(tab, 'read-screen', {}, TYPE_AND_READ);
      assert.equal(errorCode(hung), 'not_responding');
      assert.ok(Date.now() - started < 1000, 'answered within the budget');
      assert.equal(hungReplies.length, 1);
      // The reply itself fails: `handle` still resolves, with what it meant to send.
      const { ask: askBroken } = harness({
        reply: async () => {
          throw new Error('backend gone');
        },
      });
      const answer = await askBroken(tab, 'set-status', { text: 'still fine' });
      assert.equal(answer.ok, true);
      // A payload that is not one at all.
      const { dispatcher, replies: junkReplies } = harness();
      assert.equal(errorCode(await dispatcher.handle(null)), 'unauthorized');
      assert.equal(errorCode(await dispatcher.handle('{"cmd":"list"}')), 'unauthorized');
      assert.equal(junkReplies.length, 2);
    });
  });

  test('CD-04: the reply goes to control_reply as exactly { id, ok, result, error }', async () => {
    await inStore(async () => {
      const sent = [];
      const original = mockBridge.invoke;
      mockBridge.invoke = function (command, args, ...rest) {
        if (command === CONTROL_REPLY_COMMAND) {
          sent.push(args);
          return Promise.resolve(null);
        }
        return original.call(this, command, args, ...rest);
      };
      try {
        const dispatcher = createControlDispatcher();
        const tab = S.getState().activeTabId;
        await dispatcher.handle({ id: 41, session_id: sessionOf(tab), cmd: 'set-status', args: { text: 'ok' } });
        await dispatcher.handle({ id: 42, session_id: 'pty-nobody', cmd: 'list', args: {} });
      } finally {
        mockBridge.invoke = original;
      }
      assert.deepEqual(Object.keys(sent[0]).sort(), ['error', 'id', 'ok', 'result']);
      assert.deepEqual([sent[0].id, sent[0].ok, sent[0].error], [41, true, null]);
      assert.deepEqual([sent[1].id, sent[1].ok, sent[1].result, sent[1].error.code], [42, false, null, 'unauthorized']);
      assert.equal(typeof sent[1].error.message, 'string');
    });
  });
});

// ---- reporting: notify, set-status, set-progress ------------------------------------

describe('Control requests: notify, set-status and set-progress', () => {
  test('CD-05: notify goes through notifyFromProgram, cleaned as an OSC 9 is, at the same rate limit — and not at all with notifications off', async () => {
    await inStore(async () => {
      const { ask } = harness();
      const tab = S.getState().activeTabId;
      const answer = await ask(tab, 'notify', { title: 'Done\u{1b}[31m', body: 'tests \u{202e}passed\nall' });
      assert.equal(answer.ok, true);
      const [entry] = S.getState().notifications;
      assert.equal(entry.kind, 'program');
      assert.equal(entry.tabId, tab);
      assert.equal(entry.title, 'Done[31m');
      assert.equal(entry.body, 'tests passed all');
      // A second within 2 s: dropped, and said so.
      const again = await ask(tab, 'notify', { title: 'again' });
      assert.equal(errorCode(again), 'rate_limited');
      assert.equal(S.getState().notifications.length, 1);
      // Nothing to show once cleaned.
      const { ask: fresh } = harness();
      assert.equal(errorCode(await fresh(tab, 'notify', { title: '\u{7}\u{1b}' })), 'bad_request');
      settings().setSetting('terminalProgramNotifications', false);
      const { ask: off } = harness();
      assert.equal(errorCode(await off(tab, 'notify', { title: 'x' })), 'disabled');
    });
  });

  test("CD-06: set-status sets the caller's reportedStatus cleaned, with its tone; null clears it; nothing left to show is bad_request", async () => {
    await inStore(async () => {
      const { ask } = harness();
      const tab = S.getState().activeTabId;
      const answer = await ask(tab, 'set-status', { text: '  Running\ttests \u{202e}now\u{200b}  ', tone: 'warn' });
      assert.deepEqual(answer.result, { text: 'Running tests now', tone: 'warn' });
      const status = S.getState().reportedStatus[tab];
      assert.deepEqual([status.text, status.tone, typeof status.at], ['Running tests now', 'warn', 'number']);
      const long = await ask(tab, 'set-status', { text: 'x'.repeat(300) });
      assert.equal(Array.from(S.getState().reportedStatus[tab].text).length, 80, 'at most 80 characters');
      assert.equal(long.result.tone, 'info', 'info when no tone is given');
      assert.equal(errorCode(await ask(tab, 'set-status', { text: '\u{1b}\u{7}' })), 'bad_request');
      await ask(tab, 'set-status', { text: null });
      assert.equal(S.getState().reportedStatus[tab], undefined);
    });
  });

  test('CD-07: set-progress puts the bar up through setTabProgress — not with Progress Bars off', async () => {
    await inStore(async () => {
      const previous = terminalStore.__setProgressIntervalMs(0);
      try {
        const { ask } = harness();
        const tab = S.getState().activeTabId;
        assert.equal((await ask(tab, 'set-progress', { state: 'normal', value: 40 })).ok, true);
        await sleep(5);
        assert.deepEqual(S.getState().progress[tab], { state: 'normal', value: 40 });
        await ask(tab, 'set-progress', { state: 'remove' });
        await sleep(5);
        assert.equal(S.getState().progress[tab], undefined);
        settings().setSetting('terminalProgress', false);
        assert.equal(errorCode(await ask(tab, 'set-progress', { state: 'indeterminate' })), 'disabled');
      } finally {
        terminalStore.__setProgressIntervalMs(previous);
      }
    });
  });
});

// ---- the status line a program reported ---------------------------------------------

describe("A program's status line (reportedStatus)", () => {
  test('CD-08: cleared when the shell exits, when it is restarted, and when the terminal closes', async () => {
    await inStore(async () => {
      const [a, b, c] = await threeTerminals();
      for (const id of [a, b, c]) S.getState().setReportedStatus(id, { text: `working in ${id}` });
      // Exits.
      await mockBridge.emit('pty-exit', { session_id: sessionOf(a), exit_code: 0 });
      assert.equal(S.getState().reportedStatus[a], undefined, 'gone with the shell');
      assert.ok(S.getState().reportedStatus[b], 'the others keep theirs');
      // Set again while exited (no program could, but the store must not
      // keep it past a restart). The real backend has no session left to
      // kill once its shell has exited, so the restart says nothing more of
      // the old one: it is the restart itself that clears it.
      mockBridge.ptySessions.delete(sessionOf(a));
      S.setState((s) => ({ reportedStatus: { ...s.reportedStatus, [a]: { text: 'stale', tone: 'info', at: 0 } } }));
      assert.equal(await S.getState().restartShell(a), true);
      assert.equal(S.getState().reportedStatus[a], undefined, 'gone with the old shell');
      // Closes.
      await S.getState().closeTab(c);
      assert.equal(S.getState().reportedStatus[c], undefined, 'gone with the terminal');
      assert.equal(S.getState().reportedStatus[b].text, `working in ${b}`);
      // Gone from the tabs by any other way (a workspace loaded over it), its
      // shell never having said a word: pruned with the rest of its state.
      S.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== b) }));
      assert.equal(S.getState().reportedStatus[b], undefined, 'pruned with the terminal');
    });
  });

  test("CD-09: narrow — a status is its own map: setting it never touches `tabs`, the same text again writes nothing, and only the row's line reads it", async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      S.getState().setReportedStatus(b, { text: 'other' });
      const tabs = S.getState().tabs;
      const otherEntry = S.getState().reportedStatus[b];
      S.getState().setReportedStatus(a, { text: 'Running tests' });
      assert.equal(S.getState().tabs, tabs, 'every pane and chip reads tabs; a status must not replace it');
      assert.equal(S.getState().reportedStatus[b], otherEntry, "another terminal's entry keeps its identity");
      const map = S.getState().reportedStatus;
      let writes = 0;
      const stop = S.subscribe(() => {
        writes += 1;
      });
      S.getState().setReportedStatus(a, { text: 'Running tests' });
      stop();
      assert.equal(writes, 0, 'a hook saying the same thing again redraws nothing');
      assert.equal(S.getState().reportedStatus, map);
      // Read by the status line, for its own tab only — and by nothing that draws every row.
      const board = readFileSync(new URL('../../src/components/terminal/StatusBoard.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      assert.match(board, /useTerminalStore\(\(s\) => s\.reportedStatus\?\.\[tabId\] \?\? null\)/);
      for (const file of ['TerminalsPanel.jsx', 'TerminalSplitContainer.jsx', 'statusBoardModel.js']) {
        const src = readFileSync(new URL(`../../src/components/terminal/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(!src.includes('reportedStatus'), `${file} reads reportedStatus`);
      }
    });
  });
});

// ---- list -----------------------------------------------------------------------------

describe('Control requests: list', () => {
  test("CD-10: every terminal of the window in the window's order, with the fields the spec names, self and child marked", async () => {
    await inStore(async () => {
      const [a, b, c] = await threeTerminals();
      S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === b ? { ...t, running: true } : t)) }));
      const { ask } = harness();
      const split = await ask(a, 'new-split', {});
      const child = split.result.id;
      const answer = await ask(a, 'list', {});
      assert.equal(answer.ok, true);
      const rows = answer.result;
      assert.deepEqual(rows.map((r) => r.id), [a, b, c, child]);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ['active', 'agent', 'child', 'cwd', 'group', 'id', 'self', 'status', 'title']);
      }
      assert.deepEqual(rows.map((r) => r.self), [true, false, false, false]);
      assert.deepEqual(rows.map((r) => r.child), [false, false, false, true]);
      assert.equal(rows[1].status, 'running');
      assert.equal(rows[0].group, S.getState().groups[0].name);
      assert.equal(rows.filter((r) => r.active).length, 1);
      assert.equal(rows.find((r) => r.active).id, S.getState().activeTabId);
      // Asked by the child, the caller is just another terminal.
      const fromChild = (await ask(child, 'list', {})).result;
      assert.deepEqual([fromChild.find((r) => r.id === a).self, fromChild.find((r) => r.id === child).self], [false, true]);
    });
  });

  test(`CD-11: at most ${LIST_MAX} terminals`, async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const extra = Array.from({ length: LIST_MAX + 5 }, (_, i) => ({ id: `tab-term-${900 + i}`, title: `t${i}`, sessionId: `s-extra-${i}`, cwd: '/w' }));
      S.setState((s) => ({ tabs: [...s.tabs, ...extra] }));
      const { ask } = harness();
      const answer = await ask(tab, 'list', {});
      assert.equal(answer.result.length, LIST_MAX);
      assert.equal(answer.result[0].id, tab, 'placed terminals first');
    });
  });
});

// ---- new-split ------------------------------------------------------------------------

describe('Control requests: new-split', () => {
  test("CD-12: a split beside the caller's pane, its tab id returned and recorded as the caller's child; the keyboard stays where it was", async () => {
    await inStore(async () => {
      const [a, b, c] = await threeTerminals();
      S.getState().switchTab(b);
      const activePane = S.getState().getActivePaneId();
      const { ask, dispatcher } = harness();
      const answer = await ask(a, 'new-split', { direction: 'down' });
      assert.equal(answer.ok, true);
      const child = answer.result.id;
      assert.ok(tabById(child), 'a new terminal');
      assert.deepEqual([...dispatcher.childrenOf(sessionOf(a))], [child]);
      assert.equal(S.getState().getActivePaneId(), activePane, 'the keyboard is not taken from where the user is');
      assert.equal(S.getState().activeTabId, b);
      // Beside the caller's pane, split down.
      const tree = S.getState().getActiveGroup().tree;
      assert.equal(tree.type, 'split');
      assert.equal(tree.direction, 'vertical');
      assert.deepEqual(tree.children.map((n) => n.tabIds), [[a, b, c], [child]]);
      const entry = useControlLogStore.getState().entries.at(-1);
      assert.deepEqual([entry.cmd, entry.target, entry.result], ['new-split', child, 'ok']);
    });
  });

  test('CD-13: cwd is an existing local folder — ~ expanded, a network path refused, a relative one bad_request, a missing one not_found', async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      useSystemStore.setState({ homeDir: '/Users/developer' });
      const { ask } = harness();
      const inSrc = await ask(tab, 'new-split', { cwd: '/workspace/src' });
      assert.equal(inSrc.ok, true);
      assert.equal(tabById(inSrc.result.id).cwd, '/workspace/src', 'started where it was asked');
      const home = await ask(tab, 'new-split', { cwd: '~' });
      assert.equal(home.ok, true);
      assert.equal(tabById(home.result.id).cwd, '/Users/developer');
      const before = S.getState().tabs.length;
      assert.equal(errorCode(await ask(tab, 'new-split', { cwd: '\\\\server\\share\\x' })), 'refused');
      assert.equal(errorCode(await ask(tab, 'new-split', { cwd: '//server/share' })), 'refused');
      assert.equal(errorCode(await ask(tab, 'new-split', { cwd: 'src' })), 'bad_request');
      assert.equal(errorCode(await ask(tab, 'new-split', { cwd: '/workspace/nowhere' })), 'not_found');
      assert.equal(S.getState().tabs.length, before, 'no terminal started for a refused folder');
    });
  });

  test("CD-14: the command is typed as a startup command is — after the new shell's first prompt — and only with typing allowed; one of several lines is refused before anything starts", async () => {
    await inStore(async () => {
      const tab = S.getState().activeTabId;
      const { ask } = harness();
      const before = S.getState().tabs.length;
      // A command is typing (the lead's checkPolicy, review): off, nothing starts.
      const off = await ask(tab, 'new-split', { command: 'npm run dev' });
      assert.equal(errorCode(off), 'disabled');
      assert.equal(S.getState().tabs.length, before, 'no split for a command that may not be typed');
      allowTyping();
      let child = null;
      const typed = await writes(async () => {
        const answer = await ask(tab, 'new-split', { command: 'npm run dev' }, TYPE_AND_READ);
        assert.equal(answer.ok, true);
        assert.equal(answer.result.typing, true);
        child = answer.result.id;
        await sleep(20);
        await prompt(child);
        await sleep(50);
      });
      assert.deepEqual(typed, [[sessionOf(child), 'npm run dev\r']]);
      const count = S.getState().tabs.length;
      assert.equal(errorCode(await ask(tab, 'new-split', { command: 'a\nb' }, TYPE_AND_READ)), 'bad_request');
      assert.equal(S.getState().tabs.length, count);
    });
  });
});

describe('Control requests: whom they may touch', () => {
  test('CD-15: send and read-screen are disabled without "type into and read" — even for the caller, and even when only one side says yes', async () => {
    await inStore(async () => {
      const [a] = await threeTerminals();
      const shown = new Map([[a, shownTerminal()]]);
      const { ask } = harness({ shown });
      assert.equal(errorCode(await ask(a, 'send', { text: 'ls' })), 'disabled');
      assert.equal(errorCode(await ask(a, 'read-screen', {})), 'disabled');
      // The backend says yes, the page's setting no (or the other way round): no.
      assert.equal(errorCode(await ask(a, 'send', { text: 'ls' }, TYPE_AND_READ)), 'disabled');
      allowTyping();
      assert.equal(errorCode(await ask(a, 'read-screen', {})), 'disabled');
      assert.equal(errorCode(await ask(a, 'read-screen', {}, TYPE_AND_READ)), 'ok');
    });
  });

  test('CD-16: self and its children always; another terminal only with "control other terminals" on — on the page AND in the request', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      // `focus` is rate-limited per caller (review F2); the clock moves on 5 s
      // between asks, so what is checked here is whom it may touch.
      let t = 0;
      const { ask } = harness({ clock: () => (t += 6000) });
      const child = (await ask(a, 'new-split', {})).result.id;
      await prompt(child);
      assert.equal(errorCode(await ask(a, 'focus', {})), 'ok', 'self');
      assert.equal(errorCode(await ask(a, 'focus', { target: child })), 'ok', 'its child, by id');
      assert.equal(errorCode(await ask(a, 'focus', { target: `child:${child}` })), 'ok', 'its child, as child:');
      assert.equal(errorCode(await ask(a, 'focus', { target: b })), 'forbidden', 'another terminal');
      assert.equal(errorCode(await ask(a, 'focus', { target: `child:${b}` })), 'forbidden', 'not its child');
      assert.equal(errorCode(await ask(child, 'focus', { target: a })), 'forbidden', 'a child does not control its parent');
      assert.equal(errorCode(await ask(a, 'focus', { target: b }, { other: true })), 'forbidden', 'the request says yes, the page no');
      allowOthers();
      assert.equal(errorCode(await ask(a, 'focus', { target: b })), 'forbidden', 'the page says yes, the request no');
      assert.equal(errorCode(await ask(a, 'focus', { target: b }, { other: true })), 'ok');
      assert.equal(errorCode(await ask(a, 'focus', { target: 'tab-term-999' }, { other: true })), 'not_found');
    });
  });

  test('CD-17: children belong to the shell that opened them — after its restart, or once the child closes, they are not its children', async () => {
    await inStore(async () => {
      const [a] = await threeTerminals();
      const { ask, dispatcher } = harness();
      const child = (await ask(a, 'new-split', {})).result.id;
      const second = (await ask(a, 'new-split', {})).result.id;
      assert.deepEqual([...dispatcher.childrenOf(sessionOf(a))].sort(), [child, second].sort());
      await S.getState().closeTab(second);
      dispatcher.prune();
      assert.deepEqual([...dispatcher.childrenOf(sessionOf(a))], [child]);
      // The caller's shell ends and a new one starts: a new token, a new program.
      const oldSession = sessionOf(a);
      await mockBridge.emit('pty-exit', { session_id: oldSession, exit_code: 0 });
      await S.getState().restartShell(a);
      await prompt(a);
      assert.notEqual(sessionOf(a), oldSession);
      assert.equal(errorCode(await ask(a, 'focus', { target: child })), 'forbidden');
      assert.equal(dispatcher.childrenOf(oldSession).size, 0, 'forgotten with the old shell');
    });
  });
});

// ---- send -----------------------------------------------------------------------------

describe('Control requests: send', () => {
  test("CD-18: keys follow the TARGET's modes — DECCKM arrows, modifyOtherKeys' Shift+Enter — and go through writeRaw to its shell", async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const target = shownTerminal();
      await write(target.term, '\x1b[?1h\x1b[>4;1m');
      const caller = shownTerminal();
      const { ask } = harness({ shown: new Map([[a, caller], [b, target]]) });
      const rawWrites = [];
      const original = S.getState().writeRaw;
      S.setState({
        writeRaw: (tabId, data) => {
          rawWrites.push([tabId, data]);
          return original(tabId, data);
        },
      });
      let typed;
      try {
        typed = await writes(async () => {
          assert.equal((await ask(a, 'send', { target: b, keys: ['Up', 'Shift+Enter'] }, { typeAndRead: true, other: true })).ok, true);
          assert.equal((await ask(a, 'send', { keys: ['Up', 'Shift+Enter'] }, TYPE_AND_READ)).ok, true);
        });
      } finally {
        S.setState({ writeRaw: original });
      }
      assert.deepEqual(typed, [
        [sessionOf(b), '\x1bOA\x1b[27;2;13~'],
        [sessionOf(a), '\x1b[A\r'],
      ]);
      assert.deepEqual(rawWrites, [
        [b, '\x1bOA\x1b[27;2;13~'],
        [a, '\x1b[A\r'],
      ]);
    });
  });

  test('CD-19: several lines go as one bracketed paste where the program asked for it, are refused where it did not, and go raw only when asked', async () => {
    await inStore(async () => {
      const [a] = await threeTerminals();
      allowTyping();
      const term = shownTerminal();
      const { ask } = harness({ shown: new Map([[a, term]]) });
      const typed = await writes(async () => {
        const refused = await ask(a, 'send', { text: 'echo 1\necho 2' }, TYPE_AND_READ);
        assert.equal(errorCode(refused), 'refused');
        assert.match(refused.error.message, /bracketed paste/);
        await write(term.term, '\x1b[?2004h');
        assert.equal((await ask(a, 'send', { text: 'echo 1\necho 2' }, TYPE_AND_READ)).ok, true);
        await write(term.term, '\x1b[?2004l');
        assert.equal((await ask(a, 'send', { text: 'echo 1\necho 2', raw: true }, TYPE_AND_READ)).ok, true);
        // Text, then keys: the line and its Enter.
        assert.equal((await ask(a, 'send', { text: 'ls', keys: ['Enter'] }, TYPE_AND_READ)).ok, true);
      });
      assert.deepEqual(typed.map(([, data]) => data), ['\x1b[200~echo 1\recho 2\x1b[201~', 'echo 1\recho 2', 'ls\r']);
    });
  });

  test('CD-20: never into a password prompt — refused, nothing written; NOT refused because something is running', async () => {
    await inStore(async () => {
      const [a] = await threeTerminals();
      allowTyping();
      const { ask } = harness();
      const typed = await writes(async () => {
        await echo(a, true);
        const answer = await ask(a, 'send', { text: 'hunter2' }, TYPE_AND_READ);
        assert.equal(errorCode(answer), 'refused');
        assert.match(answer.error.message, /password/);
        await echo(a, false);
        S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === a ? { ...t, running: true } : t)) }));
        assert.equal((await ask(a, 'send', { text: 'y', keys: ['Enter'] }, TYPE_AND_READ)).ok, true, 'an agent running is the point');
      });
      assert.deepEqual(typed, [[sessionOf(a), 'y\r']]);
    });
  });

  test('CD-21: a password prompt the backend sees but the events have not said yet is refused too; an exited shell is refused, not restarted; an ended caller is nobody', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const { ask } = harness();
      const typed = await writes(async () => {
        const inner = mockBridge.invoke;
        mockBridge.invoke = function (command, args, ...rest) {
          if (command === 'pty_input_hidden') return Promise.resolve(true);
          return inner.call(this, command, args, ...rest);
        };
        try {
          assert.equal(errorCode(await ask(a, 'send', { text: 'x' }, TYPE_AND_READ)), 'refused');
        } finally {
          mockBridge.invoke = inner;
        }
        await mockBridge.emit('pty-exit', { session_id: sessionOf(b), exit_code: 0 });
        const exited = await ask(a, 'send', { target: b, keys: ['Enter'] }, { typeAndRead: true, other: true });
        assert.equal(errorCode(exited), 'refused');
        assert.match(exited.error.message, /exited/);
        // The caller's own shell ended: its session asks for nothing any more.
        await mockBridge.emit('pty-exit', { session_id: sessionOf(a), exit_code: 0 });
        assert.equal(errorCode(await ask(a, 'set-status', { text: 'late' })), 'unauthorized');
      });
      assert.deepEqual(typed, []);
      assert.ok(tabById(b).exited, 'still exited: an Enter from a program starts no new shell');
      assert.equal(S.getState().reportedStatus[a], undefined);
    });
  });

  test("CD-22: a shell started a moment ago is waited for until its first prompt — and past the wait it is refused as starting, not typed into", async () => {
    await inStore(async () => {
      terminalStore.__setAgentPromptWaitMs(5000);
      const [a] = await threeTerminals();
      allowTyping();
      const { ask } = harness({ typingWaitMs: 80 });
      const child = (await ask(a, 'new-split', {})).result.id;
      const typed = await writes(async () => {
        const early = await ask(a, 'send', { target: child, text: 'ls' }, TYPE_AND_READ);
        assert.equal(errorCode(early), 'refused');
        assert.match(early.error.message, /first prompt/);
        await prompt(child);
        assert.equal((await ask(a, 'send', { target: child, text: 'ls' }, TYPE_AND_READ)).ok, true);
      });
      assert.deepEqual(typed, [[sessionOf(child), 'ls']]);
    });
  });
});

// ---- read-screen ----------------------------------------------------------------------

describe('Control requests: read-screen', () => {
  test('CD-23: a terminal never shown is not_rendered — there is no screen to read, and none is made', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const { ask } = harness({ shown: new Map([[a, shownTerminal()]]), showAll: false });
      const answer = await ask(a, 'read-screen', { target: b }, { typeAndRead: true, other: true });
      assert.equal(errorCode(answer), 'not_rendered');
      assert.equal(S.getState().controlled[b], undefined, 'nothing was read, so nothing is marked');
    });
  });

  test('CD-24: the screen as plain text, masked by default; mask:false needs "other terminals" and then reads it as it is', async () => {
    await inStore(async () => {
      const [a] = await threeTerminals();
      allowTyping();
      const shown = shownTerminal({ cols: 80 });
      await write(shown.term, fx('$ env\r\n\x1b[32mNEXTERM_CONTROL_TO·KEN=Zm9vYmFyYmF6cXV4cXV1eHh5enp6MTIz\x1b[0m\r\nPATH=/usr/bin\r\n$ '));
      const { ask } = harness({ shown: new Map([[a, shown]]) });
      const masked = await ask(a, 'read-screen', {}, TYPE_AND_READ);
      assert.equal(masked.ok, true);
      assert.equal(masked.result.alternate, false);
      assert.equal(masked.result.masked, true);
      assert.ok(masked.result.lines.join('\n').includes('NEXTERM_CONTROL_TOKEN=[hidden]'), masked.result.lines.join('\n'));
      assert.ok(!masked.result.lines.join('\n').includes('Zm9vYmFy'), 'the token is masked');
      assert.ok(masked.result.lines.every((line) => typeof line === 'string' && !/\x1b/.test(line)), 'plain text, no colours');
      assert.equal(masked.result.hidden, 1);
      assert.equal(errorCode(await ask(a, 'read-screen', { mask: false }, TYPE_AND_READ)), 'forbidden');
      allowOthers();
      const clear = await ask(a, 'read-screen', { mask: false }, { typeAndRead: true, other: true });
      assert.equal(clear.ok, true);
      assert.ok(clear.result.lines.join('\n').includes('Zm9vYmFy'));
      assert.equal(clear.result.masked, false);
    });
  });

  test('CD-25: the screen — a line wrapped onto its first row read whole; `lines` the last N logical lines; the alternate screen when it is up, said so', async () => {
    const shown = shownTerminal({ cols: 20, rows: 4 });
    for (let i = 1; i <= 30; i += 1) await write(shown.term, `line ${i}\r\n`);
    // 70 characters over four rows of 20, then the prompt: the screen's first
    // row is the second row of that line.
    await write(shown.term, `${'w'.repeat(70)}\r\n$ `);
    const screen = readScreen(shown.term);
    assert.deepEqual(screen.lines, ['w'.repeat(70), '$'], 'the wrapped line whole, from where it began');
    assert.deepEqual([screen.alternate, screen.cols, screen.rows], [false, 20, 4]);
    const last = readScreen(shown.term, { lines: 4 });
    assert.deepEqual(last.lines, ['line 29', 'line 30', 'w'.repeat(70), '$']);
    await write(shown.term, '\x1b[?1049h\x1b[Htop - 12:00\r\nPID USER');
    const alt = readScreen(shown.term, { lines: 50 });
    assert.equal(alt.alternate, true);
    assert.deepEqual(alt.lines, ['top - 12:00', 'PID USER']);
    await write(shown.term, '\x1b[?1049l');
    assert.equal(readScreen(shown.term).alternate, false);
    // Within the answer's size: the oldest lines go first.
    const capped = readScreen(shown.term, { lines: 30, maxBytes: 40 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.lines.at(-1), '$', capped.lines.join('|'));
    assert.ok(capped.lines.join('\n').length <= 40);
    assert.equal(READ_MAX_BYTES, 512 * 1024, 'half the backend\'s 1 MiB answer, for JSON escaping');
  });
});

// ---- focus ----------------------------------------------------------------------------

describe('Control requests: focus', () => {
  test('CD-26: in a window in the background, focus still never switches — the target flashes and is marked, and the OS is asked for attention; the window is never raised', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      S.getState().switchTab(b);
      const pane = S.getState().getActivePaneId();
      const behind = harness({ focused: false });
      const asked = await behind.ask(a, 'focus', {});
      assert.deepEqual(asked.result, { switched: false }, 'nothing about the window in the answer');
      await sleep(0);
      assert.equal(behind.attentionAsked.length, 1, 'the Dock bounces, the taskbar flashes');
      assert.equal(S.getState().activeTabId, b, 'what the user comes back to type into is where they left it');
      assert.equal(S.getState().getActivePaneId(), pane);
      assert.deepEqual(behind.focusedViews, [], 'no terminal is handed the keyboard');
      assert.equal(S.getState().controlled[a]?.cmd, 'focus');
      assert.ok(S.getState().attentionFlash[a] !== undefined);
    });
  });
});

// ---- seen ----------------------------------------------------------------------------

describe('Seen: another terminal controlled is flashed and marked', () => {
  test('CD-27: send, read-screen, focus and new-split flash and mark another terminal naming the caller; send and focus mark the caller itself too; reading its own screen does not', async () => {
    await inStore(async () => {
      previousMark = terminalStore.__setControlledMarkMs(200);
      const [a, b] = await threeTerminals();
      S.getState().renameTab(a, 'agent');
      allowTyping();
      allowOthers();
      const shown = new Map([[a, shownTerminal()], [b, shownTerminal()]]);
      let t = 0;
      const { ask } = harness({ shown, clock: () => (t += 6000) });
      const both = { typeAndRead: true, other: true };
      const markOf = (id) => {
        const mark = S.getState().controlled[id];
        return mark ? [mark.by, mark.byTitle, mark.cmd] : null;
      };
      await writes(async () => {
        await ask(a, 'read-screen', {}, both);
        assert.deepEqual(S.getState().controlled, {}, 'reading its own screen is not news');
        for (const cmd of ['send', 'focus']) {
          S.setState({ controlled: {}, attentionFlash: {} });
          assert.equal((await ask(a, cmd, cmd === 'send' ? { keys: ['Enter'] } : {}, both)).ok, true, cmd);
          assert.deepEqual(markOf(a), [a, 'agent', cmd], `${cmd} on itself is marked, naming itself`);
          assert.ok(S.getState().attentionFlash[a] !== undefined, `${cmd} on itself flashes its ring`);
        }
        for (const cmd of ['send', 'read-screen', 'focus']) {
          S.setState({ controlled: {}, attentionFlash: {} });
          const args = cmd === 'send' ? { target: b, keys: ['Enter'] } : { target: b };
          assert.equal((await ask(a, cmd, args, both)).ok, true, cmd);
          assert.deepEqual(markOf(b), [a, 'agent', cmd], cmd);
          assert.ok(S.getState().attentionFlash[b] !== undefined, `${cmd} flashes the ring`);
        }
        S.setState({ controlled: {}, attentionFlash: {} });
        const split = (await ask(a, 'new-split', {})).result.id;
        assert.deepEqual(markOf(split), [a, 'agent', 'new-split'], 'a split a program opened says so');
      });
      // A refused request is no control: nothing marked.
      S.setState({ controlled: {} });
      settings().setSetting('terminalControlOtherTerminals', false);
      assert.equal(errorCode(await ask(a, 'focus', { target: b }, both)), 'forbidden');
      assert.deepEqual(S.getState().controlled, {});
    });
  });

  test('CD-28: the mark comes down after CONTROLLED_MARK_MS, a second call restarts it, and a closed terminal takes its mark and timer along', async () => {
    await inStore(async () => {
      assert.equal(terminalStore.CONTROLLED_MARK_MS, 10_000);
      previousMark = terminalStore.__setControlledMarkMs(60);
      const [a, b, c] = await threeTerminals();
      S.getState().noteControlled(b, { by: a, cmd: 'send' });
      await sleep(40);
      S.getState().noteControlled(b, { by: a, cmd: 'focus' });
      await sleep(40);
      assert.equal(S.getState().controlled[b]?.cmd, 'focus', 'restarted by the second: still up');
      await sleep(50);
      assert.equal(S.getState().controlled[b], undefined, 'down after its time');
      assert.equal(terminalStore.__attentionKept().controlledTimers, 0);
      S.getState().noteControlled(c, { by: a, cmd: 'send' });
      assert.equal(terminalStore.__attentionKept().controlledTimers, 1);
      await S.getState().closeTab(c);
      assert.equal(S.getState().controlled[c], undefined);
      assert.equal(terminalStore.__attentionKept().controlledTimers, 0, 'its timer went with it');
      assert.equal(S.getState().noteControlled('tab-term-999', { by: a }), false);
    });
  });
});

// ---- logged ---------------------------------------------------------------------------

describe('Logged: the last 500 calls, never what they carried', () => {
  test('CD-29: an entry says when, who, what, of whom, how much and the answer — never the text sent, the screen read, or anything else it is handed', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      S.getState().renameTab(b, 'build');
      allowTyping();
      allowOthers();
      const secret = fx('PASS·WORD=correct-horse-battery');
      const shown = shownTerminal({ cols: 80 });
      await write(shown.term, `${fx('my sec·ret screen line')}\r\n`);
      const { ask } = harness({ shown: new Map([[b, shown]]) });
      const both = { typeAndRead: true, other: true };
      await writes(async () => {
        await ask(a, 'send', { target: b, text: secret }, both);
        await ask(a, 'read-screen', { target: b, mask: false }, both);
        await ask(a, 'set-status', { text: 'status text' });
      });
      const entries = useControlLogStore.getState().entries;
      const [sent, read, status] = entries;
      assert.deepEqual(
        [sent.cmd, sent.caller, sent.target, sent.targetTitle, sent.size, sent.lines, sent.result],
        ['send', a, b, 'build', secret.length, null, 'ok']
      );
      assert.deepEqual([read.cmd, read.target, read.lines, read.size], ['read-screen', b, 1, null]);
      assert.deepEqual([status.cmd, status.target], ['set-status', null]);
      const all = JSON.stringify(entries);
      for (const kept of [secret, 'correct-horse', fx('sec·ret screen'), 'status text']) {
        assert.ok(!all.includes(kept), `the log holds ${JSON.stringify(kept)}`);
      }
      for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['at', 'caller', 'callerTitle', 'cmd', 'id', 'lines', 'result', 'size', 'target', 'targetTitle']);
      }
      // Handed more, it keeps only its fields.
      assert.deepEqual(Object.keys(logEntry({ cmd: 'send', text: 'x', token: 'y', screen: 'z' })).sort(), ['at', 'caller', 'callerTitle', 'cmd', 'lines', 'result', 'size', 'target', 'targetTitle']);
    });
  });

  test(`CD-30: the log keeps the last ${LOG_LIMIT}, the oldest going first, and nothing goes to storage`, () => {
    useControlLogStore.setState({ entries: [] });
    const written = [];
    const storage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem: (k) => written.push(k), removeItem() {}, clear() {} };
    try {
      for (let i = 0; i < LOG_LIMIT + 10; i += 1) useControlLogStore.getState().record({ cmd: 'list', caller: `tab-term-${i + 1}`, result: 'ok' });
    } finally {
      if (storage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = storage;
    }
    const entries = useControlLogStore.getState().entries;
    assert.equal(entries.length, LOG_LIMIT);
    assert.equal(entries[0].caller, 'tab-term-11', 'the ten oldest went');
    assert.equal(entries.at(-1).caller, `tab-term-${LOG_LIMIT + 10}`);
    assert.deepEqual(written, [], 'in memory only');
    useControlLogStore.getState().clear();
    assert.equal(useControlLogStore.getState().entries.length, 0);
  });
});

// ---- the settings, and the backend told them ---------------------------------------------

describe('Settings ▸ Terminal ▸ Control', () => {
  test('CD-31: the API on by default, typing and reading off, other terminals off — as the backend is told them', () => {
    const defaults = settings().settingsDefaults;
    assert.deepEqual(
      [defaults.terminalControl, defaults.terminalControlTypeAndRead, defaults.terminalControlOtherTerminals],
      [true, false, false]
    );
    assert.deepEqual(controlSettingsOf(defaults), { enabled: true, type_and_read: false, other_terminals: false });
  });

  test('CD-32: reported at start and on every change of the three, in order — a slow report holds the next — and the stop reports nothing', async () => {
    settings().resetSettings();
    const sent = [];
    const pending = [];
    const send = (values) => {
      sent.push(values);
      return new Promise((resolve) => pending.push(resolve));
    };
    const stop = reportControlSettings(useSettingsStore, send);
    try {
      await sleep(0);
      assert.deepEqual(sent, [{ enabled: true, type_and_read: false, other_terminals: false }]);
      settings().setSetting('terminalControlTypeAndRead', true);
      settings().setSetting('terminalFontSize', 15);
      settings().setSetting('terminalControl', false);
      await sleep(0);
      assert.equal(sent.length, 1, 'the next waits for the first to be answered');
      pending.shift()();
      await sleep(0);
      assert.deepEqual(sent[1], { enabled: true, type_and_read: true, other_terminals: false });
      assert.equal(sent.length, 2);
      pending.shift()();
      await sleep(0);
      assert.deepEqual(sent[2], { enabled: false, type_and_read: true, other_terminals: false });
      assert.equal(sent.length, 3, 'a font size is not one of them');
      pending.shift()();
    } finally {
      stop();
    }
    settings().setSetting('terminalControl', true);
    await sleep(0);
    assert.equal(sent.length, 3, 'stopped: nothing more, and no "off" on the way out');
    settings().resetSettings();
  });

  test('CD-33: a backend that refuses a report does not stop the ones after it', async () => {
    settings().resetSettings();
    const sent = [];
    let first = true;
    const send = async (values) => {
      sent.push(values);
      if (first) {
        first = false;
        throw new Error('not yet');
      }
    };
    const warn = console.warn;
    console.warn = () => {};
    const stop = reportControlSettings(useSettingsStore, send);
    try {
      settings().setSetting('terminalControlOtherTerminals', true);
      await sleep(5);
      assert.equal(sent.length, 2);
      assert.equal(sent[1].other_terminals, true);
    } finally {
      stop();
      console.warn = warn;
      settings().resetSettings();
    }
  });
});

describe('Review round 2: focus, self, fan-out, prompts, deadlines, one notification allowance', () => {
  /** Answer `pty_foreground_owner` with `answer` (a value, a rejection, or a function of the args) while `fn` runs; the sessions asked. */
  async function foregroundOwner(answer, fn) {
    const original = mockBridge.invoke;
    const asked = [];
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_foreground_owner') {
        asked.push(args?.session_id);
        return typeof answer === 'function' ? answer(args) : Promise.resolve(answer);
      }
      return original.call(this, command, args, ...rest);
    };
    try {
      await fn();
    } finally {
      mockBridge.invoke = original;
    }
    return asked;
  }

  test('CD-40: in a focused window focus never moves the keyboard — the target flashes and is marked instead; at most once every 5 s from one terminal', async () => {
    await inStore(async () => {
      previousMark = terminalStore.__setControlledMarkMs(200);
      const [a, b] = await threeTerminals();
      allowOthers();
      S.getState().switchTab(b);
      const pane = S.getState().getActivePaneId();
      let t = 0;
      const { ask, focusedViews, attentionAsked } = harness({ focused: true, clock: () => t });
      const answer = await ask(a, 'focus', {});
      assert.deepEqual(answer.result, { switched: false }, 'the same answer whether or not the user is looking');
      assert.equal(S.getState().activeTabId, b, 'the keyboard stays where the user is typing');
      assert.equal(S.getState().getActivePaneId(), pane);
      assert.deepEqual(focusedViews, []);
      await sleep(0);
      assert.equal(attentionAsked.length, 0);
      assert.equal(S.getState().controlled[a]?.cmd, 'focus', 'marked — even the caller itself');
      assert.ok(S.getState().attentionFlash[a] !== undefined, 'its ring flashes: where to look');
      t += 1000;
      assert.equal(errorCode(await ask(a, 'focus', { target: b }, { other: true })), 'rate_limited', 'a second within 5 s');
      t += 4500;
      assert.equal(errorCode(await ask(a, 'focus', { target: b }, { other: true })), 'ok', 'after 5 s');
      assert.equal(S.getState().activeTabId, b);
    });
  });

  test("CD-41: send asks the backend who owns the target's foreground — another user (sudo, su) is refused; null (Windows) is no word; an error or no answer in 500 ms fails closed", async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const { ask } = harness();
      const both = { typeAndRead: true, other: true };
      const asked = [];
      const typed = await writes(async () => {
        asked.push(...(await foregroundOwner({ same_user: false }, async () => {
          const answer = await ask(a, 'send', { target: b, text: 'ls' }, both);
          assert.equal(errorCode(answer), 'refused');
          assert.match(answer.error.message, /another user \(sudo, su\)/);
        })));
        for (const [what, answer] of [
          ['an error', () => Promise.reject(new Error('no such command'))],
          ['no answer within 500 ms', () => new Promise((resolve) => setTimeout(() => resolve({ same_user: true }), 700))],
        ]) {
          await foregroundOwner(answer, async () => {
            const refused = await ask(a, 'send', { target: b, text: 'rm -rf build' }, both);
            assert.equal(errorCode(refused), 'refused', what);
            assert.match(refused.error.message, /could not check what runs in that terminal; try again/, what);
          });
        }
        for (const answer of [{ same_user: true }, { same_user: null }]) {
          await foregroundOwner(answer, async () => {
            assert.equal((await ask(a, 'send', { target: b, text: 'x' }, both)).ok, true, JSON.stringify(answer));
          });
        }
      });
      assert.deepEqual(asked, [sessionOf(b)], "the TARGET's session is asked about");
      assert.deepEqual(typed, [[sessionOf(b), 'x'], [sessionOf(b), 'x']], 'typed only with a word from the backend that allows it');
    });
  });

  test('CD-42: a prompt for a secret on the target\'s cursor line refuses send on every platform — the one net Windows has', async () => {
    const term = shownTerminal({ cols: 30 }).term;
    for (const [line, secret] of [
      ['[sudo] password for kim: ', true],
      ['Password:', true],
      ["Enter passphrase for key 'C:\\Users\\kim\\.ssh\\id_ed25519':", true],
      ['Enter PIN: ', true],
      ['비밀번호: ', true],
      ['PASSWORD for root:', true],
      // Re-verification F3.
      ['[sudo] kim의 암호: ', true],
      ['암호:', true],
      ['Enter pass phrase for /tmp/key.pem:', true],
      ['Enter PEM pass phrase:', true],
      ['Password (again):', true],
      ["Enter PIN for 'SSH key':", true],
      ['Passcode:', true],
      ['Verification code: ', true],
      ['Password: ****', true],
      ['Enter password: * * *  ', true],
      ['Enter secret: ', true],
      ['Token: ', true],
      ['Enter OTP:', true],
      // Re-verification round 4: other languages, other codes, `>` and blanks.
      ['Passwort:', true],
      ['Kennwort: ', true],
      ['Mot de passe :', true],
      ['Contraseña:', true],
      ['パスワード:', true],
      ['密码：', true],
      ['密碼:', true],
      ['MFA code:', true],
      ['Authentication code: ', true],
      ['API key:', true],
      ['Password>', true],
      ['Enter passphrase> ', true],
      ['Passphrase: ____', true],
      ['PS C:\\Users\\kim> ', false],
      ['PS C:\\passwords>', false],
      ["kim@host's password: ", true],
      ['Ping statistics:', false],
      ['bypass phrasebook:', false],
      ['$ echo password', false],
      ['Password: typed', false],
      ['compiling spin:', false],
      ['$ ', false],
    ]) {
      await write(term, `\r\n${line}`);
      assert.equal(secretPromptOnScreen(term), secret, JSON.stringify(line));
    }
    await inStore(async () => {
      const [a] = await threeTerminals();
      allowTyping();
      const shown = shownTerminal();
      const { ask } = harness({ shown: new Map([[a, shown]]) });
      const typed = await writes(async () => {
        // Windows: no echo to read, so the store says nothing is hidden.
        await write(shown.term, 'Password: ');
        const answer = await ask(a, 'send', { text: 'hunter2', keys: ['Enter'] }, TYPE_AND_READ);
        assert.equal(errorCode(answer), 'refused');
        assert.match(answer.error.message, /password prompt/);
        await write(shown.term, '\r\n$ ');
        assert.equal((await ask(a, 'send', { text: 'ls' }, TYPE_AND_READ)).ok, true);
      });
      assert.deepEqual(typed, [[sessionOf(a), 'ls']]);
    });
  });

  test(`CD-43: at most ${CHILDREN_MAX} splits a caller opened are open at once, and ${SPLITS_PER_MINUTE} new ones a minute`, async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      let t = 0;
      const { ask } = harness({ clock: () => t });
      const kids = [];
      for (let i = 0; i < CHILDREN_MAX; i += 1) kids.push((await ask(a, 'new-split', {})).result.id);
      const ninth = await ask(a, 'new-split', {});
      assert.equal(errorCode(ninth), 'refused');
      assert.match(ninth.error.message, /close one first/);
      for (const id of kids.slice(0, 3)) await S.getState().closeTab(id);
      assert.equal((await ask(a, 'new-split', {})).ok, true, 'room again once some closed');
      assert.equal((await ask(a, 'new-split', {})).ok, true);
      const eleventh = await ask(a, 'new-split', {});
      assert.equal(errorCode(eleventh), 'rate_limited', 'the 11th in a minute');
      t += 60_000;
      assert.equal((await ask(a, 'new-split', {})).ok, true, 'a minute on');
    });
  });

  test(`CD-44: at most ${OPENED_MAX} terminals opened by programs are open in all, whoever opened them`, async () => {
    await inStore(async () => {
      const callers = [S.getState().activeTabId];
      for (let i = 0; i < 4; i += 1) callers.push((await S.getState().createTab()).id);
      for (const id of callers) await prompt(id);
      const { ask } = harness();
      let opened = 0;
      for (const caller of callers.slice(0, 4)) {
        for (let i = 0; i < CHILDREN_MAX; i += 1) if ((await ask(caller, 'new-split', {})).ok) opened += 1;
      }
      assert.equal(opened, OPENED_MAX);
      const more = await ask(callers[4], 'new-split', {});
      assert.equal(errorCode(more), 'refused');
      assert.match(more.error.message, new RegExp(`${OPENED_MAX} terminals open already`));
    });
  });

  test(`CD-45: desktop notifications from nexterm-cli are capped at ${API_DESKTOP_PER_MINUTE} a minute across all terminals — past it a note is still listed`, async () => {
    await inStore(async () => {
      const ids = [S.getState().activeTabId];
      for (let i = 0; i < API_DESKTOP_PER_MINUTE; i += 1) ids.push((await S.getState().createTab()).id);
      const before = mockBridge.desktopNotifications.length;
      const { ask } = harness();
      const answers = [];
      for (const id of ids) answers.push(await ask(id, 'notify', { title: `from ${id}` }));
      await sleep(5);
      assert.ok(answers.every((a) => a.ok && a.result.listed), 'every one listed');
      assert.deepEqual(answers.map((a) => a.result.desktop), [...new Array(API_DESKTOP_PER_MINUTE).fill(true), false]);
      assert.equal(mockBridge.desktopNotifications.length - before, API_DESKTOP_PER_MINUTE);
    });
  });

  test("CD-46: one notification allowance per terminal, shared by OSC 9/99/777 and nexterm-cli notify — either way round", async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      const osc = (tabId) => {
        const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
        const notes = [];
        installProgramNotifications(term, {
          allowLive: (now) => S.getState().allowProgramNote(tabId, now),
          onNotify: (note) => notes.push(note),
        });
        return { term, notes };
      };
      const { ask } = harness();
      const first = osc(a);
      await write(first.term, '\x1b]9;printed by the program\x07');
      assert.equal(first.notes.length, 1);
      assert.equal(errorCode(await ask(a, 'notify', { title: 'then the CLI' })), 'rate_limited', 'the OSC note used the allowance');
      assert.equal((await ask(b, 'notify', { title: 'the CLI first' })).ok, true);
      const second = osc(b);
      await write(second.term, '\x1b]9;then printed\x07');
      assert.equal(second.notes.length, 0, 'the CLI note used the allowance');
      const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      assert.match(registry, /allowLive: \(now\) => useTerminalStore\.getState\(\)\.allowProgramNote\?\.\(tabId, now\) \?\? true,/, "the app's terminals share it");
    });
  });

  test('CD-47: past deadline_at nothing is done — not a status, a split, a note, a key or a focus — and the log says not_responding; a deadline passing mid-wait types nothing later', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const { ask } = harness({ focused: false });
      const past = Date.now() - 1;
      const before = { tabs: S.getState().tabs.length, notes: S.getState().notifications.length, active: S.getState().activeTabId };
      const typed = await writes(async () => {
        for (const [cmd, args] of [
          ['set-status', { text: 'late' }],
          ['notify', { title: 'late' }],
          ['new-split', {}],
          ['send', { text: 'late' }],
          ['focus', { target: b }],
        ]) {
          const answer = await ask(a, cmd, args, { typeAndRead: true, other: true, deadlineAt: past });
          assert.equal(errorCode(answer), 'not_responding', cmd);
        }
      });
      assert.deepEqual(typed, []);
      assert.equal(S.getState().reportedStatus[a], undefined);
      assert.deepEqual(
        [S.getState().tabs.length, S.getState().notifications.length, S.getState().activeTabId],
        [before.tabs, before.notes, before.active]
      );
      assert.ok(useControlLogStore.getState().entries.slice(-5).every((e) => e.result === 'not_responding'));
      // A shell that draws its prompt only after the caller stopped waiting.
      terminalStore.__setAgentPromptWaitMs(5000);
      const { ask: ask2 } = harness({ typingWaitMs: 2000 });
      const child = (await ask2(a, 'new-split', {})).result.id;
      const late = await writes(async () => {
        const answer = ask2(a, 'send', { target: child, text: 'rm -rf build' }, { typeAndRead: true, deadlineAt: Date.now() + 60 });
        await sleep(120);
        await prompt(child);
        assert.equal(errorCode(await answer), 'not_responding');
        await sleep(50);
      });
      assert.deepEqual(late, [], 'typed after the caller had given up');
      // A split whose folder check outlasts the deadline is not made.
      const original = mockBridge.invoke;
      mockBridge.invoke = async function (command, args, ...rest) {
        if (command === 'fs_dir_exists') await sleep(120);
        return original.call(this, command, args, ...rest);
      };
      const count = S.getState().tabs.length;
      try {
        const { ask: ask3 } = harness();
        const answer = await ask3(b, 'new-split', { cwd: '/workspace/src' }, { deadlineAt: Date.now() + 60 });
        assert.equal(errorCode(answer), 'not_responding');
        await sleep(150);
      } finally {
        mockBridge.invoke = original;
      }
      assert.equal(S.getState().tabs.length, count, 'a split made after the caller had given up');
    });
  });

  test("CD-48: new-split continues the CALLER — its folder and shell — not the tab its pane happens to show", async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      // The caller runs bash in /workspace/src, behind zsh in /workspace.
      S.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === a ? { ...t, cwd: '/workspace/src', shell: '/bin/bash' } : t.id === b ? { ...t, cwd: '/workspace', shell: '/bin/zsh' } : t)),
      }));
      S.getState().switchTab(b);
      const { ask } = harness();
      const answer = await ask(a, 'new-split', {});
      const child = tabById(answer.result.id);
      assert.deepEqual([child.cwd, child.shell], ['/workspace/src', '/bin/bash']);
    });
  });
});

describe('Re-verification: never-shown targets, late splits, a split escape, children\'s desktop notes', () => {
  test('CD-49: send into a terminal never shown is refused — nothing can read the prompt it shows — and nothing is typed', async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      const { ask } = harness({ shown: new Map([[a, shownTerminal()]]), showAll: false });
      const typed = await writes(async () => {
        const answer = await ask(a, 'send', { target: b, text: 'ls' }, { typeAndRead: true, other: true });
        assert.equal(errorCode(answer), 'not_rendered');
        assert.match(answer.error.message, /open that terminal once first/);
        assert.equal((await ask(a, 'send', { text: 'ls' }, TYPE_AND_READ)).ok, true, 'a shown one takes it');
      });
      assert.deepEqual(typed, [[sessionOf(a), 'ls']]);
    });
  });

  test('CD-50: a split whose shell starts after the caller gave up is closed again, its command never typed, and nobody\'s child', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      allowTyping();
      const { ask, dispatcher } = harness();
      const before = S.getState().tabs.map((t) => t.id);
      const original = mockBridge.invoke;
      mockBridge.invoke = async function (command, args, ...rest) {
        if (command === 'pty_spawn') await sleep(150);
        return original.call(this, command, args, ...rest);
      };
      let typed;
      try {
        typed = await writes(async () => {
          const answer = await ask(a, 'new-split', { command: 'make deploy' }, { typeAndRead: true, deadlineAt: Date.now() + 60 });
          assert.equal(errorCode(answer), 'not_responding');
          await sleep(400);
        });
      } finally {
        mockBridge.invoke = original;
      }
      assert.deepEqual(typed, [], 'the command was typed after the caller had given up');
      assert.deepEqual(S.getState().tabs.map((t) => t.id), before, 'the split made too late is still open');
      assert.equal(dispatcher.childrenOf(sessionOf(a)).size, 0);
    });
  });

  test(`CD-51: a send right after one that ended in Escape cannot finish the sequence it began — for ${ESCAPE_JOIN_MS} ms, per terminal`, async () => {
    await inStore(async () => {
      const [a, b] = await threeTerminals();
      allowTyping();
      allowOthers();
      let t = 0;
      const { ask } = harness({ clock: () => t });
      const both = { typeAndRead: true, other: true };
      const typed = await writes(async () => {
        assert.equal((await ask(a, 'send', { target: b, keys: ['Escape'] }, both)).ok, true);
        t += 500;
        const text = await ask(a, 'send', { target: b, text: '[201~' }, both);
        assert.equal(errorCode(text), 'refused', 'an end of paste spelled across two sends');
        const keys = await ask(a, 'send', { target: b, keys: ['['] }, both);
        assert.equal(errorCode(keys), 'bad_request', 'the same, from keys');
        assert.equal((await ask(a, 'send', { text: '[x' }, TYPE_AND_READ)).ok, true, 'another terminal is not affected');
        assert.equal((await ask(a, 'send', { target: b, text: 'ls' }, both)).ok, true, 'text that starts no sequence goes');
        t += 50;
        assert.equal((await ask(a, 'send', { target: b, keys: ['Escape'] }, both)).ok, true);
        t += ESCAPE_JOIN_MS + 1;
        assert.equal((await ask(a, 'send', { target: b, text: '[201~' }, both)).ok, true, 'a second on, it is a new key press');
      });
      assert.deepEqual(typed.map(([, data]) => data), ['\x1b', '[x', 'ls', '\x1b', '[201~']);
    });
  });

  test('CD-52: what a terminal opened through the API prints as a notification counts against the API\'s desktop cap; other terminals\' do not', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      const { ask, dispatcher } = harness();
      const previous = terminalStore.setProgramDesktopGate(dispatcher.desktopAllowedFor);
      try {
        const child = (await ask(a, 'new-split', {})).result.id;
        const note = { title: 'from the child', body: '', occasion: 'always', urgency: 1 };
        const routes = [];
        for (let i = 0; i < API_DESKTOP_PER_MINUTE + 1; i += 1) routes.push(S.getState().notifyFromProgram(child, note));
        assert.deepEqual(routes.map((r) => r.desktop), [...new Array(API_DESKTOP_PER_MINUTE).fill(true), false], "the child's OSC notes are capped");
        const cli = await ask(a, 'notify', { title: 'and the CLI' });
        assert.deepEqual([cli.result.listed, cli.result.desktop], [true, false], 'the CLI shares the cap with them');
        assert.equal(S.getState().notifyFromProgram(a, note).desktop, true, 'a terminal the user opened is not the API\'s to limit');
      } finally {
        terminalStore.setProgramDesktopGate(previous);
      }
      const bridge = readFileSync(new URL('../../src/lib/controlBridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      assert.match(bridge, /setProgramDesktopGate\(dispatcher\.desktopAllowedFor\)/, "the app's dispatcher sets it");
    });
  });
});

describe('Re-verification round 4: the deadline and the answer agree', () => {
  /** Date.now() frozen while `fn` runs: only the budget's own timer can make the request late. */
  async function frozenClock(fn) {
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      await fn();
    } finally {
      Date.now = realNow;
    }
  }

  test('CD-53: when the budget runs out the request is late whatever the clock reads — a split made after the answer was given is closed, its command never typed', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      allowTyping();
      const { ask, dispatcher } = harness({ budgetMs: 40 });
      const before = S.getState().tabs.map((t) => t.id);
      const original = mockBridge.invoke;
      mockBridge.invoke = async function (command, args, ...rest) {
        if (command === 'pty_spawn') await sleep(120);
        return original.call(this, command, args, ...rest);
      };
      let typed;
      try {
        typed = await writes(async () => {
          await frozenClock(async () => {
            const answer = await ask(a, 'new-split', { command: 'make deploy' }, TYPE_AND_READ);
            assert.equal(errorCode(answer), 'not_responding');
            await sleep(500);
          });
        });
      } finally {
        mockBridge.invoke = original;
      }
      assert.deepEqual(typed, [], 'typed after the answer said nothing was done');
      assert.deepEqual(S.getState().tabs.map((t) => t.id), before, 'the split outlived its "not responding"');
      assert.equal(dispatcher.childrenOf(sessionOf(a)).size, 0);
    });
  });

  test('CD-54: a request already committed to its write is answered with what it did — not "not responding" while its keys go out', async () => {
    await inStore(async () => {
      const a = S.getState().activeTabId;
      await prompt(a);
      allowTyping();
      const { ask } = harness({ budgetMs: 40 });
      const original = mockBridge.invoke;
      const written = [];
      mockBridge.invoke = async function (command, args, ...rest) {
        if (command === 'pty_write') {
          await sleep(120);
          written.push(args.data);
          return null;
        }
        return original.call(this, command, args, ...rest);
      };
      try {
        await frozenClock(async () => {
          const answer = await ask(a, 'send', { text: 'ls', keys: ['Enter'] }, TYPE_AND_READ);
          assert.equal(answer.ok, true, JSON.stringify(answer));
        });
      } finally {
        mockBridge.invoke = original;
      }
      assert.deepEqual(written, ['ls\r']);
    });
  });
});

describe('The first shells wait for the backend to know the settings', () => {
  /** Every invoke of `commands` while `fn` runs, in order, as `[command, at]`; `delay` holds the answer to control_set_settings. */
  async function invokes(fn, { delay = 0 } = {}) {
    const original = mockBridge.invoke;
    const seen = [];
    mockBridge.invoke = async function (command, args, ...rest) {
      if (command === 'control_set_settings') {
        seen.push(['control_set_settings asked', args]);
        await sleep(delay);
        const answer = await original.call(this, command, args, ...rest);
        seen.push(['control_set_settings answered']);
        return answer;
      }
      if (command === 'pty_spawn') seen.push(['pty_spawn', args?.cwd ?? null]);
      return original.call(this, command, args, ...rest);
    };
    try {
      await fn();
    } finally {
      mockBridge.invoke = original;
    }
    return seen;
  }

  test("CD-34: with the backend slow to answer, no shell is spawned until it has the user's settings — an \"off\" holds from the first terminal", async () => {
    await inStore(async () => {
      settings().setSetting('terminalControl', false);
      let stop = null;
      const seen = await invokes(
        async () => {
          stop = reportControlSettings();
          const previous = terminalStore.holdSpawnsUntil(controlSettingsReported());
          try {
            await S.getState().createTab();
          } finally {
            terminalStore.holdSpawnsUntil(previous);
          }
        },
        { delay: 80 }
      );
      stop();
      const order = seen.map(([what]) => what);
      assert.deepEqual(order.slice(0, 3), ['control_set_settings asked', 'control_set_settings answered', 'pty_spawn'], JSON.stringify(seen));
      assert.deepEqual(seen[0][1], { enabled: false, type_and_read: false, other_terminals: false }, "the user's saved values, not the defaults");
    });
  });

  test('CD-35: every pty_spawn goes through the gate — a fresh start, a restore, a new terminal, a split and a restart alike — and a backend that never answers costs a bounded wait', async () => {
    const store = readFileSync(new URL('../../src/stores/terminalStore.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal((store.match(/invoke\('pty_spawn'/g) || []).length, 1, 'a pty_spawn that does not wait for the settings');
    assert.match(store, /async function spawnPty\(args\) \{\n\s*if \(spawnGate\) await spawnGate;\n\s*return invoke\('pty_spawn', args\);/);
    assert.ok((store.match(/spawnPty\(\{/g) || []).length >= 5, 'the five places a shell is started');
    const bridge = readFileSync(new URL('../../src/lib/controlBridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(bridge, /const stopReporting = reportControlSettings\(\);\n\s*holdSpawnsUntil\(controlSettingsReported\(\)\);/);
    const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(app.indexOf('useEffect(() => startControl(), [])') < app.indexOf('initTerminal();'), 'the terminals start before the settings are reported');
    await inStore(async () => {
      const previous = terminalStore.holdSpawnsUntil(new Promise(() => {}), 60);
      const started = Date.now();
      try {
        // Raced, so a gate that never opens fails here rather than hanging the suite.
        const tab = await Promise.race([S.getState().createTab(), sleep(2000).then(() => 'hung')]);
        assert.notEqual(tab, 'hung', 'the gate never opened: no terminal at all');
        assert.ok(tab, 'a terminal all the same');
        assert.ok(Date.now() - started >= 50, 'it waited');
        assert.ok(Date.now() - started < 2000, 'but not for ever');
      } finally {
        terminalStore.holdSpawnsUntil(previous);
      }
    });
  });
});

describe('Control: teardown', () => {
  test('CD-99: the store and the log back as the next suite expects them', () => {
    S.getState().dispose();
    S.setState({ reportedStatus: {}, controlled: {} });
    useControlLogStore.setState({ entries: [], open: false });
    settings().resetSettings();
    assert.deepEqual(S.getState().reportedStatus, {});
  });
});
