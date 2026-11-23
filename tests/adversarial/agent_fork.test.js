/**
 * Fork Conversation (bundle 1, A1: F6, F7; AC6, AC7, AC8's store half):
 * `forkConversation({ sessionId, cwd })` in src/stores/terminalStore.js.
 *
 * A fork ALWAYS opens a NEW terminal in the folder, in the active pane —
 * even when a terminal of this window holds the source — waits for the
 * shell's first prompt, and types exactly one line:
 * `claude --resume <A> --fork-session --session-id <B>`. The terminal's
 * record is the new conversation, `forkOf` the source, and the history
 * records `claude:<B>` with it; the source's entry is not touched. A password
 * prompt gets nothing (a terminal note says why); a missing folder opens
 * nothing (a notice); a source Claude Code never saved starts a new
 * conversation instead (`claude --session-id <B>`, no `forkOf`); a lookup
 * that fails or takes too long types the fork. Nothing but a Claude Code id
 * ever reaches a shell.
 *
 * The backend is the browser mock. Writes to the terminals are held, spawns
 * counted, terminal notes caught. FK-99 puts the stores, the storage and the
 * mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { CLAUDE_LOOKUP_TIMEOUT_MS, __setClaudeLookupTimeoutMs } from '../../src/lib/claudeConversations.js';
import { isSessionIdFor, startCommand } from '../../src/lib/agents.js';
import { forkTargetOfTab } from '../../src/lib/paletteItems.js';
import { isReadOnly, readOnlyAgentNotice, withReadOnly } from '../../src/lib/readOnly.js';
import { useToastStore } from '../../src/stores/toastStore.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const { FORK_HIDDEN_NOTE, FORK_NEVER_SAVED_NOTE } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const SRC = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const forkLine = (from, to) => `claude --resume ${from} --fork-session --session-id ${to}\r`;
/** The new id in a typed fork line from `from`, or null. */
const newIdIn = (data, from) => {
  const m = new RegExp(`^claude --resume ${from} --fork-session --session-id ([0-9a-f-]{36})\\r$`).exec(data ?? '');
  return m ? m[1] : null;
};

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });

async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

/**
 * `fn` with terminal writes held, and spawns, writes and Claude Code lookups
 * counted. `answer(command, args)`, when given, answers a call itself
 * (counted first) by returning `{ value }` or throwing; undefined lets the
 * mock answer.
 */
