/**
 * Terminal GROUPS (two-level layout).
 *
 * The workspace holds several groups; each group owns its own split tree of
 * panes; exactly one group fills the terminal area; switching groups swaps the
 * whole arrangement and every group is remembered exactly as last left, across
 * switches and restarts.
 *
 * These cases cover the model's invariants, the v1 → v2 migration (both the
 * live workspace and the saved-group list), the persist guard, and pane sizes.
 *
 * NOTE ON IMPORT ORDER: the store reads the saved-group list at *module
 * evaluation* time, so the localStorage shim and the v1 saved-groups fixture
 * are installed BEFORE the store is dynamically imported below. Run this file
 * on its own (or first) — if something else imports the store earlier, the
 * module cache means TG-04 sees an empty list.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { loadState, loadVersionedState, SCHEMA_VERSION } from '../../src/lib/persistence.js';

// --- localStorage shim (Node has none) -----------------------------------
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

const WORKSPACE_KEY = 'nexterm.terminal.workspace';
const SAVED_KEY = 'nexterm.terminal.savedGroups';

/** A v1 saved-group list: a flat tab list, no slot ids and no layout at all. */
const V1_SAVED_GROUPS = [
  {
    id: 'saved-v1-a',
    name: 'Old snapshot',
    savedAt: 111,
    tabs: [
      { title: 'Alpha', cwd: '/workspace' },
      { title: 'Beta', cwd: '/workspace/src' },
    ],
  },
];
backing.set(SAVED_KEY, JSON.stringify({ version: 1, data: V1_SAVED_GROUPS }));

const { useTerminalStore: S, PERSIST_KEY, SAVED_GROUPS_KEY, migrateV1Workspace } = await import(
  '../../src/stores/terminalStore.js'
);

/**
 * Seed the v1 saved-group payload and let `init()` read it.
 *
 * The store used to read localStorage during module evaluation, which made
 * this depend on which suite imported the store first; it reads in `init()`
 * now, so the fixture is seeded per-case like every other one.
 */
async function savedGroupsAfterV1Restore() {
  await relaunch({ seed: { [SAVED_KEY]: { version: 1, data: V1_SAVED_GROUPS } } });
  return S.getState().savedGroups;
}
backing.clear();

// --- local tree helpers (the store's are private) ------------------------
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const splitsOf = (node, acc = []) => {
  if (!node || node.type !== 'split') return acc;
  acc.push(node);
  node.children.forEach((c) => splitsOf(c, acc));
  return acc;
};
const groups = () => S.getState().groups;
const groupById = (id) => groups().find((g) => g.id === id);
const activeGroup = () => groupById(S.getState().activeGroupId);
const allPanes = () => groups().flatMap((g) => leavesOf(g.tree));
const panesHolding = (tabId) => allPanes().filter((p) => p.tabIds.includes(tabId));
const groupHolding = (tabId) => groups().find((g) => leavesOf(g.tree).some((l) => l.tabIds.includes(tabId)));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for the store's 300ms debounced write-behind to land. */
const flushPersist = () => wait(400);

/**
 * Simulate an app (re)launch. `keepStorage` leaves the persisted payload in
 * place so `init()` restores from it; `seed` writes raw versioned payloads
 * first (that is how an *older* schema gets in, since `saveState` always
 * stamps the current one).
 */
