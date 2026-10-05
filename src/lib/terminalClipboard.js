/**
 * Selecting, copying and pasting in a terminal — Warp's way, on every platform.
 *
 * The request: "drag to select a sentence and copy it, and paste reliably" —
 * including inside a TUI. What stood in the way, per platform:
 *
 *   - everywhere: a program that turns mouse tracking on took every drag, and
 *     Claude Code turns it on at its main prompt. Nothing in it could be
 *     selected. src/lib/mouseReporting.js now gives the mouse to full-screen
 *     programs only, and Shift-drag selects inside those (⌥-drag too on macOS).
 *   - Windows: xterm turns Ctrl+V into ^V and Ctrl+C into ^C and cancels both,
 *     so WebView2 never pasted or copied — and to Claude Code, ^V means "paste
 *     an image". There is no Edit menu off macOS to fall back on.
 *   - macOS: ⌘C and ⌘V already work, through the native Edit menu: its Paste
 *     arrives as a `paste` event on xterm's textarea (which xterm brackets
 *     when the program asked for bracketed paste), its Copy as a `copy` event
 *     xterm fills with the selection. Nothing here adds a second path.
 *
 * And, as in Warp, a selection is copied the moment the mouse makes it
 * ("Copy on Select", on by default).
 *
 * Three parts:
 *
 *   - decisions, pure: `clipboardKeyAction` (which chord does what on which
 *     platform), `pressSelects` / `shouldCopyOnSelect` (when a selection is
 *     copied). Checked in tests/adversarial/terminal_clipboard.test.js.
 *   - `handleClipboardKey`, which TerminalView's custom key handler calls
 *     first — xterm has one such slot and TerminalView owns it.
 *   - `installTerminalClipboard`, the mouse side, installed once per terminal
 *     by terminalRegistry.js. It installs mouse reporting as well.
 */
import { isMac, isWindows } from './platform.js';
import { installMouseReporting, pressForcesSelection } from './mouseReporting.js';

/** 'mac' | 'windows' | 'linux' — which chords this platform uses for the clipboard. */
export function currentPlatform() {
  if (isMac) return 'mac';
  if (isWindows) return 'windows';
  return 'linux';
}

const PASS = Object.freeze({ action: 'pass' });
const PASTE = Object.freeze({ action: 'paste' });
const COPY_AND_CLEAR = Object.freeze({ action: 'copy', clearSelection: true });
const COPY_AND_KEEP = Object.freeze({ action: 'copy', clearSelection: false });

/**
 * The letter on the key: `event.key`, or the US-layout letter of `event.code`
 * when the layout reports something else — a Russian layout reports Ctrl+V as
 * 'м', a Korean one may report a jamo. A Latin `event.key` wins, so on Dvorak
 * the key printed V is the one that pastes, wherever it sits.
 */
function letterOf(event) {
  const key = typeof event.key === 'string' ? event.key : '';
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  const match = /^Key([A-Z])$/.exec(typeof event.code === 'string' ? event.code : '');
  return match ? match[1].toLowerCase() : '';
}

/**
 * What a key does to the clipboard, or `{ action: 'pass' }` when it is not a
 * clipboard chord here.
 *
 *              paste                                   copy (needs a selection)
 *   macOS      ⌘V (the Edit menu)                      ⌘C (the Edit menu)
 *   Windows    Ctrl+V, Ctrl+Shift+V, Shift+Insert      Ctrl+C, Ctrl+Shift+C, Ctrl+Insert
 *   Linux      Ctrl+Shift+V, Shift+Insert              Ctrl+Shift+C, Ctrl+Insert
 *
 * Windows is Windows Terminal's table, and like it a copy there also clears
 * the selection — which is what lets the NEXT Ctrl+C interrupt again. Every
 * copy chord needs a selection, same as Windows Terminal: nothing selected
 * passes the key through instead — Ctrl+C is ^C, as it always was, and
 * Ctrl+Shift+C / Ctrl+Insert are left for whatever (if anything) they would
 * otherwise do, rather than silently copying nothing. Plain Ctrl+V and Ctrl+C
 * stay the shell's on Linux, as in GNOME Terminal and Konsole. Claude Code
 * pastes an image with Alt+V on Windows, so Ctrl+V pasting text costs it
 * nothing.
 *
 * `{ action: 'paste' }` is done by the browser's own paste, so the caller lets
 * the key through untouched; `{ action: 'copy', clearSelection }` is done by
 * the caller. Only keydown counts, and never a key the IME is composing with,
 * nor anything with Alt (Ctrl+Alt is AltGr on Windows: a character, not a
 * chord) or ⌘. `hasSelection` should already mean a selection the user can
 * actually see — `hasVisibleSelection` below is what the caller means by it.
 */
