/**
 * Notifications a program in the terminal asks for — OpenCode saying a
 * session is done or needs permission, Claude Code saying it is waiting —
 * read off the terminal's output and handed to the app.
 *
 * Three escape sequences carry them, and a program picks one by the terminal
 * it believes it is in:
 *
 *   OSC 99    kitty's desktop-notification protocol: a title and a body sent
 *             in chunks that share an id, plain or base64. OpenCode's TUI
 *             (OpenTUI), and Claude Code with its notification channel set
 *             to "kitty".
 *   OSC 9     iTerm2's: everything after `9;` is the message. OpenTUI's
 *             `osc9` sends "title: body" in it, Claude Code's "iterm2"
 *             channel the same.
 *   OSC 777   urxvt's `notify;title;body`, which Ghostty speaks: Claude
 *             Code's "ghostty" channel.
 *
 * xterm.js 6.0 handles none of the three: each was dropped without a trace.
 *
 * What OpenCode does, measured with 1.18.34 in a PTY harness (2026-10-05). It
 * notifies only when its tui.json turns `attention` on, and only while it
 * believes the terminal is unfocused — it asks for focus reports (`CSI ? 1004
 * h`), which xterm.js sends, and with no report yet it does not notify at all.
 * It plays its own sound; the terminal plays none. As it starts, OpenTUI asks
 * `ESC ] 99 ; i=opentui-notifications : p=? ; ESC \` — kitty's capability
 * query — and picks OSC 99 only if the terminal answers. With no answer, which
 * is all xterm.js gives, it sent nothing, ever. The answer here is what makes
 * it pick OSC 99. The backend also sets OPENTUI_NOTIFICATION_PROTOCOL=osc99
 * for every shell (`set_session_env` in pty/manager.rs), for ConPTY, which may
 * not carry the answer back to the program.
 *
 * What Claude Code 2.1.289 does: nothing, until its notification channel is
 * set. "auto" picks by the terminal's name and has none for xterm.js, which
 * is what NexTerm answers XTVERSION with. Set to "kitty" it sends a title
 * chunk, a body chunk with no `d` (so, by kitty's rule, the notification is
 * complete there), and then an empty chunk with `d=1:a=focus` — which is an
 * empty notification here, and dropped.
 *
 * Program output is not trusted. Whatever a program prints — or a file
 * someone `cat`s — reaches these handlers, so the text is cleaned of control
 * and bidirectional characters and cut to length (`sanitizeText`), the
 * pending state of a kitty notification is capped, the one value ever echoed
 * back to the program (a kitty id) must look like an id, and one terminal can
 * notify only so often (`RATE_LIMIT`).
 *
 * Three parts:
 *
 *   - pure parsing: `parseOsc9`, `parseOsc777` and `KittyNotifications`, which
 *     assembles OSC 99 chunks and answers the query;
 *   - where one goes, also pure: `windowAttention` and `routeProgramNotification`,
 *     which terminalStore's `notifyFromProgram` follows;
 *   - `installProgramNotifications`, an xterm addon (disposed with its
 *     terminal) that listens for all three and hands each notification on.
 *
 * No xterm, no store: everything here can be checked in Node.
 */

/** The longest title kept, in characters; anything longer ends in "…". */
export const TITLE_MAX = 100;

/** The longest message kept, in characters. */
export const BODY_MAX = 400;

/**
 * How often one terminal may notify: once in any 2 seconds, and 10 times in
 * any minute. Anything past that is dropped, not queued.
 *
 * A program that prints a notification in a loop — or a log full of them,
 * `cat`-ed — would otherwise fill the bell, which keeps 50, and the desktop.
 * OpenCode notifies once per event, and an event needs a session to finish or
 * a tool to ask, which takes seconds at the very least; Claude Code the same.
 */
export const RATE_LIMIT = Object.freeze({ intervalMs: 2000, perMinute: 10 });

// ---- Cleaning the text ------------------------------------------------------

/** Line and paragraph breaks and tabs: whitespace, kept as a space. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

/**
 * Removed outright: every other control character (C0, DEL, C1), and the
 * invisible bidirectional marks, embeddings, overrides and isolates (U+061C,
 * U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), which can make a line read
 * differently from the text it holds. Joiners stay: emoji sequences need them.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * How much of a payload is looked at, in UTF-16 units. xterm hands a handler
 * up to 10 MB; the most kept is 400 characters, and this leaves room for a
 * great deal of whitespace before them.
 */
