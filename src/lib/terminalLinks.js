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
 * thread, for a hover. With it a run is read once, from its start. A drive
 * letter may still follow a separator, for the verbatim `\\?\C:\…` Windows
 * tools print.
 */
const PATH_WITH_POSITION =
  /(?:(?<![\w.@~+-])[A-Za-z]:|(?<![\w.@~+\-\\/]))[\\/]?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z]\w{0,9}:\d+(?::\d+)?/g;

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

  // URLs first, so a path-shaped tail inside one cannot be claimed separately.
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = trimUrlTail(match[0]);
    if (!href) continue;
    found.push({ start: match.index, length: href.length, kind: 'url', text: href, href });
  }

  PYTHON_TRACEBACK.lastIndex = 0;
  let overlaps = overlapsAny(found);
  for (const match of text.matchAll(PYTHON_TRACEBACK)) {
    if (overlaps(match.index, match[0].length)) continue;
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
  overlaps = overlapsAny(found);
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
    if (!path || !Number.isFinite(line)) continue;
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
 * Returns null when there is nothing to resolve against, rather than guessing.
 */
export function resolveLinkPath(path, cwd) {
  if (typeof path !== 'string' || !path) return null;

  const windows = /^[A-Za-z]:[\\/]/.test(path) || (typeof cwd === 'string' && /^[A-Za-z]:[\\/]/.test(cwd));
  const sep = windows ? '\\' : '/';

  // Already absolute: a drive letter, or a leading separator.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return path;
  }
  if (typeof cwd !== 'string' || !cwd) return null;

  const base = cwd.replace(/[\\/]+$/, '');
  const cleaned = path.replace(/^\.[\\/]/, '');
  return `${base}${sep}${cleaned}`;
}

/**
 * Characters a link may run to: a path or URL longer than this is not
 * offered. It is also how far `linksAtRow` reads either side of the row it is
 * asked about, which is what lets it read so little — every link touching the
 * row that is no longer than this lies whole inside what was read.
 */
export const MAX_LINK_LENGTH = 2048;

/**
 * The links on one row of a terminal buffer, for xterm's link provider.
 *
 * xterm asks for ONE row at a time, but a terminal wraps: in an 80-column pane
 * `at Object.<anonymous> (/very/long/path/app.test.js:42:13)` is split across
 * two rows, and a provider that only saw one row would find no link in either.
 * So the rows wrapped onto this one are read with it — MAX_LINK_LENGTH
 * characters' worth either side, and no more. Reading the whole wrapped line,
 * as the provider used to, meant reading every row of a base64 blob or a
 * bundle printed without a newline, again each time the pointer crossed a row.
 *
 * `buffer` is xterm's (`length`, and `getLine(i)` giving `isWrapped` and
 * `translateToString`); `row` is the 1-based row xterm asks about. Returns the
 * links that touch that row: `findLinks`' fields plus `range`, in xterm's
 * terms — 1-based, and inclusive at both ends.
 */
export function linksAtRow(buffer, row) {
  const lineAt = (y) => (y >= 0 && y < buffer.length ? buffer.getLine(y) : undefined);
  const at = row - 1;
  const hovered = lineAt(at);
  if (!hovered) return [];

  // No trimming: a wrapped row is as wide as the terminal, and a link may run
  // across the edge between two of them. A row is wrapped when it carries on
  // the one above it.
  const rows = [{ y: at, text: hovered.translateToString(false) }];
  let reach = 0;
  for (let y = at, line = hovered; reach < MAX_LINK_LENGTH && line.isWrapped; ) {
    y -= 1;
    line = lineAt(y);
    if (!line) break;
    rows.unshift({ y, text: line.translateToString(false) });
    reach += rows[0].text.length;
  }
  const hoveredIndex = rows.length - 1;
  reach = 0;
  for (let y = at + 1, line = lineAt(y); reach < MAX_LINK_LENGTH && line?.isWrapped; line = lineAt(++y)) {
    rows.push({ y, text: line.translateToString(false) });
    reach += rows[rows.length - 1].text.length;
  }

  // Where each row starts in the joined text, so an offset maps back to a
  // row and a column.
  const starts = [];
  let text = '';
  for (const r of rows) {
    starts.push(text.length);
    text += r.text;
  }
  const from = starts[hoveredIndex];
  const to = from + rows[hoveredIndex].text.length;
  const positionOf = (offset) => {
    let k = starts.length - 1;
    while (k > 0 && starts[k] > offset) k -= 1;
    return { x: offset - starts[k] + 1, y: rows[k].y + 1 };
  };

  // A link cut off by either end of what was read is longer than
  // MAX_LINK_LENGTH if it reaches this row, so the length check is also what
  // keeps a cut-off piece from being offered as if it were the whole.
  return findLinks(text)
    .filter((link) => link.length <= MAX_LINK_LENGTH && link.start < to && link.start + link.length > from)
    .map((link) => ({
      ...link,
      range: {
        start: positionOf(link.start),
        end: positionOf(link.start + link.length - 1),
      },
    }));
}

export default { findLinks, resolveLinkPath, linksAtRow };
