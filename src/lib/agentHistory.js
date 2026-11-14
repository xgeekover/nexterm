/**
 * The agent session history, as the page sees it: pure functions only.
 *
 * The history is one file in the app's local data folder,
 * `agent-sessions.json`, kept by the backend (src-tauri/src/agent_history.rs:
 * its format, its cap, how a deleted or unreadable file is handled). The page
 * only sends it what happened — an agent started or resumed in a terminal,
 * the id of an opencode conversation learned, a title, an agent exited or its
 * terminal closed — through `agent_history_upsert`, and reads it back with
 * `agent_history_list`. The recorder that watches the terminals and sends
 * those is src/stores/agentHistoryStore.js; the resume from an entry is
 * `resumeFromHistory` in src/stores/terminalStore.js.
 *
 * What is here: the entry a terminal's agent record makes
 * (`entryOfAgent`), the key the backend gives it (`historyKey`), the events
 * between two looks at the terminals (`observeAgents`), the recorder's queue
 * of writes not sent yet (`queueUpsert`), the record an entry
 * resumes as (`historyRecord`), and what the side bar and the palette show
 * of one (`historyDisplay`, `historyMatches`).
 *
 * **Privacy.** A title is what opencode called the conversation, shown in the
 * terminal's title — or for Claude Code the title Claude Code generated for
 * it, else its last prompt, read from Claude Code's own transcript by the
 * backend (src-tauri/src/claude_conversations.rs; `claudeHistoryChanges`).
 * Either is kept only cleaned (`cleanAgentTitle`: one line, no control or
 * bidi characters, at most 200 characters) and with any secret the
 * scrollback's detection finds hidden (`maskSecretsInText`). A Claude Code
 * terminal's own record never has a title, so what the recorder writes for
 * one has none, and the backend's merge keeps the title the history has.
 *
 * **A Claude Code conversation never saved** — its terminal quit before a
 * first message was sent — cannot be resumed: `claudeHistoryChanges` drops
 * its entry, unless a terminal of this window holds it.
 *
 * **The file is untrusted input.** An entry is resumed only through
 * `historyRecord`, which refuses one whose id is not its agent's shape
 * (`isSessionIdFor`) — the id is typed into a shell — rather than resume it
 * as "the most recent".
 */
import { agentLabel, cleanAgentTitle, isKnownAgent, isSessionIdFor, resumeCertainty, serializeAgent } from './agents.js';
import { HIDDEN, maskSecretsInText } from './scrollbackSnapshot.js';
import { startableCwd } from './terminalCwd.js';

/** The backend's caps (agent_history.rs `MAX_TITLE_CHARS`, `MAX_CWD_BYTES`). */
export const HISTORY_TITLE_MAX = 200;
export const HISTORY_CWD_MAX_BYTES = 4096;

/** What the backend refuses in a folder or a title: C0, DEL, C1, U+2028/9, the bidi controls. */
const REFUSED_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** An absolute folder as the backend reads one: `/…`, `\\…`, or a drive letter and a separator. */
const ABSOLUTE = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;
/** Half of a character: a surrogate with no partner, which the backend cannot read. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const utf8Bytes = (text) => new TextEncoder().encode(text).length;

/**
 * A title as the history keeps it, or null: cleaned (`cleanAgentTitle`),
 * its secrets hidden, cleaned again (a `[hidden]` can make it longer), and
 * no half of a character left at a cut. `cut`: `title` was already cut short
 * at its end before it got here, so a token it ends in is hidden from its
 * prefix on, as at the history's own cap.
 */
export function historyTitle(title, { cut = false } = {}) {
  const clean = cleanAgentTitle(title);
  if (!clean) return null;
  let masked = maskSecretsInText(clean, { cut: cut || clean.length >= HISTORY_TITLE_MAX });
  if (masked.length > HISTORY_TITLE_MAX) {
    // Longer now, and cut again: never through a HIDDEN.
    const at = masked.lastIndexOf(HIDDEN, HISTORY_TITLE_MAX - 1);
    masked =
      at !== -1 && at + HIDDEN.length > HISTORY_TITLE_MAX
        ? `${masked.slice(0, HISTORY_TITLE_MAX - HIDDEN.length)}${HIDDEN}`
        : masked.slice(0, HISTORY_TITLE_MAX);
  }
  return cleanAgentTitle(masked.replace(LONE_SURROGATE, ''));
}

