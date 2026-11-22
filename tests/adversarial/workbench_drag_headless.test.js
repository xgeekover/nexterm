/**
 * One drag for both kinds of tab, and the pixel minimums, in a real browser
 * (editor placement, sibling C, FC3 and FC7; AC-C4): the app's own workbench
 * with real terminals and real Monaco under headless Chromium, the mouse as
 * Chromium delivers it (raw CDP `Input.dispatchMouseEvent`, so real pointer
 * events). Drives tests/adversarial/fixtures/workbench_harness.html.
 *
 *   - WG-02: a file's chip dragged onto each edge of a terminal pane. While
 *     held there the indicator shows that edge, over that pane; let go, the
 *     file is alone in a new pane on that side, the terminal's `.xterm` node
 *     is the very node it was (the pane may remount, the terminal does not),
 *     and the file's Monaco model is the one it had, still able to undo.
 *   - WG-03: a terminal's chip dragged onto each edge of a file pane: the
 *     same, the other way.
 *   - WG-04: in a 1024 x 640 window, six panes of both kinds in a line, each
 *     stored far below its minimum, are drawn no narrower than PANE_MIN_PX
 *     gives them (FC7), and nothing logs a layout error.
 *   - WG-05: nested splits of both kinds, and a column of eight panes the
 *     space cannot hold at full minimums: every pane gets its minimum scaled
 *     to the space (`minSharesOf`), the layout renders, and nothing logs a
 *     layout error.
 *   - Every case: no exception thrown in the page and left uncaught.
 *
 * Needs agent-browser, and a Node with a global WebSocket (22 and later) for
 * the CDP session: skipped without either, or when the browser cannot start,
 * saying which. WG-01 and WG-06 are setup and teardown, as cases; teardown
 * also runs from `process.on('exit')`.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { HEADLESS_AVAILABLE, BrowserUnavailable, openHarness } from './headless_browser.js';

const NOT_INSTALLED = 'agent-browser is not installed — the real-browser drag checks run locally only';
const NO_WEBSOCKET = 'this Node has no global WebSocket (Node 22 and later have one), which the CDP session needs';
const NO_HARNESS = 'the harness did not start: see WG-01';
const EDGES = ['left', 'right', 'top', 'bottom'];
const WIDTH = 1024;
const HEIGHT = 640;
/** Layout rounding: a pane's box against the pixels its share gives it. */
const SLACK_PX = 1.5;

let harness = null;
let unavailable = null;
let ids = null;

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

function assertNoPageErrors() {
  assert.deepEqual(harness.pageErrors(), [], 'no exception thrown in the page');
}

/** Anything the page logged about a layout: what react-resizable-panels says of one it refuses. */
async function assertNoLayoutErrors(where) {
  const logs = await call('logs');
  const bad = logs.filter((line) => /layout|panel|constraint|minSize|defaultSize/i.test(line));
  assert.deepEqual(bad, [], `${where}: the page logged a layout error`);
}

