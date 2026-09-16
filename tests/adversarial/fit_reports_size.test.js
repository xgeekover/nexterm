/**
 * A refit that the shell is never told about.
 *
 * The pty only learns its size from `resizePty`, and the only thing that used
 * to call it was `TerminalView`'s ResizeObserver — which watches the pane, not
 * the font. Changing the terminal font or line height refits the grid inside a
 * pane that has not moved, so the observer never fired and the shell kept the
 * old size. Measured in a real browser against the running app: halving the
 * font took the grid from 107x33 to 251x70 while the backend still held
 * 107x33, with zero `pty_resize` calls, and it stayed wrong until the sidebar
 * was toggled and something finally re-measured. Anything drawing a full
 * screen — vim, htop, a TUI — drew for 107 columns in a 251-column window.
 *
 * Both call sites now go through `fitAndReport`, so "fit" and "tell the shell"
 * cannot come apart again. These cases hold that: every path that fits either
 * reports a size or explains why it could not.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { fitAndReport, PTY_COLS, PTY_ROWS } from '../../src/lib/terminalCompat.js';

/** A stand-in for an xterm instance and its fit addon. */
function fakeTerminal({ propose, cols = 80, rows = 24, fitThrows = false, proposeThrows = false } = {}) {
  const calls = [];
  const term = {
    cols,
    rows,
    resize(c, r) {
      this.cols = c;
      this.rows = r;
      calls.push(`term.resize(${c},${r})`);
    },
  };
  const fitAddon = {
    proposeDimensions() {
      if (proposeThrows) throw new Error('not laid out');
      return propose;
    },
    fit() {
      if (fitThrows) throw new Error('container has no size');
      // The real addon resizes the terminal as part of fitting.
      if (propose) {
        term.cols = Math.floor(propose.cols);
        term.rows = Math.floor(propose.rows);
      }
      calls.push('fitAddon.fit()');
    },
  };
  return { term, fitAddon, calls };
}

const run = (fake, extra = {}) => {
  const reported = [];
  const size = fitAndReport({
    tabId: 'tab-1',
    term: fake.term,
    fitAddon: fake.fitAddon,
    resizePty: (...args) => reported.push(args),
    ...extra,
  });
  return { size, reported };
};

describe('Fitting a terminal always tells the shell the size', () => {
  test('FR-01: a refit reports the size that came out of it', () => {
    // The measured case: a smaller font fits 251x70 where 107x33 fitted before.
    const fake = fakeTerminal({ propose: { cols: 251, rows: 70 }, cols: 107, rows: 33 });
    const { size, reported } = run(fake);

    assert.deepEqual(size, { cols: 251, rows: 70 }, 'the new grid is returned');
    assert.deepEqual(reported, [['tab-1', 251, 70]], 'and the shell is told exactly once');
    assert.ok(fake.calls.includes('fitAddon.fit()'), 'the terminal really was refitted');
  });

  test('FR-02: a pane too small to be a terminal is left alone, and nothing is sent', () => {
    // A pane mid-layout can measure a column or two. Sending that on would
    // have xterm wrap at 2 columns while the backend, which never goes below
    // its floor, had the shell writing for that floor instead.
    const fake = fakeTerminal({ propose: { cols: 2, rows: 1 }, cols: 107, rows: 33 });
    const { size, reported } = run(fake);

    assert.equal(size, null, 'nothing is reported for an unmeasurable pane');
    assert.deepEqual(reported, [], 'and the shell is not told a nonsense size');
    assert.equal(fake.term.cols, 107, 'the terminal keeps the size it had');
    assert.equal(fake.calls.includes('fitAddon.fit()'), false, 'and is not refitted');
  });

  test('FR-03: an oversized pane stops at the size the backend will accept', () => {
    // Both sides have to agree, and the backend clamps.
    const fake = fakeTerminal({ propose: { cols: 5000, rows: 5000 } });
    const { size, reported } = run(fake);

    assert.equal(size.cols, PTY_COLS.max, `columns stop at ${PTY_COLS.max}`);
    assert.equal(size.rows, PTY_ROWS.max, `rows stop at ${PTY_ROWS.max}`);
    assert.deepEqual(reported, [['tab-1', PTY_COLS.max, PTY_ROWS.max]]);
  });

  test('FR-04: when fit lands off the agreed size, the agreed size wins', () => {
    // `fit` measures again itself and can land a row or two away from what
    // `proposeDimensions` just said. Letting that stand is how the two sides
    // drift by a row without anything noticing.
    const fake = fakeTerminal({ propose: { cols: 5000, rows: 40 } });
    const { size, reported } = run(fake);

    assert.equal(size.cols, PTY_COLS.max, 'the clamped width is what is used');
    assert.ok(fake.calls.includes(`term.resize(${PTY_COLS.max},40)`), 'the terminal is pulled back to it');
    assert.deepEqual(reported, [['tab-1', PTY_COLS.max, 40]], 'and that is what the shell is told');
  });

  test('FR-05: a container that is not laid out yet reports nothing rather than guessing', () => {
    for (const broken of [
      { propose: { cols: 100, rows: 30 }, proposeThrows: true },
      { propose: { cols: 100, rows: 30 }, fitThrows: true },
      { propose: null },
    ]) {
      const fake = fakeTerminal(broken);
      const { size, reported } = run(fake);
      assert.equal(size, null, `no size for ${JSON.stringify(Object.keys(broken))}`);
      assert.deepEqual(reported, [], 'and nothing is sent');
    }
  });

  test('FR-06: an off-screen pane is skipped entirely', () => {
    // A terminal in a group that is not on screen has no measurable container.
    const fake = fakeTerminal({ propose: { cols: 251, rows: 70 } });
    const { size, reported } = run(fake, { fittable: false });

    assert.equal(size, null);
    assert.deepEqual(reported, []);
    assert.deepEqual(fake.calls, [], 'it is not even measured');
  });

  test('FR-07: a caller with no resizePty still refits without throwing', () => {
    // The store hands its action in; a terminal built before the store is
    // ready must not take the whole refit down with it.
    const fake = fakeTerminal({ propose: { cols: 120, rows: 40 } });
    const size = fitAndReport({ tabId: 'tab-1', term: fake.term, fitAddon: fake.fitAddon });
    assert.deepEqual(size, { cols: 120, rows: 40 });
  });
});
