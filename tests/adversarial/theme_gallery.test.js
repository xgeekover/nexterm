/**
 * The terminal theme gallery in Settings (spec P5): which card a key moves
 * to, what is previewed, what a picked file becomes, and what importing and
 * deleting do to the two settings — src/components/common/themeGalleryModel.js,
 * which ThemeGallery.jsx draws. And the one rule the Settings window itself
 * adds: an Escape over a preview belongs to the gallery.
 *
 * Where the gallery puts these to work — pointer and focus events, the file
 * input — needs a browser; the Chromium check drives that.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, assert } from '../e2e/harness/testFramework.js';

const h = React.createElement;
import {
  AT_CAPACITY,
  GALLERY_COLUMNS,
  NO_PREVIEW,
  THEME_PREVIEWING,
  chosenCardId,
  colorWord,
  deleteTheme,
  focusIsKeyboardMove,
  galleryMove,
  ignoresHeldKey,
  importScheme,
  keyboardClickWhileHeld,
  notImported,
  pendingThemeUndo,
  pendingUndoCount,
  pickSummary,
  pointerMoved,
  previewAfter,
  previewShown,
  refocusAfterNotice,
  resetAllQuestion,
  scrollDeltaToShow,
  tabStopId,
  themeFromFile,
  undoDelete,
  undoOffered,
} from '../../src/components/common/themeGalleryModel.js';
import { DEFAULT_TERMINAL_THEME_ID, MAX_CUSTOM_THEMES, terminalThemeChoices } from '../../src/lib/terminalThemes.js';
import { THEME_FILE_MAX_BYTES } from '../../src/lib/themeImport.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useThemeGalleryStore } from '../../src/stores/themeGalleryStore.js';
import { TRASH_GRACE_MS, createGalleryInput } from '../../src/components/common/themeGalleryInput.js';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

/** SettingsWindow.jsx bundled (its .jsx imports only), every other import the real module — as settings_window.test.js does. */
let loading = null;
function loadSettingsWindow() {
  loading ??= build({
    stdin: { contents: "export * from './components/common/SettingsWindow.jsx';", resolveDir: SRC_DIR, sourcefile: 'sw.js', loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-modules',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path.endsWith('.jsx')) return undefined;
            if (args.path.startsWith('.')) {
              return { path: pathToFileURL(path.resolve(args.resolveDir, args.path)).href, external: true };
            }
            return { path: import.meta.resolve(args.path), external: true };
          });
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

const scheme = (name, theme = { background: '#101010', foreground: '#eeeeee' }, filled = []) => ({ ok: true, name, theme, filled });
const fakeFile = (name, text, size = Buffer.byteLength(text)) => ({ name, size, text });
/** What the file input hands over: the file's bytes. */
const readFake = (file) => Promise.resolve(new Uint8Array(Buffer.from(file.text)));

describe('Theme gallery: moving through the cards', () => {
  test('TG-01: arrows, Home and End move the keyboard through the cards', () => {
    assert.equal(GALLERY_COLUMNS, 3);
    const n = 11;
    assert.equal(galleryMove(2, 'ArrowRight', n), 3, 'off the end of a row onto the next');
    assert.equal(galleryMove(10, 'ArrowRight', n), 10, 'the last stays the last');
    assert.equal(galleryMove(0, 'ArrowLeft', n), 0);
    assert.equal(galleryMove(4, 'ArrowLeft', n), 3);
    assert.equal(galleryMove(7, 'ArrowDown', n), 10);
    assert.equal(galleryMove(8, 'ArrowDown', n), 8, 'no card below: stay put');
    assert.equal(galleryMove(4, 'ArrowUp', n), 1);
    assert.equal(galleryMove(1, 'ArrowUp', n), 1);
    assert.equal(galleryMove(6, 'Home', n), 0);
    assert.equal(galleryMove(0, 'End', n), 10);
    assert.equal(galleryMove(-5, 'ArrowRight', n), 1, 'an index from a list that has since changed is held to it');
    assert.equal(galleryMove(50, 'ArrowLeft', n), 9);
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageDown']) assert.equal(galleryMove(3, key, n), null, key);
    assert.equal(galleryMove(0, 'ArrowRight', 0), null);
  });

  test('TG-02: the last interaction is previewed; choosing, Escape and programmatic focus preview nothing (T1, T2, T7)', () => {
    const run = (...events) => events.reduce(previewAfter, NO_PREVIEW);
    const choices = terminalThemeChoices([]);
    const shown = (state, chosen = 'monokai') => previewShown(state, chosen, choices);
    // The pointer rests on Nord; the keyboard then moves to Dracula: Dracula
    // is shown, not Nord — the keyboard is what was used last (T1).
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'focus', id: 'dracula', byKeyboard: true })), 'dracula');
    // And the other way round.
    assert.equal(shown(run({ type: 'focus', id: 'dracula', byKeyboard: true }, { type: 'point', id: 'nord' })), 'nord');
    // Enter (or a click) chooses: the chosen theme shows, whatever the
    // pointer rests on — the hovered theme used to stay on screen (T1, T2).
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'focus', id: 'dracula', byKeyboard: true }, { type: 'choose' }), 'dracula'), null);
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'choose' }), 'nord'), null);
    // The wheel slid Dracula under a pointer that had previewed One Dark, and
    // the click chose Dracula. In WebKit a click does not focus a button, so
    // no focus event came between: choosing alone must end One Dark's preview (T2).
    assert.equal(shown(run({ type: 'point', id: 'one-dark' }, { type: 'choose' }), 'dracula'), null);
    assert.equal(shown(run({ type: 'focus', id: 'nord', byKeyboard: true }, { type: 'choose' }), 'dracula'), null);
    // Leaving with the pointer ends only a pointer preview; leaving with the keyboard only a keyboard one.
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'pointer-left' })), null);
    assert.equal(shown(run({ type: 'focus', id: 'dracula', byKeyboard: true }, { type: 'pointer-left' })), 'dracula');
    assert.equal(shown(run({ type: 'focus', id: 'dracula', byKeyboard: true }, { type: 'focus-left' })), null);
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'focus-left' })), 'nord');
    // Escape and a reset (delete, undo, import) end any preview.
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'cancel' })), null);
    assert.equal(shown(run({ type: 'focus', id: 'dracula', byKeyboard: true }, { type: 'reset' })), null);
    // Focus that is not the keyboard moving — the app moving it after Undo,
    // a delete or an import (T7), the window coming back to the front and
    // handing focus back to the card that had it (R4), a click — starts
    // nothing, and stops nothing either.
    assert.equal(shown(run({ type: 'reset' }, { type: 'focus', id: 'nord' })), null);
    assert.equal(shown(run({ type: 'reset' }, { type: 'focus-left' }, { type: 'focus', id: 'nord' })), null, 'window blur, then focus back');
    assert.equal(shown(run({ type: 'point', id: 'nord' }, { type: 'focus', id: 'dracula' })), 'nord');
    // The chosen theme, or one no longer offered, is no preview.
    assert.equal(shown(run({ type: 'point', id: 'monokai' })), null);
    assert.equal(shown(run({ type: 'point', id: 'custom:deleted' })), null);
    // A move within the same card changes nothing — no re-render per pixel.
    const once = run({ type: 'point', id: 'nord' });
    assert.equal(previewAfter(once, { type: 'point', id: 'nord' }), once);
  });

  test('TG-03: a chosen id the gallery does not offer is marked as the default, which is what is drawn', () => {
    const choices = terminalThemeChoices([{ id: 'custom:mine', label: 'Mine', theme: { background: '#000000' } }]);
    assert.equal(chosenCardId('custom:mine', choices), 'custom:mine');
    assert.equal(chosenCardId('nord', choices), 'nord');
    for (const gone of ['light-modern', 'custom:deleted', undefined, '']) assert.equal(chosenCardId(gone, choices), DEFAULT_TERMINAL_THEME_ID);
  });

  test('TG-04: colour names in a sentence', () => {
    assert.equal(colorWord('brightBlack'), 'bright black');
    assert.equal(colorWord('selectionBackground'), 'selection');
    assert.equal(colorWord('cursorAccent'), 'cursor text');
    assert.equal(colorWord('red'), 'red');
  });
});

