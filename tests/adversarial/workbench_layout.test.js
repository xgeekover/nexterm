/**
 * The workbench tree (editor placement, sibling B, step B1): a terminal
 * group's tree holds leaves of two kinds. A leaf with `kind: 'editor'` holds
 * file tabs; any other leaf — every leaf a v0.31.0 payload has, which carries
 * no `kind` — holds terminals.
 *
 *   AC-B1  `settle` and the tree actions keep each id in a leaf of its own
 *          kind, keep empty editor leaves, keep the active panes on their
 *          kind, and keep a terminal leaf in every group that has editors.
 *   AC-B2  the store half of a drag: same-kind drops as before, cross-kind
 *          drops split at the edges and change nothing at the centre or on
 *          a strip.
 *   AC-B8  editor leaves count for nothing in what reads terminals.
 *   AC-B9  `projectTree` / `liftSizes`, the bridge each view draws through.
 *   AC-B10 the pixel minimums (math only; C wires them).
 *
 * terminalStore never imports editorStore: it learns which editor tab ids
 * exist through `setEditorBridge`, which these cases fill with a fake.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useTerminalStore,
  setEditorBridge,
  zoomedPaneOf,
  panesOnScreen,
  hiddenTabIdsOf,
  swapBlockedReason,
  __settleLayout,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import {
  leafKind,
  leavesOfKind,
  tabIdsOfKind,
  countTerminalTabs,
  projectTree,
  PANE_MIN_PX,
  minSharesOf,
  fitSizesToMinimums,
  fitTreeToMinimums,
  panePixelRects,
  equalizeAll,
  equalSizesOf,
} from '../../src/components/terminal/splitLayout.js';
import { summaryCounts } from '../../src/components/terminal/statusBoardModel.js';
import { unreadIn, unreadCountByTab } from '../../src/lib/attention.js';
import { groupProgress } from '../../src/lib/terminalProgress.js';
import { createControlDispatcher } from '../../src/lib/controlDispatcher.js';

const S = useTerminalStore;

// --- localStorage shim and a fake editor bridge -----------------------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
const editorIds = new Set();
const closedEditorTabs = [];

let installed = false;

function installStorage() {
  // Captured once per case: a second install must not take our own shim for
  // the one to hand back (a suite that set its own at import would lose it).
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
  closedEditorTabs.length = 0;
  setEditorBridge({
    tabIds: () => editorIds,
    closeTabs: (ids) => {
      closedEditorTabs.push(...ids);
      for (const id of ids) editorIds.delete(id);
    },
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

// --- hand-made trees ----------------------------------------------------------
const term = (id, tabIds = [], activeTabId = tabIds[0] ?? null) => ({ type: 'leaf', id, tabIds, activeTabId });
const ed = (id, tabIds = [], activeTabId = tabIds[0] ?? null) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId });
const split = (id, direction, children, sizes) => ({ type: 'split', id, direction, children, ...(sizes ? { sizes } : {}) });
const fakeTab = (id) => ({ id, title: id, sessionId: `pty-${id}`, cwd: '/w' });

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groupById = (id) => S.getState().groups.find((g) => g.id === id);
const leafById = (id) => {
  for (const g of S.getState().groups) {
    const found = leavesOf(g.tree).find((l) => l.id === id);
    if (found) return found;
  }
  return null;
};
const snapshot = () => JSON.stringify({ groups: S.getState().groups, activeGroupId: S.getState().activeGroupId, activeTabId: S.getState().activeTabId });

/** A hand-made store state: terminal tabs `terms`, editor ids `eds`, and `groups`. */
function arrange({ terms = [], eds = [], groups, activeGroupId = groups[0].id, activeTabId = null }) {
  for (const id of eds) editorIds.add(id);
  const tabs = terms.map(fakeTab);
  S.setState({ tabs, groups, activeGroupId, activeTabId: activeTabId ?? terms[0] ?? null });
  S.setState(__settleLayout(S.getState()));
}

