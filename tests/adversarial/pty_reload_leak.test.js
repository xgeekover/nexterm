/**
 * A reloaded page must not leave its terminals running.
 *
 * The webview can be reloaded — ⌘R, or Vite replacing a module it cannot
 * hot-swap — and when it is, this store starts from nothing while the backend
 * keeps its session map. `restoreSavedLayout` then spawns a fresh PTY for
 * every tab, because the saved payload carries a title and a directory and
 * never a session id, so the previous set stayed alive with no tab to show
 * it. Measured on macOS against the real app by touching index.html three
 * times: 1 → 2 → 3 → 4 child shells, with one terminal on screen throughout.
 * It was first seen on Windows as twelve ConPTY hosts for six terminals; the
 * cause is the same on both, and has nothing to do with the OS.
 *
 * A reload is exactly what these cases perform: the store is put back to its
 * pre-init state (which is all a page load does to it) while the backend's
 * session map is deliberately left alone.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';

const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** Borrow the global for one case, then hand it back — see layout_gaps. */
function borrowStorage() {
  const held = globalThis.localStorage;
  globalThis.localStorage = shim;
  return () => {
    globalThis.localStorage = held;
  };
}

// Imported WITHOUT swapping the global first: with top-level await, a module
// that yields mid-evaluation comes back to find another file has replaced
// globalThis.localStorage underneath it, which is how this file first broke
// the terminal-groups suite. The store module is already loaded by then
// anyway, so the import is a cache hit that reads nothing.
const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const liveSessions = () => mockBridge.ptySessions.size;
const leaves = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
};
/** Terminals the user can actually see, across every group. */
const onScreen = () => S.getState().groups.flatMap((g) => leaves(g.tree)).flatMap((l) => l.tabIds).length;

/**
 * What a page load does, and only that: the JS module state goes back to
 * nothing. The backend keeps every session it had, exactly as the Rust
 * process does when the webview navigates.
 */
async function reloadPage() {
  S.getState().dispose();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false });
  await S.getState().init();
  await wait(50);
}

describe('A reloaded page does not leak its terminals', () => {
  let release;

  beforeEach(async () => {
    release = borrowStorage();
    backing.clear();
    // Start from a clean backend so the counts below are absolute.
    await mockBridge.invoke('pty_retain_only', { session_ids: [] });
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
    await S.getState().init();
    await wait(50);
  });

  test('PL-01: reloading three times leaves one shell per visible terminal', async () => {
    assert.equal(onScreen(), 1, 'one terminal to begin with');
    assert.equal(liveSessions(), 1, 'and one shell behind it');

    const counts = [];
    for (let i = 0; i < 3; i++) {
      await reloadPage();
      counts.push({ reload: i + 1, sessions: liveSessions(), terminals: onScreen() });
    }

    // Before the fix this read 2, 3, 4 against a constant 1 terminal.
    for (const c of counts) {
      assert.equal(
        c.sessions,
        c.terminals,
        `after reload ${c.reload}: ${c.sessions} backend session(s) for ${c.terminals} terminal(s) on screen`
      );
    }
    assert.equal(liveSessions(), 1, 'and still just the one');
  });

  test('PL-02: a restored layout of several terminals leaks none of them', async () => {
    // Two panes, two terminals, then reload twice.
    const group = S.getState().groups[0];
    await S.getState().splitPane(leaves(group.tree)[0].id, 'horizontal', group.id);
    await wait(50);
    assert.equal(onScreen(), 2, 'two terminals on screen');
    assert.equal(liveSessions(), 2, 'two shells');

    await S.getState().flushPersist?.();
    await wait(50);

    for (let i = 0; i < 2; i++) {
      await reloadPage();
      assert.equal(
        liveSessions(),
        onScreen(),
        `after reload ${i + 1}: ${liveSessions()} sessions for ${onScreen()} terminals`
      );
    }
    // Four leaked shells is what two reloads used to cost here.
    assert.ok(liveSessions() <= 2, `at most two shells, got ${liveSessions()}`);
  });

  test('PL-03: the reap keeps exactly what it is told to keep', async () => {
    // `retain_only` is the whole mechanism; check it directly rather than
    // only through bootstrap, so a change to its meaning is visible.
    await mockBridge.invoke('pty_retain_only', { session_ids: [] });
    const a = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace' });
    const b = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace' });
    const c = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace' });
    assert.equal(liveSessions(), 3);

    const reaped = await mockBridge.invoke('pty_retain_only', { session_ids: [b.session_id] });
    assert.equal(reaped, 2, 'it reports how many it killed');
    assert.equal(liveSessions(), 1);
    assert.ok(mockBridge.ptySessions.has(b.session_id), 'the named session survives');
    assert.equal(mockBridge.ptySessions.has(a.session_id), false);
    assert.equal(mockBridge.ptySessions.has(c.session_id), false);

    // Keeping something already gone is not an error, and kills nothing else.
    assert.equal(await mockBridge.invoke('pty_retain_only', { session_ids: [b.session_id] }), 0);
    assert.equal(liveSessions(), 1);
  });

  test('PL-04: teardown — leave the store and the backend as the next suite expects', async () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await mockBridge.invoke('pty_retain_only', { session_ids: [] });
    release();
    assert.ok(true);
  });
});