describe('Theme gallery: importing a picked file', () => {
  test('TG-05: a file over 256 KB is refused from its size, before a byte is read', async () => {
    let reads = 0;
    const read = (file) => {
      reads += 1;
      return Promise.resolve(file.text);
    };
    const big = await themeFromFile(fakeFile('huge.json', '{}', THEME_FILE_MAX_BYTES + 1), { read });
    assert.equal(big.kind, 'error');
    assert.match(big.text, /^"huge\.json" was not imported\. The file is larger than 256 KB/);
    assert.equal(reads, 0, 'the file was read anyway');
    const failing = await themeFromFile(fakeFile('x.json', '{}'), { read: () => Promise.reject(new Error('gone')) });
    assert.match(failing.text, /"x\.json" was not imported\. It could not be read\./);
    assert.equal((await themeFromFile(null)).kind, 'error');
  });

  test('TG-06: one scheme is ready to add; several are offered; a refusal names the file and the reason', async () => {
    const one = await themeFromFile(fakeFile('Night', 'background = #101010\nforeground = #eeeeee'), { read: readFake });
    assert.equal(one.kind, 'scheme');
    assert.equal(one.scheme.name, 'Night');
    const wt = { background: '#101010', foreground: '#eeeeee' };
    const many = await themeFromFile(fakeFile('s.json', JSON.stringify({ schemes: [{ ...wt, name: 'A' }, { ...wt, name: 'B', background: '#ffffff' }] })), { read: readFake });
    assert.equal(many.kind, 'pick');
    assert.deepEqual(many.schemes.map((s) => [s.name, s.ok]), [['A', true], ['B', false]]);
    const light = await themeFromFile(fakeFile('Paper', 'background = #fafafa'), { read: readFake });
    assert.equal(light.kind, 'error');
    assert.match(light.text, /^"Paper" was not imported\. "Paper" has a light background/);
  });

  test('TG-07: importing adds the theme and chooses it, saying what was filled in', () => {
    const outcome = importScheme([], scheme('Night', { background: '#101010' }, ['selectionBackground', 'brightBlack', 'brightRed']), 'Night');
    assert.deepEqual(outcome.themes.map((t) => t.id), ['custom:night']);
    assert.equal(outcome.chosen, 'custom:night');
    assert.equal(outcome.notice.kind, 'ok');
    assert.match(outcome.notice.text, /Imported "Night"/);
    assert.equal(outcome.notice.detail, 'Not in the file, so taken from the default theme: selection, bright black and bright red.');
    assert.equal(importScheme([], scheme('Whole'), 'w').notice.detail, '', 'nothing filled, nothing said');
    const full = Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => ({ id: `custom:t${i}`, label: `T${i}`, theme: { background: '#000000' } }));
    const refused = importScheme(full, scheme('One more'), 'more.json');
    assert.equal(refused.themes, undefined, 'a refused import changed the list');
    assert.equal(refused.chosen, undefined, 'a refused import changed the choice');
    assert.match(refused.notice.text, /"more\.json" was not imported\. You have 20 imported themes/);
    assert.match(AT_CAPACITY, /Delete one to import another/);
  });
});

