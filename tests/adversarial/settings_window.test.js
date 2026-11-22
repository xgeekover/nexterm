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
import { COMMANDS, configurableCommands, keysFor, resolveKeybindings } from '../../src/lib/keybindings.js';

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

  test('SW-10: the note above the shortcuts names every command claimed over a terminal that has a key, and no other', async () => {
    // It said "only the two side-bar toggles are claimed" while ten were —
    // the wrong answer for someone looking for what took a key from their
    // shell. And a command with no key takes nothing from anyone: Mark All
    // Notifications Read is claimed over a terminal, and has no default.
    // The keys in force on the platform: off macOS Go to Tab 1's only chord
    // is the macOS \u{2318}1, which takes nothing from a shell there (B-R2).
    const overTerminalNote = await exported('overTerminalNote');
    for (const isMac of [true, false]) {
      const note = overTerminalNote(undefined, undefined, { isMac });
      for (const { id, title } of configurableCommands()) {
        const takes = COMMANDS[id].overTerminal && keysFor(id, undefined, { isMac }).length > 0;
        if (takes) assert.ok(note.includes(title), `isMac ${isMac}: ${title} takes a key over a terminal and is not named`);
        else assert.ok(!note.includes(title), `isMac ${isMac}: ${title} takes no key over a terminal, yet is named`);
      }
      assert.ok(!note.includes('Mark All Notifications Read'), 'no key, not named');
      assert.ok(!/only the two side-bar toggles/.test(note));
      assert.equal(/\bGo to Tab 1\b/.test(note), isMac, `isMac ${isMac}: Go to Tab 1 named only on macOS`);
      assert.equal(note.includes('Go to Last Tab'), isMac, `isMac ${isMac}: Go to Last Tab named only on macOS`);
      assert.ok(note.includes('Next Tab'), `isMac ${isMac}: Next Tab keeps Ctrl+PageDown everywhere`);
    }
    // What the user has bound is what counts.
    const { bindings } = resolveKeybindings({ 'mark-notifications-read': 'mod+alt+u', 'find-in-terminal': null });
    const rebound = overTerminalNote(undefined, bindings);
    assert.ok(rebound.includes('Mark All Notifications Read'), 'given a key, it is named');
    assert.ok(!rebound.includes('Find in Terminal'), 'unbound, it is not');
  });

  test('SW-11: the Keyboard Shortcuts section draws that note', async () => {
    const KeybindingSettings = await exported('KeybindingSettings');
    const overTerminalNote = await exported('overTerminalNote');
    const html = renderToString(h(KeybindingSettings));
    const text = html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    assert.ok(text.includes(overTerminalNote()), 'the section does not draw the generated note');
  });

  test('SW-15: off macOS the rows show no macOS-only \u{2318} chord \u{2014} Go to Tab 1 is Unassigned, Next Tab is Ctrl+PageDown alone', async () => {
    const KeybindingSettings = await exported('KeybindingSettings');
    const overTerminalNote = await exported('overTerminalNote');
    const visible = (html) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    /** A row's title-to-chords map, as drawn: the `<kbd>`s that follow its title. */
    const rowsOf = (html) => {
      const rows = new Map();
      for (const row of html.split(/(?=<div class="py-1\.5 border-b)/).slice(1)) {
        const title = /<span class="flex-1[^"]*">([^<]*)<\/span>/.exec(row)?.[1];
        if (!title) continue;
        rows.set(title, {
          keys: [...row.matchAll(/<kbd\b[^>]*>([\s\S]*?)<\/kbd>/g)].map((m) => visible(m[1])),
          unassigned: row.includes('Unassigned'),
        });
      }
      return rows;
    };
    for (const [name, platform] of [['Windows', { isMac: false, isWindows: true }], ['Linux', { isMac: false, isWindows: false }]]) {
      const html = renderToString(h(KeybindingSettings, { platform }));
      const rows = rowsOf(html);
      for (const title of ['Go to Tab 1', 'Go to Tab 8', 'Go to Last Tab']) {
        assert.ok(rows.has(title), `${name}: the ${title} row is drawn`);
        assert.deepEqual(rows.get(title).keys, [], `${name}: ${title} shows no chord`);
        assert.ok(rows.get(title).unassigned, `${name}: ${title} reads Unassigned`);
      }
      assert.deepEqual(rows.get('Next Tab').keys, ['Ctrl+PageDown'], `${name}: Next Tab`);
      assert.deepEqual(rows.get('Previous Tab').keys, ['Ctrl+PageUp'], `${name}: Previous Tab`);
      const shown = [...rows.values()].flatMap((r) => r.keys);
      assert.ok(!shown.includes('Cmd+1') && !shown.includes('Cmd+9'), `${name}: no Cmd+1 or Cmd+9 anywhere`);
      assert.ok(!shown.some((k) => /Cmd\+Shift\+[[\]]/.test(k)), `${name}: no Cmd+Shift+[ or ]`);
      const text = visible(html);
      assert.ok(text.includes(overTerminalNote(undefined, undefined, { isMac: false })), `${name}: the note is the one for off macOS`);
    }
    // On macOS the same rows carry the \u{2318} defaults.
    const mac = rowsOf(renderToString(h(KeybindingSettings, { platform: { isMac: true, isWindows: false } })));
    assert.deepEqual(mac.get('Go to Tab 1').keys, ['\u{2318}1']);
    assert.deepEqual(mac.get('Go to Last Tab').keys, ['\u{2318}9']);
    assert.equal(mac.get('Next Tab').keys.length, 2, 'macOS: Ctrl+PageDown and \u{2318}\u{21E7}]');
  });
});

