/**
 * Prompt marks on the scrollbar in a real browser: xterm 6's own overview
 * ruler and scrollbar, made by the app's `getOrCreateTerminal`, under headless
 * Chromium (tests/adversarial/fixtures/prompt_marks_harness.html), driven over
 * raw CDP input (headless_browser.js).
 *
 * What Node cannot see: the ruler canvas and the scrollbar are 10 CSS px wide;
 * a mark paints the accent at its line's height; a press on the track there
 * jumps to the prompt, one away from the marks keeps xterm's jump, so does one
 * at a mark the setting hid, and the slider still drags; a find paints
 * nothing on the ruler; a selection can
 * start at column 0 of a marked row; the ruler is hidden on the alternate
 * screen; and a terminal in no pane is still marked by the registry's own
 * listener. The click relies on xterm's internal scrollbar DOM (VS Code's
 * class names), which these cases pin.
 *
 * Needs agent-browser (and the Chromium it drives) and a global WebSocket:
 * skipped without either, saying which. When both are there and the browser
 * still does not start, that is a skip with the reason; a page that starts and
 * then misbehaves is a failure.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NOT_INSTALLED = 'agent-browser is not installed — the real-browser prompt-mark check runs locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_BROWSER = 'the browser could not start';
const NO_HARNESS = 'the harness did not start: see PMB-01';

let harness = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__p.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

function needHarness() {
  if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
  if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
  if (!harness) skip(NO_HARNESS);
}

const ACCENT = [139, 92, 246];
const isAccent = (rgba) => rgba[3] > 200 && rgba.slice(0, 3).every((c, i) => Math.abs(c - ACCENT[i]) <= 3);
const PROMPT = 'C:\\work>';

/** Where xterm draws line `line`'s mark, in device pixels from the ruler's top, and in viewport CSS pixels. */
function markY(info, line) {
  const device = ((info.ruler.pixelHeight - 1) * line) / info.length;
  return { device, client: info.ruler.top + device / info.dpr };
}

/** The line VS Code's track jump scrolls to for a press at viewport CSS `y`: it centres the slider on the press. */
function xtermJump(info, y) {
  const offset = y - info.track.top - info.slider.height / 2;
  return Math.round((offset / (info.track.height - info.slider.height)) * (info.length - info.rows));
}

async function mouse(type, x, y, buttons = 0) {
  const params = { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 };
  await harness.send('Input.dispatchMouseEvent', params);
}

/** Over the terminal first, so its scrollbar shows (it takes no events while faded), then a press and release. */
async function clickTrack(info, y) {
  const x = info.track.left + info.track.width / 2;
  await mouse('mouseMoved', info.screen.left + 50, info.screen.top + 50);
  await sleep(150);
  await mouse('mouseMoved', x, y);
  await sleep(60);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y, 0);
  await sleep(150);
}

/** A first prompt, then five commands of 40 lines, each ending in a prompt. */
async function fill() {
  await call('reset');
  await call('prompt', `\x1b]7;file:///C:/work\x1b\\${PROMPT}`);
  for (let i = 1; i <= 5; i += 1) {
    let out = `dir ${i}\r\n`;
    for (let j = 0; j < 40; j += 1) out += `output ${i}.${j}\r\n`;
    await call('prompt', `${out}${PROMPT}`);
  }
  return call('info');
}

