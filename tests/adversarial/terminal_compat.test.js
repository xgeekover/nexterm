/**
 * The rules for what xterm.js is told about the pty behind it: how Windows'
 * ConPTY wraps and resizes, the size range the backend clamps a pty to, and
 * the verbatim paths an older backend handed out.
 */

import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  PTY_COLS,
  PTY_ROWS,
  windowsPtyFor,
  usablePtySize,
  withoutVerbatimPrefix,
} from '../../src/lib/terminalCompat.js';

describe('Terminal compatibility: windowsPty, pty size, verbatim paths', () => {
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
});
