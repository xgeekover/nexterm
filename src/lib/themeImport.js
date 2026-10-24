/**
 * Reading a terminal theme out of a file the user picked (spec P5), and
 * keeping the imported ones (the `terminalCustomThemes` setting).
 *
 * Three formats, each as its own program writes it:
 *
 *   - Ghostty theme files: `palette = N=#rrggbb`, `background = …`,
 *     `foreground`, `cursor-color`, `cursor-text`, `selection-background`.
 *     No extension, as Ghostty's own theme directory ships them.
 *   - Windows Terminal color schemes: one scheme object, a `schemes` list (a
 *     whole settings.json, comments and trailing commas included — Windows
 *     Terminal writes and reads it that way), or a bare list of schemes.
 *   - iTerm2 `.itermcolors`: an XML property list of colour dictionaries
 *     whose components are floats from 0 to 1.
 *
 * The file is something downloaded from somewhere, so everything here treats
 * it as hostile. It is read by the webview's own file input, never by a path
 * the backend opens (src/components/common/ThemeGallery.jsx), and it arrives
 * here as text:
 *
 *   - Over 256 KB is refused before anything is parsed. A theme is a few
 *     hundred bytes; the cap bounds every loop below.
 *   - The property list is read by the small parser in this file, not by the
 *     webview's DOMParser: no external DTD is fetched, no entity is expanded
 *     (so no "billion laughs"), no processing instruction is looked at. It
 *     refuses a DOCTYPE with declarations inside it, `<!ENTITY`, any entity
 *     but XML's five, processing instructions and CDATA. The one DOCTYPE it
 *     lets through is Apple's own property-list line — iTerm2 writes it at the
 *     top of every file it exports, so refusing it would refuse every real
 *     file — and it only checks that line's spelling; it never reads the DTD
 *     the line names.
 *   - A colour must be `#rgb` or `#rrggbb` (Ghostty also writes bare
 *     `rrggbb`), or three floats from 0 to 1. Anything else refuses the theme
 *     and the message names the colour, so the user can see which line.
 *   - Names lose control and direction-changing characters (a right-to-left
 *     override in a name could make "Night.txt" read as something else) and
 *     stop at 60 characters.
 *   - A light background is refused: the app is dark-only on purpose (see the
 *     header of terminalThemes.js), and the reason says so.
 *
 * Every function here is pure and runs in Node; every refusal is a sentence
 * a user can act on, never an exception.
 */
import {
  ANSI_COLOR_KEYS,
  CUSTOM_THEME_PREFIX,
  MAX_CUSTOM_THEMES,
  TERMINAL_THEMES,
  TERMINAL_THEME_IDS,
  THEME_COLOR_KEYS,
} from './terminalThemes.js';

/** The largest file read at all, in bytes. */
export const THEME_FILE_MAX_BYTES = 256 * 1024;

/**
 * The relative luminance (WCAG) above which a background counts as light.
 * Every built-in theme's background is under 0.04; Solarized Light's is 0.91.
 * 0.4 leaves room for every dark-but-not-black theme in the big collections
 * and refuses every light one.
 */
export const LIGHT_BACKGROUND_LUMINANCE = 0.4;

/** The longest name kept, in characters. */
export const THEME_NAME_MAX = 60;

/** The most schemes one file offers to choose from — a list is read by a person. */
const MAX_SCHEMES_OFFERED = 100;
/** iTerm2 nests two deep; anything near this is not a colour preset. */
const PLIST_MAX_DEPTH = 32;
const PLIST_MAX_ELEMENTS = 20000;
const SLUG_MAX = 40;
/** A stored id: the prefix and a slug, with room for a "-N" clash suffix. */
const CUSTOM_ID_RE = /^custom:[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** iTerm2 writes doubles; float noise either side of 0 and 1 is not a reason to refuse. */
const COMPONENT_SLACK = 1e-6;

const NO_COLOURS =
  'No terminal colours were found in it. NexTerm reads Ghostty theme files, Windows Terminal color schemes (.json) and iTerm2 .itermcolors files.';
const NO_WT_SCHEME =
  'No Windows Terminal color scheme was found in it: a scheme has "background", "foreground" and "black" to "brightWhite", and a settings file lists its schemes under "schemes".';
const DEFAULT_NAME = 'Imported Theme';

// ---- Values ------------------------------------------------------------------------

/**
 * `#rgb` or `#rrggbb` as lower-case `#rrggbb`, or null. `bare` also takes
 * `rrggbb` with no `#` (Ghostty's own spelling); never three bare digits,
 * which could as well be a word.
 */
export function normalizeHexColor(value, { bare = false } = {}) {
  if (typeof value !== 'string') return null;
  const hasHash = value.startsWith('#');
  if (!hasHash && !bare) return null;
  const digits = hasHash ? value.slice(1) : value;
  if (/^[0-9a-fA-F]{6}$/.test(digits)) return `#${digits.toLowerCase()}`;
  if (hasHash && /^[0-9a-fA-F]{3}$/.test(digits)) {
    return `#${Array.from(digits, (d) => d + d).join('').toLowerCase()}`;
  }
  return null;
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG relative luminance of a colour, 0 (black) to 1 (white); NaN for no colour. */
export function relativeLuminance(hex) {
  const color = normalizeHexColor(hex);
  if (!color) return NaN;
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(color.slice(i, i + 2), 16) / 255));
  return Math.min(1, 0.2126 * r + 0.7152 * g + 0.0722 * b);
}

