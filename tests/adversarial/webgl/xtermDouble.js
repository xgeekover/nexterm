/**
 * Just enough of @xterm/xterm and its addons for `terminalRegistry.js` to run
 * in Node, with every WebGL context going through a model of the browser's
 * context cap (`engines.js`). `loader.mjs` resolves every `@xterm/*` import to
 * this file.
 *
 * What it reproduces, because the registry's decisions depend on it:
 *
 *   - xterm draws a terminal only while it is on screen (its
 *     IntersectionObserver pauses the rest), draws it in full when it comes
 *     back, and redraws the cursor of the FOCUSED terminal as it blinks. An
 *     unfocused terminal with no output never draws — which is what made it
 *     the least recently drawn context, and WebKit's victim.
 *   - addon-webgl 0.18: `activate` asks the canvas for a context (which may
 *     evict another), a renderer draws through it, and a lost context is
 *     reported through `onContextLoss` only after a 3 s wait for a restore.
 *     `dispose()` removes the canvas — the context is the collector's then —
 *     but does not lose it.
 *   - its shared glyph atlas: a page merge is announced through every live
 *     renderer's `onAddTextureAtlasCanvas` (the same canvas, once per
 *     renderer), leaves `_requestClearModel` stuck on, and leaves every
 *     renderer's textures and vertex data describing the old pages until
 *     they are uploaded and rebuilt again.
 *
 * Everything is reached through `globalThis.__nextermWebglModel`, which the
 * harness installs: `{ engine, terminals, renderers, failCreate }`, plus the
 * atlas cache below.
 */

function world() {
  const model = globalThis.__nextermWebglModel;
  if (!model) throw new Error('the xterm double is only usable inside a WebGL model scenario');
  return model;
}

class Emitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return { dispose: () => this._listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of [...this._listeners]) listener(value);
  }
}

const CELL = { width: 7, height: 18 };

export class Terminal {
  constructor(options = {}) {
    this.options = { ...options };
    this.cols = 80;
    this.rows = 24;
    // xterm's unicode handling: a version must be registered before it can be
    // made active, as `@xterm/addon-unicode-graphemes` does on activation.
    const versions = ['6'];
    let activeVersion = '6';
    this.unicode = {
      get versions() {
        return versions.slice();
      },
      get activeVersion() {
        return activeVersion;
      },
      set activeVersion(version) {
        if (!versions.includes(version)) throw new Error(`unknown Unicode version "${version}"`);
        activeVersion = version;
      },
      register(provider) {
        versions.push(provider.version);
      },
    };
    this.modes = { mouseTrackingMode: 'none' };
    this.buffer = {
      active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, length: 0, getLine: () => undefined },
    };
    this.element = undefined;
    this.textarea = undefined;
    this.focused = false;
    this.disposed = false;
    /** The WebGL renderer drawing this terminal; null while xterm's DOM renderer does. */
    this.webglRenderer = null;
    this._addons = [];
    this._render = new Emitter();
    this._noop = () => ({ dispose() {} });
    this.onRender = this._render.event;
    this.onData = this._noop;
    this.onCursorMove = this._noop;
    this.onScroll = this._noop;
    this._dirty = false;
    this._wasOnScreen = false;
    this._lastBlink = -Infinity;
    world().terminals.add(this);
  }

  get onScreen() {
    return !this.disposed && Boolean(this.element && this.element.isConnected);
  }

  open(container) {
    this.element = container;
  }

  loadAddon(addon) {
    this._addons.push(addon);
    addon.activate(this);
  }

  attachCustomKeyEventHandler() {}

  registerLinkProvider() {
    return { dispose() {} };
  }

  focus() {}

  input() {}

  scrollToBottom() {}

  write(_data, callback) {
    this.refresh(0, this.rows - 1);
    callback?.();
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.webglRenderer?.handleResize(cols, rows);
    this.refresh(0, rows - 1);
  }

  /** On the next frame, or — while off screen — in full when it is back. */
  refresh() {
    this._dirty = true;
  }

  /** One animation frame of xterm's RenderService. */
  frame(now) {
    if (!this.onScreen) {
      this._wasOnScreen = false;
      return;
    }
    if (!this._wasOnScreen) {
      this._wasOnScreen = true;
      this._dirty = true;
    }
    if (this.focused && this.options.cursorBlink && now - this._lastBlink >= 600) {
      this._lastBlink = now;
      this._dirty = true;
    }
    if (!this._dirty) return;
    this._dirty = false;
    this.webglRenderer?.renderRows(0, this.rows - 1);
    this._render.fire({ start: 0, end: this.rows - 1 });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const addon of this._addons.splice(0)) addon.dispose?.();
    world().terminals.delete(this);
  }
}

export class FitAddon {
  activate(term) {
    this._term = term;
  }

  dispose() {}

  proposeDimensions() {
    return { cols: this._term.cols, rows: this._term.rows };
  }

  fit() {}
}

/** As @xterm/addon-unicode-graphemes 0.4: registers its providers and switches to the grapheme one. */
export class UnicodeGraphemesAddon {
  activate(term) {
    term.unicode.register({ version: '15' });
    term.unicode.register({ version: '15-graphemes' });
    term.unicode.activeVersion = '15-graphemes';
  }

  dispose() {}
}

export class SearchAddon {
  activate() {}

  dispose() {}

  findNext() {
    return false;
  }

  findPrevious() {
    return false;
  }

  clearDecorations() {}

  onDidChangeResults() {
    return { dispose() {} };
  }
}

