/**
 * xterm 5.5's wheel arithmetic, transcribed from its src/browser/Viewport.ts
 * and Terminal.ts, for the wheel tests to count against: what NexTerm's wheel
 * rules (src/lib/terminalCompat.js) are meant to reproduce on xterm 6.
 *
 * Checked against real 5.5 in headless Chromium, 16 px rows, before being
 * relied on: 100 px notches over the scrollback moved it 6, 6, 7, 6 rows; ⌥
 * 31; Shift none; 20 trackpad events of 4 px 5 rows; 40 px notches 2, 3, 2,
 * 3…; a 3-line event 3 rows and a page event one screen — every number below
 * gives the same. Not a module of the app: nothing under src/ imports it.
 *
 * Events are plain objects, `{ deltaY, deltaMode, altKey, shiftKey }`; 5.5's
 * defaults throughout: `scrollSensitivity` 1, `fastScrollSensitivity` 5,
 * `fastScrollModifier` 'alt'.
 */

const LINE = 1;
const PAGE = 2;

/** `Viewport._applyScrollModifier`, for the default modifier (Alt). */
function applyScrollModifier(amount, event, { scrollSensitivity = 1, fastScrollSensitivity = 5 } = {}) {
  if (event.altKey) return amount * fastScrollSensitivity * scrollSensitivity;
  return amount * scrollSensitivity;
}

/**
 * The rows each event moved the scrollback by. `Viewport.handleWheel` added
 * `_getPixelsScrolled(ev)` to the viewport's native `scrollTop` — which stops
 * at 0 and at the bottom — and `_handleScroll` then showed the row nearest to
 * it, `Math.round(scrollTop / rowHeight)`. `startRow` is the row shown first
 * (its `scrollTop` on that row, as 5.5 left it after any other scroll);
 * `maxRow` the bottom (`baseY`).
 */
export function scrollbackRows55(events, { cellHeight, rows, startRow, maxRow, ...options }) {
  let scrollTop = startRow * cellHeight;
  let row = startRow;
  return events.map((event) => {
    // `_getPixelsScrolled`: not a vertical scroll.
    if (event.deltaY === 0 || event.shiftKey) return 0;
    let amount = applyScrollModifier(event.deltaY, event, options);
    if (event.deltaMode === LINE) amount *= cellHeight;
    else if (event.deltaMode === PAGE) amount *= cellHeight * rows;
    scrollTop = Math.min(Math.max(scrollTop + amount, 0), maxRow * cellHeight);
    const next = Math.round(scrollTop / cellHeight);
    const moved = next - row;
    row = next;
    return moved;
  });
}

/**
 * The arrow keys each event sent a program on a screen without scrollback:
 * `Viewport.getLinesScrolled` — pixels over the row height, the fraction kept
 * in `_wheelPartialScroll`; a line event that many lines, a page event that
 * many screens — then Terminal's `for (i = 0; i < Math.abs(amount); i++)`,
 * one key per step begun. Negative is up (`ESC [ A`).
 */
export function pagerArrows55(events, { cellHeight, rows, ...options }) {
  let partial = 0;
  return events.map((event) => {
    if (event.deltaY === 0 || event.shiftKey) return 0;
    let amount = applyScrollModifier(event.deltaY, event, options);
    if (event.deltaMode === LINE) {
      // as is
    } else if (event.deltaMode === PAGE) {
      amount *= rows;
    } else {
      amount /= cellHeight + 0.0;
      partial += amount;
      amount = Math.floor(Math.abs(partial)) * (partial > 0 ? 1 : -1);
      partial %= 1;
    }
    if (amount === 0) return 0;
    return Math.sign(event.deltaY) * Math.ceil(Math.abs(amount));
  });
}