/**
 * The most characters of a Claude Code title the backend hands over
 * (claude_conversations.rs `MAX_TITLE_CHARS`): one this long may have been
 * cut there.
 */
export const CLAUDE_TITLE_READ_CHARS = 1000;

/**
 * A title Claude Code gave a conversation (`claude_conversations`), as the
 * history keeps it: `historyTitle`'s, told when the backend may have cut it.
 */
export function claudeHistoryTitle(title) {
  if (typeof title !== 'string') return null;
  return historyTitle(title, { cut: Array.from(title).length >= CLAUDE_TITLE_READ_CHARS });
}

/** Whether `cwd` is a folder the backend keeps: absolute, one line, at most 4096 bytes. */
export function isHistoryCwd(cwd) {
  return (
    typeof cwd === 'string' &&
    ABSOLUTE.test(cwd) &&
    !REFUSED_CHAR.test(cwd) &&
    cwd.replace(LONE_SURROGATE, '') === cwd &&
    utf8Bytes(cwd) <= HISTORY_CWD_MAX_BYTES
  );
}

/**
 * The folder a terminal's agent runs in, as the history keeps it: the
 * terminal's, spelled so that a new shell can be started there
 * (`startableCwd`: Git Bash `/c/x` is `C:\x`) — or null when there is none
 * the history could keep, and the agent is not recorded.
 */
export function historyCwd(tab, os = null) {
  const cwd = startableCwd(tab, os);
  return isHistoryCwd(cwd) ? cwd : null;
}

/** The key the backend gives an entry (`key_of`): by id, else by folder and title. */
export function historyKey({ kind, sessionId = null, cwd, title = null }) {
  return sessionId !== null ? `${kind}:${sessionId}` : `${kind}:~${cwd}\u0000${title ?? ''}`;
}

/**
 * The entry `agent`, a terminal's record (`tab.agent`), makes in the folder
 * `cwd` — every field the backend checks, as it checks them — or null for an
 * agent this build does not know. Times are the caller's.
 */
export function entryOfAgent(agent, cwd, { startedAt, lastUsedAt, endedAt = null, endReason = null }) {
  if (!agent || !isKnownAgent(agent.kind) || !isHistoryCwd(cwd)) return null;
  return {
    kind: agent.kind,
    sessionId: isSessionIdFor(agent.kind, agent.sessionId) ? agent.sessionId : null,
    cwd,
    // A Claude Code terminal's record names no conversation; the history's
    // title for it comes from Claude Code's transcript (`claudeHistoryChanges`),
    // and a write with none keeps it. opencode's is masked.
    title: agent.kind === 'claude' ? null : historyTitle(agent.title),
    startedAt,
    lastUsedAt,
    endedAt,
    endReason,
  };
}

/**
 * The key of the conversation `tab` runs or offers back, or null — what the
 * side bar marks as open in this window, and what `resumeFromHistory` looks
 * for in the terminals before it opens a new one.
 */
export function historyKeyOfTab(tab, os = null) {
  const cwd = tab?.agent ? historyCwd(tab, os) : null;
  const entry = cwd ? entryOfAgent(tab.agent, cwd, { startedAt: 0, lastUsedAt: 0 }) : null;
  return entry ? historyKey(entry) : null;
}

