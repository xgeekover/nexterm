/**
 * The agent session history: what the side bar and the palette list, and the
 * recorder that keeps it (src/lib/agentHistory.js says what an entry is).
 *
 * **The recorder** watches the terminals from outside: one subscriber to the
 * terminal store compares each terminal's `tab.agent` with the last look
 * (`observeAgents`) and sends the backend what happened. How records are made
 * — `recordAgent`, `resolveAgentSession`, `noteAgentTitle`, `resumeAgent` —
 * is not touched by it. It does nothing until `start()`, which App.jsx calls
 * once: the test suites share one process, and a subscriber made at import
 * would record every suite's terminals.
 *
 * **Writes** go one at a time, in order, through one queue, after a short
 * wait (HISTORY_WRITE_DELAY_MS) that lets a burst — a title, then its id —
 * be merged per key into one write. Every write is an `agent_history_upsert`
 * with `lastUsedAt` now (the backend's merge keeps the newest event's end),
 * the title masked, and, when the terminal's key changed, the key the last
 * write for it was given as `replaces`. After the queue is empty the list is
 * read again: the file is what the history is, whoever else wrote it. On
 * `pagehide` the queue is sent at once, as far as the page lives to send it;
 * a macOS quit is not held (useUnsavedGuard.js), so `lastUsedAt` is the last
 * event recorded, not the moment the app closed.
 *
 * **Claude Code's own titles** (F16, and F17 for a conversation never saved).
 * When the list is loaded (`load`: at the start, and each time the palette's
 * Resume Agent Session… opens), and when a Claude Code agent ends, the
 * history's Claude Code entries with an id are looked up in Claude Code's
 * own transcripts (`lookUpClaudeConversations`, src/lib/claudeConversations.js)
 * and changed as `claudeHistoryChanges` says: a title found is kept, masked
 * (and stays once the transcript is gone — a lookup that finds none clears
 * nothing); an entry whose conversation was never saved, and that no
 * terminal of this window holds, is removed. And when a Resume started a new
 * Claude Code conversation in place of one never saved
 * (`onAgentConversationReplaced`, terminalStore's `resumeAgent`), the old
 * one's entry is removed then and there: it can never be resumed.
 *
 * **What the user curated** (F18-F30): a name, a pin, the archive, groups.
 * The store holds the groups as `agent_history_groups` answers them, read
 * after every list, with `readOnly` (a newer NexTerm wrote the file) and
 * the file's `version`. Each curation action (`pin`, `rename`, `archive`,
 * `moveToGroup`, `createGroup`, `renameGroup`, `setGroupCollapsed`,
 * `deleteGroup`, `deleteEntry`, …) runs after what is queued, so a write
 * queued before it cannot undo it, and reads the list again; one refused or
 * failed is said in the AGENT SESSIONS notice ('curationFailed'), and so is
 * a change to an entry that is no longer listed. A started
 * or resumed write unarchives its entry (`unarchive`); a title, an id
 * learned or an end never does, and no recorded event changes a name, a pin
 * or a group. A Claude Code entry the user pinned, named or grouped is not
 * dropped for never having been saved; when a Resume starts a new
 * conversation in its place, the new entry takes its name, pin and group
 * first, and the old one goes only once it has (F22).
 *
 * **Live Claude Code titles** (F23): the title a running Claude Code shows
 * in its terminal (`onAgentTitleShown`) is written as its entry's title,
 * once per text, through the same queue — the transcript's (F16) replaces
 * it at the agent's end and at the next load.
 *
 * **For the next phase** (monitoring several agents, a notification when one
 * finishes; nothing of it here): `holders` maps a history key to the
 * terminal of this window holding it, and `subscribeAgentLifecycle` hears
 * every event as it is recorded — started, resumed, idLearned, titled,
 * ended with its reason.
 */
