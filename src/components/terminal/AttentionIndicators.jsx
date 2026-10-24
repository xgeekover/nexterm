import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { unreadBadge, unreadLabel } from '../../lib/attention.js';
import { aggregateProgress } from '../../lib/terminalProgress.js';
import { getTerminalThemeEntry, shownTerminalThemeId } from '../../lib/terminalThemes.js';
import { cn } from '../../lib/utils.js';

/**
 * What a terminal wants from you, drawn where you would look for it: a ring
 * round its pane, a count on its tab, its group and its side-bar row, and a
 * bar along the bottom of its tab for how far along its program says it is.
 *
 * The activity dot beside the title is a different question and stays as it
 * is: the dot says what the terminal is DOING (running, failed), the pill
 * says what it WANTS (you, N times). A terminal can be both at once — an
 * agent that is still running and has asked for permission — and folding
 * the two into one mark would lose one of them.
 *
 * Every component here is declared at module level and takes plain values
 * or one tab id. The progress pieces subscribe for themselves, to exactly
 * the bars they draw: a program reporting ten times a second then
 * re-renders a 2px bar, not the pane, the strip and the terminal under it.
 */

/**
 * The unread count on a chip or a side-bar row: nothing for none, 1 to 9,
 * then "9+" (`unreadBadge`).
 *
 * `role="img"` so that its words — "3 unread notifications" — are what a
 * screen reader takes from it, not a bare "3"; the chips and rows it sits in
 * read their names from their content. `label` replaces those words where
 * the count is about something else (the zoom chip's hidden panes).
 *
 * In line, after the title: a fixed 14px box under the 20px and 22px of the
 * chips, so a count arriving never changes a chip's height, `shrink-0` so a
 * long title gives way to it, and `whitespace-nowrap` so a narrow strip
 * cannot wrap "9+" into a "9" with the "+" cut off below it. A count laid
 * over the chip's corner instead covered the ✕ and sat against the next
 * tab's title, reading as that one's. A count coming or going does move what
 * follows it; it never does so between a press and its release, which is
 * where that once lost a click on the next tab's ✕ — the store holds a
 * pane's mark-read until the pointer is up (terminalStore.js).
 */
export function UnreadPill({ count, label: given, className }) {
  const text = unreadBadge(count);
  if (!text) return null;
  const label = given ?? unreadLabel(count);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-unread-count={count}
      className={cn(
        'shrink-0 inline-flex items-center justify-center min-w-[14px] h-[14px] px-[3px] rounded-full whitespace-nowrap',
        'bg-vsc-attention text-vsc-attention-fg text-[10px] leading-none font-semibold tabular-nums',
        className
      )}
    >
      {text}
    </span>
  );
}

/**
 * The frame a pane body keeps round its terminal, in pixels, always — the
 * room the two lines below are drawn in.
 *
 * Laid over the terminal itself, the attention ring cut the first column of
 * every row in half (xterm's screen starts at the very edge of its box), and
 * turning it on and off cannot be allowed to resize the terminal either: a
 * shell told it has one column fewer redraws its prompt. So the room is
 * there whether anything is drawn in it or not, and in the terminal's own
 * background colour (`paneBodyBackground`), so that it reads as the
 * terminal's margin rather than a border.
 */
export const PANE_FRAME_PX = 3;

/**
 * The background a pane body paints its frame in: the terminal theme's own,
 * so that the margin round the terminal is the same colour as the terminal.
 * Undefined for the theme that follows the app's tokens, whose background is
 * the pane's already — and for an imported theme that names no background,
 * which draws with that same token. Resolved by terminalThemes.js's
 * `getTerminalThemeEntry`, as the terminals' own colours are, so the margin
 * and the terminal it surrounds can never be in two different themes.
 */
export function paneBodyBackground(themeId, customThemes) {
  return getTerminalThemeEntry(themeId, customThemes)?.theme?.background ?? undefined;
}

/**
 * `paneBodyBackground` for a settings-store selector: the theme on screen —
 * the one the Settings window's gallery is previewing, else the chosen one —
 * with the user's imported themes. A plain string, so a pane re-renders only
 * when the colour itself changes.
 */
export function selectPaneBodyBackground(state) {
  return paneBodyBackground(shownTerminalThemeId(state), state.terminalCustomThemes);
}

/**
 * A press on the frame itself — the margin round the terminal, or a line
 * drawn in it, which the pointer goes through — gives that terminal the
 * keyboard, as a press on the terminal does.
 *
 * The margin is the pane body's own padding, outside the element TerminalView
 * focuses its terminal from. A press there reached nothing that takes focus,
 * so the browser gave focus to the page: out of the terminal being typed
 * into, by a click three pixels off. `preventDefault` keeps focus from
 * moving at all, and the terminal's input is focused without scrolling (it
 * follows the cursor). No mouse report goes to the program: the press was
 * not on a cell.
 *
 * Only a press on the body's own box — anything inside it handles its own.
 * Returns whether it took the press.
 */
export function pressOnPaneFrame(e) {
  if (!e || e.target !== e.currentTarget) return false;
  const input = e.currentTarget?.querySelector?.('.xterm-helper-textarea');
  if (!input) return false;
  e.preventDefault();
  input.focus({ preventScroll: true });
  return true;
}

/** A line of the frame: inside the pane body's edge, over everything in it but the drop overlays (`z-20`). */
const FRAME_LINE = 'pointer-events-none absolute z-[15]';

