/**
 * What a restored terminal shows before its new shell (stage 6, spec D7):
 * the output it had when NexTerm last closed, under a dim "Previous output"
 * line.
 *
 * The registry calls `restoreScrollback` once, when the xterm of a tab the
 * start brought back is made, and attaches the shell's output only once it
 * has settled — so the shell's first prompt, and everything it printed
 * while the file was read, comes after the restored text, never inside it.
 * The output bus keeps all of it meanwhile (ptyOutputBus.js), and keys still
 * go to the shell.
 *
 * Whatever goes wrong — no file, a file that is not ours, a backend that
 * does not answer, a terminal that throws — nothing is restored and the
 * promise still resolves: a restore that fails must never cost the terminal
 * its shell's output.
 *
 * Pure apart from what it is handed, so the suites drive it with a headless
 * xterm and the real output bus.
 */
import { parseSnapshot, restoreText } from './scrollbackSnapshot.js';

/**
 * How long the file may take to arrive before the terminal goes on without
 * it. Five seconds, not two: a cold disk, an antivirus scan of a 2 MiB file,
 * a busy machine starting four restored terminals at once. One that takes
 * longer is not taken for "no file" (`keepFile`).
 */
export const RESTORE_READ_WAIT_MS = 5000;
/** How long the restore waits for the pane to give the terminal its size. */
export const RESTORE_FIT_WAIT_MS = 500;
/**
 * How long the restored text may take to be parsed before dirty tracking is
 * on again. Only that: the shell's output, written after, is behind it in
 * xterm's own write queue whatever this does.
 */
export const RESTORE_PARSE_WAIT_MS = 5000;

/** What a read that timed out, rejected or threw answers — not null, which is "no file". */
const UNREAD = Symbol('unread');

/** `promise`'s value, or `fallback` once `ms` have passed or when it rejects. */
function within(promise, ms, fallback, { setTimer, clearTimer }) {
  return new Promise((resolve) => {
    const timer = setTimer(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimer(timer);
        resolve(value);
      },
      () => {
        clearTimer(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * Write `tabId`'s saved output into `term`.
 *
 *   read(tabId)        the file's text, or null when there is none — the
 *                      saver's read, which goes straight to the backend
 *                      rather than wait behind other tabs' writes; it rejects
 *                      when the read failed
 *   waitForFit()       resolves once the pane has given the terminal its size;
 *                      the push into the scrollback is a screen's worth of rows,
 *                      and the text wraps at the width it is written at
 *   history            the terminal's `createHistoryMark()`: written as history,
 *                      so no bell, progress bar or message in it could ever be
 *                      taken as news (none survive the filter anyway)
 *   quiet(on)          dirty tracking off while this is parsed: what is
 *                      restored is not a change to save again
 *   pushIntoScrollback Windows (ConPTY) — see `restoreText`
 *   keepFile(tabId)    a read that timed out or failed: the file may be fine
 *                      and only slow, so it is left alone this session
 *                      (the saver's `keepFile`) rather than overwritten by
 *                      the new shell's output a second later; null — no file
 *                      — and a file that is not ours are answers, and change
 *                      nothing
 *
 * Resolves `{ restored, lines, reason }` — `reason` null, 'none', 'unusable',
 * 'unread' or 'failed'; never rejects.
 */
export async function restoreScrollback({
  term,
  tabId,
  read,
  waitForFit = () => Promise.resolve(),
  history = null,
  quiet = () => {},
  keepFile = () => {},
  pushIntoScrollback = false,
  locale,
  now = () => Date.now(),
  maxLines = Infinity,
  readWaitMs = RESTORE_READ_WAIT_MS,
  fitWaitMs = RESTORE_FIT_WAIT_MS,
  parseWaitMs = RESTORE_PARSE_WAIT_MS,
  setTimeout: setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => clearTimeout(id),
  warn = (...args) => console.warn(...args),
} = {}) {
  const timers = { setTimer, clearTimer };
  let quieted = false;
  try {
    let text;
    try {
      text = await within(read(tabId), readWaitMs, UNREAD, timers);
    } catch {
      text = UNREAD;
    }
    if (text === UNREAD) {
      try {
        keepFile(tabId);
      } catch {
        // the restore still ends; only the file's fate is unsure
      }
      return { restored: false, lines: 0, reason: 'unread' };
    }
    const parsed = parseSnapshot(text, { tabId, now: now(), maxLines });
    if (!parsed) return { restored: false, lines: 0, reason: text === null ? 'none' : 'unusable' };

    try {
      await within(waitForFit(), fitWaitMs, undefined, timers);
    } catch {
      // Unfitted: written at the size it has, and reflowed when it gets one.
    }

    const data = restoreText(parsed, { pushIntoScrollback, rows: term.rows, locale });
    if (!data) return { restored: false, lines: 0, reason: 'unusable' };
    quiet(true);
    quieted = true;
    history?.before(parsed.savedAt);
    try {
      term.write(data);
    } finally {
      history?.after(term);
    }
    // Once xterm has read it: the empty write's callback runs after the text
    // is parsed, and xterm reports that batch parsed (`onWriteParsed`) in the
    // same task — so the promise, settled a microtask later, ends the quiet
    // after that report, not before it.
    await within(
      new Promise((resolve) => term.write('', resolve)),
      parseWaitMs,
      undefined,
      timers
    );
    return { restored: true, lines: parsed.lines, reason: null };
  } catch (err) {
    warn(`[scrollback] could not restore the scrollback of ${tabId}:`, err);
    return { restored: false, lines: 0, reason: 'failed' };
  } finally {
    if (quieted) {
      try {
        quiet(false);
      } catch {
        // nothing to undo
      }
    }
  }
}
