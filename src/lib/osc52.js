/**
 * OSC 52: a program in a terminal asking to put text on the clipboard.
 *
 * tmux, vim, Neovim and shells over ssh copy that way, because the program
 * cannot reach the clipboard of the machine the user sits at; the terminal
 * can. The sequence is `ESC ] 52 ; Pc ; Pd BEL` (or ST): `Pc` names the
 * selections (c, p, q, s and the cut buffers 0-7, empty meaning the default),
 * and `Pd` is the text, as base64.
 *
 * Only writes, only when the user turned them on (Settings > Terminal > Let
 * Programs Set the Clipboard (OSC 52), `terminalOsc52Write`, off by default),
 * and only to the one system clipboard, whichever selections `Pc` names:
 *
 * - A read (`Pd` is `?`) is refused, and nothing is answered: a program that
 *   could read the clipboard would read whatever the user copied last — a
 *   password, a key — and anything ssh'd into could. No notice either.
 * - A clear (`Pd` empty, or not base64) is refused: a program has no business
 *   emptying what the user copied. No notice.
 * - More than 128 KiB of text (MAX_OSC52_BYTES), or bytes that are not UTF-8,
 *   is refused whole — never cut short to fit.
 * - Output kept from before the terminal was first shown (`keptHistory`)
 *   is ignored entirely: what a program copied an hour ago in a tab never
 *   looked at is not what the user wants on the clipboard now.
 *
 * Why off by default: anything that can print to the terminal — a file `cat`
 * shows, a log line, a server over ssh — can set the clipboard with it, and
 * the next paste runs what it put there. A user who wants programs to copy
 * turns it on.
 *
 * While it is off, the first write a terminal sees prints one notice in it
 * naming the setting, so the user learns why the copy did nothing; while it
 * is on, the first write refused for size prints one of its own. Once per
 * terminal (tab id) for the app session, in memory. On the alternate screen
 * the notice waits until the terminal shows its normal screen again: written
 * into a full-screen program's screen it would corrupt it.
 *
 * Nothing a program writes is logged, kept, or put in a notice or an error.
 * No @xterm/addon-clipboard: it answers reads, and writes through the
 * webview, which asks the user on WebView2.
 */

/** The most text a program may put on the clipboard: 128 KiB, as UTF-8 (MAX_WRITE_BYTES in src-tauri/src/commands/clipboard.rs). */
export const MAX_OSC52_BYTES = 131072;

/** The longest base64 that can hold MAX_OSC52_BYTES: 4 characters for every 3 bytes, the last 1-3 bytes padded to 4. */
export const MAX_OSC52_BASE64 = Math.ceil(MAX_OSC52_BYTES / 3) * 4;

/** Where the user turns writes on, as the notice names it. */
export const OSC52_SETTING = 'Settings > Terminal > Let Programs Set the Clipboard (OSC 52)';

/** The notice for a write refused because writes are off. */
export const OSC52_DISABLED_NOTICE = `A program asked to put text on the clipboard (OSC 52). NexTerm did not let it: to allow it, turn on ${OSC52_SETTING}.`;

/** The notice for a write refused for its size or its bytes. It never says what the text was. */
export const OSC52_SIZE_NOTICE = 'A program asked to put more than 128 KiB, or text that is not UTF-8, on the clipboard (OSC 52). NexTerm refused it.';

const TARGETS = /^[cpqs0-7]*$/;
const BASE64 = /^([A-Za-z0-9+/]*)(={0,2})$/;

/** Whether `pd` is base64 a decoder reads whole: padded to a multiple of 4, or unpadded with a length that can be. */
function isBase64(pd) {
  const match = BASE64.exec(pd);
  if (!match) return false;
  const [, body, pad] = match;
  if (body.length === 0) return false;
  if (pad.length === 0) return body.length % 4 !== 1;
  return body.length % 4 === 4 - pad.length;
}

