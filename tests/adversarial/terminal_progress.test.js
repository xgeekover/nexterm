/**
 * How far along a program in a terminal says it is — ConEmu's OSC 9;4, which
 * Windows Terminal adopted — on the tab chip, the group chip and, on Windows,
 * the taskbar.
 *
 * xterm.js 6.0 drops the sequence, and NexTerm's notification handler
 * refuses every ConEmu sub-command so that a progress report is never read as
 * a message (PN-32). So a second OSC 9 handler takes `4;…` and nothing else,
 * the store keeps a bar per tab outside `tabs`, paced to ten updates a
 * second, and the taskbar is told the bars added up, four times a second at
 * most. See src/lib/terminalProgress.js.
 *
 * The parsing runs through real xterm (`@xterm/headless`, the same core as
 * the app's), beside the real notification addon; the bars through the real
 * store over the browser mock; the taskbar through the mock's recording of
 * `set_taskbar_progress`, and the Rust command's own tests (`cargo test
 * taskbar`).
 */
import { readFileSync } from 'node:fs';
// Static, as in program_notifications.test.js: other files in this runner
// register module hooks that turn `@xterm/*` into test doubles.
import headless from '@xterm/headless';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import {
  PROGRESS_INTERVAL_MS,
  PROGRESS_PAYLOAD_MAX,
  TASKBAR_INTERVAL_MS,
  TASKBAR_STATUSES,
  aggregateProgress,
  createLatestThrottle,
  createTaskbarDriver,
  groupProgress,
  installTerminalProgress,
  nextProgress,
  parseProgress,
  sameProgress,
  taskbarProgress,
} from '../../src/lib/terminalProgress.js';
import { installProgramNotifications } from '../../src/lib/programNotifications.js';
// Whole modules as well, for what the fix pass added: read inside each case,
// so a case fails on its own when one is missing rather than the file.
import * as progressLib from '../../src/lib/terminalProgress.js';
import * as outputBus from '../../src/lib/ptyOutputBus.js';
import {
  useTerminalStore as S,
  __attentionKept,
  __setProgressIntervalMs,
  setTerminalOutputBarrier,
} from '../../src/stores/terminalStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { startAttention } from '../../src/hooks/useAttention.js';

const { attachOutput, deliver, resetPtyOutputBus } = outputBus;

const { Terminal } = headless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const osc9 = (payload, end = BEL) => `${ESC}]9;${payload}${end}`;

const bar = (state, value = null) => ({ state, value });

/** A clock and timers the case moves by hand. */
function manualTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    /** Move the clock to `t`, running each timer due by then, in order. */
    advance(t) {
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = t;
    },
    get pending() {
      return timers.size;
    },
  };
}

describe('Terminal progress: reading OSC 9;4', () => {
  test('TP-01: every state, a missing or empty amount, leading zeros, and the amount held at 100', () => {
    const cases = [
      ['4;0', bar('remove')],
      ['4;0;', bar('remove')],
      ['4;0;50', bar('remove')],
      ['4;1;50', bar('normal', 50)],
      ['4;1', bar('normal')],
      ['4;1;', bar('normal')],
      ['4;1;0', bar('normal', 0)],
      ['4;1;100', bar('normal', 100)],
      ['4;2;30', bar('error', 30)],
      ['4;2', bar('error')],
      ['4;2;', bar('error')],
      ['4;3', bar('indeterminate')],
      ['4;3;70', bar('indeterminate')],
      ['4;4;10', bar('warning', 10)],
      ['4;4', bar('warning')],
      ['4;01;007', bar('normal', 7)],
      ['4;0001;0100', bar('normal', 100)],
      ['4;1;150', bar('normal', 100)],
      ['4;1;99999999999999999999', bar('normal', 100)],
    ];
    for (const [payload, expected] of cases) assert.deepEqual(parseProgress(payload), expected, payload);
  });

  test('TP-02: refused whole — a state outside 0–4, anything but ASCII digits, more fields, and anything long', () => {
    const refused = [
      '4;5;10', '4;9', '4;10;5', '4;00005;1',
      '4;1;5a', '4;1;-5', '4;1;+5', '4;1;5.5', '4;1; 5', '4;1;5 ', '4;a;5', '4;-1;5', '4; 1;5',
      // Digits, but not ASCII ones: fullwidth 5, Arabic-Indic 5.
      '4;1;\u{FF15}', '4;1;\u{0665}', '4;\u{FF11};5',
      '4;1;50;7', '4;;50', '4;;', '4', '4;', '', ';4;1;5', ' 4;1;5', '40;1;5', '04;1;5', '9;C:\\Users', '4;1;50\n',
      `4;1;${'0'.repeat(PROGRESS_PAYLOAD_MAX)}`,
    ];
    for (const payload of refused) assert.equal(parseProgress(payload), null, JSON.stringify(payload));
    for (const value of [null, undefined, 4, {}, ['4;1;5']]) assert.equal(parseProgress(value), null);

    // The cap is on the payload's length, and the longest taken is exactly it.
    const longest = `4;1;${'0'.repeat(PROGRESS_PAYLOAD_MAX - 6)}50`;
    assert.equal(longest.length, PROGRESS_PAYLOAD_MAX);
    assert.deepEqual(parseProgress(longest), bar('normal', 50));
    assert.equal(parseProgress(`4;1;0${longest.slice(4)}`), null, 'one more character and it is not looked at');
    // A megabyte costs a length check.
    assert.equal(parseProgress(`4;1;${'5'.repeat(1 << 20)}`), null);
  });

  test('TP-03: the bar a report leaves — 0 for a normal bar with no amount; an error or warning keeps the amount before it', () => {
    assert.deepEqual(nextProgress(null, bar('normal')), bar('normal', 0));
    assert.deepEqual(nextProgress(bar('normal', 40), bar('normal', 60)), bar('normal', 60));
    assert.deepEqual(nextProgress(bar('normal', 40), bar('error')), bar('error', 40), 'a build failing at 40% stays at 40%');
    assert.deepEqual(nextProgress(bar('normal', 40), bar('warning')), bar('warning', 40));
    assert.deepEqual(nextProgress(bar('warning', 40), bar('error', 70)), bar('error', 70), 'an amount given wins');
    assert.deepEqual(nextProgress(null, bar('error')), bar('error'), 'nothing before: a full bar');
    assert.deepEqual(nextProgress(bar('indeterminate'), bar('warning')), bar('warning'), 'an indeterminate bar had no amount');
    assert.deepEqual(nextProgress(bar('error', 30), bar('indeterminate')), bar('indeterminate'));
    assert.deepEqual(nextProgress(bar('error', 30), bar('normal')), bar('normal', 0));
    for (const before of [null, bar('normal', 5), bar('error'), bar('indeterminate')]) {
      assert.equal(nextProgress(before, bar('remove')), null, 'state 0 takes it down');
    }
    assert.deepEqual(nextProgress(bar('normal', 5), null), bar('normal', 5), 'no report, no change');
    assert.deepEqual(nextProgress(bar('normal', 5), { state: 'sideways' }), bar('normal', 5));

    assert.ok(sameProgress(null, undefined));
    assert.ok(sameProgress(bar('normal', 5), { state: 'normal', value: 5 }));
    assert.ok(!sameProgress(bar('normal', 5), bar('normal', 6)));
    assert.ok(!sameProgress(bar('error'), bar('warning')));
    assert.ok(!sameProgress(bar('error'), null));
  });

  test('TP-04: several bars as one — error over warning over normal over indeterminate, at the lowest amount', () => {
    assert.deepEqual(taskbarProgress({}), { status: 'none', progress: null });
    assert.deepEqual(taskbarProgress(undefined), { status: 'none', progress: null });
    assert.deepEqual(taskbarProgress({ a: bar('normal', 30), b: bar('normal', 80) }), { status: 'normal', progress: 30 });
    assert.deepEqual(taskbarProgress({ a: bar('indeterminate'), b: bar('normal', 80) }), { status: 'normal', progress: 80 });
    assert.deepEqual(taskbarProgress({ a: bar('indeterminate') }), { status: 'indeterminate', progress: null }, 'no amount for an indeterminate bar');
    assert.deepEqual(taskbarProgress({ a: bar('normal', 10), b: bar('warning', 70) }), { status: 'paused', progress: 70 });
    assert.deepEqual(
      taskbarProgress({ a: bar('warning', 70), b: bar('error', 90), c: bar('error', 20), d: bar('normal', 1) }),
      { status: 'error', progress: 20 }
    );
    assert.deepEqual(taskbarProgress({ a: bar('error') }), { status: 'error', progress: 100 }, 'an error with no amount is a full bar');
    assert.deepEqual(taskbarProgress({ a: bar('error'), b: bar('error', 40) }), { status: 'error', progress: 40 });
    assert.deepEqual(taskbarProgress({ a: bar('warning'), b: bar('normal', 5) }), { status: 'paused', progress: 100 });
    assert.deepEqual(taskbarProgress({ a: bar('normal', 33.4) }), { status: 'normal', progress: 33 }, 'a whole percentage');
    assert.deepEqual(taskbarProgress({ a: null, b: { state: 'remove' }, c: { nope: 1 } }), { status: 'none', progress: null });
    for (const { status } of [taskbarProgress({}), taskbarProgress({ a: bar('warning', 1) })]) {
      assert.ok(TASKBAR_STATUSES.includes(status));
    }

    // A group chip: the same rule, over its own tabs only.
    const map = { a: bar('normal', 60), b: bar('error'), c: bar('normal', 20) };
    assert.deepEqual(groupProgress(map, ['a', 'c']), bar('normal', 20));
    assert.deepEqual(groupProgress(map, ['a', 'b']), bar('error'), 'a full red bar');
    assert.equal(groupProgress(map, ['x']), null);
    assert.equal(groupProgress(map, []), null);
    assert.deepEqual(aggregateProgress([bar('indeterminate'), bar('indeterminate')]), bar('indeterminate'));
  });
});

