/**
 * Where the keyboard goes back to when a dialog opened from the command
 * palette closes: what had it when the palette opened.
 *
 * The palette used to give the keyboard back to that terminal first and the
 * dialog took it a moment later, so a program asking to be told of focus
 * (OpenCode, vim) was sent "focus in" and "focus out" for nothing. Now the
 * palette closes without giving it back and hands its opener here, and the
 * dialog that opens next gives the keyboard straight back to it as it closes.
 *
 * Read, not taken, as the dialog opens — React's StrictMode opens a dialog
 * twice in development — and good only for a moment: a dialog opened later
 * by other means gets nothing stale.
 */
const FRESH_MS = 2000;
let handed = null;

/** Remember `el` for the dialog about to open; null forgets. */
export function handDialogReturn(el, now = Date.now()) {
  handed = el ? { el, at: now } : null;
}

/** What was handed for a dialog opening now, or null. */
export function dialogReturn(now = Date.now()) {
  return handed && now - handed.at < FRESH_MS ? handed.el : null;
}

/**
 * Give the keyboard to `el` when it can have it — on the page, not the page
 * itself, not a button (Chromium focuses a clicked button, and Enter on it
 * would open the palette again) — else to `fallback()`.
 */
export function focusBack(el, fallback) {
  const doc = globalThis.document;
  if (el && doc && el !== doc.body && el.tagName !== 'BUTTON' && doc.contains(el) && typeof el.focus === 'function') {
    el.focus({ preventScroll: true });
    return;
  }
  fallback?.();
}
