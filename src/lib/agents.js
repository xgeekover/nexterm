/**
 * The coding agents NexTerm knows how to start again.
 *
 * Both of these already keep their own conversations; none of that is
 * reimplemented here. All NexTerm remembers is *which* agent a terminal was
 * running and, where it can find out, *which* conversation — so that after
 * a restart the terminal can offer to pick it up instead of coming back as an
 * empty shell.
 *
 * **The command is typed into a shell, not spawned instead of one.** That is
 * how the user starts an agent in the first place, it leaves a working shell
 * behind when the agent exits, and it means a tab NexTerm started and a tab
 * the user typed into are the same kind of thing. An agent the user typed by
 * hand is recognised from the line they submitted (`agentFromCommandLine`)
 * and remembered like one NexTerm started.
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
 *   an id up front.
 *
 * And on 2026-10-05, opencode 1.18.34 against a local mock model: it says
 * which conversation it is showing — as the terminal's title, `OC | <the
 * conversation's title>` (cut to 37 characters and `…` past 40), `OpenCode`
 * on its home screen and before a conversation has a title, and '' as it
 * quits. `opencode session list --format json` lists every conversation with
 * its id, title, directory and times, so a title seen in a terminal maps back
 * to an id (`pickOpencodeSession`). An opencode terminal therefore learns its
 * conversation's id after the fact and resumes it exactly from then on; until
 * it has, "the most recent one in this directory" is all `--continue` offers.
 * `-s <id>` with an older conversation shows its title at once and does not
 * touch its `updated` time.
 *
 * Both CLIs key their sessions to the working directory, which is why a
 * restored terminal must come back in its own cwd first — see
 * `resolveStartDir` and the fixes in v0.5.3 and v0.5.5.
 */

/**
 * A v4 UUID, which is the only shape `claude --session-id` accepts — and
 * exactly what `newSessionId` makes: a lowercase one.
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
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * An opencode conversation id as `opencode session list` prints them:
 * `ses_` and 26 letters and digits (`ses_ef45006f5ffeAMtumN5ySj4VmT`). Typed
 * into a shell like a claude id, so held to the same standard — letters,
 * digits and the one underscore, nothing a shell or the CLI could read as
 * anything else. The length is left a little open; the alphabet is not.
 */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]{8,64}$/;

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    /** NexTerm chooses the id when it starts one, so resuming is exact from the start. */
    choosesSessionId: true,
    sessionIdPattern: CLAUDE_SESSION_ID,
    resumeFlag: '--resume',
    /** What a layout template saved while it runs starts: a new conversation. */
    templateCommand: 'claude',
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    command: 'opencode',
    /** No flag to choose an id; it is learned later, from the terminal's title. */
    choosesSessionId: false,
    sessionIdPattern: OPENCODE_SESSION_ID,
    resumeFlag: '-s',
    /**
     * A template saved while opencode runs continues the folder's latest
     * conversation when it is opened, rather than starting an empty one —
     * the user's choice (2026-10-05). Not `-s <id>`: a template is opened
     * again and again, and should not stay pinned to one conversation.
     */
    templateCommand: 'opencode -c',
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

/** Whether `value` is a conversation id `kind`'s CLI could be handed on a command line. */
export function isSessionIdFor(kind, value) {
  return isKnownAgent(kind) && typeof value === 'string' && AGENTS[kind].sessionIdPattern.test(value);
}

/** The longest conversation title kept; opencode's own are a line long. */
const TITLE_MAX = 200;

/**
 * A conversation's title as it may be kept and shown: one line of plain text,
 * or null. It comes from a program's output and from a JSON file, so control
 * characters (C0, DEL, C1) and bidi overrides are dropped, runs of spaces
 * collapse, and it is cut to TITLE_MAX characters. Shown as text only —
 * never typed anywhere.
 */
export function cleanAgentTitle(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) : text;
}

/**
 * The command that STARTS a conversation, and the agent record to remember.
 *
 * @returns {{ command: string, agent: { kind: string, sessionId: string|null, startedAt: number, title: null } }}
 */