describe('Terminal progress: through real xterm', () => {
  /** A real xterm 6 with the progress addon, and the notification addon beside it unless `notifications` is false. */
  function terminal({ enabled = () => true, notifications = true, progressFirst = true, onProgress } = {}) {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const reports = [];
    const notes = [];
    let now = 0;
    const addProgress = () =>
      installTerminalProgress(term, { enabled, onProgress: onProgress ?? ((r) => reports.push(r)) });
    const addNotes = () =>
      notifications
        ? installProgramNotifications(term, { onNotify: (n) => notes.push(n), clock: () => (now += 10_000) })
        : null;
    let progress;
    if (progressFirst) {
      progress = addProgress();
      addNotes();
    } else {
      addNotes();
      progress = addProgress();
    }
    const screen = () => {
      const lines = [];
      for (let y = 0; y < term.rows; y += 1) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
      return lines.join('\n').trim();
    };
    return { term, progress, reports, notes, screen };
  }

  test('TP-10: `9;4` reports reach the store\'s callback, and are drawn as nothing; a message beside them is still a notification', async () => {
    for (const progressFirst of [true, false]) {
      const { term, reports, notes, screen } = terminal({ progressFirst });
      try {
        await write(term, osc9('4;1;40') + osc9('4;2', ST) + osc9('4;3;') + osc9('4;4;90') + osc9('4;0;'));
        assert.deepEqual(reports, [bar('normal', 40), bar('error'), bar('indeterminate'), bar('warning', 90), bar('remove')]);
        assert.deepEqual(notes, [], 'no progress report is a notification');
        // iTerm2's channel and ConEmu's other commands are not progress.
        await write(term, osc9('Claude is waiting for your input') + osc9('9;C:\\Users\\me', ST) + osc9('4;7;5') + osc9('4;1;5x'));
        assert.equal(reports.length, 5, 'nothing else is a report');
        assert.equal(notes.length, 1);
        assert.equal(notes[0].body, 'Claude is waiting for your input');
        assert.equal(screen(), '', 'nothing printed');
        await write(term, 'still drawing');
        assert.equal(screen(), 'still drawing');
      } finally {
        term.dispose();
      }
    }
  });

  test('TP-11: what xterm hands on — a report is taken, everything else goes on to the next handler', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      // Registered first, so xterm asks the addon before this one.
      const reached = [];
      term.parser.registerOscHandler(9, (data) => {
        reached.push(data);
        return false;
      });
      const reports = [];
      installTerminalProgress(term, { onProgress: (r) => reports.push(r) });
      await write(term, osc9('4;1;5') + osc9('hello') + osc9('9;C:\\') + osc9('4;5;5') + osc9('4;') + osc9(''));
      assert.deepEqual(reports, [bar('normal', 5)]);
      assert.deepEqual(reached, ['hello', '9;C:\\', '4;5;5', '4;', '']);
    } finally {
      term.dispose();
    }
  });

  test('TP-12: turned off, nothing is taken — read as each report arrives', async () => {
    let on = false;
    const { term, reports, notes } = terminal({ enabled: () => on });
    try {
      await write(term, osc9('4;1;40'));
      assert.deepEqual(reports, []);
      assert.deepEqual(notes, [], 'and refused, it is still no notification');
      on = true;
      await write(term, osc9('4;1;41'));
      assert.deepEqual(reports, [bar('normal', 41)]);
      on = false;
      await write(term, osc9('4;1;42'));
      assert.equal(reports.length, 1);
    } finally {
      term.dispose();
    }
  });

  test('TP-13: never throws inside the parser — a callback or a setting that throws leaves xterm writing', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const options of [
        { onProgress: () => { throw new Error('store gone'); } },
        { enabled: () => { throw new Error('settings gone'); } },
      ]) {
        const { term, screen } = terminal(options);
        try {
          await write(term, `${osc9('4;1;40')}after`);
          assert.equal(screen(), 'after', 'the write queue went on');
        } finally {
          term.dispose();
        }
      }
      // A report whose callback threw was still a report: taken, not handed
      // on to whatever was registered before as if it were something else.
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      try {
        const reached = [];
        term.parser.registerOscHandler(9, (data) => {
          reached.push(data);
          return false;
        });
        installTerminalProgress(term, { onProgress: () => { throw new Error('store gone'); } });
        await write(term, osc9('4;1;40'));
        assert.deepEqual(reached, []);
      } finally {
        term.dispose();
      }
    } finally {
      console.warn = warn;
    }
  });

  test('TP-14: disposed with its terminal — and gone, reports are not taken', async () => {
    const { term, progress, reports } = terminal({ notifications: false });
    try {
      await write(term, osc9('4;1;1'));
      progress.dispose();
      await write(term, osc9('4;1;2'));
      assert.deepEqual(reports, [bar('normal', 1)]);
    } finally {
      term.dispose();
    }
    assert.equal(installTerminalProgress({}), null, 'a terminal with no parser gets nothing');
  });
});

