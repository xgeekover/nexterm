/**
 * A key held down past what it chose.
 *
 * A key held a moment too long repeats, and once the palette row or the
 * dialog button it chose has closed, every repeat reaches whatever has the
 * keyboard then — the terminal, as Enters that ran its half-typed line, or
 * here as empty lines after a project command ran. Shared by the command
 * palette and the run dialog of a project command.
 */

/**
 * Swallow the repeats of `key`, still held from the press that chose
 * something, wherever the keyboard has gone since — until the key is let
 * go, pressed afresh (a keydown that is not a repeat), or the window loses
 * focus. In the capture phase, so a terminal never sees them. Harmless when
 * the key is not held: the next fresh press of it ends the watch, and is
 * not swallowed.
 */
export function swallowRepeatsOf(key) {
  const stop = () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', stop);
  };
  const onDown = (e) => {
    if (e.key !== key) return;
    if (!e.repeat) {
      stop();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onUp = (e) => {
    if (e.key === key) stop();
  };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', stop);
}
