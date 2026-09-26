/**
 * Where the terminal's inline suggestion is drawn.
 *
 * Two defects, both measured in the real dev app on macOS (WKWebView, real
 * zsh, 102x36 grid, SF Mono 12px, line height 1.5):
 *
 *   - Under the WebGL renderer — the one that ships wherever a GPU context
 *     exists — the suggestion never appeared at all. The cell was measured
 *     from `.xterm-rows`, which only xterm's DOM renderer creates, so there
 *     was no cell size and the layer cleared itself. Typing `git s` gave 0
 *     items and no ghost; with the WebGL addon disposed, 8 items and `tash`.
 *   - Under the DOM renderer the ghost was drawn LEFT of the cursor, over what
 *     had just been typed. It was placed when the key was sent, before the
 *     shell echoed it, so the cursor was still where it had been: 1 cell back
 *     per key typed one at a time, 5 cells back when `git s` arrived as one
 *     chunk (ghost at 231.2px, cursor at 267.3px).
 *
 * The WebGL cell is also not the font's advance: the same font gave 7.2255px
 * cells under the DOM renderer and 7px under WebGL, which floors the glyph
 * width to whole device pixels. Measuring a character in the terminal's font
 * would have put the ghost 8.3px off at column 37. Both renderers size
 * `.xterm-screen` to exactly their own grid, which is what these cases feed in.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { cellSize, textBeforeCursor, suggestionAnchor, locateSuggestion } from '../../src/lib/suggestGeometry.js';

const PROMPT = 'geekover@geekoverui-Macmini ~ % ';
const COLS = 102;
const ROWS = 36;

// `.xterm-screen` as measured in the app. The DOM renderer's grid is wider for
// the same font and the same number of columns.
const WEBGL_SCREEN = { left: 309, top: 91, width: 714, height: 756 };
const DOM_SCREEN = { left: 309, top: 91, width: 737, height: 756 };
const WRAPPER = { left: 309, top: 91, width: 737, height: 760 };
const WEBGL_CELL = 7;
const DOM_CELL = 737 / 102; // 7.2254901960784315
const CELL_HEIGHT = 21;

const isWide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch);

/**
 * A buffer row the way xterm stores one: a cell per column, a wide character
 * followed by an empty zero-width cell, and `translateToString` walking cells
 * rather than characters. Enough of `IBufferLine` for the code under test.
 */
function fakeLine(text, { cols = COLS, isWrapped = false } = {}) {
  const cells = [];
  for (const ch of text) {
    if (isWide(ch)) {
      cells.push({ ch, width: 2 }, { ch: '', width: 0 });
    } else {
      cells.push({ ch, width: 1 });
    }
  }
  while (cells.length < cols) cells.push({ ch: '', width: 1 });
  return {
    isWrapped,
    length: cols,
    translateToString(trimRight = false, startCol = 0, endCol = cols) {
      if (trimRight) {
        let trimmed = cells.length;
        while (trimmed > 0 && !cells[trimmed - 1].ch) trimmed -= 1;
        endCol = Math.min(endCol, trimmed);
      }
      let out = '';
      let x = startCol;
      while (x < endCol) {
        out += cells[x].ch || ' ';
        x += cells[x].width || 1;
      }
      return out;
    },
  };
}

/**
 * `term.buffer.active` with the prompt line at the bottom page's row
 * `cursorY`. `cursorX` defaults to the cell after the text, which is where a
 * shell's echo leaves it.
 */
function fakeBuffer(lines, { cursorY = lines.length - 1, cursorX, baseY = 0, viewportY = baseY } = {}) {
  const rows = lines.map((l) => (typeof l === 'string' ? fakeLine(l) : l));
  const last = rows[baseY + cursorY];
  const x = cursorX ?? last.translateToString(true).length + [...last.translateToString(true)].filter(isWide).length;
  return {
    cursorX: x,
    cursorY,
    baseY,
    viewportY,
    length: rows.length,
    getLine: (y) => rows[y],
  };
}

const rect = (r) => ({ getBoundingClientRect: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height }) });

/**
 * An xterm instance as the DOM shows it. The WebGL renderer draws into
 * canvases inside `.xterm-screen` and creates no `.xterm-rows`; the DOM
 * renderer creates `.xterm-rows` at the screen's origin, the same size.
 */
function fakeTerminal({ renderer = 'webgl', buffer, screen = renderer === 'webgl' ? WEBGL_SCREEN : DOM_SCREEN, cols = COLS, rows = ROWS }) {
  const found = {
    '.xterm-screen': rect(screen),
    '.xterm-rows': renderer === 'dom' ? rect(screen) : null,
  };
  return {
    cols,
    rows,
    element: { querySelector: (selector) => found[selector] ?? null },
    buffer: { active: buffer },
  };
}

const wrapper = rect(WRAPPER);

/** The line after the shell has echoed `typed` onto the prompt. */
const echoed = (typed) => fakeBuffer([PROMPT + typed]);

const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);

