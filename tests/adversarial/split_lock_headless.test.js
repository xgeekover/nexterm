/**
 * Stage 3, parts A and B, driven in a real browser with real input (CDP):
 * the whole app on a scratch Vite server (headless_browser.js), the mock
 * backend under it, the mouse and the keyboard as Chromium delivers them.
 *
 * These are the review's findings, each one a thing only a browser shows:
 *
 *   - a hidden tab strip's controls must never be put under a pointer that
 *     only came near the top of a terminal: approaching row 1, the find
 *     bar's ✕ or the resume offer's buttons from above and clicking hits
 *     what was aimed at; the strip comes up only from its handle (a click,
 *     or Enter), during a drag, and while its menu or a rename is open, and
 *     goes on Escape, a press outside it, or the pointer leaving it;
 *   - Enter or Escape finishing a tab rename is the rename's, and never
 *     reaches the shell as a key;
 *   - a lock appearing on a chip moves nothing under the pointer.
 *
 * Skipped, saying so, where there is no browser to drive (CI).
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NO_BROWSER = 'no agent-browser / Chromium on this machine';
let harness = null;
const ev = (js) => harness.evalJs(js);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mouse = (type, x, y, extra = {}) =>
  harness.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', pointerType: 'mouse', ...extra });
const move = (x, y) => mouse('mouseMoved', x, y);
const press = (x, y, clickCount = 1, button = 'left') =>
  mouse('mousePressed', x, y, { button, buttons: button === 'right' ? 2 : 1, clickCount });
const release = (x, y, clickCount = 1, button = 'left') => mouse('mouseReleased', x, y, { button, buttons: 0, clickCount });
const click = async (x, y, clickCount = 1) => {
  await press(x, y, clickCount);
  await release(x, y, clickCount);
};
const dblclick = async (x, y) => {
  await click(x, y, 1);
  await sleep(80);
  await click(x, y, 2);
};
/** A pointer coming down from the group bar onto (x, y), a few pixels a step, as a hand does. */
async function descendTo(x, y) {
  await move(x, 30);
  await sleep(50);
  for (let at = 34; at < y; at += 4) {
    await move(x, at);
    await sleep(16);
  }
  await move(x, y);
  await sleep(250);
}
/** A key as a keyboard sends it: down (with its text, so a keypress follows) and up. */
async function key(name, code, vk, text) {
  await harness.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
  await harness.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
}
const typeText = (text) => harness.send('Input.insertText', { text });

