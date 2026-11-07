/**
 * When a terminal's scrollback is written to disk (stage 6, spec D5 and D6;
 * src/lib/scrollbackSaver.js) — driven with a clock and timers the test moves
 * by hand, and a backend that writes down what it is asked, in order.
 *
 * What is held here:
 *   - saved 1 s after the last change, and at most 10 s after the first while
 *     a terminal keeps changing (a plain debounce never saves a terminal that
 *     never stops printing)
 *   - only terminals that changed; one serialized per task
 *   - every backend call in one queue, in call order: a delete is never
 *     overtaken by a write of the same tab, a clear never by a write before it
 *   - a closed tab's waiting change dropped and its file deleted
 *   - the exit flush bounded, resolving either way, never waiting for what
 *     changes after it was asked
 *   - "unsaved" reported when it changes and only then; nothing at all while
 *     saving is off
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  createScrollbackSaver,
  EXIT_FLUSH_MS,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  SAVE_MIN_INTERVAL_MS,
  CLEAR_SAVE_GAP_MS,
  FAILURES_BEFORE_STOP,
  BREAKER_PROBE_MS,
  UNTRUSTED_KEY,
  isAnotherInstance,
  pageStorage,
} from '../../src/lib/scrollbackSaver.js';

/** Let every promise already settled run its callbacks. */
async function drain() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/** A clock and timers moved only by `advance`, firing one timer at a time in order. */
function fakeTimers(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const fired = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn, seq });
      return seq;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    get count() {
      return timers.size;
    },
    fired,
    /** Move the clock `ms` on, running each timer due on the way, then whatever it settled. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at > end) continue;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
        }
        if (!next) break;
        timers.delete(next.seq);
        t = next.at;
        fired.push(next.seq);
        next.fn();
        await drain();
      }
      t = end;
      await drain();
    },
  };
}

/** A promise and its resolve, to hold a backend call open. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The backend: every call written down as it STARTS, `[name, ...args]`, and
 * `pending` reports apart. `hold(name, tabId)` keeps the next such call open
 * until the test lets it go.
 */
function fakeBackend({ failWith = null } = {}) {
  const calls = [];
  const pending = [];
  const holds = [];
  const settled = [];
  const answer = (name, args) => {
    calls.push([name, ...args]);
    // A backend that refuses every call that changes the files, as one with a broken folder does.
    if (failWith !== null && name !== 'read') return Promise.reject(failWith);
    const at = holds.findIndex((h) => h.name === name && (h.tabId === undefined || h.tabId === args[0]));
    const done = () => settled.push([name, ...args]);
    if (at === -1) {
      done();
      return Promise.resolve(name === 'read' ? `file of ${args[0]}` : null);
    }
    const [hold] = holds.splice(at, 1);
    return hold.gate.promise.then(() => {
      done();
      // Tauri rejects with the command's error string.
      if (hold.error !== null) throw hold.error;
      if (hold.reject) throw new Error(`${name} refused`);
      // A held read still answers its file: what comes back is the saver's to decide.
      return name === 'read' ? `file of ${args[0]}` : null;
    });
  };
  return {
    calls,
    pending,
    settled,
    names: () => calls.map((c) => `${c[0]} ${c[1] ?? ''}`.trim()),
    /** From now on refuse every call that changes the files with `error` — or, null, answer them again. */
    fail(error) {
      failWith = error;
    },
    hold(name, tabId, { reject = false, error = null } = {}) {
      const gate = deferred();
      holds.push({ name, tabId, gate, reject, error });
      return gate;
    },
    write: (tabId, text) => answer('write', [tabId, text]),
    delete: (tabId) => answer('delete', [tabId]),
    retainOnly: (ids) => answer('retainOnly', [ids]),
    clear: () => answer('clear', []),
    read: (tabId) => answer('read', [tabId]),
    setPending: (value) => pending.push(value),
  };
}

/** A saver on fake timers; `shots` says what each tab's snapshot is (default: its name and a counter). */
function makeSaver({ shots = {}, enabled = () => true, warn = () => {}, failWith = null } = {}) {
  const clock = fakeTimers();
  const backend = fakeBackend({ failWith });
  // The page's storage: what the saver notes there, as a map the test reads.
  const stored = new Map();
  const storage = {
    get: (key) => (stored.has(key) ? stored.get(key) : null),
    set: (key, value) => stored.set(key, String(value)),
    remove: (key) => stored.delete(key),
  };
  const taken = [];
  const counter = new Map();
  const saver = createScrollbackSaver({
    snapshot: (tabId) => {
      taken.push({ tabId, at: clock.now(), timer: clock.fired.length });
      if (Object.prototype.hasOwnProperty.call(shots, tabId)) {
        const shot = shots[tabId];
        return typeof shot === 'function' ? shot() : shot;
      }
      const n = (counter.get(tabId) ?? 0) + 1;
      counter.set(tabId, n);
      return { text: `${tabId}#${n}` };
    },
    backend,
    enabled,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    storage,
    warn,
  });
  return { saver, clock, backend, taken, storage: stored };
}

