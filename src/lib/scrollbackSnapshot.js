/**
 * A terminal's output, kept across a restart (stage 6): what is written to
 * disk, and what may come back from it.
 *
 * Saving reads xterm's NORMAL buffer through its public buffer API — never
 * the alternate screen, where OpenCode, vim and less draw — and turns it into
 * one file's text: a format line, a JSON header, then the output as logical
 * lines joined by CR LF. Restoring reads that text back and lets through only
 * text, SGR and line breaks.
 *
 * Why not @xterm/addon-serialize: it writes cursor moves (CUF) for gaps in a
 * row and mode and cursor state at the end, so the restore filter would have
 * to let cursor movement through, and its output is one string with nothing
 * to tell masking where a colour changed. This writes exactly the subset the
 * filter keeps, and keeps each line as runs of one set of attributes until
 * masking has looked at it. No dependency either.
 *
 * Logical lines, not rows: the rows of one line that xterm wrapped
 * (`isWrapped`) are joined, so a restore at another width wraps them again
 * and every later resize reflows them as it does live output. Each line
 * starts from the default attributes and ends reset, so lines can be dropped
 * from the top and masked one at a time without one's colour leaking into
 * the next.
 *
 * Secrets: output is full of them (`env`, `cat .env`, a CLI printing its
 * token). Each line's plain text — its runs' text joined, so an SGR inside a
 * token or a wrap across it does not split it — is searched before anything
 * leaves the page, and what matches is replaced by `[hidden]` in the runs
 * (see `maskLine`). Masking runs on whole lines before the caps cut any, so
 * a cut can never leave half a token behind.
 *
 * The file on disk is anybody's to edit: `parseSnapshot` checks the header
 * and `sanitizeForRestore` drops every control and every escape sequence but
 * SGR, so nothing restored can write the clipboard (OSC 52), set a title,
 * mark a command, open a link, or ask the terminal something whose answer
 * would be typed into the new shell (DA, DSR, XTVERSION, DECRQSS).
 */

/** The first line of every file. A file without it, or another version, is not read. */
export const SNAPSHOT_MAGIC = 'NEXTERM-SCROLLBACK 1';

/**
 * The most one terminal's file may hold, in UTF-8 bytes — header included.
 * Mirrors the backend's cap (src-tauri), which refuses a larger write and
 * does not read a larger file. A save reads about this much of the buffer on
 * the page's main thread (`readNewestLines`), so it is also what bounds a
 * save's cost: 2 MiB is the default 5000 lines several times over.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The only tab ids a file is ever named after. Mirrors the backend's
 * `is_tab_id`: `tab-term-<n>`, or the `tab-term-<ms>-<n>` that builds before
 * v0.1.2 made — a restore keeps a saved id as it is, so a layout from then
 * still has them, and its terminals would otherwise never be saved.
 */
export const TAB_ID_PATTERN = /^tab-term-(?:[1-9][0-9]{0,8}|[1-9][0-9]{12}-[1-9][0-9]{0,3})$/;

/**
 * How many lines the END walk-back has read since the page loaded — for the
 * suites, which pin that it stays proportional to the lines masked (a test
 * cannot time it; see SM-25).
 */
export const maskStats = { walkSteps: 0 };

/** What a masked secret becomes. */
export const HIDDEN = '[hidden]';

/** The longest header line read. A real one is under 200 characters. */
const MAX_HEADER_CHARS = 1024;

/** 2020-01-01: a `savedAt` before this is not a time this app wrote. */
const EARLIEST_SAVE = 1_577_836_800_000;

/** How far in the future a `savedAt` may be (another machine's clock, a time zone change). */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

// ---- Serializing ---------------------------------------------------------------

/** xterm's colour modes (`getFgColorMode`): the 16-colour palette, as set by 30–37, 90–97, 40–47, 100–107. */
const CM_P16 = 0x1000000;

/** `n` of the 16 colours as its own SGR: `base` + n for 0–7, `bright` + n − 8 for 8–15. */
const p16 = (n, base, bright) => String(n < 8 ? base + n : bright + n - 8);

/**
 * The SGR parameters of a cell, as one string ('' for default attributes).
 *
 * A colour set as one of the 16 (`31`, `92`) goes back as one of the 16, not
 * as `38;5;1`: xterm keeps the two apart, and draws bold text in the bright
 * colours only for the 16 (`drawBoldTextInBrightColors`) — `38;5;1` bold
 * stays dark red.
 */
function sgrOf(cell) {
  if (cell.isAttributeDefault()) return '';
  const params = [];
  if (cell.isBold()) params.push('1');
  if (cell.isDim()) params.push('2');
  if (cell.isItalic()) params.push('3');
  if (cell.isUnderline()) params.push('4');
  if (cell.isBlink()) params.push('5');
  if (cell.isInverse()) params.push('7');
  if (cell.isInvisible()) params.push('8');
  if (cell.isStrikethrough()) params.push('9');
  if (cell.isOverline()) params.push('53');
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    params.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isFgPalette()) {
    const n = cell.getFgColor();
    params.push(cell.getFgColorMode() === CM_P16 && n < 16 ? p16(n, 30, 90) : `38;5;${n}`);
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    params.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isBgPalette()) {
    const n = cell.getBgColor();
    params.push(cell.getBgColorMode() === CM_P16 && n < 16 ? p16(n, 40, 100) : `48;5;${n}`);
  }
  return params.join(';');
}

/** A cell with nothing written in it, or a space. */
function isBlank(cell) {
  const chars = cell.getChars();
  return chars === '' || chars === ' ';
}

/**
 * Append row `line` to `runs` (runs of one SGR each).
 *
 * `continues`: the next row is this line's continuation. Then every cell
 * counts — a space at the wrap is a real space between two words — except
 * the empty cell xterm leaves in the last column when a wide character did
 * not fit there and went to the next row (`gapBeforeWide`). Otherwise the
 * row's trailing blanks are left out.
 */
function appendRow(runs, line, cell, continues, gapBeforeWide) {
  // Returns the cells the row uses (after trimming), for `endCells`.
  let end = line.length;
  if (continues) {
    if (gapBeforeWide && end > 0) {
      const last = line.getCell(end - 1, cell);
      if (last && last.getChars() === '' && last.getWidth() === 1) end -= 1;
    }
  } else {
    while (end > 0) {
      const c = line.getCell(end - 1, cell);
      if (!c || !isBlank(c)) break;
      end -= 1;
    }
  }
  let current = runs.length ? runs[runs.length - 1] : null;
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    const width = c.getWidth();
    // The second half of a wide character: its first half wrote it.
    if (width === 0) continue;
    const chars = c.getChars() || ' ';
    const sgr = sgrOf(c);
    if (current && current.sgr === sgr) {
      current.text += chars;
    } else {
      current = { sgr, text: chars };
      runs.push(current);
    }
  }
  return end;
}

/**
 * The normal buffer of `term` from row `fromRow` on, as logical lines, each
 * `{ runs: [{ sgr, text }], endCells }` (`endCells`: the cells its last row
 * uses), oldest first. Blank lines at the start and the end are left out.
 */
export function readLogicalLines(term, fromRow = 0) {
  const buffer = term.buffer.normal;
  const cell = buffer.getNullCell();
  const lines = [];
  let current = null;
  const total = buffer.length;
  for (let y = Math.max(0, fromRow); y < total; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (!line.isWrapped || current === null) {
      // A first row that continues a line already gone from the scrollback
      // is the tail of that line — perhaps of a token whose start is no
      // longer there to be recognised — so it is left out (found in review).
      current = { runs: [], endCells: 0, fragment: line.isWrapped };
      lines.push(current);
    }
    const next = y + 1 < total ? buffer.getLine(y + 1) : null;
    const continues = Boolean(next && next.isWrapped);
    let gapBeforeWide = false;
    if (continues) {
      const first = next.getCell(0, buffer.getNullCell());
      gapBeforeWide = Boolean(first && first.getWidth() === 2);
    }
    current.endCells = appendRow(current.runs, line, cell, continues, gapBeforeWide);
  }
  const whole = lines.filter((l) => !l.fragment);
  const empty = (l) => l.runs.every((r) => r.text.trim() === '');
  let start = 0;
  let end = whole.length;
  while (start < end && empty(whole[start])) start += 1;
  while (end > start && empty(whole[end - 1])) end -= 1;
  return whole.slice(start, end).map(({ runs, endCells }) => ({ runs, endCells }));
}

