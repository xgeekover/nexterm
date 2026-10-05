/**
 * The right-click against REAL xterm 6 under REAL mouse events: what Node and
 * its stand-ins cannot show. terminal_right_click.test.js checks the decisions
 * and the binding on a page restated from xterm's source; this drives
 * tests/adversarial/fixtures/right_click_harness.html — a terminal made by the
 * app's own `getOrCreateTerminal`, and a stock xterm 6 as the control — in
 * headless Chromium, right-clicks sent as raw CDP `Input.dispatchMouseEvent`,
 * so the browser itself fires mousedown, contextmenu, mouseup and auxclick in
 * its own order.
 *
 *   - RH-02: at a prompt the app pastes the clipboard through xterm's own
 *     `paste`, and its element hears nothing: no press, no menu, xterm's
 *     right-click handler never runs. The control hears all four, raises its
 *     textarea for the webview's menu, and selects the word under the pointer.
 *   - RH-03: inside a full-screen program tracking the mouse, the app sends
 *     the bracketed paste and not one report; the control reports the press
 *     and the release. Claude Code's own bytes, on the normal screen, too.
 *   - RH-04: an image alone on the clipboard is an empty bracketed paste, and
 *     nothing at all to a program that did not ask for bracketed paste.
 *   - RH-05: a selection made by a real drag over the top row is copied
 *     through xterm's copy event and cleared; the next right-click pastes.
 *   - RH-06: Shift+right-click reaches xterm exactly as the control's does —
 *     the same bytes to the program, by xterm's own rule on this platform.
 *   - RH-07: with the setting at 'default' the app's terminal does exactly
 *     what the control does.
 *
 * Needs agent-browser; skipped without it, like wheel_headless. RH-01 and
 * RH-08 are setup and teardown, as cases (no suite-level hooks in this
 * harness); teardown also runs from `process.on('exit')`.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NO_BROWSER = 'agent-browser is not installed — the real-browser right-click check runs locally only';

/** Set by RH-01 once the page is up; every later case skips without it. */
let harness = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__r.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

const ESC = '\x1b';
const FULL_SCREEN = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h`;
const CLAUDE_PROMPT = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h`;
const CLIPBOARD = { text: 'echo one\ntwo', has_image: false };
const PASTED = 'echo one\rtwo';
const BRACKETED = `${ESC}[200~${PASTED}${ESC}[201~`;
const EVERY_PART = ['auxclick:2', 'contextmenu:2', 'mousedown:2', 'mouseup:2'];
const REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/;

/** Where a click on `which`'s cell (col, row) lands, in viewport coordinates. */
async function cellPoint(which, col, row) {
  const r = await call('rect', which);
  const cell = await call('cellSize', which);
  return { x: r.left + cell.width * (col + 0.5), y: r.top + cell.height * (row + 0.5) };
}

/** A whole right-click over the word "hello" on the top row; settled before returning. */
async function rightClick(which, { shift = false } = {}) {
  const { x, y } = await cellPoint(which, 2, 0);
  const modifiers = shift ? 8 : 0;
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await harness.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, modifiers });
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, modifiers });
  await sleep(60);
  await call('pasting');
}

/**
 * A left drag across the first `cols` cells of the top row. xterm rounds a
 * selection to the nearest cell edge, so it starts a fifth of a cell in and
 * ends a fifth of a cell short.
 */
async function dragTopRow(which, cols) {
  const r = await call('rect', which);
  const cell = await call('cellSize', which);
  const y = r.top + cell.height * 0.5;
  const from = r.left + cell.width * 0.2;
  const to = r.left + cell.width * (cols - 0.2);
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from, y });
  await harness.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i += 1) {
    await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from + ((to - from) * i) / 5, y, button: 'left', buttons: 1 });
  }
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
}

/** Both terminals fresh, the setting on, the clipboard holding `clipboard`, and `prelude` written to both. */
async function fresh({ prelude = '', clipboard = CLIPBOARD, setting = 'copyPaste' } = {}) {
  await call('setRightClick', setting);
  await call('setClipboard', clipboard);
  for (const which of ['app', 'stock']) {
    await call('reset', which);
    if (prelude) await call('write', which, prelude);
  }
  await call('clearMenus');
  await call('clearCopied');
  return call('reads');
}

