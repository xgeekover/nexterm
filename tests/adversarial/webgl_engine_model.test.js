/**
 * The real `terminalRegistry.js`, driven like the app drives it, against a
 * model of each engine's WebGL context cap (`webgl/engines.js`: WebKit's and
 * Chromium's rules, with the source they come from).
 *
 * Why a model: what decides which terminal goes blank is the engine's choice
 * of whom to push out, and no test that runs in Node has an engine. The
 * real-app check on macOS (2026-10-04) found what the headless Chromium lab
 * could not: pane A showing one idle terminal, pane B switching between three
 * tabs 20 times — fast, or a second apart — and pane A's context was pushed
 * out both times, blank for about four seconds. That registry gave a terminal
 * a context only while on screen, so every switch made one; WebKit keeps a
 * context lost on purpose in its count until garbage collection, and pushes
 * out the context that has gone longest without drawing — an unfocused, idle
 * terminal draws nothing.
 *
 * The same scenarios (`webgl/scenarios.js`) run against that registry push
 * pane A out in all four WebKit scenarios with an idle pane (fast switches,
 * paced switches, twenty terminals through one pane, close and reopen), make
 * a context on every switch, and four contexts for two atlas merges. Here
 * they must do none of that, on either engine.
 */
import { register } from 'node:module';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { WebKitEngine, ChromiumEngine } from './webgl/engines.js';
import {
  idlePaneWhileTabsSwitch,
  groupSwitches,
  twentyThroughOnePane,
  closeAndReopenBesideIdlePane,
  atlasMerges,
  lostContexts,
  eighteenOnScreen,
} from './webgl/scenarios.js';

// Every `@xterm/*` import of the registry resolves to the double.
register('./webgl/loader.mjs', import.meta.url);

const registryUrl = new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url).href;
const ENGINES = ['webkit', 'chromium'];

