/**
 * Where the messages sent to OpenCode in mini mode are, for the terminal's
 * scrollbar — apart from Claude Code's (agentMessageMarks.js), whose rules
 * and tests stay as they are; only its exported helpers are shared.
 *
 * NexTerm starts OpenCode V1 (1.17.10 and newer) as `opencode --mini
 * --no-replay` (opencodeLaunch.js), which draws on the normal screen, so its
 * conversation goes into the scrollback. As measured for opencode-ai 1.18.34
 * (tests/adversarial/fixtures/opencode_mini/):
 *
 *   - what is being typed (the composer) shows from column 0, without a
 *     prefix, in the live area at the bottom, a blank row above it and a
 *     coloured footer band under it — which is not always on screen (at the
 *     second Enter of the recording it had been overwritten with spaces);
 *   - a sent message is committed on the composer's own rows as `› <text>`
 *     (U+203A at column 0, then a space), hard-broken by OpenCode at the
 *     width of the moment, continuation rows from column 0, a blank row
 *     after it; a turn ends with a `▣ Build · …` row; nothing is redrawn
 *     above the live area, and with `--no-replay` nothing is printed again on
 *     a resize.
 *
 * So the composer is read when Enter is pressed (`noteSubmit`), from the
 * cursor row upwards, and each scan after OpenCode has drawn looks for `› `
 * rows above the composer, and not above where it was at Enter (less one row),
 * whose text is that text (agentMessageMarks.js `matchPending`). Every rule
 * fails towards no mark: a row printed without a submit (a resumed
 * conversation's) never answers one, the composer is never a candidate, a row
 * that matches nothing is never marked, and a mark whose row is erased,
 * trimmed or cleared is gone — there is no pass that marks a reprint again,
 * and a bound whose row was erased never reaches back to row 0. A submit
 * typed ahead before mini has drawn — before a sign only mini draws, its
 * footer band, a `▣` row or its header block, is on screen — is not queued
 * (what the tty echoed is not mini's composer), and one read empty takes only
 * the row it was read on, once a commit has moved the composer off it. No
 * colour is ever needed, only whether a row has a background: themes differ.
 *
 * No xterm import, no React. `trackOpencodeMiniMarks` keeps one terminal's
 * marks, with the interface of `trackAgentMessageMarks`; the registry
 * (terminalRegistry.js) feeds it only while OpenCode runs there, scans it with
 * the same scheduler (`createScanScheduler`) and merges its marks with the
 * others for the click and the keys.
 */

import { undecorate } from './promptMarks.js';
import { MAX_PENDING, bufferReader, matchPending, normaliseMessageText } from './agentMessageMarks.js';

/** Mini marks kept for one terminal at most, the oldest dropped first; apart from the shell marks and Claude Code's. */
export const MAX_MINI_MARKS = 500;

/** The glyph OpenCode mini starts every committed message with (U+203A). */
export const MINI_GLYPH = '›';

/** The glyph a turn's footer row starts with (U+25A3): a row that ends a message or a composer. */
export const TURN_GLYPH = '▣';

/** How mini's header block starts, at cell 0 (its first frame; the session block at exit too). */
export const HEADER_BLOCK = '█▀▀█';

/** How far above the composer top read at Enter a submit's echo may be: measured on it; one row of tolerance. */
export const ECHO_ROWS_ABOVE_COMPOSER = 1;

/** Rows of one message, or of the composer, read at most. */
const MAX_MESSAGE_ROWS = 400;

const SPACES = new Set([' ', ' ', '']);

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;
const charsAt = (line, x) => line?.getCell(x)?.getChars() ?? '';
const rowText = (line, start = 0) => (line ? line.translateToString(true, start) : '');
const isBlank = (line) => !line || rowText(line).trim() === '';

/** Whether row `y` is a candidate's first row: not a soft wrap, `›` then a space in cells 0 and 1. */
export function isMiniCandidateRow(reader, y) {
  const line = reader.line(y);
  if (!line || line.isWrapped) return false;
  return charsAt(line, 0) === MINI_GLYPH && SPACES.has(charsAt(line, 1));
}

/** Whether `line` spans the width with a background of its own: mini's footer band (any colour; themes differ). */
function isBand(line, cols) {
  if (!line || !(cols > 0)) return false;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.isBgDefault()) return false;
  }
  return true;
}

/** Whether `line` is a turn footer (`▣`) or mini's header block (`█▀▀█`), from cell 0. */
function isMiniSignRow(line) {
  if (!line || line.isWrapped) return false;
  return charsAt(line, 0) === TURN_GLYPH || rowText(line).startsWith(HEADER_BLOCK);
}

