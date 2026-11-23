/**
 * The kitty keyboard protocol, its first flag (bundle 4, A1): a program that
 * pushes it gets Shift+Enter as `CSI 13;2u`, Esc as `CSI 27u` and Ctrl+C as
 * `CSI 99;5u`; every other program, and every key the table leaves alone,
 * gets exactly the bytes it got before. See src/lib/kittyKeyboard.js.
 *
 * The table is kitty's own (docs/keyboard-protocol.rst and
 * kitty/key_encoding.c): only Enter, Tab and Backspace with no modifier keep
 * their legacy bytes. The stacks are followed through real xterm
 * (`@xterm/headless`, the same core and release as the app's
 * `@xterm/xterm`). The keys go through TerminalView's real key handler, cut
 * from TerminalView.jsx as modify_other_keys.test.js cuts it, with the real
 * modifyOtherKeys addon on the same terminal and the real Korean IME binding
 * in front of it. The registry's guards (a shell prompt, a new shell) are
 * driven through the same pieces the registry wires together, and the wiring
 * itself is checked by reading the source, as for modifyOtherKeys (MK-23).
 */
import { readFileSync } from 'node:fs';
// Static, as in modify_other_keys.test.js: other files in this runner
// register module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  KITTY_STACK_SIZE,
  KITTY_SUPPORTED_FLAGS,
  installKittyKeyboard,
  kittyKeySequence,
  kittySequence,
} from '../../src/lib/kittyKeyboard.js';
import { installModifyOtherKeys } from '../../src/lib/modifyOtherKeys.js';
import { isWindowCloseChord, legacyAltArrowSequence } from '../../src/lib/terminalCompat.js';
import { suggestionKeyAction, lineAfterKey, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';
import { macEditingKeySequence } from '../../src/lib/macEditingKeys.js';
import { typingHidden } from '../../src/lib/secretInput.js';
import { isReadOnly, readOnlyKeyAction } from '../../src/lib/readOnly.js';
import { installHangulInlineIme } from '../../src/lib/hangulInlineIme.js';
import { listenForPrompts } from '../../src/lib/promptMarks.js';
import { listen, mockBridge } from '../../src/lib/ipc.js';
import { SETTINGS_DEFAULTS, useSettingsStore } from '../../src/stores/settingsStore.js';
import { RECORDINGS } from './hangul_ime_recordings.js';

const { Terminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CSI = '\x1b[';

/** A real xterm 6 with the app's addon, every reply it sends collected. */
function terminal({ enabled = () => true, mac = false, imePending = null, modifyOtherKeys = false } = {}) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies = [];
  term.onData((data) => replies.push(data));
  const mok = modifyOtherKeys ? installModifyOtherKeys(term) : null;
  const kitty = installKittyKeyboard(term, { enabled, mac, imePending });
  return { term, kitty, mok, replies };
}

/** A keydown as the browser reports one (Enter unless said otherwise), recording how it was cancelled. */
const keydown = (over = {}) => ({
  type: 'keydown',
  key: 'Enter',
  code: 'Enter',
  keyCode: 13,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  defaultPrevented: false,
  stopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.stopped = true;
  },
  ...over,
});

