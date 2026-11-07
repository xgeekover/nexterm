/**
 * What `nexterm-cli send` types into a terminal (stage 7): key names and text
 * turned into the bytes a program there expects.
 *
 * The bytes depend on the TARGET terminal's modes, which a program sets and
 * the caller cannot see:
 * - DECCKM (application cursor keys, `CSI ? 1 h`): vim, less and readline in
 *   some setups read the arrows as `ESC O A` rather than `ESC [ A`, and an
 *   arrow sent the wrong way arrives as three stray characters.
 * - modifyOtherKeys (src/lib/modifyOtherKeys.js): OpenCode turns it on and
 *   reads Shift+Enter as `CSI 27;2;13~` (a new line in its prompt) — at level
 *   0 that would be garbage, so it is a plain CR there, as a keyboard sends.
 * - Bracketed paste (`CSI ? 2004 h`): a shell or an editor that asked for it
 *   takes a multi-line text as one paste. One that did not runs each line as
 *   it arrives, so a multi-line text is refused there unless the caller says
 *   `raw` and means it.
 *
 * The text itself is someone else's: control characters (ESC above all — it
 * would let the text carry its own escape sequences, an end-of-paste among
 * them) and the bidi and line-separator characters that make a line read
 * differently from what runs are refused, as stage 5 refuses them in a
 * project command. The zero-width joiner of an emoji is not one of them.
 */

/** The most keys one call may send. */
export const MAX_KEYS = 64;

/** The most text one call may send, in UTF-8 bytes (the backend counts the same). */
export const MAX_TEXT_BYTES = 16 * 1024;

const ESC = '\x1b';
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;

/** Names, lower-cased, to what the key is called below. */
const ALIASES = new Map([
  ['return', 'enter'],
  ['esc', 'escape'],
  ['del', 'delete'],
  ['ins', 'insert'],
  ['bs', 'backspace'],
  ['pgup', 'pageup'],
  ['pgdn', 'pagedown'],
  ['pagedn', 'pagedown'],
  ['arrowup', 'up'],
  ['arrowdown', 'down'],
  ['arrowleft', 'left'],
  ['arrowright', 'right'],
  ['spacebar', 'space'],
]);

/** Keys with nothing to say about modes. */
const PLAIN = new Map([
  ['enter', '\r'],
  ['tab', '\t'],
  ['backspace', '\x7f'],
  ['escape', ESC],
  ['space', ' '],
  ['pageup', `${CSI}5~`],
  ['pagedown', `${CSI}6~`],
  ['insert', `${CSI}2~`],
  ['delete', `${CSI}3~`],
  ['f1', `${SS3}P`],
  ['f2', `${SS3}Q`],
  ['f3', `${SS3}R`],
  ['f4', `${SS3}S`],
  ['f5', `${CSI}15~`],
  ['f6', `${CSI}17~`],
  ['f7', `${CSI}18~`],
  ['f8', `${CSI}19~`],
  ['f9', `${CSI}20~`],
  ['f10', `${CSI}21~`],
  ['f11', `${CSI}23~`],
  ['f12', `${CSI}24~`],
]);

/** The final byte of the cursor keys (and Home/End), which DECCKM sends as SS3 rather than CSI. */
const CURSOR = new Map([
  ['up', 'A'],
  ['down', 'B'],
  ['right', 'C'],
  ['left', 'D'],
  ['home', 'H'],
  ['end', 'F'],
]);

/** xterm's modifier parameter: 1 plus Shift 1, Alt 2, Ctrl 4. */
const modifierParam = ({ shift, alt, ctrl }) => 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);

/** What a name looks like in an error message: short, printable. */
function shown(name) {
  const text = String(name).replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}]/gu, '?');
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

const bad = (message) => ({ error: { code: 'bad_request', message } });