describe('Theme gallery: deleting an imported theme', () => {
  // Handed the settings store's own state, as the gallery does — a model
  // that read its own key names passed these cases while Delete did nothing
  // in the app.
  const state = (terminalCustomThemes, terminalTheme) => ({ ...useSettingsStore.getState(), terminalCustomThemes, terminalTheme });
  const list = [
    { id: 'custom:a', label: 'A', theme: { background: '#000000' } },
    { id: 'custom:b', label: 'B', theme: { background: '#000000' } },
    { id: 'custom:c', label: 'C', theme: { background: '#000000' } },
  ];

  test('TG-08: deleting the chosen theme chooses the default; deleting another leaves the choice', () => {
    const active = deleteTheme(state(list, 'custom:b'), 'custom:b');
    assert.deepEqual(active.themes.map((t) => t.id), ['custom:a', 'custom:c']);
    assert.equal(active.chosen, DEFAULT_TERMINAL_THEME_ID);
    assert.match(active.notice.text, /Deleted "B"\. The terminals are back to Dark Modern\./);
    const other = deleteTheme(state(list, 'nord'), 'custom:b');
    assert.equal(other.chosen, 'nord');
    assert.equal(other.notice.text, 'Deleted "B".');
    assert.equal(deleteTheme(state(list, 'nord'), 'custom:zzz'), null);
  });

  test('TG-09: undo puts it back where it was, chosen again if it was', () => {
    const deleted = deleteTheme(state(list, 'custom:b'), 'custom:b');
    const back = undoDelete(state(deleted.themes, deleted.chosen), deleted.notice.undo);
    assert.deepEqual(back.themes, list);
    assert.equal(back.chosen, 'custom:b');
    const notChosen = deleteTheme(state(list, 'nord'), 'custom:a');
    assert.equal(undoDelete(state(notChosen.themes, 'dracula'), notChosen.notice.undo).chosen, 'dracula', 'undo took back a choice made since');
    assert.equal(undoDelete(state(list, 'nord'), notChosen.notice.undo).themes, undefined, 'the same id is there again');
    const full = Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => ({ id: `custom:t${i}`, label: `T${i}`, theme: { background: '#000000' } }));
    assert.equal(undoDelete(state(full, 'nord'), notChosen.notice.undo).themes, undefined, 'past the cap');
    assert.equal(undoDelete(state(list, 'nord'), undefined), null);
  });
});

describe('Theme gallery: what the review found', () => {
  const state = (terminalCustomThemes, terminalTheme) => ({ ...useSettingsStore.getState(), terminalCustomThemes, terminalTheme });
  const imported = (ids) => ids.map((id) => ({ id: `custom:${id}`, label: id.toUpperCase(), theme: { background: '#000000' } }));

  test('TG-11: after a delete the keyboard goes to the card beside it, and the Undo offer is the list it made (T3)', () => {
    const list = imported(['a', 'b', 'c']);
    assert.equal(deleteTheme(state(list, 'nord'), 'custom:b').focusAfter, 'custom:c', 'the next card');
    assert.equal(deleteTheme(state(list, 'nord'), 'custom:c').focusAfter, 'custom:b', 'the last one: the card before it');
    assert.equal(deleteTheme(state(imported(['a']), 'nord'), 'custom:a').focusAfter, 'tomorrow-night', 'the only one: the last built-in');
    const deleted = deleteTheme(state(list, 'custom:b'), 'custom:b');
    assert.equal(deleted.notice.undo.after, deleted.themes);
    assert.equal(undoOffered(deleted.notice, deleted.themes), true);
  });

  test('TG-12: Reset All asks first when it would delete imported themes, and takes back any Undo (T5)', async () => {
    assert.equal(resetAllQuestion(state([], 'nord')), null, 'nothing imported: nothing to ask');
    const question = resetAllQuestion(state(imported(['a', 'b']), 'nord'));
    assert.match(question.message, /2 imported terminal themes/);
    assert.match(question.message, /cannot be undone/);
    assert.equal(question.confirmLabel, 'Reset All');
    assert.match(resetAllQuestion(state(imported(['a']), 'nord')).message, /your imported terminal theme /);
    const deleted = deleteTheme(state(imported(['a', 'b']), 'nord'), 'custom:a');
    assert.equal(undoOffered(deleted.notice, []), false, 'an Undo survived Reset All');
    assert.equal(undoOffered(deleted.notice, [...deleted.themes]), false, 'an Undo survived another change to the list');
    assert.equal(undoOffered({ kind: 'ok', text: 'x' }, deleted.themes), false);
    // The window puts the question to work: its Reset All button calls
    // `resetAll`, which asks before resetting and resets at once only when
    // there is nothing to ask (M16 removed the pending Undo from the count).
    const { resetAll } = await loadSettingsWindow();
    const before = { settings: { ...useSettingsStore.getState() }, notice: useThemeGalleryStore.getState().notice };
    try {
      const asked = [];
      const list = imported(['a']);
      useSettingsStore.setState({ terminalCustomThemes: list, terminalTheme: 'nord' });
      resetAll((question) => asked.push(question));
      assert.equal(asked.length, 1, 'Reset All with an imported theme did not ask');
      assert.equal(useSettingsStore.getState().terminalCustomThemes, list, 'it reset without asking');
      // The last imported theme deleted, its Undo on offer: still asked.
      const deleted = deleteTheme(state(list, 'nord'), 'custom:a');
      useSettingsStore.setState({ terminalCustomThemes: deleted.themes });
      useThemeGalleryStore.getState().setNotice(deleted.notice);
      resetAll((question) => asked.push(question));
      assert.equal(asked.length, 2, 'Reset All took away an undoable theme without asking');
      assert.match(asked[1].message, /can still be brought back/);
      // Nothing to lose: it resets at once.
      useThemeGalleryStore.getState().setNotice(null);
      useSettingsStore.setState({ terminalCustomThemes: [], editorWordWrap: !before.settings.settingsDefaults.editorWordWrap });
      resetAll((question) => asked.push(question));
      assert.equal(asked.length, 2, 'asked with nothing to lose');
      assert.equal(useSettingsStore.getState().editorWordWrap, before.settings.settingsDefaults.editorWordWrap, 'did not reset');
    } finally {
      useThemeGalleryStore.getState().setNotice(before.notice);
      useSettingsStore.setState(before.settings, true);
    }
  });

  test('TG-13: a file name is cleaned before it is shown (T6)', async () => {
    const text = notImported('evil\u{202E}nosj.txt.json', 'It is empty.');
    assert.ok(!/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(text), `a direction override reached the notice: ${JSON.stringify(text)}`);
    assert.match(text, /^"evilnosj\.txt\.json" was not imported\./);
    const long = notImported(`${'A'.repeat(300)}.json`, 'It is empty.');
    assert.ok(long.length < 120, `the whole name was shown: ${long.length} characters`);
    assert.match(long, /…" was not imported/);
    const wt = { background: '#101010', foreground: '#eeeeee' };
    const pick = await themeFromFile(fakeFile('two\u{202E}.json', JSON.stringify([{ ...wt, name: 'A' }, { ...wt, name: 'B' }])), { read: readFake });
    assert.equal(pick.fileName, 'two.json');
    assert.ok(!pick.text.includes('\u{202E}'));
  });

  test('TG-14: a long scheme list says how many it shows; one with nothing to import says only why (T9)', () => {
    const ok = (name) => ({ ok: true, name, theme: { background: '#101010' }, filled: [] });
    const no = (name) => ({ ok: false, name, error: 'It has a light background.' });
    const hundred = Array.from({ length: 100 }, (_, i) => ok(`S${i}`));
    assert.equal(pickSummary({ fileName: 'many.json', schemes: hundred, total: 150 }), '"many.json" holds 150 color schemes; the first 100 are listed. Choose one to import:');
    assert.equal(pickSummary({ fileName: 'two.json', schemes: [ok('A'), no('B')], total: 2 }), '"two.json" holds 2 color schemes. Choose one to import:');
    const none = pickSummary({ fileName: 'light.json', schemes: [no('A'), no('B')], total: 2 });
    assert.equal(none, 'None of the 2 color schemes in "light.json" can be imported:');
    assert.ok(!/Choose one/.test(none));
    assert.equal(pickSummary({ fileName: 'x.json', schemes: Array.from({ length: 100 }, (_, i) => no(`S${i}`)), total: 150 }), 'None of the first 100 of the 150 color schemes in "x.json" can be imported:');
  });

  test('TG-15: an Undo that cannot be done says why (T12)', () => {
    const list = imported(['a', 'b']);
    const deleted = deleteTheme(state(list, 'nord'), 'custom:a');
    const taken = undoDelete(state([...deleted.themes, list[0]], 'nord'), deleted.notice.undo);
    assert.equal(taken.themes, undefined);
    assert.equal(taken.notice.kind, 'error');
    assert.match(taken.notice.text, /"A" could not be put back/);
    const full = Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => ({ id: `custom:t${i}`, label: `T${i}`, theme: { background: '#000000' } }));
    assert.match(undoDelete(state(full, 'nord'), deleted.notice.undo).notice.text, /20 imported themes/);
  });

  test('TG-16: the cards are one Tab stop — the card last focused, else the chosen one (T14)', () => {
    const choices = terminalThemeChoices(imported(['a']));
    assert.equal(tabStopId(choices, { lastFocused: null, chosen: 'nord' }), 'nord');
    assert.equal(tabStopId(choices, { lastFocused: 'custom:a', chosen: 'nord' }), 'custom:a');
    assert.equal(tabStopId(choices, { lastFocused: 'custom:gone', chosen: 'nord' }), 'nord', 'a card that is gone');
    assert.equal(tabStopId(choices, { lastFocused: null, chosen: 'custom:gone' }), choices[0].id);
    assert.equal(tabStopId([], { lastFocused: null, chosen: 'nord' }), null);
  });
});