export function startCommand(kind) {
  const agent = AGENTS[kind];
  if (!agent) throw new Error(`Unknown agent: ${kind}`);
  const sessionId = agent.choosesSessionId ? newSessionId() : null;
  return {
    command: sessionId ? `${agent.command} --session-id ${sessionId}` : agent.command,
    agent: { kind, sessionId, startedAt: Date.now(), title: null },
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
  const { command, resumeFlag } = AGENTS[agent.kind];
  return isSessionIdFor(agent.kind, agent.sessionId)
    ? `${command} ${resumeFlag} ${agent.sessionId}`
    : `${command} --continue`;
}

/**
 * How certain the resume is, which decides what the banner may promise.
 *
 * `exact` — the record holds the conversation's own id: claude's because
 *   NexTerm chose it, opencode's once its title has been matched to one
 *   (or the user typed `-s <id>`). That conversation and no other.
 * `latest` — no id, so the CLI can only offer the most recent one in this
 *   directory. With two such terminals open on the same folder they would
 *   both land on the same conversation, so the wording must not claim
 *   otherwise.
 */
export function resumeCertainty(agent) {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  // The same test `resumeCommand` applies: an id it will not type is not a
  // conversation this can promise to find.
  return isSessionIdFor(agent.kind, agent.sessionId) ? 'exact' : 'latest';
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
 * into a spawn. That includes a session id this build could not have made or
 * read — see `isSessionIdFor` — which becomes null and resumes with
 * `--continue`.
 */
export function serializeAgent(agent) {
  if (!agent || !isKnownAgent(agent.kind)) return null;
  return {
    kind: agent.kind,
    sessionId: isSessionIdFor(agent.kind, agent.sessionId) ? agent.sessionId : null,
    startedAt: Number.isFinite(agent.startedAt) ? agent.startedAt : null,
    title: cleanAgentTitle(agent.title),
  };
}

// ---- An agent typed by hand ---------------------------------------------------

/**
 * Words of a command line, with simple quoting — `'…'` and `"…"` group, and a
 * backslash escapes inside double quotes — or null when the line does more
 * than run one command: a separator (`;` `&` `|`), a redirection, a subshell
 * or a substitution outside quotes. `cd x && opencode` runs opencode in a
 * directory the terminal does not know yet (its cwd is reported at the next
 * prompt), and `$(…)` could stand for any program at all.
 */
function wordsOf(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && i + 1 < line.length) word += line[(i += 1)];
      else if (quote === '"' && (ch === '$' || ch === '`')) return null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (word === null) word = '';
      continue;
    }
    if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    if (';&|<>()`$'.includes(ch) || ch === '\n') return null;
    word = (word ?? '') + ch;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/** `NAME=value` before a command: an environment assignment, not the program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** opencode's options that take a value — so the value is not read as a positional. */
const OPENCODE_VALUE_FLAGS = new Set([
  '-m', '--model', '-s', '--session', '--prompt', '--agent', '--port', '--hostname', '--log-level',
  '--mdns-domain', '--cors', '--replay-limit',
]);

/** claude's subcommands (2.1.289 `--help`): none of them is a conversation in this terminal. */
const CLAUDE_SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp',
  'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview',
  'update', 'upgrade', 'config', 'migrate-installer',
]);

/** `--flag=value` split, or `[arg, undefined]`. */
function flagParts(arg) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
}

function opencodeFromArgs(args) {
  let sessionId = null;
  let fork = false;
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = flagParts(args[i]);
    if (flag === '--') return null; // only positionals follow
    // A positional is a subcommand (`run`, `session`, `serve`, `pr`, … in
    // 1.18.34 — none of them this conversation view) or a project path, which
    // puts the conversation in another directory than the terminal's.
    // Neither is remembered.
    if (!flag.startsWith('-') || flag === '-') return null;
    if (flag === '-h' || flag === '--help' || flag === '-v' || flag === '--version') return null;
    if (flag === '--fork') fork = true;
    if (OPENCODE_VALUE_FLAGS.has(flag)) {
      const value = inline !== undefined ? inline : args[(i += 1)];
      if (flag === '-s' || flag === '--session') sessionId = value ?? null;
    }
  }
  // `--fork` continues into a NEW conversation, whose id nobody has yet.
  return { kind: 'opencode', sessionId: !fork && isSessionIdFor('opencode', sessionId) ? sessionId : null };
}

function claudeFromArgs(args) {
  if (args.length > 0 && CLAUDE_SUBCOMMANDS.has(args[0])) return null;
  let sessionId = null;
  let fork = false;
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = flagParts(args[i]);
    if (['-p', '--print', '-h', '--help', '-v', '--version', '--bg', '--background'].includes(flag)) return null;
    if (flag === '--fork-session') fork = true;
    if (flag === '--session-id') sessionId = inline !== undefined ? inline : args[(i += 1)] ?? null;
    if (flag === '-r' || flag === '--resume') {
      // The value is optional: without one claude shows its own picker.
      const value = inline !== undefined ? inline : args[i + 1];
      if (isSessionIdFor('claude', value)) {
        sessionId = value;
        if (inline === undefined) i += 1;
      }
    }
  }
  return { kind: 'claude', sessionId: !fork && isSessionIdFor('claude', sessionId) ? sessionId : null };
}

