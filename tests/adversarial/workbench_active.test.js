/**
 * One active pane of either kind (editor placement, sibling C, FC1; AC-C1).
 *
 * A group keeps B's two fields — `activePaneId`, its last active TERMINAL
 * leaf, and `editorPaneId`, its last active editor leaf — and gains an
 * optional `activeKind: 'editor'` saying the editor one is THE active pane.
 * `activePaneOf(group)` reads it. These cases check that every way of
 * moving the focus sets it, that `settle` drops it when the group has no
 * editor leaf, that `activePaneId` never names an editor leaf, and that it
 * survives a relaunch through localStorage — and that a payload with a
 * value this build never writes restores as terminal-active.
 *
 * terminalStore never imports editorStore: the editor tab ids come from a
 * fake bridge (`setEditorBridge`), as in workbench_layout.test.js.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useTerminalStore,
  setEditorBridge,
  activePaneOf,
  activeKindOf,
  zoomedPaneOf,
  PERSIST_KEY,
  __settleLayout,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { leafKind } from '../../src/components/terminal/splitLayout.js';
import { createControlDispatcher } from '../../src/lib/controlDispatcher.js';

const S = useTerminalStore;

// --- localStorage shim and a fake editor bridge -----------------------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
let installed = false;
const editorIds = new Set();

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

function installBridge() {
  editorIds.clear();
  setEditorBridge({
    tabIds: () => editorIds,
    closeTabs: (ids) => {
      for (const id of ids) editorIds.delete(id);
    },
    // A long deadline: restored editor leaves stay waiting for the whole case.
    restoreDeadlineMs: 15000,
  });
}

async function freshStart() {
  S.getState().dispose();
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
  installBridge();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], renameRequest: null, notifications: [], progress: {} });
  await S.getState().init();
}

/** A relaunch: the store thrown away and `init` run against what is on disk. */
async function relaunch() {
  S.getState().dispose();
  editorIds.clear();
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    groups: [{ id: 'group-1', name: 'Group 1', createdAt: 1, tree: { type: 'leaf', id: 'pane-1', tabIds: [], activeTabId: null }, activePaneId: 'pane-1' }],
    activeGroupId: 'group-1',
  });
  await S.getState().init();
}

