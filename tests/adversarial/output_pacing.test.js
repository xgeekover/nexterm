/**
 * Output for a terminal the user is not typing in is written at a pace
 * (src/lib/outputPacing.js; wired in terminalRegistry.js), stage 4.
 *
 * What must hold whatever the pace: every chunk written once, in order;
 * nothing held for ever; each chunk's flow-control acknowledgement only
 * once xterm has read the write it went out in; a terminal that stops being
 * paced — focus, cmd waiting for its answer — writes what was held before
 * anything new.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { createOutputPacer, PACE_MS } from '../../src/lib/outputPacing.js';

/** A pacer on a fake clock and fake timers, writing into a list. */
function rig({ paced = () => true } = {}) {
  let t = 0;
  const timers = [];
  const writes = [];
  const pacer = createOutputPacer({
    write: (target, data, read) => writes.push({ target, data, read }),
    paced: (target) => paced(target),
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cancelled = true;
    },
  });
  /** Move the clock on, running every timer that falls due. */
  const advance = (ms) => {
    const until = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.cancelled && x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      t = due.at;
      due.fn();
    }
    t = until;
  };
  return { pacer, writes, advance, timers };
}

describe('Output pacing: terminals without focus', () => {
  test('OP-01: a paced terminal is written at most every PACE_MS, its chunks together and in order', () => {
    const { pacer, writes, advance } = rig();
    const a = {};
    pacer.deliver(a, 'one');
    pacer.deliver(a, 'two');
    assert.deepEqual(writes.map((w) => w.data), [], 'nothing yet');
    advance(0);
    assert.deepEqual(writes.map((w) => w.data), ['onetwo'], 'the first write goes at once: nothing was written before it');
    pacer.deliver(a, 'three');
    advance(PACE_MS - 1);
    assert.equal(writes.length, 1, 'not again within PACE_MS');
    pacer.deliver(a, 'four');
    advance(1);
    assert.deepEqual(writes.map((w) => w.data), ['onetwo', 'threefour']);
  });

  test('OP-02: a terminal that is not paced is written at once — after whatever was held for it', () => {
    let focused = false;
    const { pacer, writes, advance } = rig({ paced: () => !focused });
    const a = {};
    advance(0);
    pacer.deliver(a, 'held-1');
    pacer.deliver(a, 'held-2');
    focused = true;
    pacer.deliver(a, 'now');
    assert.deepEqual(writes.map((w) => w.data), ['held-1held-2', 'now'], 'order never changes');
    advance(PACE_MS * 3);
    assert.equal(writes.length, 2, 'and nothing written twice');
  });

  test('OP-03: a write is limited to the budget, the rest goes on its following turns — none held for ever', () => {
    const { pacer, writes, advance } = rig();
    pacer.configure({ ms: PACE_MS, kb: 1 });
    const a = {};
    const chunk = 'x'.repeat(600);
    for (let i = 0; i < 5; i += 1) pacer.deliver(a, chunk);
    advance(0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.length, 600, 'two chunks would pass 1 KB: one goes');
    advance(PACE_MS * 10);
    assert.equal(writes.reduce((n, w) => n + w.data.length, 0), 3000, 'all of it, in the end');
    assert.ok(writes.every((w) => w.data.length <= 1024 || w.data.length === 600), 'each write within the budget');
    // A single chunk bigger than the budget still goes.
    const b = {};
    pacer.deliver(b, 'y'.repeat(5000));
    advance(PACE_MS);
    assert.equal(writes.at(-1).data.length, 5000);
  });

  test('OP-04: each chunk is acknowledged once the write it went out in has been read — not when it is held', () => {
    const { pacer, writes, advance } = rig();
    const a = {};
    const acked = [];
    pacer.deliver(a, 'p', () => acked.push('p'));
    pacer.deliver(a, 'q', () => acked.push('q'));
    assert.deepEqual(acked, [], 'held: not read');
    advance(0);
    assert.deepEqual(acked, [], 'written, but xterm has not read it yet');
    writes[0].read();
    assert.deepEqual(acked, ['p', 'q']);
  });

  test('OP-05: flush writes everything held at once; drop acknowledges it and writes nothing', () => {
    const { pacer, writes, advance } = rig();
    const a = {};
    const b = {};
    pacer.deliver(a, 'first');
    advance(0);
    pacer.deliver(a, 'x');
    advance(1);
    pacer.deliver(a, 'y');
    pacer.flush(a);
    assert.deepEqual(writes.map((w) => w.data), ['first', 'xy'], 'flushed before its turn');
    advance(PACE_MS * 2);
    assert.equal(writes.length, 2, 'and its turn then finds nothing to write');
    const acked = [];
    pacer.deliver(b, 'gone', () => acked.push('gone'));
    pacer.drop(b);
    advance(PACE_MS * 2);
    assert.deepEqual(acked, ['gone'], 'what will never be written is acknowledged');
    assert.ok(!writes.some((w) => w.data === 'gone'), 'and never written');
    assert.equal(pacer.held(b), 0);
  });

  test('OP-06: pacing off (`ms` 0) writes every chunk as it comes, as before', () => {
    const { pacer, writes } = rig();
    pacer.configure({ ms: 0 });
    const a = {};
    pacer.deliver(a, '1');
    pacer.deliver(a, '2');
    assert.deepEqual(writes.map((w) => w.data), ['1', '2']);
  });

  test('OP-07: terminals are paced each on their own', () => {
    const { pacer, writes, advance } = rig();
    const a = {};
    const b = {};
    pacer.deliver(a, 'a1');
    advance(0);
    pacer.deliver(b, 'b1');
    advance(0);
    assert.deepEqual(writes.map((w) => w.data), ['a1', 'b1'], "a's turn does not hold b back");
  });
});

