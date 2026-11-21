/**
 * Copy Context: a terminal's last N lines on the clipboard, as plain text,
 * with what looks like a secret masked — so a few hundred lines of a build or
 * an agent's work can be pasted into a chat or an issue without the API key
 * that scrolled past going with them.
 *
 * The lines are read the way `nexterm-cli read-screen` reads them
 * (`readScreen`, src/lib/controlScreen.js): logical lines, a wrapped line
 * joined back into one, no escape codes, the blank rows under the last
 * output not counted, the alternate screen while a full-screen program has it
 * up, and the same masking (`[hidden]`) a saved scrollback gets. Nothing is
 * written anywhere but the clipboard: no file, no scrollback command.
 *
 * What is copied is what the terminal has drawn. Output still held back by
 * pacing is not in it.
 *
 * The clipboard write has to happen inside the click or the Enter that asked
 * for it — macOS WebKit may refuse `navigator.clipboard.writeText` once that
 * turn is over (release check H9) — so the screen is read synchronously,
 * through the source the terminal registry registers here, and never through
 * anything awaited first. This module imports no component module: the menus
 * and the palette are loaded in Node by the test suites, and the registry
 * brings xterm and its stylesheet with it.
 */
import { readScreen } from './controlScreen.js';
import { copyText } from './copyText.js';

/** The Copy Context Lines setting: its default and its range. */
export const COPY_CONTEXT_DEFAULT_LINES = 200;
export const COPY_CONTEXT_MIN_LINES = 1;
export const COPY_CONTEXT_MAX_LINES = 10000;

/** Why the item is off for a terminal that has never been on screen. */
export const NEVER_SHOWN_REASON =
  'This terminal has not been shown yet, so it has no screen to copy — open it once first';

/** Why nothing was copied from a terminal that has printed nothing. */
export const NOTHING_PRINTED_REASON = 'This terminal has printed nothing yet';

/**
 * How many lines to copy for the setting's `value`: a whole number from
 * COPY_CONTEXT_MIN_LINES to COPY_CONTEXT_MAX_LINES, rounded down; the default
 * for anything that is not a finite number.
 */
export function clampContextLines(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COPY_CONTEXT_DEFAULT_LINES;
  return Math.min(COPY_CONTEXT_MAX_LINES, Math.max(COPY_CONTEXT_MIN_LINES, Math.floor(value)));
}

/** The menu's and the palette's label: how many lines, and that secrets are masked. */
export function copyContextLabel(lines) {
  const n = clampContextLines(lines);
  return `Copy Last ${n} ${n === 1 ? 'Line' : 'Lines'} (Secrets Masked)`;
}

/**
 * The last `lines` logical lines of `term` (an xterm), masked, as one plain
 * text: `{ text, lines, hidden, truncated, alternate }` — `lines` how many it
 * holds, `hidden` how many secrets were replaced with `[hidden]`, `truncated`
 * whether older ones were left out to stay within read-screen's byte limit.
 * Null without a terminal.
 */
export function contextText(term, lines) {
  if (!term) return null;
  const screen = readScreen(term, { lines: clampContextLines(lines), mask: true });
  return {
    text: screen.lines.join('\n'),
    lines: screen.lines.length,
    hidden: screen.hidden,
    truncated: screen.truncated,
    alternate: screen.alternate,
  };
}

/**
 * Put the last `lines` lines of `term` on the clipboard (`copy`, copyText by
 * default), synchronously: the copy has begun by the time this returns.
 * `{ ok: true, lines, hidden, truncated, copied }` — `copied` the promise of
 * whether the clipboard took it — or `{ ok: false, reason }` when there is
 * no terminal to read (NEVER_SHOWN_REASON) or nothing on it, and then
 * nothing is copied.
 */
export function copyTerminalContext(term, lines, { copy = copyText } = {}) {
  const context = contextText(term, lines);
  if (!context) return { ok: false, reason: NEVER_SHOWN_REASON };
  if (!context.text.trim()) return { ok: false, reason: NOTHING_PRINTED_REASON };
  let copied;
  try {
    copied = Promise.resolve(copy(context.text)).catch(() => false);
  } catch (_) {
    copied = Promise.resolve(false);
  }
  return { ok: true, lines: context.lines, hidden: context.hidden, truncated: context.truncated, copied };
}

// ---- Where the terminals are ---------------------------------------------------
// The terminal registry registers its lookup here at startup (the same pattern
// as setTerminalNoticeSink, src/lib/terminalNotice.js), so the menus and the
// palette can reach a terminal's screen without importing it.

let source = null;

/** Register the lookup `fn(tabId)` → the tab's xterm, or null. Returns an unregister function. */
export function setContextTerminalSource(fn) {
  source = typeof fn === 'function' ? fn : null;
  return () => {
    if (source === fn) source = null;
  };
}

/**
 * The xterm of `tabId` if it has been on screen — never makes one — else
 * null: a terminal never shown, an unknown tab, or no registry (Node).
 */
export function contextTerminalOf(tabId) {
  if (!source || !tabId) return null;
  try {
    return source(tabId) ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Copy the last `lines` lines of terminal `tabId` (copyTerminalContext with
 * the registered lookup). Synchronous, for a click or an Enter.
 */
export function copyContextOfTab(tabId, lines, options) {
  return copyTerminalContext(contextTerminalOf(tabId), lines, options);
}

/**
 * The menu item (ContextMenu's shape) that copies terminal `tabId`'s last
 * `lines` lines: off, saying why, while the terminal has never been shown.
 * `available` overrides the lookup (tests); `onSelect` overrides the copy.
 */
export function copyContextItem({ tabId = null, lines, available, onSelect, icon, key = 'copy-context', copy } = {}) {
  const shown = typeof available === 'boolean' ? available : contextTerminalOf(tabId) !== null;
  return {
    key,
    label: copyContextLabel(lines),
    icon,
    disabled: !shown,
    disabledReason: shown ? undefined : NEVER_SHOWN_REASON,
    onSelect: onSelect ?? (() => {
      copyContextOfTab(tabId, lines, copy ? { copy } : undefined);
    }),
  };
}
