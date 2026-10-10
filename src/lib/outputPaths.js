/**
 * The file and folder names in a terminal's output that a Cmd/Ctrl+click can
 * show in the file manager — Warp's Cmd+click on `ls` output, and VS Code's.
 *
 * `ls`, `ls -l`, `ls -F`, `dir`, `find`, `git status`, `tree` all print names
 * that exist, but none of them marks which words those are: a name is a word,
 * a word is a name. So nothing here decides that a word IS a path. It finds
 * the stretches that could be one — every whitespace-separated token, and
 * runs of tokens joined by single spaces, for names like `My Folder`,
 * `새 폴더 - 복사본` and `Tom & Jerry` — and the backend says which of them
 * exist (`fs_path_kinds`). Only those are offered; where two that exist
 * overlap, the longer.
 *
 * What it must never do: offer a path on another machine (`resolveLinkPath`
 * and the backend both refuse one — looking at it is what signs in to it),
 * take over the clicks that are already links (`findLinks`: URLs and
 * `path:line`), or change anything for a click without the modifier.
 *
 * Pure: no React, no stores, no DOM, no IPC. The kind lookup is handed the
 * function that asks (`createKindLookup`), so it is tested with a stand-in.
 * Which directory a name is read against — the tab's, a listing's header, a
 * command's argument — is src/lib/outputContext.js.
 */
import { MAX_LINK_LENGTH, findLinks, readAroundRow, resolveLinkPath } from './terminalLinks.js';

/**
 * Candidates offered for one row at most. Asked about in calls of
 * MAX_KIND_PATHS, so a row costs a few calls at most — and only while the
 * modifier is held (src/lib/revealLinks.js).
 */
export const MAX_CANDIDATES = 192;

/** Characters a candidate may run to. A token longer than this is not a name anyone types. */
export const MAX_CANDIDATE_LENGTH = 1024;

/** Paths `fs_path_kinds` answers in one call; it refuses more (src-tauri/src/fs/reveal.rs). */
export const MAX_KIND_PATHS = 64;

/** How long a kind is trusted: long enough for a pointer passing over a listing, short enough for `mkdir` then `ls`. */
export const KIND_TTL_MS = 5000;

/** Kinds remembered at most, oldest dropped first. */
export const KIND_CACHE_SIZE = 1024;

/**
 * Tokens in a name with spaces at most: `Microsoft Visual Studio 2022
 * Preview` is five, `새 텍스트 문서 - 복사본.txt` five.
 */
const MAX_RUN_TOKENS = 8;

// ---------------------------------------------------------------------------
// What a token is, when it is not a word.

/** `drwxr-xr-x`, `-rw-r--r--@` (macOS: extended attributes), `.` (SELinux), `+` (ACL). */
const PERMISSIONS = /^[-bcdlpsD?][-rwxsStTlL]{9}[.@+]?$/;
/** PowerShell's Mode column: `d----`, `-a---`, `la---`. */
const POWERSHELL_MODE = /^[-dl][-a][-r][-h][-s][-l]?$/;
/** What `dir` prints in place of a size. */
const DIR_TAG = /^<(?:DIR|JUNCTION|SYMLINKD?|MOUNTED)>$/i;
const INTEGER = /^\d+$/;
/** `1,234` (dir), `1.234` (dir in a German locale), `1'234` (Swiss). */
const GROUPED_NUMBER = /^\d{1,3}(?:[,.']\d{3})+$/;
/** `4.0K`, `4K`, `12M`, `1,5G`, `512B`, `3KiB` — `ls -h`, `du -h`. */
const SIZE = /^\d+(?:[.,]\d+)?(?:[KMGTPE](?:i?B)?|B)$/i;
/**
 * `2026-10-09` (ISO, Korean dir), `10/09/2026` (US dir), `09.10.2026`,
 * `2026/10/09`, `2026.10.09.` — a dotted one only with its four-digit year,
 * so a version folder (`3.12.10`, pyenv's) is a word.
 */
const DATE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\.?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}\.\d{1,2}\.\d{4})$/;
/** `22:00`, `22:00:01`, `22:00:01.123456789` (ls --full-time), `10:00p` (old dir). */
const TIME = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[ap]m?)?$/i;
const AM_PM = /^(?:AM|PM|오전|오후|午前|午後|上午|下午)$/i;
/** `+0900`, from `ls --full-time`. */
const ZONE = /^[+-]\d{4}$/;
/** `10월`, `9일` — GNU ls under a Korean locale. */
const KOREAN_DATE = /^\d{1,2}[월일]$/;
const TOTAL = /^(?:total|합계)$/i;
const MONTH = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/;
/** A token with no letter and no digit in it: `->`, `|`, `├──`, `-`, `&`. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** `.` and `..`, which `ls -a` lists and which are folders. */
const DOTS = /^\.\.?$/;