/**
 * The newest logical lines of the normal buffer that can be in a file of
 * `limit` lines and `maxBytes` bytes, oldest first, and the row the first of
 * them starts at.
 *
 * Read from the bottom up, a whole line at a time, each encoded as it would
 * be written, and stopped once the encoded lines are past the budget (with a
 * quarter to spare, as masking usually shortens them; the exact cut comes
 * after masking). So a save reads about as much of the buffer as the file
 * holds — not the scrollback, and not row text, which counts a line in its
 * own colour per cell as a fifth of what it costs (found in review: 0.5–3 s a
 * save at a 100 000-line scrollback when every row was read; 560 ms for a
 * truecolor-per-cell buffer bounded by row text). The blank rows under the
 * last output are not lines of the file and do not use up `limit`.
 */
function readNewestLines(term, limit, maxBytes) {
  const buffer = term.buffer.normal;
  const cell = buffer.getNullCell();
  const budget = maxBytes * 1.25;
  const lines = [];
  let bytes = 0;
  let below = true;
  let full = false;
  let context = null;
  let contextRow = -1;
  let end = buffer.length - 1;
  let fromRow = buffer.length;
  for (let y = end; y >= 0; y--) {
    const row = buffer.getLine(y);
    if (!row) continue;
    if (row.isWrapped && y > 0) continue;
    // Rows y..end are one logical line.
    const line = { runs: [], endCells: 0 };
    for (let r = y; r <= end; r++) {
      const next = r + 1 <= end ? buffer.getLine(r + 1) : null;
      const continues = Boolean(next && next.isWrapped);
      let gapBeforeWide = false;
      if (continues) {
        const first = next.getCell(0, buffer.getNullCell());
        gapBeforeWide = Boolean(first && first.getWidth() === 2);
      }
      line.endCells = appendRow(line.runs, buffer.getLine(r), cell, continues, gapBeforeWide);
    }
    const fragment = row.isWrapped; // y === 0: its start already left the scrollback
    end = y - 1;
    if (fragment) break;
    // One line more than the file holds, read for masking only: a token the
    // margin cut at its end goes on in the first line kept (found in review:
    // that tail was saved in clear, where masking everything first hid it).
    if (full) {
      context = line;
      contextRow = y;
      break;
    }
    const blank = line.runs.every((run) => run.text.trim() === '');
    if (below && blank) continue;
    below = false;
    lines.push(line);
    fromRow = y;
    bytes += utf8Length(encodeLine(line)) + 2;
    if (lines.length >= limit || bytes > budget) full = true;
  }
  lines.reverse();
  while (lines.length && lines[0].runs.every((run) => run.text.trim() === '')) {
    lines.shift();
  }
  return { lines, fromRow, context, contextRow };
}

/** A logical line as it is written to the file: its runs with SGR between them, reset at the end. */
export function encodeLine(line) {
  let out = '';
  let sgr = '';
  for (const run of line.runs) {
    if (run.text === '') continue;
    if (run.sgr !== sgr) {
      out += run.sgr === '' ? '\x1b[0m' : `\x1b[0;${run.sgr}m`;
      sgr = run.sgr;
    }
    out += run.text;
  }
  if (sgr !== '') out += '\x1b[0m';
  return out;
}

/** UTF-8 length of `text` without encoding it. A lone surrogate counts as U+FFFD would (3). */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

// ---- Masking -------------------------------------------------------------------

/*
 * Masking is linear in a line's length, whatever the line holds: no pattern
 * here can backtrack over more than a bounded stretch. Each regular
 * expression is a literal prefix followed by character classes whose match
 * ends where the class does (so a failed try costs what was read, and the
 * next try starts past it), or repeats only a bounded number of times; what
 * needs to look on both sides of a `=` or a `:` is a scanner with a fixed
 * look-back and look-ahead. Found in review: an unanchored `name*?` in front
 * of the keyword list took 440 ms a save on one `openssl rand -hex 16384`
 * line, and 5 s on 64 000 characters.
 */

/**
 * Tokens whose prefix is distinctive enough to be matched anywhere — no
 * boundary before them. A boundary rule ("not after a letter or digit")
 * misses a token printed after an escape in JSON (`\nghp_…` puts an `n`
 * before it), after `%3D` in a URL, or right after a colour change, which in
 * the plain text is right after the previous word (vault: 2026-10-23 비밀
 * 마스킹 함정). `keep` characters of the match stay, to say what it was.
 */
const PREFIXED = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, keep: 7 },
  { re: /sk-proj-[A-Za-z0-9_-]{20,}/g, keep: 8 },
  { re: /sk-svcacct-[A-Za-z0-9_-]{20,}/g, keep: 11 },
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/g, keep: 4 },
  { re: /github_pat_[A-Za-z0-9_]{22,}/g, keep: 11 },
  { re: /xox[abposr]-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { re: /xapp-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, keep: 4 },
  { re: /AIza[0-9A-Za-z_-]{35}/g, keep: 4 },
  { re: /glpat-[0-9A-Za-z_-]{20,}/g, keep: 6 },
  { re: /npm_[A-Za-z0-9]{36}/g, keep: 4 },
  { re: /[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g, keep: 8 },
  { re: /whsec_[A-Za-z0-9]{20,}/g, keep: 6 },
  { re: /hf_[A-Za-z0-9]{30,}/g, keep: 3 },
  { re: /gsk_[A-Za-z0-9]{40,}/g, keep: 4 },
  { re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, keep: 3 },
  { re: /ya29\.[A-Za-z0-9_-]{20,}/g, keep: 5 },
  { re: /hv[sb]\.[A-Za-z0-9_-]{20,}/g, keep: 4 },
  { re: /dop_v1_[a-f0-9]{64}/g, keep: 7 },
  { re: /shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}/g, keep: 6 },
  { re: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g, keep: 5 },
  { re: /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g, keep: 16 },
  { re: /ATATT[A-Za-z0-9_=-]{30,}/g, keep: 5 },
  // A PEM block in base64 (`kubectl get secret -o yaml`'s `tls.key:`), and
  // long base64 JSON (`aws ecr get-login-password`, a dockerconfigjson).
  { re: /LS0tLS1CRUdJTi[A-Za-z0-9+/=]{20,}/g, keep: 4 },
  { re: /eyJ[A-Za-z0-9+/=_-]{100,}/g, keep: 3 },
  { re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g, keep: 25 },
  { re: /discord(?:app)?\.com\/api\/webhooks\/[0-9]{5,30}\/[A-Za-z0-9_-]{20,}/g, keep: (m) => m.indexOf('webhooks/') + 9 },
];

/** Cheap first look: a line with none of these has nothing for PREFIXED to find. */
const ANY_PREFIX =
  /sk-|gh[pousr]_|github_pat_|xox|xapp-|AKIA|ASIA|AIza|glpat-|npm_|k_live_|k_test_|whsec_|hf_|gsk_|SG\.|ya29\.|hv[sb]\.|dop_v1_|shp|pypi-|AGE-SECRET|ATATT|LS0tLS1|eyJ|hooks\.slack|discord/;

