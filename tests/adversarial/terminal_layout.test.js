/**
 * Terminal LAYOUT (two-level model): where a dragged tab lands, what a
 * restored workspace actually contains, and the Terminals panel's tab /
 * saved-group commands.
 *
 * Companion file to `terminal_groups.test.js`, which owns the model's
 * invariants, the v1 -> v2 migration, the persist guard and `setPaneSizes`.
 * This file deliberately does NOT re-cover those. It owns:
 *
 *   - every `dropTabOnPane` zone, inside one group's tree and across groups
 *     (including the target group being resolved from the pane id alone);
 *   - the CONTENTS of a restored layout — which tab sits in which pane, in
 *     what order, which one is visible, and which pane/group had focus —
 *     where `terminal_groups.test.js` checks the shape;
 *   - the stale/ambiguous references a saved payload can carry (an orphaned
 *     tab, the same tab in two groups, a dead `activeGroupId`/`activePaneId`);
 *   - `pty-cwd` (OSC 7) and everything that reads a tab's LIVE cwd:
 *     `duplicateTab`, `saveGroup`, `loadSavedGroup`;
 *   - the pane-scoped tab commands and the saved-group list's own storage.
 *
 * (TL-12 is gone: it asserted `leaf.name`, and panes no longer carry names.
 * Group naming is TG-22's.)
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, PERSIST_KEY, SAVED_GROUPS_KEY } from '../../src/stores/terminalStore.js';
import { saveState, loadState } from '../../src/lib/persistence.js';
import { mockBridge } from '../../src/lib/ipc.js';

const S = useTerminalStore;

// --- localStorage shim ----------------------------------------------------
// Node has none. It is installed per test and handed back in `afterEach`, so
// another test file that installs its OWN shim at module-eval time (see
// `terminal_groups.test.js`) keeps working when these run in the same process.
const backing = new Map();
let previousLocalStorage;
let shimInstalled = false;

function installStorageShim() {
  if (!shimInstalled) {
    previousLocalStorage = globalThis.localStorage;
    shimInstalled = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function uninstallStorageShim() {
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

/**
 * Hand the shim back AND cancel the store's pending write-behind: a timer
 * still in flight would otherwise fire ~300ms later and write this file's
 * workspace into whatever `localStorage` is by then.
 */
function teardown() {
  S.getState().dispose();
  uninstallStorageShim();
}

// --- tree helpers (the store's own are private) --------------------------
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groups = () => S.getState().groups;
const groupById = (id) => groups().find((g) => g.id === id);
const activeGroup = () => groupById(S.getState().activeGroupId);
/** The active group's tree — the arrangement currently filling the terminal area. */
const tree = (gid = S.getState().activeGroupId) => groupById(gid)?.tree ?? null;
const panes = (gid) => leavesOf(tree(gid));
const allPanes = () => groups().flatMap((g) => leavesOf(g.tree));
const paneById = (paneId) => allPanes().find((p) => p.id === paneId);
const paneOf = (tabId) => allPanes().find((p) => p.tabIds.includes(tabId));
const panesHolding = (tabId) => allPanes().filter((p) => p.tabIds.includes(tabId));
const groupOf = (tabId) => groups().find((g) => leavesOf(g.tree).some((l) => l.tabIds.includes(tabId)));
const tabById = (tabId) => S.getState().tabs.find((t) => t.id === tabId);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for the store's 300ms debounced write-behind to land. */
const flushPersist = () => wait(400);

/**
 * The ONE fixture: a pristine store, as if the app had just launched.
 *
 * `keepStorage` leaves the persisted payload in place so `init()` restores
 * from it (i.e. a relaunch); `seed` writes raw versioned payloads first, which
 * is the only way an adversarial/older payload gets in — `saveState` always
 * stamps the current version.
 */
async function resetStore({ keepStorage = false, seed = null } = {}) {
  S.getState().dispose(); // also cancels a pending persist timer from a prior case
  installStorageShim();
  if (!keepStorage) backing.clear();
  if (seed) {
    for (const [key, payload] of Object.entries(seed)) {
      backing.set(key, typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  }
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [] });
  await S.getState().init();
}

/**
 * The one cross-cutting rule these cases lean on: a tab is in exactly one
 * pane of exactly one group, every pane shows one of its own tabs, and no
 * live terminal is left with nowhere to be rendered. (The full invariant set
 * is `terminal_groups.test.js`'s `assertInvariants`.)
 */
