/**
 * Whether Claude Code in a terminal is working or idle, from the terminal
 * title it sets (`claudeActivityOf`, agents.js), and when one of its turns
 * has ended in a way worth telling you about.
 *
 * Claude Code puts a spinner glyph (◐ ◑ ◒ ◓) in front of its title while it
 * works and ✳ while it waits for you. A turn starts at the first working
 * title and ends when an idle title has stood for AGENT_IDLE_SETTLE_MS with
 * no working title after it: a stray ✳ between two frames is not the end of
 * anything. Its idle period ("P") runs from the turn's last working title
 * until the next one (or the agent's or the terminal's end); a note or a bell
 * Claude Code sends itself inside P is the same moment as the completion,
 * and only one of them is listed (`agentDoneDecision`).
 *
 * A record, per terminal:
 *
 *   shown    'working', 'idle', or null for unknown — what the side bar shows
 *   since    when `shown` became what it is (wall clock, `Date.now()`)
 *   turn     the open turn, or null: `startedAt` and `lastWorkingAt` on the
 *            monotonic clock (durations), `lastWorkingWall` on the wall clock
 *            (the start of P, which `keptAt` is compared with), and the
 *            `signals` Claude Code sent since its last working title
 *   pending  the idle title waiting out the settle time, or null: `at`
 *            (monotonic) and `wall`
 *
 * Pure: no stores, no timers. Every time is handed in, so the suites drive
 * the clocks themselves.
 */
import { durationLabel } from './tabActivity.js';
import { historyTitle } from './agentHistory.js';
import { BODY_MAX, sanitizeText } from './programNotifications.js';

/** How long an idle title has to stand before a working Claude Code is taken to be idle. */
export const AGENT_IDLE_SETTLE_MS = 1500;

/** What nothing is known about: no state, no turn, nothing pending. */
export const NO_AGENT_ACTIVITY = Object.freeze({ shown: null, since: null, turn: null, pending: null });

const freeze = (record) =>
  record.shown === null && record.turn === null && record.pending === null ? NO_AGENT_ACTIVITY : Object.freeze(record);

/**
 * The record after a title of `kind` ('working', 'idle' or null, as
 * `claudeActivityOf` reads it) arrived at `now` (monotonic) and `wall`.
 * Returns `{ record, changed, settle, periodEnds }`:
 *
 *   record      the new record — `prev` itself when nothing changed at all
 *   changed     whether `shown` changed, the one thing worth a store write
 *   settle      'start' to start waiting out the idle title, 'cancel' to stop
 *               waiting, or null for neither
 *   periodEnds  a working title: whatever idle period was open is over
 *
 * A working title shows Working at once and opens a turn when none is open;
 * every one moves the turn's last working time and forgets the signals sent
 * before it. An idle title while working starts the wait; while unknown it
 * shows Idle at once, with no turn; while idle it does nothing. Any other
 * title forgets all of it, the turn and the wait included.
 */
export function nextAgentActivity(prev, kind, now, wall) {
  const was = prev ?? NO_AGENT_ACTIVITY;
  if (kind === 'working') {
    const turn = was.turn
      ? { ...was.turn, lastWorkingAt: now, lastWorkingWall: wall, signals: [] }
      : { startedAt: now, lastWorkingAt: now, lastWorkingWall: wall, signals: [] };
    const changed = was.shown !== 'working';
    return {
      record: freeze({ shown: 'working', since: changed ? wall : was.since, turn: Object.freeze(turn), pending: null }),
      changed,
      settle: was.pending ? 'cancel' : null,
      periodEnds: true,
    };
  }
  if (kind === 'idle') {
    if (was.shown === 'working') {
      // The first idle title is the one the turn ends at; another while
      // waiting changes nothing.
      if (was.pending) return { record: was, changed: false, settle: null, periodEnds: false };
      return {
        record: freeze({ ...was, pending: Object.freeze({ at: now, wall }) }),
        changed: false,
        settle: 'start',
        periodEnds: false,
      };
    }
    if (was.shown === 'idle') return { record: was, changed: false, settle: null, periodEnds: false };
    return { record: freeze({ shown: 'idle', since: wall, turn: null, pending: null }), changed: true, settle: null, periodEnds: false };
  }
  if (was === NO_AGENT_ACTIVITY) return { record: was, changed: false, settle: null, periodEnds: false };
  return { record: NO_AGENT_ACTIVITY, changed: was.shown !== null, settle: was.pending ? 'cancel' : null, periodEnds: false };
}

