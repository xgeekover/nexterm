/**
 * The agent session history, recorded: the terminals' agents as the
 * recorder (src/stores/agentHistoryStore.js) writes them into the history,
 * through the browser mock's `agent_history_*` (held to the backend by
 * agent_history_contract.test.js).
 *
 * What it records: an agent started (by NexTerm or typed by hand), the
 * opencode conversation's id learned — the provisional entry re-keyed, none
 * left behind — a title, the agent exiting, the terminal closing. What it
 * does not: a restored terminal that only offers its record, until Resume is
 * pressed. Titles masked (`[hidden]`) and cleaned. Entries survive a restart
 * (the mock's file is in the page storage), and so do the store's remove and
 * clear. Nothing is recorded before `start()` or after `stop()`.
 *
 * The backend is the browser mock: `mockBridge.agentSessions` stands in for
 * `opencode session list`, `pty-title` for a title read from the output.
 * Writes to the terminals are held. AHR-99 puts the stores, the storage and
 * the mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import {
  useAgentHistoryStore,
  subscribeAgentLifecycle,
  liveTabForKey,
  __recorderTracking,
} from '../../src/stores/agentHistoryStore.js';
import {
  historyDisplay,
  historyHolders,
  historyKey,
  historyMatches,
  historyRecord,
  historyTitle,
  folderName,
  observeAgents,
  queueUpsert,
} from '../../src/lib/agentHistory.js';
import { maskLine } from '../../src/lib/scrollbackSnapshot.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const { PERSIST_KEY } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES_A = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const SES_B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
const titled = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });

async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

/** `fn` with terminal writes held and the history's upserts counted. */
async function withBackend(fn) {
  const original = mockBridge.invoke;
  const calls = { writes: [], upserts: [] };
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      calls.writes.push(args?.data);
      return null;
    }
    if (command === 'agent_history_upsert') calls.upserts.push(structuredClone(args));
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

async function withHook(name, value, fn) {
  const previous = terminalStore[name](value);
  try {
    await fn();
  } finally {
    terminalStore[name](previous);
  }
}
/** Lookups after 5 ms of quiet, and no retries left behind. */
const quickly = (fn) =>
  withHook('__setAgentResolveDelayMs', 5, () => withHook('__setAgentResolveRetryMs', [], fn));
const settle = () => sleep(40);