/** The browser's fields for a key, by name. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  a: { key: 'a', code: 'KeyA', keyCode: 65 },
  c: { key: 'c', code: 'KeyC', keyCode: 67 },
  1: { key: '1', code: 'Digit1', keyCode: 49 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  '/': { key: '/', code: 'Slash', keyCode: 191 },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219 },
};
const key = (name, mods = {}) => keydown({ ...KEYS[name], ...mods });

// What each chord sends at flag 1 (AC1), off macOS or on it with Option as Meta.
const TABLE = [
  ['Enter', {}, null, "Enter: xterm's \\r"],
  ['Tab', {}, null, "Tab: xterm's \\t"],
  ['Backspace', {}, null, "Backspace: xterm's DEL"],
  ['Enter', { shiftKey: true }, `${CSI}13;2u`, 'Shift+Enter'],
  ['Enter', { altKey: true }, `${CSI}13;3u`, 'Alt+Enter'],
  ['Enter', { ctrlKey: true }, `${CSI}13;5u`, 'Ctrl+Enter'],
  ['Enter', { ctrlKey: true, shiftKey: true }, `${CSI}13;6u`, 'Ctrl+Shift+Enter'],
  ['Tab', { shiftKey: true }, `${CSI}9;2u`, 'Shift+Tab'],
  ['Tab', { ctrlKey: true }, `${CSI}9;5u`, 'Ctrl+Tab'],
  ['Backspace', { ctrlKey: true }, `${CSI}127;5u`, 'Ctrl+Backspace'],
  ['Backspace', { altKey: true }, `${CSI}127;3u`, 'Alt+Backspace'],
  ['Escape', {}, `${CSI}27u`, 'Esc'],
  ['Escape', { shiftKey: true }, `${CSI}27;2u`, 'Shift+Esc'],
  ['Escape', { ctrlKey: true }, `${CSI}27;5u`, 'Ctrl+Esc'],
  ['c', { ctrlKey: true }, `${CSI}99;5u`, 'Ctrl+C'],
  ['c', { ctrlKey: true, shiftKey: true, key: 'C' }, `${CSI}99;6u`, 'Ctrl+Shift+C'],
  ['a', { altKey: true }, `${CSI}97;3u`, 'Alt+A'],
  ['a', { ctrlKey: true, altKey: true }, `${CSI}97;7u`, 'Ctrl+Alt+A'],
  ['a', { shiftKey: true, altKey: true, key: 'A' }, `${CSI}97;4u`, 'Shift+Alt+A'],
  ['1', { ctrlKey: true }, `${CSI}49;5u`, 'Ctrl+1'],
  ['Space', { ctrlKey: true }, `${CSI}32;5u`, 'Ctrl+Space'],
  ['/', { ctrlKey: true }, `${CSI}47;5u`, 'Ctrl+/'],
  ['[', { altKey: true }, `${CSI}91;3u`, 'Alt+['],
];

describe('Kitty keyboard: what a key sends at flag 1 (AC1)', () => {
  test('KK-01: the pure table — Enter, Tab and Backspace alone keep their bytes; modified, Esc and Ctrl/Alt chords go as CSI u', () => {
    const rows = [
      [{ key: 'Enter' }, null],
      [{ key: 'Tab' }, null],
      [{ key: 'Backspace' }, null],
      [{ key: 'Enter', shift: true }, `${CSI}13;2u`],
      [{ key: 'Enter', alt: true }, `${CSI}13;3u`],
      [{ key: 'Enter', ctrl: true }, `${CSI}13;5u`],
      [{ key: 'Enter', ctrl: true, shift: true }, `${CSI}13;6u`],
      [{ key: 'Enter', ctrl: true, alt: true, shift: true }, `${CSI}13;8u`],
      [{ key: 'Tab', shift: true }, `${CSI}9;2u`],
      [{ key: 'Backspace', ctrl: true }, `${CSI}127;5u`],
      [{ key: 'Escape' }, `${CSI}27u`],
      [{ key: 'Escape', alt: true }, `${CSI}27;3u`],
      [{ key: 'c', ctrl: true }, `${CSI}99;5u`],
      [{ key: 'c', ctrl: true, shift: true }, `${CSI}99;6u`],
      [{ key: 'a', alt: true }, `${CSI}97;3u`],
      [{ key: 'a', alt: true, ctrl: true }, `${CSI}97;7u`],
      [{ key: 'a', alt: true, shift: true }, `${CSI}97;4u`],
      [{ key: 'a' }, null],
      [{ key: 'a', shift: true }, null],
      [{ key: ' ', shift: true }, null],
      [{ key: '\\', ctrl: true }, `${CSI}92;5u`],
      [{ key: "'", alt: true }, `${CSI}39;3u`],
      // Not keys of the table: a capital (Shift is its own field), shifted
      // punctuation, Hangul, a name xterm keeps.
      [{ key: 'A', ctrl: true }, null],
      [{ key: '?', ctrl: true }, null],
      [{ key: 'ㅊ', ctrl: true }, null],
      [{ key: 'ArrowUp', shift: true }, null],
      [{ key: 'F5', ctrl: true }, null],
      [{ key: 'Delete', ctrl: true }, null],
    ];
    for (const [descriptor, expected] of rows) {
      assert.equal(kittySequence(descriptor, 1), expected, JSON.stringify(descriptor));
    }
    for (const bad of [null, undefined, 'Enter', 5, {}, { key: 13, shift: true }, { key: 'Enter', shift: 'yes' }]) {
      assert.equal(kittySequence(bad, 1), null, JSON.stringify(bad));
    }
    assert.equal(KITTY_SUPPORTED_FLAGS, 1, 'flag 1, and no other');
  });

  test('KK-02: from a keydown, off macOS — every row of the table, and null for text, arrows, F-keys, the navigation keys and the keypad', () => {
    for (const [name, mods, expected, why] of TABLE) {
      assert.equal(kittyKeySequence(key(name, mods), 1, { mac: false }), expected, why);
      assert.equal(kittyKeySequence(key(name, mods), 1, { mac: true, optionAsMeta: true }), expected, `${why}, macOS with Option as Meta`);
    }
    // Every combination of Shift, Alt and Ctrl on the four functional keys, against the rule.
    for (const [name, number] of [['Enter', 13], ['Tab', 9], ['Backspace', 127], ['Escape', 27]]) {
      for (let bits = 0; bits < 8; bits += 1) {
        const mods = { shiftKey: !!(bits & 1), altKey: !!(bits & 2), ctrlKey: !!(bits & 4) };
        const modifiers = 1 + bits;
        const expected = bits === 0 && name !== 'Escape' ? null : `${CSI}${number}${modifiers > 1 ? `;${modifiers}` : ''}u`;
        assert.equal(kittyKeySequence(key(name, mods), 1), expected, `${name} ${JSON.stringify(mods)}`);
      }
    }
    const untouched = [
      [{ key: 'a', code: 'KeyA', keyCode: 65 }, 'a'],
      [{ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true }, 'Shift+A'],
      [{ key: '!', code: 'Digit1', keyCode: 49, shiftKey: true }, 'Shift+1'],
      [{ key: ' ', code: 'Space', keyCode: 32 }, 'Space'],
      [{ key: ' ', code: 'Space', keyCode: 32, shiftKey: true }, 'Shift+Space'],
      [{ key: '한', code: 'KeyG', keyCode: 71 }, 'a Hangul syllable'],
    ];
    for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'F1', 'F5', 'F12']) {
      for (const mods of [{}, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }]) {
        untouched.push([{ key: name, code: name, keyCode: 0, ...mods }, `${name} ${JSON.stringify(mods)}`]);
      }
    }
    for (const [k, code] of [['1', 'Numpad1'], ['+', 'NumpadAdd'], ['Enter', 'NumpadEnter'], ['/', 'NumpadDivide'], ['.', 'NumpadDecimal']]) {
      for (const mods of [{}, { shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
        untouched.push([{ key: k, code, keyCode: k === 'Enter' ? 13 : 0, location: 3, ...mods }, `keypad ${code} ${JSON.stringify(mods)}`]);
      }
    }
    for (const [fields, why] of untouched) {
      assert.equal(kittyKeySequence(keydown(fields), 1), null, why);
    }
  });

  test('KK-03: the key is named by event.code, and left to xterm where xterm names another key there', () => {
    // A Cyrillic layout: `key` is not ASCII, `code` and `keyCode` agree on C.
    assert.equal(kittyKeySequence(keydown({ key: 'с', code: 'KeyC', keyCode: 67, ctrlKey: true }), 1), `${CSI}99;5u`);
    // ⌥A on macOS with Option as Meta: WebKit still reports the ⌥ character.
    assert.equal(kittyKeySequence(keydown({ key: 'å', code: 'KeyA', keyCode: 65, altKey: true }), 1, { mac: true, optionAsMeta: true }), `${CSI}97;3u`);
    // AZERTY: the key labelled A sits where QWERTY has Q. xterm sends Ctrl+A
    // for it (keyCode 65); `code` alone would say Ctrl+Q — so it is xterm's.
    assert.equal(kittyKeySequence(keydown({ key: 'a', code: 'KeyQ', keyCode: 65, ctrlKey: true }), 1), null);
    assert.equal(kittyKeySequence(keydown({ key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true }), 1), `${CSI}97;5u`);
    // No keyCode to compare: `code` decides.
    assert.equal(kittyKeySequence(keydown({ key: 'x', code: 'KeyX', keyCode: undefined, ctrlKey: true }), 1), `${CSI}120;5u`);
    // No `code` at all (a synthetic event): the four functional keys by name, never the keypad's.
    assert.equal(kittyKeySequence(keydown({ key: 'Enter', code: '', keyCode: 13, shiftKey: true }), 1), `${CSI}13;2u`);
    assert.equal(kittyKeySequence(keydown({ key: 'Escape', code: undefined, keyCode: 27 }), 1), `${CSI}27u`);
    assert.equal(kittyKeySequence(keydown({ key: 'Enter', code: '', keyCode: 13, shiftKey: true, location: 3 }), 1), null);
    assert.equal(kittyKeySequence(keydown({ key: 'c', code: '', keyCode: 67, ctrlKey: true }), 1), null, 'a letter needs its code');
  });
});

describe('Kitty keyboard: never encoded (AC2)', () => {
  test('KK-10: no flag 1, ⌘, an IME, a Hangul key or syllable, AltGr, ⌥ as text, a password prompt, keyup and keypress — each against the same chord without it', () => {
    const chords = [
      key('Enter', { shiftKey: true }),
      key('Escape'),
      key('c', { ctrlKey: true }),
      key('Backspace', { ctrlKey: true }),
    ];
    for (const flags of [0, undefined, null, NaN, 2, 4, 8, 16, 30, '1', 1.5]) {
      for (const event of chords) assert.equal(kittyKeySequence(event, flags), null, `flags ${String(flags)}: not flag 1`);
    }
    for (const event of chords) {
      assert.ok(kittyKeySequence(event, 1), `${event.key} is encoded with nothing in the way`);
      assert.ok(kittyKeySequence(event, 3), 'flag 1 among others: encoded as flag 1');
      for (const [stop, context, why] of [
        [{ metaKey: true }, {}, '⌘: not a terminal key on macOS'],
        [{ isComposing: true }, {}, 'an IME composing'],
        [{ keyCode: 229 }, {}, 'an IME key'],
        [{}, { imePending: '한' }, 'a Korean syllable pending'],
        [{ getModifierState: (m) => m === 'AltGraph' }, {}, 'AltGr'],
        [{}, { secret: true }, 'a password prompt up'],
        [{ type: 'keyup' }, {}, 'keyup'],
        [{ type: 'keypress' }, {}, 'keypress'],
      ]) {
        assert.equal(kittyKeySequence({ ...event, ...stop }, 1, context), null, `${event.key} ${JSON.stringify(event.ctrlKey)}: ${why}`);
      }
    }
    // The Korean input source, recorded: Ctrl+C arrives as key ㅊ, code KeyC,
    // keyCode 67 (hangul_ime_recordings.js s11). xterm sends 0x03 for it.
    const recorded = RECORDINGS.s11_han_ctrlc.find((row) => row[0] === 'kd' && row[1] === 'ㅊ');
    assert.deepEqual(recorded, ['kd', 'ㅊ', 67, 'KeyC', 'c'], 'the recording is what it was');
    assert.equal(kittyKeySequence(keydown({ key: 'ㅊ', code: 'KeyC', keyCode: 67, ctrlKey: true }), 1), null, 'a Hangul key');
    assert.equal(kittyKeySequence(keydown({ key: 'ㅎ', code: 'KeyG', keyCode: 229 }), 1), null);
    // macOS, Option as Meta off: ⌥ types characters, and ⌥Enter stays ESC CR.
    for (const event of [key('a', { altKey: true, key: 'å' }), key('Enter', { altKey: true }), key('a', { altKey: true, ctrlKey: true }), key('Escape', { altKey: true }), key('Enter', { altKey: true, shiftKey: true })]) {
      assert.equal(kittyKeySequence(event, 1, { mac: true, optionAsMeta: false }), null, `macOS ⌥ ${event.key}, Option as Meta off`);
      assert.ok(kittyKeySequence(event, 1, { mac: true, optionAsMeta: true }), `macOS ⌥ ${event.key}, Option as Meta on`);
      assert.ok(kittyKeySequence(event, 1, { mac: false }), `Alt ${event.key} elsewhere`);
    }
    // Without ⌥, macOS is no different.
    assert.equal(kittyKeySequence(key('Enter', { shiftKey: true }), 1, { mac: true }), `${CSI}13;2u`);
    assert.equal(kittyKeySequence(key('c', { ctrlKey: true }), 1, { mac: true }), `${CSI}99;5u`);
  });

  test('KK-11: an event that cannot be read is left to xterm, and nothing throws', () => {
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args);
    try {
      const broken = { type: 'keydown', shiftKey: true, get key() { throw new Error('gone'); } };
      assert.equal(kittyKeySequence(broken, 1), null);
      const brokenCode = { ...key('Escape'), get code() { throw new Error('gone'); } };
      assert.equal(kittyKeySequence(brokenCode, 1), null);
      const brokenState = { ...key('Escape'), getModifierState() { throw new Error('gone'); } };
      assert.equal(kittyKeySequence(brokenState, 1), null);
      assert.equal(warned.length, 3, 'each said so');
      for (const nothing of [null, undefined, 0, 'Enter']) assert.equal(kittyKeySequence(nothing, 1), null);
    } finally {
      console.warn = warn;
    }
  });
});

describe('Kitty keyboard: the protocol, through real xterm (AC3)', () => {
  test('KK-20: xterm.js 6.0 alone does not answer CSI ? u; with the addon it is answered ESC [?0u, out the way xterm replies go', async () => {
    const bare = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const bareReplies = [];
    bare.onData((d) => bareReplies.push(d));
    try {
      await write(bare, '\x1b[?u\x1b[>1u\x1b[?u');
      assert.deepEqual(bareReplies, [], 'no reply without the addon');
    } finally {
      bare.dispose();
    }

    const { term, kitty, replies } = terminal();
    try {
      assert.ok(kitty, 'installed on a real xterm');
      assert.equal(kitty.flags, 0, 'nothing pushed yet');
      await write(term, '\x1b[?u');
      assert.deepEqual(replies, ['\x1b[?0u']);
    } finally {
      term.dispose();
    }

    // Not as typed input: `term.input(reply, false)`.
    const handlers = new Map();
    const fake = {
      inputs: [],
      parser: {
        registerCsiHandler: ({ prefix, final }, fn) => {
          handlers.set(`${prefix}${final}`, fn);
          return { dispose() {} };
        },
      },
      input(data, wasUserInput) {
        this.inputs.push([data, wasUserInput]);
      },
      loadAddon(addon) {
        addon.activate(this);
      },
    };
    const addon = installKittyKeyboard(fake);
    assert.ok(addon, 'a terminal with no buffer events or ESC handlers still gets the parser half');
    assert.deepEqual([...handlers.keys()].sort(), ['<u', '=u', '>u', '?u'], 'the four prefixed forms, and never an un-prefixed u');
    assert.equal(handlers.get('?u')([0]), true);
    assert.deepEqual(fake.inputs, [['\x1b[?0u', false]]);
  });

  test('KK-21: push, pop and query — only flag 1 is ever reported; a pop with no count pops one, more than there are empties it', async () => {
    const { term, kitty, replies } = terminal();
    try {
      const steps = [
        ['\x1b[>31u', 1, 'push 31 (every flag): only flag 1 is applied'],
        ['\x1b[>u', 0, 'push with no flags pushes 0'],
        ['\x1b[<u', 1, 'pop with no count pops one'],
        ['\x1b[>2u', 0, 'push 2 (flag 2 alone): nothing NexTerm applies'],
        ['\x1b[>1u', 1, 'push 1'],
        ['\x1b[<2u', 1, 'pop 2'],
        ['\x1b[<1u', 0, 'popped to empty: 0'],
        ['\x1b[>1u\x1b[>1u', 1, 'two pushes'],
        ['\x1b[<9u', 0, 'a pop larger than the stack empties it'],
        ['\x1b[<u', 0, 'a pop of an empty stack'],
      ];
      for (const [sequence, flags, why] of steps) {
        await write(term, `${sequence}\x1b[?u`);
        assert.equal(kitty.flags, flags, why);
        assert.equal(replies.at(-1), `\x1b[?${flags}u`, `${why}: the reply`);
      }
      assert.equal(replies.length, steps.length, 'one reply per query');
    } finally {
      term.dispose();
    }
  });

  test('KK-22: set — mode 1 assigns, 2 adds the bits, 3 takes them away; on the top entry, made when the stack is empty', async () => {
    const { term, kitty } = terminal();
    try {
      const steps = [
        ['\x1b[=1u', 1, 'set 1 on an empty stack makes its entry'],
        ['\x1b[<u', 0, 'and that entry is the one a pop takes'],
        ['\x1b[=1;1u', 1, 'mode 1 explicitly'],
        ['\x1b[=0u', 0, 'mode 1: unset bits reset'],
        ['\x1b[=1;2u', 1, 'mode 2: set bits set'],
        ['\x1b[=2;2u', 1, 'mode 2: others unchanged'],
        ['\x1b[=2;3u', 1, 'mode 3: only the bits given are reset'],
        ['\x1b[=1;3u', 0, 'mode 3: flag 1 reset'],
        ['\x1b[=31;2u', 1, 'mode 2 with every flag: flag 1 only'],
        ['\x1b[=1;u', 1, 'an empty mode is the default, 1'],
        ['\x1b[=6;1u', 0, 'mode 1 with flags NexTerm does not apply'],
      ];
      for (const [sequence, flags, why] of steps) {
        await write(term, sequence);
        assert.equal(kitty.flags, flags, why);
      }
      // A set changes the top entry, never pushes one.
      await write(term, '\x1b[<9u\x1b[>1u\x1b[>0u\x1b[=1u');
      assert.equal(kitty.flags, 1);
      await write(term, '\x1b[<u');
      assert.equal(kitty.flags, 1, 'the entry below was untouched');
      await write(term, '\x1b[<u');
      assert.equal(kitty.flags, 0, 'and there were only two');
    } finally {
      term.dispose();
    }
  });

  test('KK-23: the main and the alternate screen keep stacks of their own', async () => {
    const { term, kitty, replies } = terminal();
    try {
      await write(term, '\x1b[>1u');
      assert.equal(kitty.flags, 1, 'pushed on the main screen');
      await write(term, '\x1b[?1049h\x1b[?u');
      assert.equal(kitty.flags, 0, "the alternate screen's own stack is empty");
      assert.equal(replies.at(-1), '\x1b[?0u', 'and the query answers for the screen it is asked on');
      await write(term, '\x1b[>1u\x1b[>1u\x1b[<u');
      assert.equal(kitty.flags, 1, 'pushed and popped on the alternate screen');
      await write(term, '\x1b[<u');
      assert.equal(kitty.flags, 0);
      await write(term, '\x1b[?1049l\x1b[?u');
      assert.equal(kitty.flags, 1, "the main screen's flag was never touched");
      assert.equal(replies.at(-1), '\x1b[?1u');
    } finally {
      term.dispose();
    }
  });

  test(`KK-24: each stack keeps ${KITTY_STACK_SIZE} entries; the 17th push evicts the oldest`, async () => {
    const { term, kitty } = terminal();
    try {
      assert.equal(KITTY_STACK_SIZE, 16);
      // 1 first, then 15 zeros: 16 entries, the 1 still at the bottom.
      await write(term, `\x1b[>1u${'\x1b[>0u'.repeat(15)}`);
      assert.equal(kitty.flags, 0);
      await write(term, '\x1b[<15u');
      assert.equal(kitty.flags, 1, 'sixteen fit');
      // 1 first, then 16 zeros: the 1 is evicted.
      await write(term, `\x1b[<99u\x1b[>1u${'\x1b[>0u'.repeat(16)}\x1b[<15u`);
      assert.equal(kitty.flags, 0, 'the oldest, the 1, was evicted');
      await write(term, '\x1b[<u');
      assert.equal(kitty.flags, 0, 'and the stack is empty after sixteen pops');
      // Ten thousand pushes stay sixteen entries.
      await write(term, '\x1b[>1u'.repeat(10000));
      await write(term, '\x1b[<16u');
      assert.equal(kitty.flags, 0);
    } finally {
      term.dispose();
    }
  });

  test('KK-25: parameters the protocol does not define change nothing, and nothing throws into the parser', async () => {
    const { term, kitty, replies } = terminal();
    try {
      await write(term, '\x1b[>1u');
      for (const sequence of [
        '\x1b[>0:1u', // a sub-parameter
        '\x1b[>0;0u', // a second parameter push does not take
        '\x1b[<1;1u',
        '\x1b[<1:2u',
        '\x1b[=0;4u', // an unknown mode
        '\x1b[=0;9u',
        '\x1b[=0;1;1u', // three parameters
        '\x1b[=0:1u',
        '\x1b[=0;1:2u',
        '\x1b[?1u', // a query takes no parameter
        '\x1b[?0;0u',
      ]) {
        await write(term, sequence);
        assert.equal(kitty.flags, 1, `${JSON.stringify(sequence)} leaves it as it was`);
      }
      assert.deepEqual(replies, [], 'a query with a parameter is not answered');
      await write(term, 'x');
      assert.equal(term.buffer.active.getLine(0).translateToString(true), 'x', 'xterm still parses');
    } finally {
      term.dispose();
    }

    // Straight at the handlers: anything at all, and a reply that cannot be sent.
    const handlers = new Map();
    const throwing = {
      parser: {
        registerCsiHandler: ({ prefix, final }, fn) => {
          handlers.set(`${prefix}${final}`, fn);
          return { dispose() {} };
        },
        registerEscHandler: ({ final }, fn) => {
          handlers.set(`ESC ${final}`, fn);
          return { dispose() {} };
        },
      },
      buffer: {
        get active() {
          throw new Error('gone');
        },
        onBufferChange: (fn) => {
          handlers.set('buffer', fn);
          return { dispose() {} };
        },
      },
      input() {
        throw new Error('pty gone');
      },
      loadAddon(addon) {
        addon.activate(this);
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const addon = installKittyKeyboard(throwing);
      for (const params of [undefined, null, 'x', [], [[1]], [NaN], [-1], [1.5], [1, [2]], [2 ** 31]]) {
        for (const k of ['?u', '>u', '<u', '=u']) {
          const handled = handlers.get(k)(params);
          assert.equal(typeof handled, 'boolean', `${k} ${JSON.stringify(params)}`);
        }
      }
      assert.equal(handlers.get('?u')([0]), false, 'a reply that cannot be sent');
      assert.equal(handlers.get('ESC c')(), false, 'RIS is still xterm\'s to carry out');
      for (const buffer of [undefined, null, { type: 'normal' }, { type: 'alternate' }]) handlers.get('buffer')(buffer);
      assert.equal(addon.flags, 0, 'a screen that cannot be read is no flags');
      assert.equal(addon.sequenceFor(key('Escape')), null);
      assert.equal(addon.sequenceFor(null), null);
    } finally {
      console.warn = warn;
    }
    assert.equal(installKittyKeyboard({}), null, 'a terminal without a parser (a test double) gets nothing');
    assert.equal(installKittyKeyboard(null), null);
  });

  test("KK-26: un-prefixed CSI u is still xterm's restore-cursor, and CSI s its save", async () => {
    const { term, kitty } = terminal();
    try {
      const reached = [];
      // Registered after the addon, so asked first: it sees every `u` the
      // parser has, and hands it on.
      term.parser.registerCsiHandler({ final: 'u' }, (params) => {
        reached.push(JSON.stringify(params));
        return false;
      });
      await write(term, '\x1b[3;5H\x1b[s\x1b[10;20H\x1b[u');
      const b = term.buffer.active;
      assert.deepEqual([b.cursorX, b.cursorY], [4, 2], 'the cursor is back where `CSI s` saved it');
      assert.deepEqual(reached, ['[0]'], 'the un-prefixed form reached xterm');
      assert.equal(kitty.flags, 0, 'and changed no flag');
    } finally {
      term.dispose();
    }
  });
});

describe('Kitty keyboard: the guards (AC4)', () => {
  test('KK-30: leaving the alternate screen empties its stack — whichever way it is left — and entering it changes nothing', async () => {
    const { term, kitty } = terminal();
    try {
      for (const [enter, leave] of [
        ['\x1b[?1049h', '\x1b[?1049l'],
        ['\x1b[?1047h', '\x1b[?1047l'],
        ['\x1b[?47h', '\x1b[?47l'],
      ]) {
        await write(term, `${enter}\x1b[>1u`);
        assert.equal(kitty.flags, 1, `pushed after ${JSON.stringify(enter)}`);
        // It crashed with a handler that put the screen back and nothing else.
        await write(term, leave);
        assert.equal(kitty.flags, 0, `${JSON.stringify(leave)}: the shell after it gets \\x03 for Ctrl+C`);
        await write(term, enter);
        assert.equal(kitty.flags, 0, 'and the next full-screen program starts from nothing');
        await write(term, leave);
      }
      // The main screen's own entry survives a full-screen program.
      await write(term, '\x1b[>1u\x1b[?1049h\x1b[>1u\x1b[?1049l');
      assert.equal(kitty.flags, 1);
    } finally {
      term.dispose();
    }
  });

  test('KK-31: a reset — RIS, which `reset` sends, or term.reset() — empties both stacks, from either screen', async () => {
    const { term, kitty } = terminal();
    try {
      await write(term, '\x1b[>1u');
      await write(term, '\x1bc');
      assert.equal(kitty.flags, 0, 'RIS on the normal screen');
      await write(term, '\x1b[>1u\x1b[?1049h\x1b[>1u');
      assert.equal(kitty.flags, 1, 'a program killed with its alternate screen still up');
      await write(term, '\x1bc');
      assert.equal(term.buffer.active.type, 'normal');
      assert.equal(kitty.flags, 0, 'RIS from the alternate screen: the main stack too');
      await write(term, '\x1b[>1u');
      term.reset();
      assert.equal(kitty.flags, 0, '`term.reset()`');
    } finally {
      term.dispose();
    }
  });

  test('KK-32: reset() empties both stacks; dispose takes the handlers with it', async () => {
    const { term, kitty, replies } = terminal();
    try {
      await write(term, '\x1b[>1u\x1b[?1049h\x1b[>1u');
      kitty.reset();
      assert.equal(kitty.flags, 0);
      await write(term, '\x1b[?1049l');
      assert.equal(kitty.flags, 0, 'the main stack as well');
      await write(term, '\x1b[>1u');
      kitty.dispose();
      assert.equal(kitty.flags, 0);
      await write(term, '\x1b[>1u\x1b[?u');
      assert.equal(kitty.flags, 0, 'its handlers are gone');
      assert.deepEqual(replies, [], 'nothing answers the query any more');
    } finally {
      term.dispose();
    }
    // Through `loadAddon`, so the terminal's own dispose reaches it.
    const other = terminal();
    await write(other.term, '\x1b[>1u');
    assert.equal(other.kitty.sequenceFor(key('Escape')), `${CSI}27u`);
    other.term.dispose();
    assert.equal(other.kitty.flags, 0);
    assert.equal(other.kitty.sequenceFor(key('Escape')), null);
  });

  test('KK-33: the setting off — the query unanswered, nothing tracked, what was held dropped at once; a setting that cannot be read is off', async () => {
    let on = true;
    const { term, kitty, replies } = terminal({ enabled: () => on });
    try {
      await write(term, '\x1b[>1u');
      assert.equal(kitty.sequenceFor(key('Enter', { shiftKey: true })), `${CSI}13;2u`);
      on = false;
      assert.equal(kitty.flags, 0, 'dropped the moment it is read');
      assert.equal(kitty.sequenceFor(key('Enter', { shiftKey: true })), null, "Shift+Enter is xterm's \\r again");
      await write(term, '\x1b[?u\x1b[>1u\x1b[?u');
      assert.deepEqual(replies, [], 'the query goes unanswered, as before');
      on = true;
      assert.equal(kitty.flags, 0, 'nothing was tracked while off');
      await write(term, '\x1b[?u');
      assert.deepEqual(replies, ['\x1b[?0u']);
    } finally {
      term.dispose();
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
      const broken = terminal({
        enabled: () => {
          throw new Error('no settings');
        },
      });
      await write(broken.term, '\x1b[>1u\x1b[?u');
      assert.equal(broken.kitty.flags, 0);
      assert.deepEqual(broken.replies, [], 'off: unanswered');
      broken.term.dispose();
    } finally {
      console.warn = warn;
    }
    // The app's setting: on by default; the registry reads it at each sequence and key.
    assert.equal(SETTINGS_DEFAULTS.terminalKittyKeyboard, true, 'on by default');
    assert.equal(useSettingsStore.getState().settingsDefaults.terminalKittyKeyboard, true);
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(registry, /enabled: \(\) => useSettingsStore\.getState\(\)\.terminalKittyKeyboard !== false,/);
  });

  test("KK-34: the shell's prompt (OSC 133 D) for the terminal's session empties both stacks, once xterm has read what came before it", async () => {
    // The registry's listener, as `ensureKittyKeyboardResets` wires it: the
    // one `listenForPrompts`, each entry reset through `afterOutputSoFar`,
    // whose part here is xterm's write queue.
    const own = { sessionId: 'kk-s1', disposed: false, ...terminal() };
    const other = { sessionId: 'kk-s2', disposed: false, ...terminal() };
    const gone = { sessionId: 'kk-s1', disposed: true, ...terminal() };
    for (const entry of [own, other, gone]) entry.kittyKeyboard = entry.kitty;
    const pending = [];
    const mark = (entry) => {
      pending.push(new Promise((resolve) => entry.term.write('', () => resolve(entry.kittyKeyboard?.reset()))));
    };
    const unlisten = await listenForPrompts({ listen, entries: () => [own, other, gone].values(), mark });
    try {
      for (const entry of [own, other, gone]) await write(entry.term, '\x1b[>1u\x1b[?1049h\x1b[>1u\x1b[?1049l');
      // Claude Code died without popping; its last output — one more push —
      // is still waiting to be parsed when the shell's D arrives.
      own.term.write('\x1b[>1u');
      await mockBridge.emit('pty-command-done', { session_id: 'kk-s1', exit_code: 137 });
      await Promise.all(pending.splice(0));
      assert.equal(own.kitty.flags, 0, 'the prompt: Ctrl+C is 0x03 again');
      await write(own.term, '\x1b[?1049h');
      assert.equal(own.kitty.flags, 0, 'the alternate stack too');
      await write(own.term, '\x1b[?1049l');
      assert.equal(other.kitty.flags, 1, "another session's terminal keeps its flags");
      assert.equal(gone.kitty.flags, 1, 'a disposed terminal is skipped');
      // A shell that pushes at its own prompt (after its D) keeps what it pushed.
      own.term.write('\x1b[>1u');
      await mockBridge.emit('pty-command-done', { session_id: 'kk-s2', exit_code: 0 });
      await Promise.all(pending.splice(0));
      assert.equal(own.kitty.flags, 1);
      assert.equal(other.kitty.flags, 0);
      await mockBridge.emit('pty-command-done', {});
      await Promise.all(pending.splice(0));
      assert.equal(own.kitty.flags, 1, 'a D with no session resets nothing');
    } finally {
      unlisten?.();
      for (const entry of [own, other, gone]) entry.term.dispose();
    }

    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(
      registry,
      /kittyResetListening = listenForPrompts\(\{\s*listen,\s*entries: \(\) => instances\.values\(\),\s*mark: \(entry\) => afterOutputSoFar\(entry, \(e\) => e\.kittyKeyboard\?\.reset\(\)\),/,
      'the registry resets every live terminal of the session through afterOutputSoFar'
    );
    assert.match(registry, /\n\}\nensureKittyKeyboardResets\(\);\n/, 'started when the module loads');
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    assert.ok(create.indexOf('ensureKittyKeyboardResets();') > 0, 'and again as each terminal is made');
  });

  test('KK-35: a new shell bound to the terminal empties both stacks — now, and again once xterm has read what the old shell printed', async () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    const bind = registry.slice(registry.indexOf('function bindSession('), registry.indexOf('export function getOrCreateTerminal('));
    const replacing = bind.indexOf('if (entry.sessionId && entry.sessionId !== sessionId) {');
    const reset = bind.indexOf('resetKittyKeyboard(entry);');
    assert.ok(replacing > 0 && reset > replacing, 'when a shell replaces another');
    assert.ok(reset < bind.indexOf('entry.term.write(freshScreen(entry.term.rows))'), 'before the new screen is made ready');
    assert.ok(reset < bind.indexOf('attachOutput('), 'and before the new output is attached');

    // The registry's own `resetKittyKeyboard`, cut from the source and run on a real xterm.
    const start = registry.indexOf('function resetKittyKeyboard(entry) {');
    const end = registry.indexOf('\n}\n', start) + 2;
    assert.ok(start > 0 && end > start, 'resetKittyKeyboard is where it was');
    const resetKittyKeyboard = new Function(`${registry.slice(start, end)}\nreturn resetKittyKeyboard;`)();
    const { term, kitty } = terminal();
    try {
      await write(term, '\x1b[>1u\x1b[?1049h\x1b[>1u');
      // The old shell's last output, a push, not parsed yet.
      term.write('\x1b[>1u');
      resetKittyKeyboard({ term, kittyKeyboard: kitty });
      assert.equal(kitty.flags, 0, 'now, for a key pressed before xterm catches up');
      await write(term, '');
      assert.equal(kitty.flags, 0, 'the push parsed after it did not bring the flags back');
      await write(term, '\x1b[?1049l');
      assert.equal(kitty.flags, 0, 'the main stack too');
      // The new shell's output comes after: what it pushes stands.
      await write(term, '\x1b[>1u');
      assert.equal(kitty.flags, 1);
      resetKittyKeyboard({ term, kittyKeyboard: null });
      resetKittyKeyboard(null);
      const warn = console.warn;
      console.warn = () => {};
      try {
        resetKittyKeyboard({ term: {}, kittyKeyboard: kitty });
      } finally {
        console.warn = warn;
      }
      assert.equal(kitty.flags, 0, 'a terminal that cannot be written to is still reset at once');
    } finally {
      term.dispose();
    }
  });
});

/**
 * TerminalView's real key handler, run outside React as MK-20 runs it: the
 * code from `sendLegacyAltArrow` to the `attachCustomKeyEventHandler` call,
 * compiled with what it closes over handed in. `entry.kittyKeyboard` and
 * `entry.modifyOtherKeys` are the addons of a real xterm. A name the handler
 * starts to read that is not handed in throws.
 */
