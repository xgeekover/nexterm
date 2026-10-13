import React, { useEffect, useRef, useState } from 'react';
import { Check, ListOrdered, Play, X } from 'lucide-react';
import { agentLabel, resumeCertainty } from '../../lib/agents.js';
import { cn } from '../../lib/utils.js';
import { ContextMenu } from '../common/ContextMenu.jsx';

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

/** How many of a folder's conversations the list offers; the newest come first. */
const CHOICES_SHOWN = 20;

/**
 * Closes the list that last opened by itself, in whichever banner that was:
 * at most one is open at a time.
 */
let closeAutoOpened = null;

/** Why Resume and Choose… wait while the terminal's conversation is being looked up. */
const LOOKING_REASON = 'Looking for this terminal\u{2019}s conversation\u{2026}';

/**
 * What the offer says about what Resume will do, from how sure it can be
 * (`resumeCertainty`) and, for opencode with no id, what happens when its
 * conversation is not found by name (`fallback`, the store's
 * `resumeFallbackFor`): 'continue' — the most recent conversation in the
 * folder or below, which `--continue` opens — or 'ask'. Said as it will
 * happen: the offer once promised to ask where it then typed `--continue`.
 */
function detailFor(certainty, { label, named, ago, fallback }) {
  if (certainty === 'exact') {
    return `Picks up ${named ? `${named}, ` : ''}the conversation this terminal had${ago ? `, started ${ago}` : ''}.`;
  }
  const started = ago ? `; ${label} was started in this terminal ${ago}` : '';
  const recent = `the most recent ${label} conversation in this folder or below`;
  if (certainty === 'lookup') {
    if (fallback === 'continue') {
      return named
        ? `Looks up ${named}, the conversation this terminal had, by its name \u{2014} or, not found, ${recent}${started}.`
        : `Picks up ${recent}${started}.`;
    }
    return named
      ? `Looks up ${named}, the conversation this terminal had, by its name, and asks if it cannot tell${started}.`
      : `Asks which of this folder\u{2019}s ${label} conversations this terminal had \u{2014} it never learned its name${started}.`;
  }
  return `Picks up the most recent ${label} conversation in this folder${started}${named ? ` \u{2014} it was in ${named}` : ''}.`;
}

/**
 * Why Resume did not type anything (`tab.agentResumeNotice`, set by the
 * store's `resumeAgent`), or a list the user opened that could not be read
 * (`failure`): one line, with the backend's own reason word for word — that
 * reason is what tells a failing machine's cause apart from the others.
 */
