/**
 * Performance mode (stage 4): the measuring has to be right before any
 * number it gives can be trusted, and it has to cost nothing when the app is
 * not being measured.
 *
 * What is checked here, without a browser or a backend:
 *   - the hooks on the output path are off unless installed, and told of
 *     every chunk once they are (ptyOutputBus.js; the registry's
 *     `writeOutput` is checked from its source, as batch_job_reply does)
 *   - the probe's arithmetic: events, characters, sampled write lag, frames
 *   - perfStats.js: percentiles, the line-number check that finds lost or
 *     reordered output, the generator's summary line, counters, CPU
 *   - tests/perf/flood.js writes what the check expects, and its full-screen
 *     frames stay inside the screen
 *   - tests/perf/cpu.js reads `ps` and the Windows process tree as they are
 *   - the command lines typed into cmd, PowerShell and POSIX shells
 *   - tests/perf/summarize.js's table
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { attachOutput, deliver, forgetOutput, setDeliverObserver } from '../../src/lib/ptyOutputBus.js';
import { createProbe, WRITE_SAMPLE_MS } from '../../src/lib/perf/perfProbe.js';
import {
  checkSequence,
  counterDelta,
  cpuOver,
  median,
  parseGeneratorSummary,
  percentile,
  summarizeFrames,
  summarizeTimes,
} from '../../src/lib/perf/perfStats.js';
import { joinPath, nodeCommand } from '../../src/lib/perf/perfCommands.js';
import { frameFor, lineFor, parseArgs as floodArgs } from '../perf/flood.js';
import { descendantsOf, groupUnix, groupWindows, parsePsLine, psDuration } from '../perf/cpu.js';
import { scenarioRows, toMarkdown } from '../perf/summarize.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** A clock the test moves by hand. */
function fakeClock(start = 1000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

describe('Performance mode: the hooks on the output path', () => {
  test('PF-01: without an observer, delivering is exactly what it was — into the terminal, or kept', () => {
    setDeliverObserver(null);
    const got = [];
    const detach = attachOutput('pm-01', (data) => got.push(data));
    deliver('pm-01', 'a');
    deliver('pm-01', 'b');
    detach();
    assert.deepEqual(got, ['a', 'b']);
    forgetOutput('pm-01');
  });

  test('PF-02: an observer is told of every chunk, after it went in — kept ones too — and cannot break delivery', () => {
    const told = [];
    let t = 0;
    setDeliverObserver({ clock: () => (t += 1), delivered: (id, data, startedAt) => told.push([id, data, startedAt]) });
    try {
      const got = [];
      const detach = attachOutput('pm-02', (data) => {
        got.push(data);
        assert.equal(told.length, got.length - 1, 'the terminal has the chunk before the observer hears of it');
      });
      deliver('pm-02', 'one');
      detach();
      deliver('pm-02', 'kept');
      assert.deepEqual(got, ['one']);
      assert.deepEqual(told.map(([id, data]) => [id, data]), [['pm-02', 'one'], ['pm-02', 'kept']]);
      assert.ok(told.every(([, , startedAt]) => typeof startedAt === 'number'));
    } finally {
      setDeliverObserver(null);
      forgetOutput('pm-02');
    }
  });

  test('PF-03: something that is not an observer is not installed', () => {
    setDeliverObserver({ delivered: () => {} });
    const got = [];
    const detach = attachOutput('pm-03', (data) => got.push(data));
    deliver('pm-03', 'x');
    detach();
    forgetOutput('pm-03');
    assert.deepEqual(got, ['x']);
    setDeliverObserver(null);
  });

  test('PF-04: the registry writes with no callback of its own unless the observer asks for one', () => {
    const src = read('../../src/components/terminal/terminalRegistry.js');
    const start = src.indexOf('function writeOutput(entry, data, read = null) {');
    const length = src.slice(start).search(/\n\}\n/);
    assert.ok(start > 0 && length > 0, 'terminalRegistry.js writes output through writeOutput');
    const make = (observer, store) =>
      new Function('useTerminalStore', 'writeObserver', `${src.slice(start, start + length)}\n}\nreturn writeOutput;`)(store, observer);
    const quiet = { getState: () => ({ batchJobOutputArrived: () => false }) };
    const calls = [];
    const term = { write: (...args) => calls.push(args) };
    make(null, quiet)({ tabId: 't', term }, 'plain');
    assert.deepEqual(calls[0], ['plain'], 'off: one argument, as before performance mode existed');
    let timedRead = 0;
    make(() => () => (timedRead += 1), quiet)({ tabId: 't', term }, 'timed');
    assert.equal(typeof calls[1][1], 'function', 'asked for: a callback for xterm');
    assert.equal(timedRead, 0, 'not called before xterm has read the chunk');
    calls[1][1]();
    assert.equal(timedRead, 1, 'and called once it has');
    // With cmd's batch-job question waiting, both run, the observer first.
    const order = [];
    const waiting = { getState: () => ({ batchJobOutputArrived: () => true, answerBatchJobPrompt: () => order.push('answer') }) };
    const both = [];
    make(() => () => order.push('observer'), waiting)({ tabId: 't', term: { write: (d, cb) => both.push(cb) }, disposed: false }, 'q');
    both[0]();
    assert.deepEqual(order, ['observer', 'answer']);
  });
});

