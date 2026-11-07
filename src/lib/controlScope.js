/**
 * What a control request may ask and whom it may touch (stage 7) — the
 * page's half of the rules; the backend has already checked the token, the
 * size and the rate (src-tauri/src/control/).
 *
 * The caller is the terminal whose token came with the request. It may act
 * on itself, on terminals it opened with `new-split` (its children: an agent
 * that opens a split to run something in it), and on any other terminal
 * only while Settings ▸ Terminal ▸ Control ▸ "Let programs control other
 * terminals" is on. Typing and reading (`send`, `read-screen`) need their
 * own setting even for the caller itself, and an unmasked read needs the
 * other-terminals one as well: it hands out whatever secrets the screen holds.
 *
 * Arguments are someone else's input: every command takes exactly the keys
 * it names, of the types it names, within limits, and anything else is
 * `bad_request` — a typo must not be silently ignored, and an unknown key
 * must not reach the store.
 */
import { TAB_ID_PATTERN } from './scrollbackSnapshot.js';

/** The error codes, shared with the backend and the CLI. */
export const CONTROL_ERROR = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNKNOWN_COMMAND: 'unknown_command',
  UNAUTHORIZED: 'unauthorized',
  DISABLED: 'disabled',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  REFUSED: 'refused',
  RATE_LIMITED: 'rate_limited',
  NOT_RENDERED: 'not_rendered',
  NOT_RESPONDING: 'not_responding',
  TOO_LARGE: 'too_large',
  INTERNAL: 'internal',
});

/** How long a status line may be once cleaned, in characters. */
export const STATUS_MAX = 80;
/** The most lines `read-screen` returns. */
export const READ_LINES_MAX = 2000;

const fail = (code, message) => ({ error: { code, message } });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A target: `self`, a tab id, or `child:<tab id>`. */
function validTarget(value) {
  if (value === undefined || value === 'self') return true;
  if (typeof value !== 'string') return false;
  const id = value.startsWith('child:') ? value.slice(6) : value;
  return TAB_ID_PATTERN.test(id);
}

