/**
 * Key chords as data: text you can put in a settings file, matched against a
 * real KeyboardEvent.
 *
 * Shortcuts used to be predicates — `(e, ctx) => ctx.isMod && !e.shiftKey &&
 * isLetter(e, 'd')` — which cannot be written down, shown in a settings
 * window, or edited by anyone who is not editing the source. A chord is now a
 * string like `mod+shift+o`, parsed once and matched exactly.
 *
 * Three modifier names, and the difference matters:
 *
 *   mod    the application modifier: ⌘ on macOS, Ctrl everywhere else. Almost
 *          everything the menu advertises uses this.
 *   ctrl   literally Ctrl, on every platform including macOS. Used where a
 *          chord must be the same everywhere (`ctrl+shift+backquote`).
 *   cmd    literally ⌘. Only meaningful on macOS.
 *
 * Matching is EXACT: `mod+d` does not fire when shift is also down, so the
 * table no longer needs the `!e.shiftKey` exclusions that used to keep
 * `mod+shift+d` from being swallowed. The one unavoidable fuzziness is that on
 * Windows and Linux `mod` IS Ctrl, so `mod+b` and `ctrl+b` are the same
 * physical chord there; `conflictsWith` treats them as clashing.
 *
 * Pure: no React, no stores, no `navigator`. The caller says whether the
 * application modifier is down (see `hasMod`), which is also what lets the
 * tests exercise both platforms in one process.
 */

/** Keys whose `event.key` is unreliable, matched on `event.code` instead. */
const CODE_KEYS = {
  backquote: 'Backquote',
  minus: 'Minus',
  equal: 'Equal',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  backslash: 'Backslash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
};

/** Names accepted for keys whose `event.key` is a word rather than a glyph. */
const NAMED_KEYS = {
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
};

const MODIFIERS = new Set(['mod', 'ctrl', 'control', 'shift', 'alt', 'option', 'cmd', 'meta', 'command']);

/**
 * Parse `mod+shift+o` into a chord, or null when it is not a chord at all.
 *
 * Returns null rather than throwing: a settings file is user input, and one
 * bad line must not take the other bindings down with it.
 */
export function parseChord(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const chord = { mod: false, ctrl: false, shift: false, alt: false, cmd: false, key: null, code: null };
  const keyParts = [];

  for (const part of parts) {
    if (!MODIFIERS.has(part)) {
      keyParts.push(part);
      continue;
    }
    if (part === 'mod') chord.mod = true;
    else if (part === 'ctrl' || part === 'control') chord.ctrl = true;
    else if (part === 'shift') chord.shift = true;
    else if (part === 'alt' || part === 'option') chord.alt = true;
    else chord.cmd = true; // cmd | meta | command
  }

  // Exactly one non-modifier key. "mod+shift" is not a shortcut, and
  // "mod+a+b" is a typo rather than a chord.
  if (keyParts.length !== 1) return null;
  const name = keyParts[0];

  if (CODE_KEYS[name]) chord.code = CODE_KEYS[name];
  else if (NAMED_KEYS[name]) chord.key = NAMED_KEYS[name];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) chord.key = name.toUpperCase();
  else if (name.length === 1) chord.key = name;
  else return null;

  return chord;
}

/** The canonical text for a chord — what `parseChord` reads back. */
export function stringifyChord(chord) {
  if (!chord) return '';
  const parts = [];
  if (chord.mod) parts.push('mod');
  if (chord.ctrl) parts.push('ctrl');
  if (chord.cmd) parts.push('cmd');
  if (chord.shift) parts.push('shift');
  if (chord.alt) parts.push('alt');

  let name = chord.key ?? '';
  if (chord.code) {
    const found = Object.entries(CODE_KEYS).find(([, code]) => code === chord.code);
    name = found ? found[0] : chord.code.toLowerCase();
  } else {
    const named = Object.entries(NAMED_KEYS).find(([, key]) => key === chord.key);
    if (named) name = named[0];
    else if (name === ' ') name = 'space';
  }
  parts.push(String(name).toLowerCase());
  return parts.join('+');
}

