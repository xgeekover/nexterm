/**
 * What the Settings window's terminal theme gallery decides, as plain
 * functions (ThemeGallery.jsx draws it). Kept out of the .jsx file so that
 * file exports only components — Fast Refresh replaces a module like that in
 * place — and so Node can test every rule here without a DOM.
 *
 * Previewing (spec P5): pointing at a card, or moving the keyboard focus to
 * one, shows that theme on every terminal at once — whichever of the two was
 * done last. Nothing is saved until a theme is chosen (a click, Enter or
 * Space), and choosing ends the preview. Escape, leaving the gallery without
 * choosing, or closing Settings puts the chosen theme back.
 */
import {
  DEFAULT_TERMINAL_THEME_ID,
  MAX_CUSTOM_THEMES,
  TERMINAL_THEME_IDS,
  getTerminalThemeEntry,
} from '../../lib/terminalThemes.js';
import { addCustomTheme, readThemeFile, removeCustomTheme, shownName, THEME_FILE_MAX_BYTES } from '../../lib/themeImport.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useThemeGalleryStore } from '../../stores/themeGalleryStore.js';

/** Cards per row. The grid's CSS says the same (`grid-cols-3`); Up and Down move by this. */
export const GALLERY_COLUMNS = 3;

/**
 * Set on the gallery while it is previewing a theme. The Settings window's
 * Escape (`settingsWindowKey`) leaves an Escape from inside it to the
 * gallery, which takes the preview back instead of closing the window: the
 * user pressing Escape over a preview means "not that one", not "I am done".
 */
export const THEME_PREVIEWING = 'data-theme-previewing';

/**
 * The card a navigation key moves to from `index`, or null for a key the grid
 * does not handle. Left and Right run through the cards in order (off the end
 * of a row onto the next); Up and Down move a row and stay put when there is
 * no card there; Home and End go to the first and the last.
 */
