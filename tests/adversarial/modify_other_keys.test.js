/**
 * Shift+Enter and Ctrl+Enter reach a program that turned xterm's
 * modifyOtherKeys on as keys of their own, `CSI 27;2;13~` and `CSI 27;5;13~`,
 * and every other program gets Enter exactly as before.
 *
 * Measured on 2026-10-05 in the macOS dev app with OpenCode 1.18.34: it turns
 * modifyOtherKeys on (`CSI > 4 ; 1 m`) and inserts a newline on Shift+Enter
 * and Ctrl+Enter, but xterm.js 6.0 ignores the request and sent `\r` for both,
 * so the prompt was SUBMITTED. Written to OpenCode as `CSI 27;2;13~`, the same
 * key inserts the newline. Claude Code sends `CSI > 4 m` (off) and must keep
 * getting `\r`. See src/lib/modifyOtherKeys.js.
 *
 * The level is followed through real xterm (`@xterm/headless`, the same core
 * and release as the app's `@xterm/xterm`, see UW-04). The keys go through
 * TerminalView's real key handler, cut from TerminalView.jsx as TC-14 cuts
 * it, with the real suggestion layer and clipboard keys, and with the real
 * Korean IME binding in front of it for a syllable still being composed.
 */
import { readFileSync } from 'node:fs';
// Static, as in unicode_widths.test.js: other files in this runner register
// module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { encodeModifiedEnter, installModifyOtherKeys } from '../../src/lib/modifyOtherKeys.js';
import { legacyAltArrowSequence } from '../../src/lib/terminalCompat.js';
import { suggestionKeyAction, lineAfterKey, rankedSuggestions, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';
import { installHangulInlineIme } from '../../src/lib/hangulInlineIme.js';
import { RECORDINGS } from './hangul_ime_recordings.js';

const { Terminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));

const SHIFT_ENTER = '\x1b[27;2;13~';
const CTRL_ENTER = '\x1b[27;5;13~';

/** A real xterm 6 with the app's addon (or without it), every reply it sends collected. */
function terminal({ addon = true } = {}) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies = [];
  term.onData((data) => replies.push(data));
  return { term, mok: addon ? installModifyOtherKeys(term) : null, replies };
}

/** A keydown as the browser reports one, Enter unless said otherwise, recording how it was cancelled. */
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

/**
 * TerminalView's real key handler, run outside React as TC-14 runs it: the
 * code from `sendLegacyAltArrow` to the `attachCustomKeyEventHandler` call,
 * compiled with what it closes over handed in. `entry.modifyOtherKeys` is
 * whatever the test passes, normally the addon of a real xterm. A name the
 * handler starts to read that is not handed in throws, so a change to what it
 * depends on fails here instead of testing a stale copy.
 */
function keyHandler({
  modifyOtherKeys = null,
  suggestState = { visible: false, items: [] },
  running = false,
  alternate = false,
  clipboard = handleClipboardKey,
  onInput = () => {},
} = {}) {
  const src = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('const sendLegacyAltArrow = (event) => {');
  const end = src.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent);', start);
  assert.ok(start > 0 && end > start, 'the key handler is where it was');
  const calls = { input: [], writeRaw: [], suggestState: [] };
  const EMPTY_SUGGEST_STATE = { visible: false, items: [] };
  const scope = {
    legacyAltArrowSequence,
    isMac: true,
    entry: {
      term: {
        input: (data, wasUserInput) => {
          calls.input.push([data, wasUserInput]);
          onInput(data);
        },
        hasSelection: () => false,
      },
      modifyOtherKeys,
    },
    handleClipboardKey: clipboard,
    isFindOpen: () => false,
    suggestionKeyAction,
    suggestStateRef: { current: suggestState },
    isRunning: () => running,
    isAlternate: () => alternate,
    lineRef: { current: NEW_LINE },
    lineAfterKey,
    setSuggestState: (next) => calls.suggestState.push(next),
    writeRaw: (tabId, text) => calls.writeRaw.push([tabId, text]),
    tabId: 'tab-1',
    EMPTY_SUGGEST_STATE,
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `${src.slice(start, end)}\nreturn handleKeyEvent;`);
  return { handleKeyEvent: make(...names.map((name) => scope[name])), calls, EMPTY_SUGGEST_STATE };
}