/**
 * A column only a long listing has — `ls -l`'s permissions and time, `dir`'s
 * time and `<DIR>`, PowerShell's Mode — so the row it is on is one, and its
 * name is its last column.
 */
const isListingColumn = (word) =>
  PERMISSIONS.test(word) || POWERSHELL_MODE.test(word) || DIR_TAG.test(word) || TIME.test(word);

/**
 * 'word', 'data' or 'structural'.
 *
 * Structural is a column of a listing that never names a file on its own: a
 * permission string, `<DIR>`, a time, an arrow, a dash. Data is a column that
 * could also be a whole name — a number, a size, a date, a month, `오후`,
 * `total` — and a folder may well be called `2026-10-09`, `10월`, `4K` or
 * `42`. Everything else is a word.
 *
 * None of them ends a name: `새 폴더 - 복사본`, `Tom & Jerry` and
 * `10월 보고서.xlsx` hold such tokens. What counts is the candidate as a whole
 * (`pathCandidates`).
 */
function tokenClass(word) {
  if (!word) return 'structural';
  if (
    !HAS_LETTER_OR_DIGIT.test(word) ||
    PERMISSIONS.test(word) ||
    POWERSHELL_MODE.test(word) ||
    DIR_TAG.test(word) ||
    TIME.test(word) ||
    ZONE.test(word)
  ) {
    return 'structural';
  }
  if (
    INTEGER.test(word) ||
    GROUPED_NUMBER.test(word) ||
    SIZE.test(word) ||
    DATE.test(word) ||
    KOREAN_DATE.test(word) ||
    MONTH.test(word) ||
    AM_PM.test(word) ||
    TOTAL.test(word)
  ) {
    return 'data';
  }
  return 'word';
}

const QUOTES = '\'"`';
const LS_F_MARKERS = '/*@|=';
const PROSE_TAIL = ':,;';
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const OPENERS = { '(': ')', '[': ']', '{': '}' };

/**
 * The part of `text[s, e)` that names something once the punctuation around
 * a name in prose and in listings is left out, as `[s, e]` again.
 *
 *   - a trailing `:` `,` `;` (`ls -R` headings say `./src:`) and one trailing
 *     `.` — the end of a sentence; `..` keeps its dots;
 *   - a bracket the word closes or opens without the other: `(see a.txt)`;
 *   - one `ls -F` marker — `/` folder, `*` executable, `@` link, `|` FIFO,
 *     `=` socket. GNU ls puts it after the quotes: `'My Folder'/`;
 *   - the quotes GNU ls puts round a name with a space in it (`'My Folder'`,
 *     `"it's"`) and the backticks Markdown puts round a path.
 *
 * The word as written is always a candidate as well (`pathCandidates`), so
 * a name that really ends in one of these — `trail.`, `star*`, `[backup]` —
 * is found as it is.
 */