describe('Prompt marks: xterm 6\'s ruler under headless Chromium (CDP)', () => {
  test('PMB-01: the harness page comes up', async () => {
    if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
    if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
    try {
      harness = await openHarness('tests/adversarial/fixtures/prompt_marks_harness.html', {
        prefix: 'prompt-marks-headless',
        session: `prompt-marks-headless-${process.pid}`,
        readyExpression: 'window.__p ? window.__p.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    const size = await call('reset');
    assert.ok(size.cols > 20 && size.rows > 10, `fitted to the pane: ${JSON.stringify(size)}`);
  });

  test('PMB-02: the ruler canvas and the scrollbar are both 10 CSS px wide; the slider is --vsc-scrollbar', async () => {
    needHarness();
    const info = await fill();
    assert.ok(info.ruler, 'xterm drew no overview ruler');
    assert.equal(info.ruler.cssWidth, '10px');
    assert.equal(Math.round(info.ruler.width), 10);
    assert.ok(info.track, 'no vertical scrollbar where VS Code\'s DOM puts it');
    assert.equal(Math.round(info.track.width), 10, `scrollbar ${info.track.width}px wide`);
    assert.ok(info.slider, 'no slider');
    assert.match(info.slider.background, /155, 163, 175/, `slider ${info.slider.background}`);
    assert.equal(info.marks.length, 6, `one mark a prompt, the first included: ${JSON.stringify(info.marks)}`);
    for (const line of info.marks) {
      const text = await call('lineText', line);
      assert.ok(text.startsWith(PROMPT), `mark at ${line} reads ${JSON.stringify(text)}`);
    }
  });

  test('PMB-03: each mark paints the accent at its line\'s height', async () => {
    needHarness();
    const info = await call('info');
    const rows = await call('rulerRows');
    const half = Math.round(2 * info.dpr) / 2 + 1;
    for (const line of info.marks) {
      const { device } = markY(info, line);
      const near = rows.filter((r) => Math.abs(r.y - device) <= half + 1);
      assert.ok(near.some((r) => isAccent(r.rgba)), `no accent at line ${line} (y ${device.toFixed(1)}): ${JSON.stringify(near)}`);
    }
    assert.ok(rows.every((r) => isAccent(r.rgba)), 'only the marks are drawn on the ruler');
  });

  test('PMB-04: a press on the track at a mark scrolls that prompt to the top', async () => {
    needHarness();
    const info = await call('info');
    const target = info.marks[1];
    await clickTrack(info, markY(info, target).client);
    const after = await call('info');
    assert.equal(after.viewportY, target, `viewport at ${after.viewportY}, wanted the prompt at ${target}`);
  });

  test('PMB-05: a press away from the marks keeps xterm\'s own jump', async () => {
    needHarness();
    const info = await call('info');
    const line = Math.round((info.marks[2] + info.marks[3]) / 2);
    const y = markY(info, line).client;
    assert.ok(y < info.slider.top || y > info.slider.top + info.slider.height, 'the press is on the track, not the slider');
    await clickTrack(info, y);
    const after = await call('info');
    const expected = xtermJump(info, y);
    assert.ok(Math.abs(after.viewportY - expected) <= 2, `viewport at ${after.viewportY}, xterm's jump would be ${expected}`);
    const nearest = info.marks.reduce((a, b) => (Math.abs(b - line) < Math.abs(a - line) ? b : a));
    assert.ok(after.viewportY !== nearest || nearest === expected, `jumped to the nearest mark, at ${nearest}, instead of ${expected}`);
  });

  test('PMB-06: a drag on the slider still scrolls, even over a mark', async () => {
    needHarness();
    await call('scrollToLine', 0);
    const info = await call('info');
    const x = info.track.left + info.track.width / 2;
    const y = info.slider.top + 2;
    await mouse('mouseMoved', info.screen.left + 50, info.screen.top + 50);
    await sleep(150);
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1);
    for (let step = 1; step <= 8; step += 1) await mouse('mouseMoved', x, y + step * 10, 1);
    await mouse('mouseReleased', x, y + 80, 0);
    await sleep(150);
    const after = await call('info');
    assert.ok(after.viewportY > 20, `the drag moved the view to ${after.viewportY}`);
  });

  test('PMB-07: a find with matches puts nothing on the ruler', async () => {
    needHarness();
    const before = await call('rulerRows');
    assert.equal(await call('find', 'output'), true, 'the find had matches');
    const during = await call('rulerRows');
    assert.deepEqual(during, before, 'the find painted on the ruler');
    await call('clearFind');
  });

  test('PMB-08: a selection drag from column 0 of a marked row selects text', async () => {
    needHarness();
    const { marks } = await call('info');
    await call('scrollToLine', marks[2]);
    const info = await call('info');
    assert.equal(info.viewportY, marks[2]);
    assert.ok(info.decorationPointerEvents.length > 0, 'the mark has a decoration element on screen');
    assert.ok(info.decorationPointerEvents.every((p) => p === 'none'), `decoration elements take events: ${info.decorationPointerEvents}`);
    const y = info.screen.top + info.cell.height / 2;
    const x0 = info.screen.left + info.cell.width * 0.25;
    const x1 = info.screen.left + info.cell.width * 6.5;
    await mouse('mouseMoved', x0, y);
    await mouse('mousePressed', x0, y, 1);
    for (let step = 1; step <= 4; step += 1) await mouse('mouseMoved', x0 + ((x1 - x0) * step) / 4, y, 1);
    await mouse('mouseReleased', x1, y, 0);
    await sleep(150);
    const selected = await call('selection');
    assert.ok(selected.startsWith('C:\\wor'), `selected ${JSON.stringify(selected)}`);
  });

  test('PMB-09: the ruler is hidden on the alternate screen, and the jump does nothing there', async () => {
    needHarness();
    await call('write', '\x1b[?1049h\x1b[Hvim');
    let info = await call('info');
    assert.equal(info.type, 'alternate');
    assert.equal(info.ruler.display, 'none');
    assert.equal((await call('jump', 'previous')).moved, false);
    await call('write', '\x1b[?1049l');
    info = await call('info');
    assert.equal(info.ruler.display, 'block');
    assert.equal(info.marks.length, 6, 'the marks are intact after leaving it');
  });

  test('PMB-10: a terminal in no pane is still marked for its session, and not for another', async () => {
    needHarness();
    await call('detach');
    const before = (await call('info')).marks.length;
    const lines = await call('prompt', `dir 6\r\nnothing\r\n${PROMPT}`);
    assert.equal(lines.length, before + 1);
    assert.equal(await call('lineText', lines.at(-1)), PROMPT);
    assert.equal((await call('otherSessionPrompt')).length, before + 1);
    await call('attach');
  });

  test('PMB-11: the setting takes the marks off the ruler and back, the columns unchanged', async () => {
    needHarness();
    const info = await call('info');
    const off = await call('setMarks', false);
    assert.equal(off.decorations, 0);
    assert.equal(off.cols, info.cols);
    const left = (await call('rulerRows')).filter((r) => isAccent(r.rgba));
    assert.equal(left.length, 0, `marks still drawn while off: ${JSON.stringify(left)} ${JSON.stringify(await call('xtermDecorations'))}`);
    const on = await call('setMarks', true);
    assert.equal(on.decorations, info.marks.length);
    assert.equal(on.cols, info.cols);
    assert.ok((await call('rulerRows')).some((r) => isAccent(r.rgba)));
  });

  // Before PMB-12, which closes the browser.
  test('PMB-13: with the setting off, a press on the track at a hidden mark\'s height keeps xterm\'s own jump', async () => {
    needHarness();
    await call('setMarks', false);
    try {
      // The slider at the bottom, away from the mark pressed on.
      await call('scrollToLine', (await call('info')).baseY);
      const info = await call('info');
      assert.equal(info.decorations, 0, 'no mark is drawn');
      const target = info.marks[1];
      const y = markY(info, target).client;
      assert.ok(y < info.slider.top || y > info.slider.top + info.slider.height, 'the press is on the track, not the slider');
      const expected = xtermJump(info, y);
      assert.ok(Math.abs(expected - target) > 2, `xterm's jump (${expected}) and the mark (${target}) can be told apart`);
      await clickTrack(info, y);
      const after = await call('info');
      assert.notEqual(after.viewportY, target, 'a hidden mark took the press');
      assert.ok(Math.abs(after.viewportY - expected) <= 2, `viewport at ${after.viewportY}, xterm's jump would be ${expected}`);
    } finally {
      await call('setMarks', true);
    }
  });

  test('PMB-12: nothing thrown in the page; the browser goes', async () => {
    needHarness();
    try {
      assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
    } finally {
      harness.teardown();
      harness = null;
    }
  });
});