const strictUtf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The bytes in `pd`, already checked by `isBase64`. */
function decodeBase64(pd) {
  const binary = atob(pd);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * What to do with one OSC 52's data (`Pc;Pd`, what xterm hands its handler),
 * with writes `enabled` or not:
 *
 * - `{ action: 'write', text }` — put `text` on the clipboard;
 * - `{ action: 'refuse-target' }` — no `;`, or a `Pc` that names anything but
 *   c, p, q, s and 0-7: not a request this answers;
 * - `{ action: 'refuse-read' }` — `Pd` is `?`;
 * - `{ action: 'refuse-clear' }` — `Pd` empty or not base64;
 * - `{ action: 'refuse-size' }` — longer than MAX_OSC52_BASE64, decoded to
 *   more than MAX_OSC52_BYTES, or not UTF-8 (while enabled);
 * - `{ action: 'refuse-disabled' }` — a write, while writes are off.
 *
 * Pure: it reads nothing but its arguments. While disabled, a write is never
 * decoded.
 */
export function decideOsc52(data, { enabled = false } = {}) {
  if (typeof data !== 'string') return { action: 'refuse-target' };
  const split = data.indexOf(';');
  if (split < 0) return { action: 'refuse-target' };
  const pc = data.slice(0, split);
  const pd = data.slice(split + 1);
  if (!TARGETS.test(pc)) return { action: 'refuse-target' };
  if (pd === '?') return { action: 'refuse-read' };
  if (pd === '') return { action: 'refuse-clear' };
  if (pd.length > MAX_OSC52_BASE64) return { action: enabled === true ? 'refuse-size' : 'refuse-disabled' };
  if (!isBase64(pd)) return { action: 'refuse-clear' };
  if (enabled !== true) return { action: 'refuse-disabled' };
  const bytes = decodeBase64(pd);
  if (bytes.length > MAX_OSC52_BYTES) return { action: 'refuse-size' };
  let text;
  try {
    text = strictUtf8().decode(bytes);
  } catch {
    return { action: 'refuse-size' };
  }
  return { action: 'write', text };
}

/** The tab ids that were told, by notice kind, for this app session. */
const toldThisSession = new Set();

/**
 * The OSC 52 handler on one terminal, as an xterm addon so it is disposed with
 * it. See the module comment and `installOsc52`.
 */
class Osc52Addon {
  constructor({ enabled, keptHistory, write, notice, alternate, onNormalBuffer, noticeKey, told } = {}) {
    this._enabled = enabled;
    this._keptHistory = keptHistory;
    this._write = write;
    this._notice = notice;
    this._alternate = alternate;
    this._onNormalBuffer = onNormalBuffer;
    this._noticeKey = noticeKey;
    // Without a key, this terminal's own record; with one, the session's.
    this._told = told instanceof Set ? told : noticeKey === undefined ? new Set() : toldThisSession;
    this._waiting = [];
    this._disposables = [];
  }

  activate(term) {
    this._term = term;
    this._disposables.push(
      term.parser.registerOscHandler(52, (data) => {
        // Always consumed, whatever happens: a handler that throws wedges
        // xterm's write queue for good (see mouseReporting.js), and nothing
        // else may take a clipboard request.
        try {
          this._handle(data);
        } catch (err) {
          console.warn('[Terminal] could not handle OSC 52:', err?.name || 'error');
        }
        return true;
      })
    );
    const normal = this._subscribeNormalBuffer(() => this._flushWaiting());
    if (normal) this._disposables.push(normal);
  }

  _handle(data) {
    if (this._ask(this._keptHistory) === true) return;
    const decision = decideOsc52(data, { enabled: this._ask(this._enabled) === true });
    switch (decision.action) {
      case 'write':
        this._send(decision.text);
        return;
      case 'refuse-disabled':
        this._tell('disabled', OSC52_DISABLED_NOTICE);
        return;
      case 'refuse-size':
        this._tell('size', OSC52_SIZE_NOTICE);
        return;
      default:
        // A read, a clear or another target: refused without a word, and
        // nothing is answered.
        return;
    }
  }

  /** `fn()`, or false when it is not a function or throws. */
  _ask(fn) {
    try {
      return typeof fn === 'function' ? fn() : false;
    } catch {
      return false;
    }
  }

  _send(text) {
    let sent;
    try {
      sent = this._write?.(text);
    } catch (err) {
      this._warnWrite(err);
      return;
    }
    if (sent && typeof sent.then === 'function') sent.then(undefined, (err) => this._warnWrite(err));
  }

  _warnWrite(err) {
    // The error only — the backend's never quotes the text.
    console.warn('[Terminal] could not set the clipboard (OSC 52):', err?.message ?? String(err));
  }

  /** One notice of `kind` per terminal per session: now, or on the normal screen. */
  _tell(kind, message) {
    const key = `${kind}\u0000${this._noticeKey ?? ''}`;
    if (this._told.has(key)) return;
    this._told.add(key);
    if (this._onAlternateScreen()) {
      this._waiting.push(message);
      return;
    }
    this._say(message);
  }

  _onAlternateScreen() {
    if (typeof this._alternate === 'function') return this._ask(this._alternate) === true;
    return this._term?.buffer?.active?.type === 'alternate';
  }

  _subscribeNormalBuffer(fn) {
    try {
      if (typeof this._onNormalBuffer === 'function') return this._onNormalBuffer(fn) ?? null;
      return (
        this._term?.buffer?.onBufferChange?.((buffer) => {
          if (buffer?.type !== 'alternate') fn();
        }) ?? null
      );
    } catch {
      return null;
    }
  }

  _flushWaiting() {
    try {
      for (const message of this._waiting.splice(0)) this._say(message);
    } catch {
      // never into xterm's parser
    }
  }

  _say(message) {
    try {
      this._notice?.(message);
    } catch {
      // A notice that could not be shown is not worth a wedged terminal.
    }
  }

  dispose() {
    this._waiting = [];
    for (const d of this._disposables.splice(0)) {
      try {
        d?.dispose?.();
      } catch {
        // the terminal is going anyway
      }
    }
  }
}

/**
 * Take OSC 52 on `term` from now on (see the module comment). Options, each
 * read as a sequence arrives:
 *
 * - `enabled()` — whether writes are on (`terminalOsc52Write`);
 * - `keptHistory()` — whether the output being read was kept from before the
 *   terminal was shown; then the sequence is ignored;
 * - `write(text)` — put `text` on the clipboard; a rejection is warned about,
 *   the error alone;
 * - `notice(message)` — show NexTerm's notice in this terminal;
 * - `alternate()` and `onNormalBuffer(fn)` — whether the alternate screen is
 *   up, and a subscription to the switch back (xterm's own by default);
 * - `noticeKey` — the tab id the one-notice rule counts by for the session;
 *   without one, by this terminal; `told`, a Set of its own to count in.
 *
 * Returns the addon, or null when `term` has no parser (a test double).
 */
export function installOsc52(term, options = {}) {
  if (typeof term?.parser?.registerOscHandler !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new Osc52Addon(options);
  term.loadAddon(addon);
  return addon;
}