/**
 * OpenAI's older `sk-…` keys: `sk-` alone is too common inside words
 * (`task-`, `disk-`, `desk-`) to match anywhere, so it needs something that
 * is not a letter or digit before it — or the start of the line, a change of
 * attributes, a `\x` escape or a `%XX` — which is exactly where a key lands.
 */
const GENERIC_SK = /sk-[A-Za-z0-9_-]{20,}/g;

/** A JWT's first part; the rest is checked where it ends (`jwtAt`). */
const JWT_HEAD = /eyJ[A-Za-z0-9_-]{8,}/g;
const JWT_REST = /\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y;

/** `Authorization: Bearer …`, any case. The token must have a digit or `+/=`, or be 20 long — `HTTP Basic Authentication` is prose. */
const AUTH_SCHEME = /\b(?:bearer|basic|token)[ \t]{1,8}([A-Za-z0-9._~+/=-]{12,})/gi;

/** The password in `scheme://user:password@host` — up to the last `@` before the host, as a password may hold one. */
const URL_CREDENTIALS = /\b[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,256}:([^\s/]{1,256})@/g;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** The armour headers a key block may hold between BEGIN and its base64. */
const KEY_HEADER = /(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset|MessageID): /;
/** How many lines in a row inside a block may not be key material before the block is taken to have ended. */
const KEY_GAP_LINES = 2;
const isBase64Char = (c) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2b || c === 0x2f || c === 0x3d;

/**
 * The base64 at the end of a line of a key block, whatever is printed in
 * front of it — `git log -p`'s `-`, `cat -n`'s number, `bat`'s `│`, grep's
 * `file:`, a log's time stamp (found in review: anchoring the whole line on
 * base64 left every one of those in clear). `[start, end)` when that run is
 * at least four characters and at least half of what the line shows — the
 * short last line of a key included — null otherwise.
 */
function keyMaterialAt(text, shape = null) {
  const run = trailingBase64(text);
  if (!run || !looksLikeBase64(text.slice(run[0], run[1]))) return null;
  const [start, end] = run;
  let shown = 0;
  for (let i = 0; i < end; i++) if (!isBlankChar(text.charCodeAt(i))) shown++;
  if ((end - start) * 2 >= shown) return run;
  // A short last line behind a long prefix (`id_rsa:`, a time stamp): key
  // material if what is in front of it is shaped as on the line before.
  return shape !== null && prefixShape(text, start) === shape ? run : null;
}

/**
 * The run of base64 a line ends in, four characters or more: `[start, end)`
 * or null. What a viewer adds after it is passed over — `cat -A`'s `$`,
 * `cat -v`'s `^M`, a quote and comma of a JSON or Python list, a table's
 * `|`, word-diff's `-]` — and a JSON `\n` inside it belongs to it (a key
 * hard-wrapped with its escapes). Found in review: each of these left a
 * whole key in clear.
 */
function trailingBase64(text) {
  let end = text.length;
  // In any order and twice over: `cat -A` on a CRLF key prints `…^M$`.
  for (let pass = 0; pass < 3; pass++) {
    while (end > 0 && isBlankChar(text.charCodeAt(end - 1))) end--;
    if (text.endsWith('^M', end)) end -= 2;
    for (let skipped = 0; end > 0 && skipped < 4 && KEY_LINE_TAIL.has(text[end - 1]); skipped++) end--;
  }
  while (end > 0 && isBlankChar(text.charCodeAt(end - 1))) end--;
  let start = end;
  for (;;) {
    if (start > 0 && isBase64Char(text.charCodeAt(start - 1))) start--;
    else if (start > 0 && text[start - 1] === '\\' && /[nrt]/.test(text[start] ?? '')) start--;
    else break;
  }
  return end - start >= 4 ? [start, end] : null;
}

/** What may follow a key line's base64 on the screen. */
const KEY_LINE_TAIL = new Set(['$', '"', "'", ',', '|', ']', '-', ')', '}', ';']);

/**
 * Base64 rather than a word: sixteen long, or holding a digit or `+/=`, or
 * mixed case other than a capitalised word — so `Compiling`, `FAILED`,
 * `node_modules` after a BEGIN are not taken for a key (found in review).
 */
function looksLikeBase64(run) {
  if (run.length >= 16 || /[0-9+/=]/.test(run)) return true;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && !/^[A-Z][a-z]+$/.test(run);
}

/** What is printed in front of a key line, digits made alike: a line number, a time stamp, a file name. */
function prefixShape(text, start) {
  // `git blame`'s commit (a boundary one marked `^`) differs line to line.
  return text.slice(0, start).trim().replace(/^\^/, '').replace(/\b[0-9a-f]{7,40}\b/g, 'H').replace(/[0-9]/g, '#');
}
/** No key block is longer than this many lines (an RSA 16384 key is about 200). */
const MAX_KEY_LINES = 400;

/**
 * Words that make a name a secret's wherever they appear in it
 * (`DB_PASSWORD_PROD`, `SECRET_KEY_BASE`, `x-api-key`, `clientSecret`).
 */
const SECRET_WORDS = ['password', 'passwd', 'passphrase', 'secret', 'apikey', 'api_key', 'api-key', 'privatekey', 'private_key', 'private-key', 'accesskey', 'access_key', 'access-key', 'credential'];
/** Whole parts of a name that make it a secret's (`DB_PASS`, `GITHUB_TOKEN`, `"auth":`, `SENTRY_DSN`) — not `tokens`, `bypass`, `PWD`. */
const SECRET_PARTS = new Set(['pass', 'token', 'auth', 'dsn', 'webhook', 'cookie', 'sig', 'signature']);
/** Parts that count only beside another part: `DB_PWD`, `ADMIN_PW`, `DB_PASS` — not `PWD` (the folder) or Go's `--- PASS:`. */
const PAIRED_PARTS = new Set(['pass', 'pwd', 'pw']);
/**
 * Parts that say the value is about a secret, not the secret: `token_count`,
 * `auth_method`, `password_file`, `credential.helper`, `max_tokens` (found in
 * review: `"totalTokenCount": [hidden]` in every JSON usage report).
 */
const ABOUT_PARTS = new Set(['count', 'counts', 'limit', 'max', 'min', 'usage', 'type', 'kind', 'method', 'mode', 'expires', 'expiry', 'expiration', 'ttl', 'length', 'len', 'size', 'file', 'path', 'helper', 'name', 'header', 'prefix', 'endpoint', 'provider', 'scope', 'scopes', 'format', 'version', 'enabled', 'required', 'policy', 'strategy', 'source', 'store', 'cache', 'dir', 'rotation', 'hint', 'id']);
/** `<part>_KEY` names that are a secret's (`APP_KEY`, `ENCRYPTION_KEY`) — `sort_key`, `primary key` are not. */
const KEY_KINDS = new Set(['app', 'encryption', 'master', 'signing', 'secret', 'private', 'api', 'access', 'client', 'license', 'service', 'account', 'session', 'jwt', 'hmac', 'aes', 'rsa', 'ssh', 'gpg', 'deploy', 'admin', 'root']);
/** Values that say there is no secret here. */
const NOT_A_SECRET = /^(?:null|nil|none|true|false|undefined|yes|no|on|off|required|optional|enabled|disabled|default|redacted|masked|unset|empty|n\/a|\*+|<[^>]{0,64}>|\[hidden\]|\$\{[^}]{0,64}\}|\$[A-Za-z_][A-Za-z0-9_]{0,64}|%[A-Za-z_][A-Za-z0-9_]{0,64}%)$/i;
/** A type, not a value: `password: string`, `def f(password: str) -> bool:`. */
const TYPE_NAME = /^(?:string|str|number|int|integer|bool|boolean|any|unknown|object|bytes|secretstr|char\*?|&str|option<[^>]{0,32}>|optional\[[^\]]{0,32}\])[,);:]*$/i;
/** Code, not a value: `req.body.password`, `process.env.TOKEN;`, `config.secret,`. */
const DOTTED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,64}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,64}){1,8}[;,)]?$/;

