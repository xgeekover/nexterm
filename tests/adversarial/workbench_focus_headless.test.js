/**
 * The keyboard follows the active pane, in a real browser (editor placement,
 * sibling C2, FC14 / C1 review M-01; AC-C16): the app's own workbench with
 * real terminals and real Monaco under headless Chromium, the app's keyboard
 * layer (useKeybindings) mounted beside it, and keys pressed as Chromium
 * delivers them (raw CDP `Input.dispatchKeyEvent`). Drives
 * tests/adversarial/fixtures/workbench_harness.html.
 *
 * At C1 (2627549) Focus Next/Previous Pane and a zoom changed only the
 * store: the line moved to the file pane, but the xterm textarea kept the
 * keyboard, and what was typed next went to the shell.
 *
 *   - WF-02: a terminal focused by a click, Focus Next Pane onto the file
 *     pane, then typing: the keyboard is inside that pane's Monaco, the text
 *     is in the file's model and never reached the PTY. Focus Next Pane back:
 *     the xterm has the keyboard and what is typed reaches the PTY, not the
 *     file.
 *   - WF-03: the same with Focus Previous Pane.
 *   - WF-04: Toggle Pane Zoom from the keyboard on the focused terminal (the
 *     pane remounts): the xterm still has the keyboard, zoomed and unzoomed.
 *     Then the file pane, zoomed and unzoomed from the menu (its chord is
 *     Monaco's own inside Monaco, `toggle-pane-zoom` passThrough): its
 *     editor remounts each time and has the keyboard again.
 *   - WF-05 (AC-C11's real-browser part): a terminal pane beside a file pane
 *     keeps its prompt marks, its hidden single-tab strip's handle and its
 *     attention ring.
 *   - WF-07, WF-08 (C2 review N-01): Move Editor to New Pane Right run from
 *     the app's own command palette, opened from a terminal and from Monaco:
 *     the keyboard is in the new pane's editor, and what is typed goes into
 *     its file. At cycle 1 it stayed in the xterm, or in the old pane's
 *     editor, while the new pane was THE active one.
 *   - WF-09 (C2 review N-04): the same from a file chip's right-click menu.
 *   - WF-11 (C2 review S-01): Toggle Pane Zoom run from the palette, opened
 *     from Monaco, zooming and then unzooming the file pane: its editor
 *     remounts each time and has the keyboard again, and what is typed goes
 *     into its file. At cycle 2 the keyboard ended on the page body.
 *   - WF-12 (C2 review S-01): Swap Pane With… from the palette, opened in a
 *     focused file pane, onto the terminal pane: the files take the
 *     terminal pane's place as THE active pane, and the keyboard and what is
 *     typed follow them. At cycle 2 the keyboard ended on the page body.
 *   - WF-10 (C2 review N-02): the EditorPanel chunk held back (CDP `Fetch`)
 *     on a fresh page, Focus Next onto the file pane and back to the
 *     terminal, then the chunk let through: the keyboard stays in the xterm
 *     as Monaco mounts. At cycle 1 the file pane's focus request was still
 *     there, and Monaco took the keyboard from the shell.
 *   - Every case: no exception thrown in the page and left uncaught.
 *
 * Needs agent-browser, and a Node with a global WebSocket (22 and later):
 * skipped without either, saying which. WF-01 and WF-06 are setup and
 * teardown, as cases; WF-10 reloads the page, so it runs last before WF-06.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NOT_INSTALLED = 'agent-browser is not installed — the real-browser focus checks run locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_HARNESS = 'the harness did not start: see WF-01';
const A = '/workspace/a.js';

let harness = null;
let unavailable = null;
let ids = null;
let isMac = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn, ...args) => harness.evalJs(`window.__w.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
const mouse = (type, x, y, extra = {}) =>
  harness.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', pointerType: 'mouse', ...extra });

function needHarness() {
  if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
  if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
  if (unavailable) skip(unavailable);
  if (!harness) skip(NO_HARNESS);
}

/** Waits for `check`; on time-out fails with `what` and where the keyboard and the active pane are. */
async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      const { activePane, zoomedPaneId } = await call('state');
      throw new Error(`${what}: focus ${JSON.stringify(await call('focused'))}, active pane ${activePane}, zoomed ${zoomedPaneId}`);
    }
    await sleep(40);
  }
  await sleep(60);
}

// CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
const MOD = () => (isMac ? 4 : 2);
const KEYS = {
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
};

