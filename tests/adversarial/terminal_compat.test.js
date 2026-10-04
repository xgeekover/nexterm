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
} from '../../src/lib/terminalCompat.js';

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
});
