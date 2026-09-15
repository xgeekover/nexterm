/**
 * Every keyboard shortcut the app answers to, as data rather than as a run of
 * `if` statements.
 *
 * The menu advertises a chord next to each command, and for four of them —
 * Open Folder, Settings, Exit and Toggle Terminals Side Bar — nothing anywhere
 * listened for it. Off macOS those menu entries showed a shortcut that did
 * nothing at all; on macOS they happened to work only because the native menu
 * in `src-tauri/src/menu.rs` registers its own accelerators. A label and a
 * handler written in two different shapes, in two different files, drifted
 * apart without anything noticing.
 *
 * Here each binding carries the menu id it serves, so
 * `tests/adversarial/keybinding_table.test.js` can take the chord the menu
 * advertises, build the event a real keypress would produce on each platform,
 * and check that exactly the right binding claims it. A shortcut that is shown
 * but unhandled is now a failing test rather than a quiet disappointment.
 *
 * Pure: no React, no stores, and deliberately no reference to `isMac`. The
 * caller decides whether the app modifier is down (⌘ on macOS, Ctrl
 * elsewhere — see `hasMod`) and passes it in, which is also what lets the
 * tests exercise both platforms in one Node process.
 */

/** True when the event's key is `letter`, whatever the shift state. */
const isLetter = (e, letter) => typeof e.key === 'string' && e.key.toLowerCase() === letter;

/**
 * The bindings, in the order they are tried.
 *
 * Order is deliberately NOT load-bearing: every rule that could overlap
 * another states its own exclusion (`!e.shiftKey` on ⌘D and ⌘W, `!e.altKey`
 * on ⌘B), so ⌘⇧D can never be swallowed by the ⌘D rule no matter how the
 * list is rearranged. KB-10 holds that invariant — exactly one binding may
 * claim any chord the menu advertises — because a rule that relied on sitting
 * above another would break silently the first time someone reordered them.
 *
 * - `when(e, ctx)`  does this chord match?
 * - `passThrough`   matched, but the key belongs to whatever has focus — stop
 *                   looking and do NOT preventDefault (Monaco owns ⌘D and ⌘W
 *                   while the cursor is in a file).
 * - `run(e, ctx)`   perform the action.
 * - `preventDefault: false` for bindings that must not swallow the key.
 */
export const KEYBINDINGS = [
  {
    // ⌘P quick open · ⌘⇧P every command. One chord, two modes, which is why
    // `quick-open` and the palette's "all" mode share a binding.
    id: 'quick-open',
    when: (e, ctx) => ctx.isMod && isLetter(e, 'p'),
    run: (e, ctx) => ctx.setCommandPaletteOpen(true, e.shiftKey ? 'all' : 'files'),
  },
  {
    id: 'command-palette',
    when: (e, ctx) => ctx.isMod && isLetter(e, 'k'),
    run: (e, ctx) => ctx.setCommandPaletteOpen(!ctx.isCommandPaletteOpen),
  },
  {
    id: 'open-folder',
    when: (e, ctx) => ctx.isMod && e.shiftKey && isLetter(e, 'o'),
    run: (e, ctx) => ctx.pickRoot?.(),
  },
  {
    id: 'preferences',
    when: (e, ctx) => ctx.isMod && e.key === ',',
    run: (e, ctx) => ctx.setSettingsModalOpen?.(true),
  },
  {
    id: 'save',
    when: (e, ctx) => ctx.isMod && !e.shiftKey && isLetter(e, 's'),
    run: (e, ctx) => {
      // The key is claimed either way: letting the browser's own Save dialog
      // through when no file is open would be worse than doing nothing.
      if (ctx.activeEditorTabId) ctx.saveFile(ctx.activeEditorTabId);
    },
  },
  {
    id: 'split-down',
    when: (e, ctx) => ctx.isMod && e.shiftKey && isLetter(e, 'd'),
    run: (e, ctx) => ctx.splitActivePane?.('vertical'),
  },
  {
    // Monaco binds ⌘D to "add selection to next find match" — don't fight it.
    id: 'split-right',
    when: (e, ctx) => ctx.isMod && !e.shiftKey && isLetter(e, 'd'),
    passThrough: (e, ctx) => ctx.isInMonacoEditor,
    run: (e, ctx) => ctx.splitActivePane?.('horizontal'),
  },
  {
    id: 'close-window',
    when: (e, ctx) => ctx.isMod && e.shiftKey && isLetter(e, 'w'),
    run: (e, ctx) => ctx.closeWindow?.(),
  },
  {
    id: 'close-pane',
    when: (e, ctx) => ctx.isMod && !e.shiftKey && isLetter(e, 'w'),
    passThrough: (e, ctx) => ctx.isInMonacoEditor,
    run: (e, ctx) => ctx.closeActivePane?.(),
  },
  {
    // ⌥⌘→ / ⌥⌘← — not in the menu, so it has no menu id of its own.
    id: 'focus-pane',
    menuId: null,
    when: (e, ctx) => ctx.isMod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'),
    run: (e, ctx) => ctx.focusNextPane?.(e.key === 'ArrowRight' ? 1 : -1),
  },
  {
    // Literal Ctrl on every platform, and checked before plain ⌃` — `e.code`
    // avoids the US-layout ambiguity where shift+backtick reports key '~'.
    id: 'new-terminal',
    when: (e) => e.ctrlKey && e.shiftKey && e.code === 'Backquote',
    run: (e, ctx) => ctx.createTerminalTab?.(),
  },
  {
    id: 'toggle-panel',
    when: (e) => e.ctrlKey && !e.shiftKey && e.code === 'Backquote',
    run: (e, ctx) => ctx.togglePanel(),
  },
  {
    id: 'toggle-secondary',
    when: (e, ctx) => ctx.isMod && e.altKey && isLetter(e, 'b'),
    run: (e, ctx) => ctx.toggleSecondarySidebar?.(),
  },
  {
    id: 'toggle-sidebar',
    when: (e, ctx) => ctx.isMod && !e.altKey && isLetter(e, 'b'),
    run: (e, ctx) => ctx.toggleSidebar(),
  },
  {
    id: 'clear-terminal',
    when: (e, ctx) => ctx.isMod && isLetter(e, 'l'),
    run: (e, ctx) => ctx.clearBlocks?.(),
  },
  {
    // Escape belongs to whatever is on screen; closing the palette must not
    // stop a dialog or an inline input from seeing it too.
    id: 'escape',
    menuId: null,
    preventDefault: false,
    when: (e) => e.key === 'Escape',
    run: (e, ctx) => {
      if (ctx.isCommandPaletteOpen) ctx.setCommandPaletteOpen(false);
    },
  },
];

/** The menu item id a binding serves, or null when it has no menu entry. */
export function menuIdOf(binding) {
  return binding.menuId === undefined ? binding.id : binding.menuId;
}

/** The binding that claims `e`, or null. Does not run anything. */
export function findBinding(e, ctx) {
  return KEYBINDINGS.find((binding) => binding.when(e, ctx)) || null;
}

/**
 * Run whatever `e` maps to. Returns the binding's id when it acted, the id
 * prefixed with `pass:` when it deliberately let the key through, and null
 * when nothing claimed it.
 */
export function dispatchKeydown(e, ctx) {
  const binding = findBinding(e, ctx);
  if (!binding) return null;
  if (binding.passThrough?.(e, ctx)) return `pass:${binding.id}`;
  if (binding.preventDefault !== false) e.preventDefault();
  binding.run(e, ctx);
  return binding.id;
}
