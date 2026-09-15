/**
 * NexTerm starts with no folder open, as VS Code does, instead of adopting the
 * directory it was launched from (src-tauri in development, the program folder
 * once installed). The backend then answers `fs_get_root` with null; the
 * browser mock keeps its '/workspace', so these cases put a null root in front
 * of the mock.
 */

import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { useEditorStore as E } from '../../src/stores/editorStore.js';
import { useTerminalStore as S, PERSIST_KEY } from '../../src/stores/terminalStore.js';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

const HOME = 'C:\\Users\\me';

/**
 * Run `fn` against a backend with no folder open. It reports where it started
 * a shell, as the real one does, and every command sent is recorded.
 */
async function withNoFolder(fn) {
  const original = mockBridge.invoke;
  const calls = [];
  mockBridge.invoke = async function (command, args, ...rest) {
    calls.push({ command, args });
    if (command === 'fs_get_root') return null;
    const result = await original.call(this, command, args, ...rest);
    return command === 'pty_spawn' && args?.cwd == null ? { ...result, cwd: HOME } : result;
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

describe('Starting with no folder open', () => {
  test('NF-01: the explorer has no folder and reads no directory', async () => {
    E.setState({ rootResolved: false, fileTree: [{ name: 'stale' }] });
    const calls = await withNoFolder(() => E.getState().init());
    const st = E.getState();
    assert.equal(st.rootPath, null);
    assert.equal(st.rootResolved, true, 'the backend was asked, so the empty state can show');
    assert.deepEqual(st.fileTree, []);
    assert.equal(calls.filter((c) => c.command === 'fs_read_dir').length, 0, 'read a directory with no folder open');
  });

  test('NF-02: refreshing with no folder open asks the backend for nothing', async () => {
    const calls = await withNoFolder(() => E.getState().refreshExplorer());
    assert.deepEqual(calls, []);
    assert.equal(E.getState().isLoadingTree, false);
  });

  test('NF-03: a terminal starts wherever the backend chose, not in an invented /workspace', async () => {
    S.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    const calls = await withNoFolder(() => S.getState().init());
    const spawns = calls.filter((c) => c.command === 'pty_spawn');
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].args.cwd, null, `asked for ${JSON.stringify(spawns[0].args.cwd)}`);
    assert.equal(S.getState().tabs[0].cwd, HOME);
  });

  test('NF-04: teardown — the explorer and the terminals are back on the mock workspace', async () => {
    S.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
    E.setState({ rootPath: '/workspace', expandedFolders: new Set(['/workspace']), rootResolved: true });
    await E.getState().refreshExplorer();
    assert.equal(E.getState().fileTree.length > 0, true);
  });
});
