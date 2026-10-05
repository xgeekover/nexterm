/**
 * Pane zoom — tmux's `Prefix z`, iTerm2's "Maximize Active Pane".
 *
 * In a group split into several panes, the active one is made to fill the
 * group's whole area while the others are hidden: hidden, not closed, their
 * programs still running, and the tree itself untouched, so that unzooming
 * puts back exactly the layout that was there.
 *
 * The model is one optional field on a group, `zoomedPaneId`, and one rule in
 * `settle`: a group is zoomed on its ACTIVE pane or not at all, and only while
 * it has another pane to hide. These cases hold the toggle, every way a zoom
 * has to end (the zoomed pane closing or emptying, a split, focus moving to a
 * pane the zoom hides, a tab landing in one), what survives a group switch and
 * a relaunch, which panes are drawn (`treeOnScreen` — TerminalSplitContainer
 * renders exactly that), and the three ways in: the keyboard, the menus and
 * the palette. The keyboard's rules about the chord itself are KB-16's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  useTerminalStore,
  PERSIST_KEY,
  panesOnScreen,
  treeOnScreen,
  zoomedPaneOf,
} from '../../src/stores/terminalStore.js';
import { runMenuAction, MENU_BAR } from '../../src/lib/menuActions.js';
import { paletteCommands } from '../../src/lib/paletteItems.js';
import { DEFAULT_RESOLVED, shortcutLabel } from '../../src/lib/keybindings.js';
import { isMac } from '../../src/lib/platform.js';

const S = useTerminalStore;

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
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

/** A pristine store, as if the app had just launched. */
async function freshStart({ keepStorage = false } = {}) {
  S.getState().dispose();
  installStorageShim();
  if (!keepStorage) backing.clear();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
  await S.getState().init();
}

// --- reading the layout -----------------------------------------------------
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};
const groups = () => S.getState().groups;
const groupById = (id) => groups().find((g) => g.id === id);
const activeGroup = () => groupById(S.getState().activeGroupId);
const paneOf = (tabId) => groups().flatMap((g) => leavesOf(g.tree)).find((p) => p.tabIds.includes(tabId));
const shownIds = (group = activeGroup()) => panesOnScreen(group).map((p) => p.id);
const allIds = (group = activeGroup()) => leavesOf(group.tree).map((p) => p.id);
const layoutOf = (group = activeGroup()) => JSON.stringify(group.tree);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Split the first group into three panes, left to right: [a | b | c], with
 * focus on `b` — the middle one, so "next" and "previous" both have somewhere
 * to go. Returns the pane ids.
 */
async function threePanes() {
  const a = activeGroup().activePaneId;
  const c = await S.getState().splitActivePane('horizontal');
  S.getState().setActivePane(a);
  const b = await S.getState().splitActivePane('horizontal');
  assert.deepEqual(allIds(), [a, b, c], 'setup: three panes side by side');
  assert.equal(activeGroup().activePaneId, b, 'setup: the middle one has focus');
  return { a, b, c };
}

/** Whatever the store holds, a zoom only ever sits on a live pane, which is active, in a group with company. */
function assertZoomInvariant(msg) {
  for (const group of groups()) {
    const leaves = leavesOf(group.tree);
    if ('zoomedPaneId' in group) {
      assert.ok(
        leaves.some((l) => l.id === group.zoomedPaneId),
        `${msg}: group ${group.id} is zoomed on ${group.zoomedPaneId}, which is not one of its panes`
      );
      assert.equal(group.zoomedPaneId, group.activePaneId, `${msg}: group ${group.id} is zoomed on a pane that is not its active one`);
      assert.ok(leaves.length > 1, `${msg}: group ${group.id} is zoomed with nothing to hide`);
      assert.deepEqual(shownIds(group), [group.zoomedPaneId], `${msg}: a zoomed group draws its zoomed pane alone`);
    } else {
      assert.deepEqual(shownIds(group), leaves.map((l) => l.id), `${msg}: an unzoomed group draws every pane`);
    }
  }
}

