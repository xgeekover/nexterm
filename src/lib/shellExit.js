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

/** The lines a terminal shows when its shell has exited, as xterm writes them. */
export function exitNotice(code) {
  const described = describeExitCode(code);
  return (
    `\r\n\x1b[90m[process exited${described === null ? '' : ` with code ${described}`}]\x1b[0m` +
    `\r\n\x1b[90mPress Enter to start a new shell in this terminal.\x1b[0m\r\n`
  );
}

/**
 * Whether a failed write says the shell's session is gone — the backend's
 * own words (src-tauri/src/pty/manager.rs `write`). The write can arrive
 * before the exit event does; it means the same thing.
 */
export function sessionIsGone(message) {
  return typeof message === 'string' && /^PTY session (not found|is closed|is no longer accepting input)\b/.test(message);
}
