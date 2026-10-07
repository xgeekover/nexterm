/**
 * Put `text` on the system clipboard — what every Copy Path in a menu does.
 *
 * The Clipboard API first; where it is missing or refuses, the old copy
 * through a hidden textarea, which still works inside the click that asked
 * for it. Whatever had the focus gets it back. Best effort: resolves with
 * whether the text was copied, and never throws. The Explorer, the terminal
 * list and the tab chip each had their own copy of this, one with no fallback
 * and no error handling at all.
 *
 * Not for a terminal's own selection: `copyTerminalSelection`
 * (terminalClipboard.js) copies while xterm's textarea keeps the focus, so the
 * Korean IME is not made to send the syllable it holds.
 */
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // The copy below, then.
  }
  let area = null;
  const previous = document.activeElement;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    return document.execCommand('copy') === true;
  } catch (_) {
    return false;
  } finally {
    area?.remove?.();
    previous?.focus?.({ preventScroll: true });
  }
}
