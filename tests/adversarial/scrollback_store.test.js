/**
 * Which terminals restore their saved output, and which files go (stage 6,
 * spec D4, D7, D9) — the store's side, through the real store and the
 * browser mock's scrollback (which keeps its files in the page's storage).
 *
 *   - the start restores exactly the tabs its layout brought back, and every
 *     other file is deleted; a fresh start keeps none; with the setting off
 *     every file is deleted and nothing restored
 *   - a template, a saved group or workspace, a new tab and a split never
 *     restore
 *   - every way a terminal closes for good deletes its file
 *   - nothing about scrollback goes into the layout the store persists
 *   - turning the setting off deletes every file
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SNAPSHOT_MAGIC } from '../../src/lib/scrollbackSnapshot.js';
import { restorePending, resetScrollbackSession, scrollbackSaver } from '../../src/lib/scrollbackSession.js';
import { UNTRUSTED_KEY } from '../../src/lib/scrollbackSaver.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';

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

// Imported WITHOUT swapping the global first — see pty_reload_leak.
const { useTerminalStore: S, PERSIST_KEY } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leaves = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((child) => leaves(child, acc));
  return acc;
};

/** The files the mock holds, by tab id. */
const files = () => Object.keys(mockBridge.scrollbackLoad().store).sort();

/** Every scrollback call queued so far, done. */
const saved = () => scrollbackSaver.flushAll({ timeoutMs: 1000 });

function fileFor(tabId) {
  return `${SNAPSHOT_MAGIC}\n${JSON.stringify({ tabId, savedAt: Date.now() - 1000, cols: 80, lines: 1, hidden: 0 })}\nsaved by ${tabId}`;
}

async function writeFile(tabId) {
  await mockBridge.invoke('scrollback_write', { tab_id: tabId, content: fileFor(tabId) });
}

/** A page load, and only that: the store from nothing, the backend and its files as they were. */
async function reloadPage() {
  S.getState().dispose();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false });
  await S.getState().init();
  await saved();
  await wait(10);
}

/** A first start: no layout, no files, no shells. */
async function freshApp() {
  S.getState().dispose();
  backing.clear();
  resetScrollbackSession();
  await mockBridge.invoke('pty_retain_only', { session_ids: [] });
  await mockBridge.invoke('scrollback_clear', {});
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
  await S.getState().init();
  await saved();
  await wait(10);
}

/** Two groups, three terminals — then a restart, with a file for each terminal and one for a tab long gone. */
async function restartWithFiles() {
  await freshApp();
  const group = S.getState().groups[0];
  await S.getState().splitPane(leaves(group.tree)[0].id, 'horizontal', group.id);
  await S.getState().createGroup({ name: 'second' });
  await saved();
  const ids = S.getState().tabs.map((t) => t.id);
  assert.equal(ids.length, 3, 'three terminals to begin with');
  // The layout is written out when the page goes, as `dispose` does.
  for (const id of ids) await writeFile(id);
  await writeFile('tab-term-99');
  await reloadPage();
  return ids;
}