describe('modifyOtherKeys: the level a program asks for, through real xterm', () => {
  test('MK-01: xterm.js 6.0 alone neither answers nor applies modifyOtherKeys; with the addon it follows the request', async () => {
    const bare = terminal({ addon: false });
    try {
      await write(bare.term, '\x1b[>4;1m\x1b[?4m\x1b[>4n\x1b[?u');
      assert.deepEqual(bare.replies, [], 'no reply to XTQMODKEYS, nor to the kitty query');
      await write(bare.term, 'x');
      const cell = bare.term.buffer.active.getLine(0).getCell(0);
      assert.ok(!cell.isBold() && !cell.isUnderline(), '`CSI > 4 ; 1 m` is not SGR 4;1 either: it sets nothing at all');
    } finally {
      bare.term.dispose();
    }

    const { term, mok, replies } = terminal();
    try {
      assert.ok(mok, 'installed on a real xterm');
      assert.equal(mok.level, 0, 'off until a program asks');
      await write(term, '\x1b[>4;1m');
      assert.equal(mok.level, 1);
      await write(term, '\x1b[?u');
      assert.deepEqual(replies, [], 'the kitty query stays unanswered: a program falls back to modifyOtherKeys');
    } finally {
      term.dispose();
    }
  });

  test('MK-02: set, reset and disable — every form xterm defines', async () => {
    const { term, mok } = terminal();
    try {
      const steps = [
        ['\x1b[>4;1m', 1, '`CSI > 4 ; 1 m` turns it on (OpenCode)'],
        ['\x1b[>4;0m', 0, '`CSI > 4 ; 0 m` turns it off (OpenCode, exiting)'],
        ['\x1b[>4;2m', 2, '`CSI > 4 ; 2 m`: level 2'],
        ['\x1b[>4m', 0, '`CSI > 4 m`: back to the default, off (Claude Code)'],
        ['\x1b[>4;2m', 2, 'on again'],
        ['\x1b[>4;m', 0, '`CSI > 4 ; m`: an empty value is off'],
        ['\x1b[>4;1m', 1, 'on again'],
        ['\x1b[>4n', 0, "`CSI > 4 n`: xterm's disable"],
        ['\x1b[>4;2m', 2, 'on again'],
        ['\x1b[>m', 0, '`CSI > m`: every key resource back to its default'],
        ['\x1b[>4;1;9m', 1, 'a parameter past the value is ignored, as xterm ignores it'],
      ];
      for (const [sequence, level, why] of steps) {
        await write(term, sequence);
        assert.equal(mok.level, level, why);
      }
      for (const sequence of [
        '\x1b[>4;3m', // a value xterm does not define
        '\x1b[>4:2m', // a sub-parameter, not a value
        '\x1b[>1;2m', // modifyCursorKeys
        '\x1b[>2;1m', // modifyFunctionKeys
        '\x1b[>1n',
        '\x1b[>n', // modifyFunctionKeys, by xterm's default
        '\x1b[?1m', // a query, not a setting
      ]) {
        await write(term, sequence);
        assert.equal(mok.level, 1, `${JSON.stringify(sequence)} leaves it as it was`);
      }
    } finally {
      term.dispose();
    }
  });

  test("MK-03: only modifyOtherKeys is taken — every other sequence goes on to xterm's handling, as before", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      // Registered first, so xterm asks the addon before these, and these only
      // when the addon hands a sequence on.
      const reached = [];
      for (const [prefix, final] of [['>', 'm'], ['>', 'n'], ['?', 'm']]) {
        term.parser.registerCsiHandler({ prefix, final }, (params) => {
          reached.push(`${prefix}${JSON.stringify(params)}${final}`);
          return false;
        });
      }
      const mok = installModifyOtherKeys(term);
      await write(term, '\x1b[>4;1m\x1b[>4m\x1b[>4n\x1b[>4;2m\x1b[?4m');
      assert.deepEqual(reached, [], "Pp 4 is the addon's, every time");
      assert.equal(mok.level, 2);
      await write(term, '\x1b[>1;2m\x1b[>2n\x1b[>n\x1b[?1m\x1b[?m');
      assert.equal(mok.level, 2, 'the other resources are not modifyOtherKeys');
      await write(term, '\x1b[>m');
      assert.equal(mok.level, 0, '`CSI > m` resets every resource, so it is off — and still handed on');
      await write(term, '\x1b[>4;1m\x1b[>0m');
      assert.equal(mok.level, 0, '`CSI > 0 m` reaches the addon as the same [0], and does the same');
      assert.deepEqual(
        reached,
        ['>[1,2]m', '>[2]n', '>[0]n', '?[1]m', '?[0]m', '>[0]m', '>[0]m'],
        'everything else is handed on'
      );
    } finally {
      term.dispose();
    }
  });

  test("MK-04: XTQMODKEYS is answered with the level, out the way xterm's own replies go", async () => {
    const { term, replies } = terminal();
    try {
      await write(term, '\x1b[?4m');
      await write(term, '\x1b[>4;1m\x1b[?4m');
      await write(term, '\x1b[>4;2m\x1b[?4m');
      await write(term, '\x1b[>4;0m\x1b[?4m');
      assert.deepEqual(replies, ['\x1b[>4;0m', '\x1b[>4;1m', '\x1b[>4;2m', '\x1b[>4;0m']);
      await write(term, '\x1b[?0m\x1b[?1m\x1b[?2m\x1b[?m');
      assert.equal(replies.length, 4, "the other key resources are not this addon's to report");
    } finally {
      term.dispose();
    }

    // Not as typed input: xterm's replies leave through `onData` with
    // `wasUserInput` false, as `installXtVersionReply` sends its own.
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
    assert.ok(installModifyOtherKeys(fake), 'a terminal without `buffer.onBufferChange` still gets the parser half');
    assert.equal(handlers.get('?m')([4]), true);
    assert.deepEqual(fake.inputs, [['\x1b[>4;0m', false]]);
  });

  test('MK-05: leaving the alternate screen turns it off; entering it does not', async () => {
    const { term, mok } = terminal();
    try {
      for (const [enter, leave] of [
        ['\x1b[?1049h', '\x1b[?1049l'],
        ['\x1b[?1047h', '\x1b[?1047l'],
        ['\x1b[?47h', '\x1b[?47l'],
      ]) {
        // A program may ask before it switches or after; both stand.
        await write(term, `\x1b[>4;1m${enter}`);
        assert.equal(mok.level, 1, `asked before ${JSON.stringify(enter)}`);
        await write(term, '\x1b[>4;2m');
        assert.equal(mok.level, 2, 'and asked again on the alternate screen');
        // It crashed with a handler that put the screen back and nothing else.
        await write(term, leave);
        assert.equal(mok.level, 0, `${JSON.stringify(leave)}: the shell after it gets \\r for Shift+Enter`);
        assert.equal(mok.sequenceFor(keydown({ shiftKey: true })), null);
      }
      await write(term, '\x1b[?1049h\x1b[>4;1m');
      assert.equal(mok.level, 1, 'asked after switching');
    } finally {
      term.dispose();
    }
  });

  test('MK-06: a reset — RIS, which `reset` sends, or `term.reset()` — turns it off, on either screen', async () => {
    const { term, mok } = terminal();
    try {
      await write(term, '\x1b[>4;1m');
      assert.equal(mok.level, 1, 'left on by a program that died on the normal screen');
      await write(term, '\x1bc');
      assert.equal(mok.level, 0, 'RIS on the normal screen');
      await write(term, '\x1b[?1049h\x1b[>4;2m');
      assert.equal(mok.level, 2, 'a program killed with its alternate screen still up');
      await write(term, '\x1bc');
      assert.equal(mok.level, 0, 'RIS from the alternate screen');
      await write(term, '\x1b[>4;1m');
      assert.equal(mok.level, 1);
      term.reset();
      assert.equal(mok.level, 0, '`term.reset()`');
    } finally {
      term.dispose();
    }
  });

  test('MK-07: OpenCode and Claude Code, replayed — Shift+Enter is a newline for one and `\\r` for the other', async () => {
    // OpenCode 1.18.34 as it starts: the kitty query, modifyOtherKeys on, the
    // alternate screen, in either order.
    for (const start of ['\x1b[?u\x1b[>4;1m\x1b[?1049h', '\x1b[?1049h\x1b[?u\x1b[>4;1m']) {
      const { term, mok, replies } = terminal();
      try {
        await write(term, start);
        assert.deepEqual(replies, [], 'nothing answers the kitty query');
        assert.equal(mok.sequenceFor(keydown({ shiftKey: true })), SHIFT_ENTER, 'Shift+Enter: OpenCode inserts a newline');
        assert.equal(mok.sequenceFor(keydown({ ctrlKey: true })), CTRL_ENTER, 'Ctrl+Enter: the same');
        assert.equal(mok.sequenceFor(keydown()), null, "Enter: xterm's `\\r`, OpenCode's submit");
        assert.equal(mok.sequenceFor(keydown({ altKey: true })), null, "⌥Enter: xterm's `ESC CR`, a newline already");
        // And as it exits.
        await write(term, '\x1b[>4;0m\x1b[?1049l');
        assert.equal(mok.sequenceFor(keydown({ shiftKey: true })), null, 'back at the shell: `\\r`');
      } finally {
        term.dispose();
      }
    }

    // Claude Code 2.1.289 as it starts, on the normal screen: XTVERSION, the
    // kitty query, then modifyOtherKeys off. Even after something left it on.
    const { term, mok, replies } = terminal();
    try {
      await write(term, '\x1b[>4;1m');
      await write(term, '\x1b[>0q\x1b[?u\x1b[>4m');
      assert.equal(mok.level, 0);
      assert.equal(mok.sequenceFor(keydown({ shiftKey: true })), null, 'Claude Code keeps getting `\\r` for Shift+Enter');
      assert.deepEqual(replies, [], 'and no kitty reply, so it never turns extended keys on itself');
    } finally {
      term.dispose();
    }
  });

  test('MK-08: disposed with its terminal, and never throws inside the parser', async () => {
    const { term, mok, replies } = terminal();
    try {
      await write(term, '\x1b[>4;2m');
      assert.equal(mok.level, 2);
      mok.dispose();
      assert.equal(mok.level, 0);
      await write(term, '\x1b[>4;1m\x1b[?4m');
      assert.equal(mok.level, 0, 'its handlers are gone');
      assert.deepEqual(replies, [], 'nothing answers XTQMODKEYS any more');
    } finally {
      term.dispose();
    }

    // Through `loadAddon`, so the terminal's own dispose reaches it.
    const other = terminal();
    try {
      await write(other.term, '\x1b[>4;1m');
      assert.equal(other.mok.sequenceFor(keydown({ shiftKey: true })), SHIFT_ENTER);
    } finally {
      other.term.dispose();
    }
    assert.equal(other.mok.level, 0);
    assert.equal(other.mok.sequenceFor(keydown({ shiftKey: true })), null);

    // A handler that throws wedges xterm's write queue for good.
    const handlers = new Map();
    const throwing = {
      parser: {
        registerCsiHandler: ({ prefix, final }, fn) => {
          handlers.set(`${prefix}${final}`, fn);
          return { dispose() {} };
        },
      },
      buffer: {
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
    const addon = installModifyOtherKeys(throwing);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(handlers.get('?m')([4]), false, 'a reply that cannot be sent');
      for (const params of [undefined, null, 'x', [], [[4]], [NaN]]) {
        for (const key of ['>m', '>n', '?m']) assert.equal(handlers.get(key)(params), false, `${key} ${JSON.stringify(params)}`);
      }
      for (const buffer of [undefined, null, { type: 'normal' }, { type: 'alternate' }]) handlers.get('buffer')(buffer);
      assert.equal(handlers.get('>m')([4, 1]), true);
      assert.equal(addon.level, 1);
      assert.equal(addon.sequenceFor(null), null);
      const broken = { type: 'keydown', shiftKey: true, get key() { throw new Error('gone'); } };
      assert.equal(addon.sequenceFor(broken), null, 'an event that cannot be read is left to xterm');
    } finally {
      console.warn = warn;
    }
    assert.equal(installModifyOtherKeys({}), null, 'a terminal without a parser (a test double) gets nothing');
    assert.equal(installModifyOtherKeys(null), null);
  });
});

