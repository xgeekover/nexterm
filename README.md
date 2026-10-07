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
> `zsh` / `bash` / `pwsh` / `cmd` processes.

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
- **Zoom one pane.** `⌘⇧Enter` (`Ctrl+Shift+Enter` elsewhere) makes the active
  pane fill its group and hides the rest — tmux's `Prefix z`, iTerm2's
  *Maximize Active Pane*. The hidden ones keep running; press it again and the
  split comes back exactly as it was.
- **Save a group, or the whole desk.** *Save Group…* keeps one group's layout
  and each terminal's current directory. *Save All Groups…* snapshots every
  group at once under a name, and restoring it brings the entire session back —
  same groups, same arrangements, same directories.
- **Layout templates.** Give each terminal of a saved group a startup command
  and opening it starts everything at once — the dev server, the test watcher,
  the agent — each typed as soon as its shell is ready, tmuxinator-style.
- **Session restore.** Groups, layouts, names and each terminal's `cwd` are
  written to local storage and restored on next launch, without being asked.
- **Pick an agent conversation back up.** A terminal that was running OpenCode
  or Claude Code when NexTerm closed offers that conversation back — the one
  it had, by name — whether NexTerm started the agent or you typed it.
- **A real terminal.** xterm.js over a native PTY, with OSC 133 shell
  integration (command start/end + exit status) and OSC 7 so the status bar and
  new splits follow the shell's actual working directory. Terminals draw with
  xterm's WebGL renderer, so block and box-drawing characters — TUI logos,
  borders — fill their cells at any line height, and fall back to the DOM
  renderer where WebGL is unavailable.
- **Built for Windows' ConPTY.** The backend answers ConPTY's start-up cursor
  query (without it `cmd.exe` shows no prompt), and tells xterm.js the Windows
  build so a pane that is resized — a split, a maximised window — is not
  re-wrapped twice and does not lose lines.
- **Command suggestions.** An inline, oh-my-zsh-style ghost-text suggestion as
  you type, ranked from the commands this session has run plus a curated index
  of common ones. It is an app-side layer, not real shell completion — it never
  reads `PATH` or the filesystem.
- **11 terminal themes.** Dark Modern, Light Modern, Monokai, Material, Dracula,
  Solarized Dark/Light, Nord, One Dark, Gruvbox Dark, Tomorrow Night.
- **An editor when you need one.** Open a file from the Explorer and it appears
  as a Monaco tab above the terminals; close it and you are back to a pure
  terminal window. Monaco is loaded the first time the editor is shown, not at
  launch, and it and its workers are bundled locally — nothing is fetched from a
  CDN at runtime.
- **Opens with no folder, like VS Code.** NexTerm starts with nothing open;
  the Explorer offers *Open Folder*. Until a folder is open, terminals start in
  your home directory.
- **Filesystem confinement.** Every file command is resolved against the open
  folder, with the deepest existing ancestor canonicalised so symlinks cannot
  escape it. With no folder open, file commands are refused outright.
- **One title row.** On Windows and Linux the window is frameless and NexTerm
  draws its own compact title bar — a ☰ application menu, the folder name,
  command centre, layout toggles and window buttons in a single 35px row, VS
  Code style, instead of a native title bar with a native menu bar under it.
  macOS keeps its traffic lights and the system menu bar.

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

**Open a folder.** NexTerm starts with no folder. Click *Open Folder* in the
Explorer, or ☰ → File → *Open Folder…*. The Explorer, the title bar and new
terminals then follow that folder.

**Be told when something finishes.** A command that runs for more than ten
seconds in a terminal you are NOT looking at puts an entry in the status bar's
bell — name, exit code, how long it took — and clicking it takes you to that
terminal. Nothing is said about a command you watched finish, and nothing is
said about a quick one; the threshold is Settings ▸ Terminal ▸ Notify After,
and 0 turns it off.

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

