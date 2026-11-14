/**
 * Resuming from the agent session history: `resumeFromHistory(key)` in
 * src/stores/terminalStore.js.
 *
 * A pick opens a NEW terminal in the entry's folder, in the active pane, and
 * resumes there through the existing `resumeAgent`: nothing typed before the
 * shell's first prompt, then exactly `claude --resume <uuid>` /
 * `opencode -s <id>`. Never a second terminal on a conversation this window
 * holds — running it, or offering it back: that terminal is switched to, and
 * a notice names it. An opencode entry with no id is looked up by its title
 * with every rule a restored terminal has: the banner's Choose... when it
 * cannot tell, `--continue` only when no other opencode terminal is within
 * reach. A missing folder opens nothing and keeps the entry. And the file is
 * untrusted: an entry whose id is not its agent's shape is never typed.
 *
 * The backend is the browser mock. Writes to the terminals are held, spawns
 * counted. AHS-99 puts the stores, the storage and the mock back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useAgentHistoryStore, subscribeAgentLifecycle } from '../../src/stores/agentHistoryStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { agentSessionRowHandlers, resumeAgentSessionWith } from '../../src/components/terminal/statusBoardModel.js';

const T = terminalStore.useTerminalStore;
const H = useAgentHistoryStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES_A = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const SES_B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });

async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

/**
 * `fn` with terminal writes held, and spawns and writes counted, by terminal.
 * `answer(command, args)`, when given, answers a call itself (counted first)
 * by returning `{ value }` or throwing; undefined lets the mock answer.
 */
async function withBackend(fn, { list = null, answer = null } = {}) {
  const original = mockBridge.invoke;
  const calls = { writes: [], spawns: [] };
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      calls.writes.push({ session: args?.session_id, data: args?.data });
      return null;
    }
    if (command === 'pty_spawn') calls.spawns.push({ ...args });
    if (command === 'agent_history_list' && list) return structuredClone(list);
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

/** A `withBackend` answer: a spawn in `cwd` refused, as a folder that refuses the shell is. */
const refuseShellIn = (cwd) => (command, args) => {
  if (command === 'pty_spawn' && args?.cwd === cwd) throw new Error('Permission denied (os error 13)');
  return undefined;
};

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

const entry = (kind, sessionId, cwd, title = null) => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt: 2000, endedAt: 2000, endReason: 'closed',
});
/** Put `e` in the history; its key, as the backend made it. */
const remember = async (e) => (await mockBridge.invoke('agent_history_upsert', { entry: e })).key;

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

/**
 * `fn(resume)`: resume `key` from the history and, once the new terminal is
 * there, check nothing was typed yet, then draw its first prompt. Resolves
 * with the result, the new terminal and the calls.
 */
async function resumeNew(key, { beforePrompt = null, list = null } = {}) {
  const tabsBefore = T.getState().tabs.length;
  let result;
  let tab;
  const calls = await withBackend(async (c) => {
    const pending = T.getState().resumeFromHistory(key);
    await until(() => T.getState().tabs.length > tabsBefore || c.spawns.length > 0, 'the new terminal');
    await until(() => T.getState().tabs.length > tabsBefore && tabById(T.getState().activeTabId)?.agentHistoryKey === key, 'it to be placed');
    tab = tabById(T.getState().activeTabId);
    await sleep(20);
    assert.deepEqual(c.writes, [], 'nothing typed before the shell’s first prompt');
    if (beforePrompt) await beforePrompt(tab, c);
    await prompt(tab);
    result = await pending;
  }, { list });
  return { result, tab: tabById(tab.id) ?? tab, calls };
}

/** What was before this file's first case: AHS-99 puts it back. */
let before = null;
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** Each case: an empty history in a storage of its own; everything closed after. */
async function fresh(fn) {
  if (!before) {
    before = {
      storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      memory: mockBridge.agentHistoryMemory,
      bad: mockBridge.agentHistoryBad,
    };
  }
  backing.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  T.setState({ agentHistoryNotice: null });
  try {
    await fn();
  } finally {
    await H.getState().stop();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    mockBridge.agentSessions = [];
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  }
}

