/**
 * What xterm.js has to be told about the pty behind it.
 *
 * Pure functions only — no xterm, no store — so the rules can be tested in Node.
 */

/**
 * The size range the backend gives a pty. `PtyManager::spawn` and `resize` in
 * src-tauri/src/pty/manager.rs clamp to exactly these, so a terminal sized
 * outside them would be drawn for one size while the shell writes for another.
 */
export const PTY_COLS = { min: 10, max: 500 };
export const PTY_ROWS = { min: 2, max: 200 };

/**
 * xterm's `windowsPty` option for the machine the backend describes, or
 * undefined anywhere but Windows.
 *
 * Windows 10's ConPTY ends a wrapped line with a real line break and re-wraps
 * and repaints the screen itself on resize. Untold, xterm.js reflows as well
 * and pulls scrollback into a pane that gains rows. Measured on Windows 10
 * 19045 with cmd.exe: widening then narrowing a pane left 8 of 30 long lines
 * intact, and doubling a pane's rows lost 11 of 25 lines from the buffer
 * outright; with this option set, all 30 and all 25 survived. ConPTY from build
 * 21376 wraps natively, and xterm only needs the build number to tell them
 * apart — without one it assumes the older behaviour, which is the safe side.
 */
export function windowsPtyFor(system) {
  if (!system || system.os !== 'windows') return undefined;
  const build = Number(system.osBuild);
  return Number.isInteger(build) && build > 0
    ? { backend: 'conpty', buildNumber: build }
    : { backend: 'conpty' };
}

/**
 * The size to give a terminal and its pty for the size a pane could hold, or
 * null when the pane is too small to be a real terminal yet.
 *
 * A pane in the middle of a layout change can measure a column or two wide.
 * Sending that on left xterm wrapping at 2 columns while the backend, which
 * never goes below 10, had the shell write for 10. Too small: keep the current
 * size until the pane is real. Too large: stop at the backend's ceiling so both
 * sides still agree.
 */