function trimName(text, s, e) {
  const stripProse = () => {
    while (e > s && PROSE_TAIL.includes(text[e - 1])) e -= 1;
    if (e - s > 1 && text[e - 1] === '.' && text[e - 2] !== '.') e -= 1;
  };
  stripProse();
  // How many of each bracket the word holds, counted once and kept up to
  // date as it shrinks: counting again for each one dropped made a run of
  // `(((…` quadratic.
  const brackets = {};
  for (let i = s; i < e; i += 1) {
    if (text[i] in CLOSERS || text[i] in OPENERS) brackets[text[i]] = (brackets[text[i]] ?? 0) + 1;
  }
  const unmatched = (ch, other) => (brackets[ch] ?? 0) > (brackets[other] ?? 0);
  while (e > s && text[e - 1] in CLOSERS && unmatched(text[e - 1], CLOSERS[text[e - 1]])) {
    brackets[text[e - 1]] -= 1;
    e -= 1;
  }
  while (e > s && text[s] in OPENERS && unmatched(text[s], OPENERS[text[s]])) {
    brackets[text[s]] -= 1;
    s += 1;
  }
  stripProse();
  let marked = false;
  const stripMarker = () => {
    if (!marked && e - s > 1 && LS_F_MARKERS.includes(text[e - 1])) {
      e -= 1;
      marked = true;
    }
  };
  stripMarker();
  if (e > s && QUOTES.includes(text[e - 1])) e -= 1;
  if (e > s && QUOTES.includes(text[s])) s += 1;
  stripMarker();
  return [s, e];
}

/** UTF-8 bytes and text, joined and read back as UTF-8; null when they are not. */
function utf8(parts) {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : Uint8Array.from(part)));
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const C_ESCAPES = { a: '\u{7}', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', e: '\u{1B}', '\\': '\\', '"': '"', "'": "'", '?': '?' };

/**
 * The backslash escape at `text[i]` (just after the backslash) in a C-style
 * string — git's quoting, and the `$'…'` of bash and GNU ls: `\NNN` octal
 * and `\xHH` as bytes, `\n` `\t` `\\` `\"` … as characters. Returns
 * `[part, next index]`.
 */
function cEscape(text, i) {
  const octal = /^[0-7]{1,3}/.exec(text.slice(i, i + 3));
  if (octal) return [[parseInt(octal[0], 8) & 0xff], i + octal[0].length];
  if (text[i] === 'x') {
    const hex = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(i + 1, i + 3));
    if (hex) return [[parseInt(hex[0], 16)], i + 1 + hex[0].length];
  }
  return [C_ESCAPES[text[i]] ?? text[i], i + 1];
}

/**
 * A name as GNU `ls` quotes it on a terminal (`--quoting-style=shell-escape`):
 * `'My Folder'`, `"it's"`, `'it'\''s a.txt'`, `'a'$'\n''b'` — quoted pieces
 * and backslash escapes run together. Null when `text` is not one name so
 * quoted: no quote in it, one left open, or a space outside the quotes,
 * which separates two names.
 */
export function decodeShellQuoted(text) {
  const parts = [];
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      parts.push(text.slice(i + 1, end));
      quoted = true;
      i = end + 1;
    } else if (ch === '$' && text[i + 1] === "'") {
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) {
          const [part, next] = cEscape(text, i + 1);
          parts.push(part);
          i = next;
        } else {
          parts.push(text[i]);
          i += 1;
        }
      }
      if (i >= text.length) return null;
      quoted = true;
      i += 1;
    } else if (ch === '"') {
      i += 1;
      let piece = '';
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) i += 1;
        piece += text[i];
        i += 1;
      }
      if (i >= text.length) return null;
      parts.push(piece);
      quoted = true;
      i += 1;
    } else if (ch === '\\' && i + 1 < text.length) {
      parts.push(text[i + 1]);
      i += 2;
    } else if (/\s/.test(ch)) {
      return null;
    } else {
      parts.push(ch);
      i += 1;
    }
  }
  return quoted ? utf8(parts) : null;
}

/**
 * A path as git prints one it had to quote (`core.quotePath`, the default):
 * `"\355\225\234.txt"` for `한.txt`, octal escapes being the name's UTF-8
 * bytes. Null for anything else — no backslash escape in it, or not one
 * double-quoted string.
 */
export function decodeCQuoted(text) {
  if (text.length < 3 || text[0] !== '"' || text[text.length - 1] !== '"' || !text.includes('\\')) return null;
  const parts = [];
  let i = 1;
  const end = text.length - 1;
  while (i < end) {
    if (text[i] === '"') return null;
    if (text[i] === '\\') {
      if (i + 1 >= end) return null;
      const [part, next] = cEscape(text, i + 1);
      parts.push(part);
      i = next;
    } else {
      parts.push(text[i]);
      i += 1;
    }
  }
  return utf8(parts);
}

