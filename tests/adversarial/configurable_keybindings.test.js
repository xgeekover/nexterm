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
  describeConflict,
  configurableCommands,
  keysFor,
  findBinding,
  dispatchKeydown,
  dispatchKeydownOverTerminal,
  recordKeydown,
  commandsOverTerminal,
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
    for (const isMac of [true, false]) {
      assert.deepEqual(
        findConflicts(DEFAULT_RESOLVED, { isMac }),
        [],
        `${isMac ? 'macOS' : 'Windows'}: two commands share a chord out of the box`
      );
    }
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

/**
 * The keydown a real keypress of `key` produces on `platform`, built from the
 * chord rather than from the matcher, so the matcher is free to be wrong.
 */
function pressOn(key, platform) {
  const chord = parseChord(key);
  assert.ok(chord, `not a chord: ${key}`);
  const mac = platform === 'macos';
  const GLYPH = { Backquote: '`', Comma: ',', Minus: '-', Equal: '=' };
  return ev({
    ctrlKey: Boolean(chord.ctrl || (chord.mod && !mac)),
    metaKey: Boolean(chord.cmd || (chord.mod && mac)),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
    key: chord.code ? GLYPH[chord.code] : chord.key,
    code: chord.code ?? (chord.key.length === 1 ? `Key${chord.key.toUpperCase()}` : chord.key),
  });
}

/** The command a keypress of `key` runs on `platform`, as the window's listener finds it. */
function runsOn(key, platform, bindings) {
  const e = pressOn(key, platform);
  return findBinding(e, ctx(e, platform, { bindings }))?.command ?? null;
}

