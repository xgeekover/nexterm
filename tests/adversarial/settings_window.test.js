/**
 * The Settings window (src/components/common/SettingsWindow.jsx) and its
 * Keyboard Shortcuts section (KeybindingSettings.jsx): what a field commits,
 * what a key does to the window, and where focus goes when it closes.
 *
 * Each of those is decided by a small exported function, and these cases call
 * it. Where the window puts it to work — a listener on the document, an
 * effect — needs a browser, which is what driving the app is for (see
 * TEST_INFRA.md).
 *
 * Node cannot import a .jsx file, so the two are bundled with esbuild (already
 * present — the render suite transforms JSX with it) and imported from a
 * data: URL, as in confirm_dialog.test.js: nothing is registered
 * process-wide. Only the .jsx files are bundled. Every other import is left to
 * Node as the real module, so the stores the window reads are the ones these
 * cases see.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { COMMANDS, configurableCommands } from '../../src/lib/keybindings.js';

const h = React.createElement;

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

let loading = null;
function loadSettingsUi() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './components/common/SettingsWindow.jsx';",
        "export * from './components/common/KeybindingSettings.jsx';",
      ].join('\n'),
      resolveDir: SRC_DIR,
      sourcefile: 'settings-ui-under-test.js',
      loader: 'js',
    },
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
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

/** An export of the two files, failing by name when it is not there. */
async function exported(name) {
  const ui = await loadSettingsUi();
  assert.ok(ui[name] !== undefined, `the Settings window does not export ${name}, so none of this is under test`);
  return ui[name];
}

const SCROLLBACK = { min: 100, max: 100000 };
const NOTIFY_AFTER = { min: 0, max: 600 };

describe('Settings: a number field commits only a number that was typed', () => {
  test('SW-01: a field left blank puts the saved value back', async () => {
    // Select the scrollback, delete it to type another, click elsewhere: the
    // blur commits. Number('') is 0, which was clamped to the minimum and
    // saved — every open terminal then kept only its last 100 lines.
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('', SCROLLBACK, 5000), 5000);
    assert.equal(numberToCommit('', { min: 8, max: 32 }, 12), 12, 'a font size is not set to 8');
    assert.equal(numberToCommit('', { min: 1, max: 8 }, 2), 2, 'a tab size is not set to 1');
    assert.equal(numberToCommit('', NOTIFY_AFTER, 10), 10, 'notifications are not turned off');
  });

  test('SW-02: spaces, or text that is not a number, put the saved value back too', async () => {
    const numberToCommit = await exported('numberToCommit');
    for (const text of ['   ', '\t', 'abc', '1e', '--5', 'NaN', 'Infinity', null, undefined]) {
      assert.equal(numberToCommit(text, SCROLLBACK, 5000), 5000, `${JSON.stringify(text)} is not a number anyone typed`);
    }
  });

  test('SW-03: a number that was typed is committed, held to the field\'s range', async () => {
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('2500', SCROLLBACK, 5000), 2500);
    assert.equal(numberToCommit(' 2500 ', SCROLLBACK, 5000), 2500);
    assert.equal(numberToCommit('50', SCROLLBACK, 5000), 100, 'below the range: its minimum');
    assert.equal(numberToCommit('250000', SCROLLBACK, 5000), 100000, 'above it: its maximum');
    assert.equal(numberToCommit('1.5', { min: 1, max: 2 }, 1.2), 1.5, 'line height takes a fraction');
  });

  test('SW-04: a typed 0 is a number, and where 0 is allowed it is committed', async () => {
    // "0 turns it off" is what Notify After says — typing it must work.
    const numberToCommit = await exported('numberToCommit');
    assert.equal(numberToCommit('0', NOTIFY_AFTER, 10), 0);
    assert.equal(numberToCommit('0', SCROLLBACK, 5000), 100, 'and where it is not, the minimum, as for any number too small');
  });
});

