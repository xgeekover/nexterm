/**
 * Module-level registry of persistent @xterm/xterm instances, one per
 * terminal tab, keyed by tabId — NOT React state. This is what makes the
 * terminal survive React unmounts (pane rebinding, split/close, re-renders):
 * `TerminalView` just attaches/detaches an entry's DOM node into whichever
 * wrapper is currently mounted; it never recreates the underlying Terminal.
 *
 * Deliberately has zero dependency on `terminalStore.js` — it only knows how
 * to spin up an xterm instance, wire its `onData` to a caller-supplied
 * callback, and pipe PTY output (given a session id to filter on) into it.
 * This keeps `disposeTerminal` safe to import lazily from `terminalStore.js`
 * without that module ever eagerly loading `@xterm/*` (which throws when
 * evaluated outside a browser — see the guard at the `terminalStore.js` call
 * site). It does read `settingsStore.js` (font/cursor/scrollback prefs) —
 * that store never touches `@xterm/*` itself, so no such cycle exists there.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import '@xterm/xterm/css/xterm.css';
import { listen } from '../../lib/ipc.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { setTerminalNoticeSink } from '../../lib/terminalNotice.js';
import { TERMINAL_THEMES, DEFAULT_TERMINAL_THEME_ID } from '../../lib/terminalThemes.js';
import {
  activateGraphemeWidths,
  fitAndReport,
  installPagerWheel,
  installScrollbackWheel,
  installXtVersionReply,
  windowsPtyFor,
} from '../../lib/terminalCompat.js';
import {
  claimAtlasMergePage,
  drawWebglNow,
  gpuFailure,
  isWebglContextLost,
  mustDrawScreenFirst,
  planGpuAttach,
  planGpuReconcile,
  releaseWebglAddon,
  repairWebglAtlas,
  settleWebglAtlas,
  webglInternals,
} from '../../lib/webglLifecycle.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { findLinks, resolveLinkPath } from '../../lib/terminalLinks.js';
import { openExternal } from '../../lib/openExternal.js';
import { installHangulInlineIme } from '../../lib/hangulInlineIme.js';
import { installTerminalClipboard } from '../../lib/terminalClipboard.js';
import { installTerminalRightClick } from '../../lib/terminalRightClick.js';
import { installModifyOtherKeys } from '../../lib/modifyOtherKeys.js';
import { installFocusReports } from '../../lib/focusReport.js';
import { attachOutput, forgetOutput, startPtyOutputBus } from '../../lib/ptyOutputBus.js';
import { installProgramNotifications } from '../../lib/programNotifications.js';

const instances = new Map();

/**
 * Draw a terminal with xterm's WebGL renderer.
 *
 * The DOM renderer draws block and box-drawing characters with the font, and a
 * glyph only covers the font's height — so at the default line height of 1.5
 * every row of a TUI's logo and every vertical border came out striped with the
 * background (reproduced with the block and box characters opencode draws:
 * gaps at 1.5, solid at 1.0). The WebGL renderer draws those characters itself,
 * filling the whole cell at any line height. It measures the font from the live
 * DOM, so it is made when the terminal is first shown. Without WebGL xterm
 * carries on with its DOM renderer.
 *
 * A context is scarce, and on WebKit making one is what costs
 * (`lib/webglLifecycle.js` has the rules and the reasons):
 *
 *   - a pane showing the terminal calls `ensureGpuRenderer`, which makes the
 *     renderer the first time (before the pane fits the terminal — see
 *     `planGpuAttach`), and calls the function it returns when it stops; the
 *     terminal KEEPS its renderer while hidden, so switching tabs or groups
 *     makes no context;
 *   - past sixteen, the hidden terminal drawn longest ago gives its context
 *     back first, and every terminal on screen draws before a context is made
 *     (`drawScreenFirst`), so the engine never pushes out one on screen;
 *   - a lost context is retried, on a schedule that cannot become a loop; a
 *     hidden one whose context was lost gets a new one when shown;
 *   - when the glyph atlas merges pages, every renderer is repaired in place
 *     (`repairAtlas`) — addon-webgl 0.18 and 0.19 draw fragments after the
 *     second merge.
 *
 * Everything else is settled in one pass, `reconcileGpus`, queued as a
 * microtask: it runs after React has attached, detached and fitted every pane
 * of a commit, and before the browser paints, so a terminal just shown is
 * drawn at its fitted size for the very first frame.
 */
const gpuStats = {
  created: 0,
  failed: 0,
  released: 0,
  freedContexts: 0,
  lost: 0,
  lostOnScreen: 0,
  drawnAhead: 0,
  atlasRepairs: 0,
  atlasRepairFallbacks: 0,
  lastAtlasRepairMs: 0,
  maxAtlasRepairMs: 0,
};
let gpuReconcileQueued = false;
let gpuRetryTimer = 0;
let gpuRetryTimerAt = Infinity;
let atlasRepairQueued = false;
// Every live renderer forwards the ONE shared atlas's merge to its own addon
// (see `claimAtlasMergePage`), so the same canvas is reported once per
// renderer. Tracked by identity, module-wide, so N reports of one merge ask
// for exactly one repair — a WeakSet costs nothing once the atlas moves on.
const handledAtlasMergeCanvases = new WeakSet();
// The contexts let go of, weakly. WebKit keeps a lost context's slot until it
// is garbage collected, so until then it still counts towards the cap.
const releasedContexts = [];

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function scheduleGpuReconcile() {
  if (gpuReconcileQueued) return;
  gpuReconcileQueued = true;
  queueMicrotask(reconcileGpus);
}