const writes = (backend) => backend.calls.filter((c) => c[0] === 'write').map((c) => `${c[1]}=${c[2]}`);

describe('Scrollback saver: when a terminal is saved', () => {
  test('SV-01: saved 1 s after its last change — not before, and each change starts the wait again', async () => {
    const { saver, clock, backend } = makeSaver();
    assert.equal(SAVE_DEBOUNCE_MS, 1000);
    saver.markDirty('tab-term-1');
    await clock.advance(999);
    assert.deepEqual(writes(backend), [], 'saved before it had been quiet for a second');
    saver.markDirty('tab-term-1');
    await clock.advance(999);
    assert.deepEqual(writes(backend), [], 'a change does not start the wait again');
    await clock.advance(1);
    assert.deepEqual(writes(backend), ['tab-term-1=tab-term-1#1']);
    assert.equal(saver.isDirty('tab-term-1'), false);
    await clock.advance(30_000);
    assert.deepEqual(writes(backend), ['tab-term-1=tab-term-1#1'], 'saved again with nothing changed');
    assert.equal(clock.count, 0, 'a timer left running with nothing to save');
  });

  test('SV-02: a terminal that never stops changing is saved every 10 s — never starved', async () => {
    const { saver, clock, backend } = makeSaver();
    assert.equal(SAVE_MAX_WAIT_MS, 10_000);
    const started = clock.now();
    const savedAt = [];
    for (let elapsed = 0; elapsed < 25_000; elapsed += 200) {
      saver.markDirty('tab-term-2');
      const before = writes(backend).length;
      await clock.advance(200);
      if (writes(backend).length > before) savedAt.push(clock.now() - started);
    }
    // First change at 0, every 200 ms after: due at 10 000, and 10 000 after
    // the first change following that save — the one at 10 000 itself.
    assert.deepEqual(savedAt, [10_000, 20_000], `saved at ${savedAt}`);
    await clock.advance(SAVE_DEBOUNCE_MS);
    assert.equal(writes(backend).length, 3, 'its last change, once it stopped');
  });

  test('SV-03: only the terminals that changed are read and saved', async () => {
    const { saver, clock, backend, taken } = makeSaver();
    saver.markDirty('tab-term-1');
    saver.markDirty('tab-term-3');
    await clock.advance(1000);
    assert.deepEqual(taken.map((t) => t.tabId).sort(), ['tab-term-1', 'tab-term-3']);
    assert.deepEqual(writes(backend).sort(), ['tab-term-1=tab-term-1#1', 'tab-term-3=tab-term-3#1']);
    saver.markDirty('tab-term-3');
    // Its second save waits for SAVE_MIN_INTERVAL_MS after its first (SV-19).
    await clock.advance(SAVE_MIN_INTERVAL_MS);
    assert.deepEqual(taken.map((t) => t.tabId), ['tab-term-1', 'tab-term-3', 'tab-term-3'], 'a quiet terminal read again');
  });

  test('SV-04: four due at once are serialized one per task, in the order they changed', async () => {
    const { saver, clock, taken } = makeSaver();
    for (const id of ['tab-term-4', 'tab-term-5', 'tab-term-6', 'tab-term-7']) saver.markDirty(id);
    await clock.advance(1000);
    assert.deepEqual(taken.map((t) => t.tabId), ['tab-term-4', 'tab-term-5', 'tab-term-6', 'tab-term-7']);
    const tasks = taken.map((t) => t.timer);
    assert.equal(new Set(tasks).size, 4, `two terminals serialized in one task: ${tasks}`);
  });

  test('SV-05: a snapshot of nothing deletes the file; no terminal to read leaves it alone', async () => {
    const { saver, clock, backend } = makeSaver({ shots: { 'tab-term-8': null, 'tab-term-9': undefined } });
    saver.markDirty('tab-term-8');
    saver.markDirty('tab-term-9');
    await clock.advance(1000);
    assert.deepEqual(backend.names(), ['delete tab-term-8'], 'a cleared terminal keeps its old file, or a tab with no terminal lost its');
  });

  test('SV-06: a snapshot that throws is logged, and the next terminal is still saved', async () => {
    const warned = [];
    const { saver, clock, backend } = makeSaver({
      shots: {
        'tab-term-10': () => {
          throw new Error('buffer gone');
        },
      },
      warn: (...args) => warned.push(args.join(' ')),
    });
    saver.markDirty('tab-term-10');
    saver.markDirty('tab-term-11');
    await clock.advance(1000);
    assert.deepEqual(writes(backend), ['tab-term-11=tab-term-11#1']);
    assert.ok(warned.some((w) => w.includes('tab-term-10')), 'not said');
    assert.equal(saver.pending, false);
  });
});

