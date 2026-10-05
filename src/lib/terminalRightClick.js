/**
 * A right-click in a terminal copies or pastes — Windows Terminal's way, and
 * the default of VS Code's terminal on Windows ("copyPaste").
 *
 * Why it is needed at all: Claude Code (2.1.289) leaves right-click paste to
 * the terminal whenever the terminal names itself xterm.js, as VS Code's
 * terminal does — and NexTerm does too, answering XTVERSION
 * (terminalCompat.js). VS Code pastes on a right-click; NexTerm did nothing
 * with one. So from v0.9.0 a right-click inside Claude Code's full-screen view
 * did nothing at all on Windows, where a right-click is how a terminal
 * pastes.
 *
 * With the setting at 'copyPaste':
 *
 *   - a right-click with a selection on screen copies it and clears it, as
 *     Ctrl+C does on Windows (src/lib/terminalClipboard.js) — so the next
 *     right-click pastes;
 *   - one without pastes the clipboard: its text through xterm's own `paste`,
 *     exactly as Ctrl+V's — bracketed when the program asked for that — or,
 *     when the clipboard holds only an image, an EMPTY bracketed paste. That
 *     is what Ctrl+V sends for an image-only clipboard too (the browser's
 *     paste event carries no text), and OpenCode (measured) reads it as
 *     "attach the image on the clipboard";
 *   - xterm hears nothing of it: no mouse report reaches a program that
 *     tracks the mouse (OpenCode, Claude Code, vim), no word is selected, no
 *     link opens, no context menu appears. Full-screen programs included —
 *     the click is the terminal's, not the program's;
 *   - Shift+right-click is left alone: to xterm, the program and the webview,
 *     exactly as before. (On Windows and Linux xterm itself never reports a
 *     Shift-click — Shift is its "select instead" key — so there it opens the
 *     webview's menu, as every right-click did before.)
 *
 * 'default' changes nothing. It is the default on macOS and Linux, whose own
 * terminals open a menu on a right-click; 'copyPaste' is the default on
 * Windows only.
 *
 * Three parts:
 *
 *   - decisions, pure: `defaultRightClick` (per platform) and
 *     `rightClickAction` (what one press does);
 *   - the clipboard: `readClipboard` asks the backend (`clipboard_read`,
 *     src-tauri/src/commands/clipboard.rs, which says why not the webview)
 *     and `pasteClipboard` hands the answer to xterm;
 *   - `installTerminalRightClick`, the binding: capture-phase listeners on the
 *     terminal's container, as hangulInlineIme.js has them, so a handled
 *     click is stopped before xterm's own listeners — on its element, inside
 *     the container — can see it.
 *
 * Checked in tests/adversarial/terminal_right_click.test.js, and against real
 * xterm with real mouse events by terminal_right_click_headless.test.js.
 */
import { invoke } from './ipc.js';
import { currentPlatform, copyTerminalSelection, hasVisibleSelection } from './terminalClipboard.js';
import { hangulImeFor } from './hangulInlineIme.js';

/** The values the setting takes. Anything else acts as 'default'. */
export const RIGHT_CLICK_BEHAVIORS = Object.freeze(['copyPaste', 'default']);

/**
 * What a right-click does out of the box: what the platform's own terminals
 * do. Windows Terminal, conhost and VS Code's terminal on Windows copy or
 * paste; Terminal.app, iTerm2, GNOME Terminal and Konsole open a menu.
 */
export function defaultRightClick(platform = currentPlatform()) {
  return platform === 'windows' ? 'copyPaste' : 'default';
}

const PASS = Object.freeze({ action: 'pass' });
const COPY = Object.freeze({ action: 'copy' });
const PASTE = Object.freeze({ action: 'paste' });

/**
 * What one mouse press does: `{ action: 'pass' }` when it is not this
 * binding's — another button, the setting at 'default', Shift held — and
 * otherwise `{ action: 'copy' }` with a selection or `{ action: 'paste' }`
 * without one.
 *
 * Whether a program is tracking the mouse does not come into it: the whole
 * point is that a right-click copies or pastes inside OpenCode and Claude
 * Code as it does at a prompt. `hasSelection` should mean a selection the
 * user can see, as Ctrl+C means it — `hasVisibleSelection` in
 * terminalClipboard.js, the find bar's highlighted match excluded.
 */
