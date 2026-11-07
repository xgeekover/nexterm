import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useControlLogStore, LOG_LIMIT } from '../../stores/controlLogStore.js';
import { dialogReturn, focusBack } from '../../lib/dialogReturn.js';
import { swallowRepeatsOf } from '../../lib/heldKeys.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';
import { holdModal } from '../../lib/modalLock.js';
import { cn } from '../../lib/utils.js';

/**
 * Show Control Log (stage 7, spec D6): what programs in terminals asked
 * NexTerm to do through `nexterm-cli`, newest first — the last 500 calls,
 * kept in memory only (src/stores/controlLogStore.js). Each row is when,
 * which terminal asked, for what, of which terminal, how many bytes it typed
 * or lines it read, and the answer. What was typed and what was read are
 * never kept, so they are not here either.
 *
 * Opened from the command palette, which hands over what had the keyboard
 * (src/lib/dialogReturn.js): the dialog takes it as it opens and gives it
 * back as it closes. Escape and the ✕ close it, Tab goes round inside, and
 * the app's chords and menu do nothing behind it (modalLock.js).
 *
 * Drawn in the app's tree, not a portal, so the render suite draws it.
 * Every component here is declared at module level; the list subscribes to
 * the entries only while the dialog is open — a call every 50 ms must not
 * redraw anything nobody is looking at. No motion of its own, so reduced
 * motion has nothing to stop.
 */

const pad = (n) => String(n).padStart(2, '0');