/**
 * The agent a line typed at a prompt starts, as `{ kind, sessionId }`, or null
 * when it starts none — or one this cannot follow.
 *
 * Only a single plain command counts: the program's own name (`opencode`,
 * `claude`, with `.exe` / `.cmd` on Windows), after nothing but environment
 * assignments, and run interactively — not a subcommand, `--help`,
 * `--version`, claude's `--print` or `--bg`, nor opencode given a project
 * path. A path to the program (`./bin/opencode`) is not taken either: the
 * resume types the bare name, which might be a different program.
 *
 * `sessionId` is the conversation when the line names one — `opencode -s
 * ses_…`, `claude --resume <uuid>` or `--session-id <uuid>` — and null
 * otherwise, including a `--fork`, which continues into a new one.
 */
export function agentFromCommandLine(line) {
  if (typeof line !== 'string' || line.length > 4096) return null;
  const words = wordsOf(line.trim());
  if (!words || words.length === 0) return null;
  let at = 0;
  while (at < words.length && ENV_ASSIGNMENT.test(words[at])) at += 1;
  const program = words[at];
  if (!program) return null;
  // The bare name only: `./bin/opencode` or `C:\\tools\\opencode.exe` keeps its
  // path in the comparison and is no agent here.
  const name = program.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const args = words.slice(at + 1);
  if (name === 'opencode') return opencodeFromArgs(args);
  if (name === 'claude') return claudeFromArgs(args);
  return null;
}

// ---- Which opencode conversation a terminal shows -----------------------------

/** How opencode shows a conversation's title in the terminal's: past this, cut. */
const OPENCODE_TITLE_FULL = 40;
const OPENCODE_TITLE_CUT = 37;

/**
 * The conversation title in a terminal title opencode set (`OC | <title>`),
 * or null for any other title — its home screen's `OpenCode`, the '' it sets
 * as it quits, or another program's.
 */
export function opencodeTitleOf(windowTitle) {
  if (typeof windowTitle !== 'string') return null;
  const match = /^OC \| (.+)$/s.exec(windowTitle);
  return match ? match[1] : null;
}

/**
 * Whether `full`, a conversation's title, is what opencode would show as
 * `shown`: the same text up to 40 characters, and past that its first 37
 * followed by `…`. A cut through an emoji leaves half of it, which arrives
 * here as U+FFFD, so the 37th character is let off when it is one.
 */
export function opencodeTitleMatches(shown, full) {
  if (typeof shown !== 'string' || typeof full !== 'string') return false;
  if (shown === full) return true;
  if (!shown.endsWith('\u2026') || full.length <= OPENCODE_TITLE_FULL) return false;
  const kept = shown.slice(0, -1);
  if (kept.length !== OPENCODE_TITLE_CUT) return false;
  if (full.slice(0, OPENCODE_TITLE_CUT) === kept) return true;
  return kept.endsWith('\uFFFD') && full.slice(0, OPENCODE_TITLE_CUT - 1) === kept.slice(0, -1);
}

/**
 * The conversation a terminal showing `title` is in, from `sessions` —
 * `opencode session list`'s, already narrowed to the terminal's directory
 * (the backend does that) — or null when none fits.
 *
 * Titles repeat: a model names two conversations about the same thing the
 * same way. So among those whose title fits, the one the terminal is already
 * known to be in (`currentId`) stays — opening an older conversation with
 * `-s` does not make it the most recently updated — and otherwise the most
 * recently updated wins, which is the one just started or just written to.
 */
export function pickOpencodeSession(sessions, { title, currentId = null } = {}) {
  if (!Array.isArray(sessions) || typeof title !== 'string' || !title) return null;
  const fits = sessions.filter(
    (s) => s && isSessionIdFor('opencode', s.id) && opencodeTitleMatches(title, s.title)
  );
  if (fits.length === 0) return null;
  if (currentId && fits.some((s) => s.id === currentId)) return fits.find((s) => s.id === currentId);
  return fits.reduce((best, s) => ((Number(s.updated) || 0) > (Number(best.updated) || 0) ? s : best));
}
