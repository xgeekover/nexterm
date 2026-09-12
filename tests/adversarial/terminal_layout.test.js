/**
 * Terminal tab layout: each pane is a group holding its own tabs, and a tab can
 * be dragged into another group or onto a group's edge to split it.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, PERSIST_KEY } from '../../src/stores/terminalStore.js';
import { saveState, loadState } from '../../src/lib/persistence.js';
import { mockBridge } from '../../src/lib/ipc.js';

const S = useTerminalStore;
const tree = () => S.getState().splitTree;

function leaves(node = tree(), acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
}
const leafOf = (tabId) => leaves().find((l) => l.tabIds.includes(tabId));

describe('Terminal layout: tab groups and drag-drop placement', () => {
  beforeEach(async () => {
    // Fresh tree + tabs for every case.
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();
  });

  test('TL-01: a new tab joins the active group and becomes its visible tab', async () => {
    const first = leaves()[0];
    const startCount = first.tabIds.length;
    const tab = await S.getState().createTab();
    const leaf = leafOf(tab.id);
    assert.equal(leaves().length, 1, 'creating a tab must not split');
    assert.equal(leaf.id, 'pane-root');
    assert.equal(leaf.tabIds.length, startCount + 1);
    assert.equal(leaf.activeTabId, tab.id);
  });

  test('TL-02: dropping a tab on a pane edge splits that pane', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');

    assert.equal(tree().type, 'split');
    assert.equal(tree().direction, 'horizontal');
    assert.equal(leaves().length, 2);
    // Dropped on the right → the new group is the second child.
    assert.deepEqual(tree().children[0].tabIds, [a]);
    assert.deepEqual(tree().children[1].tabIds, [b]);
    assert.equal(S.getState().activePaneId, tree().children[1].id);
  });

  test('TL-03: "left"/"top" place the dragged tab before the target', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'top');

    assert.equal(tree().direction, 'vertical');
    assert.deepEqual(tree().children[0].tabIds, [b], 'dragged tab goes first');
    assert.deepEqual(tree().children[1].tabIds, [a]);
  });

  test('TL-04: dropping on a pane centre moves the tab into that group', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    const rightPane = leafOf(b).id;

    // Drag `a` into the right-hand group.
    S.getState().dropTabOnPane(a, rightPane, 'center');
    assert.equal(leaves().length, 1, 'source group is pruned once empty');
    assert.deepEqual(leaves()[0].tabIds, [b, a]);
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('TL-05: splitting a group off its only tab is a no-op', async () => {
    const a = leaves()[0].tabIds[0];
    const before = JSON.stringify(tree());
    S.getState().dropTabOnPane(a, 'pane-root', 'right');
    assert.equal(JSON.stringify(tree()), before, 'tree must be unchanged');
    assert.equal(leaves().length, 1);
  });

  test('TL-06: dropping a tab back on its own group just focuses it', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    assert.equal(leaves()[0].activeTabId, b);
    S.getState().dropTabOnPane(a, 'pane-root', 'center');
    assert.equal(leaves().length, 1);
    assert.deepEqual(leaves()[0].tabIds, [a, b], 'order is preserved');
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('TL-07: closing the last tab of a group collapses that group', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    assert.equal(leaves().length, 2);

    await S.getState().closeTab(b);
    assert.equal(leaves().length, 1, 'emptied group is removed');
    assert.deepEqual(leaves()[0].tabIds, [a]);
    assert.ok(leaves().some((l) => l.id === S.getState().activePaneId), 'active pane still exists');
  });

  test('TL-08: closing a group kills only the tabs no other group shows', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    const rightPane = leafOf(b).id;

    await S.getState().closePane(rightPane);
    assert.equal(leaves().length, 1);
    assert.ok(!S.getState().tabs.some((t) => t.id === b), 'its tab is gone');
    assert.ok(S.getState().tabs.some((t) => t.id === a), 'the other tab survives');
  });

  test('TL-09: a tab dropped on an unknown pane is ignored', async () => {
    const a = leaves()[0].tabIds[0];
    const before = JSON.stringify(tree());
    S.getState().dropTabOnPane(a, 'pane-does-not-exist', 'center');
    assert.equal(JSON.stringify(tree()), before);
  });

  test('TL-10: every tab lives in exactly one group after a shuffle', async () => {
    const ids = [leaves()[0].tabIds[0]];
    for (let i = 0; i < 3; i++) ids.push((await S.getState().createTab()).id);

    S.getState().dropTabOnPane(ids[1], 'pane-root', 'right');
    S.getState().dropTabOnPane(ids[2], leafOf(ids[1]).id, 'bottom');
    S.getState().dropTabOnPane(ids[3], leafOf(ids[0]).id, 'center');
    S.getState().dropTabOnPane(ids[0], leafOf(ids[2]).id, 'center');

    const placements = ids.map((id) => leaves().filter((l) => l.tabIds.includes(id)).length);
    assert.deepEqual(placements, [1, 1, 1, 1], 'no tab is duplicated or lost');
    assert.ok(leaves().every((l) => l.tabIds.length > 0), 'no empty group survives');
    assert.ok(
      leaves().every((l) => l.tabIds.includes(l.activeTabId)),
      'each group shows one of its own tabs'
    );
  });
});

describe('Terminal layout: rename, group names, and persistence', () => {
  // Node has no localStorage — shim it per test so these cases never see
  // another test's leftovers, and restore whatever was there (nothing, in
  // this runner) afterwards so the plain drag/drop suite above stays exactly
  // as it was.
  let savedGlobalLocalStorage;

  beforeEach(async () => {
    savedGlobalLocalStorage = globalThis.localStorage;
    const backing = new Map();
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
      clear: () => backing.clear(),
    };

    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();
  });

  afterEach(() => {
    if (savedGlobalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = savedGlobalLocalStorage;
  });

  test('TL-11: renaming a tab sets its title; an empty name resets to the default', () => {
    const tabId = leaves()[0].tabIds[0];
    S.getState().renameTab(tabId, '  My Shell  ');
    assert.equal(S.getState().tabs.find((t) => t.id === tabId).title, 'My Shell', 'trimmed and applied');

    S.getState().renameTab(tabId, '   ');
    assert.equal(
      S.getState().tabs.find((t) => t.id === tabId).title,
      'Terminal 1',
      'blank name falls back to the auto-generated default'
    );
  });

  test('TL-12: naming a group sets the leaf\'s name; an empty name clears it', () => {
    const paneId = leaves()[0].id;
    assert.equal(leaves()[0].name, undefined, 'unnamed by default');

    S.getState().renameGroup(paneId, 'Server Logs');
    assert.equal(leaves().find((l) => l.id === paneId).name, 'Server Logs');

    S.getState().renameGroup(paneId, '   ');
    assert.equal(leaves().find((l) => l.id === paneId).name, undefined, 'blank name clears it back to unnamed');
  });

  test('TL-13: saveState/loadState round-trip an equal structure', () => {
    const payload = { splitTree: { a: 1, list: [1, 2, 3] }, tabs: [{ id: 't1', title: 'X' }], activePaneId: 'p1' };
    assert.equal(saveState('test:roundtrip', payload), true);
    assert.deepEqual(loadState('test:roundtrip', 'FALLBACK'), payload);
  });

  test('TL-14: a corrupted payload is ignored and returns the fallback', () => {
    globalThis.localStorage.setItem('test:corrupt', 'not even json{{{');
    assert.equal(loadState('test:corrupt', 'FALLBACK'), 'FALLBACK');
  });

  test('TL-15: an old-version payload is ignored and returns the fallback', () => {
    globalThis.localStorage.setItem('test:old-version', JSON.stringify({ version: -1, data: { x: 1 } }));
    assert.equal(loadState('test:old-version', 'FALLBACK'), 'FALLBACK');
  });

  test('TL-16: a saved workspace (tree shape, group name, tab title) is restored on relaunch', async () => {
    const a = leaves()[0].tabIds[0];
    S.getState().renameTab(a, 'Main');
    const newPaneId = await S.getState().splitPane(S.getState().activePaneId, 'horizontal');
    S.getState().renameGroup(newPaneId, 'Logs');

    // Let the ~300ms debounced write-behind flush to (shimmed) localStorage.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(loadState(PERSIST_KEY, null), 'something was persisted');

    // Simulate an app relaunch: reset to the pristine pre-init shape and
    // call init() again — it should rebuild from what was just saved.
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();

    assert.equal(leaves().length, 2, 'both groups come back');
    assert.ok(S.getState().tabs.some((t) => t.title === 'Main'), 'tab title survives');
    assert.ok(leaves().some((l) => l.name === 'Logs'), 'group name survives');
    assert.ok(
      leaves().every((l) => l.tabIds.every((id) => S.getState().tabs.some((t) => t.id === id))),
      'every restored tab id resolves to a real tab'
    );
  });

  test('TL-17: a corrupted saved layout falls back to the single-terminal default instead of crashing', async () => {
    globalThis.localStorage.setItem(PERSIST_KEY, 'not even json{{{');
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();

    assert.equal(leaves().length, 1);
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Terminal 1');
  });

  test('TL-18: a saved layout with no valid tabs falls back to the single-terminal default', async () => {
    saveState(PERSIST_KEY, {
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      tabs: [],
      activePaneId: 'pane-root',
    });
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();

    assert.equal(leaves().length, 1);
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Terminal 1');
  });

  test("TL-19: a pty-cwd event updates only the emitting tab's cwd, and the store cwd only when it is active", async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id; // createTab makes b the active tab
    const sessionA = S.getState().tabs.find((t) => t.id === a).sessionId;
    const sessionB = S.getState().tabs.find((t) => t.id === b).sessionId;
    const originalACwd = S.getState().tabs.find((t) => t.id === a).cwd;
    const originalBCwd = S.getState().tabs.find((t) => t.id === b).cwd;

    assert.equal(S.getState().activeTabId, b, 'sanity: b is the active tab');

    // b is active — updating a's (inactive) session must not touch b or the store cwd.
    await mockBridge.emit('pty-cwd', { session_id: sessionA, cwd: '/workspace/a-moved' });
    assert.equal(S.getState().tabs.find((t) => t.id === a).cwd, '/workspace/a-moved', "a's own cwd updates");
    assert.equal(S.getState().tabs.find((t) => t.id === b).cwd, originalBCwd, "b's cwd is untouched by a's event");
    assert.notEqual(S.getState().cwd, '/workspace/a-moved', 'an inactive tab moving must not change the store cwd');
    assert.notEqual(originalACwd, '/workspace/a-moved', 'sanity: this really was a change');

    // b is active — updating its session must also update the store's cwd.
    await mockBridge.emit('pty-cwd', { session_id: sessionB, cwd: '/workspace/b-moved' });
    assert.equal(S.getState().tabs.find((t) => t.id === b).cwd, '/workspace/b-moved');
    assert.equal(S.getState().cwd, '/workspace/b-moved', "the active tab's cwd change updates the store cwd too");
    assert.equal(S.getState().tabs.find((t) => t.id === a).cwd, '/workspace/a-moved', "a is untouched by b's event");
  });

  test('TL-20: an unknown session id in a pty-cwd event is ignored', async () => {
    const before = JSON.stringify(S.getState().tabs);
    await mockBridge.emit('pty-cwd', { session_id: 'pty-does-not-exist', cwd: '/nowhere' });
    assert.equal(JSON.stringify(S.getState().tabs), before, 'tabs must be unchanged');
  });

  test('TL-21: the persisted payload carries a cwd updated via pty-cwd', async () => {
    const a = leaves()[0].tabIds[0];
    const sessionA = S.getState().tabs.find((t) => t.id === a).sessionId;
    await mockBridge.emit('pty-cwd', { session_id: sessionA, cwd: '/workspace/persisted-cwd' });

    // Let the debounced write-behind flush to (shimmed) localStorage.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const saved = loadState(PERSIST_KEY, null);
    assert.ok(saved, 'something was persisted');
    const savedTab = saved.tabs.find((t) => t.id === a);
    assert.ok(savedTab, 'the tab is present in the persisted payload');
    assert.equal(savedTab.cwd, '/workspace/persisted-cwd', 'the persisted cwd reflects the OSC 7 update');
  });

  test("TL-22: duplicateTab opens a new terminal in the same group, at the source tab's live cwd, and activates it", async () => {
    const a = leaves()[0].tabIds[0];
    const sessionA = S.getState().tabs.find((t) => t.id === a).sessionId;
    await mockBridge.emit('pty-cwd', { session_id: sessionA, cwd: '/workspace/deep/dir' });

    const dup = await S.getState().duplicateTab(a);
    assert.ok(dup, 'duplicateTab returns the new tab');
    assert.equal(dup.cwd, '/workspace/deep/dir', "duplicate opens in the source tab's live (not original) cwd");
    assert.equal(leafOf(dup.id).id, leafOf(a).id, 'lands in the same group as the source tab');
    assert.equal(S.getState().activeTabId, dup.id, 'the duplicate becomes the active tab');
    assert.equal(leaves().length, 1, 'duplicating never splits');
  });

  test('TL-23: group focus mode round-trips through persistence', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    const paneB = leafOf(b).id;

    assert.equal(S.getState().groupViewMode, 'split', 'starts in split view');
    S.getState().focusGroup(paneB);
    assert.equal(S.getState().groupViewMode, 'focus');
    assert.equal(S.getState().focusedPaneId, paneB);
    assert.equal(S.getState().activePaneId, paneB, 'focusing a group also makes it the active pane');

    // Let the debounced write-behind flush to (shimmed) localStorage.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(loadState(PERSIST_KEY, null), 'something was persisted');

    // Simulate an app relaunch.
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();

    assert.equal(S.getState().groupViewMode, 'focus', 'focus mode survives a relaunch');
    assert.ok(
      leaves().some((l) => l.id === S.getState().focusedPaneId),
      'the restored focused pane id resolves to a real group'
    );

    // "All" returns to the normal split view without touching the tree.
    const treeBeforeShowAll = tree();
    S.getState().showAllGroups();
    assert.equal(S.getState().groupViewMode, 'split');
    assert.equal(tree(), treeBeforeShowAll, 'showing all groups does not rebuild the split tree');
  });

  test('TL-24: a stale/closed focus target is dropped on restore instead of restoring into a dead focus mode', async () => {
    saveState(PERSIST_KEY, {
      splitTree: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [
          { type: 'leaf', id: 'pane-root', tabIds: ['tab-x'], activeTabId: 'tab-x' },
          { type: 'leaf', id: 'pane-2', tabIds: ['tab-y'], activeTabId: 'tab-y' },
        ],
      },
      tabs: [
        { id: 'tab-x', title: 'X', cwd: '/workspace' },
        { id: 'tab-y', title: 'Y', cwd: '/workspace' },
      ],
      activePaneId: 'pane-root',
      groupViewMode: 'focus',
      focusedPaneId: 'pane-that-no-longer-exists',
    });
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();

    assert.equal(S.getState().groupViewMode, 'split', 'falls back to split view rather than a dead focus target');
    assert.equal(S.getState().focusedPaneId, null);
  });
});

describe('Terminal groups panel: saved groups and tab management', () => {
  let savedLocalStorage;

  beforeEach(async () => {
    // Node has no localStorage; shim it so saved groups round-trip in-memory.
    savedLocalStorage = globalThis.localStorage;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };

    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [] });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
      groupViewMode: 'split',
      focusedPaneId: null,
    });
    await S.getState().init();
  });

  const restoreLocalStorage = () => {
    if (savedLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = savedLocalStorage;
  };

  test('SG-01: saveGroup snapshots the group’s terminals with their live cwd', async () => {
    const group = leaves()[0];
    const tabId = group.tabIds[0];
    // The shell reporting a new cwd (OSC 7) must be what gets saved.
    S.setState((st) => ({ tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, cwd: '/srv/api' } : t)) }));
    S.getState().renameTab(tabId, 'api');

    const entry = S.getState().saveGroup(group.id, 'backend');
    assert.ok(entry, 'a snapshot is returned');
    assert.equal(entry.name, 'backend');
    assert.deepEqual(entry.tabs, [{ title: 'api', cwd: '/srv/api' }]);
    assert.equal(S.getState().savedGroups.length, 1);
    restoreLocalStorage();
  });

  test('SG-02: loadSavedGroup re-opens it as a new group, leaving the original alone', async () => {
    const group = leaves()[0];
    const tabId = group.tabIds[0];
    S.setState((st) => ({ tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, cwd: '/srv/api' } : t)) }));
    const entry = S.getState().saveGroup(group.id, 'backend');

    const newPaneId = await S.getState().loadSavedGroup(entry.id);
    const loaded = leaves().find((l) => l.id === newPaneId);
    assert.equal(leaves().length, 2, 'the saved group is added beside the original');
    assert.equal(loaded.tabIds.length, 1);
    assert.equal(S.getState().tabs.find((t) => t.id === loaded.tabIds[0]).cwd, '/srv/api');
    assert.ok(leaves().some((l) => l.id === group.id), 'the original group survives');
    restoreLocalStorage();
  });

  test('SG-03: rename and delete round-trip through storage', async () => {
    const entry = S.getState().saveGroup(leaves()[0].id, 'first');
    S.getState().renameSavedGroup(entry.id, 'renamed');
    assert.equal(S.getState().savedGroups[0].name, 'renamed');
    S.getState().deleteSavedGroup(entry.id);
    assert.equal(S.getState().savedGroups.length, 0);
    restoreLocalStorage();
  });

  test('SG-04: a corrupt saved-groups payload yields an empty list, not a throw', async () => {
    globalThis.localStorage.setItem('nexterm.terminal.savedGroups', '{{{ not json');
    const { loadState } = await import('../../src/lib/persistence.js');
    assert.deepEqual(loadState('nexterm.terminal.savedGroups', []), []);
    restoreLocalStorage();
  });

  test('SG-05: closeOthersInGroup leaves exactly the target terminal', async () => {
    const keep = leaves()[0].tabIds[0];
    await S.getState().createTab();
    await S.getState().createTab();
    assert.equal(leaves()[0].tabIds.length, 3);

    await S.getState().closeOthersInGroup(keep);
    assert.deepEqual(leaves()[0].tabIds, [keep]);
    restoreLocalStorage();
  });

  test('SG-06: closeTabsToTheRight keeps everything up to and including the target', async () => {
    const first = leaves()[0].tabIds[0];
    const second = (await S.getState().createTab()).id;
    await S.getState().createTab();
    assert.equal(leaves()[0].tabIds.length, 3);

    await S.getState().closeTabsToTheRight(second);
    assert.deepEqual(leaves()[0].tabIds, [first, second]);
    restoreLocalStorage();
  });

  test('SG-07: moveTabToNewGroup splits a terminal out; a lone terminal is a no-op', async () => {
    const solo = leaves()[0].tabIds[0];
    assert.equal(S.getState().moveTabToNewGroup(solo), null, 'the only terminal is already its own group');
    assert.equal(leaves().length, 1);

    const second = (await S.getState().createTab()).id;
    S.getState().moveTabToNewGroup(second);
    assert.equal(leaves().length, 2);
    const holder = leaves().find((l) => l.tabIds.includes(second));
    assert.deepEqual(holder.tabIds, [second], 'the moved terminal is alone in its new group');
    restoreLocalStorage();
  });

  test('SG-08: every terminal still belongs to exactly one group after a save/load/close shuffle', async () => {
    await S.getState().createTab();
    const entry = S.getState().saveGroup(leaves()[0].id, 'snapshot');
    await S.getState().loadSavedGroup(entry.id);
    const someTab = leaves()[0].tabIds[0];
    S.getState().moveTabToNewGroup(someTab);

    const counts = S.getState().tabs.map((t) => leaves().filter((l) => l.tabIds.includes(t.id)).length);
    assert.ok(counts.every((c) => c === 1), `every tab in exactly one group, got ${counts}`);
    assert.ok(leaves().every((l) => l.tabIds.length > 0), 'no empty group survives');
    restoreLocalStorage();
  });
});
