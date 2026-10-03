/**
 * The UI half of drag-to-reorder: where along a ROW of chips — a pane's tab
 * strip, the group switcher — a drag lands, what the marker shows, how a row
 * that overflows is scrolled, and what a group chip let go in place does.
 *
 * `tab_reorder.test.js` pins the store calls a drop ends in. This file pins
 * the arithmetic in TerminalSplitContainer.jsx that chooses their arguments,
 * which nothing tested: putting that file back to 2f75962 — no reorder UI at
 * all — left every suite green. What went wrong there was all geometry:
 *
 *   - Every chip of an overflowing row was counted, scrolled out of view or
 *     not, and the whole strip was the target, its buttons included. With
 *     ten terminals in a 360px pane, the pointer over Split Down meant
 *     "before the fifth" with the marker drawn at x=381, outside the row on
 *     screen (10..316), and nothing reached the end of the row at all.
 *   - A click on a group chip that slipped past the 4px threshold became a
 *     drag that went nowhere, the click after it was swallowed, and the
 *     group was never switched to.
 *
 * Node cannot draw a row, so the cases here hand the real helpers what a
 * browser would: rects (the numbers measured in Chromium for the cases
 * above), or a page small enough to write by hand for the hit-testing. What
 * neither can show — the rAF loop running against a real layout, a touch
 * drag's focus — was checked by driving the real app (see the commit).
 *
 * Node cannot parse JSX either; the render suite's loader can, and is
 * borrowed here for the one module that needs it.
 *
 * One store rule rides along, because reordering is what exposed it: the
 * name a group gets when its name is cleared (`renameGroup`), which used to
 * be read off where the group sits.
 */
import { register } from 'node:module';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore as S } from '../../src/stores/terminalStore.js';

register('../render/jsxLoader.mjs', import.meta.url);
const UI = await import('../../src/components/terminal/TerminalSplitContainer.jsx');

// --- geometry -------------------------------------------------------------

/** A rect from its horizontal extent; rows and chips are one line high. */
const box = (left, right, top = 41, bottom = 63) => ({ left, right, top, bottom });

/**
 * Where the marker for `slot` is drawn: in the 2px gap just before chip
 * `slot`, or just after the last chip (InsertionMarker's -left/-right-0.5).
 */
function markerExtent(chips, slot) {
  const start = slot < chips.length ? chips[slot].left - 2 : chips[chips.length - 1].right;
  return { left: start, right: start + 2 };
}
const onScreen = (extent, visible) => extent.left >= visible.left - 0.5 && extent.right <= visible.right + 0.5;

/**
 * Ten terminals in a 360px pane, as Chromium laid them out: the row on screen
 * is x 10..316, each chip about 90px, then "+" — and Split Right/Split Down
 * beside the row, still inside the strip. `scroll` shifts the row's content
 * left as scrolling it would; 649 is as far as it goes.
 */
const STRIP = {
  strip: box(10, 370, 38, 66),
  row: box(10, 316, 38, 65),
  chips: [
    [14, 105], [107, 196], [198, 288], [290, 381], [383, 474],
    [476, 566], [568, 659], [661, 751], [753, 844], [846, 937],
  ],
  plus: [939, 961],
  splitRight: box(320, 342),
  splitDown: box(344, 366),
  maxScroll: 649,
};
const stripChips = (scroll = 0) => STRIP.chips.map(([l, r]) => box(l - scroll, r - scroll));
const stripVisible = { left: STRIP.row.left, right: STRIP.row.right };

/**
 * Eight groups in a 420px switcher, with the region chrome (a grip and two
 * buttons) beside the row: the row on screen is x 32..344, the LayoutGrid
 * icon left of it. 395 is as far as it scrolls.
 */
