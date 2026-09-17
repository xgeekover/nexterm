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
 * The reload chords it is safe to refuse.
 *
 * Measured on the shipped 0.2.3 portable build on Windows: F5 and Ctrl+R do
 * NOT reload (WebView2 already suppresses them) and Ctrl+Shift+R DOES.
 *
 * Deliberately NOT here: a plain Ctrl+R. It is reverse-i-search in bash, zsh
 * and PSReadLine — one of the most-used keys a shell has — and off macOS the
 * app modifier IS Ctrl, so a rule written as "mod+R" would quietly take it
 * away from every pane. It does not reload anyway, so there is nothing to
 * refuse. ⌘R is listed because ⌘ never reaches the shell.
 */
const isReloadChord = (e, ctx) =>
  e.key === 'F5' ||
  ((ctx.isMod || e.ctrlKey) && e.shiftKey && isLetter(e, 'r')) ||
  (e.metaKey && isLetter(e, 'r'));

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
 * - `overTerminal`  claim this chord even while a terminal has focus, ahead of
 *                   xterm — see `dispatchKeydownOverTerminal`. Reserved for
 *                   window chrome; KB-08 keeps ^C, ^D, ^L and friends out.
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
    // ⌘⌥B / Ctrl+Alt+B. `overTerminal` because off macOS this chord reached
    // the window only by accident: xterm's `_isThirdLevelShift` treats
    // Ctrl+Alt as AltGr ON WINDOWS and returns without cancelling, so the
    // event bubbles — while on LINUX no such branch applies, xterm turns the
    // chord into ESC ^B and the side bar never toggles. Claiming it up front
    // makes the three platforms agree on purpose instead of by luck.
    id: 'toggle-secondary',
    overTerminal: true,
    when: (e, ctx) => ctx.isMod && e.altKey && isLetter(e, 'b'),
    run: (e, ctx) => ctx.toggleSecondarySidebar?.(),
  },
  {
    // ⌘B on macOS, where the terminal never sees the app modifier at all. Off
    // macOS the very same rule is Ctrl+B, which xterm turns into ^B and
    // swallows before any window listener runs — so the shortcut the menu
    // advertises did nothing whenever a terminal had focus, which is this
    // app's resting state. `overTerminal` claims it first, as VS Code does.
    //
    // That is the trade, stated plainly: ^B no longer reaches the shell, so a
    // tmux prefix inside a pane has to be rebound. Only window chrome may make
    // this trade — see KB-08, which holds the line for ^C, ^D, ^L and the rest.
    id: 'toggle-sidebar',
    overTerminal: true,
    when: (e, ctx) => ctx.isMod && !e.altKey && isLetter(e, 'b'),
    run: (e, ctx) => ctx.toggleSidebar(),
  },
  {
    id: 'clear-terminal',
    when: (e, ctx) => ctx.isMod && isLetter(e, 'l'),
    run: (e, ctx) => ctx.clearBlocks?.(),
  },
  {
    // Not a feature — a guard, and the only binding whose whole job is to
    // swallow a key.
    //
    // A reload restarts the frontend from nothing, and `bootstrap` reaps every
    // PTY the backend still holds before it spawns anything (see
    // `PtyManager::retain_only`). So one stray Ctrl+Shift+R kills every shell
    // in the window — running builds, ssh sessions, the lot — with no warning
    // and no undo. Nobody reloads a terminal IDE on purpose; the chord is here
    // from the browser, not from the product.
    //
    // `ctx.blockReload` is false in development, where reloading IS the point.
    id: 'reload-guard',
    menuId: null,
    overTerminal: true,
    when: (e, ctx) => Boolean(ctx.blockReload) && isReloadChord(e, ctx),
    run: () => {},
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

/**
 * Run whatever `e` maps to while a TERMINAL has focus. Returns the binding's
 * id when it claimed the key, and null when the terminal keeps it.
 *
 * xterm binds its own keydown on the textarea and calls preventDefault +
 * stopPropagation for every chord it turns into a control byte, so a
 * window-level listener in the bubble phase never sees those at all. Almost
 * always that is right: ^C, ^D and ^L belong to whatever is running in the
 * pane, not to the window around it.
 *
 * The exceptions are the window-chrome chords the menu advertises, which have
 * to work wherever focus happens to be — an advertised shortcut that does
 * nothing is the bug this whole file exists to prevent. They mark themselves
 * `overTerminal`, and this runs from a capture-phase listener, ahead of xterm.
 * Anything not marked is left untouched, still bound for the shell.
 */
export function dispatchKeydownOverTerminal(e, ctx) {
  const binding = findBinding(e, ctx);
  if (!binding?.overTerminal) return null;
  if (binding.preventDefault !== false) e.preventDefault();
  // The point of running in capture: xterm must not also see this and turn it
  // into a control byte.
  e.stopPropagation();
  binding.run(e, ctx);
  return binding.id;
}
