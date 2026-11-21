/**
 * macOS text-editing keys (bundle 2, A6): ⌘← Ctrl+A, ⌘→ Ctrl+E, ⌘Backspace
 * Ctrl+U and ⌘Forward-Delete Ctrl+K — on macOS, with the setting on, on the
 * normal screen, before a program turns modifyOtherKeys on, and at a password
 * prompt ⌘Backspace only. See src/lib/macEditingKeys.js.
 *
 * ME-01..ME-07 call the pure rule. ME-08 checks where TerminalView puts it to
 * work and drives TerminalView's real key handler, cut from TerminalView.jsx
 * as TC-14 and MK-12 cut it, with the real rule, the real suggestion layer and
 * clipboard keys, and the real settings and terminal stores — so the setting,
 * the screen, the level and a password prompt are read where the app reads
 * them. ME-99 puts the stores back.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { MAC_EDITING_KEY_SEQUENCES, macEditingKeySequence } from '../../src/lib/macEditingKeys.js';
import { isWindowCloseChord, legacyAltArrowSequence } from '../../src/lib/terminalCompat.js';
import { suggestionKeyAction, lineAfterKey, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';
import { typingHidden } from '../../src/lib/secretInput.js';
import { SETTINGS_DEFAULTS, useSettingsStore } from '../../src/stores/settingsStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const KEY_CODES = { ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46 };
const EXPECTED = [
  ['ArrowLeft', '\x01', '⌘← is Ctrl+A, start of line'],
  ['ArrowRight', '\x05', '⌘→ is Ctrl+E, end of line'],
  ['Backspace', '\x15', '⌘Backspace is Ctrl+U, kill to the start'],
  ['Delete', '\x0b', '⌘Forward-Delete is Ctrl+K, kill to the end'],
];

/** A keydown with ⌘ held and nothing else, as the webview hands it to xterm. */
const cmd = (key, over = {}) => ({
  type: 'keydown',
  key,
  keyCode: KEY_CODES[key] ?? 0,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
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

/** Every case's starting point: macOS, the setting on, normal screen, level 0, no password prompt. */
const MAC = { mac: true, enabled: true, alternate: false, modifyOtherKeysLevel: 0, secret: false };

describe('macOS editing keys: the rule (src/lib/macEditingKeys.js)', () => {
  test('ME-01: ⌘← 0x01, ⌘→ 0x05, ⌘Backspace 0x15, ⌘Forward-Delete 0x0b — by key, and by keyCode alone', () => {
    for (const [key, sequence, why] of EXPECTED) {
      assert.equal(macEditingKeySequence(cmd(key), MAC), sequence, why);
      assert.equal(macEditingKeySequence(cmd(undefined, { keyCode: KEY_CODES[key] }), MAC), sequence, `${why}, from keyCode ${KEY_CODES[key]}`);
    }
    assert.deepEqual(Object.keys(MAC_EDITING_KEY_SEQUENCES).sort(), ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']);
    // Other ⌘ keys are the app's or the webview's, never this rule's.
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'a', 'k', 'Enter', 'Escape', 'Tab']) {
      assert.equal(macEditingKeySequence(cmd(key), MAC), null, `⌘${key} is not an editing key`);
    }
    // The setting's default is on, so a caller that passes nothing for it gets the keys.
    assert.equal(macEditingKeySequence(cmd('ArrowLeft'), { mac: true }), '\x01');
  });

  test('ME-02: null on Windows and Linux — the same keys, every one of them', () => {
    for (const [key] of EXPECTED) {
      assert.notEqual(macEditingKeySequence(cmd(key), MAC), null, `on macOS ⌘${key} maps`);
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, mac: false }), null, `off macOS ⌘${key} (Win/Super) is not touched`);
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, mac: undefined }), null, 'and the platform is not assumed');
      // Windows' and Linux's own word keys are left alone too.
      assert.equal(macEditingKeySequence(cmd(key, { metaKey: false, ctrlKey: true }), { ...MAC, mac: false }), null, `Ctrl+${key} off macOS`);
    }
    assert.equal(macEditingKeySequence(cmd('ArrowLeft')), null, 'nothing passed: not macOS');
  });

  test('ME-03: null with the setting off', () => {
    for (const [key, sequence] of EXPECTED) {
      assert.equal(macEditingKeySequence(cmd(key), MAC), sequence);
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, enabled: false }), null, `⌘${key} with the setting off`);
    }
  });

  test('ME-04: null on the alternate screen — vim, htop and less keep the key as xterm sends it', () => {
    for (const [key, sequence] of EXPECTED) {
      assert.equal(macEditingKeySequence(cmd(key), MAC), sequence);
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, alternate: true }), null, `⌘${key} on the alternate screen`);
    }
  });

  test('ME-05: null once the program turned modifyOtherKeys on (level 1 or 2)', () => {
    for (const [key, sequence] of EXPECTED) {
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, modifyOtherKeysLevel: 0 }), sequence, 'level 0: nobody asked');
      assert.equal(macEditingKeySequence(cmd(key), { ...MAC, modifyOtherKeysLevel: undefined }), sequence, 'no level known: 0');
      for (const level of [1, 2]) {
        assert.equal(macEditingKeySequence(cmd(key), { ...MAC, modifyOtherKeysLevel: level }), null, `⌘${key} at level ${level}`);
      }
    }
  });

  test('ME-06: null with Shift, ⌥ or Ctrl added, without ⌘, while composing, and for anything but a keydown', () => {
    for (const [key, sequence] of EXPECTED) {
      assert.equal(macEditingKeySequence(cmd(key), MAC), sequence);
      for (const [over, why] of [
        [{ shiftKey: true }, `⇧⌘${key}: a selection chord`],
        [{ altKey: true }, `⌥⌘${key}: the app's (focus pane)`],
        [{ ctrlKey: true }, `⌃⌘${key}`],
        [{ metaKey: false }, `${key} alone`],
        [{ isComposing: true }, `⌘${key} while an IME is composing`],
        [{ keyCode: 229 }, `⌘${key} as an IME key`],
        [{ type: 'keyup' }, `⌘${key}, keyup`],
        [{ type: 'keypress' }, `⌘${key}, keypress`],
      ]) {
        assert.equal(macEditingKeySequence(cmd(key, over), MAC), null, why);
      }
    }
    assert.equal(macEditingKeySequence(null, MAC), null);
    assert.equal(macEditingKeySequence(undefined, MAC), null);
  });

  test('ME-07: at a password prompt only ⌘Backspace maps — no 0x01, 0x05 or 0x0b lands in a password', () => {
    const secret = { ...MAC, secret: true };
    assert.equal(macEditingKeySequence(cmd('Backspace'), secret), '\x15', "Ctrl+U: the tty's kill-line erases what was typed");
    assert.equal(macEditingKeySequence(cmd(undefined, { keyCode: 8 }), secret), '\x15', 'by keyCode too');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Delete']) {
      assert.notEqual(macEditingKeySequence(cmd(key), MAC), null, `⌘${key} maps with no prompt up`);
      assert.equal(macEditingKeySequence(cmd(key), secret), null, `⌘${key} at a password prompt: left to xterm`);
      assert.equal(macEditingKeySequence(cmd(undefined, { keyCode: KEY_CODES[key] }), secret), null, `⌘${key} by keyCode at a password prompt`);
    }
    // Every other rule still holds at the prompt.
    assert.equal(macEditingKeySequence(cmd('Backspace'), { ...secret, enabled: false }), null);
    assert.equal(macEditingKeySequence(cmd('Backspace'), { ...secret, mac: false }), null);
    assert.equal(macEditingKeySequence(cmd('Backspace'), { ...secret, alternate: true }), null);
  });
});