/** A row a message or the composer never runs over: a blank one, a candidate, or a turn footer (`▣`). */
function isStopRow(reader, y) {
  const line = reader.line(y);
  if (isBlank(line)) return true;
  if (!line.isWrapped && charsAt(line, 0) === TURN_GLYPH) return true;
  return isMiniCandidateRow(reader, y);
}

/**
 * The composer as it is now: the cursor row (`cursor`, a buffer row), and
 * the rows above it that are neither blank nor stop rows, not above `from`.
 * `top` is its first row, `bottom` the cursor row, `text` its rows from
 * column 0, joined. No footer is needed. Null on the alternate screen.
 */
export function findMiniComposer(reader, cursor, from = 0) {
  if (!reader || reader.alternate || !Number.isInteger(cursor) || cursor < 0) return null;
  const first = Math.max(from, cursor - MAX_MESSAGE_ROWS, 0);
  let top = cursor;
  for (let y = cursor - 1; y >= first; y -= 1) {
    if (isStopRow(reader, y)) break;
    top = y;
  }
  const parts = [];
  for (let y = top; y <= cursor; y += 1) parts.push(rowText(reader.line(y)));
  return { top, bottom: cursor, text: parts.join('\n') };
}

/**
 * A candidate's rows: row `y` from cell 2, then the rows after it up to the
 * first stop row (and before `end`): a soft-wrapped row whole, joined to the
 * row it continues; a hard-broken one whole from cell 0.
 */
function messageRows(reader, y, end) {
  const rows = [{ text: rowText(reader.line(y), 2), wrapped: false }];
  const stop = Math.min(end, y + 1 + MAX_MESSAGE_ROWS, reader.length);
  for (let row = y + 1; row < stop; row += 1) {
    const line = reader.line(row);
    if (!line) break;
    if (line.isWrapped) {
      rows.push({ text: rowText(line), wrapped: true });
      continue;
    }
    if (isStopRow(reader, row)) break;
    rows.push({ text: rowText(line), wrapped: false });
  }
  return rows;
}

/**
 * A candidate's text (normalised) as it reads at the end of each of its rows,
 * a soft-wrapped row counted with the row it continues; shortest first, the
 * last the whole text. A mark is kept while one of these still equals the
 * text it was made for, so a reflow on resize keeps it.
 */
export function miniMessageTextsAt(reader, y, end) {
  const rows = messageRows(reader, y, end);
  const texts = [];
  let text = '';
  rows.forEach((row, i) => {
    text += normaliseMessageText(row.text);
    if (!rows[i + 1]?.wrapped) texts.push(text);
  });
  return texts;
}

/** Candidate rows in `from` .. `to - 1`, top down. */
function candidateRows(reader, from, to) {
  const rows = [];
  for (let y = Math.max(from, 0); y < Math.min(to, reader.length); y += 1) {
    if (isMiniCandidateRow(reader, y)) rows.push(y);
  }
  return rows;
}

/** The oldest text entry one of `texts` equals, at or below the rows its echo can be on; else -1. */
function exactIndex(pending, texts, row) {
  for (let i = 0; i < pending.length; i += 1) {
    const entry = pending[i];
    if (!entry.positional && entry.text && !(row < entry.from) && texts.includes(entry.text)) return i;
  }
  return -1;
}

/**
 * The marks of the messages sent to OpenCode mini in one terminal (`term`,
 * an xterm Terminal), oldest first.
 *
 *   - `noteShellSubmit()` on an Enter while no agent runs, and before NexTerm
 *     types an agent's line: the floor, below which a later OpenCode's rows
 *     are, goes to the row after it, so a shell prompt drawn as `› ` is
 *     never a candidate.
 *   - `noteTyped()` on what the user types; `noteSubmit()` on an Enter while
 *     OpenCode runs: the composer is read now, before the key reaches it,
 *     and what it held is queued with its top (the bound). Nothing is queued
 *     before mini has drawn after the floor — its footer band, a `▣` row or
 *     its header block seen (typeahead the tty echoed has none). An
 *     empty read with nothing typed since queues nothing, nor one whose
 *     composer a scan saw holding text (cleared); an empty read after
 *     typing (the draw lagged) queues a positional entry, which the next
 *     Enter on the same composer row drops.
 *   - `scan()` once OpenCode has drawn: marks what matches — of several rows
 *     for one entry, the lowest — and drops what no longer reads as its
 *     text. Nothing on the alternate screen. The composer top read from the
 *     cursor only limits new candidates; it never drops a mark (OpenCode
 *     moves the cursor mid-frame). A positional entry goes when the composer
 *     is still on its bound and empty, and otherwise is decided by the first
 *     scan that finds the composer off it: the row it was read on, or none.
 *   - `afterClear()` after Terminal: Clear; `stop()` once OpenCode is not
 *     running any more (the marks stay); `setVisible`, `setColor` and
 *     `lines` as the other marks have them.
 */
