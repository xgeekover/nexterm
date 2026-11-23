/**
 * What a copy says once it is done (bundle 3, U6): a copy changes nothing on
 * screen, so Copy Path, Copy Session ID and Copy Context each show a toast
 * (toastStore) — a short confirmation when the clipboard took the text, an
 * error that stays when it refused or there was nothing to copy.
 *
 * The copy itself is started before anything is awaited, inside the click or
 * the Enter that asked for it: macOS WebKit may refuse
 * `navigator.clipboard.writeText` once that turn is over (release check H9,
 * src/lib/copyContext.js). Only the toast waits for the clipboard's answer.
 *
 * The other copy actions (Copy Relative Path, a terminal's selection, an
 * editor's text, and the rest) do not say anything yet: later work.
 */
import { copyText } from './copyText.js';
import { useToastStore } from '../stores/toastStore.js';

/** Copy Path's confirmation (the TERMINALS row, the tab chip, the Explorer). */
export const PATH_COPIED = 'Path copied';

/** Copy Session ID's confirmation (AGENT SESSIONS). */
export const SESSION_ID_COPIED = 'Session ID copied';

/** The error when the clipboard refused the text. */
export const NOT_COPIED = 'Not copied: the clipboard refused it';

/** The error when there was nothing to put on the clipboard. */
export const NOTHING_TO_COPY = 'Not copied: there is nothing to copy';

/**
 * Why Copy Path is off for a terminal that has no directory yet: the
 * TERMINALS row and the tab chip disable the item with this reason.
 */
export const NO_DIRECTORY_REASON = 'This terminal has no directory yet';

/**
 * Copy Path's error on the tab chip when the tab went between the menu
 * opening and the pick (its item was on, the tab is no longer there).
 */
export const NO_DIRECTORY_YET = 'Not copied: this terminal has no directory yet';

/**
 * A copy error from a reason worded as a sentence of its own (copyContext.js's
 * NEVER_SHOWN_REASON and NOTHING_PRINTED_REASON, which menus also show as
 * the reason an item is off): "Not copied: " and the reason with its first
 * letter lower-cased, so every copy error starts the same way. A reason that
 * already starts so is kept; an empty one is NOTHING_TO_COPY. The first
 * letter is lower-cased whatever the word is, so a reason that starts with a
 * proper noun or an acronym ("NexTerm …", "PTY …") would come out wrong and
 * needs its own message instead.
 */
export function notCopiedBecause(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') return NOTHING_TO_COPY;
  if (text.startsWith('Not copied: ')) return text;
  return `Not copied: ${text[0].toLowerCase()}${text.slice(1)}`;
}

/** Copy Context's confirmation for `n` lines: 'Copied 200 lines (secrets masked)', '1 line' singular. */
export function contextCopiedText(n) {
  return `Copied ${n} ${n === 1 ? 'line' : 'lines'} (secrets masked)`;
}

const confirm = (text) => useToastStore.getState().show({ kind: 'confirm', text });
const fail = (text) => useToastStore.getState().show({ kind: 'error', text });

/** `copied` (a value or a promise of one) as a promise of a boolean that never rejects. */
function settle(copied) {
  return Promise.resolve(copied).then(
    (ok) => ok === true,
    () => false
  );
}

/**
 * Put `text` on the clipboard (`copy`, copyText by default) now, synchronously,
 * and when the clipboard answers show `message` as a confirmation, or
 * NOT_COPIED as an error. With no text nothing is copied and `nothing`
 * (NOTHING_TO_COPY by default) is shown as an error. Resolves with whether
 * the text was copied; never rejects.
 */
export function copyAndConfirm(text, message, { copy = copyText, nothing = NOTHING_TO_COPY } = {}) {
  if (typeof text !== 'string' || text === '') {
    fail(nothing);
    return Promise.resolve(false);
  }
  let copied;
  try {
    copied = copy(text);
  } catch (_) {
    copied = false;
  }
  return settle(copied).then((ok) => {
    if (ok) confirm(message);
    else fail(NOT_COPIED);
    return ok;
  });
}

/**
 * The toast for what copyTerminalContext returned (`{ ok, lines, copied }`,
 * the copy already begun): contextCopiedText(lines) once `copied` resolves
 * true, NOT_COPIED when it resolves false, and the reason as an error
 * (notCopiedBecause) when nothing was copied (`ok` false). Resolves with
 * whether it was copied.
 */
export function confirmContextCopy(result) {
  if (!result || result.ok !== true) {
    fail(notCopiedBecause(result?.reason));
    return Promise.resolve(false);
  }
  return settle(result.copied).then((ok) => {
    if (ok) confirm(contextCopiedText(result.lines));
    else fail(NOT_COPIED);
    return ok;
  });
}

/**
 * Copy Last Command Output's confirmation (bundle 4, A2): the command — as
 * lastCommandOutput.js gives it, secrets masked and shortened
 * (`commandForToast`) — or, unknown, a generic wording; the line count; that
 * secrets are masked; and when only part of it could be copied, why.
 */
export function lastOutputCopiedText({ command = null, lines = 0, startGone = false, truncated = false } = {}) {
  const named = typeof command === 'string' && command !== '' ? command : null;
  const what = named ? `the output of "${named}"` : "the last command's output";
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  const part = startGone
    ? ' — its start is no longer in the scrollback'
    : truncated
      ? ' — its oldest lines left out, too long to copy whole'
      : '';
  return `Copied ${count} of ${what} (secrets masked)${part}`;
}

/**
 * The toast for what copyCommandOutput returned (lastCommandOutput.js, the
 * copy already begun): lastOutputCopiedText once `copied` resolves true,
 * NOT_COPIED when it resolves false, and the reason as an error
 * (notCopiedBecause) when nothing was copied. Resolves with whether it was
 * copied.
 */
export function confirmLastOutputCopy(result) {
  if (!result || result.ok !== true) {
    fail(notCopiedBecause(result?.reason));
    return Promise.resolve(false);
  }
  return settle(result.copied).then((ok) => {
    if (ok) confirm(lastOutputCopiedText(result));
    else fail(NOT_COPIED);
    return ok;
  });
}
