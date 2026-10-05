/**
 * xterm's modifyOtherKeys, for Enter: a program that asks for it gets
 * Shift+Enter and Ctrl+Enter as keys of their own instead of a plain Enter.
 *
 * What it is. xterm can send a key together with the modifiers held on it,
 * for keys whose usual byte cannot carry them. A program turns that on with
 * XTMODKEYS, `CSI > 4 ; 1 m` (level 2 covers more keys), and off with
 * `CSI > 4 ; 0 m` or `CSI > 4 m`. While it is on, such a key arrives as
 * `CSI 27 ; <modifiers> ; <key> ~` — Shift+Enter as `CSI 27;2;13~`, Ctrl+Enter
 * as `CSI 27;5;13~`, the modifiers counted as for every xterm key: 1, plus 1
 * for Shift, 2 for ⌥/Alt, 4 for Ctrl. xterm.js 6.0 has none of it. The
 * sequence goes unhandled and sets nothing, and Enter is `\r` with Shift or
 * Ctrl held as without them.
 *
 * Why only Enter. Measured on 2026-10-05 with OpenCode 1.18.34 in the macOS
 * dev app. OpenCode's newline keys are Shift+Enter, Ctrl+Enter, ⌥Enter and
 * Ctrl+J, and its submit key is Enter. It turns modifyOtherKeys on as it
 * starts, and asks for the kitty keyboard protocol (`CSI ? u`), which xterm.js
 * 6.0 does not answer either. So Shift+Enter and Ctrl+Enter reached it as `\r`
 * and SUBMITTED the prompt; `CSI 27;2;13~` written to it inserts the newline.
 * Enter is the key xterm.js collapses: three chords leave as one byte. ⌥Enter
 * (`ESC CR`) and Ctrl+J (`LF`) already arrive apart, and ⌥Enter stays `ESC CR`
 * even with this on. xterm would send `CSI 27;3;13~` for it, but `ESC CR` is
 * the newline OpenCode and Claude Code read today. ⌘ is not a terminal key on
 * macOS and is left alone, and nothing is encoded while an IME is composing.
 *
 * Only for a program that asks. Every terminal starts at level 0, where Enter
 * is sent exactly as xterm.js sends it. Claude Code 2.1.289 sends `CSI > 4 m`
 * (off) as it starts, and turns modifyOtherKeys on (level 2) only in a
 * terminal it knows by name or one that answers `CSI ? u`; xterm.js is
 * neither. So it keeps getting `\r` for Shift+Enter, as before.
 *
 * Off again whenever xterm.js goes back to the normal screen: on leaving the
 * alternate one, and on a reset (RIS, which the `reset` command sends). xterm
 * itself does not do this. It is a guard: a full-screen program that crashes
 * before it turns modifyOtherKeys off would leave the shell after it receiving
 * `CSI 27;2;13~` for Shift+Enter. Measured with zsh 5.9: it beeps and types
 * `;2;13~` into the line, so the Enter after `echo aaa` ran `echo aaa;2;13~`,
 * and then `2` and `13~` as commands; bash 3.2 typed `7;2;13~`. A crash
 * handler that puts the screen back but not this setting is covered. A program
 * killed outright leaves the alternate screen up too, until `reset` or
 * `tput rmcup` brings the normal one back, and this goes off with it. A
 * program still running once the alternate screen is gone gets plain Enter
 * again, which is what it had before it asked, until it asks again. One that
 * turns modifyOtherKeys on and dies on the normal screen leaves it on until
 * `reset`.
 *
 * Two parts:
 *
 *   - `encodeModifiedEnter`, pure: what a keydown sends at a given level.
 *   - `installModifyOtherKeys`, an xterm addon (disposed with its terminal)
 *     that follows the level from the program's output, answers XTQMODKEYS,
 *     and hands TerminalView's key handler the sequence to send.
 */

/** XTMODKEYS' number for the modifyOtherKeys resource: `CSI > 4 ; Pv m`. */
const MODIFY_OTHER_KEYS = 4;

/** The values xterm gives modifyOtherKeys: 0 off; 1 and 2 on (2 for more keys). */
const LEVELS = new Set([0, 1, 2]);

const ENTER_CODES = new Set(['Enter', 'NumpadEnter']);

/** The Enter key, main or keypad, whether the event says so by `key`, `code` or `keyCode`. */
function isEnter(event) {
  return event.key === 'Enter' || ENTER_CODES.has(event.code) || event.keyCode === 13;
}

/**
 * What Enter sends under modifyOtherKeys, or null where xterm.js's own Enter is
 * the right one.
 *
 * `CSI 27 ; <modifiers> ; 13 ~` once a program has asked (`level` 1 or 2) and
 * Shift or Ctrl is held:
 *
 *   Shift+Enter    CSI 27;2;13~       Ctrl+Enter         CSI 27;5;13~
 *   ⌥⇧Enter        CSI 27;4;13~       Ctrl+Shift+Enter   CSI 27;6;13~
 *   Ctrl+⌥Enter    CSI 27;7;13~       Ctrl+⌥⇧Enter       CSI 27;8;13~
 *
 * Null for Enter alone and ⌥Enter alone (xterm.js's `\r` and `ESC CR`), with ⌘
 * held, at level 0, for anything but a keydown, and for a key an IME is
 * composing with. The keypad's Enter is Enter here, as it is to xterm.js.
 */