/** Every name `isSecretName` takes has one of these in it, in lower case — the cheap first look. */
const NAME_HINT = /pass|pwd|pw|secret|key|token|auth|dsn|webhook|cookie|sig|credential/;

/** A file name in front of `:line` (`src/auth.rs:12`, `token.go:45`), not a field. */
const FILE_NAME = /\.(?:rs|go|py|pyi|js|mjs|cjs|ts|tsx|jsx|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|m|mm|sh|bash|zsh|ps1|psm1|json|yaml|yml|toml|ini|cfg|conf|md|txt|log|html|css|scss|vue|svelte|ex|exs|erl|lua|pl|sql|proto|tf|xml|gradle|lock|dart|scala|clj|elm|hs|ml|nim|zig)$/i;

/**
 * How surely `name` is a secret's: 'strong' when a word that says so is in
 * it (`password`, `secret`, `api_key`, …), 'weak' when only a part of it
 * does (`token`, `auth`, `cookie`, `DB_PASS`, `APP_KEY`), null when not.
 * A weak name's value has to look like a secret too (`scanAssignments`), and
 * only a strong one's `:` value runs to the end of the line — found in
 * review: `a1b2c3d auth: refresh tokens` and `INFO token: refreshed` lost
 * their words, `src/auth.rs:12` its whole compiler message.
 */
export function secretNameStrength(name, { quoted = false } = {}) {
  if (!name || name.length > 64 || !NAME_HINT.test(name.toLowerCase())) return null;
  if (FILE_NAME.test(name)) return null;
  const lower = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const parts = lower.split(/[_.-]+/).filter(Boolean);
  if (parts.some((part) => ABOUT_PARTS.has(part)) || lower === 'oldpwd') return null;
  if (SECRET_WORDS.some((w) => lower.includes(w))) return 'strong';
  for (let i = 0; i < parts.length; i++) {
    if (PAIRED_PARTS.has(parts[i])) {
      // A quoted `"pass":` is JSON's field; a bare `PASS:` is a test report.
      if (parts.length > 1 || quoted) return 'weak';
      continue;
    }
    if (SECRET_PARTS.has(parts[i])) return 'weak';
    if (parts[i] === 'key' && i > 0 && KEY_KINDS.has(parts[i - 1])) return 'weak';
  }
  return null;
}

export function isSecretName(name) {
  return secretNameStrength(name) !== null;
}