/**
 * One key, `Ctrl+C`, `Shift+Enter`, `Alt+x`, `Up`, `F5`, as bytes for a
 * terminal in `modes`, or `{ error }`.
 */
export function encodeKey(name, modes = {}) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 40) return bad(`not a key: "${shown(name)}"`);
  const parts = name.split('+');
  // `Ctrl++` is Ctrl and the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  const key = parts.pop();
  const mods = { shift: false, alt: false, ctrl: false };
  for (const raw of parts) {
    const m = raw.toLowerCase();
    if (m === 'shift') mods.shift = true;
    else if (m === 'alt' || m === 'option' || m === 'meta') mods.alt = true;
    else if (m === 'ctrl' || m === 'control') mods.ctrl = true;
    else return bad(`unknown modifier "${shown(raw)}" in "${shown(name)}"`);
  }
  if (!key) return bad(`not a key: "${shown(name)}"`);
  const lower = ALIASES.get(key.toLowerCase()) ?? key.toLowerCase();
  const anyMod = mods.shift || mods.alt || mods.ctrl;

  if (lower === 'enter' && anyMod) {
    // As modifyOtherKeys.js's encodeModifiedEnter does for the keyboard: only
    // a chord with Shift or Ctrl becomes `CSI 27;…;13~`; Alt+Enter stays
    // `ESC CR` at every level, the newline OpenCode and Claude Code read.
    if (modes.modifyOtherKeys >= 1 && (mods.shift || mods.ctrl)) return { data: `${CSI}27;${modifierParam(mods)};13~` };
    if (mods.alt && !mods.ctrl && !mods.shift) return { data: `${ESC}\r` };
    return { data: '\r' };
  }
  if (lower === 'tab' && mods.shift && !mods.alt && !mods.ctrl) return { data: `${CSI}Z` };

  if (CURSOR.has(lower)) {
    const final = CURSOR.get(lower);
    if (anyMod) return { data: `${CSI}1;${modifierParam(mods)}${final}` };
    return { data: `${modes.applicationCursorKeys ? SS3 : CSI}${final}` };
  }

  if (PLAIN.has(lower)) {
    if (anyMod && !(mods.alt && !mods.ctrl && !mods.shift)) {
      return bad(`"${shown(name)}" is not a key NexTerm sends with modifiers`);
    }
    return { data: (mods.alt ? ESC : '') + PLAIN.get(lower) };
  }

  // One printable character, with Ctrl and/or Alt.
  if ([...key].length === 1) {
    const ch = key;
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return bad(`not a key: "${shown(name)}"`);
    let out = ch;
    if (mods.ctrl) {
      const upper = ch.toUpperCase();
      const c = upper.codePointAt(0);
      // Ctrl+A … Ctrl+Z and Ctrl+[ \ ] ^ _ are the C0 controls; Ctrl+@ (NUL) is not sent.
      if (c >= 0x41 && c <= 0x5a) out = String.fromCharCode(c - 0x40);
      else if (c >= 0x5b && c <= 0x5f) out = String.fromCharCode(c - 0x40);
      else if (ch === '?') out = '\x7f';
      else return bad(`"${shown(name)}" has no control code`);
    } else if (mods.shift) {
      out = ch.toUpperCase();
    }
    return { data: (mods.alt ? ESC : '') + out };
  }
  return bad(`unknown key "${shown(name)}"`);
}

/**
 * The characters that, right after ESC, start an escape sequence rather than
 * an Alt chord: CSI `[`, OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`, SS3 `O`.
 */
const INTRODUCERS = new Set(['[', ']', 'P', 'X', '^', '_', 'O']);

/**
 * Every key of `keys`, in order, or the first one's `{ error }`.
 *
 * A bare Escape followed by a key that starts an escape sequence, or Alt with
 * one of those keys, is refused: strung together they spell any sequence at
 * all — a fake end of paste, a fake terminal reply, an OSC string — which the
 * text path refuses by refusing ESC (found in review). Named keys (the
 * arrows, F5) still send their own sequences, which are whole.
 */
