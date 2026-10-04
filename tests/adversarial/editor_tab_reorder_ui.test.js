/**
 * The UI half of reordering editor tabs: everything between the press on a
 * chip and the store call it ends in.
 *
 * `editor_tab_reorder.test.js` pins that store call, `moveEditorTabInStrip`.
 * What decides its arguments lives in EditorPanel.jsx and EditorTabs.jsx, and
 * none of it ran in any suite — EditorPanel.jsx could be put back to a version
 * without any of it and every suite stayed green. Meanwhile a strip with more
 * tabs than fit, which scrolls, measured the drop against every chip in it,
 * the ones scrolled out of sight included: let go over the strip's own
 * buttons, a tab went in past the last chip in view, with its marker drawn
 * where nobody could see it, and the end of the strip could not be reached.
 *
 * So these cases run the real code of both files against geometry given by
 * hand: a row of a stated width, chips where the case puts them, scrolled as
 * far as it says. What a real layout hands that code is checked by driving
 * the app (see TEST_INFRA.md); what is checked here is what the code does
 * with it.
 *
 * Node cannot import a .jsx file, and EditorPanel.jsx imports Monaco, which
 * does not load outside a browser at all. So the two files are bundled here
 * with esbuild (already present — the render suite transforms JSX with it),
 * React kept real and every other import replaced by a stand-in that nothing
 * these cases reach ever calls. The bundle is imported from a data: URL:
 * nothing is registered process-wide, and no other suite in this process
 * meets a loader it did not ask for. Nor does any case touch a real store or
 * a global, which is why this file needs no teardown case.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

// ---- The two files under test, bundled ---------------------------------------

const EDITOR_DIR = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));

/** Bundled as they are: the files under test, and a helper with no imports. */
const BUNDLED = [/^\.\/Editor(Panel|Tabs)\.jsx$/, /\/lib\/utils\.js$/];
/** Kept real, so that the strip really draws. */
const REAL = new Set(['react', 'react/jsx-runtime', 'lucide-react']);

/** The editor store as far as EditorTabs reads it to draw: what the case says. */
const FAKE_EDITOR_STORE = `
let state = { tabs: [] };
export function useEditorStore(select) { return select(state); }
export function setFakeEditorState(next) { state = next; }
`;

let loading = null;
function loadEditorUi() {
  loading ??= build({
    stdin: {
      contents: [
        "export * as panel from './EditorPanel.jsx';",
        "export * as tabs from './EditorTabs.jsx';",
        "export { setFakeEditorState } from '../../stores/editorStore.js';",
      ].join('\n'),
      resolveDir: EDITOR_DIR,
      sourcefile: 'editor-ui-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'editor-ui-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (BUNDLED.some((re) => re.test(args.path))) return undefined;
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            if (/\/stores\/editorStore\.js$/.test(args.path)) return { path: 'editorStore', namespace: 'fake' };
            return { path: args.path, namespace: 'stand-in' };
          });
          b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: FAKE_EDITOR_STORE, loader: 'js' }));
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

let ui = null;
const loadUi = async () => {
  ui = await loadEditorUi();
};

/** An export of one of the two files, failing by name when it is not there. */
function exported(file, name) {
  const value = ui[file === 'EditorPanel.jsx' ? 'panel' : 'tabs'][name];
  assert.ok(value !== undefined, `${file} does not export ${name}, so none of this is under test`);
  return value;
}
const stripSlotAt = (...a) => exported('EditorTabs.jsx', 'stripSlotAt')(...a);
const markerSlot = (...a) => exported('EditorTabs.jsx', 'markerSlot')(...a);
const dropTargetAtPoint = (...a) => exported('EditorPanel.jsx', 'dropTargetAtPoint')(...a);
const stripAutoScrollSpeed = (...a) => exported('EditorPanel.jsx', 'stripAutoScrollSpeed')(...a);
const createStripAutoScroller = (...a) => exported('EditorPanel.jsx', 'createStripAutoScroller')(...a);
const trackTabDrag = (...a) => exported('EditorPanel.jsx', 'trackTabDrag')(...a);

// ---- Geometry by hand --------------------------------------------------------

/** The strip's height (`h-tab`). Every strip below sits at the top, y 0 to 35. */
const H = 35;
const MID_Y = H / 2;
const box = (left, right, top = 0, bottom = H) => ({
  left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top,
});
/** Chips `widths` wide, laid end to end from `left`. */
function chipBoxes(left, widths) {
  let x = left;
  return widths.map((w) => box(x, (x += w)));
}
/** Where gap `gap` is: the left edge of the chip it goes before, or the end of the last. */
const gapX = (chips, gap) => (gap < chips.length ? chips[gap].left : chips[chips.length - 1].right);
/**
 * Whether the marker for `gap` is wholly in view: its 2px bar, drawn as
 * TabDropMarker draws it — starting at the first gap, centred on an inner
 * one, ending a pixel short of the last — inside the row's visible box.
 */