describe('Scrollback saver: one queue, in call order', () => {
  test('SV-07: a closed tab is deleted only after its write already on the way — never overtaken', async () => {
    const { saver, clock, backend } = makeSaver();
    const gate = backend.hold('write', 'tab-term-12');
    saver.markDirty('tab-term-12');
    await clock.advance(1000);
    assert.deepEqual(backend.names(), ['write tab-term-12']);
    saver.forget('tab-term-12');
    await clock.advance(0);
    assert.deepEqual(backend.names(), ['write tab-term-12'], 'the delete went out while the write was still on its way');
    gate.resolve();
    await clock.advance(0);
    assert.deepEqual(backend.names(), ['write tab-term-12', 'delete tab-term-12']);
    assert.deepEqual(backend.settled.map((c) => c[0]), ['write', 'delete'], 'settled out of order');
  });

  test('SV-08: closing a tab drops what it had waiting — nothing written after, its file deleted, no timer left', async () => {
    const { saver, clock, backend } = makeSaver();
    saver.markDirty('tab-term-13');
    saver.forget('tab-term-13');
    await clock.advance(20_000);
    assert.deepEqual(backend.names(), ['delete tab-term-13']);
    assert.equal(clock.count, 0, 'its timer still running');
    assert.equal(saver.pending, false);
  });

  test('SV-09: a clear comes after every write queued before it, and nothing waiting is written after it', async () => {
    const { saver, clock, backend } = makeSaver();
    const gate = backend.hold('write', 'tab-term-14');
    saver.markDirty('tab-term-14');
    await clock.advance(1000);
    saver.markDirty('tab-term-15');
    saver.markDirty('tab-term-16');
    saver.clearAll();
    gate.resolve();
    await clock.advance(20_000);
    assert.deepEqual(backend.names(), ['write tab-term-14', 'clear']);
    assert.deepEqual(backend.settled.map((c) => c[0]), ['write', 'clear']);
    assert.equal(saver.pending, false);
    assert.equal(clock.count, 0);
  });

  test('SV-10: a backend call that fails does not stop the queue — and a save to be tried again is not logged each time', async () => {
    const warned = [];
    const { saver, clock, backend } = makeSaver({ warn: (...args) => warned.push(args.join(' ')) });
    const gate = backend.hold('write', 'tab-term-17', { reject: true });
    saver.markDirty('tab-term-17');
    await clock.advance(1000);
    saver.forget('tab-term-17');
    gate.resolve();
    await clock.advance(0);
    assert.deepEqual(backend.names(), ['write tab-term-17', 'delete tab-term-17']);
    // Said once if it keeps failing, when saving stops (SV-29); one that
    // recovers needed no word.
    assert.deepEqual(warned, [], warned.join('\n'));
    assert.equal(saver.pending, false, 'a failed write left it unsaved for good');
    // A call nothing tries again is logged.
    const cleared = makeSaver({ warn: (...args) => warned.push(args.join(' ')) });
    cleared.backend.hold('clear', undefined, { reject: true }).resolve();
    cleared.saver.clearAll();
    await cleared.clock.advance(0);
    assert.ok(warned.some((w) => w.includes('delete the saved scrollback')), `a failed Clear went unsaid: ${warned.join('\n')}`);
  });

  test('SV-11: the start\'s keep-only is queued like the rest; a restore\'s read is not — and is not unsaved', async () => {
    const { saver, clock, backend } = makeSaver();
    const gate = backend.hold('retainOnly');
    saver.retainOnly(['tab-term-1', 'tab-term-2']);
    const written = backend.hold('write', 'tab-term-9');
    saver.markDirty('tab-term-9');
    await clock.advance(1000);
    // A restored tab waits for its read before it shows its shell's output:
    // behind other tabs' writes (megabytes), it timed out (review, round 2).
    const read = saver.read('tab-term-1');
    assert.equal(await read, 'file of tab-term-1', 'the read waited behind the queue');
    assert.deepEqual(backend.names(), ['retainOnly tab-term-1,tab-term-2', 'read tab-term-1']);
    gate.resolve();
    written.resolve();
    await clock.advance(0);
    assert.deepEqual(backend.pending, [true, false], 'the read counted as unsaved');
    const lone = makeSaver();
    await lone.saver.read('tab-term-3');
    assert.deepEqual(lone.backend.pending, [], 'a read reported as unsaved');
  });
});

