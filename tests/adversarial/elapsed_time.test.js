/**
 * How long a TERMINALS row's state has held (bundle 3, U5-F1/F2): see
 * `elapsedLabel`, `elapsedWords` and `elapsedSince` in src/lib/terminalStatus.js,
 * src/lib/minuteClock.js and src/hooks/useMinuteNow.js.
 *
 * The label and the mapping are pure and run on values. The clock is run on
 * a fake wall clock and fake timers handed in (`fakeTime`), which count the
 * timers alive and fire them in order as the clock is moved on. The hook is
 * mounted with real React on the hand-written page of react_page.js
 * (MIN-13), with a clock of its own. RN-238 (tests/render/runner.js) draws
 * the rows and reads StatusBoard's source.
 */
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage } from './react_page.js';
import {
  agentLabel,
  elapsedLabel,
  elapsedSince,
  elapsedWords,
  terminalStatus,
} from '../../src/lib/terminalStatus.js';
import { MINUTE_MS, createMinuteClock, minuteClock, msToNextMinute } from '../../src/lib/minuteClock.js';
import { minuteNowSource, useMinuteNow } from '../../src/hooks/useMinuteNow.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** 2026-11-22 10:00:00.000 UTC: a whole minute of the wall clock. */
const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);

/**
 * A wall clock at `start` and timers on it: `live` is how many are set and
 * not yet fired or cleared, `delays` every delay asked for, `to(t)` moves the
 * clock to `t`, firing each timer due on the way, earliest first, at its own
 * time; `fire()` fires the next one now, whatever it was set for.
 */
function fakeTime(start = T0) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  const delays = [];
  const time = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      delays.push(ms);
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    get live() {
      return timers.size;
    },
    delays,
    to(target) {
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
    },
    fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
    },
    set: (value) => {
      t = value;
    },
  };
  return time;
}

const clockOn = (time) => createMinuteClock({ now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });

/** A terminal whose agent `kind` is believed to run (`agentRuns`). */
const agentTab = (id, kind, extra = {}) => ({
  id,
  sessionId: `sess-${id}`,
  agent: { kind, sessionId: `${kind}-1` },
  agentTyped: { sessionId: `sess-${id}` },
  running: false,
  lastExitCode: null,
  ...extra,
});
const plainTab = (id, extra = {}) => ({ id, sessionId: `sess-${id}`, running: false, lastExitCode: null, ...extra });

/** The start a row's line counts from, worked out as TerminalStatusLine does with Show Agent on. */
function startOf(tab, { unread = 0, progress = null, activity = null } = {}) {
  const status = terminalStatus(tab, { unread, progress, activity });
  return elapsedSince(tab, status, { activity, agentRow: Boolean(agentLabel(tab)) });
}