function markerInView(chips, row, gap) {
  const x = gapX(chips, gap);
  const [from, to] = gap === 0 ? [0, 2] : gap === chips.length ? [-3, -1] : [-1, 1];
  return x + from >= row.left && x + to <= row.right;
}
const TEN = Array(10).fill(120);

/** A stand-in element: as much of one as the hit-test and the auto-scroll read. */
class FakeElement {
  constructor(attrs, rect) {
    this.attrs = attrs;
    this.rect = rect;
    this.parent = null;
    this.children = [];
  }
  append(...children) {
    for (const c of children) {
      c.parent = this;
      this.children.push(c);
    }
    return this;
  }
  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }
  matches(selector) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!m) throw new Error(`the stand-in DOM cannot match ${selector}`);
    return Object.hasOwn(this.attrs, m[1]) && (m[2] === undefined || this.attrs[m[1]] === m[2]);
  }
  closest(selector) {
    for (let el = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() {
    return this.rect();
  }
}

/**
 * One editor group laid out by hand: its tab strip — `widths` worth of chips
 * in a row whose visible part spans `row`, scrolled `scrollLeft` along, and
 * the strip's own buttons to the right of the row — with the group's body
 * under it. Scrolling the row tells `win`, the way a browser does: a `scroll`
 * event that does not bubble.
 */
function editorGroup({ paneId = 'editor-pane-root', ids, widths = ids.map(() => 120), row = [0, 432], buttons = 70, scrollLeft = 0, win = null }) {
  const [left, right] = row;
  const content = widths.reduce((a, b) => a + b, 0);
  const clientWidth = right - left;
  const maxScroll = Math.max(0, content - clientWidth);
  let scrolled = Math.min(Math.max(scrollLeft, 0), maxScroll);

  const strip = new FakeElement({ 'data-editor-tab-strip': paneId }, () => box(left, right + buttons));
  const rowEl = new FakeElement({ 'data-editor-tab-row': paneId }, () => box(left, right));
  Object.defineProperties(rowEl, {
    scrollLeft: {
      get: () => scrolled,
      set: (v) => {
        const next = Math.min(Math.max(v, 0), maxScroll);
        if (next === scrolled) return;
        scrolled = next;
        win?.dispatch('scroll', {}, { bubbles: false });
      },
    },
    scrollWidth: { get: () => Math.max(content, clientWidth) },
    clientWidth: { get: () => clientWidth },
  });
  let at = left;
  const chips = ids.map((id, i) => {
    const from = at;
    at += widths[i];
    return new FakeElement({ 'data-tab-chip': id }, () => box(from - scrolled, from + widths[i] - scrolled));
  });
  rowEl.append(...chips);
  const buttonsEl = new FakeElement({ 'data-stand-in': 'split-and-close-buttons' }, () => box(right, right + buttons));
  strip.append(rowEl, buttonsEl);
  const body = new FakeElement({ 'data-editor-pane-body': paneId }, () => box(left, right + buttons, H, H + 400));
  return {
    paneId, ids, strip, row: rowEl, chips, buttons: buttonsEl, body, maxScroll,
    chipRects: () => chips.map((c) => c.getBoundingClientRect()),
    centreOf: (id) => {
      const r = chips[ids.indexOf(id)].getBoundingClientRect();
      return (r.left + r.right) / 2;
    },
  };
}

/** A document holding these groups, answering `elementFromPoint` from their boxes. */
function fakeDocument(...groups) {
  const root = new FakeElement({}, () => box(0, 0, 0, 0)).append(...groups.flatMap((g) => [g.strip, g.body]));
  const inside = (r, x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  return {
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    // The topmost element at the point. The row clips its chips: a chip
    // scrolled out of view is under no point at all.
    elementFromPoint(x, y) {
      for (const g of groups) {
        if (inside(g.row.getBoundingClientRect(), x, y)) {
          return g.chips.find((c) => inside(c.getBoundingClientRect(), x, y)) ?? g.row;
        }
        if (inside(g.buttons.getBoundingClientRect(), x, y)) return g.buttons;
        if (inside(g.body.getBoundingClientRect(), x, y)) return g.body;
      }
      return null;
    },
  };
}

/**
 * A window as far as the gesture uses one. Real DOM rules where they matter:
 * a listener is removed only with the same capture flag it was added with,
 * and an event that does not bubble — a row's `scroll` — reaches the window
 * only in the capture phase.
 */
function fakeWindow() {
  const listeners = new Map();
  const key = (type, options) => `${type}|${typeof options === 'boolean' ? options : Boolean(options?.capture)}`;
  return {
    addEventListener(type, fn, options) {
      const k = key(type, options);
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    },
    removeEventListener(type, fn, options) {
      listeners.get(key(type, options))?.delete(fn);
    },
    dispatch(type, props = {}, { bubbles = true } = {}) {
      const event = { type, ...props };
      for (const capture of bubbles ? [true, false] : [true]) {
        for (const fn of [...(listeners.get(`${type}|${capture}`) ?? [])]) fn(event);
      }
    },
    listening() {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
  };
}

/** requestAnimationFrame on a clock of the test's own. */
function fakeFrames() {
  let id = 0;
  let now = 1000;
  const queued = new Map();
  const frames = {
    requestFrame: (cb) => {
      id += 1;
      queued.set(id, cb);
      return id;
    },
    cancelFrame: (n) => {
      queued.delete(n);
    },
    pending: () => queued.size,
    /** Run the frame `ms` after the last one. */
    tick(ms = 16) {
      now += ms;
      const due = [...queued.values()];
      queued.clear();
      for (const cb of due) cb(now);
    },
    /** Run frames until none is asked for (at most `limit`); how many ran. */
    settle(limit = 2000, each = () => {}) {
      let n = 0;
      while (queued.size && n < limit) {
        frames.tick();
        each();
        n += 1;
      }
      return n;
    },
  };
  return frames;
}

/**
 * Press on `chipId` in `group` and follow the gesture: what the drag state
 * goes through (`states`, as EditorPanel's `setDrag` would get them) and what
 * is dropped (`drops`).
 */
function pressOn({ groups, group = groups[0], chipId, win, frames }) {
  const doc = fakeDocument(...groups);
  const states = [];
  const drops = [];
  const x0 = group.centreOf(chipId);
  const stop = trackTabDrag({ id: chipId, fileName: `${chipId}.js` }, { clientX: x0, clientY: MID_Y }, {
    onChange: (s) => states.push(s),
    onDrop: (s) => drops.push(s),
    win,
    doc,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  });
  let x = x0;
  let y = MID_Y;
  const g = {
    states,
    drops,
    stop,
    last: () => states[states.length - 1],
    /** Move to (tx, ty) in eight steps, as a hand would. */
    moveTo(tx, ty = MID_Y) {
      const fx = x;
      const fy = y;
      for (let i = 1; i <= 8; i++) win.dispatch('pointermove', { clientX: fx + ((tx - fx) * i) / 8, clientY: fy + ((ty - fy) * i) / 8 });
      x = tx;
      y = ty;
    },
    up: () => win.dispatch('pointerup', { clientX: x, clientY: y }),
    cancel: () => win.dispatch('pointercancel', { clientX: x, clientY: y }),
  };
  return g;
}

/** Whether the marker for `gap` would be wholly in view in this group's row. */
const gapInView = (group, gap) => markerInView(group.chipRects(), group.row.getBoundingClientRect(), gap);

// ---- Where a drop lands along a strip ----------------------------------------

describe('Editor tab strip: the gap a drop lands in', () => {
  beforeEach(loadUi);

  test("over a chip, its left half is the gap before it and its right half the gap after it", () => {
    const chips = chipBoxes(0, [100, 100, 100, 100]);
    for (const [x, gap] of [[10, 0], [60, 1], [140, 1], [160, 2], [240, 2], [260, 3], [340, 3], [390, 4]]) {
      assert.equal(stripSlotAt(chips, box(0, 600), x), gap, `pointer at x=${x}`);
    }
  });

  test('before the first chip is gap 0; anywhere after the last — the empty row, the buttons past it — is the end', () => {
    const chips = chipBoxes(0, [100, 100, 100, 100]);
    assert.equal(stripSlotAt(chips, box(0, 600), 1), 0);
    for (const x of [450, 599, 640, 900]) assert.equal(stripSlotAt(chips, box(0, 600), x), 4, `pointer at x=${x}`);
  });

  test('a strip with more tabs than fit: over its buttons, the last gap in view — not the gap after the hidden chips', () => {
    // The review's strip: ten chips in a 432px row, the buttons after it.
    // Counting every chip put both the drop and its marker at gap 4, x=480 —
    // past the end of the row, where nothing is drawn.
    const chips = chipBoxes(0, TEN);
    const row = box(0, 432);
    for (const x of [440, 466, 500]) {
      const gap = stripSlotAt(chips, row, x);
      assert.equal(gap, 3, `pointer at x=${x}`);
      assert.ok(markerInView(chips, row, gap), `gap ${gap} is drawn at x=${gapX(chips, gap)}, outside the row`);
    }
  });

  test('a gap is offered only where the whole of its marker can be seen', () => {
    const row = box(0, 432);
    // The gap before t4 half a pixel inside the right edge: its bar, centred
    // on the gap, would stick half a pixel out — the gap before t3 is offered.
    assert.equal(stripSlotAt(chipBoxes(431.5 - 480, TEN), row, 466), 3);
    // A pixel inside, its bar fits.
    assert.equal(stripSlotAt(chipBoxes(431 - 480, TEN), row, 466), 4);
    // Boxes measured through a transformed ancestor carry float noise: a row
    // not scrolled at all still offers its first gap.
    assert.equal(stripSlotAt(chipBoxes(-1e-7, TEN), row, 1), 0);
  });

  test('a chip cut by the edge with most of it in view: the gap past it is out of view, and is not offered', () => {
    // The verifier's real strip: package.json, README.md, main.jsx (cut at
    // 715.5 with its middle, 662, still in view), App.jsx, calculator.js —
    // dropped on Split Right at x=731 it went in at gap 3, drawn at x=721.
    const chips = chipBoxes(309, [149, 145, 118, 114, 141]);
    const row = box(309, 715.5);
    assert.equal(stripSlotAt(chips, row, 700), 2, "over main.jsx's right half");
    assert.equal(stripSlotAt(chips, row, 731), 2, 'over the Split Right button');
  });

  test('a row scrolled along: a gap scrolled out on either side is never offered', () => {
    // 150px in: chip 1 is [-30, 90] (its middle in view, its left edge not),
    // chip 4 is [330, 450] (its middle in view, its right edge not).
    const chips = chipBoxes(-150, TEN);
    const row = box(0, 432);
    assert.equal(stripSlotAt(chips, row, 5), 2, 'just inside the left edge');
    assert.equal(stripSlotAt(chips, row, 60), 2);
    assert.equal(stripSlotAt(chips, row, 260), 3);
    assert.equal(stripSlotAt(chips, row, 420), 4, 'just inside the right edge');
  });

  test('a row scrolled all the way: the end is in view, and is what the buttons give', () => {
    const chips = chipBoxes(-(1200 - 432), TEN);
    assert.equal(stripSlotAt(chips, box(0, 432), 466), 10);
    // A row's clientWidth and scrollWidth are whole pixels while its box is
    // not, so scrolled as far as the browser goes its end can still sit most
    // of a pixel outside the box — in a real split group, the row ended at
    // 715.5 and its last chip at 716.17 with scrollLeft at its maximum, 260.
    // The end has to stay reachable, its marker drawn inside the row.
    const real = chipBoxes(309 - 260, [149, 145, 118, 114, 141.171875]);
    assert.equal(stripSlotAt(real, box(309, 715.5), 731), 5, 'the verifier\'s strip, scrolled all the way');
    assert.ok(markerInView(real, box(309, 715.5), 5));
    const rounded = chipBoxes(-(1200 - 432) + 0.9, TEN);
    assert.equal(stripSlotAt(rounded, box(0, 432), 466), 10, 'the end 0.9px past the row');
  });

  test('an empty strip has one gap, wherever the pointer is', () => {
    for (const x of [-5, 0, 200, 900]) assert.equal(stripSlotAt([], box(0, 432), x), 0, `pointer at x=${x}`);
  });
});

// ---- Where the marker is drawn -----------------------------------------------

/** The root group's strip holding `ids`, drawn while `drag` is in progress. */
function drawStrip(ids, drag) {
  ui.setFakeEditorState({
    tabs: ids.map((id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: '', isDirty: false })),
  });
  const { EditorTabs, EditorDragContext } = ui.tabs;
  const node = { type: 'leaf', id: 'editor-pane-root', tabIds: ids, activeTabId: ids[0] ?? null };
  return renderToString(
    React.createElement(EditorDragContext.Provider, { value: { drag, beginDrag() {} } }, React.createElement(EditorTabs, { node }))
  );
}
/** A drag over the root group's strip at `gap`. */
const dragOver = (gap, tabId) => ({
  tabId, title: `${tabId}.js`, startX: 0, startY: 0, x: 0, y: 0,
  active: true, targetPaneId: 'editor-pane-root', zone: 'tabs', index: gap,
});
/** The strip read left to right: chip ids, with '|' where the marker is. */
const readStrip = (html) => [...html.matchAll(/data-tab-chip="([^"]+)"|data-tab-drop-marker=""/g)].map((m) => m[1] ?? '|');
/** The classes of the marker's bar. */
const barClasses = (html) => (/data-tab-drop-marker=""[^>]*><div class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);

describe('Editor tab strip: where the marker is drawn', () => {
  beforeEach(loadUi);

  test('no marker in the two gaps either side of the dragged chip — a drop there moves nothing', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.deepEqual([0, 1, 2, 3, 4].map((gap) => markerSlot(gap, ids, 'b')), [0, null, null, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((gap) => markerSlot(gap, ids, 'a')), [null, null, 2, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((gap) => markerSlot(gap, ids, 'd')), [0, 1, 2, null, null]);
    assert.equal(markerSlot(null, ids, 'b'), null, 'no gap at all');
  });

  test('a tab dragged in from another group is marked in every gap: every drop moves it', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.deepEqual([0, 1, 2, 3, 4].map((gap) => markerSlot(gap, ids, 'x')), [0, 1, 2, 3, 4]);
  });

  test('the strip as drawn: a marker where a drop moves the tab, none beside the dimmed chip', () => {
    const ids = ['e1', 'e2', 'e3', 'e4'];
    const drawn = [0, 1, 2, 3, 4].map((gap) => readStrip(drawStrip(ids, dragOver(gap, 'e2'))).join(' '));
    assert.deepEqual(drawn, [
      '| e1 e2 e3 e4',
      'e1 e2 e3 e4',
      'e1 e2 e3 e4',
      'e1 e2 e3 | e4',
      'e1 e2 e3 e4 |',
    ]);
    // From another group, each gap is drawn where it is.
    const fromElsewhere = [0, 2, 4].map((gap) => readStrip(drawStrip(ids, dragOver(gap, 'x9'))).join(' '));
    assert.deepEqual(fromElsewhere, ['| e1 e2 e3 e4', 'e1 e2 | e3 e4', 'e1 e2 e3 e4 |']);
  });

  test("the first and last markers are drawn inside the row's ends, never cut off by them", () => {
    const ids = ['e1', 'e2', 'e3', 'e4'];
    // A row not scrolled at all starts at its first chip, and one scrolled
    // all the way ends at — or most of a pixel short of — its last: a bar
    // centred on either gap is cut off by the row's own edge. These are the
    // extents `stripSlotAt` judges what is in view by.
    assert.ok(barClasses(drawStrip(ids, dragOver(0, 'x9'))).includes('left-0'), 'the first gap: from 0 to 2px');
    assert.ok(barClasses(drawStrip(ids, dragOver(4, 'x9'))).includes('-left-[3px]'), 'the last gap: from -3 to -1px');
    assert.ok(barClasses(drawStrip(ids, dragOver(2, 'x9'))).includes('-left-px'), 'a gap between two chips: -1 to 1px');
    assert.ok(barClasses(drawStrip([], dragOver(0, 'x9'))).includes('left-0'), 'the one gap of an empty strip');
  });

  test('the scrolling row says which group it belongs to — the hit-test measures what of it is on screen', () => {
    const html = drawStrip(['e1', 'e2'], null);
    const rowAt = html.indexOf('data-editor-tab-row="editor-pane-root"');
    assert.ok(rowAt !== -1, 'the row of chips carries no data-editor-tab-row');
    assert.ok(rowAt < html.indexOf('data-tab-chip="e1"'), 'the chips are not inside the marked row');
    assert.ok(html.indexOf('title="Split Right"') > html.indexOf('data-tab-chip="e2"'), 'the buttons are not after the row');
  });
});

// ---- What is under the pointer -----------------------------------------------

describe('Editor tab drag: what is under the pointer', () => {
  beforeEach(loadUi);

  test('over a chip: that strip, at the gap under the pointer, the dragged chip counted like any other', () => {
    const g = editorGroup({ ids: ['a', 'b', 'c', 'd'], widths: [100, 100, 100, 100], row: [0, 600] });
    const doc = fakeDocument(g);
    // 'b' is the chip being dragged; it stays in its strip, dimmed, and the
    // gaps are numbered with it there (see moveEditorTabInStrip).
    assert.deepEqual(dropTargetAtPoint(260, MID_Y, doc), { paneId: 'editor-pane-root', zone: 'tabs', index: 3 });
    assert.deepEqual(dropTargetAtPoint(140, MID_Y, doc), { paneId: 'editor-pane-root', zone: 'tabs', index: 1 });
  });

  test("over the buttons of a strip with more tabs than fit: the last gap on screen", () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
    const doc = fakeDocument(g);
    const hit = dropTargetAtPoint(466, MID_Y, doc);
    assert.deepEqual(hit, { paneId: 'editor-pane-root', zone: 'tabs', index: 3 });
    assert.ok(gapInView(g, hit.index), `gap ${hit.index} is out of view`);
  });

  test('a strip scrolled along: the gap is measured where the chips are now', () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), scrollLeft: 400 });
    const doc = fakeDocument(g);
    // Scrolled 400px, t4 is [80, 200]: its right half is the gap after it.
    assert.deepEqual(dropTargetAtPoint(150, MID_Y, doc), { paneId: 'editor-pane-root', zone: 'tabs', index: 5 });
    // Just inside the left edge is t3's left half ([-40, 80]), but the gap
    // before t3 is scrolled off: the first gap in view, after it, is offered.
    assert.deepEqual(dropTargetAtPoint(2, MID_Y, doc), { paneId: 'editor-pane-root', zone: 'tabs', index: 4 });
  });

  test("over a group's body: the centre moves the tab there and the edges split it, as before", () => {
    const g = editorGroup({ ids: ['a', 'b'], row: [0, 432] });
    const doc = fakeDocument(g);
    // The body spans x 0..502, y 35..435.
    assert.deepEqual(dropTargetAtPoint(251, 235, doc), { paneId: 'editor-pane-root', zone: 'center', index: null });
    assert.equal(dropTargetAtPoint(495, 235, doc).zone, 'right');
    assert.equal(dropTargetAtPoint(5, 235, doc).zone, 'left');
    assert.equal(dropTargetAtPoint(251, 430, doc).zone, 'bottom');
  });

  test('over nothing a tab can go into: no target', () => {
    const doc = fakeDocument(editorGroup({ ids: ['a'] }));
    assert.equal(dropTargetAtPoint(900, 900, doc), null);
  });
});