export function encodeKeys(keys, modes = {}, { afterEscape: before = false } = {}) {
  if (!Array.isArray(keys) || keys.length === 0) return bad('keys must be a list of key names');
  if (keys.length > MAX_KEYS) return bad(`at most ${MAX_KEYS} keys at a time`);
  let data = '';
  // Whether what went before ends in a bare ESC — this call's keys so far,
  // or (`afterEscape`) the last thing sent to this terminal: `send --keys
  // Escape` and then `send "[201~"` reach the program as one sequence too.
  // `endsWith`, not `===`: Alt+Escape is two ESCs (found in review).
  let afterEscape = before;
  for (const name of keys) {
    const one = encodeKey(name, modes);
    if (one.error) return one;
    const startsSequence = (afterEscape && INTRODUCERS.has(one.data[0])) || (one.data.length === 2 && one.data[0] === ESC && INTRODUCERS.has(one.data[1]));
    if (startsSequence) return bad(`"${shown(name)}" after Escape would start an escape sequence, which keys may not spell`);
    afterEscape = one.data.endsWith(ESC);
    data += one.data;
  }
  return { data, endsWithEscape: afterEscape };
}

/** UTF-8 length without encoding. */
function utf8Length(text) {
  let bytes = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Characters refused in sent text: C0 and C1 controls other than tab and the
 * line breaks, DEL, the bidi embeddings, overrides, isolates and marks, the
 * byte-order mark, and the Unicode line and paragraph separators. A lone
 * surrogate is refused too (it cannot cross the IPC whole).
 */
const REFUSED = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{2028}\u{2029}]/u;

/**
 * Text to type, as bytes for a terminal in `modes`, or `{ error }`.
 *
 * One line goes as it is — no Enter is added; send `keys: ["Enter"]` for that,
 * or end the text with one line break, which is Enter.
 * Several lines (LF or CR LF) go as one bracketed paste when the program
 * asked for it, with each line break as CR, as xterm pastes; when it did not,
 * they are refused unless `raw`, which types them as keys — each line break
 * an Enter, each line run as it arrives.
 */
export function encodeText(text, { bracketedPaste = false, raw = false, afterEscape = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return bad('text must be a non-empty string');
  if (!text.isWellFormed()) return bad('text holds a broken character (a lone surrogate)');
  if (utf8Length(text) > MAX_TEXT_BYTES) return bad(`text is over ${MAX_TEXT_BYTES / 1024} KiB`);
  const found = REFUSED.exec(text);
  if (found) {
    const code = found[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return { error: { code: 'refused', message: `text holds U+${code}, which is not sent (a control or direction character)` } };
  }
  // Right after a bare ESC sent to this terminal, text starting with `[`, `]`,
  // `P`… would finish an escape sequence the keys began.
  if (afterEscape && INTRODUCERS.has(text[0])) {
    return { error: { code: 'refused', message: 'text right after Escape would start an escape sequence; wait a moment or send something else first' } };
  }
  const normalized = text.replace(/\r\n?|\n/g, '\r');
  // One line break at the very end is Enter, typed after the text and outside
  // any paste: `echo cmd | nexterm-cli send -` hands over "cmd\n", which was
  // refused wherever the program had not asked for bracketed paste (found in
  // review: cmd.exe).
  const enter = normalized.endsWith('\r') ? '\r' : '';
  const body = enter ? normalized.slice(0, -1) : normalized;
  if (!body.includes('\r')) return { data: body + enter };
  if (bracketedPaste) return { data: `${CSI}200~${body}${CSI}201~${enter}` };
  if (raw) return { data: body + enter };
  return {
    error: {
      code: 'refused',
      message: 'the program in that terminal did not ask for bracketed paste, so each line would run as it arrives; send the lines one at a time, or with --raw to type them as keys',
    },
  };
}
