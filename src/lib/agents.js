/**
 * The coding agents NexTerm knows how to start again.
 *
 * Both of these already keep their own conversations; none of that is
 * reimplemented here. All NexTerm remembers is *which* agent a terminal was
 * running and, where the CLI allows it, *which* conversation — so that after
 * a restart the terminal can offer to pick it up instead of coming back as an
 * empty shell.
 *
 * **The command is typed into a shell, not spawned instead of one.** That is
 * how the user starts an agent in the first place, it leaves a working shell
 * behind when the agent exits, and it means a tab NexTerm started and a tab
 * the user typed into are the same kind of thing.
 *
 * What is NOT restored: the terminal's scrollback. The conversation comes
 * back inside the CLI; the screen above it does not. Anything shown to the
 * user has to say so rather than imply a full restore.
 *
 * Verified against the real CLIs on 2026-09-24 (macOS):
 *
 * - `claude --session-id <uuid>` starts a conversation under an id we choose,
 *   and writes it to `~/.claude/projects/<path-encoded cwd>/<uuid>.jsonl`.
 * - `claude --resume <uuid>` continues it — asked what it had just said, it
 *   said it again.
 * - `claude --session-id <uuid>` a SECOND time fails with
 *   `Error: Session ID … is already in use.` **So the flag that starts a
 *   session and the flag that resumes one are never the same flag.** A
 *   resume that reused `--session-id` would kill the terminal on every
 *   relaunch, which is the whole reason this was checked rather than assumed.
 * - opencode has `-c/--continue` and `-s/--session <id>` but no way to choose
 *   an id up front, so its conversation is identified by "the most recent one
 *   in this directory" and nothing finer.
 *
 * Both CLIs key their sessions to the working directory, which is why a
 * restored terminal must come back in its own cwd first — see
 * `resolveStartDir` and the fixes in v0.5.3 and v0.5.5.
 */

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    /** We choose the id, so resuming is exact. */
    tracksSessionId: true,
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    command: 'opencode',
    /** No flag to choose an id, so resuming means "the most recent here". */
    tracksSessionId: false,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

/** Whether `kind` is an agent this build knows. */
export function isKnownAgent(kind) {
  return Object.prototype.hasOwnProperty.call(AGENTS, kind);
}

/**
 * A v4 UUID, which is the only shape `claude --session-id` accepts.
 *
 * `crypto.randomUUID` is present in every runtime this ships to; the manual
 * path is for a non-secure context, where it is absent.
 */
export function newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Exactly what `newSessionId` makes: a lowercase v4 UUID.
 *
 * This is the line between a saved workspace and a command line. The id is
 * typed into a shell by `resumeCommand`, and it comes from a JSON file that
 * anything can have written — a hand edit, another build, a sync tool.
 * `serializeAgent` used to keep any string, so `x; curl … | sh` came back as
 * `claude --resume x; curl … | sh`. Nothing but hex digits and dashes passes
 * this, and nothing that could read as a flag.
 *
 * Uppercase is refused, though most parsers read it as the same UUID. This
 * build never writes one, so it did not come from here, and the conversation
 * is a file named after the id: whether the other case finds it depends on
 * the CLI and the filesystem, which is not something an `exact` resume can
 * promise. Refusing costs little — with no id the resume is `--continue`,
 * and the banner says that is the most recent conversation, not this one.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/**
 * The command that STARTS a conversation, and the agent record to remember.
 *
 * @returns {{ command: string, agent: { kind: string, sessionId: string|null, startedAt: number } }}
 */
export function startCommand(kind) {
  const agent = AGENTS[kind];
  if (!agent) throw new Error(`Unknown agent: ${kind}`);
  const sessionId = agent.tracksSessionId ? newSessionId() : null;
  return {
    command: sessionId ? `${agent.command} --session-id ${sessionId}` : agent.command,
    agent: { kind, sessionId, startedAt: Date.now() },
  };
}

/**
 * The command that CONTINUES the conversation an `agent` record describes, or
 * null when there is nothing to continue.
 *
 * Never `--session-id`: that flag creates, and creating an id that exists is
 * an error the CLI refuses.
 *
 * The id is checked here as well as in `serializeAgent`. This is exported,
 * and a record handed to it without passing through there must not reach a
 * shell either.
 */
export function resumeCommand(agent) {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  const { command, tracksSessionId } = AGENTS[agent.kind];
  if (tracksSessionId) {
    return isSessionId(agent.sessionId) ? `${command} --resume ${agent.sessionId}` : `${command} --continue`;
  }
  return `${command} --continue`;
}

/**
 * How certain the resume is, which decides what the banner may promise.
 *
 * `exact` — we chose the id, so it is that conversation and no other.
 * `latest` — the CLI can only offer the most recent one in this directory.
 *   With two such terminals open on the same folder they would both land on
 *   the same conversation, so the wording must not claim otherwise.
 */
export function resumeCertainty(agent) {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  // The same test `resumeCommand` applies: an id it will not type is not a
  // conversation this can promise to find.
  return AGENTS[agent.kind].tracksSessionId && isSessionId(agent.sessionId) ? 'exact' : 'latest';
}

/** What to call the agent in the interface. */
export function agentLabel(kind) {
  return AGENTS[kind]?.label ?? kind ?? '';
}

/**
 * The `agent` field as it should be persisted, or null.
 *
 * Deliberately narrow: an old workspace has no `agent` at all and a future
 * one may have more, so anything unrecognised is dropped rather than carried
 * into a spawn. That includes a session id this build could not have made —
 * see `isSessionId` — which becomes null and resumes with `--continue`.
 */
export function serializeAgent(agent) {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  return {
    kind: agent.kind,
    sessionId: isSessionId(agent.sessionId) ? agent.sessionId : null,
    startedAt: Number.isFinite(agent.startedAt) ? agent.startedAt : null,
  };
}
