/**
 * Where the messages sent to Claude Code are, for the terminal's scrollbar.
 *
 * Claude Code draws on the normal screen when NexTerm starts its shells with
 * CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 (src-tauri/src/pty/manager.rs). As
 * measured for Claude Code 2.1.327 (tests/adversarial/fixtures/claude_code/):
 *
 *   - the live input box is a `❯` row between two full-width `───` rules
 *     near the bottom, continuation rows indented two spaces;
 *   - a sent message becomes a static row `❯ <text>` above the box, wrapped
 *     rows indented two spaces, and a blank row after it;
 *   - the echo lands about one row higher than the box was at Enter, so the
 *     mark cannot go on the cursor row at Enter, as a shell prompt's does.
 *
 * So the text the box held at Enter is queued (`noteSubmit`), and each scan
 * after Claude Code has drawn looks for `❯ ` rows above the live box, and not
 * above where the box was at Enter, whose text is that text. Every rule fails
 * towards no mark: a row drawn before the submit (a resumed conversation's)
 * never answers it, the live box is never
 * a candidate, a row that matches nothing is never marked, and without a box
 * on screen a scan does nothing at all. A Claude Code UI change is fixed here.
 *
 * No xterm import, no React (like promptMarks.js). `trackAgentMessageMarks`
 * keeps one terminal's marks; the registry (terminalRegistry.js) says when to
 * scan and merges these marks with the shell prompt marks for the click and
 * the keys. Nothing runs on the alternate screen: fullscreen Claude Code has
 * no scrollback and xterm hides the ruler there.
 */

import { undecorate } from './promptMarks.js';

/** Message marks kept for one terminal at most, the oldest dropped first; apart from the shell marks' 500. */
export const MAX_MESSAGE_MARKS = 500;

/** Submits waiting for their echo at most, the oldest dropped first. */
export const MAX_PENDING = 20;

/** The glyph Claude Code starts the input box and every echoed message with (U+276F). */
export const PROMPT_GLYPH = '❯';

const RULE_CHAR = '─';
/** A rule row spans at least this share of the columns. */
export const RULE_MIN_SHARE = 0.8;

/** What a long paste or an image shows in the box instead of the text. */
const PLACEHOLDERS = ['[Pastedtext#', '[Image#'];

/** Rows of one message read at most (a pasted block echoed in full). */
const MAX_MESSAGE_ROWS = 400;

/** Scan timing (F10): a trailing debounce after the last write, and at most 4 a second while output keeps coming. */
export const SCAN_DEBOUNCE_MS = 150;
export const SCAN_MIN_INTERVAL_MS = 250;

const SPACES = new Set([' ', ' ', '']);

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;

/**
 * The text compared: Unicode NFC with every whitespace character removed, so
 * Claude Code's word wrap, CJK text wrapped without spaces, explicit newlines
 * and trailing padding compare equal.
 */
export function normaliseMessageText(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFC').replace(/\s+/gu, '');
}

/** A row that is only U+2500 once trimmed, across at least 80 percent of `cols`. */
export function isRuleRow(text, cols) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < Math.ceil(Math.max(cols, 1) * RULE_MIN_SHARE)) return false;
  for (const ch of trimmed) if (ch !== RULE_CHAR) return false;
  return true;
}

/**
 * A small reader over xterm's active buffer: what the helpers below need and
 * nothing else, counted (`reads`) so a test can tell that nothing was read.
 */
export function bufferReader(term, stats = null) {
  const buffer = term.buffer.active;
  const count = () => {
    if (stats) stats.reads += 1;
  };
  const lineAt = (y) => {
    count();
    return buffer.getLine(y);
  };
  return {
    cols: term.cols,
    rows: term.rows,
    baseY: buffer.baseY,
    length: buffer.length,
    alternate: buffer.type === 'alternate',
    line: lineAt,
  };
}

const charsAt = (line, x) => line?.getCell(x)?.getChars() ?? '';

/** A row's text from cell `start`, the cells drawn faint (a placeholder's hint) left out when `skipDim`. */
function rowText(line, cols, start = 0, skipDim = false) {
  if (!line) return '';
  if (!skipDim) return line.translateToString(true, start);
  let out = '';
  for (let x = start; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (cell.isDim?.()) {
      out += ' ';
      continue;
    }
    out += cell.getChars() || ' ';
  }
  return out.trimEnd();
}

