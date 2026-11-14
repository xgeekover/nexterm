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
 * **For the next phase** (monitoring several agents, a notification when one
 * finishes; nothing of it here): `holders` maps a history key to the
 * terminal of this window holding it, and `subscribeAgentLifecycle` hears
 * every event as it is recorded — started, resumed, idLearned, titled,
 * ended with its reason.
 */
import { create } from 'zustand';
import { invoke } from '../lib/ipc.js';
import { isKnownAgent, isSessionIdFor } from '../lib/agents.js';
import {
  claudeHistoryChanges,
  claudeIdsHeld,
  historyHolders,
  historyKey,
  observeAgents,
  queueUpsert,
} from '../lib/agentHistory.js';
import { lookUpClaudeConversations } from '../lib/claudeConversations.js';
import { onAgentConversationReplaced, useTerminalStore } from './terminalStore.js';
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
      const kept = await invoke(
        'agent_history_upsert',
        op.replaces ? { entry: op.entry, replaces: op.replaces } : { entry: op.entry }
      );
      keepKey(op, kept);
    } catch (err) {
      // Refused (a newer file, another NexTerm holding it too long) or not
      // saved: dropped. The terminal's next event writes it again.
      report('not recorded', err);
    }
  }
  await readList();
}

/** Read the list into the store. Resolves with its entries, or null when it could not be read. */
async function readList() {
  try {
    const all = await invoke('agent_history_list');
    const entries = (Array.isArray(all) ? all : []).filter((e) => e && isKnownAgent(e.kind));
    useAgentHistoryStore.setState({ entries, loaded: true });
    return entries;
  } catch (err) {
    report('could not be read', err);
    return null;
  }
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
 * goes, after what was queued — the resume of it among that.
 */
function onConversationReplaced(event) {
  if (event?.kind !== 'claude' || !isSessionIdFor('claude', event.from)) return;
  const key = historyKey({ kind: 'claude', sessionId: event.from });
  serially(async () => {
    await sendQueued();
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
    enqueue({ entry: event.entry, key: event.key, replaces: event.replaces, tabId: event.tabId });
    emit({
      type: event.type,
      ...(event.reason ? { reason: event.reason } : {}),
      tabId: event.tabId,
      key: event.key,
      entry: { ...event.entry, key: event.key },
    });
  }
  setHolders(tabs);
  if (claudeEnds.length > 0) serially(() => claudeEnded(claudeEnds));
}

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
    });
    stopReplaced = onAgentConversationReplaced(onConversationReplaced);
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
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', onPageHide);
      }
    }
    const sent = get().flush();
    tracked = new Map();
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