export function galleryMove(index, key, count, columns = GALLERY_COLUMNS) {
  if (!(count > 0)) return null;
  const last = count - 1;
  const at = Math.min(last, Math.max(0, index));
  switch (key) {
    case 'ArrowRight':
      return Math.min(last, at + 1);
    case 'ArrowLeft':
      return Math.max(0, at - 1);
    case 'ArrowDown':
      return at + columns <= last ? at + columns : at;
    case 'ArrowUp':
      return at - columns >= 0 ? at - columns : at;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/** Nothing previewed. */
export const NO_PREVIEW = Object.freeze({ id: null, source: null });

/**
 * What is previewed after an interaction — the last one wins:
 *
 *   point { id }           the pointer really moved onto a card
 *   pointer-left           the pointer left the cards
 *   focus { id, byKeyboard }     the focus moved onto a card — by the
 *                                keyboard (Tab, an arrow key) or not
 *   focus-left             the keyboard focus left the cards
 *   choose | cancel | reset      a theme was chosen, Escape, or the list
 *                                changed under the user (delete, undo, import)
 *
 * The pointer used to win outright over the keyboard: with it resting on one
 * card, arrowing to another previewed the rested-on one, and Enter left the
 * terminals showing it instead of the theme just chosen. Each source ends
 * only its own preview on leaving, so a pointer drifting off the window does
 * not undo what the keyboard is showing. Focus that is not the keyboard
 * moving — the app putting it on the card beside one deleted or back on a
 * restored one, the window coming back to the front and handing it back to
 * the card that had it, a click — is not the user pointing at anything: it
 * starts no preview, and stops none (`focusIsKeyboardMove`).
 *
 * Returns the same state when nothing changed, so a pointer moving about
 * inside one card does not re-render the gallery on every move.
 */
export function previewAfter(state, event) {
  const now = state ?? NO_PREVIEW;
  let next;
  switch (event?.type) {
    case 'point':
      next = { id: event.id, source: 'pointer' };
      break;
    case 'focus':
      if (!event.byKeyboard) return now;
      next = { id: event.id, source: 'keyboard' };
      break;
    case 'pointer-left':
      return now.source === 'pointer' ? NO_PREVIEW : now;
    case 'focus-left':
      return now.source === 'keyboard' ? NO_PREVIEW : now;
    case 'choose':
    case 'cancel':
    case 'reset':
      return NO_PREVIEW;
    default:
      return now;
  }
  return next.id === now.id && next.source === now.source ? now : next;
}

/**
 * Whether focus arriving on card `id` was the keyboard moving: an arrow key
 * the gallery handled for this card (`arrowTarget`), or a Tab pressed just
 * before (`tabKeyDown`). Anything else — the window refocusing, the app
 * moving focus, a click — is not, and previews nothing.
 */
export function focusIsKeyboardMove({ arrowTarget = null, tabKeyDown = false } = {}, id) {
  return arrowTarget === id || Boolean(tabKeyDown);
}

/**
 * Whether a pointer event at (x, y) is the pointer moving, given where the
 * last one anywhere in the window was. A browser reports the pointer over
 * whatever slid under it after a scroll — WebKit with a pointermove at the
 * same spot — and that is not the user pointing at anything.
 */
export function pointerMoved(last, x, y) {
  return !last || last.x !== x || last.y !== y;
}

/**
 * How far to scroll a list to show `rect` in `view` — the part of the list
 * not covered by the notice held at its bottom — with `margin` to spare:
 * positive down, negative up, 0 when it shows already. Something taller
 * than the view shows its top.
 */
export function scrollDeltaToShow(rect, view, margin = 8) {
  if (rect.top < view.top || rect.bottom - rect.top > view.bottom - view.top) return rect.top - view.top - margin;
  if (rect.bottom > view.bottom) return rect.bottom - view.bottom + margin;
  return 0;
}

/**
 * A key held down acts once. A held Delete deleted every imported theme one
 * after another as the focus moved on to the next; a held Enter on Undo put a
 * theme back and then chose it; a held Escape ended a preview and then closed
 * Settings. The trash button ignores a double-click's second click for the
 * same reason, and the confirm dialog ignores held keys.
 */
const HELD_KEYS = new Set(['Enter', ' ', 'Spacebar', 'Delete', 'Backspace', 'Escape']);
export function ignoresHeldKey(e) {
  return Boolean(e?.repeat) && HELD_KEYS.has(e.key);
}

/**
 * Whether a click is the keyboard's (`detail` 0) while one of those keys is
 * held (`heldKey`, noted from its repeats): no click. Cancelling the repeat's
 * keydown already stops the click it would make; this is for a platform
 * that makes it anyway.
 */
export function keyboardClickWhileHeld(e, heldKey) {
  return e?.detail === 0 && Boolean(heldKey);
}

/**
 * Where the keyboard goes when the notice it was in goes away (dismissed, or
 * replaced by a failed pick or undo): to the cards' Tab stop, instead of the
 * page. Null when focus never was in the notice, or has gone somewhere since.
 */
export function refocusAfterNotice({ focusWasInNotice, focusLost, tabStop }) {
  return focusWasInNotice && focusLost && tabStop ? tabStop : null;
}

/** The theme to show for a preview state: none for the chosen theme, already on screen, or one the gallery no longer offers. */
export function previewShown(state, chosen, choices) {
  const id = state?.id ?? null;
  if (!id || id === chosen || !choices.some((c) => c.id === id)) return null;
  return id;
}

/** The chosen theme as the gallery marks it: an id it does not offer is drawn as the default, so it is marked as that. */
export function chosenCardId(terminalTheme, choices) {
  return choices.some((c) => c.id === terminalTheme) ? terminalTheme : DEFAULT_TERMINAL_THEME_ID;
}

/**
 * The one card Tab stops on (a radio group is one stop; the arrows move
 * within it): the card the keyboard was last on, while it is still there,
 * else the chosen one, else the first.
 */
export function tabStopId(choices, { lastFocused = null, chosen = null } = {}) {
  if (lastFocused && choices.some((c) => c.id === lastFocused)) return lastFocused;
  if (chosen && choices.some((c) => c.id === chosen)) return chosen;
  return choices[0]?.id ?? null;
}

/** A theme colour's name in a sentence: `brightBlack` is "bright black". */
const COLOR_WORDS = { cursorAccent: 'cursor text', selectionBackground: 'selection' };
export function colorWord(key) {
  return COLOR_WORDS[key] ?? key.replace(/([A-Z])/g, ' $1').toLowerCase();
}

/** "a", "a and b", "a, b and c". */
function listOf(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * A picked file's name as a notice shows it. The name is the user's file
 * system's, so as hostile as the file: a right-to-left override in it turned
 * the whole notice around. Cleaned as a theme name is, and cut.
 */
const fileNameShown = (fileName) => shownName(fileName, 48);

/** What a refused file's notice says, its name first. */
export function notImported(fileName, reason) {
  const name = fileNameShown(fileName);
  return `${name ? `"${name}"` : 'The file'} was not imported. ${reason}`;
}

export const AT_CAPACITY = `You have ${MAX_CUSTOM_THEMES} imported themes, the most NexTerm keeps. Delete one to import another.`;

/**
 * The line above a file's list of Windows Terminal schemes. Past the first
 * hundred the list stops, and it says so; when none of them can be imported
 * it says only that — the reasons follow, and there is nothing to choose.
 */
export function pickSummary({ fileName, schemes, total }) {
  // A name with nothing visible in it is "this file", never `""`.
  const shown = fileNameShown(fileName);
  const name = shown ? `"${shown}"` : 'this file';
  const Name = shown ? name : 'This file';
  const count = total ?? schemes.length;
  const cut = count > schemes.length;
  if (!schemes.some((s) => s.ok)) {
    return cut
      ? `None of the first ${schemes.length} of the ${count} color schemes in ${name} can be imported:`
      : `None of the ${count} color schemes in ${name} can be imported:`;
  }
  return cut
    ? `${Name} holds ${count} color schemes; the first ${schemes.length} are listed. Choose one to import:`
    : `${Name} holds ${count} color schemes. Choose one to import:`;
}

/** Read a picked file's bytes with the webview's FileReader — no path ever reaches the backend. */
export function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * What a picked file amounts to:
 *
 *   { kind: 'error', text }                           a notice saying why not
 *   { kind: 'scheme', fileName, scheme }              one theme, ready to add
 *   { kind: 'pick', fileName, schemes, total, text }  several: the user picks one
 *
 * The size is checked from the File before a byte is read, so a huge file
 * picked by mistake is never loaded into the page at all; the bytes are
 * handed to `readThemeFile` undecoded, which counts them before decoding.
 */
export async function themeFromFile(file, { read = readFileBytes } = {}) {
  const fileName = typeof file?.name === 'string' ? file.name : '';
  if (!file) return { kind: 'error', text: notImported(fileName, 'No file was chosen.') };
  if (typeof file.size === 'number' && file.size > THEME_FILE_MAX_BYTES) {
    return { kind: 'error', text: notImported(fileName, 'The file is larger than 256 KB, far more than any terminal theme needs.') };
  }
  let bytes;
  try {
    bytes = await read(file);
  } catch {
    return { kind: 'error', text: notImported(fileName, 'It could not be read.') };
  }
  const result = readThemeFile(bytes, fileName);
  if (!result.ok) return { kind: 'error', text: notImported(fileName, result.error) };
  const shownFile = fileNameShown(fileName);
  if (result.schemes.length === 1) return { kind: 'scheme', fileName: shownFile, scheme: result.schemes[0] };
  const pick = { kind: 'pick', fileName: shownFile, schemes: result.schemes, total: result.total };
  return { ...pick, text: pickSummary(pick) };
}

/**
 * Add a scheme to the imported themes and choose it — the user picked a file
 * to use it. Returns the new list and chosen id, or only a notice when it
 * cannot be added.
 */
export function importScheme(customThemes, scheme, fileName) {
  const added = addCustomTheme(customThemes, scheme);
  if (!added.ok) return { notice: { kind: 'error', text: notImported(fileName, added.error) } };
  const filled = Array.isArray(scheme.filled) ? scheme.filled : [];
  return {
    themes: added.themes,
    chosen: added.entry.id,
    notice: {
      kind: 'ok',
      text: `Imported "${added.entry.label}" and switched the terminals to it.`,
      detail: filled.length ? `Not in the file, so taken from the default theme: ${listOf(filled.map(colorWord))}.` : '',
    },
  };
}

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`. */
const quotedList = (labels) => listOf(labels.map((label) => `"${label}"`));

/**
 * Delete an imported theme. When it was the chosen one the terminals go back
 * to the default theme, chosen outright rather than left to the resolver's
 * fallback, so the setting never names a theme that is gone. `focusAfter`
 * is the card beside it — the next, or the one before when it was the last —
 * for the keyboard to land on: its delete button is gone, and jumping to the
 * chosen card, rows away, scrolled the Undo offer out of sight.
 *
 * The notice offers to undo it — deleting needs no confirmation, so it must
 * be easy to take back — and `pending`, the Undo still on offer from the
 * deletes just before, carries on into this one: one Undo puts back every
 * theme deleted since anything else happened. Each new delete used to
 * replace the offer, and the theme deleted before it was gone for good
 * without a word.
 *
 * Takes the settings store's own state (`terminalCustomThemes`,
 * `terminalTheme`), which is what the gallery hands it.
 */
export function deleteTheme({ terminalCustomThemes, terminalTheme }, id, pending = null) {
  const list = Array.isArray(terminalCustomThemes) ? terminalCustomThemes : [];
  const index = list.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const removed = list[index];
  const wasChosen = terminalTheme === id;
  const themes = removeCustomTheme(list, id);
  const chosen = wasChosen ? DEFAULT_TERMINAL_THEME_ID : terminalTheme;
  const deleted = [...(pending?.deleted ?? []), { entry: removed, index }];
  const labels = deleted.map((d) => d.entry.label);
  const what = deleted.length === 1 ? `Deleted "${removed.label}".` : `Deleted ${deleted.length} themes: ${quotedList(labels)}.`;
  const fallbackLabel = getTerminalThemeEntry(DEFAULT_TERMINAL_THEME_ID).label;
  return {
    themes,
    chosen,
    focusAfter: (themes[index] ?? themes[index - 1])?.id ?? TERMINAL_THEME_IDS[TERMINAL_THEME_IDS.length - 1],
    notice: {
      kind: 'deleted',
      text: wasChosen ? `${what} The terminals are back to ${fallbackLabel}.` : what,
      undo: {
        deleted,
        // What was chosen before the first of these deletes, and what they
        // left chosen: Undo puts the first back only while the second still is.
        chosenBefore: pending ? pending.chosenBefore : terminalTheme,
        chosenAfter: chosen,
        // The list these deletes made. The offer stands only while the list
        // is still that one (`undoOffered`).
        after: themes,
      },
    },
  };
}

/**
 * Whether a notice's Undo may still be offered: only while the imported
 * themes are exactly the list the delete left. Reset All, or anything else
 * that changed the list since, takes it back — an Undo after Reset All put
 * one imported theme back into settings just reset.
 */
export function undoOffered(notice, customThemes) {
  return Boolean(notice?.undo) && notice.undo.after === customThemes;
}

/** How many deleted themes the notice's Undo would bring back now — 0 when it is not on offer. */
export function pendingUndoCount(notice, customThemes) {
  return undoOffered(notice, customThemes) ? notice.undo.deleted.length : 0;
}

/**
 * How many deleted themes the gallery's Undo could bring back now, for the
 * Settings window's Reset All: without it Reset All destroyed a theme the
 * user could still bring back without asking — after the last imported
 * theme was deleted there was nothing in the list to ask about. Read from
 * the gallery's store, so it counts while the gallery is hidden too.
 */
export function pendingThemeUndo() {
  return pendingUndoCount(useThemeGalleryStore.getState().notice, useSettingsStore.getState().terminalCustomThemes);
}

/**
 * Put the deleted themes back where they were. The theme that was chosen
 * before the deletes is chosen again only if what they left chosen still is:
 * a theme chosen since is the user's newer choice, and Undo used to take it
 * back. `focus` is the card of the last one deleted, for the keyboard. When
 * putting them back is no longer possible the notice says why. Takes the
 * settings store's state.
 */
export function undoDelete({ terminalCustomThemes, terminalTheme }, undo) {
  if (!undo?.deleted?.length) return null;
  const list = Array.isArray(terminalCustomThemes) ? terminalCustomThemes : [];
  const labels = undo.deleted.map((d) => d.entry.label);
  const names = quotedList(labels);
  if (undo.deleted.some((d) => list.some((t) => t.id === d.entry.id))) {
    return { notice: { kind: 'error', text: `${names} could not be put back: a theme of the same name has been imported since.` } };
  }
  if (list.length + undo.deleted.length > MAX_CUSTOM_THEMES) {
    return { notice: { kind: 'error', text: `${names} could not be put back. ${AT_CAPACITY}` } };
  }
  // Last deleted first: each goes back at the index it had when it went, so
  // the list comes back as it was.
  const themes = [...list];
  for (const { entry, index } of [...undo.deleted].reverse()) {
    themes.splice(Math.min(Math.max(0, index), themes.length), 0, entry);
  }
  return {
    themes,
    chosen: terminalTheme === undo.chosenAfter ? undo.chosenBefore : terminalTheme,
    focus: undo.deleted[undo.deleted.length - 1].entry.id,
    notice: { kind: 'ok', text: labels.length === 1 ? `${names} is back.` : `${names} are back.`, detail: '' },
  };
}

/**
 * What Reset All asks before it runs, or null when there is nothing to ask:
 * with imported themes it deletes them too — they are a setting — and that
 * cannot be taken back, so it says so first. `pending` is how many deleted
 * themes the gallery's Undo could still bring back (`pendingThemeUndo`):
 * Reset All takes that offer away too, so it counts.
 */
export function resetAllQuestion({ terminalCustomThemes }, pending = 0) {
  const count = Array.isArray(terminalCustomThemes) ? terminalCustomThemes.length : 0;
  const undoable = Number.isInteger(pending) && pending > 0 ? pending : 0;
  if (count === 0 && undoable === 0) return null;
  const parts = [];
  if (count > 0) parts.push(count === 1 ? 'your imported terminal theme is deleted' : `your ${count} imported terminal themes are deleted`);
  if (undoable > 0) {
    parts.push(
      undoable === 1
        ? 'the theme you deleted just now, which can still be brought back, is gone for good'
        : `the ${undoable} themes you deleted just now, which can still be brought back, are gone for good`
    );
  }
  return {
    title: 'Reset All Settings?',
    message: `Every setting goes back to its default, and ${parts.join(', and ')}. This cannot be undone.`,
    confirmLabel: 'Reset All',
  };
}
