/**
 * When a terminal holds a WebGL context, when it gets one back, and how one is
 * let go.
 *
 * Pure functions, plus the few guarded reads of addon-webgl's private fields
 * — no DOM — so the rules can be tested in Node.
 * `components/terminal/terminalRegistry.js` applies them.
 *
 * Why there are rules at all: a page gets at most 16 live WebGL contexts, and
 * making one more silently kills another. Every terminal used to keep one
 * for life, so the 17th terminal took WebGL away from the first; a lost
 * context was never retried, leaving that terminal on the DOM renderer (box
 * and block characters striped at line height 1.5) for good; and a closed
 * terminal's context was never let go, so it kept counting until garbage
 * collection.
 *
 * WHICH context is killed is the engine's choice, and the two NexTerm runs on
 * choose alike — the one that has gone longest without drawing:
 *
 *   - WebKit (WKWebView, macOS) recycles the context with the lowest "active
 *     ordinal", which a context takes when it is made and again on every draw
 *     call. A context lost on purpose (`WEBGL_lose_context`) KEEPS its slot
 *     until it is garbage collected.
 *   - Chromium (WebView2, Windows) loses the least recently flushed context.
 *     A context lost on purpose gives its slot back at once.
 *
 * So the slots are not the scarce thing on WebKit — making contexts is. A
 * terminal that only held one while on screen made a new one on every tab
 * switch, the lost ones piled up until garbage collection, and the next one
 * made pushed out the context that had gone longest without drawing: an idle
 * terminal in the pane beside, on screen and untouched (seen on macOS: twenty
 * tab switches, fast or a second apart, and the terminal in the other pane
 * went blank for four seconds).
 *
 * Now:
 *   - a terminal makes its context the first time it is shown and keeps it,
 *     hidden or not — switching tabs or groups makes none;
 *   - past sixteen, the hidden terminal that has gone longest without drawing
 *     gives its context back before another is made, and every terminal on
 *     screen draws first, so that whatever the engine picks to push out has
 *     not been drawn since;
 *   - a lost context is retried on a schedule that cannot become a loop, and
 *     a hidden terminal whose context was lost gets a new one when it is
 *     shown;
 *   - a glyph atlas that merged pages is repaired in place, with no new
 *     context at all (`repairWebglAtlas`).
 */

/**
 * Contexts a page can hold: the engines' own cap (WebKit's
 * `maxActiveContexts`, Chromium's `kMaxGLActiveContexts`). More terminals on
 * screen than this wait on the DOM renderer instead of evicting each other.
 */
export const GPU_CONTEXT_BUDGET = 16;

/** Automatic retries after a loss or a failed creation, in order. Then none. */
export const GPU_RETRY_DELAYS_MS = [1000, 5000, 30000];

/** A renderer that lived this long was healthy: its loss starts a fresh count. */
export const GPU_STABLE_MS = 60000;

/** Every page addon-webgl (0.18, 0.19) adds to a glyph atlas starts at this size. */
export const ATLAS_PAGE_SIZE = 512;

/**
 * Which hidden renderers give their contexts back so that `count` more can be
 * made without the page going past `budget`, least recently drawn first.
 * `holds(t, i)` says whether terminal `i` still counts as holding one.
 * Returns null when there are not enough hidden ones to let go.
 */
function roomFor(terminals, count, budget, holds) {
  let held = 0;
  terminals.forEach((t, i) => {
    if (holds(t, i)) held += 1;
  });
  const over = held + count - budget;
  if (over <= 0) return [];
  const spare = terminals
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => !t.attached && holds(t, i))
    .sort((a, b) => (a.t.drawnAt ?? 0) - (b.t.drawnAt ?? 0))
    .map(({ i }) => i);
  return spare.length >= over ? spare.slice(0, over) : null;
}

/**
 * What to do with every terminal's WebGL renderer, given where each one is.
 *
 * Each element of `terminals` describes one terminal:
 *   attached     it is in a pane on screen
 *   connected    its element is in the document (the renderer measures the font)
 *   hasGpu       it holds a WebGL renderer
 *   lost         that renderer's context is lost (addon-webgl reports it 3 s later)
 *   rebuild      its renderer must be made again (an atlas it could not repair)
 *   freshAttach  it was off screen at the last pass and is on screen now
 *   retryAt      when it may try again after a loss (see `gpuFailure`)
 *   attachedAt   when it was last put on screen
 *   drawnAt      when its renderer last drew
 *
 * Returns indexes into `terminals`. `release` is carried out before `create`.
 * A hidden terminal keeps its renderer: only one marked `rebuild` is let go,
 * and — when the page already holds `budget` contexts — the hidden ones that
 * have gone longest without drawing, one for every context about to be made.
 * At most `budget` terminals on screen hold a context; within that, terminals
 * being remade come first (they had one a moment ago), then the most recently
 * shown. `retryAt` is when the earliest pending retry falls due, or null when
 * nothing is waiting on time.
 */