describe('Workbench tree: settle (AC-B1)', () => {
  beforeEach(() => {
    installStorage();
    installBridge();
  });
  afterEach(teardown);

  test('WB-01: editor ids stay in editor leaves; a cross-kind id is dropped from either side; empty editor leaves stay', () => {
    const state = {
      tabs: ['t1', 't2'].map(fakeTab),
      groups: [
        {
          id: 'group-1',
          name: 'One',
          tree: split('split-1', 'vertical', [
            ed('pane-e1', ['e1', 't2'], 'e1'),
            split('split-2', 'horizontal', [term('pane-t1', ['t1', 'e2']), ed('pane-e2', [])]),
          ], [60, 40]),
          activePaneId: 'pane-t1',
          editorPaneId: 'pane-e1',
        },
      ],
      activeGroupId: 'group-1',
      activeTabId: 't1',
    };
    editorIds.add('e1');
    editorIds.add('e2');
    const next = __settleLayout(state);
    const leaves = leavesOf(next.groups[0].tree);
    const byId = Object.fromEntries(leaves.map((l) => [l.id, l]));
    assert.deepEqual(byId['pane-e1'].tabIds, ['e1'], 'the editor leaf keeps its file and loses the terminal id');
    assert.deepEqual(byId['pane-t1'].tabIds, ['t1'], 'the terminal leaf keeps its terminal and loses the editor id');
    assert.ok(byId['pane-e2'], 'an empty editor leaf is kept (a split, or a leaf waiting for the restore)');
    assert.deepEqual(byId['pane-e2'].tabIds, []);
    assert.equal(byId['pane-e2'].kind, 'editor');
    assert.equal(next.activeTabId, 't1', 'the store activeTabId stays a terminal id');
  });

  test('WB-02: each id lives in one leaf across groups; a leaf without `kind` is a terminal leaf', () => {
    editorIds.add('e1');
    const state = {
      tabs: ['t1', 't2'].map(fakeTab),
      groups: [
        { id: 'group-1', name: 'A', tree: split('split-1', 'vertical', [ed('pane-e1', ['e1']), term('pane-t1', ['t1'])]), activePaneId: 'pane-t1' },
        { id: 'group-2', name: 'B', tree: split('split-2', 'vertical', [ed('pane-e2', ['e1']), { type: 'leaf', id: 'pane-t2', tabIds: ['t2', 'e1', 't1'], activeTabId: 'e1' }]), activePaneId: 'pane-t2' },
      ],
      activeGroupId: 'group-1',
      activeTabId: 't1',
    };
    const next = __settleLayout(state);
    const two = leavesOf(next.groups[1].tree);
    assert.deepEqual(two.find((l) => l.id === 'pane-e2').tabIds, [], 'e1 is already in group 1, so group 2 loses it');
    const t2 = two.find((l) => l.id === 'pane-t2');
    assert.deepEqual(t2.tabIds, ['t2'], 'a kind-less leaf is a terminal leaf: an editor id is not kept in it, a duplicate terminal neither');
    assert.equal(t2.activeTabId, 't2');
    assert.equal('kind' in t2, false, 'a terminal leaf is not given a `kind`');
    assert.equal(leafKind(t2), 'terminal');
    assert.equal(leafKind(ed('x')), 'editor');
  });

  test('WB-03: activePaneId is repaired to a terminal leaf, editorPaneId to an editor leaf (or removed)', () => {
    editorIds.add('e1');
    const state = {
      tabs: ['t1'].map(fakeTab),
      groups: [
        { id: 'group-1', name: 'A', tree: split('split-1', 'vertical', [ed('pane-e1', ['e1']), ed('pane-e3'), term('pane-t1', ['t1'])]), activePaneId: 'pane-e1', editorPaneId: 'pane-t1' },
        { id: 'group-2', name: 'B', tree: term('pane-t2', ['t1']), activePaneId: 'pane-t2', editorPaneId: 'pane-gone' },
      ],
      activeGroupId: 'group-1',
      activeTabId: null,
    };
    const next = __settleLayout({ ...state, tabs: [...state.tabs, fakeTab('t2')], groups: [state.groups[0], { ...state.groups[1], tree: term('pane-t2', ['t2']) }] });
    assert.equal(next.groups[0].activePaneId, 'pane-t1', 'an editor leaf is never the terminal active pane');
    assert.equal(next.groups[0].editorPaneId, 'pane-e1', 'a terminal leaf is never the editor pane: the first editor leaf takes it');
    assert.equal('editorPaneId' in next.groups[1], false, 'a group with no editor leaf has no editorPaneId');
    assert.equal(next.activeTabId, 't1');
  });

  test('WB-04: a group whose last terminal leaf empties keeps it (in place, same id) while it holds editor leaves', () => {
    editorIds.add('e1');
    const state = {
      tabs: [fakeTab('t9')],
      groups: [
        { id: 'group-1', name: 'A', tree: term('pane-a', ['t9']), activePaneId: 'pane-a' },
        { id: 'group-2', name: 'B', tree: split('split-1', 'vertical', [ed('pane-e1', ['e1']), split('split-2', 'horizontal', [term('pane-t1', ['gone-1']), term('pane-t2', ['gone-2'])], [30, 70])], [60, 40]), activePaneId: 'pane-t2', editorPaneId: 'pane-e1' },
        { id: 'group-3', name: 'C', tree: ed('pane-e3', []), activePaneId: 'pane-e3', editorPaneId: 'pane-e3' },
      ],
      activeGroupId: 'group-2',
      activeTabId: null,
    };
    const next = __settleLayout(state);
    const two = next.groups.find((g) => g.id === 'group-2');
    assert.ok(two, 'the group with editors survives losing its terminals');
    const termLeaves = leavesOfKind(two.tree, 'terminal');
    assert.deepEqual(termLeaves.map((l) => l.id), ['pane-t2'], 'one empty terminal leaf stays: the active one');
    assert.deepEqual(termLeaves[0].tabIds, []);
    assert.equal(two.activePaneId, 'pane-t2');
    assert.deepEqual(two.tree.sizes, [60, 40], 'the editor/terminal split keeps its sizes');
    const three = next.groups.find((g) => g.id === 'group-3');
    assert.ok(three, 'an editor-only group from a hand-made state is given a terminal leaf');
    assert.equal(three.tree.type, 'split');
    assert.equal(three.tree.direction, 'vertical');
    assert.deepEqual(three.tree.sizes, [60, 40]);
    assert.equal(leafKind(three.tree.children[0]), 'editor');
    assert.equal(leafKind(three.tree.children[1]), 'terminal');
    assert.equal(three.activePaneId, three.tree.children[1].id);
  });

  test('WB-05: closing the last terminal of a group with an editor leaf (closeTab) keeps the group and an empty terminal leaf', async () => {
    await freshStart();
    try {
      const first = S.getState().activeTabId;
      const group2 = await S.getState().createGroup({ name: 'Two' });
      const t2 = S.getState().activeTabId;
      editorIds.add('tab-edit-1');
      S.getState().placeEditorTab('tab-edit-1', { groupId: group2.id });
      const paneBefore = groupById(group2.id).activePaneId;
      await S.getState().closeTab(t2);
      const g2 = groupById(group2.id);
      assert.ok(g2, 'group 2 is still there');
      const termLeaves = leavesOfKind(g2.tree, 'terminal');
      assert.equal(termLeaves.length, 1);
      assert.equal(termLeaves[0].id, paneBefore, 'the same pane, emptied in place');
      assert.deepEqual(termLeaves[0].tabIds, []);
      assert.deepEqual(tabIdsOfKind(g2.tree, 'editor'), ['tab-edit-1']);
      // Without an editor the group goes, as before.
      const group3 = await S.getState().createGroup({ name: 'Three' });
      await S.getState().closeTab(S.getState().activeTabId);
      assert.equal(groupById(group3.id), undefined, 'a terminal-only group still disappears with its last terminal');
      assert.ok(S.getState().tabs.some((t) => t.id === first));
    } finally {
      teardown();
    }
  });
});