function noticeText(notice, failure, label) {
  // Ended here with a full stop of its own, whatever the backend ended it with.
  const reason = String(notice?.reason ?? failure ?? '').replace(/[.,;:\s]+$/, '');
  const parts = [];
  if (notice?.kind === 'unsure') parts.push('Could not tell which conversation this terminal had \u{2014} choose one below.');
  if (notice?.kind === 'taken') {
    parts.push(
      notice.latest
        ? `${notice.heldBy} already continued the most recent conversation \u{2014} choose another.`
        : `That conversation is open in ${notice.heldBy} already \u{2014} choose another.`
    );
  }
  if (reason) parts.push(`Could not list ${label}\u{2019}s conversations: ${reason}.`);
  if (notice?.kind === 'unreadable' && notice.shared) {
    parts.push(
      `Another ${label} terminal is in this folder, above it or below it, so the most recent conversation may be that terminal\u{2019}s \u{2014} choose below.`
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

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
 *   that conversation. With `opencode` it is that conversation once the
 *   terminal has learned which one it showed — from the title opencode gives
 *   the terminal (src/lib/agents.js) — and the offer names it. Until then
 *   Resume looks it up by the title the terminal kept, among the folder's
 *   conversations no other terminal has; when that cannot tell, it types
 *   nothing, says why, and opens "Choose…" rather than guess — a guess is how
 *   two terminals on one folder both landed in the same conversation. The
 *   backend's reason is shown word for word when the list cannot be read.
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
export function AgentResumeBanner({
  tab,
  fallback = null,
  autoOpen = true,
  onResume,
  onDismiss,
  onListSessions,
  onResumeWith,
}) {
  // The "Choose…" list: where it opens, and what it holds so far.
  const [choices, setChoices] = useState(null);
  // Why the list the user opened could not be read, said on the banner too.
  const [failure, setFailure] = useState(null);
  const chooseRef = useRef(null);
  // The offer's own box: with focus anywhere in it, the open list takes keys.
  const bannerRef = useRef(null);
  // The notice the list last opened by itself for, so it opens once for each.
  const openedFor = useRef(null);
  const agent = tab?.agent;
  const offered = Boolean(tab?.agentResumeOffered && agent);
  const label = agentLabel(agent?.kind);
  const notice = offered ? tab.agentResumeNotice ?? null : null;

  // `auto`: opened by itself, for a notice — it then takes no focus.
  const openChoices = async (anchor, { auto = false } = {}) => {
    const box = anchor.getBoundingClientRect();
    const at = { x: box.left, y: box.bottom + 2, auto };
    setChoices({ ...at, items: [{ key: 'loading', label: `Looking for ${label} conversations…`, disabled: true }] });
    // Not a conversation of the list: what to do when none of them is it.
    const fresh = { key: 'fresh', label: `Start a new ${label} conversation`, onSelect: () => onResumeWith({ fresh: true }) };
    const latest = {
      key: 'latest',
      // `--continue`: the folder's most recent, or one in a folder below it.
      label: `Continue the most recent ${label} conversation in this folder or below`,
      onSelect: () => onResumeWith({ latest: true }),
    };
    let items;
    try {
      const sessions = await onListSessions();
      setFailure(null);
      const listed =
        sessions.length > 0
          ? sessions.slice(0, CHOICES_SHOWN).map((s) => ({
              key: s.id,
              // Open in another terminal already: shown, and not to be picked —
              // the store refuses it too (`takenByOther`).
              label: s.heldBy ? `${s.title || s.id} \u{2014} open in ${s.heldBy}` : s.title || s.id,
              disabled: Boolean(s.heldBy),
              disabledReason: s.heldBy ? `Open in ${s.heldBy} already` : undefined,
              // The one this terminal is known to have had.
              icon: s.id === agent.sessionId ? Check : undefined,
              shortcut: when(s.updated) ?? undefined,
              onSelect: () => onResumeWith({ sessionId: s.id, title: s.title }),
            }))
          : [{ key: 'none', label: `No ${label} conversations in this folder`, disabled: true }];
      // With nothing listed, the list may only spell this folder differently
      // from opencode; `--continue` finds the folder by itself.
      items = [...listed, { type: 'separator', key: 'others' }, ...(sessions.length === 0 ? [latest] : []), fresh];
    } catch (err) {
      const reason = String(err?.message ?? err);
      setFailure(reason);
      items = [
        { key: 'error', label: `Could not list ${label}\u{2019}s conversations`, disabled: true, disabledReason: reason },
        { type: 'separator', key: 'others' },
        latest,
        fresh,
      ];
    }
    // Only into a list that is still open.
    setChoices((open) => (open ? { ...open, items } : open));
  };

  // Resume could not tell which conversation this terminal had, and typed
  // nothing: the list opens by itself, under Choose…, once per notice — in
  // the active pane only (`autoOpen`), and never beside another that did
  // (`closeAutoOpened`). Two lists open at once both took the same Enter.
  const noticeSeq = notice?.seq ?? null;
  useEffect(() => {
    if (noticeSeq === null || !autoOpen || openedFor.current === noticeSeq || !chooseRef.current) return undefined;
    openedFor.current = noticeSeq;
    closeAutoOpened?.();
    const close = () => setChoices(null);
    closeAutoOpened = close;
    openChoices(chooseRef.current, { auto: true });
    return () => {
      if (closeAutoOpened === close) closeAutoOpened = null;
    };
    // Opened once for each notice, not again for every render while it shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeSeq, autoOpen]);

  if (!offered) return null;
  const certainty = resumeCertainty(agent);
  if (!certainty) return null;

  const ago = when(agent.startedAt);
  const busy = Boolean(tab.running);
  const looking = Boolean(tab.agentResumeLooking);
  const waitReason = busy ? BUSY_REASON : looking ? LOOKING_REASON : null;
  // The conversation's own name, when the terminal learned it (opencode shows
  // it as the terminal's title). Quoted as it came, never typed anywhere.
  const named = agent.title ? `\u{201C}${agent.title}\u{201D}` : null;
  const detail = detailFor(certainty, { label, named, ago, fallback });
  const said = looking ? LOOKING_REASON : noticeText(notice, failure, label);
  // A list to choose from, for an agent whose conversations NexTerm can list.
  const canChoose = agent.kind === 'opencode' && typeof onListSessions === 'function' && typeof onResumeWith === 'function';

  return (
    <div
      ref={bannerRef}
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
        {said ? (
          <div data-agent-resume-notice="" className={looking ? 'text-vsc-muted' : 'text-vsc-warn'}>
            {said}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onResume}
          disabled={Boolean(waitReason)}
          title={waitReason ?? undefined}
          // Same button the empty pane uses for New Terminal; `vsc-button`
          // is not a token this theme defines and would have styled nothing.
          // Disabled, the hover must not light it up as if it were clickable.
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-vsc-button-secondary hover:bg-vsc-item-hover text-vsc-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-vsc-button-secondary"
        >
          <Play size={12} />
          Resume
        </button>
        {canChoose ? (
          <button
            ref={chooseRef}
            type="button"
            onClick={(event) => openChoices(event.currentTarget)}
            disabled={Boolean(waitReason)}
            title={waitReason ?? `Pick one of this folder\u{2019}s ${label} conversations to resume instead`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-vsc-fg hover:bg-vsc-item-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <ListOrdered size={12} />
            Choose…
          </button>
        ) : null}
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
      <ContextMenu
        open={Boolean(choices)}
        x={choices?.x ?? 0}
        y={choices?.y ?? 0}
        items={choices?.items ?? []}
        onClose={() => setChoices(null)}
        // Several banners can each have a list: keys go to the one focused,
        // or to this offer's while focus is on it. One that opened by itself
        // leaves focus where it was — in the terminal, often, still being
        // typed into — and waits for a click, a press of its Choose button, or
        // an arrow key on this offer.
        focusedKeys
        keysWithin={bannerRef}
        takeFocus={!choices?.auto}
      />
    </div>
  );
}

export default AgentResumeBanner;