describe('Scrollback saver: leaving', () => {
  test('SV-12: flushAll saves what changed now, without the wait, and resolves true once it is written', async () => {
    const { saver, clock, backend } = makeSaver();
    assert.equal(EXIT_FLUSH_MS, 1500);
    saver.markDirty('tab-term-18');
    saver.markDirty('tab-term-19');
    const gate = backend.hold('write', 'tab-term-19');
    let result = 'unsettled';
    saver.flushAll({ timeoutMs: 1500 }).then((r) => {
      result = r;
    });
    await clock.advance(0);
    await clock.advance(0);
    assert.deepEqual(writes(backend).sort(), ['tab-term-18=tab-term-18#1', 'tab-term-19=tab-term-19#1'], 'waited for the debounce');
    assert.equal(result, 'unsettled', 'resolved before the last write was on disk');
    gate.resolve();
    await clock.advance(0);
    assert.equal(result, true);
    assert.equal(clock.count, 0, 'the bound\'s timer left running');
  });

  test('SV-13: flushAll is bounded — a backend that never answers resolves it false at the bound, never a rejection', async () => {
    const { saver, clock, backend } = makeSaver();
    saver.markDirty('tab-term-20');
    backend.hold('write', 'tab-term-20');
    let result = 'unsettled';
    saver.flushAll({ timeoutMs: 1500 }).then(
      (r) => {
        result = r;
      },
      () => {
        result = 'rejected';
      }
    );
    await clock.advance(1499);
    assert.equal(result, 'unsettled');
    await clock.advance(1);
    assert.equal(result, false);
  });

  test('SV-14: flushAll does not wait for a terminal that changes after it was asked', async () => {
    const { saver, clock, backend } = makeSaver();
    saver.markDirty('tab-term-21');
    let result = 'unsettled';
    saver.flushAll({ timeoutMs: 1500 }).then((r) => {
      result = r;
    });
    saver.markDirty('tab-term-22');
    await clock.advance(0);
    await clock.advance(0);
    assert.equal(result, true, 'held by a change made after the flush was asked for');
    assert.deepEqual(writes(backend), ['tab-term-21=tab-term-21#1']);
    await clock.advance(1000);
    assert.deepEqual(writes(backend), ['tab-term-21=tab-term-21#1', 'tab-term-22=tab-term-22#1'], 'and that one is still saved as usual');
  });

  test('SV-15: with nothing changed, flushAll still waits for what is already on its way (a clear, a delete)', async () => {
    const { saver, clock, backend } = makeSaver();
    const gate = backend.hold('delete', 'tab-term-23');
    saver.forget('tab-term-23');
    let result = 'unsettled';
    saver.flushAll().then((r) => {
      result = r;
    });
    await clock.advance(10);
    assert.equal(result, 'unsettled');
    gate.resolve();
    await clock.advance(0);
    assert.equal(result, true);
  });

  test('SV-16: flushAll for a page being unloaded serializes everything in the same task', async () => {
    const { saver, clock, backend, taken } = makeSaver();
    for (const id of ['tab-term-24', 'tab-term-25', 'tab-term-26']) saver.markDirty(id);
    const timersBefore = clock.fired.length;
    saver.flushAll({ timeoutMs: 1500, sync: true });
    assert.deepEqual(taken.map((t) => t.tabId), ['tab-term-24', 'tab-term-25', 'tab-term-26'], 'not all read at once');
    assert.ok(taken.every((t) => t.timer === timersBefore), 'waited for a task to read one');
    await drain();
    assert.equal(writes(backend).length, 3, 'the writes were not started from the same task');
  });
});

describe('Scrollback saver: what it reports, and when it is off', () => {
  test('SV-17: "unsaved" is reported when it changes and only then — dirty, in flight, then saved', async () => {
    const { saver, clock, backend } = makeSaver();
    const gate = backend.hold('write', 'tab-term-27');
    saver.markDirty('tab-term-27');
    saver.markDirty('tab-term-27');
    saver.markDirty('tab-term-28');
    assert.deepEqual(backend.pending, [true]);
    await clock.advance(1000);
    saver.markDirty('tab-term-27');
    assert.deepEqual(backend.pending, [true], 'reported again while it was already unsaved');
    gate.resolve();
    await clock.advance(SAVE_MIN_INTERVAL_MS);
    assert.deepEqual(backend.pending, [true, false]);
    assert.equal(saver.pending, false);
    saver.markDirty('tab-term-27');
    assert.deepEqual(backend.pending, [true, false, true]);
  });

  test('SV-18: off, nothing is recorded, read or saved — and turned off while waiting, nothing is written', async () => {
    let on = false;
    const { saver, clock, backend, taken } = makeSaver({ enabled: () => on });
    saver.markDirty('tab-term-29');
    await clock.advance(20_000);
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(backend.pending, [], 'reported as unsaved while off');
    assert.equal(saver.pending, false);
    on = true;
    saver.markDirty('tab-term-29');
    on = false;
    await clock.advance(1000);
    assert.deepEqual(taken, [], 'read after it was turned off');
    assert.deepEqual(backend.calls, []);
    assert.equal(saver.pending, false);
    const broken = makeSaver({
      enabled: () => {
        throw new Error('no settings');
      },
    });
    broken.saver.markDirty('tab-term-30');
    await broken.clock.advance(2000);
    assert.deepEqual(broken.backend.calls, [], 'a setting that cannot be read saved anyway');
  });
});

