/**
 * The rules for what xterm.js is told about the pty behind it: how Windows'
 * ConPTY wraps and resizes, the size range the backend clamps a pty to, the
 * verbatim paths an older backend handed out — and what ⌥ and an arrow send,
 * which xterm 6 stopped deciding the way xterm 5.5 did.
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
  installPagerWheel,
} from '../../src/lib/terminalCompat.js';
import { suggestionKeyAction, lineAfterKey, rankedSuggestions, NEW_LINE } from '../../src/lib/suggestionLayer.js';
import { handleClipboardKey } from '../../src/lib/terminalClipboard.js';

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
    assert.match(src, /if \(decision\.action === 'pass'\) return !sendLegacyAltArrow\(event\);/);
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
