/**
 * Glyph fragments after the WebGL glyph atlas merges pages.
 *
 * addon-webgl 0.18 keeps one glyph atlas per font and colour set, shared by
 * every terminal, and merges four pages into one when it runs out of texture
 * units. From the second merge on, the merged page lands on a texture unit
 * whose recorded version happens to equal the new page's, so the texture is
 * never uploaded and every glyph on that page is drawn from the old one.
 * Measured headless after three merges: one texture unit 92% wrong, and every
 * glyph drawn from it in fragments (4371 wrong pixels over the two rows that
 * used it). The atlas also gets stuck rebuilding the whole render model on
 * every frame. Upstream fixed it (xterm.js #5883) only in addon-webgl 0.20,
 * which needs xterm 6.1.
 *
 * NexTerm watches the addon's public `onAddTextureAtlasCanvas`, and when a
 * merged page appears it remakes every live renderer together, so the shared
 * atlas loses its last owner and starts afresh — the second merge never comes.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  ATLAS_PAGE_SIZE,
  ATLAS_REBUILD_MIN_INTERVAL_MS,
  isAtlasMergePage,
  atlasRebuildDelay,
  planGpuReconcile,
} from '../../src/lib/webglLifecycle.js';

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

describe('Atlas page merges: the renderers are remade on a fresh atlas', () => {
  test('AR-01: only a merged page counts — every new page starts at 512 px', () => {
    assert.equal(ATLAS_PAGE_SIZE, 512);
    assert.equal(isAtlasMergePage({ width: 512 }), false, 'an ordinary new page');
    for (const width of [1024, 2048, 4096]) assert.equal(isAtlasMergePage({ width }), true, `${width}`);
    assert.equal(isAtlasMergePage(null), false);
    assert.equal(isAtlasMergePage(undefined), false);
    assert.equal(isAtlasMergePage({}), false);
  });

  test('AR-02: every flagged renderer is released and remade in the same pass, releases first', () => {
    const plan = planGpuReconcile([term({ rebuild: true }), term({ rebuild: true }), term({ attached: false })], { now: 1 });
    assert.deepEqual(plan.release.sort(), [0, 1, 2], 'both on screen, and the hidden one');
    assert.deepEqual(plan.create.sort(), [0, 1], 'the ones on screen come straight back');
  });

  test('AR-03: a rebuild is not a retry: no backoff applies to it', () => {
    const plan = planGpuReconcile([term({ rebuild: true, retryAt: 1e9 })], { now: 1 });
    assert.deepEqual(plan.create, [0]);
  });

  test('AR-04: within the budget the renderers being remade come before terminals still waiting', () => {
    const sixteen = Array.from({ length: 16 }, () => term({ rebuild: true }));
    const waiting = term({ hasGpu: false, attachedAt: 1e6 }); // shown most recently, but had no context
    const plan = planGpuReconcile([...sixteen, waiting], { now: 1e6 });
    assert.equal(plan.create.length, 16);
    assert.ok(!plan.create.includes(16), 'a rebuild must not cost a terminal its renderer');
  });

  test('AR-05: rebuilds are at least a second apart', () => {
    assert.equal(ATLAS_REBUILD_MIN_INTERVAL_MS, 1000);
    assert.equal(atlasRebuildDelay(null, 5000), 0, 'the first one is immediate');
    assert.equal(atlasRebuildDelay(5000, 5400), 600, 'one 400 ms later waits out the rest');
    assert.equal(atlasRebuildDelay(5000, 6000), 0);
    assert.equal(atlasRebuildDelay(5000, 9000), 0);
  });

  test('AR-06: the registry listens for merged pages and remakes EVERY live renderer', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8');
    const create = src.slice(src.indexOf('function createGpu('), src.indexOf('function refitOnScreen('));
    assert.match(create, /addon\.onAddTextureAtlasCanvas\(\(canvas\) => \{\s*if \(isAtlasMergePage\(canvas\)\) requestAtlasRebuild\(\);/);
    const request = src.slice(src.indexOf('function requestAtlasRebuild('), src.indexOf('function reconcileGpus('));
    assert.match(request, /for \(const entry of instances\.values\(\)\) \{\s*if \(entry\.gpu\) entry\.gpuRebuild = true;/,
      'the atlas is shared: remaking one renderer leaves the others bound to the stale texture');
  });
});