describe('The window buttons take no focus', () => {
  // Found in the last review: after Cancel on the question a close asks, the
  // keyboard went back to the ✕ that asked it — and Enter asked again, with
  // Save ready to press.
  test('SW-14: minimize, maximize and close leave the keyboard where it was', () => {
    const src = readFileSync(new URL('../../src/components/layout/WindowControls.jsx', import.meta.url), 'utf8');
    assert.match(src, /const keepFocus = \(e\) => e\.preventDefault\(\);/);
    for (const [title, action] of [['"Minimize"', 'minimize'], ["\\{maximized \\? 'Restore' : 'Maximize'\\}", 'toggleMaximize'], ['"Close"', 'close']]) {
      assert.match(
        src,
        new RegExp(`title=${title}\\s*onMouseDown=\\{keepFocus\\}\\s*onClick=\\{\\(\\) => windowControls\\.${action}\\(\\)\\}`),
        action
      );
    }
  });
});

describe('Settings: Restore Scrollback says where, and Clear asks first', () => {
  test('SW-20: the folder the setting names is the one the backend writes — app_local_data_dir, the identifier, "scrollback"', async () => {
    const scrollbackFolder = await exported('scrollbackFolder');
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const id = conf.identifier;
    assert.equal(id, 'com.nexterm.ide');
    // dirs 6's data_local_dir, which Tauri 2's app_local_data_dir joins the identifier to.
    assert.equal(scrollbackFolder({ mac: true, windows: false }), `~/Library/Application Support/${id}/scrollback`);
    assert.equal(scrollbackFolder({ mac: false, windows: true }), `%LOCALAPPDATA%\\${id}\\scrollback`);
    assert.equal(scrollbackFolder({ mac: false, windows: false }), `~/.local/share/${id}/scrollback`);
    const command = readFileSync(new URL('../../src-tauri/src/commands/scrollback.rs', import.meta.url), 'utf8');
    assert.match(command, /\.app_local_data_dir\(\)/, 'the backend keeps the files somewhere else (roaming?)');
    const store = readFileSync(new URL('../../src-tauri/src/scrollback.rs', import.meta.url), 'utf8');
    assert.match(store, /pub const DIR: &str = "scrollback";/);
  });

  test('SW-21: Clear Saved Scrollback asks before it deletes — Cancel focused, its confirm guarded — and only the answer clears', async () => {
    const question = await exported('CLEAR_SCROLLBACK_QUESTION');
    assert.equal(question.confirmLabel, 'Clear');
    assert.match(question.message, /deleted from this computer/);
    const src = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(
      src,
      /<ConfirmDialog\s+open=\{clearAsked\}[\s\S]*?danger\s+initialFocus="cancel"\s+onConfirm=\{\(\) => \{\s*setClearAsked\(false\);\s*clearSavedScrollback\(\);\s*\}\}\s+onCancel=\{\(\) => setClearAsked\(false\)\}/,
      'the confirmation is not guarded as Reset All is, or Cancel clears'
    );
    assert.match(src, /if \(item\.action === 'clearSavedScrollback'\) setClearAsked\(true\);/, 'the button clears without asking');
    assert.equal((src.match(/clearSavedScrollback\(\)/g) ?? []).length, 1, 'cleared from somewhere other than the answer');
    // Asked afresh each time the window opens.
    assert.match(src, /setResetQuestion\(null\);\s*setClearAsked\(false\);/);
  });
});