/** One timer, for the earliest retry due; the pass it starts sets the next. */
function scheduleGpuRetry(at) {
  if (at === null || at >= gpuRetryTimerAt) return;
  clearTimeout(gpuRetryTimer);
  gpuRetryTimerAt = at;
  gpuRetryTimer = setTimeout(() => {
    gpuRetryTimer = 0;
    gpuRetryTimerAt = Infinity;
    scheduleGpuReconcile();
  }, Math.max(0, at - clock()));
}

function gpuStateOf(entry) {
  const attached = entry.attachCount > 0;
  return {
    attached,
    connected: entry.container.isConnected,
    hasGpu: Boolean(entry.gpu),
    lost: Boolean(entry.gpu) && isWebglContextLost(entry.gpu),
    rebuild: entry.gpuRebuild,
    // Off screen at the last pass and on screen now: the user is looking at
    // it again, and whatever gave up on its renderer gets another go.
    freshAttach: attached && !entry.wasAttached,
    retryAt: entry.gpuRetryAt,
    attachedAt: entry.attachedAt,
    drawnAt: entry.lastDrawnAt,
  };
}

/** Contexts let go of that may still hold a slot; null when that cannot be known. */
function lingeringContexts() {
  if (typeof WeakRef === 'undefined') return null;
  for (let i = releasedContexts.length - 1; i >= 0; i -= 1) {
    if (!releasedContexts[i].deref()) releasedContexts.splice(i, 1);
  }
  return releasedContexts.length;
}

function releaseGpu(entry) {
  const addon = entry.gpu;
  if (!addon) return;
  entry.gpu = null;
  const { gl } = webglInternals(addon);
  const { freedContext } = releaseWebglAddon(addon);
  if (gl && typeof WeakRef !== 'undefined') releasedContexts.push(new WeakRef(gl));
  gpuStats.released += 1;
  if (freedContext) gpuStats.freedContexts += 1;
}

/**
 * Right before a context is made: when the page may be at its cap, every
 * terminal on screen draws now, so the context the engine pushes out to make
 * room is one nobody is looking at (`mustDrawScreenFirst`).
 */
function drawScreenFirst() {
  let held = 0;
  for (const entry of instances.values()) if (entry.gpu && !isWebglContextLost(entry.gpu)) held += 1;
  if (!mustDrawScreenFirst({ held, lingering: lingeringContexts() })) return;
  for (const entry of instances.values()) {
    if (!entry.gpu || entry.attachCount === 0) continue;
    if (drawWebglNow(entry.gpu, entry.term, { flush: true })) {
      entry.lastDrawnAt = clock();
      gpuStats.drawnAhead += 1;
    }
  }
}

/** @returns {boolean} whether the terminal now has a WebGL renderer */
function createGpu(entry) {
  let addon = null;
  try {
    addon = new WebglAddon();
    addon.onContextLoss(() => handleGpuLoss(entry, addon));
    // The atlas is shared, but this callback is not: every live renderer
    // forwards the SAME merge canvas here, once each. `claimAtlasMergePage`
    // lets only the first of those through, so N renderers ask for one
    // repair instead of N.
    addon.onAddTextureAtlasCanvas((canvas) => {
      if (claimAtlasMergePage(canvas, handledAtlasMergeCanvases)) requestAtlasRepair();
    });
    entry.term.loadAddon(addon);
  } catch (err) {
    console.warn('[Terminal] WebGL renderer unavailable, using the DOM renderer:', err);
    if (addon) releaseWebglAddon(addon);
    gpuStats.failed += 1;
    // Never made, so not a renderer that had been healthy: no fresh count.
    const next = gpuFailure({ failures: entry.gpuFailures, createdAt: null }, clock());
    entry.gpuFailures = next.failures;
    entry.gpuRetryAt = next.retryAt;
    return false;
  }
  entry.gpu = addon;
  entry.gpuCreatedAt = clock();
  // A context counts as active from the moment it is made.
  entry.lastDrawnAt = entry.gpuCreatedAt;
  entry.drawPending = true;
  gpuStats.created += 1;
  return true;
}

/**
 * Fit a terminal on screen to its pane again, and tell the shell: its renderer
 * changed under it, and WebGL and DOM cells are not the same width.
 */
function refitOnScreen(tabId, entry) {
  fitAndReport({
    tabId,
    term: entry.term,
    fitAddon: entry.fitAddon,
    resizePty: useTerminalStore.getState().resizePty,
    fittable: isFittable(entry.container),
  });
}