describe('Scrollback and the store: what the start restores', () => {
  let release = () => {};
  const setting = () => useSettingsStore.getState().terminalRestoreScrollback;
  beforeEach(() => {
    release = borrowStorage();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', true);
  });
  afterEach(() => {
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', true);
    release();
  });

  test('SS-01: the tabs the layout brought back are restored, and only their files kept', async () => {
    const ids = await restartWithFiles();
    assert.deepEqual(S.getState().tabs.map((t) => t.id).sort(), [...ids].sort(), 'the layout did not come back with its ids');
    for (const id of ids) assert.equal(restorePending(id), true, `${id} is not restored`);
    assert.deepEqual(files(), [...ids].sort(), 'a file of a tab that is gone was kept, or a restored tab lost its file');
  });

  test('SS-02: a fresh start restores nothing and keeps no file', async () => {
    await freshApp();
    await writeFile('tab-term-1');
    await writeFile('tab-term-5');
    S.getState().dispose();
    backing.delete(PERSIST_KEY);
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await S.getState().init();
    await saved();
    const [tab] = S.getState().tabs;
    assert.equal(restorePending(tab.id), false, 'a new terminal took the old output of a tab that had its id');
    assert.deepEqual(files(), []);
  });

  test('SS-03: with Restore Scrollback off, the start deletes every file and restores nothing', async () => {
    const ids = await restartWithFiles();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', false);
    await saved();
    for (const id of ids) await writeFile(id);
    await reloadPage();
    assert.equal(setting(), false);
    for (const id of S.getState().tabs.map((t) => t.id)) assert.equal(restorePending(id), false, `${id} restored with the setting off`);
    assert.deepEqual(files(), [], 'files kept with the setting off');
  });

  test('SS-04: turning the setting off deletes every file and leaves nothing to restore', async () => {
    const ids = await restartWithFiles();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', false);
    await saved();
    assert.deepEqual(files(), []);
    for (const id of ids) assert.equal(restorePending(id), false, `${id} would still be restored`);
  });

  test('SS-05: a tab whose id a terminal made meanwhile already held is not restored — nor is that terminal', async () => {
    await restartWithFiles();
    const [first] = S.getState().tabs;
    for (const id of S.getState().tabs.map((t) => t.id)) await writeFile(id);
    // A terminal in the store before the start began, holding a restored id.
    S.getState().dispose();
    const session = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: '/workspace', shell: 'default' });
    S.setState({
      tabs: [{ id: first.id, title: 'made meanwhile', defaultTitle: 'Terminal 9', sessionId: session.session_id, cwd: '/workspace' }],
      activeTabId: first.id,
      isInitialized: false,
    });
    await S.getState().init();
    await saved();
    const kept = S.getState().tabs.find((t) => t.title === 'made meanwhile');
    assert.equal(kept?.id, first.id, 'the terminal made meanwhile lost its id');
    assert.equal(restorePending(first.id), false, 'a terminal made meanwhile took another tab\'s saved output');
    const renamed = S.getState().tabs.filter((t) => t !== kept && !restorePending(t.id));
    assert.equal(renamed.length, 1, 'the restored tab that took a new id is restored under it');
    assert.equal(files().includes(first.id), false, 'the file of an id now held by another terminal was kept');
  });
});

describe('Scrollback and the store: files noted as stale (review round 5)', () => {
  let release = () => {};
  beforeEach(() => {
    release = borrowStorage();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', true);
  });
  afterEach(() => {
    backing.delete(UNTRUSTED_KEY);
    release();
  });

  test('SS-11: a start that finds the note restores nothing, deletes every file, and takes the note away once that succeeded', async () => {
    await freshApp();
    const group = S.getState().groups[0];
    await S.getState().splitPane(leaves(group.tree)[0].id, 'horizontal', group.id);
    await saved();
    const ids = S.getState().tabs.map((t) => t.id);
    for (const id of ids) await writeFile(id);
    // The last session's breaker opened: a clear may never have reached these.
    backing.set(UNTRUSTED_KEY, String(Date.now() - 60_000));
    await reloadPage();
    assert.deepEqual(S.getState().tabs.map((t) => t.id).sort(), [...ids].sort(), 'the layout itself did not come back');
    for (const id of ids) assert.equal(restorePending(id), false, `${id} restored from files that may hold what was cleared`);
    assert.deepEqual(files(), [], 'the stale files were kept');
    assert.equal(backing.has(UNTRUSTED_KEY), false, 'the note outlived the clear that answered it');
  });

  test('SS-12: a clear that fails at the start keeps the note — the next start tries again', async () => {
    await freshApp();
    await writeFile(S.getState().tabs[0].id);
    backing.set(UNTRUSTED_KEY, '1');
    const real = mockBridge.invoke.bind(mockBridge);
    mockBridge.invoke = (command, args) => (command === 'scrollback_clear' ? Promise.reject(new Error('Access is denied')) : real(command, args));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await reloadPage();
    } finally {
      mockBridge.invoke = real;
      console.warn = warn;
    }
    assert.equal(restorePending(S.getState().tabs[0].id), false);
    assert.equal(backing.has(UNTRUSTED_KEY), true, 'the note went though nothing was deleted');
  });
});