export function planGpuReconcile(terminals, { now = 0, budget = GPU_CONTEXT_BUDGET } = {}) {
  const release = [];
  const releasing = new Set();
  const drop = (i) => {
    if (releasing.has(i)) return;
    releasing.add(i);
    release.push(i);
  };
  terminals.forEach((t, i) => {
    if (t.hasGpu && t.rebuild) drop(i);
  });
  const creating = new Set();
  const holds = (t, i) => creating.has(i) || (t.hasGpu && !t.lost && !releasing.has(i));

  let onScreen = 0;
  terminals.forEach((t, i) => {
    if (t.attached && holds(t, i)) onScreen += 1;
  });

  const ready = [];
  let retryAt = null;
  terminals.forEach((t, i) => {
    if (!t.attached || !t.connected) return;
    if (t.hasGpu && !releasing.has(i)) return; // drawing, or lost and about to be reported
    // A rebuild is not a retry, and showing a terminal again is the user
    // asking for it: neither waits out a backoff.
    if (t.rebuild || t.freshAttach || now >= (t.retryAt ?? 0)) {
      ready.push(i);
    } else if (Number.isFinite(t.retryAt) && (retryAt === null || t.retryAt < retryAt)) {
      retryAt = t.retryAt;
    }
  });
  ready.sort((a, b) => {
    const ta = terminals[a];
    const tb = terminals[b];
    if (Boolean(ta.rebuild) !== Boolean(tb.rebuild)) return ta.rebuild ? -1 : 1;
    return (tb.attachedAt ?? 0) - (ta.attachedAt ?? 0);
  });

  const create = [];
  for (const i of ready) {
    if (onScreen >= budget) break;
    const room = roomFor(terminals, 1, budget, holds);
    if (room === null) break;
    room.forEach(drop);
    create.push(i);
    creating.add(i);
    onScreen += 1;
  }
  return { release, create, retryAt };
}

/**
 * Whether a terminal a pane has just started showing gets its renderer NOW —
 * synchronously, before the pane fits it — and which hidden renderers must
 * give their contexts back first.
 *
 * Now, because the fit measures cells with whichever renderer is active, and
 * the DOM renderer's are wider (7.2 px against WebGL's 7 at the default
 * 12 px): fitted first, a terminal coming back got 104 columns, then 107 once
 * WebGL arrived — two reflows and two resizes for the program inside.
 *
 * Only a terminal without a renderer gets one; one it kept while hidden is
 * simply drawn again. Showing it is the user asking, so no backoff applies.
 */
export function planGpuAttach(terminals, index, { budget = GPU_CONTEXT_BUDGET } = {}) {
  const t = terminals[index];
  if (!t || !t.attached || !t.connected || t.hasGpu) return { create: false, releaseFirst: [] };
  const holds = (u, i) => u.hasGpu && !u.lost && !u.rebuild && i !== index;
  let onScreen = 0;
  terminals.forEach((u, i) => {
    if (u.attached && holds(u, i)) onScreen += 1;
  });
  if (onScreen >= budget) return { create: false, releaseFirst: [] };
  const room = roomFor(terminals, 1, budget, holds);
  if (room === null) return { create: false, releaseFirst: [] };
  return { create: true, releaseFirst: room };
}

/**
 * Whether the terminals on screen must draw before a context is made.
 *
 * The context the engine pushes out is the one that has gone longest without
 * drawing, and an idle terminal on screen — unfocused, its cursor not
 * blinking, nothing printed — may not have drawn for an hour. Drawn just
 * before, every terminal on screen is newer than anything the engine could
 * pick.
 *
 * Always true. This used to be "only near the cap", judged from `held` (the
 * contexts NexTerm keeps, after the releases planned) plus `lingering` (ones
 * it let go that may not be collected yet — WebKit still counts those) — but
 * `lingering` comes from a `WeakRef`, and the two engines disagree about WHEN
 * a released context's slot is actually freed relative to when a `WeakRef`
 * to it clears: JavaScriptCore clears a `WeakRef` at the end of marking, while
 * WebKit frees the slot only later, when the sweeper destroys the context.
 * Several contexts released together (closing many tabs) can all drop out of
 * `lingering` while WebKit still holds every one of their slots, undercounting
 * exactly when the page is actually near the cap — and the next context made
 * then evicts the least-recently-drawn idle pane on screen instead of one of
 * those. Making a context at all is rare once v2's `ensureGpuRenderer` keeps
 * one for as long as the terminal exists, hidden or not, so drawing ahead
 * every time costs nothing.
 */
