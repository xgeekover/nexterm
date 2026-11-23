/**
 * Copy Last Command Output (Secrets Masked) — bundle 4, A2.
 *
 * What the last command printed, on the clipboard: the rows between where its
 * output started (OSC 133 "C", `pty-command-started`) and where it ended
 * (OSC 133 "D", `pty-command-done`), read and masked as `nexterm-cli
 * read-screen` reads a window (controlScreen.js `readRows`). The backend sends
 * both markers exactly where they were in the output (src-tauri/src/pty/
 * manager.rs), and the registry acts on each once xterm has read what came
 * before it (terminalRegistry.js `afterOutputSoFar`), so the cursor is on the
 * exact row and column each one was printed at.
 *
 * Each terminal keeps one tracker with its registry entry, fed by one
 * app-level listener (`listenForCommands`), so a terminal in no pane still
 * gets its blocks. It holds xterm markers, not row numbers, which move with
 * their lines as the buffer scrolls and trims: the open block's start, and
 * the newest finished block's start and end — three at most.
 *
 * No xterm import, no React; the menus reach a terminal's tracker through
 * `setLastOutputSource`, which the registry registers at startup.
 */

import { readRows, READ_MAX_BYTES } from './controlScreen.js';
import { maskSecretsInText } from './scrollbackSnapshot.js';
import { copyText } from './copyText.js';
import { contextTerminalOf, NEVER_SHOWN_REASON } from './copyContext.js';
import { confirmLastOutputCopy } from './copyFeedback.js';

/** The item's label, in the menus and the palette. */
export const LAST_COMMAND_OUTPUT_LABEL = 'Copy Last Command Output (Secrets Masked)';

/** Off: cmd says where a prompt is (OSC 133 D) but never where output starts. */
export const CMD_REASON = "cmd does not say where a command's output starts (OSC 133 C) — use Copy Last N Lines";

/** Off: no command has finished in this terminal yet. */
export const NO_FINISHED_COMMAND_REASON = 'No command has finished yet, or this shell does not mark commands (OSC 133)';

/** Off: a command is running, its output not over yet. */
export const COMMAND_RUNNING_REASON = 'A command is running — Copy Last N Lines copies what it has printed so far';

/** Not copied: the last command printed nothing (to the normal screen). */
export const PRINTED_NOTHING_REASON = 'The last command printed nothing to the scrollback';

/** Not copied: the end of its output is gone (Terminal: Clear, `clear`, trimmed off the top). */
export const OUTPUT_GONE_REASON = "The last command's output is no longer in the scrollback";

/** How long a command is named in the confirming toast, in characters. */
export const COMMAND_IN_TOAST_MAX = 60;

/**
 * `command` as the confirming toast names it: secrets hidden
 * (maskSecretsInText, before it is cut, so a cut cannot hide one from it),
 * then shortened to COMMAND_IN_TOAST_MAX characters, '…' last. Null for none.
 */
export function commandForToast(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const masked = maskSecretsInText(command.trim());
  const chars = Array.from(masked);
  return chars.length > COMMAND_IN_TOAST_MAX ? `${chars.slice(0, COMMAND_IN_TOAST_MAX - 1).join('')}…` : masked;
}

const alive = (marker) => Boolean(marker) && !marker.isDisposed && marker.line >= 0;

function drop(marker) {
  try {
    if (marker && !marker.isDisposed) marker.dispose?.();
  } catch (_) {
    // A marker xterm is disposing already.
  }
}

/**
 * The tracker for one terminal (`term`, an xterm):
 *
 *   - `started(command)` at a C: opens a block at the cursor row, with the
 *     command text (the tab's `commandLine` then; null when unknown). A C
 *     while a block is open replaces it.
 *   - `finished(exitCode)` at a D: closes the open block at the cursor's row
 *     and column. A D with no open block (a stray D, a transient prompt) is
 *     ignored. It becomes the newest finished block; the one before goes.
 *   - No marker is made while the alternate screen is active: a C there opens
 *     nothing, and a D there drops the open block, which has no end to read.
 *   - `cleared()` after Terminal: Clear: the rows went, so the finished
 *     block's markers go (copying it says it is no longer in the
 *     scrollback), and an open block's start (its end copies what is left).
 *     xterm's clear() leaves markers where they were, on rows it blanked.
 *   - `running`, `block` (the newest finished one, or null), `markers()`.
 *   - `dispose()` with the terminal: every marker goes.
 */
