import React, { useEffect, useReducer, useRef, useState } from 'react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { ensureGpuRenderer, getOrCreateTerminal, isFittable, clearTerminalSearch } from './terminalRegistry.js';
import { TerminalFindBar } from './TerminalFindBar.jsx';
import { fitAndReport } from '../../lib/terminalCompat.js';
import { suggest, recordCommand, forgetCommand } from '../../lib/commandIndex.js';
import { locateSuggestion, locateCursorCell } from '../../lib/suggestGeometry.js';
import {
  NEW_LINE,
  trackInput,
  rankedSuggestions,
  suggestionsAllowed,
  suggestionKeyAction,
  lineAfterKey,
} from '../../lib/suggestionLayer.js';
import { hangulImeFor, isHangulCharacter } from '../../lib/hangulInlineIme.js';
import { handleClipboardKey } from '../../lib/terminalClipboard.js';
import { isFailure } from '../../lib/tabActivity.js';
import { listen } from '../../lib/ipc.js';
import { cn } from '../../lib/utils.js';
import { addCommandMark, stickyCommandFor } from '../../lib/stickyCommand.js';

// Re-exported so `terminalStore.js` can dispose a tab's terminal on close
// without ever eagerly importing this component module (see the guarded
// dynamic import at that call site).
export { disposeTerminal } from './terminalRegistry.js';

// `items` is ranked when a key is typed; `visible` waits for the shell to echo
// it (see `placeSuggestions`). So clearing means this whole object, never just
// `visible: false`: a ranking left waiting would be drawn when its echo came
// back, even after an Enter, an Esc or a key with nothing to suggest.
const EMPTY_SUGGEST_STATE = {
  visible: false,
  typed: '', // the line the items were ranked for — placement and accept measure against it
  ghost: '', // remaining characters of the top candidate, past what's typed
  items: [], // up to MAX_SUGGESTIONS candidates, for the popup list
  selectedIndex: 0,
  moved: false, // ↑/↓ moved the highlight, so → takes it rather than the ghost
  left: 0,
  top: 0,
  cellWidth: 0,
  cellHeight: 0,
};

// The Korean syllable being composed (see src/lib/hangulInlineIme.js), drawn
// over the cursor's cell. `inFlight` is what was just sent to make way for it
// and is still drawn in front of it until the program's echo moves the cursor
// — otherwise the previous syllable would blink out for one echo round trip.
const EMPTY_IME_PREVIEW = {
  visible: false,
  pending: '',
  inFlight: '',
  left: 0,
  top: 0,
  cellWidth: 0,
  cellHeight: 0,
};