async function readyTerminal() {
  await T.getState().init();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

/** The mock's history file as it stands: its entries. */
const fileEntries = () => {
  const text = mockBridge.agentHistoryFile();
  return text === null ? null : JSON.parse(text).entries;
};

// ---- A disk of our own: the page storage the mock keeps the history in -------

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** What was there before this file's first case: AHR-99 puts it back. */
let before = null;

/**
 * Each case: a fresh history in its own storage, the recorder started with
 * no write delay, and everything closed and stopped after.
 */
async function recording(fn, { start = true } = {}) {
  if (!before) {
    before = {
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
      newerSaid: mockBridge.agentHistoryNewerSaid,
    };
  }
  backing.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  H.setState({ entries: [], loaded: false, error: null, holders: {} });
  try {
    if (start) H.getState().start({ delayMs: 0 });
    await fn();
  } finally {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.agentSessions = [];
    T.getState().dispose();
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

/** A restart: the page goes (the recorder with it), the stores come back from the storage. */
async function relaunch({ seed = null } = {}) {
  await H.getState().stop();
  T.getState().dispose();
  if (seed) backing.set(PERSIST_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: seed }));
  T.setState({ tabs: [], activeTabId: null, isInitialized: false });
  H.setState({ entries: [], loaded: false, error: null, holders: {} });
  mockBridge.agentHistoryMemory = null;
  await T.getState().init();
  H.getState().start({ delayMs: 0 });
  await H.getState().load();
}

const workspaceRunning = (agent, cwd = '/workspace') => ({
  workspaceName: 'Default',
  activeGroupId: 'group-agent',
  groups: [
    {
      id: 'group-agent', name: 'Agents', createdAt: 1, activePaneId: 'pane-agent',
      tree: { type: 'leaf', id: 'pane-agent', tabIds: ['tab-agent'], activeTabId: 'tab-agent' },
    },
  ],
  tabs: [{ id: 'tab-agent', title: 'Terminal 1', cwd, agent }],
});

/** An opencode terminal that has learned it is in SES_A, "Fix the build". */
async function opencodeIn(tab, { id = SES_A, title = 'Fix the build' } = {}) {
  mockBridge.agentSessions = [{ id, title, updated: 200, created: 100, directory: tab.cwd }];
  await typeLine(tab.id, 'opencode');
  await started(tab);
  await titled(tab, `OC | ${title}`);
  await settle();
  assert.equal(tabById(tab.id).agent.sessionId, id, 'premise: the id was learned');
}

describe('Agent session history: what the recorder records', () => {
  test('AHR-01: an agent started sets startedAt and lastUsedAt, with no end; nothing before start()', async () => {
    await recording(async () => {
      const tab = await readyTerminal();
      const { upserts } = await withBackend(async () => {
        await T.getState().startAgent(tab.id, 'claude');
        await H.getState().flush();
      });
      assert.equal(upserts.length, 0, 'not started: nothing recorded');
      assert.equal(H.getState().isRecording(), false);
    }, { start: false });

    await recording(async () => {
      const events = [];
      const unsubscribe = subscribeAgentLifecycle((e) => events.push(e));
      try {
        const tab = await readyTerminal();
        const t0 = Date.now();
        let agent;
        const { upserts } = await withBackend(async () => {
          agent = await T.getState().startAgent(tab.id, 'claude');
          await H.getState().flush();
        });
        const t1 = Date.now();
        const key = `claude:${agent.sessionId}`;
        assert.equal(upserts.length, 1);
        assert.equal(upserts[0].replaces, undefined, 'a first write replaces nothing');
        const [entry] = fileEntries();
        assert.equal(entry.key, key);
        assert.deepEqual(
          { kind: entry.kind, cwd: entry.cwd, title: entry.title, endedAt: entry.endedAt, endReason: entry.endReason },
          { kind: 'claude', cwd: tab.cwd, title: null, endedAt: null, endReason: null }
        );
        assert.ok(entry.startedAt >= t0 && entry.startedAt <= t1, 'startedAt is now');
        assert.equal(entry.lastUsedAt, entry.startedAt, 'and so is lastUsedAt');
        assert.deepEqual(H.getState().entries.map((e) => e.key), [key], 'the store read it back');
        assert.deepEqual(events.map((e) => [e.type, e.key, e.tabId]), [['started', key, tab.id]]);
        assert.deepEqual(liveTabForKey(key), { tabId: tab.id, state: 'open' }, 'and knows which terminal holds it');
      } finally {
        unsubscribe();
      }
    });
  });

  test('AHR-02: learning the opencode id re-keys the provisional entry, leaving no duplicate', async () => {
    await recording(async () => {
      const events = [];
      const unsubscribe = subscribeAgentLifecycle((e) => events.push(e.type));
      try {
        const tab = await readyTerminal();
        await quickly(async () => {
          await withBackend(async () => {
            await typeLine(tab.id, 'opencode');
            await H.getState().flush();
            assert.deepEqual(fileEntries().map((e) => e.key), [`opencode:~${tab.cwd}\u0000`], 'provisional at first');
            await opencodeIn(tab);
            await H.getState().flush();
          });
        });
        const entries = fileEntries();
        assert.deepEqual(entries.map((e) => e.key), [`opencode:${SES_A}`], 'one entry, by its id');
        assert.equal(entries[0].title, 'Fix the build');
        assert.deepEqual(events.slice(0, 3), ['started', 'titled', 'idLearned']);
        assert.equal(__recorderTracking(tab.id).key, `opencode:${SES_A}`, 'the key the backend gave is the one kept');
      } finally {
        unsubscribe();
      }
    });
  });

  test('AHR-03: a rename updates the title of the same entry; another conversation is an entry of its own', async () => {
    await recording(async () => {
      const tab = await readyTerminal();
      await quickly(async () => {
        await withBackend(async () => {
          await opencodeIn(tab);
          // Renamed in opencode: the id it let go of is found again by it.
          mockBridge.agentSessions = [{ id: SES_A, title: 'Fix the build on Windows', updated: 300, created: 100, directory: tab.cwd }];
          await titled(tab, 'OC | Fix the build on Windows');
          await settle();
          await H.getState().flush();
          assert.deepEqual(fileEntries().map((e) => [e.key, e.title]), [[`opencode:${SES_A}`, 'Fix the build on Windows']], 'renamed, no stray entry');

          // Switched to another conversation.
          mockBridge.agentSessions.push({ id: SES_B, title: 'Write the docs', updated: 400, created: 350, directory: tab.cwd });
          await titled(tab, 'OC | Write the docs');
          await settle();
          await H.getState().flush();
        });
      });
      assert.deepEqual(
        fileEntries().map((e) => [e.key, e.title]),
        [[`opencode:${SES_B}`, 'Write the docs'], [`opencode:${SES_A}`, 'Fix the build on Windows']],
        'both conversations, newest first, and no provisional entry left'
      );
    });
  });

  test('AHR-04: the agent exiting ends its entry as exited; closing its terminal as closed', async () => {
    await recording(async () => {
      const ended = [];
      const unsubscribe = subscribeAgentLifecycle((e) => e.type === 'ended' && ended.push(e.reason));
      try {
        const a = await readyTerminal();
        const b = await readyTerminal();
        let claude;
        await withBackend(async () => {
          claude = await T.getState().startAgent(a.id, 'claude');
          await typeLine(b.id, `opencode -s ${SES_A}`);
          await H.getState().flush();
          const first = fileEntries().find((e) => e.key === `claude:${claude.sessionId}`);
          await sleep(5);
          await started(a);
          await prompt(a); // the agent exits: its record goes
          assert.equal(tabById(a.id).agent, null, 'premise: the record is cleared');
          await T.getState().closeTab(b.id);
          await H.getState().flush();
          const exited = fileEntries().find((e) => e.key === `claude:${claude.sessionId}`);
          assert.equal(exited.endReason, 'exited');
          assert.ok(exited.endedAt > first.lastUsedAt, 'ended now');
          assert.equal(exited.lastUsedAt, exited.endedAt);
          assert.equal(exited.startedAt, first.startedAt, 'started when it started');
        });
        const closed = fileEntries().find((e) => e.key === `opencode:${SES_A}`);
        assert.equal(closed.endReason, 'closed');
        assert.ok(Number.isSafeInteger(closed.endedAt));
        assert.deepEqual(ended.sort(), ['closed', 'exited']);
        assert.equal(liveTabForKey(`opencode:${SES_A}`), null, 'nobody holds it now');
      } finally {
        unsubscribe();
      }
    });
  });

  test('AHR-05: a restored terminal that only offers its record writes nothing until Resume is pressed', async () => {
    await recording(async () => {
      const agent = { kind: 'claude', sessionId: UUID, startedAt: 1000, title: null };
      // The history has the conversation from the last session, ended at quit time.
      await mockBridge.invoke('agent_history_upsert', {
        entry: { kind: 'claude', sessionId: UUID, cwd: '/workspace', title: null, startedAt: 1000, lastUsedAt: 2000, endedAt: 2000, endReason: 'closed' },
      });
      const { upserts, writes } = await withBackend(async (calls) => {
        await relaunch({ seed: workspaceRunning(agent) });
        const tab = tabById('tab-agent');
        assert.equal(tab.agentResumeOffered, true, 'premise: offered back');
        await H.getState().flush();
        assert.equal(calls.upserts.length, 0, 'offered: nothing written');
        assert.deepEqual(liveTabForKey(`claude:${UUID}`), { tabId: 'tab-agent', state: 'offered' });
        assert.equal(fileEntries()[0].lastUsedAt, 2000, 'nor bumped');

        await prompt(tab);
        assert.equal(await T.getState().resumeAgent(tab.id), true, 'Resume pressed');
        await H.getState().flush();
      });
      assert.deepEqual(writes, [`claude --resume ${UUID}\r`]);
      assert.equal(upserts.length, 1, 'resumed: one write');
      const [entry] = fileEntries();
      assert.equal(entry.key, `claude:${UUID}`, 'the same entry');
      assert.equal(entry.startedAt, 1000, 'its start kept');
      assert.ok(entry.lastUsedAt > 2000, 'bumped');
      assert.deepEqual([entry.endedAt, entry.endReason], [null, null], 'running again');
      assert.deepEqual(liveTabForKey(`claude:${UUID}`), { tabId: 'tab-agent', state: 'open' });

      // Dismissed instead: still nothing.
      T.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === 'tab-agent' ? { ...t, agent: { kind: 'opencode', sessionId: SES_B, startedAt: 5, title: 'Old' }, agentResumeOffered: true } : t)),
      }));
      T.getState().dismissAgentResume('tab-agent');
      await H.getState().flush();
      assert.ok(!fileEntries().some((e) => e.key === `opencode:${SES_B}`), 'a dismissed offer is never recorded');
    });
  });

  test('AHR-06: a claude and an opencode session survive a restart, newest first, as the side bar shows them', async () => {
    await recording(async () => {
      const a = await readyTerminal();
      const b = await T.getState().createTab({ cwd: '/workspace/src' });
      await prompt(b);
      let claude;
      await quickly(async () => {
        await withBackend(async () => {
          claude = await T.getState().startAgent(a.id, 'claude');
          await H.getState().flush();
          await sleep(5);
          await opencodeIn(tabById(b.id), { title: 'Port the parser' });
          await H.getState().flush();
        });
      });
      const listedBefore = await mockBridge.invoke('agent_history_list');

      await relaunch();
      const listed = await mockBridge.invoke('agent_history_list');
      assert.deepEqual(listed, listedBefore, 'agent_history_list: the same after the restart');
      assert.deepEqual(listed.map((e) => e.key), [`opencode:${SES_A}`, `claude:${claude.sessionId}`], 'newest first');
      const rows = H.getState().entries.map(historyDisplay);
      assert.deepEqual(
        rows.map((r) => [r.label, r.title, r.folder, r.folderPath]),
        [
          ['opencode', 'Port the parser', 'src', '/workspace/src'],
          ['Claude Code', claude.sessionId.slice(0, 8), 'workspace', '/workspace'],
        ],
        'the side bar data: agent, title (or a short id), folder'
      );
      assert.ok(rows[0].lastUsedAt > rows[1].lastUsedAt, 'with lastUsedAt');
      assert.deepEqual(rows.map((r) => r.certainty), ['exact', 'exact']);
    });
  });

  test('AHR-07: a title is kept masked and cleaned — the scrollback masking itself unchanged', async () => {
    // The pure step.
    assert.equal(historyTitle(`Deploy\u0007 with ${TOKEN}\u202e now`), 'Deploy with ghp_[hidden] now');
    assert.equal(historyTitle('Fix the login bug'), 'Fix the login bug', 'an ordinary title as it is');
    assert.equal(historyTitle('   \u0000 '), null);
    const long = `${'x'.repeat(185)} ghp_abc1234567`; // cut at 200, the token's start left
    assert.equal(long.length, 200);
    assert.equal(historyTitle(long), `${'x'.repeat(185)} ghp_[hidden]`, 'a token cut at the cap is hidden from its prefix on');
    const over = historyTitle(`${'x'.repeat(193)} ghp_ab`); // 200, and longer once masked
    assert.equal(over, `${'x'.repeat(192)}[hidden]`, 'cut again to the cap, never through [hidden]');
    const emoji = `${'y'.repeat(199)}\u{1F600}`;
    assert.equal(historyTitle(emoji), 'y'.repeat(199), 'no half of a character at the cut');
    // maskLine on a line object: the same as ever.
    const line = { runs: [{ sgr: '1', text: `push ${TOKEN}` }, { sgr: '', text: ' end' }] };
    assert.equal(maskLine(line), 1);
    assert.deepEqual(line.runs, [{ sgr: '1', text: 'push ghp_[hidden]' }, { sgr: '', text: ' end' }]);

    // Through the recorder: the title opencode shows.
    await recording(async () => {
      const tab = await readyTerminal();
      await quickly(async () => {
        await withBackend(async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, `OC | Rotate ${TOKEN}\u202e\u0007 key`);
          await settle();
          await H.getState().flush();
        });
      });
      const text = mockBridge.agentHistoryFile();
      assert.ok(!text.includes(TOKEN.slice(4)), 'the token is not in the file');
      assert.deepEqual(fileEntries().map((e) => e.title), ['Rotate ghp_[hidden] key']);
    });
  });

  test('AHR-08: remove and clear through the store survive a restart; clear asks first', async () => {
    await recording(async () => {
      const at = (n) => ({ kind: 'claude', sessionId: null, cwd: `/w/${n}`, title: null, startedAt: n, lastUsedAt: n, endedAt: null, endReason: null });
      for (const n of [1, 2, 3]) await mockBridge.invoke('agent_history_upsert', { entry: at(n) });
      await mockBridge.invoke('agent_history_upsert', { entry: { ...at(9), kind: 'agy', sessionId: 'agy-1' } });
      await H.getState().load();
      assert.ok(!H.getState().entries.some((e) => e.kind === 'agy'), 'an agent this build does not know is not listed');
      assert.equal((await mockBridge.invoke('agent_history_list')).filter((e) => e.kind === 'agy').length, 1, 'though the file keeps it');
      const key = historyKey(at(2));
      assert.equal(await H.getState().remove(key), true);
      assert.equal(await H.getState().remove(key), false, 'gone already');
      assert.deepEqual(H.getState().entries.map((e) => e.cwd), ['/w/3', '/w/1']);

      await relaunch();
      assert.deepEqual(H.getState().entries.map((e) => e.cwd), ['/w/3', '/w/1'], 'removed for good');

      assert.equal(await H.getState().clear({ confirm: async () => false }), null, 'said no: not cleared');
      assert.equal(H.getState().entries.length, 2);
      mockBridge.agentHistoryCorruptFile();
      await H.getState().load(); // moved aside
      await mockBridge.invoke('agent_history_upsert', { entry: at(4) });
      assert.equal(mockBridge.agentHistoryBad.length, 1, 'premise: a file moved aside');
      let asked = 0;
      assert.equal(await H.getState().clear({ confirm: async () => (asked += 1) > 0 }), 1, 'said yes: one entry went');
      assert.equal(asked, 1);
      assert.deepEqual(H.getState().entries, []);
      assert.deepEqual(mockBridge.agentHistoryBad, [], 'and no copy is left');

      await relaunch();
      assert.deepEqual(H.getState().entries, [], 'cleared for good');
    });
  });

  test('AHR-09: a burst is one write, merged per key; a refused write is said once and dropped', async () => {
    await recording(async () => {
      H.getState().stop();
      H.getState().start({ delayMs: 60_000 }); // nothing goes until flush
      const tab = await readyTerminal();
      await quickly(async () => {
        const { upserts } = await withBackend(async () => {
          await opencodeIn(tab);
          await H.getState().flush();
        });
        assert.equal(upserts.length, 1, 'start, title and id: one write');
        assert.equal(upserts[0].entry.sessionId, SES_A);
        assert.equal(upserts[0].replaces, undefined, 'the provisional entries were never written to be replaced');
      });
      assert.deepEqual(fileEntries().map((e) => e.key), [`opencode:${SES_A}`]);

      // A newer file refuses every write.
      mockBridge.agentHistoryCorruptFile(JSON.stringify({ version: 2, entries: [] }));
      const warn = console.warn;
      const warned = [];
      console.warn = (...args) => warned.push(args.join(' '));
      try {
        await started(tab);
        await prompt(tab); // exits: an end to write
        await H.getState().flush();
        const b = await readyTerminal();
        await T.getState().startAgent(b.id, 'claude');
        await H.getState().flush();
      } finally {
        console.warn = warn;
      }
      assert.equal(warned.filter((w) => w.includes('[AgentHistory]')).length, 1, 'said once');
      assert.match(H.getState().error, /newer NexTerm/);
      assert.equal(JSON.parse(mockBridge.agentHistoryFile()).version, 2, 'the newer file is left as it is');
    });
  });

  test('AHR-11: a clear that cannot delete a copy moved aside says so in a notice, and the list is read again', async () => {
    await recording(async () => {
      const at = (n) => ({ kind: 'claude', sessionId: null, cwd: `/w/${n}`, title: null, startedAt: n, lastUsedAt: n, endedAt: null, endReason: null });
      await mockBridge.invoke('agent_history_upsert', { entry: at(1) });
      mockBridge.agentHistoryCorruptFile();
      await H.getState().load(); // moved aside
      await mockBridge.invoke('agent_history_upsert', { entry: at(2) });
      await H.getState().load();
      assert.equal(H.getState().entries.length, 1, 'premise: one entry, one copy moved aside');
      mockBridge.agentHistoryHoldAsides();
      T.setState({ agentHistoryNotice: null });
      const warn = console.warn;
      console.warn = () => {};
      let cleared;
      try {
        cleared = await H.getState().clear({ confirm: async () => true });
      } finally {
        console.warn = warn;
      }
      assert.equal(cleared, null, 'not cleared as asked');
      assert.deepEqual(H.getState().entries, [], 'the list read again: the history was emptied');
      const notice = T.getState().agentHistoryNotice;
      assert.equal(notice?.kind, 'clearFailed', 'said where the side bar and the palette say things');
      assert.match(notice.text, /^The agent session history was emptied, but 1 damaged copy of it kept aside could not be deleted\./);
      assert.equal(mockBridge.agentHistoryBad.length, 1);
      mockBridge.agentHistoryHoldAsides(false);
      assert.equal(await H.getState().clear(), 0, 'let go of: cleared');
      assert.deepEqual(mockBridge.agentHistoryBad, []);
      T.getState().dismissAgentHistoryNotice();
    });
  });

  test('AHR-10: a switch to another conversation within one write delay keeps both — a queued conversation with an id is never folded away', async () => {
    for (const found of [false, true]) {
      await recording(async () => {
        H.getState().stop();
        // A real write delay, longer than the case: everything below is one
        // burst, sent together by the flush.
        H.getState().start({ delayMs: 60_000 });
        const tab = await readyTerminal();
        await quickly(async () => {
          await withBackend(async () => {
            mockBridge.agentSessions = [
              { id: SES_A, title: 'Fix the build', updated: 200, created: 100, directory: tab.cwd },
              ...(found ? [{ id: SES_B, title: 'Write the docs', updated: 400, created: 350, directory: tab.cwd }] : []),
            ];
            await typeLine(tab.id, `opencode -s ${SES_A}`);
            await started(tab);
            await titled(tab, 'OC | Fix the build');
            await settle();
            assert.deepEqual([tabById(tab.id).agent.sessionId, tabById(tab.id).agent.title], [SES_A, 'Fix the build'], 'premise: in A');
            await sleep(5);
            const switchedAt = Date.now();
            await titled(tab, 'OC | Write the docs');
            await settle();
            assert.equal(tabById(tab.id).agent.sessionId, found ? SES_B : null, `premise: switched${found ? ', B found' : ', B not found'}`);
            assert.deepEqual(fileEntries(), [], 'premise: nothing sent before the flush');
            await H.getState().flush();
            const entries = fileEntries();
            const second = found ? `opencode:${SES_B}` : `opencode:~${tab.cwd}\u0000Write the docs`;
            assert.deepEqual(
              entries.map((e) => [e.key, e.title]),
              [[second, 'Write the docs'], [`opencode:${SES_A}`, 'Fix the build']],
              'both conversations, and A under its own id'
            );
            const [b, a] = entries;
            assert.ok(a.startedAt < switchedAt, 'A started when it started');
            assert.ok(b.startedAt >= switchedAt, 'the other conversation starts at the switch, not at A’s start');
          });
        });
      });
    }
  });
});

