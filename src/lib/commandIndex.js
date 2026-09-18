import { loadState, saveState } from './persistence.js';
/**
 * Ranked command-line suggestion source for the terminal's inline
 * intellisense (see TerminalView.jsx). This is deliberately an *app-side*
 * suggestion layer, not real shell completion: it never inspects the
 * filesystem, PATH, or the shell's own completion rules — it only ranks
 * strings from two sources:
 *
 *   1. Commands this session has actually run (folded in via `recordCommand`,
 *      most-recent + most-frequent ranked highest of all).
 *   2. A small curated index of common commands and their frequent
 *      subcommands/flags, used as a baseline when history has nothing to say.
 *
 * Ranking contract (see tests/adversarial/terminal_intellisense.test.js):
 *   - Any history match outranks any static-index match, regardless of
 *     match quality (a session's own habits are always more relevant than
 *     the generic baseline).
 *   - Within the same tier, a prefix match outranks a subsequence match.
 *   - Empty/whitespace-only input yields no suggestions at all.
 */

// ---------------------------------------------------------------------------
// Curated static index — common commands with their frequent
// subcommands/flags spelled out as full example command lines. Kept flat
// (rather than a nested tree) so prefix/subsequence matching against the
// whole typed line "just works" for any prefix depth ("g", "git ", "git co").
// ---------------------------------------------------------------------------
const STATIC_COMMANDS = [
  // git
  'git status', 'git status -s', 'git add .', 'git add -A', 'git commit', 'git commit -m',
  'git commit --amend', 'git push', 'git push origin', 'git push -u origin', 'git pull',
  'git pull --rebase', 'git branch', 'git branch -a', 'git branch -d', 'git checkout',
  'git checkout -b', 'git checkout main', 'git switch', 'git switch -c', 'git log',
  'git log --oneline', 'git log --graph', 'git diff', 'git diff --staged', 'git stash',
  'git stash pop', 'git stash list', 'git merge', 'git rebase', 'git rebase -i', 'git clone',
  'git reset', 'git reset --hard', 'git reset --soft HEAD~1', 'git fetch', 'git fetch --all',
  'git remote -v', 'git tag', 'git cherry-pick', 'git blame', 'git rm', 'git mv',

  // npm
  'npm install', 'npm install --save-dev', 'npm run', 'npm run dev', 'npm run build',
  'npm run lint', 'npm run test', 'npm test', 'npm start', 'npm ci', 'npm update',
  'npm init', 'npm init -y', 'npm outdated', 'npm audit', 'npm audit fix', 'npm link',
  'npm publish', 'npm uninstall', 'npm cache clean --force',

  // pnpm / yarn
  'pnpm install', 'pnpm add', 'pnpm add -D', 'pnpm run', 'pnpm run dev', 'pnpm build',
  'pnpm test', 'pnpm dlx', 'pnpm update', 'pnpm remove',
  'yarn install', 'yarn add', 'yarn add -D', 'yarn run', 'yarn dev', 'yarn build', 'yarn test',
  'yarn remove', 'yarn upgrade',

  // node
  'node --version', 'node -v', 'node index.js', 'node -e', 'node --inspect', 'node -r dotenv/config',

  // cargo
  'cargo build', 'cargo build --release', 'cargo run', 'cargo test', 'cargo check',
  'cargo new', 'cargo add', 'cargo update', 'cargo fmt', 'cargo clippy', 'cargo doc --open',

  // docker
  'docker ps', 'docker ps -a', 'docker images', 'docker build', 'docker build -t',
  'docker run', 'docker run -it', 'docker run -d', 'docker compose up', 'docker compose up -d',
  'docker compose down', 'docker compose logs -f', 'docker exec -it', 'docker logs',
  'docker logs -f', 'docker stop', 'docker rm', 'docker rmi', 'docker pull', 'docker push',
  'docker network ls', 'docker volume ls',

  // kubectl
  'kubectl get pods', 'kubectl get svc', 'kubectl get nodes', 'kubectl get deployments',
  'kubectl apply -f', 'kubectl delete -f', 'kubectl describe pod', 'kubectl logs',
  'kubectl logs -f', 'kubectl exec -it', 'kubectl rollout restart', 'kubectl port-forward',
  'kubectl config get-contexts', 'kubectl config use-context',

  // brew
  'brew install', 'brew update', 'brew upgrade', 'brew list', 'brew search', 'brew uninstall',
  'brew cleanup', 'brew doctor', 'brew services list', 'brew services restart',

  // everyday shell tools
  'ls', 'ls -la', 'ls -al', 'ls -lh', 'cd', 'cd ..', 'cd ~', 'cd -', 'pwd',
  'grep -r', 'grep -rn', 'grep -rni', 'find . -name', 'find . -type f', 'tar -xzf',
  'tar -czf', 'tar -xvf', 'curl -o', 'curl -O', 'curl -X GET', 'curl -X POST', 'curl -I',
  'ssh', 'scp', 'chmod +x', 'chmod 755', 'chown -R', 'mkdir -p', 'rm -rf', 'cp -r',
  'mv', 'which', 'echo $PATH', 'history', 'clear', 'exit',
];

