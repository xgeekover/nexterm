/**
 * One clock for everything that shows how many minutes something has lasted
 * (bundle 3, U5-F2): the TERMINALS rows' "Working 3m", "Idle 12m".
 *
 * One timer, whatever the number of subscribers, set for the next minute of
 * the wall clock (hh:mm:00), so every row that shows a time moves on at the
 * same moment rather than each on its own schedule; and no timer at all while
 * nobody subscribes. It ticks once a minute and never more often: a time is
 * shown in whole minutes (`elapsedLabel`, terminalStatus.js), and redrawing a
 * row every second to show the same text would be cost with nothing to show
 * for it.
 *
 * Shaped for React's `useSyncExternalStore` (useMinuteNow.js): `subscribe`
 * and `getSnapshot` are fixed functions, and the snapshot is the number of
 * the current minute — the same number however often it is read within one,
 * so a render never sees it change under it, and a new one only at a minute's
 * boundary. Subscribers are counted one per `subscribe` call, the same
 * function twice counting twice, and each unsubscribe counts once however
 * often it is called.
 *
 * Pure apart from the timer: the clock and the timer functions are handed
 * in, so the suites drive time themselves.
 */

export const MINUTE_MS = 60 * 1000;

/** The number of the minute `t` (ms on the wall clock) falls in. */
const minuteOf = (t) => Math.floor(t / MINUTE_MS);

/** How long from `t` to the start of the next minute: (0, MINUTE_MS]. */
export function msToNextMinute(t) {
  const into = ((t % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  return MINUTE_MS - into;
}

/**
 * A minute clock. `now` reads the wall clock (`Date.now` by default);
 * `setTimeout` and `clearTimeout` are the timer's (the global ones by
 * default, looked up when used). Returns `{ subscribe, getSnapshot,
 * getServerSnapshot, now }`.
 */
export function createMinuteClock({ now = () => Date.now(), setTimeout: set, clearTimeout: clear } = {}) {
  const setTimer = set ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = clear ?? ((id) => globalThis.clearTimeout(id));
  const subscribers = new Set();
  let timer = null;
  let shown = null;

  function schedule() {
    timer = setTimer(tick, msToNextMinute(now()));
  }

  function tick() {
    timer = null;
    const minute = minuteOf(now());
    // Set again before anyone hears of it, so that a subscriber leaving
    // while it is told — the last one — stops the clock it just set.
    if (subscribers.size > 0) schedule();
    // A timer that came early (the wall clock was set back, a timer's
    // rounding) told of no new minute: it is set again for the real one.
    if (minute === shown) return;
    shown = minute;
    for (const entry of [...subscribers]) if (subscribers.has(entry)) entry.listener();
  }

  function subscribe(listener) {
    const entry = { listener };
    subscribers.add(entry);
    if (timer === null) {
      shown = minuteOf(now());
      schedule();
    }
    return () => {
      if (!subscribers.delete(entry)) return;
      if (subscribers.size === 0 && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    };
  }

  const getSnapshot = () => minuteOf(now());

  return Object.freeze({
    subscribe,
    getSnapshot,
    // The server render (and the render suite's `renderToString`) reads the
    // same clock: there is nothing else to read, and no subscriber there.
    getServerSnapshot: getSnapshot,
    now: () => now(),
  });
}

/** The app's minute clock: every line that shows a time listens to this one. */
export const minuteClock = createMinuteClock();