async function relaunch({ keepStorage = false, seed = null, savedGroups = null } = {}) {
  S.getState().dispose(); // also kills any pending persist timer from a prior case
  if (!keepStorage) backing.clear();
  if (seed) {
    for (const [key, payload] of Object.entries(seed)) {
      backing.set(key, typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  }
  S.setState({ tabs: [], activeTabId: null, isInitialized: false });
  if (savedGroups) S.setState({ savedGroups });
  await S.getState().init();
}

/**
 * Every invariant of the two-level model, checked against the whole store.
 */
function assertInvariants(msg = 'invariants') {
  const st = S.getState();

  assert.ok(st.groups.length >= 1, `${msg}: there is always at least one group`);

  const seenGroupIds = new Set();
  const seenPaneIds = new Set();
  const paneOfTab = new Map();

  for (const g of st.groups) {
    assert.ok(!seenGroupIds.has(g.id), `${msg}: duplicate group id ${g.id}`);
    seenGroupIds.add(g.id);
    assert.ok(g.tree, `${msg}: group ${g.id} has a tree`);

    const leaves = leavesOf(g.tree);
    assert.ok(leaves.length >= 1, `${msg}: group ${g.id} has at least one pane`);
    assert.ok(
      leaves.some((l) => l.id === g.activePaneId),
      `${msg}: group ${g.id} activePaneId (${g.activePaneId}) names one of its own panes`
    );

    for (const leaf of leaves) {
      assert.ok(!seenPaneIds.has(leaf.id), `${msg}: pane id ${leaf.id} is used in two groups`);
      seenPaneIds.add(leaf.id);

      if (leaf.tabIds.length === 0) {
        assert.equal(leaf.activeTabId, null, `${msg}: empty pane ${leaf.id} has a null activeTabId`);
      } else {
        assert.ok(
          leaf.tabIds.includes(leaf.activeTabId),
          `${msg}: pane ${leaf.id} shows one of its own tabs`
        );
      }

      for (const tabId of leaf.tabIds) {
        assert.ok(
          !paneOfTab.has(tabId),
          `${msg}: tab ${tabId} is in two panes (${paneOfTab.get(tabId)} and ${leaf.id})`
        );
        paneOfTab.set(tabId, leaf.id);
        assert.ok(st.tabs.some((t) => t.id === tabId), `${msg}: pane ${leaf.id} references a live tab`);
      }
    }

    for (const split of splitsOf(g.tree)) {
      assert.ok(split.children.length >= 2, `${msg}: split ${split.id} has at least two children`);
      if (split.sizes !== undefined) {
        assert.equal(
          split.sizes.length,
          split.children.length,
          `${msg}: split ${split.id} has one size per child`
        );
      }
    }
  }

  // Every live tab is placed somewhere (the only tabs that may be unplaced are
  // ones mid-spawn, and no action leaves the store in that state).
  for (const tab of st.tabs) {
    assert.ok(paneOfTab.has(tab.id), `${msg}: tab ${tab.id} is not in any pane`);
  }

  assert.ok(
    st.groups.some((g) => g.id === st.activeGroupId),
    `${msg}: activeGroupId names an existing group`
  );

  const active = st.groups.find((g) => g.id === st.activeGroupId);
  const inActiveGroup = new Set(leavesOf(active.tree).flatMap((l) => l.tabIds));
  if (st.activeTabId === null) {
    assert.equal(inActiveGroup.size, 0, `${msg}: activeTabId is null only when the active group is empty`);
  } else {
    assert.ok(st.tabs.some((t) => t.id === st.activeTabId), `${msg}: activeTabId is a real tab`);
    assert.ok(inActiveGroup.has(st.activeTabId), `${msg}: activeTabId lives in the ACTIVE group`);
  }

  // The deleted focus hack must not creep back.
  assert.equal(st.splitTree, undefined, `${msg}: splitTree is gone`);
  assert.equal(st.groupViewMode, undefined, `${msg}: groupViewMode is gone`);
  assert.equal(st.focusedPaneId, undefined, `${msg}: focusedPaneId is gone`);
}

// =========================================================================
describe('Terminal groups: v1 → v2 migration', () => {
  /** Two v1 groups (leaves), one of them named, split apart, in focus mode. */
  const v1Workspace = () => ({
    version: 1,
    data: {
      splitTree: {
        type: 'split',
        id: 'split-9',
        direction: 'horizontal',
        children: [
          { type: 'leaf', id: 'pane-11', tabIds: ['tab-a'], activeTabId: 'tab-a' },
          { type: 'leaf', id: 'pane-12', name: 'Logs', tabIds: ['tab-b'], activeTabId: 'tab-b' },
        ],
      },
      tabs: [
        { id: 'tab-a', title: 'Main', cwd: '/workspace' },
        { id: 'tab-b', title: 'Server', cwd: '/workspace/src' },
      ],
      activePaneId: 'pane-11',
      groupViewMode: 'focus',
      focusedPaneId: 'pane-12',
    },
  });

  test('TG-01: a v1 workspace becomes one group per v1 leaf, names and tabs intact', async () => {
    await relaunch({ seed: { [WORKSPACE_KEY]: v1Workspace() } });

    assert.equal(groups().length, 2, 'each v1 leaf (which already WAS a group) becomes a v2 group');
    assert.deepEqual(
      groups().map((g) => g.name),
      ['Group 1', 'Logs'],
      'the named leaf keeps its name, the unnamed one gets a positional default — in sibling order'
    );
    assert.equal(S.getState().tabs.length, 2, 'both tabs are restored');
    assert.deepEqual(
      S.getState().tabs.map((t) => t.title).sort(),
      ['Main', 'Server'],
      'tab titles survive'
    );
    // Each group owns exactly one pane — the v1 leaf's own id.
    assert.deepEqual(groups().map((g) => leavesOf(g.tree).length), [1, 1]);
    assert.deepEqual(groups().map((g) => g.tree.id), ['pane-11', 'pane-12']);

    const focusTarget = groups().find((g) => g.tree.id === 'pane-12');
    assert.equal(
      S.getState().activeGroupId,
      focusTarget.id,
      'the v1 focus target becomes the active group'
    );
    assert.equal(S.getState().activeTabId, 'tab-b', 'and its terminal is the active tab');
    assertInvariants('TG-01');
  });

  test('TG-02: without focus mode the active group is the one holding v1 activePaneId', async () => {
    const payload = v1Workspace();
    payload.data.groupViewMode = 'split';
    await relaunch({ seed: { [WORKSPACE_KEY]: payload } });

    const holder = groups().find((g) => g.tree.id === 'pane-11');
    assert.equal(S.getState().activeGroupId, holder.id);
    assert.equal(S.getState().activeTabId, 'tab-a');
    assertInvariants('TG-02');
  });

  test('TG-03: migrateV1Workspace drops the split nodes between leaves and keeps sibling order', () => {
    const migrated = migrateV1Workspace(v1Workspace().data);
    assert.equal(migrated.groups.length, 2);
    for (const g of migrated.groups) {
      assert.equal(g.tree.type, 'leaf', 'a migrated group is a single pane — the v1 split has no referent');
    }
    assert.deepEqual(migrated.groups.map((g) => g.tree.id), ['pane-11', 'pane-12'], 'sibling order preserved');
    assert.equal(migrated.activeGroupId, migrated.groups[1].id);
    assert.equal(migrateV1Workspace(null), null);
    assert.equal(migrateV1Workspace({ tabs: [], splitTree: null }), null);
  });

  test('TG-04: a v1 savedGroups payload survives the SCHEMA_VERSION bump', async () => {
    assert.equal(SAVED_GROUPS_KEY, SAVED_KEY);
    const savedGroups = await savedGroupsAfterV1Restore();
    assert.equal(savedGroups.length, 1, 'the v1 saved group is migrated, not discarded');

    const entry = savedGroups[0];
    assert.equal(entry.id, 'saved-v1-a');
    assert.equal(entry.name, 'Old snapshot');
    assert.equal(entry.savedAt, 111);
    assert.equal(entry.tabs.length, 2, 'tabs stays a flat array — the panel renders entry.tabs.length');
    assert.deepEqual(entry.tabs.map((t) => t.slotId), ['slot-0', 'slot-1'], 'stable slot ids are synthesized');
    assert.deepEqual(entry.tabs.map((t) => t.title), ['Alpha', 'Beta']);
    assert.ok(entry.tree, 'a single-pane tree is synthesized for it');
    assert.deepEqual(entry.tree.tabIds, ['slot-0', 'slot-1'], "the tree references slot ids, not tab ids");
    assert.equal(entry.activePaneId, entry.tree.id);
  });

  test('TG-05: loadState would have thrown the v1 payload away — loadVersionedState is what saves it', () => {
    backing.clear();
    backing.set(WORKSPACE_KEY, JSON.stringify(v1Workspace()));
    assert.equal(loadState(WORKSPACE_KEY, 'FALLBACK'), 'FALLBACK', 'the version gate rejects v1');
    const versioned = loadVersionedState(WORKSPACE_KEY);
    assert.equal(versioned.version, 1, 'but the raw payload is still reachable');
    assert.ok(versioned.data.splitTree, 'with its v1 shape intact');
    assert.equal(SCHEMA_VERSION, 2);
  });

  test('TG-06: an unrecognised schema version bootstraps instead of guessing', async () => {
    await relaunch({ seed: { [WORKSPACE_KEY]: { version: 99, data: { groups: [], tabs: [] } } } });
    assert.equal(groups().length, 1);
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Terminal 1');
    assertInvariants('TG-06');
  });

  test('TG-07: a v2 payload is restored as-is, groups and all', async () => {
    await relaunch();
    const g1 = activeGroup().id;
    await S.getState().createGroup({ name: 'Build' });
    await flushPersist();

    await relaunch({ keepStorage: true });
    assert.equal(groups().length, 2, 'both groups come back');
    assert.ok(groupById(g1), 'group ids survive a relaunch unchanged');
    assert.deepEqual(groups().map((g) => g.name), ['Group 1', 'Build'], 'names and switcher order survive');
    assert.equal(S.getState().tabs.length, 2, 'one terminal per group is respawned');
    assertInvariants('TG-07');
  });
});

// =========================================================================
describe('Terminal groups: invariants under mutation', () => {
  beforeEach(async () => {
    await relaunch();
  });

  test('TG-10: a new tab joins the active group\'s active pane and shows there', async () => {
    const before = leavesOf(activeGroup().tree).length;
    const tab = await S.getState().createTab();
    assert.equal(leavesOf(activeGroup().tree).length, before, 'creating a tab must not split');
    assert.equal(panesHolding(tab.id).length, 1, 'exactly one pane holds it');
    assert.equal(panesHolding(tab.id)[0].activeTabId, tab.id);
    assert.equal(S.getState().activeTabId, tab.id);
    assertInvariants('TG-10');
  });

  test('TG-11: splitting a pane adds a sibling with even sizes inside the SAME group', async () => {
    const gid = activeGroup().id;
    const newPaneId = await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);

    assert.equal(groups().length, 1, 'a split never creates a group');
    const tree = groupById(gid).tree;
    assert.equal(tree.type, 'split');
    assert.equal(tree.direction, 'horizontal');
    assert.equal(tree.children.length, 2);
    assert.deepEqual(tree.sizes, [50, 50], 'a fresh split is an even percentage split');
    assert.ok(leavesOf(tree).some((l) => l.id === newPaneId));
    assertInvariants('TG-11');
  });

  test('TG-12: moving a tab between groups leaves it in exactly ONE pane across ALL groups', async () => {
    const firstGroupId = activeGroup().id;
    const movingTab = S.getState().tabs[0].id;
    const other = await S.getState().createGroup({ name: 'Target' });

    // Give the source group a second terminal so it does not vanish under us.
    S.getState().setActiveGroup(firstGroupId);
    await S.getState().createTab();

    S.getState().moveTabToGroup(movingTab, other.id);

    assert.equal(panesHolding(movingTab).length, 1, 'exactly one pane holds the moved tab');
    assert.equal(groupHolding(movingTab).id, other.id, 'and it is in the target group');
    assert.equal(S.getState().activeGroupId, other.id, 'the target group comes on screen');
    assert.equal(S.getState().activeTabId, movingTab);
    assert.equal(
      groupById(firstGroupId).tree.tabIds.includes(movingTab),
      false,
      'the source group no longer lists it'
    );
    assertInvariants('TG-12');
  });

  test('TG-13: switching groups swaps the whole arrangement and moves the active tab', async () => {
    const g1 = activeGroup().id;
    const g1Tab = S.getState().tabs[0].id;
    await S.getState().splitPane(activeGroup().activePaneId, 'vertical', g1);
    const g1Shape = JSON.stringify(groupById(g1).tree);

    const g2 = (await S.getState().createGroup({ name: 'Second' })).id;
    assert.equal(S.getState().activeGroupId, g2);
    assert.equal(leavesOf(groupById(g2).tree).length, 1, 'the new group starts with one pane');
    assert.notEqual(S.getState().activeTabId, g1Tab, 'the active tab moved into the new group');

    S.getState().setActiveGroup(g1);
    assert.equal(
      JSON.stringify(groupById(g1).tree),
      g1Shape,
      'the first group comes back exactly as it was left'
    );
    assert.ok(
      leavesOf(groupById(g1).tree).flatMap((l) => l.tabIds).includes(S.getState().activeTabId),
      'the active tab follows the active group'
    );
    // The other group's terminals keep running — they are still live tabs.
    assert.ok(
      leavesOf(groupById(g2).tree).flatMap((l) => l.tabIds).every((id) =>
        S.getState().tabs.some((t) => t.id === id)
      ),
      'the inactive group keeps its terminals'
    );
    assertInvariants('TG-13');
  });

  test('TG-14: closing a tab sweeps ALL groups, not just the active tree', async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Background' });
    const backgroundTab = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    S.getState().setActiveGroup(g1);
    assert.notEqual(S.getState().activeGroupId, other.id, 'the tab we close is in a NON-active group');

    await S.getState().closeTab(backgroundTab);

    assert.equal(panesHolding(backgroundTab).length, 0, 'no pane in any group still lists it');
    assert.equal(S.getState().tabs.some((t) => t.id === backgroundTab), false);
    assertInvariants('TG-14');
  });

  test('TG-15: a group emptied of tabs is removed — unless it is the last one, which is emptied', async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Doomed' });
    const doomedTab = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    await S.getState().closeTab(doomedTab);
    assert.equal(groups().length, 1, 'a group whose tree prunes to nothing is removed');
    assert.equal(groups()[0].id, g1);
    assert.equal(S.getState().activeGroupId, g1, 'the surviving group is on screen');
    assertInvariants('TG-15a');

    // Now empty the LAST group.
    for (const t of [...S.getState().tabs]) await S.getState().closeTab(t.id);
    assert.equal(groups().length, 1, 'the last group is kept');
    assert.equal(leavesOf(groups()[0].tree).length, 1, 'and emptied down to one empty pane');
    assert.deepEqual(groups()[0].tree.tabIds, []);
    assert.equal(S.getState().activeTabId, null);
    assertInvariants('TG-15b');
  });

  test('TG-16: closing a pane in a non-active group kills only the terminals it owned', async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Two panes' });
    const keptTab = leavesOf(groupById(other.id).tree)[0].tabIds[0];
    const newPaneId = await S.getState().splitPane(groupById(other.id).activePaneId, 'horizontal', other.id);
    const doomedTab = allPanes().find((p) => p.id === newPaneId).tabIds[0];

    S.getState().setActiveGroup(g1);
    await S.getState().closePane(newPaneId, other.id);

    assert.equal(S.getState().tabs.some((t) => t.id === doomedTab), false, 'its terminal is gone');
    assert.ok(S.getState().tabs.some((t) => t.id === keptTab), 'the sibling pane keeps its terminal');
    assert.equal(leavesOf(groupById(other.id).tree).length, 1, 'the split collapsed');
    assert.equal(S.getState().activeGroupId, g1, 'the active group did not move');
    assertInvariants('TG-16');
  });

  test('TG-17: pane and group ids stay unique across every group', async () => {
    await S.getState().createGroup({ name: 'A' });
    await S.getState().createGroup({ name: 'B' });
    for (const g of groups()) await S.getState().splitPane(g.activePaneId, 'horizontal', g.id);

    const paneIds = allPanes().map((p) => p.id);
    assert.equal(new Set(paneIds).size, paneIds.length, 'no pane id is reused across groups');
    const groupIds = groups().map((g) => g.id);
    assert.equal(new Set(groupIds).size, groupIds.length);
    assertInvariants('TG-17');
  });

  test('TG-18: focusNextPane walks ONLY the active group', async () => {
    const g1 = activeGroup().id;
    await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', g1);
    const other = await S.getState().createGroup({ name: 'Elsewhere' });
    S.getState().setActiveGroup(g1);

    const ids = leavesOf(groupById(g1).tree).map((l) => l.id);
    const before = groupById(g1).activePaneId;
    S.getState().focusNextPane(1);
    const after = groupById(g1).activePaneId;

    assert.notEqual(after, before);
    assert.ok(ids.includes(after), 'focus stayed inside the active group');
    assert.equal(S.getState().activeGroupId, g1, 'cycling panes never leaves the group');
    assert.equal(
      groupById(other.id).activePaneId,
      leavesOf(groupById(other.id).tree)[0].id,
      "the other group's focus is untouched"
    );
    assertInvariants('TG-18');
  });

  test('TG-19: dropping a tab on a pane in another group splits that group, not this one', async () => {
    const g1 = activeGroup().id;
    await S.getState().createTab(); // g1 now has two tabs in one pane
    const dragged = S.getState().tabs[1].id;
    const other = await S.getState().createGroup({ name: 'Drop target' });
    const targetPaneId = groupById(other.id).activePaneId;

    S.getState().setActiveGroup(g1);
    S.getState().dropTabOnPane(dragged, targetPaneId, 'right', other.id);

    assert.equal(leavesOf(groupById(other.id).tree).length, 2, 'the target group split');
    assert.equal(leavesOf(groupById(g1).tree).length, 1, 'the source group did not');
    assert.equal(panesHolding(dragged).length, 1);
    assert.equal(groupHolding(dragged).id, other.id);
    assert.equal(S.getState().activeGroupId, other.id, 'the drop brings its group on screen');
    assertInvariants('TG-19');
  });

  test('TG-20: moveTabToNewPane splits in place; moveTabToNewGroup makes a real group', async () => {
    const g1 = activeGroup().id;
    const extra = await S.getState().createTab();

    const newPaneId = S.getState().moveTabToNewPane(extra.id, 'vertical');
    assert.ok(newPaneId, 'the old behaviour still works');
    assert.equal(groups().length, 1, 'moveTabToNewPane never creates a group');
    assert.equal(leavesOf(groupById(g1).tree).length, 2);
    assert.equal(groupById(g1).tree.direction, 'vertical');

    const newGroupId = S.getState().moveTabToNewGroup(extra.id);
    assert.ok(newGroupId, 'and the real one creates a group');
    assert.equal(groups().length, 2);
    assert.equal(groupHolding(extra.id).id, newGroupId);
    assert.equal(panesHolding(extra.id).length, 1);
    assert.equal(S.getState().activeGroupId, newGroupId);
    assert.equal(leavesOf(groupById(g1).tree).length, 1, 'the source group collapsed back to one pane');
    assertInvariants('TG-20');
  });

  test('TG-21: switchTab switches to the tab\'s owning group', async () => {
    const g1 = activeGroup().id;
    const homeTab = S.getState().tabs[0].id;
    const other = await S.getState().createGroup({ name: 'Far away' });
    const farTab = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    S.getState().setActiveGroup(g1);
    assert.equal(S.getState().activeTabId, homeTab);

    S.getState().switchTab(farTab);
    assert.equal(S.getState().activeGroupId, other.id, 'the owning group comes on screen');
    assert.equal(S.getState().activeTabId, farTab);
    assertInvariants('TG-21');
  });

  test('TG-22: renameGroup writes the group name (no tree walking) and blank resets it', () => {
    const gid = activeGroup().id;
    S.getState().renameGroup(gid, '  Servers  ');
    assert.equal(groupById(gid).name, 'Servers');
    S.getState().renameGroup(gid, '   ');
    assert.equal(groupById(gid).name, 'Group 1', 'a blank name falls back to the positional default');
    assert.equal(leavesOf(groupById(gid).tree)[0].name, undefined, 'panes no longer carry names at all');
  });

  test('TG-23: the removed focus hack is really gone', () => {
    const st = S.getState();
    assert.equal(typeof st.focusGroup, 'undefined');
    assert.equal(typeof st.showAllGroups, 'undefined');
    assert.equal(typeof st.setActiveGroup, 'function');
    assert.equal(typeof st.createGroup, 'function');
    assert.equal(typeof st.closeGroup, 'function');
    assert.equal(typeof st.moveTabToGroup, 'function');
    assert.equal(typeof st.moveTabToNewPane, 'function');
    assert.equal(typeof st.setPaneSizes, 'function');
  });

  test('TG-24: closeGroup kills its terminals and moves to a neighbour', async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Bye' });
    const doomed = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    await S.getState().closeGroup(other.id);
    assert.equal(groups().length, 1);
    assert.equal(S.getState().activeGroupId, g1);
    assert.equal(S.getState().tabs.some((t) => t.id === doomed), false, 'its terminals are killed');
    assertInvariants('TG-24');
  });
});