describe('Scrollback saver: review round 2', () => {
  test('SV-19: a terminal printing a line every 1.1 s for a minute is saved at most 12 times, each at least 5 s after the one before', async () => {
    const { saver, clock, backend } = makeSaver();
    assert.equal(SAVE_MIN_INTERVAL_MS, 5000);
    const started = clock.now();
    const at = [];
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1100) {
      saver.markDirty('tab-term-31');
      const before = writes(backend).length;
      await clock.advance(1100);
      if (writes(backend).length > before) at.push(clock.now() - started);
    }
    const saves = writes(backend).length;
    // Before the interval: rewritten whole after every line, 55 a minute.
    assert.ok(saves <= 12, `${saves} saves in a minute`);
    assert.ok(saves >= 9, `only ${saves} saves: a slow printer is starved`);
    const taken = backend.calls.filter((c) => c[0] === 'write').length;
    assert.equal(taken, saves);
    const gaps = [];
    for (let i = 1; i < at.length; i += 1) gaps.push(at[i] - at[i - 1]);
    assert.ok(gaps.every((gap) => gap >= SAVE_MIN_INTERVAL_MS), `saved closer together than the interval: ${gaps}`);
  });

  test('SV-20: a burst then quiet is still saved within 5 s of the save before — the interval delays, never drops', async () => {
    const { saver, clock, backend } = makeSaver();
    const started = clock.now();
    saver.markDirty('tab-term-32');
    await clock.advance(1000);
    assert.equal(writes(backend).length, 1, 'the first change waited for more than the debounce');
    await clock.advance(100);
    for (let i = 0; i < 4; i += 1) {
      saver.markDirty('tab-term-32');
      await clock.advance(100);
    }
    // Last change at 1.4 s; the save before at 1.0 s: due at 6.0 s.
    await clock.advance(4499);
    assert.equal(writes(backend).length, 1, 'saved again inside the interval');
    await clock.advance(1);
    assert.equal(writes(backend).length, 2, 'not saved once the interval was over');
    assert.equal(clock.now() - started, 1000 + SAVE_MIN_INTERVAL_MS);
    await clock.advance(30_000);
    assert.equal(writes(backend).length, 2, 'saved again with nothing changed');
  });

  test('SV-21: closing saves past the interval — flushAll does not wait for it', async () => {
    const { saver, clock, backend } = makeSaver();
    saver.markDirty('tab-term-33');
    await clock.advance(1000);
    saver.markDirty('tab-term-33');
    let result = 'unsettled';
    saver.flushAll({ timeoutMs: 1500 }).then((r) => {
      result = r;
    });
    await clock.advance(0);
    await clock.advance(0);
    assert.equal(writes(backend).length, 2, 'the exit waited for the interval');
    assert.equal(result, true);
  });

  test('SV-22: saveNow serializes and queues at once — no debounce, no interval, a delete for nothing left — still behind the queue', async () => {
    let shot = { text: 'before' };
    const { saver, clock, backend, taken } = makeSaver({ shots: { 'tab-term-34': () => shot } });
    saver.markDirty('tab-term-34');
    await clock.advance(1000);
    assert.deepEqual(backend.names(), ['write tab-term-34']);
    // Cleared straight after: inside the debounce and the interval.
    const gate = backend.hold('write', 'tab-term-35');
    saver.markDirty('tab-term-35');
    saver.saveNow('tab-term-35');
    shot = null;
    saver.markDirty('tab-term-34');
    saver.saveNow('tab-term-34');
    assert.equal(taken.length, 3, 'not serialized in the same task');
    assert.equal(saver.isDirty('tab-term-34'), false);
    await drain();
    assert.deepEqual(backend.names(), ['write tab-term-34', 'write tab-term-35'], 'the delete overtook a write queued before it');
    gate.resolve();
    await drain();
    assert.deepEqual(backend.names(), ['write tab-term-34', 'write tab-term-35', 'delete tab-term-34'], 'the clear did not reach disk without the clock moving');
    await clock.advance(30_000);
    assert.equal(backend.calls.length, 3, 'saved again by the timer afterwards');

    let on = false;
    const off = makeSaver({ enabled: () => on });
    off.saver.saveNow('tab-term-36');
    await drain();
    assert.deepEqual(off.backend.calls, [], 'saved with the setting off');
  });

  test('SV-23: a read goes straight to the backend; a clear while it is on its way answers null; a failed read rejects rather than say "no file"', async () => {
    const { saver, backend } = makeSaver();
    const gate = backend.hold('read', 'tab-term-37');
    const reading = saver.read('tab-term-37');
    saver.clearAll();
    gate.resolve();
    assert.equal(await reading, null, 'what a clear deleted came back through a read begun before it');
    backend.hold('read', 'tab-term-38', { reject: true }).resolve();
    let outcome = 'resolved';
    await saver.read('tab-term-38').then(
      () => {},
      () => {
        outcome = 'rejected';
      }
    );
    assert.equal(outcome, 'rejected', 'a failed read was taken for no file, and the file would be overwritten');
    const throwing = createScrollbackSaver({
      snapshot: () => undefined,
      backend: {
        read: () => {
          throw new Error('no backend');
        },
      },
    });
    outcome = 'resolved';
    await throwing.read('tab-term-39').catch(() => {
      outcome = 'rejected';
    });
    assert.equal(outcome, 'rejected');
  });

  test('SV-24: a file kept after a failed read is never written or deleted by a save — closing deletes it, a clear clears it and saving resumes', async () => {
    const { saver, clock, backend } = makeSaver();
    saver.markDirty('tab-term-40');
    saver.keepFile('tab-term-40');
    assert.equal(saver.pending, false, 'a kept file holds every close for nothing');
    saver.markDirty('tab-term-40');
    saver.saveNow('tab-term-40');
    await saver.flushAll({ timeoutMs: 1500 });
    await clock.advance(30_000);
    assert.deepEqual(backend.calls, [], 'a file that could only not be read in time was overwritten');
    assert.deepEqual(backend.pending, [true, false]);
    assert.equal(saver.isKept('tab-term-40'), true);

    saver.forget('tab-term-40');
    await clock.advance(0);
    assert.deepEqual(backend.names(), ['delete tab-term-40'], 'closing the tab left its file');
    assert.equal(saver.isKept('tab-term-40'), false);

    saver.keepFile('tab-term-41');
    saver.clearAll();
    saver.markDirty('tab-term-41');
    await clock.advance(1000);
    assert.deepEqual(backend.names(), ['delete tab-term-40', 'clear', 'write tab-term-41'], 'not cleared, or never saved again after the clear');
  });
});

