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
 * 🇰🇷 are FOUR. Editing a command line that holds one of those — moving back
 * over it and typing, ⌃A, a line long enough to wrap — is drawn a cell or more
 * off (a stray blank, characters overwritten) until zsh redraws the line;
 * what runs is still exactly what was typed. Plain emoji (✅ 🚀) agree. Unicode
 * 11 matched zsh on the VS16 and ZWJ sequences and Claude Code on none of them.
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