/** GlyphRenderer's texture bookkeeping: what it would upload on its next frame. */
class GlyphRendererDouble {
  constructor() {
    this.texturesReset = false;
    this.setAtlasCalls = 0;
  }

  setAtlas(atlas) {
    this._atlas = atlas;
    this.setAtlasCalls += 1;
    // Every texture unit's recorded version goes back to -1.
    this.texturesReset = true;
  }
}

class WebglRendererDouble {
  constructor(term, gl, atlas, addon) {
    this._term = term;
    this._gl = gl;
    this._addon = addon;
    this._charAtlas = atlas;
    this._glyphRenderer = { value: new GlyphRendererDouble() };
    this._glyphRenderer.value.setAtlas(atlas);
    this._glyphRenderer.value.texturesReset = false; // a new renderer uploads everything anyway
    this.dimensions = this._dimensionsFor(term.cols, term.rows);
    this.disposed = false;
    this.frames = 0;
    this.modelClears = 0;
    /** The model was cleared: the next frame has to rebuild every row. */
    this.needsFullFrame = false;
    /** Frames drawn with textures or vertex data from before an atlas merge. */
    this.staleFrames = 0;
    /** Frames that drew only some rows of a cleared model: the rest came out blank. */
    this.blankRowFrames = 0;
    this.staleTextures = false;
    this.staleVertices = false;
    atlas.attach(this);
    world().renderers.push(this);
  }

  _dimensionsFor(cols, rows) {
    return { css: { canvas: { width: cols * CELL.width, height: rows * CELL.height }, cell: { ...CELL } } };
  }

  handleResize(cols, rows) {
    this.dimensions = this._dimensionsFor(cols, rows);
    // A resize re-binds the atlas (every texture again) and clears the model.
    this._glyphRenderer.value.setAtlas(this._charAtlas);
    this.needsFullFrame = true;
  }

  _clearModel() {
    this.modelClears += 1;
    this.needsFullFrame = true;
  }

  renderRows(start, end) {
    if (this.disposed) return;
    let full = start <= 0 && end >= this._term.rows - 1;
    if (this._charAtlas.beginFrame()) {
      // addon-webgl rebuilds the whole viewport's model when the atlas asks it to.
      this.needsFullFrame = true;
      full = true;
    }
    if (this.needsFullFrame) {
      if (full) this.staleVertices = false;
      else this.blankRowFrames += 1;
      this.needsFullFrame = false;
    }
    const glyphs = this._glyphRenderer.value;
    if (glyphs.texturesReset) {
      glyphs.texturesReset = false;
      this.staleTextures = false;
    }
    if (this.staleTextures || this.staleVertices) this.staleFrames += 1;
    this.frames += 1;
    world().engine.draw(this._gl);
  }

  dispose() {
    this.disposed = true;
    this._charAtlas.detach(this);
  }
}

export class WebglAddon {
  constructor() {
    this._contextLoss = new Emitter();
    this.onContextLoss = this._contextLoss.event;
    this._atlasCanvas = new Emitter();
    this.onAddTextureAtlasCanvas = this._atlasCanvas.event;
    this._renderer = undefined;
    this._disposed = false;
  }

  activate(term) {
    const model = world();
    if (model.failCreate) throw new Error('WebGL2 not supported');
    const gl = model.engine.create(this);
    this._term = term;
    this._renderer = new WebglRendererDouble(term, gl, acquireAtlas(), this);
    term.webglRenderer = this._renderer;
    // addon-webgl: preventDefault, then wait 3 s for a restore before giving up.
    this._lossWatch = gl.onLost(() => {
      if (this._disposed) return;
      setTimeout(() => {
        if (!this._disposed) this._contextLoss.fire();
      }, 3000);
    });
  }

  clearTextureAtlas() {}

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._lossWatch?.dispose();
    const renderer = this._renderer;
    if (!renderer) return;
    renderer.dispose();
    if (this._term && this._term.webglRenderer === renderer) this._term.webglRenderer = null;
    // The canvas is out of the document and nothing holds it: the collector's.
    renderer._gl.collectable = true;
  }
}

/**
 * addon-webgl's CharAtlasCache: every renderer with the same font and colours
 * shares one atlas, and an atlas whose last renderer went away is dropped —
 * the next renderer starts a fresh one.
 */
export function acquireAtlas() {
  const model = world();
  if (!model.atlas || model.atlas.renderers.size === 0) model.atlas = new AtlasDouble();
  return model.atlas;
}

/**
 * addon-webgl 0.18's shared TextureAtlas, as far as a page merge goes.
 */
export class AtlasDouble {
  constructor() {
    this.pages = [{ canvas: { width: 512 }, version: 0 }];
    this._requestClearModel = false;
    this.renderers = new Set();
    this.merges = 0;
  }

  attach(renderer) {
    this.renderers.add(renderer);
  }

  detach(renderer) {
    this.renderers.delete(renderer);
  }

  beginFrame() {
    return this._requestClearModel;
  }

  /** Four pages become one twice their size; 0.18 never resets the flag. */
  merge() {
    this.merges += 1;
    const merged = { canvas: { width: 1024 }, version: 1 };
    const fresh = { canvas: { width: 512 }, version: 0 };
    this.pages.push(merged, fresh);
    this._requestClearModel = true;
    for (const renderer of this.renderers) {
      // Whatever each renderer uploaded and built describes the old pages.
      renderer.staleTextures = true;
      renderer.staleVertices = true;
    }
    for (const canvas of [merged.canvas, fresh.canvas]) {
      for (const renderer of [...this.renderers]) renderer._addon._atlasCanvas.fire(canvas);
    }
  }
}
