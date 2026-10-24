/**
 * A paste of several lines is held for a question first — VS Code's
 * `terminal.integrated.enableMultiLinePasteWarning`.
 *
 * Why: a program that has not turned bracketed paste on (`CSI ? 2004 h`)
 * cannot tell a paste from typing, so every line break in it is an Enter.
 * cmd never turns it on. A block copied from a README into cmd therefore runs
 * line by line as it arrives — the first lines already running before the
 * user has seen what the rest would do, with no way to take them back. A
 * program that did ask for bracketed paste (zsh, bash 5.1 and later,
 * OpenCode, Claude Code) gets the block as one paste and decides for itself,
 * so by default ('auto') only the others are asked about.
 *
 * Bracketed paste is only as good as its end marker. xterm 6.0 pastes text
 * as it finds it, so a copied `echo safe ESC[201~` followed by a second line
 * closed the bracket early and ran that line — with no question, since the
 * program had asked for bracketed paste. So the markers are taken out of
 * everything pasted (`withoutPasteMarkers`, as Windows Terminal does), and
 * under 'auto' a paste with an escape character in it is asked about as if
 * the program had not asked for bracketed paste.
 *
 * Three parts, as in terminalRightClick.js:
 *
 *   - decisions, pure: `pastedLines`, `pasteWarning` (whether to ask),
 *     `asOneLine` (what "Paste as One Line" sends) and `withoutPasteMarkers`;
 *   - the binding: `installPasteWarning` puts a capture-phase `paste`
 *     listener on the terminal's container, ahead of xterm's own on its
 *     textarea and element — the browser's paste, which is what Ctrl+V,
 *     Shift+Insert, ⌘V and the macOS Edit menu all end in — and `hold`, which
 *     the right-click paste (`pasteClipboard`) asks before it pastes;
 *   - the question itself is the caller's: `ask` resolves with 'paste',
 *     'oneLine' or 'cancel' (the app's is src/stores/pastePromptStore.js,
 *     drawn by PasteWarningDialog.jsx), and `withdraw` takes it back when
 *     the terminal closes while it is up.
 *
 * The text pasted after the question is the text captured when the paste
 * happened, never the clipboard read again — the user may have copied
 * something else while the dialog was up. If the program turned bracketed
 * paste on or off while the question was up, the answer was to another
 * question, and it is asked again.
 *
 * Not asked about, on purpose: files dropped on a pane (`pasteIntoTerminal`
 * in terminalRegistry.js, which calls xterm's `paste` directly — one line of
 * paths, never several), and the EMPTY paste an image-only clipboard makes,
 * which OpenCode reads as "attach the image on the clipboard": it has no
 * lines, so it is never held, and nothing is taken out of it.
 *
 * Checked in tests/adversarial/paste_warning.test.js.
 */

import { isWindows10Conpty } from './terminalCompat.js';

/** The values the setting takes. Anything else acts as 'auto'. */
export const PASTE_WARNING_MODES = Object.freeze(['auto', 'always', 'never']);

/** What a question about a paste can be answered with. */
export const PASTE_CHOICES = Object.freeze(['paste', 'oneLine', 'cancel']);

