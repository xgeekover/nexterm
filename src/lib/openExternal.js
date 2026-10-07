/**
 * Hand a URL to the system browser.
 *
 * This is the one thing in the app that acts on text the terminal printed, and
 * terminal output is not trustworthy — it is whatever some program decided to
 * write, which may be a paste, a downloaded file's name, or a server's reply.
 * So it is narrow on purpose, in three independent places:
 *
 *   1. `terminalLinks.js` only ever matches `http` and `https`, and xterm
 *      offers a program's OSC 8 hyperlink only for those two (the registry's
 *      `hyperlinkHandler` keeps `allowNonHttpProtocols` off), so a
 *      `file:///…` or `javascript:…` in the output is never offered as a link;
 *   2. this function refuses anything else again, because it is exported and
 *      the next caller may not have come through that matcher;
 *   3. the backend's capability scopes `opener:allow-open-url` to the same two
 *      schemes, so even a compromised frontend cannot ask for more.
 *
 * Nothing opens on its own. A person clicks a link they can see, which is the
 * same contract every terminal emulator has — and since an OSC 8 hyperlink
 * draws text of the program's choosing over its address, the address is
 * shown while the pointer is on it (`hyperlinkTitle`).
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
 * How much of an address a hyperlink's tooltip shows. Past it the address is
 * cut at the end, after the scheme and host it opens, which always show: a
 * program can make an address as long as it likes, and the tooltip is no
 * place for megabytes.
 */
export const HYPERLINK_TITLE_LIMIT = 300;

/**
 * Where an OSC 8 hyperlink goes, as its tooltip says it — or null for one
 * that would not open (`isOpenable`).
 *
 * A program draws a hyperlink over text of its own choosing, so "here" can
 * lead anywhere, and the tooltip is the one place the address shows. It shows
 * the address as it will be read — parsed, as the opener and the browser
 * parse it, not as the program spelled it: an international host name in
 * punycode, and anything outside ASCII after it percent-encoded, so no
 * right-to-left mark can turn it round.
 * And without a user name: in `https://example.com@evil.example/` the part
 * before the `@` is a user name sent to the host, the host is evil.example,
 * and the tooltip shows `https://evil.example/`.
 */
export function hyperlinkTitle(uri) {
  if (!isOpenable(uri)) return null;
  const url = new URL(uri);
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const room = HYPERLINK_TITLE_LIMIT - url.origin.length;
  if (rest.length <= room) return `${url.origin}${rest}`;
  return `${url.origin}${rest.slice(0, Math.max(0, room - 1))}…`;
}

/**
 * The address `openExternal` hands over for `url`: the one its tooltip shows
 * (`hyperlinkTitle`), whole — parsed, without a user name, a space or a quote
 * in it percent-encoded, the scheme in lower case.
 *
 * A program's OSC 8 hyperlink reaches here as the program spelled it, and the
 * opener does not parse it. `https://example.com/" --flag "` went to the
 * Windows shell with its quotes and spaces in it, and `HTTPS://example.com`
 * or one with a space in front was underlined, shown in the tooltip, and
 * then refused by the backend's scope, which matches the raw text — a click
 * that did nothing.
 */
export function addressToOpen(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Open `url` in the user's browser — as `addressToOpen` spells it. Returns
 * whether it was handed over.
 *
 * A refusal is not an error worth a dialog — the link simply does nothing,
 * which is the right outcome for output that asked for something it should not
 * have.
 */
export async function openExternal(raw) {
  if (!isOpenable(raw)) {
    console.warn('[openExternal] refused a URL that is not http(s):', raw);
    return false;
  }
  const url = addressToOpen(raw);

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

export default { openExternal, isOpenable, hyperlinkTitle, addressToOpen };
