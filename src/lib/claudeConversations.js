/**
 * What Claude Code itself keeps about the conversations NexTerm started:
 * whether one was ever saved, and the title Claude Code gave it — read by the
 * backend from Claude Code's own transcripts, read-only
 * (`claude_conversations`, src-tauri/src/claude_conversations.rs).
 *
 * Two uses:
 *
 * - the agent session history names a Claude Code entry by that title
 *   (src/stores/agentHistoryStore.js), and drops an entry whose conversation
 *   was never saved, since it cannot be resumed;
 * - a Resume never types `claude --resume <id>` for a conversation that was
 *   never saved — Claude Code writes one only once a first message is sent,
 *   and the resume then fails with "No conversation found" — but starts a new
 *   one instead (`resumeAgent` in src/stores/terminalStore.js).
 *
 * The answer is never waited for long: CLAUDE_LOOKUP_TIMEOUT_MS, and then it
 * is "cannot tell" — `saved` null — which resumes as NexTerm always did.
 */
import { claudeConversations } from './ipc.js';
import { isSessionIdFor } from './agents.js';

/** The most ids one lookup takes: the backend's `MAX_IDS`, the history's cap. */
export const CLAUDE_LOOKUP_MAX_IDS = 200;

/** How long a lookup is waited for before it counts as "cannot tell". */
export const CLAUDE_LOOKUP_TIMEOUT_MS = 2000;
let lookupTimeoutMs = CLAUDE_LOOKUP_TIMEOUT_MS;

/** Test hook: how long a lookup is waited for. Returns what it replaced. */
export function __setClaudeLookupTimeoutMs(ms) {
  const previous = lookupTimeoutMs;
  lookupTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : CLAUDE_LOOKUP_TIMEOUT_MS;
  return previous;
}

/**
 * The conversations of `ids` — Claude Code session ids; any other is left
 * out, and at most CLAUDE_LOOKUP_MAX_IDS are asked about — as a Map from each
 * id to `{ saved: true|false|null, title: string|null }`. Null when the
 * backend could not be asked, failed, or did not answer within
 * CLAUDE_LOOKUP_TIMEOUT_MS. Never rejects.
 */
export async function lookUpClaudeConversations(ids) {
  const asked = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => isSessionIdFor('claude', id)))].slice(
    0,
    CLAUDE_LOOKUP_MAX_IDS
  );
  if (asked.length === 0) return new Map();
  let timer = null;
  try {
    const answer = await Promise.race([
      claudeConversations(asked),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), lookupTimeoutMs);
      }),
    ]);
    if (!Array.isArray(answer)) return null;
    const found = new Map();
    for (const one of answer) {
      if (!one || !asked.includes(one.sessionId)) continue;
      found.set(one.sessionId, {
        saved: typeof one.saved === 'boolean' ? one.saved : null,
        title: typeof one.title === 'string' ? one.title : null,
      });
    }
    return found;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether Claude Code saved a conversation under `sessionId`: true, false —
 * it never did, and `claude --resume` of it can only fail — or null when that
 * cannot be told. `false` needs positive evidence (the backend): no transcript
 * in a readable `projects` folder AND Claude Code's own `session-env/<id>`
 * marker of the session having started. Anything else is null: an id that is
 * not one, no marker (perhaps another config folder than the shell's), a
 * lookup that failed or took longer than CLAUDE_LOOKUP_TIMEOUT_MS.
 */
export async function claudeConversationSaved(sessionId) {
  const found = await lookUpClaudeConversations([sessionId]);
  return found?.get(sessionId)?.saved ?? null;
}