describe('Terminal progress: output kept for a terminal not yet shown is history', () => {
  test('TP-15: replayed into a new terminal, its progress reports and its bells are not taken; what comes live after is', async () => {
    assert.equal(typeof outputBus.createHistoryMark, 'function', 'ptyOutputBus.js has createHistoryMark');
    await resetPtyOutputBus();
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      const history = outputBus.createHistoryMark();
      const reports = [];
      let bells = 0;
      installTerminalProgress(term, { enabled: () => !history.reading, onProgress: (r) => reports.push(r) });
      term.onBell(() => {
        if (!history.reading) bells += 1;
      });
      // Printed while no terminal showed the tab: kept by the bus.
      deliver('h1', `${osc9('4;1;50')}${BEL}building…\r\n`);
      deliver('h1', `${osc9('4;2')}${BEL}`);
      // The terminal is made and the kept output written into it, as the
      // registry's `bindSession` does.
      attachOutput('h1', (data, kept) => {
        if (kept) history.before();
        term.write(data);
        if (kept) history.after(term);
      });
      // Then the program goes on, live.
      deliver('h1', `${osc9('4;1;60')}${BEL}`);
      await write(term, '');
      assert.deepEqual(reports, [bar('normal', 60)], 'only the live report');
      assert.equal(bells, 1, 'only the live bell');
      assert.equal(history.reading, false, 'and the history is over');
      assert.match(term.buffer.active.getLine(0).translateToString(true), /building/, 'history is still drawn');
    } finally {
      term.dispose();
    }
  });

  test('TP-16: also when xterm reads the first chunk at once — right after a key — and for each new shell the terminal is bound to', async () => {
    await resetPtyOutputBus();
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      const history = outputBus.createHistoryMark();
      const reports = [];
      installTerminalProgress(term, { enabled: () => !history.reading, onProgress: (r) => reports.push(r) });
      const sink = (data, kept) => {
        if (kept) history.before();
        term.write(data);
        if (kept) history.after(term);
      };
      // Enter in an exited terminal starts a new shell; xterm reads the first
      // write after a key at once, not a task later.
      deliver('h2', osc9('4;1;11'));
      term.input('\r', true);
      attachOutput('h2', sink);
      await write(term, '');
      assert.deepEqual(reports, [], 'read at once, and still history');
      // A second shell's kept output, bound while the first one's is still
      // being read, is history too.
      deliver('h3', osc9('4;1;22'));
      deliver('h4', osc9('4;1;33'));
      attachOutput('h3', sink);
      attachOutput('h4', sink);
      deliver('h4', osc9('4;1;44'));
      await write(term, '');
      assert.deepEqual(reports, [bar('normal', 44)]);
      // A terminal that cannot be written to does not stay in history for good.
      const broken = outputBus.createHistoryMark();
      broken.before();
      broken.after({ write: () => { throw new Error('disposed'); } });
      assert.equal(broken.reading, false);
    } finally {
      term.dispose();
      await resetPtyOutputBus();
    }
  });

  test('TP-17: the bus says which chunks were kept — the backlog — and which are live', async () => {
    await resetPtyOutputBus();
    const got = [];
    deliver('h5', 'kept 1');
    deliver('h5', 'kept 2');
    attachOutput('h5', (data, kept) => got.push([data, kept === true]));
    deliver('h5', 'live');
    assert.deepEqual(got, [['kept 1', true], ['kept 2', true], ['live', false]]);
    await resetPtyOutputBus();
  });
});

describe('Terminal progress: when kept output was printed', () => {
  test('TP-18: the bus keeps the time each chunk arrived, and hands it on with the chunk', async () => {
    await resetPtyOutputBus();
    const got = [];
    deliver('h7', 'first', 1_000);
    deliver('h7', 'second', 2_000);
    const before = Date.now();
    deliver('h7', 'third');
    attachOutput('h7', (data, kept, at) => got.push([data, kept === true, at]));
    deliver('h7', 'live', 9_000);
    assert.deepEqual(got.slice(0, 2), [['first', true, 1_000], ['second', true, 2_000]]);
    assert.ok(got[2][2] >= before && got[2][2] <= Date.now(), 'unsaid, it is now');
    assert.deepEqual(got[3].slice(0, 2), ['live', false], 'a live chunk is not kept');
    await resetPtyOutputBus();
  });

  test('TP-19: the history mark knows when the chunk being read was printed — each chunk its own time', async () => {
    await resetPtyOutputBus();
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      const history = outputBus.createHistoryMark();
      const seen = [];
      installProgramNotifications(term, {
        onNotify: (n) => seen.push([n.body, history.reading, history.at]),
        clock: (() => { let t = 0; return () => (t += 10_000); })(),
      });
      deliver('h8', `${ESC}]9;asked at one${BEL}`, 1_000);
      deliver('h8', `${ESC}]9;asked at two${BEL}`, 2_000);
      attachOutput('h8', (data, kept, at) => {
        if (kept) history.before(at);
        term.write(data);
        if (kept) history.after(term);
      });
      deliver('h8', `${ESC}]9;asked now${BEL}`);
      await write(term, '');
      assert.deepEqual(seen, [
        ['asked at one', true, 1_000],
        ['asked at two', true, 2_000],
        ['asked now', false, null],
      ]);
    } finally {
      term.dispose();
      await resetPtyOutputBus();
    }
  });
});

describe('Terminal progress: messages from kept output have an allowance of their own', () => {
  test('TP-19b: clocked by when they were printed, and leaving the live allowance alone', async () => {
    await resetPtyOutputBus();
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      const history = outputBus.createHistoryMark();
      const seen = [];
      // The real clock: everything here is read within a few milliseconds.
      installProgramNotifications(term, {
        keptAt: () => (history.reading ? history.at : null),
        onNotify: (n, keptAt) => seen.push([n.body, keptAt ?? null]),
      });
      // An hour ago in a tab nobody had shown: two questions three seconds
      // apart, and one half a second after the second.
      deliver('h9', `${ESC}]777;notify;OpenCode;asked first${BEL}`, 1_000);
      deliver('h9', `${ESC}]777;notify;OpenCode;asked again${BEL}`, 4_000);
      deliver('h9', `${ESC}]777;notify;OpenCode;too soon after${BEL}`, 4_500);
      attachOutput('h9', (data, kept, at) => {
        if (kept) history.before(at);
        term.write(data);
        if (kept) history.after(term);
      });
      // And the program asks again, live, right after the tab is shown.
      deliver('h9', `${ESC}]777;notify;OpenCode;asked now${BEL}`);
      await write(term, '');
      assert.deepEqual(seen, [
        ['asked first', 1_000],
        ['asked again', 4_000],
        ['asked now', null],
      ]);
    } finally {
      term.dispose();
      await resetPtyOutputBus();
    }
  });
});