describe('Workbench tree: actions across kinds (AC-B1)', () => {
  beforeEach(freshStart);
  afterEach(teardown);

  test('WB-06: placeEditorTab wraps the root [editor 60 | old root 40], then fills the editor pane; splitEditorLeaf adds an empty editor leaf', () => {
    const g = S.getState().getActiveGroup();
    const rootBefore = g.tree;
    editorIds.add('e1');
    editorIds.add('e2');
    const placed = S.getState().placeEditorTab('e1');
    let group = groupById(g.id);
    assert.equal(group.tree.type, 'split');
    assert.equal(group.tree.direction, 'vertical');
    assert.deepEqual(group.tree.sizes, [60, 40]);
    assert.equal(leafKind(group.tree.children[0]), 'editor');
    assert.equal(group.tree.children[1], rootBefore, 'the old root is kept as it was (same object, same ids)');
    assert.equal(group.editorPaneId, placed.paneId);
    assert.equal(group.activePaneId, g.activePaneId, 'the terminal active pane does not move');
    S.getState().placeEditorTab('e2');
    group = groupById(g.id);
    assert.deepEqual(leafById(placed.paneId).tabIds, ['e1', 'e2'], 'the next file goes into the editor pane, shown');
    assert.equal(leafById(placed.paneId).activeTabId, 'e2');
    const fresh = S.getState().splitEditorLeaf(placed.paneId, 'horizontal');
    group = groupById(g.id);
    assert.equal(leafKind(leafById(fresh)), 'editor');
    assert.deepEqual(leafById(fresh).tabIds, []);
    assert.equal(group.editorPaneId, fresh, 'the new empty editor leaf is where the next file lands');
    assert.equal(S.getState().splitEditorLeaf(g.activePaneId, 'horizontal'), null, 'splitEditorLeaf refuses a terminal leaf');
  });

  test('WB-07: splitPane next to an editor leaf, closePane of an editor leaf, zoom, equalize and setPaneSizes on a mixed tree', async () => {
    const g = S.getState().getActiveGroup();
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    const termPane = await S.getState().splitPane(edPane, 'horizontal', g.id);
    assert.ok(termPane, 'a terminal split beside an editor leaf');
    assert.equal(leafKind(leafById(termPane)), 'terminal');
    assert.equal(leafById(termPane).tabIds.length, 1);
    let group = groupById(g.id);
    const top = group.tree.children[0];
    assert.equal(top.type, 'split');
    assert.deepEqual(top.children.map((c) => c.id), [edPane, termPane]);

    // Updated for sibling C (FC8): one tree draws both kinds, so a zoom hides
    // every other pane of either kind, and any pane of a group of two or more
    // can zoom — the only editor leaf included. B counted the pane's own kind
    // (review K-04) because each kind then had its own view. WB-20 has more.
    assert.equal(S.getState().togglePaneZoom(edPane, g.id), true, 'the only editor leaf zooms: there are other panes to hide');
    group = groupById(g.id);
    assert.equal(zoomedPaneOf(group)?.id, edPane);
    assert.equal(group.activeKind, 'editor', 'the zoomed pane is the active pane');
    assert.equal(S.getState().togglePaneZoom(edPane, g.id), false);
    assert.equal(S.getState().togglePaneZoom(termPane, g.id), true, 'a terminal beside an editor leaf can be zoomed');
    assert.equal(zoomedPaneOf(groupById(g.id))?.id, termPane);
    assert.equal(S.getState().togglePaneZoom(termPane, g.id), false);

    S.getState().setPaneSizes(g.id, top.id, [25, 75]);
    assert.deepEqual(groupById(g.id).tree.children[0].sizes, [25, 75], 'sizes of an editor/terminal split are kept');
    assert.equal(S.getState().equalizeSplits(g.id), true);
    group = groupById(g.id);
    assert.deepEqual(group.tree, equalizeAll(group.tree), 'equalized, counting editor leaves as panes');

    S.getState().closePane(edPane, g.id);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(leafById(edPane), null, 'the editor leaf is gone');
    assert.deepEqual(closedEditorTabs, ['e1'], 'its file tab is closed through the bridge, not killed as a PTY');
    assert.equal(groupById(g.id).editorPaneId, undefined);
  });

  // Updated for sibling C (FC8, AC-C7). B's version (review K-04) asserted
  // that a lone terminal beside a lone editor leaf could NOT zoom, because a
  // zoom then hid only panes of its own view's kind. With one tree drawing
  // both kinds, Toggle Pane Zoom on any pane hides every other pane, of
  // either kind, so `canZoom` is "more than one pane in the group".
  test('WB-20: zoom counts every pane: one terminal and one editor leaf can zoom either; zoom hides both kinds; hiddenTabIds lists terminals only; the zoom ends when one pane is left', async () => {
    const g = S.getState().getActiveGroup();
    const termPane = g.activePaneId;
    const termTab = S.getState().activeTabId;
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    assert.equal(S.getState().togglePaneZoom(termPane, g.id), true, 'one terminal and one editor leaf: the terminal zooms');
    let group = groupById(g.id);
    assert.deepEqual(panesOnScreen(group).map((l) => l.id), [termPane], 'the editor pane is hidden by a terminal zoom');
    assert.deepEqual(hiddenTabIdsOf(group), [], 'the hidden editor pane adds no tab id to the attention pill');
    assert.equal(S.getState().togglePaneZoom(null, null), false, 'the keyboard unzooms the active pane');
    assert.equal(S.getState().togglePaneZoom(edPane, g.id), true, 'the editor leaf zooms');
    group = groupById(g.id);
    assert.deepEqual(panesOnScreen(group).map((l) => l.id), [edPane], 'the terminal pane is hidden by an editor zoom');
    assert.deepEqual(hiddenTabIdsOf(group), [termTab], 'hiddenTabIds lists the hidden terminal\u{2019}s tab, and no file tab');
    assert.equal(S.getState().togglePaneZoom(edPane, g.id), false, 'and unzoom');
    assert.deepEqual(hiddenTabIdsOf(groupById(g.id)), [], 'nothing hidden while not zoomed');

    // A hand-made zoom on a pane that is not the active one does not survive settle.
    S.setState(__settleLayout({ ...S.getState(), groups: S.getState().groups.map((x) => (x.id === g.id ? { ...x, zoomedPaneId: termPane } : x)) }));
    assert.equal('zoomedPaneId' in groupById(g.id), false, 'settle drops a zoom that is not on THE active pane (the editor one)');

    const second = await S.getState().splitPane(termPane, 'horizontal', g.id);
    assert.equal(S.getState().togglePaneZoom(second, g.id), true, 'three panes: zoom');
    assert.equal(zoomedPaneOf(groupById(g.id))?.id, second);
    assert.deepEqual(hiddenTabIdsOf(groupById(g.id)), [termTab], 'the other terminal is hidden; the editor adds nothing');
    await S.getState().closePane(termPane, g.id);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(zoomedPaneOf(groupById(g.id))?.id, second, 'two panes left, the editor one hidden: the zoom holds');
    S.getState().removeEditorTabs(['e1']);
    assert.equal('zoomedPaneId' in groupById(g.id), false, 'one pane left: the zoom ends');
  });

  test('WB-08: swapPanes carries `kind` with the contents; the terminal tab is the same object afterwards', () => {
    const g = S.getState().getActiveGroup();
    const termPane = g.activePaneId;
    const tabBefore = S.getState().tabs[0];
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    assert.equal(S.getState().swapPanes(termPane, edPane, g.id), true);
    const a = leafById(termPane);
    const b = leafById(edPane);
    assert.equal(leafKind(a), 'editor', 'the old terminal leaf now holds the file, and is an editor leaf');
    assert.deepEqual(a.tabIds, ['e1']);
    assert.equal(leafKind(b), 'terminal');
    assert.equal('kind' in b, false, 'a terminal leaf is written without `kind`');
    assert.deepEqual(b.tabIds, [tabBefore.id]);
    const group = groupById(g.id);
    assert.equal(group.activePaneId, edPane, 'the terminal active pane follows its terminal');
    assert.equal(group.editorPaneId, termPane, 'and the editor pane its file');
    assert.equal(S.getState().tabs[0], tabBefore, 'nothing respawned: the very same tab object');
  });

  test('WB-09: swapTargets lists panes of the active pane\'s kind only', async () => {
    const g = S.getState().getActiveGroup();
    editorIds.add('e1');
    const first = g.activePaneId;
    S.getState().placeEditorTab('e1');
    let targets = S.getState().swapTargets(g.id);
    assert.deepEqual(targets.panes, [], 'one terminal pane: nothing of its kind to swap with');
    assert.ok(targets.note, 'and it says why');
    const second = await S.getState().splitPane(first, 'horizontal', g.id);
    targets = S.getState().swapTargets(g.id);
    assert.deepEqual(targets.panes.map((p) => p.paneId), [second]);
    assert.equal(targets.panes[0].count, 2, 'counted among the terminal panes');
    assert.equal(swapBlockedReason(groupById(g.id), 'editor') !== null, true, 'one editor pane cannot swap with an editor');
  });

  // Updated for sibling C (FC1): B's cycle skipped editor leaves, because
  // `activePaneId` was the only active pane and never names one. With one
  // active pane of either kind (`activeKind`), the cycle runs over both
  // kinds in DOM order, and `activePaneId` still only ever names a terminal.
  test('WB-10: focusNextPane runs over both kinds, keeping activePaneId on terminal leaves; setActivePane on an editor leaf moves editorPaneId', async () => {
    const g = S.getState().getActiveGroup();
    editorIds.add('e1');
    const first = g.activePaneId;
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    const second = await S.getState().splitPane(first, 'horizontal', g.id);
    S.getState().setActivePane(first);
    S.getState().focusNextPane(1);
    assert.equal(groupById(g.id).activePaneId, second);
    S.getState().focusNextPane(1);
    assert.equal(groupById(g.id).editorPaneId, edPane, 'the cycle wraps onto the editor leaf, above the terminals');
    assert.equal(groupById(g.id).activeKind, 'editor');
    assert.equal(groupById(g.id).activePaneId, second, 'the terminal active pane is the one last left');
    S.getState().focusNextPane(1);
    assert.equal(groupById(g.id).activePaneId, first);
    assert.equal('activeKind' in groupById(g.id), false, 'and back onto the first terminal');
    const fresh = S.getState().splitEditorLeaf(edPane, 'vertical');
    S.getState().setActivePane(edPane);
    assert.equal(groupById(g.id).editorPaneId, edPane);
    assert.equal(groupById(g.id).activePaneId, first, 'the terminal active pane is untouched');
    assert.ok(fresh);
  });
});