/**
 * addon-webgl reports a loss only after waiting 3 s for the browser to restore
 * the context itself, so by now it is gone for good. A hidden terminal gets a
 * new one when it is shown again; one on screen after the backoff.
 */
function handleGpuLoss(entry, addon) {
  if (entry.gpu !== addon) return;
  gpuStats.lost += 1;
  if (entry.attachCount > 0) gpuStats.lostOnScreen += 1;
  const createdAt = entry.gpuCreatedAt;
  releaseGpu(entry);
  const next = gpuFailure({ failures: entry.gpuFailures, createdAt }, clock());
  entry.gpuFailures = next.failures;
  entry.gpuRetryAt = next.retryAt;
  entry.refitPending = entry.attachCount > 0;
  scheduleGpuReconcile();
}

/**
 * The atlas is shared by every terminal with the same font and colours, and
 * a merge leaves every renderer drawing from it wrong (see
 * `repairWebglAtlas`). Called from inside a render, hence a queued pass: by
 * the time it runs, the render that merged has finished.
 */
function requestAtlasRepair() {
  if (atlasRepairQueued) return;
  atlasRepairQueued = true;
  queueMicrotask(repairAtlas);
}

/**
 * Every renderer re-uploads its pages and rebuilds its cells: one on screen
 * draws its whole viewport now, before the frame is painted, and a hidden one
 * — or one whose program is in the middle of a synchronized update — is drawn
 * in full when xterm next draws it. No renderer is made or let go, so no
 * context is either. Then the atlas stops asking every frame for a rebuild.
 * A renderer this addon version cannot repair in place is made again — on
 * screen now, hidden when next shown.
 */
function repairAtlas() {
  atlasRepairQueued = false;
  const startedAt = clock();
  const atlases = new Set();
  let unrepaired = false;
  for (const entry of instances.values()) {
    if (!entry.gpu) continue;
    const atlas = repairWebglAtlas(entry.gpu);
    if (!atlas) {
      entry.gpuRebuild = true;
      unrepaired = true;
      continue;
    }
    atlases.add(atlas);
    if (entry.attachCount > 0 && drawWebglNow(entry.gpu, entry.term)) {
      entry.lastDrawnAt = clock();
    } else {
      // Hidden, or in the middle of a synchronized update: the next frame
      // xterm draws covers the whole viewport.
      entry.term.refresh(0, entry.term.rows - 1);
    }
  }
  for (const atlas of atlases) settleWebglAtlas(atlas);
  const ms = clock() - startedAt;
  gpuStats.atlasRepairs += 1;
  gpuStats.lastAtlasRepairMs = ms;
  gpuStats.maxAtlasRepairMs = Math.max(gpuStats.maxAtlasRepairMs, ms);
  if (unrepaired) {
    gpuStats.atlasRepairFallbacks += 1;
    scheduleGpuReconcile();
  }
}

function reconcileGpus() {
  gpuReconcileQueued = false;
  const tabIds = [...instances.keys()];
  const entries = [...instances.values()];
  const states = entries.map((entry) => {
    const state = gpuStateOf(entry);
    if (state.freshAttach) {
      entry.gpuFailures = 0;
      entry.gpuRetryAt = 0;
      state.retryAt = 0;
    }
    entry.wasAttached = state.attached;
    return state;
  });
  const plan = planGpuReconcile(states, { now: clock() });

  for (const i of plan.release) {
    entries[i].gpuRebuild = false;
    releaseGpu(entries[i]);
  }
  if (plan.create.length > 0) drawScreenFirst();
  for (const i of plan.create) {
    // Already on screen and fitted — with the DOM renderer's cells, unless
    // this is a rebuild, where the refit finds nothing to change.
    if (createGpu(entries[i])) entries[i].refitPending = true;
  }
  entries.forEach((entry, i) => {
    if (entry.refitPending) {
      entry.refitPending = false;
      if (entry.attachCount > 0) refitOnScreen(tabIds[i], entry);
    }
    if (entry.drawPending) {
      entry.drawPending = false;
      if (entry.gpu && entry.attachCount > 0 && drawWebglNow(entry.gpu, entry.term)) entry.lastDrawnAt = clock();
    }
  });
  scheduleGpuRetry(plan.retryAt);
}

/**
 * A pane is showing this terminal: give it a WebGL renderer if it has none,
 * now if a context can be had, else as soon as one is free. Returns the
 * function to call when the pane stops showing it. The terminal keeps its
 * renderer after that: a context made on every tab switch is what pushed an
 * idle terminal on screen out of its own.
 */