describe('modifyOtherKeys: what Enter sends', () => {
  const MODS = [
    [{ shiftKey: true }, 2, 'Shift+Enter'],
    [{ shiftKey: true, altKey: true }, 4, '⌥⇧Enter'],
    [{ ctrlKey: true }, 5, 'Ctrl+Enter'],
    [{ ctrlKey: true, shiftKey: true }, 6, 'Ctrl+Shift+Enter'],
    [{ ctrlKey: true, altKey: true }, 7, 'Ctrl+⌥Enter'],
    [{ ctrlKey: true, altKey: true, shiftKey: true }, 8, 'Ctrl+⌥⇧Enter'],
  ];

  test("MK-10: Shift or Ctrl held — `CSI 27 ; 1+Shift+2·Alt+4·Ctrl ; 13 ~`, at either level, main Enter or keypad's", () => {
    for (const level of [1, 2]) {
      for (const [mods, modifiers, chord] of MODS) {
        const expected = `\x1b[27;${modifiers};13~`;
        assert.equal(encodeModifiedEnter(keydown(mods), level), expected, `${chord} at level ${level}`);
        assert.equal(encodeModifiedEnter(keydown({ ...mods, code: 'NumpadEnter' }), level), expected, `keypad ${chord}`);
        assert.equal(encodeModifiedEnter(keydown({ ...mods, key: undefined, code: undefined }), level), expected, `${chord} by keyCode alone`);
        assert.equal(encodeModifiedEnter(keydown({ ...mods, keyCode: undefined }), level), expected, `${chord} by key alone`);
      }
    }
    // Every combination of the four modifiers, against the rule.
    for (let bits = 0; bits < 16; bits += 1) {
      const mods = { shiftKey: !!(bits & 1), altKey: !!(bits & 2), ctrlKey: !!(bits & 4), metaKey: !!(bits & 8) };
      const encoded = !mods.metaKey && (mods.shiftKey || mods.ctrlKey);
      const modifiers = 1 + (mods.shiftKey ? 1 : 0) + (mods.altKey ? 2 : 0) + (mods.ctrlKey ? 4 : 0);
      assert.equal(encodeModifiedEnter(keydown(mods), 1), encoded ? `\x1b[27;${modifiers};13~` : null, JSON.stringify(mods));
    }
  });

  test('MK-11: Enter alone, ⌥Enter alone, ⌘, an IME, level 0 and any other key are left to xterm', () => {
    // Each case against the same chord without the one thing that stops it.
    for (const level of [1, 2]) {
      assert.equal(encodeModifiedEnter(keydown({ shiftKey: true }), level), SHIFT_ENTER);
      assert.equal(encodeModifiedEnter(keydown(), level), null, "Enter: `\\r`, every program's submit");
      assert.equal(encodeModifiedEnter(keydown({ altKey: true, shiftKey: true }), level), '\x1b[27;4;13~');
      assert.equal(encodeModifiedEnter(keydown({ altKey: true }), level), null, '⌥Enter: `ESC CR`, as OpenCode and Claude Code read it');
      for (const [mods, modifiers, chord] of MODS) {
        const encoded = `\x1b[27;${modifiers};13~`;
        for (const [stop, why] of [
          [{ metaKey: true }, `⌘ with ${chord}: not a terminal key on macOS`],
          [{ isComposing: true }, `${chord} while an IME is composing`],
          [{ keyCode: 229 }, `${chord} as an IME key`],
          [{ type: 'keyup' }, `${chord}, keyup`],
          [{ type: 'keypress' }, `${chord}, keypress`],
        ]) {
          assert.equal(encodeModifiedEnter(keydown(mods), level), encoded, chord);
          assert.equal(encodeModifiedEnter(keydown({ ...mods, ...stop }), level), null, why);
        }
      }
    }
    for (const level of [0, undefined, null, NaN, -1]) {
      assert.equal(encodeModifiedEnter(keydown({ shiftKey: true }), level), null, `level ${String(level)}: nothing asked`);
    }
    for (const [key, code, keyCode] of [
      ['Tab', 'Tab', 9],
      [' ', 'Space', 32],
      ['Backspace', 'Backspace', 8],
      ['j', 'KeyJ', 74],
      ['m', 'KeyM', 77],
      ['Escape', 'Escape', 27],
    ]) {
      for (const mods of [{ shiftKey: true }, { ctrlKey: true }]) {
        assert.equal(encodeModifiedEnter(keydown({ key, code, keyCode, ...mods }), 2), null, `${JSON.stringify(mods)} ${key}`);
      }
    }
    assert.equal(encodeModifiedEnter(null, 1), null);
    assert.equal(encodeModifiedEnter(undefined, 1), null);
  });
});

