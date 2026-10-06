/**
 * The sticky command header.
 *
 * Scrolling back through a long build and losing track of which command you
 * are inside is what this fixes. The signal already arrives — OSC 133 "C"
 * says a command's output begins here — so the work is entirely in deciding
 * when NOT to show anything, which is where a header like this gets annoying,
 * and in keeping each command's row right while the buffer moves under it.
 *
 * A mark's row is an xterm marker. It used to be a number, `baseY + cursorY`
 * when the command started, pruned below `baseY - scrollback` — a bound that
 * never pruned anything, because `baseY` stops growing at `scrollback`. Once
 * the buffer was full every number named a row the content had moved out of:
 * with 5000 lines of scrollback and forty commands of 300 lines, the header
 * over `cmd39`'s output read `cmd16`. The SK-17 cases below run that, scaled
 * down, against xterm's own headless build.
 */
import { readFileSync } from 'node:fs';
// Static import, resolved before any other file's module hooks can stand in.
import headless from '@xterm/headless';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  MAX_COMMAND_MARKS,
  addCommandMark,
  settleCommandMarks,
  stickyCommandFor,
  trackCommandMarks,
} from '../../src/lib/stickyCommand.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';

const { Terminal: HeadlessTerminal } = headless;

/** A stand-in for an xterm marker: a row, until it is disposed. */
function fakeMarker(line) {
  return {
    line,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
      this.line = -1;
    },
  };
}
const mark = (line, command) => ({ marker: fakeMarker(line), command });

const marks = [mark(0, 'npm install'), mark(40, 'npm run build'), mark(120, 'npm test')];

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
    const later = [mark(80, 'npm test')];
    assert.equal(stickyCommandFor({ marks: later, viewportY: 10, baseY: 500 }), '');
  });

  test('SK-05: nothing when there is nothing to say', () => {
    assert.equal(stickyCommandFor({ marks: [], viewportY: 10, baseY: 500 }), '');
    assert.equal(stickyCommandFor({}), '');
    assert.equal(stickyCommandFor(), '');
  });

  test('SK-06: a malformed mark is skipped rather than shown', () => {
    const messy = [mark(0, 'ok'), { command: 'no marker' }, null, { marker: fakeMarker(10) }];
    assert.equal(stickyCommandFor({ marks: messy, viewportY: 20, baseY: 500 }), '');
    assert.equal(stickyCommandFor({ marks: [messy[0]], viewportY: 20, baseY: 500 }), 'ok');
  });

  test('SK-15: a mark gone off the top still owns the rows above the first mark left', () => {
    // A build longer than the scrollback: its own mark is the first to go,
    // and the header over its output must not go with it.
    const gone = mark(0, 'npm run build');
    gone.marker.dispose();
    const after = [gone, mark(300, 'npm test')];
    assert.equal(stickyCommandFor({ marks: after, viewportY: 10, baseY: 500 }), 'npm run build');
    assert.equal(stickyCommandFor({ marks: after, viewportY: 310, baseY: 500 }), 'npm test');
    // …but one gone AFTER a mark still in the buffer owns nothing.
    const late = mark(50, 'late');
    late.marker.dispose();
    assert.equal(stickyCommandFor({ marks: [mark(5, 'early'), late], viewportY: 60, baseY: 500 }), 'early');
  });
});