describe('Pane zoom: toggling', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('PZ-01: zooming fills the group with the active pane, and unzooming gives back the very same layout', async () => {
    const { a, b, c } = await threePanes();
    const split = activeGroup().tree.id;
    S.getState().setPaneSizes(null, split, [50, 30, 20]);
    const before = layoutOf();

    assert.equal(S.getState().togglePaneZoom(), true, 'the toggle reports the group zoomed');
    assert.equal(activeGroup().zoomedPaneId, b, 'the active pane is the zoomed one');
    assert.deepEqual(shownIds(), [b], 'it alone is drawn');
    assert.equal(treeOnScreen(activeGroup()).id, b, 'the tree on screen IS that pane');
    assert.equal(layoutOf(), before, 'the layout itself is untouched while zoomed');
    assert.deepEqual(allIds(), [a, b, c], 'the hidden panes are still there');
    assert.equal(S.getState().tabs.length, 3, 'and so are their terminals');

    assert.equal(S.getState().togglePaneZoom(), false, 'the second toggle reports it unzoomed');
    assert.equal('zoomedPaneId' in activeGroup(), false, 'the zoom is gone, not left behind as null');
    assert.deepEqual(shownIds(), [a, b, c], 'every pane is drawn again');
    assert.equal(layoutOf(), before, 'in exactly the arrangement it had — sizes included');
    assert.equal(activeGroup().activePaneId, b, 'and focus stays where it was');
    assertZoomInvariant('PZ-01');
  });

  test('PZ-02: a pane\'s own button zooms THAT pane, makes it the active one, and its tab the active tab', async () => {
    const { a } = await threePanes();
    const tabOfA = leavesOf(activeGroup().tree).find((p) => p.id === a).activeTabId;

    assert.equal(S.getState().togglePaneZoom(a, activeGroup().id), true);
    assert.equal(activeGroup().zoomedPaneId, a);
    assert.equal(activeGroup().activePaneId, a, 'the zoomed pane is the one the keyboard goes to');
    assert.equal(S.getState().activeTabId, tabOfA, 'and its terminal is the active one');
    assertZoomInvariant('PZ-02');
  });

  test('PZ-03: a group with one pane has nothing to hide, and is left as it is', async () => {
    const before = activeGroup();
    assert.equal(S.getState().togglePaneZoom(), false);
    assert.equal(activeGroup(), before, 'not even a new group object');
    assert.equal(zoomedPaneOf(activeGroup()), null);
  });

  test('PZ-04: the panes a zoom hides are drawn by nobody — the rendering decision', async () => {
    const { b } = await threePanes();
    const group = activeGroup();
    assert.equal(treeOnScreen(group), group.tree, 'unzoomed: the whole tree');

    S.getState().togglePaneZoom();
    const zoomed = activeGroup();
    assert.equal(treeOnScreen(zoomed).type, 'leaf');
    assert.equal(treeOnScreen(zoomed).id, b);

    // Read defensively: a zoom naming a pane that is not there — a state no
    // action leaves, but one a test or an arranged render can — draws the
    // whole tree rather than nothing.
    assert.equal(treeOnScreen({ ...zoomed, zoomedPaneId: 'pane-gone' }), zoomed.tree);
    const lone = { id: 'g', tree: { type: 'leaf', id: 'p', tabIds: ['t'], activeTabId: 't' }, activePaneId: 'p', zoomedPaneId: 'p' };
    assert.equal(zoomedPaneOf(lone), null, 'one pane is never "zoomed"');
    assert.equal(treeOnScreen(lone), lone.tree);
    assert.equal(zoomedPaneOf(null), null);
    assert.equal(treeOnScreen(null), null);
  });
});

