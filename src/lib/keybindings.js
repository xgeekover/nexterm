/**
 * What the keyboard can do, and which keys currently do it.
 *
 * Those are two separate things now, as they are in VS Code:
 *
 *   COMMANDS             what a command IS — its title and what running it
 *                        does. Fixed; a user cannot invent one.
 *   DEFAULT_KEYBINDINGS  which chord runs it out of the box. Data, and the
 *                        thing a user may override.
 *
 * They used to be one list of predicates — `(e, ctx) => ctx.isMod &&
 * !e.shiftKey && isLetter(e, 'd')` — which cannot be written down, shown in a
 * settings window, or changed by anyone who is not editing this file.
 *
 * Chords match EXACTLY (see src/lib/chords.js), so `mod+d` no longer needs to
 * say "and not shift" to stay out of `mod+shift+d`'s way. That also means
 * every chord a command answers to is listed rather than hidden inside a
 * predicate: quick open and "all commands" were one entry that read
 * `e.shiftKey` at run time, and are two entries here.
 */

import { chordMatches, displayChord, parseChord } from './chords.js';

/**
 * Every command, by id. The ids match `src-tauri/src/menu.rs` and
 * `src/lib/menuActions.js`, so the menu and the keyboard cannot drift apart.
 *
 * - `title`        what the settings window calls it.
 * - `run(ctx)`     do it.
 * - `overTerminal` claim the chord even while a terminal has focus, ahead of
 *                  xterm — see `dispatchKeydownOverTerminal`. Reserved for
 *                  window chrome; KB-08 and KB-12 keep ^C, ^D, ^L and the rest
 *                  out of it.
 * - `passThrough`  matched, but the key belongs to whatever has focus: stop
 *                  looking and do NOT preventDefault.
 * - `preventDefault: false` for commands that must not swallow the key.
 * - `configurable: false` for the two that are not shortcuts anyone chooses.
 */