import { create } from 'zustand';
import { invoke } from '../lib/ipc.js';
import { isKnownAgent, isSessionIdFor, newSessionId } from '../lib/agents.js';
import {
  carriedCuration,
  claudeHistoryChanges,
  claudeIdsHeld,
  entryGroupId,
  historyGroupName,
  historyHolders,
  historyKey,
  historyTitle,
  nextGroupName,
  observeAgents,
  queueUpsert,
  renameChange,
} from '../lib/agentHistory.js';
import { lookUpClaudeConversations } from '../lib/claudeConversations.js';
import { onAgentConversationReplaced, onAgentTitleShown, useTerminalStore } from './terminalStore.js';
import { useSystemStore } from './systemStore.js';

/** How long the queue waits for more before it writes. */
export const HISTORY_WRITE_DELAY_MS = 250;

/** What the recorder keeps between looks at the terminals (`observeAgents`). */
let tracked = new Map();
/** Upserts not sent yet, oldest first: `{ entry, key, replaces, tabId }`. */
let queue = [];
/** The end of the chain every backend call of this store goes through, one at a time. */
let tail = Promise.resolve();
let timer = null;
let writeDelay = HISTORY_WRITE_DELAY_MS;
let unsubscribe = null;
/** Stops hearing of Resumes that started a new conversation (`onAgentConversationReplaced`). */
let stopReplaced = null;
/** Stops hearing the titles Claude Code terminals show (`onAgentTitleShown`). */
let stopTitles = null;
/** tab id -> `{ key, title }`: the live Claude Code title last queued for that terminal's entry. */
const liveTitles = new Map();
const lifecycle = new Set();
/** Refusals already said in the console, so a refused write every second is said once. */
const said = new Set();

const messageOf = (err) => (err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err));

function report(what, err) {
  const message = messageOf(err);
  useAgentHistoryStore.setState({ error: message });
  if (said.has(message)) return;
  said.add(message);
  console.warn(`[AgentHistory] ${what}: ${message}`);
}

/** `fn` after every backend call this store made before it. */
function serially(fn) {
  const done = tail.then(fn);
  tail = done.catch(() => {});
  return done;
}

/**
 * Queue an upsert, merged with one not sent yet as the backend would merge
 * them (`queueUpsert`: never a queued conversation with an id into another).
 */
function enqueue(op) {
  queue = queueUpsert(queue, op);
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      serially(sendQueued);
    }, writeDelay);
  }
}

/** The key the backend gave `op`, kept as the terminal's for its next write. */
function keepKey(op, kept) {
  const key = typeof kept?.key === 'string' ? kept.key : null;
  const now = tracked.get(op.tabId);
  if (key && now?.live && now.key === op.key && key !== op.key) tracked.set(op.tabId, { ...now, key });
}

/** Send every queued upsert, in order, then read the list again. */
async function sendQueued() {
  if (queue.length === 0) return;
  while (queue.length > 0) {
    const op = queue.shift();
    try {
      const args = { entry: op.entry };
      if (op.replaces) args.replaces = op.replaces;
      if (op.unarchive === true) args.unarchive = true;
      const kept = await invoke('agent_history_upsert', args);
      keepKey(op, kept);
    } catch (err) {
      // Refused (a newer file, another NexTerm holding it too long) or not
      // saved: dropped. The terminal's next event writes it again.
      report('not recorded', err);
    }
  }
  await readList();
}

const isGroup = (g) => g !== null && typeof g === 'object' && typeof g.id === 'string' && typeof g.name === 'string';

/**
 * The groups, as `agent_history_groups` answers: `{ groups, readOnly,
 * version }`, or null when they could not be read — the list read goes on
 * without them (the groups the store had stay).
 */
async function readGroups() {
  try {
    const answer = await invoke('agent_history_groups');
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.groups)) return null;
    return {
      groups: answer.groups.filter(isGroup).map((g) => ({ id: g.id, name: g.name, collapsed: g.collapsed === true })),
      readOnly: answer.readOnly === true,
      version: Number.isInteger(answer.version) ? answer.version : null,
    };
  } catch (err) {
    report('its groups could not be read', err);
    return null;
  }
}

/**
 * Read the list into the store, then its groups (F20), and set both at
 * once: no entry is ever drawn against groups of another read. Resolves
 * with the entries, or null when the list could not be read.
 */