describe('Elapsed time on TERMINALS rows (bundle 3, U5)', () => {
  test("MIN-1: the label is '' under a minute, then whole minutes, then hours and minutes, never seconds", () => {
    for (const ms of [0, 1, 59 * SECOND, MINUTE - 1]) assert.equal(elapsedLabel(ms), '', `${ms} ms`);
    assert.equal(elapsedLabel(MINUTE), '1m');
    assert.equal(elapsedLabel(3 * MINUTE), '3m');
    assert.equal(elapsedLabel(3 * MINUTE + 59 * SECOND + 999), '3m', 'rounded down');
    assert.equal(elapsedLabel(59 * MINUTE), '59m');
    assert.equal(elapsedLabel(HOUR - 1), '59m');
    assert.equal(elapsedLabel(HOUR), '1h 0m');
    assert.equal(elapsedLabel(2 * HOUR + 5 * MINUTE), '2h 5m');
    assert.equal(elapsedLabel(2 * HOUR + 5 * MINUTE + 59 * SECOND), '2h 5m');
    assert.equal(elapsedLabel(30 * HOUR), '30h 0m', 'no days: hours go on counting');
    for (let ms = 0; ms < 3 * HOUR; ms += 7 * SECOND + 13) {
      const label = elapsedLabel(ms);
      assert.match(label, /^(?:|[1-9]\d?m|[1-9]\d*h [0-5]?\dm)$/, `${ms} ms gave ${label}`);
      assert.ok(!/s/.test(label), `${ms} ms counts seconds: ${label}`);
    }
  });

  test('MIN-2: anything that is not a time has no label, and the words are empty exactly where the label is', () => {
    for (const bad of [-1, -MINUTE, -HOUR, NaN, Infinity, -Infinity, null, undefined, '180000', {}, [], true, 10n]) {
      assert.equal(elapsedLabel(bad), '', String(bad));
      assert.equal(elapsedWords(bad), '', String(bad));
    }
    assert.equal(elapsedWords(MINUTE), 'for 1 minute');
    assert.equal(elapsedWords(3 * MINUTE + 30 * SECOND), 'for 3 minutes');
    assert.equal(elapsedWords(12 * MINUTE), 'for 12 minutes');
    assert.equal(elapsedWords(HOUR), 'for 1 hour');
    assert.equal(elapsedWords(HOUR + MINUTE), 'for 1 hour 1 minute');
    assert.equal(elapsedWords(2 * HOUR + 5 * MINUTE), 'for 2 hours 5 minutes');
    for (let ms = -2 * MINUTE; ms < 2 * HOUR; ms += 11 * SECOND) {
      assert.equal(elapsedWords(ms) === '', elapsedLabel(ms) === '', `${ms} ms: ${elapsedLabel(ms)} / ${elapsedWords(ms)}`);
      assert.ok(!/second/.test(elapsedWords(ms)), `${ms} ms in seconds: ${elapsedWords(ms)}`);
    }
  });

  test("MIN-3: Working and Idle count from the agent's activity.since, only while the activity is that state", () => {
    const claude = agentTab('c', 'claude');
    const working = { state: 'working', since: T0 - 3 * MINUTE };
    const idle = { state: 'idle', since: T0 - 12 * MINUTE };
    assert.equal(terminalStatus(claude, { activity: working }).state, 'working');
    assert.equal(startOf(claude, { activity: working }), working.since);
    assert.equal(elapsedLabel(T0 - startOf(claude, { activity: working })), '3m');
    assert.equal(startOf(claude, { activity: idle }), idle.since);
    assert.equal(elapsedLabel(T0 - startOf(claude, { activity: idle })), '12m');
    // A busy bar says Working too, with no activity: no start is known.
    assert.equal(terminalStatus(claude, { progress: { state: 'indeterminate' } }).state, 'working');
    assert.equal(startOf(claude, { progress: { state: 'indeterminate' } }), null);
    // The state and the activity disagree (the status handed in is not the activity's): no time.
    assert.equal(elapsedSince(claude, terminalStatus(claude, { activity: idle }), { activity: working, agentRow: true }), null);
    assert.equal(elapsedSince(claude, terminalStatus(claude, { activity: working }), { activity: idle, agentRow: true }), null);
  });

  test('MIN-4: Waiting counts from activity.since only while the activity is idle; a Waiting with no idle activity has no time', () => {
    const claude = agentTab('c', 'claude');
    const idle = { state: 'idle', since: T0 - 12 * MINUTE };
    assert.equal(terminalStatus(claude, { unread: 1, activity: idle }).state, 'waiting');
    assert.equal(startOf(claude, { unread: 1, activity: idle }), idle.since);
    assert.equal(elapsedLabel(T0 - startOf(claude, { unread: 1, activity: idle })), '12m');
    assert.equal(startOf(claude, { unread: 2, activity: { state: 'working', since: T0 - 5 * MINUTE } }), null, 'a working agent with an unread bell');
    assert.equal(startOf(claude, { unread: 1 }), null, 'no activity at all');
    assert.equal(startOf(agentTab('o', 'opencode', { running: true, runStartedAt: T0 - 4 * MINUTE }), { unread: 1 }), null, "OpenCode's message");
  });

  test('MIN-5: Running counts from tab.runStartedAt on an agent row only (OpenCode); a plain shell gets no time', () => {
    const opencode = agentTab('o', 'opencode', { running: true, runStartedAt: T0 - 4 * MINUTE });
    assert.equal(agentLabel(opencode), 'OpenCode');
    assert.equal(terminalStatus(opencode).state, 'running');
    assert.equal(startOf(opencode), opencode.runStartedAt);
    assert.equal(elapsedLabel(T0 - startOf(opencode)), '4m');
    const plain = plainTab('p', { running: true, runStartedAt: T0 - 9 * MINUTE });
    assert.equal(terminalStatus(plain).state, 'running');
    assert.equal(startOf(plain), null);
    assert.equal(elapsedSince(plain, terminalStatus(plain), { agentRow: false }), null);
    // Show Agent off, or an agent the line does not name: not an agent row.
    assert.equal(elapsedSince(opencode, terminalStatus(opencode), { agentRow: false }), null);
    assert.equal(elapsedSince(opencode, terminalStatus(opencode)), null, 'agentRow defaults to no');
    assert.equal(elapsedSince(opencode, terminalStatus(opencode), { agentRow: 'yes' }), null, 'only true is an agent row');
    const offered = { ...opencode, agentResumeOffered: true };
    assert.equal(startOf(offered), null, 'a record offered back is no agent running');
    const working = { state: 'working', since: T0 - 3 * MINUTE };
    assert.equal(elapsedSince(agentTab('c', 'claude'), terminalStatus(agentTab('c', 'claude'), { activity: working }), { activity: working, agentRow: false }), null);
  });

  test('MIN-6: no data, or a state that has no start, gives no time', () => {
    const claude = agentTab('c', 'claude');
    for (const since of [null, undefined, 0, -5, NaN, Infinity, '1000', {}]) {
      assert.equal(startOf(claude, { activity: { state: 'working', since } }), null, `since ${String(since)}`);
      assert.equal(startOf(claude, { unread: 1, activity: { state: 'idle', since } }), null, `waiting since ${String(since)}`);
    }
    for (const runStartedAt of [null, undefined, 0, NaN, 'soon']) {
      assert.equal(startOf(agentTab('o', 'opencode', { running: true, runStartedAt })), null, `runStartedAt ${String(runStartedAt)}`);
    }
    const idle = { state: 'idle', since: T0 - 12 * MINUTE };
    const cases = [
      ['progress', agentTab('o', 'opencode', { running: true, runStartedAt: T0 - HOUR }), { progress: { state: 'normal', value: 40 } }],
      ['progress', agentTab('o', 'opencode', { running: true, runStartedAt: T0 - HOUR }), { progress: { state: 'warning', value: 40 } }],
      ['error', agentTab('o', 'opencode', { running: true, runStartedAt: T0 - HOUR }), { progress: { state: 'error', value: 10 } }],
      ['failed', agentTab('o', 'opencode', { lastExitCode: 1, runStartedAt: T0 - HOUR }), {}],
      // OpenCode at a prompt between two runs: its title says nothing of a state.
      ['none', agentTab('o', 'opencode', { runStartedAt: T0 - HOUR }), {}],
    ];
    for (const [state, tab, options] of cases) {
      assert.equal(terminalStatus(tab, options).state, state);
      assert.equal(startOf(tab, { ...options, activity: idle }), null, state);
    }
    const exited = agentTab('c', 'claude', { exited: { code: 0 }, runStartedAt: T0 - HOUR });
    assert.equal(elapsedSince(exited, terminalStatus(exited, { activity: idle }), { activity: idle, agentRow: true }), null, 'exited');
    assert.equal(elapsedSince(null, { state: 'running' }, { agentRow: true }), null);
    assert.equal(elapsedSince(claude, null, { activity: idle, agentRow: true }), null);
    assert.equal(elapsedSince(claude, { state: 'idle' }), null);
    assert.equal(elapsedSince(claude, { state: 'idle' }, undefined), null);
  });

  test('MIN-7: the clock has no timer before the first subscriber, one for five, and none after the last one leaves', () => {
    const time = fakeTime(T0 + 20 * SECOND);
    const clock = clockOn(time);
    assert.equal(time.live, 0, 'a clock nobody listens to sets nothing');
    assert.equal(typeof clock.getSnapshot(), 'number');
    assert.equal(time.live, 0, 'reading it sets nothing');
    const offs = Array.from({ length: 5 }, () => clock.subscribe(() => {}));
    assert.equal(time.live, 1, 'one timer for five subscribers');
    assert.equal(time.delays.length, 1, 'only one was ever set');
    for (const off of offs.slice(0, 4)) off();
    assert.equal(time.live, 1, 'one is still listening');
    offs[0]();
    offs[0]();
    assert.equal(time.live, 1, 'an unsubscribe called twice counts once');
    offs[4]();
    assert.equal(time.live, 0, 'nobody listens: no timer');
    time.to(T0 + 10 * MINUTE);
    assert.equal(time.delays.length, 1, 'nothing was set again while nobody listened');
    const again = clock.subscribe(() => {});
    assert.equal(time.live, 1, 'the next subscriber starts it again');
    again();
    assert.equal(time.live, 0);
  });

  test('MIN-8: the timer is set for the next minute of the wall clock and tells each subscriber once per minute boundary', () => {
    assert.equal(msToNextMinute(T0), MINUTE, 'on the boundary: the next one');
    assert.equal(msToNextMinute(T0 + 1), MINUTE - 1);
    assert.equal(msToNextMinute(T0 + 20.5 * SECOND), 39.5 * SECOND);
    assert.equal(msToNextMinute(-1), 1, 'before 1970 too');
    const time = fakeTime(T0 + 20.5 * SECOND);
    const clock = clockOn(time);
    const heard = [0, 0, 0, 0, 0];
    const snapshots = [];
    const offs = heard.map((_, i) =>
      clock.subscribe(() => {
        heard[i] += 1;
        if (i === 0) snapshots.push(clock.getSnapshot());
      })
    );
    assert.deepEqual(time.delays, [39.5 * SECOND], 'set for 10:01:00');
    time.to(T0 + MINUTE - 1);
    assert.deepEqual(heard, [0, 0, 0, 0, 0], 'nothing before the minute ends');
    time.to(T0 + MINUTE);
    assert.deepEqual(heard, [1, 1, 1, 1, 1], 'each told once at 10:01:00');
    time.to(T0 + 3 * MINUTE + 30 * SECOND);
    assert.deepEqual(heard, [3, 3, 3, 3, 3], 'once per boundary: 10:02 and 10:03');
    assert.deepEqual(time.delays.slice(1), [MINUTE, MINUTE, MINUTE], 'each next timer is a whole minute: no drift, nothing per second');
    assert.equal(time.live, 1);
    const first = Math.floor(T0 / MINUTE);
    assert.deepEqual(snapshots, [first + 1, first + 2, first + 3], 'the snapshot is the new minute when it is told');
    for (const off of offs) off();
    assert.equal(time.live, 0);
  });

  test('MIN-9: a timer that fires early tells nobody and is set again for the real boundary; a snapshot holds for its whole minute', () => {
    const time = fakeTime(T0 + 30 * SECOND);
    const clock = clockOn(time);
    let heard = 0;
    const off = clock.subscribe(() => {
      heard += 1;
    });
    time.set(T0 + MINUTE - 2);
    time.fire();
    assert.equal(heard, 0, 'still 10:00: no new minute');
    assert.equal(time.live, 1, 'set again');
    assert.equal(time.delays.at(-1), 2, 'for the 2 ms left');
    time.to(T0 + MINUTE);
    assert.equal(heard, 1);
    off();
    const still = clockOn(fakeTime(T0));
    const a = still.getSnapshot();
    assert.equal(still.getServerSnapshot(), a, 'the server render reads the same clock');
    const t2 = fakeTime(T0);
    const c2 = clockOn(t2);
    const seen = new Set();
    for (let ms = 0; ms < MINUTE; ms += 997) {
      t2.set(T0 + ms);
      seen.add(c2.getSnapshot());
    }
    assert.equal(seen.size, 1, 'one snapshot within a minute');
    t2.set(T0 + MINUTE);
    assert.equal(c2.getSnapshot(), a + 1);
    assert.equal(c2.now(), T0 + MINUTE, 'now reads the clock it was given');
  });

  test('MIN-10: subscribers are counted per subscribe; one leaving while told stops the clock when it was the last', () => {
    const time = fakeTime(T0 + 5 * SECOND);
    const clock = clockOn(time);
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    const one = clock.subscribe(listener);
    const two = clock.subscribe(listener);
    one();
    assert.equal(time.live, 1, 'the same function subscribed twice is two subscribers');
    time.to(T0 + MINUTE);
    assert.equal(calls, 1, 'the one left is told once');
    two();
    assert.equal(time.live, 0);

    let off = null;
    off = clock.subscribe(() => off());
    let later = 0;
    const stays = clock.subscribe(() => {
      later += 1;
    });
    stays();
    time.to(T0 + 2 * MINUTE);
    assert.equal(later, 0, 'a subscriber that left is not told');
    assert.equal(time.live, 0, 'the last one left while told: no timer');
    time.to(T0 + 10 * MINUTE);
    assert.equal(time.live, 0);
  });

  test('MIN-11: the app has one clock, and creating it set no timer', () => {
    assert.equal(MINUTE_MS, MINUTE);
    for (const name of ['subscribe', 'getSnapshot', 'getServerSnapshot', 'now']) assert.equal(typeof minuteClock[name], 'function', name);
    assert.ok(Object.isFrozen(minuteClock));
    assert.equal(minuteClock.getSnapshot(), Math.floor(Date.now() / MINUTE));
    // The default timers are the global ones, looked up when first used.
    const had = globalThis.setTimeout;
    const hadClear = globalThis.clearTimeout;
    const set = [];
    const cleared = [];
    globalThis.setTimeout = (fn, ms) => {
      set.push(ms);
      return 'timer-1';
    };
    globalThis.clearTimeout = (id) => cleared.push(id);
    try {
      const clock = createMinuteClock();
      const off = clock.subscribe(() => {});
      off();
      assert.equal(set.length, 1);
      assert.ok(set[0] > 0 && set[0] <= MINUTE, `waits ${set[0]} ms`);
      assert.deepEqual(cleared, ['timer-1']);
    } finally {
      globalThis.setTimeout = had;
      globalThis.clearTimeout = hadClear;
    }
  });

  test("MIN-12: a hook that is off subscribes to nothing; on, it is the clock's own functions, the same every time", () => {
    const time = fakeTime(T0);
    const clock = clockOn(time);
    const off = minuteNowSource(false, clock);
    assert.equal(minuteNowSource(false, clock), off, 'the same functions every time');
    assert.equal(minuteNowSource(false), off);
    let told = 0;
    const unsubscribe = off.subscribe(() => {
      told += 1;
    });
    assert.equal(time.live, 0, 'off: the clock has no subscriber');
    time.to(T0 + 5 * MINUTE);
    assert.equal(told, 0, 'off: never told');
    assert.equal(off.getSnapshot(), null);
    assert.equal(off.getServerSnapshot(), null);
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
    const on = minuteNowSource(true, clock);
    assert.equal(on.subscribe, clock.subscribe);
    assert.equal(on.getSnapshot, clock.getSnapshot);
    assert.equal(on.getServerSnapshot, clock.getServerSnapshot);
    assert.equal(minuteNowSource(true).subscribe, minuteClock.subscribe, "the app's clock by default");
  });

  test('MIN-13: mounted, lines that show a time share one timer and redraw once a minute; one that shows none never does', async () => {
    const h = React.createElement;
    const time = fakeTime(T0 + 15 * SECOND);
    const clock = clockOn(time);
    const draws = { a: 0, b: 0, c: 0, off: 0 };
    const nows = { a: [], off: [] };
    function Line({ name, on }) {
      const now = useMinuteNow(on, clock);
      draws[name] += 1;
      if (nows[name]) nows[name].push(now);
      return h('span', null, now === null ? '' : String(now));
    }
    const lines = (offOn = false) =>
      h('div', null, h(Line, { name: 'a', on: true }), h(Line, { name: 'b', on: true }), h(Line, { name: 'c', on: true }), h(Line, { name: 'off', on: offOn }));
    await onPage(async (p) => {
      p.render(lines());
      assert.equal(time.live, 1, 'three lines that show a time: one timer');
      const first = { ...draws };
      p.settled(() => time.to(T0 + 59 * SECOND));
      assert.deepEqual(draws, first, 'nothing redrawn within the minute');
      p.settled(() => time.to(T0 + MINUTE));
      assert.deepEqual(draws, { a: first.a + 1, b: first.b + 1, c: first.c + 1, off: first.off }, 'each line with a time redrawn once; the one without none');
      // One minute at a time: React draws what one `settled` set off once.
      for (const m of [2, 3]) p.settled(() => time.to(T0 + m * MINUTE));
      assert.deepEqual(draws, { a: first.a + 3, b: first.b + 3, c: first.c + 3, off: first.off });
      assert.equal(nows.a.at(-1), T0 + 3 * MINUTE, 'the time read when drawn');
      assert.ok(nows.off.every((now) => now === null), 'off: no time');
      p.render(lines(true));
      assert.equal(time.live, 1, 'a fourth line turning on shares the timer');
      p.settled(() => time.to(T0 + 4 * MINUTE));
      assert.equal(nows.off.at(-1), T0 + 4 * MINUTE, 'and is told on the next minute');
      p.unmount();
      assert.equal(time.live, 0, 'every line gone: no timer');
    });
    assert.equal(time.live, 0);
  });
});
