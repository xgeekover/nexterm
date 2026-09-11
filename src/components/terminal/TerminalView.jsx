import React, { useEffect, useRef } from 'react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { getOrCreateTerminal, isFittable } from './terminalRegistry.js';

// Re-exported so `terminalStore.js` can dispose a tab's terminal on close
// without ever eagerly importing this component module (see the guarded
// dynamic import at that call site).
export { disposeTerminal } from './terminalRegistry.js';

/**
 * A single terminal pane's live surface — one persistent @xterm/xterm
 * instance per tab, attached to that tab's PTY for the whole session, just
 * like iTerm/Terminal.app. There is no separate input box: typing goes
 * straight into the xterm, which forwards to the PTY.
 *
 * The instance itself lives in `terminalRegistry`'s module-level map, not in
 * React state, so switching tabs/panes or this component remounting never
 * loses scrollback — this effect only ever attaches/detaches the instance's
 * DOM node into whichever wrapper is currently mounted.
 */
export function TerminalView({ tabId, active = false }) {
  const wrapperRef = useRef(null);
  const termRef = useRef(null);

  const writeRaw = useTerminalStore((s) => s.writeRaw);
  const resizePty = useTerminalStore((s) => s.resizePty);
  const sessionId = useTerminalStore((s) => s.tabs.find((t) => t.id === tabId)?.sessionId);

  // Attach (or create) this tab's persistent xterm instance whenever the
  // bound tab changes. Never disposes it on cleanup — that only happens via
  // `disposeTerminal`, called from the store's `closeTab`/`closePane`.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !tabId) return undefined;

    const entry = getOrCreateTerminal(tabId, {
      sessionId,
      onData: (data) => writeRaw(tabId, data),
    });
    termRef.current = entry.term;

    wrapper.replaceChildren(entry.container);

    const doFit = () => {
      if (!isFittable(wrapper)) return;
      try {
        entry.fitAddon.fit();
        resizePty(tabId, entry.term.cols, entry.term.rows);
      } catch (_) {
        // container not laid out yet (zero size) — next observer tick retries
      }
    };
    doFit();

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(doFit);
      resizeObserver.observe(wrapper);
    }

    return () => {
      resizeObserver?.disconnect();
      // Deliberately not disposing `entry` or detaching its container here —
      // React unmounting `wrapper` just removes it (and the container inside
      // it) from the document; the instance stays alive in the registry for
      // the next mount to reattach with scrollback intact.
    };
  }, [tabId, sessionId, writeRaw, resizePty]);

  // Sole focus owner in the terminal area: focus the xterm when its pane
  // becomes the active one.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active, tabId]);

  return (
    <div
      ref={wrapperRef}
      onMouseDown={() => termRef.current?.focus()}
      className="w-full h-full overflow-hidden"
    />
  );
}

export default TerminalView;