describe('Workbench tree: drops and strips across kinds (AC-B2)', () => {
  beforeEach(freshStart);
  afterEach(teardown);

  const EDGES = [
    ['left', 'horizontal', true],
    ['right', 'horizontal', false],
    ['top', 'vertical', true],
    ['bottom', 'vertical', false],
  ];

  for (const equalize of [false, true]) {
    for (const [zone, direction, first] of EDGES) {
      test(`WB-11 ${zone}${equalize ? ' (Equal Splits on)' : ''}: an editor tab onto a terminal leaf, and a terminal tab onto an editor leaf, split with a leaf of the dragged kind`, async () => {
        useSettingsStore.getState().setSetting('terminalEqualizeOnSplit', equalize);
        assert.equal(useSettingsStore.getState().terminalEqualizeOnSplit, equalize);
        const g = S.getState().getActiveGroup();
        const termPane = g.activePaneId;
        const t1 = S.getState().activeTabId;
        const t2 = (await S.getState().createTab()).id;
        editorIds.add('e1');
        editorIds.add('e2');
        const { paneId: edPane } = S.getState().placeEditorTab('e1');
        S.getState().placeEditorTab('e2');

        // Editor tab onto the terminal leaf's edge.
        S.getState().dropTabOnPane('e2', termPane, zone, g.id);
        let group = groupById(g.id);
        const parent = leavesOf(group.tree).length && findParent(group.tree, termPane);
        const made = parent.children[first ? 0 : 1];
        assert.equal(parent.direction, direction);
        assert.equal(leafKind(made), 'editor', 'the new leaf has the dragged kind');
        assert.deepEqual(made.tabIds, ['e2']);
        assert.equal(parent.children[first ? 1 : 0].id, termPane);
        assert.deepEqual(parent.sizes, equalize ? equalSizesOf(parent) : [50, 50]);
        assert.equal(group.editorPaneId, made.id);
        assert.equal(group.activePaneId, termPane, 'the terminal active pane is not handed to an editor leaf');

        // Terminal tab onto the editor leaf's edge.
        S.getState().dropTabOnPane(t2, edPane, zone, g.id);
        group = groupById(g.id);
        const parent2 = findParent(group.tree, edPane);
        const made2 = parent2.children[first ? 0 : 1];
        assert.equal(parent2.direction, direction);
        assert.equal(leafKind(made2), 'terminal');
        assert.deepEqual(made2.tabIds, [t2]);
        assert.equal(group.activePaneId, made2.id);
        assert.equal(S.getState().activeTabId, t2);
        if (equalize) assert.deepEqual(parent2.sizes, equalSizesOf(parent2), 'Equal Splits on: the line is at equal shares');
        else assert.deepEqual(parent2.sizes, [50, 50], 'Equal Splits off: the split pane is halved');
        assert.deepEqual(leafById(termPane).tabIds, [t1], 'the source terminal leaf keeps its other terminal');
      });
    }
  }

  test('WB-12: a cross-kind centre drop, strip move or bind leaves the state deep-equal to before', () => {
    const g = S.getState().getActiveGroup();
    const termPane = g.activePaneId;
    const t1 = S.getState().activeTabId;
    editorIds.add('e1');
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    const before = snapshot();
    const groupsRef = S.getState().groups;
    S.getState().dropTabOnPane('e1', termPane, 'center', g.id);
    S.getState().dropTabOnPane(t1, edPane, 'center', g.id);
    S.getState().moveTabInStrip('e1', termPane, 0, g.id);
    S.getState().moveTabInStrip(t1, edPane, 0, g.id);
    S.getState().bindPaneToTab(edPane, t1, g.id);
    S.getState().bindPaneToTab(termPane, 'e1', g.id);
    assert.equal(snapshot(), before);
    assert.equal(S.getState().groups, groupsRef, 'not even a new groups array, so nothing is saved');
  });

  test('WB-13: same-kind editor moves: centre drop, strip reorder and bind, pruning the leaf they empty', () => {
    const g = S.getState().getActiveGroup();
    for (const id of ['e1', 'e2', 'e3']) editorIds.add(id);
    const { paneId: edPane } = S.getState().placeEditorTab('e1');
    S.getState().placeEditorTab('e2');
    S.getState().placeEditorTab('e3');
    S.getState().moveTabInStrip('e3', edPane, 0, g.id);
    assert.deepEqual(leafById(edPane).tabIds, ['e3', 'e1', 'e2']);
    S.getState().dropTabOnPane('e2', edPane, 'right', g.id);
    const right = groupById(g.id).editorPaneId;
    assert.notEqual(right, edPane);
    assert.deepEqual(leafById(right).tabIds, ['e2']);
    S.getState().dropTabOnPane('e2', edPane, 'center', g.id);
    assert.equal(leafById(right), null, 'the leaf the drop emptied is pruned');
    assert.deepEqual(leafById(edPane).tabIds, ['e3', 'e1', 'e2']);
    S.getState().bindPaneToTab(edPane, 'e1', g.id);
    assert.equal(leafById(edPane).activeTabId, 'e1');
    assert.equal(groupById(g.id).editorPaneId, edPane);
  });
});