function keyHandler({ kittyKeyboard = null, modifyOtherKeys = null, secret = false, readOnly = false, mac = true, alternate = false, onInput = () => {} } = {}) {
  const src = read('../../src/components/terminal/TerminalView.jsx');
  const start = src.indexOf('const sendLegacyAltArrow = (event) => {');
  const end = src.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent);', start);
  assert.ok(start > 0 && end > start, 'the key handler is where it was');
  const calls = { input: [], readOnlyNotes: 0 };
  const scope = {
    legacyAltArrowSequence,
    isWindowCloseChord,
    isWindows: false,
    isMac: mac,
    entry: {
      term: {
        input: (data, wasUserInput) => {
          calls.input.push([data, wasUserInput]);
          onInput(data);
        },
        hasSelection: () => false,
      },
      modifyOtherKeys,
      kittyKeyboard,
    },
    handleClipboardKey,
    isFindOpen: () => false,
    suggestionKeyAction,
    suggestStateRef: { current: { visible: false, items: [] } },
    isRunning: () => true,
    isAlternate: () => alternate,
    lineRef: { current: NEW_LINE },
    lineAfterKey,
    setSuggestState: () => {},
    writeRaw: () => {},
    tabId: 'tab-1',
    EMPTY_SUGGEST_STATE: { visible: false, items: [] },
    macEditingKeySequence,
    typingHidden,
    useSettingsStore: { getState: () => ({ terminalMacEditingKeys: true }) },
    useTerminalStore: {
      getState: () => ({
        secretInput: secret ? { 'tab-1': true } : {},
        // Read-only (bundle 4, A3), asked right after the clipboard keys: the
        // store's `readOnlyKey`, as it decides, counting what it would say.
        readOnlyKey: (tabId, event, options) => {
          if (!isReadOnly({ readOnly: readOnly ? { 'tab-1': true } : {} }, tabId)) return null;
          const action = readOnlyKeyAction(event, options);
          if (action === 'cancel' && event.type === 'keydown') calls.readOnlyNotes += 1;
          return action;
        },
      }),
    },
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `${src.slice(start, end)}\nreturn handleKeyEvent;`);
  return { handleKeyEvent: make(...names.map((name) => scope[name])), calls };
}

