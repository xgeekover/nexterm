/**
 * The kitty keyboard protocol, its first flag only: a program that asks gets
 * Shift+Enter, Ctrl+Enter, Esc and Ctrl+letter as keys of their own instead
 * of the bytes they share with other keys.
 *
 * What it is. A program pushes flags onto a stack (`CSI > <flags> u`), pops
 * them (`CSI < <n> u`), sets them (`CSI = <flags> ; <mode> u`) and asks for
 * the current ones (`CSI ? u`, answered `CSI ? <flags> u`). While flag 0b1,
 * "disambiguate escape codes", is on, the keys whose legacy bytes collide go
 * as `CSI <key> ; <modifiers> u`. xterm.js 6.0 has none of it: the protocol
 * is in xterm.js 6.1.0-beta (PR #5600) only, and NexTerm stays on 6.0.0. So
 * the query went unanswered and Shift+Enter reached Claude Code as `\r`.
 *
 * Verified, from the spec and kitty's own encoder
 * (https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/keyboard-protocol.rst,
 * https://raw.githubusercontent.com/kovidgoyal/kitty/master/kitty/key_encoding.c):
 *
 *   - Push with no flags pushes 0; pop with no count pops one; "If a pop
 *     request is received that empties the stack, all flags are reset". Set's
 *     mode 1 (the default) sets the bits given and resets the rest, mode 2
 *     sets the bits given and leaves the rest, mode 3 resets the bits given
 *     and leaves the rest.
 *   - "Terminals must maintain separate stacks for the main and alternate
 *     screens", should limit their size against denial of service, and evict
 *     the oldest entry when a push finds the stack full.
 *   - Under flag 1, Esc, alt+key, ctrl+key, ctrl+alt+key and shift+alt+key
 *     are sent as CSI u. "The only exceptions are the Enter, Tab and
 *     Backspace keys which still generate the same bytes as in legacy mode",
 *     and kitty's encoder makes that exception only for the keys with no
 *     modifier held. So: Enter `\r`, Tab `\t`, Backspace `\x7f` as before;
 *     Shift+Enter `CSI 13;2u`, Ctrl+Enter `CSI 13;5u`, Alt+Enter `CSI 13;3u`,
 *     Shift+Tab `CSI 9;2u`, Ctrl+Backspace `CSI 127;5u`, Esc `CSI 27u`, and
 *     Ctrl+C `CSI 99;5u` — no longer 0x03. The key is its unshifted code
 *     point; the modifiers are 1 plus Shift 1, Alt 2, Ctrl 4.
 *   - A program tells a terminal has the protocol by setting flags and then
 *     asking which are on. So a terminal that applies flag 1 alone must
 *     report flag 1 alone, whatever was pushed.
 *
 * NexTerm's own choices, where the spec is silent or leaves it open:
 *
 *   - Flag 1 only. Every value stored is masked to it, so the reply to
 *     `CSI ? u` never names a flag NexTerm does not apply. Flag 8 ("report
 *     all keys as escape codes") would send text as key events, which the
 *     Korean IME's syllables cannot survive; the others need key-release and
 *     layout data the webview does not give reliably.
 *   - 16 entries per screen. A set on an empty stack makes the entry; a pop of
 *     more entries than there are empties the stack; a sequence with
 *     parameters this does not define (a sub-parameter, an unknown mode, more
 *     parameters than the sequence takes) changes nothing. Un-prefixed `CSI u`
 *     is xterm's restore-cursor and never taken here.
 *   - Guards, as modifyOtherKeys.js has, so that a program that dies without
 *     popping does not leave the shell after it receiving `CSI 99;5u` for
 *     Ctrl+C: leaving the alternate screen empties its stack; RIS (`reset`)
 *     empties both; and the terminal registry empties both at every shell
 *     prompt (OSC 133 D, once xterm has read what came before it) and when a
 *     new shell is bound to the terminal. Claude Code runs on the normal
 *     screen, so the prompt is the guard that covers it. A program that
 *     pushes flags on the normal screen and dies in a shell without OSC 133
 *     keeps them until `reset`.
 *   - Settings ▸ Terminal ▸ Kitty Keyboard Protocol, read at each sequence and
 *     each key: off, `CSI ? u` goes unanswered as before, nothing is tracked
 *     and whatever was held is dropped.
 *   - Which keys: Enter, Tab, Backspace and Esc, and a letter, digit, Space
 *     or US punctuation key with Ctrl or Alt held. Everything else — text,
 *     Shift and a letter, the arrows, F-keys, Home, End, Page Up/Down, Insert,
 *     Delete and the keypad — is left to xterm, whose bytes for them flag 1
 *     does not change (kitty's keypad numbers are out of scope). The key is
 *     named by `event.code`; where xterm's own name for it (`keyCode`, which
 *     follows the layout) disagrees — AZERTY's A sits on KeyQ — the key is
 *     left to xterm rather than sent as another one.
 *   - Never encoded, so the key is xterm's exactly as before: with ⌘ (not a
 *     terminal key on macOS); while an IME composes, a Korean syllable is
 *     pending, or the key is a Hangul key (the Korean input source reports
 *     Ctrl+C as `key: 'ㅊ'`, and xterm still sends it as 0x03); with AltGr;
 *     ⌥ on macOS while Use Option as Meta is off (⌥ types characters there,
 *     and ⌥Enter stays the `ESC CR` agents read as a newline); while a
 *     password prompt is up, so getpass gets the bytes it always got; for
 *     anything but a keydown; and whenever reading the event throws.
 *
 * Not verified, and not claimed: which flags Claude Code and OpenCode push.
 * Claude Code's own page (https://code.claude.com/docs/en/terminal-config)
 * says a terminal with the kitty keyboard protocol "works without setup"
 * from v2.1.269, without saying which flags it pushes. Claude Code 2.1.319
 * asks `CSI ? u` as it starts (tests/adversarial/fixtures/claude-2.1.319-startup.json),
 * and 2.1.289 turns modifyOtherKeys on (level 2) in a terminal that answers
 * it (modifyOtherKeys.js), so both may be on at once: then this encoding wins
 * for the keys it covers, and modifyOtherKeys' Enter stays for the rest. Nor
 * is it verified whether Windows' own ConPTY carries `CSI ? u`, its reply and
 * the CSI u keys between NexTerm and a console program.
 *
 * Three parts:
 *
 *   - `kittySequence`, pure: what a key (a plain descriptor) sends at given
 *     flags — the same table for the keyboard and `nexterm-cli send`.
 *   - `kittyKeySequence`: a KeyboardEvent, with every rule above that keeps a
 *     key xterm's, turned into that descriptor and encoded.
 *   - `installKittyKeyboard`, an xterm addon (disposed with its terminal)
 *     that follows the stacks from the program's output, answers the query,
 *     and hands TerminalView's key handler the sequence to send.
 */
