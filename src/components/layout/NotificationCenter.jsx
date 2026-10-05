import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, Circle, MessageSquareText, X, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { durationLabel, isFailure, notificationSummary } from '../../lib/tabActivity.js';
import { cn } from '../../lib/utils.js';

/**
 * A failure is a code the shell gave that is not 0. cmd gives none — its
 * prompt can say a command ended but not how — and that is a command that
 * finished, not one that failed. A program's message carries no code at all,
 * and is never one.
 */
const failed = (note) => note.kind !== 'program' && isFailure(note.exitCode);

/**
 * Where the list opens for a bell at `el`: `right` / `bottom` in pixels for a
 * `fixed` element, so that it sits 4 px above the bell with its right edge on
 * the bell's — never past the window's right edge. Null with no bell to
 * measure, which leaves the list at the window's corner.
 */
export function listAnchor(el, win = globalThis.window) {
  const rect = el?.getBoundingClientRect?.();
  if (!rect || !win) return null;
  return {
    right: Math.max(4, Math.round(win.innerWidth - rect.right)),
    bottom: Math.max(4, Math.round(win.innerHeight - rect.top + 4)),
  };
}

/**
 * What finished while you were looking somewhere else.
 *
 * A bell sat at the end of this bar for four releases with no `onClick` at
 * all, and was removed rather than left lying. This puts one back now that
 * there is something real to put in it: the shell reports when a command
 * starts and when it ends, so the app can say that the build in the other
 * group failed four minutes ago — which is the entire reason for running
 * something in a terminal you are not watching. Programs that notify the way
 * terminals expect — OpenCode, Claude Code — put what they say here too (see
 * src/lib/programNotifications.js).
 *
 * It appears only when there is something to show, the same rule the zoom chip
 * beside it follows. A permanently visible bell that opens an empty list is
 * how the last one ended up meaningless.
 *
 * Clicking an entry goes to that terminal and drops it, because "take me
 * there" is the only thing anyone wants from one of these.
 */
export function NotificationCenter() {
  const notifications = useTerminalStore((s) => s.notifications);
  const dismiss = useTerminalStore((s) => s.dismissNotification);
  const clearAll = useTerminalStore((s) => s.clearNotifications);
  // `switchTab` and not `activateTab`: the latter is a local helper inside
  // TerminalsPanel, not a store action, and calling it through `?.()` here
  // would have made this a button that looks alive and does nothing — the
  // exact thing the old notifications bell was.
  const switchTab = useTerminalStore((s) => s.switchTab);
  const [open, setOpen] = useState(false);
  // Where the list opens: just above the bell, its right edge on the bell's.
  // Measured as it opens, and the list is `fixed`, because the status bar it
  // hangs from clips what overflows it (`overflow-hidden`, which the bar
  // needs for its own text): drawn `absolute` above the bar, the list was cut
  // off entirely — nothing on screen, and a click there landed on the panel
  // behind it.
  const [anchor, setAnchor] = useState(null);
  const rootRef = useRef(null);
  const bellRef = useRef(null);

  // Close on a click anywhere else, on Escape — a popover pinned to the
  // bottom-right corner is easy to forget is open — or when the window is
  // resized, which moves the bell out from under where the list was put.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => setOpen(false);
    // Capture, as the menus' own outside-click listeners are: a press a
    // terminal keeps to itself — a right-click that pastes, see
    // terminalRightClick.js — never bubbles up to the window.
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // Nothing to say, nothing on screen.
  if (notifications.length === 0) return null;

  const failures = notifications.filter(failed).length;
  const summary = notificationSummary(notifications);

  return (
    <div ref={rootRef} className="relative h-full shrink-0">
      <button
        ref={bellRef}
        type="button"
        aria-expanded={open}
        aria-label={summary.label}
        title={summary.title}
        onClick={() => {
          if (!open) setAnchor(listAnchor(bellRef.current));
          setOpen(!open);
        }}
        className={cn(
          'h-full px-2 flex items-center gap-1 text-vsc-fg hover:bg-vsc-item-hover',
          open && 'bg-vsc-item-active'
        )}
      >
        <Bell size={13} />
        <span
          data-notification-count
          className={cn(
            'min-w-[14px] px-1 rounded-full text-[10px] leading-[14px] text-center',
            failures > 0 ? 'bg-vsc-error text-white' : 'bg-vsc-badge text-vsc-badge-fg'
          )}
        >
          {notifications.length}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={summary.dialog}
          style={anchor ?? undefined}
          className="fixed z-50 w-[320px] max-h-[320px] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] overflow-hidden"
        >
          <div className="h-[28px] shrink-0 px-2 flex items-center justify-between border-b border-vsc-border">
            <span className="text-ui-sm text-vsc-muted">{summary.heading}</span>
            <button
              type="button"
              onClick={() => {
                clearAll();
                setOpen(false);
              }}
              className="text-ui-sm text-vsc-link hover:underline"
            >
              Clear all
            </button>
          </div>

          <NotificationList
            notifications={notifications}
            onGo={(note) => {
              switchTab(note.tabId);
              dismiss(note.id);
              setOpen(false);
            }}
            onDismiss={(note) => dismiss(note.id)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The entries, newest first. A finished command shows how it went — a tick, a
 * cross with its exit code, or neither for cmd — and how long it ran. A
 * program's message shows its title over what it said, the whole of it on
 * hover; the title is the terminal's when the program gave none.
 *
 * Its own component so the render suite can draw it: the popover around it
 * opens only on a click, which a server render never makes.
 */
export function NotificationList({ notifications, onGo, onDismiss }) {
  return (
    <div className="flex-1 overflow-y-auto">
      {notifications.map((note) => {
        const program = note.kind === 'program';
        return (
          <div
            key={note.id}
            data-notification-entry={program ? 'program' : 'command'}
            className="group/note flex items-center gap-2 px-2 py-1 hover:bg-vsc-item-hover"
          >
            <button
              type="button"
              onClick={() => onGo?.(note)}
              className="flex-1 min-w-0 flex items-center gap-2 text-left"
              title={`Go to ${program ? note.tabTitle || note.title : note.title}`}
            >
              {program ? (
                <MessageSquareText size={13} className="shrink-0 text-vsc-info" />
              ) : failed(note) ? (
                <XCircle size={13} className="shrink-0 text-vsc-error" />
              ) : note.exitCode === 0 ? (
                <Check size={13} className="shrink-0 text-vsc-ok" />
              ) : (
                <Circle size={13} className="shrink-0 text-vsc-muted" />
              )}
              {program ? (
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="truncate text-ui text-vsc-fg">{note.title}</span>
                  {note.body && (
                    <span className="truncate text-ui-sm text-vsc-muted" title={note.body}>
                      {note.body}
                    </span>
                  )}
                </span>
              ) : (
                <>
                  <span className="truncate text-ui text-vsc-fg">{note.title}</span>
                  <span className="ml-auto shrink-0 text-ui-sm text-vsc-muted tabular-nums">
                    {failed(note) ? `exit ${note.exitCode}` : durationLabel(note.durationMs)}
                  </span>
                </>
              )}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => onDismiss?.(note)}
              className="shrink-0 p-0.5 rounded-sm text-vsc-muted opacity-0 group-hover/note:opacity-100 hover:bg-vsc-item-hover hover:text-vsc-fg"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default NotificationCenter;