describe("modifyOtherKeys: TerminalView's key handler sends it", () => {
  test('MK-20: Shift+Enter and Ctrl+Enter go encoded, as keystrokes, once the program asked — and Enter is untouched', async () => {
    const { term, mok } = terminal();
    try {
      // Nothing asked: every Enter is xterm's.
      for (const mods of [{ shiftKey: true }, { ctrlKey: true }, {}, { altKey: true }]) {
        const { handleKeyEvent, calls } = keyHandler({ modifyOtherKeys: mok, running: true });
        const event = keydown(mods);
        assert.equal(handleKeyEvent(event), true, `${JSON.stringify(mods)} at level 0: xterm sends it`);
        assert.deepEqual(calls.input, []);
        assert.ok(!event.defaultPrevented && !event.stopped);
      }

      await write(term, '\x1b[>4;1m\x1b[?1049h');
      for (const [mods, sequence] of [
        [{ shiftKey: true }, SHIFT_ENTER],
        [{ ctrlKey: true }, CTRL_ENTER],
        [{ shiftKey: true, code: 'NumpadEnter' }, SHIFT_ENTER],
      ]) {
        const { handleKeyEvent, calls } = keyHandler({ modifyOtherKeys: mok, running: true, alternate: true });
        const event = keydown(mods);
        assert.equal(handleKeyEvent(event), false, 'xterm does not send its own `\\r` as well');
        assert.deepEqual(calls.input, [[sequence, true]], 'sent as a keystroke: every onData listener sees it');
        assert.ok(event.defaultPrevented, "cancelled, which also stops the keypress xterm would send as a second `\\r`");
        assert.ok(event.stopped, 'and goes no further, as xterm cancels a key it sends');
      }
      for (const mods of [{}, { altKey: true }, { shiftKey: true, metaKey: true }, { shiftKey: true, isComposing: true }]) {
        const { handleKeyEvent, calls } = keyHandler({ modifyOtherKeys: mok, running: true, alternate: true });
        const event = keydown(mods);
        assert.equal(handleKeyEvent(event), true, `${JSON.stringify(mods)}: still xterm's`);
        assert.deepEqual(calls.input, []);
        assert.ok(!event.defaultPrevented);
      }
      for (const type of ['keypress', 'keyup']) {
        const { handleKeyEvent, calls } = keyHandler({ modifyOtherKeys: mok, running: true, alternate: true });
        assert.equal(handleKeyEvent(keydown({ type, shiftKey: true })), true, `the ${type} is xterm's`);
        assert.deepEqual(calls.input, []);
      }

      // The program exits: Enter is xterm's again.
      await write(term, '\x1b[>4;0m\x1b[?1049l');
      const after = keyHandler({ modifyOtherKeys: mok, running: true });
      assert.equal(after.handleKeyEvent(keydown({ shiftKey: true })), true);
      assert.deepEqual(after.calls.input, []);
    } finally {
      term.dispose();
    }

    // A terminal with no addon at all (a test double) is no different from level 0.
    const none = keyHandler({ modifyOtherKeys: null });
    assert.equal(none.handleKeyEvent(keydown({ shiftKey: true })), true);
    assert.deepEqual(none.calls.input, []);
  });

  test('MK-21: at a shell prompt that asked for it, the suggestion layer cannot keep Shift+Enter from going encoded', async () => {
    const { term, mok } = terminal();
    try {
      await write(term, '\x1b[>4;1m');
      // The popup is drawn: Enter clears it and goes on to the shell, and so
      // does Shift+Enter — encoded, not as the `\r` that would run the line.
      const popup = { visible: true, ...rankedSuggestions('gi', ['git status', 'git push']) };
      const shifted = keyHandler({ modifyOtherKeys: mok, suggestState: popup });
      const event = keydown({ shiftKey: true });
      assert.deepEqual(suggestionKeyAction(popup, event), { action: 'clear', consume: false }, 'the layer lets the key go on');
      assert.equal(shifted.handleKeyEvent(event), false);
      assert.deepEqual(shifted.calls.input, [[SHIFT_ENTER, true]]);
      assert.deepEqual(shifted.calls.suggestState, [shifted.EMPTY_SUGGEST_STATE], 'and the popup is gone');
      assert.deepEqual(shifted.calls.writeRaw, [], 'nothing of a suggestion is typed');

      // Only a ghost: the layer passes, the key still goes encoded.
      const ghost = { visible: true, ...rankedSuggestions('git st', ['git status']) };
      const ghosted = keyHandler({ modifyOtherKeys: mok, suggestState: ghost });
      assert.equal(ghosted.handleKeyEvent(keydown({ ctrlKey: true })), false);
      assert.deepEqual(ghosted.calls.input, [[CTRL_ENTER, true]]);

      // Enter alone still runs the line, through xterm.
      const plain = keyHandler({ modifyOtherKeys: mok, suggestState: popup });
      assert.equal(plain.handleKeyEvent(keydown()), true);
      assert.deepEqual(plain.calls.input, []);
      assert.deepEqual(plain.calls.suggestState, [plain.EMPTY_SUGGEST_STATE]);
    } finally {
      term.dispose();
    }
  });

  test('MK-22: the clipboard is asked first — a key it takes is never sent as Enter as well', async () => {
    const { term, mok } = terminal();
    try {
      await write(term, '\x1b[>4;1m');
      const taken = keyHandler({ modifyOtherKeys: mok, running: true, clipboard: () => false });
      assert.equal(taken.handleKeyEvent(keydown({ shiftKey: true })), false);
      assert.deepEqual(taken.calls.input, [], 'the clipboard had it');
      const passed = keyHandler({ modifyOtherKeys: mok, running: true, clipboard: () => undefined });
      assert.equal(passed.handleKeyEvent(keydown({ shiftKey: true })), false);
      assert.deepEqual(passed.calls.input, [[SHIFT_ENTER, true]]);
    } finally {
      term.dispose();
    }
    const src = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const handleKeyEvent = (event) => {'));
    const clipboard = body.indexOf('handleClipboardKey(entry.term, event,');
    const layer = body.indexOf('suggestionKeyAction(');
    const sent = body.indexOf('sendKeyItself(event)');
    assert.ok(clipboard > 0 && clipboard < layer && layer < sent, 'clipboard, then the suggestion layer, then the key');
  });

  test('MK-23: every terminal the app makes follows it from its first byte, and the view asks it', () => {
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /import \{ installModifyOtherKeys \} from '\.\.\/\.\.\/lib\/modifyOtherKeys\.js';/);
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    const install = create.indexOf('const modifyOtherKeys = installModifyOtherKeys(term);');
    const open = create.indexOf('term.open(container);');
    assert.ok(install > 0 && install < open, 'installed before the terminal is opened, let alone bound to a shell');
    assert.match(create.slice(create.indexOf('entry = {')), /^\s+modifyOtherKeys,$/m, 'and kept on the entry');
    const view = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    assert.match(view, /entry\.modifyOtherKeys\?\.sequenceFor\(event\)/);
  });
});