describe('Theme gallery: what the second review found', () => {
  const state = (terminalCustomThemes, terminalTheme) => ({ ...useSettingsStore.getState(), terminalCustomThemes, terminalTheme });
  const imported = (ids) => ids.map((id) => ({ id: `custom:${id}`, label: id.toUpperCase(), theme: { background: '#000000' } }));

  test('TG-20: a held key acts once — Delete, Backspace, Enter and Space repeats are ignored (R1, R2)', () => {
    for (const key of ['Delete', 'Backspace', 'Enter', ' ']) {
      assert.equal(ignoresHeldKey({ key, repeat: true }), true, `held ${JSON.stringify(key)}`);
      assert.equal(ignoresHeldKey({ key, repeat: false }), false, `pressed ${JSON.stringify(key)}`);
    }
    assert.equal(ignoresHeldKey({ key: 'ArrowRight', repeat: true }), false, 'a held arrow still moves');
    assert.equal(ignoresHeldKey(undefined), false);
    // And a click the keyboard makes while such a key is held is no click —
    // should a platform deliver it although its keydown was cancelled.
    assert.equal(keyboardClickWhileHeld({ detail: 0 }, 'Enter'), true);
    assert.equal(keyboardClickWhileHeld({ detail: 1 }, 'Enter'), false, 'a mouse click is a click');
    assert.equal(keyboardClickWhileHeld({ detail: 0 }, null), false, 'a first Enter is a click');
  });

  test('TG-21: deletes in a row are all taken back by one Undo, in their places (R1)', () => {
    const list = imported(['a', 'b', 'c', 'd']);
    const first = deleteTheme(state(list, 'custom:b'), 'custom:b');
    const second = deleteTheme(state(first.themes, first.chosen), 'custom:c', first.notice.undo);
    const third = deleteTheme(state(second.themes, second.chosen), 'custom:a', second.notice.undo);
    assert.deepEqual(third.themes.map((t) => t.id), ['custom:d']);
    assert.match(third.notice.text, /Deleted 3 themes: "B", "C" and "A"\./);
    const back = undoDelete(state(third.themes, third.chosen), third.notice.undo);
    assert.deepEqual(back.themes.map((t) => t.id), ['custom:a', 'custom:b', 'custom:c', 'custom:d'], 'not back in their places');
    assert.equal(back.chosen, 'custom:b', 'the theme chosen before the deletes is chosen again');
    assert.match(back.notice.text, /"B", "C" and "A" are back\./);
    assert.equal(back.focus, 'custom:a', 'the keyboard lands on the last one deleted');
    // A delete with no Undo on offer starts afresh.
    assert.match(deleteTheme(state(list, 'nord'), 'custom:a', null).notice.text, /^Deleted "A"\.$/);
    assert.equal(pendingUndoCount(third.notice, third.themes), 3);
    assert.equal(pendingUndoCount(third.notice, []), 0, 'not after the list changed');
  });

  test('TG-22: Undo chooses only what was chosen, and only if nothing was chosen since (R2, R7)', () => {
    const list = imported(['a', 'b']);
    const deleted = deleteTheme(state(list, 'custom:a'), 'custom:a');
    assert.equal(deleted.chosen, DEFAULT_TERMINAL_THEME_ID);
    assert.equal(undoDelete(state(deleted.themes, DEFAULT_TERMINAL_THEME_ID), deleted.notice.undo).chosen, 'custom:a');
    assert.equal(undoDelete(state(deleted.themes, 'dracula'), deleted.notice.undo).chosen, 'dracula', 'Undo took back a choice made after the delete');
    const notChosen = deleteTheme(state(list, 'nord'), 'custom:b');
    assert.equal(undoDelete(state(notChosen.themes, 'nord'), notChosen.notice.undo).chosen, 'nord', 'Undo chose a theme that was not chosen');
  });

  test('TG-23: what scrolls a focused card or button clear of the notice (R3)', () => {
    const view = { top: 100, bottom: 500 };
    assert.equal(scrollDeltaToShow({ top: 200, bottom: 300 }, view), 0, 'in view: no scroll');
    assert.equal(scrollDeltaToShow({ top: 450, bottom: 550 }, view), 58, 'under the notice: down by the overlap and a margin');
    assert.equal(scrollDeltaToShow({ top: 60, bottom: 160 }, view), -48, 'above: up');
    assert.equal(scrollDeltaToShow({ top: 50, bottom: 600 }, view), -58, 'taller than the view: its top');
  });

  test('TG-24: only the keyboard moving focus previews; a window coming back to the front does not (R4)', () => {
    assert.equal(focusIsKeyboardMove({ arrowTarget: 'nord', tabKeyDown: false }, 'nord'), true, 'an arrow key to this card');
    assert.equal(focusIsKeyboardMove({ arrowTarget: null, tabKeyDown: true }, 'nord'), true, 'Tab into the cards');
    assert.equal(focusIsKeyboardMove({ arrowTarget: 'dracula', tabKeyDown: false }, 'nord'), false, 'an arrow key to another card');
    assert.equal(focusIsKeyboardMove({ arrowTarget: null, tabKeyDown: false }, 'nord'), false, 'the window refocused, a click, the app');
  });

  test('TG-25: a pointer event at the spot of the last one is not a move, wherever it was (R5)', () => {
    assert.equal(pointerMoved(null, 10, 10), true, 'the first one is');
    assert.equal(pointerMoved({ x: 10, y: 10 }, 10, 10), false);
    assert.equal(pointerMoved({ x: 10, y: 10 }, 11, 10), true);
  });

  test('TG-26: Reset All asks when an Undo is all that is left to lose (R6)', () => {
    assert.equal(resetAllQuestion(state([], 'nord'), 0), null);
    const question = resetAllQuestion(state([], 'nord'), 1);
    assert.ok(question, 'Reset All would take away a theme the Undo can still bring back, without asking');
    assert.match(question.message, /can still be brought back/);
    assert.match(resetAllQuestion(state(imported(['a']), 'nord'), 2).message, /your imported terminal theme is deleted/);
    // The count comes from the Undo on offer in the gallery's store.
    const list = imported(['a', 'b']);
    const deleted = deleteTheme(state(list, 'nord'), 'custom:a');
    const before = { notice: useThemeGalleryStore.getState().notice, themes: useSettingsStore.getState().terminalCustomThemes };
    try {
      useSettingsStore.setState({ terminalCustomThemes: deleted.themes });
      useThemeGalleryStore.getState().setNotice(deleted.notice);
      assert.equal(pendingThemeUndo(), 1);
      useSettingsStore.setState({ terminalCustomThemes: [...deleted.themes] });
      assert.equal(pendingThemeUndo(), 0, 'counted after the list changed');
    } finally {
      useThemeGalleryStore.getState().setNotice(before.notice);
      useSettingsStore.setState({ terminalCustomThemes: before.themes });
    }
  });

  test('TG-27: a notice going away from under the keyboard hands it to a card (R8)', () => {
    assert.equal(refocusAfterNotice({ focusWasInNotice: true, focusLost: true, tabStop: 'nord' }), 'nord');
    assert.equal(refocusAfterNotice({ focusWasInNotice: true, focusLost: false, tabStop: 'nord' }), null, 'focus went somewhere on purpose');
    assert.equal(refocusAfterNotice({ focusWasInNotice: false, focusLost: true, tabStop: 'nord' }), null, 'it was never there');
  });

  test('TG-28: a file name with nothing visible in it is "this file" (R10)', () => {
    const ok = { ok: true, name: 'A', theme: { background: '#101010' }, filled: [] };
    assert.equal(pickSummary({ fileName: '\u{200B}\u{200B}', schemes: [ok, ok], total: 2 }), 'This file holds 2 color schemes. Choose one to import:');
    assert.equal(pickSummary({ fileName: '\u{2800}', schemes: [{ ok: false, name: 'A', error: 'x' }], total: 1 }), 'None of the 1 color schemes in this file can be imported:');
  });
});

