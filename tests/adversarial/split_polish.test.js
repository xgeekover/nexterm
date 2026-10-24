/**
 * Stage 3, part A: split polish (spec P1–P3).
 *
 *   P1  a pane with one terminal may hide its tab strip; an overlay strip
 *       comes back over the terminal's top edge when it is wanted. Its rules
 *       live in stripReveal.js, with no DOM, and are stepped through here.
 *   P2  equal splits: a command for the whole group, and a setting that
 *       equalizes the line a new split lands in. The arithmetic is
 *       splitLayout.js's; the store applies it.
 *   P3  swapping two panes' contents: the tree keeps its shape and its
 *       sizes, the terminals change places, the active pane follows its
 *       terminal, and a zoomed group refuses.
 *
 * Plus the wiring every new command needs (keyboard table, palette rows,
 * the palette's dispatch) and the two settings.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useTerminalStore,
  PERSIST_KEY,
  swapBlockedReason,
  zoomedPaneOf,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import {
  spanAlong,
  equalSizesOf,
  equalizeAll,
  equalizeLineOf,
  paneRects,
  placeOf,
  swapChoices,
  swapLabel,
  panelMinSize,
  panelMinSizeOf,
} from '../../src/components/terminal/splitLayout.js';
import {
  createStripOverlay,
  createStripClickGuard,
  headerCloseGestures,
  pointOnStrip,
  stripShown,
} from '../../src/components/terminal/stripReveal.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  keysFor,
  menuIdOf,
  resolveKeybindings,
  configurableCommands,
  dispatchKeydownOverTerminal,
} from '../../src/lib/keybindings.js';
import { buildPaletteGroups, paletteCommands } from '../../src/lib/paletteItems.js';

const S = useTerminalStore;
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// --- localStorage shim, installed per case and handed back after ----------
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

function teardown() {
  S.getState().dispose();
  useSettingsStore.getState().resetSettings();
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

async function freshStart({ keepStorage = false } = {}) {
  S.getState().dispose();
  installStorageShim();
  if (!keepStorage) backing.clear();
  useSettingsStore.getState().resetSettings();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], renameRequest: null });
  await S.getState().init();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- reading the layout -----------------------------------------------------
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
const activeGroup = () => groups().find((g) => g.id === S.getState().activeGroupId);
const paneById = (id, group = activeGroup()) => leavesOf(group.tree).find((l) => l.id === id);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

/** The share of the whole group's width (or height) each pane gets, by id. */
function widths(tree, along = 'horizontal') {
  const rects = paneRects(tree);
  const out = {};
  for (const [id, r] of rects) out[id] = along === 'horizontal' ? r.right - r.left : r.bottom - r.top;
  return out;
}

// --- hand-made trees ----------------------------------------------------------
const leaf = (id, tabIds = [`t-${id}`]) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });
const split = (id, direction, children, sizes) => ({
  type: 'split',
  id,
  direction,
  children,
  ...(sizes ? { sizes } : {}),
});