/**
 * What changed in the terminals' agents since the last look, as the events
 * the history records, and what to remember for the next look.
 *
 * `tracked` is the previous answer's (`new Map()` the first time): by tab id,
 * `{ live, offered, agent, entry, key }` — `live` an agent running there,
 * `offered` one a restored terminal only offers back, `entry` the last one
 * sent for it (null for an agent whose folder the history cannot keep), and
 * `key` its key. `tabs` is the terminal store's.
 *
 * Events, each `{ type, tabId, entry, key, replaces }` with `entry` the whole
 * upsert (lastUsedAt `now`) and `replaces` the key it had before, if that
 * changed:
 *
 *   started    an agent started in the terminal: by NexTerm (`startAgent`),
 *              or typed by hand. startedAt and lastUsedAt now, no end.
 *   resumed    the record a terminal offered back taken up again
 *              (`resumeAgent`, which `resumeFromHistory` uses too) — the
 *              same record, by its start; an agent typed by hand over an
 *              offer is `started`. Times as for started, and from an
 *              entry with no id that is now known by its id, `replaces` that
 *              entry (`tab.agentHistoryKey`).
 *   idLearned  the opencode conversation's id found (`resolveAgentSession`).
 *   titled     a title shown (`noteAgentTitle`); on another conversation's
 *              title the id is let go of, and the entry is the provisional
 *              one until the id is found. Once an id is let go of — or one
 *              id follows another — it is another conversation: its entry
 *              starts now and `replaces` nothing, as the backend takes only
 *              an entry with no id in its place (agent_history.rs `upsert`).
 *   ended      `reason` 'exited' — the record cleared, the agent exited; or
 *              offered back again, a resume that typed nothing after all (a
 *              password prompt was up) — or 'closed': the terminal is gone.
 *
 * Not an event: a record only offered back (a restored terminal), a record
 * the user dismissed, an agent this build does not know, or one whose folder
 * the history cannot keep.
 */
export function observeAgents(tracked, tabs, { now = Date.now(), os = null } = {}) {
  const next = new Map();
  const events = [];
  const ended = (tabId, before, reason) =>
    events.push({
      type: 'ended',
      reason,
      tabId,
      entry: { ...before.entry, lastUsedAt: now, endedAt: now, endReason: reason },
      key: before.key,
      replaces: null,
    });
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || typeof tab.id !== 'string') continue;
    const before = tracked.get(tab.id) ?? null;
    const agent = tab.agent && isKnownAgent(tab.agent.kind) ? tab.agent : null;
    if (!agent || tab.agentResumeOffered) {
      // The record cleared — or, still there, offered again: a resume that
      // typed nothing after all, a password prompt being up (terminalStore
      // `giveOfferBack`). Not running, so not left reading as running.
      if (before?.live && before.entry) ended(tab.id, before, 'exited');
      next.set(tab.id, { live: false, offered: Boolean(agent && tab.agentResumeOffered), agent, entry: null, key: null });
      continue;
    }
    if (before?.live && before.agent === agent) {
      next.set(tab.id, before);
      continue;
    }
    const sameRecord = before?.live && before.agent?.kind === agent.kind && before.agent?.startedAt === agent.startedAt;
    if (!sameRecord) {
      const cwd = historyCwd(tab, os);
      const entry = cwd ? entryOfAgent(agent, cwd, { startedAt: now, lastUsedAt: now }) : null;
      const key = entry ? historyKey(entry) : null;
      if (entry) {
        // The offer taken (`takeOffer` keeps the record's start), not an
        // agent typed by hand over it, nor a fresh one picked instead.
        const taken = before?.offered && before.agent?.kind === agent.kind && before.agent?.startedAt === agent.startedAt;
        const type = taken ? 'resumed' : 'started';
        const from = type === 'resumed' && typeof tab.agentHistoryKey === 'string' ? tab.agentHistoryKey : null;
        events.push({ type, tabId: tab.id, entry, key, replaces: from !== null && from !== key ? from : null });
      }
      next.set(tab.id, { live: true, offered: false, agent, entry, key });
      continue;
    }
    if (!before.entry) {
      next.set(tab.id, { ...before, agent });
      continue;
    }
    const sessionId = isSessionIdFor(agent.kind, agent.sessionId) ? agent.sessionId : null;
    const title = agent.kind === 'claude' ? null : historyTitle(agent.title);
    if (sessionId === before.entry.sessionId && title === before.entry.title) {
      next.set(tab.id, { ...before, agent });
      continue;
    }
    // The id written is let go of, or another takes its place: not the same
    // conversation any more. A rename lets go of the id too, and finds the
    // same one again; the backend's merge then keeps the earliest start.
    const switched = before.entry.sessionId !== null && sessionId !== before.entry.sessionId;
    const entry = {
      ...before.entry,
      sessionId,
      title,
      startedAt: switched ? now : before.entry.startedAt,
      lastUsedAt: now,
      endedAt: null,
      endReason: null,
    };
    const key = historyKey(entry);
    const type = sessionId !== null && sessionId !== before.entry.sessionId ? 'idLearned' : 'titled';
    events.push({ type, tabId: tab.id, entry, key, replaces: !switched && key !== before.key ? before.key : null });
    next.set(tab.id, { live: true, offered: false, agent, entry, key });
  }
  for (const [tabId, before] of tracked) {
    if (!next.has(tabId) && before.live && before.entry) ended(tabId, before, 'closed');
  }
  return { tracked: next, events };
}