describe('Theme gallery: input as the browser delivers it (G4, G5, G8)', () => {
  /**
   * The gallery's controller (themeGalleryInput.js) with what it acts on
   * recorded: the events it sends `previewAfter`, the cards it focuses, the
   * themes it deletes and chooses. `focusCard` behaves as a browser does —
   * focusing a card fires that card's focus event, synchronously — and
   * `later` runs once the key's default action is over.
   */
  function harness({ start = 1000 } = {}) {
    const log = { dispatched: [], focused: [], deleted: [], chosen: [], inView: [] };
    let clock = start;
    const timers = [];
    let input;
    input = createGalleryInput({
      dispatch: (event) => log.dispatched.push(event),
      focusCard: (id) => {
        log.focused.push(id);
        input.cardFocus(id);
      },
      deleteCard: (id) => log.deleted.push(id),
      choose: (id) => log.chosen.push(id),
      keepInView: (node) => log.inView.push(node),
      later: (fn) => timers.push(fn),
      now: () => clock,
    });
    return {
      input,
      log,
      tick: (ms) => {
        clock += ms;
      },
      flush: () => timers.splice(0).forEach((fn) => fn()),
    };
  }
  /** A key event the way a browser hands it on, recording what was done to it. */
  const key = (k, { repeat = false, target = null } = {}) => {
    const e = { key: k, repeat, target, defaultPrevented: false, stopped: false };
    e.preventDefault = () => {
      e.defaultPrevented = true;
    };
    e.stopPropagation = () => {
      e.stopped = true;
    };
    return e;
  };
  const card = (id) => ({ closest: (selector) => (selector === '[data-theme-card]' ? { getAttribute: () => id } : null) });
  const imported = (ids) => ids.map((id) => ({ id: `custom:${id}`, label: id.toUpperCase(), theme: { background: '#000000' } }));
  const pointer = (x, y, id = null) => ({ clientX: x, clientY: y, target: id ? card(id) : { closest: () => null } });
  const choices = terminalThemeChoices(imported(['a', 'b', 'c']));
  const mine = choices.find((c) => c.id === 'custom:b');

  test('TG-30: a held Delete deletes one theme, however long it is held (M11)', () => {
    const { input, log } = harness();
    input.windowKeyDown(key('Delete'));
    input.cardKeyDown(key('Delete'), mine, choices);
    for (let i = 0; i < 10; i += 1) {
      const repeat = key('Delete', { repeat: true });
      input.windowKeyDown(repeat);
      input.cardKeyDown(repeat, mine, choices);
      assert.equal(repeat.defaultPrevented, true, 'a repeat was let through');
    }
    assert.deepEqual(log.deleted, ['custom:b'], `held Delete deleted ${log.deleted.length}`);
    const backspace = key('Backspace', { repeat: true });
    input.cardKeyDown(backspace, mine, choices);
    assert.deepEqual(log.deleted, ['custom:b']);
  });

  test('TG-31: a click the keyboard makes while a key is held is no click (M12)', () => {
    const { input, log } = harness();
    input.windowKeyDown(key('Enter'));
    input.windowKeyDown(key('Enter', { repeat: true }));
    input.cardClick({ detail: 0 }, 'nord');
    assert.deepEqual(log.chosen, [], 'a held Enter chose a theme');
    assert.equal(input.allowClick({ detail: 0 }), false);
    assert.equal(input.allowClick({ detail: 1 }), true, 'a mouse click while a key is held');
    input.windowKeyUp(key('Enter'));
    input.cardClick({ detail: 0 }, 'nord');
    assert.deepEqual(log.chosen, ['nord'], 'Enter after the key came up is a click');
    input.windowKeyDown(key('Enter', { repeat: true }));
    input.windowBlur();
    assert.equal(input.allowClick({ detail: 0 }), true, 'a key held while the window lost focus stays held');
  });

  test('TG-32: only the keyboard moving focus previews — not a window coming back, a click or the app (M13)', () => {
    const { input, log } = harness();
    input.cardFocus('nord');
    assert.deepEqual(log.dispatched.at(-1), { type: 'focus', id: 'nord', byKeyboard: false }, 'the window refocusing previewed');
    input.cardKeyDown(key('ArrowRight'), choices.find((c) => c.id === 'nord'), choices);
    assert.deepEqual(log.focused, ['one-dark']);
    assert.deepEqual(log.dispatched.at(-1), { type: 'focus', id: 'one-dark', byKeyboard: true }, 'an arrow key did not preview');
    input.windowKeyDown(key('Tab'));
    input.cardFocus('dracula');
    assert.deepEqual(log.dispatched.at(-1), { type: 'focus', id: 'dracula', byKeyboard: true }, 'Tab did not preview');
    const h = harness();
    h.input.windowKeyDown(key('Tab'));
    h.flush();
    h.input.cardFocus('dracula');
    assert.deepEqual(h.log.dispatched.at(-1), { type: 'focus', id: 'dracula', byKeyboard: false }, 'a Tab long over still counted');
  });

  test('TG-33: a pointer event at the spot of the last one previews nothing, wherever the last one was (M14)', () => {
    const { input, log } = harness();
    input.windowPointerMove(pointer(10, 10));
    input.gridPointerMove(pointer(10, 10, 'nord'));
    assert.deepEqual(log.dispatched.at(-1), { type: 'point', id: 'nord' });
    // The pointer moves off the cards and rests; the list scrolls a card under
    // it; WebKit then sends a pointermove at the same spot.
    input.windowPointerMove(pointer(300, 400));
    input.gridPointerLeave();
    const before = log.dispatched.length;
    input.windowPointerMove(pointer(300, 400, 'dracula'));
    input.gridPointerMove(pointer(300, 400, 'dracula'));
    assert.equal(log.dispatched.length, before, 'a card that slid under a still pointer was previewed');
    input.windowPointerMove(pointer(302, 401, 'dracula'));
    input.gridPointerMove(pointer(302, 401, 'dracula'));
    assert.deepEqual(log.dispatched.at(-1), { type: 'point', id: 'dracula' }, 'a real move did not preview');
  });

  test('TG-34: when the notice the keyboard was in goes away, the keyboard goes to the cards (M15)', () => {
    const { input, log } = harness();
    input.noticeFocusIn();
    input.afterRender({ focusLost: true, focusInNoticeNow: false, tabStop: 'nord' });
    assert.deepEqual(log.focused, ['nord'], 'focus was left on the page');
    assert.equal(log.dispatched.at(-1).byKeyboard, false, 'and that focus previewed');
    input.afterRender({ focusLost: true, focusInNoticeNow: false, tabStop: 'nord' });
    assert.deepEqual(log.focused, ['nord'], 'handed on twice');
    const other = harness();
    other.input.noticeFocusIn();
    other.input.afterRender({ focusLost: false, focusInNoticeNow: false, tabStop: 'nord' });
    other.input.afterRender({ focusLost: true, focusInNoticeNow: false, tabStop: 'nord' });
    assert.deepEqual(other.log.focused, [], 'focus taken elsewhere on purpose was moved');
  });

  test('TG-35: a held Escape ends a preview and stops there — it neither closes Settings nor reaches the page (G5)', async () => {
    const { input, log } = harness();
    const first = key('Escape');
    input.galleryKeyDown(first, { preview: 'nord', chosen: 'monokai' });
    assert.equal(first.defaultPrevented && first.stopped, true);
    // The preview ends, and the keyboard lands on the chosen card — a focus
    // the app moved, which previews nothing.
    assert.deepEqual(log.dispatched, [{ type: 'cancel' }, { type: 'focus', id: 'monokai', byKeyboard: false }]);
    assert.deepEqual(log.focused, ['monokai']);
    for (let i = 0; i < 5; i += 1) {
      const repeat = key('Escape', { repeat: true });
      input.galleryKeyDown(repeat, { preview: null, chosen: 'monokai' });
      assert.equal(repeat.defaultPrevented && repeat.stopped, true, 'a repeat of the Escape went on');
    }
    const { settingsWindowKey } = await loadSettingsWindow();
    const anywhere = { closest: () => null };
    assert.equal(settingsWindowKey({ key: 'Escape', repeat: true, target: anywhere }), null, 'a held Escape closes Settings');
    assert.equal(settingsWindowKey({ key: 'Escape', repeat: false, target: anywhere }), 'close');
  });

  test('TG-36: a second click on a trash button straight after a delete is ignored, unless the pointer moved (G8)', () => {
    assert.ok(TRASH_GRACE_MS >= 600 && TRASH_GRACE_MS <= 1000, `grace ${TRASH_GRACE_MS} ms`);
    const { input, log, tick } = harness();
    input.windowPointerMove(pointer(500, 300));
    input.trashClick({ detail: 1 }, 'custom:a');
    tick(700);
    input.trashClick({ detail: 1 }, 'custom:b');
    assert.deepEqual(log.deleted, ['custom:a'], 'the card that slid under the pointer was deleted too');
    tick(200);
    input.trashClick({ detail: 1 }, 'custom:b');
    assert.deepEqual(log.deleted, ['custom:a', 'custom:b'], 'a click after the grace was ignored');
    input.windowPointerMove(pointer(520, 300));
    tick(100);
    input.trashClick({ detail: 1 }, 'custom:c');
    assert.deepEqual(log.deleted, ['custom:a', 'custom:b', 'custom:c'], 'a click after the pointer moved was ignored');
    tick(50);
    input.trashClick({ detail: 2 }, 'custom:d');
    assert.equal(log.deleted.length, 3, 'a double-click\'s second click deleted');
    // A double-click whose pointer jittered between its clicks is past the
    // grace — the pointer moved — and still one click.
    tick(900);
    input.trashClick({ detail: 1 }, 'custom:d');
    input.windowPointerMove(pointer(521, 301));
    tick(120);
    input.trashClick({ detail: 2 }, 'custom:e');
    assert.deepEqual(log.deleted.slice(3), ['custom:d'], 'the second click of a double-click that moved a pixel deleted');
  });
});