/** How a chord should be shown to someone on `platform`. */
export function displayChord(chord, { isMac = false } = {}) {
  const parsed = typeof chord === 'string' ? parseChord(chord) : chord;
  if (!parsed) return '';

  const GLYPHS = { mod: '⌘', ctrl: '⌃', cmd: '⌘', shift: '⇧', alt: '⌥' };
  const WORDS = { mod: 'Ctrl', ctrl: 'Ctrl', cmd: 'Cmd', shift: 'Shift', alt: 'Alt' };
  const order = ['ctrl', 'alt', 'shift', 'cmd', 'mod'];
  const shown = order.filter((m) => parsed[m]).map((m) => (isMac ? GLYPHS[m] : WORDS[m]));

  // Punctuation is matched on `code` but has to be SHOWN as the glyph — a
  // menu reading "⌘Comma" tells the user to press a key that is not on the
  // keyboard.
  const DISPLAY_KEYS = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    ' ': 'Space', Escape: 'Esc', Enter: 'Enter',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  let name = parsed.code ?? parsed.key ?? '';
  name = DISPLAY_KEYS[name] ?? (name.length === 1 ? name.toUpperCase() : name);

  shown.push(name);
  return isMac ? shown.join('') : shown.join('+');
}

/**
 * Does `e` press this chord?
 *
 * `isMod` is what `hasMod(e)` said — ⌘ on macOS, Ctrl elsewhere. Every
 * modifier is matched exactly, with one allowance: where `mod` is Ctrl, a
 * chord using `mod` cannot also demand that Ctrl be up.
 */
export function chordMatches(chord, e, isMod) {
  if (!chord || !e) return false;

  if (Boolean(chord.mod) !== Boolean(isMod)) {
    // The two may disagree in exactly one situation: the chord names the
    // physical key that HAPPENS to be the application modifier on this
    // platform. `ctrl+shift+backquote` pressed on Windows arrives with isMod
    // true because there mod IS Ctrl; `cmd+r` pressed on macOS arrives with
    // isMod true because there mod IS ⌘. Neither is a mismatch.
    const namesTheAppModifier =
      (chord.ctrl && Boolean(e.ctrlKey)) || (chord.cmd && Boolean(e.metaKey));
    if (!(isMod && !chord.mod && namesTheAppModifier)) return false;
  }
  if (chord.ctrl && !e.ctrlKey) return false;
  if (chord.cmd && !e.metaKey) return false;
  if (Boolean(chord.shift) !== Boolean(e.shiftKey)) return false;
  if (Boolean(chord.alt) !== Boolean(e.altKey)) return false;

  // Ctrl must be UP unless something in the chord accounts for it: `ctrl`
  // asked for it, or `mod` is Ctrl on this platform.
  if (!chord.ctrl && !chord.mod && e.ctrlKey) return false;
  // Same for ⌘, which `mod` accounts for on macOS.
  if (!chord.cmd && !chord.mod && e.metaKey) return false;

  if (chord.code) return e.code === chord.code;
  if (typeof e.key !== 'string') return false;
  return e.key.toLowerCase() === String(chord.key).toLowerCase();
}

/**
 * The chord a keypress represents, for recording one in the settings window.
 * Returns null while only modifiers are held — there is nothing to bind yet.
 */
export function chordFromEvent(e, { isMod = false } = {}) {
  const key = e?.key;
  if (typeof key !== 'string') return null;
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Dead'].includes(key)) return null;

  const chord = {
    mod: Boolean(isMod),
    ctrl: Boolean(e.ctrlKey) && !isMod,
    cmd: false,
    shift: Boolean(e.shiftKey),
    alt: Boolean(e.altKey),
    key: null,
    code: null,
  };

  const knownCode = Object.values(CODE_KEYS).includes(e.code);
  if (knownCode) chord.code = e.code;
  else if (key.length === 1) chord.key = key.toLowerCase();
  else chord.key = key;
  return chord;
}

/**
 * Would these two chords fire on the same keypress?
 *
 * Not simple equality: on Windows and Linux `mod` and `ctrl` are the same
 * physical key, so `mod+b` and `ctrl+b` collide there while looking different.
 * Checked on both platforms, because a conflict on either is a conflict.
 */
export function conflictsWith(a, b) {
  const first = typeof a === 'string' ? parseChord(a) : a;
  const second = typeof b === 'string' ? parseChord(b) : b;
  if (!first || !second) return false;
  if (first.shift !== second.shift || first.alt !== second.alt) return false;
  if ((first.code ?? first.key) !== (second.code ?? second.key)) return false;

  const holds = (chord, isMac) => ({
    ctrl: chord.ctrl || (chord.mod && !isMac),
    meta: chord.cmd || (chord.mod && isMac),
  });
  for (const isMac of [true, false]) {
    const x = holds(first, isMac);
    const y = holds(second, isMac);
    if (x.ctrl === y.ctrl && x.meta === y.meta) return true;
  }
  return false;
}