/** A chord, pressed and let go: `name` from KEYS with the CDP `modifiers` bits. */
async function chord(name, modifiers) {
  const k = KEYS[name];
  await harness.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k });
  await harness.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
  await sleep(120);
}
const focusNext = () => chord('right', MOD() | 1);
const focusPrevious = () => chord('left', MOD() | 1);
const zoomKey = () => chord('enter', MOD() | 8);

/** Lower-case letters typed one key at a time, as a hand types them. */
async function typeKeys(text) {
  for (const ch of text) {
    const k = { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
    await harness.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...k });
    await harness.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }
  await sleep(150);
}

const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

/** The group back to [a.js above | t2 below], the terminal clicked: the keyboard in its xterm. */
async function terminalFocused(where) {
  await call('mixed');
  await until(async () => (await call('shown', A)) && (await call('xterm', ids.t2)).connected, `${where}: the panes never drew`);
  const at = mid(await call('body', 'terminal', ids.terminalPane));
  await mouse('mouseMoved', at.x, at.y);
  await mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 1 });
  await until(async () => {
    const f = await call('focused');
    return f.inXterm && f.paneId === ids.terminalPane && (await call('state')).activePane === ids.terminalPane;
  }, `${where}: a click did not give the terminal the keyboard`);
}

/** The keyboard is in the file pane's Monaco, and what is typed is in a.js's model, not in the shell. */
async function typesIntoFile(where, text) {
  await until(async () => (await call('state')).activePane === ids.editorPane, `${where}: the file pane did not become the active pane`);
  await until(async () => {
    const f = await call('focused');
    return f.inMonaco && f.paneKind === 'editor' && f.paneId === ids.editorPane;
  }, `${where}: the keyboard did not follow the active pane into the file pane's editor`);
  await typeKeys(text);
  assert.ok((await call('text', A)).includes(text), `${where}: "${text}" is not in a.js`);
  assert.equal((await call('written', ids.t2)).includes(text), false, `${where}: "${text}" reached the shell`);
}

/** The ids of the group's file panes, in tree order. */
function editorPaneIds(node, acc = []) {
  if (node?.type === 'leaf') {
    if (node.kind === 'editor') acc.push(node.id);
  } else node?.children?.forEach((c) => editorPaneIds(c, acc));
  return acc;
}

function leafById(node, id) {
  if (node?.type === 'leaf') return node.id === id ? node : null;
  for (const c of node?.children ?? []) {
    const found = leafById(c, id);
    if (found) return found;
  }
  return null;
}

/** The path of the file a tab of setup's is (`ids.a` is a.js). */
const pathOfTab = (tabId) => `/workspace/${'abcd'.split('').find((n) => ids[n] === tabId)}.js`;

/** Clicks into the file pane's editor: the keyboard there, the file pane THE active pane. */
async function editorFocused(where) {
  await call('mixed');
  await until(async () => (await call('shown', A)) && (await call('xterm', ids.t2)).connected, `${where}: the panes never drew`);
  const at = mid(await call('body', 'editor', ids.editorPane));
  await mouse('mouseMoved', at.x, at.y);
  await mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 1 });
  await until(async () => {
    const f = await call('focused');
    return f.inMonaco && f.paneId === ids.editorPane && (await call('state')).activePane === ids.editorPane;
  }, `${where}: a click did not give the file pane's editor the keyboard`);
}

/** The app's palette opened where the keyboard is, `title` typed and run with Enter. */
async function runFromPalette(where, title) {
  await call('palette');
  await until(async () => (await call('paletteState')).inputFocused, `${where}: the palette's search box never took the keyboard`);
  await harness.send('Input.insertText', { text: title });
  await until(async () => (await call('paletteState')).first === title, `${where}: "${title}" is not the palette's first row`);
  await chord('enter', 0);
  await until(async () => !(await call('paletteState')).open, `${where}: the palette did not close`);
}

/**
 * A file pane that was not in `before` became THE active pane, its editor
 * has the keyboard, and what is typed goes into its file and not the shell.
 * Returns that pane's leaf.
 */
async function keyboardInNewPane(where, before, text) {
  let fresh = null;
  await until(async () => {
    const s = await call('state');
    fresh = editorPaneIds(s.tree).find((id) => !before.includes(id)) ?? null;
    return fresh != null && s.activePane === fresh;
  }, `${where}: no new file pane became THE active pane`);
  await until(async () => {
    const f = await call('focused');
    return f.inMonaco && f.paneKind === 'editor' && f.paneId === fresh;
  }, `${where}: the keyboard did not go to the new pane's editor`);
  const leaf = leafById((await call('state')).tree, fresh);
  const path = pathOfTab(leaf.tabIds[0]);
  await typeKeys(text);
  assert.ok((await call('text', path)).includes(text), `${where}: "${text}" is not in ${path}, the file the new pane shows`);
  assert.equal((await call('written', ids.t2)).includes(text), false, `${where}: "${text}" reached the shell`);
  return leaf;
}

