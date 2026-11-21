/**
 * Whether NexTerm types an opencode line with `--mini --no-replay`
 * (agents.js `withOpencodeMini`): only while Settings ▸ Terminal ▸ *OpenCode
 * in Mini Mode* is on, and only when `opencode --version` says V1 1.17.10 or
 * newer (the backend's `opencode_version`, src-tauri/src/commands/agent.rs).
 *
 * The answer is kept for the app run: one probe at a time, and one that
 * failed (no opencode, an error, no answer within PROBE_TIMEOUT_MS) is asked
 * again at most once every PROBE_RETRY_MS. Every doubt types the line as it
 * was before mini mode existed — the full TUI — so this fails safe. The
 * setting is read each time a line is typed, so a change applies to the next
 * start or resume. Claude Code lines are never touched, nor probed for.
 *
 * Kept for the run by design (the requirement): an opencode upgraded or
 * replaced while NexTerm runs keeps the first answer until NexTerm restarts
 * or the setting is turned off. The backend asks the opencode the login
 * shell's PATH finds, which may not be the one a folder's nvm, mise, asdf or
 * volta pin, or a PowerShell alias, would run (README, V50 O13a and O13b).
 */
import { invoke } from './ipc.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { withOpencodeMini } from './agents.js';

/** The backend gives up at 5 s; past this the frontend does too. */
export const PROBE_TIMEOUT_MS = 6000;

/** How long a failed probe is not asked again. */
export const PROBE_RETRY_MS = 60_000;

const TIMED_OUT = Symbol('timed out');

/**
 * A launch decision with its own cache. `probe` asks the backend, `enabled`
 * reads the setting; `now`, `timeoutMs` and `retryMs` are for the suites.
 */
export function createOpencodeLaunch({
  probe = () => invoke('opencode_version'),
  enabled = () => useSettingsStore.getState().terminalOpencodeMini !== false,
  now = () => Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS,
  retryMs = PROBE_RETRY_MS,
} = {}) {
  let answer = null;
  let failedAt = -Infinity;
  let inFlight = null;
  let calls = 0;

  const failed = () => {
    failedAt = now();
    return false;
  };

  /** Whether this opencode has mini mode: the kept answer, the probe in flight, or a new one. */
  const supported = () => {
    if (answer) return Promise.resolve(answer.mini);
    if (inFlight) return inFlight;
    if (now() - failedAt < retryMs) return Promise.resolve(false);
    calls += 1;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    inFlight = Promise.race([Promise.resolve().then(probe), timeout])
      .then(
        (result) => {
          if (result === TIMED_OUT || !result || typeof result !== 'object') return failed();
          answer = { version: typeof result.version === 'string' ? result.version : null, mini: result.mini === true };
          return answer.mini;
        },
        () => failed()
      )
      .finally(() => {
        clearTimeout(timer);
        inFlight = null;
      });
    return inFlight;
  };

  return {
    /** `command` as NexTerm types it for an agent of `kind`: with the mini flags when they apply. Never rejects. */
    async line(kind, command) {
      if (kind !== 'opencode' || typeof command !== 'string') return command;
      let on = false;
      try {
        on = enabled() === true;
      } catch {
        on = false;
      }
      if (!on) return command;
      return (await supported()) ? withOpencodeMini(command) : command;
    },
    get answer() {
      return answer;
    },
    /** How many probes were started. */
    get calls() {
      return calls;
    },
  };
}

let launch = createOpencodeLaunch();

/** The line to type for `kind`'s `command` (`startAgent`, `resumeAgent` in terminalStore.js). */
export function opencodeLaunchLine(kind, command) {
  return launch.line(kind, command);
}

/** For the suites: a fresh cache, optionally with other timings or a fake probe; returns it. */
export function resetOpencodeLaunch(options = {}) {
  launch = createOpencodeLaunch(options);
  return launch;
}

export default { createOpencodeLaunch, opencodeLaunchLine, resetOpencodeLaunch, PROBE_TIMEOUT_MS, PROBE_RETRY_MS };