// ---- The strip scrolling itself under a held drag ----------------------------

describe('Editor tab drag: a strip scrolls itself while a tab is held near either end of it', () => {
  beforeEach(loadUi);

  test('no scrolling away from both ends of the row', () => {
    const row = box(0, 432);
    for (const x of [100, 216, 330]) assert.equal(stripAutoScrollSpeed(row, x), 0, `pointer at x=${x}`);
  });

  test('near the end it scrolls toward it, in proportion to how near, faster still past it (over the buttons) up to a cap', () => {
    const row = box(0, 432);
    const at = (x) => stripAutoScrollSpeed(row, x);
    assert.ok(at(431) > at(424) && at(424) > at(420) && at(420) > 0, 'not faster the nearer the end');
    // In proportion: equal steps toward the end add equal speed.
    assert.ok(Math.abs(at(428) - at(424) - (at(424) - at(420))) < 1e-6, 'not in proportion to how near');
    assert.ok(at(466) > at(432), 'no faster past the end than at it');
    assert.equal(at(4000), at(8000), 'no cap on the speed');
    assert.ok(Number.isFinite(at(8000)));
  });

  test('near the start it scrolls back toward it', () => {
    const row = box(0, 432);
    const at = (x) => stripAutoScrollSpeed(row, x);
    assert.ok(at(1) < at(8) && at(8) < 0, 'not scrolling back, faster the nearer the start');
  });

  test('a row too narrow for both zones splits itself between them', () => {
    const row = box(0, 40);
    assert.ok(stripAutoScrollSpeed(row, 15) < 0);
    assert.ok(stripAutoScrollSpeed(row, 25) > 0);
    assert.equal(stripAutoScrollSpeed(row, 20), 0);
  });

  test('held near the end, the row scrolls until it is at its end, then stops by itself', () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
    const frames = fakeFrames();
    const scroller = createStripAutoScroller({ rowOf: (id) => (id === g.paneId ? g.row : null), ...frames });
    scroller.follow(g.paneId, 466);
    const ran = frames.settle();
    assert.equal(g.row.scrollLeft, g.maxScroll, 'not scrolled to the end');
    assert.equal(frames.pending(), 0, 'still asking for frames at the end');
    assert.ok(ran > 3, `reached the end in ${ran} frames: not scrolling, jumping`);
  });

  test('the nearer the end, the faster it goes', () => {
    const distance = (x) => {
      const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
      const frames = fakeFrames();
      createStripAutoScroller({ rowOf: () => g.row, ...frames }).follow(g.paneId, x);
      for (let i = 0; i < 10; i++) frames.tick();
      return g.row.scrollLeft;
    };
    assert.ok(distance(431) > distance(420) && distance(420) > 0, `${distance(431)} vs ${distance(420)}`);
  });

  test('its speed is per second, not per frame: a 120Hz screen scrolls no faster than a 60Hz one', () => {
    const distanceIn = (ms, frameMs) => {
      const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
      const frames = fakeFrames();
      createStripAutoScroller({ rowOf: () => g.row, ...frames }).follow(g.paneId, 432);
      frames.tick(frameMs); // the first frame only starts the clock
      for (let t = 0; t < ms; t += frameMs) frames.tick(frameMs);
      return g.row.scrollLeft;
    };
    const at60 = distanceIn(320, 16);
    const at120 = distanceIn(320, 8);
    assert.ok(at60 > 50, `scrolled only ${at60}px in 320ms`);
    assert.ok(Math.abs(at120 - at60) <= 10, `320ms scrolled ${at60}px at 60Hz but ${at120}px at 120Hz`);
  });

  test('a long wait between two frames — a window gone to the background — does not make it jump', () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
    const frames = fakeFrames();
    createStripAutoScroller({ rowOf: () => g.row, ...frames }).follow(g.paneId, 432);
    for (let i = 0; i < 3; i++) frames.tick();
    const before = g.row.scrollLeft;
    frames.tick(5000);
    assert.ok(g.row.scrollLeft - before < 60, `jumped ${g.row.scrollLeft - before}px in one frame`);
  });

  test('held near the start, it scrolls back to the start and stops there', () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), scrollLeft: 300 });
    const frames = fakeFrames();
    createStripAutoScroller({ rowOf: () => g.row, ...frames }).follow(g.paneId, 3);
    frames.settle();
    assert.equal(g.row.scrollLeft, 0);
    assert.equal(frames.pending(), 0);
  });

  test('a row with nothing out of view never moves, and leaves no loop running', () => {
    const g = editorGroup({ ids: ['a', 'b', 'c'], widths: [100, 100, 100] });
    const frames = fakeFrames();
    createStripAutoScroller({ rowOf: () => g.row, ...frames }).follow(g.paneId, 466);
    frames.settle(5);
    assert.equal(g.row.scrollLeft, 0);
    assert.equal(frames.pending(), 0);
  });

  test('stop() — a drop, a cancel, an unmount — ends it at once', () => {
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
    const frames = fakeFrames();
    const scroller = createStripAutoScroller({ rowOf: () => g.row, ...frames });
    scroller.follow(g.paneId, 466);
    for (let i = 0; i < 3; i++) frames.tick();
    const reached = g.row.scrollLeft;
    assert.ok(reached > 0);
    scroller.stop();
    assert.equal(frames.pending(), 0, 'a frame is still queued after stop()');
    for (let i = 0; i < 10; i++) frames.tick();
    assert.equal(g.row.scrollLeft, reached);
  });

  test('the pointer leaving the end, or the strip, ends it', () => {
    for (const leave of [(s, g) => s.follow(g.paneId, 200), (s) => s.follow(null, 0)]) {
      const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`) });
      const frames = fakeFrames();
      const scroller = createStripAutoScroller({ rowOf: () => g.row, ...frames });
      scroller.follow(g.paneId, 466);
      for (let i = 0; i < 3; i++) frames.tick();
      const reached = g.row.scrollLeft;
      leave(scroller, g);
      frames.settle(20);
      assert.equal(g.row.scrollLeft, reached, 'still scrolling');
      assert.equal(frames.pending(), 0);
    }
  });
});

// ---- One press, from pointerdown to release ----------------------------------

describe('Editor tab drag: one press, from pointerdown to release', () => {
  beforeEach(loadUi);

  test('a press that never travels past the threshold is a click: nothing is dragged, nothing dropped', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: ['a', 'b', 'c'], widths: [100, 100, 100], win });
    const d = pressOn({ groups: [g], chipId: 'a', win, frames });
    d.moveTo(53, MID_Y + 1);
    d.up();
    assert.ok(d.states.every((s) => !s?.active), 'a 3px press turned into a drag');
    assert.equal(d.last(), null, 'the drag state is not cleared on release');
    assert.deepEqual(d.drops, []);
    assert.equal(win.listening(), 0, 'listeners left behind');
  });

  test('let go over a chip, the tab goes in at the gap the marker showed', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: ['a', 'b', 'c', 'd'], widths: [100, 100, 100, 100], row: [0, 600], win });
    const d = pressOn({ groups: [g], chipId: 'a', win, frames });
    d.moveTo(260);
    const shown = d.last();
    assert.equal(shown.index, 3);
    d.up();
    assert.equal(d.drops.length, 1);
    assert.equal(d.drops[0].tabId, 'a');
    assert.equal(d.drops[0].targetPaneId, 'editor-pane-root');
    assert.equal(d.drops[0].zone, 'tabs');
    assert.equal(d.drops[0].index, shown.index, 'dropped somewhere other than the marker');
  });

  test('held over the buttons of an overflowing strip, the row scrolls to its end with the marker in view all the way, and the tab is dropped last', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), win });
    const d = pressOn({ groups: [g], chipId: 't0', win, frames });
    d.moveTo(466); // the middle of the strip's buttons
    assert.equal(d.last().index, 3, 'over the buttons before any scrolling: the last gap in view');
    const outOfView = [];
    frames.settle(2000, () => {
      const s = d.last();
      if (s.zone === 'tabs' && !gapInView(g, s.index)) outOfView.push([g.row.scrollLeft, s.index]);
    });
    assert.equal(g.row.scrollLeft, g.maxScroll, 'the row never reached its end');
    assert.equal(frames.pending(), 0, 'still scrolling at the end');
    assert.deepEqual(outOfView, [], 'the marker went out of view while scrolling');
    assert.equal(d.last().index, 10, 'at the end of the row the marker is not at the end');
    d.up();
    assert.equal(d.drops[0].index, 10, 'not dropped at the end');
  });

  test('a wheel scroll under a still pointer moves the gap with the chips; letting go right after drops it where the marker is', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), win });
    const d = pressOn({ groups: [g], chipId: 't0', win, frames });
    d.moveTo(250); // t2's left half: the gap before it
    assert.equal(d.last().index, 2);
    g.row.scrollLeft += 120; // the wheel, not the pointer
    assert.equal(d.last().index, 3, 'the gap did not follow the chips under the pointer');
    d.up();
    assert.equal(d.drops[0].index, 3, 'not dropped where the marker is');
  });

  test('letting go stops the scrolling and leaves no listener behind', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), win });
    const d = pressOn({ groups: [g], chipId: 't0', win, frames });
    d.moveTo(466);
    for (let i = 0; i < 5; i++) frames.tick();
    const shown = d.last();
    d.up();
    const at = g.row.scrollLeft;
    for (let i = 0; i < 20; i++) frames.tick();
    assert.equal(g.row.scrollLeft, at, 'the row went on scrolling after the drop');
    assert.equal(frames.pending(), 0);
    assert.equal(win.listening(), 0, 'listeners left behind');
    assert.equal(d.last(), null);
    assert.equal(d.drops[0].index, shown.index, 'not dropped where the marker was');
  });

  test('a cancelled gesture drops nothing and stops the scrolling', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), win });
    const d = pressOn({ groups: [g], chipId: 't0', win, frames });
    d.moveTo(466);
    for (let i = 0; i < 5; i++) frames.tick();
    d.cancel();
    const at = g.row.scrollLeft;
    for (let i = 0; i < 20; i++) frames.tick();
    assert.equal(g.row.scrollLeft, at);
    assert.equal(frames.pending(), 0);
    assert.equal(win.listening(), 0);
    assert.equal(d.last(), null);
    assert.deepEqual(d.drops, []);
  });

  test('ended from outside — an unmount, or a second press — it stops listening and scrolling at once', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: TEN.map((_, i) => `t${i}`), win });
    const d = pressOn({ groups: [g], chipId: 't0', win, frames });
    d.moveTo(466);
    for (let i = 0; i < 5; i++) frames.tick();
    d.stop();
    const at = g.row.scrollLeft;
    const seen = d.states.length;
    assert.equal(frames.pending(), 0);
    assert.equal(win.listening(), 0);
    for (let i = 0; i < 20; i++) frames.tick();
    d.moveTo(100);
    d.up();
    assert.equal(g.row.scrollLeft, at);
    assert.equal(d.states.length, seen, 'a stopped gesture went on reporting');
    assert.deepEqual(d.drops, []);
  });

  test("into another group's strip, at the gap under the pointer there", () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const left = editorGroup({ paneId: 'editor-pane-root', ids: ['a', 'b'], widths: [100, 100], row: [0, 400], buttons: 70, win });
    const right = editorGroup({ paneId: 'editor-pane-1', ids: ['x', 'y'], widths: [100, 100], row: [480, 880], buttons: 70, win });
    const d = pressOn({ groups: [left, right], chipId: 'b', win, frames });
    d.moveTo(560); // x's right half
    d.up();
    assert.deepEqual(
      [d.drops[0].targetPaneId, d.drops[0].zone, d.drops[0].index],
      ['editor-pane-1', 'tabs', 1]
    );
  });

  test('let go over nothing a tab can go into, it is dropped nowhere', () => {
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: ['a', 'b'], widths: [100, 100], win });
    const d = pressOn({ groups: [g], chipId: 'a', win, frames });
    d.moveTo(900, 900);
    assert.equal(d.last().targetPaneId, null);
    d.up();
    assert.deepEqual(d.drops, []);
    assert.equal(d.last(), null);
  });

  test("let go over a group's body: the centre and the edges, as before", () => {
    for (const [x, y, zone] of [[251, 235, 'center'], [495, 235, 'right'], [251, 60, 'top']]) {
      const win = fakeWindow();
      const frames = fakeFrames();
      const g = editorGroup({ ids: ['a', 'b'], widths: [100, 100], win });
      const d = pressOn({ groups: [g], chipId: 'a', win, frames });
      d.moveTo(x, y);
      d.up();
      assert.deepEqual([d.drops[0]?.targetPaneId, d.drops[0]?.zone], ['editor-pane-root', zone], `let go at (${x}, ${y})`);
    }
  });

  test('the release of a real drag is marked, so the click that trails it is not taken for a click — and a click is not', async () => {
    const wasJustDragged = exported('EditorTabs.jsx', 'wasJustDragged');
    // Past whatever an earlier case marked: the guard lasts 200ms.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const win = fakeWindow();
    const frames = fakeFrames();
    const g = editorGroup({ ids: ['a', 'b', 'c'], widths: [100, 100, 100], win });
    const click = pressOn({ groups: [g], chipId: 'a', win, frames });
    click.up();
    assert.equal(wasJustDragged(), false, 'a plain click was marked as the end of a drag');
    const dragged = pressOn({ groups: [g], chipId: 'a', win, frames });
    dragged.moveTo(260);
    dragged.up();
    assert.equal(wasJustDragged(), true, 'the end of a drag was not marked');
  });
});