const SWITCHER = {
  bar: box(10, 430, 10, 38),
  icon: box(16, 28, 18, 30),
  row: box(32, 344, 13, 35),
  chips: [
    [34, 118], [120, 202], [204, 287], [289, 373],
    [375, 459], [461, 545], [547, 630], [632, 715],
  ],
  plus: [717, 739],
  grip: box(348, 370, 14, 34),
  maxScroll: 395,
};
const switcherChips = (scroll = 0) => SWITCHER.chips.map(([l, r]) => box(l - scroll, r - scroll, 14, 34));
const switcherVisible = { left: SWITCHER.row.left, right: SWITCHER.row.right };

// --- a page small enough to write by hand -----------------------------------

/**
 * An element: attributes, a box, children. Selectors are attribute selectors
 * only (`[data-tab-chip]`), which is all the hit-testing uses — anything else
 * throws, so a change to what it asks for fails loudly instead of matching
 * nothing.
 */
function el(attrs, rect, children = []) {
  const matches = (selector) => {
    const m = /^\[([\w-]+)\]$/.exec(selector);
    if (!m) throw new Error(`the test page knows attribute selectors only, not ${selector}`);
    return m[1] in attrs;
  };
  const node = {
    attrs,
    rect,
    children,
    parent: null,
    getAttribute: (name) => (name in attrs ? String(attrs[name]) : null),
    getBoundingClientRect: () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }),
    matches,
    closest(selector) {
      for (let n = node; n; n = n.parent) if (n.matches(selector)) return n;
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (n) => n.children.forEach((c) => (c.matches(selector) && found.push(c), walk(c)));
      walk(node);
      return found;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null;
    },
  };
  for (const child of children) child.parent = node;
  return node;
}

/**
 * `elementFromPoint` for a page of `el`s: the deepest element under the
 * point. Every box here holds its children's on-screen part, so a chip
 * scrolled outside its row is never hit — the row is not under the point.
 */
function pageOf(root) {
  const under = (n, x, y) => {
    const r = n.rect;
    if (!(x >= r.left && x < r.right && y >= r.top && y < r.bottom)) return null;
    for (const child of n.children) {
      const hit = under(child, x, y);
      if (hit) return hit;
    }
    return n;
  };
  return { elementFromPoint: (x, y) => under(root, x, y) };
}

/**
 * A pane: its tab strip (the row of chips, then the pane's buttons) above
 * its body. `grabbed` is the chip being dragged — still in its row, marked
 * the way the component marks it.
 */
function paneFixture({ paneId = 'p1', ids, chips, row = STRIP.row, grabbed = null }) {
  const chipEls = ids.map((id, i) =>
    el({ 'data-tab-chip': id, role: 'tab', 'aria-grabbed': String(id === grabbed) }, chips[i])
  );
  const plusAt = chips[chips.length - 1].right + 2;
  const rowEl = el({ 'data-chip-row': '' }, row, [...chipEls, el({ title: 'New Terminal' }, box(plusAt, plusAt + 22))]);
  // The pane's buttons sit right of the row, where STRIP measured them.
  const right = row.right + (STRIP.strip.right - STRIP.row.right);
  const shift = row.right - STRIP.row.right;
  const buttons = el({}, box(row.right, right), [
    el({ title: 'Split Right' }, box(STRIP.splitRight.left + shift, STRIP.splitRight.right + shift)),
    el({ title: 'Split Down' }, box(STRIP.splitDown.left + shift, STRIP.splitDown.right + shift)),
  ]);
  const strip = el({ 'data-tab-strip': paneId }, box(row.left, right, 38, 66), [rowEl, buttons]);
  const body = el({ 'data-pane-body': paneId }, box(row.left, right, 66, 366));
  const pane = el({}, box(row.left, right, 38, 366), [strip, body]);
  return { doc: pageOf(el({}, box(0, 2000, 0, 2000), [pane])), rowEl };
}