export function rightClickAction(event, { behavior = 'default', hasSelection = false } = {}) {
  if (!event || event.button !== 2) return PASS;
  if (behavior !== 'copyPaste') return PASS;
  if (event.shiftKey) return PASS;
  return hasSelection ? COPY : PASTE;
}

/**
 * What the clipboard holds, as `{ text, image }`: its text ('' when it holds
 * none) and whether an image is on it. Read by the backend, not the webview —
 * src-tauri/src/commands/clipboard.rs says why. Rejects when the clipboard
 * cannot be read.
 */
export async function readClipboard({ invoke: call = invoke } = {}) {
  const answer = await call('clipboard_read');
  return {
    text: typeof answer?.text === 'string' ? answer.text : '',
    image: answer?.has_image === true,
  };
}

/**
 * Paste what the clipboard holds into `term`, as Ctrl+V would. Returns what
 * went: 'text', 'image' or 'nothing'.
 *
 * Text goes through xterm's own `paste`, the function Ctrl+V's paste event
 * ends in: line breaks become `\r` and the text is bracketed when the program
 * asked for bracketed paste, so a multi-line paste is not run line by line.
 *
 * An image alone is handed over as an EMPTY bracketed paste — `paste('')` —
 * which is what Ctrl+V sends then, and what OpenCode takes as "read the image
 * from the clipboard". Only to a program that asked for bracketed paste: to
 * any other, an empty paste is no paste at all.
 */
export function pasteClipboard(term, { text = '', image = false } = {}) {
  if (typeof text === 'string' && text) {
    term.paste(text);
    return 'text';
  }
  if (image && term.modes?.bracketedPasteMode) {
    term.paste('');
    return 'image';
  }
  return 'nothing';
}