describe('Conflicts are found by the keys pressed, not by how a chord is spelled', () => {
  test('CK-15: Windows — mod+alt+d and ctrl+alt+d are one keypress, and it is reported', () => {
    // The recorder stores what Ctrl+Alt+D is pressed as there: `mod+alt+d`.
    // Split Right's default is `ctrl+alt+d`. Compared as text the two never
    // met; pressed, Ctrl+Alt+D ran Open Recent and Split Right had lost its
    // only chord that works off macOS, with no warning.
    const { bindings } = resolveKeybindings({ 'open-recent': 'mod+alt+d' });
    assert.equal(runsOn('ctrl+alt+d', 'windows', bindings), 'open-recent', 'the premise: one of them is dead');

    const conflicts = findConflicts(bindings, { isMac: false });
    assert.equal(conflicts.length, 1, `expected one conflict, got ${JSON.stringify(conflicts)}`);
    assert.deepEqual(conflicts[0].commands.slice().sort(), ['open-recent', 'split-right']);

    // On macOS they are ⌥⌘D and ⌃⌥D, two keypresses: nothing to report there.
    assert.deepEqual(findConflicts(bindings, { isMac: true }), []);
  });

  test('CK-16: macOS — mod+d and cmd+d are one keypress, and it is reported', () => {
    // Close Pane rebound to ⌘D: Split Right's `cmd+d` already answers it.
    const { bindings } = resolveKeybindings({ 'close-pane': 'mod+d' });
    const conflicts = findConflicts(bindings, { isMac: true });
    assert.equal(conflicts.length, 1, `expected one conflict, got ${JSON.stringify(conflicts)}`);
    assert.deepEqual(conflicts[0].commands.slice().sort(), ['close-pane', 'split-right']);

    // Off macOS `mod+d` is Ctrl+D and `cmd+d` needs the Windows key: two keypresses.
    assert.deepEqual(findConflicts(bindings, { isMac: false }), []);
  });

  test('CK-17: the command named as winning is the one the keypress runs', () => {
    // Open Recent is listed above Open Folder in Settings, but Open Folder
    // comes first in the bindings, so it is the one Ctrl/⌘+Shift+O runs. The
    // banner used to say "whichever is listed first wins".
    const cases = [
      [{ 'open-recent': 'mod+shift+o' }, 'open-folder', 'open-recent'],
      [{ 'open-recent': 'mod+alt+d' }, 'open-recent', 'split-right', 'windows'],
      [{ 'close-pane': 'mod+d' }, 'split-right', 'close-pane', 'macos'],
      [{ 'toggle-sidebar': 'mod+k' }, 'command-palette', 'toggle-sidebar'],
      [{ 'zoom-reset': 'f5' }, 'zoom-reset', 'reload-guard'],
    ];
    for (const [overrides, winner, loser, only] of cases) {
      const { bindings } = resolveKeybindings(overrides);
      for (const platform of only ? [only] : ['macos', 'windows']) {
        const conflicts = findConflicts(bindings, { isMac: platform === 'macos' });
        assert.equal(conflicts.length, 1, `${platform} ${JSON.stringify(overrides)}: ${JSON.stringify(conflicts)}`);
        const [conflict] = conflicts;
        assert.equal(conflict.winner, winner, `${platform} ${JSON.stringify(overrides)}`);
        assert.equal(conflict.command, loser, `${platform} ${JSON.stringify(overrides)}`);
        assert.equal(conflict.commands[0], winner, 'the one that runs comes first');
        // And it is the truth: press either chord, and the winner runs.
        for (const key of [conflict.key, conflict.winnerKey]) {
          assert.equal(runsOn(key, platform, bindings), winner, `${platform}: ${key}`);
        }
      }
    }
  });

  test('CK-18: two chords of one command are not a conflict', () => {
    // Zoom In answers both ⌘= and ⌘⇧=; a command holding the same keypress
    // twice loses nothing.
    const { bindings } = resolveKeybindings({ 'toggle-sidebar': ['mod+b', 'ctrl+b'] });
    assert.deepEqual(findConflicts(bindings, { isMac: false }), []);
  });

  test('CK-19: the warning names the chord, the command it runs and the one it does not', () => {
    const { bindings } = resolveKeybindings({ 'open-recent': 'mod+alt+d' });
    const [conflict] = findConflicts(bindings, { isMac: false });
    assert.equal(
      describeConflict(conflict, { isMac: false }),
      'Ctrl+Alt+D runs Open Recent…, never Split Pane Right'
    );

    const folder = findConflicts(resolveKeybindings({ 'open-recent': 'mod+shift+o' }).bindings, { isMac: true })[0];
    assert.equal(describeConflict(folder, { isMac: true }), '⇧⌘O runs Open Folder…, never Open Recent…');
  });

  test('CK-28: whatever is rebound, a conflict is reported exactly when a binding\'s keypress runs another command', () => {
    // A seeded walk over rebinds, spelled the ways the recorder and a hand
    // edit spell them, checked against the window's own lookup. `blockReload`
    // arms the reload guard, as in a packaged build, so every binding can run.
    let seed = 20261007;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const CHORDS = [
      ...new Set(DEFAULT_KEYBINDINGS.map((b) => b.key)),
      'mod+alt+d', 'mod+d', 'mod+ctrl+j', 'mod+j', 'mod+cmd+j', 'ctrl+j', 'cmd+j', 'ctrl+b',
      'alt+a', 'shift+f5', 'mod+tab', 'ctrl+tab', 'mod+shift+backquote', 'ctrl+comma',
    ];
    const ids = configurableCommands().map((c) => c.id);
    for (let walk = 0; walk < 300; walk += 1) {
      const overrides = {};
      for (let n = 1 + Math.floor(random() * 4); n > 0; n -= 1) {
        overrides[pick(ids)] = random() < 0.3 ? [pick(CHORDS), pick(CHORDS)] : pick(CHORDS);
      }
      const { bindings } = resolveKeybindings(overrides);
      for (const platform of ['macos', 'windows']) {
        const conflicts = findConflicts(bindings, { isMac: platform === 'macos' });
        for (const binding of bindings) {
          const e = pressOn(binding.key, platform);
          const runs = findBinding(e, ctx(e, platform, { bindings, blockReload: true }))?.command;
          const reported = conflicts.find((c) => c.command === binding.command && c.key === binding.key);
          const where = `${platform} ${JSON.stringify(overrides)} ${binding.command}:${binding.key}`;
          if (runs === binding.command) assert.equal(reported, undefined, `${where} runs, yet is reported`);
          else assert.equal(reported?.winner, runs, `${where} runs ${runs}`);
        }
      }
    }
  });
});