const isBlank = (line, cols) => !line || rowText(line, cols).trim() === '';

/**
 * The live input box on the screen (rows baseY .. baseY + rows - 1), or null:
 * searching upwards from the last non-blank row, the lowest pair of rule rows,
 * if they enclose a row whose first cell is `❯`. That pair is the only box
 * there can be: when it holds no `❯` row (bash mode's `!`, and the like), there
 * is none, and no pair higher up is taken for it (U-05). `top` is the upper
 * rule row; `text` the box's text — its first row without the `❯ ` prefix, the
 * rest without their two-space indent, faint hint text left out.
 */
export function findLiveInputBox(reader) {
  if (!reader || reader.alternate) return null;
  const first = Math.max(reader.baseY, 0);
  const last = Math.min(reader.baseY + reader.rows - 1, reader.length - 1);
  let lower = null;
  let prompt = null;
  let started = false;
  for (let y = last; y >= first; y -= 1) {
    const line = reader.line(y);
    const c0 = charsAt(line, 0);
    if (!started) {
      if (isBlank(line, reader.cols)) continue;
      started = true;
    }
    if (c0 === RULE_CHAR || c0 === '' || c0 === ' ') {
      if (isRuleRow(rowText(line, reader.cols), reader.cols)) {
        if (lower !== null) {
          if (prompt === null) return null;
          const parts = [];
          for (let row = prompt; row < lower; row += 1) {
            const text = rowText(reader.line(row), reader.cols, 2, true);
            parts.push(text);
          }
          return { top: y, bottom: lower, promptRow: prompt, text: parts.join('\n') };
        }
        lower = y;
        continue;
      }
    }
    if (lower !== null && c0 === PROMPT_GLYPH) prompt = y;
  }
  return null;
}

/** Whether row `y` is a candidate's first row: not a soft wrap, `❯` then a space in cells 0 and 1. */
export function isCandidateRow(reader, y) {
  const line = reader.line(y);
  if (!line || line.isWrapped) return false;
  return charsAt(line, 0) === PROMPT_GLYPH && SPACES.has(charsAt(line, 1));
}

/**
 * A candidate's message text: row `y` from cell 2, and the rows after it up
 * to the first blank one (and before `end`), each without its two-space
 * indent; a soft-wrapped row whole.
 */
export function messageTextAt(reader, y, end) {
  return messageRows(reader, y, end).map((row) => row.text).join('\n');
}

function messageRows(reader, y, end) {
  const rows = [{ text: rowText(reader.line(y), reader.cols, 2), wrapped: false }];
  const stop = Math.min(end, y + 1 + MAX_MESSAGE_ROWS);
  for (let row = y + 1; row < stop; row += 1) {
    const line = reader.line(row);
    if (!line || isBlank(line, reader.cols)) break;
    if (line.isWrapped) {
      rows.push({ text: rowText(line, reader.cols), wrapped: true });
      continue;
    }
    if (!SPACES.has(charsAt(line, 0)) || !SPACES.has(charsAt(line, 1))) break;
    rows.push({ text: rowText(line, reader.cols, 2), wrapped: false });
  }
  return rows;
}

/**
 * A candidate's text (normalised) as it reads at the end of each of its rows,
 * a soft-wrapped row counted with the row it continues; shortest first, the
 * last the whole text (`messageTextAt`). A mark is made for the whole text and
 * kept while one of these still equals it — read over only as many rows as it
 * had then, so a row printed directly under the message later (an interrupt
 * notice) does not take it away (U-04). A soft wrap is no row end, so a
 * reflow moves none of them.
 */