function assertEveryTabPlacedOnce(msg) {
  const st = S.getState();
  const paneOfTab = new Map();
  const tabIds = st.tabs.map((t) => t.id);
  assert.equal(
    new Set(tabIds).size,
    tabIds.length,
    `${msg}: two live terminals share a tab id — see spawnTab's Date.now-based ids`
  );
  for (const g of st.groups) {
    for (const leaf of leavesOf(g.tree)) {
      for (const id of leaf.tabIds) {
        assert.ok(
          !paneOfTab.has(id),
          `${msg}: tab ${id} is in two panes (${paneOfTab.get(id)} and ${leaf.id})`
        );
        paneOfTab.set(id, leaf.id);
      }
      if (leaf.tabIds.length > 0) {
        assert.ok(
          leaf.tabIds.includes(leaf.activeTabId),
          `${msg}: pane ${leaf.id} must show one of its own tabs`
        );
      }
    }
  }
  for (const t of st.tabs) {
    assert.ok(paneOfTab.has(t.id), `${msg}: live terminal ${t.id} (${t.title}) is in no pane at all`);
  }
}

// =========================================================================
describe('Terminal layout: drag & drop placement across panes and groups', () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(teardown);

  test('TL-01: dropping a tab on a pane\'s right edge splits that pane in two, dragged tab second, evenly sized', async () => {
    const a = panes()[0].tabIds[0];
    const paneA = panes()[0].id;
    const b = (await S.getState().createTab()).id;

    S.getState().dropTabOnPane(b, paneA, 'right');

    assert.equal(groups().length, 1, 'a drop inside a group never creates a group');
    assert.equal(tree().type, 'split');
    assert.equal(tree().direction, 'horizontal', '"right" splits along the horizontal axis');
    assert.equal(panes().length, 2);
    assert.deepEqual(tree().children[0].tabIds, [a], 'the target pane keeps its own tabs, first');
    assert.deepEqual(tree().children[1].tabIds, [b], 'the dragged tab lands in the new pane, second');
    assert.deepEqual(tree().sizes, [50, 50], 'a fresh split is an even percentage split');
    assert.equal(activeGroup().activePaneId, tree().children[1].id, 'the new pane takes focus');
    assert.equal(S.getState().activeTabId, b);
    assertEveryTabPlacedOnce('TL-01');
  });

  test('TL-02: "top"/"left" put the dragged tab BEFORE the target, and nest inside an existing split', async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    const paneA = paneOf(a).id;

    S.getState().dropTabOnPane(b, paneA, 'top');
    assert.equal(tree().direction, 'vertical', '"top" splits along the vertical axis');
    assert.deepEqual(tree().children[0].tabIds, [b], 'the dragged tab goes first');
    assert.deepEqual(tree().children[1].tabIds, [a]);

    // `c` is created in the pane that just took focus (b's), then dragged onto
    // a's pane — which is now a child of an existing split.
    const c = (await S.getState().createTab()).id;
    assert.equal(paneOf(c).id, paneOf(b).id, 'sanity: a new tab joins the focused pane');
    S.getState().dropTabOnPane(c, paneOf(a).id, 'left');

    assert.equal(tree().direction, 'vertical', 'the outer split is untouched');
    assert.deepEqual(tree().children[0].tabIds, [b], "and so is the sibling that wasn't dropped on");
    const inner = tree().children[1];
    assert.equal(inner.type, 'split', 'the drop split the nested pane, not the root');
    assert.equal(inner.direction, 'horizontal', '"left" splits along the horizontal axis');
    assert.deepEqual(inner.children[0].tabIds, [c], 'the dragged tab goes first');
    assert.deepEqual(inner.children[1].tabIds, [a]);
    assertEveryTabPlacedOnce('TL-02');
  });

  test('TL-03: a "center" drop moves the tab into the target pane and prunes the pane it emptied', async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, paneOf(a).id, 'right');
    const paneB = paneOf(b).id;
    assert.equal(panes().length, 2, 'sanity: two panes to move between');

    S.getState().dropTabOnPane(a, paneB, 'center');

    assert.equal(panes().length, 1, 'the emptied source pane is pruned and the split collapses');
    assert.equal(panes()[0].id, paneB, 'the survivor is the pane that was dropped on');
    assert.deepEqual(panes()[0].tabIds, [b, a], 'the dragged tab is appended last');
    assert.equal(panes()[0].activeTabId, a, 'and becomes the visible one');
    assert.equal(S.getState().activeTabId, a);
    assertEveryTabPlacedOnce('TL-03');
  });

  test('TL-04: dropping a pane\'s ONLY tab on its own edge is a no-op, not an empty pane', async () => {
    const a = panes()[0].tabIds[0];
    const before = JSON.stringify(tree());

    S.getState().dropTabOnPane(a, paneOf(a).id, 'right');

    assert.equal(JSON.stringify(tree()), before, 'splitting a pane off its only tab must change nothing');
    assert.equal(panes().length, 1);
    assert.equal(groups().length, 1);
    assertEveryTabPlacedOnce('TL-04');
  });

  test('TL-05: dropping a tab on the centre of its own pane only changes which tab is visible', async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    assert.equal(panes()[0].activeTabId, b, 'sanity: the newest tab is the visible one');

    S.getState().dropTabOnPane(a, paneOf(a).id, 'center');

    assert.equal(panes().length, 1, 'no split, no new pane');
    assert.deepEqual(panes()[0].tabIds, [a, b], 'tab order is preserved — it is not re-appended');
    assert.equal(panes()[0].activeTabId, a);
    assert.equal(S.getState().activeTabId, a);
  });

  test('TL-06: closing the last tab of a pane collapses that pane and leaves focus on a real one', async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, paneOf(a).id, 'right');
    assert.equal(panes().length, 2);

    await S.getState().closeTab(b);

    assert.equal(panes().length, 1, 'the emptied pane is removed and the split collapses');
    assert.deepEqual(panes()[0].tabIds, [a]);
    assert.equal(groups().length, 1, 'the group itself survives — it still has a terminal');
    assert.ok(
      panes().some((p) => p.id === activeGroup().activePaneId),
      'activePaneId still names a pane that exists'
    );
    assert.equal(S.getState().activeTabId, a, 'focus falls back to a surviving terminal');
    assertEveryTabPlacedOnce('TL-06');
  });

  test('TL-07: closing a pane kills every terminal it held — and only those', async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, paneOf(a).id, 'right');
    // The drop focused b's pane, so this third terminal joins b — a pane with
    // two terminals in it is what closePane has to sweep.
    const c = (await S.getState().createTab()).id;
    const doomedPane = paneOf(b).id;
    assert.deepEqual(paneById(doomedPane).tabIds, [b, c], 'sanity: two terminals in the doomed pane');
    const sessionB = tabById(b).sessionId;
    const sessionC = tabById(c).sessionId;

    await S.getState().closePane(doomedPane);

    assert.equal(panes().length, 1, 'the split collapsed onto the survivor');
    assert.deepEqual(panes()[0].tabIds, [a], 'the other pane is untouched');
    assert.equal(S.getState().tabs.some((t) => t.id === b), false, 'both of its terminals are dropped');
    assert.equal(S.getState().tabs.some((t) => t.id === c), false);
    assert.equal(mockBridge.ptySessions.has(sessionB), false, 'and both PTYs are actually killed');
    assert.equal(mockBridge.ptySessions.has(sessionC), false);
    assert.ok(tabById(a), 'the surviving pane keeps its terminal');
    assertEveryTabPlacedOnce('TL-07');
  });

  test('TL-08: a drop with an unknown pane id, or an unknown tab id, changes nothing at all', async () => {
    const a = panes()[0].tabIds[0];
    const snapshot = () => JSON.stringify({ groups: groups(), activeTabId: S.getState().activeTabId });
    const before = snapshot();

    S.getState().dropTabOnPane(a, 'pane-does-not-exist', 'center');
    assert.equal(snapshot(), before, 'an unknown target pane must not fall back to some other pane');

    S.getState().dropTabOnPane('tab-does-not-exist', paneOf(a).id, 'right');
    assert.equal(snapshot(), before, 'an unknown tab id must not create a pane holding a ghost');
  });

  test('TL-09: after a shuffle of drops every terminal is in exactly one pane, and no pane is left empty', async () => {
    const ids = [panes()[0].tabIds[0]];
    for (let i = 0; i < 3; i++) ids.push((await S.getState().createTab()).id);
    assert.deepEqual(panes()[0].tabIds, ids, 'sanity: all four start in one pane');

    S.getState().dropTabOnPane(ids[1], paneOf(ids[0]).id, 'right');
    S.getState().dropTabOnPane(ids[2], paneOf(ids[1]).id, 'bottom');
    S.getState().dropTabOnPane(ids[3], paneOf(ids[0]).id, 'center');
    S.getState().dropTabOnPane(ids[0], paneOf(ids[2]).id, 'center');

    assert.deepEqual(
      ids.map((id) => panesHolding(id).length),
      [1, 1, 1, 1],
      'no terminal was duplicated or lost'
    );
    assert.equal(S.getState().tabs.length, 4, 'and none was killed on the way');
    assert.ok(allPanes().every((p) => p.tabIds.length > 0), 'no empty pane survives a shuffle');
    assertEveryTabPlacedOnce('TL-09');
  });

  test('TL-10: a collapse deep in the tree must not reset the outer split\'s proportions', async () => {
    const gid = activeGroup().id;
    const a = panes()[0].tabIds[0];
    const outerPaneId = await S.getState().splitPane(paneOf(a).id, 'horizontal', gid);
    const outerSplitId = tree().id;
    S.getState().setPaneSizes(gid, outerSplitId, [70, 30]);
    assert.deepEqual(tree().sizes, [70, 30], 'sanity: the user dragged the divider');

    // Split the right-hand pane again, then drag its second terminal away so
    // the INNER split collapses. Only the inner one may be renormalized.
    const innerPaneId = await S.getState().splitPane(outerPaneId, 'vertical', gid);
    const innerTab = paneById(innerPaneId).tabIds[0];
    assert.equal(tree().children[1].type, 'split', 'sanity: a nested split exists');

    S.getState().dropTabOnPane(innerTab, paneOf(a).id, 'center');

    assert.equal(panes().length, 2, 'the inner split collapsed onto its survivor');
    assert.equal(tree().id, outerSplitId, 'the outer split is still the same node');
    assert.deepEqual(
      tree().sizes,
      [70, 30],
      'a structural change one level down must not silently even out the row the user sized'
    );
    assertEveryTabPlacedOnce('TL-10');
  });

  test('TL-25: a drop onto a pane of ANOTHER group moves the terminal there and brings that group on screen', async () => {
    const g1 = activeGroup().id;
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id; // so g1 does not vanish when b leaves
    const other = await S.getState().createGroup({ name: 'Target' });
    const targetPaneId = groupById(other.id).activePaneId;
    const x = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    S.getState().setActiveGroup(g1);
    assert.equal(S.getState().activeGroupId, g1, 'sanity: the target group is OFF screen');

    // No `targetGroupId` argument: the target group must be resolved from the
    // pane id alone, not defaulted to whatever is on screen.
    S.getState().dropTabOnPane(b, targetPaneId, 'center');

    assert.equal(groups().length, 2, 'a cross-group drop moves a terminal, it does not create a group');
    assert.equal(panesHolding(b).length, 1, 'the terminal is in exactly one pane');
    assert.equal(groupOf(b).id, other.id, 'and that pane is in the target group');
    assert.deepEqual(paneById(targetPaneId).tabIds, [x, b], 'appended to the target pane');
    assert.deepEqual(leavesOf(groupById(g1).tree)[0].tabIds, [a], 'the source group no longer lists it');
    assert.equal(S.getState().activeGroupId, other.id, 'the drop brings the target group on screen');
    assert.equal(S.getState().activeTabId, b, 'and the dropped terminal is the one showing');
    assertEveryTabPlacedOnce('TL-25');
  });
});

