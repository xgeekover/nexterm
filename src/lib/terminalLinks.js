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
 */
const PATH_WITH_POSITION =
  /(?:[A-Za-z]:)?(?:[\\/])?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z]\w{0,9}:\d+(?::\d+)?/g;

/**
 * Python's traceback shape, which names the same thing in a different order:
 * `File "src/app.py", line 42`. Common enough to be worth its own pattern.
 */
const PYTHON_TRACEBACK = /File "([^"]+)", line (\d+)/g;

/** http/https only. No `file:`, no `javascript:`, nothing that runs. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`|]+/g;

/** Trailing punctuation a URL picks up from the prose around it. */
function trimUrlTail(url) {
  let end = url.length;
  while (end > 0 && '.,;:!?)]}\''.includes(url[end - 1])) {
    // A closing bracket that the URL itself opened is part of it
    // (Wikipedia-style links), so only drop unbalanced ones.
    const ch = url[end - 1];
    const open = ch === ')' ? '(' : ch === ']' ? '[' : ch === '}' ? '{' : null;
    if (open) {
      const opens = url.slice(0, end).split(open).length - 1;
      const closes = url.slice(0, end).split(ch).length - 1;
      if (opens >= closes) break;
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
 */
function overlaps(start, length, taken) {
  const end = start + length;
  return taken.some((t) => start < t.start + t.length && end > t.start);
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
  for (const match of text.matchAll(PYTHON_TRACEBACK)) {
    if (overlaps(match.index, match[0].length, found)) continue;
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
  for (const match of text.matchAll(PATH_WITH_POSITION)) {
    if (overlaps(match.index, match[0].length, found)) continue;
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

export default { findLinks, resolveLinkPath };
