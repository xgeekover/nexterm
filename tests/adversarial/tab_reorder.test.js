/**
 * Changing the ORDER of terminal tabs and of groups by drag & drop.
 *
 * The gesture lives in TerminalSplitContainer.jsx and is pointer events from
 * press to release, which nothing in Node can drive. Every drop it makes comes
 * down to one of two store calls, though, and those are what this file pins:
 *
 *   - `moveTabInStrip(tabId, paneId, index)`: a tab chip dropped on a TAB
 *     STRIP — its own (a reorder) or another pane's (a move that inserts where
 *     it was dropped instead of appending, which is all a drop on a strip
 *     could do before);
 *   - `reorderGroup(groupId, index)`: a group chip dropped along the switcher.
 *
 * Both take a SLOT, counted in the row as it is BEFORE the move, the dragged
 * item included: slot i is "just before whatever is at position i now", and
 * slot `length` is "after the last". That is what the pointer gives, because
 * the dragged chip stays in its row (faded) for the whole drag, so the
 * midpoints it is measured against are the row as it stands. The consequence
 * worth a test of its own is that moving RIGHT by one place is two slots on —
 * the slot right after the item is where it already is.
 *
 * `terminal_layout.test.js` owns the drops on a pane's BODY (`dropTabOnPane`'s
 * zones); this file does not re-cover them.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, PERSIST_KEY } from '../../src/stores/terminalStore.js';
import { loadState } from '../../src/lib/persistence.js';

const S = useTerminalStore;

// --- localStorage shim ----------------------------------------------------
// Installed per case and handed back after it, never swapped at module scope
// (see TEST_INFRA.md). It COUNTS writes as well as keeping them: "a drop that
// changes nothing saves nothing" cannot be told apart from "it saved the same
// bytes again" by reading the stored value back.
const backing = new Map();
const writes = new Map();
let previousLocalStorage;
let shimInstalled = false;

function installStorageShim() {
  if (!shimInstalled) {
    previousLocalStorage = globalThis.localStorage;
    shimInstalled = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => {
      writes.set(k, (writes.get(k) ?? 0) + 1);
      backing.set(k, String(v));
    },
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
 * Hand the shim back AND write out the store's pending save now: a timer
 * still in flight would otherwise fire ~300ms later into whatever
 * `localStorage` is by then.
 */
function teardown() {
  S.getState().dispose();
  uninstallStorageShim();
}

/**
 * The app as it starts. `keepStorage` leaves the saved workspace in place, so
 * `init()` restores from it — which is what a relaunch is.
 */
async function launch({ keepStorage = false } = {}) {
  S.getState().dispose(); // also writes out a save pending from the previous case
  installStorageShim();
  if (!keepStorage) {
    backing.clear();
    writes.clear();
  }
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [] });
  await S.getState().init();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for the store's 300ms debounced write-behind to land. */
const persistLanded = () => wait(400);
/** How many times the live workspace has been written. */
const savesSoFar = () => writes.get(PERSIST_KEY) ?? 0;

// --- tree helpers (the store's own are private) --------------------------
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groups = () => S.getState().groups;
const groupIds = () => groups().map((g) => g.id);
const groupById = (id) => groups().find((g) => g.id === id);
const activeGroup = () => groupById(S.getState().activeGroupId);
const tree = (gid = S.getState().activeGroupId) => groupById(gid)?.tree ?? null;
const panes = (gid) => leavesOf(tree(gid));
const allPanes = () => groups().flatMap((g) => leavesOf(g.tree));
const paneById = (paneId) => allPanes().find((p) => p.id === paneId);
const paneOf = (tabId) => allPanes().find((p) => p.tabIds.includes(tabId));
const move = (tabId, paneId, index, groupId) => S.getState().moveTabInStrip(tabId, paneId, index, groupId);

/** The first pane of a fresh launch, holding `n` terminals in strip order. */
async function oneStrip(n) {
  const ids = [panes()[0].tabIds[0]];
  while (ids.length < n) ids.push((await S.getState().createTab()).id);
  assert.deepEqual(panes()[0].tabIds, ids, 'sanity: each new terminal is appended to the one strip');
  return ids;
}