const INPUT_MAX = 16_384;

/**
 * `text` as it can be shown: control and bidirectional characters gone, runs
 * of whitespace one space, trimmed, and cut to `max` characters — counted by
 * code point, so an emoji is never split in half — ending in "…" when cut.
 * '' for anything that is not a string.
 */
export function sanitizeText(text, max) {
  if (typeof text !== 'string' || !(max > 0)) return '';
  const head = text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text;
  const clean = head.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The occasions kitty defines: always, only while unfocused, only while not visible. */
const OCCASIONS = new Set(['always', 'unfocused', 'invisible']);

/**
 * A notification as the rest of the app sees it, or null when nothing would
 * be left to show. `title` may be '': the program gave none, and the store
 * titles it after the terminal.
 */
function makeNote(title, body, occasion = 'always', urgency = 1) {
  const cleanTitle = sanitizeText(title, TITLE_MAX);
  const cleanBody = sanitizeText(body, BODY_MAX);
  if (!cleanTitle && !cleanBody) return null;
  return {
    title: cleanTitle,
    body: cleanBody,
    occasion: OCCASIONS.has(occasion) ? occasion : 'always',
    urgency,
  };
}

// ---- OSC 9 and OSC 777 ------------------------------------------------------

/**
 * ConEmu's OSC 9 sub-commands, which Windows Terminal adopted: `9;4;…` is a
 * progress bar and `9;9;…` the working directory, and PowerShell prompts and
 * oh-my-posh send the second at every prompt on Windows. Claude Code sends the
 * first while it works. Read as messages, they would be a notification per
 * prompt. A real message that is a bare number, or starts with one and a
 * semicolon, is lost with them.
 */
const CONEMU = /^\d+(;|$)/;

/**
 * An OSC 9 payload as a notification, or null: a ConEmu sub-command, or
 * nothing to show. The whole payload is the message. OpenTUI and Claude Code
 * put "title: body" in it, and it stays whole — a colon is just as likely to
 * belong to the message — so the title is left to the store.
 */
export function parseOsc9(data) {
  if (typeof data !== 'string' || CONEMU.test(data)) return null;
  return makeNote('', data);
}

/**
 * An OSC 777 payload as a notification, or null. Only `notify;title;body` is
 * one; urxvt's other 777 commands are not. The body runs to the end and may
 * hold semicolons; a title cannot.
 */
export function parseOsc777(data) {
  if (typeof data !== 'string') return null;
  const first = data.indexOf(';');
  if ((first === -1 ? data : data.slice(0, first)) !== 'notify') return null;
  const rest = first === -1 ? '' : data.slice(first + 1);
  const second = rest.indexOf(';');
  return second === -1 ? makeNote(rest, '') : makeNote(rest.slice(0, second), rest.slice(second + 1));
}

// ---- OSC 99 (kitty) ---------------------------------------------------------

/**
 * What NexTerm tells a program that asks (`p=?`) — only what is implemented.
 * `a=focus`: clicking a notification's entry in the bell goes to its
 * terminal. NOT `report`: a click on the desktop notification never reaches
 * NexTerm — the notification plugin hands it to the OS and hears nothing
 * back — so no click could ever be reported to the program. Every occasion
 * and urgency is accepted, and occasion is honoured; urgency is not — the
 * desktop gets one kind.
 */
export const KITTY_CAPABILITIES = 'a=focus:o=always,unfocused,invisible:p=title,body,?:u=0,1,2';

/**
 * An id kitty allows (`[a-zA-Z0-9-_+.]`), at a sane length. The id of a query
 * goes back to the program inside the answer — as input, into whatever is
 * reading the terminal — so nothing else is ever echoed.
 */
const KITTY_ID = /^[A-Za-z0-9_+.-]{1,128}$/;

/** Notifications held while their chunks arrive; past this, the oldest goes. */
const KITTY_MAX_PENDING = 16;

/** Bytes kept of one notification's title, and of its body, until it is complete. */
const KITTY_MAX_PART_BYTES = 4096;

/** A notification still incomplete after this long is dropped: whatever sent it is gone. */
const KITTY_STALE_MS = 60_000;

/**
 * The answer to kitty's capability query with id `id`, or null for an id that
 * may not be echoed. No id, no `i` in the answer.
 */
export function kittyQueryReply(id = '') {
  if (id === '') return `\x1b]99;p=?;${KITTY_CAPABILITIES}\x1b\\`;
  if (typeof id !== 'string' || !KITTY_ID.test(id)) return null;
  return `\x1b]99;i=${id}:p=?;${KITTY_CAPABILITIES}\x1b\\`;
}

/** The longest metadata a chunk may carry. kitty's is a few dozen characters. */
const KITTY_MAX_METADATA = 1024;

/**
 * One OSC 99 payload taken apart: the `key=value` pairs before the first `;`,
 * separated by `:`, and everything after it. Keys are single letters; a pair
 * that is not one is skipped. Null for anything that is not a string, or
 * whose metadata runs past `KITTY_MAX_METADATA`.
 */
export function parseKittyChunk(data) {
  if (typeof data !== 'string') return null;
  const split = data.indexOf(';');
  const metadata = split === -1 ? data : data.slice(0, split);
  if (metadata.length > KITTY_MAX_METADATA) return null;
  const payload = split === -1 ? '' : data.slice(split + 1);
  const meta = {};
  for (const pair of metadata.split(':')) {
    const eq = pair.indexOf('=');
    if (eq !== 1) continue;
    meta[pair[0]] = pair.slice(2);
  }
  return { meta, payload };
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Base64 (standard, or URL-safe) as bytes, or null when it is not base64 at
 * all. `atob` itself skips whitespace and takes it with or without padding.
 */
function decodeBase64(text) {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The bytes a part holds, read as UTF-8 — once, at the end, so a character split across chunks survives. */
function decodePart(part) {
  const all = new Uint8Array(part.bytes);
  let at = 0;
  for (const chunk of part.chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return utf8Decoder.decode(all);
}

/**
 * kitty's notifications, assembled from their chunks: one per terminal.
 *
 * A notification arrives as chunks with the same `i`. `p` says what a chunk
 * carries — `title` (the default) or `body`; `e=1` that it is base64 of UTF-8;
 * `d=0` that more follows, and anything else that this was the last. On the
 * last, the notification is complete:
 *
 *   ESC]99;i=opentui-1:p=title:e=1:d=0;SGVsbG8gZnJvbSB0aGUgbW9jay4=ESC\
 *   ESC]99;i=opentui-1:p=body:e=1:d=1;U2Vzc2lvbiBkb25lESC\
 *
 * is "Hello from the mock." / "Session done" — exactly what OpenCode sent.
 * `o` (occasion) and `u` (urgency) may come on any chunk; the last one wins.
 * `p=?` is the capability query, answered with `KITTY_CAPABILITIES`;
 * `p=close` drops a notification still being assembled; `p=alive` is not
 * implemented, and not advertised. Any other type (an icon, buttons) is
 * skipped, though its `d` still completes the notification it belongs to.
 *
 * Bounded whatever arrives: at most 16 notifications held at once, 4 KB of
 * title and 4 KB of body each, and nothing held past a minute. An id that is
 * not an id, and anything else that does not parse, is not taken.
 */
export class KittyNotifications {
  constructor({ maxPending = KITTY_MAX_PENDING, maxPartBytes = KITTY_MAX_PART_BYTES, staleMs = KITTY_STALE_MS } = {}) {
    this._maxPending = maxPending;
    this._maxPartBytes = maxPartBytes;
    this._staleMs = staleMs;
    this._pending = new Map();
  }

  /** How many notifications are held, incomplete. */
  get pending() {
    return this._pending.size;
  }

  /**
   * Take one OSC 99 payload (what follows `99;`). Returns null when it is not
   * taken; otherwise an object with `reply` — the answer to send the program
   * — or `notification`, which is null when the completed notification has
   * nothing to show; or neither, for a chunk held until the rest arrives.
   */
  push(data, now = Date.now()) {
    const chunk = parseKittyChunk(data);
    if (!chunk) return null;
    const { meta, payload } = chunk;
    const id = meta.i ?? '';
    if (id !== '' && !KITTY_ID.test(id)) return null;
    const type = meta.p || 'title';

    if (type === '?') return { reply: kittyQueryReply(id) };
    if (type === 'alive') return null;

    this._dropStale(now);
    if (type === 'close') return this._pending.delete(id) ? {} : null;

    const content = type === 'title' || type === 'body';
    let entry = this._pending.get(id);
    if (!entry) {
      // An icon or a button belongs to a notification; on its own it is none.
      if (!content) return null;
      entry = this._open(id, now);
    }
    if (OCCASIONS.has(meta.o)) entry.occasion = meta.o;
    if (meta.u === '0' || meta.u === '1' || meta.u === '2') entry.urgency = Number(meta.u);
    if (content) this._append(entry[type], payload, meta.e === '1');
    if (meta.d === '0') return {};

    this._pending.delete(id);
    return { notification: makeNote(decodePart(entry.title), decodePart(entry.body), entry.occasion, entry.urgency) };
  }

  /** Forget everything held. */
  clear() {
    this._pending.clear();
  }

  _open(id, now) {
    // A Map keeps insertion order, so the first key is the oldest.
    while (this._pending.size >= this._maxPending) this._pending.delete(this._pending.keys().next().value);
    const entry = {
      openedAt: now,
      title: { chunks: [], bytes: 0 },
      body: { chunks: [], bytes: 0 },
      occasion: 'always',
      urgency: 1,
    };
    this._pending.set(id, entry);
    return entry;
  }

  _dropStale(now) {
    for (const [id, entry] of this._pending) {
      if (now - entry.openedAt > this._staleMs) this._pending.delete(id);
    }
  }

  /**
   * Add a chunk's payload to a title or body, up to its byte cap. Only as much
   * of a long payload is decoded as can still be kept — four base64
   * characters make three bytes — so a megabyte-long chunk costs nothing.
   * Base64 that does not decode adds nothing.
   */
  _append(part, payload, base64) {
    const room = this._maxPartBytes - part.bytes;
    if (room <= 0 || !payload) return;
    const bytes = base64
      ? decodeBase64(payload.slice(0, Math.ceil(room / 3) * 4))
      : utf8Encoder.encode(payload.slice(0, room));
    if (!bytes || bytes.length === 0) return;
    const kept = bytes.length > room ? bytes.subarray(0, room) : bytes;
    part.chunks.push(kept);
    part.bytes += kept.length;
  }
}

// ---- How often ----------------------------------------------------------------

/**
 * The rate limit for one terminal (see `RATE_LIMIT`). `allow(now)` says
 * whether a notification arriving at `now` may go through, and counts it if
 * it may. `now` must not run backwards — the addon reads a monotonic clock.
 */
export function createRateLimiter({ intervalMs = RATE_LIMIT.intervalMs, perMinute = RATE_LIMIT.perMinute } = {}) {
  const accepted = [];
  return {
    allow(now) {
      while (accepted.length > 0 && now - accepted[0] >= 60_000) accepted.shift();
      const last = accepted[accepted.length - 1];
      if (last !== undefined && now - last < intervalMs) return false;
      if (accepted.length >= perMinute) return false;
      accepted.push(now);
      return true;
    },
  };
}

// ---- Where one goes -----------------------------------------------------------

/**
 * Whether the NexTerm window has the keyboard (`focused`) and can be seen at
 * all (`visible`: not minimised or hidden), read from `doc`. With no document
 * to ask, neither: nobody is shown to be looking, so nothing is held back.
 */
export function windowAttention(doc = globalThis.document) {
  try {
    if (!doc) return { focused: false, visible: false };
    const focused = typeof doc.hasFocus === 'function' && doc.hasFocus() === true;
    const visible = focused || (doc.visibilityState ? doc.visibilityState === 'visible' : doc.hidden !== true);
    return { focused, visible };
  } catch {
    return { focused: false, visible: false };
  }
}

const NOWHERE = Object.freeze({ inApp: false, desktop: false });

/**
 * Where a program's notification goes: an entry in the bell (`inApp`), a
 * desktop notification (`desktop`), both, or neither.
 *
 *   - `activeTab`: its terminal is the active tab. With the window `focused`
 *     as well, that is the terminal being typed into, and someone watching a
 *     program does not need the bell to tell them what it said.
 *   - A desktop notification only while the window is not `focused`. In front
 *     of the window, the bell is where it goes.
 *   - The program's `occasion`, as kitty defines it: `unfocused` says nothing
 *     while its terminal is the one being typed into; `invisible` says
 *     nothing while its terminal is `onScreen` — shown in a pane of the group
 *     on screen, in a window that is not minimised — focused or not.
 *
 * So `unfocused` comes out the same as `always`: neither is shown about a
 * terminal being typed into.
 */
export function routeProgramNotification({ occasion = 'always', activeTab = false, onScreen = false, focused = false } = {}) {
  const typingInto = activeTab && focused;
  if (occasion === 'unfocused' && typingInto) return NOWHERE;
  if (occasion === 'invisible' && onScreen) return NOWHERE;
  return { inApp: !typingInto, desktop: !focused };
}

// ---- The addon ----------------------------------------------------------------

const monotonicClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The three handlers on one terminal, as an xterm addon so they are disposed
 * with it.
 *
 * Every handler is wrapped: one that throws wedges xterm's write queue for
 * good (see mouseReporting.js). Each returns true for a sequence it took,
 * false for one it did not — a ConEmu command, urxvt's other 777 commands, a
 * malformed kitty chunk, and everything while `enabled()` says no — and
 * xterm.js has nothing else for any of them, so a sequence not taken is
 * dropped as before. `enabled` is read as each sequence arrives, so turning
 * the setting off takes effect at once: no more notifications, and no more
 * answers to kitty's query. A notification past the rate limit is taken and
 * dropped.
 */
class ProgramNotificationsAddon {
  constructor({ onNotify, enabled, clock = monotonicClock, rateLimit = RATE_LIMIT } = {}) {
    this._onNotify = onNotify;
    this._enabled = enabled;
    this._clock = clock;
    this._limiter = createRateLimiter(rateLimit);
    this._kitty = new KittyNotifications();
    this._disposables = [];
  }

  activate(term) {
    const parser = term.parser;
    const guarded = (what, handler) => (data) => {
      try {
        if (!this._isEnabled()) return false;
        return handler(data) === true;
      } catch (err) {
        console.warn(`[Terminal] could not handle ${what}:`, err);
        return false;
      }
    };

    this._disposables.push(parser.registerOscHandler(9, guarded('OSC 9', (data) => this._deliver(parseOsc9(data)))));
    this._disposables.push(
      parser.registerOscHandler(777, guarded('OSC 777', (data) => this._deliver(parseOsc777(data))))
    );
    this._disposables.push(
      parser.registerOscHandler(
        99,
        guarded('OSC 99', (data) => {
          const result = this._kitty.push(data, this._clock());
          if (!result) return false;
          // Out the way xterm's own replies go, through `onData`, not as
          // typed input — as `installXtVersionReply` answers XTVERSION.
          if (result.reply) term.input(result.reply, false);
          if (result.notification) this._deliver(result.notification);
          return true;
        })
      )
    );
  }

  _isEnabled() {
    try {
      return typeof this._enabled === 'function' ? this._enabled() !== false : true;
    } catch {
      return false;
    }
  }

  /** Hand a notification on, if the rate limit lets it through. False when there was none. */
  _deliver(note) {
    if (!note) return false;
    if (this._limiter.allow(this._clock())) {
      try {
        this._onNotify?.(note);
      } catch (err) {
        console.warn('[Terminal] could not pass on a notification:', err);
      }
    }
    return true;
  }

  dispose() {
    this._kitty.clear();
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
 * Read program notifications on `term` from now on (see
 * `ProgramNotificationsAddon`): each one goes to `onNotify(note)` —
 * `{ title, body, occasion, urgency }`, cleaned — while `enabled()` is true.
 * `clock` and `rateLimit` are there for the tests. Returns the addon, or null
 * when `term` has no parser to listen to (a test double).
 */
export function installProgramNotifications(term, options = {}) {
  if (typeof term?.parser?.registerOscHandler !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new ProgramNotificationsAddon(options);
  term.loadAddon(addon);
  return addon;
}
