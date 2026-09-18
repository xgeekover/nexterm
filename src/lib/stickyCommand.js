/**
 * Which command produced what you are looking at.
 *
 * Scrolling back through a long build and losing track of which command you
 * are inside is what Warp's sticky header fixes. The signal it needs already
 * arrives: OSC 133 "C" says a command's output begins here, so a mark of
 * `{ line, command }` at that moment is enough to answer the question later.
 *
 * Pure: no xterm, no React. The caller reads the three numbers off the buffer
 * and this decides what to show — which is where all the edge cases are.
 */

/**
 * The command owning the top of the viewport, or '' when nothing should show.
 *
 * `marks` is oldest-first, each `{ line, command }` with `line` an ABSOLUTE
 * buffer row. Nothing is shown when:
 *
 *   - the view is at the bottom. There the last line IS the current command
 *     and a header would only repeat what is already on screen.
 *   - the alternate buffer is up. vim and htop own the whole screen and there
 *     is no scrollback to be lost in.
 *   - nothing has been marked above the viewport — output from before the app
 *     started watching, or from a shell with no integration at all.
 */
export function stickyCommandFor({ marks = [], viewportY = 0, baseY = 0, alternate = false } = {}) {
  if (alternate) return '';
  if (!Array.isArray(marks) || marks.length === 0) return '';
  if (viewportY >= baseY) return '';

  let found = '';
  for (const mark of marks) {
    if (!mark || typeof mark.line !== 'number') continue;
    if (mark.line <= viewportY) found = typeof mark.command === 'string' ? mark.command : '';
    else break;
  }
  return found;
}

/**
 * Add a mark, dropping any that have scrolled out of the buffer.
 *
 * Without the pruning this grows for the life of a session — a terminal left
 * running a loop overnight would keep a mark per iteration long after the
 * output itself had gone.
 */
export function addCommandMark(marks, { line, command, oldestLine = -Infinity }) {
  const text = typeof command === 'string' ? command.trim() : '';
  // A command with no text is one the view did not see typed: a script, a
  // paste it refused to track, a multi-line construct. A blank header is worse
  // than no header.
  if (!text || typeof line !== 'number') return marks;
  return [...marks, { line, command: text }].filter((m) => m.line >= oldestLine);
}

export default { stickyCommandFor, addCommandMark };