describe('modifyOtherKeys: a Korean syllable being composed goes first', () => {
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
   * Play recorded WebKit rows (hangul_ime_recordings.js) through the real IME
   * binding, then whatever it lets through into xterm 6's `_keyDown`
   * (CoreBrowserTerminal.ts): the custom key handler — TerminalView's — first,
   * nothing more when it returns false, an IME key left to composition, and
   * Enter as Keyboard.ts sends it, `ESC CR` with ⌥ and `CR` with or without
   * Shift and Ctrl. Every byte either sends lands in one list, in order, as
   * both reach the pty through xterm's `onData`.
   */
  function play(rows, { modifyOtherKeys }) {
    const bytes = [];
    const unhandled = [];
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
    const { handleKeyEvent } = keyHandler({ modifyOtherKeys, running: true, onInput: (data) => bytes.push(data) });
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
        const [, key, keyCode, code = '', modifiers = '', composing] = row;
        event = domEvent(kind === 'kd' ? 'keydown' : 'keyup', textarea, {
          key,
          keyCode,
          code,
          shiftKey: modifiers.includes('s'),
          ctrlKey: modifiers.includes('c'),
          altKey: modifiers.includes('a'),
          metaKey: modifiers.includes('m'),
          isComposing: Boolean(composing),
        });
      } else {
        continue; // what xterm 5.5 sent, recorded; not an event
      }
      if (!container.dispatch(event)) continue;
      if (event.type === 'keyup') continue;
      if (event.type !== 'keydown') {
        if (event.type === 'input') unhandled.push(row);
        continue;
      }
      if (handleKeyEvent(event) === false) continue;
      if (event.keyCode === 229 || event.isComposing) continue;
      if (event.keyCode === 13) bytes.push(event.altKey ? '\x1b\r' : '\r');
    }
    return { bytes, unhandled };
  }

  // 안녕하세요 + Enter as WebKit delivered it — the IME re-affirming 요 just
  // before the Enter — with Shift held on the Enter.
  const withShift = (rows) => {
    const enter = rows.findIndex((r) => r[0] === 'kd' && r[1] === 'Enter');
    assert.ok(enter > 0, 'the recording ends in Enter');
    return [
      ...rows.slice(0, enter),
      ['kd', 'Shift', 16, 'ShiftLeft', 's'],
      ['kd', 'Enter', 13, 'Enter', 's'],
      ['ku', 'Enter', 13, 'Enter', 's'],
      ['ku', 'Shift', 16, 'ShiftLeft'],
    ];
  };

  test('MK-30: 안녕하세요 + Shift+Enter in OpenCode sends 요 first, then `CSI 27;2;13~`', async () => {
    const { term, mok } = terminal();
    try {
      const rows = withShift(RECORDINGS.s02_annyeong_enter);
      const before = play(rows, { modifyOtherKeys: mok });
      assert.deepEqual(before.bytes, ['안', '녕', '하', '세', '요', '\r'], "nothing asked: the Enter is xterm's `\\r`, after the syllable");
      await write(term, '\x1b[>4;1m');
      const { bytes, unhandled } = play(rows, { modifyOtherKeys: mok });
      assert.deepEqual(unhandled, [], "every input event was the binding's, so the stand-in had none to guess at");
      assert.deepEqual(bytes, ['안', '녕', '하', '세', '요', SHIFT_ENTER], 'the syllable, then the newline key, in that order');
      // Shift alone, mid-syllable, sends nothing: ㅒ ㅖ ㄲ are Shift and a key.
      const toShift = rows.slice(0, rows.findIndex((r) => r[1] === 'Shift') + 1);
      assert.deepEqual(play(toShift, { modifyOtherKeys: mok }).bytes, ['안', '녕', '하', '세'], '요 is still being composed at Shift');
    } finally {
      term.dispose();
    }
  });

  test("MK-31: a Shift+Enter the IME is composing with is the IME's, not an encoded Enter", async () => {
    const { term, mok } = terminal();
    try {
      await write(term, '\x1b[>4;1m');
      const shiftEnter = (keyCode, composing) => [
        ['kd', 'Shift', 16, 'ShiftLeft', 's'],
        ['kd', 'Enter', keyCode, 'Enter', 's', composing],
        ['ku', 'Enter', 13, 'Enter', 's'],
      ];
      assert.deepEqual(play(shiftEnter(13, 0), { modifyOtherKeys: mok }).bytes, [SHIFT_ENTER], 'with nothing composing');
      assert.deepEqual(
        play(shiftEnter(229, 1), { modifyOtherKeys: mok }).bytes,
        [],
        "committing marked text (Safari, Japanese): the IME's key, not one for the program"
      );
    } finally {
      term.dispose();
    }
  });
});
