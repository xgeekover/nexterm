/**
 * The output path against REAL xterm 6 in headless Chromium (stage 4): what
 * the fake-clock suites (output_pacing.test.js, flow_control.test.js) cannot
 * show — that the app's own terminals, behind its own output bus, with the
 * pacing of terminals without focus and the backlog of one not made yet,
 * end up showing exactly what was printed.
 *
 * tests/adversarial/fixtures/output_path_harness.html does the work in the
 * page (megabytes never cross CDP): about 2.4 MB of numbered lines — Korean,
 * emoji (a ZWJ sequence, a flag), colour escapes cut anywhere — into four
 * terminals, focus moved twice mid-stream, one terminal made a quarter of the
 * way through, one closed with output held. Then every buffer row against
 * every printed line, and every byte acknowledged to flow control once.
 *
 * Needs agent-browser; skipped without it (and on Node 20, which has no
 * WebSocket for the CDP session), like the other *_headless suites.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NO_BROWSER = 'agent-browser is not installed — the real-browser output path check runs locally only';

let harness = null;
let report = null;
let review = null;

describe('The output path: real xterm 6 under headless Chromium', () => {
  test('OH-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    try {
      harness = await openHarness('tests/adversarial/fixtures/output_path_harness.html', {
        prefix: 'output-path-headless',
        readyExpression: 'window.__op ? window.__op.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    report = await harness.evalJs('window.__op.run()');
    assert.deepEqual(harness.pageErrors(), [], 'the page threw');
  });

  test('OH-02: every terminal shows every printed line, once, in order — the paced ones and the one made late too', () => {
    if (!HEADLESS_AVAILABLE || !report) skip(NO_BROWSER);
    for (const name of ['front', 'back', 'late']) {
      assert.equal(report[name].delivered, report[name].chunks, `${name}: every chunk was delivered`);
      assert.equal(report[name].difference, null, `${name}: the buffer differs from what was printed — ${JSON.stringify(report[name].difference)}`);
    }
  });

  test('OH-03: every byte is acknowledged to flow control exactly once — written, kept for a terminal not made yet, or held when its terminal closed', () => {
    if (!HEADLESS_AVAILABLE || !report) skip(NO_BROWSER);
    assert.equal(report.checks.settled, true, 'the acknowledgements caught up');
    for (const name of ['front', 'back', 'late', 'gone']) {
      assert.equal(report[name].acked, report[name].sent, `${name}: ${report[name].acked} B acknowledged of ${report[name].sent} B sent`);
    }
    assert.equal(report.checks.goneWrittenBeforeClose, 0, 'the closed terminal had its output held (it was behind)');
    assert.equal(report.gone.writes, 0, 'and none of it was written after it closed');
  });

  test('OH-04: the terminal in front is written as each chunk arrives; one behind has its chunks joined; focus arriving writes what was held at once', () => {
    if (!HEADLESS_AVAILABLE || !report) skip(NO_BROWSER);
    assert.equal(report.checks.frontFirstTwoWritten, 2, 'two chunks for the front terminal, two writes, at once');
    assert.ok(report.back.deliveredBehind > 10, `back had chunks while behind (${report.back.deliveredBehind})`);
    assert.ok(
      report.back.writesBehind < report.back.deliveredBehind,
      `back, while behind: ${report.back.writesBehind} writes for ${report.back.deliveredBehind} chunks — not joined`
    );
    assert.ok(report.checks.focus.back >= 1, 'back brought to the front: what was held for it is written in the same step');
    assert.ok(report.checks.focus.late >= 1, 'late brought to the front: the same');
  });

  // Review round 1: flushing held output only hands it to xterm, which
  // parses it later — whatever acts on the screen as it stands has to wait
  // for the parse, not just the flush.
  test('OH-05: a command mark made with output held goes on the row its output starts on', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    review = await harness.evalJs('window.__op.review()');
    assert.notEqual(review.mark.expected, -1, 'the output was written');
    assert.equal(review.mark.row, review.mark.expected, `the mark is on row ${review.mark.row}, its output starts on row ${review.mark.expected}`);
    assert.equal(review.mark.command, 'ls');
  });

  test('OH-06: Clear Terminal clears the output that arrived before it, held or not', () => {
    if (!HEADLESS_AVAILABLE || !review) skip(NO_BROWSER);
    assert.equal(review.clearReturned, true);
    assert.equal(review.clear.stillShown, false, 'output that arrived before the clear is still on screen after it');
  });

  test('OH-06b: something that throws once the output is read does not stop the terminal parsing', () => {
    if (!HEADLESS_AVAILABLE || !review) skip(NO_BROWSER);
    assert.equal(review.afterThrow.shown, true, 'a mark that throws: output after it was never parsed — the terminal is wedged');
    assert.equal(review.afterThrow.afterBarrier, true, 'the output barrier throwing: the terminal is wedged');
    assert.equal(review.afterThrow.afterAnswer, true, "cmd's answer throwing: the terminal is wedged");
  });

  test('OH-07: a hidden page does not hold the program behind xterm — up to a limit — and is not paced', () => {
    if (!HEADLESS_AVAILABLE || !review) skip(NO_BROWSER);
    const h = review.hidden;
    assert.equal(h.writtenAtOnce, 1, 'hidden: written as it came, not held for a pace nobody sees');
    assert.equal(h.ackedWhileParked, h.firstBytes, 'hidden: acknowledged as taken while nothing waited in xterm — and only that, past the limit');
    assert.equal(h.pacedWhenVisible, true, 'visible again: paced as before');
    assert.equal(h.parkedBeforeRelease, 3);
    assert.equal(h.ackedInTheEnd, h.sent, 'every byte acknowledged once in the end');
    assert.equal(h.ackedAgain, 100, 'hidden again with xterm caught up: acknowledged as taken again');
  });

  test('OH-08: teardown — close the browser session and stop the scratch server', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    harness?.teardown();
  });
});