/**
 * Every stretch of `text` that might name a file or a folder, as
 * `[{ start, length, text, drawn, tail }]`: `drawn` is
 * `text.slice(start, start + length)` as it is on screen, `text` what it
 * names — the same, or with quotes, markers and prose punctuation left out,
 * or decoded from GNU's or git's quoting — and `tail` whether it ends where
 * its column does.
 *
 *   - Columns first: a row is cut into segments at every gap of two spaces
 *     or more, or a tab — how `ls`, `dir` and `ls -l` separate columns. No
 *     candidate crosses one, so `two  spaces.txt` cannot be found, and the
 *     columns of a listing never run together.
 *   - Within a segment, every run of 1 to 8 tokens. In a long listing's row
 *     (`isListingColumn`), only in its last segment, where the name is.
 *   - A run is dropped only when it is nothing but columns as a whole: when
 *     no token of it is a word, it must be all data (`tokenClass`) AND end
 *     where its segment does — that is where a listing puts the name, so a
 *     folder called `2026-10-09` or `4K` is found, and a `4096` size column
 *     followed by a date is not asked about.
 *   - Each run gives the stretch as written, the stretch trimmed
 *     (`trimName`), the name inside `[…]` (Next.js's `[slug]` is found as
 *     written; `dir`'s `[C:\target]` as the target), and the name GNU's or
 *     git's quoting spells (`decodeShellQuoted`, `decodeCQuoted`).
 *
 * Overlapping stretches are all returned — `My`, `Folder` and `My Folder`,
 * `[backup]` and `backup` — and which of them is offered is decided once the
 * backend has said which exist (`chooseLinks`: the longest). With `from` and
 * `to`, only those touching `text[from, to)`.
 */