/** Record every backend call and every press, click and double-click, and where it landed. */
const SPY = `(() => {
  const mb = window.__nexterm.mockBridge;
  if (!mb.__spied) {
    const orig = mb.invoke;
    mb.invoke = function (command, args, ...rest) {
      (window.__calls ||= []).push([command, command === 'pty_write' ? args?.data : '']);
      return orig.call(this, command, args, ...rest);
    };
    mb.__spied = true;
    for (const type of ['pointerdown', 'click', 'dblclick']) {
      window.addEventListener(type, (e) => {
        const el = e.target;
        const where = el.closest('[data-strip-overlay]') ? 'strip'
          : el.closest('[data-strip-handle]') ? 'handle'
          : el.closest('[data-agent-resume] button') ? 'banner:' + el.closest('button').textContent.trim()
          : el.closest('[role="search"]') ? 'find'
          : el.closest('.xterm') ? 'xterm' : el.tagName;
        window.__clicks.push([type, where]);
      }, true);
    }
  }
  window.__calls = [];
  window.__clicks = [];
  return true;
})()`;
const spied = async () => JSON.parse(await ev(`JSON.stringify({ calls: window.__calls, clicks: window.__clicks })`));
const rectOf = async (selector) => JSON.parse(await ev(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect() ?? null)`));
const overlayShown = (paneId) =>
  ev(`(() => { const o = document.querySelector('[data-pane-body="${paneId}"]')?.closest('[data-strip-hidden]')?.querySelector('[data-strip-overlay]'); return o ? o.dataset.shown === 'true' : null; })()`);
const termSize = (paneId) =>
  ev(`(() => { const s = document.querySelector('[data-pane-body="${paneId}"] .xterm-screen')?.getBoundingClientRect(); return s ? Math.round(s.width) + 'x' + Math.round(s.height) : null; })()`);

/** The two panes of the group, each holding one terminal: `[{ pane, tab, session }]`. */
let panes = [];

describe('Split polish and the lock, in a real browser', () => {
  test('HS-01: setup — the app on a scratch server, two one-terminal panes, their strips hidden', async () => {
    if (!HEADLESS_AVAILABLE) skip(NO_BROWSER);
    try {
      harness = await openHarness('?debug', {
        prefix: 'split-lock-headless',
        readyExpression: 'window.__nexterm?.useTerminalStore?.getState().isInitialized === true',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) skip(`${NO_BROWSER} (${err.message})`);
      throw err;
    }
    await harness.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    panes = JSON.parse(
      await ev(`(async () => {
        const N = window.__nexterm;
        N.useSettingsStore.getState().setSetting('terminalHideSingleTabStrip', true);
        const T = () => N.useTerminalStore.getState();
        await T().splitActivePane('horizontal');
        await new Promise((r) => setTimeout(r, 600));
        const g = T().getActiveGroup();
        const leaves = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(leaves));
        return JSON.stringify(leaves(g.tree).map((l) => ({ pane: l.id, tab: l.activeTabId, session: T().tabs.find((t) => t.id === l.activeTabId).sessionId })));
      })()`)
    );
    assert.equal(panes.length, 2);
    assert.equal(await ev(`document.querySelectorAll('[data-strip-hidden]').length`), 2, 'both strips hidden');
    await ev(SPY);
  });

  test('HS-02: a pointer coming down onto row 1, then a click and a double-click there, hits the terminal and nothing else', async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane } = panes[0];
    const body = await rectOf(`[data-pane-body="${pane}"]`);
    const x = Math.round(body.left + 90);
    const row1 = Math.round(body.top + 10);
    await ev(SPY);
    await descendTo(x, row1);
    assert.equal(await overlayShown(pane), false, 'the strip came up under a pointer that only came near it');
    await click(x, row1);
    await sleep(80);
    await dblclick(x, row1 + 1);
    await sleep(200);
    const { clicks } = await spied();
    const off = clicks.filter(([, where]) => where !== 'xterm');
    assert.deepEqual(off, [], `presses meant for the terminal landed elsewhere: ${JSON.stringify(clicks)}`);
  });

  test("HS-03: the find bar's ✕, approached from above, is what the click hits", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane, tab } = panes[1];
    await ev(`window.__nexterm.useTerminalStore.getState().openFind(${JSON.stringify(tab)})`);
    await sleep(300);
    const close = await ev(`(() => { const bar = document.querySelector('[data-pane-body="${pane}"] [role="search"]'); const b = bar && [...bar.querySelectorAll('button')].pop()?.getBoundingClientRect(); return b ? JSON.stringify(b) : null; })()`);
    assert.ok(close, 'setup: no find bar with a close button');
    const r = JSON.parse(close);
    await ev(SPY);
    await descendTo(Math.round((r.left + r.right) / 2), Math.round((r.top + r.bottom) / 2));
    await click(Math.round((r.left + r.right) / 2), Math.round((r.top + r.bottom) / 2));
    await sleep(250);
    assert.equal(await ev(`window.__nexterm.useTerminalStore.getState().find.open`), false, 'the find bar is still open');
    const { clicks } = await spied();
    assert.ok(!clicks.some(([, where]) => where === 'strip'), `the click went to the strip: ${JSON.stringify(clicks)}`);
  });

  test("HS-04: the resume offer's Resume, approached from above, is what the click hits", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane, tab } = panes[0];
    await ev(`(() => { const S = window.__nexterm.useTerminalStore; S.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === ${JSON.stringify(tab)} ? { ...t, agent: { kind: 'claude', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', startedAt: Date.now() - 60000 }, agentResumeOffered: true } : t)) })); return true; })()`);
    await sleep(400);
    const button = await ev(`(() => { const b = [...document.querySelectorAll('[data-pane-body="${pane}"] [data-agent-resume] button')].find((x) => /Resume/.test(x.textContent)); return b ? JSON.stringify(b.getBoundingClientRect()) : null; })()`);
    assert.ok(button, 'setup: no Resume button');
    const r = JSON.parse(button);
    const x = Math.round((r.left + r.right) / 2);
    const y = Math.round((r.top + r.bottom) / 2);
    await ev(SPY);
    await descendTo(x, y);
    await click(x, y);
    await sleep(300);
    const { clicks } = await spied();
    assert.ok(clicks.some(([type, where]) => type === 'click' && where.startsWith('banner:Resume')), `the click did not reach Resume: ${JSON.stringify(clicks)}`);
    assert.ok(!clicks.some(([, where]) => where === 'strip'), `the click went to the strip: ${JSON.stringify(clicks)}`);
  });

  test("HS-05: the strip comes up BELOW its handle; the handle toggles it; Escape is the strip's only with the keyboard in it; a press outside or the pointer leaving puts it away — the terminal never resizing", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane, session } = panes[1];
    const handle = await rectOf(`[data-strip-handle="${pane}"]`);
    assert.ok(handle, 'no handle on a pane whose strip is hidden');
    assert.ok(handle.height >= 5 && handle.height <= 8, `the handle is ${handle.height}px tall`);
    const body = await rectOf(`[data-pane-body="${pane}"]`);
    assert.ok(body.top >= handle.bottom - 0.5, 'the handle is laid over the terminal rather than above it');
    const size = await termSize(pane);
    const hx = Math.round(handle.left + 60);
    const hy = Math.round(handle.top + handle.height / 2);
    const stripBox = async () =>
      JSON.parse(await ev(`JSON.stringify(document.querySelector('[data-strip-hidden] [data-tab-strip="${pane}"]')?.closest('[data-strip-overlay]').getBoundingClientRect())`));

    // A click opens it, below the handle; the handle is still the handle.
    await move(hx, hy);
    await click(hx, hy);
    await sleep(150);
    assert.equal(await overlayShown(pane), true, 'a click on the handle did not bring the strip up');
    const box = await stripBox();
    assert.ok(box.top >= handle.bottom - 0.5, `the strip covers its own handle (strip top ${box.top}, handle bottom ${handle.bottom})`);
    assert.equal(await ev(`document.elementFromPoint(${hx}, ${hy})?.closest('[data-strip-handle]')?.dataset.stripHandle ?? null`), pane, 'something covers the handle');
    assert.equal(await ev(`document.querySelector('[data-strip-handle="${pane}"]').getAttribute('aria-expanded')`), 'true');
    // The handle again: closes it.
    await click(hx, hy);
    await sleep(150);
    assert.equal(await overlayShown(pane), false, 'a second click on the handle did not put the strip away');

    // Escape with the keyboard in the terminal is the program's: the strip stays.
    await click(Math.round(body.left + 100), Math.round(body.top + 300)); // the keyboard into the terminal
    await sleep(150);
    await click(hx, hy);
    await sleep(150);
    await ev(SPY);
    await key('Escape', 'Escape', 27, '\u001b');
    await sleep(200);
    assert.equal(await overlayShown(pane), true, 'Escape typed into the terminal closed the strip');
    let { calls } = await spied();
    assert.ok(calls.some(([c, d]) => c === 'pty_write' && d === '\u001b'), `Escape did not reach the program: ${JSON.stringify(calls)} (${session})`);

    // A press outside closes it (here: in the terminal).
    await click(Math.round(body.left + 100), Math.round(body.top + 300));
    await sleep(150);
    assert.equal(await overlayShown(pane), false, 'a press outside left the strip up');

    // The pointer coming onto it and leaving it closes it.
    await click(hx, hy);
    await sleep(150);
    await move(hx, Math.round(box.top + 10));
    await sleep(100);
    assert.equal(await overlayShown(pane), true, 'moving onto the strip closed it');
    await move(hx, Math.round(body.top + 300));
    await sleep(150);
    assert.equal(await overlayShown(pane), false, 'the pointer left the strip and it stayed');

    // Escape with the keyboard in the strip is the strip's, and goes no further.
    await ev(`document.querySelector('[data-strip-handle="${pane}"]').focus()`);
    await key('Enter', 'Enter', 13, '\r');
    await sleep(200);
    assert.equal(await overlayShown(pane), true);
    await ev(SPY);
    await key('Escape', 'Escape', 27, '\u001b');
    await sleep(200);
    assert.equal(await overlayShown(pane), false, 'Escape with the keyboard in the strip left it up');
    ({ calls } = await spied());
    assert.ok(!calls.some(([c]) => c === 'pty_write'), `the strip's Escape reached the program: ${JSON.stringify(calls)}`);
    assert.equal(await termSize(pane), size, 'the terminal was resized');
  });

  test('HS-06: two clicks on the handle at one spot — 80, 600 and 800 ms apart — activate nothing in the strip and leave it closed; a double-click leaves it open, activating nothing', async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane } = panes[1];
    const handle = await rectOf(`[data-strip-handle="${pane}"]`);
    assert.ok(handle, 'no handle');
    const y = Math.round(handle.top + handle.height / 2);
    // Over the right end, where the strip has its Close Pane button, and the left, its chip.
    for (const x of [Math.round(handle.right - 12), Math.round(handle.left + 30)]) {
      for (const gap of [80, 600, 800]) {
        await ev(SPY);
        await move(x, y);
        await click(x, y, 1);
        await sleep(gap);
        await click(x, y, 1);
        await sleep(250);
        const { clicks } = await spied();
        assert.ok(!clicks.some(([, where]) => where === 'strip'), `${gap} ms at x=${x}: a click landed on the strip: ${JSON.stringify(clicks)}`);
        assert.equal(await overlayShown(pane), false, `${gap} ms at x=${x}: the strip is up after two clicks on its handle`);
      }
      await ev(SPY);
      await dblclick(x, y);
      await sleep(250);
      const { clicks } = await spied();
      assert.ok(!clicks.some(([, where]) => where === 'strip'), `double-click at x=${x}: a click landed on the strip: ${JSON.stringify(clicks)}`);
      assert.equal(await overlayShown(pane), true, `a double-click at x=${x} toggled the strip twice`);
      await click(x, y, 1);
      await sleep(150);
    }
    assert.equal(await ev(`document.querySelectorAll('[data-pane-body]').length`), 2, 'a pane was closed');
  });

  test("HS-07: Enter and Escape finishing a tab's rename never reach the shell", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane } = panes[0];
    // A second terminal: this pane's strip is a real one now.
    await ev(`(async () => { const T = window.__nexterm.useTerminalStore.getState(); await T.createTab(null, { paneId: ${JSON.stringify(pane)}, groupId: T.getActiveGroup().id }); return true; })()`);
    await sleep(500);
    const chip = await rectOf(`[data-tab-strip="${pane}"] [data-tab-chip]`);
    assert.ok(chip, 'setup: no chip');
    await ev(SPY);
    await move(chip.left + 20, chip.top + chip.height / 2);
    await dblclick(Math.round(chip.left + 20), Math.round(chip.top + chip.height / 2));
    await sleep(200);
    assert.ok(await ev(`!!document.querySelector('[data-rename-input]')`), 'setup: the rename did not open');
    await ev(`document.activeElement.select?.()`);
    await typeText('build');
    await key('Enter', 'Enter', 13, '\r');
    await sleep(300);
    let { calls } = await spied();
    let writes = calls.filter(([c]) => c === 'pty_write');
    assert.deepEqual(writes, [], `Enter reached the shell: ${JSON.stringify(writes)}`);
    assert.ok(await ev(`window.__nexterm.useTerminalStore.getState().tabs.some((t) => t.title === 'build')`), 'not renamed');

    await ev(SPY);
    await dblclick(Math.round(chip.left + 20), Math.round(chip.top + chip.height / 2));
    await sleep(200);
    await key('Escape', 'Escape', 27);
    await sleep(300);
    ({ calls } = await spied());
    writes = calls.filter(([c]) => c === 'pty_write');
    assert.deepEqual(writes, [], `Escape reached the shell: ${JSON.stringify(writes)}`);
  });

  test("HS-08: a lock appearing on a chip moves nothing in the strip; its words are on the chip", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane } = panes[0];
    const tabs = JSON.parse(
      await ev(`(() => { const T = window.__nexterm.useTerminalStore.getState(); const leaves = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(leaves));
        const p = T.groups.flatMap((g) => leaves(g.tree)).find((l) => l.id === ${JSON.stringify(pane)});
        return JSON.stringify(p.tabIds.map((id) => [id, T.tabs.find((t) => t.id === id).sessionId])); })()`)
    );
    assert.ok(tabs.length >= 2, 'setup: the pane holds two terminals, its strip in line');
    const [first] = tabs;
    const place = () =>
      ev(`JSON.stringify([...document.querySelectorAll('[data-tab-strip="${pane}"] button, [data-tab-strip="${pane}"] [data-tab-chip]')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }))`);
    const before = await place();
    await ev(`window.__nexterm.mockBridge.setEcho(${JSON.stringify(first[1])}, true)`);
    await sleep(200);
    assert.ok(await ev(`!!document.querySelector('[data-tab-chip="${first[0]}"] [data-lock-mark]')`), 'no lock on the chip');
    assert.equal(await place(), before, 'a lock appearing moved the chips or their buttons');
    const style = await ev(`getComputedStyle(document.querySelector('[data-tab-chip="${first[0]}"] [data-lock-mark]')).pointerEvents`);
    assert.equal(style, 'none', 'the lock takes the pointer');
    const title = await ev(`document.querySelector('[data-tab-chip="${first[0]}"]').title`);
    assert.ok(title.includes('Typing is hidden (password prompt)'), `the chip's tooltip does not say it: ${title}`);
    await ev(`window.__nexterm.mockBridge.setEcho(${JSON.stringify(first[1])}, false)`);
  });

  test('HS-09: the handle by keyboard — Enter brings the strip up with the keyboard in it, Escape gives it back; a focused terminal keeps Tab', async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane, session } = panes[1];
    await ev(`document.querySelector('[data-strip-handle="${pane}"]').focus()`);
    await key('Enter', 'Enter', 13, '\r');
    await sleep(200);
    assert.equal(await overlayShown(pane), true, 'Enter on the handle did not bring the strip up');
    assert.ok(await ev(`!!document.activeElement?.closest('[data-strip-overlay]')`), 'the keyboard is not in the strip');
    await key('Escape', 'Escape', 27);
    await sleep(200);
    assert.equal(await overlayShown(pane), false, 'Escape left it up');
    assert.equal(await ev(`document.activeElement?.dataset?.stripHandle ?? null`), pane, 'the keyboard did not go back to the handle');
    // In the terminal, Tab is the shell's: it moves no focus to the handle.
    const body = await rectOf(`[data-pane-body="${pane}"]`);
    await click(Math.round(body.left + 100), Math.round(body.top + 200));
    await sleep(200);
    await ev(SPY);
    await key('Tab', 'Tab', 9, '\t');
    await sleep(200);
    assert.ok(await ev(`!!document.activeElement?.closest('.xterm')`), 'Tab took the keyboard out of the terminal');
    const { calls } = await spied();
    assert.ok(calls.some(([c, d]) => c === 'pty_write' && d === '\t'), `Tab did not reach the shell (${session}): ${JSON.stringify(calls)}`);
  });

  test("HS-10: the palette's Rename Terminal… on a hidden strip: the strip comes up for the rename, and Enter finishes it without reaching the shell", async () => {
    if (!harness) skip(NO_BROWSER);
    const { pane, tab } = panes[1];
    const body = await rectOf(`[data-pane-body="${pane}"]`);
    await click(Math.round(body.left + 100), Math.round(body.top + 200));
    await sleep(150);
    await ev(`window.__nexterm.useSettingsStore.getState().setCommandPaletteOpen(true, 'all')`);
    await sleep(200);
    await typeText('rename term');
    await sleep(100);
    await ev(SPY);
    await key('Enter', 'Enter', 13, '\r');
    await sleep(300);
    assert.ok(await ev(`!!document.querySelector('[data-pane-body="${pane}"]')?.closest('[data-strip-hidden]')?.querySelector('[data-rename-input]')`), 'no rename in the hidden strip');
    assert.equal(await overlayShown(pane), true, 'the rename is open and its strip is down');
    await ev(`document.activeElement.select?.()`);
    await typeText('server');
    await key('Enter', 'Enter', 13, '\r');
    await sleep(300);
    const { calls } = await spied();
    const writes = calls.filter(([c]) => c === 'pty_write');
    assert.deepEqual(writes, [], `a key reached the shell: ${JSON.stringify(writes)}`);
    assert.equal(await ev(`window.__nexterm.useTerminalStore.getState().tabs.find((t) => t.id === ${JSON.stringify(tab)}).title`), 'server');
    assert.equal(await overlayShown(pane), false, 'the strip stayed up after the rename');
  });

  test('HS-11: a tab dragged onto a hidden-strip pane: its strip comes up as a drop target, and the drop merges the tab in', async () => {
    if (!harness) skip(NO_BROWSER);
    const from = panes[0].pane; // two terminals, its strip in line
    const to = panes[1].pane;
    const chips = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-tab-strip="${from}"] [data-tab-chip]')].map((c) => [c.dataset.tabChip, c.getBoundingClientRect()]))`));
    const [movingId, r] = chips[chips.length - 1];
    const target = await rectOf(`[data-pane-body="${to}"]`);
    const start = { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
    const end = { x: Math.round(target.left + 80), y: Math.round(target.top + 8) };
    await move(start.x, start.y);
    await press(start.x, start.y);
    for (let i = 1; i <= 12; i += 1) {
      await mouse('mouseMoved', start.x + ((end.x - start.x) * i) / 12, start.y + ((end.y - start.y) * i) / 12, { button: 'left', buttons: 1 });
      await sleep(16);
    }
    await sleep(150);
    assert.equal(await overlayShown(to), true, 'no strip to drop on while dragging');
    await release(end.x, end.y);
    await sleep(300);
    const tabsThere = JSON.parse(await ev(`(() => { const T = window.__nexterm.useTerminalStore.getState(); const leaves = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(leaves)); return JSON.stringify(T.groups.flatMap((g) => leaves(g.tree)).find((l) => l.id === ${JSON.stringify(to)})?.tabIds ?? []); })()`));
    assert.ok(tabsThere.includes(movingId), `not merged: ${JSON.stringify(tabsThere)}`);
  });

  test('HS-12: the keyboard tabbing out of the opened strip puts it away', async () => {
    if (!harness) skip(NO_BROWSER);
    const pane = await ev(`document.querySelector('[data-strip-handle]')?.dataset.stripHandle ?? null`);
    assert.ok(pane, 'setup: no hidden strip left');
    await ev(`document.querySelector('[data-strip-handle="${pane}"]').focus()`);
    await key('Enter', 'Enter', 13, '\r');
    await sleep(200);
    assert.equal(await overlayShown(pane), true, 'setup: Enter did not open it');
    const inStrip = `!!(document.activeElement?.closest('[data-strip-overlay]') || document.activeElement?.closest('[data-strip-handle]'))`;
    for (let i = 0; i < 8 && (await ev(inStrip)); i += 1) {
      await key('Tab', 'Tab', 9);
      await sleep(120);
    }
    assert.equal(await ev(inStrip), false, 'setup: Tab never left the strip');
    await sleep(100);
    assert.equal(await overlayShown(pane), false, 'focus left the strip and it stayed over the terminal');
  });

  test('HS-13: the pane menu from the handle, dismissed by a click on row 1, leaves the keyboard in the terminal', async () => {
    if (!harness) skip(NO_BROWSER);
    const pane = await ev(`document.querySelector('[data-strip-handle]')?.dataset.stripHandle ?? null`);
    const body = await rectOf(`[data-pane-body="${pane}"]`);
    const handle = await rectOf(`[data-strip-handle="${pane}"]`);
    await click(Math.round(body.left + 100), Math.round(body.top + 300));
    await sleep(150);
    const hx = Math.round(handle.left + 80);
    await mouse('mousePressed', hx, Math.round(handle.top + 3), { button: 'right', buttons: 2, clickCount: 1 });
    await mouse('mouseReleased', hx, Math.round(handle.top + 3), { button: 'right', buttons: 0, clickCount: 1 });
    await sleep(250);
    assert.ok(await ev(`!!document.querySelector('[role="menu"]')`), 'setup: no pane menu');
    // The opened strip has no ✕: closing is in this menu.
    assert.ok(
      await ev(`[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.textContent.trim() === 'Close Terminal')`),
      "the handle's menu does not offer Close Terminal"
    );
    await click(Math.round(body.left + 40), Math.round(body.top + 12));
    await sleep(300);
    await ev(SPY);
    await key('x', 'KeyX', 88, 'x');
    await sleep(200);
    const { calls } = await spied();
    assert.ok(calls.some(([c, d]) => c === 'pty_write' && d === 'x'), `the key went nowhere (focus on ${await ev('document.activeElement?.tagName')}): ${JSON.stringify(calls)}`);
  });

  test('HS-14: touch — a tap on the handle opens the strip, a double-tap renames, a tap on its "+" works, and a lifting finger closes nothing', async () => {
    if (!harness) skip(NO_BROWSER);
    const pane = await ev(`document.querySelector('[data-strip-handle]')?.dataset.stripHandle ?? null`);
    assert.ok(pane, 'setup: no hidden strip left');
    await harness.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const tap = async (x, y) => {
      await harness.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await sleep(50);
      await harness.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    try {
      const handle = await rectOf(`[data-strip-handle="${pane}"]`);
      await tap(Math.round(handle.left + 60), Math.round(handle.top + 3));
      await sleep(400);
      assert.equal(await overlayShown(pane), true, 'a tap on the handle did not bring the strip up — or the finger lifting put it away');
      // Past the time in which a tap just below the handle counts as one
      // meant for it (stripReveal.js, `createStripClickGuard`).
      await sleep(400);
      // A double-tap on its chip renames it.
      const chip = await rectOf(`[data-strip-overlay] [data-tab-strip="${pane}"] [data-tab-chip]`);
      await tap(Math.round(chip.left + 20), Math.round(chip.top + chip.height / 2));
      await sleep(90);
      await tap(Math.round(chip.left + 20), Math.round(chip.top + chip.height / 2));
      await sleep(300);
      assert.ok(await ev(`!!document.querySelector('[data-strip-overlay] [data-rename-input]')`), 'a double-tap on the chip did not rename it');
      await key('Escape', 'Escape', 27);
      await sleep(200);
      // A tap on "+" makes a terminal.
      const before = await ev(`window.__nexterm.useTerminalStore.getState().tabs.length`);
      if (!(await overlayShown(pane))) {
        await tap(Math.round(handle.left + 60), Math.round(handle.top + 3));
        await sleep(800);
      }
      const plus = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-strip-overlay] [data-tab-strip="${pane}"] [data-chip-row] > button')].pop().getBoundingClientRect())`));
      await tap(Math.round(plus.left + plus.width / 2), Math.round(plus.top + plus.height / 2));
      await sleep(600);
      assert.equal(await ev(`window.__nexterm.useTerminalStore.getState().tabs.length`), before + 1, 'a tap on "+" made no terminal');
    } finally {
      await harness.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  });

  test("HS-15: the reviewer's second click and second tap just below the handle (t6: a double-click drifting 4 px; t7: a tap 10 px lower 600 ms on) activate nothing", async () => {
    if (!harness) skip(NO_BROWSER);
    // A fresh one-terminal pane: its strip hidden.
    await ev(`(async () => { await window.__nexterm.useTerminalStore.getState().splitActivePane('vertical'); return 1; })()`);
    await sleep(600);
    const pane = await ev(`[...document.querySelectorAll('[data-strip-handle]')].pop()?.dataset.stripHandle ?? null`);
    assert.ok(pane, 'setup: no hidden strip');
    const handle = await rectOf(`[data-strip-handle="${pane}"]`);
    const counts = () => ev(`JSON.stringify({ panes: document.querySelectorAll('[data-pane-body]').length, tabs: window.__nexterm.useTerminalStore.getState().tabs.length })`);
    // Over each of the strip's remaining controls in turn: its "+", Split and Zoom buttons, and its chip.
    const xs = JSON.parse(await ev(`(() => { const o = document.querySelector('[data-strip-hidden] [data-tab-strip="${pane}"]'); const r = [...o.querySelectorAll('button, [data-tab-chip]')].map((b) => b.getBoundingClientRect()); return JSON.stringify(r.map((b) => Math.round((b.left + b.right) / 2))); })()`));
    assert.ok(xs.length >= 3, `setup: the strip's controls: ${JSON.stringify(xs)}`);
    const before = await counts();
    const y = Math.round(handle.top + handle.height - 1);
    for (const x of xs) {
      await ev(SPY);
      // t6: a double-click on the handle whose second click lands 4 px lower.
      await move(x, y);
      await click(x, y, 1);
      await sleep(60);
      await move(x, y + 4);
      await click(x, y + 4, 2);
      await sleep(300);
      let { clicks } = await spied();
      assert.equal(await counts(), before, `t6 at x=${x}: something was made or closed: ${JSON.stringify(clicks)}`);
      // Put it away again from the handle, a while later.
      await sleep(600);
      if (await overlayShown(pane)) {
        await click(x, y, 1);
        await sleep(200);
      }
    }
    await harness.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const tap = async (x, ty) => {
      await harness.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: ty, radiusX: 1, radiusY: 1 }] });
      await sleep(60);
      await harness.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    try {
      for (const x of xs) {
        // t7: tap the handle, then 600 ms later a tap 10 px lower, meant for the handle too.
        await tap(x, Math.round(handle.top + 3));
        await sleep(600);
        await tap(x, Math.round(handle.top + 13));
        await sleep(400);
        assert.equal(await counts(), before, `t7 at x=${x}: something was made or closed`);
        await sleep(700);
        if (await overlayShown(pane)) {
          await tap(x, Math.round(handle.top + 3));
          await sleep(300);
        }
      }
    } finally {
      await harness.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  });

  test('HS-99: teardown — the server and the browser session are gone', async () => {
    if (!harness) skip(NO_BROWSER);
    assert.deepEqual(harness.pageErrors(), [], 'the page threw');
    harness.teardown();
    harness = null;
  });
});
