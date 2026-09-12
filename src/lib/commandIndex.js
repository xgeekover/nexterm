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

export function recordCommand(cmd) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return;
  historyLog = historyLog.filter((c) => c !== trimmed);
  historyLog.push(trimmed);
  historyFreq.set(trimmed, (historyFreq.get(trimmed) || 0) + 1);
}

/** Test-only: drop everything recordCommand has accumulated so far. */
export function __resetCommandHistory() {
  historyLog = [];
  historyFreq.clear();
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

export default { suggest, recordCommand };
