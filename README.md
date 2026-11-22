# NexTerm

A desktop terminal workspace for running several shells and coding agents side
by side: a VS Code-style window — explorer, editor, command palette — around
Warp-style terminals. Native [Tauri 2](https://tauri.app) window, real PTYs,
React 18 UI — macOS, Windows and Linux from one codebase.

![NexTerm in use](docs/nexterm-demo.gif)

> Two groups — `app` and `tests` — each with their own arrangement; switching
> between them, saving the whole session, and putting it back after it was taken
> apart. This is the Windows chrome (NexTerm draws its own title bar there);
> macOS keeps its traffic lights and the system menu bar.
>
> The recording is driven through the app's UI in a browser preview, so the shell
> output in it is simulated. In the packaged desktop app the same panes run real
> `zsh` / `bash` / `pwsh` / `cmd` processes.

Terminal multiplexing usually means memorising tmux bindings, and web-based
"AI terminals" cannot reach your local shell at all. NexTerm gives you a real
local PTY per pane with a layout you rearrange by dragging, and it remembers
that layout the next time you open it.

## Highlights

- **Panes and groups, arranged by dragging.** Drop a tab on an edge of a pane
  to split it, on another group's chip to move it there. Each group is a whole
  screen of its own, and `⌘⇧Enter` zooms one pane, tmux-style.
- **Every terminal can call you.** A long command finishing, a bell or an
  agent's notification puts an orange ring and a count on that terminal, and
  `⌘⇧U` takes you there. The TERMINALS side bar shows each terminal's agent,
  state, git branch and last message.
- **The session comes back.** Groups, layouts, folders, each terminal's last
  output, the open editor tabs, and the conversation each agent terminal had —
  offered back, never run again by itself.
- **A whole layout starts at once.** Layout templates start the dev server,
  the watcher and the agent together. A folder's `.nexterm/commands.json` puts
  its own commands in the palette, with blanks to fill in, once you have read
  and trusted them.
- **Made for coding agents.** OpenCode and Claude Code notifications,
  `Shift+Enter`, resuming a conversation, several agents printing at full speed
  without freezing the window, and `nexterm-cli` for their hooks.
- **Guards a terminal usually lacks.** A lock marks a password prompt and
  nothing is typed for you into it (macOS, Linux), a multi-line paste that
  would run line by line asks first, Delete goes to the Trash, secrets are
  hidden before output is saved, and file commands stay inside the open
  folder.
- **A real terminal on macOS, Windows and Linux.** xterm.js with WebGL over a
  native PTY, ConPTY's quirks handled, OSC 133 and OSC 7 shell integration, 9
  dark themes and your own imported ones.
- **An editor and an explorer when you need them.** Monaco tabs above the
  terminals, search across files and git status in the Explorer — and a pure
  terminal window again when the last file is closed.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The window at a glance](#the-window-at-a-glance)
- [Using NexTerm](#using-nexterm)
  - [Folders, files and the editor](#folders-files-and-the-editor)
  - [Terminals, panes and groups](#terminals-panes-and-groups)
  - [Working in a terminal](#working-in-a-terminal)
  - [Knowing what every terminal is doing](#knowing-what-every-terminal-is-doing)
  - [Sessions: what comes back](#sessions-what-comes-back)
  - [Project commands](#project-commands)
  - [Coding agents](#coding-agents)
  - [Control NexTerm from a terminal](#control-nexterm-from-a-terminal)
  - [Safety nets](#safety-nets)
  - [Settings and themes](#settings-and-themes)
  - [Keyboard shortcuts](#keyboard-shortcuts)
- [Platform notes](#platform-notes)
- [Troubleshooting](#troubleshooting)
- [Develop](#develop) · [Build](#build) · [Test](#test) ·
  [Verify on Windows](#verify-on-windows) ·
  [How it fits together](#how-it-fits-together) · [License](#license)

## Install

Grab a build from the [Releases](../../releases) page:

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `NexTerm_<version>_aarch64.dmg` | Unsigned — first launch needs right-click → Open, or `xattr -dr com.apple.quarantine /Applications/NexTerm.app` |
| Windows — installer | `NexTerm_<version>_x64-setup.exe` / `_x64_en-US.msi` | Installs WebView2 if missing (needs internet on first run) |
| Windows — portable | `NexTerm-windows-x64-portable.zip` | Unzip and run `NexTerm.exe`, no installation |
| Linux (x86_64) | `.AppImage` / `.deb` / `.rpm` | Built on Ubuntu 22.04 |

There is no Intel macOS build yet — CI runs on `macos-latest`, which is Apple
Silicon. Build one locally with `npm run bundle -- --target x86_64-apple-darwin`.

## Quick start

Keys are written the macOS way. On Windows and Linux press `Ctrl` for `⌘` and
`Alt` for `⌥`; `⌃` is `Ctrl` everywhere.

1. **Open a folder.** *Open Folder* in the Explorer, or `⌘⇧O`. The Explorer,
   the title bar and new terminals follow it; until a folder is open,
   terminals start in your home directory.
2. **Open and split terminals.** The window starts as one group holding one
   terminal. `` ⌃⇧` `` adds a tab. `⌘D` / `⌘⇧D` splits the active pane right /
   down (`Ctrl+Alt+D` / `Ctrl+Shift+D` on Windows and Linux, because `Ctrl+D`
   is the shell's end of input), or drag a tab onto an edge of any pane.
3. **Make a second group.** `+` beside the group chips makes one — say one for
   the app and one for its tests. Clicking a chip swaps the whole arrangement;
   the terminals you left keep running.
4. **Start an agent.** Type `opencode` or `claude`, or right-click the empty
   part of a tab strip → *New opencode Terminal* / *New Claude Code Terminal*.
   Turn on its notifications once — [how](#notifications-from-programs).
5. **Let the terminals call you.** When a terminal you are not looking at
   finishes a long command, rings its bell or sends a notification, its pane
   gets an orange ring and a count. `⌘⇧U` goes to it.
6. **Find any command.** `⌘K` opens the command palette; `⌘P` goes straight to
   its files, and `⌘⇧P` to its commands, which show their shortcuts.
7. **Close NexTerm and open it again.** Groups, layouts, folders and each
   terminal's last output come back; an agent's conversation is offered back,
   not restarted.
8. **Make it yours.** `⌘,` opens Settings: fonts, themes, what a right-click
   does, and every shortcut.

## The window at a glance

| Part | What it holds | Show or hide |
| --- | --- | --- |
| Activity bar | Explorer, Search, and the Settings gear | |
| Side bar | the Explorer — the open folder's files, a filter, git status — or Search | `⌘B` |
| Editor | Monaco tabs above the terminals, only while a file is open | |
| Terminal panel | the group chips, then the active group's panes, each with its tab strip | `` ⌃` `` |
| TERMINALS side bar | every group and terminal with what it is doing, saved groups (SAVED) and saved workspaces (WORKSPACES) | `⌥⌘B` |
| Status bar | the open folder, its git branch, the active terminal's folder, shell and size, the last exit code, the text size when it is not the default, and the bell | |
| Title bar | on Windows and Linux NexTerm's own, with the ☰ menu; macOS keeps its traffic lights and menu bar | |

**Drag any boundary.** Every line between the side bars, the editor, the
terminal panel and the split panes resizes what is on either side of it. The
line turns violet under the pointer and while it is dragged, and it can be
grabbed a few pixels either side of it; Tab also reaches it, and the arrow keys
move it. Nothing gets too small to use:
the window is at least 960×640, the side bars keep 170px (left) and 220px
(right), the editor keeps its tabs and three lines, and the terminal panel its
header, the pane strip and three rows. A long folder name in the title bar or
the status bar is cut short with its whole path in the tooltip, so the search
box and the bell always stay in view.

**More tabs than fit.** A strip of tabs or chips — a side bar's view tabs, a
pane's terminals, the group chips, an editor pane's files — that holds more
than its width scrolls sideways with the wheel or the trackpad, with no scroll
bar, and fades out on the side that has more. While you drag a tab or chip over
a strip the fade goes away, so the marker where it will land is drawn whole.

**Toasts.** A short confirmation of something that shows nowhere else appears
as a toast in the bottom right corner, above the status bar, and fades after
about 3 seconds; an error shown there stays until you dismiss it. At most three
are up, the newest at the bottom, and the same message twice is shown once,
for its full time again. A toast never takes focus, so you keep typing in the
terminal, and it sits beside the notices in that corner, never over them (in
a window too narrow for that, just above them). A screen reader says a
confirmation when it is next idle and an error at once. With *Reduce Motion*
on (Settings ▸ Workbench, or the system setting), toasts appear and go without
fading.

Three copies say they are done this way: Copy Path (a TERMINALS row's menu,
a tab chip's menu and the Explorer) shows "Path copied", Copy Context (those
two terminal menus and the command palette) shows "Copied 200 lines (secrets
masked)" with the number of lines it copied, and Copy Session ID (AGENT
SESSIONS) shows "Session ID copied". If the clipboard refuses, or there is
nothing to copy, an error says so and stays. The other copy actions, such as
Copy Relative Path in the Explorer or copying a terminal's selection, do not
show a toast yet; that is later work.

The words this README uses:

- **Terminal** — one shell, shown as one tab.
- **Pane** — one box of a split, holding one or more terminal tabs.
- **Group** — a whole arrangement of panes. One group fills the terminal panel
  at a time; the terminals of the others keep running.
- **Saved group** — a group's layout and folders, kept under SAVED. One whose
  terminals have startup commands is a **layout template**.
- **Workspace** — every group at once, saved under a name.

**Use the menu.** On Windows and Linux, ☰ at the left of the title bar opens
File, View and Terminal. Hover or use the arrow keys to step into a menu,
`Enter` to run an item, `Esc` to back out; keys typed while it is open never
reach the terminal behind it.

## Using NexTerm

### Folders, files and the editor

**Open a folder.** NexTerm starts with no folder, like VS Code. Click *Open
Folder* in the Explorer, or ☰ → File → *Open Folder…*. The Explorer, the title
bar and new terminals then follow that folder; until one is open, terminals
start in your home directory.

**Go back to a folder you had open.** `⌥⌘O`, File → *Open Recent…*, or the
list the Explorer shows when nothing is open. A folder that has since been
moved or deleted is refused by the backend and drops out of the list rather
than staying as a row that fails every time it is clicked.

#### Editors and terminals in one layout

**Open a file.** Click a file in the Explorer. It opens in the same area as the
terminals, in an editor pane above them (about 60/40) — there is no separate
editor area and no Maximize Panel button. Close the last file and you are back
to a pure terminal window. Monaco is loaded the first time a file is shown, not
at launch, and it and its workers are bundled locally — nothing is fetched from
a CDN at runtime.

**One active pane.** Panes of both kinds sit side by side, and one of them is
the active pane, drawn with the accent line. The pane commands act on it:
`⌘S`/`Ctrl+S` saves the file the active editor pane shows; `⌘W`/`Ctrl+W` in an
editor pane closes its file tab (asking first when it is unsaved), and on its
last tab the pane goes; in a terminal pane it closes the pane, as before.
`⌘F`/`Ctrl+F` is Monaco's find in an editor pane and the terminal's find bar in
a terminal pane. Split Right/Down from an editor pane makes an empty editor
pane; `⌘D` inside Monaco is still Monaco's "add next match", and `Ctrl+Alt+D`
splits. Toggle Pane Zoom, Equalize Splits and Swap Pane With… work across both
kinds; inside Monaco the zoom chord is left to Monaco (`⌘⇧Enter` is its Insert
Line Above), so an editor pane is zoomed from its ⤢ button, Terminal → *Toggle
Pane Zoom* or the command palette. Focus Next/Previous Pane (`⌥⌘→`/`⌥⌘←`, `Ctrl+Alt+→`/`Ctrl+Alt+←`)
goes through editors and terminals in screen order, and the keyboard goes with
it: what you type next lands in the pane that is now active. New Terminal,
Clear Terminal and the prompt jumps always act on the group's terminal.

#### Moving editors

Drag a file tab onto the left, right, top or bottom edge of any pane — a
terminal included — to split there, or onto another editor pane's strip to move
it in. A terminal tab can be dragged onto the edge of an editor pane the same
way. Across kinds only the edges are offered: dropping on the other kind's
strip or middle changes nothing. Drop a file tab on another group's chip to move
it to that group. "Move Editor to New Pane Right/Down" (a file tab's right-click
menu, or the command palette) splits the file out beside its pane. Moving a file
keeps its text, undo history and caret; moving a terminal keeps its program and
scrollback.

#### Restoring the layout

**Open files belong to a terminal group.** A file opens in the terminal group
on screen, where it is already open if it is open somewhere, else in the last
editor pane you used. Switch groups and you see the other group's files and
terminals; nothing has closed. Closing a group that holds unsaved files asks
first (Save / Don't Save / Cancel). A relaunch puts back every pane of both
kinds — the split sizes, the files in each pane, the active pane and the active
group. Saved templates and workspaces stay terminal-only. Files from a version
before this come back in the active group, above its terminals. A group that
holds files keeps one terminal pane after its last terminal closes: it shows
"No terminal in this pane" with a New Terminal button and no Close button, and
it comes back that way after a relaunch. Any empty terminal pane also offers a
New Claude Code Terminal and a New opencode Terminal button, which open a
terminal in that pane and start the agent in it once the shell's prompt is up,
and up to three recent agent sessions from AGENT SESSIONS, newest first
(archived ones are left out). Clicking one resumes it in that pane; if a
terminal of this window already has it, NexTerm switches to that terminal
instead. Nothing runs until you click. Unsaved edits are not kept across a
restart (there is no hot exit): quitting with unsaved files asks first.

**Search across the files.** `⇧⌘F`, or the magnifying glass in the activity
bar, opens a search over the open folder — match case, whole word, regular
expressions — grouped by file, and clicking a result opens that file with the
caret on the line. It skips exactly what the Explorer skips (`node_modules`,
`.git`, `target`, `dist`), so the results and the tree agree about what is in
the project; `.gitignore` itself is not read. Searching happens on `Enter`, not
on every keystroke: a grep of a real repository is not something to fire on the
`e` of `error`.

**Narrow the Explorer.** The funnel in the Explorer header opens a filter: type
part of a name and the tree keeps only what matches, plus the folders that lead
to it, opened. It counts the matches, `Esc` clears it, and clearing puts your
own expanded folders back exactly as they were. This is a different question
from ⌘P — "what is in here that looks like X, and where does it sit".

**See what git sees.** When the open folder is a repository, the status bar
carries the branch, how far it is from upstream and how many files have
changed, and the Explorer colours the ones that have — modified, added,
deleted, untracked — with a letter beside each, so the row still says something
where the colours do not. It shells out to your own `git`, which is what makes
worktrees, submodules and your own `core.*` behave here the way they behave in
the terminal below. There is no staging or committing: that is a second
application, and this one has git in it already.

**Delete to the Trash.** Delete in the Explorer moves files and folders to the
Trash — the Recycle Bin on Windows — where they can be restored. Where that is
not possible or cannot be checked — a network drive, a USB stick, an item too
big for the Recycle Bin, a drive whose Recycle Bin is turned off — nothing is
deleted until a second question, *Delete Permanently?*, opens with Cancel
focused. On Windows and Linux a link is removed as a link and what it points to
stays; on macOS it goes to the Trash. Settings ▸ Files ▸ *Enable Trash* turns
it off.

**Reveal a file, or open a terminal there.** Right-click a row in the
Explorer, or the space below the rows for the open folder itself. *Reveal in
Finder* (*Reveal in File Explorer* on Windows, *Reveal in File Manager* on
Linux) shows it in the file manager: a file is selected in its folder, a folder
is opened (on Linux it is selected in its parent), and a macOS package such as
an `.app` is shown, never launched. Nothing is opened with its default
application. *Open Terminal Here* starts a new terminal in that folder — for a
file, in the folder it sits in — beside the ones in the active pane, and gives
it the keyboard. It starts there or not at all: when the shell cannot start in
that folder, the Explorer says so instead of opening a terminal somewhere else.

**Open a file or folder in an external editor.** Off by default: set
*Settings ▸ Files ▸ External Editor* to a program and its arguments, for
example `code` or `subl -w`, and the Explorer's menu gains *Open in External
Editor* for files, folders and the space below the rows (the open folder
itself). While the setting is empty, or only spaces, the item is not there, and
nothing is ever opened with the system's default application instead. What
runs is exactly the setting, split into words without a shell — words are
separated by spaces, `'…'` and `"…"` keep spaces inside one word, a backslash
is an ordinary character so `"C:\Program Files\…\code.cmd"` works, and an
unclosed quote is refused — followed by the path as one last argument. Nothing
is expanded or substituted: `*`, `$HOME`, `;`, `|` and `&&` are passed as they
are. The program is refused when it is a shell, a program that opens files
in their default application, or a wrapper that runs its arguments as a
command or a script, by name, in any case, with or without `.exe`: `sh`,
`bash`, `zsh`, `fish`, `dash`, `ksh`, `csh`, `tcsh`, `nu`, `cmd`,
`powershell`, `pwsh`, `open`, `xdg-open`, `gio`, `kde-open`, `kde-open5`,
`gnome-open`, `exo-open`, `wslview`, `start`, `explorer`, `rundll32`, `env`,
`nohup`, `xargs`, `osascript`, `cscript`, `wscript`, `mshta`, `wsl` and
`conhost`. This list guards against a mistake in the setting; it is not a
sandbox. Whatever else you set runs, with the path as its last argument: an
interpreter such as `python` or `node` is not refused, and neither is a shell
copied or linked under another name. The path must be inside the open folder (the same confinement as every other file
command) and must exist; with no folder open nothing runs. A program given as
a relative path (`bin/editor`, `.\editor.exe`) is refused, because it would be
looked up inside the open folder: give a name found on `PATH` or a full path.
The editor runs in the open folder with `PATH` set to your login shell's `PATH`
followed by NexTerm's own, so on macOS `code` is found even when NexTerm was
started from the Finder or the Dock; relative entries on `PATH` (`.`, `bin`, an
empty one) are ignored for the same reason. NexTerm does not wait for the
editor, and its input and output go nowhere. On Windows a bare name is looked
up on `PATH` as `.exe`, `.com`, `.cmd` or `.bat`, so VS Code's `code` runs as
`code.cmd`; batch files are run because the Rust toolchain NexTerm is built
with escapes their arguments (Rust 1.77.2 and later, CVE-2024-24576), and no
console window opens. A `.cmd` or `.bat` editor runs through `cmd.exe`, which
would otherwise look a bare command name up in the open folder before `PATH`,
so a `node.bat` in a cloned repository could run in place of `node`: NexTerm
starts the editor with `NoDefaultCurrentDirectoryInExePath=1`, which turns
that lookup off, and the editor and what it starts inherit it. A refusal or a failure to start is shown in red at the
top of the Explorer, in words that say why.

**Filesystem confinement.** Every file command is resolved against the open
folder, with the deepest existing ancestor canonicalised so symlinks cannot
escape it. With no folder open, file commands are refused outright.

### Terminals, panes and groups

**Open a terminal.** The window starts as one group holding one terminal.
`` ⌃⇧` `` adds a tab to the current group; the `+` in the tab bar does the same.

**Pick a shell per terminal.** Right-click a group in the TERMINALS panel →
*New Terminal With ▸* lists the shells this machine actually has — found on the
real box rather than guessed, so it names Git Bash and WSL when they are there
and does not offer PowerShell 7 when they are not. Terminals in one window may
differ, the status bar names the one you are looking at, and *Duplicate* keeps
a terminal's shell as well as its directory. Settings ▸ Terminal ▸ Default
Shell picks what a plain new terminal opens, and still takes a typed path.

**Split.** Use the split buttons in the panel header, `⌘D` (right) / `⌘⇧D`
(down) — `Ctrl+Alt+D` / `Ctrl+Shift+D` on Windows and Linux — or drag a tab
onto the left, right, top or bottom quarter of any pane. While dragging, the
target quarter lights up so you can see where it will land before you let go;
drop the tab in the middle of a pane to move it into that pane instead. Splits
nest arbitrarily and every divider is draggable, and where you drag a divider
is where it stays — across a group switch and across a restart. A split carries
on from the terminal being split: it opens in that terminal's current folder,
in the same shell — a Git Bash split stays Git Bash, in the same directory.
Settings ▸ Terminal ▸ *Split Directory* makes splits start like any new
terminal instead (VS Code's `terminal.integrated.splitCwd`).

**Even out and rearrange panes.** *Equalize Splits* in the command palette
gives every pane of the group the same share, nested splits included, and
Settings ▸ Terminal ▸ *Equal Splits* does it on every new split. *Swap Pane
With…* in the palette, or in a pane's menu, lists the other panes of the group
and trades places with the one you pick: the terminals move as they are,
programs and scrollback included, and the cursor stays in yours. It is
unavailable while a pane is zoomed, since the other panes are hidden.

**Zoom a pane.** In a split group, `⌘⇧Enter` (`Ctrl+Shift+Enter` on Windows
and Linux), the ⤢ button in a pane's tab strip, Terminal → *Toggle Pane Zoom*
or the command palette makes that pane fill the whole group. The other panes
are hidden, not closed: what runs in them keeps running, a program that asked
is told its terminal lost focus, and the pane's tab strip carries a *Zoomed*
chip — click it, or press the chord again, and the split comes back exactly as
it was, sizes and all. The terminal that grows or shrinks is told its new size,
so a full-screen program redraws for it. A zoom ends by itself when it would
stop making sense: the zoomed pane closes, you split, you move to another pane
(`⌥⌘←` / `⌥⌘→`, or a hidden terminal in the TERMINALS panel), or a terminal is
moved into a pane the zoom hides — the way tmux unzooms. Each group keeps its
own zoom while you switch between them (its chip shows ⤢); a restart comes back
with every pane in view.

**Hide a lone tab strip.** With Settings ▸ Terminal ▸ *Hide the Tab Strip of a
Single Terminal* on, a pane with one terminal shrinks its strip to a thin
handle along the top, and the terminal gets the rest of the row. The handle
marks an unread entry, progress and a password lock, and says which in its
tooltip. Click it and the strip opens just below it, over the terminal; click
the handle again, click elsewhere, or press Escape while the strip has the
keyboard to close it. Escape typed in the terminal is the program's, as it
always is: it does not close the strip. The opened strip has no close buttons,
so a click that misses the handle cannot end a terminal: close it from the
handle's right-click menu, the command palette or `⌘W`. The strip also opens
while you drag a tab, so you can still drop one there, and while its menu or
rename is open. Pointing at the pane never opens it, so a click meant for the
terminal's first row always reaches the terminal, and the terminal is never
resized by it. A second tab brings the full strip back.

**Work in groups.** The chips above the terminals are your groups; `+` makes a
new one. Each group owns its own arrangement of panes, and the active one fills
the terminal area; clicking a chip swaps the whole arrangement to that
group's — the terminals you left behind keep running. Set up one group for the app and another for tests, and switch
between them instead of cramming both onto one screen: several desks rather
than one crowded one.

**Move a terminal to another group.** Drag its tab onto the target group's chip,
or right-click it in the TERMINALS panel → *Move to Group*.

**Rename.** Double-click a terminal tab, or right-click it → *Rename*. Groups
rename the same way, from their chip or from the TERMINALS panel.

**When a shell exits.** A terminal whose shell has ended says so once —
`[process exited with code …]`, with Windows' crash and Ctrl+C codes also in
hex (`0xC000013A, ended by Ctrl+C`) — and **Enter** starts a new shell in its
place: same pane, its last directory, the shell it ran, at the top of the pane
with what was on screen moved up into the scrollback. Other keys go nowhere
instead of each printing an error, and whatever the last program had switched
on (mouse reporting, the full-screen view) is switched off, so a drag selects
text again. On Windows this is how a terminal comes back when quitting
OpenCode with Ctrl+C took cmd down with it, as has been seen; the code it
prints says how cmd ended.

#### Switching tabs

The tab commands act on the tabs of the active pane, in the order its tab
strip shows them, and leave the keyboard in the terminal they switch to.

| | Next / previous tab | Tab 1 to 8 | Last tab |
| --- | --- | --- | --- |
| macOS | `⌃PageDown` / `⌃PageUp`, or `⌘⇧]` / `⌘⇧[` | `⌘1` … `⌘8` | `⌘9` |
| Windows and Linux | `Ctrl+PageDown` / `Ctrl+PageUp` | not bound | not bound |

On a Mac keyboard without PageUp and PageDown keys, `⌃PageUp` is `fn+⌃↑` and
`⌃PageDown` is `fn+⌃↓`. Next and previous wrap around at both ends. `⌘9` is
always the last tab, as in browsers and VS Code, however many tabs the pane
holds. A number past the pane's last tab does nothing. With an editor pane active, or the keyboard in
a file, none of these switch anything. Inside the editor, `Ctrl+PageUp` and
`Ctrl+PageDown` are left to the editor. The commands have no menu entry; the
keys work wherever the keyboard is in the window.

They work while a terminal has focus, also over vim, tmux or OpenCode, as in
GNOME Terminal and VS Code. On macOS that costs a program nothing, because `⌘`
never reaches the pty. `Ctrl+PageUp` and `Ctrl+PageDown` are the exception:
xterm would send them on as `CSI 5;5~` and `CSI 6;5~`, which vim reads as its
own previous and next tab page. vim's `gT` and `gt` still do that. Emacs in a
terminal loses the same two keys, which it reads as `C-<prior>` and
`C-<next>`. If you need the chords in a program, rebind the commands in
Settings ▸ Keyboard Shortcuts.

**Why there is no Go to Tab chord on Windows and Linux.** The obvious
candidates already mean something there. `Alt+1` … `Alt+9` is readline's
digit argument (`Esc 1` … `Esc 9`) in bash and zsh, and switches windows in
irssi and weechat. `Ctrl+Alt+` a digit is `AltGr` on Windows keyboard layouts,
which type characters with it: on a German layout `AltGr+7` … `AltGr+0` type
`{ [ ] }`. The `⌘` defaults do not carry over to the Windows or Super key,
which the desktop mostly keeps for itself: `Win+1` opens the first taskbar
app. Any of these can still be bound to Go to Tab 1 … 8 or Go to Last Tab in
Settings ▸ Keyboard Shortcuts, and a chord you record with the Windows key
works.

#### Reopening a closed terminal

`⌘⇧T` on macOS, `Ctrl+Shift+T` on Windows and Linux (*Reopen Closed
Terminal*), brings back the terminal you closed last. Press it again for the
one before, up to the last 10, newest first. It counts every terminal you
close: a tab's ✕ or *Close Terminal*, *Close Others in Pane* and *Close
Terminals to the Right*, *Close Pane*, and *Close Group*. Closing a pane or a group brings
its terminals back one per press, in their old tab order.

**`Ctrl+Shift+T` is not New Tab here.** In GNOME Terminal, Konsole and Windows
Terminal `Ctrl+Shift+T` opens a new tab. In NexTerm it reopens the terminal you
closed last, as it does in the browsers and VS Code. If your fingers expect a
new tab, rebind *Reopen Closed Terminal* in Settings ▸ Keyboard Shortcuts.

What comes back is a **new shell**, not the old one:

- in the folder the terminal was in when you closed it, with the shell it ran
  (a Git Bash terminal comes back as Git Bash). A folder that no longer exists
  falls back to where a new terminal starts, as *Copy Tab* (*Duplicate*) does;
- with the name you gave it; a terminal that still had its default
  `Terminal N` name gets a fresh one;
- in its old pane at its old place in the tab strip, if that pane is still
  open. Otherwise it goes in the active terminal pane of its old group, and if
  that group is gone, where a new terminal goes. It becomes the active tab
  and gets the keyboard.

**No scrollback comes back**, and nothing is typed into the new shell. An agent
that was running there is not restarted: AGENT SESSIONS in the TERMINALS panel
resumes its conversation. The list lives in memory only. It is never saved,
holds only each terminal's name, folder, shell and place, and is empty after a
restart. Restarting a shell that exited, loading a workspace and the start-up
of the app add nothing to it. Loading a workspace or opening another folder
does not empty it either: reopening is something you ask for, and it brings a
terminal back to where it was, in its own folder. With nothing to reopen the
key does nothing.

The key works while a terminal has focus. `⌘` never reaches the pty, and xterm
sends nothing for `Ctrl+Shift+T`, so no program loses a key; `Ctrl+T` stays the
shell's. The command has no menu entry, and Settings ▸ Keyboard Shortcuts can
rebind it.

#### Recent tabs (Ctrl+Tab)

`Ctrl+Tab` switches between the terminals you used most recently, across every
group, as in VS Code, Windows Terminal and the browsers. It is literal `Ctrl`
on every platform, macOS included (`⌃Tab`, as in Terminal.app and Safari).

- Press `Ctrl+Tab` and let go: you are back in the terminal you were in
  before, even if it is in another group. Press it again to come back.
- Hold `Ctrl` and press `Tab` again to walk further down the list, which
  opens in a small overlay at the top of the window. `Ctrl+Shift+Tab` walks
  the other way. Both wrap around. While the list is open, `↑` and `↓` move
  the selection too.
- Let go of `Ctrl`, press `Enter` or click a row to switch to the selected
  terminal. It becomes the active tab and gets the keyboard.
- `Esc`, or switching to another app, closes the list without switching.

Each row shows the terminal's name, its group and the last part of its
folder. The list holds terminal tabs only: files are not in it. It lives in
memory only, is never saved, and starts again with the terminal on screen
after a restart. Terminals you have not used since then come after the ones
you have. With fewer than two terminals the keys do nothing, and they do not
open the list over a dialog, an open menu or the command palette. The overlay
does not animate, so there is nothing for *Reduce Motion* to turn off.

The keys work while a terminal has focus, also over vim, tmux or OpenCode. A
program gives nothing up: xterm sends `Ctrl+Tab` as a plain `Tab` and
`Ctrl+Shift+Tab` as `Shift+Tab` (`CSI Z`), and those two keys still reach it.
The commands (*Switch to Recent Terminal* and *Switch to Recent Terminal
(Backwards)*) have no menu entry. Settings ▸ Keyboard Shortcuts can rebind
them; with a chord like `Alt+Q`, letting go of `Alt` picks the terminal.

### Working in a terminal

**A real terminal.** xterm.js over a native PTY, with OSC 133 shell
integration (command start/end + exit status) and OSC 7 so the status bar and
new splits follow the shell's actual working directory. Terminals draw with
xterm's WebGL renderer, so block and box-drawing characters — TUI logos,
borders — fill their cells at any line height, and fall back to the DOM
renderer where WebGL is unavailable.

**Select, copy and paste — the way Warp does it.** Drag over any text to
select it; double-click takes a word, triple-click a line. The selection is on
the clipboard the moment you let go (Settings ▸ Terminal ▸ *Copy on Select*
turns that off). This works inside Claude Code too: a program writing into the
scrollback never gets the mouse, even when it asks for it, so a drag there
selects. A **full-screen** program — vim, htop, tmux, `less --mouse`, anything
on the alternate screen — does get the mouse when it asks; hold **Shift** while
dragging to select inside it anyway (on macOS **⌥** works too). *Mouse
Reporting in Full-Screen Apps* in the same section takes the mouse away from
every program. Paste with `⌘V` on macOS, `Ctrl+V` on Windows — see the table in
[Keyboard shortcuts](#keyboard-shortcuts). A program that asked for bracketed
paste gets the text bracketed, so a
multi-line paste into a shell or an agent is not run line by line.

**Copy the last lines of a terminal, secrets masked.** Right-click a
terminal's tab, or its row in TERMINALS, and pick *Copy Last 200 Lines (Secrets
Masked)*; the Command Palette has the same command for the active terminal.
The clipboard gets the terminal's last 200 lines as plain text, with no colours
or escape codes, a wrapped line joined back into one and the blank rows under
the last output left out. Strings that look like secrets (API keys, tokens,
passwords after `NAME=`) are replaced with `[hidden]`, by the same masking as
`nexterm-cli read-screen`. While a full-screen program is up, its screen is
what is copied. Nothing is written to a file. The number is Settings ▸
Terminal ▸ *Copy Context Lines* (1 to 10000), and the menu names it. Very
long output is cut at `read-screen`'s 512 KiB cap, so the oldest of those
lines are dropped, without a notice. A terminal that has never been on
screen has no screen to copy: the item is greyed out and says so, and the
palette does not offer it. What is copied is what the terminal has drawn, so
output NexTerm still holds back for a busy background terminal is not
included.

**Find something in the scrollback.** `⌘F` opens a find bar over the focused
terminal — incremental as you type, `Enter` / `Shift+Enter` to walk the matches,
`Esc` to close. Match case, whole word and regular expressions are there, every
match is highlighted at once, and the bar counts them ("3 of 17"). The buffer is
5000 lines deep by default, so this is how you get back to the error that
scrolled past.

**Know which command you are scrolled into.** Scroll back through a long build
and a small header appears at the top of the pane naming the command whose
output you are looking at. It is gone at the bottom, where the header would
only repeat what is on screen, and never appears over a full-screen program
like vim or htop. Settings ▸ Terminal ▸ *Sticky Command Header* turns it off —
it covers the top row, which is occasionally the row you scrolled up to read.

**Prompt marks on the scrollbar.** The terminal's scrollbar is a map of the
scrollback: a violet mark at every shell prompt, a blue mark at every message
you sent to Claude Code, and a translucent box for the part on screen. The
thin scrollbar and its box are always visible on a terminal's normal screen,
faintly, also with the pointer elsewhere and with nothing to scroll yet (then
the box fills the track); over the box it is a little brighter. A full-screen
program (vim, less, OpenCode, Claude Code in fullscreen) has no scrollback,
so there the scrollbar stays hidden, as before. The marks stay. Click a mark
of either kind and that row scrolls to the top of the pane, without
hovering first; a click anywhere else on the scrollbar, and dragging the box,
work as before. `Ctrl+Shift+↑` / `Ctrl+Shift+↓` (`⌘⇧↑` / `⌘⇧↓` on macOS), or
*Terminal: Go to Previous Prompt* / *Go to Next Prompt* in the palette, step
through both kinds in buffer order; past the last mark, next goes to the
bottom. On a terminal's normal screen these keys belong to NexTerm, also where there
are no marks (fish, ssh, WSL), so the shell does not get them; they can be
given other keys in Settings ▸ Keyboard Shortcuts. A mark comes from the "a
prompt is here" signal (OSC 133 D) the shell integration prints in front of
every prompt, the first one included: **cmd**, **PowerShell** (Windows
PowerShell and pwsh), **zsh**, **bash** and **Git Bash** all send it, so every
prompt gets a mark, an empty Enter included. Which row of the prompt is marked
depends on the shell. In cmd and PowerShell the signal is part of the prompt
string, so the mark is on the row you type on, the second line of a two-line
prompt. zsh and bash print the signal just before they draw the prompt: when
the prompt text arrives after it, which a prompt that takes a moment to build
(starship, powerlevel10k) makes likely, the mark is on the row the prompt
starts on, the first line of a two-line prompt or the empty line above a
prompt that begins with one; when both arrive together, it is the row you type
on. A one-line prompt is marked on its row either way. A batch file run with
`echo on` marks each line cmd prints its prompt for; cmd's `More?` gets none.
A shell or program that sends no such signal — fish without its own OSC 133,
sh, nushell, WSL, a shell on the far end of ssh — shows the box and no marks:
the only other clue, the line where Enter was pressed, cannot tell a prompt
from a REPL, a password prompt or an agent's input box.

**Claude Code's messages on the scrollbar.** Every message you send to
Claude Code gets a blue mark on its `❯` row in the conversation: a short one,
one that wraps over several rows (Korean included), a pasted block, and a
slash command that Claude Code echoes as a `❯ /…` row. The input box at the
bottom never has one, nor has an empty Enter. NexTerm reads what the box
holds when you press Enter and marks the row once Claude Code has drawn that
text above the box, so a message you send while Claude Code is still working
is marked when it shows in the transcript. For that Claude Code must draw on
the normal screen, where its conversation goes into the scrollback: every
terminal NexTerm starts gets `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, unless
the variable is already set (any value you set wins, also one exported in a
shell rc file), and on Windows its name is added to `WSLENV`. Per Claude
Code's documentation the variable wins over `CLAUDE_CODE_NO_FLICKER` and its
`tui` setting, so `/tui fullscreen` and `tui: fullscreen` do not bring the
fullscreen renderer back in NexTerm's terminals. The trade: the classic
renderer may flicker a little more in long streamed answers and has no mouse
scrolling of its own, and in return the conversation scrolls with the wheel
and the scrollbar and has its marks. Settings ▸ Terminal ▸ *Claude Code on
the Normal Screen* (on by default) turns this off for terminals started or
restarted afterwards; so does setting the variable yourself. Fullscreen
Claude Code has no marks: with the setting off, background sessions (agent
view, `claude attach`), Claude Code over ssh or on another machine, or a
version that ignores the variable, it draws on the alternate screen, where
there is no scrollback, the map is hidden and the keys go to Claude Code.
Marks also need NexTerm to know Claude Code runs there: started or resumed
from NexTerm, or `claude` typed at an integrated shell prompt (cmd,
PowerShell, zsh, bash). `npx`, an alias, a path to the binary, a shell
without the prompt signal (fish, sh, WSL) and ssh get no message marks.
Conversation history that a resumed Claude Code prints is not marked. The
rules were measured on Claude Code 2.1.327; a later version that draws its
messages differently gets no marks rather than wrong ones. A message may also
go without a mark, never with a wrong one, when it is sent while a todo list
or tool progress shows above the box, or when the pane is resized while it
waits for its echo.

**OpenCode's messages on the scrollbar.** OpenCode's full TUI draws on the
alternate screen, which has no scrollback, so NexTerm starts and resumes
OpenCode in its mini mode instead: New OpenCode Terminal types `opencode
--mini --no-replay`, and Resume types `opencode --mini --no-replay -s <id>`
or `opencode --mini --no-replay --continue`. Mini prints the conversation on
the normal screen, where it scrolls with the wheel and the scrollbar, and
every message you send gets a blue mark on its `›` row, wrapped and Korean
messages and pastes included; the composer and the footer at the bottom never
have one. The flags are added only when Settings ▸ Terminal ▸ *OpenCode in
Mini Mode* is on (the default) and `opencode --version` says OpenCode V1
1.17.10 or newer; any other OpenCode (older, or V2), one NexTerm cannot find
or ask, and the setting off all get plain `opencode`, the full TUI, as
before. NexTerm asks once per run and keeps a yes until it quits, so if
opencode is upgraded or replaced while NexTerm runs (to V2, say), restart
NexTerm or turn the setting off. It asks the `opencode` the login shell's
PATH finds, which can differ from the one a folder pins with nvm, mise, asdf
or volta, or from a PowerShell alias; such a folder may get the flags for an
opencode that has none. Typing `opencode` yourself always gives the
full TUI, as does a layout template's `opencode -c`; `opencode --mini`
typed yourself is marked too. NexTerm finds an echo by the text the
composer held at Enter, never by its colour, so other OpenCode themes work.
The limits: no marks in the full TUI, in V2, over ssh or in WSL;
a message whose text has an empty
line in it may get no mark; with replay on (`opencode --mini` without
`--no-replay`) the marks go when a resize makes mini print the conversation
again, and the reprint is not marked unless a message was still waiting for
its echo then. History a resumed conversation may print is meant to get no
mark, and a message typed before mini has drawn gets none; this is still to
be checked against a real resume (WINDOWS_VERIFICATION.md V50 O12). Mini
sets no terminal title, so a new mini conversation does not learn its id
while it runs: after a NexTerm restart it resumes through the
usual lookup, `--continue` (with the mini flags) when it is the only OpenCode
terminal in reach and otherwise the list in the banner, never into a
conversation another terminal has; one started with `-s <id>` stays exact.
Its side-bar title is no longer `OC | …`.

Marks leave with their text — the
oldest lines leaving a full scrollback, `clear` / `cls` / Ctrl+L, a redraw of
Claude Code's screen, and *Clear Terminal*, after which the prompt you are at
keeps its mark and every message mark goes. When Claude Code exits its marks
stay. At most 500 of each kind per terminal, kept apart, so neither pushes the
other out. A tab never shown has no marks for what it printed before it
first appeared. Settings ▸ Terminal ▸ *Prompt Marks on Scrollbar* turns both
kinds of marks off without changing the terminal's width; a click on the
scrollbar is then the scrollbar's own everywhere, and the keys work either
way. In Windows High Contrast prompt marks are drawn in the Highlight colour
and message marks in the LinkText colour, and the box keeps an outline,
also at rest; with reduced motion nothing fades.

**Run something again.** `⌘⇧H` opens the command history: every command line
this machine has run, newest first, with the directory it ran in. Typing
narrows it by plain substring — a command line is not a filename — and `Enter`
types the chosen one into the active terminal without pressing return, so a
command from yesterday can be edited before it runs. The history outlives the
window. It is **not** on `Ctrl+R`: that is reverse-i-search in every shell, and
a history palette that costs you the shell's own is a bad trade.

**Command suggestions.** An inline, oh-my-zsh-style ghost-text suggestion as
you type, ranked from the commands this session has run plus a curated index
of common ones. It is an app-side layer, not real shell completion — it never
reads `PATH` or the filesystem.

**Click what the output names.** A stack trace's `src/app.js:42:13`, a
compiler's `--> src/main.rs:10:5`, a Python traceback's `File "x.py", line 9` —
click it and the file opens in the editor above with the caret on that line.
Relative paths are read against the terminal's current directory, not the
workspace root, so a `cargo` run inside `src-tauri/` lands on the right file.
`http://` and `https://` addresses open in your browser; nothing else is ever
offered as a link, and a path without a line number is left as plain text so
ordinary output does not fill up with underlines.

**Show a listed file or folder in Explorer or Finder.** Hold `Ctrl` (`⌘` on
macOS) and point at a name in the output — from `ls`, `ls -l`, `dir`, `find`
or `git status` — and it is underlined if it exists; click and Explorer or
Finder opens that folder, or the file's folder with the file selected (on
Linux a folder is shown selected in the folder above it). A file is never
opened or run, and an app bundle is shown, not launched. A name is read
against the directory the terminal was in when the line was printed, and
against `dir`'s ` Directory of …` heading above it. Where NexTerm knows the
command — zsh, bash and PowerShell report it, and cmd's prompt line shows it
— it also follows an `ls -R` heading and the one folder an `ls` or `dir` was
given, and offers no names at all in output from `ssh`, `docker exec` or
`wsl`, which are another machine's. Nothing is looked up until the key is
held, and plain clicks and selection work as before.

**Drop a file to type its path.** Drag files or folders from Windows Explorer
or Finder — or a row from NexTerm's own Explorer — onto a terminal, and their
full paths are typed into that pane's active terminal: quoted only when
needed and the way its shell reads them (`"…"` for cmd, `'…'` for PowerShell
and bash), one space between them, no trailing space, nothing run. Git Bash
and Cygwin get `C:/…`, WSL gets `/mnt/c/…`. It arrives as a paste, so a
program that asked for bracketed paste — OpenCode, Claude Code — gets one
paste, not keystrokes. The pane lights up while something is over it;
dropping anywhere else does nothing, and nothing is ever moved or copied. A
name holding a newline or another control character is left out rather than
typed, because in a shell without bracketed paste it would run whatever
followed. In a shell NexTerm does not recognise, only paths that need no
quoting are typed.

**Make the text bigger.** `⌘=` and `⌘-` step the terminal and editor font
together, `⌘0` puts them back. While the size is not the default, the status bar
says so and clicking it resets.

#### macOS text-editing keys

On macOS the keys that move and delete in every text field work at a shell
prompt too. Settings ▸ Terminal ▸ *macOS Text-Editing Keys* is **on by
default**:

| Key | Sent as | Does, in zsh, bash and fish |
|---|---|---|
| `⌘←` | `Ctrl+A` | go to the start of the line |
| `⌘→` | `Ctrl+E` | go to the end of the line |
| `⌘Backspace` | `Ctrl+U` | delete to the start of the line |
| `⌘Delete` (`Fn+Backspace`) | `Ctrl+K` | delete to the end of the line |

Only `⌘` and the key: with `⇧`, `⌥` or `⌃` as well it is a different chord
(`⌥⌘←` still focuses the previous pane), and a key an input method is
composing stays the input method's. A command suggestion drawn after the
cursor takes `⌘→` as it takes `→`, and accepts it.

- **Full-screen programs keep their keys.** On the alternate screen — vim,
  htop, `less`, a full-screen TUI — the four keys go to the program exactly as
  before, because there `Ctrl+A` or `Ctrl+U` is a command of that program's,
  not "start of line". So does a program that turned on xterm's
  *modifyOtherKeys* (OpenCode does): it reads its keys itself.
- **At a password prompt only `⌘Backspace` works.** While the lock shows
  ([Safety nets](#safety-nets)), `⌘Backspace` sends `Ctrl+U`, which the
  terminal itself reads as "erase the line" and so clears what was typed of
  the password. `⌘←`, `⌘→` and `⌘Delete` are left alone there, because their
  control characters would become part of the password.

Turn the setting off to give all four back to the terminal as before (xterm
sends nothing for `⌘←` and `⌘→`). Windows and Linux are unchanged: there is
no `⌘`, and `Ctrl+←` / `Ctrl+→` still move a word.

#### Option as Meta

On macOS, Settings ▸ Terminal ▸ *Use Option as Meta* makes `⌥` act as the
Meta key: `⌥` and a key send `Esc` and that key, so `⌥B` and `⌥F` move a word
in zsh and bash, `⌥D` deletes one, `⌥.` inserts the last argument, and Emacs
gets its Meta. It is **off by default**, because it costs something: while it
is on, `⌥` no longer types the characters your keyboard layout puts on it —
`™`, `€`, and on many non-US layouts `@ [ ] { } | ~` — and no longer starts
dead keys such as `⌥E` then `E` for `é`. Both `⌥` keys act alike; there is no
left/right split. A change applies to every open terminal at once.

The other `⌥` keys are the same with it on or off:

- **`⌥`-drag still selects** over a full-screen program that has the mouse
  ([Select, copy and paste](#working-in-a-terminal)): that is a mouse
  modifier, not a key.
- **`⌥Enter` still sends `Esc Enter`**, which OpenCode and Claude Code read as
  a newline.
- **`⌥←` / `⌥→` still move a word**: NexTerm sends `Esc b` / `Esc f` for them
  itself, ahead of the terminal.

Windows and Linux have no such setting: there `Alt` already acts as Meta.

#### Programs setting the clipboard (OSC 52)

tmux, vim, Neovim and a shell over ssh can copy text to your clipboard by
printing an OSC 52 sequence: the program cannot reach the clipboard of the
machine you sit at, and the terminal can. Settings ▸ Terminal ▸ *Let Programs
Set the Clipboard (OSC 52)* lets them. It is **off by default**, because
anything that can print to a terminal could then set your clipboard — a file
shown with `cat`, a log line, a server you ssh'd into — and your next paste
would run whatever it put there. Turn it on if you copy from tmux or a remote
vim.

With it on, the rules are:

- **Writes only.** A program asking to *read* the clipboard (`?`) is refused,
  and nothing is sent back to it: otherwise anything you ssh into could read
  the password you copied last. A request to *clear* the clipboard (empty or
  not valid base64) is refused too.
- **The one system clipboard.** Whichever selections the program names (`c`,
  `p`, `q`, `s`, `0`-`7`, or none), the text goes to the system clipboard; a
  request naming anything else is ignored.
- **At most 128 KiB.** More than 131072 bytes of text, or bytes that are not
  UTF-8 text, are refused whole — never cut short to fit. The first such
  refusal in a terminal prints one notice saying so.
- **Live output only.** Output a terminal received before you first looked at
  it, and restored scrollback, is ignored: what a program copied an hour ago
  in a background tab is not what you want on the clipboard now.
- **Nothing is logged.** What a program copies is never written to the log,
  kept in notifications, or saved with the scrollback.

With it off, the first time a program in a terminal tries to copy, NexTerm
prints one notice in that terminal naming the setting, so you know why the
copy did nothing; it does not repeat in that terminal until NexTerm restarts.
If a full-screen program (vim, tmux) has the screen, the notice waits until
the program leaves it, rather than drawing over it.

### Knowing what every terminal is doing

**See what the other terminals are doing.** A tab shows a pulsing violet dot
while a command is running in it and a red circled cross when the last command
failed, and a group's chip shows the same for every terminal inside it: two
shapes, so the two still differ for anyone who cannot tell the colours apart
and in Windows High Contrast. The point is the ones you are not looking at:
switching groups replaces the whole arrangement, so without this a build
finishing — or failing — in another group is invisible. Hovering says it in
words. Nothing flashes for an empty prompt line.

**Be told when something finishes.** A command that runs for more than ten
seconds in a terminal you are NOT looking at puts an entry in the status bar's
bell — name, exit code, how long it took — and clicking it takes you to that
terminal. Nothing is said about a command you watched finish, and nothing is
said about a quick one; the threshold is Settings ▸ Terminal ▸ Notify After,
and 0 turns it off.

**Be told when Claude Code is done.** Claude Code puts a spinner (◐ ◑ ◒ ◓) in
front of its terminal's title while it works and ✳ while it waits for you.
When a turn of at least ten seconds ends in a terminal you are NOT typing
into, NexTerm puts one entry in the bell — *Waiting for you after 2m 5s of
work*, and the conversation's title — and, while NexTerm is in the
background, shows a desktop notification. It reads the title, so it needs no
Claude Code setting. The turn has to stay idle for one and a half seconds
before it counts, so a stray ✳ between two frames is not taken for the end.
When Claude Code also notifies or rings the bell itself as it finishes, you
still get one entry for that moment, not two. Until Claude Code starts working
again, NexTerm's entry also takes what that terminal says next: a further
note from it — Claude Code's own, a hook's or any other program's — updates
that entry instead of adding one or a desktop notification, and an entry you
have read stays read; a ring there is not listed. Once that entry is gone
from the bell, such a note shows nothing. The threshold is Settings ▸
Terminal ▸ *Notify When an Agent Is Done*, and 0 turns it off.

#### Notifications from programs

A program can ask its terminal to tell you something: OpenCode when a session
is done, needs permission, has a question or fails; Claude Code when it needs
permission or is waiting for you. NexTerm understands the three ways programs
ask — OSC 9 (iTerm2's), OSC 99 (kitty's) and OSC 777 (Ghostty's) — and puts
what they say in the status bar's bell, unless it came from the terminal you
are typing into. While NexTerm is in the background it also shows a desktop
notification. Clicking the entry in the bell takes you to that terminal. One
terminal is heard at most once every two seconds and ten times a minute; the
rest is dropped. Settings ▸ Terminal ▸ *Notifications from Programs* turns it
all off.

Neither program does this until you tell it to:

- **OpenCode** — in `~/.config/opencode/tui.json`:

  ```json
  { "attention": { "enabled": true } }
  ```

  It notifies only while its terminal is not the one you are typing into, and
  plays its own sound. NexTerm sets `OPENTUI_NOTIFICATION_PROTOCOL=osc99` in
  every terminal, unless you set it yourself, so OpenCode sends OSC 99 even
  where the answer to its start-up question cannot get back to it.
- **Claude Code** — `/config` → notifications → *Kitty (OSC 99)*, which is the
  `preferredNotifChannel` setting (`kitty`). *iTerm2 (OSC 9)* and *Ghostty (OSC
  777)* work too. The default, *Auto*, picks by the terminal's name and has
  nothing for NexTerm, so it stays silent.
  *Terminal Bell* works as well, but only inside the app: a bell rings the
  terminal for your attention (see below) and never makes a desktop
  notification.

  This channel is no longer needed to hear that Claude Code is done: NexTerm
  reads that from its title (*Notify When an Agent Is Done*, above), with no
  Claude Code setting. It is still how Claude Code says it needs permission
  in the middle of a turn. With both on, a turn's end makes one entry: what
  Claude Code sent itself, or NexTerm's own entry taking Claude Code's words
  when they arrive after it.

A desktop notification needs the operating system to allow it — on macOS
System Settings ▸ Notifications, on Windows Settings ▸ System ▸ Notifications,
on Linux a running notification service. On Windows, Windows notifications
are for the installed app (the `setup.exe` or `.msi`): Tauri's notification
plugin, which shows them, documents its Windows support as working only for
installed apps. The portable `NexTerm.exe` is not installed, so do not count on
a Windows notification from it.
The bell works everywhere either way.

#### Which terminal wants you

Every entry in the status bar's bell belongs to a terminal, and stays unread
until you look at that terminal: it is the active one while the NexTerm window
has focus. While it is unread you can see it from anywhere:

- **An orange ring** around the pane that holds the terminal. It pulses unless
  motion is reduced (Settings ▸ Workbench, or the operating system's own
  setting).
- **A count** on the terminal's tab, on its group's chip and on its rows in the
  TERMINALS side bar.
- **The bell's number** is how many entries are unread. Unread ones are bold,
  read ones are dimmed, and the bell turns red when an unread one is a failed
  command. *Mark all read* and *Clear all* are at the top of the list.

`⌘⇧U` (`Ctrl+Shift+U` on Windows and Linux) goes to the newest unread entry's
terminal, in whatever group or pane it is, and puts the cursor there.
*Go to Latest Unread Notification* and *Mark All Notifications Read* are in the
command palette too, and both can be given other keys in Settings ▸ Keyboard Shortcuts.
On Linux the input method (IBus) may take `Ctrl+Shift+U` for itself; bind
another key if it does nothing.

Four things make an entry: a long command finishing (see *Be told when
something finishes*), a Claude Code turn ending (see *Be told when Claude
Code is done*), a program's notification (above), and the terminal bell
— the `BEL` character a program prints, which Claude Code's *Terminal Bell*
channel sends. Repeated bells from one terminal add up in one entry, and a bell
is never a desktop notification. Settings ▸ Terminal ▸ *Terminal Bell* turns
bells off. Nothing is recorded for the terminal you are typing into; with
*Flash the Terminal You Are In* on, its ring flashes once instead.

**Progress.** A program can report how far along it is with OSC 9;4, the
sequence Windows Terminal and ConEmu understand. NexTerm draws it as a thin bar
under the terminal's tab — violet while it runs, red for an error, yellow when
paused, a sliding segment when the program cannot say how far. The group's
chip, and on Windows the taskbar button, show one bar for several terminals: an
error wins over a pause, a pause over normal progress, and among equals the one
furthest behind is shown. The bar goes when the program says so, when the
command ends or when the shell exits. A shell that never reports its prompt,
like fish or sh, or one inside ssh, cannot say that a command ended, so there a
bar the program leaves behind stays until the next one replaces it or the shell
exits. Some programs send OSC 9;4 only when they believe they are in Windows
Terminal, so not every program that shows progress there will show it here.
Settings ▸ Terminal ▸ *Progress Bars* turns it off. To try it:

```sh
printf '\033]9;4;1;40\033\\'; sleep 5
```

One limit applies to all of this: a terminal is read only once it has been on
screen. A background tab of a restored session that you have not opened since
launch raises nothing until you first show it, and what it printed before that
is replayed as history, without bells or progress. Claude Code's *Working* and
*Idle* and its completion entry are the exception, as they come from the
terminal's title, which NexTerm reads even before the terminal is first shown;
what Claude Code itself printed while it waited after a turn is still read
only when you show the terminal, and then goes into that turn's entry instead
of being listed a second time.

#### The TERMINALS panel as a status board

Each terminal's row in the TERMINALS side bar has two lines. The first is the
one it always had: its name, its unread count and its folder. The second says
what it is doing right now:

- **The agent and its state.** *Claude Code* or *OpenCode* when one runs in
  the terminal, then a state, always as a symbol and a word: *Waiting* when it
  has an unread entry in the bell (that is the only thing that means waiting —
  nothing is guessed), *Error*, *In progress 40%*, *Paused 40%* and *Working*
  from the program's progress report, *Running* while a command runs,
  *Failed* when the last one exited with an error, *Exited* when the shell is
  gone. For Claude Code, its own title says more than *Running*: *Working*
  while it shows a spinner (◐ ◑ ◒ ◓) and *Idle* (○) once it shows ✳ and waits
  for you. Until its title says either, the row shows what it would for any
  command. *Waiting* still comes first, then a progress report's *Error*,
  *In progress* or *Paused*, then Claude Code's *Working* or *Idle*, then the
  rest. An idle Claude Code is not *Waiting*: a finished turn's entry in the
  bell is what makes it wait, until you have seen it.
- **How long, on an agent's row.** When the row names an agent, its state
  says how long it has held: *Working 3m* and *Idle 12m* since Claude Code
  started working or went idle, *Waiting 12m* since it went idle, and
  *Running 4m* since the agent's command started (OpenCode, whose title says
  nothing of its state). In whole minutes — *3m*, *59m*, *1h 0m*, *2h 5m* —
  never in seconds, and nothing under a minute: a state that just began says
  only *Working*. Hovering says it in words (*Working for 3 minutes*), and
  that is also what a screen reader says. Every row moves on together, once a
  minute on the minute, from one clock that runs only while a row has a time
  to count; a plain shell's row, and every row with Show Agent and Status
  off, shows no time and is not redrawn for it.
- **The git branch of its folder**, or *detached* and the commit when the head
  is detached.
- **The last notification**, dimmed once read. Hover it for the whole text
  and how long ago it came.

Each group's row counts its terminals that are waiting, running and failed,
and a group chip says the same when you hover it. A working Claude Code counts
as running; an idle one is not running and counts nowhere, and sorts with the
quiet terminals.

The branch is read from the folder's `.git/HEAD` file. No git program runs
for it, so nothing a repository configures can run, and there is no process
per terminal. It is read again when the terminal changes folder, when a
command ends in any terminal of the same repository, when the open folder's
git status changes, when the terminal's program sends a notification or rings
the bell, and when you switch to the terminal; it is never polled. There is
no branch for a folder on another machine (a network share or a mapped network
drive, including one reached through a link), for a WSL terminal (Windows
reaches WSL's files over the network), for a repository in git's newer
reftable format, for a `.git` that cannot be read, or for a branch whose name
hides invisible characters. A lookup that takes longer than three seconds
shows no branch, and that folder is not asked again until the first answer
has come back.

**Sort by Attention**, the button in the panel's header or Settings ▸
Terminal, lists waiting terminals first, then failed ones, then running ones,
in each pane and across groups. It only changes what is shown: turn it off and
your own order is back, and menu items that act on your order, such as *Close
Terminals to the Right*, are unavailable while it is on. The order holds still
while you aim: while the pointer is on a row, from a press until its click and
a possible double-click are done, while a menu from the list is open and while
you rename a row. A dot on the sort button says the list is waiting to
re-sort; moving the pointer off the rows or switching to another app lets it
catch up at once.

Settings ▸ Terminal has *Show Folder*, *Show Git Branch*, *Show Agent and
Status* and *Show Last Notification*. With the last three off, rows are one
line again.

#### Many terminals printing at once

Nothing to set up; what you notice is what does *not* happen any more.

- **No lost output, no frozen window.** When a program prints faster than
  its terminal can draw — a build log, `yes`, an agent dumping a file — NexTerm
  stops reading from it until the screen catches up, about a megabyte later.
  The program simply waits in its own write, as it would on any terminal that
  cannot keep up. Ctrl+C, typing and pasting are never held: they go straight
  to the program, and its answer shows once what was printed before it has
  been drawn.
- **The terminal you type in comes first.** Every other terminal — a pane
  beside it, another tab, a group you are not looking at — is written about
  30 times a second (cmux draws unfocused panes the same way): what arrives
  in between is drawn in one go. Click a pane or switch to it and everything
  held for it is drawn at once. Notifications, the bell and progress bars
  from those terminals arrive at most a frame or two later.
- **Out of sight is not slowed down.** A build or an agent keeps its pace
  while NexTerm is minimised or behind another app: a hidden or minimised
  window takes output as fast as it comes — up to 32 MB a terminal — and
  draws it when you come back, and on macOS the app is never napped.
- **The order is always the order printed.** A command's mark, the folder and
  branch in the side bar, the window title an agent sets and cmd's *Terminate
  batch job (Y/N)?* answer still match the output around them.

To measure it yourself, see *Performance mode* in
[TEST_INFRA.md](TEST_INFRA.md).

**Several agents at full speed.** Four terminals flooding at once no
longer freeze the window or lose output: a terminal is read no faster than
it can be drawn, its output reaches the page in batches, and terminals you
are not typing in are drawn about 30 times a second. On a Mac, typing
beside three floods echoes within 0.2 s (p95) instead of 10 s.

### Sessions: what comes back

**Session restore.** Groups, layouts, names and each terminal's `cwd` are
written to local storage and restored on next launch, without being asked.

**Save a group.** Right-click a group in the TERMINALS panel → *Save Group…*.
It lands under SAVED with its terminal count and age; right-click it to *Load
in New Group* or *Load into Current Group*.

**Save the whole session.** The 💾 on the WORKSPACES section (or *Save All
Groups…* from the empty-area menu) snapshots every group — layouts and
directories included. Double-click a saved workspace to put the session back
the way it was, or right-click → *Add Its Groups to This Session* to bring them
in alongside what you already have.

**Layout templates.** A saved group whose terminals have startup commands is a
layout template: open it and each terminal types its command the moment its
shell has drawn its first prompt — the same wait NexTerm uses before typing an
agent, so nothing is typed ahead of the prompt and echoed twice (a shell that
never reports its prompt, like fish or sh, gets it after three seconds). It is
typed as you would type it, with `Enter`, in zsh, bash, PowerShell or cmd
alike — in the default shell, since a saved group does not remember which
shell each terminal ran. Right-click the saved group → *Edit Startup
Commands…* lists its terminals with their directories and a command field
each; empty means just a shell. Saving a group fills these in for you from
what is **running** in each terminal at that moment — `npm run dev`, a test
watcher, `claude` for Claude Code, or `opencode -c` for OpenCode, which
continues the folder's latest conversation — and leaves a terminal sitting at
a prompt empty: the last command of an idle shell is what
it did, not what it is for, and opening the template would run it again. A
saved row with startup commands shows ▶ and how many, and its tooltip lists
what opening it will run.
Each command is one line — join several with `&&` or `;` — and a multi-line
paste is refused with a message rather than run line by line; control
characters are stripped. Saved workspaces work the same way (the workspace bar
→ *Edit Startup Commands of a Saved Workspace…*), and restoring one starts
every group's commands. Restoring the session at launch never runs anything: it
brings the shells back, as it offers an agent back rather than starting it.

**Editor tabs come back too.** Each folder remembers its open files — the
editor groups, which tab each shows, which is active — and reopens them at
launch or when you open that folder again (up to 50 tabs, 12 folders).
Files reopen as they are on disk; unsaved edits are not kept. A file that
has gone, grown past 50 MB or stopped being text is dropped; one that
cannot be read just then — locked, not allowed, a drive that does not
answer — is left out but remembered and tried again, for up to three
launches. Nothing waits for the tabs: they appear once their files are read
(15 seconds at most), and if you open or type in a file before then they
join its group instead of rearranging the editor. Settings ▸ Text Editor ▸
*Restore Open Editors* turns it off and forgets what was saved.

**Pick an agent conversation back up.** Quit NexTerm while OpenCode or Claude
Code runs in a terminal, and that terminal comes back offering the
conversation: *Resume* types the command that continues it. Nothing starts by
itself — an agent spends tokens — and the terminal's scrollback is not
restored, only the conversation inside the agent. It works for an agent you
typed yourself (`opencode`, `opencode -c`, `claude`, `claude --resume <id>`) as
well as one started from a pane's menu (right-click the empty part of its tab
strip → *New opencode Terminal* / *New Claude Code Terminal*); a line that
does more than start the agent (`cd x && opencode`, a pipe) is not followed.
Claude Code's conversation is always the exact one. OpenCode chooses its own
ids, but names the conversation it shows in the terminal's title; NexTerm looks
that title up with `opencode session list`, run in the terminal's own folder
(so conversations in a git repository are found), while it runs — again if
that fails — and when *Resume* is pressed. *Resume* then types
`opencode -s <id>`, never a conversation another terminal has. When NexTerm
cannot tell which conversation a terminal had — two terminals showing the same
title before either knew its id, for instance — it types nothing, says why,
and opens *Choose…* in the active pane, where conversations other terminals
hold are greyed out; the list opens without taking the keyboard from the
terminal. `opencode --continue` (the most recent conversation in the folder or
below — a whole repository from its root) is typed only when the list cannot
say which and no other OpenCode terminal is open, offered or resumed (and
still open) in the same folder, a folder above it or one below it; if the list
cannot be read at all, the offer shows OpenCode's own reason.

#### Agent sessions: every conversation run here

The offer above covers the terminals that were open when NexTerm quit. Every
OpenCode and Claude Code conversation run in a NexTerm terminal is also kept
in a list, so one from last week can be picked up too.

**AGENT SESSIONS** sits in the TERMINALS panel, below SAVED, with its count in
the header (archived entries are not counted). Each row shows the
conversation's name (the one you gave it; else the title OpenCode or Claude
Code gave it; else the start of its id; else *most recent in folder* for one
whose id was never known), which agent ran it, the folder (the full path is in
the tooltip) and when it was last used. *offered* marks one that a terminal in
this window is offering to resume. One that a terminal in this window has
open says what that terminal's row in TERMINALS says — *Working*, *Idle*,
*Waiting*, *Running* and so on, with the same symbol — or *open* when that
says nothing. From top to
bottom the section shows:

1. **Pinned** entries, newest first, each with a pin. A pinned entry in a
   group names its group on its second line.
2. Each **group**, in the order they were made, as a header with its name and
   the number of rows under it; a click folds or unfolds it, and NexTerm
   remembers that across restarts. Under the header, one level deeper, are its
   members that are neither pinned nor archived, newest first. An empty group
   shows 0.
3. The **other** entries, newest first. The first 15 are listed; *Show all
   (N)…* opens every entry in the palette.
4. **Archived (n)**, when anything is archived: closed each time the
   TERMINALS view opens, which is when NexTerm starts and also when you go to
   another side-bar view and come back; a click opens it and lists the
   archived entries, newest first.

The hint about how the list fills shows when there is no group and no entry
outside *Archived*.

- A click selects a row. A double-click or `Enter` resumes it in a **new
  terminal** in the active pane, started in the entry's folder. Once the shell
  shows its first prompt, NexTerm types `claude --resume <id>` or
  `opencode -s <id>`. An entry without an id follows the rules of *Resume*
  above, `opencode --continue` included.
- Right-click a row for its menu:
  - *Resume in New Terminal*, or *Show Its Terminal* when a terminal in this
    window has it — the same as a double-click.
  - *Fork Conversation* (Claude Code only) continues the conversation as a
    **new** one and leaves the original as it was. It always opens a new
    terminal in the entry's folder, even when another terminal has the
    original, and once the shell shows its first prompt it types
    `claude --resume <id> --fork-session --session-id <new id>`. The fork gets
    its own row, and its tooltip says *Forked from* the original's name (or
    its short id when the original is no longer listed). If Claude Code never
    saved the original, a new conversation is started instead and the
    terminal says so. Nothing is typed into a password prompt. It is off for
    OpenCode entries and for an entry whose id NexTerm never learned, and it
    stays on for a list a newer NexTerm wrote. A `--fork-session` line you type
    yourself is recorded the same way.
  - *Copy Session ID* copies exactly the conversation's id, ready for
    `claude --resume <id>` or `opencode -s <id>` in any terminal. It is off for
    an entry whose id NexTerm never learned.
  - *Pin* / *Unpin* moves the entry into or out of the pinned area.
  - *Rename…* edits its name in place: `Enter` or clicking away keeps it,
    `Escape` leaves it as it was. Your name beats every title the agent
    gives it; the agent's titles keep being recorded underneath (the tooltip
    shows the agent's own), and renaming it to nothing brings back the newest
    one. A name is kept the way a title is (see *Privacy*).
    If the session leaves the list or its row is hidden while you type (an
    OpenCode session learning its id, or another NexTerm changing the list),
    the editor closes without saving and a notice in the bottom corner shows
    the name that was not saved.
  - *Move to Group ▸* lists every group with its count (the entry's own is
    off), *New Group…* — a group named *New Group* (or *New Group 2*, …) with
    the entry in it, its name ready to type — and *Remove from Group*.
  - *Archive* hides the entry from the lists above and puts it under
    *Archived*, keeping its name, pin and group; *Unarchive* puts it back as
    it was. Resuming an archived entry — from the list, the palette or a
    restored terminal's *Resume* — unarchives it, and so does the same
    conversation starting again in a terminal (for an entry without an id, its
    agent started again in its folder); a new title or the agent exiting does
    not. Archiving alone does not keep a session: an archived session that is
    not pinned, named or in a group leaves the list like any other once 200
    newer sessions that are not pinned, named or in a group are listed (at the
    next recorded session event), so pin it, name it or put it in a group to
    keep it.
  - *Delete…* asks, then removes the entry from NexTerm's list only. The
    conversation stays with Claude Code or OpenCode, and NexTerm deletes none
    of their files. It is off while a terminal in this window is running that
    conversation, which would only list it again.
- Right-click a group's header for *Rename Group…* (an empty name keeps the
  old one) and *Delete Group…*, which asks, then deletes only the group: its
  sessions go back to the list.
- Right-click the AGENT SESSIONS header for *Resume Agent Session…*, *New
  Group…* (an empty group, its name ready to type; at most 50 groups) and
  *Clear Agent Session History…*, which asks first and empties the whole list,
  archived entries and every group included. Clearing only changes NexTerm's
  list, and a conversation that is still running is listed again when it next
  does something.
- In the command palette, *Resume Agent Session…* lists the pinned entries
  first, then the rest newest first, then *archived agent sessions*. A grouped
  row names its group after the folder. Type to filter by name, title, group,
  agent, folder or the start of an id; `Enter` resumes. In the ordinary
  palette, typing also shows up to five matching entries under *agent
  sessions*, never an archived one. *Clear Agent Session History…* is a
  palette command too. So is *Fork Conversation*, listed while the active
  terminal runs or offers back a Claude Code conversation: it forks that
  conversation into a new terminal, as the row menu does. It has no default
  shortcut.
- When NexTerm cannot change the list (for instance a 201st entry pinned,
  renamed or put in a group), a notice in the bottom corner says why, and the
  list is read again.

**Already open: switch, don't open twice.** If a terminal in this window
already has that conversation, running or offered, NexTerm switches to that
terminal and says so instead of opening a second one into the same
conversation. This also applies to an entry without an id when a terminal has
the same agent, folder and title. When a folder no longer exists, nothing is
opened, a notice says why, and the entry stays in the list. A terminal that
cannot start in the entry's own folder is not opened somewhere else instead:
nothing is typed, and a notice says so. Notices appear in the bottom corner of
the window until you dismiss them. If the new terminal turns out to be asking
for a password, nothing is typed into it and the offer to resume stays on
screen (the entry is marked *offered*); the history records the conversation
as ended again, not as running.

**Claude Code titles.** A Claude Code entry is named the way Claude Code names
the conversation in its own list: by the title Claude Code generated for it,
or, before it has one, by the last prompt sent. While Claude Code runs in a
NexTerm terminal, the row follows the title Claude Code puts in the terminal's
title (`✳ <title>` while waiting, `◐ <title>` while working), as soon as that
text changes and with no quit needed; its default *Claude Code* is not a
title, and a working spinner writes nothing. NexTerm also reads titles from
Claude Code's own transcript (`projects/<folder>/<id>.jsonl` in
`CLAUDE_CONFIG_DIR` when NexTerm's own environment sets it, otherwise in
`~/.claude`, `%USERPROFILE%\.claude` on Windows). It does so when the list is
loaded (at start-up and when *Resume Agent Session…* opens) and when a Claude
Code agent exits or its terminal closes. The transcript is only read, never
changed, and only its last 256 KiB. A transcript or folder that is a link is
not followed. Only the title is kept, masked like an OpenCode title (see
*Privacy* below). Once kept, a title stays, even after the transcript is gone.

**A Claude Code session that never saved a conversation.** Claude Code saves a
conversation only once its first message is sent. A New Claude Code Terminal
that was closed or quit before that has an id but no conversation, and
`claude --resume <id>` would only print `No conversation found with session
ID`. So before NexTerm types a resume, whether from this list or from a
restored terminal's *Resume*, it checks Claude Code's transcripts:

- If Claude Code's `projects` folder can be read, none of its folders holds
  that conversation, and Claude Code's own `session-env/<id>` folder shows
  that the session did start, NexTerm starts a **new** Claude Code
  conversation in that terminal instead (`claude --session-id <new id>`, as
  New Claude Code Terminal does), says so in the terminal (and, for a pick
  from this list, in a notice), and drops the old entry from the list.
- In every other case NexTerm cannot tell, and types `claude --resume <id>`
  as before: no `projects` folder, no `session-env/<id>` folder (NexTerm may be
  looking at another config folder than your shell's, for instance when
  `CLAUDE_CONFIG_DIR` is set only in your shell profile), something unreadable
  or a link, or no answer within about 2 seconds.

When the list is loaded, an entry whose conversation was never saved, by the
same test, is removed from it, unless a terminal in this window is running or
offering it, or it is pinned, renamed or in a group. When a resume starts a
new conversation in place of such an entry, the new one takes over its name,
pin and group.

**Where it is kept.** `agent-sessions.json` in NexTerm's local data folder:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/com.nexterm.ide/` |
| Windows | `%LOCALAPPDATA%\com.nexterm.ide\` (local, not the roaming profile: the conversations exist only on this machine) |
| Linux | `$XDG_DATA_HOME/com.nexterm.ide/` (usually `~/.local/share/com.nexterm.ide/`) |

The list keeps the **200** most recently used sessions, plus up to **200** that
are pinned, renamed or in a group, which are never dropped for the count. An
older session that is unpinned, has its name cleared or is taken out of its
group (also by *Delete Group…*) leaves the list the next time NexTerm records a
session event, if it is then beyond the 200 most recent. Archiving does not
count: an archived session that is not pinned, named or in a group leaves the
list like any other once 200 newer sessions that are not pinned, named or in a
group are listed (at the next recorded session event); pin it, name it or put
it in a group to keep it. The file is also kept
under **1 MiB**, the most NexTerm will read, by dropping the least recently
used entries that are not pinned, renamed or grouped first, never the one just
written.

While there is no group and no entry is pinned, renamed, grouped or archived,
the file has format version 1, exactly as NexTerm 0.26.0 writes it. Anything
of these makes it version 2; once none is left (or after *Clear Agent Session
History…*), it is version 1 again.

**When the file is lost or damaged.** If the file was deleted, the list starts
empty again. If it cannot be read (not valid JSON, cut short, over 1 MiB), it
is moved aside as `agent-sessions.json.bad-<time>` and a new, empty list is
started. Only the three newest copies are kept. *Clear Agent Session History…*
deletes those copies too. If a newer NexTerm wrote the file, this one reads it
but changes nothing: the list is shown, and *Pin*, *Rename…*, *Move to Group
▸*, *Archive*, *Delete…*, *New Group…*, *Rename Group…*, *Delete Group…* and
*Clear Agent Session History…* are off and say why; the palette's *Clear Agent
Session History…* then asks nothing and only shows a notice saying why. A click
on a group header still folds or unfolds it, but only on screen: whenever the
TERMINALS view opens again (as for *Archived* above), each group is shown as
the file has it.

**Going back to an older NexTerm.** NexTerm 0.26.0 reads a version 2 file as
one written by a newer NexTerm: it shows the newest 200 entries, without their
names, pins, groups or archive; the others stay in the file, which it does not
change. It records no new sessions until NexTerm is updated again, so nothing
curated is lost. A list with nothing curated stays version 1 and keeps working
in 0.26.0 as before.

**Privacy.** A title, OpenCode's or Claude Code's, and a name you give an
entry, is kept as one line of at most 200 characters (a group's name, at most
100), after the same secret masking as saved scrollback, so a token in a title
is stored as `[hidden]`. Of Claude Code's transcript, NexTerm
reads only the title records described above, and nothing else from it is
kept, logged or shown. On macOS and Linux the file can be read only by you
(`0600`). It holds folder paths, conversation ids, titles and times, and
nothing from the terminal's output.

#### Output after a restart

Reopen NexTerm and every terminal of the session you closed starts with
what it printed last time, under a dim line:

```
── Previous output · Nov 7, 2026, 10:42 AM ──
```

- **Text, not programs.** The output comes back with its colours and styles;
  the shell is a new one and nothing in it runs. A full-screen program's
  screen — OpenCode, vim, less — is not kept, only what the shell printed
  around it. On Windows 10, which does not pass the full screen on, its last
  frames may come back as text.
- **On Windows it sits just above the screen.** ConPTY clears the screen and
  draws the prompt by position as a shell starts, so the restored lines go
  into the scrollback: the prompt starts at the top, and the separator is
  one line up.
- **It reads like any output.** It rewraps when the pane is resized, ⌘F /
  `Ctrl+F` finds in it, and file names and URLs in it can be clicked
  (resolved from the terminal's folder). Links a program sent as OSC 8,
  command marks, the sticky command line and the prompt marks on the
  scrollbar do not come back, nor do the marks of messages sent to Claude
  Code; marks start again at the new shell's first prompt, below the
  separator, and new messages are marked again. Each restart
  adds its own separator; the oldest lines leave as the scrollback fills.
- **Only the session's own terminals.** Opening a saved group, a layout
  template or a workspace, a new tab or a split starts empty.
- **When it is saved.** A second after a terminal stops printing (but not
  sooner than five seconds after its previous save), every ten seconds while
  it keeps printing, at once when it is cleared (⌘L / *Clear Terminal*, or
  `clear`, Ctrl+L, `reset` in the shell — at most every two seconds), and when
  the window is closed — the ✕, File ▸ Exit,
  `Ctrl+Shift+W`, Alt+F4, the taskbar — which waits for it (at most a second
  and a half; the window is not brought forward for it). Quitting a Mac with
  ⌘Q, the Dock or a logout does not wait: a logout must never be held up by
  it. Then, and after a crash, Task Manager or Windows shutting down, what
  changed since the last save is missing: at most the last five seconds, or
  ten of a terminal that never stopped printing. A terminal of the restored
  session that you have not opened since keeps what it had, and so does one
  whose file could not be read in time at the start.
- **Where.** One file per terminal, in the app's local data folder:
  `~/Library/Application Support/com.nexterm.ide/scrollback` on macOS,
  `%LOCALAPPDATA%\com.nexterm.ide\scrollback` on Windows (local, so a roaming
  profile does not carry it), `~/.local/share/com.nexterm.ide/scrollback` on
  Linux, readable only by you on macOS and Linux, and left out of Time
  Machine. At most 2 MB and the *Scrollback* setting's lines per terminal,
  50 MB in all (the oldest files go first). Closing a terminal deletes its
  file; at start, files of terminals that are not coming back are deleted. A
  second NexTerm started while one is open neither saves nor restores output
  until it is started again with the first one closed.
- **Secrets.** Before a file is written, strings shaped like credentials are
  replaced with `[hidden]`:
  - keys and tokens by their prefix: OpenAI and Anthropic (`sk-…`), GitHub
    (`ghp_…`, `github_pat_…`), Slack (`xoxb-…`, webhook URLs), AWS (`AKIA…`,
    and a bare secret access key), Google (`AIza…`, `ya29.…`), GitLab, npm,
    Stripe, Hugging Face, Groq, SendGrid, Vault, DigitalOcean, Shopify, PyPI,
    age, JWTs, Discord webhooks;
  - values by their name — `NAME=value`, `NAME: value`, `"name": "…"` (spaces
    and all) — where the name holds `PASSWORD`, `SECRET`, `API_KEY`,
    `PRIVATE_KEY`, `CREDENTIAL`, or a part `PASS`, `TOKEN`, `AUTH`, `DSN`,
    `COOKIE`, `SIG`, or is an `APP_KEY`-style key;
  - the password in `scheme://user:password@host`, `Authorization: Bearer …`,
    and passwords on command lines (`--password X`, `mysql -pX`, `7z -pX`,
    `sshpass -p`, `docker login -p`, `mongosh -p`, `redis-cli -a`,
    `sqlcmd -P`, `zip -P`, `openssl -k`, `smbclient -U user%X`,
    `curl -u user:X`, `pass:X`, `.netrc`);
  - private keys — PEM, PGP, PuTTY — and base64 of a PEM block (`kubectl get
    secret`), also with a line number, a file name or a time stamp in front
    of each line, and when the top of the block has already scrolled away;
  - a token a program broke onto the next line at the pane's edge.

  A secret with no recognisable shape — a base64 value under an ordinary
  name, a password typed as prose — is not caught: the file is as private as
  your shell history.
- **Off.** Settings ▸ Terminal ▸ *Restore Scrollback* (on by default) turns
  it off and deletes every saved file; *Clear Saved Scrollback* deletes them
  and keeps saving from then on.

### Project commands

**Run a folder's own commands.** Put the commands a project is worked with in
`.nexterm/commands.json` at the top of the folder:

```json
{
  "version": 1,
  "commands": [
    { "name": "Run the tests", "command": "npm test" },
    {
      "name": "Run one test file",
      "description": "The file is asked for, with this one filled in",
      "command": "npm test -- {{file}} --reporter {{reporter}}",
      "placeholders": {
        "file": { "label": "Test file", "default": "src/app.test.js" },
        "reporter": { "choices": ["dot", "spec"], "default": "spec" }
      }
    }
  ]
}
```

*Open Project Commands File* in the command palette opens it, and writes this
example first when the folder has none. Each command has a `name` (one per
file), an optional `description` and a `command` — **one line**: join several
with `&&` or `;`, or put them in a script, because a second line typed into a
shell goes to whatever the first one started. `{{name}}` is a blank (letters,
digits, `_` and `-`); anything else in double braces, `{{.Names}}` or
`{{ x }}`, is text, so Docker and Go templates pass through. A blank may be
declared under `placeholders` with a `label`, a `description`, a `default` and
`choices`; one that is not declared is a plain field. A blank stands where a
word starts, because NexTerm quotes the value itself: not inside quotes
(`"note: {{m}}"` — the value's quotes would be literal there, or close the
command's), not right after `\`, `^`, `` ` `` or `$`, not after PowerShell's
`--%`, and not touching another blank. An empty value types nothing, so a
blank can stand for an optional argument. A `!` followed by text (`!!`,
`!$`, `!word`) outside single quotes is refused, and so is a line starting
with `^`: at an interactive bash or zsh prompt those are replaced by earlier
commands before the line runs.

**Nothing in that file runs until you have read it.** A folder's commands
are somebody else's text that ends up in your shell, so the palette first
offers *Review This Folder's Commands…*: every command's full line, and every
entry NexTerm refused with the reason — a key it does not know (a typo such as
`comand` is never ignored), a second line, a control character, a space that is not a
plain space, or a bidi or invisible character that would make the line read
as something it does not run. Lines are shown in the order they are typed,
right-to-left letters included. *Trust* remembers that content in that folder; change one byte — a
`git pull` — and it is asked again. *Stop Trusting This Folder's Commands*
forgets it. A `.nexterm` or `commands.json` that is a link is not followed,
and a folder on another computer or a network drive is not read at all.

**Picking a command never runs it straight away.** It opens its blanks, the
terminal it goes to — the one you are in, or a new split — and the exact line
that will be typed, quoted for that terminal's shell and named (cmd,
PowerShell, zsh): `"…"` for cmd, `'…'` for PowerShell and the POSIX shells,
bare when nothing needs quoting. A value that shell cannot be given safely is
refused with the reason instead of typed: in cmd a `"` (it cannot be written
inside quotes), a `%` (cmd expands `%…%` even inside quotes) or a `!`; in
PowerShell a `"`, which Windows PowerShell hands to programs unescaped, and
`--%`, which it takes as "stop parsing" even in quotes; in
both, a character Windows turns into `"` or `\` for programs that read their
command line in the system code page (`₩`, `¥`, the fullwidth quote and
backslash). In a WSL terminal a `\` or `'` is refused, since NexTerm cannot
see whether the distribution starts bash or fish; in Git Bash a value that
starts with `/`, which it rewrites into a Windows path. *Run*
types the line and Enter into a **new split** — a fresh shell, where nothing
is typed yet; the keyboard moves there once the line is in. Into the terminal
you are in, the line is only typed (*Type Only*) and left for you to press
Enter: from outside a shell NexTerm cannot be sure its prompt is empty — keys
typed while a command ran, the rest of a paste, an open quote — and whatever
is there then shows in front of the line instead of running with it. That
terminal is not offered at all while something runs in it (an agent, a
server), while NexTerm knows text is typed at its prompt or that the shell is
still waiting for the rest of a line, or when its shell does not report its
prompt (fish, sh, a WSL terminal). The terminal is the one the dialog was
opened for: while it is open, NexTerm's shortcuts and menu do nothing, and if
that terminal closes, the dialog says so rather than picking another. A
terminal asking for a password is never typed into.

**Your own commands, everywhere.** Settings ▸ Terminal ▸ *User Commands* takes
the same JSON and lists them in the palette in every folder, marked *User*
(a project's are marked *Project*). What is wrong with them is said under the
field as you type.

### Coding agents

NexTerm runs any program, and has a few things for OpenCode and Claude Code
in particular. Where to find each one:

| To | Where |
| --- | --- |
| start one in a new terminal | type it, or right-click the empty part of a tab strip → *New opencode Terminal* / *New Claude Code Terminal* |
| hear when it is done or needs you | [Notifications from programs](#notifications-from-programs) — each agent needs one setting turned on |
| see what each one is doing | [The TERMINALS panel as a status board](#the-terminals-panel-as-a-status-board) |
| type a newline in OpenCode | `Shift+Enter` — see [Keyboard shortcuts](#keyboard-shortcuts) |
| select text inside Claude Code | just drag — see [Working in a terminal](#working-in-a-terminal) |
| paste an image (Windows) | `Alt+V` in Claude Code; a right-click in OpenCode — see [Keyboard shortcuts](#keyboard-shortcuts) |
| have its hooks tell NexTerm things | [`nexterm-cli`](#control-nexterm-from-a-terminal) |
| keep the computer from sleeping while Claude Code works | Settings ▸ Terminal ▸ *Keep the Computer Awake While an Agent Works* (off by default; never the display) — see [Settings](#settings-and-themes) |
| pick its conversation up after a restart | *Resume* — see [Sessions](#sessions-what-comes-back) |
| go back to any conversation run here | AGENT SESSIONS in the TERMINALS panel, or *Resume Agent Session…* in the palette — see [Agent sessions](#agent-sessions-every-conversation-run-here) |
| try another direction without losing a Claude Code conversation | *Fork Conversation* in an AGENT SESSIONS row's menu or in the palette — a new conversation in a new terminal; see [Agent sessions](#agent-sessions-every-conversation-run-here) |
| start several at once | a [layout template](#sessions-what-comes-back) with `opencode -c` or `claude` |
| run several without freezing the window | [Many terminals printing at once](#many-terminals-printing-at-once) |
| leave OpenCode with `Ctrl+C` in cmd | [Safety nets](#safety-nets) — cmd's *Terminate batch job* question is answered |

### Control NexTerm from a terminal

Programs running in a NexTerm terminal — an agent's hooks, a build script —
can talk to NexTerm with `nexterm-cli`, which comes with the app and is on the
`PATH` of every shell NexTerm starts, from a folder that holds nothing else
(its full path is in `$NEXTERM_CLI`):

```sh
nexterm-cli notify "Tests" "All 412 passed"     # a notification from this terminal
nexterm-cli set-status "Running migrations"     # this terminal's line in the side bar
nexterm-cli set-title "Deploy staging"         # what this terminal's tab is called
nexterm-cli set-title --clear
nexterm-cli set-progress 40                     # the progress bar on its tab
nexterm-cli set-progress --clear
nexterm-cli list                                # the terminals in this window
nexterm-cli new-split --down -- npm run dev     # a split of this terminal (its folder and shell)
nexterm-cli focus child:tab-term-7              # point the user at a terminal
```

A Claude Code hook that says when it is done, in `.claude/settings.json`:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "nexterm-cli notify 'Claude Code' 'Done'" }] }] } }
```

NexTerm now tells you when Claude Code is done without any hook (see *Be told
when Claude Code is done*). A hook like this one that runs more than 1.5
seconds after Claude Code shows ✳ can be refused as rate-limited, because
NexTerm's own completion entry used that terminal's allowance first (see
`notify` below).

More hooks for the same file. `PermissionRequest` runs at once, when Claude
Code asks for your permission, so you hear about it without waiting for the
turn to end; `StopFailure` runs when a turn ends on an API error instead of
finishing; `UserPromptSubmit` clears the line when you send your next
message:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "nexterm-cli notify \"Claude Code\" \"Needs your permission\"" },
          { "type": "command", "command": "nexterm-cli set-status --tone warn Waiting for permission" }
        ]
      }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "nexterm-cli set-status --tone error Stopped by an API error" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "nexterm-cli set-status --clear" }] }
    ]
  }
}
```

Merge these entries into the `"hooks"` object your settings already have.
JSON writes a double quote inside a string as `\"`; the command the shell gets
has plain double quotes, and bash, PowerShell and cmd all read each quoted
text as one argument. `set-status` joins its words, so its text needs no quotes at all.
Each command is an entry of its own rather than two joined with `;` or `&&`,
which cmd and PowerShell read differently, so `notify` being refused as
rate-limited (exit 5) does not stop the status line. `nexterm-cli` prints
nothing when it succeeds. Writing `$NEXTERM_CLI` (its full path, see above)
instead of `nexterm-cli` is optional — for a hook whose `PATH` finds another
one first.

- **NexTerm never edits your Claude Code settings.** It does not write
  `.claude/settings.json`, in your project or your home folder, nor any other
  Claude Code file: these hooks are there only if you add them yourself.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` turns these hooks off.** With it
  set, Claude Code removes `NEXTERM_CONTROL_TOKEN` from the environment its
  hooks run in, so every `nexterm-cli` call in a hook exits 3 ("Not inside a
  NexTerm terminal") and nothing is shown or set. NexTerm's own completion
  entry (*Be told when Claude Code is done*) needs no token and still comes.
- **When a status and a title go.** A status line (`set-status`) and a title
  (`set-title`) stay until `--clear`, until the shell exits or a new shell
  starts in that terminal, or until the terminal closes. And what a program
  said while an agent ran goes when that agent ends: at the first command
  end (OSC 133 D) the shell reports while the agent is running, NexTerm
  drops the status and the title set since the agent was started — by
  NexTerm (New Claude Code Terminal, Resume, Fork) or typed by hand at the
  prompt — and marks that terminal's notes from then on read (`notify`, and
  what its programs printed as OSC 9, 777 or 99), so its row no longer says
  *Waiting*. NexTerm's own completion entry stays unread, and anything set
  before the agent started stays. Two limits: Ctrl+Z suspending
  the agent counts as it ending, and an agent NexTerm cannot watch — typed
  before the shell drew its first prompt, in a shell without OSC 133 (fish,
  sh), or offered back after a restart and never resumed — never ends this
  way, so what it reported stays until one of the others.

`nexterm-cli help <command>` explains each one; `--json` prints NexTerm's
answer for scripts. It exits 0 when done, 2 for wrong usage (found by the
tool or by NexTerm — nothing was done), 3 outside a NexTerm terminal, 4 when
refused (not allowed, no such terminal), 5 when NexTerm is busy (a rate
limit), not running, not answering, or has its control turned off — try
again later.

`nexterm-cli guide` is a short guide for agents and scripts: which command
to use when (`notify` when the user is needed, `set-status` and
`set-progress` while the agent works, `set-title` once per task,
`new-split` for a server, `read-screen` and `send` with the switches they
need below), with examples and what each exit code means for the caller.
`nexterm-cli guide <topic>` prints one of `notify`, `set-status`,
`set-title`, `set-progress`, `new-split` and `read-screen`; another word
exits 2 and lists them. Like `help`, it comes from the tool itself: it
needs no NexTerm and no `NEXTERM_CONTROL`, sends nothing and writes no
file, so it works in any console, and you can tell an agent to run it
instead of pasting the flags into its instructions. It is plain ASCII
text, the same in cmd and PowerShell.

- `notify` counts against the one allowance a terminal's notes have, which
  what its programs print uses too: once every 2 seconds, 10 times a minute.
  NexTerm telling you that Claude Code is done there uses it as well, so a
  `notify` from that terminal within 2 seconds of that completion is refused
  as rate-limited (exit 5). One that gets through later, before Claude Code
  works again, only updates NexTerm's entry for that completion, if it listed
  one.
- `list` gives each terminal's `status`, the state its TERMINALS row shows:
  `exited`, `waiting`, `error`, `progress`, `working`, `idle`, `running`,
  `failed` or `none`. A Claude Code terminal reports `working` or `idle`
  once its title says which, where it used to report `running`.
- `set-title` names the caller's own terminal: its tab, its TERMINALS row,
  the handle of a hidden tab strip and its `title` in `list`. A name you gave
  the tab yourself (Rename) always wins — the program's title shows only on a
  tab you have not named, and clearing your name (an empty Rename) shows it
  again. It lasts until `set-title --clear`, until the shell exits, until a
  new shell starts in that terminal, or until the agent that was running
  when it was set ends (see *When a status and a title go* above); each of
  those brings back `Terminal N`.
  One line, control characters dropped and secrets such as `*_TOKEN=...`
  masked. A text over 200 characters is refused — `nexterm-cli` exits 2
  (wrong usage, found by NexTerm) and nothing is set — and NexTerm may
  shorten a title further when masking made it longer. It is never saved: a
  restored workspace, a saved group and a saved workspace come back with
  their own names. The mark of a terminal a program controlled and the
  control log name the caller and the target by NexTerm's own names — yours,
  else `Terminal N` — never by a title a program set, so a program cannot
  pass as another terminal.
- A new split opens beside the terminal that asked, in its folder and shell,
  and the keyboard stays where you are. At most 8 open at a time per
  terminal, 32 in all, 10 a minute.
- `focus` points you at a terminal and never moves the keyboard: it flashes
  that terminal and marks it, and with NexTerm in the background asks for
  your attention (Dock, taskbar). It never switches tabs or pulls the window
  over other apps — a program cannot catch what you type next.
- From WSL the tool is `nexterm-cli.exe`, and `--cwd` takes a Windows path.
  In Git Bash, a text starting with `/` (an agent's `/help`) is rewritten into
  a Windows path by MSYS; prefix the command with `MSYS_NO_PATHCONV=1`.

**Typing and reading** are off until you turn them on:

```sh
nexterm-cli send "npm test" --keys Enter        # type into this terminal
nexterm-cli send --to child:tab-term-7 --keys Ctrl+C
nexterm-cli read-screen --lines 200             # what a terminal shows, secrets masked
```

Keys follow what the program there asked for (application cursor keys,
Shift+Enter for OpenCode). One line break at the end is Enter, so
`echo npm test | nexterm-cli send -` types the command and runs it; several
lines go as one paste where the program asked for bracketed paste and are
refused elsewhere unless you pass `--raw`. Keys cannot spell an escape
sequence (Escape then `[`, also across two calls). Nothing is typed into a
password prompt (the terminal says when input is hidden on macOS and Linux;
NexTerm also reads the prompt line — `Password:`, `pass phrase`, `PIN`,
`암호:`, `비밀번호:`), into a terminal where anything in the foreground runs
as another user or elevated (sudo, su, gsudo — NexTerm looks at every
process there), or into a terminal you have not opened since NexTerm
started.

**Who can do what.** Settings ▸ Terminal ▸ *Control*:

| Setting | Default | Opens |
| --- | --- | --- |
| Let programs in terminals control NexTerm | on | notify, status, title, progress, list, new split, focus |
| Let programs type into and read terminals | off | `send`, `read-screen` and a `new-split` that types a command (`-- …`) |
| Let programs control other terminals | off | any terminal, not only the caller and the splits it opened; an unmasked `read-screen` |

- **Only from NexTerm's own terminals.** Each shell NexTerm starts gets a token
  of its own (`NEXTERM_CONTROL_TOKEN`) that dies with it; a call without one is
  refused. A terminal acts on itself and on the splits it opened; any other
  terminal needs the third setting.
- **Only as you, only on this computer.** No network port: a Unix socket in a
  folder only you can open (macOS, Linux), a named pipe only your account can
  open that refuses other computers (Windows). NexTerm checks who connected,
  and `nexterm-cli` checks it is talking to a NexTerm of yours before it sends
  the token. A web page cannot reach either.
- **The token is in the environment.** Any program in that terminal can use
  it, and `env` prints it — it is masked in the saved scrollback, but do not
  paste such output elsewhere. ssh, docker and sudo do not pass it on unless
  told to; off this computer it is useless.
- **You see it.** A terminal typed into, read, focused or opened by a
  program — another terminal's or its own — flashes and shows a small mark
  naming the caller for ten seconds (on the tab, or on the strip's handle
  when the tab strip is hidden); the
  palette's *Show Control Log* lists the last 500 calls (what, who, which
  terminal, how much — never the text typed or the screen read). Calls are
  rate-limited.
- **Off.** Turning the first setting off closes the socket or pipe and voids
  every token; terminals started while it was off have none until restarted.

### Safety nets

Three guards are described where they belong: file commands stay inside the
open folder and Delete goes to the Trash
([Folders, files and the editor](#folders-files-and-the-editor)), secret-looking
strings are hidden before output is saved
([Output after a restart](#output-after-a-restart)), and packaged builds refuse
the reload keys, which would end every shell
([Keyboard shortcuts](#keyboard-shortcuts)). The rest are here.

**A lock marks a password prompt.** On macOS and Linux, while a program in a
terminal reads input without showing it — `sudo`, `ssh`, `read -s`, a
password prompt — its tab, its row in the TERMINALS panel and, with the tab
strip hidden, the pane's handle show a lock: "Typing is hidden (password
prompt)". NexTerm tells this from the terminal's own settings: input that is
neither shown nor read a line at a time is how every shell's line editor and
every full-screen program works, so only hidden input read line by line
counts. While the lock is on, nothing NexTerm types for you goes into that
terminal — a layout's startup command, an agent's start or resume, the answer
to cmd's batch-job question. It waits for the prompt to be answered, and if
the terminal is still asking when the wait runs out, it is not typed and the
terminal says why. What you type and paste is never held back, so a password
manager still works. Windows gives no way to read this from outside a console
program, so there is no lock on Windows.

**Pasting several lines asks first.** A paste of two or more lines into a
program that has not asked for bracketed paste — cmd never does, so each line
would run as it arrives — asks *Paste*, *Paste as One Line* or *Cancel*, with
Cancel focused so a habitual Enter does not run it. Lines of only spaces do
not count, and a paste that carries an escape sequence is always asked about;
bracketed-paste markers are stripped from everything pasted, so a pasted
`ESC[201~` cannot end the bracket early and run what follows. Settings ▸
Terminal ▸ *Multi-Line Paste Warning*: Auto, Always or Never.

**cmd's "Terminate batch job (Y/N)?" is answered for you.** OpenCode runs in
cmd through `opencode.cmd`, so Ctrl+C out of it makes cmd ask that question,
and a second Ctrl+C at it can end cmd itself. In a cmd terminal, after your
Ctrl+C, NexTerm types `Y` for you — only for cmd's own question (its `^C` beside
it, or its English or Korean wording), only one that appeared after the Ctrl+C,
and only until you type something else. Settings ▸ Terminal turns it off.

### Settings and themes

**Change settings.** The gear in the activity bar opens a VS Code-style settings
window — editor font, terminal font/size/line-height, cursor style and blinking,
scrollback, colour theme, command suggestions, copy on select, what a
right-click does, mouse reporting, *Prompt Marks on Scrollbar* (the marks
at each shell prompt and each message sent to Claude Code on the terminal's
scrollbar; on by default), and *Claude Code on the Normal Screen* (starts
terminals with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` unless it is set
already; on by default), and *OpenCode in Mini Mode* (starts and resumes
OpenCode V1 1.17.10 and newer as `opencode --mini --no-replay`; on by
default), and *Copy Context Lines* (how many lines *Copy Last N Lines (Secrets
Masked)* copies; 200 by default, 1 to 10000; very long output is cut at
`read-screen`'s 512 KiB cap, the oldest lines dropped), and *Keep the Computer Awake
While an Agent Works* (off by default: while a Claude Code terminal is
Working in the TERMINALS panel, the computer is kept from going to sleep on
its own, and let go as soon as none is — the turn ends, the agent or the shell
exits, the terminal closes or the setting is turned off. OpenCode terminals
and progress bars do not count. The display may still turn off and lock, and
closing the lid still sleeps as the system is set to. Where the system offers
no way to do it, the setting says *Not available on this system*; see
[Platform notes](#platform-notes)).

**The colours.** NexTerm has one dark palette, ActionMacro's bluish greys with
a violet accent: the side bars, the terminal and the title and status bars are
the darkest, the editor a step lighter, menus and dialogs lighter again, and
fields lighter still. Violet marks what is active (the selected tab's line, the
active pane, the activity bar, the selection in a list, progress bars and drop
targets) and fills the button to press. A text field shows that it has the
keyboard by its own border turning violet, with no outline around it. Buttons,
tabs, chips and theme cards show a light-violet ring only when you reach them
with Tab or the arrow keys, never after a click. Every pair of colours is held
to WCAG contrast (4.5:1 for text, 3:1 for lines and marks) by the test suite.

**9 terminal themes, all dark.** NexTerm Dark (the default, drawn in the
app's own colours), Monokai, Material, Dracula,
Solarized Dark, Nord, One Dark, Gruvbox Dark and Tomorrow Night — and up to 20
of your own, imported (below).

**Pick or import a terminal theme.** Settings ▸ Terminal shows every terminal
theme as a card with its colours. Point at a card, or move to it with the arrow
keys, and every terminal shows it at once; Escape, moving away or closing
Settings puts your theme back, and a click or Enter chooses it. *Import
Theme…* reads a theme you pick and switches to it: a Ghostty theme file, a Windows Terminal colour scheme
(`.json`, one scheme or a `schemes` list to choose from) or an iTerm2
`.itermcolors` file. Up to 20 imported themes sit beside the built-in ones and
can be deleted (with an undo); colours a file leaves out come from NexTerm's own. A theme with a
light background is refused, because the rest of NexTerm is dark, and so is
a file that is too large, has a colour NexTerm cannot read, or carries XML
declarations other than the one iTerm2 always writes. The import says which.
Imported themes are settings, so *Reset All* removes them too, and asks first
when there are any.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘P` / `⌘⇧P` | Go to file / all commands |
| `⌘⇧F` | Search across files |
| `⌘⇧O` | Open a folder |
| `⌥⌘O` | Open a recent folder |
| `⌘,` | Settings |
| `` ⌃` `` | Toggle the terminal panel |
| `` ⌃⇧` `` | New terminal tab in the current group |
| `⌘D` / `⌘⇧D` | Split the active pane right / down (`Ctrl+Alt+D` / `Ctrl+Shift+D` off macOS) |
| `⌘W` | Close the active terminal pane |
| `⌘⇧W` | Close the window |
| `⌥⌘←` / `⌥⌘→` | Focus the previous / next pane |
| `⌃PageUp` / `⌃PageDown`, `⌘⇧[` / `⌘⇧]` | Previous / next tab of the active pane (`Ctrl+PageUp` / `Ctrl+PageDown` off macOS; see [Switching tabs](#switching-tabs)) |
| `⌘1` … `⌘8` / `⌘9` | Tab 1 to 8 / the last tab of the active pane (macOS only) |
| `⌘⇧T` | Reopen the terminal closed last, as a new shell (`Ctrl+Shift+T` off macOS; see [Reopening a closed terminal](#reopening-a-closed-terminal)) |
| `⌃Tab` / `⌃⇧Tab` | Switch to the terminal used before, across groups; hold `⌃` to walk the list (`Ctrl+Tab` / `Ctrl+Shift+Tab` everywhere; see [Recent tabs](#recent-tabs-ctrltab)) |
| `⌘⇧Enter` | Zoom the active pane / show every pane again |
| `⌘⇧U` | Go to the latest unread notification's terminal |
| `⌘B` | Toggle the primary sidebar |
| `⌥⌘B` | Toggle the terminals side bar |
| `⌘L` | Clear the active terminal |
| `⌘F` | Find in the active terminal's scrollback |
| `⌘⇧↑` | Scroll the active terminal to the previous prompt or message sent to Claude Code (`Ctrl+Shift+↑` off macOS) |
| `⌘⇧↓` | Scroll the active terminal to the next prompt or message sent to Claude Code, or the bottom past the last (`Ctrl+Shift+↓` off macOS) |
| `⌘⇧H` | Command history |
| `⌘=` / `⌘-` / `⌘0` | Bigger / smaller / default text |
| `⌘S` | Save the active editor file |

On Windows and Linux use `Ctrl` wherever `⌘` is listed, except split right:
`Ctrl+D` is the shell's end of input, so that one is `Ctrl+Alt+D`. That is the
table out of the box — every row is rebindable.

Copy and paste in a terminal follow each platform's own terminal, and are not
in the table above (they are not rebindable):

| | Paste | Copy the selection |
| --- | --- | --- |
| macOS | `⌘V` | `⌘C` (or just select — see *Copy on Select*) |
| Windows | `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` | `Ctrl+C` **while something is selected**, `Ctrl+Shift+C`, `Ctrl+Insert` |
| Linux | `Ctrl+Shift+V`, `Shift+Insert` | `Ctrl+Shift+C`, `Ctrl+Insert` |

On Windows this is Windows Terminal's table: `Ctrl+C` with nothing selected
still interrupts, and copying clears the selection so the next `Ctrl+C` does
too. `Ctrl+V` pastes text rather than sending `^V` — Claude Code pastes an image
with `Alt+V` there, and vim's block selection is `Ctrl+Q`, as in gvim.

**Right-click copies or pastes**, as in Windows Terminal: with a selection on
screen it copies it and clears it, otherwise it pastes — text as `Ctrl+V` does,
and an image alone as the empty paste that tells OpenCode to attach it. It does
so inside Claude Code, OpenCode and vim as well, which never see the click.
`Shift`+right-click passes the click on to the program instead — on macOS;
elsewhere xterm keeps a Shift-click for selecting, so there it does nothing.
On by default on Windows; Settings ▸ Terminal ▸ *Right Click* turns it on
(*Copy or Paste*) or off (*Default*) on any platform.

**Changing a shortcut.** Settings ▸ Keyboard Shortcuts lists every command,
records the chord you press, and unbinds or resets one per row. Conflicts are
reported rather than resolved: two commands on one chord is called out, not
silently decided by which came first. What you change follows through to the
menus — the native menu bar on macOS and the ☰ menu on Windows and Linux both
print the key that actually runs the command, and the command palette shows it
too.

One thing rebinding will not do is take a control character away from the
shell. Bind something to `Ctrl+D` and the command runs from the keyboard, but
no menu item registers it as an accelerator — the window resolves its
accelerators before the terminal ever sees the key, so registering `Ctrl+D`
would cost every pane in the app its EOF. The menu shows that row without a
shortcut.

**Shortcuts yield to the shell, with a few exceptions.** A chord the terminal
needs goes to the terminal: with a pane focused, `Ctrl+D` is EOF, `Ctrl+K`
kills to end of line, `Ctrl+C` interrupts (on Windows, unless text is selected
— then it copies), `Ctrl+R` is reverse-i-search, and the app does nothing. The
same chord elsewhere in the window does what the table says.

The exceptions are the shortcuts that would be useless if they stopped working
whenever a terminal had focus — which is this app's resting state. The app
claims these ahead of xterm:

- the side-bar toggles, `⌘B` / `Ctrl+B` and `⌥⌘B` / `Ctrl+Alt+B`; otherwise
  xterm turned `Ctrl+B` into `^B` and the shortcut the menu advertises did
  nothing at all
- find, `⌘F` / `Ctrl+F`
- the zoom keys, which are punctuation and a digit and cost the shell nothing
- pane zoom, `⌘⇧Enter` / `Ctrl+Shift+Enter`. xterm sends `Ctrl+Shift+Enter` as
  a plain `Enter`, so a shell gives nothing up; a program that turned on
  *modifyOtherKeys* (OpenCode, see below) would have received it as a key of
  its own off macOS, and binds nothing to it. Inside the editor `⌘⇧Enter` stays
  Monaco's *Insert Line Above*
- the tab keys, `Ctrl+PageUp` / `Ctrl+PageDown` everywhere and `⌘⇧[` / `⌘⇧]`
  and `⌘1` … `⌘9` on macOS. They take vim's own `Ctrl+PageUp` /
  `Ctrl+PageDown` tab-page keys (see [Switching tabs](#switching-tabs))
- Reopen Closed Terminal, `⌘⇧T` / `Ctrl+Shift+T`. xterm sends nothing for
  `Ctrl+Shift+T`, so a shell gives nothing up, and `Ctrl+T` stays its own
- the recent-terminals switcher, `Ctrl+Tab` / `Ctrl+Shift+Tab` on every
  platform. xterm would send them as a plain `Tab` and `Shift+Tab`, which
  still reach the shell, so it gives nothing up

VS Code makes the same trades with the same keys. Two of them do take something
away on Windows and Linux, where `⌘` is `Ctrl`: **`Ctrl+B` will not reach tmux**
(rebind tmux's prefix, or rebind the toggle) and **`Ctrl+F` no longer moves the
cursor forward in readline** (the arrow keys still do). Both rows are rebindable
in Settings ▸ Keyboard Shortcuts. On macOS nothing is given up — `⌘` never
reaches the pty. The tab keys `Ctrl+PageUp` / `Ctrl+PageDown` are the one
trade on every platform, macOS included: they no longer reach vim as its
tab-page keys. Everything else in the table above is left to the shell.

**`Shift+Enter` for a newline in OpenCode.** A program that turns on xterm's
*modifyOtherKeys*, as OpenCode does, gets `Shift+Enter` and `Ctrl+Enter` as
keys of their own (`CSI 27;2;13~`, `CSI 27;5;13~`), so they insert a newline
there instead of submitting. Where nothing asked for that — the shell, Claude
Code — they are plain `Enter`, as before. `⌥Enter` / `Alt+Enter` sends
`Esc Enter` either way.

Packaged builds also refuse the reload chords (`F5`, `Ctrl+Shift+R`, `⌘R`).
Reloading restarts the frontend, and start-up reaps every terminal the backend
is holding, so a stray reload would kill every running shell. Development
builds still reload, because that is the point of them.

## Platform notes

### macOS

- The window keeps its traffic lights and the system menu bar, and the menu
  shows the key that actually runs each command.
- Builds are for Apple Silicon and unsigned: the first launch needs
  right-click → Open (see [Install](#install)).
- `⌘` never reaches the shell, so no shortcut takes a key away from a terminal.
  The four [text-editing keys](#macos-text-editing-keys) (`⌘←`, `⌘→`,
  `⌘Backspace`, `⌘Delete`) are sent as the shell's own `Ctrl+A`, `Ctrl+E`,
  `Ctrl+U` and `Ctrl+K` unless that setting is off.
- A lock marks a password prompt ([Safety nets](#safety-nets)).
- Quitting with `⌘Q`, the Dock or a logout does not wait for the last output
  to be saved ([Output after a restart](#output-after-a-restart)).
- *Keep the Computer Awake While an Agent Works* runs `caffeinate -i` tied to
  NexTerm's process, so it ends with NexTerm; `pmset -g assertions` lists it
  while it holds.

### Windows

**Built for Windows' ConPTY.** The backend answers ConPTY's start-up cursor
query (without it `cmd.exe` shows no prompt), and tells xterm.js the Windows
build so a pane that is resized — a split, a maximised window — is not
re-wrapped twice and does not lose lines.

- `Ctrl+C` copies while text is selected, and a right-click copies or pastes,
  as in Windows Terminal ([Keyboard shortcuts](#keyboard-shortcuts)).
- NexTerm keeps `Ctrl+B` (side bar) and `Ctrl+F` (find) for itself, so tmux's
  default prefix and readline's forward-char need another key.
- Desktop notifications need the installed app, not the portable one
  ([Notifications from programs](#notifications-from-programs)).
- There is no password lock: Windows does not let NexTerm see that a program
  is reading hidden input. `nexterm-cli send` reads the prompt line instead.
- The taskbar button shows progress, and flashes when a program asks for your
  attention.
- *Keep the Computer Awake While an Agent Works* asks Windows itself
  (`SetThreadExecutionState`, no extra process and never the display); an
  elevated `powercfg /requests` lists NexTerm under SYSTEM while it holds.
- Dropped files arrive as `C:/…` in Git Bash and `/mnt/c/…` in WSL; from WSL
  the control tool is `nexterm-cli.exe`.
- What has been checked on a real Windows PC, and how, is in
  [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md).

### Windows and Linux

**One title row.** On Windows and Linux the window is frameless and NexTerm
draws its own compact title bar — a ☰ application menu, the folder name,
command centre, layout toggles and window buttons in a single 35px row, VS
Code style, instead of a native title bar with a native menu bar under it.
macOS keeps its traffic lights and the system menu bar.

### Linux

- Builds are made on Ubuntu 22.04: AppImage, `.deb` and `.rpm`.
- The input method (IBus) may take `Ctrl+Shift+U`; give *Go to Latest Unread
  Notification* another key in Settings ▸ Keyboard Shortcuts.
- Desktop notifications need a running notification service.
- A lock marks a password prompt, as on macOS.
- *Keep the Computer Awake While an Agent Works* needs `systemd-inhibit` and
  GNU coreutils `tail` on the PATH: the sleep lock lasts as long as
  `tail --pid` waits on NexTerm, so it ends with NexTerm. Without either one
  the setting says *Not available on this system*. A `tail` with no `--pid`
  (busybox's) ends the lock as soon as it is taken; NexTerm reports the hold
  as failed when the helper has already ended by the time it looks, but it
  may end a moment later. `systemd-inhibit --list` shows the lock while it
  holds.

## Troubleshooting

**macOS will not open NexTerm.** The build is unsigned. Right-click the app →
*Open* once, or run `xattr -dr com.apple.quarantine /Applications/NexTerm.app`.

**OpenCode or Claude Code never notifies.** Neither does until you turn it on
— see [Notifications from programs](#notifications-from-programs).

**There is a bell entry but no desktop notification.** Allow notifications for
NexTerm in the operating system's settings. On Windows, use the installed
build (`setup.exe` or `.msi`); the portable `NexTerm.exe` may never show one.

**A background tab never said anything.** A terminal is read only once it has
been on screen: a tab of the restored session that you have not opened since
launch stays quiet until you first show it. Claude Code's *Working* and *Idle*
and its completion entry are the exception: they come from the terminal's
title, which NexTerm reads even before the terminal is first shown.

**`Ctrl+Shift+U` does nothing (Linux).** IBus takes it. Bind *Go to Latest
Unread Notification* to another key in Settings ▸ Keyboard Shortcuts.

**tmux's `Ctrl+B`, or readline's `Ctrl+F`, does not reach the shell (Windows,
Linux).** NexTerm uses them for the side bar and for find. Rebind either row in
Settings ▸ Keyboard Shortcuts, or tmux's prefix.

**`Ctrl+D` closed my shell instead of splitting (Windows, Linux).** `Ctrl+D` is
the shell's end of input; split right is `Ctrl+Alt+D` there.

**Text inside vim, htop or tmux will not select.** A full-screen program that
asked for the mouse gets it. Hold `Shift` while dragging (on macOS `⌥` works
too), or turn off *Mouse Reporting in Full-Screen Apps*.

**A pasted command asked before it ran.** On purpose: a program that did not
ask for bracketed paste — cmd never does — would run each line as it arrives.
Settings ▸ Terminal ▸ *Multi-Line Paste Warning* sets when it asks.

**`nexterm-cli` says NexTerm is not running (exit 5).** The control setting is
off, the terminal was started while it was off (restart that terminal), or
NexTerm is busy — try again. See
[Control NexTerm from a terminal](#control-nexterm-from-a-terminal).

**`nexterm-cli send` is refused.** Typing into and reading terminals is off
until you turn it on, and it never types into a password prompt, into a
program running as another user or elevated, or into a terminal you have not
opened since NexTerm started.

**In Git Bash, an argument starting with `/` becomes a Windows path.** MSYS
rewrites it. Prefix the command with `MSYS_NO_PATHCONV=1`.

**Restored output shows something private.** Only strings shaped like
credentials are hidden. Settings ▸ Terminal ▸ *Clear Saved Scrollback* deletes
every saved file; turning *Restore Scrollback* off stops saving altogether.

## Develop

```sh
npm install
npm run tauri dev        # native window, hot-reloaded frontend
npm run dev              # frontend only, in a browser, on :1420
```

Anything new in the UI follows [STYLEGUIDE.md](STYLEGUIDE.md): the palette
and its tokens, the accent, focus, corners, elevation, motion and reduced
motion, sizes, wording and in-flight feedback, plus the decisions that were
made on purpose. The render suite (RN-234) checks that it still matches
`src/styles/index.css`.

## Build

```sh
npm run bundle
```

That is `tauri build` with `src-tauri/tauri.sidecar.conf.json`, which builds
`nexterm-cli` (src-tauri/cli) and puts it in every bundle beside the app; a
plain `npm run tauri build` makes installers without it. `cargo test` and
`cargo check` of the app need neither.

CI (`.github/workflows/build.yml`) runs the test suite on every push and builds
macOS, Windows and Linux bundles. Publishing is a separate, tag-only job:
pushing a `v*` tag creates the release as a **draft**, checks that all eight
expected assets are present and non-empty, uploads them, reads them back from
the API to confirm the sizes match, and only then makes the release visible.
A build that loses a platform leaves a draft behind instead of a half-finished
public release.

CI runs the tests on all three platforms, not just Linux. That matters because
the Rust suite spawns real shells, opens real PTYs and reads real directories,
so it behaves differently on each: ConPTY is not a unix pty, and
`C:\Users\me\project\src` is not a path that any `/`-shaped assumption
survives. The Windows job also reads the PE header of the binary it just built
and refuses anything that would open a console window beside the app.

## Test

```sh
cd src-tauri && cargo test    # PTY, ConPTY start-up, OSC parsing, fs confinement, native menu
cd ..
node tests/e2e/runner.js      # store + UI flows against a mock IPC bridge
node tests/adversarial/runner.js
```

Run `cargo test` **first**: it reads a real directory tree and writes what the
backend returned to `tests/fixtures/backend-tree.json`, which the adversarial
suite then pushes through the real explorer code. That pair is how a Windows
path is checked against the explorer on Windows rather than against a
hand-written string. Without the fixture those cases report as `SKIPPED`
rather than passing, so a run that checked nothing cannot look like a run that
checked everything.

## Verify on Windows

NexTerm is built on a Mac and used on Windows, and the suites cannot close
that gap on their own. Three consecutive releases fixed bugs that appear
**only on Windows**, and each shipped with every test on every platform
green — a title bar drawn twice, a folder dialog holding the event-loop
thread, a default shell that never reported its directory, a console window
flashing on every save. None of them returns an error; they are appearances,
and the code is correct on the machine that wrote it.

So a release is checked by hand on Windows, against a written list, with
evidence. [**WINDOWS_VERIFICATION.md**](WINDOWS_VERIFICATION.md) has the
procedure: the twelve checks, what each one is pinning and why it was not
caught, and the PowerShell helpers that make them evidence rather than
impressions — a screen capture (which works there and does not on the build
machine), the window's frame read as style bits rather than pixels, and a
`conhost.exe` count that catches a console flash too brief to see.

Two rules from it are worth repeating here, because both turn a real check
into a vacuous one:

- **Do not clear `%APPDATA%\com.nexterm.ide\.window-state.json` first.**
  Whether the app is right *with that file still in place* is exactly what is
  being checked; the fix was to stop reading the value so that nobody has to
  delete anything.
- **"Could not check" is a result.** The failure this guards against is a
  green report that nobody looked at, so a check that was not made is never
  written down as one that passed.

## How it fits together

```
src-tauri/src
  pty/            PTY manager, ConPTY start-up query, OSC 133/7 filter, shell integration,
                  flow control (flow_gate.rs) and output batching (output_batch.rs)
  perf.rs         performance mode: counters and knobs read only when NEXTERM_PERF is set
  fs/             folder-confined file commands + watcher; project_commands.rs reads
                  .nexterm/commands.json without following links or leaving the machine
  menu.rs         native menu described as data, so it is testable off-thread
  commands/       the #[tauri::command] surface
src
  stores/         zustand stores (terminal tree, editor, settings, system info)
  components/     layout, terminal, editor, explorer, command palette
  lib/            persistence, paths, terminal compatibility rules, themes, IPC wrapper,
                  the output bus (ptyOutputBus.js) and pacing (outputPacing.js); perf/ for measuring
                  project commands: the file's rules, blanks and quoting per shell (projectCommands.js)
tests/perf/       load generator, CPU sampler and report table for performance mode
```

The terminal layout is a tree: every leaf is a *group* holding an ordered list of
tab ids, and every branch is a horizontal or vertical split. Dragging a tab
rewrites that tree, and `src/lib/persistence.js` versions it into local storage.

## License

MIT — see [LICENSE](LICENSE).
