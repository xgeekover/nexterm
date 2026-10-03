/**
 * Where the terminal's inline suggestion is drawn: the cell the cursor is in,
 * once the shell has put what was typed on the screen.
 *
 * Pure apart from `locateSuggestion`, which only reads — two rects from the
 * DOM, the cursor and its line from xterm's buffer — and hands them to the
 * rest. No React and no real xterm, so every rule here is checked in Node
 * (tests/adversarial/suggest_geometry.test.js).
 */

/**
 * One grid cell in CSS pixels: `.xterm-screen`'s size over the grid's.
 *
 * Both of xterm's renderers size that element to exactly their own grid, so
 * this is the cell actually drawn, whichever one is running. The alternatives
 * are each right under one renderer at most. `.xterm-rows` exists only under
 * the DOM renderer, which is why the suggestion never appeared under WebGL,
 * the renderer that ships wherever a GPU context exists. The font's own
 * advance is not the WebGL cell either: WebGL floors the glyph to whole device
 * pixels, so the same 12px font measured 7.2255px cells under the DOM renderer
 * and 7px under WebGL — 8px apart by column 37. And xterm's own figure,
 * `_renderService.dimensions`, is private API.
 *
 * WebGL rounds the screen to whole CSS pixels where its cell need not be
 * whole, which moves any column by less than half a pixel.
 *
 * Null when the terminal is not laid out yet or has no grid.
 */
export function cellSize(screenRect, cols, rows) {
  if (!screenRect || !(cols > 0) || !(rows > 0)) return null;
  const { width, height } = screenRect;
  if (!(width > 0) || !(height > 0)) return null;
  return { cellWidth: width / cols, cellHeight: height / rows };
}

/**
 * The text on the cursor's line, up to the cursor.
 *
 * Read back across the rows a long line wrapped onto, so a command typed past
 * the right edge still reads whole; `atLeast` stops that walk once there is
 * enough text to decide anything. A wide character comes back once: xterm
 * stores it as a cell plus an empty one, and `translateToString` steps over the
 * empty one.
 *
 * `buffer` is xterm's `term.buffer.active`. Null when there is no line under
 * the cursor.
 */
export function textBeforeCursor(buffer, atLeast = Infinity) {
  if (!buffer || typeof buffer.getLine !== 'function') return null;
  let y = buffer.baseY + buffer.cursorY;
  let line = buffer.getLine(y);
  if (!line) return null;
  let text = line.translateToString(false, 0, buffer.cursorX);
  while (line.isWrapped && text.length < atLeast) {
    y -= 1;
    line = buffer.getLine(y);
    if (!line) break;
    text = line.translateToString(false) + text;
  }
  return text;
}

/**
 * Where a suggestion for `typed` goes, relative to `wrapperRect`, or null.
 *
 * Null until the line up to the cursor ends with what was typed. The position
 * used to be taken the moment a key was sent, before the shell had echoed it,
 * so the cursor was still where it had been: the ghost landed one cell left
 * for every key in flight, over the text just typed. What the terminal shows
 * is the only evidence of where the shell put the keys, so until it shows them
 * there is nowhere right to draw — and a line the shell never echoes, a
 * password, never gets a suggestion at all.
 *
 * Also null, rather than a guess, when the cursor's row is scrolled out of the
 * viewport, or when the cursor is parked past the last column: the next
 * character starts the next row, so there is no cell to draw in.
 *
 * `cursorY` counts from `baseY`, as xterm's buffer reports it; the row drawn is
 * counted from the top of the viewport, `viewportY`.
 */
export function suggestionAnchor({
  screenRect,
  wrapperRect,
  cols,
  rows,
  cursorX,
  cursorY,
  baseY = 0,
  viewportY = baseY,
  lineBeforeCursor,
  typed,
}) {
  if (!wrapperRect || typeof typed !== 'string' || !typed) return null;
  if (typeof lineBeforeCursor !== 'string' || !lineBeforeCursor.endsWith(typed)) return null;
  const cell = cellSize(screenRect, cols, rows);
  if (!cell) return null;
  const row = baseY + cursorY - viewportY;
  if (!(row >= 0 && row < rows) || !(cursorX >= 0 && cursorX < cols)) return null;
  return {
    left: screenRect.left - wrapperRect.left + cursorX * cell.cellWidth,
    top: screenRect.top - wrapperRect.top + row * cell.cellHeight,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
  };
}

/**
 * The cursor's own cell, relative to `wrapperRect` — where a Korean syllable
 * still being composed is drawn (see hangulInlineIme.js), on top of the cursor
 * the way xterm draws its own composition.
 *
 * Unlike a suggestion this needs nothing typed to be on screen yet: the
 * syllable has not been sent, so the cursor is exactly where it will land. A
 * cursor parked past the last column draws in the last cell, as xterm's
 * composition view does. Null when the terminal is not laid out or the
 * cursor's row is scrolled out of the viewport.
 */
export function cursorCellAnchor({ screenRect, wrapperRect, cols, rows, cursorX, cursorY, baseY = 0, viewportY = baseY }) {
  if (!wrapperRect) return null;
  const cell = cellSize(screenRect, cols, rows);
  if (!cell) return null;
  const row = baseY + cursorY - viewportY;
  if (!(row >= 0 && row < rows) || !(cursorX >= 0)) return null;
  const col = Math.min(cursorX, cols - 1);
  return {
    left: screenRect.left - wrapperRect.left + col * cell.cellWidth,
    top: screenRect.top - wrapperRect.top + row * cell.cellHeight,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
  };
}

/** `cursorCellAnchor` for a live xterm instance and the overlay's `wrapper`. */
export function locateCursorCell(term, wrapper) {
  if (!wrapper) return null;
  const screen = term?.element?.querySelector('.xterm-screen');
  const buffer = term?.buffer?.active;
  if (!screen || !buffer) return null;
  return cursorCellAnchor({
    screenRect: screen.getBoundingClientRect(),
    wrapperRect: wrapper.getBoundingClientRect(),
    cols: term.cols,
    rows: term.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
  });
}

/**
 * `suggestionAnchor` for a live xterm instance and `wrapper`, the element the
 * suggestion overlay is positioned in.
 */
export function locateSuggestion(term, wrapper, typed) {
  if (!wrapper || typeof typed !== 'string' || !typed) return null;
  const screen = term?.element?.querySelector('.xterm-screen');
  const buffer = term?.buffer?.active;
  if (!screen || !buffer) return null;
  return suggestionAnchor({
    screenRect: screen.getBoundingClientRect(),
    wrapperRect: wrapper.getBoundingClientRect(),
    cols: term.cols,
    rows: term.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lineBeforeCursor: textBeforeCursor(buffer, typed.length),
    typed,
  });
}

export default { cellSize, textBeforeCursor, suggestionAnchor, locateSuggestion, cursorCellAnchor, locateCursorCell };