export function messageTextsAt(reader, y, end) {
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
export function candidateRows(reader, from, to) {
  const rows = [];
  for (let y = Math.max(from, 0); y < Math.min(to, reader.length); y += 1) {
    if (isCandidateRow(reader, y)) rows.push(y);
  }
  return rows;
}

/** Whether a box's text (normalised) is a placeholder for what was really sent. */
export function isPlaceholderText(normalised) {
  return PLACEHOLDERS.some((p) => normalised.startsWith(p));
}

/**
 * Which pending submit, if any, the candidate on row `row` answers, by its
 * text: the index of the oldest text entry it equals, else of the oldest that
 * is a non-empty prefix of it (exact matches first, U-02); else -1. An entry
 * with a `from` row answers only candidates at or below it. An entry marked
 * `exact` (`scan` found a candidate that equals it) is not matched by a
 * prefix, so exact matches over all candidates come first (V-02). Positional
 * entries are not decided here.
 */
export function matchPending(pending, candidate, row = Infinity) {
  const open = (entry) => !entry.positional && Boolean(entry.text) && !(row < (entry.from ?? -Infinity));
  for (let i = 0; i < pending.length; i += 1) {
    if (open(pending[i]) && candidate === pending[i].text) return i;
  }
  for (let i = 0; i < pending.length; i += 1) {
    if (open(pending[i]) && !pending[i].exact && candidate.startsWith(pending[i].text)) return i;
  }
  return -1;
}

/**
 * How far above the box top read at Enter a submit's echo may be: Claude Code
 * draws it about one row above the box's `❯` row (AMM-02), so on the box top.
 */
export const ECHO_ROWS_ABOVE_BOX = 2;

/**
 * The marks of the messages sent to Claude Code in one terminal (`term`, an
 * xterm Terminal), oldest first.
 *
 *   - `noteShellSubmit()` on an Enter while no agent runs: the floor, below
 *     which a later Claude Code's rows are, goes to the row after it, so a
 *     shell prompt drawn as `❯ claude` (starship) is never a candidate.
 *   - `noteTyped()` on what the user types (`noteTerminalInput`);
 *     `noteSubmit()` on an Enter while Claude Code runs: the box is read now,
 *     before the key reaches it, and what it held is queued with the rows its
 *     echo can be on — at or below the box top less two (U-02).
 *   - `scan()` once Claude Code has drawn: marks what matches, drops what no
 *     longer does. Nothing on the alternate screen, and nothing without a box.
 *     A mark stays while its row reads as the text the mark was made for over
 *     as many rows as it had then (`messageTextsAt`, U-04). Only a mark that
 *     was lost (a scan dropped it as stale or at or below the box, or xterm
 *     erased, trimmed or cleared its row) is made again where a row reads as
 *     its text (a reprint): once for each loss, the lowest, newest such row
 *     first (V-01). A text sent before marks nothing by itself.
 *   - `afterClear()` after Terminal: Clear; `stop()` once Claude Code is not
 *     running any more (the marks stay); `setVisible`, `setColor`, `lines`,
 *     `previous`, `next` and `hit` as the shell marks have them.
 */
export function trackAgentMessageMarks(term, {
  limit = MAX_MESSAGE_MARKS,
  maxPending = MAX_PENDING,
  decorate = null,
  visible = true,
  color = null,
} = {}) {
  let marks = [];
  let pending = [];
  // The texts of the marks lost, each with how many times (V-01).
  let lost = new Map();
  let typed = false;
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
    if (typeof term?.registerMarker !== 'function') return null;
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

  // xterm disposed a mark's marker: its row was erased (ED, which a redraw
  // starts with), trimmed or cleared. Lost as well, so a reprint can take it
  // back; the tracker's own drops take a mark out of `marks` first.
  const forget = (marker) => {
    if (disposed) return;
    const mark = marks.find((m) => m.marker === marker);
    if (!mark) return;
    marks = marks.filter((m) => m !== mark);
    lose([mark]);
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

  // Pending submits, oldest first: what the box held, and the box top at
  // Enter (`bound`, a marker; `boundAt` without one) that their echo's row
  // is measured from.
  const keepPending = (next) => {
    for (const entry of pending) if (!next.includes(entry)) entry.bound?.dispose?.();
    pending = next;
  };
  // The first row an entry's echo can be on. A box top gone from the buffer
  // took every row above it along: what is left is all newer.
  const fromLine = (entry) => {
    if (!entry.bound) return entry.boundAt;
    return alive(entry.bound) ? entry.bound.line - ECHO_ROWS_ABOVE_BOX : 0;
  };
  // Marks lost, counted by their text: what a reprint may take back.
  const lose = (list) => {
    for (const mark of list) lost.set(mark.text, (lost.get(mark.text) ?? 0) + 1);
  };
  // What a reprint of a lost mark reads as, if anything.
  const lostText = (texts) => {
    for (let i = texts.length - 1; i >= 0; i -= 1) if (lost.get(texts[i]) > 0) return texts[i];
    return null;
  };
  const takeLost = (text) => {
    const left = (lost.get(text) ?? 0) - 1;
    if (left > 0) lost.set(text, left);
    else lost.delete(text);
  };

  return {
    noteShellSubmit() {
      if (disposed || alternate()) return;
      setFloor(1);
      keepPending([]);
      lost = new Map();
      typed = false;
    },
    noteTyped() {
      typed = true;
    },
    /** The box as it is now, queued for its echo; returns what was queued, or null. */
    noteSubmit() {
      const typedBefore = typed;
      typed = false;
      if (disposed || alternate()) return null;
      const box = findLiveInputBox(bufferReader(term, stats));
      if (!box) return null;
      const text = normaliseMessageText(box.text);
      let entry = null;
      if (text === '') {
        if (typedBefore) entry = { positional: true, text: '' };
      } else if (isPlaceholderText(text)) {
        entry = { positional: true, text: '' };
      } else {
        entry = { positional: false, text };
      }
      if (!entry) return null;
      const bound = markerAt(box.top);
      const queued = [...pending, { ...entry, bound, boundAt: box.top - ECHO_ROWS_ABOVE_BOX, from: 0 }];
      keepPending(queued.length > maxPending ? queued.slice(queued.length - maxPending) : queued);
      return entry;
    },
    scan() {
      if (disposed || alternate()) return false;
      stats.scans += 1;
      const reader = bufferReader(term, stats);
      const box = findLiveInputBox(reader);
      if (!box) return false;
      const top = box.top;
      // Never the live box: a mark at or below it goes (counted as lost).
      const below = marks.filter((m) => !alive(m.marker) || m.marker.line >= top);
      lose(below);
      dropAll(below);
      const start = Math.max(floorLine(), scanFromLine());
      // What was marked in the range and no longer reads as the text it was
      // made for goes (by the rule that made it: U-04), counted as lost.
      const stale = marks.filter((m) => {
        const line = m.marker.line;
        if (line < start || line >= top) return false;
        return !isCandidateRow(reader, line) || !messageTextsAt(reader, line, top).includes(m.text);
      });
      lose(stale);
      dropAll(stale);
      for (const entry of pending) entry.from = fromLine(entry);
      const marked = new Set(lines());
      const rows = [];
      for (const y of candidateRows(reader, start, top)) {
        if (marked.has(y)) continue;
        const texts = messageTextsAt(reader, y, top);
        const text = texts[texts.length - 1] ?? '';
        if (text) rows.push({ y, texts, text });
      }
      // Exact matches over all candidates before prefix matches (V-02): a
      // text entry that some candidate it can answer equals takes no prefix.
      for (const entry of pending) {
        entry.exact = !entry.positional && rows.some((r) => r.text === entry.text && !(r.y < entry.from));
      }
      // A lost mark, where its message is reprinted (a redraw, a
      // compaction): once for each loss, from the bottom up, so the newest
      // copy wins (V-01).
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const made = lostText(rows[i].texts);
        if (made === null || !add(rows[i].y, made)) continue;
        takeLost(made);
        marked.add(rows[i].y);
      }
      for (const { y, text } of rows) {
        if (marked.has(y)) continue;
        // A submit's own echo, by its text, at or below the rows it can be on
        // (U-02); the mark is made for its whole text as it reads now.
        let take = matchPending(pending, text, y);
        let made = take >= 0 ? text : null;
        // A submit without a text (a paste, an image): the first row below
        // both the rows its echo can be on and the newest mark.
        if (made === null) {
          const positional = pending.findIndex((p) => p.positional);
          if (positional >= 0 && y > pending[positional].from && y > newestLine()) {
            take = positional;
            made = text;
          }
        }
        if (made === null) continue;
        if (take >= 0) keepPending(pending.slice(take + 1));
        if (add(y, made)) marked.add(y);
      }
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
      lost = new Map();
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
      lost = new Map();
    },
  };
}

/**
 * When to scan (F10): `poke()` after a submit, and `parsed()` each time xterm
 * has parsed a write (its onWriteParsed). Nothing at all — no timer — while
 * `wanted()` is false (no Claude Code in that terminal, or the alternate
 * screen). Otherwise `scan()` runs once the output has been quiet for
 * `debounceMs`, or every `minIntervalMs` while it keeps coming, and never more
 * often than that.
 *
 * Only output counts (U-01): `wrote()` for each chunk of the shell's handed to
 * xterm, and `parsed()` asks for a scan only if one came since the last scan
 * began. A scan's own empty write (the registry's `afterOutputSoFar`) is
 * parsed too, and must not ask for the next: after the last output one more
 * scan runs, and then nothing until output or a submit comes. `now`,
 * `setTimer` and `clearTimer` are injectable for the suites.
 */
export function createScanScheduler({
  scan,
  wanted,
  debounceMs = SCAN_DEBOUNCE_MS,
  minIntervalMs = SCAN_MIN_INTERVAL_MS,
  maxWaitMs = SCAN_MIN_INTERVAL_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let lastPoke = -Infinity;
  let lastScan = -Infinity;
  let disposed = false;
  let written = 0;
  let seen = 0;

  const arm = (ms) => {
    timer = setTimer(fire, Math.max(1, Math.ceil(ms)));
  };

  function fire() {
    timer = null;
    if (disposed || !wanted()) return;
    const t = now();
    const quiet = t - lastPoke;
    const since = t - lastScan;
    // Quiet for the debounce, or output still coming for the longest wait;
    // never sooner than the interval after the last scan.
    if (since >= minIntervalMs && (quiet >= debounceMs || since >= maxWaitMs)) {
      lastScan = t;
      try {
        scan();
      } catch (err) {
        console.warn('[Terminal] could not look for sent messages:', err);
      }
      // Everything written so far was written ahead of the scan's own empty
      // write (held output included: the scan flushes it first), so it is read.
      seen = written;
      return;
    }
    arm(Math.max(minIntervalMs - since, Math.min(debounceMs - quiet, maxWaitMs - since)));
  }

  function poke() {
    if (disposed || !wanted()) return;
    lastPoke = now();
    if (timer === null) arm(debounceMs);
  }

  return {
    poke,
    wrote() {
      written += 1;
    },
    parsed() {
      if (written !== seen) poke();
    },
    get pending() {
      return timer !== null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * One `onData` of a terminal, for its message marks (the registry's
 * `noteMessageInput`): an Enter (`submits(data)`) while Claude Code runs
 * (`agentRuns()`) reads its box now, before Claude Code has the key
 * ('submit'); an Enter at a shell is the floor below which a later Claude
 * Code draws ('shell'); what the user types is noted ('typed'). Data that
 * starts with ESC is not typing (U-03): xterm's own reports (DA1, XTVERSION,
 * the kitty keyboard's), focus in and out, and the arrow and other escape
 * keys come through onData as well. Null for those and for nothing at all.
 */
export function noteTerminalInput(marks, data, { submits, agentRuns }) {
  if (!marks || typeof data !== 'string' || data === '') return null;
  if (!submits(data)) {
    if (data.charCodeAt(0) === 0x1b) return null;
    marks.noteTyped();
    return 'typed';
  }
  if (agentRuns()) {
    marks.noteSubmit();
    return 'submit';
  }
  marks.noteShellSubmit();
  return 'shell';
}

export default {
  MAX_MESSAGE_MARKS,
  MAX_PENDING,
  PROMPT_GLYPH,
  normaliseMessageText,
  isRuleRow,
  bufferReader,
  findLiveInputBox,
  isCandidateRow,
  messageTextAt,
  candidateRows,
  messageTextsAt,
  matchPending,
  trackAgentMessageMarks,
  createScanScheduler,
  noteTerminalInput,
};
