/**
 * How far along a program in a terminal says it is — winget installing,
 * Claude Code working — read off the terminal's output, and what that adds up
 * to on a tab chip, a group chip and, on Windows, the taskbar.
 *
 * The sequence is ConEmu's, which Windows Terminal adopted:
 *
 *   ESC ] 9 ; 4 ; st [ ; pr ] ST
 *
 *   st  0 remove the bar
 *       1 normal, at pr percent
 *       2 error
 *       3 indeterminate (busy, no amount)
 *       4 warning — "paused" to the taskbar
 *
 * xterm.js 6.0 drops it, and so did NexTerm: OSC 9 is also iTerm2's message
 * channel, and `parseOsc9` in programNotifications.js refuses every ConEmu
 * sub-command so that a progress report is never read as a notification. That
 * refusal stays. This module has its own OSC 9 handler beside that one, which
 * takes `4;…` and nothing else; anything it does not take goes on to the
 * notification handler, exactly as before.
 *
 * Program output is not trusted: whatever a program prints — or a file
 * someone `cat`s — reaches the handler. So a payload is looked at only when it
 * is short (`PROGRESS_PAYLOAD_MAX`), only ASCII digits count as numbers, a
 * state outside 0–4 is not taken, a percentage past 100 is held at 100, and
 * nothing is ever written back to the program. A tab updates at most ten
 * times a second however fast a program reports (`PROGRESS_INTERVAL_MS`, in
 * terminalStore's `setTabProgress`), and the taskbar four times
 * (`TASKBAR_INTERVAL_MS`).
 *
 * Four parts:
 *
 *   - pure parsing: `parseProgress`, and `nextProgress`, the bar a report
 *     leaves given the one before it;
 *   - what several bars add up to, also pure: `aggregateProgress` (a group
 *     chip) and `taskbarProgress` (the whole window);
 *   - pacing: `createLatestThrottle`, and `createTaskbarDriver`, which keeps
 *     the taskbar told without telling it twice or too often;
 *   - `installTerminalProgress`, an xterm addon (disposed with its terminal).
 *
 * No xterm, no store: everything here can be checked in Node.
 */

/**
 * The longest payload looked at, in characters: `4;1;100` is seven, and a
 * generous number of leading zeros still fits. Anything longer is not taken.
 */
export const PROGRESS_PAYLOAD_MAX = 32;

/** A tab's bar changes at most this often: ten times a second. */
export const PROGRESS_INTERVAL_MS = 100;

/** The taskbar is told at most this often: four times a second. */
export const TASKBAR_INTERVAL_MS = 250;

/**
 * What each `st` means, by its number. 'remove' is a request, never a bar;
 * the other four are what a tab's bar can be.
 */
const STATES = Object.freeze(['remove', 'normal', 'error', 'indeterminate', 'warning']);

/**
 * `4;st`, optionally `;pr`, digits only. `pr` may be empty — Claude Code ends
 * its bar with `9;4;0;` — and is then missing. Anything more, a sign, a
 * space or a fraction anywhere, and the whole sequence is not taken.
 */
const PAYLOAD = /^4;([0-9]+)(?:;([0-9]*))?$/;

/**
 * An OSC 9 payload — what follows `9;` — as a progress report, or null when
 * it is not one this takes:
 *
 *   { state: 'remove' | 'normal' | 'error' | 'indeterminate' | 'warning',
 *     value: 0–100, or null when no percentage came with it }
 *
 * Leading zeros are fine (`4;01;007` is normal at 7). A percentage over 100
 * is 100. An indeterminate bar has no amount, and a removal none either, so
 * whatever percentage came with those is dropped.
 */
export function parseProgress(payload) {
  if (typeof payload !== 'string' || payload.length > PROGRESS_PAYLOAD_MAX) return null;
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const st = Number(match[1]);
  if (!Number.isInteger(st) || st < 0 || st >= STATES.length) return null;
  const state = STATES[st];
  const given = match[2] === undefined || match[2] === '' ? null : Math.min(100, Number(match[2]));
  const value = state === 'remove' || state === 'indeterminate' ? null : given;
  return { state, value };
}

/**
 * The bar a report leaves, given the bar before it (`previous`, null for
 * none): null when there is no bar.
 *
 * A missing percentage means 0 for a normal bar — which is what Windows
 * Terminal does — and, for an error or a warning, whatever the bar showed
 * before: a build that fails at 60% stays at 60%, in red. With nothing
 * before, it is null, which is drawn as a full bar. An indeterminate bar has
 * no amount at all.
 */
export function nextProgress(previous, update) {
  const before = previous ?? null;
  switch (update?.state) {
    case 'remove':
      return null;
    case 'normal':
      return { state: 'normal', value: update.value ?? 0 };
    case 'indeterminate':
      return { state: 'indeterminate', value: null };
    case 'error':
    case 'warning':
      return { state: update.state, value: update.value ?? before?.value ?? null };
    default:
      return before;
  }
}