// --- TerminalView's real key handler -----------------------------------------------

const original = {
  settings: useSettingsStore.getState(),
  terminal: useTerminalStore.getState(),
};

function restore() {
  useSettingsStore.setState(original.settings, true);
  useTerminalStore.setState(original.terminal, true);
}

/**
 * `handleKeyEvent` cut from TerminalView.jsx and compiled with the names it
 * closes over handed in, the stores the real ones. A name it starts to read
 * that is not handed in here throws, so the cut fails loudly.
 */
function terminalViewKeyHandler({ mac = true, alternate = false, level = 0, tabId = 'tab-1' } = {}) {
  const src = read('../../src/components/terminal/TerminalView.jsx');
  const start = src.indexOf('const sendLegacyAltArrow = (event) => {');
  const end = src.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent);', start);
  assert.ok(start > 0 && end > start, 'the key handler is where it was');
  const calls = { input: [], writeRaw: [] };
  const scope = {
    legacyAltArrowSequence,
    isWindowCloseChord,
    isWindows: false,
    isMac: mac,
    entry: {
      term: { input: (data, wasUserInput) => calls.input.push([data, wasUserInput]), hasSelection: () => false },
      modifyOtherKeys: { level, sequenceFor: () => null },
    },
    handleClipboardKey,
    isFindOpen: () => false,
    suggestionKeyAction,
    suggestStateRef: { current: { visible: false, items: [] } },
    isRunning: () => false,
    isAlternate: () => alternate,
    lineRef: { current: NEW_LINE },
    lineAfterKey,
    setSuggestState: () => {},
    writeRaw: (id, text) => calls.writeRaw.push([id, text]),
    tabId,
    EMPTY_SUGGEST_STATE: { visible: false, items: [] },
    macEditingKeySequence,
    typingHidden,
    useSettingsStore,
    useTerminalStore,
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `${src.slice(start, end)}\nreturn handleKeyEvent;`);
  return { handleKeyEvent: make(...names.map((name) => scope[name])), calls };
}

/** What one key did through the handler: whether xterm still gets it, and what was sent. */
function press(key, options = {}, over = {}) {
  const { handleKeyEvent, calls } = terminalViewKeyHandler(options);
  const event = cmd(key, over);
  const toXterm = handleKeyEvent(event);
  return { toXterm, input: calls.input, cancelled: event.defaultPrevented && event.stopped };
}