describe('Performance mode: the probe', () => {
  test('PF-05: counts events and characters, and samples write lag once per terminal per window', () => {
    const now = fakeClock();
    let deliverHook = null;
    let writeHook = null;
    const probe = createProbe({
      setDeliverObserver: (o) => (deliverHook = o),
      setWriteObserver: (o) => (writeHook = o),
      raf: null,
      now,
    });
    probe.install();
    assert.ok(deliverHook && writeHook, 'installed on both hooks');
    const s = deliverHook.clock();
    now.advance(2);
    deliverHook.delivered('s1', 'abc', s);
    deliverHook.delivered('s1', 'de', deliverHook.clock());
    const first = writeHook('tab-a', 'abc');
    assert.equal(typeof first, 'function', 'the first write of a terminal is sampled');
    assert.equal(writeHook('tab-a', 'de'), null, 'the next one within the window is not');
    assert.equal(typeof writeHook('tab-b', 'x'), 'function', 'another terminal is sampled on its own');
    now.advance(30);
    first();
    now.advance(WRITE_SAMPLE_MS);
    assert.equal(typeof writeHook('tab-a', 'later'), 'function', 'and again once the window has passed');
    now.advance(1000 - 32 - WRITE_SAMPLE_MS);
    const snap = probe.snapshot();
    assert.equal(snap.events, 2);
    assert.equal(snap.chars, 5);
    assert.equal(snap.deliverMs, 2);
    assert.equal(snap.writes, 4);
    assert.equal(snap.writeLag.count, 1);
    assert.equal(snap.writeLag.max, 30);
    assert.equal(snap.eventsPerSecond, 2);
    probe.uninstall();
    assert.equal(deliverHook, null, 'uninstalled: the hooks are off again');
    assert.equal(writeHook, null);
  });

  test('PF-06: frames are timed between animation frames, only while asked, and reset clears the window', () => {
    const now = fakeClock();
    const queue = [];
    const probe = createProbe({ setDeliverObserver: () => {}, setWriteObserver: () => {}, raf: (cb) => queue.push(cb), now });
    probe.startFrames();
    for (const t of [0, 16, 33, 150]) queue.shift()(t);
    probe.stopFrames();
    queue.shift()?.(200);
    assert.equal(queue.length, 0, 'stopped: no further frame asked for');
    const frames = probe.snapshot().frames;
    assert.equal(frames.count, 3);
    assert.equal(frames.max, 117);
    assert.equal(frames.over100, 1);
    probe.reset();
    assert.equal(probe.snapshot().frames.count, 0);
  });
});

