/**
 * macOS text-editing keys in a terminal (bundle 2, A6): ⌘← and ⌘→ go to the
 * start and the end of the line, ⌘Backspace deletes to its start and
 * ⌘Forward-Delete to its end, as they do in every macOS text field and in
 * iTerm2's "Natural Text Editing" preset. xterm sends nothing for ⌘← and ⌘→,
 * so without this they did nothing at a shell prompt.
 *
 * Each key is sent as the control character a line editor already reads for
 * it — readline, zle, fish, and the tty itself in canonical mode:
 *
 *   ⌘←               Ctrl+A  0x01  beginning of line
 *   ⌘→               Ctrl+E  0x05  end of line
 *   ⌘Backspace       Ctrl+U  0x15  kill to the start of the line
 *   ⌘Forward-Delete  Ctrl+K  0x0b  kill to the end of the line
 *
 * Only where those bytes mean that:
 *
 *   - macOS only, and only while Settings ▸ Terminal ▸ macOS Text-Editing
 *     Keys (`terminalMacEditingKeys`, on by default) is on. Windows and
 *     Linux have no ⌘ for a terminal key, and their keys are unchanged.
 *   - ⌘ alone: with Ctrl, ⌥ or Shift as well it is someone else's chord
 *     (⌘⌥← is the app's focus-previous-pane), and a key an IME is composing
 *     is the IME's.
 *   - The normal screen only. On the alternate screen — vim, htop, less, a
 *     full-screen TUI — the key is left to xterm exactly as before: there
 *     Ctrl+A or Ctrl+U is a command of that program's, not "start of line".
 *   - Not once the program has turned modifyOtherKeys on (its level above 0,
 *     src/lib/modifyOtherKeys.js): such a program reads its keys itself.
 *     xterm.js 6.0 does not implement the kitty keyboard protocol and NexTerm
 *     does not track it, so there is no flag of that protocol to yield to.
 *   - While a password prompt is up (`typingHidden`, src/lib/secretInput.js)
 *     only ⌘Backspace is sent. Ctrl+U is the tty's own kill-line in
 *     canonical mode and erases what was typed of the secret; Ctrl+A, Ctrl+E
 *     and Ctrl+K are plain bytes there and would become part of the password,
 *     so those keys stay xterm's (which sends nothing for ⌘← and ⌘→).
 *
 * Pure: TerminalView's key handler hands it the event and what it reads of
 * the terminal and the settings, and sends what comes back with
 * `term.input(sequence, true)`, cancelling the key as it does for ⌥←/→.
 */

/** What each key sends, by `KeyboardEvent.key`. */
export const MAC_EDITING_KEY_SEQUENCES = Object.freeze({
  ArrowLeft: '\x01',
  ArrowRight: '\x05',
  Backspace: '\x15',
  Delete: '\x0b',
});

/** The same keys by `keyCode`, for an event that has no `key`. */
const KEY_BY_CODE = Object.freeze({ 37: 'ArrowLeft', 39: 'ArrowRight', 8: 'Backspace', 46: 'Delete' });

/** The one key still sent while a password prompt is up: the tty's own kill-line. */
const SECRET_SAFE_KEY = 'Backspace';

/**
 * The byte a keydown sends as a macOS editing key, or null when the key is
 * left to xterm.
 *
 * @param {KeyboardEvent} event
 * @param {object} context
 * @param {boolean} context.mac                  running on macOS
 * @param {boolean} context.enabled              `terminalMacEditingKeys`
 * @param {boolean} context.alternate            the terminal shows its alternate screen
 * @param {number}  context.modifyOtherKeysLevel the level the program asked for, 0 when none
 * @param {boolean} context.secret               a password prompt is up (`typingHidden`)
 * @returns {string|null}
 */
export function macEditingKeySequence(
  event,
  { mac = false, enabled = true, alternate = false, modifyOtherKeysLevel = 0, secret = false } = {}
) {
  if (!mac || enabled !== true) return null;
  if (!event || event.type !== 'keydown') return null;
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (alternate) return null;
  if ((modifyOtherKeysLevel ?? 0) !== 0) return null;
  const key = Object.hasOwn(MAC_EDITING_KEY_SEQUENCES, event.key) ? event.key : KEY_BY_CODE[event.keyCode];
  if (!key) return null;
  if (secret && key !== SECRET_SAFE_KEY) return null;
  return MAC_EDITING_KEY_SEQUENCES[key];
}
