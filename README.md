# NexTerm

A desktop terminal workspace with a VS Code shell and Warp-style terminal
ergonomics. Native [Tauri 2](https://tauri.app) window, real PTYs, React 18 UI —
macOS, Windows and Linux from one codebase.

![NexTerm in use](docs/nexterm-demo.gif)

> Two groups — `app` and `tests` — each with their own arrangement; switching
> between them, saving the whole session, and putting it back after it was taken
> apart. This is the Windows chrome (NexTerm draws its own title bar there);
> macOS keeps its traffic lights and the system menu bar.
>
> The recording is driven through the app's UI in a browser preview, so the shell
> output in it is simulated. In the packaged desktop app the same panes run real
> `zsh` / `bash` / `pwsh` processes.

## Why

Terminal multiplexing usually means memorising tmux bindings, and web-based
"AI terminals" cannot reach your local shell at all. NexTerm gives you a real
local PTY per pane with a layout you rearrange by dragging, and it remembers
that layout the next time you open it.

## What it does

- **A group is a whole screen.** Each group owns its own arrangement of panes,
  and the active one fills the terminal area. Click another group and its
  arrangement replaces it — the terminals you left behind keep running. Think
  of it as several desks rather than one crowded one.
- **Split panes by dragging a tab.** Drop a terminal tab on the left, right, top
  or bottom quarter of any pane to split there; drop it in the middle to move it
  into that pane. Splits nest arbitrarily and every divider is draggable, and
  where you drag a divider is where it stays — across a group switch and across
  a restart.
- **Move terminals between groups.** Drag a tab onto another group's chip, or
  use *Move to Group* in the TERMINALS panel.
- **Save a group, or the whole desk.** *Save Group…* keeps one group's layout
  and each terminal's current directory. *Save All Groups…* snapshots every
  group at once under a name, and restoring it brings the entire session back —
  same groups, same arrangements, same directories.
- **Session restore.** Groups, layouts, names and each terminal's `cwd` are
  written to local storage and restored on next launch, without being asked.
- **A real terminal.** xterm.js over a native PTY, with OSC 133 shell
  integration (command start/end + exit status) and OSC 7 so the status bar and
  new splits follow the shell's actual working directory.
- **Command suggestions.** An inline, oh-my-zsh-style ghost-text suggestion as
  you type, ranked from the commands this session has run plus a curated index
  of common ones. It is an app-side layer, not real shell completion — it never
  reads `PATH` or the filesystem.
- **11 terminal themes.** Dark Modern, Light Modern, Monokai, Material, Dracula,
  Solarized Dark/Light, Nord, One Dark, Gruvbox Dark, Tomorrow Night.
- **An editor when you need one.** Open a file from the Explorer and it appears
  as a Monaco tab above the terminals; close it and you are back to a pure
  terminal window. Monaco and its workers are bundled locally — nothing is
  fetched from a CDN at runtime.
- **Filesystem confinement.** Every file command is resolved against the
  workspace root, with the deepest existing ancestor canonicalised so symlinks
  cannot escape it.
- **One title row.** On Windows and Linux the window is frameless and NexTerm
  draws its own compact title bar — menu, command centre, layout toggles and
  window buttons in a single 35px row, VS Code style, instead of a native
  title bar with a native menu bar under it. macOS keeps its traffic lights
  and the system menu bar.

## Install

Grab a build from the [Releases](../../releases) page:

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `NexTerm_<version>_aarch64.dmg` | Unsigned — first launch needs right-click → Open, or `xattr -dr com.apple.quarantine /Applications/NexTerm.app` |
| Windows — installer | `NexTerm_<version>_x64-setup.exe` / `_x64_en-US.msi` | Installs WebView2 if missing (needs internet on first run) |
| Windows — portable | `NexTerm-windows-x64-portable.zip` | Unzip and run `NexTerm.exe`, no installation |
| Linux (x86_64) | `.AppImage` / `.deb` / `.rpm` | Built on Ubuntu 22.04 |

There is no Intel macOS build yet — CI runs on `macos-latest`, which is Apple
Silicon. Build one locally with `npm run tauri build -- --target x86_64-apple-darwin`.

## Using it

The recording above walks through most of this.

**Open a terminal.** The window starts as one group holding one terminal.
`⌃⇧\`` adds a tab to the current group; the `+` in the tab bar does the same.

**Split.** Use the split buttons in the panel header, `⌘D` (right) / `⌘⇧D`
(down), or drag a tab onto an edge of any pane. While dragging, the target
quarter lights up so you can see where it will land before you let go.

**Work in groups.** The chips above the terminals are your groups; `+` makes a
new one. Clicking a chip swaps the whole arrangement to that group's. Set up
one group for the app and another for tests, and switch between them instead of
cramming both onto one screen.

**Move a terminal to another group.** Drag its tab onto the target group's chip,
or right-click it in the TERMINALS panel → *Move to Group*.

**Rename.** Double-click a terminal tab, or right-click it → *Rename*. Groups
rename the same way, from their chip or from the TERMINALS panel.

**Save a group.** Right-click a group in the TERMINALS panel → *Save Group…*.
It lands under SAVED with its terminal count and age; right-click it to *Load
in New Group* or *Load into Current Group*.

**Save the whole session.** The 💾 on the WORKSPACES section (or *Save All
Groups…* from the empty-area menu) snapshots every group — layouts and
directories included. Double-click a saved workspace to put the session back
the way it was, or right-click → *Add Its Groups to This Session* to bring them
in alongside what you already have.

**Open a file.** Click a file in the Explorer. The Monaco editor opens above the
terminal panel as a normal tab; the terminals keep running underneath.

**Change settings.** The gear in the activity bar opens a VS Code-style settings
window — editor font, terminal font/size/line-height, cursor style and blinking,
scrollback, colour theme, and command suggestions.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘P` / `⌘⇧P` | Go to file / all commands |
| `⌃\`` | Toggle the terminal panel |
| `⌃⇧\`` | New terminal tab in the current group |
| `⌘D` / `⌘⇧D` | Split the active pane right / down |
| `⌘W` | Close the active terminal pane |
| `⌥⌘←` / `⌥⌘→` | Focus the previous / next pane |
| `⌘B` | Toggle the primary sidebar |
| `⌘L` | Clear the active terminal |
| `⌘S` | Save the active editor file |

On Windows and Linux use `Ctrl` wherever `⌘` is listed.

**Shortcuts yield to the shell.** A chord the terminal needs goes to the
terminal: with a pane focused, `Ctrl+D` is EOF, `Ctrl+K` kills to end of line,
`Ctrl+C` interrupts, and the app does nothing. The same chord elsewhere in the
window does what the table says. On Windows and Linux the items that would
otherwise collide are reachable from the menu bar as well, because a native
menu accelerator is resolved before the webview and would take the key away
from every shell in the app.

## Develop

```sh
npm install
npm run tauri dev        # native window, hot-reloaded frontend
npm run dev              # frontend only, in a browser, on :1420
```

## Build

```sh
npm run tauri build
```

CI (`.github/workflows/build.yml`) runs the test suite on every push and builds
macOS, Windows and Linux bundles. Pushing a `v*` tag publishes a release with
the installers plus the Windows portable zip attached.

## Test

```sh
cd src-tauri && cargo test    # PTY, OSC parsing, fs confinement, native menu
node tests/e2e/runner.js      # store + UI flows against a mock IPC bridge
node tests/adversarial/runner.js
```

## How it fits together

```
src-tauri/src
  pty/            PTY manager, OSC 133/7 filter, per-shell integration scripts
  fs/             workspace-confined file commands + watcher
  menu.rs         native menu described as data, so it is testable off-thread
  commands/       the #[tauri::command] surface
src
  stores/         zustand stores (terminal tree, editor, settings)
  components/     layout, terminal, editor, explorer, command palette
  lib/            persistence, ANSI parsing, terminal themes, IPC wrapper
```

The terminal layout is a tree: every leaf is a *group* holding an ordered list of
tab ids, and every branch is a horizontal or vertical split. Dragging a tab
rewrites that tree, and `src/lib/persistence.js` versions it into local storage.