async function withBackend(fn, { answer = null } = {}) {
  const original = mockBridge.invoke;
  const calls = { writes: [], spawns: [], lookups: [], asked: [] };
  mockBridge.invoke = async function (command, args, ...rest) {
    calls.asked.push(command);
    if (command === 'pty_write') {
      calls.writes.push({ session: args?.session_id, data: args?.data });
      return null;
    }
    if (command === 'pty_spawn') calls.spawns.push({ ...args });
    if (command === 'claude_conversations') calls.lookups.push([...(args?.ids ?? [])]);
    const answered = answer ? answer(command, args) : undefined;
    if (answered) return answered.value;
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function readyTerminal(cwd = null) {
  await T.getState().init();
  const tab = await T.getState().createTab(cwd ? { cwd } : {});
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

/** A ready terminal in `cwd` running Claude Code (`startAgent`); its record. */
async function claudeRunningIn(cwd) {
  const tab = await readyTerminal(cwd);
  let agent;
  await withBackend(async () => {
    agent = await T.getState().startAgent(tab.id, 'claude');
  });
  await started(tabById(tab.id));
  return { tab: tabById(tab.id), agent };
}

/**
 * Fork `target` and, once the new terminal is there, check that nothing was
 * typed yet, then draw its first prompt (unless `noPrompt`). Resolves with
 * the result, the new terminal and the calls.
 */
async function forkNew(target, { answer = null, beforePrompt = null, noPrompt = false } = {}) {
  const before = new Set(T.getState().tabs.map((t) => t.id));
  let result;
  let tabId = null;
  const calls = await withBackend(
    async (c) => {
      const pending = T.getState().forkConversation(target);
      await until(() => {
        const fresh = T.getState().tabs.find((t) => !before.has(t.id));
        if (fresh?.sessionId) tabId = fresh.id;
        return Boolean(tabId);
      }, 'the new terminal');
      await sleep(20);
      assert.deepEqual(c.writes, [], 'nothing typed before the shell’s first prompt');
      if (beforePrompt) await beforePrompt(tabById(tabId), c);
      if (!noPrompt) await prompt(tabById(tabId));
      result = await pending;
    },
    { answer }
  );
  return { result, tab: tabById(tabId), calls };
}

/** An entry as the recorder writes one. */
const entry = (kind, sessionId, cwd, title = null) => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt: 2000, endedAt: 2000, endReason: 'closed',
});
const remember = async (e) => (await mockBridge.invoke('agent_history_upsert', { entry: e })).key;
const listed = async () => mockBridge.invoke('agent_history_list');

/** What was before this file's first case: FK-99 puts it back. */
let before = null;
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
const notes = [];

/**
 * Each case: an empty history in a storage of its own, no Claude Code
 * transcripts ("cannot tell"), terminal notes caught; with `record`, the
 * recorder started with no write delay. Everything closed and put back after.
 */
async function fresh(fn, { record = false } = {}) {
  if (!before) {
    before = {
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
      transcripts: mockBridge.claudeTranscripts,
      markers: mockBridge.claudeSessionMarkers,
    };
  }
  backing.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  mockBridge.claudeTranscripts = null;
  mockBridge.claudeSessionMarkers = [];
  T.setState({ agentHistoryNotice: null });
  H.setState({ entries: [], loaded: false, error: null, holders: {} });
  notes.length = 0;
  const unsink = setTerminalNoticeSink((tabId, message) => {
    notes.push({ tabId, message });
    return true;
  });
  try {
    if (record) {
      H.getState().start({ delayMs: 0 });
      await H.getState().load();
    }
    await fn();
  } finally {
    unsink();
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.claudeTranscripts = null;
    mockBridge.claudeSessionMarkers = [];
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

/** The active pane of the group on screen, and the terminal it shows. */
function onScreen() {
  const state = T.getState();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const leaves = [];
  const walk = (n) => (n.type === 'leaf' ? leaves.push(n) : n.children?.forEach(walk));
  walk(group.tree);
  const pane = leaves.find((l) => l.id === group.activePaneId);
  return { paneId: pane?.id, paneTabs: pane?.tabIds ?? [], activeTabId: state.activeTabId };
}

describe('Fork Conversation: forkConversation in a new terminal (A1, F6)', () => {
  test('FK-01: a source open in another terminal — a NEW terminal in its folder, active in the active pane; after the prompt exactly one `claude --resume <A> --fork-session --session-id <B>\\r`; the record and the history carry B and forkOf A; A’s entry untouched (AC6)', async () => {
    await fresh(
      async () => {
        const { tab: holder, agent: source } = await claudeRunningIn('/workspace/src');
        const A = source.sessionId;
        await H.getState().flush();
        const sourceBefore = (await listed()).find((e) => e.key === `claude:${A}`);
        assert.ok(sourceBefore, 'premise: the source is in the history');
        assert.equal(H.getState().holders[`claude:${A}`]?.state, 'open', 'premise: a terminal of this window runs it');
        const paneBefore = onScreen().paneId;
        const tabsBefore = T.getState().tabs.length;

        const { result, tab, calls } = await forkNew({ sessionId: A, cwd: '/workspace/src' });
        assert.notEqual(tab.id, holder.id, 'not the terminal holding the source');
        assert.equal(T.getState().tabs.length, tabsBefore + 1, 'one new terminal');
        assert.deepEqual(calls.spawns.map((s) => [s.cwd, s.strict_cwd]), [['/workspace/src', true]], 'in that folder or nowhere');
        assert.equal(calls.writes.length, 1, 'exactly one write');
        const B = newIdIn(calls.writes[0].data, A);
        assert.ok(B, `the fork line: ${JSON.stringify(calls.writes[0].data)}`);
        assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: forkLine(A, B) }], 'into the new terminal');
        assert.ok(isSessionIdFor('claude', B) && B !== A, 'a new v4 id');
        assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });
        assert.equal(T.getState().agentHistoryNotice, null, 'no notice');
        assert.deepEqual(calls.lookups, [[A]], 'the source asked about once, after the prompt');
        const screen = onScreen();
        assert.equal(screen.activeTabId, tab.id, 'the active terminal');
        assert.equal(screen.paneId, paneBefore, 'in the pane that was active');
        assert.ok(screen.paneTabs.includes(tab.id));
        assert.deepEqual([tab.agent.kind, tab.agent.sessionId, tab.agent.forkOf], ['claude', B, A]);
        assert.equal(tab.agentTyped?.sessionId, tab.sessionId, 'watched: typed at a prompt');
        assert.equal(tab.agentResumeOffered, false);
        assert.equal(tabById(holder.id).agent.sessionId, A, 'the holder keeps its conversation');
        assert.deepEqual(notes, [], 'no terminal note');

        await H.getState().flush();
        const after = await listed();
        const forked = after.find((e) => e.key === `claude:${B}`);
        assert.ok(forked, `the fork recorded: ${after.map((e) => e.key)}`);
        assert.equal(forked.forkOf, A, 'linked to its source');
        assert.equal(forked.cwd, '/workspace/src');
        assert.deepEqual(after.find((e) => e.key === `claude:${A}`), sourceBefore, 'the source entry unchanged');
        assert.match(mockBridge.agentHistoryFile(), new RegExp(`"forkOf": ?"${A}"`), 'forkOf on disk');
      },
      { record: true }
    );
  });

  test('FK-02: a password prompt up through the wait — nothing typed, a terminal note, no record (AC7)', async () => {
    await fresh(async () => {
      const previousWait = terminalStore.__setAgentPromptWaitMs(300);
      try {
        const answer = (command) => (command === 'pty_input_hidden' ? { value: true } : undefined);
        const { result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' }, { answer });
        assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: false, notice: null });
        assert.deepEqual(calls.writes, [], 'not into the password prompt');
        assert.deepEqual(calls.lookups, [], 'nothing asked: nothing would be typed');
        assert.deepEqual(notes, [{ tabId: tab.id, message: FORK_HIDDEN_NOTE }], 'the terminal says why');
        assert.match(FORK_HIDDEN_NOTE, /password/);
        assert.equal(tab.agent ?? null, null, 'no record');
        assert.equal(T.getState().agentHistoryNotice, null);
      } finally {
        terminalStore.__setAgentPromptWaitMs(previousWait);
      }
    });
  });

  test('FK-03: a folder that is not there any more — a notice naming it, no terminal, nothing typed; the entry stays (AC7)', async () => {
    await fresh(async () => {
      const key = await remember(entry('claude', SRC, '/gone/away'));
      const tabsBefore = T.getState().tabs.length;
      let result;
      const calls = await withBackend(async () => {
        result = await T.getState().forkConversation({ sessionId: SRC, cwd: '/gone/away' });
      });
      assert.equal(result.outcome, 'missingFolder');
      assert.equal(result.typed, false);
      assert.deepEqual([calls.spawns.length, calls.writes.length, calls.lookups.length], [0, 0, 0]);
      assert.equal(T.getState().tabs.length, tabsBefore, 'no terminal');
      const notice = T.getState().agentHistoryNotice;
      assert.equal(notice?.kind, 'missingFolder');
      assert.ok(notice.text.includes('/gone/away'), notice.text);
      assert.equal(result.notice, notice);
      assert.ok((await listed()).some((e) => e.key === key), 'still listed');
      // No folder at all is the same: nothing opened.
      const none = await withBackend(async () => {
        result = await T.getState().forkConversation({ sessionId: SRC, cwd: null });
      });
      assert.deepEqual([result.outcome, none.spawns.length, none.writes.length], ['missingFolder', 0, 0]);
    });
  });

  test('FK-04: a source Claude Code never saved — `claude --session-id <B>` typed instead, with the note, no forkOf; the pick says so (AC7)', async () => {
    await fresh(
      async () => {
        // Claude Code's projects folder is there with no transcript of it, and
        // the marker it made when that session started.
        mockBridge.claudeTranscripts = {};
        mockBridge.claudeSessionMarkers = [SRC];
        const { result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' });
        assert.equal(calls.writes.length, 1, 'one write');
        const m = /^claude --session-id ([0-9a-f-]{36})\r$/.exec(calls.writes[0].data);
        assert.ok(m, `a new conversation: ${JSON.stringify(calls.writes[0].data)}`);
        const B = m[1];
        assert.ok(isSessionIdFor('claude', B) && B !== SRC);
        assert.ok(!calls.writes[0].data.includes('--fork-session') && !calls.writes[0].data.includes(SRC), 'never the fork of it');
        assert.deepEqual(notes, [{ tabId: tab.id, message: FORK_NEVER_SAVED_NOTE }], 'the terminal says why');
        assert.equal(result.outcome, 'opened');
        assert.equal(result.typed, true);
        assert.deepEqual([result.notice?.kind, result.notice?.text], ['newConversation', FORK_NEVER_SAVED_NOTE]);
        assert.equal(T.getState().agentHistoryNotice, result.notice);
        assert.deepEqual([tab.agent.kind, tab.agent.sessionId], ['claude', B]);
        assert.ok(!Object.prototype.hasOwnProperty.call(tab.agent, 'forkOf'), 'not linked to a conversation that does not exist');
        await H.getState().flush();
        const recorded = (await listed()).find((e) => e.key === `claude:${B}`);
        assert.ok(recorded, 'the new one recorded');
        assert.ok(!('forkOf' in recorded), 'with no forkOf');
      },
      { record: true }
    );
  });

  test('FK-05: a lookup that fails, or does not answer in time — the fork line is typed (AC7)', async () => {
    await fresh(async () => {
      mockBridge.claudeSessionMarkers = [SRC];
      mockBridge.claudeTranscripts = {};
      const failing = (command) => {
        if (command === 'claude_conversations') throw new Error('the projects folder could not be read');
        return undefined;
      };
      let { result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' }, { answer: failing });
      let B = newIdIn(calls.writes[0]?.data, SRC);
      assert.ok(B, `failed lookup: the fork typed (${JSON.stringify(calls.writes)})`);
      assert.equal(calls.writes.length, 1);
      assert.deepEqual([tab.agent.sessionId, tab.agent.forkOf, result.typed, result.notice], [B, SRC, true, null]);
      assert.deepEqual(notes, []);
      await T.getState().closeTab(tab.id);

      __setClaudeLookupTimeoutMs(40);
      const never = (command) => (command === 'claude_conversations' ? { value: new Promise(() => {}) } : undefined);
      ({ result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' }, { answer: never }));
      B = newIdIn(calls.writes[0]?.data, SRC);
      assert.ok(B, `timed-out lookup: the fork typed (${JSON.stringify(calls.writes)})`);
      assert.deepEqual([calls.writes.length, tab.agent.forkOf, result.outcome], [1, SRC, 'opened']);
    });
  });

  test('FK-06: anything but a Claude Code id is refused before anything opens — no folder check, no terminal, nothing typed; a fork under way is not started twice', async () => {
    await fresh(async () => {
      const tabsBefore = T.getState().tabs.length;
      for (const bad of ['x; rm -rf ~', SES, SRC.toUpperCase(), `${SRC}\r`, '', null, undefined, 42]) {
        T.setState({ agentHistoryNotice: null });
        let result;
        const calls = await withBackend(async () => {
          result = await T.getState().forkConversation({ sessionId: bad, cwd: '/workspace/src' });
        });
        assert.equal(result.outcome, 'notForked', String(bad));
        assert.deepEqual(calls.asked, [], `nothing asked of the backend for ${JSON.stringify(bad)}`);
        assert.equal(T.getState().agentHistoryNotice?.kind, 'notForked');
      }
      assert.equal((await T.getState().forkConversation()).outcome, 'notForked', 'no argument at all');
      assert.equal(T.getState().tabs.length, tabsBefore, 'no terminal');

      // Picked twice at once: one terminal.
      T.setState({ agentHistoryNotice: null });
      const tabsNow = T.getState().tabs.length;
      const calls = await withBackend(async (c) => {
        const first = T.getState().forkConversation({ sessionId: SRC, cwd: '/workspace/src' });
        const second = await T.getState().forkConversation({ sessionId: SRC, cwd: '/workspace/src' });
        assert.deepEqual(second, { outcome: 'busy', tabId: null, typed: false, notice: null });
        await until(() => T.getState().tabs.length > tabsNow && T.getState().tabs.at(-1)?.sessionId, 'the one terminal');
        await prompt(T.getState().tabs.at(-1));
        assert.equal((await first).typed, true);
        assert.equal(c.spawns.length, 1);
      });
      assert.equal(calls.writes.length, 1);
    });
  });

  test('FK-07: a fork typed by hand is recorded by its new id with forkOf; other Claude Code lines are recorded as before', async () => {
    await fresh(async () => {
      const B = startCommand('claude').agent.sessionId;
      const tab = await readyTerminal('/workspace/src');
      await withBackend(async () => {
        await typeLine(tab.id, `claude --resume ${SRC} --fork-session --session-id ${B}`);
      });
      let now = tabById(tab.id);
      assert.deepEqual([now.agent?.kind, now.agent?.sessionId, now.agent?.forkOf], ['claude', B, SRC]);
      // It exits like any agent, and a plain resume after it carries no forkOf.
      await started(now);
      await prompt(now);
      assert.equal(tabById(tab.id).agent, null, 'premise: ended');
      await withBackend(async () => {
        await typeLine(tab.id, `claude --resume ${SRC}`);
      });
      now = tabById(tab.id);
      assert.equal(now.agent?.sessionId, SRC);
      assert.ok(!Object.prototype.hasOwnProperty.call(now.agent, 'forkOf'), 'no forkOf key on a plain resume');
    });
  });

  test('FK-08: the palette’s target — the active terminal’s Claude Code conversation, running or offered back — forks it; none for OpenCode, a plain terminal or no id (AC8)', async () => {
    await fresh(async () => {
      const { tab: running, agent } = await claudeRunningIn('/workspace/src');
      T.getState().switchTab(running.id);
      const active = () => tabById(T.getState().activeTabId);
      assert.deepEqual(forkTargetOfTab(active()), { sessionId: agent.sessionId, cwd: '/workspace/src' });
      const { tab, calls } = await forkNew(forkTargetOfTab(active()));
      const B = newIdIn(calls.writes[0]?.data, agent.sessionId);
      assert.ok(B, JSON.stringify(calls.writes));
      assert.equal(tab.agent.forkOf, agent.sessionId);

      // Offered back after a restart: the same.
      const offered = await readyTerminal('/workspace/tests');
      T.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === offered.id ? { ...t, agent: { kind: 'claude', sessionId: SRC, startedAt: 1, title: null }, agentResumeOffered: true } : t
        ),
      }));
      assert.deepEqual(forkTargetOfTab(tabById(offered.id)), { sessionId: SRC, cwd: '/workspace/tests' });

      // OpenCode, a plain terminal, a Claude Code record with no id or a bad one: nothing to fork.
      const plain = await readyTerminal('/workspace');
      assert.equal(forkTargetOfTab(tabById(plain.id)), null, 'a plain terminal');
      const as = (agentRecord) => forkTargetOfTab({ ...tabById(plain.id), agent: agentRecord });
      assert.equal(as({ kind: 'opencode', sessionId: SES, startedAt: 1, title: 'x' }), null, 'OpenCode');
      assert.equal(as({ kind: 'claude', sessionId: null, startedAt: 1, title: null }), null, 'no id');
      assert.equal(as({ kind: 'claude', sessionId: 'x; rm -rf ~', startedAt: 1, title: null }), null, 'not an id');
      assert.equal(forkTargetOfTab({ agent: { kind: 'claude', sessionId: SRC }, cwd: '' }), null, 'no folder to open it in');
      assert.equal(forkTargetOfTab(null), null);
    });
  });

  test('FK-09: a password prompt that comes up while Claude Code is asked about the source — checked again after the lookup: nothing typed, the terminal note, no record (review A-R4)', async () => {
    await fresh(async () => {
      const previousWait = terminalStore.__setAgentPromptWaitMs(300);
      try {
        let hidden = false;
        const answer = (command) => {
          if (command === 'pty_input_hidden') return { value: hidden };
          // The prompt comes up during the lookup; the mock answers it.
          if (command === 'claude_conversations') hidden = true;
          return undefined;
        };
        const { result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' }, { answer });
        assert.deepEqual(calls.lookups, [[SRC]], 'premise: the source asked about once, the shell ready');
        const lookedUp = calls.asked.indexOf('claude_conversations');
        assert.ok(calls.asked.slice(0, lookedUp).includes('pty_input_hidden'), 'premise: no prompt before the lookup');
        assert.ok(calls.asked.slice(lookedUp + 1).includes('pty_input_hidden'), 'the backend asked again after it');
        assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: false, notice: null });
        assert.deepEqual(calls.writes, [], 'not into the password prompt');
        assert.deepEqual(notes, [{ tabId: tab.id, message: FORK_HIDDEN_NOTE }], 'the terminal says why');
        assert.equal(tab.agent ?? null, null, 'no record');
        assert.equal(T.getState().agentHistoryNotice, null);
      } finally {
        terminalStore.__setAgentPromptWaitMs(previousWait);
      }
    });
  });

  test('FK-10: read-only turned on in the new terminal while the source is looked up — checked right before the write: no pty_write, the read-only note, no record (review B-R5)', async () => {
    await fresh(async () => {
      const previousWait = terminalStore.__setAgentPromptWaitMs(300);
      try {
        const known = new Set(T.getState().tabs.map((t) => t.id));
        const toastsBefore = useToastStore.getState().toasts.length;
        const answer = (command) => {
          if (command === 'claude_conversations') {
            const opened = T.getState().tabs.find((t) => !known.has(t.id));
            T.setState((s) => ({ readOnly: withReadOnly(s.readOnly, opened.id, true) }));
          }
          return undefined;
        };
        const { result, tab, calls } = await forkNew({ sessionId: SRC, cwd: '/workspace/src' }, { answer });
        assert.deepEqual(calls.lookups, [[SRC]], 'premise: the source asked about once, the shell ready');
        assert.ok(isReadOnly(T.getState(), tab.id), 'premise: the new terminal is read-only now');
        assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: false, notice: null });
        assert.deepEqual(calls.writes, [], 'nothing typed into the read-only terminal');
        assert.deepEqual(notes, [{ tabId: tab.id, message: readOnlyAgentNotice('Claude Code') }], 'the terminal says why');
        assert.match(notes[0].message, /^Claude Code not started — this terminal is read-only, and NexTerm types nothing into it\./);
        assert.equal(tab.agent ?? null, null, 'no record');
        assert.equal(useToastStore.getState().toasts.length, toastsBefore, 'refused before writeRaw, which would toast');
        assert.equal(T.getState().agentHistoryNotice, null);
      } finally {
        terminalStore.__setAgentPromptWaitMs(previousWait);
      }
    });
  });
});

describe('Fork Conversation: teardown', () => {
  test('FK-99: the stores, the storage and the mock as they were', async () => {
    await H.getState().stop();
    H.setState({ entries: [], loaded: false, error: null, holders: {} });
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    __setClaudeLookupTimeoutMs(CLAUDE_LOOKUP_TIMEOUT_MS);
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.claudeTranscripts = before.transcripts;
      mockBridge.claudeSessionMarkers = before.markers;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    backing.clear();
    assert.equal(mockBridge.agentHistoryMemory, null, 'no history is left for another suite');
    assert.equal(H.getState().isRecording(), false);
  });
});