describe('Terminal progress: pacing', () => {
  test('TP-20: at most one delivery per interval, the latest value winning', () => {
    const time = manualTime();
    const got = [];
    const t = createLatestThrottle({ intervalMs: 100, deliver: (v) => got.push([time.now(), v]), ...time });
    assert.equal(t.push('a'), 'sent', 'the first goes at once');
    time.advance(10);
    assert.equal(t.push('b'), 'held');
    time.advance(20);
    t.push('c');
    assert.ok(t.holding);
    assert.equal(t.held, 'c');
    time.advance(99);
    assert.deepEqual(got, [[0, 'a']], 'nothing before the interval is up');
    time.advance(100);
    assert.deepEqual(got, [[0, 'a'], [100, 'c']], '"b" was replaced, never sent');
    time.advance(150);
    t.push('d');
    time.advance(199);
    assert.equal(got.length, 2);
    time.advance(200);
    assert.deepEqual(got.at(-1), [200, 'd']);
    time.advance(500);
    assert.equal(t.push('e'), 'sent', 'after a quiet spell, at once again');

    // A thousand a second is ten.
    const flood = [];
    const f = createLatestThrottle({ intervalMs: 100, deliver: (v) => flood.push(v), ...time });
    const start = time.now();
    for (let i = 1; i <= 1000; i += 1) {
      time.advance(start + i);
      f.push(i);
    }
    time.advance(start + 1200);
    assert.ok(flood.length <= 11, `${flood.length} deliveries for one second`);
    assert.equal(flood.at(-1), 1000, 'and the last word is the last value');

    // Cancelled, what was held never goes.
    const c = [];
    const g = createLatestThrottle({ intervalMs: 100, deliver: (v) => c.push(v), ...time });
    g.push(1);
    g.push(2);
    g.cancel();
    time.advance(time.now() + 1000);
    assert.deepEqual(c, [1]);
    assert.equal(g.holding, false);
  });

  test('TP-21: the taskbar is told each new bar once, at most four times a second, and nothing it already shows', () => {
    const time = manualTime();
    const sent = [];
    const driver = createTaskbarDriver({ send: (b) => sent.push(b), ...time });
    assert.equal(TASKBAR_INTERVAL_MS, 250);
    // Nothing at launch, and nothing while no terminal reports a bar: on
    // Windows each call creates the taskbar's COM object anew (tao 0.35), so
    // the taskbar is told only once a bar is really in use.
    driver.update({});
    driver.update({});
    time.advance(1000);
    assert.deepEqual(sent, [], 'no bar, nothing to say — not even "none"');

    driver.update({ a: bar('normal', 10) });
    assert.deepEqual(sent, [{ status: 'normal', progress: 10 }]);
    time.advance(1010);
    driver.update({ a: bar('normal', 20) });
    driver.update({ a: bar('normal', 30) });
    assert.equal(sent.length, 1, 'held inside the quarter second');
    time.advance(1250);
    assert.deepEqual(sent.at(-1), { status: 'normal', progress: 30 }, 'the latest, once');
    assert.equal(sent.length, 2);

    // Changed and changed back while held: nothing to say.
    time.advance(1300);
    driver.update({ a: bar('normal', 40) });
    driver.update({ a: bar('normal', 30) });
    time.advance(2000);
    assert.equal(sent.length, 2);

    // Off: no bar, whatever the terminals report.
    driver.update({ a: bar('error', 5) }, false);
    time.advance(3000);
    assert.deepEqual(sent.at(-1), { status: 'none', progress: null });

    // A flood is four a second.
    const before = sent.length;
    for (let i = 1; i <= 100; i += 1) {
      time.advance(3000 + i * 10);
      driver.update({ a: bar('normal', i) });
    }
    time.advance(5000);
    assert.ok(sent.length - before <= 5, `${sent.length - before} sends in one second`);
    assert.deepEqual(sent.at(-1), { status: 'normal', progress: 100 });

    driver.dispose();
    assert.deepEqual(sent.at(-1), { status: 'none', progress: null }, 'stopping takes a standing bar down');
    const count = sent.length;
    time.advance(20_000);
    assert.equal(sent.length, count, 'and nothing held goes out after it');

    // A driver that never showed a bar has nothing to take down.
    const quiet = [];
    const idle = createTaskbarDriver({ send: (b) => quiet.push(b), ...time });
    idle.update({});
    idle.update({}, false);
    idle.dispose();
    assert.deepEqual(quiet, []);
  });

  test('TP-23: a disposed driver never sends again, nor arms anything — even when a send it made earlier is refused afterwards', async () => {
    const time = manualTime();
    const taskbar = [];
    const pending = [];
    const sendAs = (who) => (b) => {
      taskbar.push(`${who}:${b.status}:${b.progress ?? ''}`);
      return new Promise((resolve, reject) => pending.push({ who, resolve, reject }));
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const old = createTaskbarDriver({ send: sendAs('old'), ...time });
    old.update({ a: bar('normal', 40) }); // in flight
    old.dispose(); // a hot reload, an unmount: its "none" in flight too
    const next = createTaskbarDriver({ send: sendAs('new'), ...time });
    time.advance(300);
    next.update({ a: bar('normal', 40) });
    for (const p of pending.splice(0)) (p.who === 'old' ? p.reject(new Error('ipc')) : p.resolve(null));
    await settle();
    assert.equal(time.pending, 0, 'no timer left by the disposed driver');
    time.advance(10_000);
    await settle();
    assert.deepEqual(taskbar, ['old:normal:40', 'old:none:', 'new:normal:40'], 'the new bar is the last word');
    // Updated after it was disposed, it neither sends nor holds anything back.
    old.update({ a: bar('error', 1) });
    old.update({ a: bar('error', 2) });
    assert.equal(time.pending, 0, 'nothing armed');
    time.advance(20_000);
    await settle();
    assert.equal(taskbar.length, 3, 'and nothing sent');
  });

  test('TP-22: a refused send is forgotten, and tried once more a moment later — with the bar wanted then, not the one refused', async () => {
    const time = manualTime();
    const sent = [];
    let refuse = 0;
    const send = (b) => {
      sent.push(b);
      if (refuse > 0) {
        refuse -= 1;
        return Promise.reject(new Error('taskbar busy'));
      }
      return Promise.resolve(null);
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const driver = createTaskbarDriver({ send, ...time });
    driver.update({ a: bar('normal', 40) });
    await settle();
    time.advance(1000);
    // The last word — the bar coming down — is refused.
    refuse = 1;
    driver.update({});
    await settle();
    assert.deepEqual(sent.at(-1), { status: 'none', progress: null });
    // Meanwhile another bar is wanted: held, it goes out at the quarter
    // second, and the retry finds nothing left to say.
    driver.update({ a: bar('normal', 70) }); // inside the quarter second: held
    time.advance(1300);
    await settle();
    assert.deepEqual(sent.at(-1), { status: 'normal', progress: 70 }, 'the held bar goes out as usual');
    const count = sent.length;
    time.advance(5000);
    await settle();
    assert.equal(sent.length, count, 'already shown: the retry has nothing to add');

    // Refused, and nothing changes after: tried once more, with what is wanted.
    time.advance(6000);
    refuse = 1;
    driver.update({});
    await settle();
    assert.equal(sent.length, count + 1);
    time.advance(6000 + (progressLib.TASKBAR_RETRY_MS ?? 1000));
    await settle();
    assert.equal(sent.length, count + 2, 'tried once more');
    assert.deepEqual(sent.at(-1), { status: 'none', progress: null }, 'the bar is taken down after all');
    // Refused twice: no third try, no loop.
    time.advance(20_000);
    refuse = 2;
    driver.update({ a: bar('error', 1) });
    await settle();
    time.advance(40_000);
    await settle();
    time.advance(60_000);
    await settle();
    assert.equal(sent.length, count + 4, 'the send and one retry, and no more');
    // A send that throws rather than rejects counts as refused too.
    const thrown = [];
    const sturdy = createTaskbarDriver({
      send: (b) => {
        thrown.push(b);
        if (thrown.length === 1) throw new Error('no taskbar');
      },
      ...time,
    });
    time.advance(100_000);
    sturdy.update({ a: bar('normal', 5) });
    await settle();
    time.advance(110_000);
    await settle();
    assert.equal(thrown.length, 2, 'tried once more after a throw');
    driver.dispose();
    sturdy.dispose();
  });
});

// ---- The store ------------------------------------------------------------------

const backing = new Map();
let previousLocalStorage;
let shimInstalled = false;

function installStorageShim() {
  if (!shimInstalled) {
    previousLocalStorage = globalThis.localStorage;
    shimInstalled = true;
  }
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

function giveStorageBack() {
  if (!shimInstalled) return;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  shimInstalled = false;
}

/** A pristine store with one terminal, as if the app had just launched. */
async function freshStart() {
  S.getState().dispose();
  installStorageShim();
  backing.clear();
  S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [], notifications: [], progress: {} });
  await S.getState().init();
}

const tabIds = () => S.getState().tabs.map((t) => t.id);
const progressOf = (id) => S.getState().progress[id];

describe('Terminal progress: the store', () => {
  let interval;
  beforeEach(async () => {
    interval = __setProgressIntervalMs(PROGRESS_INTERVAL_MS);
    useSettingsStore.setState({ terminalProgress: true });
    await freshStart();
  });
  afterEach(() => {
    S.getState().dispose();
    giveStorageBack();
    __setProgressIntervalMs(interval);
    useSettingsStore.setState({ terminalProgress: true });
  });

  test('TP-30: a bar per tab, kept out of `tabs` — a report re-renders nothing that draws the tabs', async () => {
    const [a] = tabIds();
    const tabsBefore = S.getState().tabs;
    assert.equal(S.getState().setTabProgress(a, bar('normal', 40)), true);
    assert.deepEqual(progressOf(a), bar('normal', 40));
    assert.equal(S.getState().tabs, tabsBefore, 'the same `tabs` array');
    assert.equal('progress' in S.getState().tabs[0], false, 'and no field on the tab');
    assert.equal(S.getState().setTabProgress('no-such-tab', bar('normal', 1)), false);
    assert.equal(progressOf('no-such-tab'), undefined);
  });

  test('TP-31: the same bar again is dropped; a flood is ten a second, the last report winning', async () => {
    const [a] = tabIds();
    let changes = 0;
    const stop = S.subscribe((s, p) => {
      if (s.progress !== p.progress) changes += 1;
    });
    try {
      S.getState().setTabProgress(a, bar('normal', 10));
      assert.equal(changes, 1, 'the first is shown at once');
      assert.equal(S.getState().setTabProgress(a, bar('normal', 10)), false, 'the same bar is no change');
      assert.equal(changes, 1);
      for (let i = 11; i <= 60; i += 1) S.getState().setTabProgress(a, bar('normal', i));
      assert.equal(changes, 1, 'fifty reports inside a tenth of a second wait');
      assert.deepEqual(progressOf(a), bar('normal', 10));
      await wait(PROGRESS_INTERVAL_MS + 60);
      assert.equal(changes, 2, 'and are shown once');
      assert.deepEqual(progressOf(a), bar('normal', 60), 'as the last of them');

      // Held, the bar a report leaves is worked out from the held one: an
      // error with no amount stays where the bar had got to.
      S.getState().setTabProgress(a, bar('normal', 70));
      S.getState().setTabProgress(a, bar('error'));
      await wait(PROGRESS_INTERVAL_MS + 60);
      assert.deepEqual(progressOf(a), bar('error', 70));
    } finally {
      stop();
    }
  });

  test('TP-32: state 0 takes the bar down, and so does the end of the command, the shell exiting and a restart', async () => {
    const [a] = tabIds();
    const sessionOf = () => S.getState().tabs.find((t) => t.id === a).sessionId;

    S.getState().setTabProgress(a, bar('normal', 40));
    await wait(PROGRESS_INTERVAL_MS + 20);
    S.getState().setTabProgress(a, bar('remove'));
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.equal(progressOf(a), undefined, 'state 0');

    await wait(PROGRESS_INTERVAL_MS + 20);
    S.getState().setTabProgress(a, bar('indeterminate'));
    assert.deepEqual(progressOf(a), bar('indeterminate'));
    S.getState().setTabProgress(a, bar('normal', 5)); // held
    await mockBridge.emit('pty-command-done', { session_id: sessionOf(), exit_code: 0 });
    assert.equal(progressOf(a), undefined, 'the command ended');
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.equal(progressOf(a), undefined, 'and what was held went with it');

    S.getState().setTabProgress(a, bar('error', 50));
    assert.deepEqual(progressOf(a), bar('error', 50));
    S.getState().setTabProgress(a, bar('error', 60)); // held
    await mockBridge.emit('pty-exit', { session_id: sessionOf(), exit_code: 1 });
    assert.equal(progressOf(a), undefined, 'the shell exited');
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.equal(progressOf(a), undefined, 'and nothing held comes after it');
    assert.ok(S.getState().tabs.find((t) => t.id === a).exited, 'setup: the tab knows');

    // A report the dying shell's last output carried, then Enter for a new
    // one. The exited session is gone from the backend, so the kill before
    // the respawn reports no second exit: the restart has to clear it itself.
    await wait(PROGRESS_INTERVAL_MS + 20);
    S.getState().setTabProgress(a, bar('warning', 20));
    assert.deepEqual(progressOf(a), bar('warning', 20));
    S.getState().setTabProgress(a, bar('warning', 30)); // held
    mockBridge.ptySessions.delete(sessionOf());
    assert.equal(await S.getState().restartShell(a), true);
    assert.equal(progressOf(a), undefined, 'a new shell starts with no bar');
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.equal(progressOf(a), undefined, 'and the old shell\'s held report does not land on it');
  });

  test('TP-37: a report in the last output before a command ends is read first, and taken down with it — the next command\'s stays', async () => {
    const [a] = tabIds();
    const sessionOf = () => S.getState().tabs.find((t) => t.id === a).sessionId;
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    installTerminalProgress(term, { onProgress: (r) => S.getState().setTabProgress(a, r) });
    // How the app hands output to xterm (ptyOutputBus.js): a write, read a
    // task later — and the backend's word that the command ended comes right
    // after it, before xterm has read it.
    const lastOutputThenEnd = async (payload, exitCode = 0) => {
      term.write(osc9(payload));
      await mockBridge.emit('pty-command-done', { session_id: sessionOf(), exit_code: exitCode });
      await write(term, '');
    };
    const previous = setTerminalOutputBarrier(null);
    try {
      // The defect, as it was: taken down at once, before xterm read the
      // report, which then put the bar back up over the prompt for good.
      await lastOutputThenEnd('4;1;50');
      assert.deepEqual(progressOf(a), bar('normal', 50), 'the race, reproduced');
      S.getState().setTabProgress(a, bar('remove'));
      await wait(PROGRESS_INTERVAL_MS + 40);
      assert.equal(progressOf(a), undefined, 'setup: no bar');

      // Behind the output, as the registry has it.
      setTerminalOutputBarrier((tabId, fn) => (tabId === a ? term.write('', fn) : fn()));
      await wait(PROGRESS_INTERVAL_MS + 20);
      await lastOutputThenEnd('4;1;60');
      assert.equal(progressOf(a), undefined, 'read, then taken down with the command');
      await wait(PROGRESS_INTERVAL_MS + 20);
      // The next command's report, written after the end, is its own.
      term.write(osc9('4;3'));
      await mockBridge.emit('pty-command-done', { session_id: sessionOf(), exit_code: 0 });
      term.write(osc9('4;1;10'));
      await write(term, '');
      await wait(PROGRESS_INTERVAL_MS + 40);
      assert.deepEqual(progressOf(a), bar('normal', 10));
    } finally {
      setTerminalOutputBarrier(previous);
      term.dispose();
    }
  });

  test('TP-37b: the same behind the output when the shell exits', async () => {
    const [a] = tabIds();
    const sessionOf = () => S.getState().tabs.find((t) => t.id === a).sessionId;
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    installTerminalProgress(term, { onProgress: (r) => S.getState().setTabProgress(a, r) });
    const previous = setTerminalOutputBarrier((tabId, fn) => (tabId === a ? term.write('', fn) : fn()));
    try {
      // A program's last report, and the shell gone right after it.
      term.write(osc9('4;1;70'));
      await mockBridge.emit('pty-exit', { session_id: sessionOf(), exit_code: 1 });
      await write(term, '');
      await wait(PROGRESS_INTERVAL_MS + 40);
      assert.equal(progressOf(a), undefined, 'read, then taken down with the shell');
    } finally {
      setTerminalOutputBarrier(previous);
      term.dispose();
    }
  });

  test('TP-38: a tab never shown — its command killed mid-bar — shows no bar when it is first shown', async () => {
    assert.equal(typeof outputBus.createHistoryMark, 'function', 'ptyOutputBus.js has createHistoryMark');
    const [a] = tabIds();
    const sessionOf = () => S.getState().tabs.find((t) => t.id === a).sessionId;
    // No terminal shows `a`: what it prints is kept for when one does.
    await mockBridge.emit('pty-output', { session_id: sessionOf(), data: `${osc9('4;1;50')}${BEL}compiling…\r\n` });
    assert.ok(outputBus.backlogSize(sessionOf()) > 0, 'setup: kept by the bus');
    // Killed: the end of the command — and nothing to take down yet.
    await mockBridge.emit('pty-command-done', { session_id: sessionOf(), exit_code: 130 });
    assert.equal(progressOf(a), undefined);
    // The user clicks the tab: its terminal is made, and what was kept is
    // written into it, as the registry does it.
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    const history = outputBus.createHistoryMark();
    installTerminalProgress(term, { enabled: () => !history.reading, onProgress: (r) => S.getState().setTabProgress(a, r) });
    try {
      attachOutput(sessionOf(), (data, kept) => {
        if (kept) history.before();
        term.write(data);
        if (kept) history.after(term);
      });
      await write(term, '');
      await wait(PROGRESS_INTERVAL_MS + 40);
      assert.equal(progressOf(a), undefined, 'the bar of a command that is over does not come back');
    } finally {
      term.dispose();
    }
  });

  test('TP-39: a tab that goes with no exit to follow it — the prune alone drops what it was holding back', async () => {
    const b = (await S.getState().createTab()).id;
    const session = S.getState().tabs.find((t) => t.id === b).sessionId;
    S.getState().setTabProgress(b, bar('normal', 10));
    S.getState().setTabProgress(b, bar('normal', 20)); // held
    // The backend has already let the session go, so the kill reports no
    // exit while the tab is there: nothing but the tab leaving `tabs` says so.
    mockBridge.ptySessions.delete(session);
    let exits = 0;
    const off = await mockBridge.listen('pty-exit', () => {
      exits += 1;
    });
    try {
      await S.getState().closeTab(b);
      assert.equal(exits, 0, 'setup: no exit came');
      assert.equal(progressOf(b), undefined);
      await wait(PROGRESS_INTERVAL_MS + 40);
      assert.equal(progressOf(b), undefined, 'the held report never lands for a tab that is gone');
      assert.deepEqual(Object.keys(S.getState().progress), []);
    } finally {
      off();
    }
  });

  test('TP-33: a closed tab takes its bar along, and a report it was holding back never lands', async () => {
    const [a] = tabIds();
    const b = (await S.getState().createTab()).id;
    S.getState().setTabProgress(b, bar('normal', 10));
    S.getState().setTabProgress(b, bar('normal', 20)); // held
    S.getState().setTabProgress(a, bar('normal', 30));
    assert.equal(__attentionKept().progressThrottles, 2);
    await S.getState().closeTab(b);
    assert.equal(progressOf(b), undefined);
    assert.deepEqual(progressOf(a), bar('normal', 30), 'the other tab keeps its own');
    assert.equal(__attentionKept().progressThrottles, 1, 'its pacing went with it');
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.equal(progressOf(b), undefined, 'the held report did not bring it back');
  });

  test('TP-34: the setting off takes every bar down at once, and reports are ignored while it is', async () => {
    const [a] = tabIds();
    const b = (await S.getState().createTab()).id;
    S.getState().setTabProgress(a, bar('normal', 10));
    S.getState().setTabProgress(b, bar('error'));
    S.getState().setTabProgress(a, bar('normal', 90)); // held
    useSettingsStore.getState().setSetting('terminalProgress', false);
    assert.deepEqual(S.getState().progress, {});
    await wait(PROGRESS_INTERVAL_MS + 40);
    assert.deepEqual(S.getState().progress, {}, 'nothing held comes back');
    assert.equal(S.getState().setTabProgress(a, bar('normal', 50)), false);
    assert.deepEqual(S.getState().progress, {});
    useSettingsStore.getState().setSetting('terminalProgress', true);
    assert.deepEqual(S.getState().progress, {}, 'turned back on, the bars come with the next report');
    S.getState().setTabProgress(a, bar('normal', 50));
    assert.deepEqual(progressOf(a), bar('normal', 50));
  });

  test('TP-35: the taskbar follows the bars — added up, once per change, and none with the setting off', async () => {
    const [a] = tabIds();
    const b = (await S.getState().createTab()).id;
    const time = manualTime();
    const sent = [];
    const listeners = { focus: new Set(), visibilitychange: new Set() };
    const target = (kind) => ({
      addEventListener: (type, fn) => listeners[type]?.add(fn),
      removeEventListener: (type, fn) => listeners[type]?.delete(fn),
      kind,
    });
    const stop = startAttention({
      win: target('window'),
      doc: { ...target('document'), visibilityState: 'visible' },
      send: (x) => sent.push(x),
      taskbar: true,
      driverOptions: time,
    });
    try {
      assert.deepEqual(sent, [], 'nothing at launch');
      time.advance(1000);
      S.getState().setTabProgress(a, bar('normal', 60));
      assert.deepEqual(sent.at(-1), { status: 'normal', progress: 60 });
      S.getState().setTabProgress(b, bar('warning'));
      assert.equal(sent.length, 1, 'inside the quarter second it waits');
      time.advance(2000);
      assert.deepEqual(sent.at(-1), { status: 'paused', progress: 100 }, 'a warning beats a normal bar');
      useSettingsStore.getState().setSetting('terminalProgress', false);
      time.advance(3000);
      assert.deepEqual(sent.at(-1), { status: 'none', progress: null });
      const count = sent.length;
      time.advance(10_000);
      assert.equal(sent.length, count, 'and nothing more, nothing having changed');
    } finally {
      stop();
    }
    assert.equal(listeners.focus.size + listeners.visibilitychange.size, 0, 'stopping takes its listeners away');
  });

  test('TP-35b: off Windows the taskbar is never told anything — no call, no churn', async () => {
    const [a] = tabIds();
    const sent = [];
    const target = { addEventListener() {}, removeEventListener() {} };
    let subscribed = 0;
    const terminals = {
      getState: () => S.getState(),
      subscribe: (fn) => {
        subscribed += 1;
        return S.subscribe(fn);
      },
    };
    const stop = startAttention({ win: target, doc: { ...target, visibilityState: 'visible' }, terminals, send: (x) => sent.push(x), taskbar: false });
    try {
      S.getState().setTabProgress(a, bar('normal', 60));
      await wait(PROGRESS_INTERVAL_MS + 300);
      assert.deepEqual(sent, []);
      assert.equal(subscribed, 0, 'not even listening for bars');
    } finally {
      stop();
    }
    // And the hook asks the platform, not a setting.
    const hook = readFileSync(new URL('../../src/hooks/useAttention.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(hook, /import \{ isWindows \} from '\.\.\/lib\/platform\.js';/);
    assert.match(hook, /taskbar = isWindows,/);
  });

  test('TP-36: the mock stands in for `set_taskbar_progress`, refusing exactly what the backend refuses', async () => {
    mockBridge.taskbarProgress.length = 0;
    const ask = (args) => mockBridge.invoke('set_taskbar_progress', args);
    // Taken: every status, any amount a u64 holds (held at 100), and none —
    // missing or null is `None` to an `Option`.
    await ask({ status: 'normal', progress: 250 });
    await ask({ status: 'indeterminate', progress: 50 });
    await ask({ status: 'error', progress: null });
    await ask({ status: 'none' });
    await ask({ status: 'paused', progress: 0 });
    await ask({ status: 'normal', progress: 2 ** 63 });
    // What goes over the wire is JSON: NaN and Infinity are null there, and
    // null is `None` — taken, as the backend takes it.
    await ask({ status: 'normal', progress: Infinity });
    assert.deepEqual(mockBridge.taskbarProgress, [
      { status: 'normal', progress: 100 },
      { status: 'indeterminate', progress: null },
      { status: 'error', progress: null },
      { status: 'none', progress: null },
      { status: 'paused', progress: 0 },
      { status: 'normal', progress: 100 },
      { status: 'normal', progress: null },
    ]);
    // Refused by Tauri before the command runs, as Tauri words it.
    await assert.rejects(() => ask({ progress: 1 }), /^Error: invalid args `status` for command `set_taskbar_progress`: command set_taskbar_progress missing required key status$/);
    for (const status of [null, 5, true, ['normal']]) {
      await assert.rejects(() => ask({ status, progress: 1 }), /invalid args `status` for command `set_taskbar_progress`: invalid type/);
    }
    for (const progress of [-1, 1.5, '50', true, 2 ** 64, 1e20, [1], { n: 1 }]) {
      await assert.rejects(() => ask({ status: 'normal', progress }), /invalid args `progress` for command `set_taskbar_progress`/, String(progress));
    }
    // Refused by the command: a string that is not a status.
    for (const status of ['warning', 'Normal', '', 'none ']) {
      await assert.rejects(() => ask({ status, progress: 1 }), /^Error: unknown taskbar progress status$/);
    }
    assert.equal(mockBridge.taskbarProgress.length, 7, 'a refusal records nothing');
    for (let i = 0; i < 60; i += 1) await ask({ status: 'normal', progress: i });
    assert.equal(mockBridge.taskbarProgress.length, 50, 'the last 50');
    mockBridge.taskbarProgress.length = 0;

    // The backend's own words, which these are matched against.
    const command = readFileSync(new URL('../../src-tauri/src/commands/taskbar.rs', import.meta.url), 'utf8');
    assert.ok(command.includes('_ => Err("unknown taskbar progress status".to_string()),'));
  });
});

describe('Terminal progress: wired', () => {
  test('TP-40: every terminal reads reports into the store, for its own tab, with the setting read as each arrives', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    const start = create.indexOf('installTerminalProgress(term, {');
    const end = create.indexOf('});', start) + 3;
    assert.ok(start > 0 && end > start, 'getOrCreateTerminal installs it on every terminal');
    assert.ok(start < create.indexOf('term.open(container);'), 'from the first byte');
    assert.ok(create.indexOf('installProgramNotifications(term, {') > 0, 'beside the notification handler, which stays');
    let installed = null;
    const settings = { terminalProgress: true };
    const calls = [];
    const history = { reading: false };
    const run = new Function('installTerminalProgress', 'term', 'tabId', 'useSettingsStore', 'useTerminalStore', 'history', create.slice(start, end));
    const term = { id: 'the-term' };
    run(
      (t, options) => {
        installed = { t, options };
      },
      term,
      'tab-term-9',
      { getState: () => settings },
      { getState: () => ({ setTabProgress: (...args) => calls.push(args) }) },
      history
    );
    assert.equal(installed.t, term);
    assert.equal(installed.options.enabled(), true);
    history.reading = true;
    assert.equal(installed.options.enabled(), false, 'not while the kept output is being read');
    history.reading = false;
    assert.ok(create.indexOf('const history = createHistoryMark();') > 0, 'the terminal has its history mark');
    assert.ok(create.indexOf('const history = createHistoryMark();') < start, 'made before the handlers that read it');
    assert.match(create.slice(create.indexOf('entry = {')), /^\s+history,$/m, 'kept on the entry, for bindSession');
    settings.terminalProgress = false;
    assert.equal(installed.options.enabled(), false, 'turned off after the terminal was made, it is off');
    delete settings.terminalProgress;
    assert.equal(installed.options.enabled(), true, 'a setting not there yet is the default, on');
    installed.options.onProgress(bar('normal', 3));
    assert.deepEqual(calls, [['tab-term-9', bar('normal', 3)]]);
  });

  test('TP-42: the registry\'s barrier waits for a terminal\'s output, and for no terminal does not wait at all', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('setTerminalOutputBarrier((tabId, fn) => {');
    const end = src.indexOf('\n});\n', start) + 4;
    assert.ok(start > 0 && end > start, 'the registry installs it as it loads');
    assert.match(src, /import \{ setTerminalOutputBarrier, useTerminalStore \} from '\.\.\/\.\.\/stores\/terminalStore\.js';/);
    let barrier = null;
    const writes = [];
    const instances = new Map([
      ['live', { term: { write: (data, cb) => writes.push([data, cb]) } }],
      ['gone', { disposed: true, term: { write: () => assert.fail('a disposed terminal is not written to') } }],
      ['full', { term: { write: () => { throw new Error('write buffer full'); } } }],
    ]);
    // `flushPaced`: output held for a terminal without focus is written
    // before the empty write, so the barrier waits for it too.
    new Function('setTerminalOutputBarrier', 'instances', 'flushPaced', src.slice(start, end))((b) => { barrier = b; }, instances, (entry) => writes.push(['flushed', entry]));
    const ran = [];
    barrier('live', () => ran.push('live'));
    assert.deepEqual(ran, [], 'waits');
    assert.equal(writes.length, 2);
    assert.equal(writes[0][0], 'flushed', 'what is held is written first');
    assert.equal(writes[1][0], '', 'an empty write, whose callback xterm runs once everything before it is read');
    writes[1][1]();
    assert.deepEqual(ran, ['live']);
    barrier('gone', () => ran.push('gone'));
    barrier('never-shown', () => ran.push('never-shown'));
    barrier('full', () => ran.push('full'));
    assert.deepEqual(ran, ['live', 'gone', 'never-shown', 'full'], 'nothing to wait for, or no way to: at once');
  });

  test('TP-43: bindSession writes kept output as history, and live output as it comes', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function bindSession(entry, sessionId) {');
    const end = src.indexOf('\n}\n', start) + 3;
    assert.ok(start > 0 && end > start);
    const bindSession = new Function(
      'startPtyOutputBus', 'attachOutput', 'writeOutput', 'listen', 'forgetOutput', 'freshScreen', 'exitNotice', 'deliverLive', 'flushPaced',
      `${src.slice(start, end)}\nreturn bindSession;`
    );
    const order = [];
    let sink = null;
    const bind = bindSession(
      () => {},
      (_sessionId, fn) => {
        sink = fn;
        return () => {};
      },
      (_entry, data) => {
        if (data === 'boom') throw new Error('write discarded');
        order.push(`write ${data}`);
      },
      () => Promise.resolve(() => {}),
      () => {},
      () => '',
      () => '',
      // Live output goes through the pacer (output_pacing.test.js).
      (_entry, data) => order.push(`live ${data}`),
      () => {}
    );
    const term = { write: () => {} };
    const entry = {
      term,
      sessionId: null,
      history: { before: (at) => order.push(`before ${at}`), after: (t) => order.push(t === term ? 'after' : 'after ?') },
    };
    bind(entry, 'sess-1');
    sink('old', true, 1_000);
    sink('new');
    assert.deepEqual(order, ['before 1000', 'write old', 'after', 'live new'], 'with the time the kept chunk was printed');
    // A write that throws still ends the history it began: left up, every
    // live bell and bar of the terminal's life would be taken for history.
    order.length = 0;
    assert.throws(() => sink('boom', true, 2_000), /write discarded/, 'the bus reports it');
    assert.deepEqual(order, ['before 2000', 'after']);
  });

  test('TP-41: the backend has `set_taskbar_progress`, taking what the frontend sends', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const main = read('../../src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::taskbar::set_taskbar_progress,'), 'in generate_handler!');
    const mod = read('../../src-tauri/src/commands/mod.rs');
    assert.match(mod, /^pub mod taskbar;$/m);
    const command = read('../../src-tauri/src/commands/taskbar.rs');
    assert.match(command, /let state = state_of\(&status, progress\)\?;\s*apply\(&window, state\)/, 'refused alike on every platform, applied on Windows');
    assert.match(command, /#\[tauri::command\(rename_all = "snake_case"\)\]\s*pub fn set_taskbar_progress\(\s*window: tauri::Window,\s*status: String,\s*progress: Option<u64>,?\s*\)/);
    for (const status of TASKBAR_STATUSES) assert.ok(command.includes(`"${status}" => Ok(`), `the backend knows "${status}"`);
    // Windows only: elsewhere the window is never touched — on macOS tao
    // replaces the Dock tile with a static picture of its own on the first call.
    const onWindows = command.slice(command.indexOf('#[cfg(windows)]\nfn apply('), command.indexOf('#[cfg(not(windows))]\nfn apply('));
    const elsewhere = command.slice(command.indexOf('#[cfg(not(windows))]\nfn apply('), command.indexOf('#[cfg(test)]'));
    assert.ok(onWindows.includes('.set_progress_bar(state)'), 'on Windows the bar is set');
    assert.ok(elsewhere.length > 0 && !elsewhere.includes('set_progress_bar'), 'and nowhere else');
    assert.match(elsewhere, /Ok\(\(\)\)/);
    const hook = read('../../src/hooks/useAttention.js');
    assert.ok(hook.includes("invoke('set_taskbar_progress', { status: bar.status, progress: bar.progress })"), 'the hook sends both');
  });
});

describe('Terminal progress: teardown', () => {
  test('TP-99: leave the store and the settings as the next suite expects them', () => {
    S.getState().dispose();
    giveStorageBack();
    useSettingsStore.setState({ terminalProgress: true });
    S.setState({ progress: {} });
    mockBridge.taskbarProgress.length = 0;
    assert.deepEqual(S.getState().progress, {});
  });
});