describe('Performance mode: the arithmetic', () => {
  test('PF-07: nearest-rank percentiles, medians, frame thresholds', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 95), 4);
    assert.deepEqual(summarizeTimes([3, 1, 2, NaN, 'x']), { count: 3, p50: 2, p95: 3, p99: 3, max: 3, mean: 2 });
    assert.equal(median([4, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([null, undefined]), null);
    const f = summarizeFrames([16, 51, 101, 17]);
    assert.equal(f.over50, 2);
    assert.equal(f.over100, 1);
  });

  test('PF-08: the line check finds a lost line and a reordered one, and ignores everything else', () => {
    const ok = checkSequence(['$ node flood.js', '#00000007 a', '#00000008 b', '#00000009 c', '[nexterm-perf] mode=bulk']);
    assert.deepEqual(ok, { checked: 3, first: 7, last: 9, gaps: 0, outOfOrder: 0 });
    assert.equal(checkSequence(['#00000001 a', '#00000003 c']).gaps, 1);
    assert.equal(checkSequence(['#00000002 b', '#00000002 b']).outOfOrder, 1);
    assert.equal(checkSequence(['#00000003 c', '#00000001 a']).outOfOrder, 1);
    assert.equal(checkSequence([]).checked, 0);
    // A number inside a line is not the line's own.
    assert.equal(checkSequence(['x #00000005 y']).checked, 0);
  });

  test('PF-09: the generator writes exactly what the check expects — every line numbered, one after the other', () => {
    const rows = [];
    for (let n = 0; n < 500; n += 1) rows.push(lineFor(n).replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, ''));
    assert.deepEqual(checkSequence(rows), { checked: 500, first: 0, last: 499, gaps: 0, outOfOrder: 0 });
    assert.ok(lineFor(3).endsWith('\n') && !lineFor(3).endsWith('\r\n'), 'a bare LF, as a program writes');
  });

  test("PF-10: the generator's full-screen frames: every row inside the screen, the whole frame one synchronized update", () => {
    const cols = 40;
    const frame = frameFor(7, cols, 10);
    assert.ok(frame.startsWith('\x1b[?2026h') && frame.endsWith('\x1b[?2026l'));
    const rows = frame.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1);
    assert.equal(rows.length, 10);
    for (const row of rows) {
      const text = row.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      // Counted in cells: the fragments hold wide characters.
      const cells = Array.from(text).reduce((n, ch) => n + (/[\u{1100}-\u{11ff}\u{ac00}-\u{d7af}\u{1f300}-\u{1faff}]/u.test(ch) ? 2 : 1), 0);
      assert.ok(Array.from(text).length <= cols - 1, `row within the width in characters: ${text}`);
      assert.ok(cells <= 2 * (cols - 1));
    }
    assert.deepEqual(floodArgs(['tui', '--fps', '30', '--seconds', 'x', '--mb', '5']), { mode: 'tui', options: { fps: 30, mb: 5 } });
  });

  test("PF-11: the generator's summary line is read back; anything else is not one", () => {
    const s = parseGeneratorSummary('noise\n[nexterm-perf] mode=flood lines=10 bytes=2097152 seconds=2.00 skipped=3\n$ ');
    assert.deepEqual(s, { mode: 'flood', lines: 10, bytes: 2097152, seconds: 2, skipped: 3, mbPerSecond: 1 });
    assert.equal(parseGeneratorSummary('[nexterm-perf] sampling 12 into x'), null);
    assert.equal(parseGeneratorSummary(null), null);
  });

  test('PF-12: counters are differences, never negative; the longest emit is the latest read', () => {
    const d = counterDelta(
      { reads: 10, read_bytes: 100, emits: 5, emit_bytes: 90, emit_nanos: 1e6, emit_max_nanos: 0 },
      { reads: 30, read_bytes: 2100, emits: 15, emit_bytes: 2090, emit_nanos: 4e6, emit_max_nanos: 2.5e6 }
    );
    assert.deepEqual(d, { reads: 20, readBytes: 2000, emits: 10, emitBytes: 2000, emitMs: 3, emitMaxMs: 2.5, bytesPerEmit: 200, holds: 0, heldMs: 0 });
    const held = counterDelta({ holds: 1, held_nanos: 0 }, { holds: 4, held_nanos: 2.5e8 });
    assert.equal(held.holds, 3);
    assert.equal(held.heldMs, 250);
    assert.equal(counterDelta(null, {}), null);
    assert.equal(counterDelta({ reads: 9 }, { reads: 3 }).reads, 0);
  });

  test('PF-13: CPU over a window is the cumulative difference across it, as a share of one core', () => {
    const samples = [
      { t: 0, app: { cpu: 10, rss: 1 }, webview: { cpu: 20, rss: 5 } },
      { t: 1000, app: { cpu: 10.5, rss: 3 }, webview: { cpu: 21, rss: 4 } },
      { t: 3000, app: { cpu: 11, rss: 2 }, webview: { cpu: 23, rss: 6 } },
      { t: 9000, app: { cpu: 99, rss: 9 }, webview: { cpu: 99, rss: 9 } },
    ];
    assert.deepEqual(cpuOver(samples, 500, 3500), { seconds: 2, appPercent: 25, webviewPercent: 100, appPeakRss: 3, webviewPeakRss: 6 });
    assert.equal(cpuOver(samples, 500, 900), null, 'fewer than two samples: no figure, not zero');
  });
});

