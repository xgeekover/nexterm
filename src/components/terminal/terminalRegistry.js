/**
 * Module-level registry of persistent @xterm/xterm instances, one per
 * terminal tab, keyed by tabId — NOT React state. This is what makes the
 * terminal survive React unmounts (pane rebinding, split/close, re-renders):
 * `TerminalView` just attaches/detaches an entry's DOM node into whichever
 * wrapper is currently mounted; it never recreates the underlying Terminal.
 *
 * Deliberately has zero dependency on the app store — it only knows how to
 * spin up an xterm instance, wire its `onData` to a caller-supplied callback,
 * and pipe PTY output (given a session id to filter on) into it. This keeps
 * `disposeTerminal` safe to import lazily from `terminalStore.js` without
 * that module ever eagerly loading `@xterm/*` (which throws when evaluated
 * outside a browser — see the guard at the `terminalStore.js` call site).
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { listen } from '../../lib/ipc.js';

const instances = new Map();

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

export function readFontFamily() {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--font-mono').trim() || 'monospace';
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
    const theme = readTheme();
    const fontFamily = readFontFamily();
    for (const entry of instances.values()) {
      entry.term.options.theme = theme;
      entry.term.options.fontFamily = fontFamily;
    }
  });
  observer.observe(rootEl, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Get the persistent xterm instance for a tab, creating it on first use.
 * `sessionId` and `onData` are only consulted the first time — the PTY
 * listener and keystroke wiring are set up once, for the lifetime of the
 * instance, so remounting the owning component never double-subscribes.
 */
export function getOrCreateTerminal(tabId, { sessionId, onData } = {}) {
  let entry = instances.get(tabId);
  if (entry) return entry;

  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';

  const term = new Terminal({
    fontFamily: readFontFamily(),
    fontSize: 12,
    // xterm's lineHeight is a multiplier of fontSize; 1.5 * 12px = 18px.
    lineHeight: 1.5,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: readTheme(),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const dataDisposable = onData ? term.onData(onData) : null;

  // Feed this tab's PTY output straight into its xterm for the whole life of
  // the instance — independent of whichever component currently has it
  // mounted, and independent of the store's own (bookkeeping) pty-output
  // listener.
  let ptyUnlisten = null;
  let ptyCancelled = false;
  if (sessionId) {
    listen('pty-output', (payload) => {
      const { session_id, data } = payload || {};
      if (!data || session_id !== sessionId) return;
      term.write(data);
    }).then((off) => {
      if (ptyCancelled) off();
      else ptyUnlisten = off;
    });
  }

  ensureThemeObserverStarted();

  entry = {
    term,
    fitAddon,
    container,
    dataDisposable,
    stopPtyListener: () => {
      ptyCancelled = true;
      ptyUnlisten?.();
    },
  };
  instances.set(tabId, entry);
  return entry;
}

/** Tear down a tab's xterm instance for good. Call only when its tab closes. */
export function disposeTerminal(tabId) {
  const entry = instances.get(tabId);
  if (!entry) return;
  entry.stopPtyListener();
  entry.dataDisposable?.dispose();
  entry.term.dispose();
  instances.delete(tabId);
}
