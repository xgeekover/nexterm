import { create } from 'zustand';

/**
 * Short feedback for an action that leaves nothing else on screen (bundle 3,
 * U6): "Path copied" after a copy, say, which changes nothing the user can
 * see. ToastHost (src/components/common/ToastHost.jsx) draws these over the
 * bottom right corner of the window, beside the corner notices.
 *
 * - A confirmation ('confirm') goes by itself after TOAST_MS. An error
 *   ('error') stays until it is dismissed: an error that went while the user
 *   looked elsewhere would never have been said.
 * - At most MAX_TOASTS are up, oldest first in `toasts` (drawn newest at the
 *   bottom); a further one drops the oldest.
 * - A text already up is not shown twice: the new toast replaces the older
 *   one (a new id, at the bottom) and a confirmation's TOAST_MS starts again,
 *   so copying twice reads as one "Path copied" that stays its full time.
 * - Every toast that goes, by its timer, by `dismiss`, by being replaced or
 *   dropped, has its timer cleared with it.
 *
 * The timer functions are the global ones, looked up when used; the suites
 * hand in their own (`setToastTimers`) and put everything back with
 * `resetToasts`, so no real timer is left running behind a test.
 */

/** How long a confirmation stays up, in ms. index.css fades it out over its last 150 ms. */
export const TOAST_MS = 3000;

/** How many toasts are up at most. */
export const MAX_TOASTS = 3;

const GLOBAL_TIMERS = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

let timers = GLOBAL_TIMERS;
/** The timer of each confirmation still up, by toast id. */
const pending = new Map();
let seq = 0;

function stopTimer(id) {
  if (!pending.has(id)) return;
  timers.clearTimeout(pending.get(id));
  pending.delete(id);
}

export const useToastStore = create((set, get) => ({
  /** [{ id, kind: 'confirm' | 'error', text }], oldest first. */
  toasts: [],

  /**
   * Show `text` as a confirmation (the default) or, with kind 'error', as an
   * error that stays. Returns the new toast's id, or null for an empty text
   * (nothing is shown).
   */
  show: ({ kind = 'confirm', text } = {}) => {
    const words = String(text ?? '').trim();
    if (!words) return null;
    const toast = { id: (seq += 1), kind: kind === 'error' ? 'error' : 'confirm', text: words };
    const kept = [];
    for (const t of get().toasts) {
      if (t.text === words) stopTimer(t.id);
      else kept.push(t);
    }
    kept.push(toast);
    while (kept.length > MAX_TOASTS) stopTimer(kept.shift().id);
    if (toast.kind === 'confirm') {
      pending.set(
        toast.id,
        timers.setTimeout(() => {
          pending.delete(toast.id);
          get().dismiss(toast.id);
        }, TOAST_MS)
      );
    }
    set({ toasts: kept });
    return toast.id;
  },

  /** Take the toast `id` down (a click on its Dismiss, or its timer). */
  dismiss: (id) => {
    stopTimer(id);
    const toasts = get().toasts;
    if (toasts.some((t) => t.id === id)) set({ toasts: toasts.filter((t) => t.id !== id) });
  },
}));

/**
 * For the suites: use `next` ({ setTimeout, clearTimeout }) for the timers
 * from now on, or the global ones again with no argument. Returns a function
 * that puts back the timers used before.
 */
export function setToastTimers(next) {
  const before = timers;
  timers = next ?? GLOBAL_TIMERS;
  return () => {
    timers = before;
  };
}

/** For the suites: every toast down, every timer cleared, the global timers back. */
export function resetToasts() {
  for (const id of [...pending.keys()]) stopTimer(id);
  timers = GLOBAL_TIMERS;
  useToastStore.setState({ toasts: [] });
}
