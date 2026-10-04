/**
 * Runs the real `terminalRegistry.js` against a model browser.
 *
 * `openModel({ registryUrl, engine })` imports a FRESH copy of the registry
 * (its own module state: instances, timers, stats), with xterm replaced by
 * `xtermDouble.js` and every WebGL context made by `engines.js`. Time is fake:
 * `setTimeout` and `performance.now` belong to the model while it is open, so
 * addon-webgl's 3 s wait and the registry's 1 s / 5 s / 30 s retries take no
 * real time. Frames are run every 16 ms of model time.
 *
 * Panes do what `TerminalView`'s effect does when a pane's tab changes: the
 * old effect's cleanup (the function `ensureGpuRenderer` returned), then
 * `wrapper.replaceChildren(container)`, then `ensureGpuRenderer`. The
 * terminal in the active pane is focused, so its cursor blinks — and draws.
 *
 * Requires `loader.mjs` to be registered before `openModel` is called.
 */
import { createEngine } from './engines.js';
import { setTerminalNoticeSink } from '../../../src/lib/terminalNotice.js';
import { useSettingsStore } from '../../../src/stores/settingsStore.js';
import { useSystemStore } from '../../../src/stores/systemStore.js';

const FRAME_MS = 16;
let imports = 0;

/** Lets every queued microtask (the registry's reconcile pass) run. */
export async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

function installFakeTime(start) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const perf = globalThis.performance;
  const timers = new Map();
  let now = start;
  let seq = 0;
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn, args });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };
  perf.now = () => now;
  return {
    now: () => now,
    /** Fires every timer due by `target`, in order, letting microtasks run after each. */
    async advanceTo(target) {
      for (;;) {
        let due = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!due || t.at < due.at || (t.at === due.at && t.id < due.id))) due = t;
        }
        if (!due) break;
        timers.delete(due.id);
        now = Math.max(now, due.at);
        due.fn(...due.args);
        await settle();
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      delete perf.now;
    },
  };
}

/**
 * The registry subscribes to the settings and system stores and never lets
 * go — right for the app, wrong for a copy imported for one scenario, whose
 * listeners would otherwise answer every later test's settings change (and
 * reach for a DOM that is no longer there). Taken back when the model closes.
 */
function captureSubscriptions(stores) {
  const unsubscribes = [];
  const originals = stores.map((store) => store.subscribe);
  stores.forEach((store, i) => {
    store.subscribe = (...args) => {
      const off = originals[i](...args);
      unsubscribes.push(off);
      return off;
    };
  });
  return () => {
    stores.forEach((store, i) => {
      store.subscribe = originals[i];
    });
    for (const off of unsubscribes.splice(0)) off();
  };
}

function fakeElement() {
  return {
    style: {},
    isConnected: false,
    offsetParent: {},
    offsetWidth: 800,
    offsetHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    querySelector: () => null,
  };
}

