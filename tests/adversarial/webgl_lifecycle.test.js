/**
 * Which terminal holds a WebGL context, and what happens when one is lost.
 *
 * A page gets 16 live WebGL contexts and making a 17th kills the oldest.
 * Every terminal used to keep one for life, so with 18 terminals open the two
 * oldest fell back to the DOM renderer (striped box and block characters at
 * line height 1.5); a lost context was final (`entry.gpu = null`, never
 * retried); and a closed terminal's context was never let go, so three
 * close/open cycles evicted two terminals that were still open. Measured
 * headless: 13 of 18 terminals kept WebGL, 5 were drawn by the DOM renderer
 * when shown, and the page held 16 live contexts for one visible terminal.
 *
 * The rules are pure (`src/lib/webglLifecycle.js`) and checked here; the
 * last cases hold the two places that wire them in, which no Node test can
 * run: a pane that stops showing a terminal gives the context back, and
 * closing a terminal releases its context before xterm disposes it.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  GPU_CONTEXT_BUDGET,
  GPU_RETRY_DELAYS_MS,
  GPU_STABLE_MS,
  planGpuReconcile,
  planGpuAttach,
  gpuFailure,
  webglInternals,
  releaseWebglAddon,
  drawWebglNow,
} from '../../src/lib/webglLifecycle.js';

/** One terminal as the planner sees it; on screen with nothing to do by default. */
const term = (over = {}) => ({
  attached: true,
  connected: true,
  hasGpu: true,
  rebuild: false,
  freshAttach: false,
  retryAt: 0,
  attachedAt: 0,
  ...over,
});

/**
 * An addon-webgl 0.18 WebglAddon as far as the release helper can see it:
 * `_renderer._gl`, and a dispose that tears the renderer down.
 */
function fakeAddon({ lost = false, extension = true, disposeThrows = false, renderer = true } = {}) {
  const log = [];
  const gl = {
    lost,
    isContextLost() {
      return this.lost;
    },
    getExtension(name) {
      log.push(`getExtension(${name})`);
      if (name !== 'WEBGL_lose_context' || !extension) return null;
      return {
        loseContext: () => {
          log.push('loseContext');
          gl.lost = true;
        },
      };
    },
  };
  const addon = {
    _renderer: renderer ? { _gl: gl } : undefined,
    dispose() {
      log.push('dispose');
      // The real addon drops what it owns; the context must have been taken first.
      this._renderer = undefined;
      if (disposeThrows) throw new Error('already disposed');
    },
  };
  return { addon, gl, log };
}

describe('WebGL contexts: only a terminal on screen holds one', () => {
  test('GL-01: a terminal no pane shows gives its context back; one on screen keeps it', () => {
    const plan = planGpuReconcile([term(), term({ attached: false }), term()], { now: 1 });
    assert.deepEqual(plan.release, [1], 'the hidden one, and only it');
    assert.deepEqual(plan.create, [], 'nothing on screen is missing a renderer');
  });

  test('GL-02: a terminal shown without a renderer gets one; a hidden one does not', () => {
    const plan = planGpuReconcile([term({ hasGpu: false }), term({ hasGpu: false, attached: false })], { now: 1 });
    assert.deepEqual(plan.create, [0]);
    assert.deepEqual(plan.release, []);
  });

  test('GL-03: a terminal whose element is not in the document yet is not given one', () => {
    // The renderer measures the font from the live DOM.
    const plan = planGpuReconcile([term({ hasGpu: false, connected: false })], { now: 1 });
    assert.deepEqual(plan.create, []);
  });

  test('GL-04: never more contexts than the budget — the rest wait instead of evicting', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => term({ hasGpu: false, attachedAt: i }));
    const plan = planGpuReconcile(twenty, { now: 100 });
    assert.equal(plan.create.length, GPU_CONTEXT_BUDGET, 'sixteen made, four wait on the DOM renderer');
    assert.equal(GPU_CONTEXT_BUDGET, 16, "the browsers' own cap (Chromium and WebKit)");

    // Fifteen on screen already hold one: exactly one more fits.
    const held = Array.from({ length: 15 }, () => term());
    const waiting = [term({ hasGpu: false, attachedAt: 1 }), term({ hasGpu: false, attachedAt: 2 })];
    assert.deepEqual(planGpuReconcile([...held, ...waiting], { now: 100 }).create, [16], 'the most recently shown');
  });

  test('GL-05: a context given back is free for a terminal waiting on screen in the same pass', () => {
    const full = Array.from({ length: 16 }, () => term());
    full[3] = term({ attached: false }); // hidden in this commit
    const plan = planGpuReconcile([...full, term({ hasGpu: false, attachedAt: 9 })], { now: 1 });
    assert.deepEqual(plan.release, [3]);
    assert.deepEqual(plan.create, [16], 'released first, then handed on');
  });
});