describe('Performance mode: the CPU sampler', () => {
  test("PF-14: ps's durations and lines, as macOS and Linux print them", () => {
    assert.equal(psDuration('01:02.50'), 62.5);
    assert.equal(psDuration('1:00:00'), 3600);
    assert.equal(psDuration('2-00:00:01'), 172801);
    const row = parsePsLine('  412  1   03:10   0:12.34  20480 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent');
    assert.equal(row.pid, 412);
    assert.equal(row.cpu, 12.34);
    assert.equal(row.rss, 20480 * 1024);
    assert.ok(row.comm.endsWith('com.apple.WebKit.WebContent'));
    assert.equal(parsePsLine('7 1 00:05 0:00.10 100 /Applications/My App.app/Contents/MacOS/x').comm, '/Applications/My App.app/Contents/MacOS/x', 'a name with spaces is the whole rest');
    assert.equal(parsePsLine('garbage'), null);
  });

  test("PF-15: macOS counts the WebKit processes that came with the app, not Safari's from before it", () => {
    const rows = [
      { pid: 100, ppid: 1, age: 60, cpu: 5, rss: 1, comm: '/x/NexTerm.app/Contents/MacOS/nexterm' },
      { pid: 101, ppid: 1, age: 59, cpu: 7, rss: 2, comm: '/W/com.apple.WebKit.WebContent' },
      { pid: 102, ppid: 1, age: 61.5, cpu: 1, rss: 3, comm: '/W/com.apple.WebKit.GPU' },
      { pid: 50, ppid: 1, age: 3600, cpu: 900, rss: 4, comm: '/W/com.apple.WebKit.WebContent' },
      { pid: 103, ppid: 100, age: 50, cpu: 3, rss: 5, comm: '/bin/zsh' },
    ];
    const g = groupUnix(rows, 100, 'darwin');
    assert.deepEqual(g.webview.map((r) => r.pid), [101, 102]);
    assert.equal(groupUnix(rows, 999, 'darwin'), null, 'the app gone: no sample');
    const linux = groupUnix([{ ...rows[0] }, { pid: 201, ppid: 100, age: 1, cpu: 1, rss: 1, comm: 'WebKitWebProcess' }, { pid: 202, ppid: 201, age: 1, cpu: 1, rss: 1, comm: 'WebKitNetworkProcess' }, rows[4]], 100, 'linux');
    assert.deepEqual(linux.webview.map((r) => r.pid), [201, 202]);
  });

  test("PF-16: Windows counts every msedgewebview2 under the app, at any depth, and not the shells", () => {
    const tree = new Map([
      [10, { ppid: 1, name: 'NexTerm.exe' }],
      [11, { ppid: 10, name: 'msedgewebview2.exe' }],
      [12, { ppid: 11, name: 'msedgewebview2.exe' }],
      [13, { ppid: 10, name: 'cmd.exe' }],
      [14, { ppid: 13, name: 'node.exe' }],
      [20, { ppid: 1, name: 'msedgewebview2.exe' }],
    ]);
    assert.deepEqual([...descendantsOf(10, new Map([...tree].map(([p, r]) => [p, r.ppid])))].sort(), [11, 12, 13, 14]);
    const rows = [10, 11, 12, 13, 14, 20].map((pid) => ({ pid, cpu: pid, rss: 1 }));
    const g = groupWindows(rows, tree, 10);
    assert.deepEqual(g.app.pids, [10]);
    assert.deepEqual(g.webview.pids, [11, 12]);
    assert.equal(g.webview.cpu, 23);
    assert.deepEqual(g.webview.each.map((p) => p.name), ['msedgewebview2.exe', 'msedgewebview2.exe'], 'each process by name, to tell which grows');
  });
});

