/**
 * Where the shell's prompts are, for the terminal's scrollbar.
 *
 * Every shell NexTerm integrates (cmd, PowerShell, zsh, bash and Git Bash)
 * prints OSC 133 "D" in front of every prompt, the first one included, and the
 * backend forwards it as `pty-command-done` exactly where it was in the
 * stream: after the output before it, ahead of the output after it, even in
 * one read (src-tauri/src/pty/manager.rs, osc.rs `into_ordered`). The mark
 * goes on the row the cursor is on once xterm has parsed everything delivered
 * before that D, which is the exact row the prompt starts on in every shell:
 * cmd and PowerShell start the prompt string with the D, and zsh's precmd /
 * bash's PROMPT_COMMAND print it with a printf of their own before ZLE or
 * readline draws the prompt. So it is the first line of a two-line prompt
 * (starship, powerlevel10k), or the empty line of one that starts with a
 * newline; a one-line prompt is on its row. (Before bundle 4 a read's markers
 * came after all of its output, and a prompt in the D's read was marked on
 * the row typed on.)
 *
 * Each such row gets an xterm marker (`term.registerMarker`), which moves with
 * its line as the buffer scrolls, trims and reflows, and a decoration drawn on
 * xterm's own overview ruler under its scrollbar (terminalRegistry.js). A
 * marker xterm disposes takes its mark with it: its line went off the top of a
 * full buffer, or was erased (`clear`, `cls`, Ctrl+L, Terminal: Clear). There
 * is nothing left there to jump to, so the mark is not placed again.
 *
 * No xterm import, no React. The pure helpers say which prompt is the previous
 * or next one and which mark a click on the ruler is aimed at;
 * `trackPromptMarks` keeps one terminal's marks.
 */

/**
 * Marks kept for one terminal at most, the oldest dropped first: the sticky
 * header's bound (MAX_COMMAND_MARKS, stickyCommand.js). xterm updates every
 * marker on each line a full buffer drops and visits every decoration on each
 * ruler redraw, and a pane cannot show more separate marks than about its
 * height in pixels divided by 3 anyway.
 */
export const MAX_PROMPT_MARKS = 500;

/** How far from a drawn mark, in CSS pixels, a click on the ruler still takes it. */
export const HIT_TOLERANCE_PX = 4;

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;

// Made transparent before it is disposed. xterm keeps its decorations in a
// list sorted by line and finds one to delete by its line; a decoration
// whose marker died first sits there with line -1 (the find bar's leave
// one after every search), the order is broken, and a later delete can
// miss — found in the browser suite: a mark stayed on the ruler after the
// setting turned the marks off. One that is missed draws nothing.
//
// A known leak, recorded and not fixed: xterm 6's DecorationService can
// fail to delete a decoration whose marker is already disposed (line -1).
// Such a decoration, made transparent here, stays in xterm's list for the
// life of the terminal, and every ruler redraw still visits it. Their count
// grows only with what the user does: turning the marks off and on, a
// recolour, and, after a find, marks lost to a trim or to the limit.
//
// Shared with the message marks (agentMessageMarks.js): `mark` is
// `{ decoration }`, and loses it here.
export function undecorate(mark) {
  const decoration = mark.decoration;
  mark.decoration = null;
  if (!decoration || decoration.isDisposed) return;
  const ruler = decoration.options?.overviewRulerOptions;
  if (ruler) ruler.color = TRANSPARENT;
  decoration.dispose?.();
}

const sortedLines = (lines) =>
  (Array.isArray(lines) ? lines : [])
    .filter((line) => Number.isInteger(line) && line >= 0)
    .sort((a, b) => a - b);

/**
 * The prompt above the top row of the view: the newest mark whose line is
 * above `viewportY`. Null when there is none.
 */
export function previousPromptLine(lines, viewportY) {
  const sorted = sortedLines(lines);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i] < viewportY) return sorted[i];
  }
  return null;
}

/**
 * The prompt below the top row of the view: the first mark whose line is
 * below `viewportY`. Past the newest mark it is the bottom (`baseY`), while
 * the view is not there yet. Null when there is nowhere to go.
 */
export function nextPromptLine(lines, viewportY, baseY = Infinity) {
  const bottom = Number.isFinite(baseY) ? Math.max(baseY, 0) : Infinity;
  for (const line of sortedLines(lines)) {
    if (line <= viewportY) continue;
    // A prompt on the last screen is reached by scrolling to the bottom.
    const target = Math.min(line, bottom);
    return target > viewportY ? target : null;
  }
  return Number.isFinite(bottom) && viewportY < bottom ? bottom : null;
}

