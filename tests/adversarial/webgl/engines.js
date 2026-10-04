/**
 * The browsers' WebGL context caps, rule for rule, for the model tests.
 *
 * NexTerm draws every terminal with WebGL, and a page gets a limited number of
 * live contexts. What happens at the limit decides which terminal goes blank,
 * and the two engines NexTerm ships on decide it differently. Nothing in Node
 * has WebGL, so these are models — small enough to read against the engines'
 * own source:
 *
 * WebKit (WKWebView, so macOS), `Source/WebCore/html/canvas/
 * WebGLRenderingContextBase.cpp`, unchanged since 2022 (bug 222411):
 *   - `maxActiveContexts = 16`; `activeContexts()` is every context that has
 *     not been DESTROYED.
 *   - `addActiveContext`: when the set already holds 16, the context with the
 *     LOWEST `activeOrdinal()` is recycled — `forceLostContext` plus
 *     `destroyGraphicsContextGL`, which takes it out of the set.
 *   - `updateActiveOrdinal()` runs in `initializeNewContext()` and at the top
 *     of `clearIfComposited()`, which every draw call and `clear` goes
 *     through: the ordinal is "when this context last drew".
 *   - `WEBGL_lose_context.loseContext()` is `forceLostContext`, which does NOT
 *     destroy: a context lost on purpose keeps its slot until garbage
 *     collection destroys it (`~WebGLRenderingContextBase`).
 *   - The lost event is always dispatched as a queued task.
 *
 * Chromium (WebView2, so Windows), `third_party/blink/.../
 * webgl_rendering_context_base.cc`:
 *   - 16 active contexts; making a 17th forcibly loses `OldestContext()`, the
 *     one with the lowest `GetLastFlushIdCHROMIUM()` — the least recently
 *     FLUSHED, which a draw alone does not change until the frame is flushed.
 *   - `loseContext()` destroys the context and `DeactivateContext`s it: the
 *     slot comes back at once.
 *
 * `gc()` is the collector: it destroys every context whose owner let go of it
 * (`collectable`). Tests that never call it are the worst case for WebKit.
 */

let nextId = 0;

class FakeContext {
  constructor(engine, owner) {
    this.engine = engine;
    this.owner = owner;
    this.id = ++nextId;
    this.lost = false;
    this.destroyed = false;
    this.collectable = false;
    this.draws = 0;
    this.ordinal = 0;
    this.flushId = 0;
    this.drewSinceFlush = false;
    this._lostListeners = new Set();
  }

  isContextLost() {
    return this.lost;
  }

  getExtension(name) {
    if (name !== 'WEBGL_lose_context') return null;
    return {
      loseContext: () => this.engine.loseContext(this),
      restoreContext: () => {},
    };
  }

  flush() {
    this.engine.flush(this);
  }

  /** What addon-webgl does on `webglcontextlost`: a listener on its canvas. */
  onLost(listener) {
    this._lostListeners.add(listener);
    return { dispose: () => this._lostListeners.delete(listener) };
  }

  _forceLost() {
    if (this.lost) return;
    this.lost = true;
    // "Always defer the dispatch of the context lost event."
    this.engine.timers.setTimeout(() => {
      for (const listener of [...this._lostListeners]) listener();
    }, 0);
  }

  _destroy() {
    this.destroyed = true;
    this.engine.active.delete(this);
  }
}

class Engine {
  constructor({ max = 16, timers = globalThis, describeOwner = () => ({}) } = {}) {
    this.max = max;
    this.timers = timers;
    this.describeOwner = describeOwner;
    this.active = new Set();
    this.created = 0;
    this.evictions = [];
  }

  /** `canvas.getContext('webgl2')`. */
  create(owner) {
    const context = new FakeContext(this, owner);
    this.created += 1;
    this._admit(context);
    return context;
  }

  _evict(victim) {
    this.evictions.push({
      id: victim.id,
      alreadyLost: victim.lost,
      collectable: victim.collectable,
      ...this.describeOwner(victim.owner),
    });
    victim._forceLost();
    victim._destroy();
  }

  /** Every context it has given out and not destroyed, lost or not. */
  get slotsHeld() {
    return this.active.size;
  }

  gc() {
    for (const context of [...this.active]) if (context.collectable) context._destroy();
  }
}

export class WebKitEngine extends Engine {
  constructor(options) {
    super(options);
    this.name = 'webkit';
    this.lastOrdinal = 0;
  }

  _admit(context) {
    // initializeNewContext(): updateActiveOrdinal(), then addActiveContext().
    context.ordinal = ++this.lastOrdinal;
    if (this.active.size >= this.max) {
      let earliest = null;
      for (const c of this.active) if (!earliest || c.ordinal < earliest.ordinal) earliest = c;
      this._evict(earliest);
    }
    this.active.add(context);
  }

  /** Any draw call or clear: clearIfComposited() → updateActiveOrdinal(). */
  draw(context) {
    if (context.lost) return false;
    context.ordinal = ++this.lastOrdinal;
    context.draws += 1;
    return true;
  }

  flush() {}

  /** Compositing: prepareForDisplay() also goes through clearIfComposited(). */
  endFrame() {}

  /** forceLostContext(SyntheticLostContext): lost, but still in the set. */
  loseContext(context) {
    context._forceLost();
  }
}

export class ChromiumEngine extends Engine {
  constructor(options) {
    super(options);
    this.name = 'chromium';
    this.lastFlush = 0;
  }

  _admit(context) {
    if (this.active.size >= this.max) {
      let oldest = null;
      for (const c of this.active) if (!oldest || c.flushId < oldest.flushId) oldest = c;
      this._evict(oldest);
    }
    context.flushId = ++this.lastFlush;
    this.active.add(context);
  }

  draw(context) {
    if (context.lost) return false;
    context.draws += 1;
    context.drewSinceFlush = true;
    return true;
  }

  flush(context) {
    if (context.lost) return;
    context.flushId = ++this.lastFlush;
    context.drewSinceFlush = false;
  }

  /** Every context that drew this frame is flushed when the frame is presented. */
  endFrame() {
    for (const c of this.active) if (c.drewSinceFlush) this.flush(c);
  }

  /** LoseContextImpl → DestroyContext + DeactivateContext: the slot is free now. */
  loseContext(context) {
    context._forceLost();
    context._destroy();
  }
}

export function createEngine(name, options) {
  if (name === 'webkit') return new WebKitEngine(options);
  if (name === 'chromium') return new ChromiumEngine(options);
  throw new Error(`unknown engine ${name}`);
}
