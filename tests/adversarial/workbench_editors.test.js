/**
 * Files on the workbench (editor placement, sibling B, step B3): editorStore
 * keeps the tabs, terminalStore keeps where they are.
 *
 *   AC-B3  Explorer placement (FB4): a file open in another group is revealed
 *          there; a new one goes to the editor pane of the group on screen,
 *          or a new editor leaf wrapped above its terminals at [60, 40].
 *   AC-B7  Unsaved prompts (FB7): closing an editor leaf, closing a group,
 *          a folder switch, window close and Quit each ask with every dirty
 *          file of what closes; Cancel changes nothing, no PTY is killed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore, registerEditorBridge } from '../../src/stores/editorStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import { leafKind, leavesOfKind, tabIdsOfKind } from '../../src/components/terminal/splitLayout.js';

const E = useEditorStore;
const T = useTerminalStore;
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// --- storage, IPC recording ---------------------------------------------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
let installed = false;
const calls = [];
let failWrites = false;

function installStorage() {
  if (!installed) {
    hadStorage = 'localStorage' in globalThis;
    previousStorage = globalThis.localStorage;
    installed = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function recordIpc() {
  calls.length = 0;
  const real = Object.getPrototypeOf(mockBridge).invoke;
  mockBridge.invoke = function recording(command, args, ...rest) {
    calls.push({ command, args });
    if (failWrites && command === 'fs_write_file') return Promise.reject(new Error('Permission denied (os error 13)'));
    return real.call(mockBridge, command, args, ...rest);
  };
}

async function setUp() {
  T.getState().dispose();
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  failWrites = false;
  recordIpc();
  registerEditorBridge();
  E.setState({ tabs: [], activeTabId: null, pendingClose: null, pendingOverwrite: null, openFailure: null, rootPath: '/workspace' });
  T.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    groups: [{ id: 'group-1', name: 'Group 1', createdAt: 1, tree: { type: 'leaf', id: 'pane-1', tabIds: [], activeTabId: null }, activePaneId: 'pane-1' }],
    activeGroupId: 'group-1',
  });
  await T.getState().init();
  calls.length = 0;
}

function teardown() {
  delete mockBridge.invoke;
  E.setState({ tabs: [], activeTabId: null, pendingClose: null });
  T.getState().dispose();
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

let counter = 0;
async function file(name = 'f', content = 'on disk') {
  counter += 1;
  const path = `/workspace/_wb_${name}_${Date.now()}_${counter}.txt`;
  await invoke('fs_write_file', { path, content });
  calls.length = 0;
  return path;
}

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const active = () => T.getState().getActiveGroup();
const groupById = (id) => T.getState().groups.find((g) => g.id === id);
const holderOf = (tabId) => {
  for (const g of T.getState().groups) {
    const leaf = leavesOfKind(g.tree, 'editor').find((l) => l.tabIds.includes(tabId));
    if (leaf) return { group: g, leaf };
  }
  return null;
};
const kills = () => calls.filter((c) => c.command === 'pty_kill').length;
const snapshot = () => JSON.stringify({ groups: T.getState().groups, tabs: E.getState().tabs.map((t) => t.id) });

describe('Workbench editors: where a file opens (AC-B3)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('WE-01: with no editor leaf, the root is wrapped [editor 60 | terminals 40], editor first', async () => {
    const before = active().tree;
    const tab = await E.getState().openFile(await file('a'));
    const g = active();
    assert.equal(g.tree.type, 'split');
    assert.equal(g.tree.direction, 'vertical');
    assert.deepEqual(g.tree.sizes, [60, 40]);
    assert.equal(leafKind(g.tree.children[0]), 'editor');
    assert.deepEqual(g.tree.children[0].tabIds, [tab.id]);
    assert.equal(g.tree.children[1], before, 'the terminals as they were, same object');
    assert.equal(g.editorPaneId, g.tree.children[0].id);
    assert.equal(E.getState().activeTabId, tab.id);
  });

  test('WE-02: a new file opens in the editor pane of the group on screen', async () => {
    const a = await E.getState().openFile(await file('a'));
    const first = holderOf(a.id).leaf.id;
    const second = E.getState().splitEditorPane(first, 'horizontal');
    assert.equal(active().editorPaneId, second);
    const b = await E.getState().openFile(await file('b'));
    assert.equal(holderOf(b.id).leaf.id, second, 'into the editor pane, the new split');
    E.getState().setActiveEditorPane(first);
    const c = await E.getState().openFile(await file('c'));
    assert.equal(holderOf(c.id).leaf.id, first);
    assert.equal(E.getState().activeTabId, c.id);
  });

  test('WE-03: a file open in group 2, opened from group 1, switches to group 2 and makes no second tab', async () => {
    const one = active().id;
    const two = await T.getState().createGroup({ name: 'Two' });
    const path = await file('shared');
    const tab = await E.getState().openFile(path);
    const other = await E.getState().openFile(await file('other'));
    assert.equal(holderOf(tab.id).group.id, two.id);
    T.getState().setActiveGroup(one);
    assert.equal(E.getState().activeTabId, null, 'group 1 shows no file: nothing to save');
    const again = await E.getState().openFile(path);
    assert.equal(again.id, tab.id);
    assert.equal(E.getState().tabs.length, 2, 'no second tab');
    assert.equal(T.getState().activeGroupId, two.id, 'its group comes on screen');
    assert.equal(groupById(two.id).editorPaneId, holderOf(tab.id).leaf.id);
    assert.equal(holderOf(tab.id).leaf.activeTabId, tab.id, 'and shows it');
    assert.equal(E.getState().activeTabId, tab.id);
    assert.ok(other);
  });

  test('WE-04: openFileAt (terminal links, Go to File) follows the same rule; the palette and search results go through openFile/openFileAt', async () => {
    const two = await T.getState().createGroup({ name: 'Two' });
    const path = await file('at', 'one\ntwo\nthree');
    const tab = await E.getState().openFileAt(path, 2, 1);
    assert.equal(holderOf(tab.id).group.id, two.id);
    T.getState().setActiveGroup(T.getState().groups[0].id);
    const again = await E.getState().openFileAt(path, 3);
    assert.equal(again.id, tab.id);
    assert.equal(T.getState().activeGroupId, two.id);
    assert.equal(E.getState().pendingReveal?.line, 3);
    assert.match(read('../../src/components/command/CommandPalette.jsx'), /openFile(At)?\(/);
    assert.match(read('../../src/components/search/SearchPanel.jsx'), /openFile(At)?\(/);
  });

  test('WE-05: two concurrent opens of one file make one tab, in one leaf', async () => {
    const path = await file('race');
    const [x, y] = await Promise.all([E.getState().openFile(path), E.getState().openFile(path)]);
    assert.equal(x.id, y.id);
    assert.equal(E.getState().tabs.length, 1);
    assert.deepEqual(tabIdsOfKind(active().tree, 'editor'), [x.id]);
  });

  test('WE-06: the active file follows group switches; closing the last file of a group removes its editor leaf', async () => {
    const one = active().id;
    const a = await E.getState().openFile(await file('a'));
    const two = await T.getState().createGroup({ name: 'Two' });
    const b = await E.getState().openFile(await file('b'));
    assert.equal(E.getState().activeTabId, b.id);
    T.getState().setActiveGroup(one);
    assert.equal(E.getState().activeTabId, a.id);
    E.getState().closeTab(a.id);
    assert.equal(leavesOfKind(groupById(one).tree, 'editor').length, 0, 'the emptied leaf is pruned: the editor area hides');
    assert.equal(E.getState().activeTabId, null);
    assert.ok(groupById(two.id));
  });
});

describe('Workbench editors: unsaved prompts (AC-B7)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  async function dirty(name) {
    const tab = await E.getState().openFile(await file(name));
    E.getState().editBuffer(tab.id, `edited ${name}`);
    return tab;
  }

  test('WE-07: closing an editor leaf asks about its dirty files; Cancel, then Save, then a failed save', async () => {
    const a = await dirty('a');
    const pane = holderOf(a.id).leaf.id;
    const before = snapshot();
    E.getState().requestCloseEditorPane(pane);
    assert.equal(E.getState().pendingClose?.kind, 'pane');
    assert.deepEqual(E.getState().pendingClose.tabIds, [a.id]);
    E.getState().cancelPendingClose();
    assert.equal(snapshot(), before, 'Cancel: the tree and the tabs as they were');
    E.getState().requestCloseEditorPane(pane);
    failWrites = true;
    await E.getState().savePendingClose().catch(() => {});
    assert.equal(snapshot(), before, 'a failed save closes nothing');
    assert.ok(E.getState().pendingClose, 'and the prompt stays');
    failWrites = false;
    await E.getState().savePendingClose();
    assert.equal(E.getState().tabs.length, 0, 'Save: saved, then closed');
    assert.equal(calls.filter((c) => c.command === 'fs_write_file').length >= 1, true);
    assert.equal(leavesOfKind(active().tree, 'editor').length, 0);
  });

  test("WE-08: closing a group with dirty files asks (kind 'group') with every one of them; Cancel kills nothing", async () => {
    const one = active().id;
    const two = await T.getState().createGroup({ name: 'Two' });
    const a = await dirty('a');
    const b = await dirty('b');
    const clean = await E.getState().openFile(await file('clean'));
    T.getState().setActiveGroup(one);
    const kept = await dirty('kept');
    calls.length = 0;
    const before = snapshot();
    const closing = T.getState().closeGroup(two.id);
    await new Promise((r) => setTimeout(r, 0));
    const pending = E.getState().pendingClose;
    assert.equal(pending?.kind, 'group');
    assert.deepEqual([...pending.tabIds].sort(), [a.id, b.id].sort(), 'every dirty file of the group, and no other');
    E.getState().cancelPendingClose();
    assert.equal(await closing, false);
    assert.equal(snapshot(), before);
    assert.equal(kills(), 0, 'no pty_kill');

    // Don't Save: the group goes, its files close, its terminal is killed.
    const again = T.getState().closeGroup(two.id);
    await new Promise((r) => setTimeout(r, 0));
    await E.getState().discardPendingClose();
    assert.equal(await again, true);
    assert.equal(groupById(two.id), undefined);
    assert.deepEqual(E.getState().tabs.map((t) => t.id), [kept.id], 'its files closed, the other group\'s kept');
    assert.equal(kills(), 1);
    assert.ok(clean);
  });

  test('WE-09: Save on a group close saves, then closes; a failed save closes nothing; a group with no dirty file asks nothing', async () => {
    const two = await T.getState().createGroup({ name: 'Two' });
    const a = await dirty('a');
    failWrites = true;
    const closing = T.getState().closeGroup(two.id);
    await new Promise((r) => setTimeout(r, 0));
    await E.getState().savePendingClose().catch(() => {});
    assert.ok(groupById(two.id), 'a failed save: nothing closed');
    assert.ok(E.getState().tabs.some((t) => t.id === a.id));
    failWrites = false;
    await E.getState().savePendingClose();
    assert.equal(await closing, true);
    assert.equal(groupById(two.id), undefined);
    assert.equal(E.getState().tabs.length, 0);

    const three = await T.getState().createGroup({ name: 'Three' });
    await E.getState().openFile(await file('clean'));
    assert.equal(await T.getState().closeGroup(three.id), true);
    assert.equal(E.getState().pendingClose, null, 'nothing was asked');
  });

  test('WE-10: a folder switch, window close and Quit list every dirty file of every group', async () => {
    const a = await dirty('a');
    await T.getState().createGroup({ name: 'Two' });
    const b = await dirty('b');
    for (const kind of ['root', 'window', 'quit']) {
      const before = snapshot();
      let went = false;
      const asked = E.getState().askBeforeLeaving(kind, () => {
        went = true;
      });
      assert.ok(asked, `${kind}: asked`);
      assert.equal(E.getState().pendingClose.kind, kind);
      assert.deepEqual([...E.getState().pendingClose.tabIds].sort(), [a.id, b.id].sort());
      E.getState().cancelPendingClose();
      assert.equal(await asked, null);
      assert.equal(went, false);
      assert.equal(snapshot(), before, `${kind}: Cancel changes nothing`);
    }
    assert.equal(kills(), 0);
  });
});