describe('Pane zoom: what ends it', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('PZ-10: the zoomed pane closing ends the zoom, and the rest of the layout comes back', async () => {
    const { a, b, c } = await threePanes();
    S.getState().togglePaneZoom();
    await S.getState().closePane(b);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'no zoom on a pane that is gone');
    assert.deepEqual(allIds(), [a, c]);
    assert.deepEqual(shownIds(), [a, c], 'both survivors are drawn');
    assertZoomInvariant('PZ-10');
  });

  test('PZ-11: the zoomed pane losing its last tab ends the zoom', async () => {
    const { b } = await threePanes();
    S.getState().togglePaneZoom();
    const onlyTab = leavesOf(activeGroup().tree).find((p) => p.id === b).tabIds[0];
    await S.getState().closeTab(onlyTab);
    assert.equal('zoomedPaneId' in activeGroup(), false);
    assert.equal(shownIds().length, 2);
    assertZoomInvariant('PZ-11');
  });

  test('PZ-12: a hidden pane closing keeps the zoom — until nothing is left to hide', async () => {
    const { a, b, c } = await threePanes();
    S.getState().togglePaneZoom();
    // From the TERMINALS panel, the one place a hidden pane can still be reached.
    await S.getState().closePane(a);
    assert.equal(activeGroup().zoomedPaneId, b, 'one pane still hidden, so still zoomed');
    await S.getState().closePane(c);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'a group of one pane is not zoomed');
    assert.deepEqual(shownIds(), [b]);
    assertZoomInvariant('PZ-12');
  });

  test('PZ-13: a split unzooms, and the new pane is on screen', async () => {
    await threePanes();
    S.getState().togglePaneZoom();
    const fresh = await S.getState().splitActivePane('vertical');
    assert.ok(fresh);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'no pane made only to be hidden');
    assert.ok(shownIds().includes(fresh), 'the new pane is drawn');
    assert.equal(shownIds().length, 4);

    // The pane's own split button goes through `splitPane` directly.
    S.getState().togglePaneZoom();
    const zoomedOn = activeGroup().zoomedPaneId;
    assert.ok(zoomedOn);
    await S.getState().splitPane(zoomedOn, 'horizontal', activeGroup().id);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'splitPane unzooms too');
    assertZoomInvariant('PZ-13');
  });

  test('PZ-14: Focus Next/Previous Pane unzooms and moves on, as tmux does', async () => {
    const { a, b, c } = await threePanes();
    S.getState().togglePaneZoom();
    S.getState().focusNextPane(1);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'next pane: unzoomed');
    assert.equal(activeGroup().activePaneId, c, 'and on the next pane');

    S.getState().setActivePane(b);
    S.getState().togglePaneZoom();
    S.getState().focusNextPane(-1);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'previous pane: unzoomed');
    assert.equal(activeGroup().activePaneId, a);
    assertZoomInvariant('PZ-14');
  });

  test('PZ-15: going to a hidden pane or its terminal unzooms; staying on the zoomed one does not', async () => {
    const { a, b } = await threePanes();
    S.getState().togglePaneZoom();

    // The zoomed pane is clicked (every mousedown in it says so): no change.
    S.getState().setActivePane(b);
    assert.equal(activeGroup().zoomedPaneId, b, 'focusing the zoomed pane keeps the zoom');

    // Another tab of the zoomed pane: still the zoomed pane.
    const second = await S.getState().createTab();
    assert.equal(paneOf(second.id).id, b, 'a new terminal opens in the zoomed pane');
    assert.equal(activeGroup().zoomedPaneId, b, 'and the zoom holds');
    const first = paneOf(second.id).tabIds[0];
    S.getState().switchTab(first);
    assert.equal(activeGroup().zoomedPaneId, b, 'switching tabs inside it keeps the zoom');

    // A hidden pane's terminal, picked from the TERMINALS panel.
    const hiddenTab = leavesOf(activeGroup().tree).find((p) => p.id === a).tabIds[0];
    S.getState().switchTab(hiddenTab);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'going to a hidden terminal unzooms');
    assert.equal(activeGroup().activePaneId, a, 'and focuses the pane it is in');
    assert.equal(S.getState().activeTabId, hiddenTab);

    // A hidden pane's row in the panel.
    S.getState().setActivePane(b);
    S.getState().togglePaneZoom();
    S.getState().setActivePane(a);
    assert.equal('zoomedPaneId' in activeGroup(), false, 'focusing a hidden pane unzooms');
    assertZoomInvariant('PZ-15');
  });

  test('PZ-16: a tab dropped into the zoomed pane keeps the zoom; on its edge, or into a hidden pane, ends it', async () => {
    const { a, b } = await threePanes();
    const extra = await S.getState().createTab(); // lands in b, the active pane
    S.getState().togglePaneZoom();

    // Along its own strip: a reorder, nothing hidden is involved.
    S.getState().moveTabInStrip(extra.id, b, 0);
    assert.equal(activeGroup().zoomedPaneId, b, 'reordering the zoomed pane\'s tabs keeps the zoom');
    // On its own body: it is already there.
    S.getState().dropTabOnPane(extra.id, b, 'center');
    assert.equal(activeGroup().zoomedPaneId, b, 'dropping it back in place keeps the zoom');

    // Into a hidden pane — no drag on screen can reach one, every other route
    // makes that pane the active one.
    S.getState().dropTabOnPane(extra.id, a, 'center');
    assert.equal('zoomedPaneId' in activeGroup(), false, 'a tab moved into a hidden pane unzooms');
    assert.equal(paneOf(extra.id).id, a);

    // Onto the zoomed pane's edge: a split.
    S.getState().setActivePane(a);
    S.getState().togglePaneZoom();
    S.getState().dropTabOnPane(extra.id, a, 'bottom');
    assert.equal('zoomedPaneId' in activeGroup(), false, 'a drop that splits unzooms');
    assert.equal(shownIds().length, 4, 'and the new pane is drawn with the rest');
    assertZoomInvariant('PZ-16');
  });

  test('PZ-17: a terminal moved in from another group lands in the zoomed pane, in view', async () => {
    const { b } = await threePanes();
    const home = activeGroup().id;
    S.getState().togglePaneZoom();
    const other = await S.getState().createGroup({ name: 'Other' });
    const visitor = leavesOf(groupById(other.id).tree)[0].tabIds[0];

    S.getState().moveTabToGroup(visitor, home);
    assert.equal(paneOf(visitor).id, b, 'it joins the pane on screen, not a hidden one');
    assert.equal(groupById(home).zoomedPaneId, b, 'and the zoom holds');
    assertZoomInvariant('PZ-17');
  });

  test('PZ-18: the zoomed pane\'s only terminal moved to a new group ends the zoom it leaves behind', async () => {
    const { b } = await threePanes();
    const home = activeGroup().id;
    S.getState().togglePaneZoom();
    const lone = leavesOf(groupById(home).tree).find((p) => p.id === b).tabIds[0];
    S.getState().moveTabToNewGroup(lone);
    assert.equal('zoomedPaneId' in groupById(home), false, 'the pane emptied, so the zoom went with it');
    assert.equal(leavesOf(groupById(home).tree).length, 2);
    assertZoomInvariant('PZ-18');
  });
});