/** The group switcher: icon, the row of group chips and "+", then the region chrome. */
function switcherFixture({ scroll = 0 } = {}) {
  const chips = switcherChips(scroll);
  const chipEls = chips.map((c, i) => el({ 'data-group-chip': `grp${i}`, role: 'tab' }, c));
  const plus = el({ title: 'New Terminal Group' }, box(SWITCHER.plus[0] - scroll, SWITCHER.plus[1] - scroll, 14, 34));
  const rowEl = el({ 'data-chip-row': '', role: 'tablist' }, SWITCHER.row, [...chipEls, plus]);
  const bar = el({ 'data-group-switcher': '' }, SWITCHER.bar, [
    el({ 'aria-hidden': 'true' }, SWITCHER.icon),
    rowEl,
    el({ 'data-fake-grip': '' }, SWITCHER.grip),
  ]);
  return { doc: pageOf(el({}, box(0, 2000, 0, 2000), [bar])), rowEl };
}

const centre = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
const ids10 = Array.from({ length: 10 }, (_, i) => `t${i}`);

// --- store harness (for the cases that end in a store call) ---------------
// The same shim discipline as tab_reorder.test.js: installed per case and
// handed back after it, never swapped at module scope (see TEST_INFRA.md).
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

function teardown() {
  S.getState().dispose(); // writes out a pending save before the shim goes
  uninstallStorageShim();
}

async function launch() {
  S.getState().dispose();
  installStorageShim();
  backing.clear();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [] });
  await S.getState().init();
}

const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groupIds = () => S.getState().groups.map((g) => g.id);
const nameOf = (id) => S.getState().groups.find((g) => g.id === id)?.name;
const names = () => S.getState().groups.map((g) => g.name);