describe('Agent session history: resuming an entry in a new terminal', () => {
  test('AHS-01: a claude entry — one new terminal in its folder, active in the active pane, `claude --resume <uuid>` after the prompt', async () => {
    await fresh(async () => {
      const other = await readyTerminal();
      // An earlier pick left a notice up: this one takes it down.
      const goneKey = await remember(entry('claude', UUID, '/gone/away'));
      assert.equal((await T.getState().resumeFromHistory(goneKey)).outcome, 'missingFolder');
      assert.equal(T.getState().agentHistoryNotice?.kind, 'missingFolder', 'premise: a notice is up');
      await mockBridge.invoke('agent_history_remove', { key: goneKey });
      const key = await remember(entry('claude', UUID, '/workspace/src'));
      const paneBefore = onScreen().paneId;
      const { result, tab, calls } = await resumeNew(key);
      assert.deepEqual(result, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });
      assert.equal(T.getState().agentHistoryNotice, null, 'the earlier notice is gone');
      assert.equal(calls.spawns.length, 1, 'one pty');
      assert.equal(calls.spawns[0].cwd, '/workspace/src', 'in the entry’s folder');
      assert.equal(calls.spawns[0].strict_cwd, true, 'and there or nowhere');
      assert.equal(tab.cwd, '/workspace/src');
      assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: `claude --resume ${UUID}\r` }], 'exactly that, there');
      const screen = onScreen();
      assert.equal(screen.activeTabId, tab.id, 'the active terminal');
      assert.equal(screen.paneId, paneBefore, 'in the pane that was active');
      assert.ok(screen.paneTabs.includes(tab.id));
      assert.notEqual(tab.id, other.id);
      assert.equal(tab.agentResumeOffered, false, 'the offer was taken');
      assert.equal(tab.agent.sessionId, UUID);
    });
  });

  test('AHS-02: an opencode entry no terminal holds — `opencode -s <id>`', async () => {
    await fresh(async () => {
      const key = await remember(entry('opencode', SES_A, '/workspace/tests', 'Fix the build'));
      const { result, tab, calls } = await resumeNew(key);
      assert.equal(result.outcome, 'opened');
      assert.equal(calls.spawns.length, 1);
      assert.deepEqual(calls.writes.map((w) => w.data), [`opencode -s ${SES_A}\r`]);
      assert.deepEqual([tab.agent.kind, tab.agent.sessionId, tab.agent.title], ['opencode', SES_A, 'Fix the build']);
    });
  });

  test('AHS-03: held by a running terminal — no new pty, that terminal made active, a notice naming it, nothing typed', async () => {
    await fresh(async () => {
      const holder = await readyTerminal();
      const claudeHolder = await readyTerminal();
      await withBackend(async () => {
        await typeLine(holder.id, `opencode -s ${SES_A}`);
        await started(holder);
      });
      let claude;
      await withBackend(async () => {
        claude = await T.getState().startAgent(claudeHolder.id, 'claude');
      });
      const elsewhere = await readyTerminal();
      assert.equal(T.getState().activeTabId, elsewhere.id, 'premise: another terminal is active');

      for (const [key, owner] of [
        [await remember(entry('opencode', SES_A, '/workspace', 'Mine')), holder],
        [await remember(entry('claude', claude.sessionId, '/workspace')), claudeHolder],
      ]) {
        T.getState().switchTab(elsewhere.id);
        const tabsBefore = T.getState().tabs.length;
        let result;
        const calls = await withBackend(async () => {
          result = await T.getState().resumeFromHistory(key);
        });
        assert.equal(result.outcome, 'focused', key);
        assert.equal(result.tabId, owner.id);
        assert.equal(calls.spawns.length, 0, 'no pty_spawn');
        assert.equal(T.getState().tabs.length, tabsBefore, 'no terminal');
        assert.deepEqual(calls.writes, [], 'nothing typed anywhere');
        assert.equal(T.getState().activeTabId, owner.id, 'the holder is the active terminal');
        const notice = T.getState().agentHistoryNotice;
        assert.equal(notice.kind, 'focused');
        assert.ok(notice.text.includes(tabById(owner.id).title), `the notice names it: ${notice.text}`);
        assert.ok(notice.text.includes('already open'), notice.text);
        assert.equal(result.notice, notice);
      }
      T.getState().dismissAgentHistoryNotice();
      assert.equal(T.getState().agentHistoryNotice, null);
    });
  });

  test('AHS-04: held by a terminal that only offers it back — the same, and nothing typed', async () => {
    await fresh(async () => {
      const offering = await readyTerminal();
      T.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === offering.id ? { ...t, agent: { kind: 'opencode', sessionId: SES_A, startedAt: 1, title: 'Mine' }, agentResumeOffered: true } : t
        ),
      }));
      const elsewhere = await readyTerminal();
      const key = await remember(entry('opencode', SES_A, '/workspace', 'Mine'));
      let result;
      const calls = await withBackend(async () => {
        result = await T.getState().resumeFromHistory(key);
      });
      assert.equal(result.outcome, 'focused');
      assert.equal(result.tabId, offering.id);
      assert.equal(T.getState().activeTabId, offering.id);
      assert.notEqual(T.getState().activeTabId, elsewhere.id);
      assert.deepEqual([calls.spawns.length, calls.writes.length], [0, 0]);
      assert.ok(result.notice.text.includes('offered back'), result.notice.text);
      assert.equal(tabById(offering.id).agentResumeOffered, true, 'its offer is left to the user');
    });
  });

  test('AHS-05: an opencode entry with no id that cannot be told — nothing typed, the banner asks, held ones marked', async () => {
    await fresh(async () => {
      // (1) Its title fits one conversation, and another terminal has it.
      const holder = await readyTerminal('/workspace/src');
      await withBackend(async () => {
        await typeLine(holder.id, `opencode -s ${SES_A}`);
        await started(holder);
      });
      mockBridge.agentSessions = [{ id: SES_A, title: 'Fix it', updated: 200, created: 100, directory: '/workspace/src' }];
      const key = await remember(entry('opencode', null, '/workspace/src', 'Fix it'));
      let { result, tab, calls } = await resumeNew(key);
      assert.equal(result.outcome, 'opened');
      assert.equal(result.typed, false);
      assert.deepEqual(calls.writes, [], 'nothing typed');
      assert.equal(tab.agentResumeOffered, true, 'the offer stays');
      assert.equal(tab.agentResumeNotice?.kind, 'unsure', 'and the banner opens its Choose... list');
      const listed = await T.getState().listAgentSessions(tab.id);
      assert.deepEqual(listed.map((s) => [s.id, s.heldBy]), [[SES_A, tabById(holder.id).title]], 'the held one is marked');
      await T.getState().closeTab(tab.id);
      await T.getState().closeTab(holder.id);

      // (2) Its title fits two, and another terminal there shows a title like
      // it — opencode's cut of it — without knowing which it is.
      const LONG = 'Fix the login bug in the OAuth callback handler';
      mockBridge.agentSessions = [
        { id: SES_A, title: LONG, updated: 200, created: 100, directory: '/workspace/src' },
        { id: SES_B, title: LONG, updated: 300, created: 250, directory: '/workspace/src' },
      ];
      const rival = await readyTerminal('/workspace/src');
      T.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === rival.id
            ? { ...t, agent: { kind: 'opencode', sessionId: null, startedAt: 1, title: `${LONG.slice(0, 37)}…` }, agentResumeOffered: true }
            : t
        ),
      }));
      const longKey = await remember(entry('opencode', null, '/workspace/src', LONG));
      ({ result, tab, calls } = await resumeNew(longKey));
      assert.equal(result.outcome, 'opened');
      assert.equal(result.typed, false);
      assert.deepEqual(calls.writes, []);
      assert.equal(tab.agentResumeNotice?.kind, 'unsure');
      await T.getState().closeTab(tab.id);

      // The same folder and title with no id in a terminal already: that one is switched to.
      T.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === rival.id ? { ...t, agent: { ...t.agent, title: LONG } } : t)),
      }));
      const focused = await withBackend(async () => {
        result = await T.getState().resumeFromHistory(longKey);
      });
      assert.deepEqual([result.outcome, result.tabId, focused.spawns.length], ['focused', rival.id, 0]);
    });
  });

  test('AHS-06: `opencode --continue` only when no other opencode terminal is within reach', async () => {
    await fresh(async () => {
      const key = await remember(entry('opencode', null, '/workspace/tests'));
      let { result, calls } = await resumeNew(key);
      assert.equal(result.typed, true, 'alone: typed');
      assert.deepEqual(calls.writes.map((w) => w.data), ['opencode --continue\r']);
      for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);

      // Another opencode terminal in the folder above it.
      const above = await readyTerminal('/workspace');
      await withBackend(async () => {
        await typeLine(above.id, 'opencode');
        await started(above);
      });
      let tab;
      ({ result, tab, calls } = await resumeNew(key));
      assert.equal(result.typed, false, 'within its reach: not typed');
      assert.deepEqual(calls.writes, []);
      assert.equal(tab.agentResumeNotice?.kind, 'unsure');
    });
  });

  test('AHS-07: a folder that is not there any more — no pty, a notice, the entry stays', async () => {
    await fresh(async () => {
      const key = await remember(entry('claude', UUID, '/gone/away'));
      const tabsBefore = T.getState().tabs.length;
      let result;
      const calls = await withBackend(async () => {
        result = await T.getState().resumeFromHistory(key);
      });
      assert.equal(result.outcome, 'missingFolder');
      assert.equal(calls.spawns.length, 0, 'no pty');
      assert.equal(T.getState().tabs.length, tabsBefore);
      assert.ok(T.getState().agentHistoryNotice.text.includes('/gone/away'));
      assert.ok((await mockBridge.invoke('agent_history_list')).some((e) => e.key === key), 'still listed');
    });
  });

  test('AHS-08: an entry whose id is not its agent’s shape, or of an unknown agent, is never typed', async () => {
    await fresh(async () => {
      await readyTerminal();
      // A history file nothing validated: the backend is bypassed.
      const bad = [
        { ...entry('claude', 'x; curl a | sh', '/workspace'), key: 'claude:x; curl a | sh' },
        { ...entry('claude', UUID.toUpperCase(), '/workspace'), key: `claude:${UUID.toUpperCase()}` },
        { ...entry('opencode', 'ses_x;rm', '/workspace', 'T'), key: 'opencode:ses_x;rm' },
        { ...entry('agy', 'agy-1', '/workspace'), key: 'agy:agy-1' },
        { ...entry('claude', null, 'workspace'), key: 'claude:~workspace\u0000' },
      ];
      for (const e of bad) {
        let result;
        const calls = await withBackend(async () => {
          result = await T.getState().resumeFromHistory(e.key);
          await sleep(20);
        }, { list: bad });
        assert.equal(result.outcome, 'refused', e.key);
        assert.deepEqual([calls.spawns.length, calls.writes.length], [0, 0], `${e.key}: nothing spawned or typed`);
      }
      const gone = await T.getState().resumeFromHistory('claude:not-there');
      assert.equal(gone.outcome, 'gone');
    });
  });

  test('AHS-09: picked twice at once — one terminal', async () => {
    await fresh(async () => {
      const key = await remember(entry('claude', UUID, '/workspace/src'));
      const calls = await withBackend(async (c) => {
        const first = T.getState().resumeFromHistory(key);
        const second = await T.getState().resumeFromHistory(key);
        assert.equal(second.outcome, 'busy');
        await until(() => tabById(T.getState().activeTabId)?.agentHistoryKey === key, 'the terminal');
        await prompt(tabById(T.getState().activeTabId));
        assert.equal((await first).outcome, 'opened');
        assert.equal(c.spawns.length, 1);
        // And once it is open, a third pick finds it.
        assert.equal((await T.getState().resumeFromHistory(key)).outcome, 'focused');
      });
      assert.equal(calls.spawns.length, 1);
    });
  });

  test('AHS-10: createTab takes a folder', async () => {
    await fresh(async () => {
      const calls = await withBackend(async () => {
        const a = await T.getState().createTab({ cwd: '/workspace/tests' });
        const b = await T.getState().createTab('Named', { cwd: '/workspace/src' });
        const c = await T.getState().createTab();
        assert.deepEqual([a.cwd, b.cwd, b.title], ['/workspace/tests', '/workspace/src', 'Named']);
        assert.equal(c.cwd, '/workspace', 'none asked: where a new terminal starts');
      });
      assert.deepEqual(calls.spawns.map((s) => s.cwd), ['/workspace/tests', '/workspace/src', null]);
      assert.deepEqual(calls.spawns.map((s) => Object.keys(s).sort()), Array(3).fill(['cols', 'cwd', 'rows', 'shell']), 'never strict unless asked');

      // Not strict: a folder that refuses the shell falls back, as ever.
      const warn = console.warn;
      console.warn = () => {};
      try {
        const fallback = await withBackend(async () => {
          const tab = await T.getState().createTab({ cwd: '/workspace/src' });
          assert.ok(tab, 'a terminal all the same');
          assert.equal(tab.cwd, '/workspace', 'in the default directory');
        }, { answer: refuseShellIn('/workspace/src') });
        assert.deepEqual(fallback.spawns.map((s) => s.cwd), ['/workspace/src', null], 'tried there, then the default');
      } finally {
        console.warn = warn;
      }
    });
  });

  test('AHS-12: a terminal that cannot start in the entry’s folder — outcome failed, a notice, nothing typed, no terminal elsewhere', async () => {
    await fresh(async () => {
      await readyTerminal();
      const error = console.error;
      console.error = () => {};
      try {
        // (1) The folder is there, but the shell is refused in it.
        const key = await remember(entry('claude', UUID, '/workspace/src'));
        const tabsBefore = T.getState().tabs.length;
        let result;
        const calls = await withBackend(async () => {
          result = await T.getState().resumeFromHistory(key);
          await sleep(20);
        }, { answer: refuseShellIn('/workspace/src') });
        assert.equal(result.outcome, 'failed');
        assert.equal(result.typed, false);
        assert.deepEqual(calls.spawns.map((s) => [s.cwd, s.strict_cwd]), [['/workspace/src', true]], 'one try, there; none in the default directory');
        assert.deepEqual(calls.writes, [], 'nothing typed anywhere');
        assert.equal(T.getState().tabs.length, tabsBefore, 'no terminal');
        assert.equal(T.getState().agentHistoryNotice?.kind, 'failed');
        assert.ok(T.getState().agentHistoryNotice.text.includes('/workspace/src'), T.getState().agentHistoryNotice.text);
        assert.equal(result.notice, T.getState().agentHistoryNotice);

        // (2) The folder went between the look and the spawn: the backend
        // refuses a strict spawn there (the mock as the backend). The worst
        // case: `claude --continue` would resume another folder's conversation.
        const vanished = await remember(entry('claude', null, '/workspace/vanished'));
        const raced = await withBackend(async () => {
          result = await T.getState().resumeFromHistory(vanished);
          await sleep(20);
        }, { answer: (command, args) => (command === 'fs_dir_exists' && args?.path === '/workspace/vanished' ? { value: true } : undefined) });
        assert.equal(result.outcome, 'failed');
        assert.deepEqual(raced.spawns.map((s) => s.cwd), ['/workspace/vanished'], 'no second try elsewhere');
        assert.deepEqual(raced.writes, [], 'no `claude --continue` anywhere');
        assert.equal(T.getState().tabs.length, tabsBefore);
        assert.ok((await mockBridge.invoke('agent_history_list')).some((e) => e.key === vanished), 'the entry stays');

        // The mock's strict spawn is the backend's: there or an error, never a fallback.
        await assert.rejects(
          () => mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace/vanished', shell: null, strict_cwd: true }),
          /^Error: No terminal can start in "\/workspace\/vanished": it is not a folder on this machine$/
        );
        const there = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace/src', shell: null, strict_cwd: true });
        assert.equal(there.cwd, '/workspace/src');
        await mockBridge.invoke('pty_kill', { session_id: there.session_id });
        assert.equal(await T.getState().createTab({ strictCwd: true }), null, 'strict with no folder: nowhere');
      } finally {
        console.error = error;
      }
    });
  });

  test('AHS-13: an opencode entry with no id whose title fits two FREE conversations — the newest is resumed (AC14(c) as amended)', async () => {
    await fresh(async () => {
      mockBridge.agentSessions = [
        { id: SES_A, title: 'Fix it', updated: 200, created: 100, directory: '/workspace/src' },
        { id: SES_B, title: 'Fix it', updated: 300, created: 250, directory: '/workspace/src' },
      ];
      const key = await remember(entry('opencode', null, '/workspace/src', 'Fix it'));
      const { result, tab, calls } = await resumeNew(key);
      assert.equal(result.outcome, 'opened');
      assert.equal(result.typed, true, 'none held, no terminal competing: typed');
      assert.deepEqual(calls.writes, [{ session: tab.sessionId, data: `opencode -s ${SES_B}\r` }], 'exactly the newer one');
      assert.equal(tab.agentResumeNotice?.kind ?? null, null, 'no Choose... asked');
    });
  });

  test('AHS-11: with the recorder on, a resumed entry with no id becomes its conversation’s, with no duplicate', async () => {
    await fresh(async () => {
      H.getState().start({ delayMs: 0 });
      mockBridge.agentSessions = [{ id: SES_A, title: 'Fix it', updated: 200, created: 100, directory: '/workspace/src' }];
      const key = await remember(entry('opencode', null, '/workspace/src', 'Fix it'));
      const { result, calls } = await resumeNew(key);
      assert.equal(result.typed, true);
      assert.deepEqual(calls.writes.map((w) => w.data), [`opencode -s ${SES_A}\r`], 'found by its title');
      await H.getState().flush();
      const listed = await mockBridge.invoke('agent_history_list');
      assert.deepEqual(listed.map((e) => [e.key, e.title, e.startedAt, e.endedAt]), [[`opencode:${SES_A}`, 'Fix it', 1000, null]], 'the entry, by its id now');
      assert.deepEqual(H.getState().holders[`opencode:${SES_A}`]?.state, 'open');
    });
  });

  test('AHS-14: a resume a password prompt gives back typed nothing — its entry is ended again, not left reading as running', async () => {
    await fresh(async () => {
      const previousWait = terminalStore.__setAgentPromptWaitMs(300);
      const warn = console.warn;
      console.warn = () => {};
      const events = [];
      const unsubscribe = subscribeAgentLifecycle((e) => events.push([e.type, e.reason ?? null]));
      try {
        H.getState().start({ delayMs: 0 });
        const key = await remember(entry('claude', UUID, '/workspace/src'));
        const { result, tab, calls } = await (async () => {
          const original = mockBridge.invoke;
          // Typing hidden in the new terminal, for as long as the wait lasts.
          mockBridge.invoke = async function (command, args, ...rest) {
            if (command === 'pty_input_hidden') return true;
            return original.call(this, command, args, ...rest);
          };
          try {
            return await resumeNew(key);
          } finally {
            mockBridge.invoke = original;
          }
        })();
        assert.deepEqual([result.outcome, result.typed], ['opened', false], 'premise: nothing typed');
        assert.deepEqual(calls.writes, [], 'not into the password prompt');
        assert.equal(tab.agentResumeOffered, true, 'premise: the offer is back');
        await H.getState().flush();
        const [kept] = await mockBridge.invoke('agent_history_list');
        assert.equal(kept.key, key);
        assert.ok(Number.isFinite(kept.endedAt), `ended again (endedAt ${kept.endedAt})`);
        assert.equal(kept.endReason, 'exited');
        assert.deepEqual(events, [['resumed', null], ['ended', 'exited']], 'the listeners hear it ended too');
        assert.deepEqual(H.getState().holders[key]?.state, 'offered', 'still offered back there');
      } finally {
        unsubscribe();
        console.warn = warn;
        terminalStore.__setAgentPromptWaitMs(previousWait);
      }
    });
  });

  test('AHS-15: Enter on a side bar row resumes through resumeFromHistory — one terminal, `claude --resume <uuid>` (B-R5)', async () => {
    await fresh(async () => {
      await readyTerminal();
      const key = await remember(entry('claude', UUID, '/workspace/src'));
      const selected = [];
      // As TerminalsPanel wires the row (AHP-06 pins that wiring).
      let pending = null;
      const resumeAgentSession = (k) => {
        pending = resumeAgentSessionWith(k, { select: (s) => selected.push(s), resumeFromHistory: T.getState().resumeFromHistory });
      };
      const row = agentSessionRowHandlers(key, { select: (s) => selected.push(s), resume: resumeAgentSession, openMenu: () => {} });
      const tabsBefore = T.getState().tabs.length;
      const calls = await withBackend(async (c) => {
        row.onKeyDown({ key: 'Enter' });
        await until(() => T.getState().tabs.length > tabsBefore && tabById(T.getState().activeTabId)?.agentHistoryKey === key, 'the new terminal');
        const tab = tabById(T.getState().activeTabId);
        await sleep(20);
        assert.deepEqual(c.writes, [], 'nothing before the prompt');
        await prompt(tab);
        assert.deepEqual(await pending, { outcome: 'opened', tabId: tab.id, typed: true, notice: null });
      });
      assert.deepEqual(selected, [key], 'the row selected');
      assert.deepEqual(calls.spawns.map((s) => [s.cwd, s.strict_cwd]), [['/workspace/src', true]], 'one terminal, in its folder');
      assert.deepEqual(calls.writes.map((w) => w.data), [`claude --resume ${UUID}\r`]);
      assert.equal(T.getState().tabs.length, tabsBefore + 1);
    });
  });
});

describe('Agent session history (resume): teardown', () => {
  test('AHS-99: the stores, the storage and the mock as they were', async () => {
    await H.getState().stop();
    H.setState({ entries: [], loaded: false, error: null, holders: {} });
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ agentHistoryNotice: null });
    mockBridge.agentSessions = [];
    if (before) {
      mockBridge.agentHistoryMemory = before.memory;
      mockBridge.agentHistoryBad = before.bad;
      if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
      else delete globalThis.localStorage;
    }
    backing.clear();
    assert.equal(mockBridge.agentHistoryMemory, null, 'no history is left for another suite');
  });
});