async function readList() {
  let entries;
  try {
    const all = await invoke('agent_history_list');
    entries = (Array.isArray(all) ? all : []).filter((e) => e && isKnownAgent(e.kind));
  } catch (err) {
    report('could not be read', err);
    return null;
  }
  const grouped = await readGroups();
  useAgentHistoryStore.setState({ entries, loaded: true, ...(grouped ?? {}) });
  return entries;
}

/**
 * Ask Claude Code about the Claude Code entries of `entries` — those of
 * `only` (session ids) when given — and keep what it says
 * (`claudeHistoryChanges`): titles found, and entries never saved that no
 * terminal of this window holds removed. The list is read again when
 * anything changed. A lookup that fails or takes too long changes nothing.
 */
async function askClaude(entries, only = null) {
  const claude = (Array.isArray(entries) ? entries : []).filter(
    (e) => e.kind === 'claude' && isSessionIdFor('claude', e.sessionId) && (only === null || only.includes(e.sessionId))
  );
  if (claude.length === 0) return;
  const answers = await lookUpClaudeConversations(claude.map((e) => e.sessionId));
  if (!answers) return;
  // Who holds what, asked after the answer: a terminal may have started or
  // ended meanwhile.
  const { removed, titled } = claudeHistoryChanges(claude, answers, claudeIdsHeld(useTerminalStore.getState().tabs));
  for (const op of titled) {
    try {
      await invoke('agent_history_upsert', { entry: op.entry });
    } catch (err) {
      report('could not keep a Claude Code title', err);
    }
  }
  for (const key of removed) {
    try {
      await invoke('agent_history_remove', { key });
    } catch (err) {
      report('could not remove an entry never saved', err);
    }
  }
  if (titled.length > 0 || removed.length > 0) await readList();
}

/** The list, read again, and what Claude Code says of its entries (`askClaude`). */
async function loadList() {
  const entries = await readList();
  if (entries) await askClaude(entries);
}

/**
 * After Claude Code agents ended (`ids`): what was queued first — their
 * ends — then what Claude Code says of them now. A first message may have
 * named the conversation; none sent, and it was never saved.
 */
async function claudeEnded(ids) {
  await sendQueued();
  const entries = await readList();
  if (entries) await askClaude(entries, ids);
}

/**
 * A Resume started a new Claude Code conversation in place of one never
 * saved (terminalStore `onAgentConversationReplaced`): the old one's entry
 * goes, after what was queued — the resume of it among that, and the new
 * conversation's start (`resumeAgent` makes the new record the terminal's
 * before it tells, so the recorder has queued it by then).
 *
 * One the user pinned, named or grouped (F22) first gives its name, pin and
 * group to the new conversation's entry (`agent_history_update`), and goes
 * only once that entry answered: when it is not there (not recorded — its
 * folder is not one the history keeps — or the update was refused) the old
 * one stays, with everything the user gave it.
 */
function onConversationReplaced(event) {
  if (event?.kind !== 'claude' || !isSessionIdFor('claude', event.from)) return;
  const key = historyKey({ kind: 'claude', sessionId: event.from });
  const to = isSessionIdFor('claude', event.to) ? historyKey({ kind: 'claude', sessionId: event.to }) : null;
  serially(async () => {
    await sendQueued();
    const entries = (await readList()) ?? useAgentHistoryStore.getState().entries;
    const changes = carriedCuration(entries.find((e) => e.key === key));
    if (changes) {
      let carried = null;
      try {
        carried = to ? await invoke('agent_history_update', { key: to, changes }) : null;
      } catch (err) {
        report('could not give a name, pin or group to the new conversation', err);
      }
      if (!carried || carried.key !== to) {
        await readList();
        return;
      }
    }
    try {
      await invoke('agent_history_remove', { key });
    } catch (err) {
      report('could not remove an entry never saved', err);
    }
    await readList();
  });
}

function emit(event) {
  for (const listener of [...lifecycle]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[AgentHistory] a lifecycle listener failed:', err);
    }
  }
}

