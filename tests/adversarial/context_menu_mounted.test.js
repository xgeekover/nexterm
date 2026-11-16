/**
 * A context menu taller than the window, mounted (src/components/common/
 * ContextMenu.jsx; FX-1 of the agent session curation task).
 *
 * Move to Group ▸ puts one 22 px item per group before New Group… and
 * Remove from Group, and there may be 50 groups. The menu had no height
 * bound: past about 35 groups in an 800 px window the last items were below
 * the window's edge, out of the mouse's reach, and any scroll closed the
 * menu. Now the menu is no taller than the window less its 4 px margin on
 * each side and scrolls; a scroll inside it leaves it open, any other
 * closes it as before; and a key that moves the active item brings that item
 * into view, which the pointer moving onto one does not.
 *
 * Since a key move scrolls the list, the pointer makes an item active only by
 * really moving (FX-8, cycle 3): CXM-04 to CXM-07.
 *
 * What effects and listeners do is out of reach of `renderToString`, so the
 * menu is rendered with real React on the hand-written page of
 * react_page.js, bundled with esbuild as agent_resume_banner_mounted.test.js
 * does. The page lays nothing out, so no pixel position is asserted: what
 * the menu asks for (its style, `scrollIntoView`) is.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, dispatch, letItRun } from './react_page.js';

const h = React.createElement;
const COMMON_DIR = fileURLToPath(new URL('../../src/components/common/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom']);

let loading = null;
function loadMenu() {
  loading ??= build({
    stdin: {
      contents: "export { ContextMenu } from './ContextMenu.jsx';",
      resolveDir: COMMON_DIR,
      sourcefile: 'context-menu-under-test.js',
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
        name: 'real-react',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            REAL.has(args.path) ? { path: import.meta.resolve(args.path), external: true } : undefined
          );
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

/** 60 items, the second one off: more than any window has room for at 22 px each. */
function sixty(picks) {
  return Array.from({ length: 60 }, (_, i) => ({
    key: `item-${i}`,
    label: `Item ${i}`,
    ...(i === 1 ? { disabled: true, disabledReason: 'Off' } : {}),
    onSelect: () => picks.push(i),
  }));
}

/**
 * The menu open at (100, 100) with `items`, closed by its own `onClose` as
 * every caller does; `closes` counts the calls. The page lays nothing out:
 * every element measures the same, and the window is 1600 by 900.
 */
async function mounted(p, ContextMenu, items, { takeFocus = true } = {}) {
  const proto = Object.getPrototypeOf(p.document.createElement('div'));
  proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 240, bottom: 892, width: 240, height: 892 });
  Object.assign(p.window, { innerWidth: 1600, innerHeight: 900 });
  const closes = [];
  function Host() {
    const [open, setOpen] = React.useState(true);
    return h(ContextMenu, {
      open,
      x: 100,
      y: 100,
      items,
      takeFocus,
      onClose: () => {
        closes.push(1);
        setOpen(false);
      },
    });
  }
  p.render(h(Host));
  await letItRun();
  return closes;
}

const menuOf = (p) => p.document.querySelector('[role="menu"]');
const itemsOf = (p) => p.document.querySelectorAll('[role="menuitem"]');
/** What the page was asked to scroll into view since `mark`: the item's label and the options. */
const scrolledSince = (p, mark) =>
  p.document.scrolledIntoView.slice(mark).map(({ element, options }) => [element.textContent, options]);