// How long a sent syllable is drawn while waiting for an echo that may never
// come (a program that does not echo, or echoes somewhere else).
const IN_FLIGHT_MS = 500;

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

  // The find bar belongs to the terminal it was opened over, not to the window
  // — in a split it has to be obvious which pane is being searched.
  const findOpen = useTerminalStore((s) => s.find.open && s.find.tabId === tabId);
  const closeFind = useTerminalStore((s) => s.closeFind);
  // Only read so the focus effect below reruns when the resume offer closes.
  const resumeOffered = useTerminalStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.agentResumeOffered === true
  );

  // Suggestion UI state lives in a ref (not React state) because it's
  // written from long-lived xterm event-handler closures (onData / the
  // custom key handler) that must always see the latest value — a plain
  // `useState` would close over whichever render happened to be current
  // when the effect (re)ran the handlers, not the latest one. `forceRender`
  // is the only thing that actually asks React to re-paint the overlay.
  const suggestStateRef = useRef(EMPTY_SUGGEST_STATE);
  /** The last line submitted, kept until its exit code arrives. */
  const lastSubmittedRef = useRef('');

  /**
   * Where each command's output began, so a scrolled-back viewport can say
   * which command produced what is on screen.
   *
   * `{ line, command }` with `line` an ABSOLUTE buffer row (`baseY + cursorY`
   * at the moment the shell reported the command starting), oldest first.
   * Warp's sticky header, built on the OSC 133 "C" marker the backend already
   * emits — scrolling up through a long build and losing track of which
   * command you are inside is the thing it fixes.
   */
  const commandMarksRef = useRef([]);
  const [stickyCommand, setStickyCommand] = useState('');
  const [, forceRender] = useReducer((c) => c + 1, 0);
  const setSuggestState = (next) => {
    const resolved = typeof next === 'function' ? next(suggestStateRef.current) : next;
    suggestStateRef.current = resolved;
    forceRender();
  };

  // Best-effort local copy of the current input line, rebuilt purely from
  // the bytes this component writes to the PTY (see the class doc above):
  // `{ buffer, tracked }`, followed by `trackInput` (src/lib/suggestionLayer.js).
  const lineRef = useRef(NEW_LINE);

  const imePreviewRef = useRef(EMPTY_IME_PREVIEW);

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
    lineRef.current = NEW_LINE;
    setSuggestState(EMPTY_SUGGEST_STATE);

    wrapper.replaceChildren(entry.container);
    const stopShowing = ensureGpuRenderer(entry);

    const doFit = () => {
      // Shared with the Settings window's live refit so the two cannot drift:
      // a pane too small for the backend (mid-layout) keeps its current size,
      // and whatever size does come out is reported to the shell.
      const fitted = fitAndReport({
        tabId,
        term: entry.term,
        fitAddon: entry.fitAddon,
        resizePty,
        fittable: isFittable(wrapper),
      });
      if (!fitted) return;
      // A resize invalidates any cached cursor pixel position — clear
      // rather than risk drawing the overlay in a stale spot.
      setSuggestState(EMPTY_SUGGEST_STATE);
    };
    doFit();

    // A drag fires the observer far more often than the screen refreshes, and
    // every call measured the container twice (`proposeDimensions`, then
    // `fit`) and reflowed the whole buffer. Coalescing to one fit per frame
    // makes a drag cost what it looks like it should.
    let fitFrame = 0;
    const scheduleFit = () => {
      if (typeof requestAnimationFrame === 'undefined') {
        doFit();
        return;
      }
      if (fitFrame) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        doFit();
      });
    };

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(wrapper);
    }

    // ---- Inline suggestion layer -----------------------------------------
    //
    // What it may do and when is decided in src/lib/suggestionLayer.js; this
    // only reads the facts it needs and draws. All of them are read at call
    // time rather than captured: the effect is keyed on the tab and its
    // session, and rebuilding the terminal wiring because a setting moved or a
    // command started would throw the xterm instance's handlers away with it.

    const suggestionsEnabled = () => useSettingsStore.getState().terminalSuggestions ?? true;
    // OSC 133 "C" until "D": a program has the keyboard, and what is typed
    // into it is not a shell command.
    const isRunning = () => useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.running === true;
    const isAlternate = () => entry.term.buffer?.active?.type === 'alternate';
    // The Korean input binding — installed on macOS only, so null elsewhere.
    const ime = hangulImeFor(entry.term);
    const layerAllowed = () =>
      suggestionsAllowed({
        enabled: suggestionsEnabled(),
        running: isRunning(),
        alternate: isAlternate(),
        composing: Boolean(ime?.pending),
      });

    /**
     * Draw the ranked suggestion at the cursor, once the terminal shows what
     * was typed — and not before.
     *
     * A key is sent before the shell echoes it, and until the echo lands the
     * cursor is still where it was before the key. Placing the ghost when the
     * key was sent put it one cell left for every key in flight, over the text
     * just typed. So ranking happens on the keystroke, and this runs again
     * whenever the screen changes: `locateSuggestion` answers nothing until the
     * typed text is on screen, and the suggestion stays hidden until it is.
     * Hiding costs the echo's latency; drawing ahead of the echo would mean
     * predicting where the shell will put the keys, and a wrong prediction is
     * the same bug again. Conservative either way: nothing rather than a
     * suggestion in the wrong place.
     *
     * Measured against the text the items were ranked for, not the live line:
     * a key the layer takes drops the line, and the popup being navigated
     * must stay where it is.
     */
    const placeSuggestions = () => {
      const s = suggestStateRef.current;
      if (s.items.length === 0) return;
      // A program started, the alternate screen came up, or a Korean syllable
      // began composing where the ghost would be.
      if (!layerAllowed()) {
        setSuggestState(EMPTY_SUGGEST_STATE);
        return;
      }
      const pos = locateSuggestion(entry.term, wrapper, s.typed);
      if (!pos) {
        if (s.visible) setSuggestState({ ...s, visible: false });
        return;
      }
      if (
        s.visible &&
        s.left === pos.left &&
        s.top === pos.top &&
        s.cellWidth === pos.cellWidth &&
        s.cellHeight === pos.cellHeight
      ) {
        return;
      }
      setSuggestState({ ...s, visible: true, ...pos });
    };

    const updateSuggestions = () => {
      const { buffer, tracked } = lineRef.current;
      if (!buffer || !tracked || !layerAllowed()) {
        setSuggestState(EMPTY_SUGGEST_STATE);
        return;
      }
      const candidates = suggest(buffer);
      if (candidates.length === 0) {
        setSuggestState(EMPTY_SUGGEST_STATE);
        return;
      }
      // Hidden until the key just typed is on screen — see `placeSuggestions`.
      setSuggestState({ ...EMPTY_SUGGEST_STATE, ...rankedSuggestions(buffer, candidates) });
      placeSuggestions();
    };

    // Second, independent `onData` subscription purely for tracking the
    // input line — deliberately not touching the existing handler passed
    // into `getOrCreateTerminal` above, which owns forwarding keystrokes to
    // the PTY. xterm supports multiple onData listeners; both fire on every
    // keystroke, and on every Korean syllable the IME binding sends.
    const bufferHandler = (data) => {
      const { line, record, rank } = trackInput(lineRef.current, data, { running: isRunning() });
      lineRef.current = line;
      if (record) {
        // Recorded on submit, because that is the only moment that works
        // for a shell without OSC 133 integration. If the shell does report
        // an exit code and it is non-zero, the command is taken back out
        // below — a typo should not be suggested for the rest of the day.
        // The directory as well as the line: it is most of what tells
        // two similar-looking commands apart in the history palette.
        recordCommand(record, {
          cwd: useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.cwd ?? null,
        });
        lastSubmittedRef.current = record;
      }
      if (rank) updateSuggestions();
      else setSuggestState(EMPTY_SUGGEST_STATE);
    };
    const suggestDataDisposable = entry.term.onData(bufferHandler);

    // ---- Korean syllable being composed (macOS) ---------------------------

    let inFlightTimer = 0;
    const setImePreview = (next) => {
      imePreviewRef.current = next;
      forceRender();
    };
    const placeImePreview = () => {
      const p = imePreviewRef.current;
      const text = p.inFlight + p.pending;
      const pos = text ? locateCursorCell(entry.term, wrapper) : null;
      if (!pos) {
        if (p.visible) setImePreview({ ...p, visible: false });
        return;
      }
      if (
        p.visible &&
        p.left === pos.left &&
        p.top === pos.top &&
        p.cellWidth === pos.cellWidth &&
        p.cellHeight === pos.cellHeight
      ) {
        return;
      }
      setImePreview({ ...p, visible: true, ...pos });
    };
    const dropInFlight = () => {
      if (inFlightTimer) {
        clearTimeout(inFlightTimer);
        inFlightTimer = 0;
      }
      const p = imePreviewRef.current;
      if (p.inFlight) setImePreview({ ...p, inFlight: '' });
    };
    const imePreviewDisposable = ime?.onPreview((pending, { flushed = '', retracted = 0 } = {}) => {
      const p = imePreviewRef.current;
      let inFlight = retracted ? '' : p.inFlight;
      if (flushed) {
        inFlight += flushed;
        if (inFlightTimer) clearTimeout(inFlightTimer);
        inFlightTimer = setTimeout(() => {
          inFlightTimer = 0;
          dropInFlight();
          placeImePreview();
        }, IN_FLIGHT_MS);
      }
      // A ghost would sit exactly where the syllable is drawn.
      if (pending) setSuggestState(EMPTY_SUGGEST_STATE);
      setImePreview({ ...p, pending, inFlight });
      placeImePreview();
    });
    imePreviewRef.current = { ...EMPTY_IME_PREVIEW, pending: ime?.pending ?? '' };
    placeImePreview();

    // The echo moves the cursor, which makes that the moment a suggestion
    // ranked on a keystroke can be drawn — xterm moves its own IME textarea on
    // the same event. A scroll, a font change or a switch of renderer moves the
    // cursor's cell on screen without moving the cursor, and each of those
    // ends in a render. The same goes for the syllable being composed, and the
    // echo is what ends a sent syllable's time in front of it.
    const cursorMoveDisposable = entry.term.onCursorMove(() => {
      dropInFlight();
      placeImePreview();
      placeSuggestions();
    });
    const renderDisposable = entry.term.onRender(() => {
      placeImePreview();
      placeSuggestions();
    });

    // Intercepts specific keys ourselves (→ to accept, ↑/↓ to move the popup
    // selection, Esc to dismiss) — and only while something is actually drawn,
    // at a shell prompt. Tab is the shell's, always. Everything else, including
    // arrows when the popup is closed, falls through to xterm untouched.
    const handleKeyEvent = (event) => {
      // Copy and paste first — Ctrl+V / Ctrl+C on Windows and the Linux chords
      // (src/lib/terminalClipboard.js). xterm would otherwise send ^V or ^C and
      // cancel the key, and WebView2 has no Edit menu to fall back on.
      const clipboard = handleClipboardKey(entry.term, event);
      if (clipboard !== undefined) return clipboard;
      const decision = suggestionKeyAction(suggestStateRef.current, event, {
        running: isRunning(),
        alternate: isAlternate(),
      });
      if (decision.action === 'pass') return true;
      // A key the layer takes never reaches the program, so whatever it
      // believed was on the line no longer counts.
      lineRef.current = lineAfterKey(lineRef.current, decision);
      if (decision.action === 'move') {
        setSuggestState((s) => ({ ...s, selectedIndex: decision.selectedIndex, moved: true }));
      } else {
        // Typed as the rest of the line, straight to the shell. Only ever a
        // candidate that continues what was typed — see `completionFor`.
        if (decision.action === 'accept' && decision.text) writeRaw(tabId, decision.text);
        setSuggestState(EMPTY_SUGGEST_STATE);
      }
      if (!decision.consume) return true;
      event.preventDefault();
      return false;
    };
    entry.term.attachCustomKeyEventHandler(handleKeyEvent);

    /**
     * Which command owns the top of the viewport right now, or ''.
     *
     * Nothing is shown while the view is at the bottom — there the last line
     * IS the current command and a header would only repeat it — nor in the
     * alternate buffer, where vim and htop own the whole screen and there is
     * no scrollback to be lost in.
     */
    // Read at call time, not captured: this effect is keyed on the tab and its
    // session, and rebuilding the whole terminal wiring because a checkbox
    // moved would throw the xterm instance away with it. Same shape as
    // `suggestionsEnabled` above.
    const stickyEnabled = () => useSettingsStore.getState().terminalStickyHeader ?? true;

    const updateSticky = () => {
      if (!stickyEnabled()) {
        setStickyCommand('');
        return;
      }
      const buffer = entry.term.buffer.active;
      setStickyCommand(
        stickyCommandFor({
          marks: commandMarksRef.current,
          viewportY: buffer.viewportY,
          baseY: buffer.baseY,
          alternate: buffer.type === 'alternate',
        })
      );
    };

    const scrollDisposable = entry.term.onScroll(updateSticky);

    // OSC 133 "C": output is about to begin, so this row is where this
    // command's output starts. The text comes from what was submitted, which
    // is the only place it exists — the marker carries none.
    let startedUnlisten = null;
    let startedCancelled = false;
    listen('pty-command-started', (payload) => {
      if (payload?.session_id !== sessionId) return;
      const buffer = entry.term.buffer.active;
      commandMarksRef.current = addCommandMark(commandMarksRef.current, {
        line: buffer.baseY + buffer.cursorY,
        command: lastSubmittedRef.current,
        // What has scrolled out of the buffer entirely: keeping those would
        // grow this for the life of the session.
        oldestLine: buffer.baseY - (entry.term.options.scrollback || 0),
      });
    }).then((off) => {
      if (startedCancelled) off();
      else startedUnlisten = off;
    });

    // The backend's OSC 133 "D" (command done) marker means a fresh prompt
    // is about to be printed — whatever we thought was on the input line no
    // longer applies.
    let promptUnlisten = null;
    let promptCancelled = false;
    listen('pty-command-done', (payload) => {
      if (payload?.session_id !== sessionId) return;
      // Only a failure the shell reported takes the line back out of the
      // history. cmd reports every end without a code; `!== 0` read that as a
      // failure and forgot every command typed into cmd.
      if (isFailure(payload.exit_code) && lastSubmittedRef.current) {
        forgetCommand(lastSubmittedRef.current);
      }
      lastSubmittedRef.current = '';
      // A new prompt: a new line, followed from its first key — even one the
      // layer had lost track of.
      lineRef.current = NEW_LINE;
      setSuggestState(EMPTY_SUGGEST_STATE);
    }).then((off) => {
      if (promptCancelled) off();
      else promptUnlisten = off;
    });

    return () => {
      resizeObserver?.disconnect();
      if (fitFrame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(fitFrame);
      scrollDisposable.dispose();
      startedCancelled = true;
      startedUnlisten?.();
      suggestDataDisposable.dispose();
      cursorMoveDisposable.dispose();
      renderDisposable.dispose();
      imePreviewDisposable?.dispose();
      if (inFlightTimer) clearTimeout(inFlightTimer);
      imePreviewRef.current = EMPTY_IME_PREVIEW;
      entry.term.attachCustomKeyEventHandler(null);
      promptCancelled = true;
      promptUnlisten?.();
      // Deliberately not disposing `entry` or detaching its container here —
      // React unmounting `wrapper` just removes it (and the container inside
      // it) from the document; the instance stays alive in the registry for
      // the next mount to reattach with scrollback intact — WebGL renderer
      // included. The registry only hears that it is no longer on screen.
      stopShowing();
    };
  }, [tabId, sessionId, writeRaw, resizePty]);

  // Sole focus owner in the terminal area: focus the xterm when its pane
  // becomes the active one. Not while the find bar is up — it owns the caret
  // until it closes, and stealing it back would make the field untypeable.
  //
  // Also when the resume offer closes. Chromium (WebView2, so Windows) focuses
  // a button on click, and Resume / Dismiss unmount the offer they sit in, so
  // focus fell to <body>: the agent had started and the keyboard reached
  // nothing until the terminal was clicked. WebKit never focuses the button,
  // which is why it only shows on Windows.
  useEffect(() => {
    if (active && !findOpen) termRef.current?.focus();
  }, [active, tabId, findOpen, resumeOffered]);

  // `updateSticky` only runs on scroll, so without this the bar would sit there
  // until the next one — a setting you can watch not take effect is worse than
  // no setting.
  const stickyHeaderEnabled = useSettingsStore((s) => s.terminalStickyHeader);
  useEffect(() => {
    if (!stickyHeaderEnabled) setStickyCommand('');
  }, [stickyHeaderEnabled]);

  const dismissFind = () => {
    clearTerminalSearch(tabId);
    closeFind();
    // Closing hands the keyboard back to the shell, which is where it was.
    termRef.current?.focus();
  };

  const suggestState = suggestStateRef.current;
  const imePreview = imePreviewRef.current;
  const imeText = imePreview.inFlight + imePreview.pending;
  const termTheme = termRef.current?.options?.theme;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div
        ref={wrapperRef}
        onMouseDown={() => termRef.current?.focus()}
        className="w-full h-full overflow-hidden"
      />
      {findOpen && <TerminalFindBar tabId={tabId} onClose={dismissFind} />}
      {stickyCommand && (
        <div
          data-sticky-command
          aria-hidden="true"
          // Decoration over the terminal: it must not take a click that was
          // meant for the text underneath it, nor a selection drag.
          // Solid, not translucent: Tailwind's `/95` opacity modifier does
          // nothing to a colour that is a bare `var(--x)`, so the first line of
          // output read straight through the header. A sticky header covers
          // the row it describes — every one does — but it has to cover it.
          className="absolute top-0 left-0 right-0 z-10 px-2 py-[2px] flex items-center gap-2 pointer-events-none bg-vsc-panel border-b border-vsc-border text-ui-sm font-mono text-vsc-muted"
        >
          <span className="shrink-0 text-vsc-accent">❯</span>
          <span className="truncate">{stickyCommand}</span>
        </div>
      )}
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
      {imePreview.visible && imeText && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
          {/* The Korean syllable being composed, over the cursor — in the
              terminal's font and colours, underlined like composition text,
              each syllable two cells wide as the terminal will draw it. */}
          <span
            data-ime-preview
            className="absolute flex whitespace-pre bg-vsc-terminal text-vsc-fg"
            style={{
              left: imePreview.left,
              top: imePreview.top,
              height: imePreview.cellHeight,
              lineHeight: `${imePreview.cellHeight}px`,
              fontFamily: termRef.current?.options?.fontFamily,
              fontSize: termRef.current?.options?.fontSize,
              color: termTheme?.foreground,
              background: termTheme?.background,
            }}
          >
            {[...imeText].map((ch, i) => (
              <span
                // The text only ever changes at its end; position is identity.
                key={i}
                className="inline-block text-center underline"
                style={{ width: (isHangulCharacter(ch) ? 2 : 1) * imePreview.cellWidth }}
              >
                {ch}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

export default TerminalView;
