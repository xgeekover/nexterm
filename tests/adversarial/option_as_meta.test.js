/**
 * Option as Meta (bundle 2, A7): Settings ▸ Terminal ▸ Use Option as Meta,
 * macOS only and off by default, sets xterm's `macOptionIsMeta` on every
 * terminal made and on every open one when it changes. ⌥←/→ stay NexTerm's
 * own Esc b / Esc f either way. See src/lib/optionAsMeta.js.
 *
 * OM-03 checks the registry's source, and runs its real settings
 * subscription — cut from terminalRegistry.js as the key handler is cut from
 * TerminalView.jsx elsewhere — against terminals that only hold options, so
 * the change is seen reaching live terminals. OM-04 drives TerminalView's real
 * key handler with the setting on. OM-99 puts the settings store back.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { macOptionIsMetaFor } from '../../src/lib/optionAsMeta.js';
import { isWindowCloseChord, legacyAltArrowSequence } from '../../src/lib/terminalCompat.js';
import { encodeModifiedEnter } from '../../src/lib/modifyOtherKeys.js';
import { suggestionKeyAction, lineAfterKey, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';
import { macEditingKeySequence } from '../../src/lib/macEditingKeys.js';
import { typingHidden } from '../../src/lib/secretInput.js';
import { SETTINGS_DEFAULTS, useSettingsStore } from '../../src/stores/settingsStore.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const original = { settings: useSettingsStore.getState() };
function restore() {
  useSettingsStore.setState(original.settings, true);
}

/**
 * The registry's settings subscription, cut from terminalRegistry.js and run
 * with the names it closes over handed in: `instances` holds terminals that
 * are only their options. Returns the listener it subscribed.
 */
function settingsListener({ instances, mac }) {
  const src = read('../../src/components/terminal/terminalRegistry.js');
  const start = src.indexOf('let settingsSubscriptionStarted = false;');
  const end = src.lastIndexOf('/**', src.indexOf('useSystemStore.subscribe((state, prev) => {'));
  assert.ok(start > 0 && end > start, 'the settings subscription is where it was');
  const listeners = [];
  const scope = {
    useSettingsStore: { subscribe: (fn) => listeners.push(fn) },
    LIVE_TERMINAL_SETTINGS_KEYS: [],
    applyLiveTerminalSettings: () => {},
    THEME_SETTINGS_KEYS: [],
    scheduleThemeRepaint: () => {},
    instances,
    promptMarksShown: () => true,
    scrollbackEnabled: () => false,
    scrollbackSaver: { markDirty: () => {} },
    macOptionIsMetaFor,
    isMac: mac,
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `${src.slice(start, end)}\nreturn ensureSettingsSubscriptionStarted;`);
  make(...names.map((name) => scope[name]))();
  assert.equal(listeners.length, 1, 'one subscription');
  return listeners[0];
}

/** A terminal entry as the registry keeps one, but only its options. */
const entry = (over = {}) => ({ disposed: false, term: { options: {} }, ...over });

/** TerminalView's real key handler, cut as mac_editing_keys.test.js cuts it, on macOS. */
function terminalViewKeyHandler() {
  const src = read('../../src/components/terminal/TerminalView.jsx');
  const start = src.indexOf('const sendLegacyAltArrow = (event) => {');
  const end = src.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent);', start);
  assert.ok(start > 0 && end > start, 'the key handler is where it was');
  const input = [];
  const scope = {
    legacyAltArrowSequence,
    isWindowCloseChord,
    isWindows: false,
    isMac: true,
    entry: { term: { input: (data, wasUserInput) => input.push([data, wasUserInput]), hasSelection: () => false }, modifyOtherKeys: { level: 0, sequenceFor: () => null } },
    handleClipboardKey,
    isFindOpen: () => false,
    suggestionKeyAction,
    suggestStateRef: { current: { visible: false, items: [] } },
    isRunning: () => false,
    isAlternate: () => false,
    lineRef: { current: NEW_LINE },
    lineAfterKey,
    setSuggestState: () => {},
    writeRaw: () => {},
    tabId: 'tab-1',
    EMPTY_SUGGEST_STATE: { visible: false, items: [] },
    macEditingKeySequence,
    typingHidden,
    useSettingsStore,
    useTerminalStore: { getState: () => ({ secretInput: {} }) },
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `${src.slice(start, end)}\nreturn handleKeyEvent;`);
  return { handleKeyEvent: make(...names.map((name) => scope[name])), input };
}

const optionKey = (key, over = {}) => ({
  type: 'keydown',
  key,
  keyCode: { ArrowLeft: 37, ArrowRight: 39, Enter: 13 }[key] ?? 0,
  altKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {},
  ...over,
});

