/**
 * One drag system for both kinds of tab (editor placement, sibling C, FC3;
 * AC-C3), on a page small enough to write by hand.
 *
 * Since sibling C a file is a pane of the workbench, beside, above or under
 * a terminal, and TerminalSplitContainer.jsx has ONE hit test
 * (`dropTargetAtPoint`, with `tabTargetAt` adding the group switcher), ONE
 * drop dispatcher (`dropDraggedTab`) and one indicator for both. What these
 * cases pin:
 *
 *   - WD-01: the hit test names the pane's kind (`paneKind`) for all four
 *     attribute sets — a terminal pane's `[data-tab-strip]` and
 *     `[data-pane-body]`, an editor pane's `[data-editor-tab-strip]` and
 *     `[data-editor-pane-body]` — for a tab of its own kind and for none.
 *   - WD-02: across kinds a pane body has no centre. A grid of points over a
 *     terminal body, for a file, maps every point to its nearest edge and
 *     none to the centre; the same over an editor body for a terminal. The
 *     same kind keeps its centre.
 *   - WD-03: the other kind's strip is no target at all, at any point of it
 *     (chips, gaps, buttons), so nothing is drawn; a release there, of a
 *     file (the whole gesture, through EditorTabs' `trackTabDrag`) or of a
 *     terminal, leaves both stores deep-equal.
 *   - WD-04: each of the 4 edges, in both directions, ends in the right
 *     tree: the new pane beside the one aimed at, on that side, in a split of
 *     that direction, holding only the dragged tab, and THE active pane.
 *   - WD-05: a file dropped on another group's chip moves there; on its own
 *     group's chip it is no target and nothing changes.
 *
 * A file's gesture is driven through `trackTabDrag` with a window of our own,
 * aimed by `fileTabTargetAt` and dropped by `dropDraggedTab`, exactly as the
 * component wires them (`beginEditorDrag`). A terminal's gesture follower
 * (`trackGesture`) lives in the component; its target is `tabTargetAt` and its
 * drop `dropDraggedTab`, which these cases call as it does. The real pointer
 * in a real browser is workbench_drag_headless.test.js.
 *
 * Node cannot parse JSX; the render suite's loader can (as in
 * tab_reorder_ui.test.js). The stores are the real ones, with the browser
 * mock of src/lib/ipc.js under them.
 */
import { register } from 'node:module';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore, registerEditorBridge } from '../../src/stores/editorStore.js';
import { useTerminalStore, activePaneOf } from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { invoke } from '../../src/lib/ipc.js';
import { leafKind } from '../../src/components/terminal/splitLayout.js';

register('../render/jsxLoader.mjs', import.meta.url);
const UI = await import('../../src/components/terminal/TerminalSplitContainer.jsx');
const { trackTabDrag } = await import('../../src/components/editor/EditorTabs.jsx');

const E = useEditorStore;
const T = useTerminalStore;
const EDGES = ['left', 'right', 'top', 'bottom'];

// --- storage --------------------------------------------------------------------
const backing = new Map();
let previousStorage;
let hadStorage = false;
let installed = false;

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

let counter = 0;
async function file(name) {
  counter += 1;
  const path = `/workspace/_wd_${name}_${Date.now()}_${counter}.txt`;
  await invoke('fs_write_file', { path, content: `${name}\n` });
  return path;
}

/**
 * One group: a file pane [a, b] above a terminal pane [t1, t2] — what
 * opening two files beside two terminals makes (FB4: [editor 60 | terminals
 * 40]).
 */
