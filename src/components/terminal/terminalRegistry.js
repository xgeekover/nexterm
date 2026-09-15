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
import '@xterm/xterm/css/xterm.css';
import { listen } from '../../lib/ipc.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { setTerminalNoticeSink } from '../../lib/terminalNotice.js';
import { TERMINAL_THEMES, DEFAULT_TERMINAL_THEME_ID } from '../../lib/terminalThemes.js';
import { usablePtySize, windowsPtyFor } from '../../lib/terminalCompat.js';
import { useSystemStore } from '../../stores/systemStore.js';

const instances = new Map();

/**
 * Draw a terminal with xterm's WebGL renderer, once its element is in the
 * document.
 *
 * The DOM renderer draws block and box-drawing characters with the font, and a
 * glyph only covers the font's height — so at the default line height of 1.5
 * every row of a TUI's logo and every vertical border came out striped with the
 * background (reproduced with the block and box characters opencode draws:
 * gaps at 1.5, solid at 1.0). The WebGL renderer draws those characters itself,
 * filling the whole cell at any line height. It measures the font from the live
 * DOM, hence "once attached". Without WebGL, or when the context is lost, the
 * addon is dropped and xterm carries on with its DOM renderer.
 */
export function ensureGpuRenderer(entry) {
  if (entry.gpu !== undefined || !entry.container.isConnected) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      entry.gpu = null;
    });
    entry.term.loadAddon(addon);
    entry.gpu = addon;
  } catch (err) {
    console.warn('[Terminal] WebGL renderer unavailable, using the DOM renderer:', err);
    entry.gpu = null;
  }
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
 */
function applyLiveTerminalSettings(state) {
  const fontFamily = state.terminalFontFamily?.trim() ? state.terminalFontFamily.trim() : readFontFamily();
  const theme = resolveTerminalTheme(state.terminalTheme);
  for (const entry of instances.values()) {
    entry.term.options.fontFamily = fontFamily;
    entry.term.options.fontSize = state.terminalFontSize;
    entry.term.options.lineHeight = state.terminalLineHeight;
    entry.term.options.cursorStyle = state.terminalCursorStyle;
    entry.term.options.cursorBlink = state.terminalCursorBlink;
    entry.term.options.scrollback = state.terminalScrollback;
    entry.term.options.theme = theme;
    if (isFittable(entry.container) && usablePtySize(entry.fitAddon.proposeDimensions())) {
      try {
        entry.fitAddon.fit();
      } catch (_) {
        // container not laid out yet — the next natural resize retries
      }
    }
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
  entry.sessionId = sessionId;
  entry.exited = false;

  let ptyUnlisten = null;
  let exitUnlisten = null;
  let cancelled = false;

  if (sessionId) {
    listen('pty-output', (payload) => {
      const { session_id, data } = payload || {};
      if (!data || session_id !== sessionId) return;
      entry.term.write(data);
    }).then((off) => {
      if (cancelled) off();
      else ptyUnlisten = off;
    });

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
  term.open(container);

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
    sessionId: null,
    container,
    dataDisposable,
    exited: false,
    stopPtyListener: null,
  };
  bindSession(entry, sessionId);
  instances.set(tabId, entry);
  return entry;
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

export function disposeTerminal(tabId) {
  const entry = instances.get(tabId);
  if (!entry) return;
  entry.stopPtyListener();
  entry.dataDisposable?.dispose();
  entry.term.dispose();
  instances.delete(tabId);
}