describe('WebGL contexts: a lost one comes back, without a loop', () => {
  test('GL-06: after a loss the terminal retries once the backoff has passed, and not before', () => {
    const lost = term({ hasGpu: false, retryAt: 5000 });
    const early = planGpuReconcile([lost], { now: 4000 });
    assert.deepEqual(early.create, [], 'still backing off');
    assert.equal(early.retryAt, 5000, 'and the pass says when to come back');
    assert.deepEqual(planGpuReconcile([lost], { now: 5000 }).create, [0], 'then it gets WebGL again');
  });

  test('GL-07: retries back off 1 s, 5 s, 30 s, then stop', () => {
    let state = { failures: 0, createdAt: null };
    const delays = [];
    let now = 1000;
    for (let i = 0; i < 4; i++) {
      const next = gpuFailure({ failures: state.failures, createdAt: now - 10 }, now);
      delays.push(next.retryAt - now);
      state = next;
      now = next.retryAt === Infinity ? now + 1 : next.retryAt + 3000; // made, then lost 3 s later
    }
    assert.deepEqual(delays.slice(0, 3), GPU_RETRY_DELAYS_MS);
    assert.deepEqual(GPU_RETRY_DELAYS_MS, [1000, 5000, 30000]);
    assert.equal(delays[3], Infinity, 'the fourth quick loss in a row is the last');
    assert.deepEqual(planGpuReconcile([term({ hasGpu: false, retryAt: Infinity })], { now: 1e12 }).create, [],
      'given up: no automatic retry, however long it waits');
  });

  test('GL-08: a renderer that had been fine for a minute starts the count afresh', () => {
    const after = gpuFailure({ failures: 3, createdAt: 0 }, GPU_STABLE_MS);
    assert.equal(after.failures, 1, 'one loss after long healthy use is not a third strike');
    assert.equal(after.retryAt, GPU_STABLE_MS + GPU_RETRY_DELAYS_MS[0]);
    const quick = gpuFailure({ failures: 1, createdAt: 0 }, GPU_STABLE_MS - 1);
    assert.equal(quick.failures, 2, 'but a renderer lost within the minute keeps counting');
  });

  test('GL-09: a renderer that could not be made at all never counts as healthy', () => {
    // A creation failure has no renderer that lived; reading an old creation
    // time as "healthy" would retry every second forever.
    const next = gpuFailure({ failures: 2, createdAt: null }, 10 * GPU_STABLE_MS);
    assert.equal(next.failures, 3);
  });

  test('GL-10: showing the terminal again tries at once, even after the retries gave up', () => {
    const gaveUp = term({ hasGpu: false, retryAt: Infinity, freshAttach: true });
    assert.deepEqual(planGpuReconcile([gaveUp], { now: 1 }).create, [0]);
    assert.equal(planGpuReconcile([gaveUp], { now: 1 }).retryAt, null);
  });
});

describe('WebGL contexts: a terminal coming back is drawn at the size it is fitted to', () => {
  test('GL-11: a terminal just shown gets its renderer at once, before its pane fits it', () => {
    // Fitted with the DOM renderer's wider cells first, it got 104 columns and
    // then 107 a frame later — two resizes on every tab switch.
    const states = [term(), term({ hasGpu: false, attachedAt: 50, freshAttach: true })];
    assert.deepEqual(planGpuAttach(states, 1, { now: 50 }), { create: true, releaseFirst: [] });
  });

  test('GL-12: a context still held by a terminal just hidden goes first when the budget is full', () => {
    const states = [
      ...Array.from({ length: 13 }, () => term()),
      term({ attached: false, attachedAt: 30 }),
      term({ attached: false, attachedAt: 10 }), // hidden longest
      term({ attached: false, attachedAt: 20 }),
      term({ hasGpu: false, attachedAt: 99, freshAttach: true }),
    ];
    const decision = planGpuAttach(states, 16, { now: 99 });
    assert.equal(decision.create, true);
    assert.deepEqual(decision.releaseFirst, [14], 'sixteen held + one new: the longest-hidden goes now');
  });

  test('GL-13: no renderer at once when sixteen terminals on screen already hold one', () => {
    const states = [...Array.from({ length: 16 }, () => term()), term({ hasGpu: false, freshAttach: true })];
    assert.deepEqual(planGpuAttach(states, 16, { now: 1 }), { create: false, releaseFirst: [] });
  });

  test('GL-14: the first frame is drawn at the fitted size, now, not on the next animation frame', () => {
    const calls = [];
    const renderer = {
      dimensions: { css: { canvas: { width: 107 * 7, height: 37 * 18 }, cell: { width: 7, height: 18 } } },
      handleResize: (c, r) => calls.push(`handleResize(${c},${r})`),
      renderRows: (a, b) => calls.push(`renderRows(${a},${b})`),
    };
    assert.equal(drawWebglNow({ _renderer: renderer }, { cols: 87, rows: 31 }), true);
    assert.deepEqual(calls, ['handleResize(87,31)', 'renderRows(0,30)'], 'resized to the fitted grid, then drawn');

    calls.length = 0;
    drawWebglNow({ _renderer: renderer }, { cols: 107, rows: 37 });
    assert.deepEqual(calls, ['renderRows(0,36)'], 'already that size: only drawn');
  });

  test('GL-15: drawing never throws, whatever the addon turned out to be', () => {
    assert.equal(drawWebglNow(undefined, { cols: 80, rows: 24 }), false);
    assert.equal(drawWebglNow({}, { cols: 80, rows: 24 }), false, 'a version without `_renderer`');
    const broken = { _renderer: { renderRows() { throw new Error('context lost'); } } };
    assert.equal(drawWebglNow(broken, { cols: 80, rows: 24 }), false);
  });
});

