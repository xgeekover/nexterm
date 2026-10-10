/**
 * Cmd/Ctrl+click to show a name in the file manager, against REAL xterm 6
 * under REAL mouse and key events: what Node and its stand-ins cannot show.
 * reveal_links.test.js restates what xterm's link detection does with a
 * link; this drives tests/adversarial/fixtures/reveal_links_harness.html — a
 * terminal made by the app's own `getOrCreateTerminal`, and a stock xterm 6
 * as the control — in headless Chromium, events sent as raw CDP input.
 *
 *   - RV-02: over a name, nothing is drawn or looked up until the modifier
 *     goes down; then the row is looked up and the name underlined, with a
 *     pointer, the pointer never moving — and undrawn when it goes up.
 *   - RV-03: a click with the modifier shows the name (`fs_reveal_path`,
 *     answered by the browser mock): a folder, a file. Without it, nothing.
 *   - RV-04: a double-click without the modifier selects the word, exactly as
 *     the control does — not the whole `My Folder` link under it.
 *   - RV-05: the modifier held before the pointer arrives: drawn as soon as
 *     the backend has said the name exists.
 *   - RV-06 (macOS): a Ctrl-click — macOS's right-click — and a ⌘+right-click
 *     over a link select the word the control selects (review: they selected
 *     the link, `My Folder` or `src` without its `/`, and Copy copied that).
 *   - RV-07: a ⌘-click right after a double-click, or after a ⌘+right-click,
 *     on the same cell still shows the name (review: it did nothing).
 *   - RV-08: no lookups without the modifier — pointer resting over output
 *     streaming in, pointer moving over rows (review: 182 in three seconds).
 *   - RV-09: a ⌘+double-click shows the name once (review: twice).
 *   - RV-10: on Windows a lone Ctrl counts — through the browser's own
 *     timers, which threw "Illegal invocation" when kept in an object (the
 *     release after a ⌘+right-click, RV-07, runs them on macOS).
 *   - RV-11: the modifier down beside the cells (the scrollbar) looks at
 *     nothing; RV-12: a ⌘-click quicker than the backend still shows.
 *   - Every case: no exception thrown in the page and left uncaught.
 *
 * Needs agent-browser, and a Node with a global WebSocket (22 and later) for
 * the CDP session: skipped without either, saying which. When both are there
 * and the browser still does not start, that is a failure, not a skip — a
 * run that checked nothing must not look like one that was not possible.
 * The agent-browser session is this process's own, so two runs at once do
 * not take each other's. RV-01 and RV-13 are setup and teardown, as cases;
 * teardown also runs from `process.on('exit')`.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, openHarness } from './headless_browser.js';

const NOT_INSTALLED = 'agent-browser is not installed — the real-browser reveal-link check runs locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_HARNESS = 'the harness did not start: see RV-01';

/** Set by RV-01 once the page is up; every later case skips without it. */
let harness = null;
/** The modifier on the page's platform, as CDP sends it. */
let modifier = null;
let os = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__r.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

// CDP's modifier bits.
const CTRL = 2;
const META = 4;

/**
 * Nothing thrown in the page and left uncaught — an event listener's
 * exceptions included. The page goes on working after one, and Node never
 * sees it: a timer called the way a browser refuses threw on every lone
 * Ctrl, and every case here passed.
 */
function assertNoPageErrors() {
  assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
}

/** Every case needs the page; RV-01 says why there is none. */
function needHarness() {
  if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
  if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
  if (!harness) skip(NO_HARNESS);
}

/** Where cell (col, row) of `which` is, in viewport coordinates. */
async function cellPoint(which, col, row) {
  const r = await call('rect', which);
  const cell = await call('cellSize', which);
  return { x: r.left + cell.width * (col + 0.5), y: r.top + cell.height * (row + 0.5) };
}

// Row 0 is "drwxr-xr-x 2 me me 4096 Oct  9 22:00 'My Folder'": `My` at
// columns 38–39, `Folder` at 41–46. Row 1 ends in `build.sh` at 38–45.
// Row 2 is `ls -F`'s "src/  tests/".
const FOLDER = { col: 43, row: 0 };
const MY = { col: 38, row: 0 };
const BUILD = { col: 40, row: 1 };
const SRC = { col: 1, row: 2 };