export function encodeModifiedEnter(event, level) {
  if (!(level >= 1) || !event || event.type !== 'keydown') return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.metaKey || !(event.shiftKey || event.ctrlKey) || !isEnter(event)) return null;
  const modifiers = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
  return `\x1b[27;${modifiers};13~`;
}

/**
 * The level a program asked for, followed from its output, as an xterm addon
 * so it is disposed with its terminal.
 *
 * Every parser handler is wrapped: one that throws wedges xterm's write queue
 * for good (see mouseReporting.js). Returning false hands a sequence on to
 * whatever else xterm has for it — for these three, nothing: xterm.js 6.0
 * registers no handler for any of them.
 */
class ModifyOtherKeysAddon {
  constructor() {
    this._level = 0;
    this._disposables = [];
  }

  /** 0 off, 1 or 2 on, as the program last set it. */
  get level() {
    return this._level;
  }

  activate(term) {
    const parser = term.parser;
    const guarded = (what, handler) => (params) => {
      try {
        return Array.isArray(params) ? handler(params) : false;
      } catch (err) {
        console.warn(`[Terminal] could not handle ${what}:`, err);
        return false;
      }
    };

    // XTMODKEYS, `CSI > Pp ; Pv m`. Pp 4 is modifyOtherKeys: Pv 0, 1 or 2
    // sets it, no Pv puts it back to xterm's default, 0. The parser hands
    // `CSI > 4 ; m` over as [4, 0], off as well. A Pv xterm does not define
    // (3, or a sub-parameter list) leaves it as it is.
    //
    // No parameters at all, `CSI > m`, puts every one of xterm's key resources
    // back, modifyOtherKeys included, so that turns it off too. xterm.js hands
    // it over as [0], exactly as it hands `CSI > 0 m` (modifyKeyboard alone),
    // so that one turns it off as well: neither OpenCode nor Claude Code sends
    // it, and off is where Enter has always been. Neither is consumed, and
    // any other Pp is left to xterm.js, which ignores it.
    this._disposables.push(
      parser.registerCsiHandler(
        { prefix: '>', final: 'm' },
        guarded('XTMODKEYS', (params) => {
          if (params.length === 1 && params[0] === 0) this._level = 0;
          if (params[0] !== MODIFY_OTHER_KEYS) return false;
          if (params.length === 1) this._level = 0;
          else if (LEVELS.has(params[1])) this._level = params[1];
          return true;
        })
      )
    );

    // `CSI > 4 n`: xterm's "disable modifyOtherKeys" (its resource value -1),
    // which for Enter is the same as off.
    this._disposables.push(
      parser.registerCsiHandler(
        { prefix: '>', final: 'n' },
        guarded('CSI > 4 n', (params) => {
          if (params[0] !== MODIFY_OTHER_KEYS) return false;
          this._level = 0;
          return true;
        })
      )
    );

    // XTQMODKEYS, `CSI ? 4 m`: answered `CSI > 4 ; <level> m`, out the way
    // xterm's own replies go, through `onData`, not as typed input (as
    // `installXtVersionReply` answers XTVERSION). Any other Pp is not ours.
    this._disposables.push(
      parser.registerCsiHandler(
        { prefix: '?', final: 'm' },
        guarded('XTQMODKEYS', (params) => {
          if (params[0] !== MODIFY_OTHER_KEYS) return false;
          term.input(`\x1b[>${MODIFY_OTHER_KEYS};${this._level}m`, false);
          return true;
        })
      )
    );

    // Back on the normal screen: off (see the file comment). xterm.js reports
    // a reset (RIS, `term.reset()`) as a change to the normal screen too, even
    // from the normal screen. Entering the alternate screen changes nothing,
    // so a program may turn it on before or after.
    if (typeof term.buffer?.onBufferChange === 'function') {
      this._disposables.push(
        term.buffer.onBufferChange((buffer) => {
          try {
            if (buffer?.type === 'normal') this._level = 0;
          } catch (err) {
            console.warn('[Terminal] could not follow the screen switch:', err);
          }
        })
      );
    }
  }

  /** What to send for `event` instead of xterm.js's own key, or null. */
  sequenceFor(event) {
    try {
      return encodeModifiedEnter(event, this._level);
    } catch (err) {
      console.warn('[Terminal] could not encode a modified Enter:', err);
      return null;
    }
  }

  dispose() {
    this._level = 0;
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
 * Follow modifyOtherKeys on `term` from now on (see `ModifyOtherKeysAddon`),
 * so that TerminalView can ask the returned addon what to send for a key
 * (`sequenceFor`). Returns null when `term` has no parser to listen to.
 */
export function installModifyOtherKeys(term) {
  if (typeof term?.parser?.registerCsiHandler !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new ModifyOtherKeysAddon();
  term.loadAddon(addon);
  return addon;
}
