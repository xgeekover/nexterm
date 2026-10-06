/**
 * Which command produced what you are looking at.
 *
 * Scrolling back through a long build and losing track of which command you
 * are inside is what Warp's sticky header fixes. The signal it needs already
 * arrives: OSC 133 "C" says a command's output begins here, so a mark of
 * `{ marker, command }` at that moment is enough to answer the question later.
 *
 * The row is held by an xterm marker (`term.registerMarker`), not a number. A
 * number is the buffer row at the time, and the buffer moves under it: once it
 * is full, every new line drops the oldest, and the number then names whatever
 * has moved up into that row. Reproduced with xterm's headless build — 5000
 * lines of scrollback, forty commands of 300 lines — the header over
 * `cmd39`'s output read `cmd16`. A marker moves with its line.
 *
 * No xterm import, no React. What to show and what to keep — which is where
 * all the edge cases are — is decided by pure functions over a list of marks;
 * `trackCommandMarks` keeps that list for one terminal, on markers the
 * terminal it is handed makes.
 */

/**
 * Marks kept for one terminal at most, the oldest dropped first. Each is a
 * marker xterm moves on every line a full buffer drops, so a terminal left at
 * a prompt for weeks must not collect them without end.
 */
export const MAX_COMMAND_MARKS = 500;

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;

/**
 * The buffer row each mark is at now, or null for one with nowhere to be.
 *
 * A marker dies one of two ways. Its line is dropped off the top of a full
 * buffer, and the command started above everything still in it: null. Or its
 * line is erased — `clear`, Ctrl+L, a watcher clearing the screen between
 * runs; xterm disposes a marker whose row it erases — and the command's output
 * carries on from the top of the screen. That place is the mark's `lost`: a
 * distance from a marker above it that is still alive, and moves as the
 * buffer does. If that one dies too, the mark has nowhere to be.
 */
function rowsOf(marks) {
  return marks.map((mark) => {
    if (alive(mark?.marker)) return mark.marker.line;
    const anchor = mark?.lost?.anchor;
    return alive(anchor) ? anchor.line + mark.lost.offset : null;
  });
}

/**
 * The command owning the top of the viewport, or '' when nothing should show.
 *
 * `marks` is oldest-first, as `addCommandMark` keeps them. Nothing is shown
 * when:
 *
 *   - the view is at the bottom. There the last line IS the current command
 *     and a header would only repeat what is already on screen.
 *   - the alternate buffer is up. vim and htop own the whole screen and there
 *     is no scrollback to be lost in.
 *   - nothing has been marked above the viewport — output from before the app
 *     started watching, or from a shell with no integration at all.
 *
 * A mark with nowhere to be, ahead of every mark that has a row, still owns
 * the top of the buffer down to the first of those: a build longer than the
 * scrollback is the very thing this header is for, and its own mark is the
 * first to go.
 */
export function stickyCommandFor({ marks = [], viewportY = 0, baseY = 0, alternate = false } = {}) {
  if (alternate) return '';
  if (!Array.isArray(marks) || marks.length === 0) return '';
  if (viewportY >= baseY) return '';

  const rows = rowsOf(marks);
  let found = '';
  let placed = false;
  for (let i = 0; i < marks.length; i += 1) {
    const command = typeof marks[i]?.command === 'string' ? marks[i].command : '';
    if (rows[i] === null) {
      if (!placed) found = command;
      continue;
    }
    placed = true;
    if (rows[i] > viewportY) break;
    found = command;
  }
  return found;
}

/**
 * The marks worth keeping, oldest first. Every mark left out has its marker
 * disposed.
 *
 *   - Of the marks with nowhere to be, only the newest ahead of every mark
 *     with a row: it owns the rows above them. The rest own nothing.
 *   - A mark with a row only if `keep(row)` agrees.
 *   - A mark whose row was erased only if the mark after it was not erased
 *     with it — the screen they shared was wiped, and what follows the top of
 *     it is the newest one's — and only where it keeps the marks in order.
 *     `place(row)` gives one a new marker there, when it can.
 */
function pruned(marks, { keep = () => true, place = null } = {}) {
  const list = (Array.isArray(marks) ? marks : []).filter((mark) => mark && typeof mark === 'object');
  const rows = rowsOf(list);
  let firstPlaced = rows.findIndex((row) => row !== null);
  if (firstPlaced === -1) firstPlaced = list.length;

  // The row of the next mark after each whose marker is alive.
  const nextLive = new Array(list.length).fill(null);
  for (let i = list.length - 2; i >= 0; i -= 1) {
    nextLive[i] = alive(list[i + 1].marker) ? list[i + 1].marker.line : nextLive[i + 1];
  }

  const next = [];
  let last = -Infinity;
  list.forEach((mark, i) => {
    const row = rows[i];
    let wanted;
    if (row === null) wanted = i === firstPlaced - 1;
    else if (alive(mark.marker)) wanted = keep(row);
    else {
      const erasedWithNext = i + 1 < list.length && !alive(list[i + 1].marker);
      wanted = keep(row) && !erasedWithNext && row >= last && (nextLive[i] === null || row <= nextLive[i]);
    }
    if (!wanted) {
      mark.marker?.dispose?.();
      return;
    }
    if (row === null || alive(mark.marker)) {
      next.push(mark);
    } else {
      const marker = place?.(row);
      next.push(marker ? { marker, command: mark.command } : mark);
    }
    if (row !== null) last = row;
  });
  return next;
}