/** `getBoundingClientRect` as it was on the page's elements before a case set it. */
let measured = null;
function remember(p) {
  const proto = Object.getPrototypeOf(p.document.createElement('div'));
  measured ??= { proto, had: Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect') };
}
function putBack() {
  if (!measured) return;
  if (measured.had) Object.defineProperty(measured.proto, 'getBoundingClientRect', measured.had);
  else delete measured.proto.getBoundingClientRect;
  measured = null;
}

describe('A context menu taller than the window fits it and scrolls (FX-1)', () => {
  test('CXM-01: 60 items — the menu is bounded at the window less 8 px, scrolls vertically, keeps its overscroll, and is placed and focused as before', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        await mounted(p, ContextMenu, sixty([]));
        const menu = menuOf(p);
        assert.ok(menu, 'open');
        assert.equal(itemsOf(p).length, 60, 'every item drawn');
        assert.equal(menu.style.maxHeight, 'calc(100vh - 8px)', 'never taller than the window less the 4 px margin on each side');
        assert.equal(menu.style.overflowY, 'auto', 'it scrolls vertically when its items need more');
        assert.equal(menu.style.overflowX, 'hidden', 'and only vertically');
        assert.equal(menu.style.overscrollBehavior, 'contain', 'a scroll that reaches its end does not go on behind it');
        // Unchanged: fixed, placed once measured, focused as it opens, and not "opened by itself".
        assert.equal(menu.style.position, 'fixed');
        assert.equal(menu.style.visibility, 'visible', 'placed');
        assert.equal(p.document.activeElement, menu, 'it took the keyboard');
        assert.equal(menu.hasAttribute('data-opened-by-itself'), false);
        p.unmount();
      } finally {
        putBack();
      }
    });
    await onPage(async (p) => {
      remember(p);
      try {
        await mounted(p, ContextMenu, sixty([]), { takeFocus: false });
        assert.equal(menuOf(p).getAttribute('data-opened-by-itself'), '', 'one that opened by itself still says so');
        assert.notEqual(p.document.activeElement, menuOf(p), 'and takes no keyboard');
        assert.equal(menuOf(p).style.maxHeight, 'calc(100vh - 8px)');
        p.unmount();
      } finally {
        putBack();
      }
    });
  });

  test('CXM-02: a scroll inside the menu leaves it open; a scroll anywhere else, the window’s too, closes it; so do a press outside, Escape and a resize', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        const closes = await mounted(p, ContextMenu, sixty([]));
        const outside = p.el('div', { 'data-outside': '' });
        p.settled(() => dispatch(p.window, itemsOf(p)[45], { type: 'scroll' }));
        p.settled(() => dispatch(p.window, menuOf(p), { type: 'scroll' }));
        assert.deepEqual(closes, [], 'its own list scrolling: still open');
        assert.ok(menuOf(p), 'and drawn');
        p.settled(() => dispatch(p.window, outside, { type: 'scroll' }));
        assert.equal(closes.length, 1, 'a scroll outside it closes it');
        assert.equal(menuOf(p), null, 'and it is gone');
        p.unmount();
      } finally {
        putBack();
      }
    });
    // The page itself scrolling (its target is the document), a press
    // outside, Escape, a resize: each closes it, as before.
    const dismissals = [
      ['the page scrolling', (p) => dispatch(p.window, p.document, { type: 'scroll' })],
      ['a press outside', (p) => dispatch(p.window, p.el('div'), { type: 'mousedown' })],
      ['Escape', (p) => dispatch(p.window, p.document.activeElement, { type: 'keydown', key: 'Escape' })],
      ['a resize', (p) => dispatch(p.window, p.window, { type: 'resize' })],
    ];
    for (const [what, act] of dismissals) {
      await onPage(async (p) => {
        remember(p);
        try {
          const closes = await mounted(p, ContextMenu, sixty([]));
          p.settled(() => dispatch(p.window, itemsOf(p)[3], { type: 'mousedown' }));
          assert.deepEqual(closes, [], `${what}: a press on an item does not close it`);
          p.settled(() => act(p));
          assert.ok(closes.length >= 1, `${what} closes it`);
          assert.equal(menuOf(p), null, `${what}: gone`);
          p.unmount();
        } finally {
          putBack();
        }
      });
    }
  });

  test('CXM-03: a key that moves the active item asks for it to be scrolled into view at the nearest edge; hovering does not; Enter still picks it', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, sixty(picks));
        const rows = itemsOf(p);
        const active = () => rows.findIndex((r) => (r.getAttribute('class') ?? '').includes('bg-vsc-selection'));
        assert.deepEqual(p.document.scrolledIntoView, [], 'nothing scrolled as it opens');

        let mark = p.document.scrolledIntoView.length;
        p.keydown('ArrowUp');
        assert.equal(active(), 59, 'from none, up is the last item');
        assert.deepEqual(scrolledSince(p, mark), [['Item 59', { block: 'nearest' }]], 'the last item, below the window’s edge, is brought into view');

        mark = p.document.scrolledIntoView.length;
        p.keydown('ArrowDown');
        p.keydown('ArrowDown');
        assert.equal(active(), 2, 'down wraps to the first, then passes over the one that is off');
        assert.deepEqual(scrolledSince(p, mark), [['Item 0', { block: 'nearest' }], ['Item 2', { block: 'nearest' }]], 'once for each key');

        mark = p.document.scrolledIntoView.length;
        // A real move (FX-8): the first only notes the point, the next at another makes the row active.
        await p.move(rows[40], 120, 900);
        await p.move(rows[40], 120, 903);
        assert.equal(active(), 40, 'premise: the pointer made item 40 active');
        assert.deepEqual(scrolledSince(p, mark), [], 'the pointer moving onto an item scrolls nothing');

        mark = p.document.scrolledIntoView.length;
        p.keydown('ArrowDown');
        assert.equal(active(), 41);
        assert.deepEqual(scrolledSince(p, mark), [['Item 41', { block: 'nearest' }]], 'a key after it scrolls to the item it made active');

        p.keydown('Enter');
        assert.deepEqual(picks, [41], 'Enter picks the active item, as before');
        assert.equal(closes.length, 1, 'and closes the menu');
        p.unmount();
      } finally {
        putBack();
      }
    });
  });
});

