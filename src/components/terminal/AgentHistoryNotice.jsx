import React from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useEditorStore } from '../../stores/editorStore.js';

/** The first line of each notice, by `resumeFromHistory`'s outcome. */
const HEADINGS = {
  focused: 'Already open',
  missingFolder: 'Folder not found',
  refused: 'Not resumed',
  gone: 'No longer in the list',
  unreadable: 'Agent session history not read',
  failed: 'No terminal could be started',
  clearFailed: 'Agent session history not cleared',
  newConversation: 'New conversation started',
};

/** The notices that tell what was done rather than what went wrong. */
const INFORMATIONAL = new Set(['focused', 'newConversation']);

/**
 * What picking an entry of AGENT SESSIONS (the side bar, or the palette's
 * Resume Agent Session…) did instead of opening a terminal: switched to the
 * terminal that already holds it, or why it could not (terminalStore's
 * `resumeFromHistory`, which sets `agentHistoryNotice`) — or, for a Claude
 * Code conversation that was never saved, that a new one was started in the
 * terminal it opened ('newConversation'). And a Clear Agent
 * Session History… that failed (`showAgentHistoryNotice`, 'clearFailed').
 *
 * Drawn as OpenFailureNotice is, over the corner of the window above the
 * status bar: the palette has closed by the time the answer comes, and the
 * side bar may not be on screen. It stays until it is dismissed or the next
 * pick replaces it. Beside that notice, not over it, when both are up.
 */
export function AgentHistoryNotice() {
  const notice = useTerminalStore((s) => s.agentHistoryNotice);
  const dismiss = useTerminalStore((s) => s.dismissAgentHistoryNotice);
  const besideOpenFailure = useEditorStore((s) => Boolean(s.openFailure));
  if (!notice) return null;
  const informational = INFORMATIONAL.has(notice.kind);

  return (
    <div
      role={informational ? 'status' : 'alert'}
      data-agent-history-notice={notice.kind}
      className={
        'fixed bottom-statusbar mb-2 z-40 w-[400px] max-w-[calc(100vw-16px)] flex items-start gap-2 px-3 py-2 bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-ui text-vsc-fg ' +
        (besideOpenFailure ? 'right-[416px]' : 'right-2')
      }
    >
      {informational ? (
        <Info size={16} className="shrink-0 mt-px text-vsc-muted" />
      ) : (
        <CircleAlert size={16} className="shrink-0 mt-px text-vsc-error" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate">{HEADINGS[notice.kind] ?? 'Agent session'}</div>
        <div className="text-ui-sm text-vsc-muted break-words">{notice.text}</div>
      </div>
      <button
        type="button"
        title="Dismiss"
        aria-label="Dismiss"
        // Keep focus where it is (the terminal switched to, usually): a
        // button that takes it and then goes leaves the keyboard on the page.
        onMouseDown={(e) => e.preventDefault()}
        onClick={dismiss}
        className="shrink-0 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default AgentHistoryNotice;