/** Whether two bars (or two absences of one) look the same. */
export function sameProgress(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return x.state === y.state && (x.value ?? null) === (y.value ?? null);
}

/**
 * Which bar wins when several are shown as one: an error over a warning, a
 * warning over a normal bar, and a normal bar over an indeterminate one. What
 * needs the user most comes first, and a bar with an amount says more than
 * one without.
 */
const RANK = Object.freeze({ error: 4, warning: 3, normal: 2, indeterminate: 1 });

/** The lower of two amounts, where null — a full bar — counts as 100. Null only when both are. */
function lower(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Several bars as one — a group chip's, or the taskbar's — or null when none
 * of them is a bar: the winning state (`RANK`), at the LOWEST amount among
 * the bars in that state. Two builds at 30% and 80% are, together, 30% done.
 */
export function aggregateProgress(bars) {
  let best = null;
  for (const bar of bars || []) {
    if (!bar || !Object.prototype.hasOwnProperty.call(RANK, bar.state)) continue;
    if (!best || RANK[bar.state] > RANK[best.state]) {
      best = { state: bar.state, value: bar.state === 'indeterminate' ? null : bar.value ?? null };
    } else if (bar.state === best.state && bar.state !== 'indeterminate') {
      best = { state: best.state, value: lower(best.value, bar.value) };
    }
  }
  return best;
}

/** The bar of a group: its tabs' bars (`progress` is the store's map), as one. */
export function groupProgress(progress, tabIds) {
  if (!progress || !Array.isArray(tabIds)) return null;
  return aggregateProgress(tabIds.map((id) => progress[id]));
}

/** What the backend's `set_taskbar_progress` takes for `status`, every one of them. */
export const TASKBAR_STATUSES = Object.freeze(['none', 'normal', 'indeterminate', 'paused', 'error']);

/** A tab's state, as the taskbar names it. */
const TASKBAR_STATUS_OF = Object.freeze({
  error: 'error',
  warning: 'paused',
  normal: 'normal',
  indeterminate: 'indeterminate',
});

/** No bar on the taskbar. */
const NO_BAR = Object.freeze({ status: 'none', progress: null });

/**
 * The whole window's bar, from every tab's (`progress`, the store's map):
 * `{ status, progress }` as `set_taskbar_progress` takes them.
 *
 * The rule is `aggregateProgress`'s. `progress` is a whole percentage, or
 * null where the taskbar must not be given one: no bar, or an indeterminate
 * one — Windows turns an indeterminate bar back into a normal one the moment
 * it is handed an amount. An error or a warning with no amount is a full bar,
 * so it is 100.
 */
export function taskbarProgress(progress) {
  const bar = aggregateProgress(Object.values(progress || {}));
  if (!bar) return NO_BAR;
  if (bar.state === 'indeterminate') return { status: 'indeterminate', progress: null };
  return { status: TASKBAR_STATUS_OF[bar.state], progress: Math.round(bar.value ?? 100) };
}

// ---- Pacing -------------------------------------------------------------------

const monotonicClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * At most one `deliver` per `intervalMs`, the latest value winning.
 *
 * `push(value)` delivers at once when nothing has gone out for `intervalMs`;
 * otherwise the value is held, replacing any value already held, and goes
 * out when the interval is up. So a program reporting a thousand times a
 * second costs ten updates, and the last of them is the last thing it said.
 * `holding` and `held` say what is waiting; `cancel()` drops it.
 *
 * `now`, `setTimer` and `clearTimer` are there for the tests.
 */
export function createLatestThrottle({
  intervalMs,
  deliver,
  now = monotonicClock,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let lastAt = -Infinity;
  let timer = null;
  let holding = false;
  let held;

  const send = (value) => {
    lastAt = now();
    try {
      deliver?.(value);
    } catch (err) {
      console.warn('[Progress] could not deliver an update:', err);
    }
  };

  const flush = () => {
    timer = null;
    if (!holding) return;
    const value = held;
    holding = false;
    held = undefined;
    send(value);
  };

  return {
    push(value) {
      if (timer === null && now() - lastAt >= intervalMs) {
        send(value);
        return 'sent';
      }
      held = value;
      holding = true;
      if (timer === null) timer = setTimer(flush, Math.max(0, lastAt + intervalMs - now()));
      return 'held';
    },
    get holding() {
      return holding;
    },
    get held() {
      return held;
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      holding = false;
      held = undefined;
    },
  };
}

/** How long a refused taskbar update waits before it is tried once more. */
export const TASKBAR_RETRY_MS = 1000;

/**
 * Keeps the taskbar showing `taskbarProgress` of the store's map, through
 * `send({ status, progress })` — `set_taskbar_progress`, which may return a
 * promise, and may reject or throw.
 *
 * Call `update(progress, enabled)` whenever the map or the setting changes.
 * The same bar is never sent twice in a row, whether it changed back while
 * held or never changed at all, and the taskbar is told at most four times a
 * second, the latest bar winning. With the setting off the bar is 'none'.
 *
 * Nothing is sent until a bar is: the taskbar starts with none, so 'none'
 * goes only to take down a bar this run has shown. On Windows each call
 * makes the taskbar's COM object anew (tao 0.35), and a window where nothing
 * reports progress has no business calling at all.
 *
 * A send that is refused leaves the taskbar showing who knows what, so it is
 * forgotten — the next bar goes whatever it is — and tried once more after
 * TASKBAR_RETRY_MS, with the bar wanted THEN rather than the one refused. A
 * retry that is refused is left at that: the next change tries again.
 *
 * `dispose()` stops, and takes a bar it left standing down. After that the
 * driver says nothing more and arms nothing — not even when a send it made
 * earlier is refused later: a retry from a driver that is gone would speak
 * over the one that replaced it (a hot reload, the app remounted).
 */
export function createTaskbarDriver({ send, intervalMs = TASKBAR_INTERVAL_MS, retryMs = TASKBAR_RETRY_MS, ...clock } = {}) {
  const setTimer = clock.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = clock.clearTimer ?? ((id) => clearTimeout(id));
  const keyOf = (bar) => `${bar.status}:${bar.progress ?? ''}`;
  const NONE = keyOf(NO_BAR);
  // What the taskbar shows, as far as this run knows: no bar, at launch;
  // null once a send was refused.
  let shown = NONE;
  // The bar the terminals add up to now.
  let wanted = NO_BAR;
  let retryTimer = null;
  let disposed = false;

  const attempt = (bar, isRetry) => {
    const key = keyOf(bar);
    if (disposed || key === shown) return;
    shown = key;
    let result;
    try {
      result = send?.(bar);
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result).catch(() => {
      if (shown === key) shown = null;
      if (disposed || isRetry || retryTimer !== null) return;
      retryTimer = setTimer(() => {
        retryTimer = null;
        attempt(wanted, true);
      }, retryMs);
    });
  };

  const throttle = createLatestThrottle({ intervalMs, deliver: (bar) => attempt(bar, false), ...clock });
  return {
    update(progress, enabled = true) {
      if (disposed) return;
      wanted = enabled ? taskbarProgress(progress) : NO_BAR;
      // Unchanged and nothing else waiting: there is nothing to do, and a
      // timer started for it would only run to send nothing.
      if (!throttle.holding && keyOf(wanted) === shown) return;
      throttle.push(wanted);
    },
    dispose() {
      if (disposed) return;
      throttle.cancel();
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      wanted = NO_BAR;
      // Its last word, refused or not, is final: a retry it would arm is not.
      if (shown !== NONE) attempt(NO_BAR, true);
      disposed = true;
    },
  };
}

// ---- The addon ----------------------------------------------------------------

/**
 * The OSC 9 handler on one terminal, as an xterm addon so it is disposed with
 * it.
 *
 * It takes a `4;…` progress report — returning true, so xterm looks no
 * further — and returns false for everything else: an iTerm2 message, ConEmu's
 * other sub-commands, a malformed report, and everything while `enabled()`
 * says no. A sequence it does not take goes on to the notification handler
 * (`installProgramNotifications`), which refuses every ConEmu sub-command, so
 * a malformed report is dropped as before rather than shown as a message.
 * `enabled` is read as each sequence arrives.
 *
 * Wrapped whole: a handler that throws wedges xterm's write queue for good
 * (see mouseReporting.js), and `onProgress` is the store's.
 */
class TerminalProgressAddon {
  constructor({ onProgress, enabled } = {}) {
    this._onProgress = onProgress;
    this._enabled = enabled;
    this._disposables = [];
  }

  activate(term) {
    this._disposables.push(
      term.parser.registerOscHandler(9, (data) => {
        try {
          if (!this._isEnabled()) return false;
          const report = parseProgress(data);
          if (!report) return false;
          try {
            this._onProgress?.(report);
          } catch (err) {
            console.warn('[Terminal] could not pass on a progress report:', err);
          }
          return true;
        } catch (err) {
          console.warn('[Terminal] could not handle OSC 9;4:', err);
          return false;
        }
      })
    );
  }

  _isEnabled() {
    try {
      return typeof this._enabled === 'function' ? this._enabled() !== false : true;
    } catch {
      return false;
    }
  }

  dispose() {
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
 * Read progress reports on `term` from now on (see `TerminalProgressAddon`):
 * each one goes to `onProgress(report)` — `parseProgress`'s shape — while
 * `enabled()` is true. Returns the addon, or null when `term` has no parser
 * to listen to (a test double).
 */
export function installTerminalProgress(term, options = {}) {
  if (typeof term?.parser?.registerOscHandler !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new TerminalProgressAddon(options);
  term.loadAddon(addon);
  return addon;
}