/** A second pane to the right of `paneId`, holding one fresh terminal plus `extra` more. */
async function paneBeside(paneId, extra = 0) {
  const gid = activeGroup().id;
  const right = await S.getState().splitPane(paneId, 'horizontal', gid);
  const ids = [paneById(right).tabIds[0]];
  for (let i = 0; i < extra; i++) {
    ids.push((await S.getState().createTab(null, { paneId: right, groupId: gid })).id);
  }
  assert.deepEqual(paneById(right).tabIds, ids, 'sanity: the new pane holds its own terminals, in order');
  return { right, ids };
}

/** Four groups, in switcher order; the last one created is on screen. */
async function fourGroups() {
  const ids = [activeGroup().id];
  for (const name of ['Two', 'Three', 'Four']) ids.push((await S.getState().createGroup({ name })).id);
  assert.deepEqual(groupIds(), ids, 'sanity: a new group is added at the end of the switcher');
  return ids;
}

// =========================================================================
describe('Tab reorder: a terminal tab dropped on a tab strip', () => {
  beforeEach(async () => {
    await launch();
  });

  afterEach(teardown);

  test('TR-01: dragged LEFT along its own strip, a tab lands at the slot it was dropped on and is the one shown', async () => {
    const [a, b, c, d] = await oneStrip(4);
    const pane = paneOf(a).id;
    S.getState().switchTab(b); // something other than the dragged tab is showing

    move(d, pane, 1); // "just before b"

    assert.deepEqual(paneById(pane).tabIds, [a, d, b, c], 'slot 1 puts it between a and b');
    assert.equal(paneById(pane).activeTabId, d, 'the dragged tab becomes the one its pane shows');
    assert.equal(S.getState().activeTabId, d, 'and the active terminal');
    assert.equal(activeGroup().activePaneId, pane);
    assert.equal(panes().length, 1, 'a reorder never splits or adds a pane');
  });

  test('TR-02: dragged RIGHT, the slot still counts the dragged tab — one place right is two slots on', async () => {
    const [a, b, c, d] = await oneStrip(4);
    const pane = paneOf(a).id;

    move(a, pane, 3); // "just before d"
    assert.deepEqual(
      paneById(pane).tabIds,
      [b, c, a, d],
      'slot 3 is BEFORE d — counted with a still in the strip, not after it was lifted out'
    );

    move(b, pane, 2); // b is first; slot 2 is "just before a"
    assert.deepEqual(paneById(pane).tabIds, [c, b, a, d], 'one place to the right');
    assert.equal(paneById(pane).activeTabId, b);
  });

  test('TR-03: the first slot and the slot after the last put a tab at either end of its strip', async () => {
    const [a, b, c, d] = await oneStrip(4);
    const pane = paneOf(a).id;

    move(c, pane, 0);
    assert.deepEqual(paneById(pane).tabIds, [c, a, b, d], 'slot 0 is the front');

    move(a, pane, 4);
    assert.deepEqual(paneById(pane).tabIds, [c, b, d, a], 'slot `length` is the end');
  });

  test('TR-04: a slot outside the strip is clamped into it, and a fraction rounds down', async () => {
    const [a, b, c, d] = await oneStrip(4);
    const pane = paneOf(a).id;

    // -1, not some large negative: unclamped, `slice(0, -1)` counts from the
    // END and would quietly put b second-to-last; -3 here happens to come out
    // right either way.
    move(b, pane, -1);
    assert.deepEqual(paneById(pane).tabIds, [b, a, c, d], 'below 0 is the front');
    move(a, pane, 99);
    assert.deepEqual(paneById(pane).tabIds, [b, c, d, a], 'past the end is the end');
    move(d, pane, -Infinity);
    assert.deepEqual(paneById(pane).tabIds, [d, b, c, a]);
    move(d, pane, Infinity);
    assert.deepEqual(paneById(pane).tabIds, [b, c, a, d]);
    move(a, pane, 1.9);
    assert.deepEqual(paneById(pane).tabIds, [b, a, c, d], '1.9 is slot 1');
    assert.equal(panes().length, 1);
    assert.equal(S.getState().tabs.length, 4, 'no terminal was lost or duplicated on the way');
  });

  test('TR-05: a drop that changes nothing changes no state at all — nothing re-renders, nothing is saved', async () => {
    const [a, b, c] = await oneStrip(3);
    const pane = paneOf(a).id;
    // c is the newest, so it is already its pane's visible tab, in the active
    // pane of the group on screen: dropping it where it is changes nothing.
    assert.equal(S.getState().activeTabId, c, 'sanity');
    await persistLanded();
    const saves = savesSoFar();
    const before = S.getState();

    move(c, pane, 2); // its own slot
    move(c, pane, 3); // and the one just after it — both "where it already is"

    assert.equal(S.getState(), before, 'not even a new state object: every subscriber would re-render');
    await persistLanded();
    assert.equal(savesSoFar(), saves, 'and nothing was written');

    // The control: a move that does change the order is saved, so the
    // counter above was able to see a write had there been one.
    move(c, pane, 0);
    assert.deepEqual(paneById(pane).tabIds, [c, a, b]);
    await persistLanded();
    assert.ok(savesSoFar() > saves, 'a real reorder is saved by itself');
  });

  test('TR-06: dropped where it already is, a tab that was NOT showing is shown — as a click on it would', async () => {
    const [a, b, c] = await oneStrip(3);
    const pane = paneOf(a).id;
    assert.equal(paneById(pane).activeTabId, c, 'sanity: the newest one is showing');

    move(a, pane, 1); // the slot just after a: where it already is

    assert.deepEqual(paneById(pane).tabIds, [a, b, c], 'the order is untouched');
    assert.equal(paneById(pane).activeTabId, a, 'but the dragged tab is now the one its pane shows');
    assert.equal(S.getState().activeTabId, a);
  });

  test('TR-07: dropped on ANOTHER pane\'s strip, a tab is inserted at the slot — not appended — and its pane takes focus', async () => {
    const gid = activeGroup().id;
    const [a, b, c] = await oneStrip(3);
    const left = paneOf(a).id;
    const { right, ids: [x, y] } = await paneBeside(left, 1);
    S.getState().setActivePane(left, gid); // pressing on b's chip focuses its pane first

    move(b, right, 1); // "just before y"

    assert.deepEqual(paneById(right).tabIds, [x, b, y], 'inserted where it was dropped');
    assert.deepEqual(paneById(left).tabIds, [a, c], 'and gone from the strip it left');
    assert.equal(paneById(right).activeTabId, b, 'shown in the pane it landed in');
    assert.equal(paneById(left).activeTabId, c, 'the pane it left shows one of its own');
    assert.equal(activeGroup().activePaneId, right, 'that pane takes focus');
    assert.equal(S.getState().activeTabId, b);
    assert.equal(groupIds().length, 1);
  });

  test('TR-08: across panes, slot 0 is the front and slot `length` the end; a pane emptied by the move goes away', async () => {
    const [a, b] = await oneStrip(2);
    const left = paneOf(a).id;
    const { right, ids: [x, y] } = await paneBeside(left, 1);

    move(a, right, 0);
    assert.deepEqual(paneById(right).tabIds, [a, x, y], 'the front of the other strip');
    move(b, right, 3);
    assert.deepEqual(paneById(right).tabIds, [a, x, y, b], 'the end of the other strip');

    assert.equal(paneById(left), undefined, 'the pane that lost its last tab is pruned');
    assert.equal(panes().length, 1, 'and the split collapsed onto the pane that was dropped on');
    assert.equal(panes()[0].id, right);
    assert.equal(activeGroup().activePaneId, right);
  });

  test('TR-09: a strip in another group takes the tab at the slot, and brings that group on screen', async () => {
    const g1 = activeGroup().id;
    const [a, b] = await oneStrip(2);
    const other = (await S.getState().createGroup({ name: 'Other' })).id;
    const target = groupById(other).activePaneId;
    const x = paneById(target).tabIds[0];
    const y = (await S.getState().createTab(null, { paneId: target, groupId: other })).id;
    S.getState().setActiveGroup(g1);
    assert.equal(S.getState().activeGroupId, g1, 'sanity: the target group is off screen');

    // No group id: it is resolved from the pane, as `dropTabOnPane` does.
    move(b, target, 1);

    assert.deepEqual(paneById(target).tabIds, [x, b, y]);
    assert.deepEqual(panes(g1)[0].tabIds, [a], 'the source group no longer lists it');
    assert.equal(S.getState().activeGroupId, other, 'the group it landed in comes on screen');
    assert.equal(S.getState().activeTabId, b);
  });

  test('TR-10: an unknown tab, an unknown pane, a pane outside the named group or a non-number slot change nothing', async () => {
    const [a] = await oneStrip(3);
    const pane = paneOf(a).id;
    const elsewhere = (await S.getState().createGroup({ name: 'Elsewhere' })).id;
    const before = S.getState();

    move('tab-term-does-not-exist', pane, 0);
    move(a, 'pane-does-not-exist', 0);
    move(a, pane, 0, 'group-does-not-exist');
    move(a, pane, 0, elsewhere); // a real group — but the pane is not in it
    for (const index of [undefined, null, NaN, '0', {}]) move(a, pane, index);

    assert.equal(S.getState(), before, 'every one of those was ignored, not half-applied');
  });

  test('TR-11: a reorder in one pane leaves every other pane, the split and its sizes exactly as they were', async () => {
    const gid = activeGroup().id;
    const [a, b, c] = await oneStrip(3);
    const left = paneOf(a).id;
    const { right, ids: [x] } = await paneBeside(left, 1);
    const splitId = tree().id;
    S.getState().setPaneSizes(gid, splitId, [70, 30]);
    S.getState().switchTab(x); // the right pane shows x, not its newest
    const rightBefore = structuredClone(paneById(right));

    move(c, left, 0);

    assert.deepEqual(paneById(left).tabIds, [c, a, b]);
    assert.deepEqual(paneById(right), rightBefore, 'the other pane: same tabs, same order, same one showing');
    assert.equal(tree().id, splitId, 'the split is the same node');
    assert.deepEqual(tree().sizes, [70, 30], 'with the proportions the user gave it');
    assert.deepEqual(panes().map((p) => p.id), [left, right], 'and the panes where they were');
    assert.equal(activeGroup().activePaneId, left, 'focus goes to the pane the tab was dropped in');
  });

  test('TR-12: the order is saved, and a relaunch brings it back — within a pane and across panes', async () => {
    const [a, b, c] = await oneStrip(3);
    const left = paneOf(a).id;
    const { right, ids: [x] } = await paneBeside(left);
    await persistLanded();
    const saves = savesSoFar();

    move(c, left, 0); // [c, a, b]
    move(a, right, 0); // right: [a, x]; left: [c, b]
    await persistLanded();

    assert.ok(savesSoFar() > saves, 'the moves were written by the store itself, before anything quit');
    const onDisk = leavesOf(loadState(PERSIST_KEY, null).groups[0].tree);
    assert.deepEqual(
      onDisk.map((p) => p.tabIds),
      [[c, b], [a, x]],
      'what is on disk is the new order'
    );

    await launch({ keepStorage: true });

    assert.equal(S.getState().tabs.length, 4, 'one fresh terminal per saved one');
    assert.deepEqual(paneById(left).tabIds, [c, b], 'the reordered strip comes back in its new order');
    assert.deepEqual(paneById(right).tabIds, [a, x], 'and the tab moved across sits where it was dropped');
    assert.equal(paneById(right).activeTabId, a, 'still the one that pane shows');
  });
});