describe('Option as Meta (bundle 2, A7)', () => {
  beforeEach(() => restore());
  afterEach(() => restore());

  test('OM-01: the default terminalOptionAsMeta is false', () => {
    assert.equal(SETTINGS_DEFAULTS.terminalOptionAsMeta, false);
    assert.equal(useSettingsStore.getState().settingsDefaults.terminalOptionAsMeta, false);
    assert.equal(useSettingsStore.getState().terminalOptionAsMeta, false, 'a fresh store starts with it off');
    assert.equal(macOptionIsMetaFor(useSettingsStore.getState(), { mac: true }), false, 'so a new terminal on macOS types ⌥-characters');
  });

  test('OM-02: macOptionIsMeta equals the setting on macOS, and is false elsewhere', () => {
    assert.equal(macOptionIsMetaFor({ terminalOptionAsMeta: true }, { mac: true }), true);
    assert.equal(macOptionIsMetaFor({ terminalOptionAsMeta: false }, { mac: true }), false);
    for (const value of [true, false]) {
      assert.equal(macOptionIsMetaFor({ terminalOptionAsMeta: value }, { mac: false }), false, `off macOS with the setting ${value}`);
      assert.equal(macOptionIsMetaFor({ terminalOptionAsMeta: value }), false, 'the platform is not assumed');
    }
    // Only a real `true` turns it on.
    for (const odd of [undefined, null, 'true', 1, {}]) {
      assert.equal(macOptionIsMetaFor({ terminalOptionAsMeta: odd }, { mac: true }), false, JSON.stringify(odd));
    }
    assert.equal(macOptionIsMetaFor(null, { mac: true }), false);
    assert.equal(macOptionIsMetaFor(undefined, { mac: true }), false);
    // Through the real store.
    useSettingsStore.getState().setSetting('terminalOptionAsMeta', true);
    assert.equal(macOptionIsMetaFor(useSettingsStore.getState(), { mac: true }), true);
    assert.equal(macOptionIsMetaFor(useSettingsStore.getState(), { mac: false }), false);
  });

  test('OM-03: terminalRegistry passes it to new Terminal() and sets it on every live terminal when the setting changes', () => {
    const registry = read('../../src/components/terminal/terminalRegistry.js');
    assert.match(registry, /import \{ macOptionIsMetaFor \} from '\.\.\/\.\.\/lib\/optionAsMeta\.js';/);
    assert.match(registry, /import \{ isMac, isWindows \} from '\.\.\/\.\.\/lib\/platform\.js';/);
    const create = registry.slice(registry.indexOf('export function getOrCreateTerminal('));
    const options = create.slice(create.indexOf('const term = new Terminal({'), create.indexOf('});', create.indexOf('const term = new Terminal({')));
    assert.match(options, /\n    macOptionIsMeta: macOptionIsMetaFor\(settingsState, \{ mac: isMac \}\),\n/, 'given when the terminal is made');
    assert.ok(create.indexOf('const settingsState = useSettingsStore.getState();') < create.indexOf('const term = new Terminal({'), 'from the settings as they are then');

    // The subscription itself, on two live terminals and a disposed one.
    const live = [entry(), entry()];
    const gone = entry({ disposed: true });
    const instances = new Map([['a', live[0]], ['b', live[1]], ['c', gone]]);
    const listener = settingsListener({ instances, mac: true });
    const off = { ...SETTINGS_DEFAULTS };
    const on = { ...off, terminalOptionAsMeta: true };
    listener(on, off);
    assert.deepEqual(live.map((e) => e.term.options.macOptionIsMeta), [true, true], 'turned on in every open terminal');
    assert.equal(gone.term.options.macOptionIsMeta, undefined, 'a disposed terminal is left alone');
    listener(off, on);
    assert.deepEqual(live.map((e) => e.term.options.macOptionIsMeta), [false, false], 'and off again');
    // A change to anything else leaves the option as it is.
    live[0].term.options.macOptionIsMeta = 'untouched';
    listener({ ...off, terminalFontSize: 20 }, off);
    assert.equal(live[0].term.options.macOptionIsMeta, 'untouched');

    // Off macOS the setting never turns it on.
    const elsewhere = entry();
    const other = settingsListener({ instances: new Map([['a', elsewhere]]), mac: false });
    other(on, off);
    assert.equal(elsewhere.term.options.macOptionIsMeta, false);
  });

  test('OM-04: with the setting on, ⌥←/→ are still Esc b / Esc f, ⌥Enter is still left to xterm, and the mouse override is untouched', () => {
    useSettingsStore.getState().setSetting('terminalOptionAsMeta', true);
    assert.equal(legacyAltArrowSequence(optionKey('ArrowLeft'), { mac: true }), '\x1bb');
    assert.equal(legacyAltArrowSequence(optionKey('ArrowRight'), { mac: true }), '\x1bf');
    // Through the key handler, ahead of xterm, as before.
    for (const [key, sequence] of [['ArrowLeft', '\x1bb'], ['ArrowRight', '\x1bf']]) {
      const { handleKeyEvent, input } = terminalViewKeyHandler();
      const event = optionKey(key);
      assert.equal(handleKeyEvent(event), false, `⌥${key}: not xterm's`);
      assert.deepEqual(input, [[sequence, true]]);
      assert.ok(event.defaultPrevented);
    }
    // ⌥Enter: never NexTerm's, so xterm's Esc CR at any modifyOtherKeys level.
    for (const level of [0, 1, 2]) assert.equal(encodeModifiedEnter(optionKey('Enter'), level), null);
    const { handleKeyEvent, input } = terminalViewKeyHandler();
    assert.equal(handleKeyEvent(optionKey('Enter')), true, '⌥Enter goes to xterm');
    assert.deepEqual(input, []);
    // Nothing on the key path reads the setting, and the ⌥ mouse override is its own option.
    const view = read('../../src/components/terminal/TerminalView.jsx');
    assert.doesNotMatch(view, /terminalOptionAsMeta|macOptionIsMeta/);
    assert.match(view, /legacyAltArrowSequence\(event, \{ mac: isMac \}\)/);
    const clipboard = read('../../src/lib/terminalClipboard.js');
    assert.doesNotMatch(clipboard, /macOptionIsMeta|terminalOptionAsMeta/);
    assert.match(clipboard, /term\.options\.macOptionClickForcesSelection = isTracking;/);
  });

  test('OM-99: teardown \u{2014} the settings store as the next suite expects', () => {
    restore();
    assert.equal(useSettingsStore.getState(), original.settings);
    assert.equal(useSettingsStore.getState().terminalOptionAsMeta, false);
  });
});