describe('Pane zoom: groups, restarts and notifications', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('PZ-20: every group keeps its own zoom across group switches', async () => {
    const { b } = await threePanes();
    const first = activeGroup().id;
    S.getState().togglePaneZoom();

    const second = await S.getState().createGroup({ name: 'Second' });
    const secondPane = await S.getState().splitActivePane('vertical');
    S.getState().togglePaneZoom();
    assert.equal(groupById(second.id).zoomedPaneId, secondPane);

    S.getState().setActiveGroup(first);
    assert.equal(groupById(first).zoomedPaneId, b, 'back to the first group: still zoomed on b');
    assert.deepEqual(shownIds(), [b]);
    assert.equal(groupById(second.id).zoomedPaneId, secondPane, 'and the second keeps its own');

    S.getState().setActiveGroup(second.id);
    assert.deepEqual(shownIds(), [secondPane]);
    assertZoomInvariant('PZ-20');
  });

  test('PZ-21: a zoom is never saved, and never schedules a save', async () => {
    await threePanes();
    await wait(400); // let the layout's own write land
    const saved = backing.get(PERSIST_KEY);
    assert.ok(saved, 'setup: the layout was written');

    S.getState().togglePaneZoom();
    await wait(400);
    assert.equal(backing.get(PERSIST_KEY), saved, 'zooming wrote nothing');

    // A real change while zoomed is written — without the zoom in it.
    S.getState().renameGroup(activeGroup().id, 'Zoomed while saved');
    await wait(400);
    const written = backing.get(PERSIST_KEY);
    assert.notEqual(written, saved);
    assert.equal(written.includes('zoomedPaneId'), false, 'the payload has no zoom in it');

    // And a relaunch comes back with every pane in view.
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await freshStart({ keepStorage: true });
    assert.equal(activeGroup().name, 'Zoomed while saved', 'setup: this is the saved layout');
    assert.equal('zoomedPaneId' in activeGroup(), false, 'restored unzoomed');
    assert.equal(shownIds().length, 3);
  });

  test('PZ-22: a terminal hidden by a zoom is off screen to a program that asks to be heard only then', async () => {
    const { a } = await threePanes();
    const hiddenTab = leavesOf(activeGroup().tree).find((p) => p.id === a).activeTabId;
    const note = { occasion: 'invisible', title: 'opencode', body: 'Session done' };
    const looking = { visible: true, focused: true };

    // Not the active terminal, but on screen beside it: kitty's `invisible`
    // says nothing about a terminal you can see.
    assert.deepEqual(S.getState().notifyFromProgram(hiddenTab, note, looking), { inApp: false, desktop: false });

    // Zoomed onto the middle pane, the same terminal is hidden: it is heard.
    S.getState().togglePaneZoom();
    assert.deepEqual(S.getState().notifyFromProgram(hiddenTab, note, looking), { inApp: true, desktop: false });
    assert.equal(S.getState().notifications[0]?.tabId, hiddenTab, 'and lands in the bell');
  });

  test('PZ-23: nothing any action does leaves a zoom where it cannot be (a seeded walk)', async () => {
    // A small deterministic fuzz over the actions that change layout or focus:
    // after every step a zoom is on a live, active pane of a group with
    // company, and the group draws exactly what `treeOnScreen` says.
    let seed = 20261005;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const zones = ['center', 'left', 'right', 'top', 'bottom'];

    for (let step = 0; step < 80; step += 1) {
      const st = S.getState();
      const tabs = st.tabs.map((t) => t.id);
      const paneIds = allIds();
      const op = pick([
        'zoom', 'zoom', 'zoom', 'next', 'prev', 'split', 'create', 'close-tab', 'close-pane',
        'focus-pane', 'switch-tab', 'new-group', 'switch-group', 'drop', 'strip', 'to-group',
      ]);
      if (op === 'zoom') st.togglePaneZoom();
      else if (op === 'next') st.focusNextPane(1);
      else if (op === 'prev') st.focusNextPane(-1);
      else if (op === 'split' && tabs.length < 9) await st.splitActivePane(rand() < 0.5 ? 'horizontal' : 'vertical');
      else if (op === 'create' && tabs.length < 9) await st.createTab();
      else if (op === 'close-tab' && tabs.length > 2) await st.closeTab(pick(tabs));
      else if (op === 'close-pane' && paneIds.length > 1) await st.closePane(pick(paneIds));
      else if (op === 'focus-pane') st.setActivePane(pick(paneIds));
      else if (op === 'switch-tab') st.switchTab(pick(tabs));
      else if (op === 'new-group' && st.groups.length < 3 && tabs.length < 9) await st.createGroup({});
      else if (op === 'switch-group') st.setActiveGroup(pick(st.groups).id);
      else if (op === 'drop') st.dropTabOnPane(pick(tabs), pick(paneIds), pick(zones));
      else if (op === 'strip') st.moveTabInStrip(pick(tabs), pick(paneIds), Math.floor(rand() * 3));
      else if (op === 'to-group') st.moveTabToGroup(pick(tabs), pick(st.groups).id);
      assertZoomInvariant(`step ${step} (${op})`);
    }
  });
});