import { isHangulCharacter } from './hangulInlineIme.js';

/** The flags NexTerm applies: 0b1, "disambiguate escape codes", and no other. */
export const KITTY_SUPPORTED_FLAGS = 0b1;

/** How many entries each screen's stack keeps; a push beyond evicts the oldest. */
export const KITTY_STACK_SIZE = 16;

const CSI = '\x1b[';

/** The functional keys flag 1 changes, with their kitty numbers (their C0 code points). */
const FUNCTIONAL_KEYS = Object.freeze({ Enter: 13, Tab: 9, Backspace: 127, Escape: 27 });

/** The same four by `event.code`. The keypad's Enter (`NumpadEnter`) is not one of them. */
const FUNCTIONAL_BY_CODE = Object.freeze({ Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Escape' });

/** The text keys flag 1 changes with Ctrl or Alt held, by `event.code`: what each sends unshifted on a US layout. */
const TEXT_BY_CODE = Object.freeze({
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [`Key${c.toUpperCase()}`, c])),
  ...Object.fromEntries([...'0123456789'].map((c) => [`Digit${c}`, c])),
  Space: ' ',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
});

/** The same keys as xterm names them, by `keyCode` (its Keyboard.ts): what decides whether `code` is trusted. */
const TEXT_BY_KEY_CODE = Object.freeze({
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [c.toUpperCase().charCodeAt(0), c])),
  ...Object.fromEntries([...'0123456789'].map((c) => [c.charCodeAt(0), c])),
  32: ' ',
  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',
  219: '[',
  220: '\\',
  221: ']',
  222: "'",
});

