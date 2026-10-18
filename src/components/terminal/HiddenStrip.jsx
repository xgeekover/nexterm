import React from 'react';
import { Lock } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { unreadLabel } from '../../lib/attention.js';
import { TYPING_HIDDEN_LABEL } from '../../lib/secretInput.js';
import { ProgressBar, UnreadPill, progressWords } from './AttentionIndicators.jsx';
import { cn } from '../../lib/utils.js';

/**
 * The pieces of a pane whose tab strip is hidden (spec P1, "Hide the Tab
 * Strip of a Single Terminal") — the handle along its top edge and the
 * overlay the strip comes back in — and the marks a terminal's tab carries
 * besides its title (the stage 1 count, the stage 3 lock).
 *
 * The handle is real layout, 6 px, always the same height; the overlay is
 * laid over the terminal. Neither ever resizes it. Every component here is
 * declared at module level and subscribes for itself, to exactly what it
 * draws. When the strip comes back and goes is stripReveal.js's.
 */

/** Whether `tabId`'s terminal is asking for a password: one boolean, nothing else to redraw for. */
const useLocked = (tabId) => useTerminalStore((s) => Boolean(tabId && s.secretInput?.[tabId]));

/**
 * The lock on a terminal asking for a password (spec P4): its typing is
 * hidden — echo off in canonical mode, as sudo, ssh and `read -s` leave the
 * terminal (src-tauri/src/pty/echo_watch.rs). Subscribed to that one
 * terminal's boolean (`secretInput`); nothing at all when it is not asking.
 *
 * `role="img"` with the words, as the unread pill does: what it sits in
 * reads its name from its content, so "Typing is hidden (password prompt)"
 * is what a screen reader says there. The colour is the warning token's,
 * drawn by the icon in `currentColor`, so forced colours repaint it with the
 * text and it survives as a shape. Nothing moves, so reduced motion has
 * nothing to stop.
 *
 * In line, where it is drawn — the TERMINALS side bar's row, whose only
 * target is the whole row, so nothing clickable moves when it comes.
 */