// ---------------------------------------------------------------------------
// Session history — populated only via recordCommand(). Kept as an ordered
// log (oldest first) plus a frequency map so ranking can reward both
// recency and repetition, per the task's "most-recent + frequency" ask.
// ---------------------------------------------------------------------------
let historyLog = []; // ordered, oldest → newest, de-duplicated (re-running a
// command moves it to the end instead of adding a second entry)
const historyFreq = new Map(); // command -> times executed

/**
 * Where and when each command was last run, for the history palette.
 *
 * Kept beside the log rather than inside it because the log's shape — a
 * de-duplicated array of strings — is what the suggestion ranking reads, and
 * that is covered by cases nothing here should disturb.
 */
const historyMeta = new Map(); // command -> { cwd, at }

/**
 * The history outlives the window.
 *
 * It used to live only in module scope, so every reload started from nothing —
 * which is fine for ranking the next keystroke and useless for "what did I run
 * yesterday". Stored through the same helper the layout and settings use, and
 * capped, because a machine left running for a month should not accumulate an
 * unbounded log in localStorage.
 *
 * Saving is best-effort on purpose: a full or blocked store must cost a
 * suggestion, never a keystroke.
 */
const HISTORY_KEY = 'nexterm.commandHistory';

function persistHistory() {
  try {
    saveState(HISTORY_KEY, historyLog.map((command) => ({
      c: command,
      n: historyFreq.get(command) || 1,
      d: historyMeta.get(command)?.cwd ?? null,
      t: historyMeta.get(command)?.at ?? null,
    })));
  } catch (_) {
    // Never worth interrupting typing for.
  }
}

/**
 * Read back what an earlier session ran. Called once, by the app's bootstrap.
 *
 * Tolerant of anything: this is a file on the user's disk, and one bad entry
 * must not cost them the rest of their history.
 */
export function loadCommandHistory() {
  const saved = loadState(HISTORY_KEY, null);
  if (!Array.isArray(saved)) return 0;
  let restored = 0;
  for (const entry of saved) {
    const command = typeof entry?.c === 'string' ? entry.c.trim() : '';
    if (!command || historyFreq.has(command)) continue;
    historyLog.push(command);
    historyFreq.set(command, Number.isFinite(entry.n) && entry.n > 0 ? entry.n : 1);
    historyMeta.set(command, {
      cwd: typeof entry.d === 'string' ? entry.d : null,
      at: Number.isFinite(entry.t) ? entry.t : null,
    });
    restored += 1;
  }
  return restored;
}

/** How many commands survive a restart. Enough to be a history, not a log. */
const HISTORY_LIMIT = 500;

export function recordCommand(cmd, { cwd = null, at = Date.now() } = {}) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return;
  historyLog = historyLog.filter((c) => c !== trimmed);
  historyLog.push(trimmed);
  historyFreq.set(trimmed, (historyFreq.get(trimmed) || 0) + 1);
  historyMeta.set(trimmed, { cwd: cwd || historyMeta.get(trimmed)?.cwd || null, at });
  if (historyLog.length > HISTORY_LIMIT) {
    const dropped = historyLog.splice(0, historyLog.length - HISTORY_LIMIT);
    for (const command of dropped) {
      historyFreq.delete(command);
      historyMeta.delete(command);
    }
  }
  persistHistory();
}

/**
 * The history, newest first, as the palette shows it.
 *
 * `count` is how often the command has been run and `cwd` where it last ran —
 * which is most of what tells two similar-looking commands apart.
 */
export function commandHistory() {
  const out = [];
  for (let i = historyLog.length - 1; i >= 0; i -= 1) {
    const command = historyLog[i];
    const meta = historyMeta.get(command) || {};
    out.push({ command, cwd: meta.cwd ?? null, at: meta.at ?? null, count: historyFreq.get(command) || 1 });
  }
  return out;
}