function findParent(node, id) {
  if (!node || node.type !== 'split') return null;
  if (node.children.some((c) => c.id === id)) return node;
  for (const c of node.children) {
    const found = findParent(c, id);
    if (found) return found;
  }
  return null;
}

describe('Workbench tree: terminal-only readers (AC-B8)', () => {
  beforeEach(freshStart);
  afterEach(teardown);

  test('WB-14: editor leaves add nothing to terminal counts, the TerminalsPanel model, status counts, unread, progress or `list`', async () => {
    const g = S.getState().getActiveGroup();
    const a = S.getState().activeTabId;
    const b = (await S.getState().createTab()).id;
    const termOnly = groupById(g.id).tree;
    const termIds = tabIdsOfKind(termOnly, 'terminal');
    for (const id of ['e1', 'e2']) editorIds.add(id);
    S.getState().placeEditorTab('e1');
    S.getState().placeEditorTab('e2');
    const mixed = groupById(g.id).tree;
    assert.equal(countTerminalTabs(mixed), 2);
    assert.equal(countTerminalTabs(termOnly), 2);
    assert.deepEqual(tabIdsOfKind(mixed, 'terminal'), termIds);
    assert.deepEqual(tabIdsOfKind(mixed, 'editor'), ['e1', 'e2']);
    const panel = projectTree(mixed, 'terminal');
    assert.deepEqual(leavesOf(panel).map((l) => l.id), leavesOf(termOnly).map((l) => l.id), 'the TerminalsPanel panes');
    assert.deepEqual(leavesOf(panel).reduce((n, l) => n + l.tabIds.length, 0), 2, 'and its count');

    const state = S.getState();
    assert.deepEqual(summaryCounts(state, tabIdsOfKind(mixed, 'terminal')), summaryCounts(state, termIds));
    assert.deepEqual(summaryCounts(state, [...termIds, 'e1']), summaryCounts(state, termIds), 'an editor id is not a terminal to count');
    const counts = { ...unreadCountByTab(state.notifications), [a]: 2 };
    assert.equal(unreadIn(counts, tabIdsOfKind(mixed, 'terminal')), 2);
    const progress = { [a]: { state: 'normal', value: 40 }, [b]: { state: 'normal', value: 60 } };
    assert.deepEqual(groupProgress(progress, tabIdsOfKind(mixed, 'terminal')), groupProgress(progress, termIds));

    const replies = [];
    const dispatcher = createControlDispatcher({ reply: async (m) => replies.push(m), readTerminal: async () => null });
    const caller = S.getState().tabs.find((t) => t.id === a).sessionId;
    await dispatcher.handle({ id: 1, session_id: caller, cmd: 'list', args: {} });
    assert.equal(replies[0]?.ok, true, JSON.stringify(replies[0]?.error));
    assert.deepEqual(replies[0].result.map((r) => r.id), [a, b], 'list shows the terminals in order, and no editor');
  });
});