// =========================================================================
describe('Tab reorder UI: the slot under the pointer', () => {
  // A wide row, nothing out of view: the plain midpoint count.
  const four = [box(14, 105), box(107, 196), box(198, 288), box(290, 381)];
  const wide = { left: 10, right: 1000 };

  test('UI-01: left of a chip\'s middle is before it, right of it is after it; the ends are 0 and `length`', () => {
    const at = (x) => UI.slotAtX(four, x, wide);
    assert.equal(at(20), 0, 'the left half of the first chip is the front');
    assert.equal(at(100), 1, 'its right half is after it');
    assert.equal(at(150), 1, 'the left half of the second chip (middle 151.5) is before it');
    assert.equal(at(160), 2);
    assert.equal(at(250), 3, 'the right half of the third chip');
    assert.equal(at(300), 3, 'the left half of the last chip');
    assert.equal(at(380), 4, 'the right half of the last chip is the end');
    assert.equal(at(700), 4, 'and so is anywhere past it in the row');
    assert.equal(at(12), 0, 'the row\'s padding before the first chip is the front');
    assert.equal(UI.slotAtX([], 500, wide), 0, 'an empty row has the one slot');
  });

  test('UI-02: the dragged chip is counted — it is still in its row, and one place right is two slots on', async () => {
    await launch();
    try {
      const pane = leavesOf(S.getState().groups[0].tree)[0];
      const ids = [pane.tabIds[0]];
      while (ids.length < 4) ids.push((await S.getState().createTab()).id);
      const [a, b, c, d] = ids;

      // `a` is being dragged: faded and marked, but still where it was.
      const { doc } = paneFixture({ paneId: pane.id, ids, chips: four, row: box(10, 1000, 38, 65), grabbed: a });
      const hit = UI.dropTargetAtPoint(170, 52, doc); // the right half of b
      assert.equal(hit.zone, 'tabs');
      assert.equal(hit.paneId, pane.id);
      assert.equal(hit.slot, 2, 'a and b are both left of the pointer: slot 2, not 1');

      S.getState().moveTabInStrip(a, hit.paneId, hit.slot);
      assert.deepEqual(
        leavesOf(S.getState().groups[0].tree)[0].tabIds,
        [b, a, c, d],
        'the slot the row gives, handed to the store, moves the tab exactly one place right'
      );
    } finally {
      teardown();
    }
  });

  test('UI-03: pointing past an overflowing strip — over its own Split buttons — counts as the edge of the row on screen', () => {
    const chips = stripChips(0);
    const { doc, rowEl } = paneFixture({ ids: ids10, chips });

    for (const button of [STRIP.splitRight, STRIP.splitDown]) {
      const p = centre(button);
      const hit = UI.dropTargetAtPoint(p.x, p.y, doc);
      assert.equal(hit?.zone, 'tabs', 'the buttons are part of the strip, which is still the target');
      assert.equal(
        hit.slot,
        3,
        `at x=${p.x}: before t3, the last gap on screen — c5231e5 said 4, "before t4", drawn at x=381 outside the row`
      );
      assert.ok(onScreen(markerExtent(chips, hit.slot), stripVisible), 'and its marker is on screen');
      assert.equal(hit.row, rowEl, 'the row is found through the strip, so auto-scroll can move it');
    }
  });

  test('UI-04: a chip cut off by the edge with its middle on screen is not "after" it — that marker would be off screen', () => {
    // t3 runs 250..341 and the row ends at 316: its middle (295.5) is on
    // screen, its right side and the gap after it are not.
    const chips = [box(14, 105), box(107, 196), box(198, 248), box(250, 341), box(343, 430)];
    for (const x of [300, 310, 316, 330, 400]) {
      const slot = UI.slotAtX(chips, x, stripVisible);
      assert.equal(slot, 3, `x=${x}: the marker goes before the cut chip, the last gap that can be seen`);
      assert.ok(onScreen(markerExtent(chips, slot), stripVisible));
    }
    assert.equal(UI.slotAtX(chips, 280, stripVisible), 3, 'left of its middle it was slot 3 anyway');
  });

  test('UI-05: scrolled to the end, past the last chip is the end — over "+", or over the buttons', () => {
    const chips = stripChips(STRIP.maxScroll); // t9 is 197..288, "+" 290..312
    const { doc } = paneFixture({ ids: ids10, chips });

    for (const [where, p] of [
      ['"+"', { x: 301, y: 52 }],
      ['Split Right', centre(STRIP.splitRight)],
      ['Split Down', centre(STRIP.splitDown)],
    ]) {
      const hit = UI.dropTargetAtPoint(p.x, p.y, doc);
      assert.equal(hit.slot, 10, `over ${where}: after the last of the ten`);
    }
    assert.ok(onScreen(markerExtent(chips, 10), stripVisible), 'and the marker after t9 is on screen');
    assert.equal(UI.dropTargetAtPoint(250, 52, doc).slot, 10, 'the right half of t9 too');
    assert.equal(UI.dropTargetAtPoint(220, 52, doc).slot, 9, 'its left half is before it');
  });

  test('UI-06: scrolled away from the front, the chips out of view to the left all count as before the pointer', () => {
    const chips = stripChips(STRIP.maxScroll); // t6 ends at x=10, t7 is 12..102
    const { doc } = paneFixture({ ids: ids10, chips });
    assert.equal(UI.dropTargetAtPoint(13, 52, doc).slot, 7, 'at the left edge: before t7, the first chip on screen');
    assert.equal(UI.slotAtX(chips, -200, stripVisible), 7, 'and left of the row it is still the first gap on screen');
  });

  test('UI-07: a row with no gap on screen (one chip wider than it) counts the pointer at the row\'s edge', () => {
    // 50px of row, a 150px chip filling it and another past it. No marker can
    // be seen anywhere, so nothing is gained by restricting the slot — but a
    // pointer over the buttons must still not count the chip out of view.
    const chips = [box(-50, 100), box(102, 300)];
    const visible = { left: 10, right: 60 };
    assert.equal(UI.slotAtX(chips, 250, visible), 1, 'over the buttons: after the chip on screen, not after the one past it');
    assert.equal(UI.slotAtX(chips, 0, visible), 0, 'left of the row: before it');
  });

  test('UI-08: wherever the pointer is and however far the row is scrolled, the marker is on screen', () => {
    let drawn = 0;
    for (let scroll = 0; scroll <= STRIP.maxScroll; scroll += 3) {
      const chips = stripChips(scroll);
      for (let x = -40; x <= 420; x += 2) {
        const slot = UI.slotAtX(chips, x, stripVisible);
        // Dragging t0, so the gaps beside it draw nothing (`markerSlot`).
        const mark = UI.markerSlot(slot, ids10, 't0');
        if (mark === null) continue;
        drawn += 1;
        const at = markerExtent(chips, mark);
        assert.ok(onScreen(at, stripVisible), `scroll ${scroll}, x=${x}: the marker for slot ${mark} is at ${at.left}..${at.right}`);
      }
    }
    assert.ok(drawn > 10000, `the sweep drew markers (${drawn}) rather than proving nothing`);

    // And every slot can be had: the front at the start, the end once scrolled to.
    assert.equal(UI.slotAtX(stripChips(0), 20, stripVisible), 0);
    assert.equal(UI.slotAtX(stripChips(STRIP.maxScroll), 400, stripVisible), 10);
  });

  test('UI-09: over the switcher\'s region chrome a dragged group counts as at the row\'s edge; left of the row, its start', () => {
    const { doc, rowEl } = switcherFixture();
    const grip = centre(SWITCHER.grip);
    const hit = UI.groupSlotAtPoint(grip.x, grip.y, doc);
    assert.equal(
      hit.slot,
      3,
      'before grp3, the last gap on screen — c5231e5 said 4, "before grp4", drawn at x=373 outside the row (32..344)'
    );
    assert.ok(onScreen(markerExtent(switcherChips(0), hit.slot), switcherVisible));
    assert.equal(hit.row, rowEl, 'and auto-scroll gets the row');

    const scrolled = switcherFixture({ scroll: SWITCHER.maxScroll });
    assert.equal(UI.groupSlotAtPoint(grip.x, grip.y, scrolled.doc).slot, 8, 'scrolled to the end, the chrome is the end');
    const icon = centre(SWITCHER.icon);
    const front = UI.groupSlotAtPoint(icon.x, icon.y, scrolled.doc).slot;
    const chips = switcherChips(SWITCHER.maxScroll);
    assert.ok(onScreen(markerExtent(chips, front), switcherVisible), 'over the icon left of the row: a gap on screen');
    assert.ok(chips[front].left >= SWITCHER.row.left, 'before the first chip that starts on screen');
    assert.ok(front === 0 || chips[front - 1].left < SWITCHER.row.left, 'and no later than that');

    assert.deepEqual(UI.groupSlotAtPoint(500, 500, doc), { slot: null, row: null }, 'off the switcher: nowhere');
  });

  test('UI-10: a TAB over the switcher finds the group chip under the pointer, and the row to scroll', () => {
    const { doc, rowEl } = switcherFixture();
    const onGrp2 = centre(box(204, 287, 14, 34));
    const over = UI.switcherAtPoint(onGrp2.x, onGrp2.y, doc);
    assert.equal(over.groupId, 'grp2');
    assert.equal(over.row, rowEl);
    const grip = centre(SWITCHER.grip);
    assert.deepEqual(UI.switcherAtPoint(grip.x, grip.y, doc), { row: rowEl, groupId: null }, 'beside the row: no group');
    assert.equal(UI.switcherAtPoint(500, 500, doc), null);
  });

  test('UI-11: a drop on a pane\'s body splits or joins by quarter, and scrolls nothing', () => {
    const { doc } = paneFixture({ ids: ['a', 'b'], chips: [box(14, 105), box(107, 196)] });
    // The body is 10..370 x 66..366.
    assert.deepEqual(UI.dropTargetAtPoint(190, 216, doc), { paneId: 'p1', zone: 'center', row: null });
    assert.equal(UI.dropTargetAtPoint(20, 216, doc).zone, 'left');
    assert.equal(UI.dropTargetAtPoint(360, 216, doc).zone, 'right');
    assert.equal(UI.dropTargetAtPoint(190, 356, doc).zone, 'bottom');
    assert.equal(UI.dropTargetAtPoint(1500, 1500, doc), null, 'nothing under the pointer: no target');
  });
});