describe('Sticky command header: what to remember', () => {
  test('SK-07: a mark is added in order, on the marker it was given', () => {
    const ls = fakeMarker(5);
    const pwd = fakeMarker(9);
    const one = addCommandMark([], { marker: ls, command: 'ls' });
    const two = addCommandMark(one, { marker: pwd, command: 'pwd' });
    assert.deepEqual(two.map((m) => m.command), ['ls', 'pwd']);
    assert.equal(two[0].marker, ls);
    assert.equal(two[1].marker, pwd);
  });

  test('SK-08: a command with no text is not marked, and its marker is let go', () => {
    // A script, a paste the view refused to track, a multi-line construct —
    // a blank header is worse than no header.
    for (const command of ['', '   ', null]) {
      const m = fakeMarker(5);
      assert.deepEqual(addCommandMark([], { marker: m, command }), []);
      assert.equal(m.isDisposed, true, `marker of ${JSON.stringify(command)} disposed`);
    }
    const dead = fakeMarker(5);
    dead.dispose();
    assert.deepEqual(addCommandMark([], { marker: dead, command: 'ls' }), [], 'a dead marker marks nothing');
    assert.deepEqual(addCommandMark([], { command: 'ls' }), [], 'nor does none');
  });

  test('SK-09: the text is trimmed, because the header shows it raw', () => {
    const [only] = addCommandMark([], { marker: fakeMarker(1), command: '  npm test  ' });
    assert.equal(only.command, 'npm test');
  });

  test('SK-10: of the marks gone off the top, only the newest is kept', () => {
    // It owns the rows above the first mark left; the older ones own nothing,
    // and a terminal left running for days must not keep a mark per command.
    const first = mark(1, 'first');
    const second = mark(50, 'second');
    first.marker.dispose();
    second.marker.dispose();
    const kept = addCommandMark([first, second, mark(900, 'third')], { marker: fakeMarker(1000), command: 'fourth' });
    assert.deepEqual(kept.map((m) => m.command), ['second', 'third', 'fourth']);
  });

  test('SK-11: the input list is not modified', () => {
    const original = [mark(1, 'ls')];
    const snapshot = JSON.stringify(original);
    addCommandMark(original, { marker: fakeMarker(2), command: 'pwd' });
    assert.equal(JSON.stringify(original), snapshot);
  });

  test('SK-16: a command starting at or above marked rows drops them — the screen was cleared over them', () => {
    const a = mark(10, 'a');
    const b = mark(30, 'b');
    const c = mark(31, 'c');
    const kept = addCommandMark([a, b, c], { marker: fakeMarker(30), command: 'after clear' });
    assert.deepEqual(kept.map((m) => m.command), ['a', 'after clear']);
    assert.equal(b.marker.isDisposed, true, 'dropped marks let their markers go');
    assert.equal(c.marker.isDisposed, true);
    assert.equal(a.marker.isDisposed, false);
  });

  test(`SK-17: at most ${MAX_COMMAND_MARKS} marks, the oldest dropped first and its marker let go`, () => {
    let list = [];
    const all = [];
    for (let i = 0; i < MAX_COMMAND_MARKS + 25; i += 1) {
      const m = fakeMarker(i * 2);
      all.push(m);
      list = addCommandMark(list, { marker: m, command: `c${i}` });
    }
    assert.equal(list.length, MAX_COMMAND_MARKS);
    assert.equal(list[0].command, 'c25');
    assert.equal(all.filter((m) => m.isDisposed).length, 25);
    assert.equal(addCommandMark([mark(1, 'a'), mark(2, 'b')], { marker: fakeMarker(3), command: 'c', limit: 2 }).length, 2);
  });

  test('SK-18: settling gives an erased mark a new marker where it now is, and drops what owns nothing', () => {
    const anchor = mark(10, 'kept');
    const wiped = mark(60, 'wiped');
    const current = mark(70, 'current');
    wiped.marker.dispose();
    current.marker.dispose();
    // Both erased by one clear; the screen's top was 50 rows below the anchor.
    wiped.lost = { anchor: anchor.marker, offset: 40 };
    current.lost = { anchor: anchor.marker, offset: 40 };
    const made = [];
    const settled = settleCommandMarks([anchor, wiped, current], {
      markAt: (row) => {
        const m = fakeMarker(row);
        made.push(m);
        return m;
      },
    });
    assert.deepEqual(settled.map((m) => m.command), ['kept', 'current'], 'what followed the top of the screen is the newest one’s');
    assert.equal(made.length, 1);
    assert.equal(made[0].line, 50);
    assert.equal(settled[1].marker, made[0]);
    assert.equal(stickyCommandFor({ marks: settled, viewportY: 55, baseY: 100 }), 'current');
    assert.equal(stickyCommandFor({ marks: settled, viewportY: 45, baseY: 100 }), 'kept');
  });
});