describe('Settings: Copy Context Lines (bundle 1, A3)', () => {
  test('SW-22: a number row in the terminal section, 1 to 10000, 200 by default, saying secrets are masked and nothing is written to a file', async () => {
    const buildItems = await exported('buildItems');
    const numberToCommit = await exported('numberToCommit');
    const { SETTINGS_DEFAULTS } = await import('../../src/stores/settingsStore.js');
    const rows = buildItems('', [], '');
    const row = rows.find((r) => r.id === 'terminalCopyContextLines');
    assert.ok(row, 'no Copy Context Lines row');
    assert.equal(rows.filter((r) => r.key === 'terminalCopyContextLines').length, 1, 'one row for the setting');
    assert.deepEqual(
      [row.section, row.key, row.control, row.min, row.max, row.title],
      ['terminal', 'terminalCopyContextLines', 'number', 1, 10000, 'Copy Context Lines']
    );
    assert.equal(SETTINGS_DEFAULTS[row.key], 200);
    assert.match(row.description, /\[hidden\]/);
    assert.match(row.description, /Nothing is written to a file/);
    // Held to its range as it is committed; a blank or junk field keeps what was saved.
    assert.equal(numberToCommit('0', row, 200), 1);
    assert.equal(numberToCommit('-4', row, 200), 1);
    assert.equal(numberToCommit('25000', row, 200), 10000);
    assert.equal(numberToCommit('350', row, 200), 350);
    assert.equal(numberToCommit('', row, 200), 200);
    assert.equal(numberToCommit('lots', row, 200), 200);
    // The window hands the row its value.
    const src = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /const terminalCopyContextLines = useSettingsStore\(\(s\) => s\.terminalCopyContextLines\);/);
    assert.match(src, /const values = \{[^}]*\n    terminalCopyContextLines,\n/);
  });
});

