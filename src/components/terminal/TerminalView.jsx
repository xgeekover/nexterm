import React, { useEffect, useReducer, useRef } from 'react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { ensureGpuRenderer, getOrCreateTerminal, isFittable } from './terminalRegistry.js';
import { usablePtySize } from '../../lib/terminalCompat.js';
import { suggest, recordCommand, forgetCommand, completionFor } from '../../lib/commandIndex.js';
import { listen } from '../../lib/ipc.js';
import { cn } from '../../lib/utils.js';

// Re-exported so `terminalStore.js` can dispose a tab's terminal on close
// without ever eagerly importing this component module (see the guarded
// dynamic import at that call site).
export { disposeTerminal } from './terminalRegistry.js';

const EMPTY_SUGGEST_STATE = {
  visible: false,
  ghost: '', // remaining characters of the top candidate, past what's typed
  items: [], // up to MAX_SUGGESTIONS candidates, for the popup list
  selectedIndex: 0,
  left: 0,
  top: 0,
  cellWidth: 0,
  cellHeight: 0,
};

/**
 * Measures one xterm cell in real pixels from the rendered `.xterm-rows`
 * element (a DOM measurement, per the task — an alternative is
 * `term._core._renderService.dimensions`, a private API, which this
 * deliberately avoids). Returns null rather than a guess when the terminal
 * isn't laid out yet — callers must treat that as "show nothing".
 */
function measureCell(term) {
  const rowsEl = term.element?.querySelector('.xterm-rows');
  if (!rowsEl) return null;
  const rect = rowsEl.getBoundingClientRect();
  if (!rect.width || !rect.height || !term.cols || !term.rows) return null;
  return { rect, cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows };
}

/**
 * Pixel position of the live cursor, relative to `wrapper` (the element the
 * overlay is absolutely positioned inside of) — from `term.buffer.active`,
 * per the task. Returns null on any uncertainty (not laid out, buffer not
 * ready) so the caller can prefer showing nothing over a wrong position.
 */
function computeCursorPixelPos(term, wrapper) {
  if (!wrapper) return null;
  const cell = measureCell(term);
  if (!cell) return null;
  const buffer = term.buffer?.active;
  if (!buffer || buffer.cursorX == null || buffer.cursorY == null) return null;
  const wrapperRect = wrapper.getBoundingClientRect();
  return {
    left: cell.rect.left - wrapperRect.left + buffer.cursorX * cell.cellWidth,
    top: cell.rect.top - wrapperRect.top + buffer.cursorY * cell.cellHeight,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
  };
}

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
 *
 * On top of that, this component also runs an app-side inline suggestion
 * layer (oh-my-zsh/Warp-style autosuggest + a small completion popup) — see
 * the `suggestStateRef`-driven block below. It is intentionally best-effort:
 * it tracks a local guess of "what's on the current input line" purely from
 * the bytes this component sends to the PTY, it does not read the shell's
 * real line buffer. See the module doc in `src/lib/commandIndex.js` and this
 * worker's task report for the specific cases this cannot get right
 * (mid-line editing via arrow keys, multi-line prompts, vi-mode, pastes).
 */