**Go back to a folder you had open.** `⌥⌘O`, File → *Open Recent…*, or the
list the Explorer shows when nothing is open. A folder that has since been
moved or deleted is refused by the backend and drops out of the list rather
than staying as a row that fails every time it is clicked.
**Pick a shell per terminal.** Right-click a group in the TERMINALS panel →
*New Terminal With ▸* lists the shells this machine actually has — found on the
real box rather than guessed, so it names Git Bash and WSL when they are there
and does not offer PowerShell 7 when they are not. Terminals in one window may
differ, the status bar names the one you are looking at, and *Duplicate* keeps
a terminal's shell as well as its directory. Settings ▸ Terminal ▸ Default
Shell picks what a plain new terminal opens, and still takes a typed path.

**Open a terminal.** The window starts as one group holding one terminal.
`⌃⇧\`` adds a tab to the current group; the `+` in the tab bar does the same.

**Split.** Use the split buttons in the panel header, `⌘D` (right) / `⌘⇧D`
(down), or drag a tab onto an edge of any pane. While dragging, the target
quarter lights up so you can see where it will land before you let go.

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

**Work in groups.** The chips above the terminals are your groups; `+` makes a
new one. Clicking a chip swaps the whole arrangement to that group's. Set up
one group for the app and another for tests, and switch between them instead of
cramming both onto one screen.

**Move a terminal to another group.** Drag its tab onto the target group's chip,
or right-click it in the TERMINALS panel → *Move to Group*.

**Click what the output names.** A stack trace's `src/app.js:42:13`, a
compiler's `--> src/main.rs:10:5`, a Python traceback's `File "x.py", line 9` —
click it and the file opens in the editor above with the caret on that line.
Relative paths are read against the terminal's current directory, not the
workspace root, so a `cargo` run inside `src-tauri/` lands on the right file.
`http://` and `https://` addresses open in your browser; nothing else is ever
offered as a link, and a path without a line number is left as plain text so
ordinary output does not fill up with underlines.
**See what the other terminals are doing.** A tab shows a blue dot while a
command is running in it and a red one when the last command failed, and a
group's chip shows the same for every terminal inside it. The point is the ones
you are not looking at: switching groups replaces the whole arrangement, so
without this a build finishing — or failing — in another group is invisible.
Hovering says it in words. Nothing flashes for an empty prompt line.
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

**Select, copy and paste — the way Warp does it.** Drag over any text to
select it; double-click takes a word, triple-click a line. The selection is on
the clipboard the moment you let go (Settings ▸ Terminal ▸ *Copy on Select*
turns that off). This works inside Claude Code too: a program writing into the
scrollback never gets the mouse, even when it asks for it, so a drag there
selects. A **full-screen** program — vim, htop, tmux, `less --mouse`, anything
on the alternate screen — does get the mouse when it asks; hold **Shift** while
dragging to select inside it anyway (on macOS **⌥** works too). *Mouse
Reporting in Full-Screen Apps* in the same section takes the mouse away from
every program. Paste with `⌘V` on macOS, `Ctrl+V` on Windows — see the table
below. A program that asked for bracketed paste gets the text bracketed, so a
multi-line paste into a shell or an agent is not run line by line.

**Find something in the scrollback.** `⌘F` opens a find bar over the focused
terminal — incremental as you type, `Enter` / `Shift+Enter` to walk the matches,
`Esc` to close. Match case, whole word and regular expressions are there, every
match is highlighted at once, and the bar counts them ("3 of 17"). The buffer is
5000 lines deep by default, so this is how you get back to the error that
scrolled past.

**Make the text bigger.** `⌘=` and `⌘-` step the terminal and editor font
together, `⌘0` puts them back. While the size is not the default, the status bar
says so and clicking it resets.

**Rename.** Double-click a terminal tab, or right-click it → *Rename*. Groups
rename the same way, from their chip or from the TERMINALS panel.

**Save a group.** Right-click a group in the TERMINALS panel → *Save Group…*.
It lands under SAVED with its terminal count and age; right-click it to *Load
in New Group* or *Load into Current Group*.

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
ids, but names the conversation it shows in the terminal's title, and NexTerm
looks that title up with `opencode session list` — so once the conversation
has a title, *Resume* is `opencode -s <id>`, that conversation, and the offer
says which by name. Before then, or if OpenCode cannot be found from NexTerm,
it is `opencode --continue`: the folder's most recent. *Choose…* lists the
folder's OpenCode conversations to resume another.