/** Keep `event` from everything after this listener, and from the webview. */
function consume(event) {
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

const installed = new WeakMap();

/** The DOM side, as an xterm addon so it is disposed with its terminal. */
class TerminalRightClickAddon {
  constructor(container, { behavior, isFindOpen, read }) {
    this._container = container;
    this._behavior = behavior;
    this._isFindOpen = isFindOpen;
    this._read = read;
    this._term = null;
    /**
     * The handled press whose other events are still to come: its release,
     * its auxclick and the context menu it opens — in that order on Windows,
     * where the menu follows the release, and menu first on macOS and Linux.
     * Each is stopped once; any new press anywhere starts afresh.
     */
    this._gesture = null;
    this._pasting = Promise.resolve();
    this._removers = [];
    this._warned = new Set();
    this._disposed = false;
  }

  activate(term) {
    this._term = term;
    const container = this._container;
    const view = container.ownerDocument?.defaultView ?? globalThis.window;
    const on = (target, type, handler) => {
      if (!target?.addEventListener) return;
      const guarded = (e) => this._guard(type, () => handler(e));
      target.addEventListener(type, guarded, true);
      this._removers.push(() => target.removeEventListener(type, guarded, true));
    };

    // Any press, anywhere, begins a new gesture. Window capture runs before
    // the container's listeners below, so a handled press is recorded after.
    on(view, 'mousedown', () => {
      this._gesture = null;
    });
    // Capture on the container: before xterm's listeners, which are all on
    // its element inside the container, and after every other binding's
    // capture listener there (the Korean IME, mouse reporting, copy on
    // select) — they were installed first, and still hear the press.
    on(container, 'mousedown', (e) => this._press(e));
    on(container, 'mouseup', (e) => this._follow(e, 'release'));
    on(container, 'auxclick', (e) => this._follow(e, 'auxclick'));
    on(container, 'contextmenu', (e) => this._follow(e, 'menu'));
  }

  /**
   * A press. Anything this binding does not claim — or anything that throws
   * before it does — is left exactly as it came, so xterm handles it as it
   * did before this file existed.
   */
  _press(e) {
    if (!e || e.button !== 2) return;
    const term = this._term;
    const decision = rightClickAction(e, {
      behavior: this._behavior(),
      hasSelection: hasVisibleSelection(term, { findOpen: this._isFindOpen() }),
    });
    if (decision.action === 'pass') return;

    // From here on the click is the terminal's. Cancelled, so the webview
    // neither moves the focus nor starts a selection; stopped, so xterm
    // neither reports it nor readies its context menu.
    this._gesture = { release: true, auxclick: true, menu: true };
    consume(e);
    // xterm focuses itself on a press; this one never reaches it. Focused
    // before copying, which is done through xterm's own copy event.
    this._guard('focus', () => term.focus());
    if (decision.action === 'copy') {
      this._guard('copy', () => {
        // In the terminal's own document, whose focus was just moved.
        copyTerminalSelection(term, { document: this._container.ownerDocument ?? undefined });
        // As Windows Terminal does: the selection goes once copied.
        term.clearSelection();
      });
    } else {
      this._paste();
    }
  }

  /** The release, auxclick or context menu of a handled press: stopped too. */
  _follow(e, part) {
    const gesture = this._gesture;
    if (!gesture?.[part]) return;
    // The menu is the press's own whatever button an engine reports it with;
    // a release or an auxclick has to be the right button's.
    if (part !== 'menu' && e.button !== 2) return;
    gesture[part] = false;
    consume(e);
  }

  /**
   * Read the clipboard and paste it — later, since the read is an IPC call.
   * Each right-click reads for itself: two in a row paste twice, as two
   * Ctrl+Vs do.
   */
  _paste() {
    const term = this._term;
    let reading;
    try {
      reading = Promise.resolve(this._read());
    } catch (err) {
      reading = Promise.reject(err);
    }
    this._pasting = reading
      .then((contents) => {
        if (this._disposed) return;
        // A Korean syllable still being composed (macOS) goes first, as it
        // does ahead of any key composing cannot absorb — the paste follows
        // what was typed.
        hangulImeFor(term)?.flush();
        pasteClipboard(term, contents);
      })
      .catch((err) => console.warn('[Terminal] a right-click could not paste the clipboard:', err));
  }

  /** The last paste a right-click started, settled — for the suites. */
  get pasting() {
    return this._pasting;
  }

  /**
   * Run one of this binding's handlers. A handler that throws is reported
   * once per part, never again, and the event goes on as if this binding were
   * not there — unless it was already claimed, in which case it stays claimed.
   */
  _guard(label, fn) {
    try {
      return fn();
    } catch (err) {
      if (!this._warned.has(label)) {
        this._warned.add(label);
        console.warn(`[Terminal] the right-click binding's ${label} handler failed; ignoring it:`, err);
      }
      return undefined;
    }
  }

  dispose() {
    this._disposed = true;
    for (const remove of this._removers.splice(0)) remove();
    this._term = null;
  }
}

/**
 * Install the binding on a terminal, once, right after `term.open(container)`
 * — after every other binding with capture listeners on `container`, so they
 * still hear a press this one stops.
 *
 * `settings` is the settings store (`getState`), read at every press, so the
 * setting takes effect at once; absent, the setting is this platform's
 * default. `isFindOpen` says whether the find bar is open over this terminal
 * — its highlighted match is a selection, but not one to copy. `read` reads
 * the clipboard; the suites hand in their own.
 */
export function installTerminalRightClick(
  term,
  container,
  { settings = null, platform = currentPlatform(), isFindOpen = () => false, read = readClipboard } = {}
) {
  if (!term || !container) return null;
  const existing = installed.get(term);
  if (existing) return existing;
  const behavior = () => {
    const value = settings?.getState?.()?.terminalRightClick;
    return typeof value === 'string' ? value : defaultRightClick(platform);
  };
  const findOpen = () => {
    try {
      return Boolean(isFindOpen());
    } catch {
      return false;
    }
  };
  const addon = new TerminalRightClickAddon(container, { behavior, isFindOpen: findOpen, read });
  if (typeof term.loadAddon === 'function') term.loadAddon(addon);
  else addon.activate(term);
  installed.set(term, addon);
  return addon;
}

/** The binding installed on `term`, or null. */
export function terminalRightClickFor(term) {
  return (term && installed.get(term)) || null;
}

export default {
  RIGHT_CLICK_BEHAVIORS,
  defaultRightClick,
  rightClickAction,
  readClipboard,
  pasteClipboard,
  installTerminalRightClick,
  terminalRightClickFor,
};