export function LockMark({ tabId, className }) {
  if (!useLocked(tabId)) return null;
  return (
    <span
      role="img"
      aria-label={TYPING_HIDDEN_LABEL}
      title={TYPING_HIDDEN_LABEL}
      data-lock-mark={tabId}
      className={cn('shrink-0 inline-flex items-center justify-center w-[12px] h-[14px] text-vsc-warn', className)}
    >
      <Lock size={11} strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

/**
 * The lock on a TAB CHIP: the same lock, taking no room at all — a 10 px
 * badge on the chip's own top-left corner, away from its ✕, that the
 * pointer goes straight through. In line it pushed the ✕ and the "+" along
 * by its width the moment a prompt came up, and a click resting on either
 * closed the password terminal or opened another one (review). It ends
 * where the activity dot begins (8 px in) and sits above it, so the two
 * never overlap; and it stays inside the row of chips, which scrolls and
 * clips what is drawn beyond it. Its words are the chip's: in its tooltip
 * (the chip's title says them) and read from its content.
 */
export function LockBadge({ tabId }) {
  if (!useLocked(tabId)) return null;
  return (
    <span
      role="img"
      aria-label={TYPING_HIDDEN_LABEL}
      data-lock-mark={tabId}
      className={cn(
        'pointer-events-none absolute -top-[2px] -left-[2px] z-[1] flex items-center justify-center',
        'w-[10px] h-[10px] rounded-full bg-vsc-panel text-vsc-warn ring-1 ring-vsc-border'
      )}
    >
      <Lock size={8} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}

/**
 * What a terminal's row in the TERMINALS side bar says besides its title:
 * whether its typing is hidden (`LockMark`), then its unread count. A
 * fragment, no wrapper: with nothing to say it draws exactly what the pill
 * alone drew, on a line of fixed height.
 */
export function TabMarks({ tabId, unread, className }) {
  return (
    <>
      <LockMark tabId={tabId} className={className} />
      <UnreadPill count={unread} className={className} />
    </>
  );
}

/** The handle's marks in words: "Typing is hidden (password prompt), 2 unread notifications, 40% done". */
function handleWords({ locked = false, unread = 0, bar = null } = {}) {
  return [locked ? TYPING_HIDDEN_LABEL : '', unread > 0 ? unreadLabel(unread) : '', progressWords(bar)]
    .filter(Boolean)
    .join(', ');
}

/**
 * The handle of a pane whose strip is hidden: a 6 px bar along its top edge,
 * in layout — always there, always this height, so nothing about it ever
 * resizes the terminal below it. A toggle: a click on it (or Enter, or
 * Space: it is a button, reachable with Tab from the chrome around the
 * terminal — a focused terminal keeps Tab for its shell) brings the strip
 * up below it, and a second click puts it away; the second click of a
 * double-click changes nothing (stripReveal.js). `onToggle({ detail,
 * pointerType })` is told each click — 'keyboard' for Enter and Space.
 *
 * It carries what the strip's chip would say while the strip is down, as
 * small marks told apart by shape, not by colour alone: a padlock (a
 * password prompt), a dot (unread notifications), and the program's
 * progress as the 2 px bar along its bottom. Their words are its tooltip and
 * its accessible name, with what it does. In forced colours the dot and the
 * grip keep system colours (index.css), the padlock is drawn in the text
 * colour, and the bar as every progress bar is.
 *
 * `open`: the strip is up (`aria-expanded`). The right-click opens the
 * strip's own menu, as a right-click on the strip's empty space does.
 */
export function StripHandle({ paneId, tabId, title, unread = 0, open = false, handleRef, onToggle, onPress, onContextMenu }) {
  const locked = useLocked(tabId);
  const barsOn = useSettingsStore((s) => s.terminalProgress !== false);
  const stored = useTerminalStore((s) => (tabId ? s.progress[tabId] : undefined));
  const bar = barsOn ? stored ?? null : null;
  const marks = handleWords({ locked, unread, bar });
  const words = `${title}${marks ? ` — ${marks}` : ''}. ${open ? 'Hide' : 'Show'} its tab strip`;
  return (
    <button
      ref={handleRef}
      type="button"
      data-strip-handle={paneId}
      aria-label={words}
      aria-expanded={open}
      title={words}
      // A mouse press leaves the keyboard where it was — in the terminal.
      // Only Tab puts it on the handle.
      onMouseDown={(e) => e.preventDefault()}
      // What the opened strip refuses is timed from here (stripReveal.js).
      onPointerDown={onPress}
      onClick={(e) =>
        onToggle?.({
          detail: e.detail,
          // A click is a PointerEvent in Chromium and WebKit: which pointer
          // made it. Enter and Space make one with no pointer.
          pointerType: e.detail === 0 ? 'keyboard' : e.nativeEvent?.pointerType || 'mouse',
        })
      }
      onContextMenu={onContextMenu}
      className={cn(
        'group/handle relative shrink-0 block w-full h-[6px] p-0 m-0 cursor-pointer',
        'bg-vsc-panel border-0 border-b border-solid border-vsc-border hover:bg-vsc-hover outline-none',
        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vsc-focus'
      )}
    >
      {/* The grip: says "something to take hold of" without a word. */}
      <span
        aria-hidden="true"
        data-handle-grip=""
        className="absolute left-1/2 top-[1px] -translate-x-1/2 w-6 h-[2px] rounded-full bg-vsc-muted opacity-50 group-hover/handle:opacity-90"
      />
      <span aria-hidden="true" className="absolute left-1 top-0 bottom-[1px] z-[1] flex items-center gap-1">
        {locked && (
          <span data-handle-mark="lock" className="flex items-center text-vsc-warn">
            <Lock size={6} strokeWidth={3} aria-hidden="true" />
          </span>
        )}
        {unread > 0 && <span data-handle-mark="unread" className="w-[4px] h-[4px] rounded-full bg-vsc-attention" />}
      </span>
      <ProgressBar bar={bar} />
    </button>
  );
}

/**
 * The overlay a hidden strip comes back in: the very same strip, laid over
 * the top of the pane — its handle and the terminal's first row — so
 * showing or hiding it never resizes the terminal.
 *
 * Laid directly BELOW the handle (`top-[6px]`), never over it: the handle
 * stays clickable — a second click on it is the handle's, never a click on
 * whatever strip control would have been under it (stripReveal.js).
 *
 * Kept mounted while the strip is hidden, faded out and transparent to the
 * pointer — so `dropTargetAtPoint` never finds it then, and a drag finds it
 * the moment it is shown (`data-tab-strip` is on the strip inside). Drawn by
 * its state ALONE: drawn also while focus was inside it (`focus-within`), a
 * window that lost and regained focus showed a strip the state said was
 * closed, which neither Escape nor the handle could then put away. The
 * keyboard is kept agreeing instead: it goes into the strip when the strip
 * opens from the keyboard, and to the handle when it closes with the
 * keyboard in it (stripReveal.js).
 *
 * `guard`: capture-phase handlers that refuse a click or a tap meant for the
 * handle above it (`createStripClickGuard`) — the strip itself carries
 * nothing that destroys.
 *
 * A mouse press in it never moves focus out of the terminal: clicking a chip
 * or a button of a strip that goes away again would otherwise leave the
 * keyboard on something nobody can see. The rename field is the exception —
 * it is there to be typed into.
 *
 * Fades in 100ms; Reduce Motion (the OS's or the setting) makes that instant
 * with every other transition (index.css).
 */
export function StripOverlay({ shown, boxRef, guard, children }) {
  return (
    <div
      ref={boxRef}
      {...guard}
      data-strip-overlay=""
      data-shown={shown ? 'true' : 'false'}
      onMouseDown={(e) => {
        if (!e.target?.closest?.('input')) e.preventDefault();
      }}
      className={cn(
        'absolute top-[6px] left-0 right-0 z-30 transition-[opacity,transform] duration-100 ease-out',
        shown
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 -translate-y-1 pointer-events-none'
      )}
    >
      {children}
    </div>
  );
}
