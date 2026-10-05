/**
 * The focus-out a terminal taken off screen never sent.
 *
 * A program that turns on focus reporting (`CSI ? 1004 h`) hears `CSI I` and
 * `CSI O` from xterm as the terminal's textarea gains and loses DOM focus.
 * OpenCode uses them to notify only while you are elsewhere ("Session done",
 * "Permission needs input"); vim uses them for FocusLost.
 *
 * WebKit fires no `blur` at a focused element that is hidden or detached. So
 * when a pane shows another tab without a click first moving the focus — a
 * new terminal from the keyboard, a command from the palette, a tab the app
 * opens itself — the terminal that had the keyboard goes out of sight, and its
 * program is never told. OpenCode then believes it is still being watched and
 * holds back the notification it exists to send. Measured in the macOS app
 * (2026-10-05): a click on another tab's chip sent `CSI O`, because the
 * mousedown moved the focus first; Ctrl+Shift+` (New Terminal) sent nothing.
 *
 * So this follows what xterm last told the program, and TerminalView asks it
 * to send the `CSI O` xterm would have sent when it takes a terminal off
 * screen (`reportOut`). Only once: a terminal that already reported going out —
 * a real blur — is left alone, and so is one on screen whose textarea still
 * has the focus, where xterm's own events are still true. Off screen counts
 * even when the hidden textarea is still `activeElement`: WebKit clears that
 * lazily and never with a `blur` — guarding on `activeElement` alone, the
 * first version of this sent nothing when a new tab took the pane. Coming back needs
 * nothing: TerminalView focuses the terminal it shows, and xterm reports
 * `CSI I` itself.
 */

const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

/** Whether the terminal is in the document and laid out (not `display: none` anywhere above it). */
function onScreen(term) {
  const el = term.element;
  return Boolean(el?.isConnected) && el.offsetParent !== null;
}

class FocusReportsAddon {
  constructor() {
    // 'in' or 'out' as xterm last reported it; null before any report.
    this._reported = null;
    this._term = null;
    this._disposable = null;
  }

  /** What the program was last told: 'in', 'out', or null. */
  get reported() {
    return this._reported;
  }

  activate(term) {
    this._term = term;
    this._disposable = term.onData((data) => {
      if (data === FOCUS_IN) this._reported = 'in';
      else if (data === FOCUS_OUT) this._reported = 'out';
    });
  }

  /**
   * Tell the program its terminal lost focus, if it asked to be told and was
   * last told the opposite. Returns whether `CSI O` was sent. Never throws.
   */
  reportOut(doc = globalThis.document) {
    try {
      const term = this._term;
      if (!term || this._reported !== 'in' || !term.modes?.sendFocusMode) return false;
      // On screen and still focused — React's development double run of an
      // effect looks like this — xterm reports the blur itself when it
      // comes. Off screen, the textarea may still be `activeElement` (WebKit
      // clears it lazily), but no blur will ever come: report.
      if (term.textarea && doc?.activeElement === term.textarea && onScreen(term)) return false;
      term.input(FOCUS_OUT, false);
      return true;
    } catch (err) {
      console.warn('[Terminal] could not report focus out:', err);
      return false;
    }
  }

  dispose() {
    try {
      this._disposable?.dispose?.();
    } catch {
      // the terminal is going anyway
    }
    this._disposable = null;
    this._term = null;
  }
}

/**
 * Follow `term`'s focus reports from now on (see the file comment). Returns the
 * addon — `reportOut()` sends the focus-out a hidden terminal never got — or
 * null for a terminal that cannot take addons (a test double).
 */
export function installFocusReports(term) {
  if (typeof term?.loadAddon !== 'function' || typeof term.onData !== 'function') return null;
  const addon = new FocusReportsAddon();
  term.loadAddon(addon);
  return addon;
}
