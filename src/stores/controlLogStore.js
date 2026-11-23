import { create } from 'zustand';

/**
 * What programs in terminals asked NexTerm to do through `nexterm-cli`
 * (stage 7, spec D6), for the palette's Show Control Log — and whether that
 * dialog is open.
 *
 * In memory only, the last LOG_LIMIT entries, newest last: nothing on disk
 * (spec Q6), so a call is gone with the window. Each entry is what the call
 * WAS, never what it carried — `{ at, caller, callerTitle, cmd, target,
 * targetTitle, size, lines, result, count }`: who asked, for what, of whom,
 * how many bytes typed or lines read, the answer's code, and how many such
 * calls in a row it stands for. Never the token (the page never holds one),
 * the text sent, or the screen read: the log is there to see what happened,
 * and must not become a second copy of a password typed into a terminal.
 * `record` keeps exactly those fields, so a caller handing it more cannot
 * widen it.
 *
 * Repeats (bundle 4, OQ2): a program polling `list` would push everything
 * else out of the log. A `list` with the same caller, target, amounts and
 * answer as the LAST entry is that entry again — its count goes up by one,
 * its time and titles become the new call's, its id stays — so it is one
 * entry toward LOG_LIMIT. Only `list` (MERGED): a `send`, `read-screen`,
 * `focus` or `new-split` is always an entry of its own, however alike, so
 * every one that acted on a terminal is there to see. `count` is the
 * store's own: whatever a caller hands in, a new entry counts 1.
 *
 * Its own store, not the terminal store's: the terminal store is read by
 * every pane and chip, and a call every 50 ms must not redraw them. Only the
 * dialog, while it is open, reads `entries`.
 */

/** How many entries the log keeps; the oldest goes first. */
export const LOG_LIMIT = 500;

/** The fields an entry keeps, and nothing else. */
const FIELDS = ['at', 'caller', 'callerTitle', 'cmd', 'target', 'targetTitle', 'size', 'lines', 'result', 'count'];

/** The only command whose repeats are one entry: it reads, it acts on nothing. */
const MERGED = new Set(['list']);

/** What must be the same for a call to be the last entry again — everything but the time and the titles. */
const SAME = ['caller', 'cmd', 'target', 'size', 'lines', 'result'];

/** An entry's count goes no higher; a repeat past it starts a new entry, so the calls still add up. */
export const COUNT_MAX = 1_000_000_000;

/** Short strings only: an id, a title, a command's name, a code. */
const shortText = (value, max = 80) => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
/** How many calls an entry stands for: a whole number from 1 to COUNT_MAX, 1 when it is anything else. */
const calls = (value) => (Number.isInteger(value) && value >= 1 ? Math.min(value, COUNT_MAX) : 1);

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
    count: calls(e.count),
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

  /**
   * Keep one call (`logEntry`'s fields only, counting 1): a repeated `list`
   * is the last entry again (MERGED), anything else a new entry, dropping
   * the oldest past LOG_LIMIT.
   */
  record: (entry) => {
    const kept = { ...logEntry(entry), count: 1 };
    set((s) => {
      const last = s.entries.at(-1);
      if (last && MERGED.has(kept.cmd) && SAME.every((key) => last[key] === kept[key]) && calls(last.count) < COUNT_MAX) {
        const entries = s.entries.slice();
        entries[entries.length - 1] = { ...last, at: kept.at, callerTitle: kept.callerTitle, targetTitle: kept.targetTitle, count: calls(last.count) + 1 };
        return { entries };
      }
      entrySeq += 1;
      const entries = s.entries.length >= LOG_LIMIT ? s.entries.slice(s.entries.length - LOG_LIMIT + 1) : s.entries.slice();
      entries.push({ id: entrySeq, ...kept });
      return { entries };
    });
  },

  clear: () => set({ entries: [] }),
  setOpen: (open) => set({ open: Boolean(open) }),
}));

export default useControlLogStore;