export function pathCandidates(text, { from = 0, to = Infinity } = {}) {
  if (typeof text !== 'string' || !text) return [];
  // `ls -l`'s first line: a count of blocks, never a folder called `24`.
  if (/^\s*(?:total|합계)\s+[\d.,]+[KMGTPE]?\s*$/i.test(text)) return [];
  const tokens = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    // Too long to be a name, or part of one: not looked into.
    if (match[0].length > MAX_CANDIDATE_LENGTH) {
      tokens.push({ start, end, kind: 'structural', long: true });
      continue;
    }
    const [s, e] = trimName(text, start, end);
    const word = text.slice(s, e);
    tokens.push({ start, end, kind: tokenClass(word), listing: isListingColumn(word) });
  }
  // Segment of each token: a new one after any gap that is not one space.
  let segment = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (i > 0 && text.slice(tokens[i - 1].end, tokens[i].start) !== ' ') segment += 1;
    tokens[i].segment = segment;
  }
  // A long listing's row names one thing, in its last column: the owner,
  // the group (`root`, `staff`) and the date (`2026-10-09`) are no names
  // even where a folder happens to be called that.
  const listing = tokens.some((t) => t.listing);
  const lastSegment = segment;

  const found = [];
  const seen = new Set();
  const add = (s, e, name, tail) => {
    if (e <= s || e - s > MAX_CANDIDATE_LENGTH || !name) return;
    const key = `${s}:${e}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ start: s, length: e - s, text: name, drawn: text.slice(s, e), tail });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    // Only runs that touch `[from, to)`: the row asked about.
    if (tokens[i].start >= to) break;
    if (tokens[i].long || (listing && tokens[i].segment !== lastSegment)) continue;
    let words = 0;
    let structural = 0;
    for (let n = 1; n <= MAX_RUN_TOKENS && i + n <= tokens.length; n += 1) {
      const last = tokens[i + n - 1];
      if (last.segment !== tokens[i].segment || last.long) break;
      if (last.kind === 'word') words += 1;
      if (last.kind === 'structural') structural += 1;
      const tail = i + n === tokens.length || tokens[i + n].segment !== last.segment;
      const s0 = tokens[i].start;
      const e0 = last.end;
      if (e0 - s0 > MAX_CANDIDATE_LENGTH) break;
      if (e0 <= from) continue;
      const allowed =
        words > 0 ||
        (structural === 0 && tail) ||
        // `ls -a` lists `.` and `..`, which are folders.
        (n === 1 && DOTS.test(trimmedText(text, s0, e0)));
      if (!allowed) continue;

      add(s0, e0, text.slice(s0, e0), tail);
      const [s, e] = trimName(text, s0, e0);
      add(s, e, text.slice(s, e), tail);
      if (e - s > 2 && text[s] === '[' && text[e - 1] === ']') add(s + 1, e - 1, text.slice(s + 1, e - 1), tail);

      // A quoted name: its quotes and escapes read as GNU ls and git write
      // them. Drawn whole, quotes and all — unless it reads the same as the
      // trimmed stretch, which already covers it without them.
      const [qs, qe] = quotedSpan(text, s0, e0);
      if (qe > qs && (text[qs] === "'" || text[qs] === '"' || text[qs] === '$')) {
        const spelled = text.slice(qs, qe);
        const trimmed = text.slice(s, e);
        for (const name of [decodeShellQuoted(spelled), decodeCQuoted(spelled)]) {
          if (name && name !== trimmed) add(qs, qe, name, tail);
        }
      }
    }
  }
  return found;
}

/** `text[s, e)` trimmed (`trimName`), as a string. */
function trimmedText(text, s, e) {
  const [a, b] = trimName(text, s, e);
  return text.slice(a, b);
}

/**
 * `text[s, e)` without what follows a closing quote in a listing or a
 * sentence: trailing `:` `,` `;`, and one `ls -F` marker right after the
 * quote (`'My Folder'/`).
 */
function quotedSpan(text, s, e) {
  while (e > s && PROSE_TAIL.includes(text[e - 1])) e -= 1;
  if (e - s > 1 && LS_F_MARKERS.includes(text[e - 1]) && QUOTES.includes(text[e - 2])) e -= 1;
  return [s, e];
}

/**
 * The candidates touching one row of a terminal buffer, for xterm's link
 * provider: `pathCandidates`' fields plus `range`, in xterm's terms (1-based,
 * inclusive, counted in cells — see `readAroundRow`).
 *
 * The rows wrapped onto this one are read with it, as `linksAtRow` reads
 * them, so `My Folder` split over the edge of two rows is still one name.
 * Left out: anything overlapping a link `findLinks` gives — a URL or a
 * `path:line` is already a link, with its own click. At most MAX_CANDIDATES:
 * those that end where their column does first (where a listing puts its
 * names), then the ones nearest the middle of the row, then the longer.
 */
export function pathsAtRow(buffer, row) {
  const read = readAroundRow(buffer, row, MAX_LINK_LENGTH);
  if (!read) return [];
  const { text, from, to, rangeOf } = read;

  // Only the text a name touching the row can lie in. A token cut at either
  // end of it is longer than MAX_CANDIDATE_LENGTH if it reaches the row.
  const lo = Math.max(0, from - MAX_CANDIDATE_LENGTH);
  const hi = Math.min(text.length, to + MAX_CANDIDATE_LENGTH);
  const links = findLinks(text).filter((link) => link.start < hi && link.start + link.length > lo);
  const overlapsLink = (start, end) => links.some((link) => link.start < end && link.start + link.length > start);

  // The middle of what is written on the row, not of its cells: a short line
  // in a wide pane is mostly blank to its right.
  let end = to;
  while (end > from && /\s/.test(text[end - 1])) end -= 1;
  const middle = (from + end) / 2;
  const distance = (c) => Math.abs(c.start + c.length / 2 - middle);
  return pathCandidates(text.slice(lo, hi), { from: from - lo, to: to - lo })
    .map((c) => ({ ...c, start: c.start + lo }))
    .filter((c) => c.start < to && c.start + c.length > from && !overlapsLink(c.start, c.start + c.length))
    .sort((a, b) => Number(b.tail) - Number(a.tail) || distance(a) - distance(b) || b.length - a.length || a.start - b.start)
    .slice(0, MAX_CANDIDATES)
    .sort((a, b) => a.start - b.start || a.length - b.length)
    .map((c) => ({ ...c, range: rangeOf(c.start, c.start + c.length) }));
}

/**
 * An MSYS or Cygwin spelling of a Windows path, as Windows spells it:
 * `/c/Users/me` and `/cygdrive/c/Users/me` are `C:\Users\me`. Git Bash
 * reports its directory that way (OSC 7, src-tauri/src/pty/osc.rs keeps it as
 * it came) and prints paths that way. Anything else comes back as it was —
 * `/usr/bin` under Git Bash is somewhere inside its own install, which only
 * Git Bash knows. A bare drive (`/c`, `/c/`) is translated only when `bare`
 * is set: as a directory a shell reports it is the drive, as a word in the
 * output it is far more often a switch (`cmd /c`, `xcopy /s /e /h /d`).
 */
export function fromMsysPath(path, { bare = true } = {}) {
  if (typeof path !== 'string') return path;
  const match = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(path);
  if (!match) return path;
  const rest = match[2] ?? '';
  if (!bare && !rest) return path;
  return `${match[1].toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}

/**
 * The absolute path a name in the output stands for, or null.
 *
 * A relative name is read against `cwd` — the directory it was printed in
 * (src/lib/outputContext.js decides which) — as `resolveLinkPath` reads a
 * `path:line`; `~` against the home folder. On Windows, and only in a tab
 * whose shell is Git Bash's or Cygwin's (`msys`), an MSYS spelling in the
 * name or in the directory is read as the drive it names (`fromMsysPath`) —
 * in cmd or PowerShell `/c/x` is no path, and `/c` a switch. Null with
 * nothing to resolve against, for a path on another machine
 * (`resolveLinkPath` — the directory is no safer than the name, anything
 * printed can print an OSC 7), and for anything that is still not absolute
 * on this OS: the backend would not look at it either.
 */
export function resolveOutputPath(name, { cwd = null, os = null, home = null, msys = false } = {}) {
  if (typeof name !== 'string' || !name) return null;
  const windows = os === 'windows';
  const translate = windows && msys;
  let path = translate ? fromMsysPath(name, { bare: false }) : name;
  const dir = translate && typeof cwd === 'string' ? fromMsysPath(cwd) : cwd;
  if (typeof home === 'string' && home && (path === '~' || /^~[\\/]/.test(path))) {
    const base = home.replace(/[\\/]+$/, '') || home;
    path = path === '~' ? base : `${base}${windows ? '\\' : '/'}${path.slice(2)}`;
  }
  const resolved = resolveLinkPath(path, dir);
  if (!resolved) return null;
  const absolute = windows ? /^[A-Za-z]:[\\/]/.test(resolved) : resolved.startsWith('/');
  return absolute ? resolved : null;
}

const isKind = (kind) => kind === 'file' || kind === 'dir';

/**
 * The candidates to offer, given what the backend said of each path:
 * `candidates` carry `start`, `length` and either `path` or `paths` — the
 * places the name may stand for, the likeliest first (a listing's own folder
 * before the tab's); `kinds` maps a path to 'file', 'dir' or null. Each is
 * taken at the first of its paths that exists, and dropped when none does;
 * where two overlap the longer wins — `My Folder` over `My`, `[backup]` over
 * `backup` — the earlier of two the same length. In the order they appear,
 * each with its `path` and `kind`.
 */
export function chooseLinks(candidates, kinds) {
  const existing = [];
  for (const c of candidates) {
    const path = (c.paths ?? [c.path]).find((p) => isKind(kinds.get(p)));
    if (path) existing.push({ ...c, path, kind: kinds.get(path) });
  }
  existing.sort((a, b) => b.length - a.length || a.start - b.start);
  const chosen = [];
  for (const c of existing) {
    const end = c.start + c.length;
    if (chosen.some((o) => o.start < end && o.start + o.length > c.start)) continue;
    chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * Whether `event` carries the modifier that shows a path in the file
 * manager: ⌘ on macOS, Ctrl on Windows and Linux.
 *
 * Not with Alt or Shift as well, which belong to selection — Shift-drag
 * selects inside a full-screen program, ⌥-drag too on macOS, ⌥ alone makes
 * a column selection — and not with the other platform's modifier: on macOS
 * a Ctrl-click is a right-click, and AltGr on Windows arrives as Ctrl+Alt.
 * `platform` is the system store's `os` ('macos', 'windows', 'linux').
 */
export function isRevealModifier(event, platform) {
  if (!event || event.altKey || event.shiftKey) return false;
  if (platform === 'macos' || platform === 'mac') return Boolean(event.metaKey) && !event.ctrlKey;
  return Boolean(event.ctrlKey) && !event.metaKey;
}

/**
 * Whether a click shows its path: the main button, with the modifier
 * (`isRevealModifier`). xterm activates a link on the release of ANY button,
 * and a Ctrl+right-click is not a request to open Explorer.
 */
export function isRevealClick(event, platform) {
  return Boolean(event) && (event.button ?? 0) === 0 && isRevealModifier(event, platform);
}

/**
 * Whether paths exist, and as what, asked of the backend as little as
 * possible: `ask(paths)` is `fs_path_kinds` (an array of 'file' | 'dir' |
 * null, in order); what it answered is kept for `ttlMs`, at most
 * `maxEntries` paths, the oldest dropped first; a path already being asked
 * about is waited for, not asked again; and what is asked goes in calls of
 * MAX_KIND_PATHS at most. A call that fails answers null for its paths and
 * is remembered for nothing, so the next hover asks again.
 *
 * `known(paths)` is a Map of every path's kind when all are fresh in memory,
 * else null — the provider answers at once then, without waiting for the
 * next task. `kinds(paths)` resolves to that Map, asking for what is missing.
 */
export function createKindLookup({
  ask,
  ttlMs = KIND_TTL_MS,
  maxEntries = KIND_CACHE_SIZE,
  now = () => Date.now(),
} = {}) {
  const remembered = new Map();
  const asking = new Map();

  const fresh = (path) => {
    const hit = remembered.get(path);
    if (!hit) return undefined;
    if (now() - hit.at > ttlMs) {
      remembered.delete(path);
      return undefined;
    }
    return hit.kind;
  };
  const remember = (path, kind) => {
    remembered.delete(path);
    remembered.set(path, { kind, at: now() });
    while (remembered.size > maxEntries) remembered.delete(remembered.keys().next().value);
  };
  const normalized = (kind) => (kind === 'file' || kind === 'dir' ? kind : null);

  const askFor = (batch) => {
    const answer = Promise.resolve()
      .then(() => ask(batch))
      .then(
        (kinds) => {
          const usable = Array.isArray(kinds) && kinds.length === batch.length;
          return batch.map((path, i) => {
            const kind = usable ? normalized(kinds[i]) : null;
            if (usable) remember(path, kind);
            return kind;
          });
        },
        () => batch.map(() => null)
      )
      .finally(() => {
        for (const path of batch) asking.delete(path);
      });
    batch.forEach((path, i) => asking.set(path, answer.then((kinds) => kinds[i])));
  };

  return {
    known(paths) {
      const found = new Map();
      for (const path of paths) {
        const kind = fresh(path);
        if (kind === undefined) return null;
        found.set(path, kind);
      }
      return found;
    },
    async kinds(paths) {
      const unique = [...new Set(paths)];
      const missing = unique.filter((path) => fresh(path) === undefined && !asking.has(path));
      for (let i = 0; i < missing.length; i += MAX_KIND_PATHS) askFor(missing.slice(i, i + MAX_KIND_PATHS));
      const found = new Map();
      await Promise.all(
        unique.map(async (path) => {
          const kind = fresh(path);
          found.set(path, kind !== undefined ? kind : await asking.get(path));
        })
      );
      return found;
    },
  };
}

export default {
  pathCandidates,
  pathsAtRow,
  decodeShellQuoted,
  decodeCQuoted,
  fromMsysPath,
  resolveOutputPath,
  chooseLinks,
  isRevealModifier,
  isRevealClick,
  createKindLookup,
};