// =========================================================================
describe('Terminal groups: persistence, the save guard, and pane sizes', () => {
  beforeEach(async () => {
    await relaunch();
  });

  test('TG-30: a mutation in a NON-ACTIVE group still schedules a save', async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Background' });
    S.getState().setActiveGroup(g1);
    await flushPersist();

    // Purest form of the guard bug: only `groups` changes — not `tabs`, not
    // `activeGroupId`, and not the group that is on screen.
    S.getState().renameGroup(other.id, 'Renamed while off screen');
    await flushPersist();

    const saved = loadState(PERSIST_KEY, null);
    assert.ok(saved, 'something was persisted');
    assert.equal(saved.activeGroupId, g1, 'the active group never changed');
    const persisted = saved.groups.find((g) => g.id === other.id);
    assert.ok(persisted, 'the off-screen group is in the payload');
    assert.equal(
      persisted.name,
      'Renamed while off screen',
      'an activeGroupId-only guard would have missed this write entirely'
    );

    // And a structural change in the same off-screen group.
    await S.getState().splitPane(groupById(other.id).activePaneId, 'horizontal', other.id);
    await flushPersist();
    const saved2 = loadState(PERSIST_KEY, null);
    assert.equal(saved2.groups.find((g) => g.id === other.id).tree.type, 'split');
    assert.equal(S.getState().activeGroupId, g1, 'and it still is not the group on screen');
  });

  test('TG-31: pane sizes survive a persist/restore round trip', async () => {
    const gid = activeGroup().id;
    await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);
    const splitId = groupById(gid).tree.id;

    S.getState().setPaneSizes(gid, splitId, [70, 30]);
    assert.deepEqual(groupById(gid).tree.sizes, [70, 30]);
    await flushPersist();

    const payload = loadState(PERSIST_KEY, null);
    assert.deepEqual(payload.groups[0].tree.sizes, [70, 30], 'sizes are in the serialized payload');

    await relaunch({ keepStorage: true });
    const restored = groups()[0];
    assert.equal(restored.tree.type, 'split');
    assert.deepEqual(restored.tree.sizes, [70, 30], 'and come back on relaunch');
    assertInvariants('TG-31');
  });

  test('TG-32: setPaneSizes normalizes to percentages and rejects a mismatched arity', async () => {
    const gid = activeGroup().id;
    await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);
    const splitId = groupById(gid).tree.id;

    S.getState().setPaneSizes(gid, splitId, [3, 1]);
    assert.deepEqual(groupById(gid).tree.sizes, [75, 25], 'raw ratios become percentages summing to 100');

    S.getState().setPaneSizes(gid, splitId, [50, 30, 20]);
    assert.deepEqual(groupById(gid).tree.sizes, [75, 25], 'a size per child or nothing at all');

    S.getState().setPaneSizes(gid, 'no-such-split', [60, 40]);
    assert.deepEqual(groupById(gid).tree.sizes, [75, 25]);
    assertInvariants('TG-32');
  });

  test('TG-33: sizes are renormalized when a pane is pruned away', async () => {
    const gid = activeGroup().id;
    const p2 = await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);
    S.getState().setPaneSizes(gid, groupById(gid).tree.id, [80, 20]);

    await S.getState().closePane(p2, gid);
    assert.equal(groupById(gid).tree.type, 'leaf', 'the split collapsed to its survivor');
    assertInvariants('TG-33');
  });

  test('TG-34: every group\'s arrangement survives a relaunch, exactly as left', async () => {
    const g1 = activeGroup().id;
    await S.getState().splitPane(activeGroup().activePaneId, 'vertical', g1);
    S.getState().renameGroup(g1, 'Editors');
    const g2 = (await S.getState().createGroup({ name: 'Servers' })).id;
    await S.getState().splitPane(groupById(g2).activePaneId, 'horizontal', g2);
    S.getState().setActiveGroup(g1);

    const shapeBefore = groups().map((g) => ({
      name: g.name,
      panes: leavesOf(g.tree).length,
      direction: g.tree.direction,
    }));
    await flushPersist();

    await relaunch({ keepStorage: true });

    assert.deepEqual(
      groups().map((g) => ({ name: g.name, panes: leavesOf(g.tree).length, direction: g.tree.direction })),
      shapeBefore,
      'both groups come back with their own layout'
    );
    assert.equal(S.getState().tabs.length, 4, 'one fresh PTY per saved terminal');
    assert.equal(groups()[0].name, 'Editors', 'switcher order is preserved');
    assertInvariants('TG-34');
  });

  test('TG-35: id counters are bumped past everything restored', async () => {
    await relaunch({
      seed: {
        [WORKSPACE_KEY]: {
          version: 2,
          data: {
            activeGroupId: 'group-900',
            groups: [
              {
                id: 'group-900',
                name: 'Restored',
                createdAt: 1,
                activePaneId: 'pane-900',
                tree: {
                  type: 'split',
                  id: 'split-900',
                  direction: 'horizontal',
                  sizes: [60, 40],
                  children: [
                    { type: 'leaf', id: 'pane-900', tabIds: ['t1'], activeTabId: 't1' },
                    { type: 'leaf', id: 'pane-901', tabIds: ['t2'], activeTabId: 't2' },
                  ],
                },
              },
            ],
            tabs: [
              { id: 't1', title: 'One', cwd: '/workspace' },
              { id: 't2', title: 'Two', cwd: '/workspace' },
            ],
          },
        },
      },
    });

    assert.deepEqual(groups()[0].tree.sizes, [60, 40]);
    const restoredPaneIds = new Set(allPanes().map((p) => p.id));
    const fresh = await S.getState().splitPane('pane-900', 'vertical', 'group-900');
    assert.equal(restoredPaneIds.has(fresh), false, 'a freshly minted pane id cannot collide with a restored one');
    const g = await S.getState().createGroup({ name: 'New' });
    assert.notEqual(g.id, 'group-900');
    assertInvariants('TG-35');
  });

  test('TG-36: a corrupt workspace payload falls back to the single-terminal default', async () => {
    await relaunch({ seed: { [WORKSPACE_KEY]: 'not even json{{{' } });
    assert.equal(groups().length, 1);
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Terminal 1');
    assertInvariants('TG-36');
  });

  test('TG-37: a v2 payload whose tabs are all gone falls back too', async () => {
    await relaunch({
      seed: {
        [WORKSPACE_KEY]: {
          version: 2,
          data: {
            activeGroupId: 'group-x',
            groups: [
              {
                id: 'group-x',
                name: 'Ghost',
                createdAt: 1,
                activePaneId: 'pane-x',
                tree: { type: 'leaf', id: 'pane-x', tabIds: ['gone'], activeTabId: 'gone' },
              },
            ],
            tabs: [],
          },
        },
      },
    });
    assert.equal(groups().length, 1);
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Terminal 1');
    assertInvariants('TG-37');
  });
});