describe('Workbench tree: projections (AC-B9, unit part)', () => {
  test('WB-15: projectTree keeps ids, collapses single-child splits and renormalizes the sizes it keeps', () => {
    const tree = split('s-root', 'vertical', [
      split('s-ed', 'horizontal', [ed('pe1', ['e1']), ed('pe2', [])], [70, 30]),
      split('s-mid', 'horizontal', [term('pt1', ['t1']), ed('pe3', ['e3']), term('pt2', ['t2'])], [20, 30, 50]),
    ], [60, 40]);
    const terms = projectTree(tree, 'terminal');
    assert.equal(terms.id, 's-mid', 'the root collapses into its one child with terminals');
    assert.deepEqual(terms.children.map((c) => c.id), ['pt1', 'pt2']);
    assert.deepEqual(terms.sizes, [28.57, 71.43]);
    assert.equal(terms.children[0], tree.children[1].children[0], 'kept leaves are the same objects');
    const eds = projectTree(tree, 'editor');
    assert.equal(eds.id, 's-root');
    assert.equal(eds.children[0], tree.children[0], 'a subtree of one kind is handed back as it is');
    assert.equal(eds.children[1].id, 'pe3', 'the middle row collapses to its one editor leaf');
    assert.deepEqual(eds.sizes, [60, 40]);
    assert.equal(projectTree(term('x', ['t']), 'editor'), null);
    assert.equal(projectTree(null, 'terminal'), null);
    const pure = split('s', 'horizontal', [term('a'), term('b')], [30, 70]);
    assert.equal(projectTree(pure, 'terminal'), pure, 'a one-kind tree is the same object: nothing remounts');
  });

  // Rewritten for sibling C (FC2): WB-16 pinned `liftSizes`, the bridge's
  // write-back of a resize made in one kind's projection. The workbench now
  // draws the full tree and stores a split's sizes as dragged, so nothing
  // uses it and it is removed; what is pinned instead is that it is gone.
  test('WB-16: liftSizes went with the bridge: splitLayout no longer exports it', async () => {
    const layout = await import('../../src/components/terminal/splitLayout.js');
    assert.equal('liftSizes' in layout, false, 'liftSizes is still exported');
  });
});