export function ensureGpuRenderer(entry) {
  if (!entry || entry.disposed) return () => {};
  entry.attachCount += 1;
  if (entry.attachCount === 1) {
    entry.attachedAt = clock();
    if (entry.wasAttached === false) {
      entry.gpuFailures = 0;
      entry.gpuRetryAt = 0;
    }
    // Kept while hidden, and lost meanwhile — pushed out to make room, or a
    // GPU reset. addon-webgl would say so only after waiting 3 s, with the
    // terminal blank on screen all the while.
    if (entry.gpu && isWebglContextLost(entry.gpu)) {
      gpuStats.lost += 1;
      releaseGpu(entry);
    }
    if (!entry.gpu) {
      const entries = [...instances.values()];
      const decision = planGpuAttach(entries.map(gpuStateOf), entries.indexOf(entry));
      if (decision.create) {
        for (const i of decision.releaseFirst) releaseGpu(entries[i]);
        drawScreenFirst();
        createGpu(entry);
      }
    }
    entry.wasAttached = true;
  }
  // Drawn by the queued pass, once the pane has fitted it.
  entry.drawPending = true;
  scheduleGpuReconcile();
  let shown = true;
  return function stopShowing() {
    if (!shown) return;
    shown = false;
    entry.attachCount = Math.max(0, entry.attachCount - 1);
    scheduleGpuReconcile();
  };
}

/** What the GPU renderers are doing — read by the lab and through the app's debug bridge. */
export function getGpuStats() {
  let live = 0;
  let hidden = 0;
  let shown = 0;
  let shownWithoutGpu = 0;
  for (const entry of instances.values()) {
    if (entry.gpu) {
      live += 1;
      if (entry.attachCount === 0) hidden += 1;
    }
    if (entry.attachCount > 0) {
      shown += 1;
      if (!entry.gpu) shownWithoutGpu += 1;
    }
  }
  return { live, hidden, shown, shownWithoutGpu, lingering: lingeringContexts(), ...gpuStats };
}

/** Keys the Settings window exposes that should update every live terminal
 * instance in place, without recreating it. */
const LIVE_TERMINAL_SETTINGS_KEYS = [
  'terminalFontFamily',
  'terminalFontSize',
  'terminalLineHeight',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalScrollback',
  'terminalTheme',
];

/**
 * Reads the current ANSI/base palette from the design-token CSS variables so
 * xterm's theme always matches the active VS Code light/dark palette — never
 * hard-code a colour here, mirror src/styles/index.css instead.
 */
export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => {
    const val = cs.getPropertyValue(name).trim();
    return val || undefined;
  };
  return {
    background: v('--vsc-terminal-bg'),
    foreground: v('--vsc-fg'),
    cursor: v('--vsc-fg-bright') || v('--vsc-fg'),
    cursorAccent: v('--vsc-terminal-bg'),
    selectionBackground: v('--vsc-selection'),
    black: v('--vsc-ansi-black'),
    red: v('--vsc-ansi-red'),
    green: v('--vsc-ansi-green'),
    yellow: v('--vsc-ansi-yellow'),
    blue: v('--vsc-ansi-blue'),
    magenta: v('--vsc-ansi-magenta'),
    cyan: v('--vsc-ansi-cyan'),
    white: v('--vsc-ansi-white'),
    brightBlack: v('--vsc-ansi-bright-black'),
    brightRed: v('--vsc-ansi-bright-red'),
    brightGreen: v('--vsc-ansi-bright-green'),
    brightYellow: v('--vsc-ansi-bright-yellow'),
    brightBlue: v('--vsc-ansi-bright-blue'),
    brightMagenta: v('--vsc-ansi-bright-magenta'),
    brightCyan: v('--vsc-ansi-bright-cyan'),
    brightWhite: v('--vsc-ansi-bright-white'),
  };
}

/**
 * Resolve the settings store's `terminalTheme` id into an actual xterm
 * `ITheme` — either a fixed published palette from terminalThemes.js, or (for
 * `followsAppTheme` entries, e.g. the default "Dark Modern") the live
 * `readTheme()` snapshot of the app's own --vsc-* tokens. Tolerant of the
 * setting being undefined (older persisted state, or this store key not
 * having loaded yet) by falling back to the default theme id.
 */
export function resolveTerminalTheme(themeId) {
  const id = themeId ?? DEFAULT_TERMINAL_THEME_ID;
  const entry = TERMINAL_THEMES[id] || TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID];
  return entry.followsAppTheme ? readTheme() : entry.theme;
}

export function readFontFamily() {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--font-mono').trim() || 'monospace';
}

/**
 * The Settings window's `terminalFontFamily` overrides the app's mono token
 * when set; '' means "follow --font-mono", same convention the store's own
 * doc comment describes.
 */
export function resolveTerminalFontFamily() {
  const custom = useSettingsStore.getState().terminalFontFamily;
  return custom && custom.trim() ? custom.trim() : readFontFamily();
}

/**
 * xterm's FitAddon measures the container and, when it is detached or has
 * zero size, leaves the render dimensions undefined — a viewport sync
 * scheduled on the next frame then throws asynchronously (outside any
 * try/catch around fit()). Only fit when the element is actually laid out
 * and visible.
 */
export function isFittable(container) {
  return (
    !!container &&
    container.isConnected &&
    container.offsetParent !== null &&
    container.offsetWidth > 0 &&
    container.offsetHeight > 0
  );
}