export function mustDrawScreenFirst() {
  return true;
}

/**
 * The retry state after a terminal's WebGL renderer was lost, or could not be
 * made at all.
 *
 * From here two kinds of loss look the same: the GPU going away (sleep, a
 * driver reset — worth another try in a moment) and the context cap evicting
 * this one to make room (where a retry evicts someone else, who retries, who
 * evicts...). So a retry is never immediate and never endless: 1 s, 5 s,
 * 30 s, then nothing until the terminal is shown again. A renderer that had
 * been fine for a minute starts the count afresh — one loss after an hour of
 * work is not the third strike of a loop.
 */
export function gpuFailure({ failures = 0, createdAt = null } = {}, now = 0) {
  const healthy = createdAt !== null && createdAt !== undefined && now - createdAt >= GPU_STABLE_MS;
  const count = (healthy ? 0 : failures) + 1;
  const delay = GPU_RETRY_DELAYS_MS[count - 1];
  return { failures: count, retryAt: delay === undefined ? Infinity : now + delay };
}

/**
 * Whether a page just added to a glyph atlas came out of a merge.
 *
 * addon-webgl 0.18 corrupts glyphs once its atlas has merged pages twice: the
 * merged page lands on a texture unit whose recorded version equals the new
 * page's, so the texture is never uploaded and every glyph on that page is
 * drawn from the old one — fragments (xterm.js #5847; the fix, #5883, ships in
 * addon-webgl 0.20, which needs xterm 6.1). 0.19, the line for xterm 6.0,
 * merges the same way: measured headless with this repair switched off, three
 * merges left a texture unit 93% stale and 3018 pixels wrong, on screen and in
 * a terminal hidden through them; with it, none. A merge is the only thing that
 * adds a page larger than the size every new page starts at, and the addon's
 * public `onAddTextureAtlasCanvas` reports every page added.
 */
export function isAtlasMergePage(canvas) {
  return Boolean(canvas) && Number(canvas.width) > ATLAS_PAGE_SIZE;
}

/**
 * Whether THIS call is the one that gets to act on `canvas`.
 *
 * The atlas is shared, but `onAddTextureAtlasCanvas` is not: addon-webgl
 * gives every live `WebglRenderer` its own emitter, and forwards the ONE
 * shared atlas's merge to each of them in turn — so N renderers watching the
 * same atlas report the exact same merge canvas N times. Answering the
 * question with the canvas's OWN identity (never seen before, for this
 * `handled` set) rather than with time (a renderer counted) is what makes
 * this exact, however many renderers are attached. `handled` is a WeakSet so
 * a canvas the atlas has since discarded costs nothing to keep track of.
 *
 * Only a merge page claims anything; an ordinary new page is never owed a
 * repair and never occupies the set.
 */
export function claimAtlasMergePage(canvas, handled) {
  if (!isAtlasMergePage(canvas)) return false;
  if (handled.has(canvas)) return false;
  handled.add(canvas);
  return true;
}

/**
 * The renderer and WebGL context inside an addon-webgl `WebglAddon` (0.18 and
 * 0.19 name them alike).
 *
 * NexTerm reads the addon's private fields only through this and the two
 * atlas helpers below (`_renderer`, the WebglRenderer, and its `_gl`). Either
 * may come back null — another version can rename them — and every caller
 * copes with that.
 */
export function webglInternals(addon) {
  try {
    const renderer = addon?._renderer;
    if (!renderer || typeof renderer !== 'object') return { renderer: null, gl: null };
    const gl = renderer._gl;
    return { renderer, gl: gl && typeof gl.getExtension === 'function' ? gl : null };
  } catch {
    return { renderer: null, gl: null };
  }
}

/**
 * Whether the addon's context is lost — known at once, where addon-webgl only
 * reports it after waiting 3 s for a restore that, for a context the engine
 * pushed out, never comes.
 */
export function isWebglContextLost(addon) {
  const { gl } = webglInternals(addon);
  try {
    return Boolean(gl && gl.isContextLost());
  } catch {
    return false;
  }
}

/**
 * Let go of a WebGL addon AND its context.
 *
 * `dispose()` alone leaves the context alive until garbage collection, and a
 * context nothing can reach still counts against the cap (xterm.js #6068) —
 * which is how closed terminals evicted open ones. So the context is taken
 * before the dispose and lost on purpose after it: Chromium hands the slot
 * back at once; WebKit keeps it until collection, but a lost context is the
 * first one it recycles. A context that is already lost is left alone.
 *
 * @returns {{ disposed: boolean, freedContext: boolean }}
 */