// =========================================================================
describe('Terminal layout: persistence, restore contents, and live cwd', () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(teardown);

  test('TL-11: renaming a tab sets its title; an empty name resets to the default', () => {
    const tabId = panes()[0].tabIds[0];
    S.getState().renameTab(tabId, '  My Shell  ');
    assert.equal(tabById(tabId).title, 'My Shell', 'trimmed and applied');

    S.getState().renameTab(tabId, '   ');
    assert.equal(tabById(tabId).title, 'Terminal 1', 'blank name falls back to the auto-generated default');
  });

  test('TL-13: saveState/loadState round-trip an equal structure', () => {
    const payload = { groups: [{ id: 'g1', tree: { a: 1, list: [1, 2, 3] } }], tabs: [{ id: 't1', title: 'X' }], activeGroupId: 'g1' };
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

  test('TL-16: a relaunch restores which terminal sits in which pane, in what order, and which one is visible', async () => {
    const gid = activeGroup().id;
    const a = panes()[0].tabIds[0];
    S.getState().renameTab(a, 'Main');
    const b = (await S.getState().createTab()).id; // a, b and c share the first pane
    const c = (await S.getState().createTab()).id;

    const p2 = await S.getState().splitPane(paneOf(a).id, 'horizontal', gid);
    const d = paneById(p2).tabIds[0];
    const p3 = await S.getState().splitPane(p2, 'vertical', gid); // nested split under p2
    const e = paneById(p3).tabIds[0];

    const outerSplitId = tree().id;
    S.getState().setPaneSizes(gid, outerSplitId, [70, 30]);
    // The visible tab of pane 1 is deliberately neither the first of its tabs
    // nor the newest — restoring "the first one" must not look correct here.
    S.getState().switchTab(b);

    await flushPersist();
    assert.ok(loadState(PERSIST_KEY, null), 'something was persisted');

    await resetStore({ keepStorage: true });

    assert.equal(S.getState().tabs.length, 5, 'one fresh PTY per saved terminal');
    assert.equal(tabById(a).title, 'Main', 'tab titles survive');
    assert.equal(tree().type, 'split');
    assert.equal(tree().direction, 'horizontal');
    assert.deepEqual(tree().sizes, [70, 30], 'the sized divider comes back where the user left it');

    const first = tree().children[0];
    assert.deepEqual(first.tabIds, [a, b, c], 'a pane holding several terminals restores them in order');
    assert.equal(first.activeTabId, b, 'and restores WHICH of them was on top, not just the first');

    const nested = tree().children[1];
    assert.equal(nested.type, 'split', 'a nested split is restored as a split, not flattened');
    assert.equal(nested.direction, 'vertical');
    assert.deepEqual(nested.children.map((n) => n.tabIds), [[d], [e]], 'in its original order');
    assertEveryTabPlacedOnce('TL-16');
  });

  test('TL-17: a saved terminal no group references costs no PTY on relaunch', async () => {
    const sessionsBefore = mockBridge.ptySessions.size;

    await resetStore({
      seed: {
        [PERSIST_KEY]: {
          version: 2,
          data: {
            activeGroupId: 'group-500',
            groups: [
              {
                id: 'group-500',
                name: 'Kept',
                createdAt: 1,
                activePaneId: 'pane-500',
                tree: { type: 'leaf', id: 'pane-500', tabIds: ['t-used'], activeTabId: 't-used' },
              },
            ],
            tabs: [
              { id: 't-used', title: 'Used', cwd: '/workspace' },
              { id: 't-orphan', title: 'Orphan', cwd: '/workspace' },
            ],
          },
        },
      },
    });

    assert.equal(
      mockBridge.ptySessions.size - sessionsBefore,
      1,
      'an orphaned tab id in the payload must not cost a shell process'
    );
    assert.equal(S.getState().tabs.length, 1);
    assert.equal(S.getState().tabs[0].title, 'Used');
    assert.equal(S.getState().tabs.some((t) => t.title === 'Orphan'), false, 'and must not become a tab');
    assertEveryTabPlacedOnce('TL-17');
  });

  test('TL-18: a terminal saved into two groups is restored into exactly one of them', async () => {
    await resetStore({
      seed: {
        [PERSIST_KEY]: {
          version: 2,
          data: {
            activeGroupId: 'group-first',
            groups: [
              {
                id: 'group-first',
                name: 'First',
                createdAt: 1,
                activePaneId: 'pane-first',
                tree: { type: 'leaf', id: 'pane-first', tabIds: ['t-shared'], activeTabId: 't-shared' },
              },
              {
                id: 'group-second',
                name: 'Second',
                createdAt: 2,
                activePaneId: 'pane-second',
                // A hand-edited / half-written payload claiming the same terminal.
                tree: { type: 'leaf', id: 'pane-second', tabIds: ['t-shared', 't-own'], activeTabId: 't-shared' },
              },
            ],
            tabs: [
              { id: 't-shared', title: 'Shared', cwd: '/workspace' },
              { id: 't-own', title: 'Own', cwd: '/workspace' },
            ],
          },
        },
      },
    });

    assert.equal(groups().length, 2, 'both groups still restore');
    assert.equal(S.getState().tabs.length, 2, 'each saved terminal respawns exactly once');
    assert.equal(panesHolding('t-shared').length, 1, 'the contested terminal ends up in ONE pane');
    assert.equal(groupOf('t-shared').id, 'group-first', 'the first group to claim it keeps it');
    assert.deepEqual(
      leavesOf(groupById('group-second').tree)[0].tabIds,
      ['t-own'],
      'the second group keeps only what was really its own'
    );
    assertEveryTabPlacedOnce('TL-18');
  });

  test("TL-19: a pty-cwd event updates only the emitting tab's cwd, and the store cwd only when it is active", async () => {
    const a = panes()[0].tabIds[0];
    const b = (await S.getState().createTab()).id; // createTab makes b the active tab
    const sessionA = tabById(a).sessionId;
    const sessionB = tabById(b).sessionId;
    const originalACwd = tabById(a).cwd;
    const originalBCwd = tabById(b).cwd;

    assert.equal(S.getState().activeTabId, b, 'sanity: b is the active tab');

    // b is active — updating a's (inactive) session must not touch b or the store cwd.
    await mockBridge.emit('pty-cwd', { session_id: sessionA, cwd: '/workspace/a-moved' });
    assert.equal(tabById(a).cwd, '/workspace/a-moved', "a's own cwd updates");
    assert.equal(tabById(b).cwd, originalBCwd, "b's cwd is untouched by a's event");
    assert.notEqual(S.getState().cwd, '/workspace/a-moved', 'an inactive tab moving must not change the store cwd');
    assert.notEqual(originalACwd, '/workspace/a-moved', 'sanity: this really was a change');

    // b is active — updating its session must also update the store's cwd.
    await mockBridge.emit('pty-cwd', { session_id: sessionB, cwd: '/workspace/b-moved' });
    assert.equal(tabById(b).cwd, '/workspace/b-moved');
    assert.equal(S.getState().cwd, '/workspace/b-moved', "the active tab's cwd change updates the store cwd too");
    assert.equal(tabById(a).cwd, '/workspace/a-moved', "a is untouched by b's event");
  });

  test('TL-20: an unknown session id in a pty-cwd event is ignored', async () => {
    const before = JSON.stringify(S.getState().tabs);
    await mockBridge.emit('pty-cwd', { session_id: 'pty-does-not-exist', cwd: '/nowhere' });
    assert.equal(JSON.stringify(S.getState().tabs), before, 'tabs must be unchanged');
  });

  test('TL-21: the persisted payload carries a cwd updated via pty-cwd', async () => {
    const a = panes()[0].tabIds[0];
    await mockBridge.emit('pty-cwd', { session_id: tabById(a).sessionId, cwd: '/workspace/persisted-cwd' });

    await flushPersist();
    const saved = loadState(PERSIST_KEY, null);
    assert.ok(saved, 'something was persisted');
    const savedTab = saved.tabs.find((t) => t.id === a);
    assert.ok(savedTab, 'the tab is present in the persisted payload');
    assert.equal(savedTab.cwd, '/workspace/persisted-cwd', 'the persisted cwd reflects the OSC 7 update');
  });

  test("TL-22: duplicateTab opens a terminal in the SOURCE tab's pane at its live cwd — even from an off-screen group", async () => {
    const g1 = activeGroup().id;
    const other = await S.getState().createGroup({ name: 'Background' });
    const x = leavesOf(groupById(other.id).tree)[0].tabIds[0];
    await mockBridge.emit('pty-cwd', { session_id: tabById(x).sessionId, cwd: '/workspace/deep/dir' });

    S.getState().setActiveGroup(g1);
    assert.notEqual(S.getState().activeGroupId, other.id, 'sanity: the source terminal is off screen');

    const dup = await S.getState().duplicateTab(x);

    assert.ok(dup, 'duplicateTab returns the new tab');
    assert.equal(dup.cwd, '/workspace/deep/dir', "the duplicate opens in the source tab's live (not original) cwd");
    assert.equal(paneOf(dup.id).id, paneOf(x).id, 'it lands in the source tab\'s own pane, not the focused one');
    assert.equal(groups().length, 2, 'duplicating never creates a group');
    assert.equal(leavesOf(groupById(other.id).tree).length, 1, 'and never splits');
    assert.equal(S.getState().activeGroupId, other.id, 'its group is brought on screen so the new tab is visible');
    assert.equal(S.getState().activeTabId, dup.id, 'the duplicate becomes the active tab');
    assertEveryTabPlacedOnce('TL-22');
  });

  test('TL-23: the group, pane and terminal that were on screen are the ones on screen after a relaunch', async () => {
    const g1 = activeGroup().id;
    const g2 = (await S.getState().createGroup({ name: 'Second' })).id;
    const p2 = await S.getState().splitPane(groupById(g2).activePaneId, 'horizontal', g2);
    const y = paneById(p2).tabIds[0];
    S.getState().setActivePane(p2, g2);

    assert.equal(S.getState().activeGroupId, g2, 'sanity: the SECOND group is on screen');
    await flushPersist();

    await resetStore({ keepStorage: true });

    assert.equal(groups().length, 2);
    assert.equal(groups()[0].id, g1, 'switcher order survives');
    assert.equal(
      S.getState().activeGroupId,
      g2,
      'the group switch round-trips — restoring must not silently fall back to the first group'
    );
    assert.equal(activeGroup().activePaneId, p2, 'and so does which pane inside it had focus');
    assert.equal(S.getState().activeTabId, y, 'and which terminal that pane was showing');
    assertEveryTabPlacedOnce('TL-23');
  });

  test('TL-24: a stale activeGroupId / activePaneId in the payload falls back to something real', async () => {
    await resetStore({
      seed: {
        [PERSIST_KEY]: {
          version: 2,
          data: {
            activeGroupId: 'group-that-no-longer-exists',
            groups: [
              {
                id: 'group-a',
                name: 'A',
                createdAt: 1,
                activePaneId: 'pane-that-no-longer-exists',
                tree: { type: 'leaf', id: 'pane-a1', tabIds: ['t-a'], activeTabId: 't-a' },
              },
              {
                id: 'group-b',
                name: 'B',
                createdAt: 2,
                activePaneId: 'pane-b1',
                tree: { type: 'leaf', id: 'pane-b1', tabIds: ['t-b'], activeTabId: 't-b' },
              },
            ],
            tabs: [
              { id: 't-a', title: 'A1', cwd: '/workspace' },
              { id: 't-b', title: 'B1', cwd: '/workspace' },
            ],
          },
        },
      },
    });

    assert.equal(groups().length, 2, 'a dead focus target must not cost the user a group');
    assert.equal(S.getState().activeGroupId, 'group-a', 'the workspace opens on a real group');
    assert.equal(activeGroup().activePaneId, 'pane-a1', 'and on a pane that really is in that group');
    assert.equal(S.getState().activeTabId, 't-a', 'showing a terminal that group actually holds');
    assertEveryTabPlacedOnce('TL-24');
  });
});

// =========================================================================
describe('Terminals panel: saved groups and pane-scoped tab commands', () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(teardown);

  test('SG-01: saveGroup snapshots each terminal\'s LIVE cwd and title, and writes the list to storage', async () => {
    const gid = activeGroup().id;
    const a = panes()[0].tabIds[0];
    // The shell reporting a new cwd (OSC 7) is what must get saved.
    await mockBridge.emit('pty-cwd', { session_id: tabById(a).sessionId, cwd: '/srv/api' });
    S.getState().renameTab(a, 'api');

    const entry = S.getState().saveGroup(gid, '  backend  ');

    assert.ok(entry, 'a snapshot is returned');
    assert.equal(entry.name, 'backend', 'the name is trimmed');
    assert.deepEqual(entry.tabs, [{ slotId: 'slot-0', title: 'api', cwd: '/srv/api' }]);
    assert.equal(S.getState().savedGroups.length, 1);

    const stored = loadState(SAVED_GROUPS_KEY, null);
    assert.ok(stored, 'the snapshot is written to storage immediately, not just held in memory');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].tabs[0].cwd, '/srv/api', 'and it is the live cwd that survives a relaunch');
  });

  test('SG-02: loadSavedGroup re-opens the snapshot as its own group, respawned at the saved cwd, original untouched', async () => {
    const gid = activeGroup().id;
    const a = panes()[0].tabIds[0];
    await mockBridge.emit('pty-cwd', { session_id: tabById(a).sessionId, cwd: '/srv/api' });
    const entry = S.getState().saveGroup(gid, 'backend');
    const originalShape = JSON.stringify(groupById(gid).tree);

    const newGroupId = await S.getState().loadSavedGroup(entry.id);

    assert.ok(newGroupId, 'the id of the group the terminals landed in is returned');
    assert.notEqual(newGroupId, gid, 'a snapshot opens as a NEW group, not into the live one');
    assert.equal(groups().length, 2);
    assert.equal(groupById(newGroupId).name, 'backend', 'the snapshot names its group');

    const restoredTabId = leavesOf(groupById(newGroupId).tree)[0].tabIds[0];
    assert.notEqual(restoredTabId, a, 'it is a fresh terminal, not the original one moved');
    assert.equal(tabById(restoredTabId).cwd, '/srv/api', 'respawned where it was saved');
    assert.equal(JSON.stringify(groupById(gid).tree), originalShape, 'the group it was saved from is untouched');
    assert.ok(tabById(a), 'and keeps its own terminal');
    assert.equal(S.getState().activeGroupId, newGroupId, 'the freshly loaded group comes on screen');
    assertEveryTabPlacedOnce('SG-02');
  });

  test('SG-03: renaming and deleting a saved group round-trip through storage, not just state', async () => {
    const entry = S.getState().saveGroup(activeGroup().id, 'first');
    assert.equal(loadState(SAVED_GROUPS_KEY, [])[0].name, 'first');

    S.getState().renameSavedGroup(entry.id, '  renamed  ');
    assert.equal(S.getState().savedGroups[0].name, 'renamed');
    assert.equal(loadState(SAVED_GROUPS_KEY, [])[0].name, 'renamed', 'the rename is written through');

    S.getState().renameSavedGroup(entry.id, '   ');
    assert.equal(S.getState().savedGroups[0].name, 'renamed', 'a blank rename keeps the old name');

    S.getState().deleteSavedGroup(entry.id);
    assert.equal(S.getState().savedGroups.length, 0);
    assert.deepEqual(loadState(SAVED_GROUPS_KEY, null), [], 'the deletion is written through too');
  });

  test('SG-04: a snapshot whose tree forgot a slot still opens every terminal it promised', async () => {
    const gid = activeGroup().id;
    const a = panes()[0].tabIds[0];
    S.getState().renameTab(a, 'one');
    S.getState().renameTab((await S.getState().createTab()).id, 'two');

    const entry = S.getState().saveGroup(gid, 'pair');
    assert.deepEqual(entry.tree.tabIds, ['slot-0', 'slot-1'], 'sanity: the tree references both slots');

    // Adversarial fixture: a hand-edited (or half-written) snapshot whose tree
    // lost a slot. Its `tabs` still promise two terminals, so two PTYs get
    // spawned — leaving one with no pane to render in would leak a shell.
    S.setState({
      savedGroups: S.getState().savedGroups.map((e) =>
        e.id === entry.id ? { ...e, tree: { ...e.tree, tabIds: ['slot-0'], activeTabId: 'slot-0' } } : e
      ),
    });

    const newGroupId = await S.getState().loadSavedGroup(entry.id);

    const placed = leavesOf(groupById(newGroupId).tree).flatMap((l) => l.tabIds);
    assert.equal(placed.length, 2, 'the slot the tree forgot is parked in the group, not left homeless');
    assert.deepEqual(placed.map((id) => tabById(id).title).sort(), ['one', 'two']);
    assertEveryTabPlacedOnce('SG-04');
  });

  test('SG-05: closeOthersInGroup is pane-scoped — a sibling pane and another group keep their terminals', async () => {
    const keep = panes()[0].tabIds[0];
    const samePane = (await S.getState().createTab()).id;
    const movedOut = (await S.getState().createTab()).id;
    assert.equal(panes()[0].tabIds.length, 3);

    S.getState().dropTabOnPane(movedOut, paneOf(keep).id, 'right'); // its own pane, same group
    const other = await S.getState().createGroup({ name: 'Elsewhere' });
    const elsewhere = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    await S.getState().closeOthersInGroup(keep);

    assert.deepEqual(paneOf(keep).tabIds, [keep], 'only the target is left in its own pane');
    assert.equal(S.getState().tabs.some((t) => t.id === samePane), false, 'its pane-mate is closed');
    assert.ok(tabById(movedOut), 'a terminal in a sibling PANE must survive');
    assert.ok(tabById(elsewhere), 'and so must one in another group');
    assertEveryTabPlacedOnce('SG-05');
  });

  test('SG-06: closeTabsToTheRight keeps everything up to and including the target, and only in that pane', async () => {
    const first = panes()[0].tabIds[0];
    const second = (await S.getState().createTab()).id;
    const third = (await S.getState().createTab()).id;
    const fourth = (await S.getState().createTab()).id;
    assert.deepEqual(panes()[0].tabIds, [first, second, third, fourth]);

    S.getState().dropTabOnPane(fourth, paneOf(first).id, 'bottom'); // fourth leaves for its own pane

    await S.getState().closeTabsToTheRight(second);

    assert.deepEqual(paneOf(first).tabIds, [first, second], 'everything after the target in its pane is closed');
    assert.equal(S.getState().tabs.some((t) => t.id === third), false);
    assert.ok(tabById(fourth), 'a terminal that is no longer "to the right" in that pane is not touched');
    assertEveryTabPlacedOnce('SG-06');
  });

  test('SG-07: moveTabToNewGroup refuses a group\'s only terminal, but accepts one that is merely alone in its pane', async () => {
    const gid = activeGroup().id;
    const solo = panes()[0].tabIds[0];

    assert.equal(
      S.getState().moveTabToNewGroup(solo),
      null,
      "a group's only terminal already IS its own group — moving it would just rename the group"
    );
    assert.equal(groups().length, 1, 'and no empty group is left behind');

    const p2 = await S.getState().splitPane(paneOf(solo).id, 'horizontal', gid);
    const alone = paneById(p2).tabIds[0];
    assert.deepEqual(paneById(p2).tabIds, [alone], 'sanity: alone in its pane, but its group has two panes');

    const newGroupId = S.getState().moveTabToNewGroup(alone);

    assert.ok(newGroupId, 'that terminal CAN become a group of its own');
    assert.equal(groups().length, 2);
    assert.deepEqual(leavesOf(groupById(newGroupId).tree)[0].tabIds, [alone]);
    assert.equal(leavesOf(groupById(gid).tree).length, 1, 'the source group collapsed back to one pane');
    assert.equal(S.getState().activeGroupId, newGroupId, 'and the new group comes on screen');
    assertEveryTabPlacedOnce('SG-07');
  });

  test('SG-08: a group can be snapshotted, closed, and brought back with its layout and its cwds', async () => {
    // The clock is stepped by hand for this case ONLY. `spawnTab` mints tab
    // ids as `tab-term-${Date.now()}-${tabs.length + 1}`, so a terminal
    // spawned in the same millisecond as one that was CLOSED can be handed the
    // id of a still-live terminal — the exact collision `makeSplitId` was made
    // counter-based to avoid. That defect (reported separately; it is not this
    // case's subject) makes this close-then-respawn story fail at random.
    // Stepping the clock removes the coincidence; it does not fix the bug, and
    // `assertEveryTabPlacedOnce` below still checks tab ids are unique.
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => ++clock;
    try {
      const gid = activeGroup().id;
      const a = panes()[0].tabIds[0];
      await mockBridge.emit('pty-cwd', { session_id: tabById(a).sessionId, cwd: '/srv/one' });
      const p2 = await S.getState().splitPane(paneOf(a).id, 'vertical', gid);
      const b = paneById(p2).tabIds[0];
      await mockBridge.emit('pty-cwd', { session_id: tabById(b).sessionId, cwd: '/srv/two' });

      const entry = S.getState().saveGroup(gid, 'stack');
      assert.equal(entry.tree.type, 'split', 'sanity: the snapshot carries the layout');

      await S.getState().createGroup({ name: 'Keeper' }); // so closing `gid` really removes it
      await S.getState().closeGroup(gid);
      assert.equal(groups().some((g) => g.id === gid), false, 'the group is really gone');
      assert.equal(S.getState().tabs.some((t) => t.id === a), false, 'and its terminals were killed');

      const restoredId = await S.getState().loadSavedGroup(entry.id);

      const restored = groupById(restoredId).tree;
      assert.equal(restored.type, 'split', 'the snapshot rebuilds the pane layout, not a flat list of tabs');
      assert.equal(restored.direction, 'vertical', 'along the axis it was saved on');
      assert.deepEqual(
        leavesOf(restored).flatMap((l) => l.tabIds).map((id) => tabById(id).cwd).sort(),
        ['/srv/one', '/srv/two'],
        'each pane\'s terminal respawns where that terminal was'
      );
      assertEveryTabPlacedOnce('SG-08');
    } finally {
      Date.now = realNow;
    }
  });
});