describe('Theme gallery: the component hands its events to the controller', () => {
  /**
   * ThemeGallery.jsx bundled with a JSX runtime that records the props of
   * every element it makes, then rendered on the server: no DOM, but every
   * handler the component binds is captured, closures and all, and can be
   * called as the browser would call it. What a handler does to the stores —
   * a theme deleted, a theme chosen — is what is checked; so a binding that
   * stops handing an event to the controller, or hands it past a guard,
   * fails here. (The window-wide listeners are bound in an effect, which a
   * server render does not run; the Chromium check drives those.)
   */
  let loadingGallery = null;
  function loadGallery() {
    loadingGallery ??= build({
      stdin: { contents: "export * from './components/common/ThemeGallery.jsx';", resolveDir: SRC_DIR, sourcefile: 'gallery.js', loader: 'js' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [
        {
          name: 'recording-jsx',
          setup(b) {
            b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'recording-jsx', namespace: 'recording' }));
            b.onLoad({ filter: /.*/, namespace: 'recording' }, () => ({
              loader: 'js',
              contents: [
                `import runtime from ${JSON.stringify(import.meta.resolve('react/jsx-runtime'))};`,
                'const record = (props) => { if (props) (globalThis.__galleryProps ??= []).push(props); };',
                'export const Fragment = runtime.Fragment;',
                'export function jsx(type, props, key) { record(props); return runtime.jsx(type, props, key); }',
                'export function jsxs(type, props, key) { record(props); return runtime.jsxs(type, props, key); }',
              ].join('\n'),
            }));
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.namespace === 'recording') return { path: args.path, external: true };
              if (args.path.endsWith('.jsx')) return undefined;
              if (args.path.startsWith('.')) {
                return { path: pathToFileURL(path.resolve(args.resolveDir, args.path)).href, external: true };
              }
              return { path: import.meta.resolve(args.path), external: true };
            });
          },
        },
      ],
    }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
    return loadingGallery;
  }

  /** Render the gallery with these imported themes; the handlers it bound, found by what they are on. */
  async function renderGallery(themes) {
    const { ThemeGallery } = await loadGallery();
    useSettingsStore.setState({ terminalCustomThemes: themes, terminalTheme: 'nord' });
    useThemeGalleryStore.getState().setNotice(null);
    globalThis.__galleryProps = [];
    // zustand answers a server render from each store's initial state, so the
    // arranged state is copied there for the render and put back after it:
    // every suite in this process shares these stores.
    const initial = [useSettingsStore, useThemeGalleryStore].map((s) => [s.getInitialState(), { ...s.getInitialState() }, s.getState()]);
    try {
      for (const [target, , now] of initial) Object.assign(target, now);
      renderToString(h(ThemeGallery));
    } finally {
      for (const [target, saved] of initial) {
        for (const k of Object.keys(target)) delete target[k];
        Object.assign(target, saved);
      }
    }
    const props = globalThis.__galleryProps;
    return {
      card: (id) => props.find((p) => p.role === 'radio' && p.title === [...TERMINAL_THEMES_LABELS, ...themes.map((t) => [t.id, t.label])].find(([i]) => i === id)?.[1]),
      trash: (label) => props.find((p) => p['aria-label'] === `Delete ${label}`),
      gallery: () => props.find((p) => 'data-theme-gallery' in p),
    };
  }
  const TERMINAL_THEMES_LABELS = terminalThemeChoices([]).map((c) => [c.id, c.label]);
  const ev = (fields) => ({ preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields });
  const themes = () => [
    { id: 'custom:a', label: 'A', theme: { background: '#000000' } },
    { id: 'custom:b', label: 'B', theme: { background: '#000000' } },
    { id: 'custom:c', label: 'C', theme: { background: '#000000' } },
  ];

  test('TG-38: Delete on a card deletes its theme once — a held one no more — and a trash button twice in a row deletes once', async () => {
    const before = { settings: { ...useSettingsStore.getState() }, notice: useThemeGalleryStore.getState().notice };
    try {
      const g = await renderGallery(themes());
      g.card('custom:b').onKeyDown(ev({ key: 'Delete', repeat: true }));
      assert.equal(useSettingsStore.getState().terminalCustomThemes.length, 3, 'a held Delete deleted');
      g.card('custom:b').onKeyDown(ev({ key: 'Delete', repeat: false }));
      assert.deepEqual(useSettingsStore.getState().terminalCustomThemes.map((t) => t.id), ['custom:a', 'custom:c'], 'Delete on the card did not delete it');
      assert.match(useThemeGalleryStore.getState().notice?.text ?? '', /Deleted "B"/);
      const t = await renderGallery(themes());
      t.trash('A').onClick(ev({ detail: 1 }));
      t.trash('B').onClick(ev({ detail: 1 }));
      assert.deepEqual(useSettingsStore.getState().terminalCustomThemes.map((x) => x.id), ['custom:b', 'custom:c'], 'two clicks on one spot deleted two themes');
    } finally {
      useThemeGalleryStore.getState().setNotice(before.notice);
      useSettingsStore.setState(before.settings, true);
    }
  });

  test('TG-39: a click on a card chooses it; Escape held over the gallery is kept from the page', async () => {
    const before = { settings: { ...useSettingsStore.getState() }, notice: useThemeGalleryStore.getState().notice };
    try {
      const g = await renderGallery(themes());
      g.card('dracula').onClick(ev({ detail: 1 }));
      assert.equal(useSettingsStore.getState().terminalTheme, 'dracula', 'a click on a card did not choose it');
      g.card('monokai').onClick(ev({ detail: 2 }));
      assert.equal(useSettingsStore.getState().terminalTheme, 'dracula', 'a double-click\'s second click chose');
      const held = ev({ key: 'Escape', repeat: true });
      g.gallery().onKeyDown(held);
      assert.equal(held.defaultPrevented && held.stopped, true, 'a held Escape went on to the page');
    } finally {
      useThemeGalleryStore.getState().setNotice(before.notice);
      useSettingsStore.setState(before.settings, true);
    }
  });
});