describe('Scrollback and the store: nothing else restores, every close deletes', () => {
  let release = () => {};
  beforeEach(async () => {
    release = borrowStorage();
    useSettingsStore.getState().setSetting('terminalRestoreScrollback', true);
    await restartWithFiles();
  });
  afterEach(() => release());

  test('SS-06: a new tab, a split, a saved group and a saved workspace never restore', async () => {
    const before = new Set(S.getState().tabs.map((t) => t.id));
    const group = S.getState().groups[0];
    const pane = leaves(group.tree)[0];
    await S.getState().createTab({ paneId: pane.id, groupId: group.id });
    await S.getState().splitPane(pane.id, 'vertical', group.id);
    const savedGroup = S.getState().saveGroup(group.id, 'template');
    await S.getState().loadSavedGroup(savedGroup.id);
    const workspace = S.getState().saveWorkspace('desk');
    await S.getState().loadWorkspace(workspace.id, { mode: 'add' });
    const made = S.getState().tabs.filter((t) => !before.has(t.id));
    assert.ok(made.length >= 4, `only ${made.length} terminals were made`);
    for (const tab of made) assert.equal(restorePending(tab.id), false, `${tab.id} (${tab.title}) would restore`);
  });

  test('SS-07: replacing the workspace deletes the files of the terminals it replaced, and restores none of the new', async () => {
    const replaced = S.getState().tabs.map((t) => t.id);
    const workspace = S.getState().saveWorkspace('desk');
    await S.getState().loadWorkspace(workspace.id, { mode: 'replace' });
    await saved();
    for (const id of replaced) assert.equal(files().includes(id), false, `${id}: its file outlived it`);
    for (const id of replaced) assert.equal(restorePending(id), false);
    for (const tab of S.getState().tabs) assert.equal(restorePending(tab.id), false, `${tab.id} from a saved workspace would restore`);
  });

  test('SS-08: closing a tab, a pane and a group deletes their files and drops them from the restore', async () => {
    const [a, b, c] = S.getState().tabs.map((t) => t.id);
    await S.getState().closeTab(a);
    await saved();
    assert.equal(files().includes(a), false, 'closeTab left its file');
    assert.equal(restorePending(a), false);

    const group = S.getState().groups.find((g) => leaves(g.tree).some((l) => l.tabIds.includes(b)));
    const pane = leaves(group.tree).find((l) => l.tabIds.includes(b));
    await S.getState().closePane(pane.id, group.id);
    await saved();
    assert.equal(files().includes(b), false, 'closePane left its file');

    const other = S.getState().groups.find((g) => leaves(g.tree).some((l) => l.tabIds.includes(c)));
    await S.getState().closeGroup(other.id);
    await saved();
    assert.equal(files().includes(c), false, 'closeGroup left its file');
    assert.equal(restorePending(c), false);
  });

  test('SS-09: the persisted layout holds nothing about scrollback', async () => {
    S.getState().dispose();
    const raw = backing.get(PERSIST_KEY);
    assert.ok(raw, 'no layout was persisted, so nothing was checked');
    assert.equal(/scrollback|previous output|saved by/i.test(raw), false, `scrollback in the layout: ${raw.slice(0, 200)}`);
    const { data } = JSON.parse(raw);
    for (const tab of data.tabs) assert.deepEqual(Object.keys(tab).sort(), ['agent', 'cwd', 'id', 'title']);
    await S.getState().init();
  });

  test('SS-10: teardown — the store disposed, no files, nothing to restore', async () => {
    S.getState().dispose();
    await mockBridge.invoke('scrollback_clear', {});
    resetScrollbackSession();
    backing.clear();
    assert.deepEqual(files(), []);
  });
});