/** A weak name's value must look like a secret: a digit, `+/=`, or sixteen long. */
const looksSecret = (value) => /[0-9+/=]/.test(value) || value.length >= 16;
/** A type or a structure, not a value: `AccessToken`, `Vec<u8>`, `{…}`, `[…]`, `(known after apply)`, `&[u8]`, `<set to …>`. */
const PASCAL_TYPE = /^(?:[A-Z][a-z]+){2,}(?:<[^>]{0,64}>)?[,;)]*$|^[A-Z][A-Za-z0-9]{0,40}<[^>]{0,64}>[,;)]*$/;
const STRUCTURE_START = /^[{[(&]/;
/** A placeholder in angle brackets standing for the whole value: `<set to the key 'password' in secret 'db'>`. */
const PLACEHOLDER = /^<[^<>]{0,200}>(?:[\s,;]|$)/;

const isNameChar = (c) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2e || c === 0x2d;
const isBlankChar = (c) => c === 0x20 || c === 0x09;
const isQuote = (ch) => ch === '"' || ch === "'" || ch === '`';
/**
 * Where an unquoted value ends: white space, a backtick, `,` or `;` — not a
 * quote, which a password may hold (`PASSWORD=abc'def` hid only `abc`, found
 * in review) — and, in a URL's query, `&` and `#`.
 */
const endsValue = (c, inQuery) =>
  c === 0x20 || c === 0x09 || c === 0x60 || c === 0x2c || c === 0x3b || (inQuery && (c === 0x26 || c === 0x23));

/**
 * `NAME=value`, `NAME: value`, `"name": "value with spaces"`, `export X=…`,
 * YAML, JSON, `.env`, `Set-Cookie:`. A scanner, not a pattern: from each `=`
 * or `:` it looks back at most 72 characters for the name and forward at
 * most 520 for the value, then goes on past the value.
 */
function scanAssignments(text, add) {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x3d && c !== 0x3a) continue;
    // `://`, `::` and `a:b:c` paths are not separators worth reading, nor a
    // `:` with something right after it (`auth:server listening`) unless the
    // name was quoted (`"password":"x"`).
    if (c === 0x3a && (text[i + 1] === '/' || text[i + 1] === ':' || text[i - 1] === ':')) continue;
    // A `:` with the value right after it (`Password:hunter2x` from Go's
    // `%+v`, `auth:server listening` from a debug prefix) is read, but its
    // value has to look like a secret.
    const tight = c === 0x3a && !isQuote(text[i - 1]) && !(i + 1 >= n || isBlankChar(text.charCodeAt(i + 1)) || isQuote(text[i + 1]));
    // `password = PasswordHash` is code; `PASSWORD=Welcome` is an assignment.
    const spaced = c === 0x3d && i > 0 && isBlankChar(text.charCodeAt(i - 1)) && i + 1 < n && isBlankChar(text.charCodeAt(i + 1));
    let j = i - 1;
    for (let skipped = 0; j >= 0 && skipped < 8 && isBlankChar(text.charCodeAt(j)); skipped++) j--;
    if (j >= 0 && isQuote(text[j])) j--;
    const nameEnd = j + 1;
    let k = j;
    while (k >= 0 && nameEnd - k <= 64 && isNameChar(text.charCodeAt(k))) k--;
    const strength = secretNameStrength(text.slice(k + 1, nameEnd), { quoted: isQuote(text[nameEnd]) });
    if (!strength) continue;
    const inQuery = k >= 0 && (text[k] === '?' || text[k] === '&');
    let v = i + 1;
    for (let spaces = 0; v < n && spaces < 8 && isBlankChar(text.charCodeAt(v)); spaces++) v++;
    let start;
    let end;
    const quoted = isQuote(text[v]);
    if (quoted) {
      const quote = text[v];
      start = v + 1;
      end = start;
      // `\"` inside a JSON string is part of it (found in review: the rest leaked).
      while (end < n && end - start < 512 && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
      end = Math.min(end, n);
      if (end === start) continue;
    } else if (c === 0x3a && !inQuery && !tight && strength === 'strong') {
      // `password: correct horse battery staple` (YAML, a header): the value
      // is the rest of the line, not its first word.
      start = v;
      end = v;
      while (end < n && end - start < 512) end++;
      while (end > start && isBlankChar(text.charCodeAt(end - 1))) end--;
      const first = text.slice(start, Math.min(end, start + 64)).split(/\s/)[0];
      if (end - start < 4 || NOT_A_SECRET.test(first) || DOTTED_NAME.test(first) || TYPE_NAME.test(first)) continue;
      if (PASCAL_TYPE.test(first) || STRUCTURE_START.test(first)) continue;
    } else {
      start = v;
      end = v;
      while (end < n && end - start < 512 && !endsValue(text.charCodeAt(end), inQuery)) end++;
      if (end - start < 4) continue;
    }
    const value = text.slice(start, end);
    // Types and structures only where code has them: after an unquoted `:`
    // or a spaced `=`. A quoted value, or `API_TOKEN={a8f9…}`, is a value
    // (found in review: skipping them everywhere left those in clear).
    const codeLike = !quoted && (c === 0x3a || spaced);
    if (codeLike && (PASCAL_TYPE.test(value) || STRUCTURE_START.test(value) || PLACEHOLDER.test(value))) continue;
    // A weak name in prose or a log, or glued to its value: the value must
    // look like a secret. `DB_PASS=letmein` is an assignment and is hidden.
    if ((tight || (codeLike && strength === 'weak')) && !looksSecret(value)) continue;
    // `Authorization: Bearer …`: the scheme stays, AUTH_SCHEME takes the token.
    if (NOT_A_SECRET.test(value) || DOTTED_NAME.test(value) || TYPE_NAME.test(value) || /^(?:bearer|basic|token|digest)$/i.test(value)) continue;
    add(start, end);
    i = end - 1;
  }
}

/** Cheap first looks for `scanWords`: a flag it reads, or a word that could be a bare AWS secret. */
const WORD_HINT = /\s-[pPuUak]|--(?:pass|token|secret|api|user)|pass:|^\s*(?:machine|default)\s/;
/** Programs that take a password in the word after one of these flags. */
const PASSWORD_FLAGS = new Map([
  ['sshpass', ['-p']],
  ['login', ['-p']],
  ['mongosh', ['-p']],
  ['mongo', ['-p']],
  ['redis-cli', ['-a']],
  ['sqlcmd', ['-P']],
  ['zip', ['-P']],
  ['openssl', ['-k']],
]);
const AWS_HINT = /(?:^|\s)[A-Za-z0-9+/]{40}(?:\s|$)/;

/** A word that is an AWS secret access key on its own (`aws configure get aws_secret_access_key`): 40 of base64's letters, both cases and a digit. */
const AWS_SECRET = /^[A-Za-z0-9+/]{40}$/;

/**
 * Passwords handed to programs on their command line, as a shell echoes
 * them and as `ps` or a history shows them: `--password X`, `--token=X`,
 * `mysql -pX`, `sshpass -p X`, `docker login -p X`, `curl -u user:X`,
 * openssl's `pass:X`, a `.netrc` line's `password X` — and a bare AWS secret
 * access key.
 */
function scanWords(text, add) {
  const words = [];
  for (const m of text.matchAll(/\S+/g)) words.push({ w: m[0], at: m.index });
  let mysql = false;
  // A set, filled once per program: a list copied on every program name made
  // a line of `zip zip zip … -P` quadratic (found in review: 12.7 s a save).
  const takesP = new Set();
  let smb = false;
  let urlTool = false;
  const netrc = words.length > 0 && (words[0].w === 'machine' || words[0].w === 'default');
  const next = (n) => words[n + 1];
  for (let n = 0; n < words.length; n++) {
    const { w, at } = words[n];
    const end = at + w.length;
    // The program's name, also inside `$(curl …`, `(curl …`, `x;curl …` (found in review).
    const base = w.replace(/^.*[/\\(;`"'$|&]/, '').toLowerCase();
    if (/^(?:mysql|mariadb|mysqldump|mysqladmin|mysqlsh|7z|7za)(?:\.exe)?$/.test(base)) mysql = true;
    const flags = PASSWORD_FLAGS.get(base.replace(/\.exe$/, ''));
    if (flags) for (const flag of flags) takesP.add(flag);
    // `-u user:password` is curl's (and wget's, httpie's); Docker's `-u 1000:1000` is a user and group.
    if (/^(?:curl|wget|http|https|xh)(?:\.exe)?$/.test(base)) urlTool = true;
    if (base === 'smbclient' || base === 'smbclient.exe') smb = true;
    const flag = /^--?(?:password|passwd|pass|token|secret|api-key|apikey)(?:=(.+))?$/i.exec(w);
    if (flag) {
      if (flag[1]) add(end - flag[1].length, end);
      else if (next(n)) {
        add(next(n).at, next(n).at + next(n).w.length);
        n++;
      }
      continue;
    }
    if (mysql && w.length > 4 && w.startsWith('-p')) {
      add(at + 2, end);
      continue;
    }
    if (takesP.has(w) && next(n)) {
      add(next(n).at, next(n).at + next(n).w.length);
      n++;
      continue;
    }
    const attached = urlTool ? /^(?:--user=|-u(?=[^\s:]+:))([^:]*):(.+)$/.exec(w) : null;
    if (attached) {
      add(end - attached[2].length, end);
      continue;
    }
    if (smb && w === '-U' && next(n)) {
      const user = next(n);
      const cut = user.w.indexOf('%');
      if (cut !== -1 && cut < user.w.length - 1) add(user.at + cut + 1, user.at + user.w.length);
      n++;
      continue;
    }
    if (urlTool && (w === '-u' || w === '--user') && next(n)) {
      const user = next(n);
      const colon = user.w.indexOf(':');
      if (colon !== -1 && colon < user.w.length - 1) add(user.at + colon + 1, user.at + user.w.length);
      n++;
      continue;
    }
    if (netrc && (w === 'password' || w === 'account') && next(n)) {
      add(next(n).at, next(n).at + next(n).w.length);
      n++;
      continue;
    }
    if (w.startsWith('pass:') && w.length > 5) {
      add(at + 5, end);
      continue;
    }
    if (w.length === 40 && AWS_SECRET.test(w) && /[A-Z]/.test(w) && /[a-z]/.test(w) && /[0-9]/.test(w)) add(at, end);
  }
}

function genericSkAllowed(text, at, runStarts) {
  if (at === 0 || runStarts.has(at)) return true;
  const before = text.charCodeAt(at - 1);
  const alnum = (before >= 0x30 && before <= 0x39) || (before >= 0x41 && before <= 0x5a) || (before >= 0x61 && before <= 0x7a);
  if (!alnum) return true;
  if (at >= 2 && text[at - 2] === '\\') return true;
  return at >= 3 && text[at - 3] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(at - 2, at));
}

/** Ranges `[start, end)` of one line's plain text to hide, merged, in order. */
function secretRanges(text, runStarts) {
  const ranges = [];
  const add = (start, end) => {
    if (end > start) ranges.push([start, end]);
  };
  if (ANY_PREFIX.test(text)) {
    for (const { re, keep } of PREFIXED) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(text)); ) {
        const kept = typeof keep === 'function' ? keep(m[0]) : keep;
        add(m.index + kept, m.index + m[0].length);
      }
    }
    GENERIC_SK.lastIndex = 0;
    for (let m; (m = GENERIC_SK.exec(text)); ) {
      if (genericSkAllowed(text, m.index, runStarts)) add(m.index + 3, m.index + m[0].length);
    }
    JWT_HEAD.lastIndex = 0;
    for (let m; (m = JWT_HEAD.exec(text)); ) {
      JWT_REST.lastIndex = m.index + m[0].length;
      const rest = JWT_REST.exec(text);
      if (rest) add(m.index + 3, JWT_REST.lastIndex);
    }
  }
  if (/bearer|basic|token/i.test(text)) {
    AUTH_SCHEME.lastIndex = 0;
    for (let m; (m = AUTH_SCHEME.exec(text)); ) {
      if (!/[0-9+/=]/.test(m[1]) && m[1].length < 20) continue;
      add(m.index + m[0].length - m[1].length, m.index + m[0].length);
    }
  }
  if (text.includes('://')) {
    URL_CREDENTIALS.lastIndex = 0;
    for (let m; (m = URL_CREDENTIALS.exec(text)); ) {
      const end = m.index + m[0].length - 1;
      add(end - m[1].length, end);
    }
  }
  if (text.includes('=') || text.includes(':')) scanAssignments(text, add);
  if (WORD_HINT.test(text) || AWS_HINT.test(text)) scanWords(text, add);
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i]);
  }
  return merged;
}

/**
 * The private-key block ranges of one line, given whether the line before
 * was inside one (`pem.inside`, carried line to line). Between BEGIN and END
 * on one line (JSON) everything is hidden; a line inside a block is hidden
 * while it looks like key material — so `grep "BEGIN RSA PRIVATE KEY"`, whose
 * next line is ordinary output, does not hide the rest of the session — and
 * no block runs longer than MAX_KEY_LINES. PuTTY's `Private-Lines: N` hides
 * the N lines after it.
 */
function keyRanges(text, pem) {
  const ranges = [];
  if (pem.ppk > 0) {
    pem.ppk -= 1;
    const material = keyMaterialAt(text);
    if (material) ranges.push(material);
    return ranges;
  }
  if (text.includes('PuTTY-User-Key-File-')) pem.putty = true;
  const ppk = pem.putty ? /Private-Lines: ([0-9]{1,3})\s*$/.exec(text) : null;
  if (ppk) {
    pem.ppk = Number(ppk[1]);
    return ranges;
  }
  let from = 0;
  if (pem.inside) {
    const end = PEM_END.exec(text);
    if (end) {
      // Whatever base64 is left on the END line, before END.
      const material = keyMaterialAt(text.slice(0, end.index), pem.shape ?? null);
      if (material) ranges.push(material);
      pem.inside = false;
      from = end.index + end[0].length;
    } else if ((pem.lines += 1) > MAX_KEY_LINES) {
      pem.inside = false;
    } else {
      const material = keyMaterialAt(text, pem.shape ?? null);
      if (material) {
        ranges.push(material);
        pem.shape = prefixShape(text, material[0]);
        pem.gap = 0;
      } else if (text.trim() !== '' && !KEY_HEADER.test(text) && (pem.gap += 1) >= KEY_GAP_LINES) {
        // Two lines that are not key material: `grep "BEGIN RSA PRIVATE KEY"`
        // and what came after it, not a key. Those lines are not hidden.
        pem.inside = false;
      }
      return ranges;
    }
  }
  for (;;) {
    const rest = text.slice(from);
    const begin = PEM_BEGIN.exec(rest);
    if (!begin) break;
    const bodyStart = from + begin.index + begin[0].length;
    const end = PEM_END.exec(text.slice(bodyStart));
    if (end) {
      if (end.index > 0) ranges.push([bodyStart, bodyStart + end.index]);
      from = bodyStart + end.index + end[0].length;
      continue;
    }
    // The rest of the BEGIN line is the key only when it starts like one
    // (`\nMIIE…` in JSON, base64 straight after) — not `-----BEGIN … KEY----- header`
    // in a log line or a test's message (found in review).
    if (bodyStart < text.length && /^\s*(?:\\[nrt])*[A-Za-z0-9+/=]{16,}/.test(text.slice(bodyStart, bodyStart + 64))) {
      ranges.push([bodyStart, text.length]);
    }
    pem.inside = true;
    pem.lines = 0;
    pem.gap = 0;
    // Each body line has in front of it what BEGIN had (a grep path longer
    // than the key line, a pod's name): that is the shape to look for.
    pem.shape = prefixShape(text, from + begin.index);
    break;
  }
  return ranges;
}

/** Cut `ranges` out of `line`'s runs, `[hidden]` where each began, in that run's attributes. */
function applyRanges(line, ranges) {
  const out = [];
  let offset = 0;
  let r = 0;
  for (const run of line.runs) {
    const runEnd = offset + run.text.length;
    let piece = '';
    for (let i = offset; i < runEnd; ) {
      while (r < ranges.length && ranges[r][1] <= i) r += 1;
      const range = ranges[r];
      if (!range || range[0] >= runEnd) {
        piece += run.text.slice(i - offset);
        break;
      }
      if (i < range[0]) {
        piece += run.text.slice(i - offset, range[0] - offset);
        i = range[0];
      }
      if (i === range[0]) piece += HIDDEN;
      i = Math.min(range[1], runEnd);
    }
    if (piece !== '') out.push({ sgr: run.sgr, text: piece });
    offset = runEnd;
  }
  line.runs = out;
}

function plainOf(line) {
  let text = '';
  const runStarts = new Set();
  for (const run of line.runs) {
    runStarts.add(text.length);
    text += run.text;
  }
  return { text, runStarts };
}

function mergeRanges(ranges) {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i].slice());
  }
  return merged;
}

/**
 * Ranges that never cut a character in two: a mask ending between the two
 * halves of an emoji left a lone surrogate, which the backend refuses to
 * write (serde), so that terminal's every later save failed — a Clear
 * included (found in review).
 */
function wholeCharacters(text, ranges) {
  const low = (i) => {
    const c = text.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  for (const range of ranges) {
    if (range[0] > 0 && low(range[0])) range[0] -= 1;
    if (range[1] < text.length && low(range[1])) range[1] += 1;
  }
  return ranges;
}

/**
 * The rest of a token a program broke onto the next line: the run of token
 * characters that starts `text` after at most four spaces, `=` only as
 * base64's padding at its end. `full`: the line before reached the right
 * margin, so any such run of four or more is taken; otherwise only a line
 * that is nothing but one such run, eight or more long with a letter and a
 * digit and no `.` (`23456789AbCdEf` after `…ghp_…01`), so that a `Done` or
 * a `TERM=xterm-256color` after a token is left alone (found in review: an
 * `env` listing after a token became `[hidden]` line after line).
 * `[start, end)` or null.
 */
function leadingToken(text, full) {
  let start = 0;
  // Claude Code indents what it wraps by five columns, other programs by more or less.
  while (start < 8 && text[start] === ' ') start++;
  const chars = full ? /[A-Za-z0-9_\-+/.]/ : /[A-Za-z0-9_\-+/]/;
  let end = start;
  while (end < text.length && chars.test(text[end])) end++;
  // `=` only as padding: one or two at the very end of the run. One with
  // more after it is a `NAME=value` (found in review: `NODE_VERSION=` hidden
  // after a token that reached the margin).
  let padEnd = end;
  while (padEnd < text.length && padEnd - end < 2 && text[padEnd] === '=') padEnd++;
  if (padEnd > end) {
    if (padEnd < text.length && !isBlankChar(text.charCodeAt(padEnd))) return null;
    end = padEnd;
  }
  const run = text.slice(start, end);
  if (full) return run.length >= 4 ? [start, end] : null;
  const alone = text.slice(end).trim() === '';
  return alone && run.length >= 8 && /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? [start, end] : null;
}

const HEX_KEY_LABEL = /^\s*(?:privateExponent|prime1|prime2|exponent1|exponent2|coefficient|priv):\s*$/;
const HEX_LINE = /^\s*[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){0,31}:?\s*$/;

/** The token prefixes a line can end in when a program broke the token right after it (`TAIL_PREFIX`). */
const TAIL_PREFIX =
  /(?:sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|xox[abposr]-|xapp-|glpat-|hf_|gsk_|whsec_|AKIA|ASIA|AIza|ya29\.|hv[sb]\.|npm_|[sr]k_live_|[sr]k_test_|eyJ|ATATT)/;

/**
 * A token cut by the right margin before it was long enough to recognise
 * (`sk-ant-api03-AbCd` and the rest on the next line): when a line that
 * reaches the margin ends in a run of token characters holding a known
 * prefix, what follows the prefix is hidden and the next line's start is
 * taken as the rest. Only the last 300 characters are looked at — a longer
 * token was recognised whole.
 */
function cutTokenAtEnd(text) {
  let end = text.length;
  while (end > 0 && isBlankChar(text.charCodeAt(end - 1))) end--;
  let start = end;
  while (start > 0 && end - start < 300 && /[A-Za-z0-9_\-.]/.test(text[start - 1])) start--;
  const m = TAIL_PREFIX.exec(text.slice(start, end));
  if (!m) return null;
  return [start + m.index + m[0].length, end];
}

/**
 * Hide the secrets in one logical line, in place. Returns how many were hidden.
 * `pem` carries a private-key block from one line to the next.
 */
export function maskLine(line, pem = { inside: false, lines: 0, gap: 0, ppk: 0 }) {
  const { text, runStarts } = plainOf(line);
  const ranges = wholeCharacters(text, mergeRanges([...secretRanges(text, runStarts), ...keyRanges(text, pem)]));
  if (ranges.length === 0) return 0;
  applyRanges(line, ranges);
  return ranges.length;
}

/**
 * Mask every line, oldest first. Returns how many were hidden in each line.
 *
 * Across lines, three things one line cannot see alone:
 * - a key block (`pem`), which may also have begun above the first line
 *   (`insideKey`: the caller looked further up);
 * - an END with no BEGIN above it — the scrollback dropped the top of the
 *   block — after which the base64 lines right above it are hidden too;
 * - a token a program broke over two lines at the pane's width (Claude Code
 *   and other Ink programs wrap that way, `base64` at 76): when a hidden
 *   token runs to the end of a line that reaches the right margin
 *   (`endCells`, within four columns of `cols`), the run of token characters
 *   that starts the next line is the rest of it.
 */
export function maskLines(lines, { cols = 0, insideKey = false, putty = false, ppk = 0, hexKey: hexAbove = false } = {}) {
  const pem = { inside: insideKey, lines: 0, gap: 0, ppk, shape: null, putty };
  let walkFloor = -1;
  let hexKey = hexAbove;
  const counts = new Array(lines.length).fill(0);
  const plains = [];
  let carry = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { text, runStarts } = plainOf(line);
    plains.push(text);
    const wasInside = pem.inside;
    let ranges = [...secretRanges(text, runStarts), ...keyRanges(text, pem)];
    // `openssl rsa -text`, `openssl ec -text`: the private numbers as hex
    // with colons, under their names; `modulus` and `publicExponent` are public.
    if (hexKey) {
      if (HEX_LINE.test(text)) ranges.push([text.length - text.trimStart().length, text.trimEnd().length]);
      else hexKey = false;
    }
    if (HEX_KEY_LABEL.test(text)) hexKey = true;
    if (carry) {
      const lead = leadingToken(text, carry === 'full');
      if (lead) ranges.push(lead);
    }
    // An END with no BEGIN seen: hide the key material right above it —
    // its short last line too (found in review: stopping at the first line
    // under 16 characters left about one RSA key in four in clear).
    if (!wasInside && PEM_END.test(text) && !PEM_BEGIN.test(text)) {
      // The lines above that end in base64; hidden when most of them are key
      // material on their own (the short last one behind a long prefix is not).
      const block = [];
      const endShape = prefixShape(text, text.search(PEM_END));
      // Never over lines an earlier walk already read: a log of END lines
      // made every one read the 400 above it again (found in review).
      for (let j = i - 1; j > walkFloor && block.length < MAX_KEY_LINES; j--) {
        maskStats.walkSteps += 1;
        const above = plainOf(lines[j]).text;
        if (counts[j] > 0 && above.trim().endsWith(HIDDEN)) {
          block.push({ j, run: null, alone: true });
          continue;
        }
        const run = trailingBase64(above);
        if (!run) {
          if (KEY_HEADER.test(above)) continue;
          break;
        }
        block.push({ j, run, alone: Boolean(keyMaterialAt(above, endShape)) });
      }
      walkFloor = i;
      if (block.length && block.filter((b) => b.alone).length * 3 >= block.length * 2) {
        for (const { j, run } of block) {
          if (!run) continue;
          applyRanges(lines[j], wholeCharacters(plainOf(lines[j]).text, [run]));
          counts[j] += 1;
        }
      }
    }
    const full = cols > 0 && (line.endCells ?? 0) >= cols - 4;
    if (full) {
      const cut = cutTokenAtEnd(text);
      if (cut && cut[1] > cut[0]) ranges.push(cut);
    }
    ranges = wholeCharacters(text, mergeRanges(ranges));
    const trimmedEnd = text.trimEnd().length;
    const toTheEnd = ranges.length > 0 && ranges[ranges.length - 1][1] >= trimmedEnd;
    const cutBeforeTheRest = full && cutTokenAtEnd(text) !== null;
    carry = toTheEnd || cutBeforeTheRest ? (full ? 'full' : 'short') : false;
    if (ranges.length) {
      applyRanges(line, ranges);
      counts[i] = ranges.length;
    }
  }
  return counts;
}

/**
 * What the rows above `row` leave masking in the middle of, read as plain row
 * text (cheap), so a cut never starts inside a secret whose start is just out
 * of the file: a private-key block (a BEGIN among the MAX_KEY_LINES rows
 * above with no END after it), PuTTY's `Private-Lines: N` still running, or
 * openssl's private hex under its name (found in review: each left the lines
 * under the cut in clear).
 */
function stateAbove(buffer, row) {
  const state = { insideKey: false, putty: false, ppk: 0, hexKey: false };
  let pemSeen = false;
  let hexSeen = false;
  let ppkSeen = false;
  for (let y = row - 1; y >= 0 && row - y <= MAX_KEY_LINES; y--) {
    const text = buffer.getLine(y)?.translateToString(true) ?? '';
    if (!pemSeen) {
      if (PEM_END.test(text)) pemSeen = true;
      else if (PEM_BEGIN.test(text)) {
        state.insideKey = !PEM_END.test(text.slice(text.search(PEM_BEGIN)));
        pemSeen = true;
      }
    }
    // openssl's private numbers: hex lines all the way up to their name.
    if (!hexSeen && !HEX_LINE.test(text)) {
      state.hexKey = HEX_KEY_LABEL.test(text);
      hexSeen = true;
    }
    // PuTTY: a `Private-Lines: N` whose N lines run past the cut, under its header.
    if (!ppkSeen) {
      const ppk = /Private-Lines: ([0-9]{1,3})\s*$/.exec(text);
      if (ppk) {
        ppkSeen = true;
        const left = Number(ppk[1]) - (row - y - 1);
        for (let h = y - 1; left > 0 && h >= 0 && y - h <= 20; h--) {
          if ((buffer.getLine(h)?.translateToString(true) ?? '').includes('PuTTY-User-Key-File-')) {
            state.putty = true;
            state.ppk = left;
            break;
          }
        }
      }
    }
    // A PuTTY header just above the cut: its Private-Lines may be below it.
    if (row - y <= 20 && text.includes('PuTTY-User-Key-File-')) state.putty = true;
    if (pemSeen && hexSeen && ppkSeen && row - y > 20) break;
  }
  return state;
}


// ---- The file ------------------------------------------------------------------

/**
 * What `term` would save for `tabId`: the file's text, or null when its
 * normal buffer holds nothing but blanks (the caller then deletes the file —
 * a cleared terminal must not come back with what was cleared).
 *
 * Masked first, then cut to the newest `maxLines` lines and `maxBytes` bytes,
 * the header counted. A line that alone does not fit ends the file there.
 */
export function snapshotTerminal(term, { tabId, now = Date.now(), maxLines = Infinity, maxBytes = MAX_FILE_BYTES } = {}) {
  if (!TAB_ID_PATTERN.test(String(tabId))) return null;
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : Infinity;
  const buffer = term.buffer.normal;
  const { lines, fromRow, context, contextRow } = readNewestLines(term, limit, maxBytes);
  if (lines.length === 0) return null;
  const masked = context ? [context, ...lines] : lines;
  const above = stateAbove(buffer, context ? contextRow : fromRow);
  const counts = maskLines(masked, { cols: term.cols, ...above });
  const hiddenPerLine = context ? counts.slice(1) : counts;
  const encoded = lines.map(encodeLine);

  // The header's numbers are at most this long; reserving for the longest
  // keeps the cut honest without encoding twice.
  const headerFor = (count, hidden) =>
    `${SNAPSHOT_MAGIC}\n${JSON.stringify({ tabId, savedAt: now, cols: term.cols, lines: count, hidden })}\n`;
  const reserve = utf8Length(headerFor(999_999_999, 999_999_999));
  let budget = maxBytes - reserve;
  let first = encoded.length;
  while (first > 0 && encoded.length - first < limit) {
    const cost = utf8Length(encoded[first - 1]) + (first === encoded.length ? 0 : 2);
    if (cost > budget) break;
    budget -= cost;
    first -= 1;
  }
  const kept = encoded.slice(first);
  if (kept.length === 0) return null;
  // Only what is in the file: secrets in lines that were cut are not.
  const hidden = hiddenPerLine.slice(first).reduce((sum, n) => sum + n, 0);
  // Well-formed whatever a program printed: a lone surrogate in the text
  // (an emoji cut by a program, or one this file's masking missed) makes the
  // backend refuse the whole write.
  const raw = headerFor(kept.length, hidden) + kept.join('\r\n');
  const text = typeof raw.toWellFormed === 'function' ? raw.toWellFormed() : raw.replace(/[\u{d800}-\u{dbff}](?![\u{dc00}-\u{dfff}])|(?<![\u{d800}-\u{dbff}])[\u{dc00}-\u{dfff}]/gu, '\u{fffd}');
  return { text, lines: kept.length, hidden, bytes: utf8Length(text) };
}

/**
 * Drop everything from `text` but printable text, SGR (`ESC [ … m`, digits,
 * `;` and `:` only) and LF. Every other escape sequence goes whole — CSI,
 * OSC (to BEL or ST), DCS, SOS, PM, APC (to ST), two- and three-character
 * escapes, their 8-bit C1 forms — and so does every other C0 or C1 control
 * (CR, TAB, BEL and DEL included). A string sequence with no terminator ends
 * at the end of its line, so one bad byte cannot swallow the rest of the file.
 */
export function sanitizeForRestore(text) {
  if (typeof text !== 'string') return '';
  let out = '';
  const n = text.length;
  let i = 0;
  const skipString = (from) => {
    // To BEL, ESC \, or 8-bit ST; never past a LF.
    let j = from;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 0x0a) return j;
      if (c === 0x07 || c === 0x9c) return j + 1;
      if (c === 0x1b && text[j + 1] === '\\') return j + 2;
      j += 1;
    }
    return n;
  };
  const skipCsi = (from, introLength) => {
    // Parameters 0x30–0x3F, intermediates 0x20–0x2F, a final 0x40–0x7E.
    let j = from + introLength;
    const paramsStart = j;
    while (j < n && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j += 1;
    const params = text.slice(paramsStart, j);
    const interStart = j;
    while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j += 1;
    const intermediates = j - interStart;
    if (j < n && text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e) {
      const final = text[j];
      const keep = introLength === 2 && final === 'm' && intermediates === 0 && /^[0-9;:]{0,64}$/.test(params);
      return { end: j + 1, keep: keep ? `\x1b[${params}m` : '' };
    }
    // Malformed: drop what was read, and go on from the byte that broke it.
    return { end: j, keep: '' };
  };
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === '[') {
        const { end, keep } = skipCsi(i, 2);
        out += keep;
        i = end;
      } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        i = skipString(i + 2);
      } else {
        // ESC, any intermediates, one final: `ESC 7`, `ESC c`, `ESC ( B`, `ESC # 8`.
        let j = i + 1;
        while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j += 1;
        if (j < n && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x7e) j += 1;
        i = j;
      }
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      if (code === 0x9b) {
        i = skipCsi(i, 1).end;
      } else if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        i = skipString(i + 1);
      } else {
        i += 1;
      }
      continue;
    }
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) {
      i += 1;
      continue;
    }
    // A run of ordinary characters at once.
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c < 0x20 || c === 0x1b || c === 0x7f || (c >= 0x80 && c <= 0x9f)) break;
      j += 1;
    }
    out += text.slice(i, j);
    i = j;
  }
  return out;
}

function plainHeader(raw) {
  try {
    const header = JSON.parse(raw);
    return header && typeof header === 'object' && !Array.isArray(header) ? header : null;
  } catch (_) {
    return null;
  }
}

/**
 * A file's text, as read back for `tabId`: `{ content, savedAt, lines, hidden }`
 * ready for `restoreText`, or null when it is not one this app wrote for this
 * tab — no format line, another version, a header that does not parse, another
 * tab's id, a time that is not one, or nothing left once filtered. `maxLines`
 * keeps the newest lines (the scrollback setting may have been lowered since).
 */
export function parseSnapshot(fileText, { tabId, now = Date.now(), maxLines = Infinity } = {}) {
  if (typeof fileText !== 'string' || !TAB_ID_PATTERN.test(String(tabId))) return null;
  if (!fileText.startsWith(`${SNAPSHOT_MAGIC}\n`)) return null;
  const headerStart = SNAPSHOT_MAGIC.length + 1;
  const headerEnd = fileText.indexOf('\n', headerStart);
  if (headerEnd === -1 || headerEnd - headerStart > MAX_HEADER_CHARS) return null;
  const header = plainHeader(fileText.slice(headerStart, headerEnd));
  if (!header || header.tabId !== tabId) return null;
  const { savedAt } = header;
  if (!Number.isSafeInteger(savedAt) || savedAt < EARLIEST_SAVE || savedAt > now + FUTURE_SLACK_MS) return null;

  let lines = sanitizeForRestore(fileText.slice(headerEnd + 1)).split('\n');
  while (lines.length && lines[lines.length - 1].replace(/\x1b\[[0-9;:]*m/g, '').trim() === '') lines.pop();
  if (Number.isFinite(maxLines) && maxLines > 0 && lines.length > maxLines) lines = lines.slice(lines.length - Math.floor(maxLines));
  if (lines.length === 0) return null;
  // As the file says; only ever shown, never trusted for anything.
  const hidden = Number.isSafeInteger(header.hidden) && header.hidden >= 0 ? header.hidden : 0;
  return { content: lines.join('\r\n'), savedAt, lines: lines.length, hidden };
}

/**
 * The dim line under restored output: `── Previous output · 6 Nov 2026, 10:42 ──`,
 * the date and time in the user's locale. Short rather than the pane's width:
 * a full-width rule would wrap into two lines in a narrower window.
 */
export function separatorLine(savedAt, locale) {
  let when;
  try {
    when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(savedAt));
  } catch (_) {
    when = new Date(savedAt).toISOString().slice(0, 16).replace('T', ' ');
  }
  return `\x1b[0;2m\u{2500}\u{2500} Previous output \u{00b7} ${sanitizeForRestore(when).replace(/\n/g, ' ')} \u{2500}\u{2500}\x1b[0m`;
}

/**
 * What goes into a new terminal before any of its shell's output.
 *
 * `pushIntoScrollback` (Windows): ConPTY paints by absolute position on a
 * screen it believes is empty, and may clear it as it starts. Restored lines
 * left on the screen would be painted over or erased, so they are moved into
 * the scrollback as `freshScreen` does: `rows - 1` line feeds put the
 * separator on the last line above the screen, then the cursor goes home on
 * an empty screen — where ConPTY thinks it is.
 */
export function restoreText(parsed, { pushIntoScrollback = false, rows = 24, locale } = {}) {
  if (!parsed || typeof parsed.content !== 'string') return '';
  let text = `${parsed.content}\x1b[0m\r\n${separatorLine(parsed.savedAt, locale)}\r\n`;
  if (pushIntoScrollback) {
    const lines = Number.isInteger(rows) && rows > 1 ? rows - 1 : 23;
    text += `${'\n'.repeat(lines)}\x1b[H\x1b[J`;
  }
  return text;
}