/** The index among `rows` of the row drawn active, or -1: the same means CXM-03 uses. */
const activeOf = (rows) => rows.findIndex((r) => (r.getAttribute('class') ?? '').includes('bg-vsc-selection'));

/** A row, a separator and a row. */
function twoWithASeparator(picks) {
  return [
    { key: 'a', label: 'A', onSelect: () => picks.push('a') },
    { type: 'separator', key: 'sep' },
    { key: 'b', label: 'B', onSelect: () => picks.push('b') },
  ];
}

/**
 * The menu with `items`, measured as `mounted` measures it, rendered straight
 * into the root by the function this returns, `(x, y, open = true)`: rendered
 * again, it is the same menu, closed or open at another point.
 */
function reopenable(p, ContextMenu, items, closes) {
  const proto = Object.getPrototypeOf(p.document.createElement('div'));
  proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 240, bottom: 892, width: 240, height: 892 });
  Object.assign(p.window, { innerWidth: 1600, innerHeight: 900 });
  return async (x, y, open = true) => {
    p.render(h(ContextMenu, { open, x, y, items, onClose: () => closes.push(1) }));
    await letItRun();
  };
}

/**
 * The list scrolling under a pointer that rests sends the row now under it a
 * `mouseover`, and some engines a `mousemove` at the same point (C-01, shown
 * on Chromium). Neither may change the active item: only a `mousemove` at
 * another point than the last one seen over the menu does.
 */