/**
 * Add the mark of a command whose output starts at `marker`'s row.
 *
 * Returns a new list and leaves the one given alone. Owns `marker` from here
 * on: it is disposed when the mark is refused, and when it is dropped later.
 * Dropped on the way in:
 *
 *   - marks at or below the new one. A command cannot start above one that
 *     started before it unless the screen was cleared or redrawn over them
 *     (`clear`, Ctrl+L), and what they marked is gone.
 *   - what `settleCommandMarks` drops.
 *   - the oldest, past `limit`.
 *
 * `markAt`, when given, gives erased marks new markers as `settleCommandMarks`
 * does.
 */
export function addCommandMark(marks, { marker, command, limit = MAX_COMMAND_MARKS, markAt = null } = {}) {
  const text = typeof command === 'string' ? command.trim() : '';
  // A command with no text is one the view did not see typed: a script, a
  // paste it refused to track, a multi-line construct. A blank header is worse
  // than no header.
  if (!text || !alive(marker)) {
    marker?.dispose?.();
    return Array.isArray(marks) ? marks : [];
  }
  const row = marker.line;
  const next = pruned(marks, { keep: (r) => r < row, place: markAt });
  next.push({ marker, command: text });
  while (next.length > limit) next.shift().marker?.dispose?.();
  return next;
}

/**
 * Tidy the marks after markers have died: an erased mark gets a new marker
 * where it now is — `markAt(row)` makes one at a buffer row, or returns null
 * when it cannot — and what owns nothing any more is dropped (see `pruned`).
 *
 * Run soon after a marker dies. An erased mark is placed from a marker above
 * it, and once that one goes off the top as well there is nothing left to
 * place it from.
 */
export function settleCommandMarks(marks, { markAt = null } = {}) {
  return pruned(marks, { place: markAt });
}

/** Let every mark's marker go: the terminal is closing. */
export function disposeCommandMarks(marks) {
  for (const mark of Array.isArray(marks) ? marks : []) mark?.marker?.dispose?.();
}

/**
 * One terminal's command marks, on markers `term` makes (an xterm Terminal).
 *
 * `mark(command)` when the shell reports OSC 133 "C", with the line the view
 * saw submitted; `current()` for the header over the viewport as it is now;
 * `dispose()` with the terminal. Kept with the terminal rather than with the
 * view showing it, so a pane that switches tabs shows the right commands.
 *
 * When a marker dies, where its mark now is gets written down at once (see
 * `rowsOf`), and the marks are settled a moment later. Not at once: a marker
 * dies inside xterm's own loop over the markers of a row it is erasing, and a
 * marker made there would be erased in turn.
 */
export function trackCommandMarks(term, { limit = MAX_COMMAND_MARKS } = {}) {
  let marks = [];
  let settling = false;
  let disposed = false;

  // Markers go on the active buffer, and these belong to the normal one: none
  // is made while a full-screen program has the alternate one up.
  const alternate = () => term.buffer.active.type === 'alternate';

  // A mark whose row was just erased: its output carries on from the top of
  // the screen, placed from the highest mark above it still alive — one in
  // the scrollback, which no erase reaches, if there is one. A mark dropped
  // off the top has no live mark above it, and so stays nowhere.
  const noteLost = (marker) => {
    const i = marks.findIndex((mark) => mark.marker === marker);
    if (i === -1) return;
    const anchor = marks.slice(0, i).map((mark) => mark.marker).find(alive);
    if (!anchor) return;
    const top = term.buffer.normal.baseY;
    marks = marks.map((mark, j) => (j === i ? { ...mark, lost: { anchor, offset: top - anchor.line } } : mark));
  };

  const settleSoon = () => {
    if (disposed || settling) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      // Under a full-screen program this waits for the next command marked.
      if (disposed || alternate()) return;
      marks = settleCommandMarks(marks, { markAt: markerAtRow() });
    });
  };

  const markerAt = (offset) => {
    const marker = term.registerMarker?.(offset);
    marker?.onDispose?.(() => {
      if (disposed) return;
      noteLost(marker);
      settleSoon();
    });
    return marker;
  };

  const markerAtRow = () => {
    const buffer = term.buffer.active;
    return (row) => (row >= 0 && row < buffer.length ? markerAt(row - (buffer.baseY + buffer.cursorY)) : null);
  };

  return {
    mark(command) {
      if (disposed || alternate()) return;
      if (typeof command !== 'string' || !command.trim()) return;
      const marker = markerAt(0);
      if (marker) marks = addCommandMark(marks, { marker, command, limit, markAt: markerAtRow() });
    },
    current() {
      if (disposed) return '';
      const buffer = term.buffer.active;
      return stickyCommandFor({
        marks,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        alternate: buffer.type === 'alternate',
      });
    },
    /** The marks as kept, oldest first — for the suites. */
    get marks() {
      return marks;
    },
    dispose() {
      disposed = true;
      disposeCommandMarks(marks);
      marks = [];
    },
  };
}

export default {
  stickyCommandFor,
  addCommandMark,
  settleCommandMarks,
  disposeCommandMarks,
  trackCommandMarks,
  MAX_COMMAND_MARKS,
};