describe('Scrollback saver: review round 3', () => {
  const ANOTHER = 'Another NexTerm is using the saved scrollback; this one saves and restores none until it is started again';

  test('SV-25: a clear in the output is saved at once — then at most once every 2 s, the clears inside the gap saved at its end, unsaved meanwhile', async () => {
    const { saver, clock, taken } = makeSaver();
    assert.equal(CLEAR_SAVE_GAP_MS, 2000);
    saver.saveCleared('tab-term-50');
    assert.equal(taken.length, 1, 'not saved at once');
    await clock.advance(300);
    saver.saveCleared('tab-term-50');
    await clock.advance(300);
    saver.saveCleared('tab-term-50');
    assert.equal(taken.length, 1, 'saved again inside the gap');
    assert.equal(saver.pending, true, 'a clear waiting for the end of the gap is not unsaved, so a close does not wait for it');
    await clock.advance(1399);
    assert.equal(taken.length, 1);
    await clock.advance(1);
    assert.equal(taken.length, 2, 'the clears inside the gap were never saved');
    assert.equal(taken[1].at - taken[0].at, CLEAR_SAVE_GAP_MS);
    await clock.advance(30_000);
    assert.equal(taken.length, 2, 'saved again with nothing new');
    // Past the gap: at once again.
    saver.saveCleared('tab-term-50');
    assert.equal(taken.length, 3);
    // Every 300 ms for 10 s: one at once, then one at the end of each gap.
    const { saver: busy, clock: busyClock, taken: busyTaken } = makeSaver();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 300) {
      busy.saveCleared('tab-term-51');
      await busyClock.advance(300);
    }
    assert.ok(busyTaken.length <= 6, `${busyTaken.length} immediate saves in 10 s`);
  });

  test('SV-26: Terminal: Clear (saveNow) is saved at once every time — never held by the clears\' gap; closing a tab drops its waiting clear', async () => {
    const { saver, clock, taken, backend } = makeSaver();
    saver.saveCleared('tab-term-52');
    saver.saveNow('tab-term-52');
    await clock.advance(100);
    saver.saveNow('tab-term-52');
    assert.equal(taken.length, 3, 'a ⌘K inside the gap waited');
    saver.saveCleared('tab-term-52');
    saver.forget('tab-term-52');
    await clock.advance(5000);
    assert.equal(taken.length, 3, 'a closed tab saved at the end of its gap');
    assert.equal(backend.names().at(-1), 'delete tab-term-52');
  });

  test('SV-31: the backend\'s own refusal text (src-tauri/src/scrollback.rs ANOTHER_INSTANCE) is the one recognised', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src-tauri/src/scrollback.rs', import.meta.url), 'utf8');
    const match = /pub const ANOTHER_INSTANCE: &str =\s*"([^"]+)";/.exec(source);
    assert.ok(match, 'the constant is where this test looks for it');
    assert.equal(isAnotherInstance(match[1]), true, match[1]);
    assert.equal(isAnotherInstance(ANOTHER), true);
  });

  test('SV-27: a refusal for another NexTerm is said once and stops every save, the clears and the exit\'s included', async () => {
    const warned = [];
    const { saver, clock, backend, taken } = makeSaver({ warn: (...args) => warned.push(args.join(' ')) });
    assert.equal(isAnotherInstance(ANOTHER), true);
    assert.equal(isAnotherInstance(new Error('disk full')), false);
    backend.hold('write', 'tab-term-53', { error: ANOTHER }).resolve();
    saver.markDirty('tab-term-53');
    await clock.advance(1000);
    assert.equal(saver.refused, true);
    const shotsBefore = taken.length;
    for (let i = 0; i < 5; i += 1) {
      saver.markDirty('tab-term-54');
      saver.saveNow('tab-term-55');
      saver.saveCleared('tab-term-56');
      assert.equal(saver.pending, false, 'after a refusal, a change still counts as unsaved and holds the close');
      await clock.advance(11_000);
    }
    assert.equal(taken.length, shotsBefore, 'still serializing terminals whose saves will all be refused');
    assert.equal(await saver.flushAll({ timeoutMs: 1500 }), true);
    assert.deepEqual(backend.names(), ['write tab-term-53'], 'tried again after a refusal that will not change');
    assert.equal(warned.length, 1, `said ${warned.length} times`);
    assert.match(warned[0], /another NexTerm/i);
    assert.equal(saver.pending, false, 'a refused session holds every close for nothing');
  });

  test('SV-28: any other failed save is tried again at the terminal\'s next interval — not once it closed, nor after a clear of everything', async () => {
    const { saver, clock, backend } = makeSaver();
    backend.hold('write', 'tab-term-57', { reject: true }).resolve();
    saver.markDirty('tab-term-57');
    await clock.advance(1000);
    assert.equal(saver.isDirty('tab-term-57'), true, 'a failed save was taken for a saved one: what it held is lost until the next change');
    assert.equal(saver.refused, false);
    await clock.advance(SAVE_MIN_INTERVAL_MS - 1);
    assert.equal(writes(backend).length, 1, 'tried again before the interval');
    await clock.advance(1);
    assert.equal(writes(backend).length, 2, 'never tried again');
    // A delete that fails is tried again the same way.
    const { saver: del, clock: delClock, backend: delBackend } = makeSaver({ shots: { 'tab-term-58': null } });
    delBackend.hold('delete', 'tab-term-58', { reject: true }).resolve();
    del.markDirty('tab-term-58');
    await delClock.advance(1000);
    await delClock.advance(SAVE_MIN_INTERVAL_MS);
    assert.deepEqual(delBackend.names(), ['delete tab-term-58', 'delete tab-term-58']);
    // Closed, or everything cleared, while the failing save was on its way: let go.
    const { saver: gone, clock: goneClock, backend: goneBackend } = makeSaver();
    const closing = goneBackend.hold('write', 'tab-term-59', { reject: true });
    const clearing = goneBackend.hold('write', 'tab-term-60', { reject: true });
    gone.markDirty('tab-term-59');
    gone.markDirty('tab-term-60');
    await goneClock.advance(1000);
    gone.forget('tab-term-59');
    closing.resolve();
    await goneClock.advance(0);
    gone.clearAll();
    clearing.resolve();
    await goneClock.advance(30_000);
    assert.deepEqual(writes(goneBackend).length, 2, 'a closed tab, or one cleared since, was saved again');
    assert.equal(gone.pending, false);
  });
});