/**
 * A Claude Code terminal showed a conversation title (terminalStore
 * `onAgentTitleShown`, F23): for the entry the recorder tracks for that
 * terminal — running, with that id — the title as the history keeps it
 * (`historyTitle`) is queued, once per text, with `lastUsedAt` now and no
 * end, and heard as `titled`. Never `unarchive`. A title before the
 * recorder tracks the agent, or of another conversation, is let go.
 */
function onTitleShown(event) {
  if (event?.kind !== 'claude' || !isSessionIdFor('claude', event.sessionId)) return;
  const t = tracked.get(event.tabId);
  if (!t?.live || !t.entry || t.entry.kind !== 'claude' || t.entry.sessionId !== event.sessionId) return;
  const title = historyTitle(event.title);
  const last = liveTitles.get(event.tabId);
  if (!title || (last && last.key === t.key && last.title === title)) return;
  liveTitles.set(event.tabId, { key: t.key, title });
  const entry = { ...t.entry, title, lastUsedAt: Date.now(), endedAt: null, endReason: null };
  enqueue({ entry, key: t.key, replaces: null, tabId: event.tabId });
  emit({ type: 'titled', tabId: event.tabId, key: t.key, entry: { ...entry, key: t.key } });
}

/**
 * A notice the terminal store put up: a pick of an entry a terminal of this
 * window already holds switched to it ('focused', `resumeFromHistory`).
 * Picking it was resuming it, so an archived one is unarchived (F29) —
 * explicitly, as no write of the recorder's comes of it.
 */
function onNotice(notice) {
  if (notice?.kind !== 'focused' || typeof notice.key !== 'string') return;
  const { key } = notice;
  serially(async () => {
    await sendQueued();
    const entries = (await readList()) ?? useAgentHistoryStore.getState().entries;
    if (entries.find((e) => e.key === key)?.archived !== true) return;
    try {
      await invoke('agent_history_update', { key, changes: { archived: false } });
    } catch (err) {
      report('could not unarchive the entry', err);
    }
    await readList();
  });
}

const osNow = () => useSystemStore.getState().os ?? null;

function setHolders(tabs) {
  const holders = historyHolders(tracked, tabs, osNow());
  const before = useAgentHistoryStore.getState().holders;
  if (JSON.stringify(before) !== JSON.stringify(holders)) useAgentHistoryStore.setState({ holders });
}

/** One look at the terminals: record what changed. */
function observe(tabs) {
  const seen = observeAgents(tracked, tabs, { now: Date.now(), os: osNow() });
  tracked = seen.tracked;
  const claudeEnds = [];
  for (const event of seen.events) {
    if (event.type === 'ended' && event.entry.kind === 'claude' && event.entry.sessionId) claudeEnds.push(event.entry.sessionId);
    // A start, or a resume, of an archived entry brings it back (F29).
    const unarchive = event.type === 'started' || event.type === 'resumed';
    enqueue({ entry: event.entry, key: event.key, replaces: event.replaces, tabId: event.tabId, ...(unarchive ? { unarchive } : {}) });
    emit({
      type: event.type,
      ...(event.reason ? { reason: event.reason } : {}),
      tabId: event.tabId,
      key: event.key,
      entry: { ...event.entry, key: event.key },
    });
  }
  for (const tabId of [...liveTitles.keys()]) if (!tracked.get(tabId)?.live) liveTitles.delete(tabId);
  setHolders(tabs);
  if (claudeEnds.length > 0) serially(() => claudeEnded(claudeEnds));
}

/**
 * The 'curationFailed' notice's words for a change to an entry the backend
 * no longer has (`agent_history_update` answered null): re-keyed while the
 * write waited (an OpenCode entry that learned its id), or removed by
 * another NexTerm.
 */
export const ENTRY_GONE_TEXT = 'The list changed before this could be done. If the session is still listed, try again.';

/** Its words for New Group… whose session is not in the group it made. */
export const NOT_MOVED_TEXT =
  'The group was made, but the list changed first and the session is not in it. If the session is still listed, move it to the group.';

