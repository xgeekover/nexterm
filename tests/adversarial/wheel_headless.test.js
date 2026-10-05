/**
 * The wheel against REAL xterm 6, with REAL wheel events: what Node and its
 * stand-ins cannot show. terminal_compat.test.js checks the arithmetic
 * (`wheelScrollRows`, `wheelArrowCount`) and the rules on a hand-written
 * terminal; this drives tests/adversarial/fixtures/wheel_harness.html —
 * a terminal made by the app's own `getOrCreateTerminal`, one with the two
 * wheel rules alone, and a stock xterm 6 as the control — in headless
 * Chromium, wheels sent as raw CDP `Input.dispatchMouseEvent` (a line- or
 * page-mode event, which CDP cannot make, as a synthetic `WheelEvent`).
 *
 * Every count is checked against xterm 5.5's own arithmetic
 * (`xterm55Wheel.js`, itself checked against real 5.5 in this browser), at
 * whatever row height the font gives — 16 px in headless Chromium, where the
 * numbers measured for the review apply literally:
 *
 *   - WH-02..WH-04 (scrollback): a 100 px notch moves 6, 6, 7 rows where stock
 *     xterm 6 moves 3; ⌥, Shift, line and page events, a trackpad's 4 px
 *     events, WKWebView's 40 px notches; the scrollbar on the row shown.
 *   - WH-05 (no scrollback): the scrollback rule keeps out of the way — the
 *     pager rule turns the wheel into arrows.
 *   - WH-06 (mouse reporting): with tracking on the wheel is still REPORTED —
 *     neither wheel rule swallows it — and the tracking Claude Code asks for
 *     on the normal screen, which the app holds back, leaves the wheel to
 *     scroll as 5.5 did.
 *   - WH-07 / WH-08 (pager, X10): 6, 6, 6, 7 arrows for 100 px notches, 5 for
 *     twenty 4 px events, 31 for an ⌥ notch — under X10 too, which reports
 *     presses only — where stock xterm 6 sends one per event.
 *
 * Needs agent-browser; skipped without it, like mouse_reporting_headless.
 * WH-01 and WH-09 are setup and teardown, as cases (no suite-level hooks in
 * this harness); teardown also runs from `process.on('exit')`.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';
import { scrollbackRows55, pagerArrows55 } from './xterm55Wheel.js';

const NO_BROWSER = 'agent-browser is not installed — the real-browser wheel check runs locally only';

/** Set by WH-01 once the page is up; every later case skips without it. */
let harness = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__w.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

/** A notch-sized pixel event (CDP can only make those), or a line / page one. */
const px = (deltaY, over = {}) => ({ deltaY, deltaMode: 0, altKey: false, shiftKey: false, ...over });
const lines = (deltaY) => px(deltaY, { deltaMode: 1 });
const pages = (deltaY) => px(deltaY, { deltaMode: 2 });

/**
 * One wheel over the middle of `which`'s screen: a real CDP wheel for a pixel
 * event, a synthetic one for a line or page event. Settled before returning:
 * xterm acts on a wheel synchronously, but CDP's acknowledgement is no
 * promise that the page has seen the event yet.
 */
async function wheel(which, event) {
  if (event.deltaMode !== 0) {
    await call('syntheticWheel', which, { deltaY: event.deltaY, deltaMode: event.deltaMode, altKey: event.altKey, shiftKey: event.shiftKey });
  } else {
    const r = await call('rect', which);
    await harness.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      deltaX: 0,
      deltaY: event.deltaY,
      modifiers: (event.altKey ? 1 : 0) | (event.shiftKey ? 8 : 0),
    });
  }
  await sleep(40);
}

/** The rows each event moved `which`'s view by. */
async function rowsMoved(which, events) {
  const moved = [];
  for (const event of events) {
    const before = await call('viewportY', which);
    await wheel(which, event);
    moved.push((await call('viewportY', which)) - before);
  }
  return moved;
}

/** The arrow keys each event sent `which`'s program — negative for ↑ — and nothing else. */
async function arrowsSent(which, events) {
  const sent = [];
  for (const event of events) {
    await call('clearData', which);
    await wheel(which, event);
    const data = await call('data', which);
    const down = data.split('\x1b[B').length - 1;
    const up = data.split('\x1b[A').length - 1;
    assert.equal(data, (down ? '\x1b[B'.repeat(down) : '') + (up ? '\x1b[A'.repeat(up) : ''), 'arrow keys only');
    sent.push(down - up);
  }
  return sent;
}

