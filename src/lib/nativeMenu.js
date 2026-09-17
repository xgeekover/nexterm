/**
 * The native menu's shortcuts, kept equal to the ones actually bound.
 *
 * macOS draws the menu bar itself, from `src-tauri/src/menu.rs`, and that file
 * hardcodes an accelerator per item. Rebinding a shortcut in Settings changed
 * what the key DID while the menu carried on printing the old one — a menu
 * that lies about its own keys. VS Code has the same split (its menus are
 * native too) and solves it the same way: the keybinding layer owns the truth
 * and pushes it down.
 *
 * So the frontend converts each bound chord into a Tauri/muda accelerator
 * string and sends the lot to `menu_set_accelerators`, which rebuilds the menu
 * with them. One rule survives the conversion and is the reason this is not a
 * two-line mapping: an accelerator that is a bare Ctrl+letter is resolved by
 * the window BEFORE the webview sees the key, so registering one takes that
 * control character away from every shell in the app. See `acceleratorFor`.
 *
 * Pure apart from `syncNativeMenu`: `isMac` and the transport are arguments,
 * so a test can ask what Windows would be sent without being on Windows.
 */

import { parseChord } from './chords.js';
import { DEFAULT_RESOLVED, menuIdOf, COMMANDS } from './keybindings.js';
import { isMac as IS_MAC } from './platform.js';
import { invoke, isTauri } from './ipc.js';

/** The glyph muda's parser wants for a key we match on `code`. */
const CODE_GLYPHS = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** `event.key` spellings muda accepts, mapped to what it calls them. */
const NAMED_ACCELERATOR_KEYS = {
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  ' ': 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

/** The key half of an accelerator, or null when muda could not parse it. */
function acceleratorKey(chord) {
  if (chord.code) return CODE_GLYPHS[chord.code] ?? null;
  const key = chord.key;
  if (typeof key !== 'string' || key === '') return null;
  if (NAMED_ACCELERATOR_KEYS[key]) return NAMED_ACCELERATOR_KEYS[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return key.toUpperCase();
  // Anything else — a dead key, `ContextMenu`, a layout-specific glyph — has
  // no accelerator spelling. Sending it would make the whole menu fail to
  // build, so the item goes without a shortcut instead.
  return null;
}

/**
 * Would this accelerator take a control character away from the shell?
 *
 * The same rule `no_accelerator_claims_a_bare_ctrl_letter` holds in menu.rs,
 * and it has to hold here too because a user can now bind whatever they like.
 * Windows resolves the window's accelerator table before the webview, GTK runs
 * its accel group before the focused widget, and AppKit matches key
 * equivalents before the key reaches the web view — so `Ctrl+D` in a menu is
 * EOF gone from every pane, on every platform.
 *
 * `CmdOrCtrl` is ⌘ on macOS and therefore safe there; off macOS it IS Ctrl,
 * which is exactly what `terminal_safe` in menu.rs encodes for the defaults.
 */
export function stealsFromTheShell(accelerator, { isMac = false } = {}) {
  if (typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+');
  if (parts.length !== 2) return false;
  const isCtrl = parts[0] === 'Ctrl' || (parts[0] === 'CmdOrCtrl' && !isMac);
  return isCtrl && /^[A-Za-z]$/.test(parts[1]);
}

/**
 * The accelerator string for a chord, or null when the menu must not show one.
 *
 * Null is a real answer, not a failure: the item then appears with no shortcut
 * beside it, and `useKeybindings.js` still runs the command from the webview —
 * where xterm can take the key back when a terminal has focus. That is how
 * ⌘S-shaped shortcuts work off macOS today.
 */
export function acceleratorFor(key, { isMac = false } = {}) {
  const chord = typeof key === 'string' ? parseChord(key) : key;
  if (!chord) return null;

  const name = acceleratorKey(chord);
  if (!name) return null;

  const parts = [];
  if (chord.mod) parts.push('CmdOrCtrl');
  if (chord.cmd) parts.push('Cmd');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(name);

  const accelerator = parts.join('+');
  return stealsFromTheShell(accelerator, { isMac }) ? null : accelerator;
}

/**
 * What every menu item's shortcut should be, by menu item id.
 *
 * Complete rather than a diff: an id whose command the user has unbound maps
 * to null, so resetting a shortcut puts the old one back instead of leaving
 * whatever was sent last time. Commands with no menu entry (`menuId: null` —
 * the reload guard, Escape, the pane-focus pair) are not in here at all.
 *
 * A command bound to several chords shows the first, as the OS gives a menu
 * item one key equivalent.
 */
export function acceleratorOverrides(bindings = DEFAULT_RESOLVED, { isMac = false } = {}) {
  const overrides = {};
  for (const id of Object.keys(COMMANDS)) {
    const menuId = menuIdOf(id);
    if (!menuId) continue;
    overrides[menuId] = null;
  }
  for (const binding of bindings) {
    const menuId = menuIdOf(binding.command);
    if (!menuId || !(menuId in overrides)) continue;
    if (overrides[menuId] !== null) continue; // an earlier chord already won
    overrides[menuId] = acceleratorFor(binding.chord ?? binding.key, { isMac });
  }
  return overrides;
}

/**
 * Push the current shortcuts to the native menu.
 *
 * Sent on every platform: only macOS has a native menu today, and the command
 * is a no-op elsewhere, but which platforms have one is the backend's business
 * rather than something for the frontend to guess at. In a browser there is no
 * backend at all, so nothing is sent.
 *
 * Returns what was sent, or null when nothing was.
 */
export async function syncNativeMenu(
  bindings = DEFAULT_RESOLVED,
  { isMac = IS_MAC, send = invoke, hasBackend = isTauri } = {}
) {
  if (!hasBackend()) return null;
  const accelerators = acceleratorOverrides(bindings, { isMac });
  try {
    await send('menu_set_accelerators', { accelerators });
  } catch (err) {
    // A menu that could not be rebuilt keeps the accelerators it had. Worth
    // saying out loud, not worth taking the window down for.
    console.warn('[menu] could not update the native shortcuts:', err);
    return null;
  }
  return accelerators;
}

export default { acceleratorFor, acceleratorOverrides, stealsFromTheShell, syncNativeMenu };