const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = /\r\n|\r|\n/g;
const TRAILING_BREAK = /(?:\r\n|\r|\n)$/;
const PASTE_MARKERS = /\x1b\[20[01]~/g;

/**
 * `text` without ONE line break at its end. A line copied from an editor or
 * a browser comes with its own, and that is not a second line.
 */
export function withoutTrailingBreak(text) {
  return typeof text === 'string' ? text.replace(TRAILING_BREAK, '') : '';
}

/**
 * How many lines of `text` would run, once one line break at its end is
 * dropped: those with something other than spaces on them. A line of only
 * spaces is an Enter at an empty prompt, and is neither counted nor shown.
 * A Tab is not a space here: cmd and every readline shell complete on it, and
 * the Enter after it runs what was completed (review, 2026-10-11 — `trim()`
 * had made `"echo one\n\t\n"` paste unasked). CRLF, LF and a lone CR all end
 * a line, as xterm's `paste` takes all three as Enter.
 */
export function pastedLines(text) {
  if (typeof text !== 'string' || text === '') return { lines: 0 };
  const lines = withoutTrailingBreak(text).split(LINE_BREAK);
  return { lines: lines.filter((line) => /[^ ]/.test(line)).length };
}

/**
 * `text` without bracketed paste's start and end markers, `ESC[200~` and
 * `ESC[201~` — taken out until none is left, so one cannot be put back
 * together from the pieces around another.
 */
export function withoutPasteMarkers(text) {
  if (typeof text !== 'string') return '';
  let clean = text;
  for (let next = clean.replace(PASTE_MARKERS, ''); next !== clean; next = clean.replace(PASTE_MARKERS, '')) {
    clean = next;
  }
  return clean;
}

/**
 * Whether pasting `text` should be asked about first: `{ lines, bracketed,
 * escape }` for the question — `escape` when the text carries an escape
 * character — or null to paste at once.
 *
 *   'never'   never asked
 *   'always'  asked for every paste of two or more lines that would run
 *   'auto'    the same, but only while the program has NOT turned bracketed
 *             paste on — or the text carries an escape character, which a
 *             bracket cannot be trusted to hold — the default, and what any
 *             unknown value means
 *
 * `bracketed` is whether a bracketed paste reaches the program as one: xterm's
 * own `term.modes.bracketedPasteMode`, and the markers getting through
 * (`pasteMarkersArrive`). `markersLost` says the program asked for it and the
 * markers do not get through — asked about as if it had not, and said so.
 */
export function pasteWarning(text, { mode = 'auto', bracketed = false, markersLost = false } = {}) {
  if (mode === 'never') return null;
  const { lines } = pastedLines(text);
  if (lines < 2) return null;
  const escape = text.includes('\x1b');
  const trusted = Boolean(bracketed) && !markersLost;
  if (mode !== 'always' && trusted && !escape) return null;
  return { lines, bracketed: trusted, escape, markersLost: Boolean(markersLost) };
}

/**
 * Whether bracketed paste's markers reach the program through this pty.
 *
 * On Windows they go through ConPTY's input, and Windows 10's console host
 * does not pass them on: Git Bash (bash 5.2, bracketed paste on, and xterm's
 * mode on with it) ran the first of two pasted lines the moment it arrived,
 * under Auto, without a question — the very case the question is for (V38).
 * So on Windows 10, and on Windows of a build not yet known, a program's
 * asking for bracketed paste is not taken as a reason not to ask. Windows 11
 * (build 22000 on) is left as it was: not measured either way.
 * `windowsPty` is the terminal's own option (`windowsPtyFor`); off Windows it
 * is unset, and the markers arrive.
 */
export function pasteMarkersArrive(windowsPty) {
  return !isWindows10Conpty(windowsPty);
}

/**
 * What "Paste as One Line" sends: the line break at the end dropped and every
 * other one made a single space, so the program gets one line it runs once.
 */
export function asOneLine(text) {
  return withoutTrailingBreak(text).replace(LINE_BREAKS, ' ');
}

/** The question's title. */
export function pastePromptTitle(lines) {
  return `Paste ${lines} lines?`;
}

/** The question's text, for a program that did or did not ask for bracketed paste. */
export function pastePromptMessage({ bracketed = false, escape = false, markersLost = false } = {}) {
  if (markersLost) {
    return 'The program in this terminal asked for bracketed paste, but this version of Windows does not pass it on to the program, so each line runs as a command as soon as it is pasted — the next one starting before you can see what the last one did.';
  }
  if (bracketed && escape) {
    return 'The program in this terminal asked for bracketed paste, but these lines carry an escape sequence, which can end a bracketed paste early and run the lines after it as commands.';
  }
  if (bracketed) {
    return 'The program in this terminal asked for bracketed paste, so it receives these lines as one paste and decides what to do with them.';
  }
  return 'The program in this terminal did not ask for bracketed paste, so each line runs as a command as soon as it is pasted — the next one starting before you can see what the last one did. cmd never asks for it.';
}

/**
 * Give the keyboard back to `element` if it is still on the page; false if
 * it cannot take it — or it is the page itself, which had nothing to give.
 */
function refocus(element) {
  if (!element || typeof element.focus !== 'function' || element.isConnected === false) return false;
  if (element === element.ownerDocument?.body) return false;
  element.focus();
  return true;
}

const installed = new WeakMap();

/**
 * `{ bracketed, markersLost }` for `pasteWarning`, as `term` stands now: the
 * program's bracketed paste, and whether its markers get through this pty.
 */
function bracketingOf(term) {
  const asked = Boolean(term?.modes?.bracketedPasteMode);
  const arrive = pasteMarkersArrive(term?.options?.windowsPty);
  return { bracketed: asked && arrive, markersLost: asked && !arrive };
}

/** The binding, as an xterm addon so it is disposed with its terminal. */
class PasteWarningAddon {
  constructor(container, { mode, ask, withdraw }) {
    this._container = container;
    this._mode = mode;
    this._ask = ask;
    this._withdraw = withdraw;
    this._term = null;
    this._removers = [];
    this._answering = Promise.resolve();
    this._asking = 0;
    this._disposed = false;
  }

  activate(term) {
    this._term = term;
    const container = this._container;
    if (!container?.addEventListener) return;
    // Capture on the container: before xterm's listeners, which are on its
    // textarea and its element, both inside the container. A paste this
    // holds or cleans never reaches them; any other goes on as it came.
    const onPaste = (e) => {
      try {
        this._paste(e);
      } catch (err) {
        console.warn('[Terminal] the multi-line paste check failed; pasting as usual:', err);
      }
    };
    container.addEventListener('paste', onPaste, true);
    this._removers.push(() => container.removeEventListener('paste', onPaste, true));
  }

  /**
   * The browser's paste. Held, and kept from xterm and the webview, when it
   * is to be asked about; pasted here, cleaned, when it carries a paste
   * marker; and otherwise — the empty image paste included — left to xterm
   * exactly as it came.
   */
  _paste(e) {
    const text = e?.clipboardData?.getData?.('text/plain') ?? '';
    if (text === '') return;
    const claimed = this.hold(text) || this._pasteCleaned(text);
    if (!claimed) return;
    e.preventDefault?.();
    e.stopImmediatePropagation?.();
  }

  /** Paste `text` without its markers when it had any; false when it had none (xterm pastes it). */
  _pasteCleaned(text) {
    const clean = withoutPasteMarkers(text);
    if (clean === text) return false;
    if (clean) this._term?.paste(clean);
    return true;
  }

  /**
   * Whether `text` is held for the question. When it is, it is pasted later,
   * as the answer says. When it is not, the caller pastes it now — without
   * its markers. `returnFocusTo` is what had the keyboard before the paste
   * moved it (a right-click focuses the terminal): Cancel gives it back; a
   * paste leaves it in the terminal.
   */
  hold(text, { returnFocusTo = null } = {}) {
    const term = this._term;
    if (this._disposed || !term || typeof this._ask !== 'function') return false;
    const question = pasteWarning(text, { mode: this._mode(), ...bracketingOf(term) });
    if (!question) return false;
    let answer;
    try {
      answer = Promise.resolve(this._ask(question));
    } catch (err) {
      answer = Promise.reject(err);
    }
    this._asking += 1;
    this._answering = answer
      .then((choice) => {
        this._asking -= 1;
        return this._deliver(text, question, choice, returnFocusTo);
      })
      .catch((err) => {
        this._asking = Math.max(0, this._asking - 1);
        console.warn('[Terminal] the multi-line paste question failed; nothing was pasted:', err);
      });
    return true;
  }

  _deliver(text, question, choice, returnFocusTo) {
    const term = this._term;
    if (this._disposed || !term) return 'gone';
    if (choice !== 'paste' && choice !== 'oneLine') {
      if (!refocus(returnFocusTo)) term.focus?.();
      return 'cancel';
    }
    // The program turned bracketed paste on or off while the question was
    // up: the answer was to another question. Asked again, or — when the
    // new state needs no question — pasted as answered.
    if (bracketingOf(term).bracketed !== question.bracketed && this.hold(text, { returnFocusTo })) {
      return 'asked again';
    }
    // Through xterm's own `paste`, as its paste listener would have sent it:
    // line breaks as Enter, bracketed if the program asked — the markers out.
    const clean = withoutPasteMarkers(choice === 'oneLine' ? asOneLine(text) : text);
    if (clean) term.paste(clean);
    term.focus?.();
    return choice;
  }

  /** The last question this terminal asked, settled — for the suites. */
  get answering() {
    return this._answering;
  }

  dispose() {
    this._disposed = true;
    for (const remove of this._removers.splice(0)) remove();
    // A question still up is about a terminal that is gone: Paste would do
    // nothing, and say nothing about it.
    if (this._asking > 0) {
      try {
        this._withdraw?.();
      } catch (err) {
        console.warn('[Terminal] could not take back the multi-line paste question:', err);
      }
    }
    this._term = null;
  }
}

/**
 * Install the check on a terminal, once, right after `term.open(container)`.
 *
 * `settings` is the settings store (`getState`), read at every paste, so the
 * setting takes effect at once; absent, the setting is 'auto'. `ask(question)`
 * puts `{ lines, bracketed }` to the user and resolves with one of
 * PASTE_CHOICES; without it nothing is ever held. `withdraw()` takes the
 * question back when the terminal is disposed while it is up.
 */
export function installPasteWarning(term, container, { settings = null, ask = null, withdraw = null } = {}) {
  if (!term || !container) return null;
  const existing = installed.get(term);
  if (existing) return existing;
  const mode = () => {
    try {
      const value = settings?.getState?.()?.terminalMultiLinePasteWarning;
      return PASTE_WARNING_MODES.includes(value) ? value : 'auto';
    } catch {
      return 'auto';
    }
  };
  const addon = new PasteWarningAddon(container, { mode, ask, withdraw });
  if (typeof term.loadAddon === 'function') term.loadAddon(addon);
  else addon.activate(term);
  installed.set(term, addon);
  return addon;
}

/** The check installed on `term`, or null. */
export function pasteWarningFor(term) {
  return (term && installed.get(term)) || null;
}

export default {
  PASTE_WARNING_MODES,
  PASTE_CHOICES,
  withoutTrailingBreak,
  pastedLines,
  withoutPasteMarkers,
  pasteWarning,
  pasteMarkersArrive,
  asOneLine,
  pastePromptTitle,
  pastePromptMessage,
  installPasteWarning,
  pasteWarningFor,
};