export function releaseWebglAddon(addon) {
  if (!addon) return { disposed: false, freedContext: false };
  const { gl } = webglInternals(addon);
  let disposed = false;
  try {
    addon.dispose();
    disposed = true;
  } catch (err) {
    // The context still has to go, or it is the leak this exists to stop.
    console.warn('[Terminal] disposing the WebGL renderer failed:', err);
  }
  let freedContext = false;
  try {
    if (gl && !gl.isContextLost()) {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        lose.loseContext();
        freedContext = true;
      }
    }
  } catch {
    // Nothing left to free.
  }
  return { disposed, freedContext };
}

/** The grid a WebGL renderer is currently sized for, from its public dimensions. */
function rendererGrid(renderer) {
  const css = renderer?.dimensions?.css;
  if (!css || !(css.cell?.width > 0) || !(css.cell?.height > 0)) return null;
  return {
    cols: Math.round(css.canvas.width / css.cell.width),
    rows: Math.round(css.canvas.height / css.cell.height),
  };
}

/**
 * Draw a WebGL renderer's whole viewport now, at the terminal's current size,
 * instead of on its next frame.
 *
 * xterm pauses drawing while it believes a terminal is off screen and learns
 * that it is back from an IntersectionObserver one frame later, holding back a
 * resize made in between. A terminal just shown would leave that first frame
 * blank — a flash on every tab switch — or, after the pane fitted it to a new
 * size, draw it at the old one. So the renderer is sized to the terminal and
 * drawn once here; xterm's own redraw follows with the same picture.
 *
 * The same whole-viewport draw is what a terminal on screen does before a new
 * context is made (`mustDrawScreenFirst`), and `flush` sends the commands on
 * at once — Chromium ranks contexts by their last flush, not their last draw.
 *
 * Never inside a synchronized update (DEC 2026, `CSI ? 2026 h` … `l`): the
 * program has said the screen is half written, and xterm holds every frame
 * back until it says otherwise. This draw goes round xterm's own render
 * service, so it has to hold back as well — measured: a terminal shown again
 * mid-update, or an atlas repair, drew the half-written frame. Returns false
 * then, and xterm draws the whole viewport once the update ends.
 *
 * @returns {boolean} whether a frame was drawn
 */
export function drawWebglNow(addon, { cols, rows, modes } = {}, { flush = false } = {}) {
  const { renderer, gl } = webglInternals(addon);
  if (!renderer || typeof renderer.renderRows !== 'function' || !(rows > 0)) return false;
  if (modes?.synchronizedOutputMode) return false;
  try {
    if (gl && gl.isContextLost()) return false;
    const grid = rendererGrid(renderer);
    if (grid && (grid.cols !== cols || grid.rows !== rows) && typeof renderer.handleResize === 'function') {
      renderer.handleResize(cols, rows);
    }
    renderer.renderRows(0, rows - 1);
    if (flush && gl && typeof gl.flush === 'function') gl.flush();
    return true;
  } catch {
    return false;
  }
}

/**
 * Repair one renderer after its glyph atlas merged pages, in place — no new
 * renderer, so no new context.
 *
 * A merge leaves two things wrong in addon-webgl 0.18 and 0.19 (#5847): a texture unit
 * can keep the page it held before (the recorded version happens to equal the
 * new page's, so the page is never uploaded), and the cells built before the
 * merge still point at where their glyphs used to be. `GlyphRenderer.setAtlas`
 * sets every texture unit's recorded version to -1, so the next frame uploads
 * every page again — what a resize does, which is why one column narrower and
 * back repaired the picture in the lab — and `_clearModel(true)` makes the
 * next frame rebuild every cell from the glyphs' new places. That next frame
 * has to draw the whole viewport, or the rows it skipped come out blank.
 *
 * Returns the atlas (see `settleWebglAtlas`), or null when the private fields
 * are not there — another addon version — and nothing was changed.
 */
export function repairWebglAtlas(addon) {
  const { renderer } = webglInternals(addon);
  try {
    const glyphs = renderer?._glyphRenderer?.value;
    const atlas = renderer?._charAtlas;
    if (!atlas || typeof glyphs?.setAtlas !== 'function' || typeof renderer._clearModel !== 'function') return null;
    glyphs.setAtlas(atlas);
    renderer._clearModel(true);
    return atlas;
  } catch {
    return null;
  }
}

/**
 * End the whole-model rebuild addon-webgl 0.18/0.19 asks every renderer for on
 * every frame after a merge: the atlas raises `_requestClearModel` and never
 * lowers it (#5883 does). Only once every renderer drawing from `atlas` has
 * been through `repairWebglAtlas` — the flag is what told the others to
 * rebuild. Returns whether it was raised.
 */
export function settleWebglAtlas(atlas) {
  try {
    if (atlas && atlas._requestClearModel === true) {
      atlas._requestClearModel = false;
      return true;
    }
  } catch {
    // A version without the flag has nothing to settle.
  }
  return false;
}