// One MutationObserver for every terminal instance, started lazily on first
// use — light/dark flips are rare, no need for a per-component observer.
let themeObserverStarted = false;
function ensureThemeObserverStarted() {
  if (themeObserverStarted) return;
  themeObserverStarted = true;
  if (typeof MutationObserver === 'undefined') return;
  const rootEl = document.documentElement;
  const observer = new MutationObserver(() => {
    // A fixed (non-followsAppTheme) terminal theme deliberately ignores the
    // app's own light/dark flip — only re-read the live tokens when the
    // selected theme is the one that is supposed to track them.
    const themeId = useSettingsStore.getState().terminalTheme ?? DEFAULT_TERMINAL_THEME_ID;
    const entryDef = TERMINAL_THEMES[themeId] || TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID];
    const fontFamily = resolveTerminalFontFamily();
    for (const entry of instances.values()) {
      if (entryDef.followsAppTheme) entry.term.options.theme = readTheme();
      entry.term.options.fontFamily = fontFamily;
    }
  });
  observer.observe(rootEl, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Push every terminal-related Settings-window value onto every live xterm
 * instance's `.options`, then refit (reusing `FitAddon`, the same one
 * `TerminalView`'s own resize-observer calls) so a font/line-height change
 * takes effect immediately instead of only on the next natural resize.
 *
 * The refit has to be reported to the shell as well. A smaller font fits more
 * columns into the same pane, but the pane itself does not move, so
 * `TerminalView`'s ResizeObserver never fires and nothing used to send the new
 * size on: halving the font took the grid from 107x33 to 251x70 while the
 * shell went on believing it had 107 columns. Everything drawing a full screen
 * — vim, htop, a TUI — then drew for the wrong width until something else
 * happened to resize the window. `resizePty` ignores a size the tab has
 * already reported, so calling it here costs nothing when nothing moved.
 */
function applyLiveTerminalSettings(state) {
  const fontFamily = state.terminalFontFamily?.trim() ? state.terminalFontFamily.trim() : readFontFamily();
  const theme = resolveTerminalTheme(state.terminalTheme);
  const resizePty = useTerminalStore.getState().resizePty;
  for (const [tabId, entry] of instances.entries()) {
    entry.term.options.fontFamily = fontFamily;
    entry.term.options.fontSize = state.terminalFontSize;
    entry.term.options.lineHeight = state.terminalLineHeight;
    entry.term.options.cursorStyle = state.terminalCursorStyle;
    entry.term.options.cursorBlink = state.terminalCursorBlink;
    entry.term.options.scrollback = state.terminalScrollback;
    entry.term.options.theme = theme;
    fitAndReport({
      tabId,
      term: entry.term,
      fitAddon: entry.fitAddon,
      resizePty,
      fittable: isFittable(entry.container),
    });
  }
}

// One subscription for every terminal instance, started lazily on first use
// — mirrors `ensureThemeObserverStarted` above.
let settingsSubscriptionStarted = false;
function ensureSettingsSubscriptionStarted() {
  if (settingsSubscriptionStarted) return;
  settingsSubscriptionStarted = true;
  useSettingsStore.subscribe((state, prevState) => {
    const changed = LIVE_TERMINAL_SETTINGS_KEYS.some((key) => state[key] !== prevState[key]);
    if (changed) applyLiveTerminalSettings(state);
  });
}

/**
 * Keep every terminal's `windowsPty` in step with what the backend reports.
 *
 * The first terminals are created at startup, before `system_get_info` has
 * answered, so they were made without the build number; they get it as soon as
 * it arrives. `{}` is xterm's own "not set" value.
 */
useSystemStore.subscribe((state, prev) => {
  if (state.os === prev.os && state.osBuild === prev.osBuild) return;
  const windowsPty = windowsPtyFor(state) ?? {};
  for (const entry of instances.values()) entry.term.options.windowsPty = windowsPty;
});

/**
 * The whole logical line a rendered row belongs to.
 *
 * xterm hands a link provider ONE row at a time, but a terminal wraps: in an
 * 80-column pane `at Object.<anonymous> (/very/long/path/app.test.js:42:13)`
 * is split across two rows, and a provider that only ever sees one row finds
 * no link in either. So walk back to the row that started the wrap, join the
 * group, and remember where it began — offsets map back to (x, y) from there.
 */
function logicalLineAt(term, row) {
  const buffer = term.buffer.active;
  let start = row;
  while (start > 1 && buffer.getLine(start - 1)?.isWrapped) start -= 1;

  let text = '';
  for (let i = start; i <= buffer.length; i += 1) {
    const line = buffer.getLine(i - 1);
    if (!line) break;
    if (i > start && !line.isWrapped) break;
    // No trimming: every wrapped row is exactly `cols` wide, and that is what
    // makes `positionOf` arithmetic rather than a search.
    text += line.translateToString(false);
  }
  return { text, start };
}

/** An offset into the joined text, as xterm's 1-based (x, y). */
function positionOf(offset, startRow, cols) {
  return { x: (offset % cols) + 1, y: startRow + Math.floor(offset / cols) };
}

/**
 * Make paths and URLs in the output clickable.
 *
 * A stack trace names a file and a line, and this app has that file's editor
 * in the same window — having to retype the path to reach it was most of the
 * reason that pairing did not pay off. What counts as a link is decided by
 * `src/lib/terminalLinks.js`, which is pure and tested; this maps the matches
 * onto the screen and says what a click does.
 *
 * A relative path is resolved against the TAB'S live cwd, read at click time
 * rather than captured here — the shell may have `cd`'d twenty times since
 * this instance was created.
 */
function registerLinks(term, tabId) {
  return term.registerLinkProvider({
    provideLinks(row, callback) {
      const { text, start } = logicalLineAt(term, row);
      const matches = findLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const cols = term.cols || 80;
      callback(
        matches.map((match) => ({
          range: {
            start: positionOf(match.start, start, cols),
            // xterm's ranges are inclusive at both ends, hence the -1.
            end: positionOf(match.start + match.length - 1, start, cols),
          },
          text: match.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            event?.preventDefault?.();
            if (match.kind === 'url') {
              openExternal(match.href);
              return;
            }
            const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
            const editor = useEditorStore.getState();
            const resolved = resolveLinkPath(match.path, tab?.cwd || editor.rootPath);
            if (!resolved) return;
            // A path a tool printed may not exist, may sit outside the
            // workspace the backend confines reads to, or may have been
            // deleted since it was printed. Say so in the terminal and carry
            // on — a click that cannot land must not take the window down.
            editor.openFileAt(resolved, match.line, match.column).catch(() => {
              writeNotice(tabId, `could not open ${resolved}`);
            });
          },
        }))
      );
    },
  });
}