async function moveTo(which, { col, row }, modifiers = 0) {
  const { x, y } = await cellPoint(which, col, row);
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  // The kinds come from the mock backend a task later; xterm draws on the next frame.
  await sleep(120);
}

async function key(type, held, which = modifier) {
  await harness.send('Input.dispatchKeyEvent', {
    type,
    key: which.key,
    code: which.code,
    windowsVirtualKeyCode: which.vk,
    modifiers: held ? which.bit : 0,
  });
  await sleep(60);
}

async function click(which, at, { modifiers = 0, count = 1, button = 'left' } = {}) {
  const { x, y } = await cellPoint(which, at.col, at.row);
  const buttons = button === 'left' ? 1 : 2;
  await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await sleep(120);
  for (let n = 1; n <= count; n += 1) {
    await harness.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: n, modifiers });
    await harness.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n, modifiers });
  }
  await sleep(150);
}

/** Away from every name, with nothing held: whatever was hovered is left. */
async function rest() {
  await moveTo('app', { col: 2, row: 6 });
  await moveTo('stock', { col: 2, row: 6 });
}

/** The link under `at` established: hovered there with the modifier down, then let go. */
async function hoverWithModifier(at) {
  await moveTo('app', at);
  await key('rawKeyDown', true);
  await sleep(80);
  await key('keyUp', false);
}