const toHex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * Display P3 components as sRGB (CSS Color 4's matrix, linear light), clipped
 * to what sRGB can show. iTerm2 writes P3 when the colour was picked that
 * way; read as sRGB it would come out duller than the user saw it.
 */
function p3ToSrgb(components) {
  const [r, g, b] = components.map(toLinear);
  const linear = [
    1.2249401762805598 * r - 0.22494017628055996 * g,
    -0.04205695470968816 * r + 1.0420569547096882 * g,
    -0.019637554590334432 * r - 0.07863604555063175 * g + 1.0982736001409663 * b,
  ];
  return linear.map((c) => fromLinear(Math.min(1, Math.max(0, c))));
}

/** Control characters and line or paragraph separators: a name is one line, so these become a space. */
const NAME_BREAKS = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{2028}\u{2029}]/gu;

/**
 * What does not show, or changes how what is around it shows, dropped from a
 * name: the bidirectional marks, embeddings, overrides and isolates, and the
 * invisible format characters — zero-width space, soft hyphen, word joiner
 * and invisible operators, the byte-order mark, the combining grapheme
 * joiner, Mongolian and Khmer invisibles, interlinear annotation, musical
 * formatting, tag characters, the Hangul fillers. The set the TERMINALS side
 * bar refuses in a branch name (terminalStatus.js's `BRANCH_REFUSED`, less
 * git's own punctuation); a test holds the two together. Zero-width joiners
 * and variation selectors stay: emoji need them. Lone surrogates go too, and
 * so do two characters fonts draw as nothing or as an empty box: the Braille
 * blank (U+2800) and the object replacement character (U+FFFC).
 */