/** The keyboard is in t2's xterm, and what is typed reaches the PTY, not the file. */
async function typesIntoShell(where, text) {
  await until(async () => (await call('state')).activePane === ids.terminalPane, `${where}: the terminal pane did not become the active pane`);
  await until(async () => {
    const f = await call('focused');
    return f.inXterm && f.paneId === ids.terminalPane;
  }, `${where}: the keyboard did not follow the active pane into the terminal`);
  await typeKeys(text);
  await until(async () => (await call('written', ids.t2)).includes(text), `${where}: "${text}" never reached the PTY`);
  assert.equal((await call('text', A)).includes(text), false, `${where}: "${text}" went into a.js`);
}

describe('The keyboard follows the active pane, under headless Chromium (CDP)', () => {
  test('WF-01: setup — the harness page with the keyboard layer, four terminals and four files', async () => {
    if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
    if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
    try {
      harness = await openHarness('tests/adversarial/fixtures/workbench_harness.html', {
        prefix: 'workbench-focus-headless',
        session: `workbench-focus-headless-${process.pid}`,
        readyExpression: 'window.__w ? window.__w.ready === true : false',
      });
    } catch (err) {
      if (err instanceof BrowserUnavailable) {
        unavailable = `the browser could not start (${err.message})`;
        skip(unavailable);
      }
      throw err;
    }
    await harness.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await harness.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
    ids = await call('setup');
    isMac = await harness.evalJs('window.__w.isMac');
    await until(async () => (await call('shown', A)) && (await call('holdXterm', ids.t2)), 'a.js and t2 never drew', 15000);
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-02: Focus Next Pane from a terminal onto a file pane and back — the keyboard goes with it', async () => {
    needHarness();
    await terminalFocused('WF-02');
    await focusNext();
    await typesIntoFile('WF-02 next onto the file', 'zq');
    await focusNext();
    await typesIntoShell('WF-02 next back onto the terminal', 'kx');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-03: Focus Previous Pane, the same both ways', async () => {
    needHarness();
    await terminalFocused('WF-03');
    await focusPrevious();
    await typesIntoFile('WF-03 previous onto the file', 'jv');
    await focusPrevious();
    await typesIntoShell('WF-03 previous back onto the terminal', 'hb');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-04: a zoom — the terminal from the keyboard, the file pane from the menu — keeps the keyboard in the pane zoomed', async () => {
    needHarness();
    await terminalFocused('WF-04');
    await zoomKey();
    await until(async () => (await call('state')).zoomedPaneId === ids.terminalPane, 'WF-04: the keyboard zoom did not zoom the terminal');
    await typesIntoShell('WF-04 terminal zoomed', 'mw');
    await zoomKey();
    await until(async () => (await call('state')).zoomedPaneId === null, 'WF-04: the keyboard zoom did not unzoom');
    await typesIntoShell('WF-04 terminal unzoomed', 'ny');

    await focusNext();
    await typesIntoFile('WF-04 next onto the file', 'pu');
    await call('menu', 'toggle-pane-zoom');
    await until(async () => (await call('state')).zoomedPaneId === ids.editorPane, 'WF-04: the menu did not zoom the file pane');
    await typesIntoFile('WF-04 file zoomed (its editor remounted)', 'gc');
    await call('menu', 'toggle-pane-zoom');
    await until(async () => (await call('state')).zoomedPaneId === null, 'WF-04: the menu did not unzoom the file pane');
    await typesIntoFile('WF-04 file unzoomed (remounted again)', 'fd');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  // AC-C11's real-browser part (FC12): beside an editor pane, a terminal
  // pane keeps what it draws of its own — prompt marks on its scrollbar, the
  // hidden single-tab strip's handle, the attention ring for unread output.
  test('WF-05: a terminal pane beside a file pane keeps its prompt marks, its hidden-strip handle and its attention ring', async () => {
    needHarness();
    await call('setting', 'terminalHideSingleTabStrip', true);
    await call('layout', {
      type: 'split', id: 'split-wf-features', direction: 'horizontal', sizes: [50, 50],
      children: [
        { type: 'leaf', kind: 'editor', id: ids.editorPane, tabIds: [ids.a], activeTabId: ids.a },
        { type: 'leaf', id: ids.terminalPane, tabIds: [ids.t2], activeTabId: ids.t2 },
      ],
    });
    await until(async () => (await call('shown', A)) && (await call('xterm', ids.t2)).connected, 'WF-05: the panes never drew');
    // The file pane is THE active pane: the terminal's unread output rings it.
    const at = mid(await call('body', 'editor', ids.editorPane));
    await mouse('mouseMoved', at.x, at.y);
    await mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 1 });
    await until(async () => (await call('state')).activePane === ids.editorPane, 'WF-05: the file pane did not become active');

    const before = await call('marks', ids.t2);
    const after = await call('prompt', ids.t2, 'C:\\work>dir\r\n file.txt\r\nC:\\work>');
    assert.ok(after.lines.length > before.lines.length, `WF-05: no prompt mark was made (${JSON.stringify(after)})`);
    assert.ok(after.painted > 0, 'WF-05: the marks are not painted on the scrollbar');

    await until(async () => (await call('terminalFeatures', ids.terminalPane)).handle, 'WF-05: the hidden single-tab strip has no handle beside a file pane');
    await call('notify', ids.t2);
    await until(async () => (await call('terminalFeatures', ids.terminalPane)).ring.includes('unread'), 'WF-05: no attention ring on the terminal pane');
    await call('setting', 'terminalHideSingleTabStrip', false);
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-07: Move Editor to New Pane Right from the palette, opened from a terminal — the keyboard goes to the new pane', async () => {
    needHarness();
    await terminalFocused('WF-07');
    const before = editorPaneIds((await call('state')).tree);
    await runFromPalette('WF-07', 'Move Editor to New Pane Right');
    await keyboardInNewPane('WF-07', before, 'wq');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-08: Move Editor to New Pane Right from the palette, opened from Monaco — the keyboard goes to the new pane, with the file it showed', async () => {
    needHarness();
    await editorFocused('WF-08');
    const before = editorPaneIds((await call('state')).tree);
    await runFromPalette('WF-08', 'Move Editor to New Pane Right');
    const leaf = await keyboardInNewPane('WF-08', before, 'ok');
    assert.deepEqual(leaf.tabIds, [ids.a], 'WF-08: a.js, the file the old pane showed, is the one moved');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-09: Move Editor to New Pane Down from a file chip\u{2019}s right-click menu — the keyboard goes to the new pane', async () => {
    needHarness();
    await terminalFocused('WF-09');
    const before = editorPaneIds((await call('state')).tree);
    const at = mid(await call('chip', 'editor', ids.b));
    await mouse('mouseMoved', at.x, at.y);
    await mouse('mousePressed', at.x, at.y, { button: 'right', buttons: 2, clickCount: 1 });
    await mouse('mouseReleased', at.x, at.y, { button: 'right', buttons: 0, clickCount: 1 });
    const label = 'Move Editor to New Pane Down';
    await until(async () => (await call('menuItem', label)) != null, `WF-09: the chip's menu has no "${label}"`);
    const item = mid(await call('menuItem', label));
    await mouse('mouseMoved', item.x, item.y);
    await mouse('mousePressed', item.x, item.y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', item.x, item.y, { button: 'left', buttons: 0, clickCount: 1 });
    const leaf = await keyboardInNewPane('WF-09', before, 'ej');
    assert.deepEqual(leaf.tabIds, [ids.b], 'WF-09: b.js, the chip\u{2019}s file, is the one moved');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-11: Toggle Pane Zoom from the palette, opened from Monaco — the zoomed and the unzoomed file pane keep the keyboard', async () => {
    needHarness();
    await editorFocused('WF-11');
    await runFromPalette('WF-11 zoom', 'Toggle Pane Zoom');
    await until(async () => (await call('state')).zoomedPaneId === ids.editorPane, 'WF-11: the palette did not zoom the file pane');
    await typesIntoFile('WF-11 file zoomed from the palette (its editor remounted)', 'ti');
    await runFromPalette('WF-11 unzoom', 'Toggle Pane Zoom');
    await until(async () => (await call('state')).zoomedPaneId === null, 'WF-11: the palette did not unzoom the file pane');
    await typesIntoFile('WF-11 file unzoomed from the palette (remounted again)', 'rl');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-12: Swap Pane With\u{2026} from the palette, opened in a focused file pane, onto the terminal pane — the keyboard goes with the file', async () => {
    needHarness();
    await editorFocused('WF-12');
    const title = 'Swap Pane With\u{2026}';
    await call('palette');
    await until(async () => (await call('paletteState')).inputFocused, 'WF-12: the palette\u{2019}s search box never took the keyboard');
    await harness.send('Input.insertText', { text: 'Swap Pane With' });
    await until(async () => (await call('paletteState')).first === title, `WF-12: "${title}" is not the palette's first row`);
    await chord('enter', 0);
    // The pick: the group's one other pane, the terminal pane.
    await until(async () => {
      const p = await call('paletteState');
      return p.open && p.first != null && p.first !== title;
    }, 'WF-12: the palette did not offer the terminal pane to swap with');
    await chord('enter', 0);
    await until(async () => !(await call('paletteState')).open, 'WF-12: the palette did not close');
    // The files moved into the terminal pane's place, and THE active pane went with them.
    await until(async () => {
      const s = await call('state');
      return leafById(s.tree, ids.terminalPane)?.kind === 'editor' && s.activePane === ids.terminalPane;
    }, 'WF-12: the files did not move into the terminal pane\u{2019}s place as THE active pane');
    await until(async () => {
      const f = await call('focused');
      return f.inMonaco && f.paneKind === 'editor' && f.paneId === ids.terminalPane;
    }, 'WF-12: the keyboard did not follow the file pane to its new place');
    await typeKeys('sa');
    assert.ok((await call('text', A)).includes('sa'), 'WF-12: "sa" is not in a.js, the file the moved pane shows');
    assert.equal((await call('written', ids.t2)).includes('sa'), false, 'WF-12: "sa" reached the shell');
    assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
  });

  test('WF-10: the EditorPanel chunk held back — Focus Next onto the file pane and back before Monaco mounts: the keyboard stays in the terminal as it mounts', async () => {
    needHarness();
    const paused = [];
    const stop = harness.onEvent('Fetch.requestPaused', (p) => paused.push(p.requestId));
    const release = async () => {
      while (paused.length > 0) await harness.send('Fetch.continueRequest', { requestId: paused.shift() }).catch(() => {});
    };
    try {
      await harness.send('Fetch.enable', { patterns: [{ urlPattern: '*EditorPanel.jsx*', requestStage: 'Request' }] });
      // A fresh page: this one loaded the chunk in WF-01, and keeps it.
      await harness.evalJs('window.__wfOldPage = true');
      await harness.send('Page.reload', { ignoreCache: true });
      await until(async () => {
        try {
          return await harness.evalJs('!window.__wfOldPage && Boolean(window.__w && window.__w.ready === true)');
        } catch {
          return false;
        }
      }, 'WF-10: the reloaded harness never got ready', 15000);
      await harness.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      ids = await call('setup');
      await until(async () => paused.length > 0, 'WF-10: the EditorPanel chunk was never asked for');
      await until(async () => (await call('xterm', ids.t2)).connected, 'WF-10: the terminal never drew');
      assert.equal(await call('shown', A), false, 'setup: the file pane has no Monaco yet');

      const at = mid(await call('body', 'terminal', ids.terminalPane));
      await mouse('mouseMoved', at.x, at.y);
      await mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
      await mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 1 });
      await until(async () => (await call('focused')).inXterm, 'WF-10: a click did not give the terminal the keyboard');

      await focusNext();
      await until(async () => (await call('state')).activePane === ids.editorPane, 'WF-10: Focus Next did not reach the file pane');
      assert.equal((await call('focused')).inXterm, false, 'WF-10: the shell let go of the keyboard on the file pane');
      await focusNext();
      await until(async () => {
        const f = await call('focused');
        return f.inXterm && f.paneId === ids.terminalPane && (await call('state')).activePane === ids.terminalPane;
      }, 'WF-10: Focus Next back did not give the terminal the keyboard');

      await release();
      await until(async () => call('shown', A), 'WF-10: the file never drew once the chunk was let through', 15000);
      await sleep(500);
      const f = await call('focused');
      assert.ok(f.inXterm && f.paneId === ids.terminalPane, `WF-10: Monaco took the keyboard from the shell as it mounted: ${JSON.stringify(f)}`);
      await typesIntoShell('WF-10 after Monaco mounted', 'yk');
      assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
    } finally {
      stop();
      await release();
      await harness.send('Fetch.disable').catch(() => {});
    }
  });

  test('WF-06: teardown', () => {
    if (!harness) skip(unavailable ?? NO_HARNESS);
    harness.teardown();
    harness = null;
  });
});