// =========================================================================
describe('Tab reorder UI: the marker, and a group chip let go in place', () => {
  test('UI-12: no marker in the two gaps that leave the dragged chip where it is; one everywhere else', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.equal(UI.markerSlot(1, ids, 'b'), null, 'just before itself');
    assert.equal(UI.markerSlot(2, ids, 'b'), null, 'just after itself');
    assert.equal(UI.markerSlot(0, ids, 'b'), 0);
    assert.equal(UI.markerSlot(3, ids, 'b'), 3);
    assert.equal(UI.markerSlot(4, ids, 'b'), 4);
    assert.equal(UI.markerSlot(0, ids, 'a'), null, 'the first chip: the front is where it is');
    assert.equal(UI.markerSlot(4, ids, 'd'), null, 'the last chip: the end is where it is');
    for (let slot = 0; slot <= 4; slot += 1) {
      assert.equal(UI.markerSlot(slot, ids, 'x'), slot, `a chip from another row moves wherever it goes: slot ${slot}`);
    }
    assert.equal(UI.markerSlot(null, ids, 'b'), null, 'off the row');
    assert.equal(UI.markerSlot(undefined, ids, 'b'), null);
  });

  test('UI-13: a group chip let go where it already is switches to that group — the click it nearly was', () => {
    const ids = ['g1', 'g2', 'g3', 'g4'];
    // g1 is on screen. A click on g3 that slipped past the threshold:
    assert.deepEqual(UI.groupDropAction(ids, 'g3', 2, 'g1'), { type: 'switch' }, 'left of its own middle');
    assert.deepEqual(UI.groupDropAction(ids, 'g3', 3, 'g1'), { type: 'switch' }, 'right of it');
    assert.equal(UI.groupDropAction(ids, 'g1', 0, 'g1'), null, 'the group on screen, in place: nothing to do');
    assert.equal(UI.groupDropAction(ids, 'g1', 1, 'g1'), null);
  });

  test('UI-14: dropped anywhere else a group is reordered, never switched to; off the switcher nothing happens', () => {
    const ids = ['g1', 'g2', 'g3', 'g4'];
    for (const slot of [0, 1, 4]) {
      assert.deepEqual(UI.groupDropAction(ids, 'g3', slot, 'g1'), { type: 'reorder' }, `slot ${slot}`);
    }
    assert.deepEqual(UI.groupDropAction(ids, 'g1', 3, 'g1'), { type: 'reorder' }, 'the group on screen moves too');
    assert.equal(UI.groupDropAction(ids, 'g3', null, 'g1'), null, 'let go off the switcher');
    assert.equal(UI.groupDropAction(ids, 'nope', 0, 'g1'), null, 'a group that is gone');
  });
});