const NAME_INVISIBLE =
  /[\u{00AD}\u{034F}\u{061C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{3164}\u{FEFF}\u{FFA0}\u{FFF9}-\u{FFFB}\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{D800}-\u{DFFF}\u{2800}\u{FFFC}]/gu;

/**
 * More than this many combining marks on one letter is a smear piled over
 * the card ("Zalgo" text), not a letter: Vietnamese stacks two, the scripts
 * that stack most rarely pass three. Counted per letter, so joiners and
 * skin-tone modifiers put between the marks do not start a new count — they
 * did, and a ZWJ after every four marks let all of them through. The
 * joiners and modifiers themselves are capped the same way: an emoji
 * sequence has one between each two emoji, never a run.
 */
const MARKS_KEPT = 4;
const JOINERS_KEPT = 4;
const JOINER = /[\u{200C}\u{200D}\u{1F3FB}-\u{1F3FF}]/u;
const MARK = /\p{M}/u;

function capMarks(text) {
  let out = '';
  let marks = 0;
  let joiners = 0;
  for (const ch of text) {
    if (MARK.test(ch)) {
      if (marks >= MARKS_KEPT) continue;
      marks += 1;
    } else if (JOINER.test(ch)) {
      if (joiners >= JOINERS_KEPT) continue;
      joiners += 1;
    } else {
      marks = 0;
      joiners = 0;
    }
    out += ch;
  }
  return out;
}

/** The longest stretch of a name looked at: far past what is kept, and the work stays bounded. */
const NAME_SCAN = 16 * 1024;

/**
 * Whether a name shows anything: a letter, a digit, a symbol or a mark of
 * punctuation. A private-use character (`\p{Co}`, a glyph only some icon
 * font has and an empty box everywhere else) is none of these, so a name of
 * nothing else shows nothing.
 */
const showsSomething = (name) => /[\p{L}\p{N}\p{S}\p{P}]/u.test(name);

/** Text from a file cleaned to `max` characters: what `cleanThemeName` does, at another length. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  const cleaned = capMarks(raw.slice(0, NAME_SCAN).replace(NAME_BREAKS, ' ').replace(NAME_INVISIBLE, ''))
    .replace(/\s+/g, ' ')
    .trim();
  const text = Array.from(cleaned).slice(0, max).join('').trim();
  return showsSomething(text) ? text : '';
}

/**
 * A name as it may be shown: control characters become spaces, characters
 * that do not show or turn the text around are dropped, a run of combining
 * marks is cut to a few, runs of space become one, and it stops at 60
 * characters — counted as characters, so an emoji is never cut in half. A
 * name with nothing visible left in it is no name (''), so the caller falls
 * back to another rather than drawing a card with a blank label.
 */
export function cleanThemeName(raw) {
  return cleanText(raw, THEME_NAME_MAX);
}

/**
 * Text from a file — a name, a value, the file's own name — as it may be
 * shown in a sentence: cleaned as a theme name is, and cut to `max`
 * characters with an ellipsis.
 */
export function shownName(value, max = THEME_NAME_MAX) {
  // Cleaned at its own length, not a name's: a JSON error asked for 120
  // characters was cut at 60, mid-sentence and with no ellipsis.
  const chars = Array.from(cleanText(String(value ?? ''), max + 1));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** A value from the file, as a refusal quotes it. */
const shown = (value, max = 24) => shownName(value, max + 1);

/** A JSON value as a refusal quotes it. */
function shownJson(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${shown(value)}"`;
  return shown(JSON.stringify(value) ?? String(value), 32);
}

/** The name a file gives a theme it does not name: its own, less a known extension. */
function baseName(fileName) {
  const name = String(fileName ?? '').split(/[\\/]/).pop();
  return name.replace(/\.(itermcolors|jsonc?|conf|ghostty|txt|theme)$/i, '');
}

/** Bytes of `text` in UTF-8, stopping early once past the cap. */
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= THEME_FILE_MAX_BYTES; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// ---- Ghostty ------------------------------------------------------------------------

const GHOSTTY_KEYS = {
  background: 'background',
  foreground: 'foreground',
  'cursor-color': 'cursor',
  'cursor-text': 'cursorAccent',
  'selection-background': 'selectionBackground',
};

const unquote = (value) => (/^"[^"]*"$/.test(value) ? value.slice(1, -1) : value);

/**
 * Ghostty 1.2 lets the cursor and the selection take the colours of the cell
 * they are on: `cursor-color = cell-foreground`, `selection-background =
 * cell-background`. xterm has no such colour, so these count as not given —
 * the cursor then follows the foreground, the selection the default theme's
 * — rather than refusing a theme over a colour it cannot draw anyway. Only
 * for those keys, as in Ghostty.
 */
const GHOSTTY_CELL_COLOURS = new Set(['cell-foreground', 'cell-background']);
const GHOSTTY_CELL_KEYS = new Set(['cursor-color', 'cursor-text', 'selection-background', 'selection-foreground']);

/**
 * A Ghostty theme file. Only whole-line comments, as in Ghostty; a repeated
 * key keeps its last value, as in Ghostty. Keys a theme does not set
 * (fonts, `selection-foreground`, palette entries past 15) are passed over —
 * a theme file may be a whole config.
 */
function readGhostty(text) {
  const colors = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key === 'palette') {
      const entry = /^(\d{1,3})\s*=\s*(.*)$/.exec(value);
      if (!entry || Number(entry[1]) > 255) {
        return { error: `The palette entry "${shown(value)}" has no colour number from 0 to 255.` };
      }
      const index = Number(entry[1]);
      if (index > 15) continue;
      const color = normalizeHexColor(unquote(entry[2].trim()), { bare: true });
      if (!color) return { error: `palette ${index} "${shown(entry[2])}" is not a colour NexTerm can read: use #rrggbb.` };
      colors[ANSI_COLOR_KEYS[index]] = color;
    } else if (own(GHOSTTY_KEYS, key)) {
      if (GHOSTTY_CELL_KEYS.has(key) && GHOSTTY_CELL_COLOURS.has(value)) {
        delete colors[GHOSTTY_KEYS[key]];
        continue;
      }
      const color = normalizeHexColor(value, { bare: true });
      if (!color) return { error: `${key} "${shown(value)}" is not a colour NexTerm can read: use #rrggbb.` };
      colors[GHOSTTY_KEYS[key]] = color;
    }
  }
  return { candidates: [{ name: '', colors }] };
}

// ---- Windows Terminal --------------------------------------------------------------

const WT_KEYS = {
  background: 'background',
  foreground: 'foreground',
  cursorColor: 'cursor',
  selectionBackground: 'selectionBackground',
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  purple: 'magenta',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  brightBlack: 'brightBlack',
  brightRed: 'brightRed',
  brightGreen: 'brightGreen',
  brightYellow: 'brightYellow',
  brightBlue: 'brightBlue',
  brightPurple: 'brightMagenta',
  brightMagenta: 'brightMagenta',
  brightCyan: 'brightCyan',
  brightWhite: 'brightWhite',
};

/** Deeper than this is no color scheme: Windows Terminal's settings.json nests five deep. */
const JSON_MAX_DEPTH = 64;
class JsonRefusal extends Error {}

/**
 * JSON with comments and trailing commas — what Windows Terminal writes in
 * settings.json — as plain JSON, in one pass over the text. A string is
 * copied as it is, so a `//` inside a URL or a scheme name stays text; a
 * comment becomes a space; a comma with only space before the `]` or `}`
 * after it is dropped. Nesting is counted on the way, and anything deeper
 * than JSON_MAX_DEPTH is refused before `JSON.parse` sees it.
 *
 * One pass, never a rescan: the comment stripping used to look for the next
 * quote again after every comment, and 256 KB of `//` lines took 190 ms — a
 * long task the window froze for.
 */