/** The registry warns when WebGL is unavailable; the model makes that happen on purpose. */
async function quietly(fn) {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

describe('WebGL engine model: the rules it follows', () => {
  const timers = { setTimeout: (fn) => fn() };

  test('WM-01: WebKit recycles the context drawn longest ago, and a lost one keeps its slot', () => {
    const engine = new WebKitEngine({ timers, describeOwner: (o) => ({ tabId: o }) });
    const contexts = Array.from({ length: 16 }, (_, i) => engine.create(`t${i}`));
    engine.draw(contexts[0]); // t0 drew last: t1 is now the one drawn longest ago
    contexts[5].getExtension('WEBGL_lose_context').loseContext();
    assert.equal(engine.slotsHeld, 16, 'lost on purpose, still counted');
    engine.create('t16');
    assert.deepEqual(engine.evictions.map((e) => e.tabId), ['t1'], 'not t0: drawing made it recent');
    assert.equal(contexts[1].isContextLost(), true);
    contexts[5].collectable = true;
    engine.gc();
    assert.equal(engine.slotsHeld, 15, 'collected: the slot comes back');
  });

  test('WM-02: Chromium loses the least recently flushed, and a lost one frees its slot at once', () => {
    const engine = new ChromiumEngine({ timers, describeOwner: (o) => ({ tabId: o }) });
    const contexts = Array.from({ length: 16 }, (_, i) => engine.create(`t${i}`));
    engine.draw(contexts[0]);
    engine.create('t16');
    assert.deepEqual(engine.evictions.map((e) => e.tabId), ['t0'], 'a draw alone is not a flush');
    engine.draw(contexts[1]);
    engine.endFrame();
    contexts[2].getExtension('WEBGL_lose_context').loseContext();
    assert.equal(engine.slotsHeld, 15, 'the slot came back at once');
    engine.create('t17');
    engine.create('t18');
    assert.deepEqual(engine.evictions.map((e) => e.tabId), ['t0', 't3'], 't1 was flushed with its frame');
  });
});

describe('WebGL engine model: switching tabs and groups', () => {
  for (const engine of ENGINES) {
    for (const paced of [false, true]) {
      const how = paced ? 'a second apart' : 'as fast as they come';
      test(`WM-03 (${engine}, ${how}): twenty tab switches make no context and push out nobody`, async () => {
        const r = await quietly(() => idlePaneWhileTabsSwitch({ registryUrl, engine, paced }));
        assert.equal(r.createdBySwitching, 0, 'every terminal kept the context it was first shown with');
        assert.deepEqual(r.evictions, 0);
        assert.deepEqual(r.onScreenWithoutWebgl, []);
        assert.equal(r.stats.lost, 0, 'pane A never lost its context');
        assert.equal(r.stats.live, 4, 'A, B1, B2, B3 — one each, hidden or not');
      });
    }

    test(`WM-10 (${engine}): forty group switches, fast and paced, make no context and push out nobody`, async () => {
      const r = await quietly(() => groupSwitches({ registryUrl, engine }));
      assert.equal(r.createdBySwitching, 0);
      assert.equal(r.evictions, 0);
      assert.deepEqual(r.onScreenWithoutWebgl, []);
      assert.equal(r.stats.lost, 0);
    });
  }
});

describe('WebGL engine model: more terminals than contexts', () => {
  for (const engine of ENGINES) {
    for (const idlePane of [false, true]) {
      const beside = idlePane ? ' beside an idle pane' : '';
      test(`WM-04 (${engine}): twenty terminals through one pane${beside}, twice round`, async () => {
        const r = await quietly(() => twentyThroughOnePane({ registryUrl, engine, idlePane }));
        assert.deepEqual(r.evictedOnScreen, [], 'nothing on screen is ever pushed out');
        assert.deepEqual(r.evictedLive, [], 'only contexts NexTerm had already let go');
        assert.deepEqual(r.shownWithoutWebgl, [], 'every terminal is drawn by WebGL from the moment it is shown');
        assert.deepEqual(r.onScreenWithoutWebgl, []);
        assert.equal(r.stats.live, 16, 'the page holds the cap, no more');
        if (engine === 'chromium') assert.equal(r.evictions, 0, 'a context let go frees its slot at once');
        if (idlePane) assert.ok(r.stats.drawnAhead > 0, 'pane A drew ahead of the contexts made near the cap');
      });
    }

    test(`WM-05 (${engine}): closing terminals and opening more beside an idle pane pushes out nothing on screen`, async () => {
      const r = await quietly(() => closeAndReopenBesideIdlePane({ registryUrl, engine }));
      assert.deepEqual(r.evictedOnScreen, []);
      assert.deepEqual(r.evictedLive, []);
      assert.deepEqual(r.onScreenWithoutWebgl, []);
      assert.equal(r.stats.lost, 0);
    });

    test(`WM-06 (${engine}): eighteen on screen — sixteen drawn by WebGL, two wait, closing two hands theirs on`, async () => {
      const r = await quietly(() => eighteenOnScreen({ registryUrl, engine }));
      assert.equal(r.withWebgl, 16);
      assert.equal(r.waiting, 2, 'waiting on the DOM renderer, not evicting each other');
      assert.deepEqual(r.onScreenWithoutWebglAfterClosingTwo, []);
      assert.deepEqual(r.evictedOnScreen, [], 'the closed ones go, not a neighbour');
      assert.deepEqual(r.evictedLive, []);
    });
  }

  test('WM-07 (webkit): the same twenty with the collector running between switches', async () => {
    const r = await quietly(() => twentyThroughOnePane({ registryUrl, engine: 'webkit', idlePane: true, gc: true }));
    assert.deepEqual(r.evictedOnScreen, []);
    assert.deepEqual(r.evictedLive, []);
    assert.deepEqual(r.shownWithoutWebgl, []);
  });
});

describe('WebGL engine model: an atlas merge and a lost context', () => {
  for (const engine of ENGINES) {
    test(`WM-08 (${engine}): two atlas merges are repaired without a single new context`, async () => {
      const r = await quietly(() => atlasMerges({ registryUrl, engine }));
      assert.equal(r.createdByMerges, 0, 'remaking every renderer would make up to sixteen at once');
      assert.equal(r.createdByShowingAfter, 0, 'the hidden ones kept theirs too');
      assert.equal(r.staleFrames, 0, 'no frame drew from pages or cells as they were before a merge');
      assert.equal(r.blankRowFrames, 0, 'no frame drew part of a cleared model');
      assert.equal(r.flagStuckAfterMerges, false, 'no whole-model rebuild on every frame');
      assert.equal(r.stats.atlasRepairs, 2, 'one repair per merge, however many renderers reported it');
      assert.deepEqual(r.onScreenWithoutWebgl, []);
    });

    test(`WM-09 (${engine}): a lost context comes back — on screen after the backoff, hidden the moment it is shown`, async () => {
      const r = await quietly(() => lostContexts({ registryUrl, engine }));
      assert.equal(r.visibleBackAfterMs, 4000, "addon-webgl's 3 s wait for a restore, then the 1 s retry");
      assert.equal(r.hiddenHeldContext, true, 'the hidden terminal had kept its context');
      assert.equal(r.hiddenOnWebglWhenShown, true, 'not blank for the rest of the 3 s wait');
      assert.deepEqual(r.onScreenWithoutWebgl, []);
    });
  }
});