// =========================================================================
describe('Tab reorder UI: auto-scroll', () => {
  const row = { left: 10, right: 316 };

  test('UI-15: nothing away from the edges; toward an edge it scrolls that way, faster the closer, faster still past it', () => {
    const step = (x) => UI.autoScrollStep(x, row);
    for (const x of [60, 163, 260]) assert.equal(step(x), 0, `x=${x} is well inside the row`);

    const right = [292, 300, 310, 316, 340, 380].map(step);
    assert.ok(right.every((s) => s > 0), `near or past the right edge it scrolls right: ${right}`);
    for (let i = 1; i < right.length; i += 1) {
      assert.ok(right[i] >= right[i - 1], `and no slower further out: ${right}`);
    }
    assert.ok(step(380) > step(316), 'past the edge (over the buttons) is faster than on it');
    assert.equal(step(5000), step(3000), 'up to a cap');

    for (const x of [8, 10, 20, 30]) {
      assert.equal(step(x), -step(row.left + row.right - x), `x=${x}: the left edge mirrors the right`);
    }
    assert.ok(step(-100) < 0, 'left of the row, it scrolls left');
    assert.equal(UI.autoScrollStep(300, null), 0, 'no row, no scrolling');
  });

  /** A row that scrolls, clamped the way a browser clamps `scrollLeft`. */
  function scrollingRow(max, rect = row) {
    let left = 0;
    return {
      getBoundingClientRect: () => ({ left: rect.left, right: rect.right }),
      get scrollLeft() {
        return left;
      },
      set scrollLeft(v) {
        left = Math.min(Math.max(v, 0), max);
      },
    };
  }

  /** requestAnimationFrame by hand: frames run when the test says so. */
  function frames() {
    const queue = new Map();
    let next = 1;
    return {
      frame: (cb) => (queue.set(next, cb), next++),
      cancelFrame: (id) => queue.delete(id),
      pending: () => queue.size,
      run() {
        const due = [...queue.values()];
        queue.clear();
        due.forEach((cb) => cb());
        return due.length;
      },
    };
  }

  test('UI-16: held past the end of an overflowing strip it scrolls frame by frame to the end, re-measuring after every step, then stops', () => {
    const f = frames();
    const strip = scrollingRow(STRIP.maxScroll);
    let measured = 0;
    const scroller = UI.createAutoScroller({ onScroll: () => (measured += 1), frame: f.frame, cancelFrame: f.cancelFrame });

    scroller.follow(strip, centre(STRIP.splitDown).x);
    assert.equal(f.pending(), 1, 'one frame asked for');
    scroller.follow(strip, centre(STRIP.splitDown).x);
    assert.equal(f.pending(), 1, 'and only one, however many moves arrive before it');

    let ran = 0;
    let previous = 0;
    while (f.pending() && ran < 500) {
      f.run();
      ran += 1;
      assert.ok(strip.scrollLeft >= previous, 'it only ever scrolls toward the end');
      previous = strip.scrollLeft;
    }
    assert.equal(strip.scrollLeft, STRIP.maxScroll, 'it reached the end');
    assert.ok(ran > 1 && ran < 120, `frame by frame (${ran} frames), not all at once and not forever`);
    assert.equal(measured, ran - 1, 'the slot was measured again after every step that moved the row, and not after the one that could not');
    assert.equal(f.pending(), 0, 'and then it stopped asking for frames');
  });

  test('UI-17: stop() cancels the frame it asked for; a pointer moved off the row, or into its middle, stops it too', () => {
    const f = frames();
    const strip = scrollingRow(STRIP.maxScroll);
    let measured = 0;
    const scroller = UI.createAutoScroller({ onScroll: () => (measured += 1), frame: f.frame, cancelFrame: f.cancelFrame });

    scroller.follow(strip, 400);
    scroller.stop(); // the drop, a cancel, or the terminal unmounting
    assert.equal(f.pending(), 0, 'the frame is cancelled');
    f.run();
    assert.equal(strip.scrollLeft, 0, 'and nothing scrolled');

    scroller.follow(strip, 400);
    f.run();
    const after = strip.scrollLeft;
    assert.ok(after > 0, 'sanity: following again scrolls');
    scroller.follow(null, 400); // the pointer left the strip
    f.run();
    assert.equal(strip.scrollLeft, after, 'off the row: not another pixel');
    assert.equal(f.pending(), 0);

    scroller.follow(strip, 163); // back over the middle of the row
    f.run();
    assert.equal(strip.scrollLeft, after, 'in the middle: nothing');
    assert.equal(f.pending(), 0, 'and no frame asked for after that');
    assert.equal(measured, 1, 'only the one step that moved the row was re-measured');
  });

  test('UI-18: at the left edge of a scrolled row it scrolls back to the front, and stops there', () => {
    const f = frames();
    const strip = scrollingRow(STRIP.maxScroll);
    strip.scrollLeft = 100;
    const scroller = UI.createAutoScroller({ onScroll: () => {}, frame: f.frame, cancelFrame: f.cancelFrame });
    scroller.follow(strip, 12);
    for (let i = 0; i < 200 && f.pending(); i += 1) f.run();
    assert.equal(strip.scrollLeft, 0, 'all the way to the front');
    assert.equal(f.pending(), 0);
  });
});