describe('macOS editing keys: where TerminalView sends them', () => {
  beforeEach(() => restore());
  afterEach(() => restore());

  test('ME-08: the key handler sends them before xterm, reading the setting, the screen, the level and a password prompt; the setting is on by default', () => {
    // Source: in the chain the handler runs once the clipboard and the suggestion layer let a key go on, before xterm.
    const view = read('../../src/components/terminal/TerminalView.jsx');
    assert.match(view, /import \{ macEditingKeySequence \} from '\.\.\/\.\.\/lib\/macEditingKeys\.js';/);
    // Beside ⌥←/→ (which needs ⌥ and no ⌘) and ahead of a modified Enter, which it never maps.
    assert.match(view, /const sendKeyItself = \(event\) => sendLegacyAltArrow\(event\) \|\| sendMacEditingKey\(event\) \|\| sendModifiedEnter\(event\);/);
    assert.match(view, /if \(decision\.action === 'pass'\) return !sendKeyItself\(event\);/);
    const fn = view.slice(view.indexOf('const sendMacEditingKey = (event) => {'), view.indexOf('const sendKeyItself'));
    assert.ok(fn.length > 0 && view.indexOf('const sendMacEditingKey') < view.indexOf('const handleKeyEvent'), 'defined beside the other keys it sends');
    for (const pattern of [
      /mac: isMac,/,
      /enabled: useSettingsStore\.getState\(\)\.terminalMacEditingKeys,/,
      /alternate: isAlternate\(\),/,
      /modifyOtherKeysLevel: entry\.modifyOtherKeys\?\.level \?\? 0,/,
      /secret: typingHidden\(useTerminalStore\.getState\(\), tabId\),/,
      /event\.preventDefault\(\);\n\s+event\.stopPropagation\(\);\n\s+entry\.term\.input\(sequence, true\);/,
    ]) {
      assert.match(fn, pattern);
    }
    assert.equal(SETTINGS_DEFAULTS.terminalMacEditingKeys, true, 'on by default');
    assert.equal(useSettingsStore.getState().settingsDefaults.terminalMacEditingKeys, true);

    // Driven: sent as a keystroke and cancelled, so xterm sends nothing of its own.
    for (const [key, sequence, why] of EXPECTED) {
      const r = press(key);
      assert.equal(r.toXterm, false, `${why}: not xterm's`);
      assert.deepEqual(r.input, [[sequence, true]], `${why}: sent as user input`);
      assert.ok(r.cancelled, `${why}: cancelled as xterm cancels a key`);
    }
    // Each rule as the handler reads it.
    for (const [key] of EXPECTED) {
      for (const [options, why] of [
        [{ mac: false }, 'off macOS'],
        [{ alternate: true }, 'on the alternate screen'],
        [{ level: 2 }, 'modifyOtherKeys on'],
      ]) {
        const r = press(key, options);
        assert.equal(r.toXterm, true, `⌘${key} ${why}: xterm's`);
        assert.deepEqual(r.input, [], `⌘${key} ${why}: nothing sent`);
        assert.ok(!r.cancelled);
      }
    }
    useSettingsStore.getState().setSetting('terminalMacEditingKeys', false);
    for (const [key] of EXPECTED) {
      const r = press(key);
      assert.equal(r.toXterm, true, `⌘${key} with the setting off: xterm's`);
      assert.deepEqual(r.input, []);
    }
    useSettingsStore.getState().setSetting('terminalMacEditingKeys', true);
    // A password prompt up in this terminal: ⌘Backspace only. In another terminal: all four.
    useTerminalStore.setState({ secretInput: { 'tab-1': true } });
    assert.deepEqual(press('Backspace').input, [['\x15', true]], '⌘Backspace clears the secret typed so far');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Delete']) {
      const r = press(key);
      assert.equal(r.toXterm, true, `⌘${key} at a password prompt: xterm's`);
      assert.deepEqual(r.input, [], `⌘${key} at a password prompt: no byte in the password`);
    }
    assert.deepEqual(press('ArrowLeft', { tabId: 'tab-2' }).input, [['\x01', true]], 'the prompt is that terminal\'s, not every one\'s');
    // ⌥←/→ are still NexTerm's own ESC b / ESC f, and ⌥⌘← is not an editing key.
    useTerminalStore.setState({ secretInput: {} });
    assert.deepEqual(press('ArrowLeft', {}, { metaKey: false, altKey: true }).input, [['\x1bb', true]]);
    assert.deepEqual(press('ArrowLeft', {}, { altKey: true }).input, [], '⌥⌘← is the app\'s');
  });

  test('ME-99: teardown \u{2014} the settings and terminal stores as the next suite expects', () => {
    restore();
    assert.equal(useSettingsStore.getState(), original.settings);
    assert.equal(useTerminalStore.getState(), original.terminal);
    assert.equal(useSettingsStore.getState().terminalMacEditingKeys, true);
  });
});
