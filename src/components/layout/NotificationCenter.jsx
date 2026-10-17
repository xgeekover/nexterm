import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, Check, Circle, MessageSquareText, X, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { durationLabel, isFailure, notificationSummary } from '../../lib/tabActivity.js';
import { bellText, hasUnreadFailure, isUnread, unreadLabel, unreadTotal } from '../../lib/attention.js';
import { cn } from '../../lib/utils.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';

/**
 * A failure is a code the shell gave that is not 0. cmd gives none — its
 * prompt can say a command ended but not how — and that is a command that
 * finished, not one that failed. A program's message and a terminal's bell
 * carry no code at all, and are never one.
 */
const failed = (note) => note.kind !== 'program' && note.kind !== 'bell' && isFailure(note.exitCode);

/**
 * What had the keyboard before the list opened, if it can have it back:
 * still on the page, and not the bell or something in the list — those go
 * with the list, or are where the keyboard already is. Null otherwise.
 *
 * Remembered as the bell is pressed (`openerRef`), not as the list opens:
 * in Chromium and WebView2 a click on the bell gives the bell the keyboard
 * first, and what had it — the editor, say — would be lost by then.
 */
export function focusBackTarget(opener, root) {
  if (!opener || opener.isConnected === false || typeof opener.focus !== 'function') return null;
  if (root && typeof root.contains === 'function' && root.contains(opener)) return null;
  return opener;
}

/**
 * Where the keyboard goes when Escape closes the list: back to what had it
 * before the list opened (`focusBackTarget`), else to the bell — never left
 * on a control that is about to be gone, which drops it to the page. Null
 * when it was not in the list at all (a terminal, with the list left open
 * beside it): Escape closes the list and takes nothing from there.
 */
export function escapeFocusTarget(root, active, bell, opener = null) {
  if (!root || !active || typeof root.contains !== 'function' || !root.contains(active)) return null;
  return focusBackTarget(opener, root) ?? bell ?? null;
}

/** The control that goes to an entry, in `row` — or in the dialog, for its first entry. */
export function entryButtonIn(el) {
  return el?.querySelector?.('[data-notification-go]') ?? null;
}

/**
 * The entry to give the keyboard to when `row` is dismissed from it: the
 * one after, else the one before. Null when it was the last, and the list —
 * and the bell with it — is about to go.
 */
export function neighbourEntry(row) {
  return entryButtonIn(row?.nextElementSibling) ?? entryButtonIn(row?.previousElementSibling);
}

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
 * Its number is what is still UNREAD (src/lib/attention.js) — what is
 * waiting for you, the same entries that ring a pane and count on its tab —
 * not how long the list is. An entry is read once its terminal has been
 * seen, and stays in the list, dimmed, until it is dismissed or cleared:
 * "what happened over there" is still worth reading after you have been.
 * With entries and nothing unread the bell is muted and has no number, and
 * it turns red while an unread one is a command that failed.
 *
 * Clicking an entry goes to that terminal, gives it the keyboard and marks it
 * read (`goToNotification`), because "take me there" is the only thing anyone
 * wants from one of these.
 *
 * Closed from inside — Escape, Clear all, the last entry dismissed — the
 * keyboard goes back where it was before the list opened, the editor as
 * much as a terminal; see `focusBackTarget`.
 */
