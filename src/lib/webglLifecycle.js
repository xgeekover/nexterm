/**
 * When a terminal holds a WebGL context, when it gets one back, and how one is
 * let go.
 *
 * Pure functions only — no xterm, no DOM — so the rules can be tested in Node.
 * `components/terminal/terminalRegistry.js` applies them.
 *
 * Why there are rules at all: a page gets at most 16 live WebGL contexts
 * (Chromium, so WebView2, and WebKit, so WKWebView), and making a 17th
 * silently kills the OLDEST. Every terminal used to keep one for life, so the
 * 17th terminal took WebGL away from the first; a lost context was never
 * retried, leaving that terminal on the DOM renderer (box and block characters
 * striped at line height 1.5) for good; and a closed terminal's context was
 * never let go, so it kept counting until garbage collection. Measured
 * headless with 18 terminals and three close/open cycles: 13 kept WebGL, and
 * 5 were drawn by the DOM renderer when shown.
 *
 * Now only a terminal on screen holds a context, every renderer that is let go
 * takes its context with it, and a lost one is retried on a schedule that
 * cannot become a loop.
 */

/**
 * Contexts NexTerm keeps alive at most: the browsers' own cap. Creating one
 * past it evicts another terminal's, so a terminal over the budget waits on
 * the DOM renderer until a context comes free instead.
 */
export const GPU_CONTEXT_BUDGET = 16;

/** Automatic retries after a loss or a failed creation, in order. Then none. */
export const GPU_RETRY_DELAYS_MS = [1000, 5000, 30000];

/** A renderer that lived this long was healthy: its loss starts a fresh count. */
export const GPU_STABLE_MS = 60000;

/**
 * What to do with every terminal's WebGL renderer, given where each one is.
 *
 * Each element of `terminals` describes one terminal:
 *   attached     it is in a pane on screen
 *   connected    its element is in the document (the renderer measures the font)
 *   hasGpu       it holds a WebGL renderer now
 *   freshAttach  it was off screen at the last pass and is on screen now
 *   retryAt      when it may try again after a loss (see `gpuFailure`)
 *   attachedAt   when it was last put on screen
 *
 * Returns indexes into `terminals`. `release` is carried out before `create`,
 * so a context a hidden terminal gives back is the one a shown terminal gets.
 * Within the budget the most recently shown come first. `retryAt` is when the
 * earliest pending retry falls due, or null when nothing is waiting on time.
 */
export function planGpuReconcile(terminals, { now = 0, budget = GPU_CONTEXT_BUDGET } = {}) {
  const release = [];
  let live = 0;
  terminals.forEach((t, i) => {
    if (!t.hasGpu) return;
    if (!t.attached) release.push(i);
    else live += 1;
  });

  const ready = [];
  let retryAt = null;
  terminals.forEach((t, i) => {
    if (!t.attached || !t.connected) return;
    if (t.hasGpu) return;
    // Showing a terminal again is the user asking for it: no backoff.
    if (t.freshAttach || now >= (t.retryAt ?? 0)) {
      ready.push(i);
    } else if (Number.isFinite(t.retryAt) && (retryAt === null || t.retryAt < retryAt)) {
      retryAt = t.retryAt;
    }
  });
  ready.sort((a, b) => (terminals[b].attachedAt ?? 0) - (terminals[a].attachedAt ?? 0));

  return { release, create: ready.slice(0, Math.max(0, budget - live)), retryAt };
}

/**
 * Whether a terminal a pane has just started showing gets its renderer NOW —
 * synchronously, before the pane fits it — and which contexts must go first.
 *
 * Now, because the fit measures cells with whichever renderer is active, and
 * the DOM renderer's are wider (7.2 px against WebGL's 7 at the default
 * 12 px): fitted first, a terminal coming back got 104 columns, then 107 once
 * WebGL arrived — two reflows and two resizes for the program inside, on every
 * tab switch.
 *
 * `releaseFirst` lists terminals no longer on screen whose contexts are only
 * given back at the end of the pass; when they would put the page over the
 * budget meanwhile, the longest-hidden go now.
 */
export function planGpuAttach(terminals, index, { now = 0, budget = GPU_CONTEXT_BUDGET } = {}) {
  const { create } = planGpuReconcile(terminals, { now, budget });
  if (!create.includes(index)) return { create: false, releaseFirst: [] };
  const held = terminals.filter((t) => t.hasGpu).length;
  const spare = terminals
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.hasGpu && !t.attached)
    .sort((a, b) => (a.t.attachedAt ?? 0) - (b.t.attachedAt ?? 0))
    .map(({ i }) => i);
  return { create: true, releaseFirst: spare.slice(0, Math.max(0, held + 1 - budget)) };
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
 * The renderer and WebGL context inside an addon-webgl 0.18 `WebglAddon`.
 *
 * The ONE place NexTerm reads the addon's private fields (`_renderer`, the
 * WebglRenderer, and its `_gl`). Either may come back null — another version
 * can rename them — and every caller copes with that.
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
 * Let go of a WebGL addon AND its context.
 *
 * `dispose()` alone leaves the context alive until garbage collection, and a
 * context nothing can reach still counts against the browser's 16 (xterm.js
 * #6068) — which is how closed terminals evicted open ones. So the context is
 * taken before the dispose and lost on purpose after it, which hands the slot
 * back at once. A context that is already lost has no slot to give back.
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
 * resize made in between. A renderer made for a terminal being shown would
 * leave that first frame blank — a flash on every tab switch — or, after the
 * pane fitted the terminal to a new size, draw it at the old one. So the
 * renderer is sized to the terminal and drawn once here; xterm's own redraw
 * follows with the same picture.
 *
 * @returns {boolean} whether a frame was drawn
 */
export function drawWebglNow(addon, { cols, rows } = {}) {
  const { renderer } = webglInternals(addon);
  if (!renderer || typeof renderer.renderRows !== 'function' || !(rows > 0)) return false;
  try {
    const grid = rendererGrid(renderer);
    if (grid && (grid.cols !== cols || grid.rows !== rows) && typeof renderer.handleResize === 'function') {
      renderer.handleResize(cols, rows);
    }
    renderer.renderRows(0, rows - 1);
    return true;
  } catch {
    return false;
  }
}