export function clipboardKeyAction(event, { platform = 'linux', hasSelection = false } = {}) {
  if (!event || event.type !== 'keydown') return PASS;
  if (event.isComposing || event.keyCode === 229) return PASS;
  if (platform === 'mac') return PASS;
  if (event.altKey || event.metaKey) return PASS;

  const ctrl = Boolean(event.ctrlKey);
  const shift = Boolean(event.shiftKey);
  const windows = platform === 'windows';
  const copy = windows ? COPY_AND_CLEAR : COPY_AND_KEEP;

  if (event.key === 'Insert') {
    if (shift && !ctrl) return PASTE;
    if (ctrl && !shift) return hasSelection ? copy : PASS;
    return PASS;
  }
  if (!ctrl) return PASS;
  const letter = letterOf(event);
  if (letter === 'v') return shift || windows ? PASTE : PASS;
  if (letter === 'c') return hasSelection && (shift || windows) ? copy : PASS;
  return PASS;
}

/**
 * Copy the terminal's selection, inside the user gesture that asked for it.
 *
 * First choice: `document.execCommand('copy')` while xterm's textarea has
 * focus. That fires the `copy` event xterm already handles — it puts the
 * selection on the clipboard itself — with no change of focus (the Korean IME
 * binding sends its syllable on blur) and no Clipboard-API permission, which
 * WebKit grants only in some contexts. A listener here makes sure the text
 * lands even if xterm stands aside, and tells whether the event happened at
 * all. If it did not — no focus, or the gesture has expired (Chromium keeps a
 * mouse press's activation for a few seconds) — `navigator.clipboard`.
 *
 * Returns 'copied', 'async' (handed to the Clipboard API), 'empty' or 'failed'.
 */
