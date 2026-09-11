import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '../../stores/terminalStore.js';

/**
 * Reads the current ANSI/base palette from the design-token CSS variables so
 * xterm's theme always matches the active VS Code light/dark palette — never
 * hard-code a colour here, mirror src/styles/index.css instead.
 */
function readTheme() {
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

function readFontFamily() {
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--font-mono').trim() || 'monospace';
}

/**
 * xterm's FitAddon measures the container and, when it is detached or has zero
 * size, leaves the render dimensions undefined — a viewport sync scheduled on
 * the next frame then throws asynchronously (outside any try/catch around
 * fit()). Only fit when the element is actually laid out and visible.
 */
function isFittable(container) {
  return (
    !!container &&
    container.isConnected &&
    container.offsetParent !== null &&
    container.offsetWidth > 0 &&
    container.offsetHeight > 0
  );
}

/**
 * Live PTY surface rendered in place of a running block's static output.
 * A real @xterm/xterm instance interprets cursor movement / CSI sequences
 * (vim, htop, spinners, progress bars) that the static ANSI-only renderer
 * cannot. Keystrokes typed here go straight to the PTY via `writeRaw`.
 */
export function XtermSurface({ tabId, block, height = 200, onSnapshot = null }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const serializeAddonRef = useRef(null);
  const writtenLenRef = useRef(0);
  const blockIdRef = useRef(block.id);
  const snapshotDoneRef = useRef(false);

  const writeRaw = useTerminalStore((s) => s.writeRaw);
  const resizePty = useTerminalStore((s) => s.resizePty);
  const setBlockOutput = useTerminalStore((s) => s.setBlockOutput);

  // Mount the xterm instance once; torn down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const term = new Terminal({
      fontFamily: readFontFamily(),
      fontSize: 12,
      // xterm's lineHeight is a multiplier of fontSize; 1.5 * 12px = 18px so
      // rows line up with the static output's `text-code` (12px/18px) class.
      lineHeight: 1.5,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: readTheme(),
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.open(container);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;
    blockIdRef.current = block.id;
    writtenLenRef.current = 0;

    // Seed with whatever output the block already carries (e.g. a running
    // block that existed before this surface mounted).
    const initialOutput = block.output || '';
    if (initialOutput) {
      term.write(initialOutput);
      writtenLenRef.current = initialOutput.length;
    }

    const doFit = () => {
      if (!termRef.current || !isFittable(container)) return;
      try {
        fitAddon.fit();
        resizePty(tabId, term.cols, term.rows);
      } catch (_) {
        // container not laid out yet (zero size) — ignore, next observer tick retries
      }
    };
    doFit();
    term.focus();

    const dataDisposable = term.onData((data) => {
      writeRaw(tabId, data);
    });

    // Re-read the theme/font whenever the app's light/dark class flips.
    const rootEl = document.documentElement;
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme();
      term.options.fontFamily = readFontFamily();
    });
    themeObserver.observe(rootEl, { attributes: true, attributeFilter: ['class'] });

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => doFit());
      resizeObserver.observe(container);
    }

    return () => {
      dataDisposable.dispose();
      themeObserver.disconnect();
      resizeObserver?.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
    };
    // Mount once per surface instance (a new block id gets a fresh <XtermSurface>
    // via React `key` in TerminalBlock, so this never needs to react to prop changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit when the parent hands us a new pane height.
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !isFittable(containerRef.current)) return;
    try {
      fitAddon.fit();
      resizePty(tabId, term.cols, term.rows);
    } catch (_) {
      // ignore — surface may be between layouts
    }
  }, [height, tabId, resizePty]);

  // Feed incremental PTY output into the live buffer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const output = block.output || '';

    // Block identity changed (surface reused across blocks) or output shrank
    // (block replaced/rewound) — reset and rewrite from scratch.
    if (block.id !== blockIdRef.current || output.length < writtenLenRef.current) {
      term.reset();
      writtenLenRef.current = 0;
      blockIdRef.current = block.id;
    }

    if (output.length > writtenLenRef.current) {
      term.write(output.slice(writtenLenRef.current));
      writtenLenRef.current = output.length;
    }
  }, [block.id, block.output]);

  // On completion: snapshot the live buffer back into the block's output
  // (as ANSI text, so the static renderer keeps colours) and let the parent
  // switch away from this surface.
  useEffect(() => {
    if (block.status === 'running') {
      snapshotDoneRef.current = false;
      return;
    }
    if (snapshotDoneRef.current) return;
    const term = termRef.current;
    const serializeAddon = serializeAddonRef.current;
    if (!term || !serializeAddon) return;

    snapshotDoneRef.current = true;
    const serialized = serializeAddon.serialize({ scrollback: 5000 }).replace(/(\r?\n[ \t]*)+$/, '');
    setBlockOutput(tabId, block.id, serialized);
    onSnapshot?.();
  }, [block.status, block.id, tabId, setBlockOutput, onSnapshot]);

  return <div ref={containerRef} className="w-full overflow-hidden" style={{ height: `${height}px` }} />;
}

export default XtermSurface;