/** Every text key of the table: a lower-case letter, a digit, Space or unshifted US punctuation. */
export const KITTY_TEXT_KEYS = Object.freeze(new Set(Object.values(TEXT_BY_CODE)));

/** Whether `flags` has the one flag NexTerm applies. */
const applies = (flags) => Number.isInteger(flags) && (flags & KITTY_SUPPORTED_FLAGS) !== 0;

/**
 * What a key sends under the kitty keyboard protocol at `flags`, or null where
 * the key's legacy bytes stay.
 *
 * `descriptor.key` is 'Enter', 'Tab', 'Backspace', 'Escape', or one character
 * of `KITTY_TEXT_KEYS` (a letter in lower case: Shift is `descriptor.shift`).
 * At flag 1:
 *
 *   Enter, Tab, Backspace alone   null (`\r`, `\t`, `\x7f`)
 *   Shift+Enter    CSI 13;2u      Alt+Enter          CSI 13;3u
 *   Ctrl+Enter     CSI 13;5u      Ctrl+Shift+Enter   CSI 13;6u
 *   Shift+Tab      CSI 9;2u       Ctrl+Backspace     CSI 127;5u
 *   Esc            CSI 27u        Shift+Esc          CSI 27;2u
 *   Ctrl+C         CSI 99;5u      Ctrl+Shift+C       CSI 99;6u
 *   Alt+A          CSI 97;3u      Shift+Alt+A        CSI 97;4u
 *   Ctrl+Alt+A     CSI 97;7u      A, Shift+A         null (text)
 *
 * Null at flags without flag 1 and for any other key.
 */
export function kittySequence(descriptor, flags) {
  if (!applies(flags) || !descriptor || typeof descriptor !== 'object') return null;
  const { key } = descriptor;
  const shift = descriptor.shift === true;
  const alt = descriptor.alt === true;
  const ctrl = descriptor.ctrl === true;
  const modifiers = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const tail = modifiers > 1 ? `;${modifiers}` : '';
  if (typeof key !== 'string') return null;
  if (Object.hasOwn(FUNCTIONAL_KEYS, key)) {
    if (key !== 'Escape' && modifiers === 1) return null;
    return `${CSI}${FUNCTIONAL_KEYS[key]}${tail}u`;
  }
  if (KITTY_TEXT_KEYS.has(key)) {
    // Text, with or without Shift, is typed as text.
    if (!alt && !ctrl) return null;
    return `${CSI}${key.codePointAt(0)}${tail}u`;
  }
  return null;
}

/** The descriptor's `key` for an event, or null for a key the table does not cover (see the file comment). */
function keyOf(event) {
  const code = typeof event.code === 'string' ? event.code : '';
  if (Object.hasOwn(FUNCTIONAL_BY_CODE, code)) return FUNCTIONAL_BY_CODE[code];
  if (Object.hasOwn(TEXT_BY_CODE, code)) {
    const text = TEXT_BY_CODE[code];
    const named = TEXT_BY_KEY_CODE[event.keyCode];
    // xterm names another key there: the layout is not the one `code` describes.
    if (named !== undefined && named !== text) return null;
    return text;
  }
  // No `code` at all (a synthetic event): the four functional keys by name,
  // never the keypad's.
  if (code === '' && event.location !== 3 && Object.hasOwn(FUNCTIONAL_KEYS, event.key)) return event.key;
  return null;
}

/**
 * What a keydown sends under the kitty keyboard protocol at `flags`, or null
 * when the key is left to xterm — for every rule in the file comment, and
 * whenever reading the event throws.
 *
 * @param {KeyboardEvent} event
 * @param {number} flags                 the active screen's flags
 * @param {object} context
 * @param {boolean} context.mac          running on macOS
 * @param {boolean} context.optionAsMeta xterm's `macOptionIsMeta` for this terminal
 * @param {boolean} context.secret       a password prompt is up (`typingHidden`)
 * @param {string}  context.imePending   the Korean syllable being composed, '' when none
 * @returns {string|null}
 */