describe('Suggestion placement: a cell that does not depend on the renderer', () => {
  test('SP-01: under WebGL, where there is no .xterm-rows, the suggestion is still placed', () => {
    const term = fakeTerminal({ renderer: 'webgl', buffer: echoed('git s') });
    const at = locateSuggestion(term, wrapper, 'git s');
    assert.ok(at, 'no position under the WebGL renderer: the suggestion layer is silently off');
    near(at.left, 37 * WEBGL_CELL, 'left');
    near(at.top, 0, 'top');
    near(at.cellWidth, WEBGL_CELL, 'cell width');
    near(at.cellHeight, CELL_HEIGHT, 'cell height');
  });

  test('SP-02: the cell is the renderer\'s own, so the same font lands differently under each', () => {
    // 7px under WebGL and 7.2255px under the DOM renderer, for the same font at
    // the same size. A position computed from the font would be right under one
    // of them at most.
    const gl = locateSuggestion(fakeTerminal({ renderer: 'webgl', buffer: echoed('git s') }), wrapper, 'git s');
    const dom = locateSuggestion(fakeTerminal({ renderer: 'dom', buffer: echoed('git s') }), wrapper, 'git s');
    assert.ok(gl && dom, 'both renderers must give a position');
    near(gl.left, 259, 'WebGL left');
    near(dom.left, 37 * DOM_CELL, 'DOM left');
    near(dom.cellWidth, DOM_CELL, 'DOM cell width');
  });

  test('SP-03: the cell size is the screen divided by the grid, and nothing when either is missing', () => {
    assert.deepEqual(cellSize(WEBGL_SCREEN, COLS, ROWS), { cellWidth: 7, cellHeight: 21 });
    assert.equal(cellSize({ width: 0, height: 756 }, COLS, ROWS), null, 'not laid out');
    assert.equal(cellSize({ width: 714, height: 0 }, COLS, ROWS), null, 'not laid out');
    assert.equal(cellSize(WEBGL_SCREEN, 0, ROWS), null, 'no grid yet');
    assert.equal(cellSize(WEBGL_SCREEN, COLS, undefined), null, 'no grid yet');
    assert.equal(cellSize(null, COLS, ROWS), null);
  });

  test('SP-04: the screen\'s offset inside the pane is carried into the position', () => {
    const inset = { left: WRAPPER.left + 4, top: WRAPPER.top + 2, width: 714, height: 756 };
    const term = fakeTerminal({ renderer: 'webgl', screen: inset, buffer: echoed('git s') });
    const at = locateSuggestion(term, wrapper, 'git s');
    assert.ok(at);
    near(at.left, 4 + 37 * WEBGL_CELL, 'left');
    near(at.top, 2, 'top');
  });
});

describe('Suggestion placement: after the echo, never before', () => {
  // The keys have been sent; what the terminal shows is the only evidence of
  // where the shell put them. Until it shows them, the cursor is where it was
  // before they were typed — which is exactly where the ghost used to go.
  for (const renderer of ['webgl', 'dom']) {
    test(`SP-05 (${renderer}): nothing is placed while the typed keys are not on screen yet`, () => {
      const notYet = fakeTerminal({ renderer, buffer: fakeBuffer([PROMPT]) });
      assert.equal(locateSuggestion(notYet, wrapper, 'git s'), null, 'placed before any of it was echoed');

      const partly = fakeTerminal({ renderer, buffer: fakeBuffer([PROMPT + 'git']) });
      assert.equal(locateSuggestion(partly, wrapper, 'git s'), null, 'placed with two keys still unechoed');
    });

    test(`SP-06 (${renderer}): once it is on screen, the ghost starts exactly at the cursor`, () => {
      const cell = renderer === 'webgl' ? WEBGL_CELL : DOM_CELL;
      const term = fakeTerminal({ renderer, buffer: echoed('git s') });
      const at = locateSuggestion(term, wrapper, 'git s');
      assert.ok(at, 'not placed after the echo arrived');
      near(at.left, term.buffer.active.cursorX * cell, 'left');
      assert.equal(term.buffer.active.cursorX, 37);
    });
  }

  test('SP-07: a line the shell never echoes (a password) never gets a suggestion', () => {
    for (const renderer of ['webgl', 'dom']) {
      const term = fakeTerminal({ renderer, buffer: fakeBuffer(['[sudo] password for geekover: ']) });
      assert.equal(locateSuggestion(term, wrapper, 'hunter2'), null, renderer);
    }
  });

  test('SP-08: a trailing space is matched by the blank cell the echo leaves', () => {
    // An echoed space and a cell nobody wrote read the same; both are a space
    // before the cursor.
    const term = fakeTerminal({ renderer: 'webgl', buffer: fakeBuffer([PROMPT + 'git'], { cursorX: 36 }) });
    const at = locateSuggestion(term, wrapper, 'git ');
    assert.ok(at);
    near(at.left, 36 * WEBGL_CELL, 'left');
  });
});

