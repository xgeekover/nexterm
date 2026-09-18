/**
 * Shortcuts a user can change.
 *
 * They used to be predicates — `(e, ctx) => ctx.isMod && !e.shiftKey &&
 * isLetter(e, 'd')` — which cannot be written into a settings file, shown in a
 * window, or rebound by anyone who is not editing the source. A command and
 * the chord that runs it are separate things now, and the chord is data.
 *
 * These cases cover the part a user touches: parsing what they typed or
 * pressed, resolving their overrides over the defaults, refusing to lose every
 * shortcut over one bad entry, and reporting a chord bound twice rather than
 * letting position decide which wins.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  parseChord,
  stringifyChord,
  displayChord,
  chordMatches,
  chordFromEvent,
  conflictsWith,
} from '../../src/lib/chords.js';
import {
  COMMANDS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED,
  resolveKeybindings,
  findConflicts,
  configurableCommands,
  keysFor,
  findBinding,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
} from '../../src/lib/keybindings.js';

const ev = (o = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '', ...o });
const isModOn = (e, platform) => (platform === 'macos' ? Boolean(e.metaKey) : Boolean(e.ctrlKey));
const ctx = (e, platform, extra = {}) => ({ isMod: isModOn(e, platform), ...extra });

describe('Configurable keybindings', () => {
  test('CK-01: a chord survives being written down and read back', () => {
    for (const text of [
      'mod+p', 'mod+shift+o', 'ctrl+shift+backquote', 'mod+alt+right',
      'mod+comma', 'escape', 'f5', 'cmd+r', 'mod+l',
    ]) {
      const chord = parseChord(text);
      assert.ok(chord, `${text} must parse`);
      assert.equal(stringifyChord(chord), text, `${text} must round-trip`);
    }
  });

  test('CK-02: nonsense is rejected rather than half-understood', () => {
    // A settings file is user input. Each of these must be null, not a chord
    // that matches something unexpected.
    for (const bad of ['', '   ', '+', 'mod+', 'mod', 'shift+alt', 'mod+a+b', 'mod+nosuchkey', null, 42, {}]) {
      assert.equal(parseChord(bad), null, `${JSON.stringify(bad)} is not a chord`);
    }
  });

  test('CK-03: a chord is shown the way the platform writes it', () => {
    assert.equal(displayChord('mod+shift+o', { isMac: true }), '⇧⌘O');
    assert.equal(displayChord('mod+shift+o', { isMac: false }), 'Shift+Ctrl+O');
    // Punctuation is matched on `code` and must still be SHOWN as the glyph —
    // a menu reading "⌘Comma" names a key that is not on the keyboard.
    assert.equal(displayChord('mod+comma', { isMac: true }), '⌘,');
    assert.equal(displayChord('ctrl+backquote', { isMac: true }), '⌃`');
    assert.equal(displayChord('mod+alt+right', { isMac: true }), '⌥⌘→');
  });

  test('CK-04: matching is exact, so a shifted chord is not swallowed', () => {
    const modD = parseChord('mod+d');
    const modShiftD = parseChord('mod+shift+d');
    for (const platform of ['macos', 'windows']) {
      const plain = platform === 'macos'
        ? ev({ metaKey: true, key: 'd', code: 'KeyD' })
        : ev({ ctrlKey: true, key: 'd', code: 'KeyD' });
      const shifted = platform === 'macos'
        ? ev({ metaKey: true, shiftKey: true, key: 'D', code: 'KeyD' })
        : ev({ ctrlKey: true, shiftKey: true, key: 'D', code: 'KeyD' });

      assert.ok(chordMatches(modD, plain, isModOn(plain, platform)), `${platform}: mod+d`);
      assert.equal(chordMatches(modD, shifted, isModOn(shifted, platform)), false,
        `${platform}: mod+d must not fire when shift is down`);
      assert.ok(chordMatches(modShiftD, shifted, isModOn(shifted, platform)), `${platform}: mod+shift+d`);
    }
  });

  test('CK-05: recording a keypress gives back the chord that was pressed', () => {
    const pressed = chordFromEvent(
      ev({ metaKey: true, shiftKey: true, key: 'B', code: 'KeyB' }),
      { isMod: true }
    );
    assert.equal(stringifyChord(pressed), 'mod+shift+b');
    // And it matches the very keypress it came from.
    const e = ev({ metaKey: true, shiftKey: true, key: 'B', code: 'KeyB' });
    assert.ok(chordMatches(pressed, e, true), 'what you pressed is what gets bound');

    // Holding only modifiers is not yet a chord to bind.
    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
      assert.equal(chordFromEvent(ev({ key }), { isMod: true }), null, `${key} alone binds nothing`);
    }
  });

  test('CK-06: the shipped defaults do not fight each other', () => {
    assert.deepEqual(findConflicts(DEFAULT_RESOLVED), [], 'two commands share a chord out of the box');
    for (const entry of DEFAULT_KEYBINDINGS) {
      assert.ok(COMMANDS[entry.command], `${entry.command} has a default chord but no command`);
      assert.ok(parseChord(entry.key), `${entry.command}: ${entry.key} does not parse`);
    }
  });

  test('CK-07: an override replaces the default, and a reset brings it back', () => {
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': 'mod+shift+b' });
    assert.deepEqual(keysFor('toggle-sidebar', bindings), ['mod+shift+b']);

    // The new chord runs the command; the old one no longer does.
    const shifted = ev({ metaKey: true, shiftKey: true, key: 'B', code: 'KeyB' });
    assert.equal(findBinding(shifted, ctx(shifted, 'macos', { bindings }))?.command, 'toggle-sidebar');
    const plain = ev({ metaKey: true, key: 'b', code: 'KeyB' });
    assert.equal(findBinding(plain, ctx(plain, 'macos', { bindings })), null, 'the old chord is free');

    // Dropping the override restores the default.
    assert.deepEqual(keysFor('toggle-sidebar', resolveKeybindings({}).bindings), ['mod+b']);
  });

  test('CK-08: null unbinds a command without disturbing the others', () => {
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': null });
    assert.deepEqual(keysFor('toggle-sidebar', bindings), []);
    assert.deepEqual(keysFor('command-palette', bindings), ['mod+k'], 'everything else is untouched');

    const plain = ev({ metaKey: true, key: 'b', code: 'KeyB' });
    assert.equal(findBinding(plain, ctx(plain, 'macos', { bindings })), null);
  });

  test('CK-09: one bad entry costs the user that entry, not every shortcut', () => {
    const { bindings, problems } = resolveKeybindings({
      'toggle-sidebar': 'not a chord at all',
      'no-such-command': 'mod+x',
      escape: 'mod+q',
      save: 'mod+shift+s',
    });

    assert.deepEqual(keysFor('save', bindings), ['mod+shift+s'], 'the good override applies');
    assert.deepEqual(keysFor('command-palette', bindings), ['mod+k'], 'untouched commands survive');
    assert.deepEqual(keysFor('escape', bindings), ['escape'], 'a guard keeps its chord');
    assert.deepEqual(keysFor('toggle-sidebar', bindings), [], 'the unparseable one binds nothing');

    const reasons = problems.map((p) => `${p.command}:${p.reason}`).sort();
    assert.deepEqual(reasons, [
      'escape:this one cannot be rebound',
      'no-such-command:no such command',
      'toggle-sidebar:not a chord',
    ], 'and every rejection says why');
  });

  test('CK-10: a chord bound twice is reported, not silently resolved', () => {
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': 'mod+k' });
    const conflicts = findConflicts(bindings);
    assert.equal(conflicts.length, 1, `expected one conflict, got ${JSON.stringify(conflicts)}`);
    assert.equal(conflicts[0].key, 'mod+k');
    assert.deepEqual(conflicts[0].commands.sort(), ['command-palette', 'toggle-sidebar']);
  });

  test('CK-11: mod and ctrl are the same key off macOS, and that counts as a clash', () => {
    // `mod+b` and `ctrl+b` look different and are the same physical chord on
    // Windows and Linux. Someone rebinding to `ctrl+b` there deserves to be
    // told it collides.
    assert.equal(conflictsWith('mod+b', 'ctrl+b'), true);
    assert.equal(conflictsWith('mod+b', 'mod+shift+b'), false);
    assert.equal(conflictsWith('mod+b', 'mod+alt+b'), false);
    assert.equal(conflictsWith('cmd+r', 'mod+r'), true, 'on macOS mod IS cmd');
  });

  test('CK-12: the two guards may not be rebound', () => {
    const ids = configurableCommands().map((c) => c.id);
    assert.equal(ids.includes('escape'), false, 'Escape is not a shortcut anyone chooses');
    assert.equal(ids.includes('reload-guard'), false, 'the reload guard is not a shortcut either');
    // And every other command is offered, with a title to show.
    for (const [id, spec] of Object.entries(COMMANDS)) {
      if (spec.configurable === false) continue;
      assert.ok(ids.includes(id), `${id} should be rebindable`);
      assert.ok(spec.title, `${id} needs a title for the settings row`);
    }
  });

  test('CK-13: rebinding cannot hand the shell’s control bytes to the app', () => {
    // A user may bind whatever they like, but only `overTerminal` commands are
    // claimed over a focused terminal — so even a deliberate `ctrl+c` binding
    // leaves ^C alone there. KB-11 pins which commands those are.
    const { bindings } = resolveKeybindings({ save: 'ctrl+c' });
    const e = {
      ...ev({ ctrlKey: true, key: 'c', code: 'KeyC' }),
      preventDefault: () => assert.ok(false, '^C must not be swallowed over a terminal'),
      stopPropagation: () => assert.ok(false, '^C must reach xterm'),
    };

    // Bound deliberately, so it does match — that is what rebinding means, and
    // the ordinary listener will run it when focus is anywhere but a terminal.
    for (const platform of ['macos', 'windows']) {
      const found = findBinding(e, ctx(e, platform, { bindings }));
      assert.equal(found?.command, 'save', `${platform}: the user's own binding applies`);
      assert.equal(Boolean(found?.spec?.overTerminal), false,
        `${platform}: rebinding must not make a command claimable over a terminal`);
    }

    // And over a focused terminal it is left alone, because only the commands
    // marked `overTerminal` are claimed there — a list KB-11 pins, and which
    // no amount of rebinding can join.
    for (const platform of ['macos', 'windows']) {
      assert.equal(
        dispatchKeydownOverTerminal(e, ctx(e, platform, { bindings })),
        null,
        `${platform}: ^C still belongs to the shell`
      );
    }
  });

  test('CK-14: a rebound chord actually runs the command behind it', () => {
    const calls = [];
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': 'mod+shift+b' });
    const e = { ...ev({ metaKey: true, shiftKey: true, key: 'B', code: 'KeyB' }), preventDefault: () => calls.push('prevented') };
    const fired = dispatchKeydown(e, ctx(e, 'macos', { bindings, toggleSidebar: () => calls.push('toggled') }));
    assert.equal(fired, 'toggle-sidebar');
    assert.deepEqual(calls, ['prevented', 'toggled']);
  });
});