/** 5.5's scrollback count for `events` on `which`, from the row it shows now. */
async function expectedScroll(which, events) {
  return scrollbackRows55(events, {
    cellHeight: await call('cellHeight', which),
    rows: await call('rows', which),
    startRow: await call('viewportY', which),
    maxRow: await call('baseY', which),
  });
}

const sum = (list) => list.reduce((a, b) => a + b, 0);
const SGR_WHEEL = /^(?:\x1b\[<6[45];\d+;\d+M)+$/;

describe('The wheel: real xterm 6 under headless Chromium (CDP)', () => {
  test('WH-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    try {
      harness = await openHarness('tests/adversarial/fixtures/wheel_harness.html', {
        prefix: 'wheel-headless',
        readyExpression: 'window.__w ? window.__w.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    assert.equal(await call('cellHeight', 'app'), await call('cellHeight', 'stock'), 'the app and the control draw the same rows');
  });

  test('WH-02: a mouse notch over the scrollback scrolls it as far as xterm 5.5 did — 6, 6, 7, 6 at 16 px; stock xterm 6, 3', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const notches = [px(-100), px(-100), px(-100), px(-100), px(100), px(100), px(100), px(100)];
    for (const which of ['app', 'bare', 'stock']) await call('reset', which);
    const expected = await expectedScroll('app', notches);
    if ((await call('cellHeight', 'app')) === 16) {
      assert.deepEqual(expected, [-6, -6, -7, -6, 6, 7, 6, 6], '5.5 at the row height the review measured it at');
    }
    assert.deepEqual(await rowsMoved('app', notches), expected, "the app's own terminal");
    assert.deepEqual(await rowsMoved('bare', notches), await expectedScroll('bare', notches), 'the wheel rules alone');
    // The control: xterm 6's own wheel, a fixed 50 px a notch.
    const stock = await rowsMoved('stock', notches);
    assert.ok(
      Math.abs(sum(stock.slice(0, 4))) < Math.abs(sum(expected.slice(0, 4))),
      `stock xterm 6 scrolls less (${stock}) — or this case proves nothing`
    );
  });

  test('WH-03: the scrollbar follows — on the very row shown, where xterm 6 draws it for that row', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    await call('reset', 'app');
    await call('reset', 'stock');
    const atBottom = await call('sliderTop', 'app');
    await rowsMoved('app', [px(-100), px(-100), px(-100)]);
    const row = await call('viewportY', 'app');
    assert.equal(await call('scrollTopRows', 'app'), row, 'the scrollable element is exactly on the row the view shows');
    assert.ok((await call('sliderTop', 'app')) < atBottom, 'the slider moved up with it');
    await call('alignStock', row);
    assert.equal(await call('viewportY', 'stock'), row);
    assert.equal(await call('sliderTop', 'app'), await call('sliderTop', 'stock'), "where xterm 6 itself puts the slider for that row");
  });

  test('WH-04: ⌥ five times as far, Shift not at all, a line or page event its lines or screen, a trackpad and a WKWebView notch — 5.5\'s counts', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const events = [
      px(-100, { altKey: true }),
      px(-100, { shiftKey: true }),
      lines(-3),
      lines(3),
      pages(-1),
      pages(1),
      ...Array(20).fill(px(-4)),
      ...Array(10).fill(px(-40)),
    ];
    for (const which of ['app', 'bare']) {
      await call('reset', which);
      await call('scrollToLine', which, 200);
      const expected = await expectedScroll(which, events);
      const got = await rowsMoved(which, events);
      assert.deepEqual(got.slice(0, 6), expected.slice(0, 6), `${which}: ⌥, Shift, line and page events`);
      assert.equal(sum(got.slice(6, 26)), sum(expected.slice(6, 26)), `${which}: twenty 4 px trackpad events`);
      assert.deepEqual(got.slice(26), expected.slice(26), `${which}: 40 px notches, as WKWebView sends them`);
      if ((await call('cellHeight', which)) === 16) {
        assert.deepEqual(got.slice(0, 2), [-31, 0], '⌥ 31 rows; Shift none');
        assert.equal(sum(got.slice(6, 26)), -5);
      }
    }
  });

  test('WH-05: a screen with no scrollback is left to the pager rule — arrows, not a scroll, and nothing swallowed', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const notches = [px(100), px(100), px(100), px(100)];
    await call('reset', 'flat');
    const cellHeight = await call('cellHeight', 'flat');
    const rows = await call('rows', 'flat');
    assert.deepEqual(await arrowsSent('flat', notches), pagerArrows55(notches, { cellHeight, rows }), 'scrollback 0');
    assert.equal(await call('viewportY', 'flat'), 0);
    await call('reset', 'app');
    await call('write', 'app', '\x1b[?1049h\x1b[H');
    assert.equal(await call('bufferType', 'app'), 'alternate');
    assert.deepEqual(await arrowsSent('app', notches), pagerArrows55(notches, { cellHeight, rows }), 'the alternate screen');
  });

  test('WH-06: with mouse tracking on the wheel is still REPORTED — and tracking the app holds back leaves it scrolling', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    // A full-screen program asking for SGR reports: the app lets it have them.
    await call('reset', 'app');
    await call('write', 'app', '\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    assert.equal(await call('mode', 'app'), 'vt200');
    await call('clearData', 'app');
    await wheel('app', px(100));
    await wheel('app', px(-100));
    assert.match(await call('data', 'app'), SGR_WHEEL, 'a wheel report each, no arrows');
    assert.match(await call('data', 'app'), /^\x1b\[<65;\d+;\d+M\x1b\[<64;\d+;\d+M$/, 'down, then up');

    // Tracking that does apply on the normal screen (no gate): reported, and the scrollback stays put.
    await call('reset', 'bare');
    await call('write', 'bare', '\x1b[?1000h\x1b[?1006h');
    const row = await call('viewportY', 'bare');
    await call('clearData', 'bare');
    await wheel('bare', px(-100));
    assert.match(await call('data', 'bare'), SGR_WHEEL, 'the program hears the wheel');
    assert.equal(await call('viewportY', 'bare'), row, 'and the scrollback does not move as well');

    // What Claude Code sends at its prompt, on the NORMAL screen: the app
    // holds it back (mouseReporting.js), so the wheel scrolls — 5.5's way.
    await call('reset', 'app');
    await call('write', 'app', '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    assert.equal(await call('mode', 'app'), 'none', 'held back on the normal screen');
    await call('clearData', 'app');
    const notches = [px(-100), px(-100), px(-100)];
    const expected = await expectedScroll('app', notches);
    assert.deepEqual(await rowsMoved('app', notches), expected);
    assert.equal(await call('data', 'app'), '', 'nothing reported, nothing typed');
  });

  test("WH-07: over a pager each notch is 5.5's arrows — 6, 6, 6, 7 at 16 px, 5 for twenty 4 px events, 31 for ⌥ — where stock xterm 6 sends one", async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const events = [px(100), px(100), px(100), px(100), ...Array(20).fill(px(4)), px(100, { altKey: true })];
    for (const which of ['app', 'stock']) {
      await call('reset', which);
      await call('write', which, '\x1b[?1049h\x1b[H');
    }
    const cellHeight = await call('cellHeight', 'app');
    const expected = pagerArrows55(events, { cellHeight, rows: await call('rows', 'app') });
    if (cellHeight === 16) {
      assert.deepEqual([...expected.slice(0, 4), sum(expected.slice(4, 24)), expected[24]], [6, 6, 6, 7, 5, 31], 'the numbers measured for the review');
    }
    const got = await arrowsSent('app', events);
    assert.deepEqual(got.slice(0, 4), expected.slice(0, 4), 'mouse notches');
    assert.equal(sum(got.slice(4, 24)), sum(expected.slice(4, 24)), 'a trackpad');
    assert.equal(got[24], expected[24], '⌥');
    // The control: xterm 6 alone, one arrow per notch.
    assert.deepEqual(await arrowsSent('stock', events.slice(0, 4)), [1, 1, 1, 1]);
  });

  test('WH-08: under X10, which reports presses only, the wheel is still 5.5\'s — arrows over a pager, rows over scrollback', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const notches = [px(100), px(100), px(100), px(100)];
    await call('reset', 'app');
    await call('write', 'app', '\x1b[?1049h\x1b[?9h');
    assert.equal(await call('mode', 'app'), 'x10', 'a full-screen program has its X10');
    const cellHeight = await call('cellHeight', 'app');
    const rows = await call('rows', 'app');
    assert.deepEqual(await arrowsSent('app', notches), pagerArrows55(notches, { cellHeight, rows }), 'not one arrow per notch');

    await call('reset', 'bare');
    await call('write', 'bare', '\x1b[?9h');
    assert.equal(await call('mode', 'bare'), 'x10');
    const up = [px(-100), px(-100), px(-100)];
    const expected = await expectedScroll('bare', up);
    assert.deepEqual(await rowsMoved('bare', up), expected, 'not 50 px a notch');
  });

  test('WH-09: teardown — close the browser session and stop the scratch server', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    harness?.teardown();
  });
});