/**
 * The mark a press on the scrollbar's track is aimed at, or null.
 *
 * `offsetY` is the press from the top of the track and `rulerHeight` the
 * track's height, both in CSS pixels; `bufferLength` is how many lines the
 * ruler maps onto that height. xterm draws a mark at line L centred at
 * `L / bufferLength * rulerHeight`, so the press is taken in buffer lines at
 * the same scale and compared with each mark's line. The nearest within
 * HIT_TOLERANCE_PX wins; of two as near, the upper one. A press on the slider
 * (`sliderTop` .. `sliderTop + sliderHeight`) is never a mark's: it drags the
 * slider.
 */
export function hitPromptMark({
  offsetY,
  rulerHeight,
  bufferLength,
  lines,
  sliderTop = 0,
  sliderHeight = 0,
  tolerancePx = HIT_TOLERANCE_PX,
} = {}) {
  if (!Number.isFinite(offsetY) || !(rulerHeight > 0) || !(bufferLength > 0)) return null;
  if (sliderHeight > 0 && offsetY >= sliderTop && offsetY <= sliderTop + sliderHeight) return null;
  const linesPerPx = bufferLength / rulerHeight;
  const pointer = offsetY * linesPerPx;
  const tolerance = tolerancePx * linesPerPx;
  let best = null;
  let bestDistance = Infinity;
  for (const line of sortedLines(lines)) {
    const distance = Math.abs(line - pointer);
    if (distance > tolerance + 1e-9) continue;
    // Sorted, so on a tie the one found first is the upper one.
    if (distance < bestDistance - 1e-9) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The marks of one terminal (`term`, an xterm Terminal), oldest first.
 *
 * `decorate(marker, color)` puts a mark on the ruler and returns the
 * decoration, or null; without one (xterm headless, which draws nothing) the
 * marks are only kept. `limit` bounds them.
 *
 *   - `mark()` on every D, once xterm has read the output before it. Nothing
 *     while the alternate buffer is up: a full-screen program has no prompts,
 *     and markers go on the active buffer. Nothing on the row of the newest
 *     mark (a repaint, a redraw). Marks at or below the new row go: a prompt
 *     only comes above an older one when the screen was redrawn over them.
 *   - `cursorOnNewestMark()` before Terminal: Clear and `afterClear(was)`
 *     after it: every mark goes with the text it was on, and the prompt the
 *     cursor is on, when it had a mark, gets one again on its new row; then
 *     `onClear()`, for marks kept elsewhere (agentMessageMarks.js).
 *   - `setVisible(false)` takes every decoration off the ruler and keeps the
 *     marks; `setVisible(true)` puts them back. `setColor(css)` redraws them
 *     in another colour.
 *   - `previous(viewportY)`, `next(viewportY, baseY)` and `hit(...)` answer
 *     from the marks' lines now; `hit` only while the marks are shown, so
 *     with the setting off every press on the track is xterm's own.
 *   - `dispose()` with the terminal: every marker and decoration goes.
 */
export function trackPromptMarks(term, { limit = MAX_PROMPT_MARKS, decorate = null, visible = true, color = null, onClear = null } = {}) {
  let marks = [];
  let shown = visible !== false;
  let colour = color;
  let disposed = false;

  const alternate = () => term?.buffer?.active?.type === 'alternate';

  const decorateMark = (mark) => {
    if (!shown || typeof decorate !== 'function' || mark.decoration || !alive(mark.marker)) return;
    try {
      mark.decoration = decorate(mark.marker, colour) ?? null;
    } catch (err) {
      mark.decoration = null;
      console.warn('[Terminal] could not draw a prompt mark:', err);
    }
  };

  // xterm disposes a marker whose line it trims or erases, from inside its own
  // loop over the buffer's markers: only this list is touched here.
  const forget = (marker) => {
    if (disposed) return;
    const mark = marks.find((m) => m.marker === marker);
    if (!mark) return;
    marks = marks.filter((m) => m !== mark);
    undecorate(mark);
  };

  const drop = (mark) => {
    undecorate(mark);
    if (mark.marker && !mark.marker.isDisposed) mark.marker.dispose?.();
  };

  const lines = () => marks.filter((m) => alive(m.marker)).map((m) => m.marker.line);

  return {
    mark() {
      if (disposed || alternate() || typeof term?.registerMarker !== 'function') return null;
      const buffer = term.buffer.active;
      const row = buffer.baseY + buffer.cursorY;
      const newest = marks[marks.length - 1];
      if (newest && alive(newest.marker) && newest.marker.line === row) return null;
      const marker = term.registerMarker(0);
      if (!marker) return null;
      const mark = { marker, decoration: null };
      marker.onDispose?.(() => forget(marker));
      const stale = marks.filter((m) => !alive(m.marker) || m.marker.line >= row);
      marks = marks.filter((m) => !stale.includes(m));
      marks.push(mark);
      const over = marks.length > limit ? marks.slice(0, marks.length - limit) : [];
      if (over.length) marks = marks.slice(over.length);
      for (const old of [...stale, ...over]) drop(old);
      decorateMark(mark);
      return mark;
    },
    /** Whether the newest mark is on the row the cursor is on. */
    cursorOnNewestMark() {
      if (disposed || alternate()) return false;
      const newest = marks[marks.length - 1];
      const buffer = term.buffer.active;
      return Boolean(newest) && alive(newest.marker) && newest.marker.line === buffer.baseY + buffer.cursorY;
    },
    afterClear(cursorWasMarked) {
      if (disposed) return;
      // Everything but the cursor's line is gone. xterm 6's `term.clear()`
      // disposed every marker (`clearAllMarkers`); the headless build's does
      // not, and leaves them naming rows that now hold other text. Either
      // way no mark from before is right any more.
      const all = marks;
      marks = [];
      for (const mark of all) drop(mark);
      if (cursorWasMarked) this.mark();
      // What else goes with a clear: the registry's message marks.
      if (typeof onClear === 'function') onClear();
    },
    setVisible(next) {
      if (disposed) return;
      shown = next !== false;
      for (const mark of marks) {
        if (shown) decorateMark(mark);
        else undecorate(mark);
      }
    },
    setColor(next) {
      if (disposed || next === colour) return;
      colour = next;
      if (!shown) return;
      for (const mark of marks) {
        undecorate(mark);
        decorateMark(mark);
      }
    },
    previous(viewportY) {
      return disposed ? null : previousPromptLine(lines(), viewportY);
    },
    next(viewportY, baseY) {
      return disposed ? null : nextPromptLine(lines(), viewportY, baseY);
    },
    /** Only drawn marks take a press: none while they are hidden, so the track is xterm's. */
    hit(args) {
      return disposed || !shown ? null : hitPromptMark({ ...args, lines: lines() });
    },
    /** The marks as kept, oldest first: `{ marker, decoration }`. */
    get marks() {
      return marks;
    },
    /** Their buffer lines now, oldest first. */
    get lines() {
      return lines();
    },
    get visible() {
      return shown;
    },
    get color() {
      return colour;
    },
    dispose() {
      if (disposed) return;
      const all = marks;
      marks = [];
      disposed = true;
      for (const mark of all) drop(mark);
    },
  };
}

/**
 * Several kinds of marks as one (F12): the shell prompts and the messages
 * sent to Claude Code (agentMessageMarks.js), each a tracker with `lines`
 * and `visible`. Previous, next and the click go to the nearest of either
 * kind, in buffer order; the click only to marks that are drawn, so with the
 * setting off every press on the track is xterm's. Empty sources are fine.
 */
export function mergeMarks(...sources) {
  const live = () => sources.filter((s) => s && typeof s === 'object');
  const merged = (onlyShown) => {
    const all = new Set();
    for (const source of live()) {
      if (onlyShown && source.visible === false) continue;
      for (const line of source.lines ?? []) all.add(line);
    }
    return [...all].sort((a, b) => a - b);
  };
  return {
    get lines() {
      return merged(false);
    },
    previous(viewportY) {
      return previousPromptLine(merged(false), viewportY);
    },
    next(viewportY, baseY) {
      return nextPromptLine(merged(false), viewportY, baseY);
    },
    hit(args) {
      const lines = merged(true);
      return lines.length ? hitPromptMark({ ...args, lines }) : null;
    },
  };
}

/**
 * Where Terminal: Go to Previous / Next Prompt scrolls `buffer` (xterm's
 * active buffer) to, from `marks` (`mergeMarks`): null on the alternate
 * screen, where a full-screen program keeps the key and there is no
 * scrollback to go to, and where there is nowhere to go.
 */
export function promptJumpLine(buffer, marks, direction) {
  if (!buffer || !marks || buffer.type === 'alternate') return null;
  return direction === 'previous' ? marks.previous(buffer.viewportY) : marks.next(buffer.viewportY, buffer.baseY);
}

/**
 * The one app-level listener for prompts: every `pty-command-done` marks
 * every live terminal bound to that session (`entries()` yields the
 * registry's entries; `mark(entry)` marks one once its output is read). Kept
 * with the terminals, not the view showing one, so a terminal that is alive
 * but in no pane still gets its prompts. Returns `listen`'s promise of an
 * unlisten function.
 */
export function listenForPrompts({ listen, entries, mark }) {
  return Promise.resolve(
    listen('pty-command-done', (payload) => {
      const sessionId = payload?.session_id;
      if (!sessionId) return;
      for (const entry of entries()) {
        if (!entry || entry.disposed || entry.sessionId !== sessionId) continue;
        try {
          mark(entry);
        } catch (err) {
          console.warn('[Terminal] could not mark a prompt:', err);
        }
      }
    })
  );
}

export default {
  MAX_PROMPT_MARKS,
  HIT_TOLERANCE_PX,
  previousPromptLine,
  nextPromptLine,
  hitPromptMark,
  trackPromptMarks,
  mergeMarks,
  promptJumpLine,
  undecorate,
  listenForPrompts,
};