const ids = {};
async function setUp() {
  T.getState().dispose();
  backing.clear();
  installStorage();
  useSettingsStore.getState().resetSettings();
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
  // `init` may already have started the group's first terminal; two at least.
  while (T.getState().tabs.length < 2) await T.getState().createTab();
  const terminals = leaves(group().tree)[0].tabIds;
  ids.terminals = [...terminals];
  ids.t1 = terminals[0];
  ids.t2 = terminals.at(-1);
  ids.a = (await E.getState().openFile(await file('a'))).id;
  ids.b = (await E.getState().openFile(await file('b'))).id;
  const g = group();
  ids.group = g.id;
  ids.terminal = leaves(g.tree).find((l) => l.tabIds.includes(ids.t1)).id;
  ids.editor = leaves(g.tree).find((l) => l.tabIds.includes(ids.a)).id;
  assert.equal(leafKind(leaves(g.tree).find((l) => l.id === ids.editor)), 'editor');
  assert.ok(ids.terminals.length >= 2 && ids.terminals.every((id) => leaves(g.tree).find((l) => l.id === ids.terminal).tabIds.includes(id)), 'the terminals in one pane');
  assert.deepEqual(leaves(g.tree).find((l) => l.id === ids.editor).tabIds, [ids.a, ids.b], 'both files in one pane');
}

function teardown() {
  E.setState({ tabs: [], activeTabId: null, pendingClose: null });
  T.getState().dispose();
  useSettingsStore.getState().resetSettings();
  if (installed) {
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
    installed = false;
  }
}

const leaves = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
};
const group = (id = null) => {
  const s = T.getState();
  return s.groups.find((g) => g.id === (id ?? s.activeGroupId));
};
function parentOf(node, id) {
  if (!node || node.type !== 'split') return null;
  for (const child of node.children) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}
/** Everything a drop could change, in both stores, as plain data. */
const snapshot = () =>
  structuredClone({
    groups: T.getState().groups,
    activeGroupId: T.getState().activeGroupId,
    terminalActiveTab: T.getState().activeTabId,
    tabs: T.getState().tabs.map((t) => t.id),
    files: E.getState().tabs.map((t) => t.id),
    fileActiveTab: E.getState().activeTabId,
  });

// --- a page small enough to write by hand (as in tab_reorder_ui.test.js) ---------

const box = (left, right, top, bottom) => ({ left, right, top, bottom });

/** An element: attributes, a box, children; attribute selectors only, anything else throws. */
function el(attrs, rect, children = []) {
  const matches = (selector) => {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!m) throw new Error(`the test page knows attribute selectors only, not ${selector}`);
    return m[1] in attrs && (m[2] === undefined || String(attrs[m[1]]) === m[2]);
  };
  const node = {
    attrs,
    rect,
    children,
    parent: null,
    isConnected: true,
    scrollLeft: 0,
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

/** `elementFromPoint` (the deepest element under the point) and `querySelector` for a page of `el`s. */
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
  return { elementFromPoint: (x, y) => under(root, x, y), querySelector: (s) => root.querySelector(s) };
}

/**
 * The workbench as the component draws it, in the shape that matters to the
 * hit test: the group switcher on top, then the terminal pane (its strip —
 * the row of chips, then its buttons — over its body) left of the editor
 * pane (the same, with the editor's own attributes).
 */
const RECTS = {
  switcher: box(0, 800, 0, 30),
  switcherRow: box(30, 600, 2, 28),
  terminalStrip: box(0, 400, 30, 58),
  terminalRow: box(0, 340, 30, 58),
  terminalButtons: box(340, 400, 30, 58),
  terminalBody: box(0, 400, 58, 400),
  editorStrip: box(400, 800, 30, 58),
  editorRow: box(400, 740, 30, 58),
  editorButtons: box(740, 800, 30, 58),
  editorBody: box(400, 800, 58, 400),
};
function workbenchPage({ groups = [ids.group] } = {}) {
  const chip = (attr, id, i, row) => el({ [attr]: id }, box(row.left + 2 + i * 90, row.left + 88 + i * 90, row.top + 2, row.bottom - 2));
  const switcher = el({ 'data-group-switcher': '' }, RECTS.switcher, [
    el({ 'data-chip-row': '' }, RECTS.switcherRow, groups.map((g, i) => chip('data-group-chip', g, i, RECTS.switcherRow))),
  ]);
  const terminalPane = el({}, box(0, 400, 30, 400), [
    el({ 'data-tab-strip': ids.terminal }, RECTS.terminalStrip, [
      el({ 'data-chip-row': '' }, RECTS.terminalRow, ids.terminals.map((id, i) => chip('data-tab-chip', id, i, RECTS.terminalRow))),
      el({ title: 'Split Right' }, RECTS.terminalButtons),
    ]),
    el({ 'data-pane-body': ids.terminal }, RECTS.terminalBody),
  ]);
  const editorPane = el({}, box(400, 800, 30, 400), [
    el({ 'data-editor-tab-strip': ids.editor }, RECTS.editorStrip, [
      el({ 'data-editor-tab-row': ids.editor }, RECTS.editorRow, [ids.a, ids.b].map((id, i) => chip('data-tab-chip', id, i, RECTS.editorRow))),
      el({ title: 'Split Right' }, RECTS.editorButtons),
    ]),
    el({ 'data-editor-pane-body': ids.editor }, RECTS.editorBody),
  ]);
  return pageOf(el({}, box(0, 2000, 0, 2000), [switcher, terminalPane, editorPane]));
}

