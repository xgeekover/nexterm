/**
 * The native menu must print the key that actually runs the command.
 *
 * The menu bar on macOS is built in Rust (`src-tauri/src/menu.rs`) with an
 * accelerator hardcoded per item, and until now those were the only shortcuts
 * it could show. Settings can rebind a command, so the menu went on
 * advertising ⌘B for a side bar that had moved to ⌘J — the same class of lie
 * as the four menu entries whose shortcuts nothing listened for (see
 * keybinding_table.test.js), only this half of it lives in another language.
 *
 * `src/lib/nativeMenu.js` converts the bound chords to Tauri/muda accelerator
 * strings and `menu_set_accelerators` rebuilds the menu with them. Two things
 * have to hold and neither is obvious:
 *
 *   1. what the frontend computes for the DEFAULT bindings must equal what
 *      Rust hardcodes, or the menu changes its mind a moment after launch —
 *      NM-01 checks that against a fixture `cargo test` writes, so it is the
 *      real spec on the real platform rather than a copy of it here;
 *   2. no accelerator may be a bare Ctrl+letter, because the window resolves
 *      its accelerator table before the webview and that is ^C, ^D and ^L
 *      taken away from every shell in the app. A user can now bind whatever
 *      they like, so this is enforced rather than merely written down.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  acceleratorFor,
  acceleratorOverrides,
  stealsFromTheShell,
  syncNativeMenu,
} from '../../src/lib/nativeMenu.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  dispatchKeydown,
  menuIdOf,
  resolveKeybindings,
} from '../../src/lib/keybindings.js';
import { menuBarFor } from '../../src/lib/menuActions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'menu-accelerators.json');
const available = existsSync(FIXTURE);
const fixture = available ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

/** The bindings in force once `overrides` are applied. */
const boundWith = (overrides) => resolveKeybindings(overrides).bindings;

/** What the menu would show for `command` under those overrides. */
const accelFor = (command, overrides, isMac) =>
  acceleratorOverrides(boundWith(overrides), { isMac })[menuIdOf(command)];