describe('Reveal links: real xterm 6 under headless Chromium (CDP)', () => {
  test('RV-01: setup — the scratch vite server, the harness page, a raw CDP session onto it', async () => {
    if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
    if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
    // Installed and able to run: anything that goes wrong from here fails.
    harness = await openHarness('tests/adversarial/fixtures/reveal_links_harness.html', {
      prefix: 'reveal-links-headless',
      session: `reveal-links-headless-${process.pid}`,
      readyExpression: 'window.__r ? window.__r.ready === true : false',
    });
    os = await call('os');
    modifier = os === 'macos'
      ? { key: 'Meta', code: 'MetaLeft', vk: 91, bit: META }
      : { key: 'Control', code: 'ControlLeft', vk: 17, bit: CTRL };
    assert.deepEqual(await call('cellSize', 'app'), await call('cellSize', 'stock'), 'the app and the control draw the same cells');
  });

  test('RV-02: looked up and underlined, with a pointer, only while the modifier is down — the pointer never moving', async () => {
    needHarness();
    await rest();
    await call('clearAsked');
    await moveTo('app', FOLDER);
    assert.deepEqual(await call('underlined', 'app'), [], 'over a name, nothing held: nothing drawn');
    assert.equal(await call('pointer', 'app'), false, 'and no pointer');
    assert.equal(await call('asked'), 0, 'and nothing looked up');

    await key('rawKeyDown', true);
    await sleep(80);
    assert.deepEqual(await call('underlined', 'app'), ['My Folder'], 'the whole name, not `My`, which exists too');
    assert.equal(await call('pointer', 'app'), true);
    assert.ok((await call('asked')) >= 1, 'looked up once the modifier went down');

    await key('keyUp', false);
    assert.deepEqual(await call('underlined', 'app'), [], 'let go: undrawn');
    assert.equal(await call('pointer', 'app'), false);

    await key('rawKeyDown', true);
    assert.deepEqual(await call('underlined', 'app'), ['My Folder'], 'and again');
    await key('keyUp', false);
    assertNoPageErrors();
  });

  test('RV-03: a click with the modifier shows the name — a folder, a file — and a plain click shows nothing', async () => {
    needHarness();
    await rest();
    await call('clearRevealed');
    await click('app', FOLDER);
    assert.deepEqual(await call('revealed'), [], 'a plain click: nothing new');

    await click('app', MY, { modifiers: modifier.bit });
    await click('app', BUILD, { modifiers: modifier.bit });
    assert.deepEqual(await call('revealed'), [
      { path: '/workspace/My Folder', kind: 'dir' },
      { path: '/workspace/build.sh', kind: 'file' },
    ]);
    await rest();
    assertNoPageErrors();
  });

  test('RV-04: a double-click without the modifier selects the word, as the control does — not the link', async () => {
    needHarness();
    await rest();
    await call('clearRevealed');
    for (const which of ['app', 'stock']) {
      await call('clearSelection', which);
      if (which === 'app') await hoverWithModifier(FOLDER);
      await click(which, FOLDER, { count: 2 });
    }
    assert.equal(await call('selection', 'stock'), 'Folder', 'the control: xterm selects the word');
    assert.equal(await call('selection', 'app'), 'Folder', 'the app: the same word, though `My Folder` is a link');
    for (const which of ['app', 'stock']) {
      await call('clearSelection', which);
      if (which === 'app') await hoverWithModifier(BUILD);
      await click(which, BUILD, { count: 2 });
      assert.equal(await call('selection', which), 'build.sh', which);
    }
    assert.deepEqual(await call('revealed'), [], 'and nothing was shown');
    await rest();
    assertNoPageErrors();
  });

  test('RV-05: the modifier held before the pointer arrives — drawn once the name is known to exist', async () => {
    needHarness();
    await rest();
    await key('rawKeyDown', true);
    await moveTo('app', BUILD, modifier.bit);
    assert.deepEqual(await call('underlined', 'app'), ['build.sh']);
    assert.equal(await call('pointer', 'app'), true);
    await key('keyUp', false);
    assert.deepEqual(await call('underlined', 'app'), []);
    await rest();
    assertNoPageErrors();
  });

  test('RV-06: on macOS a Ctrl-click and a ⌘+right-click over a link select the word the control selects', async () => {
    needHarness();
    if (os !== 'macos') skip('a Ctrl-click is a right-click only on macOS');
    const ctrl = { key: 'Control', code: 'ControlLeft', vk: 17, bit: CTRL };
    const select = async (which, at, how) => {
      await rest();
      await call('clearSelection', which);
      if (which === 'app') await hoverWithModifier(at);
      if (how === 'ctrl-click') {
        await moveTo(which, at);
        await key('rawKeyDown', true, ctrl);
        await click(which, at, { modifiers: CTRL });
        await key('keyUp', false, ctrl);
      } else {
        await moveTo(which, at, META);
        await key('rawKeyDown', true);
        await click(which, at, { modifiers: META, button: 'right' });
        await key('keyUp', false);
      }
      return call('selection', which);
    };
    for (const [at, how] of [[MY, 'ctrl-click'], [SRC, 'ctrl-click'], [MY, 'cmd-right-click']]) {
      const stock = await select('stock', at, how);
      const app = await select('app', at, how);
      assert.ok(stock, `premise: the control selects something on a ${how}`);
      assert.equal(app, stock, `${how} at ${JSON.stringify(at)}: the app selects what the control selects`);
    }
    await rest();
    assertNoPageErrors();
  });

  test('RV-07: a ⌘-click right after a double-click, or after a ⌘+right-click, on the same cell still shows the name', async () => {
    needHarness();
    await rest();
    await call('clearRevealed');
    await hoverWithModifier(BUILD);
    await click('app', BUILD, { count: 2 });
    // The modifier goes down with the pointer where the double-click left it.
    await key('rawKeyDown', true);
    await sleep(80);
    await click('app', BUILD, { modifiers: modifier.bit });
    await key('keyUp', false);
    assert.deepEqual(await call('revealed'), [{ path: '/workspace/build.sh', kind: 'file' }], 'after a double-click');

    await call('clearRevealed');
    await rest();
    await moveTo('app', FOLDER, modifier.bit);
    await key('rawKeyDown', true);
    await click('app', FOLDER, { modifiers: modifier.bit, button: 'right' });
    // Still held: no key event to make anything look again.
    await click('app', FOLDER, { modifiers: modifier.bit });
    await key('keyUp', false);
    assert.deepEqual(await call('revealed'), [{ path: '/workspace/My Folder', kind: 'dir' }], 'after a ⌘+right-click');
    await rest();
    assertNoPageErrors();
  });

  test('RV-08: no lookups without the modifier — the pointer resting over streaming output, or moving over rows', async () => {
    needHarness();
    await rest();
    await moveTo('app', BUILD);
    await call('clearAsked');
    for (let i = 0; i < 40; i += 1) {
      await call('write', 'app', `src  README.md  build${i}.log\r\n`);
      await sleep(10);
    }
    for (const at of [FOLDER, BUILD, SRC, { col: 3, row: 4 }, { col: 3, row: 5 }]) await moveTo('app', at);
    assert.equal(await call('asked'), 0, 'not one lookup');
    await call('reset', 'app');
    await rest();
    assertNoPageErrors();
  });

  test('RV-09: a ⌘+double-click shows the name once', async () => {
    needHarness();
    await rest();
    await call('clearRevealed');
    await moveTo('app', FOLDER, modifier.bit);
    await key('rawKeyDown', true);
    await click('app', FOLDER, { modifiers: modifier.bit, count: 2 });
    await key('keyUp', false);
    assert.deepEqual(await call('revealed'), [{ path: '/workspace/My Folder', kind: 'dir' }]);
    await rest();
    assertNoPageErrors();
  });

  test('RV-10: on Windows a lone Ctrl counts after AltGr\'s grace, through the browser\'s own timers — nothing thrown', async () => {
    needHarness();
    await rest();
    // The page's paths are POSIX ones, which a Windows build would not look
    // up: what is checked is that the key counts — the row under the pointer
    // is looked at again, by moves the page makes itself.
    await call('setOs', 'windows');
    try {
      const ctrl = { key: 'Control', code: 'ControlLeft', vk: 17, bit: CTRL };
      await moveTo('app', BUILD);
      const before = await call('lookedAgain');
      await key('rawKeyDown', true, ctrl);
      await sleep(150);
      assert.equal((await call('lookedAgain')) - before, 2, 'a row away and back: Ctrl counted');
      await key('keyUp', false, ctrl);
    } finally {
      await call('setOs', os);
    }
    assertNoPageErrors();
    await rest();
  });

  test('RV-11: the modifier down with the pointer beside the cells — the scrollbar side — looks at nothing', async () => {
    needHarness();
    await rest();
    const r = await call('rect', 'app');
    const cell = await call('cellSize', 'app');
    await harness.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.left + r.width + 12, y: r.top + cell.height * 1.5 });
    await sleep(80);
    await call('clearAsked');
    await key('rawKeyDown', true);
    await sleep(120);
    assert.equal(await call('asked'), 0, 'nothing looked up');
    assert.deepEqual(await call('underlined', 'app'), [], 'nothing drawn beside the pointer');
    await key('keyUp', false);
    assertNoPageErrors();
    await rest();
  });

  test('RV-12: a ⌘-click quicker than a slow backend shows the name when the answer comes', async () => {
    needHarness();
    await rest();
    await call('addFolder', 'quick-folder');
    await call('write', 'app', 'quick-folder\r\n');
    await call('clearRevealed');
    await call('setKindsDelay', 80);
    try {
      const at = { col: 3, row: 3 };
      await moveTo('app', at);
      const { x, y } = await cellPoint('app', at.col, at.row);
      // The key and the click at once: the lookup the key started is still
      // on its way when the press comes.
      await harness.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.vk, modifiers: modifier.bit });
      await harness.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: modifier.bit });
      await harness.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: modifier.bit });
      await sleep(400);
      await key('keyUp', false);
      assert.deepEqual(await call('revealed'), [{ path: '/workspace/quick-folder', kind: 'dir' }]);
    } finally {
      await call('setKindsDelay', 0);
    }
    assertNoPageErrors();
    await call('reset', 'app');
    await rest();
  });

  test('RV-13: teardown — close the browser session and stop the scratch server', async () => {
    if (!HEADLESS_AVAILABLE || typeof WebSocket !== 'function') skip(HEADLESS_AVAILABLE ? NO_WEBSOCKET : NOT_INSTALLED);
    harness?.teardown();
  });
});
