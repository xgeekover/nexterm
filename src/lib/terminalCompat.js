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
