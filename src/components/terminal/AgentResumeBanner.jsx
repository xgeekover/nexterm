import React from 'react';
import { Play, X } from 'lucide-react';
import { agentLabel, resumeCertainty } from '../../lib/agents.js';
import { cn } from '../../lib/utils.js';

/** "2 hours ago", roughly. Absent or nonsense timestamps say nothing at all. */
function when(ts) {
  if (!Number.isFinite(ts)) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Why Resume is greyed out while something is running in the terminal.
 *
 * Resuming TYPES a command into the shell (see agents.js). With another
 * program in the foreground — an editor, a REPL, a password prompt — those
 * keystrokes would go to that program instead of the shell.
 */
const BUSY_REASON =
  'Something is still running in this terminal, and Resume would type into it. Available again when it finishes.';

/**
 * The offer to pick an agent conversation back up in a restored terminal.
 *
 * Offered, not taken. Starting an agent runs a real CLI that spends tokens
 * and calls an API, and doing that for every restored terminal the moment the
 * app opens is not something to decide on the user's behalf.
 *
 * It also has to be honest about three things:
 *
 * - **the scrollback is gone.** What comes back is the conversation inside
 *   the CLI, not the screen. The wording says "conversation" and never
 *   "session" or "restore" for that reason.
 * - **how sure the resume is.** With `claude` NexTerm chose the id, so it is
 *   that conversation. With `opencode` there is no way to choose one, so the
 *   best the CLI can do is the most recent in this folder — and if two such
 *   terminals were open on one folder, they would both land on it. That is
 *   what the second line says instead of pretending otherwise.
 * - **what the time is.** `agent.startedAt` is when the agent was STARTED in
 *   this terminal, and resuming does not move it — so it is "started", never
 *   "last used", which nothing records. With `opencode` the conversation
 *   picked up may not be the one started then, so there the time is said of
 *   the terminal, not of the conversation.
 *
 * Resume is disabled — not hidden, so it is plain it will come back — while
 * `tab.running` (between the shell's OSC 133 C and D markers); see
 * BUSY_REASON. Dismiss never is: leaving the terminal alone is always safe.
 *
 * It is a row of its own that the caller lays out ABOVE the terminal, never
 * over it: drawn over the terminal it hid the first rows, which is exactly
 * where a freshly restored shell prints its prompt.
 */
export function AgentResumeBanner({ tab, onResume, onDismiss }) {
  const agent = tab?.agent;
  if (!tab?.agentResumeOffered || !agent) return null;

  const certainty = resumeCertainty(agent);
  if (!certainty) return null;

  const label = agentLabel(agent.kind);
  const ago = when(agent.startedAt);
  const busy = Boolean(tab.running);
  const detail =
    certainty === 'exact'
      ? `Picks up the conversation this terminal had${ago ? `, started ${ago}` : ''}.`
      : `Picks up the most recent ${label} conversation in this folder${ago ? `; ${label} was started in this terminal ${ago}` : ''}.`;

  return (
    <div
      role="status"
      data-agent-resume=""
      className={cn(
        'shrink-0 flex items-start gap-3 px-3 py-2',
        'bg-vsc-panel border-b border-vsc-border text-ui-sm'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-vsc-fg font-medium">Resume {label}?</div>
        <div className="text-vsc-muted">
          {detail} The terminal&rsquo;s own scrollback is not restored.
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          title={busy ? BUSY_REASON : undefined}
          // Same button the empty pane uses for New Terminal; `vsc-button`
          // is not a token this theme defines and would have styled nothing.
          // Disabled, the hover must not light it up as if it were clickable.
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-vsc-button-secondary hover:bg-vsc-item-hover text-vsc-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-vsc-button-secondary"
        >
          <Play size={12} />
          Resume
        </button>
        <button
          type="button"
          onClick={onDismiss}
          title="Leave this as a plain shell"
          aria-label="Dismiss"
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export default AgentResumeBanner;
