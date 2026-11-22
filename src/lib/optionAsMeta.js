/**
 * Option as Meta (bundle 2, A7): on macOS, Settings ▸ Terminal ▸ *Use Option
 * as Meta* (`terminalOptionAsMeta`, off by default) turns on xterm's
 * `macOptionIsMeta`, so ⌥ and a key send Esc and that key — `⌥B` and `⌥F`
 * move a word in zsh and bash, `⌥.` inserts the last argument, and Emacs
 * gets its Meta — instead of the character the keyboard layout puts there.
 *
 * The trade, stated in the setting's row: with it on, ⌥ no longer types
 * ⌥-characters (™, €, and on many non-US layouts @ [ ] { } | ~) and no
 * longer starts dead keys (⌥E then E for é). Both ⌥ keys act alike; there is
 * no left/right split.
 *
 * What it leaves alone:
 *
 *   - The ⌥ mouse-select override (⌥-drag selects over a program that has the
 *     mouse) is a mouse modifier, xterm's `macOptionClickForcesSelection`
 *     (src/lib/terminalClipboard.js, src/lib/mouseReporting.js), not a key.
 *   - ⌥Enter sends Esc Enter either way: xterm sends it so with or without
 *     the option, and src/lib/modifyOtherKeys.js leaves it to xterm.
 *   - ⌥← and ⌥→ keep NexTerm's own Esc b / Esc f (`legacyAltArrowSequence`,
 *     src/lib/terminalCompat.js), which TerminalView sends before xterm sees
 *     the key.
 *
 * Off macOS there is no such setting: xterm already sends Alt as Meta there,
 * and `macOptionIsMeta` means nothing to it.
 */

/**
 * The `macOptionIsMeta` a terminal gets for a settings state: the setting on
 * macOS, false everywhere else and for anything but a `true`.
 *
 * @param {object} state  the settings store's state (or anything with `terminalOptionAsMeta`)
 * @param {object} options
 * @param {boolean} options.mac  running on macOS
 * @returns {boolean}
 */
export function macOptionIsMetaFor(state, { mac = false } = {}) {
  return mac === true && state?.terminalOptionAsMeta === true;
}
