import { useSyncExternalStore } from 'react';
import { minuteClock } from '../lib/minuteClock.js';

/**
 * The wall clock, read again once a minute (minuteClock.js), for a component
 * that shows how long something has lasted — or null, and nothing at all is
 * listened to, while `enabled` is false.
 *
 * A component that shows no time passes false and is never redrawn by the
 * clock: it subscribes to a subscription that does nothing, so the clock has
 * one subscriber fewer and, when nobody shows a time, no timer at all
 * (bundle 3, U5-F2). `clock` is the app's one by default; the suites hand in
 * their own.
 *
 * What is returned is read when the component draws, not when the minute
 * began: a line drawn for some other reason between two ticks shows the time
 * of that moment. The snapshot React compares is the minute's number, so the
 * tick redraws a subscriber once a minute and nothing else does.
 */
export function useMinuteNow(enabled, clock = minuteClock) {
  const source = minuteNowSource(enabled, clock);
  useSyncExternalStore(source.subscribe, source.getSnapshot, source.getServerSnapshot);
  return enabled ? clock.now() : null;
}

const NO_SUBSCRIPTION = () => {};
const IDLE = Object.freeze({
  subscribe: () => NO_SUBSCRIPTION,
  getSnapshot: () => null,
  getServerSnapshot: () => null,
});

/**
 * What `useMinuteNow` hands `useSyncExternalStore`: the clock's own functions
 * while `enabled`, otherwise fixed ones that subscribe to nothing and never
 * change. Each is the same function every time, so React never subscribes
 * again for a redraw. Exported for the suites.
 */
export function minuteNowSource(enabled, clock = minuteClock) {
  return enabled ? clock : IDLE;
}