/**
 * One curation write (F30), after what is queued — so a write queued before
 * it cannot undo it — then the list read again. `call` makes it and
 * resolves with the backend's answer, which this resolves with (null for
 * none). Refused or failed (too many curated or groups, a newer file, busy,
 * not saved): said in the AGENT SESSIONS notice, kind 'curationFailed', in
 * the backend's own words; the list is read again, and it resolves null.
 * `untold`, when given, is asked after that read with the answer, and the
 * words it gives (an answer that did not do what was asked) go in the same
 * notice; it resolves with the answer all the same.
 */
function curate(what, call, untold = null) {
  return serially(async () => {
    await sendQueued();
    let answer;
    try {
      answer = await call();
    } catch (err) {
      report(what, err);
      await readList();
      useTerminalStore.getState().showAgentHistoryNotice?.('curationFailed', messageOf(err));
      return null;
    }
    await readList();
    const text = untold ? untold(answer ?? null) : null;
    if (text) useTerminalStore.getState().showAgentHistoryNotice?.('curationFailed', text);
    return answer ?? null;
  });
}

/** `changes` (`agent_history_update`) to the entry under `key`: the entry as kept, or null — said when it is no longer listed. */
const updateEntry = (what, key, changes) =>
  curate(what, () => invoke('agent_history_update', { key: String(key ?? ''), changes }), (kept) => (kept ? null : ENTRY_GONE_TEXT));

/** An id for a new group: what the backend takes (`^[0-9A-Za-z_-]{1,64}$`). */
const newGroupId = () =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : newSessionId();

const groupById = (id) => useAgentHistoryStore.getState().groups.find((g) => g.id === id) ?? null;

function onPageHide() {
  useAgentHistoryStore.getState().flush();
}