export const COMMANDS = {
  'quick-open': {
    title: 'Go to File…',
    run: (ctx) => ctx.setCommandPaletteOpen(true, 'files'),
  },
  'all-commands': {
    title: 'Show All Commands',
    menuId: null,
    run: (ctx) => ctx.setCommandPaletteOpen(true, 'all'),
  },
  'command-palette': {
    title: 'Command Palette',
    run: (ctx) => ctx.setCommandPaletteOpen(!ctx.isCommandPaletteOpen),
  },
  'open-folder': {
    title: 'Open Folder…',
    run: (ctx) => ctx.pickRoot?.(),
  },
  preferences: {
    title: 'Settings',
    run: (ctx) => ctx.setSettingsModalOpen?.(true),
  },
  save: {
    title: 'Save File',
    run: (ctx) => {
      // The key is claimed either way: letting the browser's own Save dialog
      // through when no file is open would be worse than doing nothing.
      if (ctx.activeEditorTabId) ctx.saveFile(ctx.activeEditorTabId);
    },
  },
  'split-down': {
    title: 'Split Pane Down',
    run: (ctx) => ctx.splitActivePane?.('vertical'),
  },
  'split-right': {
    title: 'Split Pane Right',
    // Monaco binds this to "add selection to next find match" — don't fight it.
    passThrough: (ctx) => ctx.isInMonacoEditor,
    run: (ctx) => ctx.splitActivePane?.('horizontal'),
  },
  'close-window': {
    title: 'Close Window',
    run: (ctx) => ctx.closeWindow?.(),
  },
  'close-pane': {
    title: 'Close Pane',
    passThrough: (ctx) => ctx.isInMonacoEditor,
    run: (ctx) => ctx.closeActivePane?.(),
  },
  'focus-next-pane': {
    title: 'Focus Next Pane',
    menuId: null,
    run: (ctx) => ctx.focusNextPane?.(1),
  },
  'focus-previous-pane': {
    title: 'Focus Previous Pane',
    menuId: null,
    run: (ctx) => ctx.focusNextPane?.(-1),
  },
  'new-terminal': {
    title: 'New Terminal',
    run: (ctx) => ctx.createTerminalTab?.(),
  },
  'toggle-panel': {
    title: 'Toggle Terminal Panel',
    run: (ctx) => ctx.togglePanel(),
  },
  'toggle-secondary': {
    title: 'Toggle Terminals Side Bar',
    // Off macOS this chord reached the window only by accident: xterm's
    // `_isThirdLevelShift` treats Ctrl+Alt as AltGr ON WINDOWS and returns
    // without cancelling, so the event bubbles — while on LINUX no such branch
    // applies, xterm turns the chord into ESC ^B and the side bar never
    // toggles. Claiming it up front makes the three platforms agree on purpose
    // instead of by luck.
    overTerminal: true,
    run: (ctx) => ctx.toggleSecondarySidebar?.(),
  },
  'toggle-sidebar': {
    title: 'Toggle Primary Side Bar',
    // On macOS the terminal never sees the app modifier at all. Off macOS the
    // same chord is Ctrl+B, which xterm turns into ^B and swallows before any
    // window listener runs — so the shortcut the menu advertises did nothing
    // whenever a terminal had focus, which is this app's resting state.
    // `overTerminal` claims it first, as VS Code does.
    //
    // That is the trade, stated plainly: ^B no longer reaches the shell, so a
    // tmux prefix inside a pane has to be rebound — or this shortcut rebound
    // instead, which is now something a user can do in Settings.
    overTerminal: true,
    run: (ctx) => ctx.toggleSidebar(),
  },
  'clear-terminal': {
    title: 'Clear Unpinned Blocks',
    run: (ctx) => ctx.clearBlocks?.(),
  },
  'command-history': {
    title: 'Command History',
    // Deliberately NOT Ctrl+R. That is reverse-i-search in bash, zsh and
    // PSReadLine, KB-12 names it as a key that must reach the shell, and a
    // history palette that costs you the shell's own history search is a bad
    // trade whichever way you look at it.
    overTerminal: true,
    run: (ctx) => ctx.setCommandPaletteOpen(true, 'history'),
  },
  'find-in-terminal': {
    title: 'Find in Terminal',
    // The scrollback is 5000 lines deep, and a find bar that stops working the
    // moment a terminal has focus would never work at all — focus on a
    // terminal IS this app's resting state. So it is claimed ahead of xterm,
    // like the side bar toggle above.
    //
    // The trade, stated plainly: off macOS `mod` is Ctrl, so Ctrl+F no longer
    // reaches readline as forward-char. VS Code makes the same trade with the
    // same key, the arrow keys do the same job, and this is one of the
    // shortcuts a user can now change in Settings. On macOS nothing is given
    // up — ⌘ never reaches the pty.
    overTerminal: true,
    run: (ctx) => ctx.openFind?.(),
  },
  'zoom-in': {
    title: 'Zoom In',
    overTerminal: true,
    run: (ctx) => ctx.zoomFont?.(1),
  },
  'zoom-out': {
    title: 'Zoom Out',
    overTerminal: true,
    run: (ctx) => ctx.zoomFont?.(-1),
  },
  'zoom-reset': {
    title: 'Reset Zoom',
    overTerminal: true,
    run: (ctx) => ctx.resetZoom?.(),
  },
  'reload-guard': {
    title: 'Block reload',
    menuId: null,
    // Not a feature — a guard, and the only command whose whole job is to
    // swallow a key.
    //
    // A reload restarts the frontend from nothing, and `bootstrap` reaps every
    // PTY the backend still holds before it spawns anything (see
    // `PtyManager::retain_only`). So one stray Ctrl+Shift+R kills every shell
    // in the window — running builds, ssh sessions, the lot — with no warning
    // and no undo. Nobody reloads a terminal IDE on purpose; the chord is here
    // from the browser, not from the product.
    //
    // Not configurable: rebinding a guard is not a thing anyone wants, and
    // whether it applies is decided by `ctx.blockReload`, which is false in
    // development where reloading IS the point.
    configurable: false,
    overTerminal: true,
    enabled: (ctx) => Boolean(ctx.blockReload),
    run: () => {},
  },
  escape: {
    title: 'Dismiss',
    menuId: null,
    // Escape belongs to whatever is on screen; closing the palette must not
    // stop a dialog or an inline input from seeing it too.
    configurable: false,
    preventDefault: false,
    run: (ctx) => {
      if (ctx.isCommandPaletteOpen) ctx.setCommandPaletteOpen(false);
    },
  },
};