describe('Split polish: the arithmetic of equal shares (splitLayout.js)', () => {
  test('SP-01: a node spans one pane, the sum of a same-direction split, the widest row of a crossing one', () => {
    assert.equal(spanAlong(leaf('a'), 'horizontal'), 1);
    const row = split('s', 'horizontal', [leaf('a'), split('s2', 'horizontal', [leaf('b'), leaf('c')])]);
    assert.equal(spanAlong(row, 'horizontal'), 3, 'three panes side by side, however they nest');
    assert.equal(spanAlong(row, 'vertical'), 1, 'and one pane tall');
    const column = split('v', 'vertical', [leaf('a'), split('h', 'horizontal', [leaf('b'), leaf('c')])]);
    assert.equal(spanAlong(column, 'horizontal'), 2, 'a column whose bottom row holds two panes is two panes wide');
    assert.equal(spanAlong(column, 'vertical'), 2);
  });

  test('SP-02: a flat row is split evenly, to two decimals summing to 100, and an even row is handed back as it was', () => {
    const row = split('s', 'horizontal', [leaf('a'), leaf('b'), leaf('c')], [50, 30, 20]);
    const even = equalizeAll(row);
    assert.deepEqual(even.sizes, [33.33, 33.33, 33.34]);
    assert.equal(sum(even.sizes), 100);
    assert.equal(equalizeAll(even), even, 'nothing to change: the very same object, so nothing is saved or drawn');
    assert.deepEqual(row.sizes, [50, 30, 20], 'the input is not touched');
  });

  test('SP-03: nested splits in one direction come out as equal panes, not equal halves', () => {
    // What splitting twice to the right makes: [[a | b] | c]. Halving each
    // split gives a and b a quarter each and c a half.
    const tree = split('root', 'horizontal', [split('inner', 'horizontal', [leaf('a'), leaf('b')], [70, 30]), leaf('c')], [20, 80]);
    const even = equalizeAll(tree);
    assert.deepEqual(even.sizes, [66.67, 33.33]);
    assert.deepEqual(even.children[0].sizes, [50, 50]);
    const w = widths(even);
    for (const id of ['a', 'b', 'c']) assert.ok(near(w[id], 1 / 3, 0.001), `${id} is ${w[id]} of the width, not a third`);
  });

  test('SP-04: a crossing split counts as its widest row; its own sizes are equalized along its own direction', () => {
    // [a | (b / (c | d))]: three columns where the bottom right has two.
    const tree = split('root', 'horizontal', [
      leaf('a'),
      split('col', 'vertical', [leaf('b'), split('bottom', 'horizontal', [leaf('c'), leaf('d')], [80, 20])], [90, 10]),
    ], [80, 20]);
    const even = equalizeAll(tree);
    assert.deepEqual(even.sizes, [33.33, 66.67]);
    assert.deepEqual(even.children[1].sizes, [50, 50], 'b above, the c|d row below, halved');
    assert.deepEqual(even.children[1].children[1].sizes, [50, 50]);
    const w = widths(even);
    for (const id of ['a', 'c', 'd']) assert.ok(near(w[id], 1 / 3, 0.001), `${id}: ${w[id]}`);
  });

  test('SP-05: seven panes, ten panes in a line: truly equal, and never under what their panels allow', () => {
    // Made by splitting right again and again: a share of 1/7 is under the
    // 15% two panels used to be held to, and was pushed back up to it.
    for (const count of [7, 10]) {
      let tree = leaf('p0');
      for (let i = 1; i < count; i += 1) tree = split(`s${i}`, 'horizontal', [tree, leaf(`p${i}`)]);
      const even = equalizeAll(tree);
      const w = widths(even);
      for (let i = 0; i < count; i += 1) {
        assert.ok(near(w[`p${i}`], 1 / count, 0.0005), `${count} panes: p${i} is ${w[`p${i}`]} of the width, not 1/${count}`);
      }
      for (const s of splitsOf(even)) {
        const min = Number(panelMinSizeOf(s));
        assert.ok(min <= Number(panelMinSize(s.children.length)), `${s.id}: a minimum above the old one`);
        assert.ok(s.sizes.every((v) => v >= min - 0.005), `${s.id}: ${JSON.stringify(s.sizes)} has a share under its panels' ${min}%`);
        assert.ok(near(sum(s.sizes), 100, 0.001), `${s.id} sums to ${sum(s.sizes)}`);
      }
    }
    assert.deepEqual(equalSizesOf(split('x', 'horizontal', [leaf('a'), leaf('b')])), [50, 50]);
    assert.equal(panelMinSizeOf(split('x', 'horizontal', [leaf('a'), leaf('b')])), '15', 'two panes keep the 15% they had');
  });

  test('SP-06: equalizing the line of one split leaves splits across it and other lines alone', () => {
    // [(a / b) | [c | d]] — a new split d|… lands in the right-hand line.
    const tree = split('root', 'horizontal', [
      split('left', 'vertical', [leaf('a'), leaf('b')], [70, 30]),
      split('right', 'horizontal', [leaf('c'), leaf('d')], [10, 90]),
    ], [60, 40]);
    const even = equalizeLineOf(tree, 'right');
    assert.deepEqual(even.sizes, [33.33, 66.67], 'the whole line from its top: one column on the left, two on the right');
    assert.deepEqual(even.children[1].sizes, [50, 50]);
    assert.deepEqual(even.children[0].sizes, [70, 30], 'the crossing split keeps its own sizes');
    assert.equal(even.children[0], tree.children[0], 'and is the very same node');

    // A vertical split inside a horizontal row only equalizes itself.
    const col = split('root', 'horizontal', [leaf('a'), split('v', 'vertical', [leaf('b'), leaf('c')], [80, 20])], [70, 30]);
    const once = equalizeLineOf(col, 'v');
    assert.deepEqual(once.sizes, [70, 30], 'the row around it is another direction, left alone');
    assert.deepEqual(once.children[1].sizes, [50, 50]);
    assert.equal(equalizeLineOf(col, 'no-such-split'), col, 'an unknown split changes nothing');

    // Two columns, each split down: a split in the right column is not a
    // sibling of the left column's panes, though both run the same way.
    const columns = split('root', 'horizontal', [
      split('left', 'vertical', [leaf('a'), leaf('b')], [70, 30]),
      split('right', 'vertical', [leaf('c'), leaf('d')], [80, 20]),
    ], [60, 40]);
    const right = equalizeLineOf(columns, 'right');
    assert.deepEqual(right.children[1].sizes, [50, 50]);
    assert.equal(right.children[0], columns.children[0], 'the other column is not touched');
    assert.deepEqual(right.sizes, [60, 40], 'nor the row they sit in');
  });

  test('SP-07: where each pane is, in words, from the sizes it is drawn at', () => {
    const grid = split('root', 'horizontal', [
      split('l', 'vertical', [leaf('a'), leaf('b')]),
      split('r', 'vertical', [leaf('c'), leaf('d')]),
    ]);
    const rects = paneRects(grid);
    assert.deepEqual(
      ['a', 'b', 'c', 'd'].map((id) => placeOf(rects.get(id))),
      ['top left', 'bottom left', 'top right', 'bottom right']
    );
    const row = split('row', 'horizontal', [leaf('a'), leaf('b'), leaf('c')]);
    const r2 = paneRects(row);
    assert.deepEqual(['a', 'b', 'c'].map((id) => placeOf(r2.get(id))), ['left', 'middle', 'right']);
    const stack = split('st', 'vertical', [leaf('a'), leaf('b')]);
    const r3 = paneRects(stack);
    assert.deepEqual(['a', 'b'].map((id) => placeOf(r3.get(id))), ['top', 'bottom']);
    assert.equal(placeOf({ left: 0, top: 0, right: 1, bottom: 1 }), 'whole group');
  });

  test('SP-08: the panes to swap with are the others, by the title of the terminal each one shows', () => {
    const tree = split('root', 'horizontal', [
      leaf('a', ['t1']),
      split('r', 'vertical', [leaf('b', ['t2', 't3']), leaf('c', ['t4'])]),
    ]);
    // Pane b shows its second terminal.
    tree.children[1].children[0].activeTabId = 't3';
    const tabs = [
      { id: 't1', title: 'server' },
      { id: 't2', title: 'logs' },
      { id: 't3', title: 'agent' },
      { id: 't4', title: 'tests' },
    ];
    const choices = swapChoices(tree, tabs, 'a');
    assert.deepEqual(
      choices.map((c) => [c.paneId, c.title, c.place, c.index, c.count, c.terminals]),
      [
        ['b', 'agent', 'top right', 1, 3, 2],
        ['c', 'tests', 'bottom right', 2, 3, 1],
      ]
    );
    // Two panes can show terminals of the same name in the same place
    // words ("claude", "right"): the menu row says which pane it is.
    assert.equal(swapLabel(choices[0]), 'Swap with agent (top right, pane 2 of 3)');
    const twins = swapChoices(split('r', 'horizontal', [leaf('a', ['t1']), split('v', 'vertical', [leaf('b', ['t2']), leaf('c', ['t3'])])]), [
      { id: 't1', title: 'claude' },
      { id: 't2', title: 'claude' },
      { id: 't3', title: 'claude' },
    ], 'a');
    assert.notEqual(swapLabel(twins[0]), swapLabel(twins[1]), 'two rows read the same');
    const menu = read('../../src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(menu, /label: swapLabel\(choice\),/, 'the pane menu writes its rows with `swapLabel`');
  });
});

describe('Split polish: Equalize Splits and equal splits in the store (P2)', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  /** [[a | b] | c] with focus on b, sizes set by hand. */
  async function nestedRow() {
    const a = activeGroup().activePaneId;
    const c = await S.getState().splitActivePane('horizontal');
    S.getState().setActivePane(a);
    const b = await S.getState().splitActivePane('horizontal');
    const root = activeGroup().tree;
    S.getState().setPaneSizes(null, root.id, [80, 20]);
    S.getState().setPaneSizes(null, root.children[0].id, [75, 25]);
    return { a, b, c };
  }

  test('SP-10: Equalize Splits gives every pane of the group on screen an equal share, nested splits included', async () => {
    const { a, b, c } = await nestedRow();
    const before = groups();
    assert.equal(S.getState().equalizeSplits(), true, 'it reports that something changed');
    const w = widths(activeGroup().tree);
    for (const id of [a, b, c]) assert.ok(near(w[id], 1 / 3, 0.001), `${id} is ${w[id]}`);
    assert.notEqual(groups(), before, 'a new groups array, so the change is saved');
    const after = groups();
    assert.equal(S.getState().equalizeSplits(), false, 'equal already: nothing to do');
    assert.equal(groups(), after, 'and nothing written');
  });

  test('SP-11: only the group on screen is equalized', async () => {
    await nestedRow();
    const first = activeGroup();
    await S.getState().createGroup({ name: 'Other' });
    const otherId = S.getState().activeGroupId;
    await S.getState().splitActivePane('vertical');
    const other = activeGroup();
    S.getState().setPaneSizes(otherId, other.tree.id, [90, 10]);
    S.getState().setActiveGroup(first.id);
    S.getState().equalizeSplits();
    assert.deepEqual(groups().find((g) => g.id === otherId).tree.sizes, [90, 10], 'the other group keeps its sizes');
    assert.deepEqual(activeGroup().tree.sizes, [66.67, 33.33]);
  });

  test('SP-12: by default a new split halves the pane it splits and leaves the rest of the line as it was', async () => {
    assert.equal(useSettingsStore.getState().terminalEqualizeOnSplit, false, 'off by default');
    const { b } = await nestedRow();
    S.getState().setActivePane(b);
    await S.getState().splitActivePane('horizontal');
    const root = activeGroup().tree;
    assert.deepEqual(root.sizes, [80, 20], 'the line keeps the sizes set by hand');
    assert.deepEqual(root.children[0].sizes, [75, 25]);
  });

  test('SP-13: with Equal Splits on, a new split equalizes its whole line — the button, and a tab dropped on an edge', async () => {
    useSettingsStore.getState().setSetting('terminalEqualizeOnSplit', true);
    const { a, b, c } = await nestedRow();
    S.getState().setActivePane(b);
    const d = await S.getState().splitActivePane('horizontal');
    let w = widths(activeGroup().tree);
    for (const id of [a, b, c, d]) assert.ok(near(w[id], 1 / 4, 0.001), `split: ${id} is ${w[id]}`);

    // A split across the line equalizes only itself.
    S.getState().setActivePane(c);
    const e = await S.getState().splitActivePane('vertical');
    w = widths(activeGroup().tree);
    for (const id of [a, b, c, d]) assert.ok(near(w[id], 1 / 4, 0.001), `across: ${id} is ${w[id]}`);
    const h = widths(activeGroup().tree, 'vertical');
    assert.ok(near(h[c], 0.5, 0.001) && near(h[e], 0.5, 0.001), 'c and e share their column');

    // The same for a tab dragged onto a pane's right edge.
    const g = activeGroup();
    const moving = paneById(a, g).tabIds[0];
    await S.getState().createTab(null, { paneId: a, groupId: g.id });
    const extra = paneById(a).tabIds.find((id) => id !== moving);
    S.getState().dropTabOnPane(extra, d, 'right', g.id);
    w = widths(activeGroup().tree);
    const panes = leavesOf(activeGroup().tree).filter((p) => p.id !== e);
    assert.equal(panes.length, 5, 'five columns now');
    for (const p of panes) assert.ok(near(w[p.id], 1 / 5, 0.001), `drop: ${p.id} is ${w[p.id]}`);
  });

  test('SP-14: equalized sizes are saved and come back after a relaunch', async () => {
    await nestedRow();
    S.getState().equalizeSplits();
    const tree = JSON.stringify(activeGroup().tree);
    await wait(400);
    const saved = JSON.parse(backing.get(PERSIST_KEY));
    const savedRoot = saved.data?.groups?.[0]?.tree ?? saved.groups?.[0]?.tree;
    assert.deepEqual(savedRoot.sizes, [66.67, 33.33], 'written as drawn');
    await freshStart({ keepStorage: true });
    assert.equal(JSON.stringify(activeGroup().tree), tree, 'restored exactly');
  });
});