/** `newer` with what `older`, an earlier write of the same entry, adds: the backend's merge for two events. */
function foldedEntry(older, newer) {
  return {
    ...newer,
    startedAt: Math.min(older.startedAt, newer.startedAt),
    title: newer.sessionId !== null ? (newer.title ?? older.title) : newer.title,
  };
}

/**
 * The upserts not sent yet, `queue` (oldest first, each `{ entry, key,
 * replaces, tabId }`), with `op` added — a new array. One merged with
 * another that is waiting, as the backend would merge the two writes:
 *
 * - one queued for the key `op` replaces is taken into it — only when the
 *   backend would take that entry (agent_history.rs `upsert`): one with no
 *   id, of the same kind. Any other is a conversation of its own, and is
 *   sent as it is;
 * - one queued for the same key takes `op` in — unless a later one
 *   replaces that key, or the two replace different keys, when `op` waits
 *   its turn.
 */
export function queueUpsert(queue, op) {
  const pending = [...queue];
  let next = { ...op };
  const replaced = next.replaces
    ? pending.findIndex(
        (q) => q.key === next.replaces && q.entry?.sessionId === null && q.entry?.kind === next.entry?.kind
      )
    : -1;
  if (replaced !== -1) {
    const [older] = pending.splice(replaced, 1);
    next = { ...next, entry: foldedEntry(older.entry, next.entry), replaces: older.replaces };
  }
  const same = pending.findIndex((q) => q.key === next.key);
  const free =
    same !== -1 &&
    !pending.slice(same + 1).some((q) => q.replaces === next.key) &&
    (!next.replaces || !pending[same].replaces || next.replaces === pending[same].replaces);
  if (free) {
    const older = pending[same];
    pending[same] = { ...next, entry: foldedEntry(older.entry, next.entry), replaces: older.replaces ?? next.replaces };
  } else {
    pending.push(next);
  }
  return pending;
}

/**
 * Which terminal holds each entry, by key: `{ tabId, state }` with `state`
 * 'open' — the agent runs there — or 'offered', a restored terminal offering
 * it back. From `tracked` (`observeAgents`) for the running ones, so the key
 * is the one written, and from the records for the offered ones.
 */
export function historyHolders(tracked, tabs, os = null) {
  const holders = {};
  for (const [tabId, t] of tracked) {
    if (t.live && t.key && !holders[t.key]) holders[t.key] = { tabId, state: 'open' };
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab?.agentResumeOffered) continue;
    const key = historyKeyOfTab(tab, os);
    if (key && !holders[key]) holders[key] = { tabId: tab.id, state: 'offered' };
  }
  return holders;
}

/**
 * The Claude Code conversation ids the terminals in `tabs` hold: running
 * there, or offered back by a restored terminal.
 */
export function claudeIdsHeld(tabs) {
  const held = new Set();
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (tab?.agent?.kind === 'claude' && isSessionIdFor('claude', tab.agent.sessionId)) held.add(tab.agent.sessionId);
  }
  return held;
}

