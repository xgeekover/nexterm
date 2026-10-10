/**
 * The clickable things in a line of terminal output.
 *
 * A stack trace names a file and a line. A compiler names a file and a line.
 * A failing test names a file and a line. NexTerm has that file's editor in
 * the same window and, until now, made you retype the path to reach it — which
 * is most of the reason to put a terminal and an editor in one window at all.
 *
 * Two rules keep this from becoming a false-positive machine:
 *
 *   1. **A line number is required.** `src/foo.js` on its own is a word that
 *      happens to contain a slash; `src/foo.js:12` is somewhere to go. It also
 *      means a click always has a place to land, rather than opening a file at
 *      the top and leaving you to search.
 *   2. **A file extension is required.** Without it every `usr/bin:1` in a
 *      printed `$PATH` becomes a link.
 *
 * Both separators are matched everywhere, because the output of a tool running
 * under cmd.exe says `src\foo.js:12` and the output of git in the same window
 * says `src/foo.js:12`. This is the file that gets Windows wrong if anything
 * does — see paths.js for why that keeps happening.
 *
 * Pure: no React, no stores, no DOM, no filesystem. Whether the file exists is
 * the caller's problem, and deliberately so — the link provider runs on every
 * rendered line and must not touch the disk.
 */
import { withoutVerbatimPrefix } from './terminalCompat.js';

/**
 * path:line[:column]
 *
 * The path may be absolute (`/a/b.rs`, `C:\a\b.rs`), relative (`src/b.rs`) or
 * explicitly relative (`./src/b.rs`, `..\src\b.rs`). Segments allow the
 * characters real project paths use and stop at whitespace, quotes and the
 * punctuation that surrounds a path in prose — `(`, `)`, `,`, `<`, `>`.
 *
 * A match only starts where a path can: never straight after a character
 * paths are made of. Without that rule the engine, having failed at the start
 * of a long run of such characters, tried again one character in, and again,
 * each try reading to the end of the run before failing — 1.5 s for 32,000
 * characters of `a.a.a…` and 3 s for 131,000 of base64, measured, on the UI
 * thread, for a hover. With it a run is read once, from its start. It also
 * keeps the second slash of `//host/share/x.py:1` from being a start, which
 * read a network path as a local `/host/share/x.py`. A drive letter may still
 * follow a separator, for the verbatim `\\?\C:\…` Windows tools print.
 *
 * The one place a path may start right after a slash is a `file://` URI's
 * own: `at file:///Users/me/a.mjs:12:7` is how Node prints an ES module's
 * stack frame, and Deno and tsx print the same — the path starts at the
 * third slash. Only a third slash: `file:////host/share` and
 * `file://host/share` name another machine and are not offered.
 */
const PATH_WITH_POSITION =
  /(?:(?<![\w.@~+-])[A-Za-z]:|(?<![\w.@~+\-\\/])|(?<=file:\/\/)(?=\/[^\\/]))[\\/]?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z]\w{0,9}:\d+(?::\d+)?/g;

/**
 * Python's traceback shape, which names the same thing in a different order:
 * `File "src/app.py", line 42`. Common enough to be worth its own pattern.
 */
const PYTHON_TRACEBACK = /File "([^"]+)", line (\d+)/g;