function teardown() {
  S.getState().dispose();
  setEditorBridge(null);
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groupById = (id) => S.getState().groups.find((g) => g.id === id);
const activeGroup = () => S.getState().getActiveGroup();

/**
 * The invariants of FC1, checked after every step: `activePaneId` names a
 * terminal leaf of its group, `activeKind` is 'editor' or absent, and
 * 'editor' only beside an `editorPaneId` that names an editor leaf.
 */
function assertInvariants(where) {
  for (const g of S.getState().groups) {
    const leaves = leavesOf(g.tree);
    const terminal = leaves.find((l) => l.id === g.activePaneId);
    assert.ok(terminal && leafKind(terminal) === 'terminal', `${where}: activePaneId of ${g.id} is a terminal leaf (${g.activePaneId})`);
    if ('activeKind' in g) {
      assert.equal(g.activeKind, 'editor', `${where}: activeKind is 'editor' or absent`);
      const editor = leaves.find((l) => l.id === g.editorPaneId);
      assert.ok(editor && leafKind(editor) === 'editor', `${where}: an editor-active group names an editor leaf`);
    }
  }
}

describe('One active pane of either kind (AC-C1)', () => {
  beforeEach(freshStart);
  afterEach(teardown);

  test('WA-01: a click (setActivePane) and a focus (setEditorPane, switchTab) move the one active pane across kinds; activePaneId stays the terminal leaf', () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    const termTab = S.getState().activeTabId;
    assert.equal(activePaneOf(g), termPane, 'a fresh group is terminal-active');
    assert.equal('activeKind' in g, false);
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'opening a file makes its pane the active one');

    S.getState().setActivePane(termPane);
    let group = groupById(g.id);
    assert.equal(activePaneOf(group), termPane, 'a click on the terminal');
    assert.equal('activeKind' in group, false, 'terminal-active: the field goes, rather than staying behind');
    assert.equal(activeKindOf(group), 'terminal');
    assertInvariants('after a terminal click');

    S.getState().setActivePane(edPane);
    group = groupById(g.id);
    assert.equal(activePaneOf(group), edPane, 'a click on the editor pane');
    assert.equal(group.activeKind, 'editor');
    assert.equal(group.activePaneId, termPane, 'activePaneId keeps naming the terminal leaf');
    assert.equal(S.getState().activeTabId, termTab, 'the terminal active tab is left alone');
    assertInvariants('after an editor click');
    const before = S.getState().groups;
    S.getState().setActivePane(edPane);
    assert.equal(S.getState().groups, before, 'clicking the active pane again changes no state');

    S.getState().switchTab(termTab);
    assert.equal(activePaneOf(groupById(g.id)), termPane, 'switching to a terminal (the TERMINALS panel) makes its pane active');
    S.getState().setEditorPane(edPane);
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'a focus inside the editor pane (setEditorPane)');
    S.getState().setEditorPane(termPane);
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'setEditorPane on a terminal leaf does nothing');
    assertInvariants('after focus');
  });

  test('WA-02: drops make the dropped tab\u{2019}s new pane active, of its own kind, both ways', async () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    const t1 = S.getState().activeTabId;
    await S.getState().createTab();
    const t2 = S.getState().activeTabId;
    editorIds.add('e1');
    editorIds.add('e2');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    S.getState().placeEditorTab('e2');

    // A file dropped on the terminal's right edge: a new editor leaf there, active.
    S.getState().dropTabOnPane('e2', termPane, 'right', g.id);
    let group = groupById(g.id);
    const newEditor = leavesOf(group.tree).find((l) => l.tabIds.includes('e2'));
    assert.equal(leafKind(newEditor), 'editor');
    assert.notEqual(newEditor.id, edPane);
    assert.equal(activePaneOf(group), newEditor.id, 'the editor leaf the drop made is the active pane');
    assertInvariants('after an editor edge drop');

    // A terminal dropped on the editor's bottom edge: a new terminal leaf, active.
    S.getState().dropTabOnPane(t2, edPane, 'bottom', g.id);
    group = groupById(g.id);
    const newTerminal = leavesOf(group.tree).find((l) => l.tabIds.includes(t2));
    assert.equal(leafKind(newTerminal), 'terminal');
    assert.equal(activePaneOf(group), newTerminal.id, 'the terminal leaf the drop made is the active pane');
    assert.equal('activeKind' in group, false);
    assert.equal(S.getState().activeTabId, t2);
    assertInvariants('after a terminal edge drop');

    // A strip reorder of a file makes its leaf active again.
    S.getState().moveTabInStrip('e1', edPane, 0, g.id);
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'a file moved in its strip: its leaf is the active pane');
    // And a terminal strip drop hands it back to the terminal.
    S.getState().moveTabInStrip(t1, termPane, 0, g.id);
    assert.equal(activePaneOf(groupById(g.id)), termPane);
    // The centre of a pane of the other kind: nothing at all.
    const snap = JSON.stringify(S.getState().groups);
    S.getState().dropTabOnPane('e1', termPane, 'center', g.id);
    assert.equal(JSON.stringify(S.getState().groups), snap, 'a file on a terminal centre changes nothing');
    assertInvariants('after strip moves');
  });

  test('WA-03: opens — placeEditorTab and revealEditorTab — make the file\u{2019}s pane active, in its group; `activate: false` does not', async () => {
    const g1 = activeGroup();
    const term1 = g1.activePaneId;
    editorIds.add('e1');
    editorIds.add('e2');
    const placed = S.getState().placeEditorTab('e1');
    S.getState().setActivePane(term1);
    const g2 = await S.getState().createGroup({ name: 'Two' });
    assert.equal(S.getState().activeGroupId, g2.id);
    const shown = S.getState().revealEditorTab('e1');
    assert.equal(shown.groupId, g1.id);
    assert.equal(S.getState().activeGroupId, g1.id, 'its group comes on screen');
    assert.equal(activePaneOf(groupById(g1.id)), placed.paneId, 'and the pane showing it becomes the active one');
    S.getState().setActivePane(term1);
    S.getState().revealEditorTab('e1');
    assert.equal(activePaneOf(groupById(g1.id)), placed.paneId, 'reveal in the group on screen, from the terminal');

    S.getState().placeEditorTab('e2', { groupId: g2.id, activate: false });
    const two = groupById(g2.id);
    assert.equal('activeKind' in two, false, 'a placement that asks for no activation leaves the group terminal-active');
    assert.ok(two.editorPaneId, 'though the leaf is its editor pane, where the next file lands');
    assertInvariants('after opens');
  });

  test('WA-04: zoom zooms the one active pane of either kind and makes the zoomed pane active; unzoom keeps it', () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    assert.equal(S.getState().togglePaneZoom(), true, 'the keyboard zooms THE active pane: the editor one');
    let group = groupById(g.id);
    assert.equal(zoomedPaneOf(group)?.id, edPane);
    assert.equal(activePaneOf(group), edPane);
    assert.equal(S.getState().togglePaneZoom(), false, 'and unzooms');
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'the active pane stays');

    assert.equal(S.getState().togglePaneZoom(termPane, g.id), true, 'a pane\u{2019}s own button zooms the terminal');
    group = groupById(g.id);
    assert.equal(zoomedPaneOf(group)?.id, termPane);
    assert.equal(activePaneOf(group), termPane, 'zooming the terminal makes it the active pane');
    assert.equal('activeKind' in group, false);
    // Focus moved to the hidden editor pane ends the zoom (`settle`).
    S.getState().setActivePane(edPane);
    group = groupById(g.id);
    assert.equal(zoomedPaneOf(group), null, 'going to a hidden pane of the other kind unzooms');
    assert.equal(activePaneOf(group), edPane);
    assertInvariants('after zoom');
  });

  test('WA-05: focus cycling (focusNextPane) runs over both kinds in DOM order from the one active pane', async () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    const term2 = await S.getState().splitPane(termPane, 'horizontal', g.id);
    const order = leavesOf(groupById(g.id).tree).map((l) => l.id);
    assert.deepEqual(order, [edPane, termPane, term2], 'editor above, two terminals below');
    S.getState().setActivePane(edPane);
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      S.getState().focusNextPane(1);
      seen.push(activePaneOf(groupById(g.id)));
      assertInvariants(`after next ${i}`);
    }
    assert.deepEqual(seen, [termPane, term2, edPane, termPane], 'forward, wrapping, through the editor leaf');
    S.getState().focusNextPane(-1);
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'backward lands on the editor leaf');
    assert.equal(groupById(g.id).activeKind, 'editor');
    assert.equal(groupById(g.id).activePaneId, termPane, 'and the terminal active pane is the one last left');
  });

  test('WA-06: control `focus` moves no pane: an editor-active group stays editor-active, a terminal-active one terminal-active', async () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    const caller = S.getState().tabs[0];
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    const replies = [];
    const dispatcher = createControlDispatcher({ reply: async (m) => replies.push(m), readTerminal: async () => null });
    await dispatcher.handle({ id: 1, session_id: caller.sessionId, cmd: 'focus', args: {} });
    assert.equal(replies[0]?.ok, true, JSON.stringify(replies[0]?.error));
    assert.deepEqual(replies[0].result, { switched: false }, 'a program asks for attention; it never moves the focus (spec Q4)');
    assert.equal(activePaneOf(groupById(g.id)), edPane, 'the editor pane stays THE active pane');
    S.getState().setActivePane(termPane);
    await wait(0);
    assertInvariants('after control focus');
    assert.equal(activePaneOf(groupById(g.id)), termPane);
  });
});