export function usablePtySize(dims) {
  if (!dims) return null;
  const cols = Math.floor(Number(dims.cols));
  const rows = Math.floor(Number(dims.rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < PTY_COLS.min || rows < PTY_ROWS.min) return null;
  return { cols: Math.min(cols, PTY_COLS.max), rows: Math.min(rows, PTY_ROWS.max) };
}

/**
 * A path without Windows' verbatim `\\?\` prefix, as a person would write it.
 *
 * The backend handed such paths out until it canonicalized through dunce, and
 * they were persisted with the terminal layout — so a restored terminal kept
 * showing `\\?\D:\…` long after the backend stopped producing it.
 */
export function withoutVerbatimPrefix(path) {
  if (typeof path !== 'string') return path;
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  if (/^\\\\\?\\[A-Za-z]:/.test(path)) return path.slice(4);
  return path;
}

/**
 * Refit a terminal to its pane AND tell the shell the size that came out.
 *
 * Both halves matter, and the second one is easy to forget: the app used to
 * refit after a font or line-height change without reporting, because the pane
 * itself had not moved so `TerminalView`'s ResizeObserver never fired.
 * Measured in a real browser — halving the font took the grid from 107x33 to
 * 251x70 while the shell went on believing it had 107 columns, and stayed
 * wrong until something else happened to resize the window. Anything drawing a
 * full screen (vim, htop, a TUI) draws for the wrong width in between.
 *
 * Returns the size reported, or null when the pane is not measurable yet — a
 * pane mid-layout is left at its current size rather than told a nonsense one.
 *
 * `term`, `fitAddon` and `resizePty` are passed in rather than imported so this
 * stays free of xterm and of the store, and can be checked in Node.
 */
export function fitAndReport({ tabId, term, fitAddon, resizePty, fittable = true }) {
  if (!fittable || !term || !fitAddon) return null;

  let size;
  try {
    size = usablePtySize(fitAddon.proposeDimensions());
  } catch (_) {
    return null;
  }
  if (!size) return null;

  try {
    fitAddon.fit();
    // `fit` measures again itself and can land a row or two off what
    // `proposeDimensions` just said; the clamped size is the one both sides
    // agreed on, so force it rather than let them drift.
    if (term.cols !== size.cols || term.rows !== size.rows) {
      term.resize(size.cols, size.rows);
    }
  } catch (_) {
    // container not laid out yet — the next resize retries
    return null;
  }

  resizePty?.(tabId, term.cols, term.rows);
  return { cols: term.cols, rows: term.rows };
}

const ARROW_KEYS = Object.freeze({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' });
const ARROW_KEY_CODES = Object.freeze({ 37: 'left', 39: 'right', 38: 'up', 40: 'down' });
const CTRL_ARROW = Object.freeze({ left: '\x1b[1;5D', right: '\x1b[1;5C', up: '\x1b[1;5A', down: '\x1b[1;5B' });
const MAC_OPTION_ARROW = Object.freeze({ left: '\x1bb', right: '\x1bf' });

/**
 * What xterm 5.5 sent for Option/Alt and an arrow key, or null for any other
 * key — xterm 6 no longer does it (xterm.js #5346).
 *
 * xterm 6 sends the arrow with the Alt modifier, `CSI 1;3D` / `CSI 1;3C`, and
 * a default zsh has nothing bound to either. Measured with a real zsh 5.9,
 * with no startup files and with macOS's /etc/zshrc alike: ⌥← at the end of
 * `echo aaa bbb ccc` typed `;3D` into the line instead of moving, so Enter ran
 * the echo and then a command named `3DX`; ⌥→ typed `;3C`. xterm 5.5 sent
 * `ESC b` / `ESC f` on macOS — a word back and forward to zsh, bash and Claude
 * Code alike — and Ctrl and the arrow everywhere else, ↑ and ↓ included. This
 * is that mapping, exactly: Alt alone (with Shift, Ctrl or ⌘ it is another
 * key), on keydown, and never for a key an IME is composing with.
 */
export function legacyAltArrowSequence(event, { mac = false } = {}) {
  if (!event || event.type !== 'keydown') return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  const arrow = ARROW_KEYS[event.key] ?? ARROW_KEY_CODES[event.keyCode];
  if (!arrow) return null;
  return (mac ? MAC_OPTION_ARROW[arrow] : CTRL_ARROW[arrow]) ?? null;
}

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

/**
 * What one wheel event is worth before its unit is applied, as xterm 5.5
 * measured it (`Viewport._applyScrollModifier`): its deltaY times
 * `scrollSensitivity`, and ⌥/Alt — 5.5's default fast-scroll modifier —
 * `fastScrollSensitivity` times as far again. Shift, a sideways scroll, is
 * worth nothing. Negative is up.
 */
function wheelAmount(event, { scrollSensitivity = 1, fastScrollSensitivity = 5 } = {}) {
  const deltaY = Number(event?.deltaY) || 0;
  if (!deltaY || event.shiftKey) return 0;
  return deltaY * scrollSensitivity * (event.altKey ? fastScrollSensitivity : 1);
}

/**
 * How many arrow keys one wheel event is worth to a full-screen program that
 * did not ask for the mouse (`less`, `man`, `git log`), counted as xterm 5.5
 * counted them (`Viewport.getLinesScrolled`): the event's pixels over the row
 * height, the fraction carried to the next event (`partial`); a line-mode
 * event that many lines, a page-mode one that many screens, one key for
 * every whole step begun — 1.5 lines were two keys. See `wheelAmount` for ⌥
 * and Shift.
 *
 * xterm 6 sends ONE arrow per wheel event whatever its size ("simplified" with
 * the new viewport): measured under headless Chromium, a mouse-wheel notch
 * moved a pager 1 line where 5.5 moved it 5, and a short trackpad-like swipe 2
 * lines where 5.5 moved it 6.
 */
export function wheelArrowCount(event, { cellHeight = 0, rows = 0, partial = 0, ...sensitivity } = {}) {
  const amount = wheelAmount(event, sensitivity);
  const whole = (n) => Math.sign(n) * Math.ceil(Math.abs(n));
  if (event?.deltaMode === WHEEL_DELTA_LINE) return { lines: whole(amount), partial };
  if (event?.deltaMode === WHEEL_DELTA_PAGE) return { lines: whole(amount * rows), partial };
  if (!amount || !(cellHeight > 0)) return { lines: 0, partial };
  const total = partial + amount / cellHeight;
  const lines = Math.trunc(total);
  return { lines, partial: total - lines };
}

/**
 * How many rows one wheel event scrolls the scrollback, as xterm 5.5 scrolled
 * it. 5.5 added the event's pixels (`_getPixelsScrolled`: a line-mode event's
 * lines and a page-mode event's screens in pixels) to its viewport's native
 * `scrollTop`, and showed the row nearest to it — `Math.round(scrollTop /
 * rowHeight)` — so what a notch fell short of a row was kept for the next:
 * 100 px notches at 16 px rows moved 6, then 6, then 7 rows.
 *
 * Done relative to the row on screen, which rounds the same way, the row
 * being whole: `offset` is the remainder the previous call returned, in
 * pixels like 5.5's, and `min` / `max` are how many rows the viewport can go
 * each way — where 5.5's `scrollTop` stopped, and its remainder with it.
 *
 * The one difference: the remainder is kept exactly, where a browser may hold
 * `scrollTop` in whole device pixels. A trackpad's fractional deltas can then
 * reach a row one event sooner or later than under 5.5; whole-pixel deltas —
 * a mouse notch, in WebView2 and WKWebView alike — count exactly the same.
 */
export function wheelScrollRows(
  event,
  { cellHeight = 0, rows = 0, offset = 0, min = -Infinity, max = Infinity, ...sensitivity } = {}
) {
  if (!(cellHeight > 0)) return { rows: 0, offset };
  let pixels = wheelAmount(event, sensitivity);
  if (event?.deltaMode === WHEEL_DELTA_LINE) pixels *= cellHeight;
  else if (event?.deltaMode === WHEEL_DELTA_PAGE) pixels *= cellHeight * rows;
  const target = Math.min(Math.max(offset + pixels, min * cellHeight), max * cellHeight);
  const scrolled = Math.round(target / cellHeight) || 0; // `|| 0`: never -0
  return { rows: scrolled, offset: target - scrolled * cellHeight };
}

/**
 * Whether the program is told about the wheel rather than xterm acting on it:
 * a mouse protocol that reports it — VT200, DRAG or ANY. X10 (`?9h`) reports
 * presses only, so under it xterm scrolls and sends arrows exactly as with no
 * protocol at all, and so does every rule here.
 */
function wheelReported(term) {
  const mode = term.modes?.mouseTrackingMode ?? 'none';
  return mode !== 'none' && mode !== 'x10';
}

/** The active screen keeps no scrollback: the alternate one, or a terminal made with none. */
function noScrollback(term) {
  return term.buffer?.active?.type === 'alternate' || term.options?.scrollback === 0;
}

/** One row's height in CSS pixels as drawn — the screen's over its rows — or 0 before it is laid out. */
function rowHeightOf(term) {
  const screen = term.element?.querySelector?.('.xterm-screen');
  const height = screen?.getBoundingClientRect?.().height ?? 0;
  return term.rows > 0 ? height / term.rows : 0;
}

/**
 * Turn the wheel into as many arrow keys as xterm 5.5 did (`wheelArrowCount`)
 * wherever xterm turns it into arrow keys at all: a screen with no scrollback
 * (the alternate one, or scrollback 0) and no protocol that reports the wheel
 * — X10 included, under which xterm 6 sent one arrow per event as well.
 * Everywhere else the event is xterm's, untouched: the scrollback scrolls
 * (`installScrollbackWheel`), or the program gets wheel reports. Uses the
 * terminal's one custom wheel slot; returns whether it was installed.
 */
export function installPagerWheel(term) {
  if (typeof term?.attachCustomWheelEventHandler !== 'function') return false;
  let partial = 0;
  term.attachCustomWheelEventHandler((event) => {
    try {
      if (!noScrollback(term) || wheelReported(term)) return true;
      const result = wheelArrowCount(event, {
        cellHeight: rowHeightOf(term),
        rows: term.rows,
        scrollSensitivity: term.options?.scrollSensitivity ?? 1,
        fastScrollSensitivity: term.options?.fastScrollSensitivity ?? 5,
        partial,
      });
      partial = result.partial;
      if (result.lines !== 0) {
        const key = `\x1b${term.modes?.applicationCursorKeysMode ? 'O' : '['}${result.lines < 0 ? 'A' : 'B'}`;
        term.input(key.repeat(Math.abs(result.lines)), true);
      }
      // As xterm cancels a wheel it turned into keys: the page must not scroll.
      event.preventDefault?.();
      event.stopPropagation?.();
      return false;
    } catch {
      return true;
    }
  });
  return true;
}

/**
 * The scrollback half of the wheel, as an xterm addon so it is disposed with
 * its terminal (see `installScrollbackWheel`).
 *
 * The listener goes on `term.element` in the CAPTURE phase. xterm 6 scrolls
 * the scrollback from a bubble-phase listener on the `.xterm-scrollable-
 * element` it puts inside that element (src/browser/Viewport.ts), so this
 * runs first, and stopping the event here means xterm never sees it — not the
 * scrollable element, and not xterm's own listener on `term.element` either.
 */
class ScrollbackWheelAddon {
  constructor() {
    this._offset = 0;
    this._scrolling = false;
    this._disposables = [];
  }

  activate(term) {
    const element = term.element;
    if (typeof element?.addEventListener !== 'function') return;
    const onWheel = (event) => {
      try {
        if (noScrollback(term) || wheelReported(term)) return;
        // A sideways swipe: nothing for the scrollback, and nothing to cancel.
        if (!Number(event.deltaY)) return;
        const cellHeight = rowHeightOf(term);
        const buffer = term.buffer?.active;
        // Not laid out, or not an xterm this knows: its own scrolling beats none.
        if (!(cellHeight > 0) || !Number.isInteger(buffer?.viewportY) || !Number.isInteger(buffer?.baseY)) return;
        const result = wheelScrollRows(event, {
          cellHeight,
          rows: term.rows,
          scrollSensitivity: term.options?.scrollSensitivity ?? 1,
          fastScrollSensitivity: term.options?.fastScrollSensitivity ?? 5,
          offset: this._offset,
          min: -buffer.viewportY,
          max: buffer.baseY - buffer.viewportY,
        });
        // Cancelled before the scroll: should it throw, the wheel is lost
        // once rather than counted twice.
        event.preventDefault();
        event.stopPropagation();
        this._offset = result.offset;
        if (result.rows === 0) return;
        this._scrolling = true;
        try {
          term.scrollLines(result.rows);
        } finally {
          this._scrolling = false;
        }
      } catch (err) {
        console.warn('[Terminal] wheel over the scrollback failed:', err);
      }
    };
    element.addEventListener('wheel', onWheel, { capture: true, passive: false });
    this._disposables.push({ dispose: () => element.removeEventListener('wheel', onWheel, { capture: true }) });
    // Anything else that moves the viewport — output, a key, the scrollbar —
    // put 5.5's scrollTop back on a row, and the remainder went with it.
    // xterm 6 scrolls synchronously (no `smoothScrollDuration`), so the
    // scroll this addon makes itself is the one that arrives while
    // `_scrolling` is set.
    if (typeof term.onScroll === 'function') {
      this._disposables.push(
        term.onScroll(() => {
          if (!this._scrolling) this._offset = 0;
        })
      );
    }
  }

  dispose() {
    for (const d of this._disposables.splice(0)) {
      try {
        d?.dispose?.();
      } catch {
        // the terminal is going anyway
      }
    }
  }
}

/**
 * Scroll the scrollback as far per wheel event as xterm 5.5 did
 * (`wheelScrollRows`) — on every platform, from the event's own delta.
 *
 * xterm 6's viewport is VS Code's `SmoothScrollableElement`, which reads the
 * legacy `wheelDeltaY / 120` (vs/base/browser/mouseEvent.ts) and scrolls
 * 50 px for each unit: a fixed distance per notch, whatever the event's own
 * deltaY says, and blind to the OS's lines-per-notch setting, since
 * wheelDeltaY stays 120. Measured: in Chromium — WebView2 — a notch is deltaY
 * 100, and xterm 6 scrolled 3 rows of 16 px where 5.5 scrolled 6; in the
 * macOS app (WKWebView) a notch is deltaY 40, and at 21 px rows xterm 6
 * scrolled 2.4 rows where 5.5 scrolled 1.9.
 *
 * Only where xterm would scroll the scrollback: the normal screen with
 * scrollback, and no protocol that reports the wheel. The alternate screen
 * and a terminal without scrollback are `installPagerWheel`'s; a wheel the
 * program asked to hear about goes to it, as a report.
 *
 * Call after `term.open()` — the listener needs `term.element`. Returns the
 * addon, or null when the terminal has no element yet.
 */
export function installScrollbackWheel(term) {
  if (typeof term?.element?.addEventListener !== 'function' || typeof term.loadAddon !== 'function') return null;
  const addon = new ScrollbackWheelAddon();
  term.loadAddon(addon);
  return addon;
}

/** The @xterm/xterm release the app ships — what XTVERSION reports (SO-02 keeps it true). */
export const XTERM_VERSION = '6.0.0';

/**
 * The reply to XTVERSION (`CSI > q`, `CSI > 0 q`), or null for any other
 * parameter: `DCS > | xterm.js(6.0.0) ST`.
 *
 * xterm.js answers this itself only from 6.1 (#5502, merged four days after
 * 6.0.0 shipped), with exactly this text. Claude Code 2.1.289 asks XTVERSION
 * first and sends its DEC 2026 probe (`CSI ? 2026 $ p`) ONLY if a reply comes
 * back — its own log says "DECRQM 2026 not asked (no XTVERSION reply)" — and
 * otherwise guesses from TERM_PROGRAM, which nothing sets for a shell in this
 * app. So without this, xterm 6's synchronized output went unused by the one
 * program it was wanted for. Answering as xterm.js is the truth (this IS
 * xterm.js) and is what makes Claude Code treat the app as it treats VS
 * Code's terminal. Drop it with the move to xterm 6.1, which says the same.
 */
export function xtVersionReply(params, version = XTERM_VERSION) {
  const ps = Array.isArray(params) ? params[0] : undefined;
  if (typeof ps === 'number' && ps > 0) return null;
  return `\x1bP>|xterm.js(${version})\x1b\\`;
}

/**
 * Answer XTVERSION on `term` from now on (see `xtVersionReply`): the reply goes
 * out the way xterm's own replies do, through `onData`, not as typed input.
 * Returns the parser handler's disposable, or null when `term` has no parser.
 * Never throws inside the parser — a handler that throws wedges xterm's write
 * queue for good (see mouseReporting.js).
 */
export function installXtVersionReply(term, version = XTERM_VERSION) {
  const parser = term?.parser;
  if (typeof parser?.registerCsiHandler !== 'function') return null;
  return parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    try {
      const reply = xtVersionReply(params, version);
      if (reply) term.input(reply, false);
    } catch (err) {
      console.warn('[Terminal] could not answer XTVERSION:', err);
    }
    return true;
  });
}

/** The width provider `@xterm/addon-unicode-graphemes` registers: Unicode 15, by grapheme cluster. */
export const GRAPHEME_WIDTHS = '15-graphemes';

/**
 * Measure characters the way the programs inside the terminal do.
 *
 * xterm defaults to Unicode 6 widths, in which every emoji is ONE cell, while
 * Claude Code (`Bun.stringWidth`), Ink and most modern command-line tools
 * count it as two. A program that redraws by moving the cursor relative to
 * what it believes is on screen then lands one column off for every emoji to
 * the left: a status line `✅ 통과 13개` repainted as `✅ 통과 123`, and the
 * WebGL renderer squeezed each emoji into one cell over its neighbour.
 *
 * Unicode 11, used before, fixed single emoji but still measured an emoji
 * made wide by VS16 (⚠️ ✔️ ❤️) as one cell, and a ZWJ or skin-tone sequence
 * (👨‍💻 👍🏽) as four — 75 of 82 characters measured against Claude Code. The
 * grapheme provider counts a whole cluster as one character: two cells for
 * each of those, as Claude Code does, and 82 of 82 agree
 * (tests/adversarial/unicode_widths.test.js runs them through real xterm).
 *
 * Known limit, measured with zsh 5.9 on macOS: zsh's line editor measures
 * with the C library's `wcwidth`, so to zsh ⚠️ ✔️ ❤️ are ONE cell and 👍🏽 👨‍💻
 * 🇰🇷 are FOUR, where they are two here. One in the PROMPT is enough: a VS16
 * emoji there alone — Starship's default ☁️ or ❄️ — is two cells here and
 * one to zsh, so EVERY command line long enough to wrap sits a cell off from
 * where zsh believes it is. Editing across the wrap then shows the wrong
 * characters — typed past it, deleted back across it and typed again, the
 * screen read `…qrsZ` where the line was `…qrstZ`. A line that holds one of
 * those is drawn off the same way when edited (moving back over it and
 * typing, ⌃A) until zsh redraws it. Only the screen is wrong: zsh's buffer,
 * and what runs, is exactly what was typed. Plain emoji (✅ 🚀) agree.
 * Unicode 11 matched zsh on the VS16 and ZWJ sequences and Claude Code on
 * none of them.
 *
 * `UnicodeGraphemesAddon` is passed in so this stays free of xterm and can be
 * checked in Node. Returns whether grapheme widths are active; never throws —
 * a terminal measuring with the old tables is still a working terminal.
 */
export function activateGraphemeWidths(term, UnicodeGraphemesAddon) {
  try {
    term.loadAddon(new UnicodeGraphemesAddon());
    // The addon switches to its provider as it loads; asked for again, so a
    // version that registers without switching still ends up measuring with it.
    if (term.unicode.activeVersion !== GRAPHEME_WIDTHS) term.unicode.activeVersion = GRAPHEME_WIDTHS;
    return term.unicode.activeVersion === GRAPHEME_WIDTHS;
  } catch (err) {
    console.warn('[Terminal] grapheme widths unavailable, measuring with xterm defaults:', err);
    return false;
  }
}