describe('Suggestion placement: the cursor\'s cell, whatever the line holds', () => {
  test('SP-09: wide characters take two cells and still read back as typed', () => {
    // 한 and 글 are two cells each, so the cursor is at 32 + 5 + 4 = 41.
    const buffer = fakeBuffer([PROMPT + 'echo 한글']);
    assert.equal(buffer.cursorX, 41, 'fixture: the cursor is past both wide cells');
    assert.equal(textBeforeCursor(buffer), PROMPT + 'echo 한글');
    const at = locateSuggestion(fakeTerminal({ renderer: 'webgl', buffer }), wrapper, 'echo 한글');
    assert.ok(at);
    near(at.left, 41 * WEBGL_CELL, 'left');
  });

  test('SP-10: a typed line that wrapped onto the next row is read across the wrap', () => {
    const head = PROMPT + 'x'.repeat(COLS - PROMPT.length);
    const tail = 'yyyy';
    const buffer = fakeBuffer([head, fakeLine(tail, { isWrapped: true })], { cursorY: 1, cursorX: 4 });
    const typed = 'x'.repeat(COLS - PROMPT.length) + tail;
    assert.ok(textBeforeCursor(buffer).endsWith(typed), 'the wrapped rows were not joined');
    const at = locateSuggestion(fakeTerminal({ renderer: 'webgl', buffer }), wrapper, typed);
    assert.ok(at, 'a wrapped line lost its suggestion');
    near(at.left, 4 * WEBGL_CELL, 'left');
    near(at.top, CELL_HEIGHT, 'top: the row the cursor is on');
  });

  for (const renderer of ['webgl', 'dom']) {
    test(`SP-11 (${renderer}): the row counts from the top of the viewport, and off-screen is nothing`, () => {
      // 100 rows of scrollback; the prompt is the bottom page's row 3.
      const lines = [...Array.from({ length: 103 }, () => 'output'), PROMPT + 'git s'];
      const atBottom = fakeBuffer(lines, { baseY: 100, cursorY: 3 });
      const bottom = locateSuggestion(fakeTerminal({ renderer, buffer: atBottom }), wrapper, 'git s');
      assert.ok(bottom);
      near(bottom.top, 3 * CELL_HEIGHT, 'top at the bottom of the scrollback');

      const scrolledALittle = fakeBuffer(lines, { baseY: 100, cursorY: 3, viewportY: 90 });
      const little = locateSuggestion(fakeTerminal({ renderer, buffer: scrolledALittle }), wrapper, 'git s');
      assert.ok(little);
      near(little.top, 13 * CELL_HEIGHT, 'top after scrolling back 10 rows');

      const scrolledAway = fakeBuffer(lines, { baseY: 100, cursorY: 3, viewportY: 40 });
      assert.equal(
        locateSuggestion(fakeTerminal({ renderer, buffer: scrolledAway }), wrapper, 'git s'),
        null,
        'drawn over the scrollback while the cursor is off-screen'
      );
    });

    test(`SP-12 (${renderer}): the cursor parked past the last column has no cell to draw in`, () => {
      // After a character lands in the last column the cursor waits at `cols`
      // for the next one, which will start the next row.
      const full = PROMPT + 'x'.repeat(COLS - PROMPT.length);
      const buffer = fakeBuffer([full], { cursorX: COLS });
      const typed = 'x'.repeat(COLS - PROMPT.length);
      assert.equal(locateSuggestion(fakeTerminal({ renderer, buffer }), wrapper, typed), null);
    });
  }

  test('SP-13: anything missing means nothing is placed, and nothing throws', () => {
    const buffer = echoed('git s');
    const term = fakeTerminal({ renderer: 'webgl', buffer });
    assert.equal(locateSuggestion(term, null, 'git s'), null, 'no wrapper');
    assert.equal(locateSuggestion(term, wrapper, ''), null, 'nothing typed');
    assert.equal(locateSuggestion(term, wrapper, undefined), null, 'nothing typed');
    assert.equal(locateSuggestion({ ...term, element: undefined }, wrapper, 'git s'), null, 'not opened');
    assert.equal(locateSuggestion({ ...term, buffer: undefined }, wrapper, 'git s'), null, 'no buffer');
    assert.equal(
      locateSuggestion(fakeTerminal({ renderer: 'webgl', buffer, screen: { left: 0, top: 0, width: 0, height: 0 } }), wrapper, 'git s'),
      null,
      'not laid out'
    );
    assert.equal(
      locateSuggestion({ ...term, element: { querySelector: () => null } }, wrapper, 'git s'),
      null,
      'no screen element'
    );
    assert.equal(textBeforeCursor(fakeBuffer([PROMPT], { cursorY: 5, cursorX: 0 })), null, 'no line under the cursor');
  });

  test('SP-14: the pure form agrees with what the terminal adapter reads', () => {
    const buffer = echoed('git s');
    const pure = suggestionAnchor({
      screenRect: WEBGL_SCREEN,
      wrapperRect: WRAPPER,
      cols: COLS,
      rows: ROWS,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      lineBeforeCursor: textBeforeCursor(buffer),
      typed: 'git s',
    });
    assert.deepEqual(pure, locateSuggestion(fakeTerminal({ renderer: 'webgl', buffer }), wrapper, 'git s'));
  });
});
