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

**Open a file.** Click a file in the Explorer. The Monaco editor opens above the
terminal panel as a normal tab; the terminals keep running underneath. Close
the last file and you are back to a pure terminal window. Monaco is loaded the
first time the editor is shown, not at launch, and it and its workers are
bundled locally — nothing is fetched from a CDN at runtime.

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

### Knowing what every terminal is doing

**See what the other terminals are doing.** A tab shows a blue dot while a
command is running in it and a red one when the last command failed, and a
group's chip shows the same for every terminal inside it. The point is the ones
you are not looking at: switching groups replaces the whole arrangement, so
without this a build finishing — or failing — in another group is invisible.
Hovering says it in words. Nothing flashes for an empty prompt line.

**Be told when something finishes.** A command that runs for more than ten
seconds in a terminal you are NOT looking at puts an entry in the status bar's
bell — name, exit code, how long it took — and clicking it takes you to that
terminal. Nothing is said about a command you watched finish, and nothing is
said about a quick one; the threshold is Settings ▸ Terminal ▸ Notify After,
and 0 turns it off.

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

A desktop notification needs the operating system to allow it — on macOS
System Settings ▸ Notifications, on Windows Settings ▸ System ▸ Notifications,
on Linux a running notification service. On Windows, toasts are for the
installed app (the `setup.exe` or `.msi`): Tauri's notification plugin, which
shows them, documents its Windows support as working only for installed apps.
The portable `NexTerm.exe` is not installed, so do not count on a toast from it.
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

Three things make an entry: a long command finishing (see *Be told when
something finishes*), a program's notification (above), and the terminal bell
— the `BEL` character a program prints, which Claude Code's *Terminal Bell*
channel sends. Repeated bells from one terminal add up in one entry, and a bell
is never a desktop notification. Settings ▸ Terminal ▸ *Terminal Bell* turns
bells off. Nothing is recorded for the terminal you are typing into; with
*Flash the Terminal You Are In* on, its ring flashes once instead.

**Progress.** A program can report how far along it is with OSC 9;4, the
sequence Windows Terminal and ConEmu understand. NexTerm draws it as a thin bar
under the terminal's tab — blue while it runs, red for an error, yellow when
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
is replayed as history, without bells or progress.

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
  gone.
- **The git branch of its folder**, or *detached* and the commit when the head
  is detached.
- **The last notification**, dimmed once read. Hover it for the whole text
  and how long ago it came.

Each group's row counts its terminals that are waiting, running and failed,
and a group chip says the same when you hover it.

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
  command marks and the sticky command line do not come back. Each restart
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
| pick its conversation up after a restart | *Resume* — see [Sessions](#sessions-what-comes-back) |
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

`nexterm-cli help <command>` explains each one; `--json` prints NexTerm's
answer for scripts. It exits 0 when done, 2 for wrong usage (found by the
tool or by NexTerm — nothing was done), 3 outside a NexTerm terminal, 4 when
refused (not allowed, no such terminal), 5 when NexTerm is busy (a rate
limit), not running, not answering, or has its control turned off — try
again later.

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
| Let programs in terminals control NexTerm | on | notify, status, progress, list, new split, focus |
| Let programs type into and read terminals | off | `send` and `read-screen` |
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
right-click does, and mouse reporting.

**9 terminal themes, all dark.** Dark Modern, Monokai, Material, Dracula,
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
| `⌘⇧Enter` | Zoom the active pane / show every pane again |
| `⌘⇧U` | Go to the latest unread notification's terminal |
| `⌘B` | Toggle the primary sidebar |
| `⌥⌘B` | Toggle the terminals side bar |
| `⌘L` | Clear the active terminal |
| `⌘F` | Find in the active terminal's scrollback |
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

VS Code makes the same trades with the same keys. Two of them do take something
away on Windows and Linux, where `⌘` is `Ctrl`: **`Ctrl+B` will not reach tmux**
(rebind tmux's prefix, or rebind the toggle) and **`Ctrl+F` no longer moves the
cursor forward in readline** (the arrow keys still do). Both rows are rebindable
in Settings ▸ Keyboard Shortcuts. On macOS nothing is given up — `⌘` never
reaches the pty. Everything else in the table above is left to the shell.

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
- A lock marks a password prompt ([Safety nets](#safety-nets)).
- Quitting with `⌘Q`, the Dock or a logout does not wait for the last output
  to be saved ([Output after a restart](#output-after-a-restart)).

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
launch stays quiet until you first show it.

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
