import React from 'react';
import { KeyboardOff } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { READ_ONLY_STRIP_TEXT, READ_ONLY_TURN_OFF, READ_ONLY_TURN_OFF_HINT, isReadOnly } from '../../lib/readOnly.js';
import { cn } from '../../lib/utils.js';

/**
 * The strip a read-only terminal's pane shows (bundle 4, A3): a thin row of
 * its own ABOVE the terminal, saying that what you type does not reach it,
 * with the Turn Off button the refusal toasts name ("Turn Off in the pane").
 * Laid over the terminal it would hide its top row for as long as the
 * terminal stays read-only — in a full-screen program, a row that never
 * scrolls into view — so it is real layout, as the resume offer is, and
 * TerminalView's ResizeObserver refits the xterm (and tells its program)
 * when it comes and when it goes.
 *
 * Subscribed to that one terminal's boolean; nothing at all while it is
 * writable. The surface is the panel's, the words the UI's own text, the
 * mark lucide's `KeyboardOff` — the badge's shape — so forced colours repaint
 * all of it and it still reads. Nothing moves, so reduced motion has nothing
 * to stop.
 */
export function ReadOnlyStrip({ tabId }) {
  const readOnly = useTerminalStore((s) => isReadOnly(s, tabId));
  if (!readOnly) return null;
  const turnOff = (e) => {
    useTerminalStore.getState().setReadOnly?.(tabId, false);
    // The keyboard back to the terminal it now reaches; Turn Off is gone.
    const input = e.currentTarget.closest?.('[data-pane-body]')?.querySelector?.('.xterm-helper-textarea');
    setTimeout(() => input?.focus?.({ preventScroll: true }), 0);
  };
  return (
    <div
      role="status"
      data-read-only-strip={tabId}
      className={cn(
        'shrink-0 flex items-center gap-2 h-[24px] px-2',
        'bg-vsc-panel border-b border-vsc-border text-ui-sm text-vsc-fg'
      )}
    >
      <KeyboardOff size={12} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-vsc-fg-bright" />
      <span className="min-w-0 flex-1 truncate">{READ_ONLY_STRIP_TEXT}</span>
      <button
        type="button"
        data-read-only-turn-off={tabId}
        title={READ_ONLY_TURN_OFF_HINT}
        onClick={turnOff}
        className="shrink-0 flex items-center h-[18px] px-2 rounded-control bg-vsc-button-secondary border border-vsc-input-border hover:bg-vsc-item-hover text-vsc-fg transition-colors"
      >
        {READ_ONLY_TURN_OFF}
      </button>
    </div>
  );
}

export default ReadOnlyStrip;
