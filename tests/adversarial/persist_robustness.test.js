/**
 * Three ways the workspace used to be lost. All were found by verifying the
 * group refactor rather than by using the app, and none of them announce
 * themselves — the running app looks perfectly healthy in every case.
 *
 *   1. The debounced save was starvable. `pty-output` rebuilds `state.tabs` on
 *      every chunk, so a shell printing more often than the debounce (a dev
 *      server, `tail -f`, a test watcher) pushed the write out forever.
 *   2. A failed restore replaced the payload it failed to read. On the upgrade
 *      launch that payload is irreplaceable.
 *   3. Quitting dropped whatever was still pending.
 */

import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';

// Other suites install their own localStorage shim. Installing this one at
// module scope replaced theirs for the whole run, so it goes in and comes back
// out around each test instead.
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
let borrowedFrom = null;

function useOwnStorage() {
  borrowedFrom = globalThis.localStorage;
  globalThis.localStorage = shim;
  backing.clear();
}
function returnStorage() {
  globalThis.localStorage = borrowedFrom;
  borrowedFrom = null;
}

const { useTerminalStore: S, PERSIST_KEY, PERSIST_BACKUP_KEY } = await import(
  '../../src/stores/terminalStore.js'
);
const { mockBridge } = await import('../../src/lib/ipc.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const onDisk = () => {
  const raw = backing.get(PERSIST_KEY);
  return raw ? JSON.parse(raw).data : null;
};

/** A workspace exactly as the released v0.1.1 wrote it. */
const V1_PAYLOAD = {
  splitTree: {
    type: 'split', id: 's1', direction: 'horizontal',
    children: [
      { type: 'leaf', id: 'pane-root', tabIds: ['t1', 't2'], activeTabId: 't1', name: 'Backend' },
      { type: 'leaf', id: 'pane-1', tabIds: ['t3'], activeTabId: 't3' },
    ],
  },
  tabs: [
    { id: 't1', title: 'build', cwd: '/workspace' },
    { id: 't2', title: 'server', cwd: '/workspace' },
    { id: 't3', title: 'logs', cwd: '/workspace' },
  ],
  activePaneId: 'pane-root', groupViewMode: 'split', focusedPaneId: null,
};

async function relaunch({ seedV1 = false, failSpawns = [] } = {}) {
  S.getState().dispose();
  backing.clear();
  if (seedV1) backing.set(PERSIST_KEY, JSON.stringify({ version: 1, data: V1_PAYLOAD }));
  S.setState({ tabs: [], activeTabId: null, isInitialized: false });

  const real = mockBridge.invoke.bind(mockBridge);
  let spawn = 0;
  mockBridge.invoke = async (cmd, args) => {
    if (cmd === 'pty_spawn') {
      spawn += 1;
      if (failSpawns.includes(spawn)) throw new Error('pty_spawn failed (simulated)');
    }
    return real(cmd, args);
  };
  try {
    await S.getState().init();
  } finally {
    mockBridge.invoke = real;
  }
}

describe('The layout still saves while a terminal is streaming', () => {
  afterEach(returnStorage);
  beforeEach(async () => {
    useOwnStorage();
    await relaunch();
    await S.getState().attachListeners();
    await wait(400);
  });

  test('PR-01: a rename lands on disk even while output never stops', async () => {
    const sessionId = S.getState().tabs[0].sessionId;
    S.getState().renameGroup(S.getState().activeGroupId, 'RENAMED-WHILE-STREAMING');

    // Output every 100ms — comfortably faster than the 300ms debounce, which
    // used to reset it forever.
    let streaming = true;
    const pump = (async () => {
      while (streaming) {
        await mockBridge.emit('pty-output', { session_id: sessionId, data: '.' });
        await wait(100);
      }
    })();

    await wait(2600); // past the max-wait ceiling, still mid-stream
    const saved = onDisk();
    streaming = false;
    await pump;

    assert.ok(saved, 'nothing was ever written');
    assert.equal(
      saved.groups.some((g) => g.name === 'RENAMED-WHILE-STREAMING'),
      true,
      'the rename never reached disk while the terminal was producing output'
    );
  });

  test('PR-02: terminal output on its own does not schedule a write', async () => {
    await wait(400);
    const before = backing.get(PERSIST_KEY);
    const sessionId = S.getState().tabs[0].sessionId;
    for (let i = 0; i < 25; i += 1) {
      await mockBridge.emit('pty-output', { session_id: sessionId, data: `line ${i}\r\n` });
    }
    await wait(2600);
    assert.equal(backing.get(PERSIST_KEY), before, 'output alone rewrote the payload');
  });

  test('PR-03: quitting flushes what is still pending', async () => {
    S.getState().renameGroup(S.getState().activeGroupId, 'LAST-SECOND');
    S.getState().dispose(); // immediately, well inside the debounce
    const saved = onDisk();
    assert.equal(
      saved.groups.some((g) => g.name === 'LAST-SECOND'),
      true,
      'the pending save was discarded on dispose instead of flushed'
    );
  });
});

describe('Upgrading from v0.1.1 cannot lose the workspace', () => {
  beforeEach(useOwnStorage);
  afterEach(returnStorage);

  test('PR-04: the pre-upgrade payload is kept aside before anything overwrites it', async () => {
    await relaunch({ seedV1: true });
    await wait(2600);

    const backup = backing.get(PERSIST_BACKUP_KEY);
    assert.ok(backup, 'no backup of the v1 payload was taken');
    const parsed = JSON.parse(backup);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.data.tabs.map((t) => t.title), ['build', 'server', 'logs']);
    assert.equal(JSON.parse(backing.get(PERSIST_KEY)).version, 2, 'the live payload moved to v2');
  });

  test('PR-05: one terminal that will not spawn costs only that terminal', async () => {
    // Both the saved cwd and the workspace-root retry fail for the 2nd tab.
    await relaunch({ seedV1: true, failSpawns: [2, 3] });
    await wait(2600);

    const titles = S.getState().tabs.map((t) => t.title);
    assert.deepEqual(titles, ['build', 'logs'], 'the restore gave up on more than the failed tab');
    assert.equal(S.getState().groups.length, 2, 'both groups survived');
    assert.deepEqual(
      S.getState().groups.map((g) => g.name),
      ['Backend', 'Group 2'],
      'group names survived'
    );
    // and the original is still recoverable
    assert.deepEqual(
      JSON.parse(backing.get(PERSIST_BACKUP_KEY)).data.tabs.map((t) => t.title),
      ['build', 'server', 'logs']
    );
  });

  test('PR-06: teardown — leave the store disposed for the next suite', () => {
    S.getState().dispose();
    assert.ok(true);
  });
});