/**
 * What the history does with what Claude Code says of its conversations
 * (`claude_conversations`): `answers`, a Map from session id to `{ saved,
 * title }`, for the Claude Code `entries` of the history (each as
 * `agent_history_list` answers it). `held` is `claudeIdsHeld`'s.
 *
 * - `removed`, the keys of the entries whose conversation was never saved
 *   (`saved` false) and that no terminal of this window holds: one cannot be
 *   resumed, and only clutters the list. One that is held stays — its
 *   terminal may yet send the first message.
 * - `titled`, an upsert for each entry whose title is to change: Claude
 *   Code's title as the history keeps it (`claudeHistoryTitle`), with the
 *   entry's own times, so the change moves nothing in the list. A lookup that
 *   finds no title changes nothing: a title once kept stays, whatever became
 *   of the transcript.
 *
 * An entry with no id (`claude --continue`), of another agent, or with no
 * answer is left as it is.
 */
export function claudeHistoryChanges(entries, answers, held = new Set()) {
  const removed = [];
  const titled = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'claude' || !isSessionIdFor('claude', entry.sessionId)) continue;
    const answer = answers instanceof Map ? answers.get(entry.sessionId) : undefined;
    if (!answer) continue;
    if (answer.saved === false) {
      if (!held.has(entry.sessionId)) removed.push(entry.key);
      continue;
    }
    const title = claudeHistoryTitle(answer.title);
    if (!title || title === entry.title) continue;
    titled.push({
      key: entry.key,
      entry: {
        kind: entry.kind,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title,
        startedAt: entry.startedAt,
        lastUsedAt: entry.lastUsedAt,
        endedAt: entry.endedAt ?? null,
        endReason: entry.endReason ?? null,
      },
    });
  }
  return { removed, titled };
}

/**
 * The record an entry from the file resumes as — `serializeAgent`'s, so the
 * same as a restored terminal's — or null when it may not be resumed: an
 * agent this build does not know, a folder that is not one, or an id that is
 * not its agent's shape. Refused rather than resumed as "the most recent":
 * that would be another conversation than the one picked.
 */
export function historyRecord(entry) {
  if (!entry || typeof entry !== 'object' || !isKnownAgent(entry.kind) || !isHistoryCwd(entry.cwd)) return null;
  const sessionId = entry.sessionId ?? null;
  if (sessionId !== null && !isSessionIdFor(entry.kind, sessionId)) return null;
  return serializeAgent({
    kind: entry.kind,
    sessionId,
    startedAt: entry.startedAt,
    // Claude Code's title names the entry in the list, not the terminal's
    // record: the record stays what a Claude Code terminal's always is.
    title: entry.kind === 'claude' ? null : entry.title,
  });
}

/** The last name in a folder's path: `app` of `/work/app` or `C:\work\app`; a root as it is. */
export function folderName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return cwd;
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** The start of an id, enough to tell two apart: a UUID's first group, `ses_` and eight more. */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return sessionId.startsWith('ses_') ? sessionId.slice(0, 12) : sessionId.slice(0, 8);
}

/**
 * What a row of the AGENT SESSIONS list shows for `entry`, as text:
 * `label` the agent, `title` its title or a short id — or, with neither,
 * that it is the folder's most recent — `folder` the folder's name and
 * `folderPath` the folder (for a tooltip), `certainty` `resumeCertainty`'s,
 * `lastUsedAt` and `endReason` as stored. Titles are text only.
 */
export function historyDisplay(entry) {
  const agent = { kind: entry?.kind, sessionId: entry?.sessionId ?? null };
  const shortId = shortSessionId(entry?.sessionId);
  return {
    key: entry?.key ?? null,
    label: agentLabel(entry?.kind),
    title: entry?.title || shortId || 'most recent in folder',
    titled: Boolean(entry?.title),
    shortId,
    folder: folderName(entry?.cwd),
    folderPath: entry?.cwd ?? '',
    certainty: resumeCertainty(agent),
    lastUsedAt: entry?.lastUsedAt ?? null,
    endReason: entry?.endReason ?? null,
  };
}

/**
 * Whether `entry` fits what was typed in the palette: every word of `query`
 * found, case aside, in the agent's label, the title, the folder, or at the
 * start of the id.
 */
export function historyMatches(entry, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [agentLabel(entry?.kind), entry?.kind, entry?.title, entry?.cwd].filter(Boolean).join('\n').toLowerCase();
  const id = String(entry?.sessionId ?? '').toLowerCase();
  return words.every((w) => text.includes(w) || (id !== '' && id.startsWith(w)));
}