describe('Workbench tree: pixel minimums (AC-B10)', () => {
  const line = (count, direction, sizes, kindOf = () => 'terminal') =>
    split('line', direction, Array.from({ length: count }, (_, i) => (kindOf(i) === 'editor' ? ed(`p${i}`) : term(`p${i}`))), sizes);

  test('WB-17: every pane gets at least its kind\'s minimum when the space allows', () => {
    assert.ok(PANE_MIN_PX.terminal.width >= 120 && PANE_MIN_PX.terminal.height >= 88);
    assert.ok(PANE_MIN_PX.editor.width >= 120 && PANE_MIN_PX.editor.height >= 88);
    const node = line(3, 'horizontal', [90, 5, 5], (i) => (i === 2 ? 'editor' : 'terminal'));
    const mins = minSharesOf(node, 1000);
    assert.deepEqual(mins.map((v) => Math.round(v * 100) / 100), [12, 12, PANE_MIN_PX.editor.width / 10]);
    const fitted = fitSizesToMinimums(node, 1000);
    fitted.forEach((v, i) => assert.ok(v * 10 >= (i === 2 ? PANE_MIN_PX.editor.width : 120) - 0.1, `pane ${i}: ${v}% of 1000px`));
    assert.ok(Math.abs(fitted.reduce((a, b) => a + b, 0) - 100) < 0.001);
    const roomy = line(2, 'horizontal', [40, 60]);
    assert.deepEqual(fitSizesToMinimums(roomy, 1000), [40, 60], 'sizes already above the minimums are left alone');
  });

  test('WB-18: the minimums are capped when the space is too small, and stay positive', () => {
    const node = line(6, 'horizontal', [95, 1, 1, 1, 1, 1]);
    const mins = minSharesOf(node, 300);
    assert.ok(mins.reduce((a, b) => a + b, 0) <= 100.001, 'capped to the space there is');
    mins.forEach((v) => assert.ok(v > 0));
    fitSizesToMinimums(node, 300).forEach((v) => assert.ok(v > 0));
    assert.deepEqual(minSharesOf(node, 0), [0, 0, 0, 0, 0, 0], 'no space, no minimum (and no NaN)');
  });

  test('WB-19: a 6-pane line in 1024x640 gives no zero or negative size, nested or flat, either direction', () => {
    for (const direction of ['horizontal', 'vertical']) {
      let nested = term('p0');
      for (let i = 1; i < 6; i += 1) nested = split(`s${i}`, direction, [nested, i % 2 ? ed(`p${i}`) : term(`p${i}`)], [98, 2]);
      for (const tree of [nested, line(6, direction, [95, 1, 1, 1, 1, 1])]) {
        const fitted = fitTreeToMinimums(tree, 1024, 640);
        const rects = panePixelRects(fitted, 1024, 640);
        assert.equal(rects.size, 6);
        for (const [id, r] of rects) {
          assert.ok(r.width > 0 && r.height > 0, `${direction} ${id}: ${JSON.stringify(r)}`);
          const min = PANE_MIN_PX[leafKind(leavesOf(fitted).find((l) => l.id === id))];
          const along = direction === 'horizontal' ? r.width : r.height;
          const wanted = direction === 'horizontal' ? min.width : min.height;
          assert.ok(along >= wanted - 0.5, `${direction} ${id}: ${along}px under ${wanted}px`);
        }
      }
    }
  });
});