/** What a right-click did to `which`: what the program got, what xterm's element heard, and the rest. */
async function outcome(which) {
  return {
    data: await call('data', which),
    seen: (await call('seen', which)).sort(),
    menus: await call('menus', which),
    raised: (await call('textareaZ', which)) === '1000',
    selection: await call('selection', which),
    focused: await call('focused', which),
  };
}

describe('The right-click: real xterm 6 under headless Chromium (CDP)', () => {
  test('RH-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    try {
      harness = await openHarness('tests/adversarial/fixtures/right_click_harness.html', {
        prefix: 'right-click-headless',
        readyExpression: 'window.__r ? window.__r.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    assert.deepEqual(await call('cellSize', 'app'), await call('cellSize', 'stock'), 'the app and the control draw the same cells');
  });

  test('RH-02: at a prompt, the app pastes through xterm\'s paste and xterm hears nothing; the control hears all of it', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const reads = await fresh();
    await rightClick('app');
    const app = await outcome('app');
    assert.equal(app.data, PASTED, 'the clipboard, as xterm pastes it — a line break as Enter, no bracketing nobody asked for');
    assert.deepEqual(app.seen, [], 'not one of the four events reached xterm\'s element');
    assert.deepEqual(app.menus, [true], 'the context menu cancelled: no webview menu');
    assert.equal(app.raised, false, 'xterm\'s right-click handler never ran');
    assert.equal(app.selection, '', 'and selected no word');
    assert.equal(app.focused, true, 'focused, as a press on xterm would have');
    assert.equal((await call('reads')) - reads, 1, 'the clipboard read once');

    // The control: the very same click on xterm alone.
    await rightClick('stock');
    const stock = await outcome('stock');
    assert.deepEqual(stock.seen, EVERY_PART, 'xterm\'s element hears the whole right-click');
    assert.deepEqual(stock.menus, [false], 'and leaves the webview its menu');
    assert.equal(stock.raised, true, 'its handler raised the textarea under the pointer, for the menu to paste into');
    assert.equal(stock.selection, 'hello', 'and selected the word there');
    assert.equal(stock.data, '', 'xterm itself pastes nothing on a right-click');
  });

  test('RH-03: inside a full-screen program tracking the mouse, the app sends the paste and not one report — the control reports both halves', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    await fresh({ prelude: FULL_SCREEN });
    assert.equal(await call('mode', 'app'), 'vt200', 'the program has the mouse');
    await rightClick('app');
    const app = await outcome('app');
    assert.equal(app.data, BRACKETED, 'bracketed, as the program asked');
    assert.ok(!REPORT.test(app.data), 'no mouse report reached the program');
    assert.deepEqual(app.seen, []);
    assert.deepEqual(app.menus, [true]);

    await rightClick('stock');
    assert.match(await call('data', 'stock'), /^\x1b\[<2;\d+;\d+M\x1b\[<2;\d+;\d+m$/, 'xterm alone reports the press and the release');

    // Claude Code's prompt: tracking asked for on the normal screen, which the
    // app holds back — the right-click pastes there just the same.
    await fresh({ prelude: CLAUDE_PROMPT });
    assert.equal(await call('mode', 'app'), 'none');
    await rightClick('app');
    assert.equal(await call('data', 'app'), BRACKETED);
    assert.deepEqual(await call('seen', 'app'), []);
  });

  test('RH-04: an image alone is an empty bracketed paste — and nothing at all to a program that did not ask for bracketed paste', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const imageOnly = { text: '', has_image: true };
    await fresh({ prelude: FULL_SCREEN, clipboard: imageOnly });
    await rightClick('app');
    assert.equal(await call('data', 'app'), `${ESC}[200~${ESC}[201~`, 'what Ctrl+V sends, and what OpenCode reads as "attach the image"');
    assert.deepEqual(await call('menus', 'app'), [true]);

    await fresh({ clipboard: imageOnly });
    assert.equal(await call('bracketed', 'app'), false);
    await rightClick('app');
    assert.equal(await call('data', 'app'), '', 'a shell that never asked: not one byte');
    assert.deepEqual(await call('seen', 'app'), [], 'and still nothing to xterm');

    await fresh({ prelude: FULL_SCREEN, clipboard: { text: '', has_image: false } });
    await rightClick('app');
    assert.equal(await call('data', 'app'), '', 'an empty clipboard: nothing');
  });

  test('RH-05: a selection dragged over the top row is copied through xterm\'s copy event and cleared — then the next right-click pastes', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const reads = await fresh();
    await dragTopRow('app', 5);
    assert.equal(await call('selection', 'app'), 'hello', 'a real drag over the first word of the first row');
    assert.equal((await call('selectionPosition', 'app')).start.y, 0, 'which xterm 6 reports as row 0');
    await call('clearCopied');
    await call('clearSeen', 'app');
    await rightClick('app');
    assert.deepEqual(await call('copied'), ['hello'], 'on the clipboard, through the copy event xterm fills');
    assert.equal(await call('selection', 'app'), '', 'cleared, as Windows Terminal clears it');
    assert.equal(await call('data', 'app'), '', 'nothing pasted');
    assert.deepEqual(await call('seen', 'app'), [], 'nothing reached xterm');
    assert.equal((await call('reads')) - reads, 0, 'the clipboard not even read');

    await rightClick('app');
    assert.equal(await call('data', 'app'), PASTED, 'nothing selected now: the next right-click pastes');

    // The same inside a full-screen program, where Shift-drag is how one
    // selects. (The alternate screen keeps the cursor where it was: home it.)
    await fresh({ prelude: `${FULL_SCREEN}${ESC}[Hhello world` });
    await call('select', 'app', 0, 0, 5);
    assert.equal(await call('selection', 'app'), 'hello');
    await rightClick('app');
    assert.deepEqual(await call('copied'), ['hello']);
    assert.equal(await call('data', 'app'), '', 'no paste, no report');
  });

  test('RH-06: Shift+right-click reaches xterm exactly as the control\'s does — the same bytes, by xterm\'s own rule here', async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    const reads = await fresh({ prelude: FULL_SCREEN });
    await rightClick('app', { shift: true });
    await rightClick('stock', { shift: true });
    const app = await outcome('app');
    const stock = await outcome('stock');
    assert.deepEqual(app.seen, EVERY_PART, 'every part reached xterm\'s element');
    assert.deepEqual(app.seen, stock.seen);
    // All but the webview's own menu, which xterm alone leaves to open: on
    // macOS it took the button's release with it (measured in the app).
    assert.deepEqual(app.menus, [true], 'no webview menu');
    assert.deepEqual(stock.menus, [false], 'where xterm alone opens one');
    assert.equal(app.raised, true, 'xterm\'s right-click handler ran');
    assert.equal(app.data, stock.data, 'the program got what it gets from xterm alone');
    if (/Mac/.test(await call('platform'))) {
      // On macOS xterm forces selection with ⌥, not Shift: the click is reported, Shift in its bits.
      assert.match(app.data, /^\x1b\[<6;\d+;\d+M\x1b\[<6;\d+;\d+m$/, 'reported to the program');
    }
    assert.equal((await call('reads')) - reads, 0, 'the clipboard not read');
  });

  test("RH-07: with the setting at 'default', the app's terminal does exactly what xterm alone does", async () => {
    if (!HEADLESS_AVAILABLE || !harness) skip(NO_BROWSER);
    for (const prelude of ['', FULL_SCREEN]) {
      const reads = await fresh({ prelude, setting: 'default' });
      await rightClick('app');
      await rightClick('stock');
      const app = await outcome('app');
      const stock = await outcome('stock');
      assert.deepEqual(app.seen, stock.seen, `${prelude ? 'full screen' : 'prompt'}: the same events heard`);
      assert.deepEqual(app.menus, [false]);
      assert.equal(app.raised, true);
      assert.equal(app.selection, stock.selection);
      assert.equal(app.data, stock.data, prelude ? 'reported, as before' : 'nothing typed, as before');
      assert.equal((await call('reads')) - reads, 0);
    }
  });

  test('RH-08: teardown — close the browser session and stop the scratch server', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    if (harness) await call('setClipboard', { text: '', has_image: false });
    harness?.teardown();
  });
});