export function trackLastCommandOutput(term) {
  let open = null; // { start, command }
  let last = null; // { start, end, column, exitCode, command }
  let disposed = false;
  const onAlternate = () => term?.buffer?.active?.type === 'alternate';
  const mark = () => {
    if (typeof term?.registerMarker !== 'function') return null;
    return term.registerMarker(0) ?? null;
  };
  return {
    started(command) {
      if (disposed || onAlternate()) return false;
      const start = mark();
      if (!start) return false;
      if (open) drop(open.start);
      open = { start, command: typeof command === 'string' && command.trim() !== '' ? command.trim() : null };
      return true;
    },
    finished(exitCode) {
      if (disposed || !open) return false;
      if (onAlternate()) {
        drop(open.start);
        open = null;
        return false;
      }
      const end = mark();
      if (!end) return false;
      const cursorX = term.buffer?.active?.cursorX;
      if (last) {
        drop(last.start);
        drop(last.end);
      }
      last = {
        start: open.start,
        end,
        column: Number.isInteger(cursorX) && cursorX > 0 ? cursorX : 0,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        command: open.command,
      };
      open = null;
      return true;
    },
    cleared() {
      if (open) drop(open.start);
      if (last) {
        drop(last.start);
        drop(last.end);
      }
    },
    get running() {
      return open !== null;
    },
    get block() {
      return last;
    },
    /** The markers held now (at most three). */
    markers() {
      return [open?.start, last?.start, last?.end].filter((m) => m && !m.isDisposed);
    },
    dispose() {
      disposed = true;
      drop(open?.start);
      drop(last?.start);
      drop(last?.end);
      open = null;
      last = null;
    },
  };
}

/**
 * What `block` (a tracker's finished one) printed on `term`, now:
 * `{ ok: true, text, lines, hidden, truncated, startGone, command }`, or
 * `{ ok: false, reason }`. The logical lines from the C row up to the D row,
 * and the D row's cells left of the D's column when it is above 0 (output
 * with no newline at its end, the prompt after it on that row), blank lines
 * at both ends left out, masked as read-screen masks, the newest within
 * `maxBytes` (`truncated` when older ones were left out). A start gone from
 * the buffer while the end is still there reads from the first row left
 * (`startGone`). `command` is the command for the toast (commandForToast:
 * masked, shortened; null when unknown).
 */
export function readCommandOutput(term, block, { maxBytes = READ_MAX_BYTES } = {}) {
  if (!term || !block) return { ok: false, reason: NO_FINISHED_COMMAND_REASON };
  if (!alive(block.end)) return { ok: false, reason: OUTPUT_GONE_REASON };
  const startGone = !alive(block.start);
  const fromRow = startGone ? 0 : block.start.line;
  const toRow = block.end.line;
  if (toRow < fromRow) return { ok: false, reason: PRINTED_NOTHING_REASON };
  const read = readRows(term, { fromRow, toRow, toCol: block.column, maxBytes });
  const text = read.lines.join('\n');
  if (text.trim() === '') return { ok: false, reason: PRINTED_NOTHING_REASON };
  return {
    ok: true,
    text,
    lines: read.lines.length,
    hidden: read.hidden,
    truncated: read.truncated,
    startGone,
    command: commandForToast(block.command),
  };
}

/**
 * Why the item is off for this terminal, or null when it is on. `term` its
 * xterm (null: never shown), `tracker` its tracker, `isCmd` whether its
 * shell is cmd.
 */
export function lastOutputUnavailable({ term = null, tracker = null, isCmd = false } = {}) {
  if (!term) return NEVER_SHOWN_REASON;
  if (isCmd) return CMD_REASON;
  if (tracker?.running) return COMMAND_RUNNING_REASON;
  if (!tracker?.block) return NO_FINISHED_COMMAND_REASON;
  return null;
}

/**
 * Put `tracker`'s last command output on the clipboard (`copy`, copyText by
 * default), synchronously: the copy has begun by the time this returns.
 * readCommandOutput's result with `copied`, the promise of whether the
 * clipboard took it — or `{ ok: false, reason }`, and nothing copied.
 */
export function copyCommandOutput(term, tracker, { copy = copyText, isCmd = false } = {}) {
  const off = lastOutputUnavailable({ term, tracker, isCmd });
  if (off) return { ok: false, reason: off };
  const result = readCommandOutput(term, tracker.block);
  if (!result.ok) return result;
  let copied;
  try {
    copied = Promise.resolve(copy(result.text)).catch(() => false);
  } catch (_) {
    copied = Promise.resolve(false);
  }
  return { ...result, copied };
}