async function until(check, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(await call('state'))}`);
    await sleep(50);
  }
  await sleep(80);
}

const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
function nearEdge(r, edge, inset = 10) {
  const { x, y } = mid(r);
  return {
    left: { x: r.left + inset, y },
    right: { x: r.right - inset, y },
    top: { x, y: r.top + inset },
    bottom: { x, y: r.bottom - inset },
  }[edge];
}
function parentOf(node, id) {
  if (!node || node.type !== 'split') return null;
  for (const child of node.children) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}
const leavesOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leavesOf(c, acc));
  return acc;
};

/**
 * Press at `from`, move to `to` a few pixels a step as a hand does, hold,
 * read the indicator, let go. Returns the indicator shown while held.
 */
async function drag(from, to, steps = 14) {
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: 'left', buttons: 1 });
    await sleep(16);
  }
  await sleep(150);
  const shown = await call('indicator');
  await mouse('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  return shown;
}

/** The pane on `edge`'s side of `id`, in the split that holds it, or null. */
function besideOn(tree, id, edge) {
  const split = parentOf(tree, id);
  if (!split) return { split: null, fresh: null };
  const at = split.children.findIndex((c) => c.id === id);
  return { split, fresh: split.children[edge === 'left' || edge === 'top' ? at - 1 : at + 1] ?? null };
}

/** Every split's children against the floors the pixel minimums give them. */
async function assertFloors(where) {
  const splits = await call('splits');
  assert.ok(splits.length > 0, `${where}: no split on screen`);
  for (const split of splits) {
    assert.ok(split.length > 0, `${where}: split ${split.id} measured no length`);
    for (const child of split.children) {
      assert.ok(child.size != null, `${where}: ${child.id} is not on screen`);
      assert.ok(
        child.size >= child.floor - SLACK_PX,
        `${where}: ${child.id} is ${child.size.toFixed(1)}px along ${split.direction}, under its floor ${child.floor.toFixed(1)}px (split ${split.id}, ${split.length}px, stored ${JSON.stringify(split.stored)})`
      );
    }
  }
  return splits;
}

const leaf = (id, tabIds, kind = null) => ({ type: 'leaf', ...(kind ? { kind } : {}), id, tabIds, activeTabId: tabIds[0] });
const split = (id, direction, children, sizes) => ({ type: 'split', id, direction, children, sizes });

describe('Workbench drag and pixel minimums, under headless Chromium (CDP)', () => {
  test('WG-01: setup — the scratch vite server, the harness page in a 1024 x 640 window, four terminals and four files', async () => {
    if (!HEADLESS_AVAILABLE) skip(NOT_INSTALLED);
    if (typeof WebSocket !== 'function') skip(NO_WEBSOCKET);
    try {
      harness = await openHarness('tests/adversarial/fixtures/workbench_harness.html', {
        prefix: 'workbench-drag-headless',
        session: `workbench-drag-headless-${process.pid}`,
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
    await harness.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    ids = await call('setup');
    await until(async () => (await call('shown', '/workspace/a.js')) && (await call('holdXterm', ids.t2)), 'a.js and t2 never drew');
    // An edit in each file the drags move, so that each model has an undo step to keep.
    for (const path of ['/workspace/a.js']) {
      await call('type', path, '/*held*/');
      assert.equal(await call('holdModel', path), true);
    }
    assert.equal((await call('model', '/workspace/a.js')).canUndo, true);
    assertNoPageErrors();
  });

  test('WG-02: a file\'s chip dragged onto each edge of a terminal pane — the indicator, the tree, the same .xterm node, the same model', async () => {
    needHarness();
    for (const edge of EDGES) {
      await call('mixed');
      await until(async () => (await call('shown', '/workspace/a.js')) && (await call('xterm', ids.t2)).connected, `${edge}: the panes never drew`);
      assert.equal(await call('holdXterm', ids.t2), true, `${edge}: t2 has no .xterm node`);
      const from = mid(await call('chip', 'editor', ids.a));
      const to = nearEdge(await call('body', 'terminal', ids.terminalPane), edge);
      const shown = await drag(from, to);
      assert.ok(shown, `${edge}: no indicator while a.js was held over the terminal`);
      assert.deepEqual(
        { zone: shown.zone, paneId: shown.paneId, paneKind: shown.paneKind, count: shown.count },
        { zone: edge, paneId: ids.terminalPane, paneKind: 'terminal', count: 1 },
        `${edge}: the indicator did not show that edge of the terminal pane (${shown.label})`
      );
      await until(async () => (await call('shown', '/workspace/a.js')) && (await call('xterm', ids.t2)).connected, `${edge}: the panes never drew again`);
      const { tree, activePane } = await call('state');
      const { split: around, fresh } = besideOn(tree, ids.terminalPane, edge);
      assert.ok(around, `${edge}: the terminal pane is not in a split`);
      assert.equal(around.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', `${edge}: the split goes the wrong way`);
      assert.ok(fresh && fresh.kind === 'editor', `${edge}: no file pane on that side of the terminal: ${JSON.stringify(tree)}`);
      assert.deepEqual(fresh.tabIds, [ids.a], `${edge}: a.js is not alone in the new pane`);
      assert.equal(activePane, fresh.id, `${edge}: the new pane is not the active one`);
      const xterm = await call('xterm', ids.t2);
      assert.deepEqual(xterm, { same: true, connected: true, pane: ids.terminalPane }, `${edge}: t2's .xterm node was replaced or left its pane`);
      const model = await call('model', '/workspace/a.js');
      assert.equal(model.same, true, `${edge}: a.js's model was replaced`);
      assert.equal(model.canUndo, true, `${edge}: a.js's model lost its undo`);
      assert.equal(model.editors, 1, `${edge}: a.js is not shown once`);
    }
    assertNoPageErrors();
    await assertNoLayoutErrors('WG-02');
  });

  test('WG-03: a terminal\'s chip dragged onto each edge of a file pane — the indicator, the tree, the same .xterm node, the same model', async () => {
    needHarness();
    for (const edge of EDGES) {
      await call('mixed');
      await until(async () => (await call('shown', '/workspace/a.js')) && (await call('xterm', ids.t2)).connected, `${edge}: the panes never drew`);
      assert.equal(await call('holdXterm', ids.t2), true, `${edge}: t2 has no .xterm node`);
      const from = mid(await call('chip', 'terminal', ids.t2));
      const to = nearEdge(await call('body', 'editor', ids.editorPane), edge);
      const shown = await drag(from, to);
      assert.ok(shown, `${edge}: no indicator while t2 was held over the file pane`);
      assert.deepEqual(
        { zone: shown.zone, paneId: shown.paneId, paneKind: shown.paneKind, count: shown.count },
        { zone: edge, paneId: ids.editorPane, paneKind: 'editor', count: 1 },
        `${edge}: the indicator did not show that edge of the file pane (${shown.label})`
      );
      await until(async () => (await call('shown', '/workspace/a.js')) && (await call('xterm', ids.t2)).connected, `${edge}: the panes never drew again`);
      const { tree, activePane, activePaneId } = await call('state');
      const { split: around, fresh } = besideOn(tree, ids.editorPane, edge);
      assert.ok(around, `${edge}: the file pane is not in a split`);
      assert.equal(around.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', `${edge}: the split goes the wrong way`);
      assert.ok(fresh && fresh.kind !== 'editor', `${edge}: no terminal pane on that side of the file pane: ${JSON.stringify(tree)}`);
      assert.deepEqual(fresh.tabIds, [ids.t2], `${edge}: t2 is not alone in the new pane`);
      assert.equal(activePane, fresh.id, `${edge}: the new pane is not the active one`);
      assert.equal(activePaneId, fresh.id, `${edge}: the new pane is not the active terminal pane`);
      const xterm = await call('xterm', ids.t2);
      assert.deepEqual(xterm, { same: true, connected: true, pane: fresh.id }, `${edge}: t2's .xterm node was replaced, or is not in its new pane`);
      const model = await call('model', '/workspace/a.js');
      assert.equal(model.same, true, `${edge}: a.js's model was replaced`);
      assert.equal(model.canUndo, true, `${edge}: a.js's model lost its undo`);
    }
    assertNoPageErrors();
    await assertNoLayoutErrors('WG-03');
  });

  test('WG-04: 1024 x 640, six panes of both kinds in a line stored far under their minimums — none drawn under PANE_MIN_PX', async () => {
    needHarness();
    await call(
      'layout',
      split(
        'split-wh-line',
        'horizontal',
        [
          leaf(ids.editorPane, [ids.a], 'editor'),
          leaf(ids.terminalPane, [ids.t1]),
          leaf('pane-wh-e2', [ids.b], 'editor'),
          leaf('pane-wh-t2', [ids.t2]),
          leaf('pane-wh-e3', [ids.c, ids.d], 'editor'),
          leaf('pane-wh-t3', [ids.t3, ids.t4]),
        ],
        [4, 4, 4, 4, 4, 80]
      )
    );
    await until(async () => (await call('leafBoxes')).every((l) => l.box && l.box.width > 0), 'the six panes never drew');
    await sleep(300);
    const { tree } = await call('state');
    assert.equal(leavesOf(tree).length, 6, `the store did not keep six panes: ${JSON.stringify(tree)}`);
    const [line] = await assertFloors('six in a line');
    assert.ok(line.length > 6 * 120, `the line is only ${line.length}px wide`);
    // The space holds every minimum here, so each floor is the documented one, unscaled.
    for (const box of await call('leafBoxes')) {
      const min = box.kind === 'editor' ? 160 : 120;
      assert.ok(box.box.width >= min - SLACK_PX, `${box.id} (${box.kind}) is ${box.box.width.toFixed(1)}px wide, under ${min}px`);
    }
    assertNoPageErrors();
    await assertNoLayoutErrors('WG-04');
  });

  test('WG-05: nested splits of both kinds, and a column the space cannot hold — every pane at its scaled minimum, no layout error', async () => {
    needHarness();
    await call(
      'layout',
      split(
        'split-wh-nested',
        'vertical',
        [
          split('split-wh-top', 'horizontal', [leaf(ids.editorPane, [ids.a], 'editor'), leaf(ids.terminalPane, [ids.t1]), leaf('pane-wh-e2', [ids.b], 'editor')], [5, 5, 90]),
          split(
            'split-wh-bottom',
            'horizontal',
            [leaf('pane-wh-t2', [ids.t2]), split('split-wh-inner', 'vertical', [leaf('pane-wh-e3', [ids.c, ids.d], 'editor'), leaf('pane-wh-t3', [ids.t3, ids.t4])], [3, 97])],
            [4, 96]
          ),
        ],
        [5, 95]
      )
    );
    await until(async () => (await call('leafBoxes')).every((l) => l.box && l.box.width > 0 && l.box.height > 0), 'the nested panes never drew');
    await sleep(300);
    await assertFloors('nested');
    // Unscaled here too: the top row gets an editor's height, the inner column a file and a terminal.
    for (const box of await call('leafBoxes')) {
      const min = box.kind === 'editor' ? { width: 160, height: 96 } : { width: 120, height: 88 };
      assert.ok(box.box.width >= min.width - SLACK_PX, `nested: ${box.id} is ${box.box.width.toFixed(1)}px wide`);
      assert.ok(box.box.height >= min.height - SLACK_PX, `nested: ${box.id} is ${box.box.height.toFixed(1)}px high`);
    }

    // Eight panes in a column: more than 600px of minimums in about 600px.
    const kinds = ['editor', 'terminal'];
    const column = [ids.a, ids.t1, ids.b, ids.t2, ids.c, ids.t3, ids.d, ids.t4].map((tab, i) =>
      leaf(i === 0 ? ids.editorPane : i === 1 ? ids.terminalPane : `pane-wh-col-${i}`, [tab], kinds[i % 2] === 'editor' ? 'editor' : null)
    );
    await call('layout', split('split-wh-column', 'vertical', column, [2, 2, 2, 2, 2, 2, 2, 86]));
    await until(async () => (await call('leafBoxes')).length === 8 && (await call('leafBoxes')).every((l) => l.box && l.box.height > 0), 'the column never drew');
    await sleep(300);
    const [col] = await assertFloors('column');
    const needed = 4 * 96 + 4 * 88;
    assert.ok(col.length < needed, `the column (${col.length}px) holds every minimum (${needed}px): nothing to scale`);
    col.children.forEach((child, i) => {
      // Even rows are files (96px high at full minimum), odd ones terminals (88px).
      const full = i % 2 === 0 ? 96 : 88;
      assert.ok(child.size > 0, `${child.id} was squeezed to nothing`);
      assert.ok(child.scaled < full, `${child.id}'s floor (${child.scaled.toFixed(1)}px) was not scaled down from ${full}px`);
      assert.ok(child.scaled > full * 0.5, `${child.id}'s floor (${child.scaled.toFixed(1)}px) was scaled past what the space needs`);
    });
    assertNoPageErrors();
    await assertNoLayoutErrors('WG-05');
  });

  test('WG-06: teardown', () => {
    if (!harness) skip(NO_HARNESS);
    harness.teardown();
    harness = null;
  });
});
