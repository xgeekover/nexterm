/**
 * Which terminal holds a WebGL context, and what happens when one is lost.
 *
 * A page gets 16 live WebGL contexts, and making one more kills the one that
 * has gone longest without drawing. Every terminal used to keep one for life
 * with no limit, so with 18 terminals open the two oldest fell back to the
 * DOM renderer (striped box and block characters at line height 1.5); a lost
 * context was final; and a closed terminal's context was never let go.
 *
 * The next attempt gave a terminal a context only while on screen. On WebKit
 * that made a context on every tab switch, the ones let go kept their slots
 * until garbage collection, and the context pushed out to make room was an
 * idle terminal ON SCREEN in the next pane (macOS, 2026-10-04: twenty tab
 * switches, fast or a second apart, and the other pane went blank).
 *
 * The rules are pure (`src/lib/webglLifecycle.js`) and checked here. What
 * they add up to, on a model of each engine's cap with the real registry
 * driving it, is `webgl_engine_model.test.js`.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  GPU_CONTEXT_BUDGET,
  GPU_RETRY_DELAYS_MS,
  GPU_STABLE_MS,
  planGpuReconcile,
  planGpuAttach,
  mustDrawScreenFirst,
  gpuFailure,
  webglInternals,
  isWebglContextLost,
  releaseWebglAddon,
  drawWebglNow,
} from '../../src/lib/webglLifecycle.js';

/** One terminal as the planner sees it; on screen, drawing, nothing to do by default. */
const term = (over = {}) => ({
  attached: true,
  connected: true,
  hasGpu: true,
  lost: false,
  rebuild: false,
  freshAttach: false,
  retryAt: 0,
  attachedAt: 0,
  drawnAt: 0,
  ...over,
});