/** One key through the handler: whether xterm still gets it, what was sent, and whether it was cancelled. */
function press(event, options) {
  const { handleKeyEvent, calls } = keyHandler(options);
  const toXterm = handleKeyEvent(event);
  return { toXterm, input: calls.input, cancelled: event.defaultPrevented && event.stopped, readOnlyNotes: calls.readOnlyNotes };
}

describe("Kitty keyboard: TerminalView's key handler, beside modifyOtherKeys (AC5)", () => {
  test('KK-40: with kitty 1 and modifyOtherKeys 2 both on, Shift+Enter is ESC [13;2u; with kitty 0 and modifyOtherKeys 1 it is still ESC [27;2;13~', async () => {
    const { term, kitty, mok } = terminal({ modifyOtherKeys: true, mac: true });
    try {
      // Nothing asked: every key is xterm's.
      for (const event of [key('Enter', { shiftKey: true }), key('Escape'), key('c', { ctrlKey: true }), key('Enter')]) {
        const r = press(event, { kittyKeyboard: kitty, modifyOtherKeys: mok });
        assert.equal(r.toXterm, true, `${event.key} with nothing asked`);
        assert.deepEqual(r.input, []);
      }
      // What Claude Code may do once `CSI ? u` is answered: both.
      await write(term, '\x1b[>4;2m\x1b[>1u');
      assert.equal(mok.level, 2);
      assert.equal(kitty.flags, 1);
      for (const [event, sequence] of [
        [key('Enter', { shiftKey: true }), `${CSI}13;2u`],
        [key('Enter', { ctrlKey: true }), `${CSI}13;5u`],
        [key('Escape'), `${CSI}27u`],
        [key('c', { ctrlKey: true }), `${CSI}99;5u`],
        [key('Tab', { shiftKey: true }), `${CSI}9;2u`],
        [key('Backspace', { ctrlKey: true }), `${CSI}127;5u`],
      ]) {
        const r = press(event, { kittyKeyboard: kitty, modifyOtherKeys: mok });
        assert.equal(r.toXterm, false, `${JSON.stringify(sequence)}: xterm does not send its own as well`);
        assert.deepEqual(r.input, [[sequence, true]], 'sent once, as a keystroke');
        assert.ok(r.cancelled, 'cancelled, as xterm cancels a key it sends');
      }
      for (const event of [key('Enter'), key('Tab'), key('Backspace'), key('a'), keydown({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, shiftKey: true })]) {
        const r = press(event, { kittyKeyboard: kitty, modifyOtherKeys: mok });
        assert.equal(r.toXterm, true, `${event.key}: still xterm's`);
        assert.deepEqual(r.input, []);
      }
      // A password prompt: getpass gets the bytes it always got; modifyOtherKeys' Enter is as it was.
      const secret = press(key('c', { ctrlKey: true }), { kittyKeyboard: kitty, modifyOtherKeys: mok, secret: true });
      assert.equal(secret.toXterm, true, "Ctrl+C at a password prompt: xterm's 0x03");
      assert.deepEqual(secret.input, []);
      // The program pops: modifyOtherKeys alone, exactly as before.
      await write(term, '\x1b[<u\x1b[>4;1m');
      assert.equal(kitty.flags, 0);
      const before = press(key('Enter', { shiftKey: true }), { kittyKeyboard: kitty, modifyOtherKeys: mok });
      assert.deepEqual(before.input, [['\x1b[27;2;13~', true]], 'kitty 0, modifyOtherKeys 1: CSI 27;2;13~');
      const esc = press(key('Escape'), { kittyKeyboard: kitty, modifyOtherKeys: mok });
      assert.equal(esc.toXterm, true, "Esc: xterm's ESC");
      assert.deepEqual(esc.input, []);
    } finally {
      term.dispose();
    }
    // No addon at all (a test double) is no different from flags 0.
    const none = press(key('Escape'), {});
    assert.equal(none.toXterm, true);
    assert.deepEqual(none.input, []);
  });

  test('KK-43: a read-only terminal (A3) sends no kitty key — Shift+Enter, Esc and Ctrl+C are cancelled and say why; ⌘ chords and Shift+PageUp are not', async () => {
    const { term, kitty, mok } = terminal({ modifyOtherKeys: true, mac: true });
    try {
      await write(term, '\x1b[>4;2m\x1b[>1u');
      assert.equal(kitty.flags, 1);
      for (const event of [key('Enter', { shiftKey: true }), key('Escape'), key('c', { ctrlKey: true }), key('Enter'), keydown({ key: 'x', code: 'KeyX', keyCode: 88 }), key('Tab')]) {
        const r = press(event, { kittyKeyboard: kitty, modifyOtherKeys: mok, readOnly: true });
        assert.equal(r.toXterm, false, `${event.key}: kept from xterm`);
        assert.deepEqual(r.input, [], `${event.key}: nothing sent`);
        assert.equal(r.cancelled, true, `${event.key}: cancelled`);
        assert.equal(r.readOnlyNotes, 1, `${event.key}: said`);
      }
      const page = press(keydown({ key: 'PageUp', code: 'PageUp', keyCode: 33, shiftKey: true }), { kittyKeyboard: kitty, readOnly: true });
      assert.equal(page.toXterm, true, 'Shift+PageUp scrolls, as xterm does');
      const cmd = press(keydown({ key: 'k', code: 'KeyK', keyCode: 75, metaKey: true }), { kittyKeyboard: kitty, readOnly: true });
      assert.equal(cmd.toXterm, false);
      assert.equal(cmd.cancelled, false, 'a ⌘ chord goes on as it went');
      assert.equal(cmd.readOnlyNotes, 0);
      const shift = press(keydown({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true }), { kittyKeyboard: kitty, readOnly: true });
      assert.equal(shift.readOnlyNotes, 0, 'a modifier alone says nothing');
      // Read-only off: exactly as KK-40.
      assert.deepEqual(press(key('Enter', { shiftKey: true }), { kittyKeyboard: kitty, modifyOtherKeys: mok }).input, [[`${CSI}13;2u`, true]]);
    } finally {
      term.dispose();
    }
  });

  test('KK-41: the ⌘ editing keys yield to kitty flags as to modifyOtherKeys; ⌥ follows Option as Meta at the key', async () => {
    const cmd = (name, keyCode) => keydown({ key: name, code: name, keyCode, metaKey: true });
    // macEditingKeySequence itself.
    assert.equal(macEditingKeySequence(cmd('ArrowLeft', 37), { mac: true, kittyFlags: 0 }), '\x01');
    for (const kittyFlags of [1, 3]) {
      assert.equal(macEditingKeySequence(cmd('ArrowLeft', 37), { mac: true, kittyFlags }), null, `kitty flags ${kittyFlags}`);
      assert.equal(macEditingKeySequence(cmd('Backspace', 8), { mac: true, kittyFlags, secret: true }), null);
    }
    assert.equal(macEditingKeySequence(cmd('ArrowRight', 39), { mac: true }), '\x05', 'no kitty flags given: as before');

    const { term, kitty } = terminal({ mac: true });
    try {
      const before = press(cmd('ArrowLeft', 37), { kittyKeyboard: kitty });
      assert.deepEqual(before.input, [['\x01', true]], '⌘← is Ctrl+A at the shell');
      await write(term, '\x1b[>1u');
      const after = press(cmd('ArrowLeft', 37), { kittyKeyboard: kitty });
      assert.equal(after.toXterm, true, "⌘← to a kitty program: xterm's, as to a modifyOtherKeys one");
      assert.deepEqual(after.input, []);
      // ⌥ as Meta, read from the terminal's own option at the key.
      const optA = key('a', { altKey: true, key: 'å' });
      assert.equal(kitty.sequenceFor(optA), null, 'Option as Meta off: ⌥A types å');
      term.options.macOptionIsMeta = true;
      assert.equal(kitty.sequenceFor(optA), `${CSI}97;3u`, 'on: Alt+A');
      term.options.macOptionIsMeta = false;
      assert.equal(kitty.sequenceFor(key('Enter', { altKey: true })), null, '⌥Enter stays ESC CR');
    } finally {
      term.dispose();
    }
  });

  test('KK-42: the wiring — every terminal has the addon from its first byte, the view asks it before modifyOtherKeys, and terminalModes reports its flags', () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(registry, /import \{ installKittyKeyboard \} from '\.\.\/\.\.\/lib\/kittyKeyboard\.js';/);
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    const install = create.indexOf('const kittyKeyboard = installKittyKeyboard(term, {');
    assert.ok(install > 0 && install < create.indexOf('term.open(container);'), 'installed before the terminal is opened');
    assert.ok(create.indexOf('const modifyOtherKeys = installModifyOtherKeys(term);') < install, 'beside modifyOtherKeys');
    assert.match(create.slice(install), /^\s+mac: isMac,\n\s+imePending: \(\) => hangulImeFor\(term\)\?\.pending \?\? '',\n/m, 'macOS and the Korean syllable, read at the key');
    assert.match(create.slice(create.indexOf('entry = {')), /^\s+kittyKeyboard,$/m, 'kept on the entry');
    const modes = registry.slice(registry.indexOf('export function terminalModes('));
    assert.match(modes.slice(0, modes.indexOf('\n}\n')), /kittyFlags: entry\.kittyKeyboard\?\.flags \?\? 0,/);

    const view = read('../../src/components/terminal/TerminalView.jsx');
    assert.match(view, /entry\.kittyKeyboard\?\.sequenceFor\(event, \{\s*secret: typingHidden\(useTerminalStore\.getState\(\), tabId\),\s*\}\)/);
    const enter = view.slice(view.indexOf('const sendModifiedEnter = (event) => {'));
    assert.ok(enter.indexOf('if (sendKittyKey(event)) return true;') < enter.indexOf('entry.modifyOtherKeys?.sequenceFor(event)'), 'kitty first, then modifyOtherKeys');
    assert.ok(view.indexOf('const sendKittyKey = (event) => {') < view.indexOf('const sendModifiedEnter = (event) => {'));
    const mac = view.slice(view.indexOf('const sendMacEditingKey = (event) => {'), view.indexOf('const sendKeyItself'));
    assert.match(mac, /kittyFlags: entry\.kittyKeyboard\?\.flags \?\? 0,/);
    // So the chain is ⌥-arrow, ⌘ editing keys, kitty, modifyOtherKeys' Enter.
    assert.match(view, /const sendKeyItself = \(event\) => sendLegacyAltArrow\(event\) \|\| sendMacEditingKey\(event\) \|\| sendModifiedEnter\(event\);/);
  });
});