export function kittyKeySequence(event, flags, { mac = false, optionAsMeta = false, secret = false, imePending = '' } = {}) {
  try {
    if (!applies(flags) || !event || event.type !== 'keydown') return null;
    if (event.metaKey) return null;
    if (event.isComposing || event.keyCode === 229) return null;
    if (imePending || isHangulCharacter(event.key)) return null;
    if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return null;
    if (secret) return null;
    if (mac && event.altKey && optionAsMeta !== true) return null;
    const key = keyOf(event);
    if (!key) return null;
    return kittySequence({ key, shift: event.shiftKey === true, alt: event.altKey === true, ctrl: event.ctrlKey === true }, flags);
  } catch (err) {
    console.warn('[Terminal] could not encode a key for the kitty keyboard protocol:', err);
    return null;
  }
}

/** A parameter list of one plain number, or null: none given is xterm's [0]. */
function single(params) {
  if (params.length !== 1) return null;
  const [value] = params;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The flags a program set, followed from its output, as an xterm addon so it
 * is disposed with its terminal.
 *
 * Every parser handler is wrapped: one that throws wedges xterm's write queue
 * for good (see mouseReporting.js). Returning false hands a sequence on to
 * whatever else xterm has for it — for `?`, `>`, `<` and `=` with `u`,
 * nothing: xterm.js 6.0 registers no handler for any of them.
 */
class KittyKeyboardAddon {
  constructor({ enabled, mac, imePending }) {
    this._enabled = enabled;
    this._mac = mac === true;
    this._imePending = imePending;
    this._stacks = { normal: [], alternate: [] };
    this._screen = 'normal';
    this._term = null;
    this._disposables = [];
  }

  /** Whether the setting is on; a setting that cannot be read is off, which is how NexTerm was before. */
  _on() {
    try {
      return this._enabled() === true;
    } catch (err) {
      console.warn('[Terminal] could not read the kitty keyboard setting:', err);
      return false;
    }
  }

  /** The active screen's stack, chosen when a sequence is read or a key pressed. */
  _active() {
    return this._term?.buffer?.active?.type === 'alternate' ? this._stacks.alternate : this._stacks.normal;
  }

  /** The active screen's flags, 0 when its stack is empty or the setting is off. */
  get flags() {
    try {
      if (!this._on()) {
        this.reset();
        return 0;
      }
      const stack = this._active();
      return stack.length > 0 ? stack[stack.length - 1] : 0;
    } catch (err) {
      console.warn('[Terminal] could not read the kitty keyboard flags:', err);
      return 0;
    }
  }

  activate(term) {
    this._term = term;
    try {
      this._screen = term.buffer?.active?.type === 'alternate' ? 'alternate' : 'normal';
    } catch {
      // A screen that cannot be read is taken for the normal one.
      this._screen = 'normal';
    }
    const parser = term.parser;
    const guarded = (what, handler) => (params) => {
      try {
        if (!this._on()) {
          this.reset();
          return false;
        }
        return Array.isArray(params) ? handler(params) : false;
      } catch (err) {
        console.warn(`[Terminal] could not handle ${what}:`, err);
        return false;
      }
    };
    const handle = (prefix, what, handler) => {
      this._disposables.push(parser.registerCsiHandler({ prefix, final: 'u' }, guarded(what, handler)));
    };

    // The query, `CSI ? u`: answered `CSI ? <flags> u` with the active
    // screen's flags, out the way xterm's own replies go — through `onData`,
    // not as typed input (as modifyOtherKeys.js answers XTQMODKEYS). A
    // parameter the query does not take makes it not this one.
    handle('?', 'the kitty keyboard query', (params) => {
      if (params.length > 1 || (params.length === 1 && params[0] !== 0)) return false;
      term.input(`${CSI}?${this.flags}u`, false);
      return true;
    });

    // Push, `CSI > <flags> u`: onto the active screen's stack, the oldest
    // entry evicted beyond KITTY_STACK_SIZE.
    handle('>', 'a kitty keyboard push', (params) => {
      const value = single(params);
      if (value === null) return false;
      const stack = this._active();
      stack.push(value & KITTY_SUPPORTED_FLAGS);
      if (stack.length > KITTY_STACK_SIZE) stack.splice(0, stack.length - KITTY_STACK_SIZE);
      return true;
    });

    // Pop, `CSI < <n> u`: n entries, one when none is given (xterm hands
    // that over as [0]); more than there are empties the stack, and so the
    // flags are 0.
    handle('<', 'a kitty keyboard pop', (params) => {
      const value = single(params);
      if (value === null) return false;
      const stack = this._active();
      stack.splice(Math.max(0, stack.length - (value === 0 ? 1 : value)));
      return true;
    });

    // Set, `CSI = <flags> ; <mode> u`: mode 1 (the default) assigns, 2 adds
    // the bits, 3 takes them away — on the top entry, made when the stack is
    // empty.
    handle('=', 'a kitty keyboard set', (params) => {
      if (params.length < 1 || params.length > 2) return false;
      const [value, given = 1] = params;
      if (!Number.isInteger(value) || value < 0 || !Number.isInteger(given)) return false;
      const mode = given === 0 ? 1 : given;
      if (mode < 1 || mode > 3) return false;
      const stack = this._active();
      const current = stack.length > 0 ? stack[stack.length - 1] : 0;
      const next = (mode === 1 ? value : mode === 2 ? current | value : current & ~value) & KITTY_SUPPORTED_FLAGS;
      if (stack.length > 0) stack[stack.length - 1] = next;
      else stack.push(next);
      return true;
    });

    // RIS (`ESC c`, what `reset` sends), from either screen: both stacks.
    // Not consumed — xterm resets the terminal as it always does.
    if (typeof parser.registerEscHandler === 'function') {
      this._disposables.push(
        parser.registerEscHandler({ final: 'c' }, () => {
          try {
            this.reset();
          } catch (err) {
            console.warn('[Terminal] could not follow a reset:', err);
          }
          return false;
        })
      );
    }

    // Back on the normal screen: the alternate stack is gone with it. A
    // change to the normal screen while on the normal screen is xterm's
    // reset (RIS, `term.reset()`), and empties both.
    if (typeof term.buffer?.onBufferChange === 'function') {
      this._disposables.push(
        term.buffer.onBufferChange((buffer) => {
          try {
            const now = buffer?.type === 'alternate' ? 'alternate' : 'normal';
            if (now === 'normal') {
              this._stacks.alternate.length = 0;
              if (this._screen === 'normal') this._stacks.normal.length = 0;
            }
            this._screen = now;
          } catch (err) {
            console.warn('[Terminal] could not follow the screen switch:', err);
          }
        })
      );
    }
  }

  /** Both stacks emptied: the flags are 0 on either screen (the registry's guards). */
  reset() {
    this._stacks.normal.length = 0;
    this._stacks.alternate.length = 0;
  }

  /**
   * What to send for `event` instead of xterm.js's own key, or null. ⌥ as
   * Meta and the Korean syllable are read here, at the key; whether a
   * password prompt is up is the caller's (`context.secret`).
   */
  sequenceFor(event, { secret = false } = {}) {
    try {
      const flags = this.flags;
      if (!applies(flags)) return null;
      return kittyKeySequence(event, flags, {
        mac: this._mac,
        optionAsMeta: this._term?.options?.macOptionIsMeta === true,
        secret: secret === true,
        imePending: this._imePending?.() ?? '',
      });
    } catch (err) {
      console.warn('[Terminal] could not encode a key for the kitty keyboard protocol:', err);
      return null;
    }
  }

  dispose() {
    this.reset();
    for (const d of this._disposables.splice(0)) {
      try {
        d?.dispose?.();
      } catch {
        // the terminal is going anyway
      }
    }
  }
}

/**
 * Follow the kitty keyboard protocol on `term` from now on (see
 * `KittyKeyboardAddon`), so that TerminalView can ask the returned addon what
 * to send for a key (`sequenceFor`) and the registry can empty its stacks
 * (`reset`). Returns null when `term` has no parser to listen to.
 *
 * @param {object} term
 * @param {object} options
 * @param {() => boolean} options.enabled   the setting, read at each sequence and key
 * @param {boolean}       options.mac       running on macOS
 * @param {() => string}  options.imePending the Korean syllable being composed
 */
export function installKittyKeyboard(term, { enabled = () => true, mac = false, imePending = null } = {}) {
  if (typeof term?.parser?.registerCsiHandler !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new KittyKeyboardAddon({
    enabled: typeof enabled === 'function' ? enabled : () => enabled === true,
    mac,
    imePending: typeof imePending === 'function' ? imePending : null,
  });
  term.loadAddon(addon);
  return addon;
}