/** http/https only. No `file:`, no `javascript:`, nothing that runs. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`|]+/g;

/** Trailing punctuation a URL picks up from the prose around it. */
function trimUrlTail(url) {
  // How many of each bracket the URL opened and did not close, counted once
  // and kept up to date as the tail shrinks. Counting again for every
  // character dropped made a URL followed by a long run of `)` quadratic.
  const count = (ch) => url.split(ch).length - 1;
  const unclosed = {
    ')': count('(') - count(')'),
    ']': count('[') - count(']'),
    '}': count('{') - count('}'),
  };
  let end = url.length;
  while (end > 0 && '.,;:!?)]}\''.includes(url[end - 1])) {
    // A closing bracket that the URL itself opened is part of it
    // (Wikipedia-style links), so only drop unbalanced ones.
    const ch = url[end - 1];
    if (ch in unclosed) {
      if (unclosed[ch] >= 0) break;
      unclosed[ch] += 1;
    }
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Does `path` name another machine?
 *
 * Two separators first, of either kind — `\\host\share\x.py`, `//host/share/x.py`
 * — is a network path, and Windows opens one by connecting to the host and
 * signing in to it with the user's credentials, before anything has the
 * chance to refuse the read: the backend's `canonicalize` does exactly that on
 * its way to saying no. What a terminal prints is not trusted — any program,
 * any file `cat`ed, any agent can print a path — so a link to another machine
 * is never offered and never resolved. The device namespaces go with it
 * (`\\.\`, and `\??\`, which reaches the same shares by another name); only
 * the verbatim spelling of a local drive, `\\?\C:\…`, is a local path.
 */
export function isNetworkPath(path) {
  if (typeof path !== 'string') return false;
  return /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(withoutVerbatimPrefix(path));
}

/**
 * Is this match sitting inside a URL that was already matched?
 *
 * `https://host:8080/app.js:3` contains something shaped exactly like a
 * path:line, and turning half a URL into a file link would be worse than
 * leaving it alone.
 *
 * Returns the check for one pass over the text. A pass meets its matches in
 * order and the ranges taken before it never overlap one another, so each
 * check only ever steps forward: checking every taken range for every match
 * made a line of a few thousand short links quadratic.
 */
function overlapsAny(taken) {
  const ranges = [...taken].sort((a, b) => a.start - b.start);
  let i = 0;
  return (start, length) => {
    while (i < ranges.length && ranges[i].start + ranges[i].length <= start) i += 1;
    return i < ranges.length && ranges[i].start < start + length;
  };
}

/**
 * Every link in one line of text, in the order they appear.
 *
 * Each is `{ start, length, kind, text }` plus, for a path, `path`, `line` and
 * `column`, and for a url, `href`. `start` is a 0-based index into `text`;
 * callers working with xterm's 1-based columns add one.
 */
export function findLinks(text) {
  if (typeof text !== 'string' || !text) return [];

  const found = [];
  // Everything matched, offered or not: a path refused for naming another
  // machine must not have a piece of it claimed as some other link instead.
  const taken = [];

  // URLs first, so a path-shaped tail inside one cannot be claimed separately.
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = trimUrlTail(match[0]);
    if (!href) continue;
    const link = { start: match.index, length: href.length, kind: 'url', text: href, href };
    found.push(link);
    taken.push(link);
  }

  PYTHON_TRACEBACK.lastIndex = 0;
  let overlaps = overlapsAny(taken);
  for (const match of text.matchAll(PYTHON_TRACEBACK)) {
    if (overlaps(match.index, match[0].length)) continue;
    taken.push({ start: match.index, length: match[0].length });
    if (isNetworkPath(match[1])) continue;
    found.push({
      start: match.index,
      length: match[0].length,
      kind: 'path',
      text: match[0],
      path: match[1],
      line: Number(match[2]),
      column: null,
    });
  }

  PATH_WITH_POSITION.lastIndex = 0;
  overlaps = overlapsAny(taken);
  for (const match of text.matchAll(PATH_WITH_POSITION)) {
    if (overlaps(match.index, match[0].length)) continue;
    const parts = match[0].split(':');
    // A Windows path carries its own colon (`C:\a\b.rs:10:5`), so the position
    // is always read from the END rather than by counting from the front.
    const column = parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])
      ? Number(parts.pop())
      : null;
    const line = Number(parts.pop());
    const path = parts.join(':');
    if (!path || !Number.isFinite(line) || isNetworkPath(path)) continue;
    found.push({
      start: match.index,
      length: match[0].length,
      kind: 'path',
      text: match[0],
      path,
      line,
      column,
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Where a link's path actually points, given where the command ran.
 *
 * Relative paths are resolved against `cwd` — the shell's live directory, not
 * the workspace root — because that is what the tool printing them meant. A
 * `cargo` run inside `src-tauri/` prints `src/main.rs`, and resolving that
 * against the workspace root opens the wrong file, or nothing at all.
 *
 * Returns null when there is nothing to resolve against, rather than guessing,
 * and when the answer is on another machine (`isNetworkPath`) — whether the
 * link named one or the cwd is one. The cwd is no safer than the link: the
 * shell reports it with OSC 7, and anything printed can print an OSC 7.
 */
export function resolveLinkPath(path, cwd) {
  if (typeof path !== 'string' || !path) return null;
  const target = withoutVerbatimPrefix(path);
  const dir = typeof cwd === 'string' ? withoutVerbatimPrefix(cwd) : null;

  const windows = /^[A-Za-z]:[\\/]/.test(target) || (typeof dir === 'string' && /^[A-Za-z]:[\\/]/.test(dir));
  const sep = windows ? '\\' : '/';

  // Already absolute: a drive letter, or a leading separator.
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\')) {
    return isNetworkPath(target) ? null : target;
  }
  if (typeof dir !== 'string' || !dir) return null;

  const base = dir.replace(/[\\/]+$/, '');
  const cleaned = target.replace(/^\.[\\/]/, '');
  const resolved = `${base}${sep}${cleaned}`;
  return isNetworkPath(resolved) ? null : resolved;
}

/**
 * Characters a link may run to: a path or URL longer than this is not
 * offered. It is also how far `linksAtRow` reads either side of the row it is
 * asked about, which is what lets it read so little — every link touching the
 * row that is no longer than this lies whole inside what was read.
 */
export const MAX_LINK_LENGTH = 2048;

/**
 * One row of a terminal buffer as text, with the cell each character of it
 * is drawn in.
 *
 * `translateToString` gives the text and loses the cells: a wide character —
 * Hangul, CJK, most emoji — is ONE character of the string drawn over TWO
 * cells, so every one of them before a link moved the link a cell to the
 * left. Korean `dir` output starts every line with `오후`, and a `path:line`
 * after it was underlined two cells early, its last two characters left out.
 * So the row is read cell by cell, as xterm reads it for `translateToString`:
 * a cell's characters (an empty cell is a space), and on to the cell after
 * its width — the right half of a wide character adds nothing. The text is
 * the same string `translateToString(false)` gives.
 *
 * `line` is xterm's IBufferLine (`length`, `getCell(x, cell)` with
 * `getChars()` and `getWidth()`). Returns `{ text, cells, firstWide,
 * lastEmpty }`: `cells[i]` is the 0-based column of the cell holding
 * `text[i]` — both halves of a surrogate pair, and a mark combined into a
 * cell, share it — and `cells[text.length]` is the column after the last
 * cell read. So the characters `[a, b)` are drawn from column `cells[a]` to
 * `cells[b] - 1`, whatever is wide among them. `firstWide` is whether the
 * row starts with a wide character, `lastEmpty` whether its last cell holds
 * nothing at all (not even a space) — see `readAroundRow`.
 */
export function rowCells(line) {
  const cells = [];
  let text = '';
  let cell;
  let x = 0;
  let firstWide = false;
  let lastEmpty = false;
  while (x < line.length) {
    // One cell object, loaded again for each column: xterm's advice for a
    // loop over every cell of a line.
    cell = line.getCell(x, cell);
    if (!cell) break;
    const raw = cell.getChars();
    const chars = raw || ' ';
    const width = cell.getWidth();
    if (x === 0) firstWide = width === 2;
    lastEmpty = raw === '';
    for (let i = 0; i < chars.length; i += 1) cells.push(x);
    text += chars;
    // At least one: the right half of a wide character is skipped by the
    // width of its left, and anything else of no width still is a cell.
    x += width || 1;
  }
  cells.push(x);
  return { text, cells, firstWide, lastEmpty };
}

/**
 * `row` without the empty cell xterm leaves at the end of a row when the
 * wide character after it did not fit, and went to the next row instead.
 * Read as a space, it split a name in two at the edge: `ab보고서.txt` in five
 * columns read `ab보 고서.txt`. Only that cell, only then: the next row,
 * which carries this one on, starts with a wide character, and this one ends
 * in a cell nothing was ever written to.
 */
function withoutWidePad(row, next) {
  if (!next?.firstWide || !row.lastEmpty || !row.text) return row;
  const cells = row.cells.slice(0, row.text.length - 1);
  cells.push(row.cells[row.text.length - 1]);
  return { ...row, text: row.text.slice(0, -1), cells };
}

/**
 * The rows wrapped together with `row`, read as one text — `reach`
 * characters' worth either side of it, and no more.
 *
 * xterm asks for ONE row at a time, but a terminal wraps: in an 80-column pane
 * `at Object.<anonymous> (/very/long/path/app.test.js:42:13)` is split across
 * two rows, and a provider that only saw one row would find no link in either.
 * Reading the whole wrapped line, as the provider used to, meant reading every
 * row of a base64 blob or a bundle printed without a newline, again each time
 * the pointer crossed a row.
 *
 * Returns null past either end of the buffer, else `{ text, from, to,
 * rangeOf }`: the row asked about is `text.slice(from, to)`, and
 * `rangeOf(start, end)` is where the characters `[start, end)` are drawn, in
 * xterm's terms — 1-based, inclusive at both ends, and by cell (`rowCells`),
 * so a wide character before them moves nothing and a wide one at their end
 * is covered whole.
 */
export function readAroundRow(buffer, row, reach) {
  const lineAt = (y) => (y >= 0 && y < buffer.length ? buffer.getLine(y) : undefined);
  const at = row - 1;
  const hovered = lineAt(at);
  if (!hovered) return null;

  // No trimming: a wrapped row is as wide as the terminal, and a link may run
  // across the edge between two of them. A row is wrapped when it carries on
  // the one above it.
  const rows = [{ y: at, ...rowCells(hovered) }];
  let read = 0;
  for (let y = at, line = hovered; read < reach && line.isWrapped; ) {
    y -= 1;
    line = lineAt(y);
    if (!line) break;
    rows.unshift({ y, ...rowCells(line) });
    read += rows[0].text.length;
  }
  const hoveredIndex = rows.length - 1;
  read = 0;
  for (let y = at + 1, line = lineAt(y); read < reach && line?.isWrapped; line = lineAt(++y)) {
    rows.push({ y, ...rowCells(line) });
    read += rows[rows.length - 1].text.length;
  }

  // A wide character that did not fit at the end of a row left that row's
  // last cell empty; it is no character of the line.
  for (let k = 0; k + 1 < rows.length; k += 1) rows[k] = withoutWidePad(rows[k], rows[k + 1]);

  // Where each row starts in the joined text, so an offset maps back to a
  // row and a cell.
  const starts = [];
  let text = '';
  for (const r of rows) {
    starts.push(text.length);
    text += r.text;
  }
  const from = starts[hoveredIndex];
  const to = from + rows[hoveredIndex].text.length;
  // The row holding the character at `offset`.
  const rowOf = (offset) => {
    let k = starts.length - 1;
    while (k > 0 && starts[k] > offset) k -= 1;
    return k;
  };
  const rangeOf = (start, end) => {
    const first = rowOf(start);
    const last = rowOf(end - 1);
    return {
      start: { x: rows[first].cells[start - starts[first]] + 1, y: rows[first].y + 1 },
      // The column after the last character's cells, 0-based, is the last of
      // them 1-based.
      end: { x: rows[last].cells[end - starts[last]], y: rows[last].y + 1 },
    };
  };
  return { text, from, to, rangeOf };
}

/**
 * The links on one row of a terminal buffer, for xterm's link provider.
 *
 * The rows wrapped onto this one are read with it (`readAroundRow`),
 * MAX_LINK_LENGTH characters' worth either side.
 *
 * `buffer` is xterm's (`length`, and `getLine(i)` giving `isWrapped`,
 * `length` and `getCell`); `row` is the 1-based row xterm asks about. Returns
 * the links that touch that row: `findLinks`' fields plus `range`, in xterm's
 * terms — 1-based, inclusive at both ends, and counted in cells.
 */
export function linksAtRow(buffer, row) {
  const read = readAroundRow(buffer, row, MAX_LINK_LENGTH);
  if (!read) return [];
  const { text, from, to, rangeOf } = read;

  // A link cut off by either end of what was read is longer than
  // MAX_LINK_LENGTH if it reaches this row, so the length check is also what
  // keeps a cut-off piece from being offered as if it were the whole.
  return findLinks(text)
    .filter((link) => link.length <= MAX_LINK_LENGTH && link.start < to && link.start + link.length > from)
    .map((link) => ({ ...link, range: rangeOf(link.start, link.start + link.length) }));
}

export default { findLinks, resolveLinkPath, isNetworkPath, linksAtRow, rowCells, readAroundRow };