describe('Pane zoom: the ways in', () => {
  beforeEach(() => freshStart());
  afterEach(teardown);

  test('PZ-30: the menu item toggles the active group\'s zoom, from either menu', async () => {
    const { b } = await threePanes();
    runMenuAction('toggle-pane-zoom');
    assert.equal(activeGroup().zoomedPaneId, b, 'the native menu and ☰ both dispatch here');
    runMenuAction('toggle-pane-zoom');
    assert.equal('zoomedPaneId' in activeGroup(), false);

    // Drawn in the Terminal menu, beside the other pane commands, with the
    // chord that actually runs it.
    const terminalMenu = MENU_BAR.find((m) => m.title === 'Terminal');
    const item = terminalMenu.items.find((i) => i.id === 'toggle-pane-zoom');
    assert.ok(item, 'Terminal ▸ Toggle Pane Zoom');
    assert.equal(item.label, 'Toggle Pane Zoom');
    assert.equal(item.key, 'mod+shift+enter');

    // And the native menu declares the same id, with the accelerator the
    // frontend would send (NM-01 compares every item against `cargo test`'s
    // fixture where one exists; this holds even where it does not).
    const menuRs = readFileSync(fileURLToPath(new URL('../../src-tauri/src/menu.rs', import.meta.url)), 'utf8');
    assert.ok(
      /custom\("toggle-pane-zoom", "Toggle Pane Zoom", "CmdOrCtrl\+Shift\+Enter"\)/.test(menuRs),
      'menu.rs declares Toggle Pane Zoom with CmdOrCtrl+Shift+Enter'
    );
  });

  test('PZ-31: the palette offers it, with the bound chord, and dispatches it', async () => {
    const row = paletteCommands().find((c) => c.command === 'toggle_pane_zoom');
    assert.ok(row, 'a palette row');
    assert.equal(row.title, 'Toggle Pane Zoom');
    // Whichever platform this runs as — Node 20 has no `navigator`, so CI reads
    // as "not macOS" everywhere — the row says what the menu says.
    assert.equal(row.hint, shortcutLabel('toggle-pane-zoom', DEFAULT_RESOLVED, { isMac }));
    assert.ok(row.hint, 'and it says something');
    // A rebind shows in the row, as in every other.
    const rebound = paletteCommands([{ command: 'toggle-pane-zoom', key: 'mod+alt+z', chord: { mod: true, alt: true, key: 'z' } }]);
    assert.ok(/Z$/.test(rebound.find((c) => c.command === 'toggle_pane_zoom').hint), 'the hint follows the binding');

    // CommandPalette.jsx is a component the suites cannot click; its dispatch
    // must name the row's command, or the row is one that does nothing.
    const palette = readFileSync(
      fileURLToPath(new URL('../../src/components/command/CommandPalette.jsx', import.meta.url)),
      'utf8'
    );
    assert.ok(/case 'toggle_pane_zoom':\s*\n[^]*?togglePaneZoom/.test(palette), 'CommandPalette dispatches toggle_pane_zoom');
  });
});