// =========================================================================
describe('Group reorder: a group chip dropped along the switcher', () => {
  beforeEach(async () => {
    await launch();
  });

  afterEach(teardown);

  test('GR-01: dragged LEFT, a group lands at the slot it was dropped on', async () => {
    const [g1, g2, g3, g4] = await fourGroups();
    S.getState().reorderGroup(g4, 1); // "just before g2"
    assert.deepEqual(groupIds(), [g1, g4, g2, g3]);
  });

  test('GR-02: dragged RIGHT, the slot still counts the dragged group — one place right is two slots on', async () => {
    const [g1, g2, g3, g4] = await fourGroups();

    S.getState().reorderGroup(g1, 3); // "just before g4"
    assert.deepEqual(groupIds(), [g2, g3, g1, g4], 'slot 3 is BEFORE g4, counted with g1 still in the row');

    S.getState().reorderGroup(g2, 2); // g2 is first; slot 2 is "just before g1"
    assert.deepEqual(groupIds(), [g3, g2, g1, g4], 'one place to the right');
  });

  test('GR-03: slot 0 and slot `length` are the two ends, and anything outside the row is clamped into it', async () => {
    const [g1, g2, g3, g4] = await fourGroups();

    S.getState().reorderGroup(g3, 0);
    assert.deepEqual(groupIds(), [g3, g1, g2, g4]);
    S.getState().reorderGroup(g1, 4);
    assert.deepEqual(groupIds(), [g3, g2, g4, g1]);
    S.getState().reorderGroup(g4, -2);
    assert.deepEqual(groupIds(), [g4, g3, g2, g1]);
    S.getState().reorderGroup(g4, 50);
    assert.deepEqual(groupIds(), [g3, g2, g1, g4]);
  });

  test('GR-04: reordering is not switching — the group on screen, its panes and the active terminal stay put', async () => {
    const [g1, g2, g3, g4] = await fourGroups();
    await S.getState().splitPane(groupById(g2).activePaneId, 'horizontal', g2);
    S.getState().setActiveGroup(g2);
    const st = S.getState();
    const activeTabId = st.activeTabId;
    const each = new Map(st.groups.map((g) => [g.id, structuredClone(g)]));

    S.getState().reorderGroup(g2, 4); // the group on screen, to the end
    S.getState().reorderGroup(g4, 0); // and another one past it

    assert.deepEqual(groupIds(), [g4, g1, g3, g2]);
    assert.equal(S.getState().activeGroupId, g2, 'the same group is on screen — wherever it now sits');
    assert.equal(S.getState().activeTabId, activeTabId, 'showing the same terminal');
    for (const g of groups()) {
      assert.deepEqual(g, each.get(g.id), `${g.name}: same panes, same focus, same name`);
    }
    assert.equal(S.getState().tabs, st.tabs, 'no terminal was touched');
  });

  test('GR-05: a group dropped where it already is, an unknown group or a non-number slot change no state and save nothing', async () => {
    const [, g2] = await fourGroups();
    await persistLanded();
    const saves = savesSoFar();
    const before = S.getState();

    S.getState().reorderGroup(g2, 1); // its own slot
    S.getState().reorderGroup(g2, 2); // and the one just after it
    S.getState().reorderGroup('group-does-not-exist', 0);
    for (const index of [undefined, null, NaN, '0']) S.getState().reorderGroup(g2, index);

    assert.equal(S.getState(), before, 'not even a new state object');
    await persistLanded();
    assert.equal(savesSoFar(), saves, 'and nothing was written');

    S.getState().reorderGroup(g2, 0); // the control
    await persistLanded();
    assert.ok(savesSoFar() > saves, 'a real reorder is saved by itself');
  });

  test('GR-06: the switcher order is saved, and a relaunch brings it back with the same group on screen', async () => {
    const [g1, g2, g3, g4] = await fourGroups();
    S.getState().setActiveGroup(g3);
    await persistLanded();
    const saves = savesSoFar();

    S.getState().reorderGroup(g4, 0);
    S.getState().reorderGroup(g1, 3);
    assert.deepEqual(groupIds(), [g4, g2, g1, g3]);
    await persistLanded();

    assert.ok(savesSoFar() > saves, 'the reorder was written by the store itself, before anything quit');
    assert.deepEqual(
      loadState(PERSIST_KEY, null).groups.map((g) => g.id),
      [g4, g2, g1, g3],
      'what is on disk is the new order'
    );

    await launch({ keepStorage: true });

    assert.deepEqual(groupIds(), [g4, g2, g1, g3], 'the switcher comes back in the order it was left');
    assert.deepEqual(groups().map((g) => g.name), ['Four', 'Two', 'Group 1', 'Three'], 'names travel with their groups');
    assert.equal(S.getState().activeGroupId, g3, 'and the group that was on screen still is');
  });
});

// =========================================================================
describe('Tab reorder: teardown', () => {
  test('TR-99: teardown — leave the store disposed and the shim handed back for the next suite', () => {
    teardown();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    assert.equal(shimInstalled, false, 'the real localStorage (or none) is back');
  });
});