const str = (max, { required = false, nonEmpty = required } = {}) => (v) => {
  if (v === undefined) return required ? 'is required' : null;
  if (typeof v !== 'string') return 'must be a string';
  if (nonEmpty && v.length === 0) return 'must not be empty';
  if (v.length > max) return `must be at most ${max} characters`;
  if (!v.isWellFormed()) return 'holds a broken character';
  return null;
};
const oneOf = (values, { required = false } = {}) => (v) => {
  if (v === undefined) return required ? 'is required' : null;
  return values.includes(v) ? null : `must be one of ${values.join(', ')}`;
};
const bool = () => (v) => (v === undefined || typeof v === 'boolean' ? null : 'must be true or false');
const int = (min, max) => (v) => {
  if (v === undefined) return null;
  return Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`;
};
const target = () => (v) => (validTarget(v) ? null : 'must be self, a tab id or child:<tab id>');

/** Each command's arguments and their checks. */
const SCHEMAS = {
  notify: { title: str(200, { required: true }), body: str(2000), occasion: oneOf(['always', 'unfocused', 'invisible']) },
  'set-status': {
    text: (v) => (v === null ? null : str(500, { required: true, nonEmpty: true })(v)),
    tone: oneOf(['info', 'warn', 'error']),
  },
  'set-progress': { state: oneOf(['normal', 'indeterminate', 'error', 'warning', 'remove'], { required: true }), value: int(0, 100) },
  list: {},
  'new-split': { direction: oneOf(['right', 'down']), cwd: str(4096, { nonEmpty: true }), command: str(2000, { nonEmpty: true }) },
  send: {
    target: target(),
    text: str(16 * 1024, { nonEmpty: true }),
    keys: (v) => (v === undefined || (Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every((k) => typeof k === 'string')) ? null : 'must be a list of 1 to 64 key names'),
    raw: bool(),
  },
  'read-screen': { target: target(), lines: int(0, READ_LINES_MAX), mask: bool() },
  focus: { target: target() },
};

/** The commands there are. */
export const COMMANDS = Object.freeze(Object.keys(SCHEMAS));

/** Commands that type into or read a terminal: they need "Let programs type into and read terminals". */
export function needsTypeAndRead(cmd) {
  return cmd === 'send' || cmd === 'read-screen';
}

/**
 * `{ cmd, args }` checked — exactly the keys the command names, each of its
 * type and within its limits — or `{ error }`.
 */
export function validateRequest(cmd, args) {
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, cmd)) {
    return fail(CONTROL_ERROR.UNKNOWN_COMMAND, `unknown command "${String(cmd).slice(0, 40)}"`);
  }
  const given = args === undefined || args === null ? {} : args;
  if (!isPlainObject(given)) return fail(CONTROL_ERROR.BAD_REQUEST, 'args must be an object');
  const schema = SCHEMAS[cmd];
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return fail(CONTROL_ERROR.BAD_REQUEST, `${cmd} takes no "${key.slice(0, 40)}"`);
    }
  }
  for (const [key, check] of Object.entries(schema)) {
    const problem = check(given[key]);
    if (problem) return fail(CONTROL_ERROR.BAD_REQUEST, `${cmd}: ${key} ${problem}`);
  }
  if (cmd === 'send' && given.text === undefined && given.keys === undefined) {
    return fail(CONTROL_ERROR.BAD_REQUEST, 'send needs text or keys');
  }
  if (cmd === 'set-status' && !Object.prototype.hasOwnProperty.call(given, 'text')) {
    return fail(CONTROL_ERROR.BAD_REQUEST, 'set-status: text is required (null clears it)');
  }
  return { cmd, args: { ...given } };
}

/**
 * Whether the settings let `cmd` with `args` through at all, or `{ error }`:
 * typing and reading need their setting, an unmasked read the
 * other-terminals one too.
 */
export function checkPolicy(cmd, args, { typeAndRead = false, otherTerminals = false } = {}) {
  if (needsTypeAndRead(cmd) && !typeAndRead) {
    return fail(CONTROL_ERROR.DISABLED, 'typing into and reading terminals is off (Settings ▸ Terminal ▸ Control)');
  }
  // A split with a command types that command and presses Enter in a fresh
  // shell of the user's — the same power as send, so the same setting (found
  // in review: `new-split -- curl … | sh` ran with typing switched off). A
  // split without one stays on by default.
  if (cmd === 'new-split' && args?.command !== undefined && !typeAndRead) {
    return fail(CONTROL_ERROR.DISABLED, 'a command for the new split is typing — "Let programs type into and read terminals" is off (Settings ▸ Terminal ▸ Control)');
  }
  if (cmd === 'read-screen' && args?.mask === false && !otherTerminals) {
    return fail(CONTROL_ERROR.FORBIDDEN, 'an unmasked read needs "Let programs control other terminals" on');
  }
  return null;
}

/**
 * The tab a request acts on: `{ tabId, self }` or `{ error }`.
 *
 * `tabs` — the store's tabs; `children` — Map of a caller's tab id to the
 * Set of tabs it opened with `new-split`; `otherTerminals` — the setting.
 */
export function resolveTarget({ tabs, callerTabId, target: wanted = 'self', children = new Map(), otherTerminals = false }) {
  const exists = (id) => Array.isArray(tabs) && tabs.some((t) => t.id === id);
  if (!callerTabId || !exists(callerTabId)) return fail(CONTROL_ERROR.UNAUTHORIZED, 'the calling terminal is gone');
  if (wanted === undefined || wanted === 'self' || wanted === callerTabId) return { tabId: callerTabId, self: true };
  if (!validTarget(wanted)) return fail(CONTROL_ERROR.BAD_REQUEST, 'target must be self, a tab id or child:<tab id>');
  const asChild = wanted.startsWith('child:');
  const id = asChild ? wanted.slice(6) : wanted;
  if (id === callerTabId) return { tabId: callerTabId, self: true };
  const mine = children.get(callerTabId);
  const isChild = Boolean(mine && mine.has(id));
  if (asChild && !isChild) return fail(CONTROL_ERROR.FORBIDDEN, `${id} was not opened by this terminal`);
  if (!isChild && !otherTerminals) {
    return fail(CONTROL_ERROR.FORBIDDEN, 'controlling other terminals is off (Settings ▸ Terminal ▸ Control)');
  }
  if (!exists(id)) return fail(CONTROL_ERROR.NOT_FOUND, `no terminal ${id}`);
  return { tabId: id, self: false };
}

/** Characters dropped from a status line: controls, format characters (bidi, zero-width), line separators. */
const DROPPED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A status line as the side bar shows it: someone else's text with controls,
 * direction and invisible characters removed (stage 5's rule for names on
 * screen), runs of white space made one, and cut to STATUS_MAX characters
 * with an ellipsis — never inside a character.
 */
export function cleanStatusText(text) {
  if (typeof text !== 'string') return '';
  // White space first: tab, CR and LF are controls too, and dropping them
  // would glue the words on either side together.
  const flat = text.replace(/\s+/g, ' ').replace(DROPPED, '').replace(/ {2,}/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= STATUS_MAX) return flat;
  return `${chars.slice(0, STATUS_MAX - 1).join('').trimEnd()}\u{2026}`;
}