export function TerminalView({ tabId, active = false }) {
  const wrapperRef = useRef(null);
  const termRef = useRef(null);

  const writeRaw = useTerminalStore((s) => s.writeRaw);
  const resizePty = useTerminalStore((s) => s.resizePty);
  const sessionId = useTerminalStore((s) => s.tabs.find((t) => t.id === tabId)?.sessionId);

  // Suggestion UI state lives in a ref (not React state) because it's
  // written from long-lived xterm event-handler closures (onData / the
  // custom key handler) that must always see the latest value — a plain
  // `useState` would close over whichever render happened to be current
  // when the effect (re)ran the handlers, not the latest one. `forceRender`
  // is the only thing that actually asks React to re-paint the overlay.
  const suggestStateRef = useRef(EMPTY_SUGGEST_STATE);
  /** The last line submitted, kept until its exit code arrives. */
  const lastSubmittedRef = useRef('');
  const [, forceRender] = useReducer((c) => c + 1, 0);
  const setSuggestState = (next) => {
    const resolved = typeof next === 'function' ? next(suggestStateRef.current) : next;
    suggestStateRef.current = resolved;
    forceRender();
  };

  // Best-effort local copy of the current input line, rebuilt purely from
  // the bytes this component writes to the PTY (see the class doc above).
  const bufferRef = useRef('');

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
    bufferRef.current = '';
    setSuggestState(EMPTY_SUGGEST_STATE);

    wrapper.replaceChildren(entry.container);
    ensureGpuRenderer(entry);

    const doFit = () => {
      if (!isFittable(wrapper)) return;
      try {
        // A pane too small for the backend (mid-layout) keeps its current size:
        // otherwise xterm draws for one size while the shell writes for another.
        const size = usablePtySize(entry.fitAddon.proposeDimensions());
        if (!size) return;
        entry.fitAddon.fit();
        if (entry.term.cols !== size.cols || entry.term.rows !== size.rows) {
          entry.term.resize(size.cols, size.rows);
        }
        resizePty(tabId, entry.term.cols, entry.term.rows);
        // A resize invalidates any cached cursor pixel position — clear
        // rather than risk drawing the overlay in a stale spot.
        setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
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

    // ---- Inline suggestion layer -----------------------------------------

    const suggestionsEnabled = () => useSettingsStore.getState().terminalSuggestions ?? true;

    const updateSuggestions = () => {
      if (!suggestionsEnabled()) {
        setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
        return;
      }
      const buf = bufferRef.current;
      if (!buf) {
        setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
        return;
      }
      const candidates = suggest(buf);
      if (candidates.length === 0) {
        setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
        return;
      }
      const pos = computeCursorPixelPos(entry.term, wrapper);
      if (!pos) {
        // Conservative: if we can't trust the cursor position, show nothing
        // rather than draw a suggestion in the wrong place.
        setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
        return;
      }
      const top = candidates[0];
      const ghost = top.length > buf.length && top.toLowerCase().startsWith(buf.toLowerCase())
        ? top.slice(buf.length)
        : '';
      setSuggestState({
        visible: true,
        ghost,
        items: candidates,
        selectedIndex: 0,
        left: pos.left,
        top: pos.top,
        cellWidth: pos.cellWidth,
        cellHeight: pos.cellHeight,
      });
    };

    // Second, independent `onData` subscription purely for tracking the
    // input line — deliberately not touching the existing handler passed
    // into `getOrCreateTerminal` above, which owns forwarding keystrokes to
    // the PTY. xterm supports multiple onData listeners; both fire on every
    // keystroke.
    const bufferHandler = (data) => {
      if (!data) return;

      if (data.length > 1) {
        // Pastes / IME commits arrive as one multi-character chunk. A
        // single-line chunk with no control bytes is safe to fold into the
        // buffer; anything containing a newline or control byte is too
        // ambiguous to reconstruct reliably, so drop tracking instead of
        // risking a wrong suggestion (see "Known-imperfect cases").
        if (/[\r\n\x03\x1b\x7f]/.test(data)) {
          bufferRef.current = '';
          setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
        } else {
          bufferRef.current += data;
          updateSuggestions();
        }
        return;
      }

      switch (data) {
        case '\r':
        case '\n': {
          const cmd = bufferRef.current.trim();
          if (cmd) {
            // Recorded on submit, because that is the only moment that works
            // for a shell without OSC 133 integration. If the shell does report
            // an exit code and it is non-zero, the command is taken back out
            // below — a typo should not be suggested for the rest of the day.
            recordCommand(cmd);
            lastSubmittedRef.current = cmd;
          }
          bufferRef.current = '';
          setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
          return;
        }
        case '\x7f':
        case '\b':
          bufferRef.current = bufferRef.current.slice(0, -1);
          updateSuggestions();
          return;
        case '\x03': // Ctrl-C
          bufferRef.current = '';
          setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
          return;
        default:
          if (data === '\x1b' || data.charCodeAt(0) < 0x20) {
            // Bare Esc or another control byte (arrow keys arrive as their
            // own multi-char escape sequences and are handled by the key
            // handler below, not here) — clear defensively.
            setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
            return;
          }
          bufferRef.current += data;
          updateSuggestions();
      }
    };
    const suggestDataDisposable = entry.term.onData(bufferHandler);

    /**
     * Accept a suggestion by typing the part the user has not typed yet.
     *
     * That only works when the candidate actually CONTINUES what is on the
     * line. `suggest()` also returns subsequence matches — `gs` matches
     * `git push` — and slicing those by the buffer's length wrote the tail of
     * a different string onto the line: `gs` + Enter became `gst push`, and
     * the Enter was swallowed, so the user got a mangled line instead of a
     * command. Anything that is not a continuation is left alone.
     *
     * @returns true when something was written.
     */
    const acceptSuggestion = (index) => {
      const state = suggestStateRef.current;
      const chosen = state.items[index ?? 0];
      const rest = completionFor(bufferRef.current, chosen);
      if (rest === null) {
        setSuggestState(EMPTY_SUGGEST_STATE);
        return false;
      }
      if (rest) {
        writeRaw(tabId, rest);
        bufferRef.current = chosen;
      }
      setSuggestState(EMPTY_SUGGEST_STATE);
      return true;
    };

    // Intercepts specific keys ourselves (Tab/→ to accept, ↑/↓ to move the
    // popup selection, Enter to accept, Esc to dismiss) and lets everything
    // else — including arrows when the popup is closed — fall through to
    // xterm's normal handling untouched.
    const handleKeyEvent = (event) => {
      if (event.type !== 'keydown') return true;
      const state = suggestStateRef.current;
      const popupOpen = state.visible && state.items.length > 1;

      if (state.visible && state.ghost && (event.key === 'Tab' || event.key === 'ArrowRight')) {
        if (!acceptSuggestion(popupOpen ? state.selectedIndex : 0)) return true;
        event.preventDefault();
        return false;
      }
      if (popupOpen && event.key === 'ArrowDown') {
        event.preventDefault();
        setSuggestState((s) => ({ ...s, selectedIndex: (s.selectedIndex + 1) % s.items.length }));
        return false;
      }
      if (popupOpen && event.key === 'ArrowUp') {
        event.preventDefault();
        setSuggestState((s) => ({
          ...s,
          selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
        }));
        return false;
      }
      // Enter RUNS what is on the line — it never accepts a suggestion. Taking
      // the highlighted item instead meant typing `opencode`, seeing a stale
      // `opencoded` offered from history, and having it typed for you. Tab and
      // → accept; Enter submits, as it does in every shell.
      if (popupOpen && event.key === 'Enter') {
        setSuggestState(EMPTY_SUGGEST_STATE);
        return true;
      }
      if (state.visible && event.key === 'Escape') {
        event.preventDefault();
        setSuggestState(EMPTY_SUGGEST_STATE);
        return false;
      }
      return true;
    };
    entry.term.attachCustomKeyEventHandler(handleKeyEvent);

    // The backend's OSC 133 "D" (command done) marker means a fresh prompt
    // is about to be printed — whatever we thought was on the input line no
    // longer applies.
    let promptUnlisten = null;
    let promptCancelled = false;
    listen('pty-command-done', (payload) => {
      if (payload?.session_id !== sessionId) return;
      if (payload.exit_code !== 0 && lastSubmittedRef.current) {
        forgetCommand(lastSubmittedRef.current);
      }
      lastSubmittedRef.current = '';
      bufferRef.current = '';
      setSuggestState((s) => (s.visible ? EMPTY_SUGGEST_STATE : s));
    }).then((off) => {
      if (promptCancelled) off();
      else promptUnlisten = off;
    });

    return () => {
      resizeObserver?.disconnect();
      suggestDataDisposable.dispose();
      entry.term.attachCustomKeyEventHandler(null);
      promptCancelled = true;
      promptUnlisten?.();
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

  const suggestState = suggestStateRef.current;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div
        ref={wrapperRef}
        onMouseDown={() => termRef.current?.focus()}
        className="w-full h-full overflow-hidden"
      />
      {suggestState.visible && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
          {suggestState.ghost && (
            <span
              className="absolute whitespace-pre text-vsc-muted"
              style={{
                left: suggestState.left,
                top: suggestState.top,
                lineHeight: `${suggestState.cellHeight}px`,
                fontFamily: termRef.current?.options?.fontFamily,
                fontSize: termRef.current?.options?.fontSize,
              }}
            >
              {suggestState.ghost}
            </span>
          )}
          {suggestState.items.length > 1 && (
            <div
              className="absolute bg-vsc-quickinput border border-vsc-widget-border shadow-widget"
              style={{ left: suggestState.left, top: suggestState.top + suggestState.cellHeight }}
            >
              {suggestState.items.map((item, i) => (
                <div
                  key={item}
                  className={cn(
                    'h-[22px] px-2 flex items-center whitespace-pre text-ui-sm font-mono',
                    i === suggestState.selectedIndex ? 'bg-vsc-selection' : 'text-vsc-fg'
                  )}
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TerminalView;