describe('Scrollback saver: review round 4', () => {
  test('SV-29: a folder that refuses every call ("is a link") opens the breaker after three — said once, then one try a minute, nothing serialized or unsaved between', async () => {
    const warned = [];
    const LINK = 'The scrollback folder\'s .scrollback.lock is a link; nothing is saved through one';
    const { saver, clock, backend, taken, storage } = makeSaver({ failWith: LINK, warn: (...args) => warned.push(args.join(' ')) });
    assert.equal(FAILURES_BEFORE_STOP, 3);
    assert.equal(BREAKER_PROBE_MS, 60_000);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1000) {
      saver.markDirty('tab-term-61');
      if (elapsed === 30_000) saver.saveCleared('tab-term-62');
      await clock.advance(1000);
    }
    assert.equal(saver.tripped, true, 'never stopped');
    assert.equal(saver.refused, false, 'a failing folder taken for another NexTerm');
    // Three before it opened; then one a minute.
    assert.ok(backend.calls.length <= 4, `${backend.calls.length} attempts in a minute against a folder that always refuses`);
    assert.equal(warned.length, 1, `said ${warned.length} times`);
    assert.ok(warned[0].includes('is a link'), `the warning does not name the error: ${warned[0]}`);
    assert.ok(storage.has(UNTRUSTED_KEY), 'the files were not noted as possibly stale');
    saver.markDirty('tab-term-61');
    saver.saveNow('tab-term-61');
    assert.equal(saver.pending, false, 'a close held for saves that will all fail');
    const shots = taken.length;
    const calls = backend.calls.length;
    await clock.advance(BREAKER_PROBE_MS * 3);
    assert.ok(taken.length - shots <= 3, `${taken.length - shots} snapshots in three minutes with the breaker open`);
    assert.ok(backend.calls.length - calls <= 3, `${backend.calls.length - calls} tries in three minutes`);
    assert.equal(warned.length, 1, 'a try that failed again was said again');
    assert.equal(saver.pending, false);
    assert.equal(await saver.flushAll({ timeoutMs: 1500 }), true);
  });

  test('SV-30: only failures in a row count — one success between them starts the count again', async () => {
    const run = async (outcomes) => {
      const { saver, clock, backend } = makeSaver();
      const ids = outcomes.map((_, i) => `tab-term-${70 + i}`);
      outcomes.forEach((ok, i) => {
        if (!ok) backend.hold('write', ids[i], { reject: true }).resolve();
      });
      for (const id of ids) saver.markDirty(id);
      await clock.advance(1000);
      assert.equal(backend.calls.length, outcomes.length);
      assert.equal(saver.refused, false);
      return saver.tripped;
    };
    assert.equal(await run([false, false, true, false, false]), false, 'four failures, never three in a row, stopped saving');
    assert.equal(await run([false, false, true, false, false, false]), true, 'three in a row did not stop it');
    assert.equal(await run([false, false, false]), true);
  });
});

