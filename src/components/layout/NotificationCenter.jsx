import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, X, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { durationLabel } from '../../lib/tabActivity.js';
import { cn } from '../../lib/utils.js';

/**
 * What finished while you were looking somewhere else.
 *
 * A bell sat at the end of this bar for four releases with no `onClick` at
 * all, and was removed rather than left lying. This puts one back now that
 * there is something real to put in it: the shell reports when a command
 * starts and when it ends, so the app can say that the build in the other
 * group failed four minutes ago — which is the entire reason for running
 * something in a terminal you are not watching.
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
  const rootRef = useRef(null);

  // Close on a click anywhere else, or on Escape — a popover pinned to the
  // bottom-right corner is easy to forget is open.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to say, nothing on screen.
  if (notifications.length === 0) return null;

  const failures = notifications.filter((n) => n.exitCode !== 0).length;

  return (
    <div ref={rootRef} className="relative h-full shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${notifications.length} finished command${notifications.length === 1 ? '' : 's'}`}
        title={`${notifications.length} command${notifications.length === 1 ? '' : 's'} finished while you were elsewhere`}
        onClick={() => setOpen((v) => !v)}
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
          aria-label="Finished commands"
          className="absolute bottom-full right-0 mb-1 w-[320px] max-h-[320px] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] overflow-hidden"
        >
          <div className="h-[28px] shrink-0 px-2 flex items-center justify-between border-b border-vsc-border">
            <span className="text-ui-sm text-vsc-muted">Finished while you were elsewhere</span>
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

          <div className="flex-1 overflow-y-auto">
            {notifications.map((note) => (
              <div
                key={note.id}
                className="group/note flex items-center gap-2 px-2 py-1 hover:bg-vsc-item-hover"
              >
                <button
                  type="button"
                  onClick={() => {
                    switchTab(note.tabId);
                    dismiss(note.id);
                    setOpen(false);
                  }}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left"
                  title={`Go to ${note.title}`}
                >
                  {note.exitCode === 0 ? (
                    <Check size={13} className="shrink-0 text-vsc-ok" />
                  ) : (
                    <XCircle size={13} className="shrink-0 text-vsc-error" />
                  )}
                  <span className="truncate text-ui text-vsc-fg">{note.title}</span>
                  <span className="ml-auto shrink-0 text-ui-sm text-vsc-muted tabular-nums">
                    {note.exitCode === 0 ? durationLabel(note.durationMs) : `exit ${note.exitCode}`}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => dismiss(note.id)}
                  className="shrink-0 p-0.5 rounded-sm text-vsc-muted opacity-0 group-hover/note:opacity-100 hover:bg-vsc-item-hover hover:text-vsc-fg"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