/** The attributes of the first element in some markup, by name. */
function attributesOf(html) {
  const tag = /^<[a-z]+([^>]*)>/.exec(html);
  assert.ok(tag, `no element in ${html}`);
  return new Map([...tag[1].matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']));
}

/**
 * An element as far as `closest` goes: its attributes and its parent. Only
 * `[name]` selectors are understood; anything else throws, so a window that
 * starts asking for more fails loudly rather than matching nothing.
 */
function element(attributes = new Map(), parent = null) {
  return {
    attributes,
    parent,
    closest(selector) {
      const match = /^\[([a-zA-Z-]+)\]$/.exec(selector);
      if (!match) throw new Error(`the test element knows [attribute] selectors only, not ${selector}`);
      for (let node = this; node; node = node.parent) if (node.attributes.has(match[1])) return node;
      return null;
    },
  };
}

const key = (k, target, fields = {}) => ({ key: k, target, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...fields });

describe('Settings: Escape while a shortcut is being recorded', () => {
  test('SW-05: Escape on the field recording a shortcut is that field\'s; anywhere else it closes the window', async () => {
    // The window's listener runs in the capture phase, ahead of the field's
    // own, and used to close the whole window for an Escape that only meant
    // "stop recording".
    const settingsWindowKey = await exported('settingsWindowKey');
    const ChordRecorder = await exported('ChordRecorder');
    const recorder = element(attributesOf(renderToString(
      h(ChordRecorder, { title: 'Find in Terminal', refusal: null, onKeyDown() {}, onBlur() {} })
    )));
    assert.equal(settingsWindowKey(key('Escape', recorder)), null, 'Escape while recording must not close the window');

    const searchBox = element(new Map([['type', 'text']]), element(new Map([['role', 'dialog']])));
    assert.equal(settingsWindowKey(key('Escape', searchBox)), 'close');
    assert.equal(settingsWindowKey(key('Escape', element())), 'close');
  });

  test('SW-06: the rest of the window\'s keys are as they were', async () => {
    const settingsWindowKey = await exported('settingsWindowKey');
    const ChordRecorder = await exported('ChordRecorder');
    const recorder = element(attributesOf(renderToString(
      h(ChordRecorder, { title: 'Save File', refusal: null, onKeyDown() {}, onBlur() {} })
    )));
    for (const target of [element(), recorder]) {
      assert.equal(settingsWindowKey(key('Tab', target)), 'trap', 'Tab goes round inside the window');
      assert.equal(settingsWindowKey(key('Tab', target, { shiftKey: true })), 'trap');
      for (const other of ['a', 'Enter', ' ', 'ArrowDown']) assert.equal(settingsWindowKey(key(other, target)), null, other);
    }
  });

  test('SW-07: a refused key is said in words, on the field itself too', async () => {
    const ChordRecorder = await exported('ChordRecorder');
    const refusal = 'A shortcut needs Ctrl or Alt, or an F-key.';
    const html = renderToString(h(ChordRecorder, { title: 'Save File', refusal, refusalId: 'why-1', onKeyDown() {}, onBlur() {} }));
    const attributes = attributesOf(html);
    assert.equal(attributes.get('aria-invalid'), 'true');
    assert.equal(attributes.get('aria-describedby'), 'why-1', 'the field points at the reason');
    assert.equal(attributes.get('aria-label'), 'Press the keys for Save File');

    const calm = attributesOf(renderToString(h(ChordRecorder, { title: 'Save File', refusal: null, refusalId: 'why-1', onKeyDown() {}, onBlur() {} })));
    assert.equal(calm.has('aria-invalid'), false, 'nothing refused yet, nothing invalid');
    assert.equal(calm.has('aria-describedby'), false);
  });
});

/** A page as far as `focusAfterClose` looks at one. */
function page() {
  const body = { focus() {} };
  const nodes = new Set([body]);
  const doc = {
    body,
    documentElement: {},
    activeElement: body,
    contains: (node) => nodes.has(node),
  };
  const add = () => {
    const node = { focus() { doc.activeElement = node; } };
    nodes.add(node);
    return node;
  };
  return { doc, add, remove: (node) => nodes.delete(node) };
}

describe('Settings: closing gives focus back', () => {
  test('SW-08: focus goes back to the terminal that had it when the window opened', async () => {
    // With focus left on the page, the terminal got no keys until clicked,
    // and off macOS a Ctrl+W meant for the shell ran Close Pane instead.
    const focusAfterClose = await exported('focusAfterClose');
    const { doc, add } = page();
    const terminal = add();
    assert.equal(focusAfterClose(terminal, doc), terminal);
  });

  test('SW-09: …unless it has gone, was nothing, or something else has focus now', async () => {
    const focusAfterClose = await exported('focusAfterClose');
    const { doc, add, remove } = page();

    const closedTerminal = add();
    remove(closedTerminal);
    assert.equal(focusAfterClose(closedTerminal, doc), null, 'a terminal closed meanwhile');

    assert.equal(focusAfterClose(doc.body, doc), null, 'the window opened with nothing focused');
    assert.equal(focusAfterClose(null, doc), null);

    const terminal = add();
    const editor = add();
    editor.focus();
    assert.equal(focusAfterClose(terminal, doc), null, 'the editor took focus since; it keeps it');
  });
});

describe('Settings: what a focused terminal never sees', () => {
  test('SW-12: closing the window leaves the field being typed in, so what was typed is kept', async () => {
    // Found in review: Escape and a click beside the window closed it with
    // the focus still in a number or text field, which commits only when
    // left, so a value typed and not yet left was dropped without a word.
    const leave = await exported('leaveEditedField');
    const blurred = [];
    const field = { blur: () => blurred.push('field') };
    const outside = { blur: () => blurred.push('outside') };
    const dialog = { contains: (el) => el === field };
    const doc = (active) => ({ activeElement: active, body: { blur: () => blurred.push('body') } });

    assert.equal(leave(dialog, doc(field)), true);
    assert.deepEqual(blurred, ['field'], 'the field in the window is left');
    assert.equal(leave(dialog, doc(outside)), false, 'focus elsewhere is not touched');
    const d = doc(null);
    d.activeElement = d.body;
    assert.equal(leave(dialog, d), false);
    assert.equal(leave(null, doc(field)), false);
    assert.deepEqual(blurred, ['field']);

    // Both ways of closing that do not move the focus first leave the field.
    const src = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8');
    assert.match(src, /if \(action === 'close'\) \{\s*e\.preventDefault\(\);\s*leaveEditedField\(dialogRef\.current, document\);\s*setOpen\(false\);/, 'Escape');
    assert.match(src, /e\.preventDefault\(\);\s*leaveEditedField\(dialogRef\.current, document\);\s*setOpen\(false\);\s*\}\}/, 'a click beside the window');
  });

  test('SW-13: wired — focus goes back on close, Escape in the recorder stays there, and the gear takes no focus', () => {
    // Found in review: the helpers above are tested on their own, and taking
    // any of these three lines out left every suite green.
    const win = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8');
    assert.match(
      win,
      /const opener = document\.activeElement;\s*return \(\) => \{\s*focusAfterClose\(opener, document\)\?\.focus\(\);/,
      'what had focus when the window opened gets it back'
    );
    assert.match(win, /const action = settingsWindowKey\(e\);/, 'Escape is judged by settingsWindowKey, which leaves it to the recorder');
    assert.match(win, /document\.addEventListener\('keydown', onKeyDown, true\);/);
    const sidebar = readFileSync(new URL('../../src/components/layout/Sidebar.jsx', import.meta.url), 'utf8');
    assert.match(
      sidebar,
      /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}\s*onClick=\{\(\) => setSettingsModalOpen\(true\)\}/,
      'the gear leaves focus where it was'
    );
  });

  test('SW-10: the note above the shortcuts names every command claimed over a terminal, and no other', async () => {
    // It said "only the two side-bar toggles are claimed" while ten were —
    // the wrong answer for someone looking for what took a key from their
    // shell.
    const overTerminalNote = await exported('overTerminalNote');
    const note = overTerminalNote();
    for (const { id, title } of configurableCommands()) {
      if (COMMANDS[id].overTerminal) assert.ok(note.includes(title), `${title} is claimed over a terminal and not named`);
      else assert.ok(!note.includes(title), `${title} is not claimed over a terminal, yet named`);
    }
    assert.ok(!/only the two side-bar toggles/.test(note));
  });

  test('SW-11: the Keyboard Shortcuts section draws that note', async () => {
    const KeybindingSettings = await exported('KeybindingSettings');
    const overTerminalNote = await exported('overTerminalNote');
    const html = renderToString(h(KeybindingSettings));
    const text = html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    assert.ok(text.includes(overTerminalNote()), 'the section does not draw the generated note');
  });
});
