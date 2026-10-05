/**
 * The rules for what xterm.js is told about the pty behind it: how Windows'
 * ConPTY wraps and resizes, the size range the backend clamps a pty to, the
 * verbatim paths an older backend handed out — and what ⌥ and an arrow send,
 * and how far the wheel goes, which xterm 6 stopped deciding the way xterm
 * 5.5 did. The wheel against real xterm, in a real browser:
 * wheel_headless.test.js.
 */

import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  PTY_COLS,
  PTY_ROWS,
  windowsPtyFor,
  usablePtySize,
  withoutVerbatimPrefix,
  legacyAltArrowSequence,
  wheelArrowCount,
  wheelScrollRows,
  installPagerWheel,
  installScrollbackWheel,
} from '../../src/lib/terminalCompat.js';
import { suggestionKeyAction, lineAfterKey, rankedSuggestions, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';
import { scrollbackRows55 } from './xterm55Wheel.js';

const ARROW_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

/** A keydown as the browser reports ⌥/Alt and an arrow. */
const altArrow = (key, over = {}) => ({
  type: 'keydown',
  key,
  keyCode: ARROW_CODES[key],
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...over,
});

/** Enough of an xterm for the pager wheel: its one custom wheel slot, a screen 21 px a row, input(). */
function wheelTerm({ type = 'alternate', tracking = 'none', scrollback = 1000, appCursor = false } = {}) {
  const term = {
    rows: 30,
    options: { scrollback, scrollSensitivity: 1, fastScrollSensitivity: 5 },
    modes: { mouseTrackingMode: tracking, applicationCursorKeysMode: appCursor },
    buffer: { active: { type } },
    element: { querySelector: (sel) => (sel === '.xterm-screen' ? { getBoundingClientRect: () => ({ height: 30 * 21 }) } : null) },
    sent: [],
    handler: null,
    input(data, wasUserInput) {
      this.sent.push({ data, wasUserInput });
    },
    attachCustomWheelEventHandler(fn) {
      this.handler = fn;
    },
  };
  installPagerWheel(term);
  return term;
}

/** A wheel event as the browser hands it over; pixels unless said otherwise. */
const wheelEvent = (deltaY, over = {}) => ({
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  altKey: false,
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
 * Enough of an opened xterm for the scrollback wheel: `term.element` taking
 * listeners, a screen `cellHeight` px a row, a buffer `baseY` rows deep, and
 * `scrollLines` / `onScroll` as xterm 6 has them — clamped to the buffer, the
 * scroll event fired synchronously from inside `scrollLines`.
 */
function scrollbackTerm({
  type = 'normal',
  tracking = 'none',
  scrollback = 1000,
  cellHeight = 16,
  rows = 14,
  baseY = 300,
  open = true,
} = {}) {
  const scrollListeners = new Set();
  const term = {
    rows,
    options: { scrollback, scrollSensitivity: 1, fastScrollSensitivity: 5 },
    modes: { mouseTrackingMode: tracking },
    buffer: { active: { type, viewportY: baseY, baseY } },
    listeners: [],
    removed: [],
    scrolled: [],
    addons: [],
    element: open
      ? {
          addEventListener: (eventType, fn, options) => term.listeners.push({ eventType, fn, options }),
          removeEventListener: (eventType, fn, options) => term.removed.push({ eventType, fn, options }),
          querySelector: (sel) =>
            sel === '.xterm-screen' ? { getBoundingClientRect: () => ({ height: rows * cellHeight }) } : null,
        }
      : undefined,
    scrollLines(n) {
      const b = term.buffer.active;
      term.scrolled.push(n);
      const next = Math.min(Math.max(b.viewportY + n, 0), b.baseY);
      if (next === b.viewportY) return;
      b.viewportY = next;
      for (const listener of [...scrollListeners]) listener(next);
    },
    onScroll(listener) {
      scrollListeners.add(listener);
      return { dispose: () => scrollListeners.delete(listener) };
    },
    scrollListenerCount: () => scrollListeners.size,
    loadAddon(addon) {
      term.addons.push(addon);
      addon.activate(term);
    },
    dispose() {
      for (const addon of term.addons) addon.dispose();
    },
    /** Deliver `event` as the browser would, to every wheel listener on the element. */
    wheel(event) {
      for (const { eventType, fn } of term.listeners) if (eventType === 'wheel') fn(event);
      return event;
    },
  };
  term.installed = installScrollbackWheel(term);
  return term;
}

/** The rows each of `deltas` scrolled `term`, one wheel event at a time. */
function scrollEach(term, deltas, over = {}) {
  return deltas.map((deltaY) => {
    const before = term.buffer.active.viewportY;
    term.wheel(wheelEvent(deltaY, over));
    return term.buffer.active.viewportY - before;
  });
}

/**
 * TerminalView's real key handler, run outside React: `sendLegacyAltArrow`
 * and `handleKeyEvent` cut from TerminalView.jsx and compiled with the names
 * they close over handed in — the real suggestion layer and clipboard keys
 * among them. A name the handler starts to read that is not handed in here
 * throws, so a change to what it depends on fails loudly instead of testing
 * a stale copy.
 */
function terminalViewKeyHandler({ mac, suggestState }) {
  const src = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('const sendLegacyAltArrow = (event) => {');
  const end = src.indexOf('entry.term.attachCustomKeyEventHandler(handleKeyEvent);', start);
  assert.ok(start > 0 && end > start, 'the key handler is where it was');
  const calls = { input: [], writeRaw: [], suggestState: [] };
  const EMPTY_SUGGEST_STATE = { visible: false, items: [] };
  const scope = {
    legacyAltArrowSequence,
    isMac: mac,
    entry: { term: { input: (data, wasUserInput) => calls.input.push([data, wasUserInput]), hasSelection: () => false } },
    handleClipboardKey,
    isFindOpen: () => false,
    suggestionKeyAction,
    suggestStateRef: { current: suggestState },
    isRunning: () => false,
    isAlternate: () => false,
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

/** A keydown as xterm hands it to the custom key handler, recording how it was cancelled. */
const keydown = (key, over = {}) => ({
  ...altArrow(key, { altKey: false }),
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

describe('Terminal compatibility: windowsPty, pty size, verbatim paths, ⌥ and an arrow', () => {
  test('TC-01: windowsPty is set on Windows only, with the build when the backend knows it', () => {
    assert.deepEqual(windowsPtyFor({ os: 'windows', osBuild: 19045 }), { backend: 'conpty', buildNumber: 19045 });
    assert.deepEqual(windowsPtyFor({ os: 'windows', osBuild: 22631 }), { backend: 'conpty', buildNumber: 22631 });
    assert.equal(windowsPtyFor({ os: 'macos' }), undefined);
    assert.equal(windowsPtyFor({ os: 'linux', osBuild: 6 }), undefined);
    assert.equal(windowsPtyFor(null), undefined);
  });

  test('TC-02: an unknown Windows build still tells xterm it is ConPTY (the older, safe behaviour)', () => {
    for (const osBuild of [undefined, null, 0, -1, 'abc', 19045.5]) {
      assert.deepEqual(windowsPtyFor({ os: 'windows', osBuild }), { backend: 'conpty' }, `osBuild=${osBuild}`);
    }
  });

  test('TC-03: a pane too small for the backend keeps its current size instead of disagreeing with the pty', () => {
    assert.equal(usablePtySize({ cols: 2, rows: 30 }), null, 'two columns is a pane mid-layout, not a terminal');
    assert.equal(usablePtySize({ cols: PTY_COLS.min - 1, rows: 30 }), null);
    assert.equal(usablePtySize({ cols: 80, rows: PTY_ROWS.min - 1 }), null);
    assert.equal(usablePtySize(undefined), null, 'the fit addon proposes nothing for a hidden pane');
    assert.equal(usablePtySize({ cols: NaN, rows: 24 }), null);
  });

  test('TC-04: every size handed on is one the backend applies unchanged', () => {
    assert.deepEqual(usablePtySize({ cols: PTY_COLS.min, rows: PTY_ROWS.min }), { cols: 10, rows: 2 });
    assert.deepEqual(usablePtySize({ cols: 102.7, rows: 34.2 }), { cols: 102, rows: 34 });
    assert.deepEqual(usablePtySize({ cols: 900, rows: 400 }), { cols: PTY_COLS.max, rows: PTY_ROWS.max });
    for (let cols = 0; cols <= 600; cols += 7) {
      const size = usablePtySize({ cols, rows: 24 });
      if (!size) continue;
      const backend = Math.min(Math.max(size.cols, PTY_COLS.min), PTY_COLS.max); // manager.rs: cols.clamp(10, 500)
      assert.equal(size.cols, backend, `cols ${cols}: terminal ${size.cols}, pty ${backend}`);
    }
  });

  test('TC-05: verbatim prefixes are dropped, and nothing else is touched', () => {
    assert.equal(withoutVerbatimPrefix('\\\\?\\D:\\workspace\\ai\\claude\\nexterm'), 'D:\\workspace\\ai\\claude\\nexterm');
    assert.equal(withoutVerbatimPrefix('\\\\?\\UNC\\server\\share\\dir'), '\\\\server\\share\\dir');
    for (const p of ['D:\\workspace', '/Users/me/project', '\\\\server\\share', '~/project', '', null, undefined]) {
      assert.equal(withoutVerbatimPrefix(p), p);
    }
  });

  test('TC-06: ⌥← / ⌥→ on macOS send ESC b / ESC f — a word back and forward, as xterm 5.5 sent them', () => {
    const mac = { mac: true };
    assert.equal(legacyAltArrowSequence(altArrow('ArrowLeft'), mac), '\x1bb');
    assert.equal(legacyAltArrowSequence(altArrow('ArrowRight'), mac), '\x1bf');
    // xterm 5.5 left ⌥↑ / ⌥↓ alone on macOS, and so does xterm 6: nothing to restore.
    assert.equal(legacyAltArrowSequence(altArrow('ArrowUp'), mac), null);
    assert.equal(legacyAltArrowSequence(altArrow('ArrowDown'), mac), null);
    // A WebKit event without `key` is still the same key.
    assert.equal(legacyAltArrowSequence(altArrow(undefined, { keyCode: 37 }), mac), '\x1bb');
  });

  test('TC-07: Alt and an arrow elsewhere send Ctrl and the arrow, all four, as xterm 5.5 did', () => {
    for (const mac of [false, undefined]) {
      const opts = mac === undefined ? undefined : { mac };
      assert.equal(legacyAltArrowSequence(altArrow('ArrowLeft'), opts), '\x1b[1;5D');
      assert.equal(legacyAltArrowSequence(altArrow('ArrowRight'), opts), '\x1b[1;5C');
      assert.equal(legacyAltArrowSequence(altArrow('ArrowUp'), opts), '\x1b[1;5A');
      assert.equal(legacyAltArrowSequence(altArrow('ArrowDown'), opts), '\x1b[1;5B');
    }
  });

  test('TC-08: any other key, modifier, phase or a composing IME is left to xterm', () => {
    for (const mac of [true, false]) {
      const left = (over) => legacyAltArrowSequence(altArrow('ArrowLeft', over), { mac });
      assert.equal(left({ altKey: false }), null, 'a plain arrow');
      assert.equal(left({ shiftKey: true }), null, '⇧⌥← is a selection key, not a word move');
      assert.equal(left({ ctrlKey: true }), null);
      assert.equal(left({ metaKey: true }), null, '⌘⌥← is the app\'s focus-previous-pane');
      assert.equal(left({ type: 'keyup' }), null);
      assert.equal(left({ type: 'keypress' }), null);
      assert.equal(left({ isComposing: true }), null);
      assert.equal(left({ keyCode: 229 }), null, 'the IME owns the key');
      assert.equal(legacyAltArrowSequence({ type: 'keydown', key: 'b', keyCode: 66, altKey: true }, { mac }), null);
      assert.equal(legacyAltArrowSequence(null, { mac }), null);
    }
  });

  test('TC-09: the terminal sends it from its key handler, after the suggestion layer has passed on the key', () => {
    const src = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf('const sendLegacyAltArrow = (event) => {'));
    assert.match(handler, /legacyAltArrowSequence\(event, \{ mac: isMac \}\)/);
    assert.match(handler, /entry\.term\.input\(sequence, true\)/, 'as a keystroke: every onData listener sees it');
    assert.match(handler, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/, 'and cancelled, as xterm cancels a key it sends');
    // The suggestion layer keeps first say (⌥→ over a ghost accepts it, as before).
    assert.match(src, /const sendKeyItself = \(event\) => sendLegacyAltArrow\(event\) \|\| /);
    assert.match(src, /if \(decision\.action === 'pass'\) return !sendKeyItself\(event\);/);
    assert.match(src, /entry\.term\.attachCustomKeyEventHandler\(handleKeyEvent\);/);
  });

  test('TC-10: a wheel over a pager is worth its pixels over the row height, the fraction carried — xterm 5.5\'s count', () => {
    const at21 = { cellHeight: 21, rows: 30 };
    assert.deepEqual(wheelArrowCount(wheelEvent(105), at21), { lines: 5, partial: 0 }, 'one mouse notch, 5 rows');
    const first = wheelArrowCount(wheelEvent(100), at21);
    assert.equal(first.lines, 4);
    assert.ok(Math.abs(first.partial - 16 / 21) < 1e-9, 'the rest of the notch is kept');
    assert.equal(wheelArrowCount(wheelEvent(100), { ...at21, partial: first.partial }).lines, 5, 'and counted with the next one');
    assert.equal(wheelArrowCount(wheelEvent(-63), at21).lines, -3, 'up is negative');
    // A trackpad: many small events, nothing lost between them.
    let partial = 0;
    let lines = 0;
    for (let i = 0; i < 25; i++) {
      const step = wheelArrowCount(wheelEvent(5.25), { ...at21, partial });
      lines += step.lines;
      partial = step.partial;
    }
    assert.equal(lines, 6, '25 × 5.25 px is 6.25 rows: 6 keys');
    assert.equal(partial, 0.25, 'and the quarter row waits for the next event');
  });

  test('TC-11: line and page events, Shift, ⌥ and a sensitivity, as 5.5 counted them', () => {
    const at21 = { cellHeight: 21, rows: 30 };
    assert.equal(wheelArrowCount(wheelEvent(3, { deltaMode: 1 }), at21).lines, 3, 'line mode: that many lines');
    assert.equal(wheelArrowCount(wheelEvent(1.5, { deltaMode: 1 }), at21).lines, 2, 'every step begun is a key');
    assert.equal(wheelArrowCount(wheelEvent(-1, { deltaMode: 2 }), at21).lines, -30, 'page mode: a screen');
    assert.deepEqual(wheelArrowCount(wheelEvent(105, { shiftKey: true }), at21), { lines: 0, partial: 0 }, 'Shift scrolls sideways');
    assert.equal(wheelArrowCount(wheelEvent(21, { altKey: true }), at21).lines, 5, '⌥: fastScrollSensitivity times');
    assert.equal(wheelArrowCount(wheelEvent(21), { ...at21, scrollSensitivity: 2 }).lines, 2);
    assert.deepEqual(wheelArrowCount(wheelEvent(0), at21), { lines: 0, partial: 0 });
    assert.deepEqual(wheelArrowCount(wheelEvent(50), { cellHeight: 0, rows: 30 }), { lines: 0, partial: 0 }, 'not laid out');
    assert.deepEqual(wheelArrowCount(null), { lines: 0, partial: 0 });
  });

  test('TC-12: on the alternate screen with no mouse reporting the wheel becomes that many arrows, and goes no further', () => {
    const term = wheelTerm();
    const notch = wheelEvent(105);
    assert.equal(term.handler(notch), false, 'xterm does not add its own single arrow');
    assert.deepEqual(term.sent, [{ data: '\x1b[B'.repeat(5), wasUserInput: true }]);
    assert.ok(notch.defaultPrevented && notch.stopped, 'cancelled, as xterm cancels a wheel it turned into keys');
    term.sent.length = 0;
    term.handler(wheelEvent(-42));
    assert.deepEqual(term.sent, [{ data: '\x1b[A\x1b[A', wasUserInput: true }]);

    const app = wheelTerm({ appCursor: true });
    app.handler(wheelEvent(42));
    assert.deepEqual(app.sent.map((s) => s.data), ['\x1bOB\x1bOB'], 'application cursor keys, as the program asked');

    const small = wheelTerm();
    assert.equal(small.handler(wheelEvent(10)), false);
    assert.deepEqual(small.sent, [], 'less than a row: kept for the next event, nothing sent');
    small.handler(wheelEvent(11));
    assert.deepEqual(small.sent.map((s) => s.data), ['\x1b[B']);
  });

  test('TC-13: anywhere else the wheel is xterm\'s, untouched', () => {
    for (const term of [wheelTerm({ type: 'normal' }), wheelTerm({ tracking: 'any' }), wheelTerm({ tracking: 'vt200' })]) {
      const event = wheelEvent(105);
      assert.equal(term.handler(event), true);
      assert.deepEqual(term.sent, []);
      assert.ok(!event.defaultPrevented && !event.stopped);
    }
    const noScrollback = wheelTerm({ type: 'normal', scrollback: 0 });
    assert.equal(noScrollback.handler(wheelEvent(42)), false, 'a normal screen with no scrollback is turned into keys too, as xterm does');
    assert.equal(installPagerWheel({}), false, 'an xterm without the slot is left alone');
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    assert.ok(create.indexOf('installPagerWheel(term);') > 0, 'every terminal the app makes has it');
  });
});

describe('Terminal compatibility: ⌥→ with the suggestion popup open', () => {
  // `gp` typed, the popup drawn, and ↓ moved its highlight onto `git push` —
  // a subsequence match, which → cannot take (`completionFor`).
  const popup = () => ({
    visible: true,
    ...rankedSuggestions('gp', ['git push', 'gpg --list-keys']),
    selectedIndex: 0,
    moved: true,
  });

  test('TC-14: ⌥→ over a highlighted match that does not continue the line clears the popup and still moves a word', () => {
    for (const [mac, word] of [
      [true, '\x1bf'],
      [false, '\x1b[1;5C'],
    ]) {
      const { handleKeyEvent, calls, EMPTY_SUGGEST_STATE } = terminalViewKeyHandler({ mac, suggestState: popup() });
      const event = keydown('ArrowRight', { altKey: true });
      assert.deepEqual(suggestionKeyAction(popup(), event), { action: 'clear', consume: false }, 'the layer lets the key go on');
      assert.equal(handleKeyEvent(event), false, "not xterm 6's own `CSI 1;3C`, which zsh types as `;3C`");
      assert.deepEqual(calls.input, [[word, true]], 'a word forward, as a keystroke');
      assert.ok(event.defaultPrevented && event.stopped, 'cancelled, as xterm cancels a key it sends');
      assert.deepEqual(calls.suggestState, [EMPTY_SUGGEST_STATE], 'and the popup is gone');
      assert.deepEqual(calls.writeRaw, [], 'nothing of `git push` is typed');
    }

    // Around it nothing moves: → and Enter still go to xterm, ⌥→ over a ghost still accepts it.
    for (const mac of [true, false]) {
      const plain = terminalViewKeyHandler({ mac, suggestState: popup() });
      assert.equal(plain.handleKeyEvent(keydown('ArrowRight')), true, '→ alone: xterm sends it');
      assert.deepEqual(plain.calls.input, []);
      const enter = terminalViewKeyHandler({ mac, suggestState: popup() });
      assert.equal(enter.handleKeyEvent(keydown('Enter', { keyCode: 13 })), true, 'Enter runs the line');
      assert.deepEqual(enter.calls.input, []);
      const ghost = terminalViewKeyHandler({
        mac,
        suggestState: { visible: true, ...rankedSuggestions('git st', ['git status']) },
      });
      assert.equal(ghost.handleKeyEvent(keydown('ArrowRight', { altKey: true })), false, 'taken by the layer');
      assert.deepEqual(ghost.calls.writeRaw, [['tab-1', 'atus']], 'the ghost is typed');
      assert.deepEqual(ghost.calls.input, [], 'with no word move on top of it');
    }
  });
});

describe('Terminal compatibility: X10 tracking and the wheel over a pager', () => {
  test("TC-15: X10 reports presses only — over a pager the wheel is still 5.5's arrows, not xterm's one", () => {
    const term = wheelTerm({ tracking: 'x10' });
    const notch = wheelEvent(105);
    assert.equal(term.handler(notch), false, 'xterm adds no arrow of its own');
    assert.deepEqual(term.sent, [{ data: '\x1b[B'.repeat(5), wasUserInput: true }]);
    assert.ok(notch.defaultPrevented && notch.stopped);
    for (const tracking of ['vt200', 'drag', 'any']) {
      const reported = wheelTerm({ tracking });
      assert.equal(reported.handler(wheelEvent(105)), true, `${tracking} reports the wheel: the program's`);
      assert.deepEqual(reported.sent, []);
    }
  });
});

describe('Terminal compatibility: the wheel over the scrollback, as far as xterm 5.5 scrolled it', () => {
  /** `deltas` through `wheelScrollRows` one after another, the remainder carried, mid-buffer. */
  const chain = (deltas, measure) => {
    let offset = 0;
    return deltas.map((deltaY) => {
      const result = wheelScrollRows(wheelEvent(deltaY), { ...measure, offset });
      offset = result.offset;
      return result.rows;
    });
  };
  const at16 = { cellHeight: 16, rows: 14 };

  test('TC-16: a notch is its pixels over the row height, rounded where 5.5 rounded — 6, 6, 7 rows at 16 px', () => {
    assert.deepEqual(chain([-100, -100, -100, -100], at16), [-6, -6, -7, -6], 'WebView2: deltaY 100 a notch (xterm 6 alone: 3)');
    assert.deepEqual(chain([100, 100, 100, 100], at16), [6, 7, 6, 6], 'down rounds the same position the other way');
    assert.deepEqual(
      wheelScrollRows(wheelEvent(-100), at16),
      { rows: -6, offset: -4 },
      'the quarter row a notch fell short of is kept, in pixels'
    );
    // WKWebView: deltaY 40 a notch, at the app's default 21 px rows — 1.9 a
    // notch where xterm 6 scrolled 2.4.
    const mac = chain(Array(21).fill(-40), { cellHeight: 21, rows: 30 });
    assert.deepEqual(mac.slice(0, 7), [-2, -2, -2, -2, -2, -1, -2]);
    assert.equal(mac.reduce((a, b) => a + b, 0), -40, '21 notches of 40 px: 40 rows of 21');
    assert.equal(chain(Array(20).fill(-4), at16).reduce((a, b) => a + b, 0), -5, 'a trackpad: 80 px, 5 rows');
  });

  test('TC-17: line and page events, ⌥, Shift, a sensitivity and both ends of the buffer, as 5.5 counted them', () => {
    assert.equal(wheelScrollRows(wheelEvent(-3, { deltaMode: 1 }), at16).rows, -3, 'a line event: that many rows');
    assert.equal(wheelScrollRows(wheelEvent(1, { deltaMode: 2 }), at16).rows, 14, 'a page event: a screen');
    assert.equal(wheelScrollRows(wheelEvent(-100, { altKey: true }), at16).rows, -31, '⌥: five times as far, 500 px');
    assert.deepEqual(wheelScrollRows(wheelEvent(-100, { shiftKey: true }), at16), { rows: 0, offset: 0 }, 'Shift: none');
    assert.equal(wheelScrollRows(wheelEvent(-16), { ...at16, scrollSensitivity: 2 }).rows, -2);
    assert.deepEqual(
      wheelScrollRows(wheelEvent(-100), { ...at16, min: -3 }),
      { rows: -3, offset: 0 },
      'three rows from the top: three, and nothing kept'
    );
    assert.deepEqual(wheelScrollRows(wheelEvent(100), { ...at16, max: 0 }), { rows: 0, offset: 0 }, 'at the bottom: nothing kept');
    assert.deepEqual(wheelScrollRows(wheelEvent(-100), { cellHeight: 0, rows: 14 }), { rows: 0, offset: 0 }, 'not laid out');
    assert.ok(Object.is(wheelScrollRows(wheelEvent(-4), at16).rows, 0), 'a sliver up is 0 rows, never -0');
  });

  test('TC-18: event for event the same count as 5.5 — thousands of random wheels, every unit, both ends', () => {
    let seed = 20261005;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (list) => list[Math.floor(random() * list.length)];
    for (let run = 0; run < 80; run += 1) {
      const cellHeight = pick([16, 17, 19, 21, 24, 16.5]);
      const rows = pick([10, 24, 37]);
      const maxRow = pick([0, 5, 40, 300]);
      const startRow = Math.floor(random() * (maxRow + 1));
      const events = Array.from({ length: 60 }, () => {
        const deltaMode = pick([0, 0, 0, 0, 1, 2]);
        const sign = pick([-1, 1]);
        const size = deltaMode === 0 ? pick([100, 40, 120, 1, 4, 7, 13, 33, 0]) : deltaMode === 1 ? pick([1, 2, 3]) : 1;
        return { deltaY: sign * size, deltaMode, altKey: random() < 0.15, shiftKey: random() < 0.1 };
      });
      const expected = scrollbackRows55(events, { cellHeight, rows, startRow, maxRow });
      let row = startRow;
      let offset = 0;
      const got = events.map((event) => {
        const result = wheelScrollRows(event, { cellHeight, rows, offset, min: -row, max: maxRow - row });
        row += result.rows;
        offset = result.offset;
        return result.rows;
      });
      assert.deepEqual(got, expected, `run ${run}: ${cellHeight} px rows, ${rows} on screen, from row ${startRow} of ${maxRow}`);
    }
  });

  test("TC-19: installed on the terminal's element in the capture phase, ahead of xterm, and the wheel cancelled there", () => {
    const term = scrollbackTerm();
    assert.ok(term.installed, 'installed');
    assert.equal(term.listeners.length, 1);
    const [{ eventType, options }] = term.listeners;
    assert.equal(eventType, 'wheel');
    assert.deepEqual(options, { capture: true, passive: false }, 'before the scrollable element inside it, and able to cancel');
    const notch = term.wheel(wheelEvent(-100));
    assert.deepEqual(term.scrolled, [-6], 'through `term.scrollLines`, which moves the scrollbar with it');
    assert.ok(notch.defaultPrevented && notch.stopped, "xterm's own 50 px a notch must not run as well");
    assert.deepEqual(scrollEach(term, [-100, -100, -100]), [-6, -7, -6]);
    assert.equal(scrollbackTerm({ open: false }).installed, null, 'not before `open`: there is no element to listen on');
  });

  test('TC-20: only over scrollback, and only while the program is not told about the wheel — X10 is not', () => {
    for (const over of [{ type: 'alternate' }, { scrollback: 0 }, { tracking: 'vt200' }, { tracking: 'drag' }, { tracking: 'any' }]) {
      const term = scrollbackTerm(over);
      const event = term.wheel(wheelEvent(-100));
      assert.deepEqual(term.scrolled, [], JSON.stringify(over));
      assert.ok(!event.defaultPrevented && !event.stopped, `${JSON.stringify(over)}: xterm's — a pager's arrows, or a report`);
    }
    assert.deepEqual(scrollEach(scrollbackTerm({ tracking: 'x10' }), [-100, -100, -100]), [-6, -6, -7], 'X10 reports no wheel');
    const sideways = scrollbackTerm();
    const swipe = sideways.wheel(wheelEvent(0, { deltaX: 30 }));
    assert.ok(!swipe.defaultPrevented && !swipe.stopped && sideways.scrolled.length === 0, 'a sideways swipe is left alone');
    const unlaid = scrollbackTerm({ cellHeight: 0 });
    const early = unlaid.wheel(wheelEvent(-100));
    assert.ok(!early.defaultPrevented && unlaid.scrolled.length === 0, 'not laid out: xterm scrolls it its own way');
  });

  test('TC-21: what a notch fell short of a row waits for the next — unless something else moved the view', () => {
    const kept = scrollbackTerm();
    assert.deepEqual(scrollEach(kept, [-100, -100, -100]), [-6, -6, -7], 'half a row left over makes the third notch 7');
    const moved = scrollbackTerm();
    assert.deepEqual(scrollEach(moved, [-100, -100]), [-6, -6]);
    // Output, a key or the scrollbar: 5.5 put its scrollTop back on the row.
    moved.scrollLines(-1);
    assert.deepEqual(scrollEach(moved, [-100]), [-6], 'counted from the row: 6, not 7');
  });

  test('TC-22: disposed with the terminal — the listener and the scroll subscription both go', () => {
    const term = scrollbackTerm();
    const [{ fn }] = term.listeners;
    assert.equal(term.scrollListenerCount(), 1);
    term.dispose();
    assert.deepEqual(
      term.removed.map((r) => [r.eventType, r.fn === fn, r.options?.capture]),
      [['wheel', true, true]],
      'the same listener, from the capture phase it was added to'
    );
    assert.equal(term.scrollListenerCount(), 0);
  });

  test("TC-23: every terminal the app makes has both wheel rules, the scrollback's after `open`", () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const open = create.indexOf('term.open(container);');
    assert.ok(open > 0 && create.indexOf('installPagerWheel(term);') > 0);
    assert.ok(create.indexOf('installScrollbackWheel(term);') > open, 'its listener needs `term.element`');
  });
});
