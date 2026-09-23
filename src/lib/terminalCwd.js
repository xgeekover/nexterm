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
 */
import { expandHome } from './paths.js';

/** The values `terminal.integrated.cwd` may hold. */
export const CWD_MODES = ['workspace', 'home', 'active', 'custom'];

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
  if (asked) return asked;

  switch (mode) {
    case 'home':
      // No home known yet (the backend has not answered) is not a reason to
      // guess one — fall through to the backend, which knows.
      return homeDir || null;
    case 'active': {
      const live = typeof activeCwd === 'string' ? activeCwd.trim() : '';
      // The first terminal of a session has no sibling to copy. That is not a
      // failure; it is just the case where the fallback is the answer.
      return live || null;
    }
    case 'custom': {
      const typed = typeof customPath === 'string' ? customPath.trim() : '';
      if (!typed) return null;
      return expandHome(typed, homeDir);
    }
    case 'workspace':
    default:
      return null;
  }
}