// =========================================================================
describe('Terminal groups: saved groups carry a layout', () => {
  beforeEach(async () => {
    await relaunch();
    S.setState({ savedGroups: [] });
  });

  test('TG-40: saveGroup snapshots the layout with slot ids, not live tab ids', async () => {
    const gid = activeGroup().id;
    S.getState().renameTab(S.getState().tabs[0].id, 'Left');
    await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);
    S.getState().renameGroup(gid, 'Dev');

    const entry = S.getState().saveGroup(gid, '');
    assert.ok(entry);
    assert.equal(entry.name, 'Dev', 'a blank name falls back to the group name');
    assert.equal(entry.tabs.length, 2, 'tabs is a flat array the panel can count');
    assert.deepEqual(entry.tabs.map((t) => t.slotId), ['slot-0', 'slot-1']);
    assert.equal(entry.tabs[0].title, 'Left');
    assert.equal(entry.tree.type, 'split', 'the pane layout is saved');
    const slotIds = new Set(entry.tabs.map((t) => t.slotId));
    for (const leaf of leavesOf(entry.tree)) {
      for (const id of leaf.tabIds) {
        assert.ok(slotIds.has(id), `saved tree references slot ids only (saw ${id})`);
      }
    }
  });

  test('TG-41: loading a saved group twice cannot collide', async () => {
    const gid = activeGroup().id;
    await S.getState().splitPane(activeGroup().activePaneId, 'horizontal', gid);
    const entry = S.getState().saveGroup(gid, 'Snapshot');

    const first = await S.getState().loadSavedGroup(entry.id);
    const second = await S.getState().loadSavedGroup(entry.id);
    assert.notEqual(first, second, 'each load is its own group');
    assert.equal(groups().length, 3);

    for (const id of [first, second]) {
      assert.equal(leavesOf(groupById(id).tree).length, 2, 'the saved layout is rebuilt, not flattened');
      assert.equal(groupById(id).name, 'Snapshot');
    }
    const paneIds = allPanes().map((p) => p.id);
    assert.equal(new Set(paneIds).size, paneIds.length, 'pane ids are regenerated on every load');
    assert.equal(S.getState().activeGroupId, second, 'the newest load is on screen');
    assertInvariants('TG-41');
  });

  test('TG-42: a migrated v1 saved group still loads', async () => {
    await savedGroupsAfterV1Restore();
    const groupId = await S.getState().loadSavedGroup('saved-v1-a');
    assert.ok(groupId);
    assert.equal(leavesOf(groupById(groupId).tree).length, 1, 'a v1 snapshot rebuilds as a single pane');
    assert.deepEqual(
      leavesOf(groupById(groupId).tree)[0].tabIds.length,
      2,
      'both of its terminals respawn'
    );
    assert.ok(S.getState().tabs.some((t) => t.title === 'Alpha'));
    assert.ok(S.getState().tabs.some((t) => t.title === 'Beta'));
    assertInvariants('TG-42');
  });

  test('TG-43: loadSavedGroup mode:"replace" drops the terminals into the active pane', async () => {
    const gid = activeGroup().id;
    const entry = S.getState().saveGroup(gid, 'One tab');
    const before = leavesOf(activeGroup().tree)[0].tabIds.length;

    const landed = await S.getState().loadSavedGroup(entry.id, { mode: 'replace' });
    assert.equal(landed, gid, 'nothing new is created');
    assert.equal(groups().length, 1);
    assert.equal(leavesOf(groupById(gid).tree)[0].tabIds.length, before + 1);
    assertInvariants('TG-43');
  });
});