/**
 * The record once the idle title it waits on has stood for the settle time:
 * Idle since that title arrived, the turn closed. Returns `{ record, changed,
 * done }`, `done` being `{ durationMs, from, signals }` for the turn that
 * ended — how long it worked (idle title minus turn start, monotonic), when
 * its idle period began (wall clock) and what Claude Code sent in it — or
 * null when nothing was waiting.
 */
export function settleAgentActivity(prev) {
  const was = prev ?? NO_AGENT_ACTIVITY;
  if (!was.pending || was.shown !== 'working') return { record: was, changed: false, done: null };
  const turn = was.turn;
  const record = freeze({ shown: 'idle', since: was.pending.wall, turn: null, pending: null });
  if (!turn) return { record, changed: true, done: null };
  return {
    record,
    changed: true,
    done: Object.freeze({
      durationMs: Math.max(0, was.pending.at - turn.startedAt),
      from: turn.lastWorkingWall,
      signals: turn.signals,
    }),
  };
}

/**
 * The record with `signal` — 'note' or 'bell', something Claude Code sent
 * itself — counted in its open turn's idle period. `prev` itself when no
 * turn is open: outside a turn, nothing is folded.
 */
export function withAgentSignal(prev, signal) {
  const was = prev ?? NO_AGENT_ACTIVITY;
  if (!was.turn || (signal !== 'note' && signal !== 'bell')) return was;
  return freeze({ ...was, turn: Object.freeze({ ...was.turn, signals: [...was.turn.signals, signal] }) });
}

/** Whether wall time `at` (a kept note's `keptAt`) lies in the idle period of `prev`'s open turn. */
export function inAgentPeriod(prev, at) {
  const from = prev?.turn?.lastWorkingWall;
  return typeof from === 'number' && typeof at === 'number' && Number.isFinite(at) && at >= from;
}

/**
 * What a turn that ended (`settleAgentActivity`'s `done`) shows, as
 * `{ list, desktop, flash }`:
 *
 *   - nothing for a turn shorter than `thresholdMs`, or with it 0 or less;
 *   - nothing when Claude Code sent a note of its own in the idle period:
 *     that note was the news;
 *   - when it only rang the bell, which listed an entry already: no entry,
 *     but the desktop notification a bell never shows, if `route` has one;
 *   - otherwise what `route` (`routeProgramNotification`'s, kitty's 'always'
 *     occasion) says: an entry, a desktop notification, and a flash of the
 *     terminal being typed into instead of an entry when `flashFocused`.
 */
export function agentDoneDecision({ durationMs, thresholdMs, signals = [], route, flashFocused = false }) {
  const none = { list: false, desktop: false, flash: false };
  if (!(typeof thresholdMs === 'number' && thresholdMs > 0) || !(typeof durationMs === 'number' && durationMs >= thresholdMs)) return none;
  const said = Array.isArray(signals) ? signals : [];
  if (said.includes('note')) return none;
  const inApp = Boolean(route?.inApp);
  const desktop = Boolean(route?.desktop);
  if (said.length > 0) return { list: false, desktop, flash: false };
  return { list: inApp, desktop, flash: !inApp && flashFocused === true };
}

/**
 * The text of a finished turn's entry: "Waiting for you after 12s of work",
 * then " — <title>" when Claude Code's last title named the conversation —
 * cleaned and its secrets masked as the history keeps it (`historyTitle`) —
 * all of it cut to a note's length.
 */
export function agentDoneBody(durationMs, conversationTitle) {
  const head = `Waiting for you after ${durationLabel(durationMs)} of work`;
  const title = typeof conversationTitle === 'string' ? historyTitle(conversationTitle) : null;
  return sanitizeText(title ? `${head} \u{2014} ${title}` : head, BODY_MAX);
}
