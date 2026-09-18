/**
 * The sticky command header.
 *
 * Scrolling back through a long build and losing track of which command you
 * are inside is what this fixes. The signal already arrives — OSC 133 "C"
 * says a command's output begins here — so the work is entirely in deciding
 * when NOT to show anything, which is where a header like this gets annoying.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { stickyCommandFor, addCommandMark } from '../../src/lib/stickyCommand.js';

const marks = [
  { line: 0, command: 'npm install' },
  { line: 40, command: 'npm run build' },
  { line: 120, command: 'npm test' },
];

describe('Sticky command header: what to show', () => {
  test('SK-01: the command whose output the top of the viewport is inside', () => {
    assert.equal(stickyCommandFor({ marks, viewportY: 10, baseY: 500 }), 'npm install');
    assert.equal(stickyCommandFor({ marks, viewportY: 40, baseY: 500 }), 'npm run build');
    assert.equal(stickyCommandFor({ marks, viewportY: 119, baseY: 500 }), 'npm run build');
    assert.equal(stickyCommandFor({ marks, viewportY: 400, baseY: 500 }), 'npm test');
  });

  test('SK-02: nothing at the bottom, where the header would only repeat the screen', () => {
    assert.equal(stickyCommandFor({ marks, viewportY: 500, baseY: 500 }), '');
    assert.equal(stickyCommandFor({ marks, viewportY: 501, baseY: 500 }), '');
  });

  test('SK-03: nothing in the alternate buffer', () => {
    // vim and htop own the whole screen; there is no scrollback to be lost in.
    assert.equal(stickyCommandFor({ marks, viewportY: 10, baseY: 500, alternate: true }), '');
  });

  test('SK-04: nothing above the first mark', () => {
    // Output from before the app was watching, or from a shell with no
    // integration at all. Guessing would be worse than saying nothing.
    const later = [{ line: 80, command: 'npm test' }];
    assert.equal(stickyCommandFor({ marks: later, viewportY: 10, baseY: 500 }), '');
  });

  test('SK-05: nothing when there is nothing to say', () => {
    assert.equal(stickyCommandFor({ marks: [], viewportY: 10, baseY: 500 }), '');
    assert.equal(stickyCommandFor({}), '');
    assert.equal(stickyCommandFor(), '');
  });

  test('SK-06: a malformed mark is skipped rather than shown', () => {
    const messy = [{ line: 0, command: 'ok' }, { command: 'no line' }, null, { line: 10 }];
    assert.equal(stickyCommandFor({ marks: messy, viewportY: 20, baseY: 500 }), '');
    assert.equal(stickyCommandFor({ marks: [messy[0]], viewportY: 20, baseY: 500 }), 'ok');
  });
});

describe('Sticky command header: what to remember', () => {
  test('SK-07: a mark is added in order', () => {
    const one = addCommandMark([], { line: 5, command: 'ls' });
    const two = addCommandMark(one, { line: 9, command: 'pwd' });
    assert.deepEqual(two, [{ line: 5, command: 'ls' }, { line: 9, command: 'pwd' }]);
  });

  test('SK-08: a command with no text is not marked', () => {
    // A script, a paste the view refused to track, a multi-line construct —
    // a blank header is worse than no header.
    assert.deepEqual(addCommandMark([], { line: 5, command: '' }), []);
    assert.deepEqual(addCommandMark([], { line: 5, command: '   ' }), []);
    assert.deepEqual(addCommandMark([], { line: 5, command: null }), []);
    assert.deepEqual(addCommandMark([], { line: null, command: 'ls' }), []);
  });

  test('SK-09: the text is trimmed, because the header shows it raw', () => {
    assert.deepEqual(addCommandMark([], { line: 1, command: '  npm test  ' }), [
      { line: 1, command: 'npm test' },
    ]);
  });

  test('SK-10: marks that scrolled out of the buffer are dropped', () => {
    // Without this a terminal left running a loop overnight keeps a mark per
    // iteration long after the output itself is gone.
    const old = [
      { line: 1, command: 'first' },
      { line: 50, command: 'second' },
      { line: 900, command: 'third' },
    ];
    const kept = addCommandMark(old, { line: 1000, command: 'fourth', oldestLine: 500 });
    assert.deepEqual(kept.map((m) => m.command), ['third', 'fourth']);
  });

  test('SK-11: the input list is not modified', () => {
    const original = [{ line: 1, command: 'ls' }];
    const snapshot = JSON.stringify(original);
    addCommandMark(original, { line: 2, command: 'pwd' });
    assert.equal(JSON.stringify(original), snapshot);
  });
});
