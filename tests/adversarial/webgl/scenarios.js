/**
 * What a user does that makes WebGL contexts come and go, run against a model
 * browser (`harness.js`). Each scenario takes `{ registryUrl, engine }`, so
 * the same steps can be run against any version of `terminalRegistry.js`, and
 * returns plain numbers for the caller to judge.
 *
 * The first two are the real-app check of 2026-10-04 on macOS: pane A shows
 * one idle terminal while pane B switches between three tabs, 20 times as
 * fast as possible, then 20 times a second apart. The registry of that day
 * took pane A's context both times.
 */
import { openModel, settle } from './harness.js';

/** Every renderer the model ever made: frames drawn wrong after an atlas merge. */
function rendererDefects(app) {
  let staleFrames = 0;
  let blankRowFrames = 0;
  for (const r of app.world.renderers) {
    staleFrames += r.staleFrames;
    blankRowFrames += r.blankRowFrames;
  }
  return { staleFrames, blankRowFrames };
}

function evictionSummary(app) {
  return {
    evictions: app.engine.evictions.length,
    evictedOnScreen: app.evictionsOnScreen().map((e) => e.tabId),
    evictedLive: app.engine.evictions.filter((e) => !e.alreadyLost).map((e) => e.tabId),
  };
}

/**
 * Pane A shows one terminal and is left alone — unfocused, no output, so it
 * never draws. Pane B, focused, switches between three tabs 20 times.
 */
export async function idlePaneWhileTabsSwitch({ registryUrl, engine = 'webkit', paced = false }) {
  const app = await openModel({ registryUrl, engine });
  try {
    const A = app.pane();
    const B = app.pane();
    A.show('A');
    await app.run(200);
    app.focus(B);
    for (const tab of ['B1', 'B2', 'B3', 'B1']) {
      B.show(tab);
      await app.run(800);
    }
    await app.run(5000);
    const createdBefore = app.engine.created;
    const order = ['B2', 'B3', 'B1'];
    for (let i = 0; i < 20; i++) {
      B.show(order[i % 3]);
      if (paced) await app.run(1000);
      else await settle();
    }
    // Long enough for any loss to surface: the queued lost event, addon-webgl's
    // 3 s wait, and the registry's retries.
    await app.run(15000);
    return {
      ...evictionSummary(app),
      createdBySwitching: app.engine.created - createdBefore,
      onScreenWithoutWebgl: app.onScreenWithoutWebgl(),
      stats: app.reg.getGpuStats(),
    };
  } finally {
    await app.dispose();
  }
}

/**
 * Twenty terminals shown one after another in one pane, twice round —
 * optionally with pane A idle beside it. Past sixteen, every new context
 * pushes another out; it must be one nobody is looking at.
 */
export async function twentyThroughOnePane({ registryUrl, engine = 'webkit', idlePane = false, gc = false }) {
  const app = await openModel({ registryUrl, engine });
  try {
    if (idlePane) {
      app.pane().show('A');
      await app.run(200);
    }
    const P = app.pane();
    app.focus(P);
    const shownWithoutWebgl = [];
    for (let round = 0; round < 2; round++) {
      for (let i = 1; i <= 20; i++) {
        const tab = `T${i}`;
        P.show(tab);
        await settle();
        // The pane fits it and the browser paints it now: WebGL or not.
        if (!app.hasLiveWebgl(tab)) shownWithoutWebgl.push(`${tab}@${round}`);
        await app.run(500);
        if (gc) app.engine.gc();
      }
    }
    await app.run(15000);
    return {
      ...evictionSummary(app),
      created: app.engine.created,
      shownWithoutWebgl,
      onScreenWithoutWebgl: app.onScreenWithoutWebgl(),
      slotsHeld: app.engine.slotsHeld,
      stats: app.reg.getGpuStats(),
    };
  } finally {
    await app.dispose();
  }
}

/**
 * Terminals opened, some closed, more opened — the closed ones' contexts are
 * lost on purpose, and in WebKit they keep their slots until collected. Pane A
 * sits idle throughout.
 */