/**
 * The chords each command answers to out of the box.
 *
 * Order decides nothing — every chord matches exactly, and `findConflicts`
 * refuses two commands on one chord — but reading order is kept roughly menu
 * order.
 */
export const DEFAULT_KEYBINDINGS = [
  { command: 'quick-open', key: 'mod+p' },
  { command: 'all-commands', key: 'mod+shift+p' },
  { command: 'command-palette', key: 'mod+k' },
  { command: 'open-folder', key: 'mod+shift+o' },
  { command: 'preferences', key: 'mod+comma' },
  { command: 'save', key: 'mod+s' },
  { command: 'split-down', key: 'mod+shift+d' },
  { command: 'split-right', key: 'mod+d' },
  { command: 'close-window', key: 'mod+shift+w' },
  { command: 'close-pane', key: 'mod+w' },
  { command: 'focus-next-pane', key: 'mod+alt+right' },
  { command: 'focus-previous-pane', key: 'mod+alt+left' },
  // Literal Ctrl on every platform, and matched on `code` because shift plus
  // backtick reports `~` on a US layout.
  { command: 'new-terminal', key: 'ctrl+shift+backquote' },
  { command: 'toggle-panel', key: 'ctrl+backquote' },
  { command: 'toggle-secondary', key: 'mod+alt+b' },
  { command: 'toggle-sidebar', key: 'mod+b' },
  { command: 'clear-terminal', key: 'mod+l' },
  { command: 'command-history', key: 'mod+shift+h' },
  { command: 'find-in-terminal', key: 'mod+f' },
  // Two spellings of "bigger", because `+` is the shifted `=` on most layouts
  // and people press whichever they think of. The menu shows the first.
  { command: 'zoom-in', key: 'mod+equal' },
  { command: 'zoom-in', key: 'mod+shift+equal' },
  { command: 'zoom-out', key: 'mod+minus' },
  { command: 'zoom-reset', key: 'mod+0' },
  // The guard's several spellings of "reload". `mod+r` is deliberately absent:
  // off macOS that is Ctrl+R, which is reverse-i-search in every shell.
  { command: 'reload-guard', key: 'f5' },
  { command: 'reload-guard', key: 'mod+shift+r' },
  { command: 'reload-guard', key: 'ctrl+shift+r' },
  { command: 'reload-guard', key: 'cmd+r' },
  { command: 'reload-guard', key: 'cmd+shift+r' },
  { command: 'escape', key: 'escape' },
];

/** Commands a user may rebind — everything but the two that are not choices. */
export function configurableCommands() {
  return Object.entries(COMMANDS)
    .filter(([, cmd]) => cmd.configurable !== false)
    .map(([id, cmd]) => ({ id, title: cmd.title }));
}

/**
 * Turn the defaults plus a user's overrides into the list actually in force.
 *
 * `overrides` is `{ [commandId]: string | string[] | null }` — one chord,
 * several, or null to unbind the command entirely. An unknown command id or an
 * unparseable chord is dropped WITH A REASON rather than throwing: this is user
 * input, and one bad entry must not cost the user every other shortcut.
 *
 * Returns `{ bindings, problems }`. Nothing here reads a store, so the settings
 * window can resolve a candidate and show its conflicts before saving anything.
 */
export function resolveKeybindings(overrides = {}) {
  const problems = [];
  const byCommand = new Map();

  for (const entry of DEFAULT_KEYBINDINGS) {
    if (!byCommand.has(entry.command)) byCommand.set(entry.command, []);
    byCommand.get(entry.command).push(entry.key);
  }

  for (const [command, value] of Object.entries(overrides || {})) {
    const spec = COMMANDS[command];
    if (!spec) {
      problems.push({ command, reason: 'no such command' });
      continue;
    }
    if (spec.configurable === false) {
      problems.push({ command, reason: 'this one cannot be rebound' });
      continue;
    }
    if (value === null) {
      byCommand.set(command, []);
      continue;
    }
    const keys = (Array.isArray(value) ? value : [value]).filter((k) => typeof k === 'string');
    const usable = [];
    for (const key of keys) {
      if (parseChord(key)) usable.push(key);
      else problems.push({ command, key, reason: 'not a chord' });
    }
    byCommand.set(command, usable);
  }

  const bindings = [];
  for (const [command, keys] of byCommand) {
    for (const key of keys) {
      const chord = parseChord(key);
      if (chord) bindings.push({ command, key, chord });
    }
  }
  return { bindings, problems };
}