/**
 * Get the persistent xterm instance for a tab, creating it on first use.
 * `sessionId` and `onData` are only consulted the first time — the PTY
 * listener and keystroke wiring are set up once, for the lifetime of the
 * instance, so remounting the owning component never double-subscribes.
 */
/**
 * Point an instance's PTY listeners at `sessionId`, replacing whatever they
 * were listening to before.
 *
 * A tab keeps its id across a restore while its shell gets a NEW session id,
 * so an instance left bound to the old one shows no output and sends input
 * nowhere — a terminal that looks alive and is completely inert. Rebinding on
 * change is what keeps the instance and its shell together.
 */
function bindSession(entry, sessionId) {
  entry.stopPtyListener?.();
  // A shell this instance no longer shows is gone (a restore respawned it):
  // nothing it left waiting will ever be written anywhere.
  if (entry.sessionId && entry.sessionId !== sessionId) forgetOutput(entry.sessionId);
  entry.sessionId = sessionId;
  entry.exited = false;

  let ptyUnlisten = null;
  let exitUnlisten = null;
  let cancelled = false;

  if (sessionId) {
    // Output through the one listener in ptyOutputBus.js: first what the shell
    // printed before this terminal existed — a tab never shown kept it there —
    // then everything live, with nothing lost or doubled in between.
    startPtyOutputBus();
    ptyUnlisten = attachOutput(sessionId, (data) => entry.term.write(data));

    // When the shell exits, say so. The pane used to keep a blinking cursor
    // and simply swallow every keystroke, with no way to tell a dead terminal
    // from a hung one — the failure only showed up in the devtools console.
    listen('pty-exit', (payload) => {
      const { session_id, exit_code } = payload || {};
      if (session_id !== sessionId || entry.exited) return;
      entry.exited = true;
      const code = typeof exit_code === 'number' ? exit_code : null;
      entry.term.write(
        `\r\n\x1b[90m[process exited${code === null ? '' : ` with code ${code}`}]\x1b[0m\r\n`
      );
    }).then((off) => {
      if (cancelled) off();
      else exitUnlisten = off;
    });
  }

  entry.stopPtyListener = () => {
    cancelled = true;
    ptyUnlisten?.();
    exitUnlisten?.();
  };
}