export function copyTerminalSelection(
  term,
  { document: doc = globalThis.document, clipboard = globalThis.navigator?.clipboard } = {}
) {
  const text = typeof term?.getSelection === 'function' ? term.getSelection() : '';
  if (!text) return 'empty';
  const textarea = term.textarea;
  if (doc && textarea && doc.activeElement === textarea && typeof doc.execCommand === 'function') {
    let delivered = false;
    // On the document, so it runs after xterm's own listener on its element.
    const onCopy = (e) => {
      if (!e.defaultPrevented && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
      delivered = Boolean(e.defaultPrevented);
    };
    doc.addEventListener('copy', onCopy);
    try {
      doc.execCommand('copy');
    } catch {
      // Not allowed here; the Clipboard API below.
    } finally {
      doc.removeEventListener('copy', onCopy);
    }
    if (delivered) return 'copied';
  }
  if (typeof clipboard?.writeText === 'function') {
    // Called here, in the gesture — not from a promise callback, which WebKit
    // may no longer count as part of it.
    try {
      clipboard.writeText(text)?.catch?.((err) => console.warn('[Terminal] could not copy the selection:', err));
      return 'async';
    } catch (err) {
      console.warn('[Terminal] could not copy the selection:', err);
    }
  }
  return 'failed';
}

/**
 * Does the terminal have a selection worth treating as "the user has
 * something to copy" — one actually on screen right now, not merely
 * somewhere in the scrollback.
 *
 * `term.hasSelection()` alone is true for either: a selection scrolled out of
 * the viewport (made earlier, then scrolled past) copies instead of
 * interrupting a program the user meant to Ctrl+C, invisibly: nothing the
 * user can see changes, but the clipboard does. `findOpen` is for the other
 * way a selection can be there unasked: the find bar highlights its current
 * match with `term.select()` — the very same call a drag makes
 * (`@xterm/addon-search`) — so while it is open, a "selection" is the match,
 * not something to copy.
 *
 * Without `term.getSelectionPosition()` or the buffer/row fields it is
 * compared against (an older xterm, or a test double) this cannot be told,
 * so a plain selection counts — as it always did before this existed.
 */
export function hasVisibleSelection(term, { findOpen = false } = {}) {
  if (findOpen) return false;
  if (!term?.hasSelection?.()) return false;
  const range = typeof term.getSelectionPosition === 'function' ? term.getSelectionPosition() : null;
  const viewportY = term.buffer?.active?.viewportY;
  const rows = term.rows;
  if (!range || !Number.isFinite(viewportY) || !Number.isFinite(rows)) return true;
  // Absolute buffer rows, all 0-based — `viewportY` as `IBuffer.getLine`
  // counts, and the selection as xterm 6 really reports it. Its typings call
  // `IBufferCellPosition.y` 1-based, but `getSelectionPosition` hands over the
  // selection model's own rows, which `select()` takes 0-based: measured in
  // Chromium, a drag over the top row of a fresh terminal reports y 0. Read
  // as 1-based, a selection on the top row counted as off screen (Ctrl+C
  // interrupted instead of copying it) and the row below the bottom as on.
  const top = viewportY;
  const bottom = viewportY + rows - 1;
  return range.end.y >= top && range.start.y <= bottom;
}

/**
 * The clipboard part of TerminalView's custom key handler. Returns undefined
 * when the key is not a clipboard chord here — the caller carries on — and
 * otherwise what the handler must return to xterm: false, so xterm neither
 * sends ^V / ^C nor cancels the key.
 *
 * A paste is the browser's: with the key left uncancelled, WebView2 (and
 * WebKitGTK) paste into xterm's textarea, xterm gets the `paste` event and
 * sends the text — bracketed, when the program asked for that. A copy is done
 * here, and the key cancelled so nothing else acts on it. `findOpen` is the
 * caller's to supply — see `hasVisibleSelection`.
 */
export function handleClipboardKey(
  term,
  event,
  { platform = currentPlatform(), copy = copyTerminalSelection, findOpen = false } = {}
) {
  const decision = clipboardKeyAction(event, {
    platform,
    hasSelection: hasVisibleSelection(term, { findOpen }),
  });
  if (decision.action === 'pass') return undefined;
  if (decision.action === 'copy') {
    copy(term);
    if (decision.clearSelection) term?.clearSelection?.();
    event.preventDefault?.();
  }
  return false;
}

/**
 * Does this press start a SELECTION — rather than a click the program gets?
 * Only the primary button selects; while a program tracks the mouse, only a
 * press that forces selection does (see `pressForcesSelection`).
 */
export function pressSelects(event, { mac = false, tracking = false } = {}) {
  if (!event || (event.button ?? 0) !== 0) return false;
  return !tracking || pressForcesSelection(event, { mac });
}

/**
 * Copy on select: when the mouse is released at the end of a press that
 * selected (a drag, a double- or triple-click, a Shift-click extending the
 * selection), copy what is selected.
 *
 * Tied to the gesture, not to xterm's selection-change event: a search match
 * is a selection too, and the find bar must not overwrite the clipboard with
 * every match it steps to. And not merely to "something is selected": a click
 * a full-screen program receives leaves an old selection standing, and
 * copying it again on every click would put back text the user had since
 * replaced on the clipboard.
 */
export function shouldCopyOnSelect({ enabled = true, selecting = false, hasSelection = false } = {}) {
  return Boolean(enabled) && Boolean(selecting) && Boolean(hasSelection);
}

/**
 * Make xterm read a macOS Shift-press as ⌥ — its own "select anyway" modifier.
 *
 * xterm's `shouldForceSelection` is Shift on Windows and Linux but only ⌥ on
 * macOS, so without this a Shift-drag inside vim went to vim. Shadowing the
 * event's `altKey` (a prototype getter) keeps everything else about the press
 * — it is still trusted, still the same click count for a double-click, the
 * same position — and changes nothing for listeners that already ran.
 */
function pressAsOption(event) {
  try {
    Object.defineProperty(event, 'altKey', { configurable: true, get: () => true });
  } catch {
    // A press that cannot be relabelled goes to the program, as before.
  }
}

const installed = new WeakMap();

/** The mouse side. See `installTerminalClipboard`. */
class TerminalClipboardAddon {
  constructor(container, { platform, setting, onSettingsChange, mouse }) {
    this._container = container;
    this._platform = platform;
    this._setting = setting;
    this._onSettingsChange = onSettingsChange;
    this._mouse = mouse;
    this._selecting = false;
    this._removers = [];
  }

  activate(term) {
    const mac = this._platform === 'mac';
    const unsubscribe = this._onSettingsChange?.();
    if (typeof unsubscribe === 'function') this._removers.push(unsubscribe);
    const tracking = () => (term.modes?.mouseTrackingMode ?? 'none') !== 'none';

    if (mac) {
      // iTerm2's convention: ⌥-drag selects inside a program that has the
      // mouse. Only then — elsewhere ⌥-drag stays xterm's column selection,
      // and a quick ⌥-click still has to move the cursor, as any click does.
      // Both are needed together: with `macOptionClickForcesSelection` alone,
      // `altClickMovesCursor` (on by default) still runs its OWN mouseup
      // handling of a forced-selection ⌥-click underneath it and sends
      // xterm's `moveToCellSequence` — on the alternate screen, cursor-key
      // presses (tmux recalls old commands on a quick ⌥-click, htop moves its
      // selection bar). So it is off exactly while the other is on, and back
      // to whatever it was otherwise.
      //
      // Both are `term.options` writes, and addon-webgl re-uploads its whole
      // glyph atlas texture on every one — so they are set only when the
      // mouse's EFFECTIVE tracking state actually changes, from the one place
      // that knows that (`mouse.onTrackingChange`), and only if the value
      // differs, never from a mousedown that changes nothing.
      this._defaultAltClickMovesCursor = Boolean(term.options?.altClickMovesCursor ?? true);
      const applyMacOptionBehavior = (isTracking) => {
        if (!term.options) return;
        if (term.options.macOptionClickForcesSelection !== isTracking) {
          term.options.macOptionClickForcesSelection = isTracking;
        }
        const altClickMovesCursor = isTracking ? false : this._defaultAltClickMovesCursor;
        if (term.options.altClickMovesCursor !== altClickMovesCursor) {
          term.options.altClickMovesCursor = altClickMovesCursor;
        }
      };
      applyMacOptionBehavior(this._mouse ? this._mouse.isTracking : tracking());
      if (typeof this._mouse?.onTrackingChange === 'function') {
        this._removers.push(this._mouse.onTrackingChange(applyMacOptionBehavior));
      }
    }

    const on = (target, type, handler) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler, true);
      this._removers.push(() => target.removeEventListener(type, handler, true));
    };
    const view = this._container.ownerDocument?.defaultView ?? globalThis.window;

    // Any press starts a new gesture; a press outside this terminal is not one
    // of its selections. Window capture runs before the container's below.
    on(view, 'mousedown', () => {
      this._selecting = false;
    });

    // Capture on the container: before xterm's own listeners, which sit on
    // its element inside it, so they see the press as relabelled here.
    on(this._container, 'mousedown', (e) => {
      const isTracking = tracking();
      if (mac && isTracking && e.shiftKey && !e.altKey && (e.button ?? 0) === 0) pressAsOption(e);
      this._selecting = pressSelects(e, { mac, tracking: isTracking });
    });

    // Window capture: a drag may end anywhere, and nothing can stop the
    // release before it gets here. xterm's selection is final by now — it
    // moves with the mouse, not on release.
    on(view, 'mouseup', (e) => {
      if ((e.button ?? 0) !== 0) return;
      const selecting = this._selecting;
      this._selecting = false;
      const copy = shouldCopyOnSelect({
        enabled: this._setting('terminalCopyOnSelect'),
        selecting,
        hasSelection: Boolean(term.hasSelection?.()),
      });
      if (copy) copyTerminalSelection(term);
    });
  }

  dispose() {
    for (const remove of this._removers.splice(0)) remove();
  }
}

