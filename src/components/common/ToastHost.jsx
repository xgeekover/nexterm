import React, { useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { useToastStore } from '../../stores/toastStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';

/**
 * Where the toasts sit, by how many corner notices are up (OpenFailureNotice,
 * AgentHistoryNotice): each notice is 400px wide at right-2 or right-[416px],
 * so the toasts go to the next 400px with an 8px gap, beside them and never
 * over them — while the window has room for that column (toastPlacement).
 */
const OFFSETS = ['right-2', 'right-[416px]', 'right-[824px]'];

/** One toast or notice column: its 400px and the 8px gap to its right. */
const COLUMN_PX = 408;

/** The gap between the corner notices' top and the lowest toast, as between two toasts (gap-2). */
const GAP_PX = 8;

/** What the corner notices' roots carry, so their height can be read (OpenFailureNotice, AgentHistoryNotice). */
export const CORNER_NOTICE_SELECTOR = '[data-corner-notice]';

/**
 * How many 400px columns fit side by side in a window `width` px wide, 8px
 * from the right edge, 8px apart and 8px clear of the left edge:
 * OFFSETS[n] needs n + 1 of them, a window at least 416 + 408n wide (824px
 * beside one notice, 1232px beside two). A width that is not a number (a
 * server render, an engine that does not say) fits them all.
 */
export function columnsThatFit(width) {
  return Number.isFinite(width) ? Math.floor((width - GAP_PX) / COLUMN_PX) : Infinity;
}

/**
 * Where the toasts go with `notices` corner notices up, `columns` of room
 * (columnsThatFit) and `noticeHeight` the tallest notice's height in px:
 * beside the notices (OFFSETS[notices]) when that column fits; else at
 * right-2 directly above the notices, `lift` px higher than the notices'
 * bottom (their height and the 8px gap), so a toast is never cut off by the
 * window's edge and never covers a notice. With no height to go by (a notice
 * not drawn yet) the toasts stay beside the notices.
 */
export function toastPlacement(notices, columns, noticeHeight) {
  if (notices === 0 || columns > notices || !(noticeHeight > 0)) return { offset: OFFSETS[notices], lift: 0 };
  return { offset: OFFSETS[0], lift: noticeHeight + GAP_PX };
}

const UNMEASURED = { columns: Infinity, height: 0 };

/**
 * The window's columns and the tallest corner notice's height, read only
 * while `active` (a toast and a notice are up): once when it starts or the
 * notices change (`noticesKey`), the width again on each window resize, and
 * the height whenever a notice changes size (a ResizeObserver on the
 * notices' roots). No polling; the state changes only when a value does; the
 * listener and the observer go when `active` ends, the notices change, or the
 * host unmounts. Before paint (a layout effect), so a toast is never drawn
 * off screen first.
 */
function useCornerRoom(active, noticesKey) {
  const [room, setRoom] = useState(UNMEASURED);
  // What `room` was last set to, so an unchanged value sets nothing (a
  // resize fires on every pixel; the columns change only every 408px).
  const roomRef = useRef(UNMEASURED);
  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const notices = [...document.querySelectorAll(CORNER_NOTICE_SELECTOR)];
    const heightOf = () =>
      notices.reduce((max, el) => Math.max(max, typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().height || 0 : 0), 0);
    let columns = columnsThatFit(window.innerWidth);
    let height = heightOf();
    const update = () => {
      if (roomRef.current.columns === columns && roomRef.current.height === height) return;
      roomRef.current = { columns, height };
      setRoom(roomRef.current);
    };
    update();
    const onResize = () => {
      columns = columnsThatFit(window.innerWidth);
      update();
    };
    window.addEventListener('resize', onResize);
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        height = heightOf();
        update();
      });
      for (const el of notices) observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      if (observer) observer.disconnect();
    };
  }, [active, noticesKey]);
  return room;
}

/**
 * The toasts of toastStore, over the bottom right corner of the window above
 * the status bar, drawn as the corner notices are (the one elevation), the
 * newest at the bottom.
 *
 * A confirmation is said politely (when the screen reader is next idle)
 * through one status region that is always there, empty and visually
 * hidden, so its text lands in a live region the screen reader already
 * knows: some do not announce a region that comes with its first text. The
 * drawn confirmation is not a live region itself, and its words are
 * aria-hidden, so the region is their one copy and they are said and read
 * once. It fades in and, over the last 150 ms of TOAST_MS, out; an error is
 * an alert and stays until dismissed. By opacity only, and not at all under reduced
 * motion (index.css). Nothing here takes focus: no toast is focused when it
 * appears, and Dismiss keeps focus where it was (usually the terminal being
 * typed in), as the notices' Dismiss does. With no toast nothing is drawn;
 * the hidden region takes no room and no clicks, and the host lets clicks
 * through around the toasts.
 *
 * Beside the corner notices while the window has room for that column; in a
 * narrower one at right-2 above them (toastPlacement, useCornerRoom).
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const openFailure = useEditorStore((s) => Boolean(s.openFailure));
  const agentHistoryNotice = useTerminalStore((s) => Boolean(s.agentHistoryNotice));
  const notices = Number(openFailure) + Number(agentHistoryNotice);
  const measuring = toasts.length > 0 && notices > 0;
  const room = useCornerRoom(measuring, Number(openFailure) + 2 * Number(agentHistoryNotice));
  const { offset, lift } = measuring ? toastPlacement(notices, room.columns, room.height) : toastPlacement(notices, Infinity, 0);

  return (
    <>
      {/* Mounted from the start and never taken away: each confirmation is
          added here as its own line (additions only, so a line that goes
          is not said). Errors are alerts of their own below. */}
      <div data-toast-live="" role="status" aria-live="polite" aria-atomic="false" className="sr-only pointer-events-none">
        {toasts
          .filter((toast) => toast.kind !== 'error')
          .map((toast) => (
            <div key={toast.id}>{toast.text}</div>
          ))}
      </div>
      {toasts.length > 0 && (
        <div
          data-toast-host=""
          className={
            'fixed bottom-statusbar mb-2 z-40 w-[400px] max-w-[calc(100vw-16px)] flex flex-col gap-2 pointer-events-none ' + offset
          }
          // Above the notices: their height and the gap on top of mb-2's 8px.
          style={lift > 0 ? { marginBottom: `${GAP_PX + lift}px` } : undefined}
        >
          {toasts.map((toast) => {
            const error = toast.kind === 'error';
            return (
              <div
                key={toast.id}
                role={error ? 'alert' : undefined}
                data-toast={toast.kind}
                className={
                  'pointer-events-auto flex items-start gap-2 px-3 py-2 bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-popover text-ui text-vsc-fg ' +
                  (error ? 'animate-toast-in' : 'animate-toast-in-out')
                }
              >
                {error ? (
                  <CircleAlert size={16} className="shrink-0 mt-px text-vsc-error" />
                ) : (
                  <Check size={16} className="shrink-0 mt-px text-vsc-muted" />
                )}
                {/* A confirmation's words are said by the polite region
                    above, their one accessible copy; drawn here for the eye
                    only (the icon is aria-hidden by lucide), so browse mode
                    does not read them twice. An error is its own alert and
                    is read here. */}
                <div aria-hidden={error ? undefined : 'true'} className="min-w-0 flex-1 break-words">
                  {toast.text}
                </div>
                <button
                  type="button"
                  title="Dismiss"
                  aria-label="Dismiss"
                  // Keep focus where it is (usually the terminal): a button that
                  // takes it and then goes leaves the keyboard on the page.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default ToastHost;