describe('Performance mode: what is typed, and the table', () => {
  test('PF-17: the scripts are run by a path each shell reads as one word', () => {
    assert.equal(joinPath('/Users/me/repo/tests/', 'flood.js', 'macos'), '/Users/me/repo/tests/flood.js');
    assert.equal(joinPath('C:\\Users\\me\\repo\\tests', 'flood.js', 'windows'), 'C:\\Users\\me\\repo\\tests\\flood.js');
    assert.equal(nodeCommand('/repo/tests/perf/flood.js', 'flood --seconds 10', 'posix'), 'node /repo/tests/perf/flood.js flood --seconds 10');
    assert.equal(nodeCommand('/my repo/flood.js', 'bulk', 'posix'), "node '/my repo/flood.js' bulk");
    const cmd = nodeCommand('C:\\Users\\Kim Lee\\repo\\flood.js', 'bulk', 'cmd');
    assert.equal(cmd, 'node "C:\\Users\\Kim Lee\\repo\\flood.js" bulk');
    const ps = nodeCommand('C:\\Users\\Kim Lee\\repo\\flood.js', 'bulk', 'powershell');
    assert.ok(ps.startsWith('node ') && ps.includes('Kim Lee') && /^node ['"]/.test(ps), ps);
    assert.equal(nodeCommand('C:\\a"b\\flood.js', 'bulk', 'cmd'), null, 'a quote cmd cannot carry: nothing typed');
    assert.equal(nodeCommand('/x/\x07/flood.js', '', 'posix'), null);
  });

  test('PF-18: the table is the median of each scenario, failures listed, CPU from the samples', () => {
    const run = (scenario, n, extra = {}) => ({
      scenario,
      title: `${scenario} title`,
      startedAtEpoch: n * 10_000,
      endedAtEpoch: n * 10_000 + 4000,
      durationMs: 4000 + n,
      page: { eventsPerSecond: 100 * n, charsPerEvent: 1000, frames: { p50: 16, p95: 20 + n, max: 40, over50: 0, over100: 0 }, writeLag: { p95: 5, max: 9 } },
      backend: { reads: 2 * n, emits: n },
      terminals: [{ drainMs: 1000 * n, generator: { mbPerSecond: 10 }, sequence: { gaps: 0, outOfOrder: 0 } }],
      ...extra,
    });
    const report = {
      startedAt: 'now',
      environment: { appVersion: '0.21.0', os: 'macos', repeat: 3 },
      runs: [run('S2', 1), run('S2', 2), run('S2', 3, { terminals: [{ drainMs: 1, sequence: { gaps: 1, outOfOrder: 2 } }] }), { scenario: 'S4', title: 'S4 title', error: 'the typing terminal never showed its prompt' }],
    };
    const samples = [];
    for (let t = 0; t <= 40_000; t += 1000) samples.push({ t, app: { cpu: t / 2000, rss: 1048576 }, webview: { cpu: t / 1000, rss: 1048576 } });
    const rows = scenarioRows(report, samples);
    const s2 = rows.find((r) => r.scenario === 'S2');
    assert.equal(s2.runs, '3/3');
    assert.equal(s2.eventsPerSecond, 200);
    assert.equal(s2.frameP95, 22);
    assert.equal(s2.readsPerEmit, 2);
    assert.equal(s2.appCpu, 50);
    assert.equal(s2.webviewCpu, 100);
    assert.equal(s2.lostLines, 3, 'lost and reordered lines are summed, never medianed away');
    const s4 = rows.find((r) => r.scenario === 'S4');
    assert.equal(s4.runs, '0/1');
    const withEach = [{ t: 0, app: { each: [{ pid: 1, name: 'nexterm', rss: 50 * 1048576 }] }, webview: { each: [{ pid: 2, name: 'com.apple.WebKit.WebContent', rss: 900 * 1048576 }, { pid: 3, name: 'com.apple.WebKit.GPU', rss: 300 * 1048576 }] } }];
    const md = toMarkdown(report, rows, withEach);
    assert.match(md, /Most memory held, by process: webview: com\.apple\.WebKit\.WebContent 900 MB · webview: com\.apple\.WebKit\.GPU 300 MB · app: nexterm 50 MB/);
    assert.match(md, /\| \*\*S2\*\* S2 title \| 3\/3 \|/);
    assert.match(md, /S4: the typing terminal never showed its prompt/);
  });
});