describe('Agent session history: the pure parts', () => {
  test('AHR-20: observeAgents — what is an event and what is not', () => {
    const tab = (id, agent, extra = {}) => ({ id, cwd: '/w', agent, agentResumeOffered: false, ...extra });
    const claude = { kind: 'claude', sessionId: UUID, startedAt: 1, title: null };
    let seen = observeAgents(new Map(), [tab('t1', claude), tab('t2', { kind: 'agy', sessionId: 'a', startedAt: 1 })], { now: 10 });
    assert.deepEqual(seen.events.map((e) => [e.type, e.key]), [['started', `claude:${UUID}`]], 'an unknown agent is no event');
    const same = observeAgents(seen.tracked, [tab('t1', claude)], { now: 11 });
    assert.deepEqual(same.events.map((e) => [e.type, e.reason]), [], 'the same record again: nothing');

    seen = observeAgents(new Map(), [tab('t1', { kind: 'opencode', sessionId: null, startedAt: 1, title: null }, { cwd: 'relative/dir' })], { now: 10 });
    assert.deepEqual(seen.events, [], 'a folder the history cannot keep: not recorded');
    seen = observeAgents(new Map(), [tab('t1', claude, { cwd: '//server/share/x' })], { now: 10 });
    assert.deepEqual(seen.events, [], 'nor one on another machine');

    // Offered, then resumed from a history entry with no id that is now known by its id.
    const offered = { kind: 'opencode', sessionId: null, startedAt: 5, title: 'T' };
    seen = observeAgents(new Map(), [tab('t1', offered, { agentResumeOffered: true, agentHistoryKey: 'opencode:~/w\u0000T' })], { now: 10 });
    assert.deepEqual(seen.events, [], 'offered: nothing');
    const resumed = observeAgents(seen.tracked, [tab('t1', { ...offered, sessionId: SES_A }, { agentHistoryKey: 'opencode:~/w\u0000T' })], { now: 12 });
    assert.deepEqual(
      resumed.events.map((e) => [e.type, e.key, e.replaces, e.entry.startedAt, e.entry.lastUsedAt]),
      [['resumed', `opencode:${SES_A}`, 'opencode:~/w\u0000T', 12, 12]]
    );
    const typedOver = observeAgents(seen.tracked, [tab('t1', { kind: 'opencode', sessionId: null, startedAt: 11, title: null }, { agentHistoryKey: 'opencode:~/w\u0000T' })], { now: 12 });
    assert.deepEqual(
      typedOver.events.map((e) => [e.type, e.replaces]),
      [['started', null]],
      'an agent typed by hand over the offer is a start of its own, and replaces nothing'
    );
    const gone = observeAgents(resumed.tracked, [], { now: 20 });
    assert.deepEqual(gone.events.map((e) => [e.type, e.reason, e.entry.endedAt, e.entry.endReason]), [['ended', 'closed', 20, 'closed']]);
    assert.deepEqual(historyHolders(resumed.tracked, []), { [`opencode:${SES_A}`]: { tabId: 't1', state: 'open' } });
  });

  test('AHR-22: observeAgents — a switch starts the other conversation now and replaces nothing; a provisional entry is still replaced', () => {
    const tab = (agent) => ({ id: 't1', cwd: '/w', agent, agentResumeOffered: false });
    const inA = { kind: 'opencode', sessionId: SES_A, startedAt: 1, title: 'Alpha' };
    let seen = observeAgents(new Map(), [tab(inA)], { now: 10 });
    // The id let go of: another conversation's title.
    const away = observeAgents(seen.tracked, [tab({ ...inA, sessionId: null, title: 'Beta' })], { now: 20 });
    assert.deepEqual(
      away.events.map((e) => [e.type, e.key, e.replaces, e.entry.startedAt, e.entry.lastUsedAt]),
      [['titled', 'opencode:~/w\u0000Beta', null, 20, 20]],
      'replaces null (the backend never takes an id entry), and started at the switch'
    );
    // Its id found next: the provisional entry it was is replaced, its start kept.
    const found = observeAgents(away.tracked, [tab({ ...inA, sessionId: SES_B, title: 'Beta' })], { now: 30 });
    assert.deepEqual(
      found.events.map((e) => [e.type, e.key, e.replaces, e.entry.startedAt]),
      [['idLearned', `opencode:${SES_B}`, 'opencode:~/w\u0000Beta', 20]]
    );
    // One id straight after another: also another conversation.
    const straight = observeAgents(seen.tracked, [tab({ ...inA, sessionId: SES_B })], { now: 40 });
    assert.deepEqual(straight.events.map((e) => [e.type, e.replaces, e.entry.startedAt]), [['idLearned', null, 40]]);
    // A provisional entry titled: re-keyed, replacing the one it was, its start kept.
    seen = observeAgents(new Map(), [tab({ ...inA, sessionId: null, title: null })], { now: 50 });
    const titledNow = observeAgents(seen.tracked, [tab({ ...inA, sessionId: null, title: 'Gamma' })], { now: 60 });
    assert.deepEqual(
      titledNow.events.map((e) => [e.type, e.key, e.replaces, e.entry.startedAt]),
      [['titled', 'opencode:~/w\u0000Gamma', 'opencode:~/w\u0000', 50]]
    );
  });

  test('AHR-24: observeAgents — an offer taken and given back (a password prompt) ends what it resumed; taken again, resumed again', () => {
    const record = { kind: 'claude', sessionId: UUID, startedAt: 5, title: null };
    const tab = (offered) => ({ id: 't1', cwd: '/w', agent: record, agentResumeOffered: offered });
    const offered = observeAgents(new Map(), [tab(true)], { now: 10 });
    assert.deepEqual(offered.events, [], 'offered: nothing');
    const taken = observeAgents(offered.tracked, [tab(false)], { now: 20 });
    assert.deepEqual(taken.events.map((e) => [e.type, e.entry.endedAt]), [['resumed', null]]);
    const givenBack = observeAgents(taken.tracked, [tab(true)], { now: 30 });
    assert.deepEqual(
      givenBack.events.map((e) => [e.type, e.reason, e.key, e.entry.lastUsedAt, e.entry.endedAt, e.entry.endReason]),
      [['ended', 'exited', `claude:${UUID}`, 30, 30, 'exited']],
      'not left reading as running'
    );
    assert.deepEqual(historyHolders(givenBack.tracked, [tab(true)]), { [`claude:${UUID}`]: { tabId: 't1', state: 'offered' } });
    const again = observeAgents(givenBack.tracked, [tab(false)], { now: 40 });
    assert.deepEqual(again.events.map((e) => [e.type, e.entry.startedAt, e.entry.endedAt]), [['resumed', 40, null]]);
    // Still offered: nothing more.
    assert.deepEqual(observeAgents(givenBack.tracked, [tab(true)], { now: 50 }).events, []);
  });

  test('AHR-23: queueUpsert takes a queued entry in only as the backend would — one with no id, of the same kind', () => {
    const e = (kind, sessionId, title, startedAt) => ({ kind, sessionId, cwd: '/w', title, startedAt, lastUsedAt: startedAt, endedAt: null, endReason: null });
    const op = (entry, replaces = null) => ({ entry, key: historyKey(entry), replaces, tabId: 't1' });
    const keysOf = (q) => q.map((o) => [o.key, o.replaces]);

    // A conversation with an id, queued, then the terminal is in another one.
    const a = op(e('opencode', SES_A, 'Alpha', 1));
    let q = queueUpsert([a], op(e('opencode', null, 'Beta', 2), `opencode:${SES_A}`));
    assert.deepEqual(keysOf(q), [[`opencode:${SES_A}`, null], ['opencode:~/w\u0000Beta', `opencode:${SES_A}`]], 'A is still sent');
    assert.deepEqual(q[0], a, 'as it was');
    // Nor one of another kind.
    const claudeLatest = op(e('claude', null, null, 1));
    q = queueUpsert([claudeLatest], op(e('opencode', null, null, 2), claudeLatest.key));
    assert.deepEqual(keysOf(q).map(([k]) => k), [claudeLatest.key, 'opencode:~/w\u0000'], 'another kind is its own');

    // A provisional entry is taken into the one replacing it, its start kept.
    const provisional = op(e('opencode', null, null, 5));
    const titledOp = op(e('opencode', null, 'Fix', 6), provisional.key);
    q = queueUpsert([provisional], titledOp);
    assert.deepEqual(keysOf(q), [['opencode:~/w\u0000Fix', null]], 'folded: never sent to be replaced');
    q = queueUpsert(q, op(e('opencode', SES_B, 'Fix', 7), 'opencode:~/w\u0000Fix'));
    assert.deepEqual(keysOf(q), [[`opencode:${SES_B}`, null]]);
    assert.deepEqual([q[0].entry.startedAt, q[0].entry.title], [5, 'Fix']);
    // The same key: one write.
    q = queueUpsert(q, op(e('opencode', SES_B, null, 9)));
    assert.deepEqual([q.length, q[0].entry.startedAt, q[0].entry.title], [1, 5, 'Fix'], 'merged per key, the title kept');
    // The queue given is not changed.
    const given = [a];
    queueUpsert(given, op(e('opencode', SES_A, 'Alpha 2', 3)));
    assert.deepEqual(given, [a]);
  });

  test('AHR-21: historyRecord, the display and the palette filter', () => {
    const entry = { key: `opencode:${SES_A}`, kind: 'opencode', sessionId: SES_A, cwd: 'C:\\work\\app', title: 'Fix it', startedAt: 1, lastUsedAt: 2, endedAt: null, endReason: null };
    assert.deepEqual(historyRecord(entry), { kind: 'opencode', sessionId: SES_A, startedAt: 1, title: 'Fix it' });
    assert.equal(historyRecord({ ...entry, sessionId: 'x; curl a | sh' }), null, 'an id not of its shape is refused, not continued');
    assert.equal(historyRecord({ ...entry, kind: 'agy' }), null, 'an agent this build does not know');
    assert.equal(historyRecord({ ...entry, cwd: 'work' }), null);
    assert.equal(historyRecord({ ...entry, kind: 'claude', sessionId: null, title: 'x' }).title, null, 'claude keeps no title');
    assert.equal(folderName('C:\\work\\app'), 'app');
    assert.equal(folderName('/'), '/');
    assert.equal(folderName('C:\\'), 'C:\\');
    assert.equal(historyDisplay({ ...entry, kind: 'claude', sessionId: null, title: null }).title, 'most recent in folder');
    assert.equal(historyDisplay({ ...entry, title: null }).title, 'ses_aaaaaaaa');
    assert.ok(historyMatches(entry, 'open fix'));
    assert.ok(historyMatches(entry, 'ses_aaa'), 'an id prefix');
    assert.ok(historyMatches(entry, 'APP'), 'the folder, case aside');
    assert.ok(!historyMatches(entry, 'aaaa'), 'an id fits only from its start');
    assert.ok(!historyMatches(entry, 'claude'));
  });
});

describe('Agent session history (recording): teardown', () => {
  test('AHR-99: the stores, the storage and the mock as they were', async () => {
    await H.getState().stop();
    H.setState({ entries: [], loaded: false, error: null, holders: {} });
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.getState().dispose();
    mockBridge.agentSessions = [];
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      mockBridge.agentHistoryNewerSaid = before.newerSaid;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    backing.clear();
    assert.equal(H.getState().isRecording(), false, 'the recorder is stopped');
    assert.equal(mockBridge.agentHistoryMemory, null, 'no history is left for another suite');
  });
});