**When a shell exits.** A terminal whose shell has ended says so once —
`[process exited with code …]`, with Windows' crash and Ctrl+C codes also in
hex (`0xC000013A, ended by Ctrl+C`) — and **Enter** starts a new shell in its
place: same pane, same scrollback, its last directory, the shell it ran. Other
keys go nowhere instead of each printing an error. On Windows this is how a
terminal comes back when quitting OpenCode with Ctrl+C took cmd down with it,
as has been seen; the code it prints says how cmd ended.

**Save the whole session.** The 💾 on the WORKSPACES section (or *Save All
Groups…* from the empty-area menu) snapshots every group — layouts and
directories included. Double-click a saved workspace to put the session back
the way it was, or right-click → *Add Its Groups to This Session* to bring them
in alongside what you already have.

**Open a file.** Click a file in the Explorer. The Monaco editor opens above the
terminal panel as a normal tab; the terminals keep running underneath.

**Use the menu.** On Windows and Linux, ☰ at the left of the title bar opens
File, View and Terminal. Hover or use the arrow keys to step into a menu,
`Enter` to run an item, `Esc` to back out; keys typed while it is open never
reach the terminal behind it.

**See what git sees.** When the open folder is a repository, the status bar
carries the branch, how far it is from upstream and how many files have
changed, and the Explorer colours the ones that have — modified, added,
deleted, untracked — with a letter beside each, so the row still says something
where the colours do not. It shells out to your own `git`, which is what makes
worktrees, submodules and your own `core.*` behave here the way they behave in
the terminal below. There is no staging or committing: that is a second
application, and this one has git in it already.

**Change settings.** The gear in the activity bar opens a VS Code-style settings
window — editor font, terminal font/size/line-height, cursor style and blinking,
scrollback, colour theme, command suggestions, copy on select, what a
right-click does, and mouse reporting.

### Notifications from programs

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

A desktop notification needs the operating system to allow it — on macOS
System Settings ▸ Notifications, on Windows Settings ▸ System ▸ Notifications,
on Linux a running notification service. On Windows, toasts are for the
installed app (the `setup.exe` or `.msi`): Tauri's notification plugin, which
shows them, documents its Windows support as working only for installed apps.
The portable `NexTerm.exe` is not installed, so do not count on a toast from it.
The bell works everywhere either way.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘P` / `⌘⇧P` | Go to file / all commands |
| `⌘⇧F` | Search across files |
| `⌘⇧O` | Open a folder |
| `⌥⌘O` | Open a recent folder |
| `⌘,` | Settings |
| `⌃\`` | Toggle the terminal panel |
| `⌃⇧\`` | New terminal tab in the current group |
| `⌘D` / `⌘⇧D` | Split the active pane right / down |
| `⌘W` | Close the active terminal pane |
| `⌘⇧W` | Close the window |
| `⌥⌘←` / `⌥⌘→` | Focus the previous / next pane |
| `⌘⇧Enter` | Zoom the active pane / show every pane again |
| `⌘B` | Toggle the primary sidebar |
| `⌥⌘B` | Toggle the terminals side bar |
| `⌘L` | Clear the active terminal |
| `⌘F` | Find in the active terminal's scrollback |
| `⌘⇧H` | Command history |
| `⌘=` / `⌘-` / `⌘0` | Bigger / smaller / default text |
| `⌘S` | Save the active editor file |

On Windows and Linux use `Ctrl` wherever `⌘` is listed. That is the table out
of the box — every row is rebindable.

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
  pty/            PTY manager, ConPTY start-up query, OSC 133/7 filter, shell integration
  fs/             folder-confined file commands + watcher
  menu.rs         native menu described as data, so it is testable off-thread
  commands/       the #[tauri::command] surface
src
  stores/         zustand stores (terminal tree, editor, settings, system info)
  components/     layout, terminal, editor, explorer, command palette
  lib/            persistence, paths, terminal compatibility rules, themes, IPC wrapper
```

The terminal layout is a tree: every leaf is a *group* holding an ordered list of
tab ids, and every branch is a horizontal or vertical split. Dragging a tab
rewrites that tree, and `src/lib/persistence.js` versions it into local storage.

## License

MIT — see [LICENSE](LICENSE).