describe('activeKind repaired by settle (AC-C1)', () => {
  beforeEach(() => {
    installStorage();
    installBridge();
  });
  afterEach(teardown);

  const term = (id, tabIds = []) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });
  const ed = (id, tabIds = []) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });
  const fakeTab = (id) => ({ id, title: id, sessionId: `pty-${id}`, cwd: '/w' });

  test('WA-07: settle drops activeKind when the group has no editor leaf, or holds a value it never writes', () => {
    editorIds.add('e1');
    const next = __settleLayout({
      tabs: [fakeTab('t1'), fakeTab('t2'), fakeTab('t3')],
      groups: [
        { id: 'group-1', name: 'A', tree: term('pane-1', ['t1']), activePaneId: 'pane-1', activeKind: 'editor', editorPaneId: 'pane-x' },
        { id: 'group-2', name: 'B', tree: { type: 'split', id: 'split-1', direction: 'vertical', children: [ed('pane-e', ['e1']), term('pane-2', ['t2'])], sizes: [60, 40] }, activePaneId: 'pane-2', editorPaneId: 'pane-e', activeKind: 'diagram' },
        { id: 'group-3', name: 'C', tree: { type: 'split', id: 'split-2', direction: 'vertical', children: [ed('pane-f'), term('pane-3', ['t3'])], sizes: [60, 40] }, activePaneId: 'pane-3', editorPaneId: 'pane-f', activeKind: 'editor' },
      ],
      activeGroupId: 'group-1',
      activeTabId: 't1',
    });
    const [a, b, c] = next.groups;
    assert.equal('activeKind' in a, false, 'no editor leaf: the field goes');
    assert.equal('editorPaneId' in a, false);
    assert.equal(activePaneOf(a), 'pane-1');
    assert.equal('activeKind' in b, false, 'an unknown value reads as terminal-active');
    assert.equal(activePaneOf(b), 'pane-2');
    assert.equal(c.activeKind, 'editor', 'an empty editor leaf can be the active pane');
    assert.equal(activePaneOf(c), 'pane-f');
    // A hand-made state that `settle` never saw is read defensively.
    assert.equal(activePaneOf({ tree: term('p', []), activePaneId: 'p', activeKind: 'editor', editorPaneId: 'gone' }), 'p');
    assert.equal(activePaneOf(null), null);
  });

  test('WA-08: closing the active editor leaf hands the focus to the neighbouring editor leaf, then to the terminal pane', async () => {
    await freshStart();
    const g = activeGroup();
    const termPane = g.activePaneId;
    editorIds.add('e1');
    editorIds.add('e2');
    const { paneId: first } = S.getState().placeEditorTab('e1');
    const second = S.getState().splitEditorLeaf(first, 'horizontal');
    assert.equal(activePaneOf(groupById(g.id)), second, 'a split editor leaf is the active pane');
    S.getState().placeEditorTab('e2');
    assert.equal(activePaneOf(groupById(g.id)), second);
    // The file's last tab closes (editorStore takes it out of its leaf).
    S.getState().removeEditorTabs(['e2']);
    let group = groupById(g.id);
    assert.equal(leavesOf(group.tree).some((l) => l.id === second), false, 'the emptied leaf is removed');
    assert.equal(activePaneOf(group), first, 'its neighbour takes the focus');
    assert.equal(group.activeKind, 'editor');
    S.getState().removeEditorTabs(['e1']);
    group = groupById(g.id);
    assert.equal(leavesOf(group.tree).some((l) => leafKind(l) === 'editor'), false);
    assert.equal(activePaneOf(group), termPane, 'no editor leaf left: the terminal pane');
    assert.equal('activeKind' in group, false, 'settle dropped the field');
    assertInvariants('after closing files');
  });
});