/**
 * Chords claimed by more than one command.
 *
 * Reported rather than resolved: letting whichever came first win is how a
 * shortcut silently changes meaning when an unrelated line moves.
 */
export function findConflicts(bindings) {
  const seen = new Map();
  const conflicts = [];
  for (const binding of bindings) {
    const existing = seen.get(binding.key);
    if (existing && existing !== binding.command) {
      conflicts.push({ key: binding.key, commands: [existing, binding.command] });
    } else if (!existing) {
      seen.set(binding.key, binding.command);
    }
  }
  return conflicts;
}

/** The bindings in force when nobody has overridden anything. */
export const DEFAULT_RESOLVED = resolveKeybindings({}).bindings;

/** The binding `e` presses, or null. Runs nothing. */
export function findBinding(e, ctx) {
  const bindings = ctx?.bindings ?? DEFAULT_RESOLVED;
  for (const binding of bindings) {
    if (!chordMatches(binding.chord, e, ctx?.isMod)) continue;
    const spec = COMMANDS[binding.command];
    if (!spec) continue;
    if (spec.enabled && !spec.enabled(ctx)) continue;
    return { ...binding, spec, id: binding.command };
  }
  return null;
}

/**
 * Run whatever `e` maps to. Returns the command id when it acted, the id
 * prefixed with `pass:` when it deliberately let the key through, and null
 * when nothing claimed it.
 */
export function dispatchKeydown(e, ctx) {
  const binding = findBinding(e, ctx);
  if (!binding) return null;
  const { spec } = binding;
  if (spec.passThrough?.(ctx)) return `pass:${binding.command}`;
  if (spec.preventDefault !== false) e.preventDefault();
  spec.run(ctx);
  return binding.command;
}

/**
 * The same, for the capture-phase listener that runs while a terminal has
 * focus.
 *
 * A chord the terminal needs belongs to the terminal — xterm turns ^C, ^D and
 * ^L into control bytes and the app must not take them. The exceptions are the
 * window-chrome chords the menu advertises, which have to work wherever focus
 * happens to be; they mark themselves `overTerminal`, and this runs ahead of
 * xterm. Anything not marked is left untouched, still bound for the shell.
 */
export function dispatchKeydownOverTerminal(e, ctx) {
  const binding = findBinding(e, ctx);
  if (!binding?.spec?.overTerminal) return null;
  if (binding.spec.preventDefault !== false) e.preventDefault();
  // The point of running in capture: xterm must not also see this and turn it
  // into a control byte.
  e.stopPropagation();
  binding.spec.run(ctx);
  return binding.command;
}

/** The menu item id a command serves, or null when it has no menu entry. */
export function menuIdOf(binding) {
  const id = binding?.command ?? binding?.id ?? binding;
  const spec = binding?.spec ?? COMMANDS[id];
  if (!spec) return null;
  return spec.menuId === undefined ? id : spec.menuId;
}

/** Every chord in force for a command, for a menu label or a settings row. */
export function keysFor(command, bindings = DEFAULT_RESOLVED) {
  return bindings.filter((b) => b.command === command).map((b) => b.key);
}

/**
 * How a command's shortcut should be written where it is advertised — a menu
 * row, a palette entry — or '' when the user has unbound it.
 *
 * The first chord, because there is one place to print it and an OS menu item
 * carries one key equivalent. `isMac` is an argument rather than read from
 * `navigator` so this file stays testable on both platforms at once.
 */
export function shortcutLabel(command, bindings = DEFAULT_RESOLVED, { isMac = false } = {}) {
  const key = keysFor(command, bindings)[0];
  return key ? displayChord(key, { isMac }) : '';
}