// ---- Where the trackers are ----------------------------------------------------
// The registry registers `fn(tabId)` → `{ tracker, isCmd }` at startup, as it
// registers Copy Context's terminal lookup (copyContext.js).

let source = null;

/** Register the lookup `fn(tabId)` → `{ tracker, isCmd }`, or null. Returns an unregister function. */
export function setLastOutputSource(fn) {
  source = typeof fn === 'function' ? fn : null;
  return () => {
    if (source === fn) source = null;
  };
}

function lookup(tabId) {
  if (!source || !tabId) return null;
  try {
    return source(tabId) ?? null;
  } catch (_) {
    return null;
  }
}

/** `tabId`'s terminal, tracker and shell: `{ term, tracker, isCmd }`. */
function stateOfTab(tabId) {
  const found = lookup(tabId);
  return { term: contextTerminalOf(tabId), tracker: found?.tracker ?? null, isCmd: Boolean(found?.isCmd) };
}

/** Why the item is off for terminal `tabId` now, or null (lastOutputUnavailable). */
export function lastOutputUnavailableOfTab(tabId) {
  return lastOutputUnavailable(stateOfTab(tabId));
}

/**
 * Copy terminal `tabId`'s last command output (copyCommandOutput with the
 * registered lookups). Synchronous, for a click or an Enter.
 */
export function copyCommandOutputOfTab(tabId, { copy } = {}) {
  const { term, tracker, isCmd } = stateOfTab(tabId);
  return copyCommandOutput(term, tracker, { isCmd, ...(copy ? { copy } : {}) });
}

/**
 * Copy terminal `tabId`'s last command output and say so (the palette's
 * Enter): the copy now, inside the Enter (release check H9), the toast once
 * the clipboard has answered (confirmLastOutputCopy). Resolves with whether
 * it was copied.
 */
export function copyLastOutputOfTabAndConfirm(tabId, options) {
  return confirmLastOutputCopy(copyCommandOutputOfTab(tabId, options));
}

/**
 * The menu item (ContextMenu's shape, as copyContextItem): off with the
 * reason (lastOutputUnavailable) — `unavailable` overrides the lookup, a
 * reason or null (tests) — and otherwise copying inside the click, the
 * toast once the clipboard has answered (copyFeedback.js
 * confirmLastOutputCopy). `onSelect` overrides the copy.
 */
export function lastCommandOutputItem({ tabId = null, unavailable, onSelect, icon, key = 'copy-last-command-output', copy } = {}) {
  const reason = unavailable !== undefined ? unavailable : lastOutputUnavailableOfTab(tabId);
  return {
    key,
    label: LAST_COMMAND_OUTPUT_LABEL,
    icon,
    disabled: Boolean(reason),
    disabledReason: reason || undefined,
    // The copy first, synchronously; only the toast waits for its answer.
    onSelect: onSelect ?? (() => confirmLastOutputCopy(copyCommandOutputOfTab(tabId, copy ? { copy } : undefined))),
  };
}

/**
 * The one listener for every terminal's commands: `pty-command-started`
 * calls `started(tabId, entry)` and `pty-command-done` calls
 * `finished(tabId, entry, exitCode)` for each live entry of that session.
 * `entries()` gives `[tabId, entry]` pairs. Resolves with the unlisten
 * functions. All or nothing: when either listen fails (rejects or throws),
 * the one that succeeded is taken back before this rejects, so a caller
 * that resets its guard and tries again never listens twice (review A-R4).
 */
export async function listenForCommands({ listen, entries, started, finished }) {
  const each = (sessionId, fn) => {
    if (!sessionId) return;
    for (const [tabId, entry] of entries()) {
      if (!entry || entry.disposed || entry.sessionId !== sessionId) continue;
      try {
        fn(tabId, entry);
      } catch (err) {
        console.warn('[Terminal] could not track a command:', err);
      }
    }
  };
  const attempt = (fn) => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const results = await Promise.allSettled([
    attempt(() => listen('pty-command-started', (payload) => each(payload?.session_id, (tabId, entry) => started(tabId, entry)))),
    attempt(() =>
      listen('pty-command-done', (payload) =>
        each(payload?.session_id, (tabId, entry) => finished(tabId, entry, payload?.exit_code ?? null))
      )
    ),
  ]);
  const failed = results.find((r) => r.status === 'rejected');
  if (!failed) return results.map((r) => r.value);
  for (const r of results) {
    if (r.status !== 'fulfilled' || typeof r.value !== 'function') continue;
    try {
      r.value();
    } catch (err) {
      console.warn('[Terminal] could not stop listening for commands:', err);
    }
  }
  throw failed.reason;
}
