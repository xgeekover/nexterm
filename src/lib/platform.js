/**
 * Platform helpers so shortcuts and their on-screen hints agree with the OS.
 * macOS uses ⌘ as the app modifier; Windows/Linux use Ctrl.
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

export const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '');

/** Display label for the app modifier key. */
export const modLabel = isMac ? '⌘' : 'Ctrl';

/** True when the event carries the app modifier (⌘ on macOS, Ctrl elsewhere). */
export function hasMod(e) {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Render a chord like `mod+shift+d` as "⌘⇧D" on macOS or "Ctrl+Shift+D" elsewhere. */
export function chord(...keys) {
  const map = isMac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' };
  const parts = keys.map((k) => map[k] || k.toUpperCase());
  return isMac ? parts.join('') : parts.join('+');
}