/** A call's time as the list shows it: 24-hour, to the second, the same on every locale. */
function timeOf(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** What the call typed or read, in words: "12 bytes", "40 lines", or nothing. */
function amountOf(entry) {
  if (typeof entry.size === 'number') return `${entry.size} ${entry.size === 1 ? 'byte' : 'bytes'}`;
  if (typeof entry.lines === 'number') return `${entry.lines} ${entry.lines === 1 ? 'line' : 'lines'}`;
  return '';
}

/** Whom it was aimed at: its own terminal, another by name (and id), or nobody. */
function targetOf(entry) {
  if (entry.target === 'self') return 'itself';
  if (!entry.target) return '';
  return entry.targetTitle ? `${entry.targetTitle} (${entry.target})` : entry.target;
}

/** One call. */
function LogRow({ entry }) {
  const ok = entry.result === 'ok';
  return (
    <tr data-control-log-row={entry.id} className="border-b border-vsc-border last:border-b-0 align-top">
      <td className="py-1 pr-3 whitespace-nowrap tabular-nums text-vsc-muted">{timeOf(entry.at)}</td>
      <td className="py-1 pr-3 max-w-[160px] truncate" title={entry.caller ?? ''}>
        <bdi>{entry.callerTitle || entry.caller || 'unknown'}</bdi>
      </td>
      <td className="py-1 pr-3 whitespace-nowrap font-mono">{entry.cmd || '?'}</td>
      <td className="py-1 pr-3 max-w-[180px] truncate">
        <bdi>{targetOf(entry)}</bdi>
      </td>
      <td className="py-1 pr-3 whitespace-nowrap tabular-nums text-vsc-muted">{amountOf(entry)}</td>
      <td data-control-log-result={entry.result ?? ''} className={cn('py-1 whitespace-nowrap font-mono', ok ? 'text-vsc-ok' : 'text-vsc-error')}>
        {ok ? 'ok' : entry.result || '?'}
      </td>
    </tr>
  );
}

/** The calls, newest first — subscribed to only while the dialog is open. */
function LogList() {
  const entries = useControlLogStore((s) => s.entries);
  if (entries.length === 0) {
    return (
      <p data-control-log-empty="" className="m-0 py-6 text-center text-ui-sm text-vsc-muted">
        No program has asked NexTerm for anything yet.
      </p>
    );
  }
  const newestFirst = entries.slice().reverse();
  return (
    <table className="w-full border-collapse text-ui-sm">
      <thead>
        <tr className="text-left text-vsc-muted border-b border-vsc-border">
          <th className="py-1 pr-3 font-normal">Time</th>
          <th className="py-1 pr-3 font-normal">From</th>
          <th className="py-1 pr-3 font-normal">Command</th>
          <th className="py-1 pr-3 font-normal">Target</th>
          <th className="py-1 pr-3 font-normal">Typed or read</th>
          <th className="py-1 font-normal">Result</th>
        </tr>
      </thead>
      <tbody>
        {newestFirst.map((entry) => (
          <LogRow key={entry.id} entry={entry} />
        ))}
      </tbody>
    </table>
  );
}

/** How many calls are kept, for the heading. */
function LogCount() {
  const count = useControlLogStore((s) => s.entries.length);
  return (
    <span data-control-log-count={count} className="text-ui-sm text-vsc-muted tabular-nums">
      {count === 1 ? '1 call' : `${count} calls`}
    </span>
  );
}

/** The open dialog. */
function ControlLogBox() {
  const setOpen = useControlLogStore((s) => s.setOpen);
  const clear = useControlLogStore((s) => s.clear);
  const boxRef = useRef(null);
  const closeRef = useRef(null);
  const [returnTo] = useState(() => dialogReturn());
  const close = () => setOpen(false);

  // The app's chords and menu do nothing while this is open.
  useEffect(() => holdModal(), []);

  useEffect(() => {
    const box = boxRef.current;
    const focused = document.activeElement;
    const opener = returnTo ?? (box?.contains(focused) || focused === document.body ? null : focused);
    closeRef.current?.focus();
    // In the capture phase, ahead of whatever the key was aimed at: a
    // terminal behind the dialog must not also get a key the dialog keeps.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        swallowRepeatsOf('Escape');
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = Array.from(box?.querySelectorAll('button:not([disabled]), [tabindex="0"]') ?? []);
      if (stops.length === 0) return;
      e.preventDefault();
      const at = stops.indexOf(document.activeElement);
      const next = at === -1 ? 0 : (at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length;
      stops[next]?.focus();
    };
    // The keyboard stays in the dialog: a pane made active behind it (a
    // program's `focus`) takes focus as it does, and keys would go to it.
    const onFocusIn = (e) => {
      if (!box || box.contains(e.target)) return;
      closeRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      // Still on the page: React's development double effects, not a close.
      if (box?.isConnected) return;
      const now = document.activeElement;
      if (now && now !== document.body && !box?.contains(now)) return;
      focusBack(opener, () => focusWorkspace('terminal'));
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        close();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-log-title"
        aria-describedby="control-log-about"
        data-control-log-dialog=""
        tabIndex={-1}
        className="w-[760px] max-w-[94vw] max-h-[75vh] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-vsc-fg outline-none"
      >
        <div className="h-[35px] shrink-0 px-3 flex items-center gap-3 border-b border-vsc-border">
          <h2 id="control-log-title" className="m-0 text-ui font-semibold">
            Control Log
          </h2>
          <LogCount />
          <div className="flex-1" />
          <button
            type="button"
            onClick={clear}
            className="h-[24px] px-2 rounded-[3px] text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
          >
            Clear
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            title="Close"
            aria-label="Close"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
          >
            <X size={14} />
          </button>
        </div>
        <p id="control-log-about" className="m-0 px-3 pt-2 text-ui-sm text-vsc-muted">
          {`What programs in terminals asked NexTerm to do through nexterm-cli, newest first. The last ${LOG_LIMIT} calls are kept, in memory only, and go when NexTerm closes. What was typed and what was read are never kept.`}
        </p>
        <div tabIndex={0} aria-label="Calls" className="flex-1 min-h-0 overflow-y-auto px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-vsc-focus">
          <LogList />
        </div>
      </div>
    </div>
  );
}

/** Show Control Log's dialog, while it is open. */
export function ControlLogDialog() {
  const open = useControlLogStore((s) => s.open);
  return open ? <ControlLogBox /> : null;
}

export default ControlLogDialog;