// ---------------------------------------------------------------------------
// Against xterm itself: the buffer trims, erases and reflows, and a marker
// does what xterm does with it.

const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
// Marks are settled a moment after a marker dies.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function terminal({ scrollback = 100, rows = 10, cols = 40 } = {}) {
  const term = new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
  return { term, marks: trackCommandMarks(term) };
}

/** A prompt, the command typed at it, OSC 133 "C" — then its output. */
async function run(t, command, lines) {
  await write(t.term, `$ ${command}\r\n`);
  t.marks.mark(command);
  let out = '';
  for (let i = 0; i < lines; i += 1) out += `${command} out ${i}\r\n`;
  await write(t.term, out);
}

/**
 * Scroll to every row with scrollback above it and compare the header with
 * what the top line shows: a line of output is its command's; the prompt a
 * command was typed at is the command before's, where its output region ends.
 */
function wrongRows(t, order) {
  const buffer = t.term.buffer.active;
  const wrong = [];
  let checked = 0;
  for (let y = 0; y < buffer.baseY; y += 1) {
    t.term.scrollToLine(y);
    const top = buffer.getLine(buffer.viewportY).translateToString(true);
    const output = /^(\S+) out \d+/.exec(top);
    const prompt = /^\$ (\S+)/.exec(top);
    let want = null;
    if (output) want = output[1];
    else if (prompt && order.indexOf(prompt[1]) > 0) want = order[order.indexOf(prompt[1]) - 1];
    if (want === null) continue;
    checked += 1;
    const got = t.marks.current();
    if (got !== want) wrong.push(`row ${y} "${top}": header "${got}", wanted "${want}"`);
  }
  t.term.scrollToBottom();
  assert.ok(checked > 0, 'something was checked');
  return wrong;
}

function done(t) {
  t.marks.dispose();
  t.term.dispose();
}

