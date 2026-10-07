/**
 * What a terminal says when its shell is gone, and how it comes back.
 *
 * Reported from Windows (2026-10-07): quitting OpenCode with Ctrl+C in cmd
 * sometimes left a terminal where every key printed "[NexTerm] PTY session
 * not found: pty-5" and nothing could be typed. The backend drops a session
 * only once its shell has ended, so cmd itself had exited. Why is not known
 * yet: cmd runs OpenCode through npm's `opencode.cmd`, so a second Ctrl+C can
 * reach cmd while it asks "Terminate batch job (Y/N)?", and a process ended
 * by Ctrl+C reports STATUS_CONTROL_C_EXIT (0xC000013A) — which is why the
 * notice now names that code. The one "[process exited]" line was easy to
 * miss, and every keystroke after it went to a session that no longer
 * existed, each failure printed in turn.
 *
 * So a terminal whose shell has exited says so once, with the code in the
 * form Windows documents it, and takes Enter to start a new shell in its
 * place — what Windows Terminal does ("press Enter to restart"). Other keys
 * go nowhere and say nothing.
 */

/** STATUS_CONTROL_C_EXIT: what Windows reports for a process ended by Ctrl+C. */
export const CTRL_C_EXIT = 0xc000013a;

/** The keys that start a new shell in a terminal whose shell has exited. */
export function restartsShell(data) {
  return data === '\r' || data === '\n' || data === '\r\n';
}

/**
 * An exit code as a person can look it up: the number, then — for the
 * NTSTATUS values Windows uses for crashes and Ctrl+C, which only read as
 * codes in hex — `0xC000013A`, and what that one means. Null when there is
 * no code (cmd never reports one for a command; a session can end without).
 * A negative code (PowerShell reports NTSTATUS signed) reads as the same
 * unsigned value.
 */
export function describeExitCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code) || !Number.isInteger(code)) return null;
  const unsigned = code >>> 0;
  if (unsigned < 0x80000000) return String(code);
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
  return unsigned === CTRL_C_EXIT ? `${unsigned} (${hex}, ended by Ctrl+C)` : `${unsigned} (${hex})`;
}

/**
 * What a program switches on and only it switches off again, switched off:
 * mouse reporting, synchronized output, modifyOtherKeys, and — through a soft
 * reset (DECSTR) — a hidden cursor, application cursor keys and keypad,
 * bracketed paste, focus reports, a scroll region, insert mode and colours.
 * A program that dies with its shell never switches them off, and a terminal
 * that kept them took every drag as a mouse report instead of a selection and
 * every Shift+Enter as `CSI 27;2;13~`. The screen itself is left as it is.
 */
export const PROGRAM_MODES_OFF = '\x1b[?1000l\x1b[?1006l\x1b[?2026l\x1b[>4m\x1b[!p';

/**
 * What a terminal is written when its shell has exited, as xterm takes it:
 * the modes its last program left switched off, then the lines that say so.
 */
export function exitNotice(code) {
  const described = describeExitCode(code);
  return (
    PROGRAM_MODES_OFF +
    `\r\n\x1b[90m[process exited${described === null ? '' : ` with code ${described}`}]\x1b[0m` +
    `\r\n\x1b[90mPress Enter to start a new shell in this terminal.\x1b[0m\r\n`
  );
}

/**
 * What a terminal is written before a new shell's first output, when it
 * showed another shell before (Enter after an exit; a restore).
 *
 * Back on the normal screen, its cursor where it was before the program that
 * took the alternate one — `ESC 7` first, so that on the normal screen
 * already it stays put — and every mode a program set switched off: the new
 * shell would otherwise have drawn on the dead program's alternate screen,
 * with no scrollback, and sent its clicks as mouse reports.
 *
 * Then everything down to the cursor row goes up into the scrollback (a line
 * feed per row from wherever the cursor is), leaving the cursor at the top of
 * an empty screen. That is where a new pseudoconsole takes it to be: the
 * backend answers ConPTY's startup query with the origin
 * (src-tauri/src/pty/startup_query.rs), true only of an empty terminal, and
 * ConPTY places what it draws from there — over the old screen, in a
 * terminal that still showed one.
 */
export function freshScreen(rows) {
  const lines = Number.isInteger(rows) && rows > 0 ? rows : 24;
  return `\x1b7\x1b[?1049l${PROGRAM_MODES_OFF}${'\n'.repeat(lines)}\x1b[H\x1b[J`;
}

/** `"120x40"`, the size a terminal last told its PTY, as `{ cols, rows }`; null for anything else. */
export function parseSize(key) {
  const match = typeof key === 'string' ? /^(\d{1,4})x(\d{1,4})$/.exec(key) : null;
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols > 0 && rows > 0 ? { cols, rows } : null;
}

/**
 * Whether a failed write says the shell's session is gone — the backend's
 * own words (src-tauri/src/pty/manager.rs `write`). The write can arrive
 * before the exit event does; it means the same thing.
 */
export function sessionIsGone(message) {
  return typeof message === 'string' && /^PTY session (not found|is closed|is no longer accepting input)\b/.test(message);
}