describe('Terminal ids never repeat', () => {
  test('TG-50: a terminal spawned in the same millisecond as a closed one gets its own id', async () => {
    // Ids used to be `tab-term-${Date.now()}-${tabs.length + 1}`. tabs.length
    // REWINDS on close, so two terminals a millisecond apart could share an
    // id — and the xterm registry, the placement sweep, closeTab and PTY
    // reaping all key on it, so one terminal's close killed the other's shell.
    const realNow = Date.now;
    Date.now = () => 1757740000000;
    try {
      const minted = [];
      for (let i = 0; i < 5; i += 1) {
        const before = new Set(S.getState().tabs.map((t) => t.id));
        await S.getState().createTab();
        const fresh = S.getState().tabs.map((t) => t.id).find((id) => !before.has(id));
        minted.push(fresh);
        await S.getState().closeTab(fresh);
      }
      assert.equal(new Set(minted).size, minted.length, `ids repeated: ${minted.join(', ')}`);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('Saving the whole workspace, not one group at a time', () => {
  /** A compact drawing of a group's arrangement, e.g. `h([1]v([1][1]))`. */
  const shape = (n) =>
    n.type === 'leaf' ? `[${n.tabIds.length}]` : `${n.direction[0]}(${n.children.map(shape).join('')})`;
  const layout = () => groups().map((g) => `${g.name}${shape(g.tree)}`).join('  ');
  const cwds = () => S.getState().tabs.map((t) => t.cwd).sort().join(',');

  /** Two groups with different arrangements and distinct directories. */
  async function buildSession() {
    await relaunch();
    S.getState().renameGroup(S.getState().activeGroupId, 'Backend');
    const pane = await S.getState().splitPane(S.getState().getActivePaneId(), 'horizontal');
    await S.getState().splitPane(pane, 'vertical');
    await S.getState().createGroup({ name: 'Frontend' });
    await S.getState().splitPane(S.getState().getActivePaneId(), 'vertical');
    // stand in for the live OSC 7 cwd each shell reports
    S.setState((st) => ({ tabs: st.tabs.map((t, i) => ({ ...t, cwd: `/srv/dir${i}` })) }));
  }

  test('TG-60: saveWorkspace snapshots every group, its layout and its directories', async () => {
    await buildSession();
    const entry = S.getState().saveWorkspace('Morning setup');

    assert.ok(entry, 'nothing was saved');
    assert.equal(entry.name, 'Morning setup');
    assert.equal(entry.groups.length, 2, 'both groups are in the snapshot');
    assert.deepEqual(entry.groups.map((g) => g.name), ['Backend', 'Frontend']);
    assert.equal(
      entry.groups.reduce((n, g) => n + g.tabs.length, 0),
      5,
      'every terminal is in the snapshot'
    );
    // the layout is stored by slot id, never by live tab id
    const slots = entry.groups.flatMap((g) => leavesOf(g.tree).flatMap((l) => l.tabIds));
    assert.equal(slots.every((id) => id.startsWith('slot-')), true, `tree references live ids: ${slots}`);
    assert.deepEqual(
      entry.groups.flatMap((g) => g.tabs.map((t) => t.cwd)).sort(),
      ['/srv/dir0', '/srv/dir1', '/srv/dir2', '/srv/dir3', '/srv/dir4'],
      'each terminal keeps the directory it was actually in'
    );
    assertInvariants('TG-60');
  });

  test('TG-61: restoring brings the whole session back, layout and directories alike', async () => {
    await buildSession();
    const before = layout();
    const beforeCwds = cwds();
    const entry = S.getState().saveWorkspace('Morning setup');

    // wreck it: close every group but one, then rearrange what is left
    for (const g of groups().slice(1)) await S.getState().closeGroup(g.id);
    await S.getState().splitPane(S.getState().getActivePaneId(), 'vertical');
    assert.notEqual(layout(), before, 'the session was not actually disturbed');

    await S.getState().loadWorkspace(entry.id, { mode: 'replace' });

    assert.equal(layout(), before, 'the arrangement did not come back');
    assert.equal(cwds(), beforeCwds, 'the directories did not come back');
    assert.equal(S.getState().tabs.length, 5, 'restoring leaked or lost terminals');
    assertInvariants('TG-61');
  });

  test('TG-62: restoring replaces the session; adding keeps what is already open', async () => {
    await buildSession();
    const entry = S.getState().saveWorkspace('Snapshot');

    await S.getState().loadWorkspace(entry.id, { mode: 'append' });
    assert.equal(groups().length, 4, 'append should sit alongside the current groups');
    assert.equal(S.getState().tabs.length, 10, 'append should spawn its own terminals');

    await S.getState().loadWorkspace(entry.id, { mode: 'replace' });
    assert.equal(groups().length, 2, 'replace should leave only the saved groups');
    assert.equal(S.getState().tabs.length, 5, 'replace should reap the terminals it displaced');
    assertInvariants('TG-62');
  });

  test('TG-63: workspaces round-trip through storage and survive a relaunch', async () => {
    await buildSession();
    const entry = S.getState().saveWorkspace('Persisted');
    await flushPersist();

    await relaunch({ keepStorage: true });
    const restored = S.getState().savedWorkspaces;
    assert.equal(restored.length, 1, 'the workspace list did not survive a relaunch');
    assert.equal(restored[0].name, 'Persisted');
    assert.equal(restored[0].groups.length, 2);

    S.getState().renameSavedWorkspace(entry.id, 'Renamed');
    await relaunch({ keepStorage: true });
    assert.equal(S.getState().savedWorkspaces[0].name, 'Renamed', 'rename did not reach storage');

    S.getState().deleteSavedWorkspace(entry.id);
    await relaunch({ keepStorage: true });
    assert.equal(S.getState().savedWorkspaces.length, 0, 'delete did not reach storage');
  });

  test('TG-64: saving an empty session saves nothing', async () => {
    await relaunch();
    for (const tab of [...S.getState().tabs]) await S.getState().closeTab(tab.id);
    assert.equal(S.getState().saveWorkspace('Empty'), null);
    assert.equal(S.getState().savedWorkspaces.length, 0);
  });
});