describe('Split polish: swapping panes (P3)', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  /** [a | b] with a holding t1, b holding t2, focus on a, sizes 70/30. */
  async function twoPanes() {
    const a = activeGroup().activePaneId;
    const b = await S.getState().splitActivePane('horizontal');
    S.getState().setActivePane(a);
    S.getState().setPaneSizes(null, activeGroup().tree.id, [70, 30]);
    return { a, b, t1: paneById(a).tabIds[0], t2: paneById(b).tabIds[0] };
  }

  test('SP-20: two panes swap terminals; the tree, its ids and its sizes stay; the active pane follows its terminal', async () => {
    const { a, b, t1, t2 } = await twoPanes();
    const activeTab = S.getState().activeTabId;
    assert.equal(activeTab, t1, 'setup');
    const shape = JSON.stringify(activeGroup().tree, (k, v) => (k === 'tabIds' || k === 'activeTabId' ? undefined : v));

    assert.equal(S.getState().swapPanes(a, b), true);
    assert.deepEqual(paneById(a).tabIds, [t2]);
    assert.deepEqual(paneById(b).tabIds, [t1]);
    assert.equal(paneById(a).activeTabId, t2);
    assert.equal(paneById(b).activeTabId, t1);
    assert.equal(
      JSON.stringify(activeGroup().tree, (k, v) => (k === 'tabIds' || k === 'activeTabId' ? undefined : v)),
      shape,
      'same panes, same splits, same sizes'
    );
    assert.equal(activeGroup().activePaneId, b, 'the active pane is the one its terminal went to');
    assert.equal(S.getState().activeTabId, t1, 'the terminal being typed into is the same one');
    assert.equal(S.getState().tabs.length, 2, 'no terminal made or closed');

    // Swapping back from the other side.
    assert.equal(S.getState().swapActivePane(a), true);
    assert.deepEqual(paneById(a).tabIds, [t1]);
    assert.equal(activeGroup().activePaneId, a);
  });

  test('SP-21: a pane with several terminals carries all of them, its visible one included; nested panes swap as well', async () => {
    const { a, b, t1 } = await twoPanes();
    S.getState().setActivePane(b);
    const c = await S.getState().splitActivePane('vertical');
    await S.getState().createTab(null, { paneId: a, groupId: activeGroup().id });
    const aTabs = [...paneById(a).tabIds];
    S.getState().bindPaneToTab(a, t1);
    const cTabs = [...paneById(c).tabIds];
    S.getState().setActivePane(c);

    assert.equal(S.getState().swapPanes(c, a), true);
    assert.deepEqual(paneById(c).tabIds, aTabs, 'every terminal of a, in order');
    assert.equal(paneById(c).activeTabId, t1, 'showing the one a showed');
    assert.deepEqual(paneById(a).tabIds, cTabs);
    assert.equal(activeGroup().activePaneId, a, 'focus followed the terminal of c into a');
    assert.equal(leavesOf(activeGroup().tree).length, 3);
  });

  test('SP-22: a zoomed group refuses to swap, and says why; unzoomed, it swaps', async () => {
    const { a, b, t1 } = await twoPanes();
    S.getState().togglePaneZoom();
    assert.ok(zoomedPaneOf(activeGroup()), 'setup: zoomed');
    const before = groups();
    assert.match(swapBlockedReason(activeGroup()), /zoomed/i);
    assert.equal(S.getState().swapPanes(a, b), false);
    assert.equal(groups(), before, 'nothing written');
    S.getState().togglePaneZoom();
    assert.equal(swapBlockedReason(activeGroup()), null);
    assert.equal(S.getState().swapPanes(a, b), true);
    assert.deepEqual(paneById(b).tabIds, [t1]);
  });

  test('SP-23: a pane with itself, an unknown pane, a pane of another group, a group of one: all refused', async () => {
    assert.match(swapBlockedReason(activeGroup()), /one pane/i, 'one pane: nothing to swap with');
    const { a } = await twoPanes();
    const first = activeGroup();
    await S.getState().createGroup({ name: 'Other' });
    const elsewhere = activeGroup().activePaneId;
    S.getState().setActiveGroup(first.id);
    const before = groups();
    assert.equal(S.getState().swapPanes(a, a), false);
    assert.equal(S.getState().swapPanes(a, 'pane-nope'), false);
    assert.equal(S.getState().swapPanes(a, elsewhere, first.id), false, 'panes swap within one group only');
    assert.equal(groups(), before);
  });

  test('SP-24: a swap is saved, comes back after a relaunch, and a saved group keeps it', async () => {
    const { a, b } = await twoPanes();
    S.getState().swapPanes(a, b);
    const titles = (tree, tabs) => leavesOf(tree).map((p) => tabs.find((t) => t.id === p.activeTabId)?.title);
    const order = titles(activeGroup().tree, S.getState().tabs);
    const saved = S.getState().saveGroup(activeGroup().id, 'swapped');
    const slots = leavesOf(saved.tree).map((p) => saved.tabs.find((t) => t.slotId === p.activeTabId)?.title);
    assert.deepEqual(slots, order, 'the saved group holds the swapped arrangement');
    await wait(400);
    await freshStart({ keepStorage: true });
    assert.deepEqual(titles(activeGroup().tree, S.getState().tabs), order, 'restored swapped');
  });
});