export function getOrCreateTerminal(tabId, { sessionId, onData } = {}) {
  let entry = instances.get(tabId);
  if (entry) {
    // The instance is reused across pane moves and remounts, but its SHELL can
    // change underneath it (a restore respawns every terminal with the same tab
    // id and a fresh session).
    if (sessionId && entry.sessionId !== sessionId) bindSession(entry, sessionId);
    return entry;
  }

  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';

  const settingsState = useSettingsStore.getState();
  const term = new Terminal({
    fontFamily: resolveTerminalFontFamily(),
    fontSize: settingsState.terminalFontSize,
    // xterm's lineHeight is a multiplier of fontSize.
    lineHeight: settingsState.terminalLineHeight,
    cursorStyle: settingsState.terminalCursorStyle,
    cursorBlink: settingsState.terminalCursorBlink,
    scrollback: settingsState.terminalScrollback,
    // xterm's default is 1, i.e. no correction, and several canonical palettes
    // define an ANSI colour equal to their own background — Monokai, One Dark,
    // Gruvbox, Tomorrow Night and Solarized all render "black" invisibly, as
    // does the default theme (#000000 on #181818). VS Code lifts the same
    // palettes to 4.5 rather than editing them, and so do we: the theme stays
    // the canonical one, the text stays readable.
    minimumContrastRatio: 4.5,
    allowProposedApi: true,
    theme: resolveTerminalTheme(settingsState.terminalTheme),
    // `{}` off Windows: xterm's own "not set". See terminalCompat.js.
    windowsPty: windowsPtyFor(useSystemStore.getState()) ?? {},
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Emoji — VS16, ZWJ and skin-tone sequences included — are two cells wide
  // to the programs running here; see terminalCompat.js.
  activateGraphemeWidths(term, UnicodeGraphemesAddon);
  // XTVERSION, answered as xterm.js 6.1 answers it: Claude Code asks for DEC
  // 2026 (synchronized output) only after this reply. See terminalCompat.js.
  installXtVersionReply(term);
  // Shift+Enter and Ctrl+Enter as keys of their own to a program that turns
  // xterm's modifyOtherKeys on (OpenCode), and Enter as before to every other.
  // It follows the program's output from the first byte; TerminalView sends
  // the keys. See modifyOtherKeys.js.
  const modifyOtherKeys = installModifyOtherKeys(term);
  // What xterm last told the program about focus (`CSI I` / `CSI O`), so a
  // terminal taken off screen without a blur can still be reported as gone —
  // WebKit sends none. TerminalView asks; see focusReport.js.
  const focusReports = installFocusReports(term);
  // What a program asks to tell the user — OpenCode, Claude Code — through
  // OSC 9, 99 or 777: to the bell, and to the desktop while the window is in
  // the background. Read from the first byte, so OpenCode's start-up question
  // about OSC 99 is answered; the setting is read as each one arrives, and
  // the store decides where it goes. Disposed with the terminal. See
  // programNotifications.js.
  installProgramNotifications(term, {
    enabled: () => useSettingsStore.getState().terminalProgramNotifications !== false,
    onNotify: (note) => useTerminalStore.getState().notifyFromProgram?.(tabId, note),
  });
  const linkProvider = registerLinks(term, tabId);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  // The find bar reads its "n of m" from here. Reported per tab because the
  // bar belongs to whichever terminal is focused, and a search left running in
  // a background tab must not overwrite the count the user is looking at.
  searchAddon.onDidChangeResults((results) => {
    useTerminalStore.getState().setFindResults?.(tabId, results);
  });
  term.open(container);

  // The wheel moves the scrollback, and a pager (`less`, `man`, `git log`), as
  // far as it did under xterm 5.5 — xterm 6 scrolls a fixed 50 px a notch and
  // sends a pager one arrow per wheel event. The scrollback's listener goes on
  // `term.element`, hence after `open`; disposed with the terminal.
  // terminalCompat.js.
  installPagerWheel(term);
  installScrollbackWheel(term);

  // ---- Korean inline IME (macOS only) — see src/lib/hangulInlineIme.js ----
  // WebKit composes Hangul by rewriting the textarea in place, which xterm
  // ignores; this sends each syllable whole. Installed once per instance so it
  // survives remounts, and disposed with the terminal. Does nothing elsewhere.
  installHangulInlineIme(term, container);
  // ---- end Korean inline IME ----------------------------------------------

  // ---- Selection, copy on select, mouse reporting — src/lib/terminalClipboard.js ----
  // Warp's model: only a full-screen program gets the mouse, a drag anywhere
  // else selects, and a selection is copied as it is made. After the IME, so
  // its mousedown listener still runs first. Disposed with the terminal.
  installTerminalClipboard(term, container, { settings: useSettingsStore });
  // ---- end selection, copy on select, mouse reporting ------------------------

  // ---- Right-click copies or pastes — src/lib/terminalRightClick.js ----------
  // Windows Terminal's right-click, Windows' default: the selection is copied,
  // or the clipboard pasted, and neither xterm nor the program hears of it.
  // Last of the container's capture listeners, so the IME, mouse reporting and
  // copy on select still hear the press it stops. The find bar's highlighted
  // match is not a selection to copy. Disposed with the terminal.
  installTerminalRightClick(term, container, {
    settings: useSettingsStore,
    isFindOpen: () => {
      const find = useTerminalStore.getState().find;
      return Boolean(find?.open && find?.tabId === tabId);
    },
  });
  // ---- end right-click ---------------------------------------------------------

  const dataDisposable = onData ? term.onData(onData) : null;

  // Feed this tab's PTY output straight into its xterm for the whole life of
  // the instance — independent of whichever component currently has it
  // mounted, and independent of the store's own (bookkeeping) pty-output
  // listener.
  ensureThemeObserverStarted();
  ensureSettingsSubscriptionStarted();

  entry = {
    term,
    fitAddon,
    linkProvider,
    searchAddon,
    // Asked for what a key sends by TerminalView's key handler; null when the
    // terminal has no parser (a test double).
    modifyOtherKeys,
    // Sends the focus-out a hidden terminal never got (`reportFocusOut`).
    focusReports,
    sessionId: null,
    container,
    dataDisposable,
    exited: false,
    stopPtyListener: null,
    // The WebGL renderer and its bookkeeping — see `ensureGpuRenderer`.
    gpu: null,
    attachCount: 0,
    attachedAt: 0,
    wasAttached: false,
    gpuRebuild: false,
    gpuFailures: 0,
    gpuRetryAt: 0,
    gpuCreatedAt: null,
    // When its renderer last drew: the engines push out the context that has
    // gone longest without drawing, so this is the order hidden ones go in.
    lastDrawnAt: 0,
    renderDisposable: null,
    drawPending: false,
    refitPending: false,
    disposed: false,
  };
  const drawn = entry;
  entry.renderDisposable = term.onRender(() => {
    drawn.lastDrawnAt = clock();
  });
  bindSession(entry, sessionId);
  instances.set(tabId, entry);
  return entry;
}

/**
 * Colours for the search decorations, read from the app's own tokens.
 *
 * xterm parses these itself and accepts `#RRGGBB` ONLY — a token carrying an
 * alpha channel (several of ours do) is dropped without a word, and the
 * matches then highlight in xterm's own yellow instead of the app's. Hence the
 * shape check and the literal fallback.
 */
function searchDecorations() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => {
    const val = cs.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(val) ? val : fallback;
  };
  const other = v('--vsc-find-match-other', '#613214');
  const active = v('--vsc-find-match', '#9e6a03');
  return {
    matchBackground: other,
    matchOverviewRuler: other,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active,
  };
}

/**
 * Run a search over a tab's scrollback.
 *
 * `direction` is 'next', 'previous' or 'incremental' — the last is what typing
 * does: xterm then grows the current selection while it still matches, instead
 * of jumping to the following occurrence on every keystroke.
 *
 * `decorations` is not optional in practice. Without it xterm highlights only
 * the current match and never fires `onDidChangeResults`, so the bar could not
 * say "3 of 17" — which is the part that makes searching a 5000-line buffer
 * worth anything.
 */
export function searchInTerminal(tabId, query, { direction = 'next', ...options } = {}) {
  const entry = instances.get(tabId);
  if (!entry?.searchAddon) return false;
  if (!query) {
    entry.searchAddon.clearDecorations();
    return false;
  }
  const searchOptions = { ...options, decorations: searchDecorations() };
  if (direction === 'previous') return entry.searchAddon.findPrevious(query, searchOptions);
  return entry.searchAddon.findNext(query, { ...searchOptions, incremental: direction === 'incremental' });
}

/** Drop every highlight — the find bar closing, or its query emptying. */
export function clearTerminalSearch(tabId) {
  const entry = instances.get(tabId);
  entry?.searchAddon?.clearDecorations();
}

/** Tear down a tab's xterm instance for good. Call only when its tab closes. */
/**
 * Print a NexTerm message into a terminal, styled so it cannot be mistaken for
 * program output. Used for things the user has to be told about but the shell
 * knows nothing of — a paste the kernel refused, for instance.
 */
export function writeNotice(tabId, message) {
  const entry = instances.get(tabId);
  if (!entry || !message) return false;
  entry.term.write(`\r\n\x1b[33m[NexTerm] ${message}\x1b[0m\r\n`);
  return true;
}

// Let the store reach the screen without importing this module (it runs in
// Node under the test suites, and xterm brings a stylesheet with it).
setTerminalNoticeSink(writeNotice);

/**
 * Tell the program in `tabId`'s terminal that the terminal lost focus, when it
 * asked for focus reports and xterm last told it the opposite — for a terminal
 * TerminalView is taking off screen, which WebKit does without a `blur` (see
 * focusReport.js).
 *
 * Decided a task later, once React has finished: TerminalView asks from an
 * effect cleanup, and the cleanup that detaches the terminal from its pane may
 * not have run yet — asked then, the terminal still looked on screen and
 * focused, so nothing was sent, and once detached nothing ever was. A task
 * later it is off screen, or — React's development double run — back on
 * screen with the focus, and left alone.
 */
export function reportFocusOut(tabId) {
  setTimeout(() => {
    instances.get(tabId)?.focusReports?.reportOut();
  }, 0);
}

export function disposeTerminal(tabId) {
  const entry = instances.get(tabId);
  if (!entry) return;
  // Before `term.dispose()`, which would drop the WebGL addon without letting
  // its context go — and a context nothing can reach still counts against the
  // browser's 16 until it is collected, evicting terminals that are open.
  entry.disposed = true;
  entry.attachCount = 0;
  releaseGpu(entry);
  entry.renderDisposable?.dispose();
  entry.stopPtyListener();
  entry.dataDisposable?.dispose();
  entry.linkProvider?.dispose();
  entry.searchAddon?.dispose();
  entry.term.dispose();
  instances.delete(tabId);
  // The context just freed may be the one a terminal on screen is waiting for.
  scheduleGpuReconcile();
}
