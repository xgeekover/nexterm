/**
 * init() comes from App's mount effect, which React StrictMode runs twice in
 * development — the second call arriving while the first is still waiting on
 * the backend. Both stores used to run in full each time:
 *
 *   - terminalStore restored the saved layout twice. A restore spawns a shell
 *     per tab and the second overwrote the first, so every restored tab left a
 *     shell running with nothing on screen to show it. Measured in the dev app
 *     on Windows: one reload, two saved tabs, four new backend sessions.
 *   - editorStore asked for the root and read the tree twice.
 *
 * The explorer also read the tree before anyone had asked for the root, and
 * got the browser mock's '/workspace' refused by the real backend; that is
 * what `rootResolved` is for.
 */

import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { useTerminalStore as S, PERSIST_KEY } from '../../src/stores/terminalStore.js';
import { useEditorStore as E } from '../../src/stores/editorStore.js';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

/** Count the commands the stores send to the backend while `fn` runs. */
async function countingCommands(fn) {
  const original = mockBridge.invoke;
  const counts = {};
  mockBridge.invoke = function (command, ...rest) {
    counts[command] = (counts[command] || 0) + 1;
    return original.call(this, command, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return counts;
}

const resetTerminals = () => S.setState({ tabs: [], activeTabId: null, isInitialized: false });

describe('init() runs once, however many callers arrive at once', () => {
  test('INIT-01: racing terminal init() calls restore the layout once and leave no stray shell', async () => {
    // Two terminals, persisted the way a relaunch finds them.
    S.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
    resetTerminals();
    await S.getState().init();
    await S.getState().createTab();
    assert.equal(S.getState().tabs.length, 2, 'setup: two terminals before the relaunch');
    S.getState().dispose(); // writes the pending layout out

    const before = new Set(mockBridge.ptySessions.keys());
    resetTerminals();
    const counts = await countingCommands(() => Promise.all([S.getState().init(), S.getState().init()]));

    const tabs = S.getState().tabs;
    assert.equal(tabs.length, 2, 'the saved layout came back');
    assert.equal(counts.pty_spawn, 2, `one shell per restored tab, not ${counts.pty_spawn}`);
    const fresh = [...mockBridge.ptySessions.keys()].filter((id) => !before.has(id)).sort();
    assert.deepEqual(fresh, tabs.map((t) => t.sessionId).sort(), 'every new shell belongs to a tab');
  });

  test('INIT-02: a later terminal init() runs again instead of handing back the finished one', async () => {
    resetTerminals();
    const counts = await countingCommands(() => S.getState().init());
    assert.equal(counts.pty_spawn >= 1, true, 'a relaunch after the first run settled must bootstrap again');
    assert.equal(S.getState().isInitialized, true);
  });

  test('INIT-03: racing editor init() calls ask for the root and read the tree once', async () => {
    E.setState({ rootResolved: false });
    const counts = await countingCommands(() => Promise.all([E.getState().init(), E.getState().init()]));
    assert.equal(counts.fs_get_root, 1, `fs_get_root sent ${counts.fs_get_root} times`);
    assert.equal(counts.fs_read_dir, 1, `fs_read_dir sent ${counts.fs_read_dir} times`);
  });

  test('INIT-04: the root is reported as known only once the backend has been asked', async () => {
    E.setState({ rootResolved: false });
    const running = E.getState().init();
    assert.equal(E.getState().rootResolved, false, 'claimed to know the root before the backend answered');
    await running;
    assert.equal(E.getState().rootResolved, true);
  });

  test('INIT-05: teardown — leave the terminal store disposed and nothing persisted', () => {
    S.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
  });
});
