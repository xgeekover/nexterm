/**
 * Hand a URL to the system browser.
 *
 * This is the one thing in the app that acts on text the terminal printed, and
 * terminal output is not trustworthy — it is whatever some program decided to
 * write, which may be a paste, a downloaded file's name, or a server's reply.
 * So it is narrow on purpose, in three independent places:
 *
 *   1. `terminalLinks.js` only ever matches `http` and `https`, so a
 *      `file:///…` or `javascript:…` in the output is never offered as a link;
 *   2. this function refuses anything else again, because it is exported and
 *      the next caller may not have come through that matcher;
 *   3. the backend's capability scopes `opener:allow-open-url` to the same two
 *      schemes, so even a compromised frontend cannot ask for more.
 *
 * Nothing opens on its own. A person clicks a link they can see, which is the
 * same contract every terminal emulator has.
 */
import { invoke, isTauri } from './ipc.js';

/** http(s) only, and it must parse as a URL at all. */
export function isOpenable(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Open `url` in the user's browser. Returns whether it was handed over.
 *
 * A refusal is not an error worth a dialog — the link simply does nothing,
 * which is the right outcome for output that asked for something it should not
 * have.
 */
export async function openExternal(url) {
  if (!isOpenable(url)) {
    console.warn('[openExternal] refused a URL that is not http(s):', url);
    return false;
  }

  if (!isTauri()) {
    // Browser QA and the mock: `noopener` so the opened page cannot reach back
    // through `window.opener`.
    window.open?.(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  try {
    // The plugin's own command, called directly rather than through
    // @tauri-apps/plugin-opener — one less npm dependency for a single call,
    // and the ACL check is on the command, not on the wrapper.
    await invoke('plugin:opener|open_url', { url });
    return true;
  } catch (err) {
    console.warn('[openExternal] the backend refused to open', url, err);
    return false;
  }
}

export default { openExternal, isOpenable };