describe('Theme gallery: the Undo outlives the gallery (G6)', () => {
  test('TG-37: hiding the gallery keeps an Undo on offer, and drops any other notice', () => {
    const store = useThemeGalleryStore;
    const before = store.getState().notice;
    try {
      const undoable = deleteTheme({ terminalCustomThemes: [{ id: 'custom:a', label: 'A', theme: { background: '#000000' } }], terminalTheme: 'nord' }, 'custom:a');
      store.getState().setNotice(undoable.notice);
      store.getState().galleryClosed();
      assert.equal(store.getState().notice, undoable.notice, 'a Settings search dropped the Undo');
      store.getState().setNotice({ kind: 'error', text: 'x' });
      store.getState().galleryClosed();
      assert.equal(store.getState().notice, null, 'a stale notice came back with the gallery');
    } finally {
      store.getState().setNotice(before);
    }
  });
});

describe('Theme gallery: Escape in the Settings window', () => {
  /** A key event whose target sits inside the given attributes' elements. */
  const keyIn = (key, inside = []) => ({
    key,
    target: { closest: (selector) => (selector.split(',').some((s) => inside.includes(s.trim())) ? {} : null) },
  });

  test('TG-10: Escape over a preview is the gallery\'s; anywhere else it closes the window', async () => {
    const { settingsWindowKey } = await loadSettingsWindow();
    assert.equal(typeof settingsWindowKey, 'function');
    assert.equal(THEME_PREVIEWING, 'data-theme-previewing');
    assert.equal(settingsWindowKey(keyIn('Escape', [`[${THEME_PREVIEWING}]`])), null, 'Settings closed instead of taking the preview back');
    assert.equal(settingsWindowKey(keyIn('Escape', ['[data-theme-gallery]'])), 'close', 'a gallery with nothing previewed keeps Escape closing the window');
    assert.equal(settingsWindowKey(keyIn('Escape')), 'close');
    assert.equal(settingsWindowKey(keyIn('Tab', [`[${THEME_PREVIEWING}]`])), 'trap');
  });
});