describe('Recording a shortcut takes only something that can be one', () => {
  const MAC = { isMac: true };
  const WIN = { isMac: false };

  test('CK-20: Tab and Shift+Tab are never bound — they move focus on', () => {
    // Change on Find in Terminal, then Tab to move on: Tab was bound, and
    // since that command is claimed ahead of a focused terminal, Tab
    // completion stopped working in every shell and agent.
    for (const platform of [MAC, WIN]) {
      assert.deepEqual(recordKeydown(ev({ key: 'Tab', code: 'Tab' }), platform), { action: 'leave' });
      assert.deepEqual(recordKeydown(ev({ key: 'Tab', code: 'Tab', shiftKey: true }), platform), { action: 'leave' });
    }
    // With Ctrl it is a chord like any other.
    assert.deepEqual(recordKeydown(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }), WIN), { action: 'bind', key: 'mod+tab' });
    assert.deepEqual(recordKeydown(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }), MAC), { action: 'bind', key: 'ctrl+tab' });
  });

  test('CK-21: Escape stops recording, with or without modifiers, and binds nothing', () => {
    for (const fields of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      for (const platform of [MAC, WIN]) {
        assert.deepEqual(recordKeydown(ev({ key: 'Escape', code: 'Escape', ...fields }), platform), { action: 'cancel' });
      }
    }
  });

  test('CK-22: a key on its own is refused, F-keys apart, and Shift alone does not make a shortcut', () => {
    const typing = [
      ev({ key: 'a', code: 'KeyA' }),
      ev({ key: 'A', code: 'KeyA', shiftKey: true }),
      ev({ key: '7', code: 'Digit7' }),
      ev({ key: ',', code: 'Comma' }),
      ev({ key: '~', code: 'Backquote', shiftKey: true }),
      ev({ key: ' ', code: 'Space' }),
      ev({ key: 'Enter', code: 'Enter' }),
      ev({ key: 'Enter', code: 'Enter', shiftKey: true }),
      ev({ key: 'Backspace', code: 'Backspace' }),
      ev({ key: 'Delete', code: 'Delete' }),
      ev({ key: 'ArrowLeft', code: 'ArrowLeft' }),
      ev({ key: 'Home', code: 'Home' }),
    ];
    for (const e of typing) {
      for (const platform of [MAC, WIN]) {
        const outcome = recordKeydown(e, platform);
        assert.equal(outcome.action, 'refuse', `${JSON.stringify(e.key)}${e.shiftKey ? ' with Shift' : ''} must not be bound`);
        assert.match(outcome.reason, platform.isMac ? /⌘, ⌃ or ⌥/ : /Ctrl or Alt/, 'and the refusal says what would do');
      }
    }
    assert.deepEqual(recordKeydown(ev({ key: 'F2', code: 'F2' }), WIN), { action: 'bind', key: 'f2' });
    assert.deepEqual(recordKeydown(ev({ key: 'F5', code: 'F5', shiftKey: true }), WIN), { action: 'bind', key: 'shift+f5' });
    assert.deepEqual(recordKeydown(ev({ key: 'a', code: 'KeyA', altKey: true }), WIN), { action: 'bind', key: 'alt+a' });
    assert.deepEqual(recordKeydown(ev({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }), WIN), { action: 'bind', key: 'mod+shift+a' });
    assert.deepEqual(recordKeydown(ev({ key: 'a', code: 'KeyA', metaKey: true }), MAC), { action: 'bind', key: 'mod+a' });
    assert.deepEqual(recordKeydown(ev({ key: 'a', code: 'KeyA', ctrlKey: true }), MAC), { action: 'bind', key: 'ctrl+a' });
  });

  test('CK-23: every modifier held is kept, so the chord bound is the chord pressed', () => {
    // macOS: Ctrl+⌘+J was recorded as ⌘J, and plain ⌘J then ran it.
    const ctrlCmdJ = ev({ key: 'j', code: 'KeyJ', ctrlKey: true, metaKey: true });
    const recorded = recordKeydown(ctrlCmdJ, MAC);
    assert.deepEqual(recorded, { action: 'bind', key: 'mod+ctrl+j' });
    const { bindings } = resolveKeybindings({ 'toggle-panel': recorded.key });
    assert.equal(findBinding(ctrlCmdJ, ctx(ctrlCmdJ, 'macos', { bindings }))?.command, 'toggle-panel');
    const cmdJ = ev({ key: 'j', code: 'KeyJ', metaKey: true });
    assert.equal(findBinding(cmdJ, ctx(cmdJ, 'macos', { bindings })), null, 'plain ⌘J is another chord');

    // And off macOS the Windows key is not dropped either.
    const ctrlWinJ = ev({ key: 'j', code: 'KeyJ', ctrlKey: true, metaKey: true });
    const windows = recordKeydown(ctrlWinJ, WIN);
    assert.deepEqual(windows, { action: 'bind', key: 'mod+cmd+j' });
    const plainCtrlJ = ev({ key: 'j', code: 'KeyJ', ctrlKey: true });
    const onWindows = resolveKeybindings({ 'toggle-panel': windows.key }).bindings;
    assert.equal(findBinding(plainCtrlJ, ctx(plainCtrlJ, 'windows', { bindings: onWindows })), null, 'Ctrl+J is another chord');
  });

  test('CK-24: a key the chord grammar cannot name is refused, not saved as text that unbinds', () => {
    // `mod+capslock` does not parse: saved, it would leave the command with
    // no chord at all (CK-09), which is not what pressing a key asked for.
    for (const e of [
      ev({ key: 'CapsLock', code: 'CapsLock', ctrlKey: true }),
      ev({ key: 'Insert', code: 'Insert', ctrlKey: true }),
      ev({ key: 'ContextMenu', code: 'ContextMenu', altKey: true }),
    ]) {
      const outcome = recordKeydown(e, WIN);
      assert.equal(outcome.action, 'refuse', `${e.key}`);
      assert.match(outcome.reason, /cannot be part of a shortcut/);
    }
  });

  test('CK-25: nothing is decided while only modifiers are down, or while an IME composes', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'Dead', 'Process']) {
      assert.deepEqual(recordKeydown(ev({ key, ctrlKey: key === 'Control' }), WIN), { action: 'wait' }, key);
    }
    assert.deepEqual(recordKeydown(ev({ key: 'ㅁ', code: 'KeyA', isComposing: true }), MAC), { action: 'wait' });
    assert.deepEqual(recordKeydown(ev({ key: 'Process', code: 'KeyA', keyCode: 229 }), WIN), { action: 'wait' });
  });

  test('CK-26: recording for a command claimed over the terminal leaves Tab and typing to the shell', () => {
    // The whole sequence a user goes through: Change on Find in Terminal,
    // Tab (meant to move on), a letter (meant to type), then a real chord.
    // Only the chord is ever bound, and afterwards a focused terminal still
    // gets Tab and the letter.
    assert.ok(COMMANDS['find-in-terminal'].overTerminal, 'the premise: it is claimed over a terminal');
    let bound = null;
    for (const e of [
      ev({ key: 'Tab', code: 'Tab' }),
      ev({ key: 'g', code: 'KeyG' }),
      ev({ key: 'G', code: 'KeyG', shiftKey: true }),
      ev({ key: 'g', code: 'KeyG', ctrlKey: true, altKey: true }),
    ]) {
      const outcome = recordKeydown(e, WIN);
      if (outcome.action === 'bind') {
        bound = outcome.key;
        break;
      }
    }
    assert.equal(bound, 'mod+alt+g');
    const { bindings } = resolveKeybindings({ 'find-in-terminal': bound });
    for (const e of [ev({ key: 'Tab', code: 'Tab' }), ev({ key: 'g', code: 'KeyG' })]) {
      const shell = {
        ...e,
        preventDefault: () => assert.fail(`${e.key} was swallowed`),
        stopPropagation: () => assert.fail(`${e.key} never reached xterm`),
      };
      assert.equal(dispatchKeydownOverTerminal(shell, ctx(shell, 'windows', { bindings })), null, `${e.key} reaches the shell`);
    }
  });

  test('CK-27: the commands claimed over a terminal are read from the flags', () => {
    const ids = commandsOverTerminal().map((c) => c.id);
    const flagged = Object.entries(COMMANDS)
      .filter(([, spec]) => spec.overTerminal && spec.configurable !== false)
      .map(([id]) => id);
    assert.deepEqual(ids, flagged);
    assert.ok(ids.length > 2, 'more than the two side-bar toggles, which is what Settings used to say');
    for (const { id, title } of commandsOverTerminal()) assert.equal(title, COMMANDS[id].title);
  });
});