describe('The native menu shows the shortcut that is actually bound', () => {
  test('NM-01: the defaults agree with the menu Rust builds, item for item', () => {
    if (!available) {
      const where = path.relative(process.cwd(), FIXTURE);
      // In CI `cargo test` always runs first, so a missing fixture there means
      // the two halves went unchecked — a failure, not a skip.
      assert.equal(
        Boolean(process.env.CI),
        false,
        `${where} is missing in CI — the menu contract went unchecked`
      );
      skip(`no ${where} — run \`cd src-tauri && cargo test\` first`);
    }

    const isMac = fixture.platform === 'macos';
    const ours = acceleratorOverrides(DEFAULT_RESOLVED, { isMac });
    const wrong = [];
    for (const [id, accelerator] of Object.entries(fixture.accelerators)) {
      if (ours[id] !== accelerator) {
        wrong.push(`${id}: menu.rs says ${accelerator}, the frontend sends ${ours[id]}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      `on ${fixture.platform} the menu would change key the moment the frontend connects:\n  ${wrong.join('\n  ')}`
    );
    // Guard the guard: an empty fixture would make the loop above vacuous.
    assert.ok(
      Object.keys(fixture.accelerators).length >= 13,
      `the fixture lists only ${Object.keys(fixture.accelerators).length} items`
    );
  });

  test('NM-02: every item the backend menu has is a command the frontend knows', () => {
    if (!available) skip('no tests/fixtures/menu-accelerators.json — run `cd src-tauri && cargo test` first');
    const known = new Set(Object.keys(COMMANDS).map(menuIdOf).filter(Boolean));
    const unknown = Object.keys(fixture.accelerators).filter((id) => !known.has(id));
    assert.deepEqual(unknown, [], `menu items no keybinding serves: ${unknown.join(', ')}`);
  });

  test('NM-03: rebinding a command changes what the menu prints', () => {
    const before = accelFor('toggle-sidebar', {}, true);
    const after = accelFor('toggle-sidebar', { 'toggle-sidebar': 'mod+j' }, true);
    assert.equal(before, 'CmdOrCtrl+B');
    assert.equal(after, 'CmdOrCtrl+J', 'the menu still advertises the old key');
  });

  test('NM-04: unbinding leaves the item with no shortcut at all', () => {
    // The id must still be SENT — as null. Leaving it out would mean the menu
    // keeps whatever `spec()` hardcoded, so unbinding ⌘B would look like it
    // did nothing.
    const sent = acceleratorOverrides(boundWith({ 'toggle-sidebar': null }), { isMac: true });
    assert.ok('toggle-sidebar' in sent, 'the item must still be addressed');
    assert.equal(sent['toggle-sidebar'], null, 'and told it has no shortcut');
  });

  test('NM-05: no rebind can register a bare Ctrl+letter', () => {
    // ^D is EOF, ^K kills to end of line, ^W deletes a word, ^R is
    // reverse-i-search. An accelerator on any of them takes it from every pane
    // in the app, because the window resolves accelerators before the webview.
    for (const letter of ['c', 'd', 'l', 'k', 'w', 'u', 'r', 'a', 'e']) {
      for (const isMac of [true, false]) {
        assert.equal(
          accelFor('save', { save: `ctrl+${letter}` }, isMac),
          null,
          `Ctrl+${letter} must not become an accelerator (isMac=${isMac})`
        );
      }
      // And off macOS `mod` IS Ctrl, so the same holds for a mod chord there —
      // this is exactly what `terminal_safe` hardcodes for the defaults.
      assert.equal(
        accelFor('save', { save: `mod+${letter}` }, false),
        null,
        `mod+${letter} is Ctrl+${letter} off macOS`
      );
      // On macOS it is ⌘, which the pty never sees.
      assert.equal(
        accelFor('save', { save: `mod+${letter}` }, true),
        `CmdOrCtrl+${letter.toUpperCase()}`,
        `⌘${letter.toUpperCase()} is safe on macOS and must be shown`
      );
    }
  });

  test('NM-06: refusing the accelerator does not refuse the shortcut', () => {
    // The menu shows no key, and the webview listener still runs the command —
    // which is the whole reason it is safe to refuse. If this ever stops being
    // true, NM-05 would be quietly disabling shortcuts instead of protecting
    // the shell.
    const bindings = boundWith({ save: 'ctrl+d' });
    assert.equal(accelFor('save', { save: 'ctrl+d' }, true), null, 'no accelerator');

    const saved = [];
    const e = {
      key: 'd', code: 'KeyD', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      preventDefault: () => {},
    };
    const fired = dispatchKeydown(e, {
      bindings,
      isMod: false, // macOS: Ctrl is not the app modifier
      activeEditorTabId: 'tab-1',
      saveFile: (id) => saved.push(id),
    });
    assert.equal(fired, 'save', 'the rebound chord must still run the command');
    assert.deepEqual(saved, ['tab-1']);
  });

  test('NM-07: a key muda cannot spell produces no accelerator, not a broken menu', () => {
    // `chordFromEvent` records whatever the keyboard reported, and a German
    // layout reports 'ä'. Sending that would make the whole menu fail to
    // build — every item, not just this one — so the item goes without.
    for (const key of ['mod+ä', 'mod+°', 'mod+ㄱ']) {
      assert.equal(acceleratorFor(key, { isMac: true }), null, `${key} must not be sent`);
    }
    // The spellings muda does take, including the ones that are not letters.
    assert.equal(acceleratorFor('mod+comma', { isMac: true }), 'CmdOrCtrl+,');
    assert.equal(acceleratorFor('ctrl+shift+backquote', { isMac: true }), 'Ctrl+Shift+`');
    assert.equal(acceleratorFor('mod+alt+right', { isMac: true }), 'CmdOrCtrl+Alt+Right');
    assert.equal(acceleratorFor('mod+shift+f5', { isMac: true }), 'CmdOrCtrl+Shift+F5');
    assert.equal(acceleratorFor('cmd+escape', { isMac: true }), 'Cmd+Escape');
    assert.equal(acceleratorFor('mod+space', { isMac: true }), 'CmdOrCtrl+Space');
  });

  test('NM-08: commands with no menu entry are never sent', () => {
    const sent = acceleratorOverrides(DEFAULT_RESOLVED, { isMac: true });
    for (const id of ['all-commands', 'escape', 'reload-guard', 'focus-next-pane', 'focus-previous-pane']) {
      assert.equal(menuIdOf(id), null, `${id} is keyboard-only`);
      assert.ok(!(id in sent), `${id} has no menu item to set an accelerator on`);
    }
  });

  test('NM-09: a command bound to several chords shows the first', () => {
    // An OS menu item carries one key equivalent; the rest still work from the
    // keyboard.
    const sent = acceleratorOverrides(boundWith({ save: ['mod+s', 'mod+shift+s'] }), { isMac: true });
    assert.equal(sent.save, 'CmdOrCtrl+S');
  });

  test('NM-10: the sync sends one message, in the shape the command expects', () => {
    const calls = [];
    const sent = [];
    return syncNativeMenu(boundWith({ 'toggle-sidebar': 'mod+j' }), {
      isMac: true,
      hasBackend: () => true,
      send: async (command, args) => {
        calls.push(command);
        sent.push(args);
      },
    }).then((result) => {
      assert.deepEqual(calls, ['menu_set_accelerators'], 'exactly one call, by that name');
      // `menu_set_accelerators` takes `accelerators`; Tauri would drop an
      // argument under any other name and the menu would silently keep its
      // defaults.
      assert.deepEqual(Object.keys(sent[0]), ['accelerators']);
      assert.equal(sent[0].accelerators['toggle-sidebar'], 'CmdOrCtrl+J');
      assert.equal(result, sent[0].accelerators, 'and it reports what it sent');
    });
  });

  test('NM-11: nothing is sent when there is no backend, and a failure is survivable', () => {
    let sends = 0;
    const inBrowser = syncNativeMenu(DEFAULT_RESOLVED, {
      hasBackend: () => false,
      send: async () => { sends += 1; },
    });
    const failing = syncNativeMenu(DEFAULT_RESOLVED, {
      hasBackend: () => true,
      send: async () => { throw new Error('no menu on this platform'); },
    });
    return Promise.all([inBrowser, failing]).then(([browser, failed]) => {
      assert.equal(sends, 0, 'a browser has no native menu to update');
      assert.equal(browser, null);
      assert.equal(failed, null, 'a menu that would not rebuild must not take the window down');
    });
  });

  test('NM-12: the in-app menu follows a rebind too', () => {
    // Windows and Linux draw their own menu, and `menu_set_accelerators` is a
    // no-op there — so if this did not follow the bindings, rebinding would
    // update nothing visible on the platforms that have no native menu at all.
    const rebound = menuBarFor(boundWith({ 'toggle-sidebar': 'mod+j' }));
    const row = rebound.flatMap((m) => m.items).find((i) => i.id === 'toggle-sidebar');
    assert.equal(row.key, 'mod+j');
    assert.ok(/J$/.test(row.shortcut), `the row still reads ${row.shortcut}`);

    const unbound = menuBarFor(boundWith({ 'toggle-sidebar': null }));
    const gone = unbound.flatMap((m) => m.items).find((i) => i.id === 'toggle-sidebar');
    assert.ok(gone, 'the row stays in the menu');
    assert.equal(gone.shortcut, '', 'with nothing beside it');
  });

  test('NM-13: the rule itself, stated directly', () => {
    // NM-05 goes through the whole pipeline; this pins the predicate, so a
    // change to it fails here with an obvious message rather than as a menu
    // item that quietly lost its shortcut.
    assert.equal(stealsFromTheShell('Ctrl+D', { isMac: true }), true);
    assert.equal(stealsFromTheShell('CmdOrCtrl+D', { isMac: false }), true);
    assert.equal(stealsFromTheShell('CmdOrCtrl+D', { isMac: true }), false, '⌘D is ours');
    assert.equal(stealsFromTheShell('Ctrl+Shift+D', { isMac: false }), false, 'shift is not a control byte');
    assert.equal(stealsFromTheShell('Ctrl+`', { isMac: false }), false, 'not a letter');
    assert.equal(stealsFromTheShell('Ctrl+Alt+D', { isMac: false }), false);
  });
});