function plainJson(text) {
  const out = [];
  const n = text.length;
  let depth = 0;
  let from = 0; // start of the stretch not yet copied
  // The last comma, copied as a piece of its own, while only space and
  // comments have followed it: its index in `out`, or -1. A `]` or `}` next
  // empties that piece.
  let comma = -1;
  // The last character that was not space or a comment. A comma straight
  // after `[`, `{` or another comma follows no value: it is left for
  // `JSON.parse` to refuse — dropped, `[,]` read as an empty list.
  let previous = 0;
  const flush = (to) => {
    if (to > from) out.push(text.slice(from, to));
    from = to;
  };
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // A string: copied whole, escapes and all.
      comma = -1;
      previous = c;
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) j += 2;
        else if (d === 0x22) break;
        else j += 1;
      }
      i = j + 1;
    } else if (c === 0x2f && (text.charCodeAt(i + 1) === 0x2f || text.charCodeAt(i + 1) === 0x2a)) {
      // A comment runs to the end of its line — `\n`, or `\r` alone as old
      // Mac files end lines — or to its `*/`. A `/*` never closed is refused:
      // read to the end, it took the scheme's closing brace with it.
      flush(i);
      if (text.charCodeAt(i + 1) === 0x2a) {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) throw new JsonRefusal('It has a comment that is never closed: a "/*" with no "*/" after it.');
        i = close + 2;
      } else {
        let j = i + 2;
        while (j < n && text.charCodeAt(j) !== 0x0a && text.charCodeAt(j) !== 0x0d) j += 1;
        i = j;
      }
      out.push(' ');
      from = i;
    } else if (c === 0x2c) {
      flush(i);
      out.push(',');
      comma = previous === 0x5b || previous === 0x7b || previous === 0x2c || previous === 0 ? -1 : out.length - 1;
      previous = c;
      i += 1;
      from = i;
    } else if (c === 0x5d || c === 0x7d) {
      if (comma >= 0) out[comma] = '';
      comma = -1;
      previous = c;
      depth -= 1;
      i += 1;
    } else if (c === 0x5b || c === 0x7b) {
      comma = -1;
      previous = c;
      depth += 1;
      if (depth > JSON_MAX_DEPTH) throw new JsonRefusal('It is nested more deeply than any color scheme is.');
      i += 1;
    } else {
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
        comma = -1;
        previous = c;
      }
      i += 1;
    }
  }
  flush(n);
  return out.join('');
}

function readWindowsTerminalScheme(scheme, index) {
  const label = `Scheme ${index + 1}`;
  if (!isRecord(scheme)) return { name: label, error: `${label} is not a color scheme.` };
  const name = typeof scheme.name === 'string' && own(scheme, 'name') ? scheme.name : '';
  const colors = {};
  for (const [key, target] of Object.entries(WT_KEYS)) {
    if (!own(scheme, key)) continue;
    const color = normalizeHexColor(scheme[key]);
    if (!color) {
      return { name, error: `"${key}" is not a colour NexTerm can read: ${shownJson(scheme[key])}. Use "#rrggbb".` };
    }
    colors[target] = color;
  }
  return { name, colors };
}

function readWindowsTerminal(text) {
  let data;
  try {
    data = JSON.parse(plainJson(text));
  } catch (err) {
    if (err instanceof JsonRefusal) return { error: err.message };
    return { error: `It is not valid JSON: ${shown(err?.message ?? err, 120)}` };
  }
  let schemes;
  if (Array.isArray(data)) schemes = data;
  else if (isRecord(data) && own(data, 'schemes') && Array.isArray(data.schemes)) schemes = data.schemes;
  else if (isRecord(data) && Object.keys(WT_KEYS).some((key) => own(data, key))) schemes = [data];
  if (!schemes || schemes.length === 0) return { error: NO_WT_SCHEME };
  return { candidates: schemes.slice(0, MAX_SCHEMES_OFFERED).map(readWindowsTerminalScheme), total: schemes.length };
}

// ---- Property lists (iTerm2) ----------------------------------------------------

class PlistRefusal extends Error {}
const refuse = (message) => {
  throw new PlistRefusal(message);
};
const malformed = (detail) => refuse(`It is not a well-formed property list: ${detail}.`);

const APPLE_DOCTYPE =
  /^<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple(?: Computer)?\/\/DTD PLIST 1\.0\/\/EN"\s+"http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>$/;