// =========================================================================
describe('Tab reorder UI: a rename left open when a drag starts', () => {
  /** An element that is focused, and whether it was blurred — inside the flush. */
  function focused(attrs) {
    const log = [];
    const element = {
      matches: (selector) => selector === '[data-rename-input]' && 'data-rename-input' in attrs,
      blur: () => log.push(inFlush ? 'blur-in-flush' : 'blur'),
    };
    let inFlush = false;
    const flush = (fn) => {
      inFlush = true;
      try {
        fn();
      } finally {
        inFlush = false;
      }
    };
    return { doc: { activeElement: element }, flush, log };
  }

  test('UI-19: an open tab or group rename is committed (blurred, as a mouse press would) before the row is measured', () => {
    const open = focused({ 'data-rename-input': '' });
    assert.equal(UI.commitOpenRename(open.doc, open.flush), true);
    assert.deepEqual(open.log, ['blur-in-flush'], 'blurred, and flushed so the row is whole before it is measured');
  });

  test('UI-20: anything else that has focus is left alone', () => {
    const chip = focused({ role: 'tab' });
    assert.equal(UI.commitOpenRename(chip.doc, chip.flush), false);
    assert.deepEqual(chip.log, [], 'a focused chip is not blurred');
    assert.equal(UI.commitOpenRename({ activeElement: null }, (fn) => fn()), false, 'nothing focused');
  });
});