describe('Kitty keyboard: a Korean syllable being composed goes first (AC2, AC5)', () => {
  /** xterm's helper textarea. */
  class Textarea {
    constructor() {
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
  }

  /** The terminal's container: the IME binding's capture listeners, ahead of xterm's own. */
  class Container {
    constructor() {
      this.listeners = [];
    }
    addEventListener(type, fn, capture) {
      this.listeners.push({ type, fn, capture: capture === true });
    }
    removeEventListener() {}
    dispatch(event) {
      for (const l of this.listeners.filter((x) => x.type === event.type && x.capture)) {
        l.fn(event);
        if (event.immediatePropagationStopped) return false;
      }
      return true;
    }
  }

  const domEvent = (type, target, fields) => ({
    type,
    target,
    ...fields,
    defaultPrevented: false,
    stopped: false,
    immediatePropagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
      this.immediatePropagationStopped = true;
    },
  });

  /**
   * Recorded WebKit rows (hangul_ime_recordings.js) through the real IME
   * binding, then into TerminalView's handler with a real kitty addon whose
   * flags `kittyTerm` followed; what the handler lets through is sent as
   * xterm 6 would: Enter `\r`, Ctrl+letter its control code by keyCode.
   */
  function play(rows, { kitty }) {
    const bytes = [];
    const textarea = new Textarea();
    const container = new Container();
    const term = {
      textarea,
      options: {},
      buffer: { active: { viewportY: 0, baseY: 0 } },
      modes: { mouseTrackingMode: 'none' },
      loadAddon(addon) {
        addon.activate(this);
      },
      input: (data) => bytes.push(data),
    };
    installHangulInlineIme(term, container, { mac: true });
    const { handleKeyEvent } = keyHandler({ kittyKeyboard: kitty, onInput: (data) => bytes.push(data) });
    for (const row of rows) {
      const [kind] = row;
      let event;
      if (kind === 'bi' || kind === 'in') {
        const [, it, data, value, start, end, composing] = row;
        textarea.value = value;
        textarea.selectionStart = start;
        textarea.selectionEnd = end;
        const inputType = { IT: 'insertText', IRT: 'insertReplacementText' }[it] ?? it;
        event = domEvent(kind === 'bi' ? 'beforeinput' : 'input', textarea, { inputType, data, isComposing: Boolean(composing) });
      } else if (kind === 'kd' || kind === 'ku') {
        const [, k, keyCode, code = '', modifiers = '', composing] = row;
        event = domEvent(kind === 'kd' ? 'keydown' : 'keyup', textarea, {
          key: k,
          keyCode,
          code,
          shiftKey: modifiers.includes('s'),
          ctrlKey: modifiers.includes('c'),
          altKey: modifiers.includes('a'),
          metaKey: modifiers.includes('m'),
          isComposing: Boolean(composing),
        });
      } else {
        continue;
      }
      if (!container.dispatch(event)) continue;
      if (event.type !== 'keydown') continue;
      if (handleKeyEvent(event) === false) continue;
      if (event.keyCode === 229 || event.isComposing) continue;
      if (event.keyCode === 13) bytes.push(event.altKey ? '\x1b\r' : '\r');
      else if (event.ctrlKey && event.keyCode >= 65 && event.keyCode <= 90) bytes.push(String.fromCharCode(event.keyCode - 64));
    }
    return bytes;
  }

  test('KK-50: 안녕하세요 + Shift+Enter in a kitty program sends 요 first, then ESC [13;2u; Shift alone mid-syllable sends nothing', async () => {
    const { term, kitty } = terminal({ mac: true });
    try {
      const rows = RECORDINGS.s02_annyeong_enter;
      const enter = rows.findIndex((r) => r[0] === 'kd' && r[1] === 'Enter');
      assert.ok(enter > 0, 'the recording ends in Enter');
      const shifted = [
        ...rows.slice(0, enter),
        ['kd', 'Shift', 16, 'ShiftLeft', 's'],
        ['kd', 'Enter', 13, 'Enter', 's'],
        ['ku', 'Enter', 13, 'Enter', 's'],
        ['ku', 'Shift', 16, 'ShiftLeft'],
      ];
      assert.deepEqual(play(shifted, { kitty }), ['안', '녕', '하', '세', '요', '\r'], "nothing pushed: xterm's \\r after the syllable");
      await write(term, '\x1b[>1u');
      assert.deepEqual(play(shifted, { kitty }), ['안', '녕', '하', '세', '요', `${CSI}13;2u`], 'the syllable, then the newline key, in that order');
      const toShift = shifted.slice(0, shifted.findIndex((r) => r[1] === 'Shift') + 1);
      assert.deepEqual(play(toShift, { kitty }), ['안', '녕', '하', '세'], '요 is still being composed at Shift');
      // Plain Enter is still the submit.
      assert.deepEqual(play(rows, { kitty }), ['안', '녕', '하', '세', '요', '\r']);
    } finally {
      term.dispose();
    }
  });

  test("KK-51: Ctrl+C with the Korean input source, as recorded, is xterm's 0x03 even in a kitty program — after the syllable", async () => {
    const { term, kitty } = terminal({ mac: true });
    try {
      await write(term, '\x1b[>1u');
      const bytes = play(RECORDINGS.s11_han_ctrlc, { kitty });
      assert.deepEqual(bytes, ['한', '\x03'], 'the syllable, then the legacy Ctrl+C');
      // With the Latin input source the same key is the kitty one.
      assert.deepEqual(play([['kd', 'c', 67, 'KeyC', 'c']], { kitty }), [`${CSI}99;5u`]);
    } finally {
      term.dispose();
    }
  });

  test('KK-52: the addon reads the syllable being composed at the key, from what the registry hands it', async () => {
    let pending = '';
    const { term, kitty } = terminal({ imePending: () => pending });
    try {
      await write(term, '\x1b[>1u');
      assert.equal(kitty.sequenceFor(key('Escape')), `${CSI}27u`);
      pending = '하';
      assert.equal(kitty.sequenceFor(key('Escape')), null, 'a syllable pending: the key is the IME binding\'s to follow');
      pending = '';
      assert.equal(kitty.sequenceFor(key('Escape')), `${CSI}27u`);
      assert.equal(kitty.sequenceFor(key('Escape'), { secret: true }), null, 'a password prompt up');
    } finally {
      term.dispose();
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
      const broken = terminal({
        imePending: () => {
          throw new Error('gone');
        },
      });
      await write(broken.term, '\x1b[>1u');
      assert.equal(broken.kitty.sequenceFor(key('Escape')), null, 'an IME that cannot be read: the key is xterm\'s');
      broken.term.dispose();
    } finally {
      console.warn = warn;
    }
  });
});