/**
 * An addon-webgl WebglAddon (0.18 and 0.19 alike) as far as the release helper can see it:
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
    flush() {
      log.push('flush');
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

describe('WebGL contexts: made once, kept while hidden', () => {
  test('GL-01: a terminal no pane shows KEEPS its renderer — hiding makes and frees nothing', () => {
    const plan = planGpuReconcile([term(), term({ attached: false }), term()], { now: 1 });
    assert.deepEqual(plan.release, [], 'a tab switch must not cost a context');
    assert.deepEqual(plan.create, []);
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

  test('GL-04: never more terminals ON SCREEN with a context than the cap — the rest wait', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => term({ hasGpu: false, attachedAt: i }));
    const plan = planGpuReconcile(twenty, { now: 100 });
    assert.equal(plan.create.length, GPU_CONTEXT_BUDGET, 'sixteen made, four wait on the DOM renderer');
    assert.equal(GPU_CONTEXT_BUDGET, 16, "the engines' own cap (WebKit and Chromium)");
    assert.deepEqual(plan.create.slice(0, 2), [19, 18], 'the most recently shown first');
  });

  test('GL-05: past the cap, the hidden renderer drawn longest ago makes room — not the one hidden longest', () => {
    const states = [
      term(), // on screen
      ...Array.from({ length: 12 }, (_, i) => term({ attached: false, drawnAt: 500 + i })),
      // Hidden a moment ago, but idle on screen for an hour before that: its
      // context has gone longest without drawing, and that is the engines' order.
      term({ attached: false, attachedAt: 990, drawnAt: 10 }),
      term({ attached: false, attachedAt: 100, drawnAt: 400 }),
      term({ attached: false, attachedAt: 200, drawnAt: 450 }),
      term({ hasGpu: false, attachedAt: 1000 }), // just shown
    ];
    const plan = planGpuReconcile(states, { now: 1000 });
    assert.deepEqual(plan.create, [16]);
    assert.deepEqual(plan.release, [13], 'sixteen held + one to make: one hidden goes, by choice');
  });

  test('GL-06: a context on screen is never given up to make room; with no hidden one to spare, nothing is made', () => {
    const states = [...Array.from({ length: 15 }, () => term()), term({ attached: false, hasGpu: true }), term({ hasGpu: false })];
    const one = planGpuReconcile(states, { now: 1 });
    assert.deepEqual(one.release, [15], 'the hidden one goes');
    assert.deepEqual(one.create, [16]);
    const full = [...Array.from({ length: 16 }, () => term()), term({ hasGpu: false })];
    const none = planGpuReconcile(full, { now: 1 });
    assert.deepEqual(none.release, []);
    assert.deepEqual(none.create, [], 'sixteen on screen: the seventeenth waits on the DOM renderer');
  });

  test('GL-07: several made in one pass each get their room — the page never goes past the cap', () => {
    const hidden = Array.from({ length: 14 }, (_, i) => term({ attached: false, drawnAt: i }));
    const shown = [term({ hasGpu: false, attachedAt: 5 }), term({ hasGpu: false, attachedAt: 6 }), term({ hasGpu: false, attachedAt: 7 })];
    const states = [term(), ...hidden, ...shown];
    const plan = planGpuReconcile(states, { now: 10 });
    assert.equal(plan.create.length, 3);
    const held = states.filter((t) => t.hasGpu).length - plan.release.length + plan.create.length;
    assert.equal(held, GPU_CONTEXT_BUDGET, `15 held + 3 made needs 2 let go (released ${plan.release})`);
    assert.deepEqual(plan.release, [1, 2], 'the two drawn longest ago');
  });

  test('GL-08: a renderer whose context is lost holds no slot worth counting', () => {
    // Lost and not reported yet: addon-webgl waits 3 s for a restore first.
    const states = [term({ attached: false, lost: true }), ...Array.from({ length: 15 }, () => term()), term({ hasGpu: false })];
    const plan = planGpuReconcile(states, { now: 1 });
    assert.deepEqual(plan.release, [], 'fifteen live + one lost leaves room for one more');
    assert.deepEqual(plan.create, [16]);
    const onScreenLost = planGpuReconcile([term({ lost: true })], { now: 1 });
    assert.deepEqual(onScreenLost, { release: [], create: [], retryAt: null }, 'on screen: left to the loss report and the retry');
  });
});

describe('WebGL contexts: a lost one comes back, without a loop', () => {
  test('GL-09: after a loss the terminal retries once the backoff has passed, and not before', () => {
    const lost = term({ hasGpu: false, retryAt: 5000 });
    const early = planGpuReconcile([lost], { now: 4000 });
    assert.deepEqual(early.create, [], 'still backing off');
    assert.equal(early.retryAt, 5000, 'and the pass says when to come back');
    assert.deepEqual(planGpuReconcile([lost], { now: 5000 }).create, [0], 'then it gets WebGL again');
  });

  test('GL-10: retries back off 1 s, 5 s, 30 s, then stop', () => {
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

  test('GL-11: a renderer that had been fine for a minute starts the count afresh', () => {
    const after = gpuFailure({ failures: 3, createdAt: 0 }, GPU_STABLE_MS);
    assert.equal(after.failures, 1, 'one loss after long healthy use is not a third strike');
    assert.equal(after.retryAt, GPU_STABLE_MS + GPU_RETRY_DELAYS_MS[0]);
    const quick = gpuFailure({ failures: 1, createdAt: 0 }, GPU_STABLE_MS - 1);
    assert.equal(quick.failures, 2, 'but a renderer lost within the minute keeps counting');
  });

  test('GL-12: a renderer that could not be made at all never counts as healthy', () => {
    // A creation failure has no renderer that lived; reading an old creation
    // time as "healthy" would retry every second forever.
    const next = gpuFailure({ failures: 2, createdAt: null }, 10 * GPU_STABLE_MS);
    assert.equal(next.failures, 3);
  });

  test('GL-13: showing the terminal again tries at once, even after the retries gave up', () => {
    const gaveUp = term({ hasGpu: false, retryAt: Infinity, freshAttach: true });
    assert.deepEqual(planGpuReconcile([gaveUp], { now: 1 }).create, [0]);
    assert.equal(planGpuReconcile([gaveUp], { now: 1 }).retryAt, null);
  });
});

describe('WebGL contexts: a terminal being shown', () => {
  test('GL-14: shown for the first time, it gets its renderer at once, before its pane fits it', () => {
    // Fitted with the DOM renderer's wider cells first, it got 104 columns and
    // then 107 a frame later — two resizes for the program inside.
    const states = [term(), term({ hasGpu: false, attachedAt: 50, freshAttach: true })];
    assert.deepEqual(planGpuAttach(states, 1), { create: true, releaseFirst: [] });
  });

  test('GL-15: shown again with the renderer it kept, it gets nothing new', () => {
    const states = [term(), term({ attachedAt: 50, freshAttach: true })];
    assert.deepEqual(planGpuAttach(states, 1), { create: false, releaseFirst: [] });
  });

  test('GL-16: at the cap, the hidden renderer drawn longest ago goes first', () => {
    const states = [
      ...Array.from({ length: 13 }, () => term()),
      term({ attached: false, drawnAt: 30 }),
      term({ attached: false, drawnAt: 10 }), // drawn longest ago
      term({ attached: false, drawnAt: 20 }),
      term({ hasGpu: false, attachedAt: 99, freshAttach: true }),
    ];
    assert.deepEqual(planGpuAttach(states, 16), { create: true, releaseFirst: [14] });
  });

  test('GL-17: no renderer at once when sixteen terminals on screen already hold one', () => {
    const states = [...Array.from({ length: 16 }, () => term()), term({ hasGpu: false, freshAttach: true })];
    assert.deepEqual(planGpuAttach(states, 16), { create: false, releaseFirst: [] });
  });

  test('GL-18 (M2): the terminals on screen always draw before a context is made', () => {
    // WebKit pushes out the context that has gone longest without drawing, and
    // an idle terminal on screen may not have drawn for an hour. This used to
    // be skipped away from the cap, judged from a `lingering` count of
    // released-but-maybe-uncollected contexts kept with `WeakRef` — but
    // JavaScriptCore clears a `WeakRef` at the end of marking while WebKit
    // frees the context's slot only later, when the sweeper destroys it.
    // Several contexts released together (closing many tabs) can all drop out
    // of that count while WebKit still holds every one of their slots, so the
    // "nowhere near the cap" case could be wrong exactly when it mattered.
    // Always true now: a context is rarely made at all once shown under v2,
    // so drawing ahead every time costs nothing.
    assert.equal(mustDrawScreenFirst({ held: 0, lingering: 0 }), true, 'nothing held: still draw ahead');
    assert.equal(mustDrawScreenFirst({ held: 3, lingering: 0 }), true);
    assert.equal(mustDrawScreenFirst({ held: 15, lingering: 0 }), true);
    assert.equal(mustDrawScreenFirst({ held: 4, lingering: 11 }), true,
      'contexts let go still count on WebKit until collected');
    assert.equal(mustDrawScreenFirst({ held: 1, lingering: null }), true, 'unknown counts as full');
    assert.equal(mustDrawScreenFirst(), true, 'no args at all: still true');
  });

  test('GL-19: the first frame is drawn at the fitted size, now, not on the next animation frame', () => {
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

  test('GL-20: a draw ahead of a new context is flushed — Chromium ranks contexts by their last flush', () => {
    const { addon, log } = fakeAddon();
    addon._renderer.renderRows = () => log.push('renderRows');
    addon._renderer.dimensions = { css: { canvas: { width: 70, height: 18 }, cell: { width: 7, height: 18 } } };
    assert.equal(drawWebglNow(addon, { cols: 10, rows: 1 }, { flush: true }), true);
    assert.deepEqual(log, ['renderRows', 'flush']);
    const lost = fakeAddon({ lost: true });
    lost.addon._renderer.renderRows = () => lost.log.push('renderRows');
    assert.equal(drawWebglNow(lost.addon, { cols: 10, rows: 1 }), false, 'a lost context draws nothing');
  });

  test('GL-21: drawing never throws, whatever the addon turned out to be', () => {
    assert.equal(drawWebglNow(undefined, { cols: 80, rows: 24 }), false);
    assert.equal(drawWebglNow({}, { cols: 80, rows: 24 }), false, 'a version without `_renderer`');
    const broken = { _renderer: { renderRows() { throw new Error('context lost'); } } };
    assert.equal(drawWebglNow(broken, { cols: 80, rows: 24 }), false);
  });

  test('GL-27: nothing is drawn in the middle of a synchronized update (DEC 2026) — xterm draws it when it ends', () => {
    const calls = [];
    const renderer = {
      dimensions: { css: { canvas: { width: 80 * 7, height: 24 * 18 }, cell: { width: 7, height: 18 } } },
      handleResize: (c, r) => calls.push(`handleResize(${c},${r})`),
      renderRows: (a, b) => calls.push(`renderRows(${a},${b})`),
    };
    const addon = { _renderer: renderer };
    // `term.modes.synchronizedOutputMode`, as xterm 6 reports it between `CSI ? 2026 h` and `l`.
    const midUpdate = { cols: 100, rows: 30, modes: { synchronizedOutputMode: true } };
    assert.equal(drawWebglNow(addon, midUpdate), false);
    assert.equal(drawWebglNow(addon, midUpdate, { flush: true }), false, 'not even ahead of a new context');
    assert.deepEqual(calls, [], 'neither resized nor drawn: the program said the screen is half written');
    assert.equal(drawWebglNow(addon, { cols: 80, rows: 24, modes: { synchronizedOutputMode: false } }), true);
    assert.deepEqual(calls, ['renderRows(0,23)'], 'and drawn as usual once the update is over');
  });

  test('GL-28: the registry hands xterm the whole viewport when it could not draw an atlas repair now', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const repair = src.slice(src.indexOf('function repairAtlas()'), src.indexOf('function reconcileGpus()'));
    assert.match(
      repair,
      /if \(entry\.attachCount > 0 && drawWebglNow\(entry\.gpu, entry\.term\)\) \{[\s\S]*?\} else \{[\s\S]*?entry\.term\.refresh\(0, entry\.term\.rows - 1\);/,
      'hidden or mid-update alike: the repaired model is drawn in full by the next frame'
    );
  });
});

describe('WebGL contexts: releasing an addon releases its context', () => {
  test('GL-22: the context is taken before the dispose and lost on purpose after it', () => {
    const { addon, gl, log } = fakeAddon();
    const result = releaseWebglAddon(addon);
    assert.deepEqual(log, ['dispose', 'getExtension(WEBGL_lose_context)', 'loseContext']);
    assert.equal(gl.lost, true, 'Chromium has the slot back now; WebKit recycles a lost context first');
    assert.deepEqual(result, { disposed: true, freedContext: true });
  });

  test('GL-23: a context that is already lost is disposed and left alone', () => {
    const { addon, log } = fakeAddon({ lost: true });
    assert.deepEqual(releaseWebglAddon(addon), { disposed: true, freedContext: false });
    assert.ok(!log.includes('loseContext'));
  });

  test('GL-24: a failing dispose still lets the context go', () => {
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

  test('GL-25: an addon without the private fields, or a browser without the extension, is only disposed', () => {
    const noRenderer = fakeAddon({ renderer: false });
    assert.deepEqual(releaseWebglAddon(noRenderer.addon), { disposed: true, freedContext: false });
    const noExtension = fakeAddon({ extension: false });
    assert.deepEqual(releaseWebglAddon(noExtension.addon), { disposed: true, freedContext: false });
    assert.deepEqual(releaseWebglAddon(null), { disposed: false, freedContext: false });
  });

  test('GL-26: the private fields are read in one guarded place, and a loss is seen at once', () => {
    const { addon, gl } = fakeAddon();
    assert.equal(webglInternals(addon).gl, gl);
    assert.deepEqual(webglInternals({ _renderer: { _gl: {} } }).gl, null, 'not a context: no getExtension');
    const hostile = { get _renderer() { throw new Error('renamed'); } };
    assert.deepEqual(webglInternals(hostile), { renderer: null, gl: null });
    assert.equal(isWebglContextLost(addon), false);
    gl.lost = true;
    assert.equal(isWebglContextLost(addon), true, 'not 3 s later, when addon-webgl gives up on a restore');
    assert.equal(isWebglContextLost(hostile), false);
  });
});