const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
/** A point just inside `r`, by `edge`, half way along it. */
function nearEdge(r, edge, inset = 6) {
  const { x, y } = mid(r);
  return {
    left: { x: r.left + inset, y },
    right: { x: r.right - inset, y },
    top: { x, y: r.top + inset },
    bottom: { x, y: r.bottom - inset },
  }[edge];
}
/** The point's nearest edge of `r`, by fraction of the rect — or null at a tie. */
function nearestEdge(r, x, y) {
  const fx = (x - r.left) / (r.right - r.left);
  const fy = (y - r.top) / (r.bottom - r.top);
  const d = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ].sort((p, q) => p[1] - q[1]);
  return d[1][1] - d[0][1] < 1e-9 ? null : d[0][0];
}
/** Every point of a grid of n x n over `r`, short of its border. */
function grid(r, n = 15) {
  const points = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      points.push({ x: r.left + 1 + ((r.right - r.left - 2) * (i + 0.5)) / n, y: r.top + 1 + ((r.bottom - r.top - 2) * (j + 0.5)) / n });
    }
  }
  return points;
}

/** A window of our own for `trackTabDrag`: listeners kept, events fired by hand. */
function fakeWindow() {
  const handlers = new Map();
  return {
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type, fn) => {
      if (handlers.get(type) === fn) handlers.delete(type);
    },
    fire: (type, ev = {}) => handlers.get(type)?.(ev),
    listening: () => [...handlers.keys()],
  };
}

/**
 * A FILE tab's chip pressed at `from`, moved to `to` and let go, wired as
 * the component's `beginEditorDrag` wires it. Returns the drag state the
 * indicator was drawn from at the release, and what was dropped (null when
 * the release was over no target, and so dropped nothing).
 */
