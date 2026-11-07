import { create } from 'zustand';

/**
 * What programs in terminals asked NexTerm to do through `nexterm-cli`
 * (stage 7, spec D6), for the palette's Show Control Log — and whether that
 * dialog is open.
 *
 * In memory only, the last LOG_LIMIT calls, newest last: nothing on disk
 * (spec Q6), so a call is gone with the window. Each entry is what the call
 * WAS, never what it carried — `{ at, caller, callerTitle, cmd, target,
 * targetTitle, size, lines, result }`: who asked, for what, of whom, how
 * many bytes typed or lines read, and the answer's code. Never the token
 * (the page never holds one), the text sent, or the screen read: the log is
 * there to see what happened, and must not become a second copy of a
 * password typed into a terminal. `record` keeps exactly those fields, so a
 * caller handing it more cannot widen it.
 *
 * Its own store, not the terminal store's: the terminal store is read by
 * every pane and chip, and a call every 50 ms must not redraw them. Only the
 * dialog, while it is open, reads `entries`.
 */

/** How many calls the log keeps; the oldest goes first. */
export const LOG_LIMIT = 500;

/** The fields an entry keeps, and nothing else. */
const FIELDS = ['at', 'caller', 'callerTitle', 'cmd', 'target', 'targetTitle', 'size', 'lines', 'result'];

/** Short strings only: an id, a title, a command's name, a code. */
const shortText = (value, max = 80) => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** `entry` cut down to what the log may keep. */
export function logEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const kept = {
    at: count(e.at) ?? Date.now(),
    caller: shortText(e.caller, 40),
    callerTitle: shortText(e.callerTitle),
    cmd: shortText(e.cmd, 24),
    target: shortText(e.target, 40),
    targetTitle: shortText(e.targetTitle),
    size: count(e.size),
    lines: count(e.lines),
    result: shortText(e.result, 24),
  };
  // Stated once more, so a field added above without thought fails here.
  return Object.fromEntries(FIELDS.map((key) => [key, kept[key]]));
}

let entrySeq = 0;

export const useControlLogStore = create((set) => ({
  /** The calls, oldest first, each with an `id` for the list's keys. */
  entries: [],
  /** Whether Show Control Log's dialog is open. */
  open: false,

  /** Keep one call (`logEntry`'s fields only), dropping the oldest past LOG_LIMIT. */
  record: (entry) => {
    entrySeq += 1;
    const kept = { id: entrySeq, ...logEntry(entry) };
    set((s) => {
      const entries = s.entries.length >= LOG_LIMIT ? s.entries.slice(s.entries.length - LOG_LIMIT + 1) : s.entries.slice();
      entries.push(kept);
      return { entries };
    });
  },

  clear: () => set({ entries: [] }),
  setOpen: (open) => set({ open: Boolean(open) }),
}));

export default useControlLogStore;