describe('The pointer makes an item active only by really moving (FX-8)', () => {
  test('CXM-04: a menu that opens under a resting pointer has nothing active — not by itself, by a mouseover or by the first mousemove; ArrowUp then makes the last item active and Enter picks it', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, sixty(picks));
        const rows = itemsOf(p);
        assert.equal(activeOf(rows), -1, 'nothing active as it opens');
        await p.hover(rows[10]);
        assert.equal(activeOf(rows), -1, 'a mouseover on the row under the pointer: still nothing');
        await p.move(rows[10], 120, 330);
        assert.equal(activeOf(rows), -1, 'the first mousemove only notes where the pointer is');
        p.keydown('ArrowUp');
        assert.equal(activeOf(rows), 59, 'from none, up is the last item');
        p.keydown('Enter');
        assert.deepEqual(picks, [59], 'Enter picks it');
        assert.equal(closes.length, 1, 'and closes the menu');
        p.unmount();
      } finally {
        putBack();
      }
    });
    // Each time it opens, also at a new point, the first move only notes
    // where the pointer is.
    await onPage(async (p) => {
      remember(p);
      try {
        const closes = [];
        const openAt = reopenable(p, ContextMenu, sixty([]), closes);
        await openAt(100, 100);
        let rows = itemsOf(p);
        await p.move(rows[4], 120, 190);
        await p.move(rows[4], 120, 193);
        assert.equal(activeOf(rows), 4, 'premise: a real move made row 4 active');
        await openAt(300, 200);
        rows = itemsOf(p);
        assert.equal(activeOf(rows), -1, 'open at a new point: nothing active');
        await p.move(rows[6], 320, 340);
        assert.equal(activeOf(rows), -1, 'the first move there only notes where the pointer is');
        await p.move(rows[6], 320, 343);
        assert.equal(activeOf(rows), 6, 'the next, at another point, makes the row under it active');
        await openAt(300, 200, false);
        assert.equal(menuOf(p), null, 'closed');
        await openAt(300, 200);
        rows = itemsOf(p);
        await p.move(rows[8], 320, 380);
        assert.equal(activeOf(rows), -1, 'open again at the same point: the first move only notes where the pointer is');
        assert.deepEqual(closes, []);
        p.unmount();
      } finally {
        putBack();
      }
    });
  });

  test('CXM-05: the keys’ item stays active under a resting pointer — a mouseover on another row and a mousemove at the point last seen leave it, and Enter picks it', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, sixty(picks));
        const rows = itemsOf(p);
        await p.move(rows[3], 120, 170);
        await p.move(rows[3], 121, 170);
        assert.equal(activeOf(rows), 3, 'premise: a real move made row 3 active');
        for (let i = 0; i < 5; i += 1) p.keydown('ArrowDown');
        assert.equal(activeOf(rows), 8, 'the keys moved it five rows on');
        // The list scrolled under the pointer: the row now under it gets a
        // mouseover, and some engines send a mousemove at the same point.
        await p.hover(rows[20]);
        assert.equal(activeOf(rows), 8, 'a mouseover on another row leaves the keys’ item active');
        await p.move(rows[20], 121, 170);
        assert.equal(activeOf(rows), 8, 'so does a mousemove on that row at the point last seen');
        p.keydown('Enter');
        assert.deepEqual(picks, [8], 'Enter picks the keys’ item');
        assert.equal(closes.length, 1, 'and closes the menu');
        p.unmount();
      } finally {
        putBack();
      }
    });
  });

  test('CXM-06: a real move takes over from the keys; over the item that is off it leaves nothing active; over a separator or the padding it leaves the active item as it is; a click picks the row clicked', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, sixty(picks));
        const rows = itemsOf(p);
        await p.move(rows[3], 120, 170);
        await p.move(rows[3], 120, 173);
        for (let i = 0; i < 3; i += 1) p.keydown('ArrowDown');
        assert.equal(activeOf(rows), 6, 'premise: the keys moved the active item to row 6');
        await p.move(rows[30], 123, 173);
        assert.equal(activeOf(rows), 30, 'a mousemove 3 px on, over row 30, makes it active');
        await p.move(rows[1], 123, 140);
        assert.equal(activeOf(rows), -1, 'a real move over the item that is off leaves nothing active');
        p.keydown('Enter');
        assert.deepEqual(picks, [], 'Enter with nothing active picks nothing');
        assert.deepEqual(closes, [], 'and the menu stays open');
        await p.move(rows[30], 123, 760);
        assert.equal(activeOf(rows), 30);
        p.keydown('Enter');
        assert.deepEqual(picks, [30], 'Enter picks the row the pointer made active');
        assert.equal(closes.length, 1);
        p.unmount();
      } finally {
        putBack();
      }
    });
    await onPage(async (p) => {
      remember(p);
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, twoWithASeparator(picks));
        const rows = itemsOf(p);
        await p.move(rows[0], 120, 110);
        await p.move(rows[0], 120, 112);
        assert.equal(activeOf(rows), 0, 'premise: a real move made A active');
        await p.move(p.document.querySelector('[role="separator"]'), 120, 128);
        assert.equal(activeOf(rows), 0, 'a real move over the separator leaves A active');
        await p.move(menuOf(p), 120, 102);
        assert.equal(activeOf(rows), 0, 'and so does one over the menu’s padding');
        await p.move(rows[1], 120, 140);
        assert.equal(activeOf(rows), 1, 'a real move over B makes B active');
        p.click(rows[0]);
        assert.deepEqual(picks, ['a'], 'a click picks the row clicked, not the active one');
        assert.equal(closes.length, 1, 'and closes the menu');
        p.unmount();
      } finally {
        putBack();
      }
    });
  });

  test('CXM-07: a scroll of the menu’s own list makes no row active; one that takes the active item wholly out of the menu’s box leaves the menu open and nothing active, and Enter picks nothing; partly inside, it stays active', async () => {
    const { ContextMenu } = await loadMenu();
    await onPage(async (p) => {
      remember(p);
      // The page lays nothing out: the menu and the rows this case looks at
      // get boxes of their own, which `finally` takes back.
      const measuredHere = new Set();
      const measure = (el, top, bottom) => {
        el.getBoundingClientRect = () => ({ left: 0, top, right: 240, bottom, width: 240, height: bottom - top });
        measuredHere.add(el);
      };
      try {
        const picks = [];
        const closes = await mounted(p, ContextMenu, sixty(picks));
        const rows = itemsOf(p);
        const menu = menuOf(p);
        const scrollInside = () => p.settled(() => dispatch(p.window, menu, { type: 'scroll' }));
        measure(menu, 100, 500);
        await p.move(rows[5], 120, 200);
        await p.move(rows[5], 120, 203);
        assert.equal(activeOf(rows), 5, 'premise: a real move made row 5 active');

        measure(rows[5], 190, 212);
        scrollInside();
        assert.equal(activeOf(rows), 5, 'wholly inside the menu’s box: still active');
        measure(rows[5], 90, 112);
        scrollInside();
        assert.equal(activeOf(rows), 5, 'partly inside, across its top edge: still active');
        measure(rows[5], 490, 512);
        scrollInside();
        assert.equal(activeOf(rows), 5, 'partly inside, across its bottom edge: still active');

        measure(rows[5], 78, 100);
        scrollInside();
        assert.deepEqual(closes, [], 'its own list scrolling leaves it open');
        assert.equal(activeOf(rows), -1, 'scrolled wholly out of its box, above the top: active no more');
        await p.hover(rows[7]);
        assert.equal(activeOf(rows), -1, 'the row now under the resting pointer getting a mouseover is not made active');
        await p.move(rows[7], 120, 203);
        assert.equal(activeOf(rows), -1, 'nor by a mousemove at the point last seen');
        p.keydown('Enter');
        assert.deepEqual(picks, [], 'Enter then picks nothing');
        assert.deepEqual(closes, [], 'and the menu stays open');
        assert.ok(menuOf(p), 'drawn');

        await p.move(rows[7], 120, 206);
        assert.equal(activeOf(rows), 7, 'a real move then makes the row under the pointer active');
        measure(rows[7], 500, 522);
        scrollInside();
        assert.equal(activeOf(rows), -1, 'scrolled wholly out of its box, below the bottom: active no more');
        p.keydown('ArrowDown');
        assert.equal(activeOf(rows), 0, 'the next arrow key starts as it does with nothing active');
        p.keydown('Enter');
        assert.deepEqual(picks, [0]);
        assert.equal(closes.length, 1);
        p.unmount();
      } finally {
        for (const el of measuredHere) delete el.getBoundingClientRect;
        putBack();
      }
    });
  });
});