export const useAgentHistoryStore = create((set, get) => ({
  /** The entries of the agents this build knows, newest first (as `agent_history_list` answers). */
  entries: [],
  /** Whether the list has been read once. */
  loaded: false,
  /** The last thing the backend refused or that failed, as text, or null when nothing has. */
  error: null,
  /**
   * By history key, the terminal in this window holding it: `{ tabId,
   * state: 'open' | 'offered' }` — running there, or offered back by a
   * restored terminal. What the side bar's badge reads.
   */
  holders: {},
  /** The groups, in display order, each `{ id, name, collapsed }` (`agent_history_groups`). */
  groups: [],
  /** Whether a newer NexTerm wrote the file: it is read, and every curation is refused. */
  readOnly: false,
  /** The file's format version as read (1, 2, or a newer one), or null before the first read. */
  version: null,

  /**
   * Start recording, and read the list. Once: a second call changes nothing.
   * The terminals as they are now are where the recorder starts from; none
   * of them is written until it does something. Returns `stop`.
   * `delayMs` is the write delay (HISTORY_WRITE_DELAY_MS).
   */
  start: ({ delayMs } = {}) => {
    if (unsubscribe) return get().stop;
    writeDelay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : HISTORY_WRITE_DELAY_MS;
    const { tabs } = useTerminalStore.getState();
    tracked = observeAgents(new Map(), tabs, { now: Date.now(), os: osNow() }).tracked;
    setHolders(tabs);
    unsubscribe = useTerminalStore.subscribe((state, prev) => {
      if (state.tabs !== prev.tabs) observe(state.tabs);
      if (state.agentHistoryNotice !== prev.agentHistoryNotice) onNotice(state.agentHistoryNotice);
    });
    stopReplaced = onAgentConversationReplaced(onConversationReplaced);
    stopTitles = onAgentTitleShown(onTitleShown);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', onPageHide);
    }
    get().load();
    return get().stop;
  },

  /** Stop recording. Resolves once what was queued has been sent. */
  stop: () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
      stopReplaced?.();
      stopReplaced = null;
      stopTitles?.();
      stopTitles = null;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', onPageHide);
      }
    }
    const sent = get().flush();
    tracked = new Map();
    liveTitles.clear();
    // A recorder started again says a refusal once more, and a test file's
    // refusals are not kept from the next one's.
    said.clear();
    set({ holders: {} });
    return sent;
  },

  /** Whether the recorder runs. */
  isRecording: () => unsubscribe !== null,

  /** Read the list again, and what Claude Code says of its Claude Code entries. */
  load: () => serially(loadList),

  /** Send what is queued now rather than after the wait. Resolves when it has been. */
  flush: () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return serially(sendQueued);
  },

  /**
   * Remove one entry from the history — after what is queued, so a write
   * queued before it does not bring it back. A conversation still running
   * comes back at its next event. Resolves with whether there was one.
   */
  remove: (key) =>
    serially(async () => {
      await sendQueued();
      try {
        const removed = await invoke('agent_history_remove', { key: String(key ?? '') });
        await readList();
        return removed === true;
      } catch (err) {
        report('could not remove the entry', err);
        return false;
      }
    }),

  /**
   * Empty the history, and the files the backend moved aside with it. Asks
   * first when given `confirm` (a function resolving true to go on — the
   * side bar's and the palette's confirmation): no, and nothing changes.
   * Resolves with how many entries went, or null when it was not cleared.
   * Conversations still running come back at their next event.
   *
   * A clear that fails — refused (a newer file), or the history emptied but
   * a copy moved aside left behind (`COPIES_LEFT`) — is said in the notice
   * the AGENT SESSIONS picks use (`showAgentHistoryNotice`, kind
   * 'clearFailed'), and the list is read again: it is what the file is.
   */
  clear: async ({ confirm = null } = {}) => {
    if (typeof confirm === 'function' && !(await confirm())) return null;
    return serially(async () => {
      await sendQueued();
      try {
        const removed = await invoke('agent_history_clear');
        await readList();
        return Number.isInteger(removed) ? removed : 0;
      } catch (err) {
        report('could not be cleared', err);
        await readList();
        useTerminalStore.getState().showAgentHistoryNotice?.('clearFailed', messageOf(err));
        return null;
      }
    });
  },

  // ---- Curation (F26-F30). Each: after what is queued, then the list read
  // again; refused or failed, the 'curationFailed' notice and null. ----------

  /** Pin the entry under `key`. Resolves with the entry as kept, or null (none, or refused). */
  pin: (key) => updateEntry('could not pin the entry', key, { pinned: true }),

  /** Unpin it. Resolves as `pin`. */
  unpin: (key) => updateEntry('could not unpin the entry', key, { pinned: false }),

  /** Archive it: it leaves the other lists and keeps its name, pin and group. Resolves as `pin`. */
  archive: (key) => updateEntry('could not archive the entry', key, { archived: true }),

  /** Unarchive it, exactly as it was. Resolves as `pin`. */
  unarchive: (key) => updateEntry('could not unarchive the entry', key, { archived: false }),

  /**
   * Rename it (Rename…, F26): `text` trimmed, cleaned and masked
   * (`renameChange`) — empty clears the name, the automatic title while no
   * name is set changes nothing. Resolves with the entry as kept, the entry
   * as the store has it when nothing was to change (nothing is sent, and
   * nothing said), or null — said when it is no longer listed.
   */
  rename: (key, text) => {
    let sent = false;
    return curate(
      'could not rename the entry',
      async () => {
        const entry = useAgentHistoryStore.getState().entries.find((e) => e.key === key) ?? null;
        const changes = renameChange(entry, text);
        if (!changes) return entry;
        sent = true;
        return invoke('agent_history_update', { key: String(key ?? ''), changes });
      },
      (kept) => (sent && !kept ? ENTRY_GONE_TEXT : null)
    );
  },

  /** Move it into the group `groupId`. Resolves as `pin`. */
  moveToGroup: (key, groupId) => updateEntry('could not move the entry', key, { groupId: String(groupId ?? '') }),

  /** Take it out of its group. Resolves as `pin`. */
  removeFromGroup: (key) => updateEntry('could not take the entry out of its group', key, { groupId: null }),

  /**
   * Make a group at the end (New Group…): named `name` cleaned and masked
   * (`historyGroupName`), or, with none, the first free 'New Group',
   * 'New Group 2', … (`nextGroupName`); with `moveKey`, that entry goes into
   * it in the same write. Resolves with the group as kept
   * (`{ id, name, collapsed: false }`), or null when refused. A `moveKey`
   * entry that is not in the group once the list is read again (it was no
   * longer listed) is said in the notice; the group stays, and is resolved.
   */
  createGroup: ({ name = null, moveKey = null } = {}) =>
    curate(
      'could not make the group',
      () => {
        const group = { id: newGroupId(), name: historyGroupName(name) ?? nextGroupName(useAgentHistoryStore.getState().groups) };
        return invoke('agent_history_group_create', moveKey ? { group, move_key: String(moveKey) } : { group });
      },
      (group) => {
        if (!moveKey || !group) return null;
        const moved = useAgentHistoryStore.getState().entries.find((e) => e.key === String(moveKey));
        return moved && entryGroupId(moved) === group.id ? null : NOT_MOVED_TEXT;
      }
    ),

  /**
   * Rename the group `id` (Rename Group…): `text` cleaned and masked
   * (`historyGroupName`). Empty, or its name already, sends nothing.
   * Resolves with the group as kept (or as the store has it, when nothing
   * was sent), or null.
   */
  renameGroup: (id, text) =>
    curate('could not rename the group', async () => {
      const name = historyGroupName(text);
      const current = groupById(id);
      if (name === null || name === current?.name) return current;
      return invoke('agent_history_group_update', { id: String(id ?? ''), changes: { name } });
    }),

  /** Fold (`collapsed` true) or unfold the group `id`, kept in the file. Resolves with the group, or null. */
  setGroupCollapsed: (id, collapsed) =>
    curate('could not fold the group', () =>
      invoke('agent_history_group_update', { id: String(id ?? ''), changes: { collapsed: collapsed === true } })
    ),

  /**
   * Delete the group `id`; its members go back to the list, ungrouped, and
   * none is deleted. Asks first when given `confirm` (as `clear`): no, and
   * nothing changes. Resolves with how many entries were ungrouped, or null
   * (declined, no such group, or refused).
   */
  deleteGroup: async (id, { confirm = null } = {}) => {
    if (typeof confirm === 'function' && !(await confirm())) return null;
    const ungrouped = await curate('could not delete the group', () => invoke('agent_history_group_delete', { id: String(id ?? '') }));
    return Number.isInteger(ungrouped) ? ungrouped : null;
  },

  /**
   * Delete the entry under `key` from the list (Delete…): NexTerm's list
   * only — the conversation and its files stay with its agent. Asks first
   * when given `confirm`. Resolves true when it went, false when there was
   * none or it failed (said in the notice), null when declined. Unlike
   * `remove`, a failure is shown.
   */
  deleteEntry: async (key, { confirm = null } = {}) => {
    if (typeof confirm === 'function' && !(await confirm())) return null;
    return (await curate('could not delete the entry', () => invoke('agent_history_remove', { key: String(key ?? '') }))) === true;
  },
}));

/**
 * Hear every event the recorder records, as it does:
 * `{ type: 'started' | 'resumed' | 'idLearned' | 'titled' | 'ended', reason?:
 * 'exited' | 'closed', tabId, key, entry }`. Returns the unsubscribe.
 */
export function subscribeAgentLifecycle(listener) {
  if (typeof listener !== 'function') return () => {};
  lifecycle.add(listener);
  return () => lifecycle.delete(listener);
}

/** The terminal of this window holding `key` — `{ tabId, state }` — or null. */
export function liveTabForKey(key) {
  return useAgentHistoryStore.getState().holders[key] ?? null;
}

/** Test hook: what the recorder holds about one terminal, or null. */
export function __recorderTracking(tabId) {
  const t = tracked.get(tabId);
  return t ? { ...t } : null;
}

export default useAgentHistoryStore;