describe('Sticky command header: against xterm', () => {
  test('SK-19: forty commands past a full scrollback — every row names its own command', async () => {
    const t = terminal({ scrollback: 1000, rows: 30 });
    const order = [];
    for (let k = 0; k < 40; k += 1) {
      order.push(`cmd${k}`);
      await run(t, `cmd${k}`, 60);
    }
    await settled();
    const wrong = wrongRows(t, order);
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} rows named the wrong command`);
    // What went off the top went from the list too, but the one owning the top.
    assert.ok(t.marks.marks.length <= 18, `${t.marks.marks.length} marks kept for 1000 rows of 61-row commands`);
    done(t);
  });

  test('SK-20: a build longer than the scrollback keeps its header all the way up', async () => {
    const t = terminal();
    await run(t, 'setup', 3);
    await run(t, 'build', 500);
    await settled();
    assert.deepEqual(wrongRows(t, ['setup', 'build']), []);
    assert.deepEqual(t.marks.marks.map((m) => m.command), ['build']);
    done(t);
  });

  test('SK-21: Ctrl+L at a prompt — the scrollback keeps its headers, the commands after it get theirs', async () => {
    const t = terminal({ scrollback: 1000 });
    const order = [];
    for (let k = 0; k < 6; k += 1) {
      order.push(`c${k}`);
      await run(t, `c${k}`, 7);
    }
    // zsh's clear-screen: home, erase the screen; the scrollback stays.
    await write(t.term, '$ \x1b[H\x1b[2J');
    await settled();
    for (let k = 6; k < 10; k += 1) {
      order.push(`c${k}`);
      await run(t, `c${k}`, 7);
    }
    await settled();
    assert.deepEqual(wrongRows(t, order), []);
    done(t);
  });

  test('SK-22: a watcher clearing the screen between runs keeps its own header', async () => {
    // Node's console.clear() — home, erase below — as jest, vitest and
    // nodemon do between runs. The erase disposes the watcher's own marker.
    const t = terminal({ scrollback: 1000 });
    await run(t, 'setup', 30);
    await run(t, 'more', 30);
    await write(t.term, '$ watch\r\n');
    t.marks.mark('watch');
    for (let pass = 0; pass < 5; pass += 1) {
      let out = '\x1b[1;1H\x1b[0J';
      for (let i = 0; i < 25; i += 1) out += `watch out ${pass * 100 + i}\r\n`;
      await write(t.term, out);
      await settled();
    }
    assert.deepEqual(wrongRows(t, ['setup', 'more', 'watch']), []);
    done(t);
  });

  test('SK-23: a watcher with no scrollback yet, and one whose output trims the buffer between clears', async () => {
    const fresh = terminal({ rows: 12 });
    await run(fresh, 'a', 2);
    await write(fresh.term, '$ watch\r\n');
    fresh.marks.mark('watch');
    for (let pass = 0; pass < 3; pass += 1) {
      let out = '\x1b[1;1H\x1b[0J';
      for (let i = 0; i < 20; i += 1) out += `watch out ${pass * 100 + i}\r\n`;
      await write(fresh.term, out);
      await settled();
    }
    assert.deepEqual(wrongRows(fresh, ['a', 'watch']), []);
    done(fresh);

    const busy = terminal({ scrollback: 100 });
    await run(busy, 'one', 20);
    await run(busy, 'two', 20);
    await write(busy.term, '$ watch\r\n');
    busy.marks.mark('watch');
    for (let pass = 0; pass < 4; pass += 1) {
      let out = '\x1b[1;1H\x1b[0J';
      for (let i = 0; i < 70; i += 1) out += `watch out ${pass * 100 + i}\r\n`;
      await write(busy.term, out);
      await settled();
    }
    assert.deepEqual(wrongRows(busy, ['one', 'two', 'watch']), []);
    done(busy);
  });

  test('SK-24: `clear` (scrollback and screen) and jest’s clear', async () => {
    const t = terminal({ scrollback: 1000 });
    const order = [];
    for (let k = 0; k < 6; k += 1) {
      order.push(`d${k}`);
      await run(t, `d${k}`, 10);
    }
    order.push('clear');
    await write(t.term, '$ clear\r\n');
    t.marks.mark('clear');
    await write(t.term, '\x1b[3J\x1b[H\x1b[2J');
    await settled();
    for (let k = 6; k < 12; k += 1) {
      order.push(`d${k}`);
      await run(t, `d${k}`, 10);
    }
    await settled();
    assert.deepEqual(wrongRows(t, order), []);
    done(t);

    const jest = terminal({ scrollback: 500 });
    await run(jest, 'one', 30);
    await run(jest, 'two', 30);
    await write(jest.term, '$ jest\r\n');
    jest.marks.mark('jest');
    for (let pass = 0; pass < 3; pass += 1) {
      let out = '\x1b[2J\x1b[3J\x1b[H';
      for (let i = 0; i < 30; i += 1) out += `jest out ${pass * 100 + i}\r\n`;
      await write(jest.term, out);
      await settled();
    }
    assert.deepEqual(wrongRows(jest, ['one', 'two', 'jest']), []);
    done(jest);
  });

  test('SK-25: a resize that reflows wrapped output moves the marks with it', async () => {
    const t = terminal({ scrollback: 500, cols: 40 });
    const order = [];
    const wide = async (name) => {
      order.push(name);
      await write(t.term, `$ ${name}\r\n`);
      t.marks.mark(name);
      for (let i = 0; i < 6; i += 1) await write(t.term, `${name} out ${i} ${'x'.repeat(60)}\r\n`);
    };
    for (let k = 0; k < 8; k += 1) await wide(`w${k}`);
    t.term.resize(100, 10);
    for (let k = 8; k < 12; k += 1) await wide(`w${k}`);
    t.term.resize(30, 10);
    await settled();
    assert.deepEqual(wrongRows(t, order), []);
    done(t);
  });

  test('SK-26: under a full-screen program nothing is marked, and nothing is shown', async () => {
    const t = terminal({ scrollback: 500 });
    await run(t, 'one', 15);
    await write(t.term, '$ vim\r\n');
    t.marks.mark('vim');
    await write(t.term, '\x1b[?1049h\x1b[H\x1b[2Jvim screen\r\n');
    t.marks.mark('typed inside vim');
    assert.equal(t.marks.current(), '', 'the alternate buffer has no header');
    await write(t.term, '\x1b[?1049l');
    await run(t, 'two', 15);
    await settled();
    assert.deepEqual(t.marks.marks.map((m) => m.command), ['one', 'vim', 'two']);
    assert.deepEqual(wrongRows(t, ['one', 'vim', 'two']), []);
    done(t);
  });

  test(`SK-27: xterm holds at most ${MAX_COMMAND_MARKS} markers for the header, and none once it is disposed`, async () => {
    const t = terminal({ scrollback: 5000, rows: 5 });
    for (let k = 0; k < MAX_COMMAND_MARKS + 100; k += 1) await run(t, `k${k}`, 1);
    await settled();
    assert.equal(t.marks.marks.length, MAX_COMMAND_MARKS);
    assert.equal(t.term.markers.length, MAX_COMMAND_MARKS, 'the dropped ones were let go');
    t.marks.dispose();
    assert.equal(t.term.markers.length, 0);
    assert.equal(t.marks.current(), '');
    t.marks.mark('after dispose');
    assert.equal(t.term.markers.length, 0, 'a disposed tracker makes no markers');
    t.term.dispose();
  });

  test('SK-28: wired — the view marks through the terminal’s tracker, which the registry makes and disposes', () => {
    const view = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8');
    assert.match(view, /entry\.commandMarks\.mark\(lastSubmittedRef\.current\)/);
    assert.match(view, /entry\.commandMarks\.current\(\)/);
    assert.doesNotMatch(view, /options\.scrollback|oldestLine/, 'no row bound of its own, worked out from the scrollback');
    assert.doesNotMatch(view, /commandMarksRef/, 'the marks are the terminal’s, not the view’s');
    const registry = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    assert.match(registry, /commandMarks: trackCommandMarks\(term\)/);
    const dispose = registry.slice(registry.indexOf('export function disposeTerminal('));
    assert.ok(dispose.indexOf('entry.commandMarks.dispose();') !== -1, 'disposed with the terminal');
    assert.ok(
      dispose.indexOf('entry.commandMarks.dispose();') < dispose.indexOf('entry.term.dispose();'),
      'before the terminal itself'
    );
  });
});

describe('Sticky command header: the setting', () => {
  test('SK-12: on by default, because it is absent most of the time', () => {
    const defaults = useSettingsStore.getState().settingsDefaults;
    assert.equal(defaults.terminalStickyHeader, true);
  });

  test('SK-13: it can be turned off and back on', () => {
    const S = useSettingsStore.getState();
    S.setSetting('terminalStickyHeader', false);
    assert.equal(useSettingsStore.getState().terminalStickyHeader, false);
    S.setSetting('terminalStickyHeader', true);
    assert.equal(useSettingsStore.getState().terminalStickyHeader, true);
  });

  test('SK-14: resetting the settings brings it back', () => {
    useSettingsStore.getState().setSetting('terminalStickyHeader', false);
    useSettingsStore.getState().resetSettings();
    assert.equal(useSettingsStore.getState().terminalStickyHeader, true);
  });
});