describe('activeKind saved and restored (AC-C1)', () => {
  beforeEach(freshStart);
  afterEach(teardown);

  test('WA-09: a round trip through localStorage brings back activeKind \u{2018}editor\u{2019} with the right editorPaneId', async () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    editorIds.add('e1');
    editorIds.add('e2');
    const { paneId: first } = S.getState().placeEditorTab('e1');
    const second = S.getState().splitEditorLeaf(first, 'vertical');
    S.getState().placeEditorTab('e2');
    S.getState().setActivePane(first);
    await wait(400);
    const payload = JSON.parse(backing.get(PERSIST_KEY));
    const savedGroup = payload.data.groups.find((x) => x.id === g.id);
    assert.equal(savedGroup.activeKind, 'editor', 'written as an optional group field');
    assert.equal(savedGroup.editorPaneId, first);
    assert.equal(savedGroup.activePaneId, termPane);
    assert.equal(payload.version, 2, 'SCHEMA_VERSION unchanged');
    // Additive: without the field the group is exactly what B wrote.
    assert.deepEqual(Object.keys(savedGroup).sort(), ['activeKind', 'activePaneId', 'createdAt', 'editorPaneId', 'id', 'name', 'tree']);

    await relaunch();
    const back = groupById(g.id);
    assert.ok(back, 'the group comes back');
    assert.equal(back.activeKind, 'editor');
    assert.equal(back.editorPaneId, first, 'the editor pane named, not merely the first editor leaf');
    assert.ok(leavesOf(back.tree).some((l) => l.id === second), 'both editor leaves are back, waiting for their files');
    assert.equal(activePaneOf(back), first);
    assert.equal(back.activePaneId, termPane);
    assertInvariants('after the relaunch');

    // Terminal-active is written as nothing at all.
    S.getState().setActivePane(back.activePaneId);
    await wait(400);
    const again = JSON.parse(backing.get(PERSIST_KEY)).data.groups.find((x) => x.id === g.id);
    assert.equal('activeKind' in again, false, 'terminal-active: no field written');
    assert.equal(again.editorPaneId, first, 'the editor pane is still remembered');
  });

  test('WA-10: a payload whose groups carry an unknown activeKind restores as terminal-active and does not throw', async () => {
    const g = activeGroup();
    const termPane = g.activePaneId;
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    await S.getState().createGroup({ name: 'Two' });
    await wait(400);
    const payload = JSON.parse(backing.get(PERSIST_KEY));
    payload.data.groups[0].activeKind = 'diagram';
    payload.data.groups[1].activeKind = 42;
    payload.data.groups[1].editorPaneId = 'pane-nowhere';
    backing.set(PERSIST_KEY, JSON.stringify(payload));
    await relaunch();
    const one = groupById(g.id);
    assert.ok(one, 'the group comes back');
    assert.equal('activeKind' in one, false, 'an unknown value is not kept');
    assert.equal(activePaneOf(one), termPane, 'terminal-active');
    assert.equal(one.editorPaneId, edPane, 'the editor pane is still known');
    const two = S.getState().groups[1];
    assert.equal('activeKind' in two, false);
    assert.equal('editorPaneId' in two, false, 'an editorPaneId naming nothing is dropped');
    assertInvariants('after restoring unknown values');
    // An 'editor' with no editor pane to name: terminal-active as well.
    await wait(400);
    const p2 = JSON.parse(backing.get(PERSIST_KEY));
    p2.data.groups[1].activeKind = 'editor';
    backing.set(PERSIST_KEY, JSON.stringify(p2));
    await relaunch();
    assert.equal('activeKind' in S.getState().groups[1], false, '\u{2018}editor\u{2019} without an editor leaf restores terminal-active');
    assertInvariants('after restoring an editor kind with no editor leaf');
  });
});