function installDom() {
  const saved = {};
  const set = (key, value) => {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  set('document', { documentElement: fakeElement(), body: fakeElement(), createElement: () => fakeElement() });
  set('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  return () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

class Pane {
  constructor(app) {
    this.app = app;
    this.entry = null;
    this.tabId = null;
    this._release = null;
  }

  /** The pane's tab changes: TerminalView's effect cleanup, then its effect. */
  show(tabId) {
    const next = this.app.terminal(tabId);
    if (this.entry === next) return next;
    this._release?.();
    if (this.entry) this.entry.container.isConnected = false;
    next.container.isConnected = true;
    this._release = this.app.reg.ensureGpuRenderer(next);
    this.entry = next;
    this.tabId = tabId;
    this.app.syncFocus();
    return next;
  }

  /** The pane goes away (a group switch, a split closing). */
  unmount() {
    this._release?.();
    this._release = null;
    if (this.entry) this.entry.container.isConnected = false;
    this.entry = null;
    this.tabId = null;
    this.app.syncFocus();
  }
}

class ModelApp {
  constructor({ reg, world, time, restore }) {
    this.reg = reg;
    this.world = world;
    this.time = time;
    this._restore = restore;
    this.panes = [];
    this.activePane = null;
    this._tabs = new Map();
  }

  get engine() {
    return this.world.engine;
  }

  terminal(tabId) {
    const entry = this.reg.getOrCreateTerminal(tabId, {});
    entry.term.tabId = tabId;
    this._tabs.set(tabId, entry);
    return entry;
  }

  pane() {
    const pane = new Pane(this);
    this.panes.push(pane);
    if (!this.activePane) this.activePane = pane;
    return pane;
  }

  focus(pane) {
    this.activePane = pane;
    this.syncFocus();
  }

  syncFocus() {
    for (const entry of this._tabs.values()) {
      entry.term.focused = Boolean(this.activePane && this.activePane.entry === entry);
    }
  }

  async close(tabId) {
    for (const pane of this.panes) if (pane.tabId === tabId) pane.unmount();
    this.reg.disposeTerminal(tabId);
    this._tabs.delete(tabId);
    await settle();
  }

  /** Model time passes: timers fire, every terminal gets its animation frames. */
  async run(ms) {
    const end = this.time.now() + ms;
    while (this.time.now() < end) {
      await this.time.advanceTo(Math.min(end, this.time.now() + FRAME_MS));
      for (const term of [...this.world.terminals]) term.frame(this.time.now());
      this.engine.endFrame();
      await settle();
    }
  }

  /** The WebGL context a terminal's renderer draws through, or null. */
  contextOf(tabId) {
    const entry = this._tabs.get(tabId);
    return entry?.gpu?._renderer?._gl ?? null;
  }

  /** Whether the terminal is drawn by a live WebGL context right now. */
  hasLiveWebgl(tabId) {
    const gl = this.contextOf(tabId);
    return Boolean(gl && !gl.isContextLost());
  }

  onScreenTabs() {
    return this.panes.filter((p) => p.tabId).map((p) => p.tabId);
  }

  /** On-screen terminals not drawn by a live WebGL context. */
  onScreenWithoutWebgl() {
    return this.onScreenTabs().filter((tabId) => !this.hasLiveWebgl(tabId));
  }

  evictionsOnScreen() {
    return this.engine.evictions.filter((e) => e.onScreen);
  }

  async closeAll() {
    for (const pane of this.panes) pane.unmount();
    for (const tabId of [...this._tabs.keys()]) this.reg.disposeTerminal(tabId);
    this._tabs.clear();
    await settle();
  }

  async dispose() {
    try {
      await this.closeAll();
    } finally {
      this._restore();
    }
  }
}

/**
 * Open a model browser running the registry at `registryUrl` (a file URL).
 * `engine` is 'webkit' (WKWebView) or 'chromium' (WebView2).
 */
export async function openModel({ registryUrl, engine = 'webkit', start = 100000 } = {}) {
  const time = installFakeTime(start);
  const restoreDom = installDom();
  const releaseSubscriptions = captureSubscriptions([useSettingsStore, useSystemStore]);
  const restore = () => {
    releaseSubscriptions();
    time.restore();
    restoreDom();
    delete globalThis.__nextermWebglModel;
    setTerminalNoticeSink(null);
  };
  const world = { terminals: new Set(), renderers: [], atlas: null, failCreate: false };
  world.engine = createEngine(engine, {
    timers: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) },
    // `onScreen`: the context was drawing a terminal on screen at that moment.
    describeOwner: (addon) => {
      const term = addon?._term;
      const current = Boolean(term && addon._renderer && term.webglRenderer === addon._renderer);
      return { tabId: term?.tabId ?? null, onScreen: current && Boolean(term.onScreen) };
    },
  });
  globalThis.__nextermWebglModel = world;
  let reg;
  try {
    reg = await import(`${registryUrl}?model=${++imports}`);
  } catch (err) {
    restore();
    throw err;
  }
  return new ModelApp({ reg, world, time, restore });
}