export function trackOpencodeMiniMarks(term, {
  limit = MAX_MINI_MARKS,
  maxPending = MAX_PENDING,
  decorate = null,
  visible = true,
  color = null,
} = {}) {
  let marks = [];
  let pending = [];
  let typed = false;
  // Whether mini has drawn since the last line typed at the shell (the
  // floor): a sign only mini draws seen below the floor (`noteDrawn`).
  // Before that, what the cursor sits in is the tty's echo of typeahead,
  // not mini's composer.
  let drawn = true;
  // The composer the last scan read: `{ top, empty }`.
  let lastRead = null;
  let floor = null;
  let floorOffset = 0;
  let scanFrom = null;
  let shown = visible !== false;
  let colour = color;
  let disposed = false;
  const stats = { scans: 0, reads: 0 };

  const buffer = () => term?.buffer?.active;
  const alternate = () => buffer()?.type === 'alternate';
  const cursorLine = () => buffer().baseY + buffer().cursorY;

  const markerAt = (line) => {
    if (typeof term?.registerMarker !== 'function' || line < 0) return null;
    const marker = term.registerMarker(line - cursorLine());
    if (!marker) return null;
    if (marker.line !== line) {
      marker.dispose?.();
      return null;
    }
    return marker;
  };

  const decorateMark = (mark) => {
    if (!shown || typeof decorate !== 'function' || mark.decoration || !alive(mark.marker)) return;
    try {
      mark.decoration = decorate(mark.marker, colour) ?? null;
    } catch (err) {
      mark.decoration = null;
      console.warn('[Terminal] could not draw a message mark:', err);
    }
  };

  // xterm disposed a mark's marker: its row was erased (ED), trimmed or
  // cleared. The mark goes with it, and nothing brings it back (no lost pass).
  const forget = (marker) => {
    if (disposed) return;
    const mark = marks.find((m) => m.marker === marker);
    if (!mark) return;
    marks = marks.filter((m) => m !== mark);
    undecorate(mark);
  };

  const drop = (mark) => {
    undecorate(mark);
    if (mark.marker && !mark.marker.isDisposed) mark.marker.dispose?.();
  };

  const dropAll = (list) => {
    if (!list.length) return;
    marks = marks.filter((m) => !list.includes(m));
    for (const mark of list) drop(mark);
  };

  const lines = () => marks.filter((m) => alive(m.marker)).map((m) => m.marker.line);

  const floorLine = () => (alive(floor) ? floor.line + floorOffset : 0);
  const scanFromLine = () => (alive(scanFrom) ? scanFrom.line : 0);

  const setFloor = (offset) => {
    floor?.dispose?.();
    floor = markerAt(cursorLine());
    floorOffset = offset;
    scanFrom?.dispose?.();
    scanFrom = null;
  };

  const add = (line, text) => {
    const marker = markerAt(line);
    if (!marker) return null;
    const mark = { marker, decoration: null, text };
    marker.onDispose?.(() => forget(marker));
    marks.push(mark);
    if (marks.length > limit) dropAll(marks.slice(0, marks.length - limit));
    decorateMark(mark);
    return mark;
  };

  const newestLine = () => {
    let newest = -1;
    for (const mark of marks) if (alive(mark.marker) && mark.marker.line > newest) newest = mark.marker.line;
    return newest;
  };

  // Pending submits, oldest first: what the composer held, its top at Enter
  // (`bound`, a marker; `boundAt` without one), and the last scrollback row
  // above the screen then (`above`), older than anything the echo can be.
  const keepPending = (next) => {
    for (const entry of pending) {
      if (next.includes(entry)) continue;
      entry.bound?.dispose?.();
      entry.above?.dispose?.();
    }
    pending = next;
  };
  // The composer top an entry's echo is measured from. A bound whose row was
  // erased, trimmed or cleared falls back to below the floor, the newest
  // mark and the rows above the screen at Enter — never to row 0 (W-01 of
  // agentMessageMarks.js is not copied).
  const boundLine = (entry) => {
    if (!entry.bound) return entry.boundAt;
    if (alive(entry.bound)) return entry.bound.line;
    return Math.max(floorLine(), newestLine() + 1, alive(entry.above) ? entry.above.line + 1 : 0);
  };
  // The first row a text entry's echo can be on: one row of tolerance above
  // a live bound, none above a fallen-back one.
  const fromLine = (entry) => {
    const line = boundLine(entry);
    return !entry.bound || alive(entry.bound) ? line - ECHO_ROWS_ABOVE_COMPOSER : line;
  };
  // Mini has drawn once a read sees, at or below the floor, a sign only mini
  // draws (Y-02): its footer band (a full-width row with a background) under
  // the composer, a turn's `▣` row, or its header block (`█▀▀█` at cell 0),
  // the composer's own rows left out. What the tty echoed of typeahead, an
  // empty Enter's blank row and a notice printed before mini's first frame
  // (a hook, a migration) have none of them (X-02). Until then nothing is
  // queued. Rows MAX_MESSAGE_ROWS around the composer at most.
  const noteDrawn = (reader, composer) => {
    if (drawn || !composer) return drawn;
    const from = Math.max(floorLine(), composer.top - MAX_MESSAGE_ROWS, 0);
    const to = Math.min(reader.length, composer.bottom + 1 + MAX_MESSAGE_ROWS);
    for (let y = from; y < to; y += 1) {
      if (y >= composer.top && y <= composer.bottom) continue;
      const line = reader.line(y);
      if (isMiniSignRow(line) || (y > composer.bottom && isBand(line, reader.cols))) {
        drawn = true;
        break;
      }
    }
    return drawn;
  };
  // Whether a positional entry still waits: its composer read on its bound.
  const onBound = (entry, top) => (!entry.bound || alive(entry.bound)) && boundLine(entry) === top;

  return {
    noteShellSubmit() {
      if (disposed || alternate()) return;
      setFloor(1);
      keepPending([]);
      typed = false;
      drawn = false;
      lastRead = null;
    },
    noteTyped() {
      typed = true;
    },
    /** The composer as it is now, queued for its echo; returns what was queued, or null. */
    noteSubmit() {
      const typedBefore = typed;
      typed = false;
      if (disposed || alternate()) return null;
      const reader = bufferReader(term, stats);
      const composer = findMiniComposer(reader, cursorLine(), floorLine());
      if (!composer) return null;
      // Typed ahead before mini has drawn (X-02): the cursor is in the tty's
      // echo under the launch line, and a resumed conversation's history may
      // repeat that text further down. Nothing is queued.
      if (!noteDrawn(reader, composer)) return null;
      const seen = lastRead;
      lastRead = null;
      const text = normaliseMessageText(composer.text);
      // A positional entry whose composer is still on its row was never
      // committed (a commit moves the composer down): it goes (X-01).
      const left = pending.filter((p) => !(p.positional && boundLine(p) === composer.top));
      let entry = null;
      if (text === '') {
        // Empty after typing: the draw lagged behind the keys — unless a scan
        // saw text in this composer since, which was then cleared (Ctrl+U,
        // Backspace) and commits nothing (X-01).
        const cleared = Boolean(seen) && seen.top === composer.top && !seen.empty;
        if (typedBefore && !cleared) entry = { positional: true, text: '' };
      } else {
        entry = { positional: false, text };
      }
      if (!entry) {
        keepPending(left);
        return null;
      }
      const bound = markerAt(composer.top);
      const above = markerAt(Math.min(composer.top, reader.baseY) - 1);
      const queued = [...left, { ...entry, bound, above, boundAt: composer.top, from: composer.top - ECHO_ROWS_ABOVE_COMPOSER }];
      keepPending(queued.length > maxPending ? queued.slice(queued.length - maxPending) : queued);
      return entry;
    },
    scan() {
      if (disposed || alternate()) return false;
      stats.scans += 1;
      const reader = bufferReader(term, stats);
      const composer = findMiniComposer(reader, cursorLine(), floorLine());
      if (!composer) return false;
      noteDrawn(reader, composer);
      const top = composer.top;
      const empty = normaliseMessageText(composer.text) === '';
      lastRead = { top, empty };
      const start = Math.max(floorLine(), scanFromLine());
      // What was marked and no longer reads as the text it was made for goes,
      // read over its own rows only. The composer top plays no part: the
      // cursor may be anywhere mid-frame (measured: on the row under a
      // two-row echo, which made the composer start on its second row).
      const stale = marks.filter((m) => {
        if (!alive(m.marker)) return true;
        const line = m.marker.line;
        if (line < start) return false;
        return !isMiniCandidateRow(reader, line) || !miniMessageTextsAt(reader, line, reader.length).includes(m.text);
      });
      dropAll(stale);
      // Entries that can answer nothing any more go first: one whose bound
      // was erased with no scrollback row above the screen at Enter, or with
      // that row gone too (ED 3) — nothing to fall back to (X-05, Y-04); a
      // positional one whose bound was erased, or whose composer is still on
      // its bound and empty — nothing was committed (X-01).
      keepPending(
        pending.filter((entry) => {
          if (entry.bound && !alive(entry.bound) && (entry.positional || !alive(entry.above))) return false;
          return !(entry.positional && empty && onBound(entry, top));
        })
      );
      for (const entry of pending) entry.from = fromLine(entry);
      const marked = new Set(lines());
      const rows = [];
      for (const y of candidateRows(reader, start, top)) {
        if (marked.has(y)) continue;
        const texts = miniMessageTextsAt(reader, y, top);
        const text = texts[texts.length - 1] ?? '';
        if (text) rows.push({ y, texts, text });
      }
      // Exact matches over all candidates before prefix matches (`matchPending`).
      for (const entry of pending) {
        entry.exact = !entry.positional && rows.some((r) => r.texts.includes(entry.text) && !(r.y < entry.from));
      }
      // Whether rows below row `r` of this scan answer entry `i` (as `fits`
      // says) more often than the later entries of its text can take: then
      // the lowest is its own, and the rows above it (a history OpenCode
      // printed by itself) are not (X-02).
      const lowerTakes = (r, i, fits) => {
        const entry = pending[i];
        const later = pending.slice(i + 1).filter((p) => !p.positional && p.text === entry.text).length;
        let lower = 0;
        for (let k = r + 1; k < rows.length; k += 1) {
          if (!marked.has(rows[k].y) && !(rows[k].y < entry.from) && fits(rows[k], entry)) lower += 1;
        }
        return lower > later;
      };
      for (let r = 0; r < rows.length; r += 1) {
        const { y, texts, text } = rows[r];
        if (marked.has(y)) continue;
        // A submit's own echo, by its text, at or below the rows it can be on.
        let take = exactIndex(pending, texts, y);
        let made = take >= 0 ? pending[take].text : null;
        if (made !== null && lowerTakes(r, take, (row, entry) => row.texts.includes(entry.text))) continue;
        if (made === null) {
          take = matchPending(pending, text, y);
          if (take >= 0) made = text;
          if (made !== null && lowerTakes(r, take, (row, entry) => row.text.startsWith(entry.text))) continue;
        }
        // A submit read empty after typing: only the row it was read on (or
        // the one of tolerance above), below the newest mark, once the
        // composer has left it — a commit moved it down.
        if (made === null) {
          const positional = pending.findIndex((p) => p.positional);
          const at = positional >= 0 ? boundLine(pending[positional]) : null;
          if (at !== null && y <= at && y >= at - ECHO_ROWS_ABOVE_COMPOSER && y > newestLine()) {
            take = positional;
            made = text;
          }
        }
        if (made === null) continue;
        keepPending(pending.slice(take + 1));
        if (add(y, made)) marked.add(y);
      }
      // A positional entry is decided by the first scan that finds its
      // composer off its row: taken above, or gone now (X-01).
      keepPending(pending.filter((p) => !p.positional || onBound(p, top)));
      scanFrom?.dispose?.();
      scanFrom = markerAt(reader.baseY);
      return true;
    },
    afterClear() {
      if (disposed) return;
      dropAll([...marks]);
      if (!alternate()) setFloor(0);
    },
    stop() {
      keepPending([]);
      typed = false;
    },
    setVisible(next) {
      if (disposed) return;
      shown = next !== false;
      for (const mark of marks) {
        if (shown) decorateMark(mark);
        else undecorate(mark);
      }
    },
    setColor(next) {
      if (disposed || next === colour) return;
      colour = next;
      if (!shown) return;
      for (const mark of marks) {
        undecorate(mark);
        decorateMark(mark);
      }
    },
    get marks() {
      return marks;
    },
    get lines() {
      return lines();
    },
    get pending() {
      return pending.map(({ positional, text }) => ({ positional, text }));
    },
    get floor() {
      return floorLine();
    },
    get visible() {
      return shown;
    },
    get color() {
      return colour;
    },
    get stats() {
      return stats;
    },
    dispose() {
      if (disposed) return;
      const all = marks;
      marks = [];
      disposed = true;
      for (const mark of all) drop(mark);
      floor?.dispose?.();
      scanFrom?.dispose?.();
      floor = null;
      scanFrom = null;
      keepPending([]);
    },
  };
}

export default {
  MAX_MINI_MARKS,
  MINI_GLYPH,
  TURN_GLYPH,
  HEADER_BLOCK,
  isMiniCandidateRow,
  findMiniComposer,
  miniMessageTextsAt,
  trackOpencodeMiniMarks,
};