/**
 * What a pane body's frame shows (D3, D4, and which pane is active).
 *
 *   - `active`: a 1px line in the focus colour on the outermost pixel — this
 *     is the pane the keyboard is in. Drawn here and not on the pane's own
 *     box, where the strip and the terminal painted straight over it; and
 *     only where there is a choice of pane to be in (`PaneFrame` is told).
 *   - `unread`: the attention ring, 2px, one pixel in, so the active line
 *     stays visible outside it; it pulses while any tab in the pane has
 *     unread entries.
 *   - `flash`: the store's flash number for the pane's visible terminal, or
 *     undefined — the same ring once. Used as the key, so a second flash
 *     before the first has ended mounts a new element and the animation
 *     starts over.
 *
 * Both lines lie in the `PANE_FRAME_PX` margin, never over a glyph. The
 * pointer goes straight through them: drags and drops find their targets
 * with `elementFromPoint`, which must never see these. `aria-hidden`: the
 * counts on the chips are what can be read out.
 *
 * Always rendered, in the same place in the body, so that what it draws
 * coming and going never moves the terminal beside it to another slot.
 */
export function PaneFrame({ active, unread, flash }) {
  return (
    <>
      {active && (
        <div
          aria-hidden="true"
          data-active-pane=""
          className={cn(FRAME_LINE, 'inset-0 ring-1 ring-inset ring-vsc-focus')}
        />
      )}
      {unread && (
        <div
          aria-hidden="true"
          data-attention-ring="unread"
          className={cn(FRAME_LINE, 'inset-px ring-2 ring-inset ring-vsc-attention animate-attention-pulse')}
        />
      )}
      {flash !== undefined && (
        <div
          key={flash}
          aria-hidden="true"
          data-attention-ring="flash"
          className={cn(FRAME_LINE, 'inset-px ring-2 ring-inset ring-vsc-attention animate-attention-flash')}
        />
      )}
    </>
  );
}

/** What colour each state's bar is drawn in. */
const BAR_COLOUR = {
  normal: 'bg-vsc-accent',
  indeterminate: 'bg-vsc-accent',
  warning: 'bg-vsc-warn',
  error: 'bg-vsc-error',
};

/**
 * A bar in words, for whoever cannot see its colour or its length: "40%
 * done", "error at 40%", "paused at 70%", "working".
 */
export function progressWords(bar) {
  if (!bar || !BAR_COLOUR[bar.state]) return '';
  const at = bar.value === null || bar.value === undefined ? '' : ` at ${Math.round(bar.value)}%`;
  switch (bar.state) {
    case 'normal':
      return `${Math.round(bar.value ?? 0)}% done`;
    case 'error':
      return `error${at}`;
    case 'warning':
      return `paused${at}`;
    default:
      return 'working';
  }
}

/**
 * A 2px bar along the bottom of a chip (D12) for `bar` — `{ state, value }`
 * as the store keeps it — or nothing for none.
 *
 * `value` percent wide; an error or a warning with no amount is a full bar.
 * An indeterminate bar has no amount and is a segment that slides, still in
 * the middle under reduced motion (index.css).
 *
 * The bar is drawn for the eye and hidden from a screen reader; beside it,
 * visually hidden, the same thing in words (`progressWords`), which a chip —
 * named from its content — reads out after its title. Here, inside the
 * narrowly subscribed pieces below, so that saying it costs the pane nothing.
 */
export function ProgressBar({ bar }) {
  if (!bar || !BAR_COLOUR[bar.state]) return null;
  const indeterminate = bar.state === 'indeterminate';
  const value = indeterminate ? null : Math.max(0, Math.min(100, bar.value ?? 100));
  return (
    <>
      <span data-progress-words="" className="sr-only">
        {progressWords(bar)}
      </span>
      <span
        aria-hidden="true"
        data-progress-state={bar.state}
        data-progress-value={value ?? undefined}
        className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] overflow-hidden rounded-b-sm"
      >
        <span
          data-progress-fill=""
          className={cn(
            'absolute top-0 bottom-0 left-0',
            BAR_COLOUR[bar.state],
            indeterminate && 'w-[30%] animate-progress-indeterminate'
          )}
          style={indeterminate ? undefined : { width: `${value}%` }}
        />
      </span>
    </>
  );
}

/** Whether bars are drawn at all — off, the store empties its map, and nothing it still had is drawn either. */
const progressShown = (s) => s.terminalProgress !== false;

/**
 * One tab's bar, subscribed to that tab's entry alone. The store replaces
 * only the entry that changed, so the other tabs' bars keep theirs and do
 * not draw again.
 */
export function TabProgress({ tabId }) {
  const shown = useSettingsStore(progressShown);
  const bar = useTerminalStore((s) => s.progress[tabId]);
  return shown ? <ProgressBar bar={bar} /> : null;
}

/**
 * A group's bar: its tabs' bars as one (`aggregateProgress` — an error over
 * a warning over a normal bar over an indeterminate one, at the lowest
 * amount among the winners). Subscribed to those tabs' entries only, compared
 * one by one (`useShallow`), so a bar in another group does not draw this one.
 */
export function GroupProgress({ tabIds }) {
  const shown = useSettingsStore(progressShown);
  const bars = useTerminalStore(useShallow((s) => tabIds.map((id) => s.progress[id])));
  return shown ? <ProgressBar bar={aggregateProgress(bars)} /> : null;
}
