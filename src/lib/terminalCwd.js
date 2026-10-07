/**
 * Where a new terminal starts.
 *
 * The rule, in order, and the order is the whole point:
 *
 *   1. the directory the CALLER asked for
 *   2. the `terminal.integrated.cwd` setting
 *   3. whatever the backend falls back to — the open folder, then home
 *
 * Step 1 comes first because restoring a session is step 1. Every saved
 * terminal hands `spawnTab` the directory it was in, and a setting that
 * overruled that would undo v0.5.3 and v0.5.5, which exist entirely to make
 * a restored terminal come back where it was.
 *
 * Step 3 is deliberately expressed as `null` rather than resolved here. The
 * backend already decides it (`Workspace::spawn_dir`), it is the only side
 * that knows the canonical root, and duplicating the fallback in the frontend
 * is how the two ends drift apart.
 *
 * A directory on another machine is never asked for: starting a shell in
 * `\\host\share`, or only resolving it, has Windows connect to the host and
 * sign in with the user's credentials. The one asked for and the active
 * terminal's come from what a shell reported (OSC 7) — saved with the
 * session, or live — and anything a program prints can report one. Such a
 * directory falls through to the next step; the backend refuses one too
 * (`Workspace::start_dir`), the setting's included, and Settings says so
 * where it is typed (`NETWORK_START_DIR`).
 */
import { expandHome } from './paths.js';
import { isNetworkPath } from './terminalLinks.js';

/** The values `terminal.integrated.cwd` may hold. */
export const CWD_MODES = ['workspace', 'home', 'active', 'custom'];

/** What Settings says about a custom directory on another machine. */
export const NETWORK_START_DIR =
  'That directory is on another machine, and a terminal never starts in one: opening it signs in to that machine. Map it to a drive letter to use it. New terminals will fall back to the workspace root, or your home directory if no folder is open.';

/**
 * @param {object} input
 * @param {string|null} input.requested  what the caller asked for, if anything
 * @param {string} input.mode            the setting
 * @param {string} input.customPath      the setting's path, for `custom`
 * @param {string|null} input.homeDir    this machine's home directory
 * @param {string|null} input.activeCwd  the active terminal's live directory
 * @returns {string|null} the directory to ask for, or null to let the backend decide
 */
export function resolveStartDir({
  requested = null,
  mode = 'workspace',
  customPath = '',
  homeDir = null,
  activeCwd = null,
} = {}) {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (asked && !isNetworkPath(asked)) return asked;

  switch (mode) {
    case 'home':
      // No home known yet (the backend has not answered) is not a reason to
      // guess one — fall through to the backend, which knows.
      return homeDir || null;
    case 'active': {
      const live = typeof activeCwd === 'string' ? activeCwd.trim() : '';
      // The first terminal of a session has no sibling to copy. That is not a
      // failure; it is just the case where the fallback is the answer.
      return live && !isNetworkPath(live) ? live : null;
    }
    case 'custom': {
      const typed = typeof customPath === 'string' ? customPath.trim() : '';
      if (!typed) return null;
      const path = expandHome(typed, homeDir);
      return isNetworkPath(path) ? null : path;
    }
    case 'workspace':
    default:
      return null;
  }
}
