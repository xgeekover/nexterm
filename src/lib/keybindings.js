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

import { chordFromEvent, chordMatches, displayChord, parseChord, stringifyChord } from './chords.js';

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
 *                  looking and do NOT preventDefault. Receives the binding as
 *                  well as the context, because a command bound to more than
 *                  one chord may need to yield only one of them.
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
  'open-recent': {
    title: 'Open Recent…',
    run: (ctx) => ctx.setCommandPaletteOpen(true, 'recent'),
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
    // Monaco binds ⌘D to "add selection to next find match" — don't fight it.
    // Only that spelling, though: Ctrl+Alt+D means nothing to Monaco, so
    // stepping aside for it would leave the shortcut dead in the editor on the
    // very platforms it exists for.
    passThrough: (ctx, binding) => ctx.isInMonacoEditor && Boolean(binding?.chord?.cmd),
    // Splitting a terminal pane while a terminal has focus is the whole point
    // of the command, and neither spelling costs the shell a control byte —
    // ⌘ never reaches the pty, and Ctrl+Alt+D is not a bare Ctrl+letter. Left
    // unclaimed, xterm would turn Alt+D into the `ESC d` that deletes a word.
    overTerminal: true,
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
  'toggle-pane-zoom': {
    title: 'Toggle Pane Zoom',
    // ⌘⇧Enter is Monaco's "Insert Line Above" — the editor keeps it, as it
    // keeps ⌘D. Ctrl+Shift+Enter means nothing to Monaco, but there is one
    // binding per chord here, so the mod spelling steps aside in both.
    passThrough: (ctx) => ctx.isInMonacoEditor,
    // Zooming the pane a terminal is in is the whole point of the command,
    // and a focused terminal is this app's resting state. Neither spelling
    // takes a control byte: ⌘ never reaches the pty, and xterm sends
    // Ctrl+Shift+Enter as a plain `\r`, the Enter key. The one thing given
    // up: a program that turned on modifyOtherKeys — OpenCode — would have
    // got `CSI 27;6;13~` for Ctrl+Shift+Enter off macOS, and binds nothing
    // to it. KB-11 holds the list.
    overTerminal: true,
    run: (ctx) => ctx.togglePaneZoom?.(),
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
  'search-in-files': {
    title: 'Search in Files',
    // The terminal has no use for ⇧⌘F, and off macOS Ctrl+Shift+F is not a
    // bare Ctrl+letter, so the window may claim it everywhere.
    overTerminal: true,
    run: (ctx) => ctx.showView?.('search'),
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
 * Order decides nothing here — no two commands share a keypress, which
 * CK-06 holds on both platforms — but reading order is kept roughly menu
 * order. Once a user binds one keypress twice, the binding listed first runs;
 * `findConflicts` says which.
 */
export const DEFAULT_KEYBINDINGS = [
  { command: 'quick-open', key: 'mod+p' },
  { command: 'all-commands', key: 'mod+shift+p' },
  { command: 'command-palette', key: 'mod+k' },
  { command: 'open-folder', key: 'mod+shift+o' },
  // Next to Open Folder, and nothing in a shell wants ⌥⌘O / Ctrl+Alt+O.
  { command: 'open-recent', key: 'mod+alt+o' },
  { command: 'preferences', key: 'mod+comma' },
  { command: 'save', key: 'mod+s' },
  { command: 'split-down', key: 'mod+shift+d' },
  // Two spellings, because ⌘D is fine and Ctrl+D is not. ⌘ collides with
  // nothing in a pty, and on macOS the native menu owns the key anyway (see
  // `terminal_safe` in menu.rs), so it stays. Off macOS `mod` IS Ctrl, and
  // Ctrl+D is EOF: the menu advertised it, and pressing it with a terminal
  // focused — the ordinary state in a terminal app — ended the shell instead
  // of splitting the pane. Ctrl+Alt+D is the choice `open-recent` already
  // made one line up: nothing in a shell wants it.
  //
  // macOS first, and `shortcutLabel` skips the ⌘ spelling off macOS, so each
  // platform prints the chord it can actually press.
  { command: 'split-right', key: 'cmd+d' },
  { command: 'split-right', key: 'ctrl+alt+d' },
  { command: 'close-window', key: 'mod+shift+w' },
  { command: 'close-pane', key: 'mod+w' },
  { command: 'focus-next-pane', key: 'mod+alt+right' },
  { command: 'focus-previous-pane', key: 'mod+alt+left' },
  // iTerm2's own chord for "Maximize Active Pane" (⌘⇧Enter), and Ctrl+Shift+
  // Enter off macOS, where nothing in a shell reads it: xterm sends it as the
  // Enter key. tmux's `Prefix z` is a prefix NexTerm does not have.
  { command: 'toggle-pane-zoom', key: 'mod+shift+enter' },
  // Literal Ctrl on every platform, and matched on `code` because shift plus
  // backtick reports `~` on a US layout.
  { command: 'new-terminal', key: 'ctrl+shift+backquote' },
  { command: 'toggle-panel', key: 'ctrl+backquote' },
  { command: 'toggle-secondary', key: 'mod+alt+b' },
  { command: 'toggle-sidebar', key: 'mod+b' },
  { command: 'clear-terminal', key: 'mod+l' },
  { command: 'search-in-files', key: 'mod+shift+f' },
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
 * The rebindable commands whose keys a focused terminal never sees, because
 * they are claimed ahead of it (`overTerminal`). Read from the flags, so what
 * Settings tells someone hunting for a key their shell lost is what the code
 * does.
 */
export function commandsOverTerminal() {
  return configurableCommands().filter(({ id }) => COMMANDS[id].overTerminal);
}

/** Keys that only modify the next one, or are an input method at work. */
const NOT_A_KEY_YET = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'Dead', 'Process']);

/**
 * What the shortcut recorder in Settings does with a keydown:
 *
 *   { action: 'cancel' }          Escape: stop recording, bind nothing
 *   { action: 'leave' }           Tab or Shift+Tab: focus moves on as it
 *                                 always does, which ends the recording
 *   { action: 'wait' }            only a modifier so far, or an IME composing
 *   { action: 'refuse', reason }  no shortcut is made of that; say why
 *   { action: 'bind', key }       the chord pressed, as `parseChord` reads it
 *
 * The recorder used to bind the first key that was not a modifier. Tab,
 * pressed to move on, became Find in Terminal's chord, and as that command is
 * claimed ahead of a focused terminal, Tab completion stopped working in every
 * shell and agent. Escape, pressed to give up, closed the whole Settings
 * window.
 *
 * A key on its own is no shortcut, F-keys apart. A letter, digit or
 * punctuation mark, Space, Enter, Backspace, an arrow: each belongs to what is
 * being typed in, and a command bound to one takes it from the editor and
 * every text field — and from every terminal, for a command claimed over one.
 * Shift alone does not change that; it types capitals. Ctrl, ⌘ or Alt does.
 *
 * Every modifier held is kept. `chordFromEvent` records the application
 * modifier as `mod` and drops the other one — Ctrl on macOS, the Windows key
 * elsewhere — so Ctrl+⌘+J was bound as ⌘J and plain ⌘J ran it. It is put back
 * here.
 */
export function recordKeydown(e, { isMac = false } = {}) {
  if (e.isComposing || e.keyCode === 229) return { action: 'wait' };
  if (e.key === 'Escape') return { action: 'cancel' };
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return { action: 'leave' };
  if (NOT_A_KEY_YET.has(e.key)) return { action: 'wait' };

  const chord = chordFromEvent(e, { isMod: isMac ? e.metaKey : e.ctrlKey });
  if (!chord) return { action: 'wait' };
  if (isMac && e.ctrlKey && e.metaKey) chord.ctrl = true;
  if (!isMac && e.metaKey) chord.cmd = true;

  // A key the chord grammar has no name for (CapsLock, Insert) would be
  // saved as text that does not parse, which unbinds the command.
  const key = stringifyChord(chord);
  if (!parseChord(key)) return { action: 'refuse', reason: 'That key cannot be part of a shortcut.' };

  const held = chord.mod || chord.ctrl || chord.cmd || chord.alt;
  if (!held && !/^F\d+$/.test(chord.key ?? '')) {
    const hold = isMac ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt';
    return { action: 'refuse', reason: `A shortcut needs ${hold}, or an F-key.` };
  }
  return { action: 'bind', key };
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
 * What `event.key` is for the punctuation keys a chord matches on `code`, as
 * a US layout reports them — so that the press built from `mod+comma` also
 * reaches a chord spelled `mod+,`.
 */
const PUNCTUATION_KEY = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/**
 * The keydown pressing `chord` produces on one platform: `mod` held as ⌘ on
 * macOS and as Ctrl elsewhere, every other modifier as written.
 */
function pressOf(chord, isMac) {
  return {
    ctrlKey: Boolean(chord.ctrl || (chord.mod && !isMac)),
    metaKey: Boolean(chord.cmd || (chord.mod && isMac)),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
    key: chord.code ? PUNCTUATION_KEY[chord.code] ?? '' : chord.key,
    code: chord.code ?? '',
  };
}

/**
 * Bindings that never run on this platform, because the keypress that is
 * their chord runs another command first.
 *
 * Asked of the keys pressed, not of the text: off macOS `mod+alt+d` and
 * `ctrl+alt+d` are both Ctrl+Alt+D, and on macOS `mod+d` and `cmd+d` are both
 * ⌘D. Compared as strings those never met, so recording Ctrl+Alt+D for Open
 * Recent took Split Right's only chord off macOS with no warning. Each
 * binding's own keypress goes to the matcher `findBinding` uses, in the order
 * it uses them, and the first binding to match is the one that runs — so
 * what this reports is what the keyboard does.
 *
 * Reported rather than resolved: letting whichever came first win is how a
 * shortcut silently changes meaning when an unrelated line moves.
 *
 * Each conflict is `{ key, command }`, the binding that never runs,
 * `{ winner, winnerKey }`, the one that runs instead, and `commands`, the
 * two of them with the winner first.
 */
export function findConflicts(bindings, { isMac = false } = {}) {
  const conflicts = [];
  for (const binding of bindings) {
    const press = pressOf(binding.chord, isMac);
    const isMod = isMac ? press.metaKey : press.ctrlKey;
    const first = bindings.find((b) => chordMatches(b.chord, press, isMod));
    if (!first || first.command === binding.command) continue;
    conflicts.push({
      key: binding.key,
      command: binding.command,
      winner: first.command,
      winnerKey: first.key,
      commands: [first.command, binding.command],
    });
  }
  return conflicts;
}

/**
 * One conflict in words: the keypress, the command it runs and the one it
 * never runs — "Ctrl+Alt+D runs Open Recent…, never Split Pane Right".
 *
 * The keypress is written as it is pressed, `mod` spelled out as the key it
 * is here, so `mod+alt+d` and `ctrl+alt+d` read as the one chord they are.
 */
export function describeConflict(conflict, { isMac = false } = {}) {
  const chord = parseChord(conflict.key);
  const pressed = chord && {
    ...chord,
    mod: false,
    ctrl: Boolean(chord.ctrl || (chord.mod && !isMac)),
    cmd: Boolean(chord.cmd || (chord.mod && isMac)),
  };
  const title = (id) => COMMANDS[id]?.title ?? id;
  return `${displayChord(pressed, { isMac })} runs ${title(conflict.winner)}, never ${title(conflict.command)}`;
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
  if (spec.passThrough?.(ctx, binding)) return `pass:${binding.command}`;
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
 * The first chord the reader can actually press, because there is one place to
 * print it and an OS menu item carries one key equivalent. A chord spelled
 * with `cmd` needs a ⌘ key, so off macOS it is skipped rather than printed:
 * `split-right` is ⌘D on macOS and Ctrl+Alt+D elsewhere, and a Windows menu
 * reading "Cmd+D" names a key that machine does not have.
 *
 * `isMac` is an argument rather than read from `navigator` so this file stays
 * testable on both platforms at once.
 */
export function shortcutLabel(command, bindings = DEFAULT_RESOLVED, { isMac = false } = {}) {
  const usable = keysFor(command, bindings).filter(
    (key) => isMac || !parseChord(key)?.cmd
  );
  const key = usable[0];
  return key ? displayChord(key, { isMac }) : '';
}