const XML_DECLARATION =
  /^<\?xml\s+version\s*=\s*(["'])1\.\d\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/;
const START_TAG = /<([A-Za-z_][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>/y;
const REAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

/** The elements a property list is made of. */
const PLIST_ELEMENTS = new Set(['dict', 'array', 'key', 'string', 'real', 'integer', 'true', 'false', 'date', 'data']);
/** The ones whose content is text. */
const TEXT_ELEMENTS = new Set(['key', 'string', 'real', 'integer', 'date', 'data']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Text with XML's five named entities and character references replaced.
 * Any other `&name;` is an entity some DOCTYPE would have had to declare —
 * refused, never looked up.
 */
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf('&', i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    const semi = text.indexOf(';', amp);
    const name = semi > amp && semi - amp <= 12 ? text.slice(amp + 1, semi) : null;
    if (name === null) malformed('it has an "&" that starts no entity');
    if (own(NAMED_ENTITIES, name)) {
      out += NAMED_ENTITIES[name];
    } else if (/^#(?:x[0-9a-fA-F]+|[0-9]+)$/.test(name)) {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      const allowed =
        code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && (code >= 0x20 || code === 0x9 || code === 0xa || code === 0xd);
      if (!allowed) refuse(`It has the character reference "&${shown(name)};", which is not a character.`);
      out += String.fromCodePoint(code);
    } else {
      refuse(`It uses the XML entity "&${shown(name)};", which NexTerm refuses to expand.`);
    }
    i = semi + 1;
  }
  return out;
}

/** The value an element stands for, once it is closed. */
function valueOf(frame) {
  switch (frame.tag) {
    case 'key':
    case 'string':
    case 'date':
    case 'data':
      return frame.text;
    // A number that is not one is kept as NaN here and refused by whoever
    // reads it, so the refusal can name the colour it belongs to.
    case 'real':
      return REAL.test(frame.text.trim()) ? Number(frame.text.trim()) : NaN;
    case 'integer':
      return INTEGER.test(frame.text.trim()) ? Number(frame.text.trim()) : NaN;
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return frame.items.map((item) => item.value);
    case 'dict': {
      // No prototype: a key spelled "__proto__" or "constructor" is a key.
      const dict = Object.create(null);
      if (frame.items.length % 2 !== 0) malformed('a <dict> has a key with no value');
      for (let k = 0; k < frame.items.length; k += 2) {
        if (frame.items[k].tag !== 'key') malformed('a <dict> has a value where a key belongs');
        if (frame.items[k + 1].tag === 'key') malformed('a <dict> has a key where a value belongs');
        dict[frame.items[k].value] = frame.items[k + 1].value;
      }
      return dict;
    }
    default:
      return undefined;
  }
}

function parsePlistOrThrow(input) {
  const text = input.replace(/^\u{FEFF}/u, '');
  // The XML declaration, only first — after a byte-order mark and blank
  // lines, which editors leave and which are no reason to refuse a file:
  // anywhere else `<?` is a processing instruction.
  let i = /^[ \t\r\n]*/.exec(text)[0].length;
  if (text.startsWith('<?xml', i) && /[\s?]/.test(text[i + 5] ?? '')) {
    const declaration = XML_DECLARATION.exec(text.slice(i));
    if (!declaration) malformed('its XML declaration cannot be read');
    i += declaration[0].length;
  }
  const stack = [];
  let root;
  let rootSeen = false;
  let doctypeSeen = false;
  let elements = 0;

  const addText = (chunk) => {
    const top = stack[stack.length - 1];
    if (top && TEXT_ELEMENTS.has(top.tag)) top.text += decodeEntities(chunk);
    else if (/[^ \t\r\n]/.test(chunk)) malformed(`it has text outside a value ("${shown(chunk)}")`);
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    addText(lt < 0 ? text.slice(i) : text.slice(i, lt));
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close < 0) malformed('a comment is never closed');
      i = close + 3;
    } else if (text.startsWith('<?', i)) {
      refuse(`It contains an XML processing instruction ("${shown(text.slice(i, i + 20))}"), which NexTerm refuses to read.`);
    } else if (text.startsWith('<![CDATA[', i)) {
      refuse('It contains a CDATA section, which an .itermcolors file never needs; NexTerm refuses it.');
    } else if (text.startsWith('<!DOCTYPE', i)) {
      const close = text.indexOf('>', i);
      const open = text.indexOf('[', i);
      if (doctypeSeen || stack.length > 0 || rootSeen || close < 0 || (open >= 0 && open < close)) {
        refuse('It declares a document type of its own, with declarations in it. NexTerm reads only the DOCTYPE line iTerm2 writes, and never anything declared inside one.');
      }
      if (!APPLE_DOCTYPE.test(text.slice(i, close + 1))) {
        refuse('It declares a document type other than Apple\'s property list, which NexTerm refuses to read.');
      }
      doctypeSeen = true;
      i = close + 1;
    } else if (text.startsWith('<!', i)) {
      if (/^<!ENTITY/i.test(text.slice(i, i + 8))) refuse('It declares an XML entity, which NexTerm refuses to read.');
      malformed(`it has a declaration NexTerm does not read ("${shown(text.slice(i, i + 12))}")`);
    } else if (text.startsWith('</', i)) {
      END_TAG.lastIndex = i;
      const end = END_TAG.exec(text);
      if (!end) malformed('it has an end tag that cannot be read');
      const frame = stack.pop();
      if (!frame || frame.tag !== end[1]) malformed(`</${shown(end[1])}> closes ${frame ? `<${frame.tag}>` : 'nothing'}`);
      i = END_TAG.lastIndex;
      if (frame.tag === 'plist') {
        if (frame.items.length !== 1) malformed('<plist> must hold exactly one value');
        root = frame.items[0].value;
      } else {
        stack[stack.length - 1].items.push({ tag: frame.tag, value: valueOf(frame) });
      }
    } else {
      START_TAG.lastIndex = i;
      const start = START_TAG.exec(text);
      if (!start) malformed('it has a tag that cannot be read');
      const [, tag, attributes, selfClosing] = start;
      i = START_TAG.lastIndex;
      elements += 1;
      if (elements > PLIST_MAX_ELEMENTS) refuse('It has more elements than any .itermcolors file has.');
      if (tag === 'plist') {
        if (rootSeen || stack.length > 0) malformed('it has a second <plist>');
        rootSeen = true;
        decodeEntities(attributes);
      } else {
        if (!PLIST_ELEMENTS.has(tag)) refuse(`It is not an iTerm2 color preset: it has a <${shown(tag)}> element, which a property list never has.`);
        if (attributes.trim()) malformed(`<${tag}> has attributes`);
        const parent = stack[stack.length - 1];
        if (!parent) malformed(`<${tag}> is outside <plist>`);
        if (!['plist', 'dict', 'array'].includes(parent.tag)) malformed(`<${tag}> is inside <${parent.tag}>`);
        if (tag === 'key' && parent.tag !== 'dict') malformed('a <key> is outside a <dict>');
        if (parent.tag === 'plist' && parent.items.length > 0) malformed('<plist> must hold exactly one value');
      }
      if (stack.length >= PLIST_MAX_DEPTH) refuse('It is nested more deeply than any .itermcolors file is.');
      const frame = { tag, items: [], text: '' };
      if (selfClosing) {
        if (tag === 'plist') malformed('<plist/> holds nothing');
        stack[stack.length - 1].items.push({ tag, value: valueOf(frame) });
      } else {
        stack.push(frame);
      }
    }
  }
  if (stack.length > 0) malformed(`it ends before <${stack[stack.length - 1].tag}> is closed`);
  if (!rootSeen) refuse('It is not a property list: it has no <plist> element.');
  return root;
}

/**
 * An XML property list as plain values — dicts with no prototype, arrays,
 * strings, numbers, booleans — or the reason it was refused.
 */
export function parsePlist(text) {
  if (typeof text !== 'string') return { ok: false, error: 'There is no text to read.' };
  try {
    return { ok: true, value: parsePlistOrThrow(text) };
  } catch (err) {
    if (err instanceof PlistRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

const ITERM_KEYS = {
  'Background Color': 'background',
  'Foreground Color': 'foreground',
  'Cursor Color': 'cursor',
  'Cursor Text Color': 'cursorAccent',
  'Selection Color': 'selectionBackground',
  ...Object.fromEntries(ANSI_COLOR_KEYS.map((key, n) => [`Ansi ${n} Color`, key])),
};

/** One iTerm2 colour dictionary as `#rrggbb`, or why not. */
function readItermColor(dict, name) {
  const problem = (why) => ({ error: `"${name}" is not a colour NexTerm can read: ${why}.` });
  if (!isRecord(dict)) return problem('it is not a colour dictionary');
  const components = [];
  for (const channel of ['Red', 'Green', 'Blue']) {
    const key = `${channel} Component`;
    if (!own(dict, key)) return problem(`it has no ${key}`);
    const value = dict[key];
    if (typeof value !== 'number' || Number.isNaN(value)) return problem(`its ${key} is not a number`);
    if (!(value >= -COMPONENT_SLACK && value <= 1 + COMPONENT_SLACK)) {
      return problem(`its ${key} is ${shown(value)}, not between 0 and 1`);
    }
    components.push(Math.min(1, Math.max(0, value)));
  }
  // "sRGB", "Calibrated" and "Device" are read as they are; "P3" is
  // converted. A Color Space that is not text at all is passed over.
  const space = own(dict, 'Color Space') && typeof dict['Color Space'] === 'string' ? dict['Color Space'] : 'sRGB';
  return { color: toHex(space.trim().toLowerCase() === 'p3' ? p3ToSrgb(components) : components) };
}

function readIterm(text) {
  const parsed = parsePlist(text);
  if (!parsed.ok) return { error: parsed.error };
  if (!isRecord(parsed.value)) return { error: 'It is not an iTerm2 color preset: its property list does not hold a dictionary of colours.' };
  const colors = {};
  for (const [key, target] of Object.entries(ITERM_KEYS)) {
    if (!own(parsed.value, key)) continue;
    const read = readItermColor(parsed.value[key], key);
    if (read.error) return { error: read.error };
    colors[target] = read.color;
  }
  return { candidates: [{ name: '', colors }] };
}

// ---- Every format -------------------------------------------------------------------

function formatOf(text, fileName) {
  const name = String(fileName ?? '').toLowerCase();
  if (name.endsWith('.itermcolors')) return 'iterm2';
  if (name.endsWith('.json') || name.endsWith('.jsonc')) return 'windows-terminal';
  const head = text.trimStart();
  if (head.startsWith('<')) return 'iterm2';
  if (head.startsWith('{') || head.startsWith('[') || head.startsWith('"')) return 'windows-terminal';
  return 'ghostty';
}

/**
 * A scheme's colours as a theme to keep: only the colours the file gave, in
 * a fixed order, with the cursor following the foreground and the text under
 * a block cursor the background where the file says nothing (what Ghostty and
 * iTerm2 do). Everything else is listed in `filled` and comes from the
 * default theme where the theme is drawn (`themeColorsOf`), so a theme kept
 * today follows the default's colours as they are then.
 */
function finishScheme(colors, rawName, fallbackName) {
  const name = cleanThemeName(rawName) || cleanThemeName(fallbackName) || DEFAULT_NAME;
  if (Object.keys(colors).length === 0) return { ok: false, name, error: NO_COLOURS };
  const given = { ...colors };
  if (!given.cursor && given.foreground) given.cursor = given.foreground;
  if (!given.cursorAccent && given.background) given.cursorAccent = given.background;
  const theme = {};
  for (const key of THEME_COLOR_KEYS) if (own(given, key)) theme[key] = given[key];
  if (theme.background && relativeLuminance(theme.background) > LIGHT_BACKGROUND_LUMINANCE) {
    return {
      ok: false,
      name,
      error: `"${name}" has a light background (${theme.background}). NexTerm is dark throughout, so it takes only dark terminal themes: a light terminal would be the one bright rectangle in a dark window.`,
    };
  }
  return { ok: true, name, theme, filled: THEME_COLOR_KEYS.filter((key) => !own(theme, key)) };
}

const TOO_BIG = 'The file is larger than 256 KB, far more than any terminal theme needs.';

/**
 * A file's bytes as text — counted as the file has them, before decoding:
 * decoded first, every byte that is not UTF-8 became a three-byte U+FFFD and
 * a 100 KB file was refused as larger than 256 KB. UTF-8 (with or without a
 * byte-order mark) or UTF-16 with one; anything else is refused as not text,
 * never read with replacement characters into a name.
 */
function decodeThemeBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > THEME_FILE_MAX_BYTES) return { error: TOO_BIG };
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  try {
    return { text: new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { error: utf16 ? 'It is not UTF-16 text, though it starts as if it were.' : 'It is not UTF-8 text, which every theme format NexTerm reads is.' };
  }
}

/**
 * Everything a picked file holds, as themes. `input` is the file's bytes (a
 * Uint8Array or ArrayBuffer, as the file input hands them over) or its text.
 *
 *   { ok: false, error }                        nothing in it can be imported
 *   { ok: true, format, schemes, total }        one scheme or more, each
 *       { ok: true, name, theme, filled } or { ok: false, name, error }
 *
 * A file with one scheme that cannot be imported is `ok: false` with that
 * scheme's reason; a file with several lists them all, refused ones with
 * theirs, so the user can see why one of them is not offered. `total` is how
 * many the file holds: past MAX_SCHEMES_OFFERED only the first are listed,
 * and the user is told so.
 */
export function readThemeFile(input, fileName = '') {
  try {
    let text = input;
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const decoded = decodeThemeBytes(input);
      if (decoded.error) return { ok: false, error: decoded.error };
      text = decoded.text;
    } else if (typeof text !== 'string') {
      return { ok: false, error: 'The file is empty.' };
    } else if (text.length > THEME_FILE_MAX_BYTES || utf8Length(text) > THEME_FILE_MAX_BYTES) {
      return { ok: false, error: TOO_BIG };
    }
    if (text.trim() === '') return { ok: false, error: 'The file is empty.' };
    if (text.includes('\u{0}')) return { ok: false, error: 'It is not a text file.' };
    const body = text.replace(/^\u{FEFF}/u, '');
    const format = formatOf(body, fileName);
    const read = format === 'iterm2' ? readIterm(body) : format === 'windows-terminal' ? readWindowsTerminal(body) : readGhostty(body);
    if (read.error) return { ok: false, error: read.error };
    const fallback = baseName(fileName);
    const schemes = read.candidates.map((candidate) =>
      candidate.error
        ? { ok: false, name: cleanThemeName(candidate.name) || fallback || DEFAULT_NAME, error: candidate.error }
        : finishScheme(candidate.colors, candidate.name, fallback)
    );
    if (schemes.length === 1 && !schemes[0].ok) return { ok: false, error: schemes[0].error };
    return { ok: true, format, schemes, total: read.total ?? schemes.length };
  } catch {
    // Every refusal above is a return; this is a bug, and still not a crash.
    return { ok: false, error: 'NexTerm could not read it.' };
  }
}

// ---- The kept list -------------------------------------------------------------------

/** `custom:<slug>`, with `-2`, `-3`… when that is taken. */
export function customThemeId(name, takenIds = []) {
  const slug =
    String(name ?? '')
      .normalize('NFKD')
      .replace(/[\u{300}-\u{36F}]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/, '') || 'theme';
  const taken = new Set(takenIds);
  let id = `${CUSTOM_THEME_PREFIX}${slug}`;
  for (let n = 2; taken.has(id); n += 1) id = `${CUSTOM_THEME_PREFIX}${slug}-${n}`;
  return id;
}

/**
 * A name no other theme in the gallery shows, built-ins included: "Dracula
 * (2)". A name that already ends in a number in brackets takes the next free
 * one ("Mine (3)"), not a second pair.
 */
/**
 * A name as it reads, for telling two apart: compatibility-normalised (so
 * "Café" typed two ways, or in full-width letters, is one name), without the
 * joiners and variation selectors that change nothing a reader sees, in one
 * case.
 */
const labelKey = (label) =>
  String(label)
    .normalize('NFKC')
    .replace(/[\u{200C}\u{200D}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, '')
    .toLowerCase();

function uniqueLabel(name, customThemes) {
  const taken = new Set(
    [...TERMINAL_THEME_IDS.map((id) => TERMINAL_THEMES[id].label), ...customThemes.map((t) => t.label)].map(labelKey)
  );
  if (!taken.has(labelKey(name))) return name;
  const base = name.replace(/ \(\d+\)$/, '') || name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const label = `${Array.from(base).slice(0, THEME_NAME_MAX - suffix.length).join('').trimEnd()}${suffix}`;
    if (!taken.has(labelKey(label))) return label;
  }
}

/**
 * The list with one more theme — a scheme `readThemeFile` accepted — or why
 * not. Never more than MAX_CUSTOM_THEMES: past it, the user deletes one.
 */
export function addCustomTheme(customThemes, scheme) {
  const list = Array.isArray(customThemes) ? customThemes : [];
  if (!scheme?.ok || !isRecord(scheme.theme)) return { ok: false, error: scheme?.error || 'There is no theme to add.' };
  if (list.length >= MAX_CUSTOM_THEMES) {
    return {
      ok: false,
      error: `You have ${MAX_CUSTOM_THEMES} imported themes, the most NexTerm keeps. Delete one to import another.`,
    };
  }
  const name = cleanThemeName(scheme.name) || DEFAULT_NAME;
  const entry = {
    id: customThemeId(name, list.map((t) => t.id)),
    label: uniqueLabel(name, list),
    theme: { ...scheme.theme },
  };
  return { ok: true, themes: [...list, entry], entry };
}

/** The list without `id` — the same list when there was no such theme. */
export function removeCustomTheme(customThemes, id) {
  const list = Array.isArray(customThemes) ? customThemes : [];
  const next = list.filter((t) => t?.id !== id);
  return next.length === list.length ? list : next;
}

/**
 * The imported themes as read back from storage, keeping only what could
 * have been written by `addCustomTheme`: a list of `{ id, label, theme }`
 * with a `custom:` id, a name, and dark `#rrggbb` colours. Anything else — a
 * hand-edited settings file, an older or newer version's shape — is dropped
 * entry by entry rather than costing the user the whole list, and never
 * throws. Unknown colour keys are dropped, labels cleaned again, at most 20.
 */
export function sanitizeCustomThemes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const ids = new Set();
  for (const item of value) {
    if (out.length >= MAX_CUSTOM_THEMES) break;
    if (!isRecord(item)) continue;
    const { id, label, theme } = item;
    if (typeof id !== 'string' || !CUSTOM_ID_RE.test(id) || ids.has(id)) continue;
    const name = cleanThemeName(label);
    if (!name || !isRecord(theme)) continue;
    const colors = {};
    let valid = true;
    for (const key of THEME_COLOR_KEYS) {
      if (!own(theme, key)) continue;
      const color = normalizeHexColor(theme[key]);
      if (!color) {
        valid = false;
        break;
      }
      colors[key] = color;
    }
    if (!valid || Object.keys(colors).length === 0) continue;
    if (colors.background && relativeLuminance(colors.background) > LIGHT_BACKGROUND_LUMINANCE) continue;
    // Two cards with one name cannot be told apart — nor one named like a
    // built-in: a hand edit gets the same "(2)" an import would.
    out.push({ id, label: uniqueLabel(name, out), theme: colors });
    ids.add(id);
  }
  return out;
}