export function NotificationCenter() {
  const notifications = useTerminalStore((s) => s.notifications);
  const dismiss = useTerminalStore((s) => s.dismissNotification);
  const clearAll = useTerminalStore((s) => s.clearNotifications);
  const markAllRead = useTerminalStore((s) => s.markAllNotificationsRead);
  // A store action, which shows the terminal's group, pane and panel as
  // well as switching to it. Not TerminalsPanel's `activateTab`: that is a
  // local helper there, and calling it through `?.()` here once made this a
  // button that looked alive and did nothing — the exact thing the old
  // notifications bell was.
  const goToNotification = useTerminalStore((s) => s.goToNotification);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
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
  const dialogRef = useRef(null);
  // What had the keyboard as the bell was pressed (see `focusBackTarget`).
  const openerRef = useRef(null);
  const rememberOpener = () => {
    if (!open) openerRef.current = document.activeElement;
  };

  // Another terminal became the active one — Go to Latest Unread
  // Notification, a click in the side bar — and the list was about what is
  // waiting: it closes and lets the jump through, rather than standing over
  // the terminal just gone to. On mount `open` is false already.
  useEffect(() => {
    setOpen(false);
  }, [activeTabId]);

  // Close on a click anywhere else, on Escape — a popover pinned to the
  // bottom-right corner is easy to forget is open — or when the window is
  // resized, which moves the bell out from under where the list was put.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const back = escapeFocusTarget(rootRef.current, document.activeElement, bellRef.current, openerRef.current);
      setOpen(false);
      back?.focus();
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

  const unread = unreadTotal(notifications);
  const summary = notificationSummary(notifications);
  // The summary says what is in the list; this says how much of it is new —
  // and, in words, what the red means: a colour is not something a screen
  // reader can read out.
  const failedUnread = notifications.filter((n) => isUnread(n) && failed(n)).length;
  const failedWords =
    failedUnread === 0 ? '' : failedUnread === 1 ? ', 1 of them a failed command' : `, ${failedUnread} of them failed commands`;
  const readState = unread > 0 ? `${unreadLabel(unread)}${failedWords}` : 'all read';

  /**
   * The bell is about to go with the last entry, or with all of them: the
   * keyboard, if it was in here, goes back where it was before the list
   * opened, or — that gone too — to the terminal or the file on screen
   * (`focusWorkspace`), rather than falling to the page.
   */
  const leaveIfInside = () => {
    if (!rootRef.current?.contains(document.activeElement)) return;
    const back = focusBackTarget(openerRef.current, rootRef.current);
    if (back) back.focus();
    else focusWorkspace();
  };

  return (
    <div ref={rootRef} className="relative h-full shrink-0">
      <button
        ref={bellRef}
        type="button"
        aria-expanded={open}
        aria-label={`${summary.label} — ${readState}`}
        title={`${summary.title} — ${readState}`}
        data-notification-bell={unread > 0 ? 'unread' : 'read'}
        onPointerDown={rememberOpener}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') rememberOpener();
        }}
        onClick={() => {
          if (!open) setAnchor(listAnchor(bellRef.current));
          setOpen(!open);
        }}
        className={cn(
          'h-full px-2 flex items-center gap-1 hover:bg-vsc-item-hover',
          unread > 0 ? 'text-vsc-fg' : 'text-vsc-muted',
          open && 'bg-vsc-item-active'
        )}
      >
        <Bell size={13} />
        {unread > 0 && (
          <span
            data-notification-count={unread}
            className={cn(
              'min-w-[14px] px-1 rounded-full text-[10px] leading-[14px] text-center',
              hasUnreadFailure(notifications) ? 'bg-vsc-error text-vsc-fg-bright' : 'bg-vsc-badge text-vsc-badge-fg'
            )}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <NotificationPopover
          dialogRef={dialogRef}
          anchor={anchor}
          summary={summary}
          unread={unread}
          notifications={notifications}
          onMarkAllRead={markAllRead}
          onClearAll={() => {
            leaveIfInside();
            clearAll();
            setOpen(false);
          }}
          onGo={(note) => {
            goToNotification(note.id);
            setOpen(false);
          }}
          onDismiss={(note, e) => {
            // The row goes, and the ✕ that had the keyboard with it.
            const row = e?.currentTarget?.closest?.('[data-notification-entry]');
            if (row?.contains(document.activeElement)) {
              const next = neighbourEntry(row);
              if (next) next.focus();
              else leaveIfInside();
            }
            dismiss(note.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * The open list: its header — what it holds, Mark all read, Clear all — over
 * the entries. `data-bell-list` names it for what looks for open dialogs
 * (workspaceFocus.js): this one is not modal, and a jump to a terminal may
 * go on past it.
 *
 * Its own component so the render suite can draw it open; the bell opens it
 * only on a click, which a server render never makes.
 */
export function NotificationPopover({
  dialogRef,
  anchor,
  summary,
  unread,
  notifications,
  onMarkAllRead,
  onClearAll,
  onGo,
  onDismiss,
}) {
  return (
    <div
      ref={dialogRef}
      role="dialog"
      data-bell-list=""
      aria-label={summary.dialog}
      style={anchor ?? undefined}
      className="fixed z-50 w-[320px] max-h-[320px] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] overflow-hidden"
    >
      <div className="h-[28px] shrink-0 px-2 flex items-center gap-3 border-b border-vsc-border">
        <span className="flex-1 min-w-0 truncate text-ui-sm text-vsc-muted">{summary.heading}</span>
        {/* Stays open: the rows dimming is the answer to the click. It
            disables itself, so the keyboard on it goes to the first entry
            first — a disabled button drops focus to the page. */}
        <button
          type="button"
          data-mark-all-read=""
          disabled={unread === 0}
          onClick={(e) => {
            if (document.activeElement === e.currentTarget) entryButtonIn(dialogRef?.current)?.focus();
            onMarkAllRead?.();
          }}
          title={unread === 0 ? 'Nothing is unread' : undefined}
          className="shrink-0 text-ui-sm text-vsc-link hover:underline disabled:text-vsc-muted disabled:no-underline disabled:cursor-default"
        >
          Mark all read
        </button>
        <button
          type="button"
          data-clear-all=""
          onClick={() => onClearAll?.()}
          className="shrink-0 text-ui-sm text-vsc-link hover:underline"
        >
          Clear all
        </button>
      </div>

      <NotificationList notifications={notifications} onGo={onGo} onDismiss={onDismiss} />
    </div>
  );
}

/**
 * The entries, newest first. A finished command shows how it went — a tick, a
 * cross with its exit code, or neither for cmd — and how long it ran. A
 * program's message shows its title over what it said, the whole of it on
 * hover; the title is the terminal's when the program gave none. A
 * terminal's bell names the terminal and how many times it rang ("Bell ×3"):
 * the rings of one terminal while unread are one entry (`addBell`).
 *
 * An unread entry is bold, with a dot in the attention colour in front; a
 * read one has neither, and its title is in the muted colour. Not faded:
 * faded, its 11px lines were 3:1 against the list. The muted colour on the
 * list is 6:1, and every muted line turns the normal colour under the
 * pointer or the keyboard, where the row's highlight would take it under
 * 4.5:1. The dot has a fixed slot either way, so read and unread rows line
 * up.
 *
 * The ✕ shows on hover, and whenever the row has the keyboard: a control you
 * have tabbed to and cannot see is not one you can use.
 *
 * Its own component so the render suite can draw it: the popover around it
 * opens only on a click, which a server render never makes.
 */
export function NotificationList({ notifications, onGo, onDismiss }) {
  const muted = 'text-vsc-muted group-hover/note:text-vsc-fg group-focus-within/note:text-vsc-fg';
  return (
    <div className="flex-1 overflow-y-auto">
      {notifications.map((note) => {
        const program = note.kind === 'program';
        const bell = note.kind === 'bell';
        const unread = isUnread(note);
        return (
          <div
            key={note.id}
            data-notification-entry={program ? 'program' : bell ? 'bell' : 'command'}
            data-unread={unread ? 'true' : 'false'}
            className="group/note flex items-center gap-1.5 px-2 py-1 hover:bg-vsc-item-hover"
          >
            <span
              aria-hidden="true"
              data-unread-dot={unread ? '' : undefined}
              className={cn('w-[6px] h-[6px] rounded-full shrink-0', unread && 'bg-vsc-attention')}
            />
            <button
              type="button"
              data-notification-go=""
              onClick={() => onGo?.(note)}
              className="flex-1 min-w-0 flex items-center gap-2 text-left"
              title={`Go to ${program || bell ? note.tabTitle || note.title : note.title}`}
            >
              {/* The dot is a colour; this is the same thing in words. */}
              {unread && <span className="sr-only">Unread: </span>}
              {program ? (
                <MessageSquareText size={13} className="shrink-0 text-vsc-info" />
              ) : bell ? (
                <BellRing size={13} className="shrink-0 text-vsc-attention" />
              ) : failed(note) ? (
                <XCircle size={13} className="shrink-0 text-vsc-error" />
              ) : note.exitCode === 0 ? (
                <Check size={13} className="shrink-0 text-vsc-ok" />
              ) : (
                <Circle size={13} className="shrink-0 text-vsc-muted" />
              )}
              {program ? (
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className={cn('truncate text-ui', unread ? 'text-vsc-fg font-semibold' : muted)}>{note.title}</span>
                  {note.body && (
                    <span className={cn('truncate text-ui-sm', muted)} title={note.body}>
                      {note.body}
                    </span>
                  )}
                </span>
              ) : (
                <>
                  <span className={cn('truncate text-ui', unread ? 'text-vsc-fg font-semibold' : muted)}>{note.title}</span>
                  <span className={cn('ml-auto shrink-0 text-ui-sm tabular-nums', muted)}>
                    {bell ? bellText(note.count) : failed(note) ? `exit ${note.exitCode}` : durationLabel(note.durationMs)}
                  </span>
                </>
              )}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={(e) => onDismiss?.(note, e)}
              className={cn(
                'shrink-0 p-0.5 rounded-sm text-vsc-muted hover:bg-vsc-item-hover hover:text-vsc-fg',
                'opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100 focus-visible:opacity-100'
              )}
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