describe('Scrollback saver: review round 5 — the breaker recovers', () => {
  test('SV-31: after three passing failures, a clear made while the breaker is open is written first once the folder answers again — and saving resumes', async () => {
    const warned = [];
    const { saver, clock, backend, storage, taken } = makeSaver({ failWith: 'Access is denied. (os error 5)', warn: (...args) => warned.push(args.join(' ')) });
    for (const id of ['tab-term-80', 'tab-term-81', 'tab-term-82']) saver.markDirty(id);
    await clock.advance(1000);
    assert.equal(saver.tripped, true, 'three failures at once did not open the breaker');
    const trippedAt = clock.now();
    // The antivirus lets go; the user clears a terminal; another prints.
    await clock.advance(5000);
    backend.fail(null);
    saver.saveCleared('tab-term-83');
    saver.markDirty('tab-term-84');
    const before = backend.calls.length;
    const shotsBefore = taken.length;
    await clock.advance(trippedAt + BREAKER_PROBE_MS - clock.now() - 1);
    assert.equal(backend.calls.length, before, 'tried before the minute was up');
    assert.equal(taken.length, shotsBefore, 'serialized with the breaker open');
    await clock.advance(1);
    assert.deepEqual(backend.names().slice(before, before + 1), ['write tab-term-83'], 'the waiting clear was not the one let through');
    assert.equal(saver.tripped, false, 'a save that succeeded left the breaker open');
    assert.equal(storage.has(UNTRUSTED_KEY), false, 'the note that the files may be stale outlived a save that succeeded');
    await clock.advance(SAVE_MAX_WAIT_MS);
    const written = new Set(backend.calls.slice(before).filter((c) => c[0] === 'write').map((c) => c[1]));
    for (const id of ['tab-term-80', 'tab-term-81', 'tab-term-82', 'tab-term-84']) {
      assert.ok(written.has(id), `${id} was never saved once the folder answered again`);
    }
    assert.equal(warned.length, 1);
    assert.equal(saver.pending, false);
  });

  test('SV-32: a try that fails keeps the breaker open for another minute — no word, no note taken away — and the terminal longest overdue goes first', async () => {
    const warned = [];
    const { saver, clock, backend, storage } = makeSaver({ failWith: 'busy', warn: (...args) => warned.push(args.join(' ')) });
    for (const id of ['tab-term-85', 'tab-term-86', 'tab-term-87']) saver.markDirty(id);
    await clock.advance(1000);
    assert.equal(saver.tripped, true);
    const calls = backend.calls.length;
    await clock.advance(BREAKER_PROBE_MS);
    assert.equal(backend.calls.length, calls + 1, 'not one try a minute');
    assert.equal(backend.calls[calls][1], 'tab-term-85', 'not the terminal longest overdue');
    await clock.advance(BREAKER_PROBE_MS);
    assert.equal(backend.calls.length, calls + 2);
    assert.equal(saver.tripped, true);
    assert.equal(warned.length, 1, 'a failed try was said again');
    assert.ok(storage.has(UNTRUSTED_KEY), 'the note went without a save succeeding');
  });

  test('SV-33: the note is set when the breaker opens — not for another NexTerm — and goes with a save, or a clear of everything, that succeeds', async () => {
    const other = makeSaver({ failWith: 'Another NexTerm that is running keeps the saved scrollback; this one saves and restores none while it does' });
    other.saver.markDirty('tab-term-88');
    await other.clock.advance(1000);
    assert.equal(other.saver.refused, true);
    assert.equal(other.storage.has(UNTRUSTED_KEY), false, 'the other window\'s files were noted as stale');
    await other.clock.advance(BREAKER_PROBE_MS * 2);
    assert.equal(other.backend.calls.length, 1, 'another NexTerm is tried again');

    const { saver, clock, backend, storage } = makeSaver({ failWith: 'busy' });
    for (const id of ['tab-term-89', 'tab-term-90', 'tab-term-91']) saver.markDirty(id);
    await clock.advance(1000);
    assert.ok(storage.has(UNTRUSTED_KEY));
    assert.equal(saver.untrusted, true);
    backend.fail(null);
    saver.clearAll();
    await clock.advance(0);
    assert.equal(storage.has(UNTRUSTED_KEY), false, 'a clear of everything that succeeded left the note');
    assert.equal(saver.tripped, false);

    // The page's storage itself never throws back.
    const held = globalThis.localStorage;
    globalThis.localStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    try {
      assert.equal(pageStorage.get(UNTRUSTED_KEY), null);
      pageStorage.set(UNTRUSTED_KEY, '1');
      pageStorage.remove(UNTRUSTED_KEY);
    } finally {
      globalThis.localStorage = held;
    }
  });
});
