/**
 * Find in the terminal, and zoom.
 *
 * Both are shortcuts a user reaches for while a terminal has focus, which is
 * this app's resting state — so the cases that matter are not "does the store
 * hold a boolean" but: does the key survive xterm, does the size stop at the
 * edges instead of running away, and does the bar say what happened.
 *
 * The highlighting itself belongs to xterm's search addon and is not exercised
 * here: these suites run in Node with no DOM, and a mock of xterm's search
 * would only test the mock. What IS tested is everything around it — which
 * terminal a result may land on, what the bar shows for a count, and which
 * keys reach the shell regardless.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useSettingsStore, FONT_SIZE_RANGE } from '../../src/stores/settingsStore.js';
import { buildStatusItems } from '../../src/lib/statusInfo.js';
import {
  COMMANDS,
  DEFAULT_RESOLVED,
  findBinding,
  dispatchKeydownOverTerminal,
} from '../../src/lib/keybindings.js';
import { runMenuAction } from '../../src/lib/menuActions.js';

const S = useSettingsStore;
const { useTerminalStore: T } = await import('../../src/stores/terminalStore.js');

const itemOf = (items, id) => items.find((i) => i.id === id) ?? null;

/** The event a real keypress for this chord produces on `platform`. */
function press(key, code, { platform = 'windows', shift = false } = {}) {
  const mac = platform === 'macos';
  return {
    ctrlKey: !mac,
    metaKey: mac,
    shiftKey: shift,
    altKey: false,
    key,
    code,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

const ctxFor = (e, platform, extra = {}) => ({
  isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
  isInMonacoEditor: false,
  isCommandPaletteOpen: false,
  bindings: DEFAULT_RESOLVED,
  ...extra,
});

describe('Zoom: the text gets bigger, and stops', () => {
  beforeEach(() => {
    S.getState().resetSettings();
  });

  test('FZ-01: one step moves the terminal and the editor together', () => {
    const before = S.getState();
    S.getState().zoomFont(1);
    const after = S.getState();
    assert.equal(after.terminalFontSize, before.terminalFontSize + 1);
    assert.equal(after.editorFontSize, before.editorFontSize + 1);
  });

  test('FZ-02: holding the key does not run off the end of the scale', () => {
    // The Settings window will not show a size outside this range, so the
    // keyboard must not be able to reach one either — a terminal at 2px is
    // unreadable and there is no visible control to climb back out with.
    for (let i = 0; i < 60; i += 1) S.getState().zoomFont(1);
    assert.equal(S.getState().terminalFontSize, FONT_SIZE_RANGE.max);
    assert.equal(S.getState().editorFontSize, FONT_SIZE_RANGE.max);

    for (let i = 0; i < 120; i += 1) S.getState().zoomFont(-1);
    assert.equal(S.getState().terminalFontSize, FONT_SIZE_RANGE.min);
    assert.equal(S.getState().editorFontSize, FONT_SIZE_RANGE.min);
  });

  test('FZ-03: reset is the way back, from either end', () => {
    const defaults = S.getState().settingsDefaults;
    for (let i = 0; i < 20; i += 1) S.getState().zoomFont(-1);
    S.getState().resetZoom();
    assert.equal(S.getState().terminalFontSize, defaults.terminalFontSize);
    assert.equal(S.getState().editorFontSize, defaults.editorFontSize);
  });

  test('FZ-04: zooming leaves every other setting alone', () => {
    S.getState().setSetting('terminalScrollback', 9999);
    S.getState().setSetting('terminalCursorStyle', 'block');
    S.getState().zoomFont(3);
    assert.equal(S.getState().terminalScrollback, 9999);
    assert.equal(S.getState().terminalCursorStyle, 'block');
  });

  test('FZ-05: the menu and the keyboard zoom by the same amount', () => {
    const start = S.getState().terminalFontSize;
    runMenuAction('zoom-in');
    const viaMenu = S.getState().terminalFontSize;
    S.getState().resetZoom();
    COMMANDS['zoom-in'].run({ zoomFont: S.getState().zoomFont });
    assert.equal(S.getState().terminalFontSize, viaMenu);
    assert.equal(viaMenu, start + 1);

    runMenuAction('zoom-reset');
    assert.equal(S.getState().terminalFontSize, start);
  });
});

describe('Zoom: the status bar says so', () => {
  test('FZ-06: nothing is shown at the default size', () => {
    const { right } = buildStatusItems({ os: 'darwin', fontSize: 12, defaultFontSize: 12 });
    assert.equal(itemOf(right, 'zoom'), null, 'a permanent size chip would be noise');
  });

  test('FZ-07: a size that is not the default is shown, and offers the way back', () => {
    const { right } = buildStatusItems({ os: 'darwin', fontSize: 18, defaultFontSize: 12 });
    const chip = itemOf(right, 'zoom');
    assert.ok(chip, 'the bar must explain why the text is a different size');
    assert.equal(chip.text, '18px');
    // `action` is what makes it a button rather than another read-out — the
    // bar used to end in a notifications bell that looked clickable and was
    // not, which is the shape this deliberately avoids.
    assert.equal(chip.action, 'zoom-reset');
  });

  test('FZ-08: no chip claims to be clickable without an action behind it', () => {
    const { left, right } = buildStatusItems({
      os: 'win32',
      cwd: 'C:\\work\\p',
      cols: 80,
      rows: 24,
      terminalCount: 2,
      groupCount: 1,
      lastExitCode: 1,
      fontSize: 9,
      defaultFontSize: 12,
    });
    for (const item of [...left, ...right]) {
      if (!item.action) continue;
      assert.equal(item.id, 'zoom', `${item.id} claims an action nothing dispatches`);
    }
  });
});

describe('Find: which terminal, and which keys', () => {
  beforeEach(() => {
    T.setState({
      find: {
        open: false,
        tabId: null,
        query: '',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        resultIndex: -1,
        resultCount: 0,
      },
      activeTabId: 'tab-a',
    });
  });

  test('FZ-09: the bar opens against the terminal that has focus', () => {
    T.getState().openFind();
    assert.equal(T.getState().find.open, true);
    assert.equal(T.getState().find.tabId, 'tab-a', 'the bar must search the focused terminal');
  });

  test('FZ-10: a background terminal cannot overwrite the count on screen', () => {
    // Both terminals hold a search addon and both keep reporting. Without the
    // tabId check, a build still streaming in the other pane would rewrite
    // "3 of 12" under the user while they read it.
    T.getState().openFind('tab-a');
    T.getState().setFindResults('tab-a', { resultIndex: 2, resultCount: 12 });
    T.getState().setFindResults('tab-b', { resultIndex: 0, resultCount: 999 });
    assert.equal(T.getState().find.resultCount, 12);
    assert.equal(T.getState().find.resultIndex, 2);
  });

  test('FZ-11: closing keeps the query, so reopening repeats the search', () => {
    T.getState().openFind('tab-a');
    T.getState().setFindQuery('error');
    T.getState().setFindResults('tab-a', { resultIndex: 1, resultCount: 4 });
    T.getState().closeFind();

    assert.equal(T.getState().find.open, false);
    assert.equal(T.getState().find.query, 'error', 'the query is what every editor keeps');
    // The count is not kept: it describes a buffer that has gone on scrolling.
    assert.equal(T.getState().find.resultCount, 0);
    assert.equal(T.getState().find.resultIndex, -1);
  });

  test('FZ-12: only the three real options toggle, and a typo changes nothing', () => {
    T.getState().toggleFindOption('caseSensitive');
    T.getState().toggleFindOption('regex');
    assert.equal(T.getState().find.caseSensitive, true);
    assert.equal(T.getState().find.regex, true);
    assert.equal(T.getState().find.wholeWord, false);

    const before = { ...T.getState().find };
    T.getState().toggleFindOption('open');
    T.getState().toggleFindOption('nonsense');
    assert.deepEqual(T.getState().find, before, 'only the search options are togglable');
  });

  test('FZ-13: a query that is not a string is not a query', () => {
    // The field is user input and the store is also reachable from `?debug`.
    T.getState().setFindQuery(null);
    assert.equal(T.getState().find.query, '');
    T.getState().setFindQuery({ toString: () => 'rm -rf' });
    assert.equal(T.getState().find.query, '');
  });

  test('FZ-14: ⌘F reaches the bar over a focused terminal, on both platforms', () => {
    for (const platform of ['macos', 'windows']) {
      const opened = [];
      const e = press('f', 'KeyF', { platform });
      const fired = dispatchKeydownOverTerminal(
        e,
        ctxFor(e, platform, { openFind: () => opened.push(platform) })
      );
      assert.equal(fired, 'find-in-terminal', `${platform}: find must beat xterm to the key`);
      assert.deepEqual(opened, [platform]);
    }
  });

  test('FZ-15: on macOS a literal Ctrl+F is still the shell’s', () => {
    // ⌘F is the app's; ^F is forward-char and never ours where ⌘ exists.
    const e = {
      ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      key: 'f', code: 'KeyF',
      preventDefault: () => assert.ok(false, 'macOS: ^F must not be swallowed'),
      stopPropagation: () => assert.ok(false, 'macOS: ^F must reach xterm'),
    };
    assert.equal(findBinding(e, ctxFor(e, 'macos')), null);
    assert.equal(dispatchKeydownOverTerminal(e, ctxFor(e, 'macos')), null);
  });

  test('FZ-16: zoom is claimed over a terminal without taking a control byte', () => {
    const steps = [];
    for (const [key, code, id] of [['=', 'Equal', 'zoom-in'], ['-', 'Minus', 'zoom-out'], ['0', 'Digit0', 'zoom-reset']]) {
      for (const platform of ['macos', 'windows']) {
        const e = press(key, code, { platform });
        // `0` is matched on `key`, the punctuation on `code` — mirror what a
        // browser actually reports rather than what the table wants.
        if (id === 'zoom-reset') e.code = 'Digit0';
        const fired = dispatchKeydownOverTerminal(
          e,
          ctxFor(e, platform, { zoomFont: (d) => steps.push(d), resetZoom: () => steps.push('reset') })
        );
        assert.equal(fired, id, `${platform}: ${id} must run over a focused terminal`);
      }
    }
    assert.deepEqual(steps, [1, 1, -1, -1, 'reset', 'reset']);
  });
});
