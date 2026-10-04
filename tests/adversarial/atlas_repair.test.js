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
 * merged page appears it repairs every renderer in place: each uploads its
 * pages again and rebuilds its cells, and the atlas stops asking for a
 * rebuild on every frame. No renderer is made or let go, so no WebGL context
 * is either — remaking them all, as the fix before this did, made up to
 * sixteen contexts at once.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  ATLAS_PAGE_SIZE,
  isAtlasMergePage,
  claimAtlasMergePage,
  repairWebglAtlas,
  settleWebglAtlas,
  planGpuReconcile,
} from '../../src/lib/webglLifecycle.js';

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
 * An addon-webgl 0.18 WebglAddon after a merge, down to what the repair
 * touches: the renderer's `_charAtlas`, its `_glyphRenderer` (a
 * MutableDisposable, hence `.value`) whose `setAtlas` sets every texture
 * unit's recorded version back to -1, and `_clearModel`.
 */
function addonAfterMerge() {
  const atlas = { _requestClearModel: true, pages: [{ version: 1 }, { version: 4 }] };
  const glyphs = {
    // Unit 0's recorded version equals the new page 0's: never uploaded again.
    _atlasTextures: [{ version: 1 }, { version: 3 }],
    setAtlas(next) {
      this._atlas = next;
      for (const texture of this._atlasTextures) texture.version = -1;
    },
  };
  const renderer = {
    _gl: { getExtension() {}, isContextLost: () => false },
    _charAtlas: atlas,
    _glyphRenderer: { value: glyphs },
    modelClears: [],
    _clearModel(clearGlyphRenderer) {
      this.modelClears.push(clearGlyphRenderer);
    },
  };
  return { addon: { _renderer: renderer }, atlas, glyphs, renderer };
}

/** The pages the renderer's next frame uploads: every one whose version it has not recorded. */
const pagesUploadedNext = ({ atlas, glyphs }) =>
  atlas.pages.map((page, i) => (page.version !== glyphs._atlasTextures[i].version ? i : -1)).filter((i) => i >= 0);

describe('Atlas page merges: every renderer is repaired in place', () => {
  test('AR-01: only a merged page counts — every new page starts at 512 px', () => {
    assert.equal(ATLAS_PAGE_SIZE, 512);
    assert.equal(isAtlasMergePage({ width: 512 }), false, 'an ordinary new page');
    for (const width of [1024, 2048, 4096]) assert.equal(isAtlasMergePage({ width }), true, `${width}`);
    assert.equal(isAtlasMergePage(null), false);
    assert.equal(isAtlasMergePage(undefined), false);
    assert.equal(isAtlasMergePage({}), false);
  });

  test('AR-02: the repair makes the next frame upload every page and rebuild every cell', () => {
    const merged = addonAfterMerge();
    assert.deepEqual(pagesUploadedNext(merged), [1], 'as 0.18 left it: page 0 would stay stale');
    assert.equal(repairWebglAtlas(merged.addon), merged.atlas, 'the atlas, for settling once all are repaired');
    assert.deepEqual(pagesUploadedNext(merged), [0, 1], 'every page uploaded again');
    assert.equal(merged.glyphs._atlas, merged.atlas, 're-bound to its own atlas, not another');
    assert.deepEqual(merged.renderer.modelClears, [true], 'vertex data rebuilt from the glyphs\' new places');
  });

  test('AR-03: the stuck whole-model rebuild is lowered once, and nothing else is touched', () => {
    const { atlas } = addonAfterMerge();
    assert.equal(settleWebglAtlas(atlas), true);
    assert.equal(atlas._requestClearModel, false, 'no more rebuilding every cell on every frame');
    assert.equal(settleWebglAtlas(atlas), false, 'already lowered');
    assert.equal(settleWebglAtlas(null), false);
    assert.equal(settleWebglAtlas({}), false, 'a version without the flag');
  });

  test('AR-04: an addon without those fields is left as it was — and remade instead', () => {
    assert.equal(repairWebglAtlas({}), null);
    assert.equal(repairWebglAtlas({ _renderer: { _charAtlas: {}, _glyphRenderer: {} } }), null, 'renamed: nothing changed');
    const hostile = { get _renderer() { throw new Error('renamed'); } };
    assert.equal(repairWebglAtlas(hostile), null);
    // The registry marks such a renderer `rebuild`: on screen it is remade in
    // the same pass, hidden it is let go and made again when shown.
    const plan = planGpuReconcile([term({ rebuild: true }), term({ rebuild: true, attached: false })], { now: 1 });
    assert.deepEqual(plan.release.sort(), [0, 1]);
    assert.deepEqual(plan.create, [0]);
    assert.deepEqual(planGpuReconcile([term({ rebuild: true, retryAt: 1e9 })], { now: 1 }).create, [0], 'not a retry: no backoff');
  });

  test('AR-05: a merge canvas forwarded through N renderers is acted on exactly once', () => {
    // addon-webgl gives every live WebglRenderer its own emitter, and the one
    // shared atlas forwards the SAME merge canvas through each of them —
    // simulated here as N separate calls (one "renderer" apiece) against the
    // one WeakSet the registry keeps module-wide.
    const handled = new WeakSet();
    const mergeCanvas = { width: 1024 };
    const rendererSawIt = () => claimAtlasMergePage(mergeCanvas, handled);

    assert.equal(rendererSawIt(), true, 'the first renderer to report this merge claims it');
    assert.equal(rendererSawIt(), false, 'a second renderer reporting the SAME merge must not claim it again');
    assert.equal(rendererSawIt(), false, 'nor a third');

    // A later, distinct merge (its own, bigger canvas) is its own event.
    assert.equal(claimAtlasMergePage({ width: 2048 }, handled), true);
    // An ordinary new page (not a merge) never claims anything, for anyone.
    assert.equal(claimAtlasMergePage({ width: ATLAS_PAGE_SIZE }, handled), false);
  });

  test('AR-06: the repair is written against addon-webgl 0.18 — the line for xterm 5', () => {
    // 0.20 fixes the merge itself and needs xterm 6.1; moving to it makes the
    // repair unnecessary and its private fields unknown (it then remakes).
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.dependencies['@xterm/addon-webgl'], /^\^0\.18\./);
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    assert.match(lock.packages['node_modules/@xterm/addon-webgl'].version, /^0\.18\./);
  });
});