/**
 * Take a command back out of the history.
 *
 * A command is recorded when it is submitted, because that is the only moment
 * that works for shells without OSC 133 integration. When the shell does tell
 * us the exit code and it is non-zero, the typo comes straight back out again —
 * otherwise `opencoded` was suggested, and offered ahead of `opencode`, for the
 * rest of the session.
 */
export function forgetCommand(cmd) {
  const key = typeof cmd === 'string' ? cmd.trim() : '';
  if (!key) return;
  const seen = historyFreq.get(key);
  if (seen === undefined) return;
  if (seen > 1) {
    // It has worked before; one failure should not erase a command the user
    // actually uses.
    historyFreq.set(key, seen - 1);
    return;
  }
  historyFreq.delete(key);
  historyMeta.delete(key);
  historyLog = historyLog.filter((c) => c !== key);
  persistHistory();
}

/** Test-only: drop everything recordCommand has accumulated so far. */
export function __resetCommandHistory() {
  historyLog = [];
  historyFreq.clear();
  historyMeta.clear();
}

// ---------------------------------------------------------------------------
// Matching + ranking
// ---------------------------------------------------------------------------

/** True if every character of `needle` appears in `haystack`, in order
 * (not necessarily contiguous). Both must already be lower-cased. */
function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Tiers are multiplied by a value far larger than any possible in-tier score
// spread, so a tier boundary is never crossed by match quality alone —
// "history outranks the static index" holds unconditionally.
const TIER_HISTORY = 1;
const TIER_STATIC = 0;
const TIER_SPAN = 1_000_000;

const PREFIX_BASE = 10_000;
const SUBSEQUENCE_BASE = 100;

/** Match-quality score for one candidate against the (already-trimmed,
 * lower-cased) input, or null if it does not match at all. Prefix matches
 * always outrank subsequence matches; shorter/tighter candidates are
 * preferred within each kind so the list doesn't bury an exact command
 * under long ones that merely happen to start the same way. */
function matchScore(lowerInput, lowerCandidate) {
  if (lowerCandidate.startsWith(lowerInput)) {
    return PREFIX_BASE - lowerCandidate.length;
  }
  if (isSubsequence(lowerInput, lowerCandidate)) {
    return SUBSEQUENCE_BASE - lowerCandidate.length;
  }
  return null;
}

export const MAX_SUGGESTIONS = 8;

/**
 * Rank suggestions for the current input line.
 * `history` lets a caller fold in extra session commands it tracked itself,
 * on top of whatever recordCommand() has already accumulated internally —
 * either source alone is enough, callers only need one of them.
 */
export function suggest(input, { history = [] } = {}) {
  const trimmedInput = (input || '').trim();
  if (!trimmedInput) return [];
  const lowerInput = trimmedInput.toLowerCase();

  const best = new Map(); // candidate string -> best score seen so far

  const consider = (candidate, tier, bonus = 0) => {
    if (!candidate || candidate === trimmedInput) return; // nothing left to suggest
    const score = matchScore(lowerInput, candidate.toLowerCase());
    if (score === null) return;
    const total = tier * TIER_SPAN + score + bonus;
    const existing = best.get(candidate);
    if (existing === undefined || total > existing) {
      best.set(candidate, total);
    }
  };

  // History tier: internal recordCommand() log + whatever the caller passed.
  historyLog.forEach((cmd, index) => {
    const recencyBonus = index; // later index = more recent = higher bonus
    const freqBonus = (historyFreq.get(cmd) || 1) * 5;
    consider(cmd, TIER_HISTORY, recencyBonus + freqBonus);
  });
  history.forEach((cmd) => consider(cmd, TIER_HISTORY));

  // Static index tier.
  STATIC_COMMANDS.forEach((cmd) => consider(cmd, TIER_STATIC));

  return Array.from(best.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SUGGESTIONS)
    .map(([candidate]) => candidate);
}

export default { suggest, recordCommand, forgetCommand, completionFor };

/**
 * The text still to be typed for `candidate` to complete `buffer`, or null when
 * it does not complete it at all.
 *
 * `suggest()` ranks subsequence matches too — `gs` matches `git push` — which
 * are useful to SHOW but must never be accepted by slicing off `buffer.length`
 * characters: that wrote the tail of a different string onto the command line
 * (`gs` + Enter became `gst push`). Completion is only defined when the
 * candidate literally continues what is there.
 */
export function completionFor(buffer, candidate) {
  if (typeof buffer !== 'string' || typeof candidate !== 'string') return null;
  if (!candidate.toLowerCase().startsWith(buffer.toLowerCase())) return null;
  return candidate.slice(buffer.length);
}