describe('Output pacing: wired into the registry', () => {
  const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('OP-10: a held write xterm refuses is acknowledged, not owed for ever, and the next turn still comes', () => {
    // Found in review: a paced write that threw (xterm refuses past 50 M
    // characters waiting) lost its chunks' acknowledgements — the backend
    // over-counted for the rest of the session — and its timer never
    // scheduled the next turn.
    let t = 0;
    const timers = [];
    let refuse = true;
    const written = [];
    const pacer = createOutputPacer({
      write: (target, data, read) => {
        if (refuse) throw new Error('write data discarded');
        written.push(data);
        read?.();
      },
      paced: () => true,
      now: () => t,
      setTimer: (fn, ms) => {
        const timer = { at: t + ms, fn };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
    });
    const run = () => {
      while (timers.length) {
        const timer = timers.shift();
        t = Math.max(t, timer.at);
        timer.fn();
      }
    };
    let acked = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      pacer.deliver('a', 'x'.repeat(10), () => (acked += 1));
      pacer.deliver('a', 'y'.repeat(10), () => (acked += 1));
      run();
    } finally {
      console.warn = warn;
    }
    assert.equal(acked, 2, 'both chunks acknowledged though lost');
    refuse = false;
    pacer.deliver('a', 'z', () => (acked += 1));
    run();
    assert.deepEqual(written, ['z'], 'the next output still goes');
    assert.equal(acked, 3);
  });

  test('OP-08: the terminal typed in and one whose cmd waits for its answer are never paced', () => {
    const start = src.indexOf('const pacer = createOutputPacer({');
    const end = src.indexOf('\n});\n', start) + 4;
    assert.ok(start > 0 && end > start);
    let state = { activeTabId: 'front', batchJobWaiting: (id) => id === 'cmd' };
    let hidden = false;
    const made = [];
    new Function('createOutputPacer', 'writeOutput', 'useTerminalStore', 'clock', 'pageHidden', src.slice(start, end))(
      (options) => made.push(options),
      () => {},
      { getState: () => state },
      () => 0,
      () => hidden
    );
    const { paced } = made[0];
    assert.equal(paced({ tabId: 'front' }), false, 'the one typed in');
    assert.equal(paced({ tabId: 'cmd' }), false, "cmd's question is judged as each chunk arrives");
    assert.equal(paced({ tabId: 'other' }), true);
    assert.equal(paced({ tabId: 'other', disposed: true }), false);
    hidden = true;
    assert.equal(paced({ tabId: 'other' }), false, 'a hidden page draws nothing: no pace to keep');
    hidden = false;
    state = { activeTabId: 'other' };
    assert.equal(paced({ tabId: 'other' }), false, 'focus moves, and so does the exemption');
  });

  test('OP-09: whatever reads the screen as the shell left it writes what is held first', () => {
    const exit = src.slice(src.indexOf("listen('pty-exit'"), src.indexOf("listen('pty-exit'") + 400);
    assert.match(exit, /flushPaced\(entry\);\s*entry\.term\.write\(exitNotice/, 'the exit notice');
    const notice = src.slice(src.indexOf('export function writeNotice('));
    assert.match(notice, /^[\s\S]*?flushPaced\(entry\);\s*entry\.term\.write\(`\\r\\n\\x1b\[33m\[NexTerm\]/, 'a NexTerm notice');
    const barrier = src.slice(src.indexOf('setTerminalOutputBarrier((tabId, fn) => {'));
    assert.match(barrier, /^[\s\S]*?flushPaced\(entry\);\s*entry\.term\.write\('', guarded\);/, 'the barrier the progress bar waits on');
    // A mark or a clear acts on the screen as it stands, so it waits for
    // xterm to have READ what was flushed, not just to have been handed it.
    assert.match(
      src,
      /function afterOutputSoFar\(entry, fn\) \{\s*if \(!entry \|\| entry\.disposed\) return false;\s*flushPaced\(entry\);\s*entry\.term\.write\('', \(\) => \{\s*if \(entry\.disposed\) return;[\s\S]*?try \{\s*fn\(entry\);/,
      'flushed, then after the parse'
    );
    const clear = src.slice(src.indexOf('export function clearTerminal(tabId) {'));
    assert.match(clear, /^[^}]*?return afterOutputSoFar\(instances\.get\(tabId\), \(entry\) => entry\.term\.clear\(\)\);/, 'a clear');
    assert.match(src, /flushPacedOutput\(tabId\);\s*dirs\.note\(cwd\);/, "the folder's mark after what was printed in the old one");
    const bind = src.slice(src.indexOf('function bindSession(entry, sessionId) {'));
    assert.match(bind, /^function bindSession\(entry, sessionId\) \{[\s\S]*?flushPaced\(entry\);\s*entry\.stopPtyListener\?\.\(\);/, 'another shell bound');
    assert.match(src, /focusSubscription = useTerminalStore\.subscribe\(\(state\) => \{[\s\S]*?flushPaced\(instances\.get\(focused\)\);/, 'focus arriving');
    assert.match(src, /pacer\.drop\(entry\);/, 'a terminal disposed: held output acknowledged');
    const view = readFileSync(new URL('../../src/components/terminal/TerminalView.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(
      view,
      /const command = lastSubmittedRef\.current;\s*afterTerminalOutput\(tabId, \(current\) => current\.commandMarks\.mark\(command\)\);/,
      "a command's mark, on the row its output starts on — the command as submitted then"
    );
  });
});