describe('Split polish: when a hidden strip is up (P1, stripReveal.js)', () => {
  /** An overlay driven by hand, and what it last told. */
  function rig() {
    const told = [];
    const overlay = createStripOverlay({ onChange: (v) => told.push(v) });
    return { overlay, told };
  }
  const mouse = { pointerType: 'mouse' };

  test('SP-60: the handle is a toggle — a click opens, a second click closes, a double-click\'s second click changes nothing', () => {
    const { overlay } = rig();
    assert.equal(overlay.open, false);
    overlay.handleClick({ detail: 1, ...mouse });
    assert.equal(overlay.open, true, 'a click on the handle opens the strip');
    overlay.handleClick({ detail: 2, ...mouse });
    assert.equal(overlay.open, true, "a double-click's second click toggled it again");
    overlay.handleClick({ detail: 1, ...mouse });
    assert.equal(overlay.open, false, 'a second, separate click on the handle closes it');
    overlay.handleClick({ detail: 0, pointerType: 'keyboard' });
    assert.equal(overlay.open, true, 'Enter on the handle opens it');
    overlay.handleClick({ detail: 0, pointerType: 'keyboard' });
    assert.equal(overlay.open, false, 'and closes it');
    assert.equal(createStripOverlay().quiet, undefined, 'the strip never covers its handle, so there is no window in which it ignores the pointer');
  });

  test('SP-61: Escape is the strip\'s only while the keyboard is in the strip or on its handle — otherwise the program\'s', () => {
    const { overlay } = rig();
    overlay.handleClick({ detail: 1, ...mouse });
    assert.equal(overlay.escape(false), false, 'Escape taken from the terminal it was typed into');
    assert.equal(overlay.open, true);
    assert.equal(overlay.escape(true), true, 'Escape with the keyboard in the strip did not close it');
    assert.equal(overlay.open, false);
    assert.equal(overlay.escape(true), false, 'closed: nothing to take the key for');
  });

  test('SP-62: a mouse leaving the strip and its handle, having been on them, closes it; touch and pen never do; held, nothing does', () => {
    const { overlay } = rig();
    overlay.handleClick({ detail: 1, ...mouse }); // the mouse is on the handle
    overlay.pointerAt({ inside: false, pointerType: 'touch' });
    overlay.pointerAt({ inside: false, pointerType: 'pen' });
    assert.equal(overlay.open, true, 'a finger leaving (after it lifted) closed it before its tap landed');
    overlay.pointerAt({ inside: false, pointerType: 'mouse', held: true });
    assert.equal(overlay.open, true, 'held by a menu, a rename or a drag, and closed');
    overlay.pointerAt({ inside: false, ...mouse });
    assert.equal(overlay.open, false, 'the mouse left it and it stayed');
    // Opened from the keyboard, the mouse has not been on it: moving
    // elsewhere is not leaving it.
    overlay.handleClick({ detail: 0, pointerType: 'keyboard' });
    overlay.pointerAt({ inside: false, ...mouse });
    assert.equal(overlay.open, true);
    overlay.pointerAt({ inside: true, ...mouse });
    overlay.pointerAt({ inside: false, ...mouse });
    assert.equal(overlay.open, false);
    // Touch opens it as a tap does, and a tap outside closes it.
    overlay.handleClick({ detail: 1, pointerType: 'touch' });
    overlay.pointerAt({ inside: false, pointerType: 'touch' });
    assert.equal(overlay.open, true);
    overlay.pressOutside();
    assert.equal(overlay.open, false);
  });

  test('SP-63: the keyboard tabbing out of the strip and its handle closes it — the window losing focus does not; a press outside does, unless something holds it', () => {
    const { overlay } = rig();
    overlay.handleClick({ detail: 0, pointerType: 'keyboard' });
    overlay.focusMoved({ to: 'nowhere' }); // the window lost focus: no element took it
    assert.equal(overlay.open, true, 'the window losing focus closed the strip — and it came back drawn but closed');
    overlay.focusMoved({ to: 'inside' });
    assert.equal(overlay.open, true);
    overlay.focusMoved({ to: 'outside' });
    assert.equal(overlay.open, false, 'focus left the strip and it stayed over the terminal');
    overlay.handleClick({ detail: 1, ...mouse });
    overlay.pressOutside(true);
    assert.equal(overlay.open, true, 'held, and a press outside closed it');
    overlay.pressOutside();
    assert.equal(overlay.open, false);
    overlay.handleClick({ detail: 1, ...mouse });
    overlay.holdEnded(true);
    assert.equal(overlay.open, true, 'a hold let go with the pointer on it');
    overlay.holdEnded(false);
    assert.equal(overlay.open, false);
  });

  test('SP-64: shown while opened or held — never by the pointer alone; Escape heard first and kept from the program; the handle has no hover', () => {
    const none = { open: false, dragging: false, menuOpen: false, renaming: false };
    assert.equal(stripShown(none), false);
    for (const key of Object.keys(none)) assert.equal(stripShown({ ...none, [key]: true }), true, key);
    assert.equal(stripShown({ ...none, hover: true }), false, 'hover brings nothing up');
    const reveal = read('../../src/components/terminal/stripReveal.js');
    const hook = reveal.slice(reveal.indexOf('export function useStripOverlay'));
    // Heard in the capture phase, before anything else on the page.
    assert.match(hook, /window\.addEventListener\('keydown', onKey, true\);/, 'Escape is not heard in the capture phase');
    // Taken, it goes no further: not to the program, not to another handler.
    const onKey = /const onKey = \(e\) => \{([^]*?)\n {4}\};/.exec(hook)?.[1] ?? '';
    assert.match(onKey, /overlay\.escape\(/);
    assert.match(onKey, /e\.preventDefault\(\);[^]*e\.stopPropagation\(\);/, 'an Escape the strip took still goes on to the program');
    // The handle opens on a click or a key, never on the pointer passing.
    const strip = read('../../src/components/terminal/HiddenStrip.jsx');
    const handle = strip.slice(strip.indexOf('export function StripHandle'), strip.indexOf('export function StripOverlay'));
    assert.ok(!/on(Pointer|Mouse)(Enter|Over|Move)=/.test(handle), 'the handle reacts to the pointer passing over it');
    // A rename finished from the keyboard: the key is cancelled, and the
    // terminal gets the keyboard only once the key is over.
    const pane = read('../../src/components/terminal/TerminalSplitContainer.jsx');
    const rename = /data-rename-input=""[^]*?onKeyDown=\{\(e\) => \{([^]*?)\n {18}\}\}/.exec(pane)?.[1] ?? '';
    assert.match(rename, /e\.preventDefault\(\);/, 'Enter finishing a rename goes on to be a key');
    assert.match(rename, /setTimeout\(\(\) => input\?\.focus\(/, 'the terminal is focused inside the key, and takes it');
    assert.ok(!/\n\s*input\?\.focus\(/.test(rename), 'the terminal is focused inside the key, and takes it');
    // A pane menu closed with the keyboard left on the page gives it back
    // to the terminal: what the hook does is strip_overlay_mounted.test.js's
    // (SO-05, SO-06); that the pane uses it, this.
    assert.match(pane, /useRefocusAfterMenu\(holds\.menuOpen, paneRef\);/, 'the pane does not hand the keyboard back after its menus');
  });
});

describe('Split polish: what the opened strip refuses (P1, stripReveal.js)', () => {
  /** A guard on a hand-moved clock. */
  function rig() {
    let now = 10_000;
    const guard = createStripClickGuard({ now: () => now });
    return { guard, at: (ms) => { now = 10_000 + ms; } };
  }

  test("SP-65: the reviewer's double-click on the handle drifting 4 px down (t6 679 4): its second click activates nothing", () => {
    const { guard, at } = rig();
    at(0);
    guard.handlePressed({ pointerType: 'mouse' });
    guard.handleClicked({ pointerType: 'mouse' });
    at(60);
    guard.stripPressed({ pointerType: 'mouse', below: 4 });
    assert.equal(guard.refuses({ type: 'click', detail: 2 }), true, "a double-click's second click activated a strip control");
    assert.equal(guard.refuses({ type: 'dblclick' }), true, 'the double-click itself reached the strip');
    // A click with `detail` past one is never a strip control's, whenever it comes.
    at(5000);
    assert.equal(guard.refuses({ type: 'click', detail: 3 }), true);
  });

  test("SP-66: a tap on the handle, then a second tap 10 px lower 600 ms after it (t7 679 10 600): refused; lower or later, it is the strip's", () => {
    const { guard, at } = rig();
    at(0);
    guard.handlePressed({ pointerType: 'touch' });
    at(60);
    guard.handleClicked({ pointerType: 'touch' }); // the tap lands as the finger lifts
    at(660); // 600 ms after it, the second finger comes down 10 px below the handle
    guard.stripPressed({ pointerType: 'touch', below: 10 });
    at(720);
    assert.equal(guard.refuses({ type: 'click', detail: 1 }), true, 'a second tap meant for the handle activated the strip');
    // 13 px down is the strip's.
    guard.stripPressed({ pointerType: 'touch', below: 13 });
    assert.equal(guard.refuses({ type: 'click', detail: 1 }), false);
    // And so is a tap right below the handle a while later.
    at(1500);
    guard.stripPressed({ pointerType: 'touch', below: 4 });
    at(1560);
    assert.equal(guard.refuses({ type: 'click', detail: 1 }), false);
  });

  test('SP-67: nothing in the strip is activated within 500 ms of a press on the handle; after it, a click is a click and a double-click renames', () => {
    const { guard, at } = rig();
    at(0);
    guard.handlePressed({ pointerType: 'mouse' });
    guard.handleClicked({ pointerType: 'mouse' });
    at(499);
    guard.stripPressed({ pointerType: 'mouse', below: 20 });
    assert.equal(guard.refuses({ type: 'click', detail: 1 }), true, 'activated 499 ms after a press on the handle');
    at(500);
    guard.stripPressed({ pointerType: 'mouse', below: 20 });
    assert.equal(guard.refuses({ type: 'click', detail: 1 }), false, 'a deliberate click on the strip was refused');
    assert.equal(guard.refuses({ type: 'dblclick' }), false, 'a double-click on a chip no longer renames it');
    // The keyboard: Enter on a chip is a click with `detail` 0.
    assert.equal(guard.refuses({ type: 'click', detail: 0 }), false);
  });

  test('SP-68: a hold letting go counts the pointer on the HANDLE as on the strip — dismissing its own menu keeps it open', () => {
    const handle = { left: 0, top: 0, right: 300, bottom: 6 };
    const overlay = { left: 0, top: 6, right: 300, bottom: 34 };
    assert.equal(pointOnStrip({ x: 80, y: 3 }, overlay, handle), true, 'on the handle, and counted off the strip');
    assert.equal(pointOnStrip({ x: 80, y: 20 }, overlay, handle), true);
    assert.equal(pointOnStrip({ x: 80, y: 50 }, overlay, handle), false);
    assert.equal(pointOnStrip(null, overlay, handle), false);
  });

  test('SP-69: the opened strip of a hidden one has no one-click close — no chip ✕, no middle-click, no Close Pane; the pane menu closes instead', () => {
    for (const canClose of [true, false]) {
      const hidden = headerCloseGestures({ stripHidden: true, canClose });
      assert.equal(hidden.chipMiddleClick, false, `a middle-click on a chip in the opened strip closes its terminal (canClose ${canClose})`);
      assert.equal(hidden.chipButton, false, `the opened strip's chip has a \u{2715} (canClose ${canClose})`);
      assert.equal(hidden.paneButton, false, `the opened strip has a Close Pane button (canClose ${canClose})`);
      assert.equal(hidden.menuCloseTerminal, true, `with no \u{2715} in the strip, the pane menu cannot close the terminal (canClose ${canClose})`);
      assert.equal(hidden.menuClosePane, canClose, `the pane menu's Close Pane does not follow whether the pane can close (canClose ${canClose})`);
    }
    // A strip that is drawn in line keeps every way it had.
    for (const canClose of [true, false]) {
      const inline = headerCloseGestures({ stripHidden: false, canClose });
      assert.equal(inline.chipMiddleClick, true, `a middle-click on an in-line chip no longer closes it (canClose ${canClose})`);
      assert.equal(inline.chipButton, true, `an in-line chip lost its \u{2715} (canClose ${canClose})`);
      assert.equal(inline.paneButton, canClose, `Close Pane in line does not follow whether the pane can close (canClose ${canClose})`);
      assert.equal(inline.menuCloseTerminal, false, 'the pane menu repeats the chip\u{2019}s close in line');
      assert.equal(inline.menuClosePane, false, 'the pane menu repeats the Close Pane button in line');
    }
    // Wiring only (the rule itself is above): the chip's middle-click asks it.
    const container = read('../../src/components/terminal/TerminalSplitContainer.jsx');
    assert.match(container, /e\.button === 1 && closeGestures\.chipMiddleClick\)/, "the chip's middle-click does not ask headerCloseGestures");
  });
});

describe('Split polish: settings and commands', () => {
  afterEach(() => useSettingsStore.getState().resetSettings());

  test('SP-30: both settings are off by default, and saved when changed — and only then', () => {
    installStorageShim();
    try {
      assert.equal(SETTINGS_DEFAULTS.terminalHideSingleTabStrip, false);
      assert.equal(SETTINGS_DEFAULTS.terminalEqualizeOnSplit, false);
      const saved = () => {
        const raw = JSON.parse(backing.get('nexterm.settings') ?? 'null');
        return raw?.data ?? raw ?? {};
      };
      useSettingsStore.getState().setSetting('terminalHideSingleTabStrip', true);
      useSettingsStore.getState().setSetting('terminalEqualizeOnSplit', true);
      assert.equal(useSettingsStore.getState().terminalHideSingleTabStrip, true);
      assert.equal(useSettingsStore.getState().terminalEqualizeOnSplit, true);
      assert.equal(saved().terminalHideSingleTabStrip, true, 'written');
      assert.equal(saved().terminalEqualizeOnSplit, true, 'written');
      useSettingsStore.getState().setSetting('terminalEqualizeOnSplit', false);
      assert.ok(!('terminalEqualizeOnSplit' in saved()), 'back at its default, it leaves storage');
    } finally {
      useSettingsStore.getState().resetSettings();
      if (shimInstalled) {
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
        shimInstalled = false;
      }
    }
  });

  test('SP-40: Equalize Splits and Swap Pane With… have no key and no menu entry, and a key the user gives them works over a terminal', () => {
    const eq = COMMANDS['equalize-splits'];
    const sw = COMMANDS['swap-pane'];
    assert.equal(eq?.title, 'Equalize Splits');
    assert.equal(sw?.title, 'Swap Pane With…');
    for (const id of ['equalize-splits', 'swap-pane']) {
      assert.equal(menuIdOf(id), null, `${id}: no native menu entry`);
      assert.deepEqual(keysFor(id), [], `${id}: no default chord, so nothing is taken from a shell as shipped`);
      assert.equal(COMMANDS[id].overTerminal, true, `${id}: a chord the user binds must work while a terminal has focus`);
      assert.ok(configurableCommands().some((c) => c.id === id), `${id}: a user can give it a key`);
    }
    const calls = [];
    eq.run({ equalizeSplits: () => calls.push('eq') });
    sw.run({ setCommandPaletteOpen: (open, mode) => calls.push([open, mode]) });
    assert.deepEqual(calls, ['eq', [true, 'swap-pane']]);
    // Bound by a user, it runs from a focused terminal, ahead of xterm.
    const { bindings } = resolveKeybindings({ 'equalize-splits': 'mod+alt+e' });
    assert.deepEqual(keysFor('equalize-splits', bindings), ['mod+alt+e']);
    let ran = 0;
    const e = { key: 'e', code: 'KeyE', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} };
    assert.equal(dispatchKeydownOverTerminal(e, { bindings, isMod: true, equalizeSplits: () => (ran += 1) }), 'equalize-splits');
    assert.equal(ran, 1);
  });

  test('SP-41: the palette offers the four new rows, hints only for keys the user bound', () => {
    const rows = paletteCommands(DEFAULT_RESOLVED);
    const by = (command) => rows.find((r) => r.command === command);
    assert.equal(by('equalize_splits')?.title, 'Equalize Splits');
    assert.equal(by('swap_pane')?.title, 'Swap Pane With…');
    assert.equal(by('swap_pane')?.opens, 'swap-pane', 'it turns the palette into a pick of panes');
    assert.equal(by('rename_terminal')?.title, 'Rename Terminal…');
    assert.equal(by('close_terminal')?.title, 'Close Terminal');
    assert.equal(by('equalize_splits').hint, '');
    const rebound = paletteCommands(resolveKeybindings({ 'swap-pane': 'mod+alt+s' }).bindings);
    assert.ok(rebound.find((r) => r.command === 'swap_pane').hint, 'a bound key is shown');
  });

  test('SP-42: the pane pick lists the other panes, filters by title and place, and says why it is empty', () => {
    const panes = [
      { paneId: 'p2', title: 'server', place: 'top right', index: 1, count: 3, terminals: 1 },
      { paneId: 'p3', title: 'tests', place: 'bottom right', index: 2, count: 3, terminals: 2 },
    ];
    const pick = (query, extra = {}) => buildPaletteGroups({ mode: 'swap-pane', panes, query, ...extra });
    const all = pick('');
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].items.map((i) => [i.type, i.paneId, i.title]), [['pane', 'p2', 'server'], ['pane', 'p3', 'tests']]);
    assert.ok(all[0].items[1].subtitle.includes('bottom right') && all[0].items[1].subtitle.includes('2 terminals'), all[0].items[1].subtitle);
    assert.deepEqual(pick('bottom')[0].items.map((i) => i.paneId), ['p3'], 'by place');
    assert.deepEqual(pick('serv')[0].items.map((i) => i.paneId), ['p2'], 'by title');
    const zoomed = pick('', { panes: [], panesNote: 'Unavailable while a pane is zoomed' });
    assert.equal(zoomed.length, 1, 'the group stays, for its note');
    assert.equal(zoomed[0].items.length, 0);
    assert.match(zoomed[0].note, /zoomed/);
  });

  test('SP-43: the palette runs each new row against the store, and the pick swaps with the active pane', () => {
    const palette = read('../../src/components/command/CommandPalette.jsx');
    assert.match(palette, /case 'equalize_splits':\n[^]*?equalizeSplits\?\.\(\)/);
    assert.match(palette, /case 'close_terminal':[^\n]*\n[^]*?closeTab\(/);
    assert.match(palette, /case 'rename_terminal':\n[^]*?requestTabRename\?\.\(\)/);
    assert.match(palette, /item\.type === 'pane'[^]*?swapActivePane\?\.\(item\.paneId\)/);
    assert.match(palette, /swapTargets\?\.\(\)/, 'the pick asks the store what to offer, and why not');
    const hook = read('../../src/hooks/useKeybindings.js');
    assert.match(hook, /equalizeSplits,/, 'the keyboard hands the store action over');
  });
});

describe('Split polish: renaming from elsewhere', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('SP-50: a rename asked for the active terminal waits for its pane to take it, once', async () => {
    const tabId = S.getState().activeTabId;
    assert.equal(S.getState().requestTabRename(), true);
    assert.equal(S.getState().renameRequest?.tabId, tabId);
    assert.equal(S.getState().takeRenameRequest('tab-term-999'), null, 'another pane cannot take it');
    assert.equal(S.getState().takeRenameRequest(tabId)?.tabId, tabId);
    assert.equal(S.getState().renameRequest, null, 'taken once');
    assert.equal(S.getState().requestTabRename('tab-term-999'), false, 'no such terminal');
    assert.equal(S.getState().renameRequest, null);
  });

  test('SP-99: teardown — the store and the settings are back to a fresh start', async () => {
    useSettingsStore.getState().resetSettings();
    assert.equal(useSettingsStore.getState().terminalEqualizeOnSplit, false);
  });
});