function dragFile(tabId, from, to, doc) {
  const win = fakeWindow();
  const tab = E.getState().tabs.find((t) => t.id === tabId);
  const states = [];
  let dropped = null;
  trackTabDrag(tab, { clientX: from.x, clientY: from.y }, {
    targetAt: (x, y) => UI.fileTabTargetAt(x, y, T.getState().activeGroupId, doc),
    onChange: (d) => states.push(d),
    onDrop: (cur) => {
      dropped = cur;
      UI.dropDraggedTab(cur);
    },
    win,
    doc,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  win.fire('pointermove', { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  win.fire('pointermove', { clientX: to.x, clientY: to.y });
  const shown = states.at(-1);
  win.fire('pointerup', {});
  assert.deepEqual(win.listening(), [], 'the gesture left listeners behind');
  assert.equal(states.at(-1), null, 'the drag state was not cleared on release');
  return { shown, dropped };
}

/** A TERMINAL tab let go at `to`: the component's target (`tabTargetAt`, less `index`) and drop. */
function dropTerminal(tabId, to, doc) {
  const { index: _index, row: _row, ...target } = UI.tabTargetAt(to.x, to.y, 'terminal', T.getState().activeGroupId, doc);
  const cur = { kind: 'tab', tabKind: 'terminal', tabId, active: true, ...target };
  UI.dropDraggedTab(cur);
  return cur;
}

const fileChip = (id) => mid(box(RECTS.editorRow.left + 2 + [ids.a, ids.b].indexOf(id) * 90, RECTS.editorRow.left + 88 + [ids.a, ids.b].indexOf(id) * 90, 32, 56));

describe('Workbench drag: one hit test and one drop for both kinds (sibling C, AC-C3)', () => {
  beforeEach(setUp);
  afterEach(teardown);

  test('WD-01: dropTargetAtPoint names the pane kind for all four attribute sets', () => {
    const doc = workbenchPage();
    for (const tabKind of [null, 'terminal']) {
      const strip = UI.dropTargetAtPoint(mid(RECTS.terminalRow).x, mid(RECTS.terminalRow).y, doc, tabKind);
      assert.equal(strip.paneKind, 'terminal', `[data-tab-strip], tabKind ${tabKind}`);
      assert.equal(strip.paneId, ids.terminal);
      assert.equal(strip.zone, 'tabs');
      assert.equal(typeof strip.slot, 'number');
      const body = UI.dropTargetAtPoint(mid(RECTS.terminalBody).x, mid(RECTS.terminalBody).y, doc, tabKind);
      assert.deepEqual(body, { paneId: ids.terminal, paneKind: 'terminal', zone: 'center', row: null }, `[data-pane-body], tabKind ${tabKind}`);
    }
    for (const tabKind of [null, 'editor']) {
      const strip = UI.dropTargetAtPoint(mid(RECTS.editorRow).x, mid(RECTS.editorRow).y, doc, tabKind);
      assert.equal(strip.paneKind, 'editor', `[data-editor-tab-strip], tabKind ${tabKind}`);
      assert.equal(strip.paneId, ids.editor);
      assert.equal(strip.zone, 'tabs');
      assert.equal(typeof strip.index, 'number');
      const body = UI.dropTargetAtPoint(mid(RECTS.editorBody).x, mid(RECTS.editorBody).y, doc, tabKind);
      assert.equal(body.paneKind, 'editor', `[data-editor-pane-body], tabKind ${tabKind}`);
      assert.equal(body.paneId, ids.editor);
      assert.equal(body.zone, 'center');
    }
    // Across kinds the bodies still say whose they are.
    assert.equal(UI.dropTargetAtPoint(mid(RECTS.terminalBody).x, mid(RECTS.terminalBody).y, doc, 'editor').paneKind, 'terminal');
    assert.equal(UI.dropTargetAtPoint(mid(RECTS.editorBody).x, mid(RECTS.editorBody).y, doc, 'terminal').paneKind, 'editor');
    // Off every pane: no target, and the switcher is a target only through tabTargetAt.
    assert.equal(UI.dropTargetAtPoint(5, 10, doc, 'editor'), null);
  });

  test('WD-02: across kinds every point of a body is its nearest edge, never the centre — both ways', () => {
    const doc = workbenchPage();
    for (const [tabKind, rect, paneId, paneKind] of [
      ['editor', RECTS.terminalBody, ids.terminal, 'terminal'],
      ['terminal', RECTS.editorBody, ids.editor, 'editor'],
    ]) {
      const seen = new Set();
      const points = [...grid(rect), mid(rect)];
      for (const p of points) {
        const hit = UI.dropTargetAtPoint(p.x, p.y, doc, tabKind);
        assert.ok(hit, `a ${tabKind} tab over the ${paneKind} body at (${p.x}, ${p.y}) has no target`);
        assert.equal(hit.paneId, paneId);
        assert.equal(hit.paneKind, paneKind);
        assert.ok(EDGES.includes(hit.zone), `a ${tabKind} tab over the ${paneKind} body at (${p.x}, ${p.y}) is '${hit.zone}', not an edge`);
        const want = nearestEdge(rect, p.x, p.y);
        if (want) assert.equal(hit.zone, want, `(${p.x}, ${p.y}) is nearest the ${want} edge`);
        seen.add(hit.zone);
      }
      assert.deepEqual([...seen].sort(), [...EDGES].sort(), `the grid over the ${paneKind} body did not reach every edge`);
    }
    // The same kind keeps its centre, as before sibling C.
    assert.equal(UI.dropTargetAtPoint(mid(RECTS.terminalBody).x, mid(RECTS.terminalBody).y, doc, 'terminal').zone, 'center');
    assert.equal(UI.dropTargetAtPoint(mid(RECTS.editorBody).x, mid(RECTS.editorBody).y, doc, 'editor').zone, 'center');
  });

  test('WD-03: the other kind\'s strip is no target anywhere, and a release there changes nothing in either store', () => {
    const doc = workbenchPage();
    for (const [tabKind, strip] of [
      ['editor', RECTS.terminalStrip],
      ['terminal', RECTS.editorStrip],
    ]) {
      for (const p of grid(strip, 12)) {
        assert.equal(UI.dropTargetAtPoint(p.x, p.y, doc, tabKind), null, `a ${tabKind} tab over the other strip at (${p.x}, ${p.y})`);
        const target = UI.tabTargetAt(p.x, p.y, tabKind, ids.group, doc);
        assert.deepEqual(
          { targetPaneId: target.targetPaneId, zone: target.zone, targetGroupId: target.targetGroupId },
          { targetPaneId: null, zone: null, targetGroupId: null },
          `nothing to draw for a ${tabKind} tab at (${p.x}, ${p.y})`
        );
      }
    }

    // A file, the whole gesture: pressed on its chip, let go over a terminal chip.
    const before = snapshot();
    const onChip = mid(box(RECTS.terminalRow.left + 2, RECTS.terminalRow.left + 88, 32, 56));
    const { shown, dropped } = dragFile(ids.b, fileChip(ids.b), onChip, doc);
    assert.equal(shown.active, true, 'the gesture never became a drag');
    assert.equal(shown.targetPaneId, null, 'a target was drawn over the terminal strip');
    assert.equal(shown.zone, null);
    assert.equal(dropped, null, 'something was dropped');
    assert.deepEqual(snapshot(), before, 'a file let go over the terminal strip changed the stores');
    // And over the terminal strip's buttons.
    dragFile(ids.b, fileChip(ids.b), mid(RECTS.terminalButtons), doc);
    assert.deepEqual(snapshot(), before, 'a file let go over the terminal strip\'s buttons changed the stores');

    // A terminal let go over a file chip, and over the editor strip's buttons.
    for (const p of [fileChip(ids.a), mid(RECTS.editorButtons)]) {
      const cur = dropTerminal(ids.t2, p, doc);
      assert.equal(cur.targetPaneId, null);
      assert.deepEqual(snapshot(), before, `a terminal let go over the editor strip at (${p.x}, ${p.y}) changed the stores`);
    }
  });

  for (const edge of EDGES) {
    test(`WD-04 (${edge}): a file let go on a terminal pane's ${edge} edge splits it there, the file alone in a new pane`, () => {
      const doc = workbenchPage();
      const { shown, dropped } = dragFile(ids.b, fileChip(ids.b), nearEdge(RECTS.terminalBody, edge), doc);
      assert.equal(shown.zone, edge, 'the indicator did not show that edge');
      assert.equal(shown.targetPaneId, ids.terminal);
      assert.equal(shown.paneKind, 'terminal');
      assert.ok(dropped, 'nothing was dropped');
      const g = group();
      const split = parentOf(g.tree, ids.terminal);
      assert.ok(split, 'the terminal pane is not in a split');
      assert.equal(split.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', 'the split goes the wrong way');
      const at = split.children.findIndex((c) => c.id === ids.terminal);
      const fresh = split.children[edge === 'left' || edge === 'top' ? at - 1 : at + 1];
      assert.ok(fresh, `no pane on the ${edge} of the terminal`);
      assert.equal(leafKind(fresh), 'editor', `the pane on the ${edge} is not a file pane`);
      assert.deepEqual(fresh.tabIds, [ids.b], 'b.js is not alone in the new pane');
      assert.deepEqual(leaves(g.tree).find((l) => l.id === ids.editor).tabIds, [ids.a], 'b.js is still in the pane it left');
      assert.deepEqual(leaves(g.tree).find((l) => l.id === ids.terminal).tabIds, ids.terminals, 'the terminals moved');
      assert.equal(activePaneOf(g), fresh.id, 'the new pane is not the active one');
      assert.equal(E.getState().activeTabId, ids.b, 'b.js is not the active file');
    });

    test(`WD-04 (${edge}, the other way): a terminal let go on a file pane's ${edge} edge splits it there, the terminal alone in a new pane`, () => {
      const doc = workbenchPage();
      const point = nearEdge(RECTS.editorBody, edge);
      const cur = dropTerminal(ids.t2, point, doc);
      assert.equal(cur.zone, edge, 'the indicator did not show that edge');
      assert.equal(cur.targetPaneId, ids.editor);
      assert.equal(cur.paneKind, 'editor');
      const g = group();
      const split = parentOf(g.tree, ids.editor);
      assert.ok(split, 'the file pane is not in a split');
      assert.equal(split.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', 'the split goes the wrong way');
      const at = split.children.findIndex((c) => c.id === ids.editor);
      const fresh = split.children[edge === 'left' || edge === 'top' ? at - 1 : at + 1];
      assert.ok(fresh, `no pane on the ${edge} of the file pane`);
      assert.notEqual(leafKind(fresh), 'editor', `the pane on the ${edge} is not a terminal pane`);
      assert.deepEqual(fresh.tabIds, [ids.t2], 't2 is not alone in the new pane');
      assert.deepEqual(leaves(g.tree).find((l) => l.id === ids.terminal).tabIds, ids.terminals.slice(0, -1), 't2 is still in the pane it left');
      assert.deepEqual(leaves(g.tree).find((l) => l.id === ids.editor).tabIds, [ids.a, ids.b], 'the files moved');
      assert.equal(activePaneOf(g), fresh.id, 'the new pane is not the active one');
      assert.equal(g.activePaneId, fresh.id, 'the new terminal pane is not the active terminal pane');
    });
  }

  test('WD-05: a file let go on another group\'s chip moves into that group; on its own group\'s chip nothing happens', async () => {
    const other = (await T.getState().createGroup()).id;
    T.getState().setActiveGroup(ids.group);
    const doc = workbenchPage({ groups: [ids.group, other] });
    const chipOf = (i) => mid(box(RECTS.switcherRow.left + 2 + i * 90, RECTS.switcherRow.left + 88 + i * 90, 4, 26));

    const before = snapshot();
    const own = dragFile(ids.b, fileChip(ids.b), chipOf(0), doc);
    assert.equal(own.shown.targetGroupId, null, 'the chip of the group on screen was drawn as a target');
    assert.equal(own.dropped, null);
    assert.deepEqual(snapshot(), before, 'a file let go on its own group\'s chip changed the stores');

    const moved = dragFile(ids.b, fileChip(ids.b), chipOf(1), doc);
    assert.equal(moved.shown.targetGroupId, other, 'the other group\'s chip was not the target');
    assert.equal(moved.shown.targetPaneId, null);
    assert.ok(moved.dropped, 'nothing was dropped');
    const there = leaves(group(other).tree).filter((l) => leafKind(l) === 'editor');
    assert.ok(there.some((l) => l.tabIds.includes(ids.b)), 'b.js is not in the other group');
    assert.ok(!leaves(group(ids.group).tree).some((l) => l.tabIds.includes(ids.b)), 'b.js is still in the group it left');
    assert.deepEqual(leaves(group(ids.group).tree).find((l) => l.id === ids.editor).tabIds, [ids.a]);
    assert.equal(T.getState().activeGroupId, other, 'the move did not bring the other group on screen');
  });
});