// =========================================================================
describe('Tab reorder UI: a group name cleared after a reorder', () => {
  beforeEach(async () => {
    await launch();
  });

  afterEach(teardown);

  /** Groups named Group 1..3 by the app, then Group 3 dragged to the front. */
  async function reordered() {
    const g1 = S.getState().activeGroupId;
    const g2 = (await S.getState().createGroup()).id;
    const g3 = (await S.getState().createGroup()).id;
    assert.deepEqual(names(), ['Group 1', 'Group 2', 'Group 3'], 'sanity: the app numbered them');
    S.getState().reorderGroup(g3, 0);
    assert.deepEqual(groupIds(), [g3, g1, g2]);
    return { g1, g2, g3 };
  }

  test('UI-21: a cleared name becomes a "Group N" no other group has — not one read off where the group now sits', async () => {
    const { g1 } = await reordered();
    S.getState().renameGroup(g1, 'Work');
    S.getState().renameGroup(g1, '   ');
    assert.equal(nameOf(g1), 'Group 1', 'second in the row, but "Group 2" is taken — c5231e5 gave it "Group 2"');
    assert.equal(new Set(names()).size, names().length, `no two groups share a name: ${names()}`);
  });

  test('UI-22: clearing a default name keeps it when nothing else uses it — wherever the group sits', async () => {
    const { g1, g3 } = await reordered();
    S.getState().renameGroup(g3, '');
    assert.equal(nameOf(g3), 'Group 3', 'first in the row, still "Group 3" — c5231e5 renamed it "Group 1", a duplicate');
    assert.deepEqual(names(), ['Group 3', 'Group 1', 'Group 2']);

    // With a lower number free, clearing a name that is already a default
    // still changes nothing: it is not renumbered to the lowest free one.
    S.getState().renameGroup(g1, 'Work');
    S.getState().renameGroup(g3, '   ');
    assert.equal(nameOf(g3), 'Group 3', '"Group 1" is free now, and "Group 3" stays "Group 3"');
  });

  test('UI-23: a number another group holds is never handed out again; the lowest free one is', async () => {
    const { g1, g2, g3 } = await reordered();
    S.getState().renameGroup(g2, 'Group 1'); // typed by the user: theirs to keep, duplicate or not
    S.getState().renameGroup(g1, '');
    assert.equal(nameOf(g1), 'Group 2', 'its own 1 is taken now, and 2 is the lowest free');
    S.getState().renameGroup(g3, 'Logs');
    S.getState().renameGroup(g2, '');
    assert.equal(nameOf(g2), 'Group 1', 'a group already called "Group 1" keeps it when it is the only one');
    assert.deepEqual(names(), ['Logs', 'Group 2', 'Group 1']);
  });
});

// =========================================================================
describe('Tab reorder UI: teardown', () => {
  test('UI-99: teardown — leave the store disposed and the shim handed back for the next suite', () => {
    teardown();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    assert.equal(shimInstalled, false, 'the real localStorage (or none) is back');
  });
});