export async function closeAndReopenBesideIdlePane({ registryUrl, engine = 'webkit' }) {
  const app = await openModel({ registryUrl, engine });
  try {
    app.pane().show('A');
    await app.run(200);
    const B = app.pane();
    app.focus(B);
    for (let i = 1; i <= 12; i++) {
      B.show(`T${i}`);
      await app.run(400);
    }
    for (let i = 1; i <= 8; i++) {
      await app.close(`T${i}`);
      await app.run(200);
    }
    for (let i = 13; i <= 24; i++) {
      B.show(`T${i}`);
      await app.run(400);
    }
    await app.run(15000);
    return {
      ...evictionSummary(app),
      onScreenWithoutWebgl: app.onScreenWithoutWebgl(),
      stats: app.reg.getGpuStats(),
    };
  } finally {
    await app.dispose();
  }
}

/**
 * The glyph atlas merges pages twice while two terminals are on screen and
 * two more are hidden; then the hidden ones are shown.
 */
export async function atlasMerges({ registryUrl, engine = 'webkit' }) {
  const app = await openModel({ registryUrl, engine });
  try {
    const A = app.pane();
    const B = app.pane();
    A.show('A');
    app.focus(B);
    for (const tab of ['B1', 'B2', 'B3']) {
      B.show(tab);
      await app.run(400);
    }
    await app.run(1500);
    const createdBefore = app.engine.created;
    const atlas = app.world.atlas;
    atlas.merge();
    await settle();
    await app.run(300);
    app.world.atlas.merge();
    await settle();
    await app.run(1500);
    const createdByMerges = app.engine.created - createdBefore;
    const flagStuckAfterMerges = Boolean(app.world.atlas && app.world.atlas._requestClearModel);
    // The terminals that were hidden through both merges come back.
    for (const tab of ['B1', 'B2', 'B3']) {
      B.show(tab);
      await app.run(400);
    }
    await app.run(1500);
    return {
      createdByMerges,
      createdByShowingAfter: app.engine.created - createdBefore - createdByMerges,
      flagStuckAfterMerges,
      ...rendererDefects(app),
      onScreenWithoutWebgl: app.onScreenWithoutWebgl(),
      ...evictionSummary(app),
      stats: app.reg.getGpuStats(),
    };
  } finally {
    await app.dispose();
  }
}

/**
 * A context lost under a terminal: on screen (a GPU reset), and hidden (an
 * eviction) and shown again inside addon-webgl's 3 s wait.
 */
export async function lostContexts({ registryUrl, engine = 'webkit' }) {
  const app = await openModel({ registryUrl, engine });
  try {
    const P = app.pane();
    app.focus(P);
    P.show('L1');
    await app.run(500);
    P.show('L2');
    await app.run(500);

    const lose = (tab) => app.contextOf(tab)?.getExtension('WEBGL_lose_context').loseContext();
    lose('L2');
    const visibleTimeline = [];
    for (let t = 0; t < 8000; t += 500) {
      await app.run(500);
      visibleTimeline.push(app.hasLiveWebgl('L2'));
    }
    const visibleBackAfterMs = (visibleTimeline.indexOf(true) + 1) * 500;

    // L1 is hidden; whatever it holds is lost, then it is shown 1 s later.
    const hiddenHeldContext = Boolean(app.contextOf('L1'));
    if (hiddenHeldContext) lose('L1');
    await app.run(1000);
    P.show('L1');
    await settle();
    const hiddenOnWebglWhenShown = app.hasLiveWebgl('L1');
    await app.run(6000);
    return {
      visibleBackAfterMs: visibleTimeline.includes(true) ? visibleBackAfterMs : null,
      hiddenHeldContext,
      hiddenOnWebglWhenShown,
      onScreenWithoutWebgl: app.onScreenWithoutWebgl(),
      stats: app.reg.getGpuStats(),
    };
  } finally {
    await app.dispose();
  }
}

/** Eighteen panes on screen at once: sixteen get WebGL, two wait; closing two hands theirs on. */
export async function eighteenOnScreen({ registryUrl, engine = 'webkit' }) {
  const app = await openModel({ registryUrl, engine });
  try {
    const panes = Array.from({ length: 18 }, () => app.pane());
    panes.forEach((pane, i) => pane.show(`S${i + 1}`));
    await settle();
    await app.run(1000);
    const withWebgl = app.onScreenTabs().filter((tab) => app.hasLiveWebgl(tab)).length;
    await app.close('S1');
    await app.close('S2');
    await app.run(3000);
    return {
      withWebgl,
      waiting: 18 - withWebgl,
      onScreenWithoutWebglAfterClosingTwo: app.onScreenWithoutWebgl(),
      ...evictionSummary(app),
    };
  } finally {
    await app.dispose();
  }
}