/**
 * Install selection, copy on select and mouse reporting on a terminal, once,
 * right after `term.open(container)`. `settings` is the settings store
 * (`getState`, `subscribe`); both settings are read when they are needed, and
 * mouse reporting is re-applied the moment its setting changes.
 */
export function installTerminalClipboard(term, container, { settings = null, platform = currentPlatform() } = {}) {
  if (!term || !container) return null;
  const existing = installed.get(term);
  if (existing) return existing;

  // Absent (an older saved state, a store without the key) means the default: on.
  const setting = (key) => {
    try {
      return settings?.getState?.()?.[key] !== false;
    } catch {
      return true;
    }
  };

  const mouse = installMouseReporting(term, container, { isEnabled: () => setting('terminalMouseReporting') });
  // Subscribed while the terminal lives; the addon unsubscribes on dispose.
  const onSettingsChange = () =>
    typeof settings?.subscribe === 'function'
      ? settings.subscribe((state, prev) => {
          if (state?.terminalMouseReporting !== prev?.terminalMouseReporting) mouse?.sync();
        })
      : null;
  const addon = new TerminalClipboardAddon(container, { platform, setting, onSettingsChange, mouse });
  if (typeof term.loadAddon === 'function') term.loadAddon(addon);
  else addon.activate(term);
  installed.set(term, addon);
  return addon;
}

/** The binding installed on `term`, or null. */
export function terminalClipboardFor(term) {
  return (term && installed.get(term)) || null;
}

export default {
  currentPlatform,
  clipboardKeyAction,
  copyTerminalSelection,
  hasVisibleSelection,
  handleClipboardKey,
  pressSelects,
  shouldCopyOnSelect,
  installTerminalClipboard,
  terminalClipboardFor,
};