describe('Settings: Keep the Computer Awake While an Agent Works (bundle 1, A4)', () => {
  test("SW-23: a checkbox row in the terminal section, off by default, saying the display may still sleep — and 'not available on this system' when unsupported", async () => {
    const buildItems = await exported('buildItems');
    const { SETTINGS_DEFAULTS } = await import('../../src/stores/settingsStore.js');
    const rowFor = (support) => buildItems('', [], '', support).find((r) => r.id === 'terminalKeepAwakeWhileAgentsWork');
    const row = rowFor(null);
    assert.ok(row, 'no keep-awake row');
    assert.equal(buildItems('', [], '').filter((r) => r.key === 'terminalKeepAwakeWhileAgentsWork').length, 1, 'one row for the setting');
    assert.deepEqual(
      [row.section, row.key, row.control, row.title],
      ['terminal', 'terminalKeepAwakeWhileAgentsWork', 'checkbox', 'Keep the Computer Awake While an Agent Works']
    );
    assert.equal(SETTINGS_DEFAULTS[row.key], false, 'on by default');
    // Not known yet, or supported: what it does, and that the display may still sleep.
    for (const support of [null, { supported: true, method: 'caffeinate' }, { supported: true, method: 'SetThreadExecutionState' }]) {
      const words = rowFor(support).description;
      assert.match(words, /Claude Code terminal is working/);
      assert.match(words, /The display may still turn off and lock\./);
      assert.doesNotMatch(words, /not available/i, `unsupported while ${JSON.stringify(support)}`);
    }
    // Unsupported: said so, in the row itself.
    const unsupported = rowFor({ supported: false, method: 'none' }).description;
    assert.match(unsupported, /The display may still turn off and lock\./);
    assert.match(unsupported, /Not available on this system\.$/);
    // The window asks the shared support question when it opens, hands the answer to the rows, and the row its value.
    const src = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /keepAwakeSupport\(\)\.then\(\(answer\) => \{\s*if \(!cancelled\) setKeepAwake\(answer\);/);
    assert.match(src, /buildItems\(monoPlaceholder, detectedShells, homeDir, keepAwake\),\s*\[monoPlaceholder, detectedShells, homeDir, keepAwake\]/);
    assert.match(src, /const terminalKeepAwakeWhileAgentsWork = useSettingsStore\(\(s\) => s\.terminalKeepAwakeWhileAgentsWork\);/);
    assert.match(src, /const values = \{[^}]*\n    terminalKeepAwakeWhileAgentsWork,\n/);
  });
});

describe('Settings: bundle 2 rows', () => {
  // The macOS-only rows (A6, A7): in the Terminal section on macOS, and not
  // there at all elsewhere — a ⌘ or ⌥ setting does nothing on Windows or Linux.
  const MAC_ONLY = [
    ['terminalMacEditingKeys', 'macOS Text-Editing Keys'],
    ['terminalOptionAsMeta', 'Use Option as Meta'],
  ];

  test('SW-B2-01: buildItems has the macOS-only rows on macOS only, one checkbox each in Terminal', async () => {
    const buildItems = await exported('buildItems');
    const mac = buildItems('', [], '', null, { mac: true });
    const other = buildItems('', [], '', null, { mac: false });
    for (const [key, title] of MAC_ONLY) {
      const rows = mac.filter((r) => r.key === key);
      assert.equal(rows.length, 1, `one ${key} row on macOS`);
      assert.deepEqual([rows[0].id, rows[0].section, rows[0].control, rows[0].title], [key, 'terminal', 'checkbox', title]);
      assert.equal(other.filter((r) => r.key === key || r.id === key).length, 0, `no ${key} row off macOS`);
    }
    // Nothing else depends on the platform flag.
    const macOnly = new Set(MAC_ONLY.map(([key]) => key));
    assert.deepEqual(mac.filter((r) => !macOnly.has(r.key)).map((r) => r.id), other.map((r) => r.id));
    // The ⌘ keys row says what each key sends and where it does not.
    const editing = mac.find((r) => r.key === 'terminalMacEditingKeys').description;
    for (const words of [/⌘← and ⌘→/, /Ctrl\+A, Ctrl\+E, Ctrl\+U and Ctrl\+K/, /full-screen program/, /password prompt is up only ⌘Backspace/]) {
      assert.match(editing, words);
    }
    // The Option as Meta row states the trade: ⌥-characters and dead keys go; the mouse, ⌥Enter and ⌥←/→ stay.
    const meta = mac.find((r) => r.key === 'terminalOptionAsMeta').description;
    for (const words of [/⌥-characters/, /™, €/, /@ \[ \] \{ \} \| ~/, /dead keys/, /⌥-drag still selects/, /⌥Enter still sends Esc Enter/, /⌥← \/ ⌥→ still move a word/]) {
      assert.match(meta, words);
    }
    // OSC 52 (A8): one checkbox in Terminal on every platform, whose words
    // say it is writes only, what is refused, and why it starts off.
    for (const rows of [mac, other]) {
      const osc52 = rows.filter((r) => r.key === 'terminalOsc52Write');
      assert.equal(osc52.length, 1, 'one terminalOsc52Write row');
      assert.deepEqual(
        [osc52[0].id, osc52[0].section, osc52[0].control, osc52[0].title],
        ['terminalOsc52Write', 'terminal', 'checkbox', 'Let Programs Set the Clipboard (OSC 52)']
      );
      for (const words of [/Off by default/, /never reads the clipboard and never clears it/, /more than 128 KiB is refused whole/, /kept from before a terminal was shown is ignored/, /one notice/, /Nothing a program copies is logged/]) {
        assert.match(osc52[0].description, words);
      }
    }
    // The external editor (A12-3): one text row in Files on every platform,
    // whose words say what is run, how, and what is refused.
    for (const rows of [mac, other]) {
      const editor = rows.filter((r) => r.key === 'externalEditorCommand');
      assert.equal(editor.length, 1, 'one externalEditorCommand row');
      assert.deepEqual(
        [editor[0].id, editor[0].section, editor[0].control, editor[0].title],
        ['externalEditorCommand', 'files', 'text', 'External Editor']
      );
      assert.match(
        editor[0].description,
        /^A program and its arguments, for example code or subl -w; run without a shell, with the path added as the last argument\./
      );
      for (const words of [/Open in External Editor/, /files, folders and the open folder/, /A shell, an app that opens files in their default app \(open, xdg-open, start, explorer\) or a wrapper that runs its arguments \(env, xargs, wsl\) is refused\./, /guards against a mistake and is not a sandbox/, /interpreters such as python or node are not refused/, /Empty: no such item/]) {
        assert.match(editor[0].description, words);
      }
      assert.equal(editor[0].placeholder, 'Not set', 'blank reads as none, not as a default editor');
    }
    // The window hands each row its value, and asks for the rows of the platform it runs on.
    const src = readFileSync(new URL('../../src/components/common/SettingsWindow.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /export function buildItems\(monoPlaceholder, detectedShells, homeDir, keepAwake = null, \{ mac = isMac \} = \{\}\)/);
    for (const [key] of [...MAC_ONLY, ['terminalOsc52Write'], ['externalEditorCommand']]) {
      assert.match(src, new RegExp(`const ${key} = useSettingsStore\\(\\(s\\) => s\\.${key}\\);`));
      assert.match(src, new RegExp(`const values = \\{[^}]*\\n    ${key},\\n`));
    }
  });

  test('SW-B2-02: the defaults — macOS Text-Editing Keys on, Use Option as Meta and OSC 52 writes off, no external editor', async () => {
    const { SETTINGS_DEFAULTS } = await import('../../src/stores/settingsStore.js');
    assert.equal(SETTINGS_DEFAULTS.terminalMacEditingKeys, true);
    assert.equal(SETTINGS_DEFAULTS.terminalOptionAsMeta, false);
    assert.equal(SETTINGS_DEFAULTS.terminalOsc52Write, false);
    assert.equal(SETTINGS_DEFAULTS.externalEditorCommand, '');
  });
});