describe('WebGL contexts: releasing an addon releases its context', () => {
  test('GL-16: the context is taken before the dispose and lost on purpose after it', () => {
    const { addon, gl, log } = fakeAddon();
    const result = releaseWebglAddon(addon);
    assert.deepEqual(log, ['dispose', 'getExtension(WEBGL_lose_context)', 'loseContext']);
    assert.equal(gl.lost, true, 'the slot is handed back now, not at garbage collection');
    assert.deepEqual(result, { disposed: true, freedContext: true });
  });

  test('GL-17: a context that is already lost is disposed and left alone', () => {
    const { addon, log } = fakeAddon({ lost: true });
    assert.deepEqual(releaseWebglAddon(addon), { disposed: true, freedContext: false });
    assert.ok(!log.includes('loseContext'));
  });

  test('GL-18: a failing dispose still lets the context go', () => {
    const { addon, gl } = fakeAddon({ disposeThrows: true });
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(releaseWebglAddon(addon), { disposed: false, freedContext: true });
    } finally {
      console.warn = warn;
    }
    assert.equal(gl.lost, true);
  });

  test('GL-19: an addon without the private fields, or a browser without the extension, is only disposed', () => {
    const noRenderer = fakeAddon({ renderer: false });
    assert.deepEqual(releaseWebglAddon(noRenderer.addon), { disposed: true, freedContext: false });
    const noExtension = fakeAddon({ extension: false });
    assert.deepEqual(releaseWebglAddon(noExtension.addon), { disposed: true, freedContext: false });
    assert.deepEqual(releaseWebglAddon(null), { disposed: false, freedContext: false });
  });

  test('GL-20: the private fields are read in one guarded place', () => {
    const { addon, gl } = fakeAddon();
    assert.equal(webglInternals(addon).gl, gl);
    assert.deepEqual(webglInternals({ _renderer: { _gl: {} } }).gl, null, 'not a context: no getExtension');
    const hostile = { get _renderer() { throw new Error('renamed'); } };
    assert.deepEqual(webglInternals(hostile), { renderer: null, gl: null });
  });
});

describe('WebGL contexts: the two places the rules are wired in', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  test('GL-21: a pane that stops showing a terminal gives its context back', () => {
    const src = read('../../src/components/terminal/TerminalView.jsx');
    const effect = src.slice(src.indexOf('useEffect(() => {'), src.indexOf('}, [tabId, sessionId'));
    const m = effect.match(/const (\w+) = ensureGpuRenderer\(entry\);/);
    assert.ok(m, 'the attach keeps the function that undoes it');
    const cleanup = effect.slice(effect.lastIndexOf('return () => {'));
    assert.ok(cleanup.includes(`${m[1]}();`), "and the effect's cleanup calls it");
  });

  test("GL-22: closing a terminal releases its context before xterm's own dispose", () => {
    const src = read('../../src/components/terminal/terminalRegistry.js');
    const body = src.slice(src.indexOf('export function disposeTerminal('));
    const release = body.indexOf('releaseGpu(entry);');
    const dispose = body.indexOf('entry.term.dispose();');
    assert.ok(release > 0 && dispose > 0 && release < dispose,
      "term.dispose() drops the addon without losing the context, and the zombie counts against the 16");
  });
});
