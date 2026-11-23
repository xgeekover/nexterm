# Verifying NexTerm on Windows

NexTerm is built on a Mac and used on Windows. That asymmetry has a cost, and
this document is what the project does about it.

## Why this exists

Release after release has fixed bugs that **only appear on Windows**, and
every one of them shipped green: `cargo test`, three platform test jobs, three
platform builds, all passing, for months in one case.

| Release | What was wrong | Why nothing caught it |
| --- | --- | --- |
| v0.5.2 | The native title bar sat above the app's own, with a second set of window buttons | `tauri.conf.json` was correct. `tauri-plugin-window-state` restored a saved `decorated: true` **after** the window was built, and only a machine that had run v0.1.x had that value. Survived eleven releases. |
| v0.5.3 | Opening a folder froze the window | A plain `fn` command is `ExecutionContext::Blocking` — the event-loop thread. macOS hides it, because `NSOpenPanel` keeps pumping the loop while modal. |
| v0.5.3 | A terminal's directory never followed `cd` | cmd is the Windows default shell and had no shell integration at all, so no OSC 7 was ever emitted. |
| v0.5.3 | Restored sessions lost every directory | OSC 7 reports `/C:/Users/dev`; nothing turned it back into a path Windows can open, so respawning hit the fallback silently. |
| v0.5.4 | A console window flashed whenever git ran | `git` is a console program, and a child gets its own console unless given `CREATE_NO_WINDOW`. |
| v0.6.1 | *Resume* typed into the first command of every PowerShell session | ConPTY holds an escape sequence that paints nothing until the next frame, so that command's OSC 133 "C" arrived with its "D", when it ended. Every suite drives a mock, where C arrives on time. |

Read the "why nothing caught it" column as one sentence: **these are not
failures, they are appearances.** Nothing returns an error. The code is
correct on the machine that wrote it. A test can only observe them by being on
Windows with a human or an agent looking at the screen.

## What CI already does, and where it stops

CI runs the Rust and JS suites on all three platforms, and the Windows job
reads the PE header of the binary it built to refuse a console subsystem. That
catches what is checkable. It cannot catch a window that is drawn twice, a
thread that is busy rather than wrong, or a console that opens for a
hundredth of a second.

Two kinds of test partially close the gap, and both live in the source:

- **Source-reading tests.** `commands/fs.rs` asserts that every command
  touching the disk is dispatched off the event-loop thread, and `fs/git.rs`
  scans the whole backend for a `Command::new` without `CREATE_NO_WINDOW`.
  Both exist because the property is decided by one word in an attribute that
  no runtime assertion can reach. Both were verified by reintroducing the bug.
- **Shape-based tests.** `osc.rs` decides that `/C:/…` is a Windows path by
  its shape and never by the host OS, so the case means the same thing on
  every machine.

What remains is everything visual, and that is what the checklist below is
for.

## Before you start

Get a build from [Releases](../../releases/latest). The portable zip needs no
installation:

```powershell
$ErrorActionPreference = 'Stop'
$dir = "$env:TEMP\nexterm-qa"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
gh release download --repo xgeekover/nexterm --pattern "NexTerm-windows-x64-portable.zip" --dir $dir --clobber
Expand-Archive "$dir\NexTerm-windows-x64-portable.zip" -DestinationPath "$dir\app" -Force
```

To check a pull request before it is released, take the same zip from that
PR's CI run instead:

```powershell
gh run download <run-id> -R xgeekover/nexterm -n nexterm-windows-latest -D $dir
```

**Close every NexTerm first, and back up what it saved.** The portable build
has the same identifier (`com.nexterm.ide`) as an installed one, so the two
share a WebView2 data folder: with one already running, the debugging port
below never opens and both write the same saved state. With the app closed,
copy `%APPDATA%\com.nexterm.ide` and `%LOCALAPPDATA%\com.nexterm.ide` aside,
and put them back when you are done — the checks change the saved workspace,
the settings and the command history.

**Do not launch it from inside a Claude Code session.** The app inherits
`CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1`, so a `claude` started in one
of its terminals says "Transcript saving is off – inherited…" and writes no
`.jsonl` — and every check that resumes a conversation then tests nothing.
Remove those variables from the process that starts it.

**Do not delete `%APPDATA%\com.nexterm.ide\.window-state.json`.** Read it and
keep a copy of what it said. Nor can you sidestep it by redirecting
`%APPDATA%`: Tauri resolves the config directory through the Win32
known-folder API, which does not read the environment variable. Backing up the
real file and putting it back afterwards is the only way. Whether the app is correct *with that file still
in place* is the whole point of V1 — the fix was to stop reading the value,
precisely so that nobody has to find and delete a file. Clearing it first
turns a real check into a vacuous one.

## Three tools

These are what make the checks evidence rather than impressions. The first one
is worth stating plainly: **screen capture works here and does not on the
build machine**, where it fails with "could not create image from display". On
Windows you can actually look at the app.

```powershell
function Save-Shot($path) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output $path
}
```

The window's frame, read as bits rather than pixels:

```powershell
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-NexTermWindow {
  $p = Get-Process NexTerm -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "no NexTerm window" }
  $s = [Win]::GetWindowLong($p.MainWindowHandle, -16)   # GWL_STYLE
  $wr = New-Object Win+RECT; $cr = New-Object Win+RECT
  [void][Win]::GetWindowRect($p.MainWindowHandle, [ref]$wr)
  [void][Win]::GetClientRect($p.MainWindowHandle, [ref]$cr)
  [pscustomobject]@{
    Title         = $p.MainWindowTitle
    WS_CAPTION    = (($s -band 0x00C00000) -eq 0x00C00000)
    WS_THICKFRAME = (($s -band 0x00040000) -ne 0)
    WindowHeight  = $wr.Bottom - $wr.Top
    ClientHeight  = $cr.Bottom - $cr.Top
  }
}
```

A console window opened by a child process is too brief to see, so it has to
be watched for rather than looked for. **Counting `conhost.exe` does not work**
— that was tried first and it is a trap twice over:

- NexTerm's own ConPTY terminals each run a *headless* conhost, so the
  baseline is already around thirty and moves on its own as tabs open.
- When the default terminal is Windows Terminal, a console popup is not a
  `ConsoleWindowClass` window at all; it arrives as **a new Windows Terminal
  window**, so watching for that class misses it entirely.

Watch instead for any newly *visible top-level window*, whatever its class,
and keep a **positive control** beside it — proof that `git` really ran during
the window being sampled. Without the control, a run where the watcher was
simply looking at nothing is indistinguishable from a pass.

```powershell
# Sketch: snapshot the visible top-level windows, do the thing, diff.
# The control is the point — sample Get-Process git as well, and report it.
$before = (Get-Process | Where-Object MainWindowHandle -ne 0).MainWindowHandle
# ... trigger the work, sampling both sets on a short interval ...
# PASS = no window handle appeared that was not in $before, AND git was seen
#        running in at least some samples.
```

**Optional, and only possible here.** Tauri uses WebView2 on Windows, and
WebView2 accepts CDP — so the *shipped* app's DOM can be read and clicked,
which the macOS WKWebView never allows:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process "$env:TEMP\nexterm-qa\app\NexTerm.exe"
Start-Sleep 5
(Invoke-RestMethod http://127.0.0.1:9222/json) | Select-Object title, type, webSocketDebuggerUrl
```

A release build has **no** `window.__nexterm` handle — that is gated on a dev
build or `?debug` — but it is not only the DOM either:

- **`localStorage`** is where the saved workspace, the settings and the
  history live (`nexterm.terminal.workspace`, `nexterm.settings`,
  `nexterm.commandHistory`), so whether something was saved can be read rather
  than inferred from the screen. Changes are written within about two seconds.
  Since 0.7.0 `nexterm.settings` holds only what differs from the defaults: a
  setting at its default is simply absent.
- **`window.__TAURI_INTERNALS__`** is there. `invoke('plugin:event|listen', …)`
  subscribes the page to the backend's own events — `pty-command-started`,
  `pty-command-done`, `pty-cwd` — so you can timestamp what the backend
  actually parsed. `pty-output` arrives with the OSC markers already stripped.

Driving it over CDP:

- The terminal is drawn with WebGL: there is no `.xterm-rows` and no terminal
  text in the DOM. Read it from screenshots (`Page.captureScreenshot` works).
- Adding `--disable-webgl` to `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` puts xterm
  on its DOM renderer, where the text is readable from `.xterm-rows`. That is
  not the shipped configuration — say so whenever you use it. (Before 0.7.0 it
  was also the only way to see inline suggestions, #35.)
- Click with `Input.dispatchMouseEvent` — pressed, then released — never with
  `element.click()`: a bug in where focus goes only shows under a real press.
  `Input.insertText` reaches the shell exactly like typing.
- A native `<select>` changes by focusing it and sending `ArrowDown` /
  `ArrowUp` key events.
- Tab chips overflow under the pane's buttons with no scrollbar, so the centre
  of a chip's rect can be clipped and land on *Split Right*. Check
  `document.elementFromPoint` before any click by coordinates.

**ConPTY holds output that paints nothing.** An escape sequence that changes
nothing on screen — OSC 7, OSC 133's markers — reaches NexTerm only with the
next frame that does paint something. So for anything those markers drive,
record *when* the event arrives, not only *whether* it does, and test the first
command of a fresh shell on its own: on 19045 its "C" arrived together with
its "D", when the command was already over.

## The checks

### V1 — one title bar, not two

Read `.window-state.json` and record it, without deleting it. Launch, run
`Get-NexTermWindow`, take a screenshot and look at it.

Expect a single title row: the one NexTerm draws (☰ menu, name, folder,
command centre, window buttons). `WS_CAPTION = False`, `WS_THICKFRAME = True`
(it must still be resizable), `Title = NexTerm`.

If the style bit and the screenshot disagree, **the screenshot decides** and
say so — `tao` may remove the frame another way.

### V2 — the window still remembers where it was

V1 was fixed by stopping the window-state plugin from remembering the frame.
Removing too much would lose size and position with it. Move the window
somewhere distinctive, quit fully, relaunch. Repeat maximised.

### V3 — opening a folder does not freeze the window

With the folder dialog **open**, check that the window behind it still
repaints (cover it and uncover it) and that `(Get-Process NexTerm).Responding`
is `True`. Then pick a repository with thousands of files and watch whether
the UI locks while the tree loads.

### V4 — git opens no console window

Not just on opening a folder: `git_status` is wired to the file watcher and
re-runs, debounced, on every burst of changes — so it ran on **every save**.
That is the more important half of this check.

```powershell
$repo = "C:\path\to\a\git\repo"
$baseline = @(Get-Process conhost -ErrorAction SilentlyContinue).Count
$job = Start-Job {
  1..30 | ForEach-Object {
    Set-Content "$using:repo\qa-touch.txt" (Get-Random)
    Start-Sleep -Milliseconds 500
  }
}
$peak = Watch-Conhost 16
Receive-Job $job -Wait -AutoRemoveJob | Out-Null
Remove-Item "$repo\qa-touch.txt" -ErrorAction SilentlyContinue
"peak $peak / baseline $baseline"
```

Expect `peak == baseline`.

### V5 — cmd reports its directory

**Change no settings.** cmd is the default and that is the point. Confirm with
`echo %COMSPEC%`, note the path shown beside the terminal in the TERMINALS
panel, `cd C:\Windows\System32`, and watch it follow.

The prompt itself must look untouched (`C:\...>`) — visible escape characters
are a failure. `echo %PROMPT%` should show the marker spliced in front of it.

Since 0.7.0 cmd also reports that a command **ended** — `echo %PROMPT%` shows
`$E]133;D$E\` in front of the directory marker — but never how: its prompt
cannot expand `%ERRORLEVEL%`. So after `ping -n 10 localhost` the tab reads as
running from about 300 ms after Enter until the next prompt, a long command
that finishes while you are elsewhere raises a notification with no ✓ and no
✗, and the command stays in the history. Three empty Enters must not flicker
the tab. Command blocks and the sticky header still need a "started" marker
cmd cannot send; switching the default shell to PowerShell brings those back.
Worth noting as well: a batch file run with `echo on` draws the prompt before
each line it echoes, and a `(` block's `More?` prompt sends no end. And the
markers live in `PROMPT`: running `prompt` (which resets it) or `echo off` at
the prompt removes them, and from the next Enter that terminal reads as
running until it is reopened — a known limit, not a bug to chase.

### V6 — a path shows its end

Open a terminal somewhere deep. Expect `…\src-tauri\src`: the last segments,
with the ellipsis in **front**. The row's tooltip still carries the full path.

### V7 — dragging a divider does not make the terminal flicker

With output on screen, drag a divider slowly and then quickly, with several
panes split. The contents should follow smoothly, without the prompt being
redrawn over and over. The status bar's `cols×rows` updates when the drag
settles.

### V8 — a saved session keeps its directories

**Anything saved before v0.5.3 already holds broken paths in local storage**,
so save a new one. Put two or three terminals in different directories, *Save
All Groups…*, quit, relaunch, restore. Each terminal must come back in its own
directory rather than at the workspace root.

### V9–V12 — never verified here at all

Not bug reports. These have simply never been exercised on Windows.

- **V9** Explorer git decoration — colours and `M`/`A`/`U` on changed files.
  The Windows path bug behind this was fixed in v0.5.0 and never checked
  since; before it, **no file would have been coloured at all**.
- **V10** `Ctrl+Shift+F` search: results grouped by file, clicking one opens
  it at that line.
- **V11** Terminal find (`Ctrl+F`), zoom (`Ctrl+=` / `Ctrl+-`), splitting by
  dragging a tab, switching groups.
- **V12** The ☰ menu, Open Recent, and shortcut hints reading `Ctrl+…` rather
  than `⌘`.

### V13 — an agent terminal comes back, and Resume hands over the keyboard

Needs a `claude` that is logged in, and spends a few tokens — keep the
conversation to one short message. Right-click the empty part of a pane's tab
strip → *New Claude Code Terminal*. The `claude --session-id <uuid>` it types
must arrive whole. Send one message, then check `localStorage`: that tab's
`agent` is `{kind: 'claude', sessionId: <lowercase v4 UUID>, …}`.

Close the window with claude still running and relaunch. The tab offers
"Resume Claude Code?" in a row **above** the terminal, not over its first
lines (the banner's bottom equals `.xterm-screen`'s top). Press *Resume*: focus
must land in `.xterm-helper-textarea`, text typed without clicking the
terminal must reach claude, the process must be `claude --resume` with the same
id (`Win32_Process` shows it when claude has cleared the screen), and it must
remember what was said. Relaunch once more and press *Dismiss*: `agent` goes to
`null` on disk, and the next launch offers nothing.

Since 0.7.0 the record also ends when the agent does. Quit claude (`/exit`)
and `agent` goes to `null` within a couple of seconds; the next launch offers
nothing. A conversation that never got a message cannot be resumed — Resume
prints "No conversation found" — and that also clears it (#37). And the start
command waits for the shell's first prompt (up to 3 s), so it is echoed once,
after the prompt. Check all three on cmd, PowerShell 5.1 and PowerShell 7, and
note how long PowerShell with a profile takes to draw its first prompt.

### V14 — Resume waits while something runs

With PowerShell as the default shell, give a restored offer a long **first**
command (`Start-Sleep 20`): *Resume* is disabled with a reason for the whole
run and enabled again after it. Repeat on Windows PowerShell 5.1 and on
PowerShell 7 — the first command is the one ConPTY delays, see below. Three
empty Enters must not flicker it. On cmd (since 0.7.0) it is disabled too, from
about 300 ms after Enter until the next prompt — check that with `ping -n 10
localhost`, and that nothing is left marked as running afterwards.

### V15 — the Default Directory setting reaches every new terminal

Settings → Terminal → Default Directory → *Custom path…*. A relative `src` (in
a folder that has one) shows no warning, `nope` does, and New Terminal, Split
and New Group all start in `<open folder>\src`. A `~\Documents` path opens in
the home's Documents. A folder that exists but cannot be entered (a path past
`MAX_PATH`) must not cost a terminal: New Terminal falls back to the open
folder, and a launch with no saved layout still starts with one terminal.

### V16 — a poisoned history entry runs nothing

Put `{c: "echo SAFE\recho INJECTED", n: 9}` into `nexterm.commandHistory`
through CDP, with a clean `echo SAFECONTROL` beside it as the control, and
relaunch. In the History palette and with → after `echo S`, only the control
is offered, and `INJECTED` is never printed.

### V17 — inline suggestions draw under WebGL, at the cursor

With the shipped WebGL renderer (no `--disable-webgl`), type `git s` in a
terminal whose history has `git status`: the ghost text and the popup appear,
and the ghost starts right **after** the typed text, never over it (#35, #36).
The ghost is drawn only once the shell has echoed the keys, so type along a
suggestion one key at a time and watch whether it reads steady or blinks —
ConPTY echoes later than a unix pty, and that has not been measured. → accepts
the ghost, or the popup item once ↑/↓ has moved the highlight; Esc dismisses.
Tab always goes to the shell: PowerShell's own completion runs with a ghost on
screen. Inside a running program — `python`, or an agent — nothing is drawn,
and Tab, →, Esc, ↑ and ↓ all reach the program.

### V18 — copy and paste reach the terminal, and a drag selects in Claude Code

Never run on Windows: the key path was checked in headless Chromium with the
platform spoofed to `Win32`, which proves the key reaches the browser
uncancelled but not what WebView2 then does with it. Check on cmd, PowerShell
and inside `claude`:

- `Ctrl+V` pastes the clipboard's text — never `^V`, and in claude never the
  "paste an image" path (that is `Alt+V`). A multi-line paste at a PowerShell
  prompt arrives as one block, not as commands run line by line.
  `Ctrl+Shift+V` and `Shift+Insert` paste too.
- Select some output, `Ctrl+C`: it lands on the clipboard (paste it into
  Notepad), the selection disappears, and nothing is interrupted. `Ctrl+C`
  again, with nothing selected, interrupts (`ping -t localhost` stops).
  `Ctrl+Shift+C` and `Ctrl+Insert` copy as well.
- Inside claude, a plain drag over its text selects (it used to go to claude
  and select nothing), and letting go copies it — paste into Notepad without
  pressing anything else. The wheel scrolls back through claude's output.
- In a full-screen program that uses the mouse (`vim` with `:set mouse=a`, or
  `htop` under WSL), a click still reaches the program; `Shift`-drag selects
  instead.
- Settings ▸ Terminal: *Copy on Select* off — a drag selects but the clipboard
  keeps what it had. *Mouse Reporting in Full-Screen Apps* off — vim's clicks
  stop reaching it at once, a drag there selects.

### V19 — xterm 6: widths, keys and the wheel under ConPTY

Never run on Windows: xterm 6 was checked headless on macOS only, and ConPTY
measures and repaints text with conhost's own width tables before NexTerm sees
any of it — which is exactly what nothing here can reproduce.

- In PowerShell, `Write-Output "A✅B ⚠️C 👍🏽D 한글E"`: each emoji and each
  syllable takes two cells, with no gap and no overlap before the next letter.
  Then make the pane narrower and wider again (ConPTY repaints on resize): the
  line must come back identical. A letter shifted or eaten after one emoji is
  conhost and xterm disagreeing about its width — note which emoji.
- Inside `claude`, ask for a reply with ✅ ⚠️ 👨‍💻 in it, and watch a status line
  that is redrawn (the spinner, "통과 13개"-style counters): nothing is left
  over from the previous frame.
- `Alt+←` / `Alt+→` move a word at the PowerShell, cmd and Git Bash prompts
  (NexTerm sends `Ctrl+←` / `Ctrl+→`, as xterm 5.5 did; xterm 6 alone sends
  `ESC[1;3D`).
- `git log` in Git Bash, or `less` under WSL: one wheel notch moves several
  lines, as in 0.8.0 — not one.
- Over plain scrollback (`dir /s` in cmd, then scroll back): one notch moves
  as far as in 0.8.0 — about five rows at the default font, where xterm 6
  alone moved two or three — and raising "lines to scroll at a time" in
  Windows' mouse settings makes it go further.
- Whether `claude` frames its output with synchronized updates here is open:
  it asks XTVERSION first, and conhost may answer or swallow that query itself.
- Inside `claude`'s full-screen view a right-click pastes: told it runs in
  xterm.js, claude leaves right-click paste to the terminal, which NexTerm
  now does — see V22. (Through 0.10.0 it did nothing there.)

### V20 — Shift+Enter inserts a newline in OpenCode under ConPTY

Never run on Windows: measured and tested on macOS only. ConPTY stands between
OpenCode and NexTerm both ways. conhost may swallow OpenCode's request for
modifyOtherKeys (`CSI > 4 ; 1 m`), and then nothing changes from 0.9.0; or it
may pass the request on, and then it has to pass `CSI 27;2;13~` back to
OpenCode as well.

- In `opencode`, type a word, then `Shift+Enter` and `Ctrl+Enter`: each
  inserts a newline. `Enter` submits, `Alt+Enter` still inserts a newline.
  `Shift+Enter` doing nothing at all means conhost dropped the key; text like
  `[27;2;13~` in the input, or OpenCode acting as if `Esc` was pressed, means
  conhost split it. Either way note the Windows build: the encoding can be
  turned off where `windowsPty` is set.
- Quit OpenCode. At the PowerShell prompt `Shift+Enter` runs the line, as in
  0.9.0, with nothing like `;2;13~` typed into it. In `claude`, with nothing
  typed, it does what `Enter` does, as in 0.9.0.

### V21 — a program's notification reaches the bell and a toast under ConPTY

Never run on Windows, nor yet in the app: OpenCode was measured in a PTY
harness on macOS, and NexTerm's side through real xterm in the suites.
OpenCode picks OSC 99 only when the terminal answers its start-up query, and
whether conhost carries that answer back is unknown — hence
`OPENTUI_NOTIFICATION_PROTOCOL` below. Use the **installed** build (`setup.exe` or `.msi`): Tauri documents
its notifications as working only for installed apps on Windows, and a
development build shows them as PowerShell's.

- In PowerShell, `$env:OPENTUI_NOTIFICATION_PROTOCOL` prints `osc99`.
- Turn OpenCode's on (`{"attention": {"enabled": true}}` in
  `.config\opencode\tui.json` under `%USERPROFILE%`), give it a prompt, and
  Alt+Tab to another app before it answers: a toast with the session's title
  says "Session done", and the bell holds the same entry; clicking the entry
  goes to that terminal. Ask for something it needs permission for, and switch
  away again: "Permission needs input".
- NexTerm in front with another terminal tab active: an entry, no toast. In
  OpenCode's own tab, typing into it: nothing at all.
- No `]99;`, `]9;4;` or `]9;9;` text ever appears — on screen, or typed into
  OpenCode's input box as it starts (that would be conhost turning NexTerm's
  answer to OpenCode's query into keystrokes) — and a PowerShell or oh-my-posh
  prompt (which sends `9;9` with the directory) never adds an entry.
- *Notifications from Programs* off (Settings ▸ Terminal): nothing appears.
- When it fails, say which half: an entry but no toast is Windows' side —
  Settings ▸ System ▸ Notifications for NexTerm, Do not disturb; neither is
  conhost swallowing OSC 99 — note the Windows build. An entry that arrives
  only once something else on screen changes is ConPTY holding a sequence that
  draws nothing, as in V14.

### V22 — right-click copies or pastes, inside Claude Code and OpenCode too

Never run on Windows: checked against real xterm in headless Chromium on macOS
(with the setting switched on there), and the clipboard read by the backend on
macOS only. The Windows half — the text through arboard, and whether an image
is there through `IsClipboardFormatAvailable` — has never run. Settings ▸
Terminal ▸ *Right Click* should already say *Copy or Paste*, untouched.

- PowerShell: copy a line in Notepad and right-click in the terminal — it is
  pasted at the prompt and no menu opens. Copy two lines: they arrive as one
  block, not run one by one. Select some output and right-click: it is copied
  (paste it into Notepad) and the selection disappears; right-click again and
  it pastes.
- `opencode`: right-click with text on the clipboard — pasted into its input,
  and OpenCode does nothing with the click itself. Take a screenshot with
  `Win+Shift+S` (an image alone on the clipboard) and right-click — `[Image 1]`
  appears, as with `Ctrl+V`. Shift-drag over its text, then right-click — it
  is copied.
- `claude`: in its full-screen view a right-click pastes into the input (it did
  nothing before — V19), and copies a Shift-drag selection.
- `vim` with `:set mouse=a`, in insert mode: a right-click pastes, and vim
  hears no click (nothing selected, the cursor does not jump). `Shift`+right-
  click does nothing at all: no menu opens — NexTerm cancels WebView2's — and
  vim hears nothing either, as off macOS xterm never reports a Shift-click,
  Shift being its "select instead" key.
- Set *Right Click* to *Default*: a right-click opens WebView2's menu again, and
  in vim with `mouse=a` it reaches vim. Back to *Copy or Paste*: the next
  right-click pastes, no restart.
- When it fails, say which half: no menu and nothing pasted is the clipboard
  read (the devtools console says "a right-click could not paste the
  clipboard"); a menu opening means the click was not claimed at all; text
  that pastes while a screenshot does not is the image check — note what made
  the image (Snipping Tool, PrintScreen, a browser's Copy Image).

### V23 — Ctrl+Shift+Enter zooms a pane, and what it hides keeps running

Never run on Windows: built and tested on macOS, where the chord is ⌘⇧Enter
and the native menu holds the accelerator. Off macOS the chord is claimed by
the webview ahead of xterm, and ConPTY has to pass the resize on both ways.

- Split a group in three, run `ping -t localhost` in one pane and `htop` (WSL)
  or `vim` in another, and press `Ctrl+Shift+Enter` in the vim pane: it fills
  the group, its tab strip shows *Zoomed*, and vim redraws at the larger size
  with no stale rows from the smaller one. `Ctrl+Shift+Enter` again: all three
  panes are back with their old proportions, vim redrawn small, and `ping` has
  kept counting while hidden.
- At a PowerShell prompt `Ctrl+Shift+Enter` zooms and types nothing — no
  empty line runs. Inside `opencode` it zooms rather than inserting anything.
- While zoomed: ☰ → Terminal → *Toggle Pane Zoom* and the palette's *Toggle
  Pane Zoom* both toggle, and a click on a hidden terminal in the TERMINALS
  panel unzooms onto it.

### V24 — a layout template's startup commands run in PowerShell and cmd

Never run on Windows: the suites hold the typing against a mock shell, and on
macOS it was checked with zsh only. The command is typed when the shell's first
OSC 133 "D" arrives — which ConPTY may hold back with the next frame (see V14)
— or three seconds after the shell started.

- A saved group does not remember which shell each terminal ran — it opens
  every terminal in Settings ▸ Terminal ▸ Default Shell — so run this once with
  the default set to PowerShell and once with cmd. Make a group of two
  terminals, right-click it → *Save Group…*, then the saved entry → *Edit
  Startup Commands…*: `echo one && echo two` and `cd ..` (both valid in cmd,
  and in PowerShell 7; in Windows PowerShell 5.1 use `echo one; echo two`).
  Save; the row shows ▶ 2.
- Double-click the entry: each new terminal shows its prompt, then its command
  typed once and run — never twice, never before the prompt (a command echoed
  above the first prompt is typeahead), and never with a stray character from
  the `\r` that ends it.
- Run `ping -t localhost` in a terminal, *Save Group…* while it runs, and open
  *Edit Startup Commands…*: the field holds `ping -t localhost`. A terminal
  that only *ran* something earlier comes back empty.
- In *Edit Startup Commands…*, paste two lines copied from Notepad into a field:
  it is refused with a message, and nothing is joined into one long line.

### V25 — an OpenCode conversation comes back by name after a restart

Never run on Windows: checked against real OpenCode 1.18.34 on macOS — its
output through the backend's filter, `opencode session list` through the
backend with a Finder-like PATH — and in the suites. Three things are new
under ConPTY and a GUI launch: whether conhost passes OpenCode's window title
(OSC 0) on; whether a terminal's typed `opencode` is followed in PowerShell and
cmd; and whether the app, started from the Start menu, finds npm's
`opencode.cmd` to list conversations.

- In PowerShell, in a project folder: `opencode`, ask it anything, wait for the
  reply. Quit NexTerm with OpenCode still open (the window's ✕), start it again:
  that terminal says *Resume opencode?* and *Picks up "<the conversation's
  title>", the conversation this terminal had*. *Resume* types
  `opencode -s ses_…` and OpenCode opens that conversation.
- The same in cmd. And with two OpenCode terminals on the same folder, each in
  its own conversation: after the restart each offers its own by name, and each
  resumes into its own.
- *Choose…* lists the folder's conversations, newest first, the terminal's own
  ticked; picking another types `opencode -s` with that one's id.
- `opencode` started and quit again (`/exit`) before the restart: no offer.
  `opencode run "hi"`, `opencode --version`, `cd .. && opencode`: no offer.
- Four OpenCode terminals in one **git repository** folder in cmd, each in
  its own conversation, each with at least one reply before quitting: quit,
  start again, *Resume* each → four different `opencode -s ses_…`, never
  `--continue`. Two of them renamed to the same title after their first reply
  still each resume their own; two that never had a reply ask.
- With opencode removed from PATH: the offer says "opencode was not found on
  PATH" (readable, not garbled), and nothing is typed while another OpenCode
  terminal is open or was resumed in the same folder, above it or below it;
  unrelated folders and closed terminals don't count. An opencode too old for
  `--pure` reads its list from outside the repository and says so on the offer.
- After an "opencode session list: gave up after 20 s", Task Manager shows no
  leftover `node.exe` or `opencode.exe` from it.
- A folder on a share (`\\server\share`) is compared by spelling only; a
  repository on a share does not list its conversations (mapped drive letters
  do).
- When it fails, copy the offer's reason line word for word, and the output of
  `where.exe opencode`. A terminal line "opencode lists no conversation for
  this folder (…)" means opencode keeps the folder spelled differently: run
  `opencode session list --format json` in that folder and note its
  `directory`. Otherwise say which half: an offer that never names the
  conversation, even after the reply, is the title or the lookup. With Developer Tools open, the console says
  "could not look up the opencode conversation" when the lookup failed (note
  where `opencode` is installed: `where.exe opencode`); with no such line,
  conhost dropped the title. No offer at all is the typed line not being
  followed — note the shell.
### V26 — a shell that exits comes back with Enter

Reported from this PC (2026-10-07): quitting `opencode` with Ctrl+C in cmd
sometimes left a terminal printing "[NexTerm] PTY session not found: pty-5"
for every key. cmd had exited (the backend drops a session only when its shell
ends); why is not known yet. npm runs OpenCode through `opencode.cmd`, so a
second Ctrl+C can reach cmd at "Terminate batch job (Y/N)?" — the exit code
the terminal now prints will say. Never run on Windows since the fix: checked
in the suites with the browser mock.

- In cmd, start `opencode` and press Ctrl+C two or three times quickly, a few
  times over. Whenever cmd goes with it, the terminal shows one grey
  `[process exited with code …]` line — write down the code, it says how cmd
  ended (`0xC000013A, ended by Ctrl+C` is the suspected one) — and
  `Press Enter to start a new shell in this terminal.`, and no yellow
  `[NexTerm] PTY session …` line however many keys are pressed.
- Enter: a new cmd prompt at the top of the same pane, in the same
  directory; the old output and the notice are in the scrollback just above
  it (scroll up). Commands run, and the prompt and their output stay where
  they are written — nothing lands on top of old output. Resize the pane: the
  same. The tab's name is no longer struck through.
- If cmd went while OpenCode was still on screen: the notice shows over
  OpenCode's last screen, a drag there selects text (it does not reach
  OpenCode), and Enter brings back cmd's own screen with the cursor visible.
  Arrow keys and Shift+Enter then behave as in a new terminal.
- `exit` at a PowerShell prompt: the same notice with code 0, and Enter brings
  PowerShell back.
- When it fails, say which half: a yellow `[NexTerm] Could not start a new
  shell: …` is the spawn (note the text); keys still producing
  `PTY session …` lines means the notice was never reached — note the exit
  code printed, if any.

### V27 — Clear Terminal clears it, and stays cleared

Clear Terminal (palette, Terminal menu, Ctrl+L with the focus outside a
terminal) used to do nothing at all. It now clears xterm's screen and
scrollback; ConPTY is not told (portable-pty has no ClearPseudoConsole), so
the risk on Windows is ConPTY painting the old screen back on its next full
redraw. Never run on Windows: checked with the browser mock.

- In cmd, run `dir /s C:\Windows\System32\drivers` (a few screens). Click the
  Explorer, then Ctrl+L: the terminal is empty but for the prompt line at the
  top, and the scrollbar shows no scrollback.
- Drag a divider to resize the pane, then maximize and restore the window:
  the old output does not come back. Type `dir`: it prints below the prompt.
- Ctrl+L with the terminal focused is cmd's (nothing happens in cmd; in
  PowerShell it clears the screen itself) — NexTerm does not take it there.
- Palette: type `save all` — the first row is *Save All Files*, not *Clear
  Terminal*.

### V28 — no terminal starts on another machine

A directory on another machine (`\\host\share`) is never where a terminal
starts: starting a shell there, or only resolving the path, makes Windows
connect to the host and sign in with your credentials — and any program's
output can claim a directory (OSC 7). Never run on Windows.

- Settings ▸ Terminal ▸ Working Directory ▸ Custom path, type
  `\\localhost\C$\Windows`: the field says the directory is on another machine
  and a terminal never starts in one. Open a new terminal: it starts in the
  open folder (or your home directory), not there.
- In PowerShell, `cd \\localhost\C$\Windows`, then quit the shell with `exit`
  and press Enter: the new shell starts where the terminal was before the
  `cd`, not on the share. The same after closing and reopening NexTerm.
- A folder on a mapped drive letter (`Z:\…`) is a local path and works as
  before.

### V29 — closing with unsaved edits asks, and a dead page cannot hold the window

The backend decides every close now (src-tauri/src/commands/app.rs): with
nothing unsaved the window closes at once; with an unsaved editor tab it asks
the page, which shows Save / Don't Save / Cancel. A page that does not answer
within 2 s — crashed, hung — no longer keeps the window open. Never run on
Windows: checked with the suites and the browser mock.

- Edit a file without saving, then Alt+F4: the window comes forward if it was
  behind and asks. Cancel keeps everything. Alt+F4 again, Don't Save: the
  window closes, with no second "Leave site?" question.
- The same with the title bar's ✕ double-clicked: one question, not a close,
  and it stays up (the second press does not cancel it). Cancel, then press
  Enter: nothing happens — the keyboard is back in the editor, not on ✕.
- The same with nothing unsaved: Alt+F4 closes at once.
- Edit a file, then Ctrl+R or F5 with the editor focused: a "Leave site?"
  question (or nothing at all, if WebView2 already swallows the key — say
  which); the edit is still there afterwards.
- With a shell running, press Ctrl+R, F5 and Ctrl+Shift+R in each field that
  keeps its keys to itself: the Explorer's rename box (F2), its filter, the
  Search box, and a terminal tab's rename field. Nothing reloads — the shell
  is still there, same PID. Ctrl+R in the terminal is still reverse-i-search.
- Known and not fixed: shutting down, signing out or a restart for an update
  with unsaved edits loses them without asking (tao ignores
  WM_QUERYENDSESSION).

### V30 — pasting a pnpm or npm-workspaces project without Developer Mode

A copy of a folder whose node_modules is full of junctions failed at the first
one and rolled the whole paste back, because a symlink needs Developer Mode or
an administrator. Junctions are copied as junctions now. Never run on Windows.

- With Developer Mode off, in the Explorer copy a pnpm project (or any folder
  with a junction: `mklink /J link target`) and paste it beside itself. While
  it copies the Explorer says "Copying '…'…" and Paste is greyed; a hidden
  `.<name>.copying` folder appears and becomes `<name> copy` at the end.
- In the copy, `dir node_modules` shows `<JUNCTION>` entries, and the project
  runs (`pnpm test` or similar).
- A relative folder symlink in the source (made with Developer Mode on:
  `mklink /D shared ..\libs\shared` inside `packages\app`), pasted with it
  off: in the copy, `packages\app\shared` is a `<JUNCTION>` that opens the
  copy's own `libs\shared` — not a `.…copying` folder that no longer exists.
- Close NexTerm in the middle of a big paste: what is left is the
  `.<name>.copying` folder, never a half-filled `<name> copy`.

### V31 — Open Folder holds the window while the picker is open

The folder picker belongs to the window now. Never run on Windows.

- File ▸ Open Folder…: while the picker is open, clicking NexTerm does
  nothing (it is disabled behind the dialog), so nothing can be typed into a
  tab the folder switch would then close without asking.

### V32 — a link to another machine inside a project is never followed

With Developer Mode on (or a repository checked out with
`core.symlinks=true`), a link inside the open folder whose target is a share
(`mklink /D docs \\localhost\C$\Windows`) was followed — by the Explorer, Go to
File, search and opening a file through it — and following one signs in to
that machine. Never run on Windows.

- Open the folder: `docs` is listed as a link and does not expand. Go to File
  does not list anything under it; Search in Files finds nothing under it;
  opening `docs\…` from a terminal link says "Path goes through a link to
  another machine".
- The same through a second link: `mklink /D via docs` — `via` does not
  expand either, and nothing under it is listed, searched or opened.

### V33 — a file dropped onto a terminal is typed as its path

Dropping files onto a terminal types their paths into that pane's active
terminal, quoted for its shell, as one paste. Windows-only parts that the
Mac cannot check: WebView2 reports the drop position in PHYSICAL pixels (the
Mac reports points), the Explorer drag runs on Chromium's click rules, and
cmd's quoting rules are only checked against documentation. Never run on
Windows.

- At 125% and 150% display scaling, split a group into four panes and drag a
  file from Windows Explorer across them: the highlight ("Insert path") is on
  the pane under the pointer, including near the dividers and right under the
  title bar. Drop it: the path appears once, in that pane, with nothing run.
- cmd: drop `C:\Users\<you>\My Pics\a.png` → `"C:\Users\<you>\My Pics\a.png"`;
  a file named `100%done.txt` → quoted; drop two files → two quoted words, one
  space, no trailing space. PowerShell: `'…'`. Git Bash: `C:/Users/…`. WSL
  (`wsl.exe`): `/mnt/c/Users/…`.
- With OpenCode running under cmd, drop one PNG whose path has a space: it
  attaches as `[Image 1]` (OpenCode strips the quotes). Two files arrive as
  text.
- NexTerm's own Explorer: drag a file onto a pane → path typed, file NOT
  opened, terminal focused. Then: a plain click opens a file; a double click
  opens it once; a folder's arrow toggles once; Esc during a drag, then
  release a second later anywhere → nothing opens and nothing is typed; F2,
  then drag-select inside the name and release over the row → only the text
  is selected.

### V34 — Ctrl+click a listed name shows it in Explorer

Ctrl+click on a file or folder name in the output opens Explorer. The
Windows code — `ShellExecuteExW` with the "explore" verb for a folder,
`GetDriveTypeW` to leave mapped drives alone, `SEM_FAILCRITICALERRORS` — was
type-checked on the Mac and never run; the Korean `dir` headings were tested
in Node only. Never run on Windows.

- In cmd, `dir` in a folder holding `새 폴더`, `새 폴더 - 복사본` and `a b.txt`:
  hold Ctrl over each name → the whole name is underlined (not part of it);
  release Ctrl → the underline goes. Ctrl+click a folder → Explorer opens
  THAT folder; Ctrl+click a file → its folder opens with the file selected,
  and nothing runs (try it on an `.exe` and a `.bat`).
- `dir ..\other` and `dir /s`: names under each ` C:\… 디렉터리` heading open
  the folder they were listed in. `cd` elsewhere and Ctrl+click an older
  listing: still the folder it was listed in.
- Ctrl+click `xcopy /?` output or `cmd /c` text: no `S:\` or `C:\` is opened.
- A mapped network drive (`net use Z: …`), also disconnected: hovering with
  Ctrl held never hangs the window and its names are not underlined.
- Hovering without Ctrl, typing, double-click and right-click copy/paste on a
  name behave exactly as before. AltGr (Ctrl+Alt) does not flash an underline.
- In Git Bash: `ls /c/Users` names open `C:\Users\…`.
- A folder named `x.{645FF040-5081-101B-9F08-00AA002F954E}` in a `dir`
  listing is never underlined. `echo nul com1 con aux` hovered with Ctrl
  underlines nothing and does not hang.
- A path on an empty card reader or DVD drive, hovered with Ctrl: no
  "insert a disk" box.

### V35 — a split opens where the terminal being split is, in its shell

A split used to open at the workspace root in the default shell. It now
continues the terminal being split. Git Bash reports its directory as
`/c/Users/…`, which has to be handed to Windows as `C:\Users\…`; that was
checked only against the browser mock. Never run on Windows.

- cmd: `cd C:\Windows`, then Split Right (Ctrl+Alt+D; Ctrl+D is cmd's EOF) →
  the new pane is cmd, at `C:\Windows`.
- PowerShell (from a profile) → the split is PowerShell, same folder.
- Git Bash: `cd /c/Users` → the split is Git Bash at `/c/Users`. *Duplicate
  Tab* on it opens there too (it used to fall back to the workspace root).
- Settings ▸ Terminal ▸ Split Directory ▸ *Same as a new terminal*: the
  split opens where New Terminal does, in the Default Shell.

### V36 — cmd's "Terminate batch job (Y/N)?" is answered Y, and nothing else is

Matched on the cursor row after the user's Ctrl+C, by cmd's `^C` echo or its
English/Korean wording. Real ConPTY output in a Korean locale never seen.
Never run on Windows.

- `opencode` in cmd, Ctrl+C → the question appears and is answered `Y`; cmd
  is still alive at its prompt. Quit OpenCode slowly (wait a few seconds after
  Ctrl+C): still answered.
- `del *.*`, then at its "(Y/N)?" press Ctrl+C → no `Y` is typed.
- A batch file that runs `choice` (or any program asking "(Y/N)?") right after
  a Ctrl+C → no `Y`. Ctrl+C, then paste anything → no `Y`.
- PowerShell: nothing is ever answered. Setting off: the question stays.

### V37 — Delete moves to the Recycle Bin, and never deletes for good unasked

The drive, size and policy checks read the registry
(`HKCU\…\Explorer\BitBucket\Volume\{GUID}`, `KnownFolder`, the
`NoRecycleFiles` / `RecycleBinSize` policies) — written from documentation,
never run.

- First, the sanity check: opening, saving, renaming and deleting ordinary
  files and folders in the Explorer all still work. Every path is now refused
  when Windows would read it differently from how it is spelled (a name ending
  in `.` or a space can otherwise hit the folder above it), and a case that
  check did not anticipate would refuse ordinary paths too.
- Report `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume /s`
  on this profile. With no key for a drive, deletes there still go to the
  Recycle Bin (Windows' default); only a key that exists but cannot be read
  leads to *Delete Permanently?*.
- On C:: a file and a folder → in the Recycle Bin, restorable. A junction → removed
  as a link, its target untouched. A junction on a USB stick pointing into C:
  → removed as a link, not trashed.
- A folder bigger than the Recycle Bin's maximum size → *Delete Permanently?*
  ("too big for the Recycle Bin"), Cancel focused; Cancel keeps it.
- A mapped network drive, a USB stick, a `subst` drive, C: with "Don't move
  files to the Recycle Bin" → *Delete Permanently?* with the reason.
- A folder listed in the Explorer, then replaced by a junction from a
  terminal, then deleted → *Delete Permanently?* in link wording; only the
  junction goes.
- A USB stick or exFAT volume with 64 KiB clusters: a folder of many small
  files near the Recycle Bin's size → "too big for the Recycle Bin". A nearly
  full drive asks sooner (the 5% guess is taken of free space).
- Two failing deletes one after the other → two separate questions, each for
  its own item. Setting off → the old one-question permanent delete.

### V38 — pasting several lines asks first

Only a synthetic paste in Chromium was tested; WebView2's Ctrl+V and
Shift+Insert never pressed.

- cmd: Ctrl+V, Shift+Insert and a right-click paste of two lines → asked.
  *Paste* runs both, *Paste as One Line* runs one line, *Cancel* sends nothing.
  Ctrl+V then Enter at once → nothing pasted (Cancel has focus).
- One line with a trailing newline → not asked. OpenCode (bracketed paste) →
  not asked under Auto, except on Windows 10, where ConPTY drops the markers
  and it is asked; a paste containing `ESC[201~` → asked. PowerShell 7.6
  (PSReadLine 2.4.5) never asks for bracketed paste, so it is asked.
- An image-only clipboard into OpenCode still attaches; a dropped file still
  types its path. Right-click paste from the find field, then Cancel → focus
  back in the find field. Ctrl+W while asked → the question closes.

### V39 — editor tabs come back per folder

Only the browser mock was tested.

- Open three files in two groups (one dragged to the right edge), quit with
  the window's ✕, relaunch → same groups, tabs, shown tab and active group.
- Open another folder through Open Recent, then go back → the first folder's
  tabs. Do it again within a second of opening a file → that file is there too.
- Delete or rename one of the files in Windows' File Explorer (outside the
  app), relaunch → it is dropped (a file renamed outside counts as gone), no
  notice, the others are there.
- A folder on a mapped network drive with the drive disconnected → the app
  starts, the Explorer works, Open Recent and the palette hand focus back at
  once; a file opened and edited meanwhile is there after a restart; tabs
  appear within 15 seconds; the drive's files come back within the next
  three launches once it is back.
- From `src` in a terminal, Ctrl+click a printed `..\README.md` → the
  Explorer's README tab, not a second one. Open a file through a link typed in
  another case (`C:\PROJ\SRC\a.js`), relaunch → it comes back. With `a.js`
  already open from the Explorer, the link reveals that tab rather than
  opening a second.
- Hold a file with an exclusive lock (PowerShell:
  `$f=[IO.File]::Open('x.txt','Open','Read','None')`), relaunch → its tab is
  missing and nothing pops up; `$f.Close()`, relaunch → it is back. Keep it
  locked for three launches → on the third it is forgotten. A file locked in
  the right-hand group comes back in the right-hand group once unlocked.
- On a slow restore, delete one restored file in the Explorer before the tabs
  appear → it does not come back. Split the editor before they appear → the
  split stays. Open a file and keep typing in it as the tabs appear → no
  keystroke lost, the file stays in front; the restored tabs join its group.
- Setting off → nothing reopens. Back on → what is open now comes back next
  launch.

### V40 — the terminal that wants you is marked, and progress shows

Only the browser mock and the macOS build were tested. The taskbar half is
Windows-only and has never run.

- Four terminals in two groups, OpenCode in each with notifications on (see
  the README). Ask each something and switch to another terminal while it
  works → when one finishes or asks for permission, its pane gets an orange
  ring, its tab and group chip and its side bar rows a count, and the bell an
  unread entry. The terminal you are typing into gets none of it.
- `Ctrl+Shift+U` from inside another terminal → the newest one's terminal, in
  its group, cursor in it; ring and count gone. Again → the next one. With
  nothing unread → nothing happens, and `Ctrl+U` still clears the shell's line.
- Bell list: an unread row is bold, clicking it goes there and leaves it
  dimmed; *Mark all read* clears every ring; the bell is muted with no number.
- Minimise NexTerm while OpenCode works → the desktop notification as before;
  restore the window with that terminal active → its ring goes.
- Claude Code with `/config` → notifications → *Terminal Bell*, in a
  background terminal → a ring and one "Bell" entry, counting up, and no
  desktop notification. In PowerShell,
  `Start-Sleep 3; Write-Host -NoNewline ([char]7)`, then switch to another
  terminal within three seconds → the same. With
  `1..3 | % { Start-Sleep 3; Write-Host -NoNewline ([char]7) }` → still one
  entry, "×3".
- Progress, in PowerShell:
  `Write-Host -NoNewline "$([char]27)]9;4;1;40$([char]7)"; Start-Sleep 5`
  → a blue bar under the tab, 40% wide, the taskbar button green at 40%, both
  gone when the command ends. Repeat with `9;4;2;60` (red), `9;4;4;60`
  (yellow / paused) and `9;4;3` (sliding; the taskbar's own animation).
- Two terminals with progress, one at `2` (error) → the taskbar shows the
  error. Close that tab → the other's bar. Close both → the taskbar button is
  plain again.
- Record what winget (`winget install --id Git.Git` in a background terminal,
  cancel it), PowerShell 7 with `$PSStyle.Progress.UseOSCIndicator = $true`
  and `Invoke-WebRequest` of a large file, and Claude Code while it works each
  do. Some send OSC 9;4 only inside Windows Terminal (they check
  `WT_SESSION`); say which.
- Settings ▸ Terminal: *Progress Bars* off while a bar shows → the tab bar and
  the taskbar both clear at once. *Terminal Bell* off → bells do nothing.

### V41 — the TERMINALS panel says what each terminal is doing

Only the browser mock and the macOS build were tested.

- Terminals in cmd, PowerShell, Git Bash and WSL, each in a git repository →
  each row's second line shows its branch; the WSL one shows none. `cd` to a
  folder outside any repository → the branch goes.
- In cmd, `git switch -c v41-test` → the row shows `v41-test` when the
  command ends. A second terminal in a subfolder of the same repository
  follows within a second. Switch back and delete the branch afterwards.
- A folder on a mapped network drive (`Z:`), and a local link to one
  (`mklink /D C:\Temp\z Z:\` from an elevated prompt, then `cd C:\Temp\z`) →
  no branch, and nothing is shown on the network share's side (no access in
  its log, no credential prompt). Disconnect the drive → the panel does not
  hang.
- Drives that Windows does not call network drives: a `subst` drive pointing
  into a mapped drive (`subst Y: Z:\proj`), a cloud or rclone mount that
  shows as a local disk, and a volume mounted into a folder. Record for each
  whether a branch shows and whether the share sees any access; a hang must
  not spread to other terminals' branches.
- Four OpenCode terminals with notifications on (see V40) → rows show
  *OpenCode* and *Running*; when one asks for permission its row says
  *Waiting* with the message as its last notification; reading it dims the
  line.
- *Sort by Attention* on → the waiting terminal moves to the top of its pane
  and its group to the top; off → your own order. Right-click a row while
  sorted → *Close Terminals to the Right* is unavailable. Keep the pointer on
  a row while something becomes waiting → nothing moves and the sort button
  shows a dot; move off the rows or switch to another app → the order catches
  up. Double-click a waiting row → that row, not its neighbour, is renamed. On
  a touch screen, tap a row while another becomes waiting → the tapped row is
  the one activated.
- Settings ▸ Terminal: each *Show …* row turns its piece off; with branch,
  agent and last notification all off the rows are one line.

### V42 — tidy panes, no false password lock, imported themes

Only the browser mock and the macOS build were tested.

- Settings ▸ Terminal ▸ *Hide the Tab Strip of a Single Terminal* on → a pane
  with one terminal shows a thin handle instead of its strip. Moving the
  pointer over the terminal's first row and clicking there reaches the
  terminal (and the find bar's ✕ and the resume banner's buttons work).
  Click the handle → the strip opens just below it, over the terminal, without
  resizing it (a full-screen program does not redraw); click the handle again
  → it closes. Double-click the handle, and click twice a few pixels below it
  → nothing closes, splits or opens; the opened strip has no close buttons.
  On a touch screen, tap the handle, then tap it again a little low → it
  closes and nothing else happens; tap the handle and then *+* → a new tab.
  In OpenCode, press Escape in the terminal while the strip is open →
  OpenCode gets it; the strip stays. Switch to another app and back with the
  strip open from the keyboard → Escape still closes it. Drag a tab from
  another pane onto it → it merges; onto its edge → it splits. Double-click
  the opened strip's tab → rename, and Enter does not run anything in the
  shell. Add a second tab → the full strip is back.
- *Equalize Splits* in a group of three panes → equal shares, also nested.
  *Swap Pane With…* → the two terminals trade places with their programs and
  scrollback; while a pane is zoomed it is unavailable and says why.
- No lock ever appears on Windows: `runas /user:Administrator cmd` in cmd,
  `ssh user@host` at its password prompt in PowerShell, and `Read-Host
  -AsSecureString` all show no lock, and nothing else does either.
- With a startup command in a saved group, open it while another terminal
  waits at a password prompt → the startup command is typed into its own
  terminal as before.
- Import a Windows Terminal color scheme (`settings.json`'s `schemes` list, or
  one scheme saved as `.json`) → pick one, the terminals switch; a light
  scheme such as *One Half Light* is refused with its reason. Delete it →
  Dark Modern, with an undo.

### V43 — four terminals flooding: no freeze, no loss, typing still answers

Measured on macOS only (release build, App Nap off, medians of 3 —
TEST_INFRA.md *Performance mode*). On Windows **ConPTY sits in between**: it
parses what a program prints and sends its own redraw of the screen, so a
flood may already arrive coalesced and slower, and the gains may be smaller
or larger than on the Mac. That is what this check is for — numbers, not an
impression. It runs on its own from start to end; set aside about an hour.

Before you start: a clone of the repository at the PR's commit (the load
generator is `tests\perf\flood.js`), Node on `PATH`, the PR's portable build
and the v0.21.0 portable build, AC power, nothing heavy running, the window
the same size for every run and **not covered or minimised** (WebView2 slows a
hidden page). Write down Windows' build, WebView2's version, the CPU, the
window size and the terminal font size.

1. **Measured runs, one build, before and after.** From `cmd.exe` in the
   clone, with the PR's build. Each run opens its own groups, types the load
   into them, closes them, and leaves a *perf: cpu* group with the table;
   both files land in `%TEMP%\nexterm-perf` (`report-<stamp>.json` and `.md`).

   ```bat
   rem After: the build as it ships.
   set NEXTERM_PERF=1& set NEXTERM_PERF_SCENARIOS=S1,S2,S3,S4,S5& set NEXTERM_PERF_REPEAT=3& set NEXTERM_PERF_TOOLS=%CD%\tests\perf& "<PR build>\NexTerm.exe"
   rem Before: the same build with this stage's three changes switched off (= v0.21.0's output path).
   set NEXTERM_PERF=1& set NEXTERM_PERF_SCENARIOS=S1,S2,S3,S4,S5& set NEXTERM_PERF_REPEAT=3& set NEXTERM_PERF_TOOLS=%CD%\tests\perf& set NEXTERM_PERF_FLOW_KB=0& set NEXTERM_PERF_BATCH_MS=0& set NEXTERM_PERF_PACE_MS=0& "<PR build>\NexTerm.exe"
   ```

   Do both with the default shell set to **cmd**, then both again with
   **PowerShell** (Settings ▸ Terminal ▸ Default Shell): four runs. Run *after*
   first, and run it twice if its two halves disagree — measure one build
   twice before comparing two. Close the app between runs. A run that has not
   written its table after 30 minutes has hung: say so, with the last
   scenario its groups showed.
   - **Pass:** *after* has `0` in *Lost lines* in every row; S2 and S4
     finish (a time in *Time s*, not a timeout); S4's typing p95 is well below
     *before*'s; the window never stops answering during S2 (drag it while the
     floods run). Report every row of all four tables, not only the ones that
     improved.
   - **Fail, and the most important one to report:** *after* loses lines
     where *before* does not. Flow control holds the reader, which leaves
     ConPTY's pipe full; on a unix PTY that makes the program wait, but if
     conhost keeps drawing and drops what scrolls past between frames, flow
     control would be creating the loss it is meant to prevent on Windows.
   - A *before* that loses lines or never finishes S2/S4 is the expected
     v0.21.0 behaviour on the Mac, not a failure of this check.
2. **v0.21.0 itself, by hand** (it has no performance mode). Start the
   v0.21.0 portable build, open four terminals in one group (two splits each
   way) and in each run `node tests\perf\flood.js flood --seconds 20`; in a
   fifth terminal start
   `node tests\perf\cpu.js --pid <NexTerm.exe's pid> --out %TEMP%\nexterm-qa\v0210-cpu.jsonl`
   before them and stop it with Ctrl+C after. Do the same with the PR's build
   (no environment variables). Note for each: did the window freeze (how long,
   roughly), did typing in a sixth terminal echo, did each flood's last line
   `[nexterm-perf] mode=flood …` appear, and the CPU file's size — attach both
   `.jsonl` files.
3. **Four OpenCodes.** With the PR's build, four terminals each running
   OpenCode, give all four a task that prints a lot at once (for example
   "read every file under src/lib and summarise each"). While they print:
   type in one, switch between them with clicks and with the keyboard, paste
   a line. **Pass:** typing echoes without a noticeable wait, a terminal you
   switch to is up to date at once, the paste warning still shows for a
   multi-line paste, and an OpenCode you are not looking at still raises its
   ring and count when it finishes. Write down how it felt beside v0.21.0 if
   you can run the same in it.
4. **Minimised.** With the PR's build, in one terminal run
   `node tests\perf\flood.js bulk --mb 50` and note the `seconds=` in its
   last line, with the window in front. Run it again and minimise NexTerm at
   once; restore it after a minute and read `seconds=` again. **Pass:** the
   minimised run took about as long as the one in front (WebView2 slows a
   minimised page's timers; NexTerm must not let that slow the program), and
   the output is all there (its last line follows the one before it). Do the
   same with v0.21.0 for comparison if you can.
5. **Ctrl+C and a resize in a flood.** With the PR's build (no environment
   variables), four PowerShell terminals in one group each running
   `node tests\perf\flood.js flood --seconds 60`. After five seconds drag a
   pane divider back and forth, then click one terminal and press Ctrl+C.
   **Pass:** the window keeps answering while you drag (a resize is a
   synchronous call to ConPTY, made while its pipe is full), and that flood
   stops within a second or two and its prompt comes back — write down
   roughly how long. Then the same in cmd terminals, once more running the
   flood through a script
   (`echo node tests\perf\flood.js flood --seconds 60 > %TEMP%\nexterm-qa\f.cmd`,
   then `%TEMP%\nexterm-qa\f.cmd`) so Ctrl+C asks *Terminate batch job
   (Y/N)?* → it is answered as before (V36), with the flood still printing
   behind it.

Put the four `.md` tables, the notes from 2–5 and the machine details into
`%TEMP%\nexterm-qa\report.md`.

### V44 — a folder's own commands, quoted for cmd and PowerShell

Checked on macOS and in the browser mock. On Windows only CI has run the
quoting: the PC-28–PC-30 suites hand every value of a table through
`cmd /d /s /c` and through Windows PowerShell 5.1 and PowerShell 7
(`-EncodedCommand`) and compare what arrives — not at a prompt typed into by
a person, which is what this check is for.

Set up a scratch folder `%TEMP%\nexterm-qa\pc` with `.nexterm\commands.json`:

```json
{
  "version": 1,
  "commands": [
    { "name": "Show a value", "command": "node -e \"console.log(JSON.stringify(process.argv.slice(1)))\" {{v}}" },
    { "name": "Pick a mode", "command": "echo {{mode}}", "placeholders": { "mode": { "choices": ["debug", "release"] } } }
  ]
}
```

1. Open the folder → nothing runs and nothing is asked. ⌘⇧P / `Ctrl+Shift+P`
   → *Review This Folder's Commands…* lists both lines in full. *Cancel* →
   still not trusted; open it again → *Trust* → the two commands are in the
   palette, marked *Project*. Hold Enter on *Trust*, and double-click it → it
   trusts once, nothing else happens.
2. From a **cmd** terminal, *Show a value* into a *New split* with each of
   these, *Run* → node
   prints a list of exactly one item equal to what was typed: `two words`,
   `한글 경로`, `C:\my dir\`, `a&b|c<d>`, `(x)`, `it's`, `^`. Each of `%PATH%`,
   `100%`, `say "hi"`, `hi!`, `x y₩` is refused under the field with the
   reason, and *Run* is unavailable. An empty value → node prints `[]`.
   *This terminal* → only *Type Only*: the line waits at its prompt, nothing
   runs until you press Enter.
3. The same in **Windows PowerShell** (and PowerShell 7 if installed):
   `it's`, `it’s`, `$env:PATH` (printed as written, not expanded), `a,b`,
   `-x`, `1e3`, `한글 경로` arrive as typed; `--%`, `say "hi"`, `x y₩` and
   `C:\my dir\` are refused with the reason. With the Korean IME, type a
   value in Hangul and press Enter while the last syllable is still being
   composed → the syllable is committed and nothing runs; a second Enter runs
   it, with the whole word in the line.
   In a **Git Bash** terminal `/api/v1` is refused (Git Bash would rewrite it
   into a Windows path); in a **WSL** terminal `C:\dir\` and `it's` are
   refused, and `two words` arrives as typed.
   Type `echo half` at a prompt without Enter, then pick *Show a value* →
   *This terminal* is not offered (something is typed there). Run `timeout 3`
   and type `echo late` while it waits, then pick *Show a value* → *This
   terminal* types the line after `echo late` and does not press Enter, so
   both show at the prompt and nothing runs.
4. Start OpenCode in a terminal and pick *Show a value* there → *This
   terminal* cannot be chosen and says why; *New split* opens a split and types
   the line into its shell once the prompt is up — quoted for that split's
   shell (pick it in a cmd group and in a PowerShell group). Type keys while
   the split starts → they stay in the terminal you were in; the keyboard moves
   to the split only after the line is typed.
5. Change one character of `commands.json` in another editor → the palette
   says the commands changed since they were trusted, and lists them again
   only after a new *Trust*. *Stop Trusting This Folder's Commands* → back to
   the review row.
6. Replace `.nexterm` with a junction to another folder
   (`mklink /J .nexterm %TEMP%\nexterm-qa\elsewhere`, with a
   `commands.json` there) → not read; the palette says it is a link. If a
   mapped network drive is at hand, open a folder on it with a
   `.nexterm\commands.json` → not read, and it says why (no credential prompt,
   no delay).
   If OneDrive is set up, copy the scratch folder into it: with
   `commands.json` downloaded, its commands load as before; with it made
   online-only (right-click → *Free up space*), the palette says it is
   online-only and asks to open it once — and nothing is downloaded behind
   your back.
7. Settings ▸ Terminal ▸ *User Commands*: paste the JSON above with `"version": 2`
   → the field says why; fix it → the commands are in the palette marked
   *User*, in any folder.

Note in `%TEMP%\nexterm-qa\report.md` what each value printed, and anything
refused that should not have been.

### V45 — output comes back after a restart

Checked on macOS, in the browser mock and against `@xterm/headless`. On
Windows nothing but CI has run it, and CI has no ConPTY on screen: whether
the restored lines survive what ConPTY sends as a shell starts — it may clear
the screen and paints by position — is what this check is for. NexTerm moves
the restored lines into the scrollback above an empty screen for exactly
that reason (`restoreText`, `pushIntoScrollback`); if they are painted over
or erased anyway, say so with a screenshot.

The files are in `%LOCALAPPDATA%\com.nexterm.ide\scrollback` (one
`tab-term-N.scrollback` per terminal), not in Roaming.

1. In a **cmd** terminal: `dir %WINDIR%`, then `echo 한글 출력 확인` and
   `echo ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5`. Split it and in a
   **PowerShell** terminal run `Get-ChildItem Env: | Select-Object -First 20`
   and `Write-Host red -ForegroundColor Red`. If WSL is installed, a **WSL**
   terminal with `ls --color=always /`. Wait two seconds.
2. Close the window with ✕. Reopen NexTerm → each terminal starts with an
   empty screen and its prompt at the top; scroll up one line → a dim
   `── Previous output · <today's date and time> ──` line, and above it the
   output of step 1 with its colours, Hangul two cells wide and lined up,
   and the token shown as `ghp_[hidden]`. Nothing was run again. Open the
   file of the cmd terminal in Notepad → the token is not in it.
3. Resize the window narrower and wider → the restored lines rewrap like the
   rest. ⌘F / `Ctrl+F` finds a word of the restored output; Ctrl+click a
   file name in the `dir` output reveals it in Explorer.
4. Start `opencode` (or `vim` in WSL) in a terminal, wait, close the window
   while it is open, reopen → what the shell printed before it is back, the
   full-screen program's screen is not. On Windows 10 ConPTY does not pass
   the alternate screen on, so its frames may come back as text — note it.
5. Print something new, wait six seconds, end NexTerm from Task Manager
   (*End task*), reopen → it is all back. Print again and end it at once →
   up to the last five seconds may be missing. Do the same while a terminal
   keeps printing (`ping -t localhost`) → at most the last ten seconds are
   missing. Run `cls`, end it at once from Task Manager, reopen → note
   whether what `cls` cleared comes back (it should not if ConPTY clears the
   scrollback for `cls`; say which).
6. Close the window from the taskbar's thumbnail while NexTerm is
   minimised → it closes without popping up first. Start a second NexTerm
   while one is open → it restores nothing and saves nothing (the first
   keeps its files).
7. Close a terminal (its tab's ✕) → its file is gone from the folder.
   Settings ▸ Terminal ▸ *Clear Saved Scrollback* → asks first; confirm →
   the folder is empty. Turn *Restore Scrollback* off → the files go and
   nothing comes back at the next start; on again → saved again from then on.

Note in `%TEMP%\nexterm-qa\report.md` what came back where, the screenshot
of step 2, and the file sizes.

### V46 — nexterm-cli and the control API

Checked on macOS (a real socket) and in CI. On Windows, CI has created the
pipe, read its DACL back, checked that a second server under the same name is
refused, and run the CLI against a real pipe; nobody has called it from a
NexTerm terminal on a real PC, or from another account. That is what this
check is for.

1. In a **cmd** terminal: `where nexterm-cli` → one copy, in
   `%LOCALAPPDATA%\com.nexterm.ide\bin` (a folder that holds nothing else —
   `where uninstall` and `where nexterm` find nothing there);
   `echo %NEXTERM_CLI%` is the same path. `nexterm-cli --version` → the app's
   version. `nexterm-cli notify "Test" "한글 알림"` → a notification from
   that terminal, Hangul intact (also on the desktop while NexTerm is in the
   background). `nexterm-cli set-status "빌드 중"` → that terminal's line in
   the TERMINALS side bar; `nexterm-cli set-status --clear` → gone.
   `nexterm-cli set-progress 40` → the tab's bar and the taskbar button at
   40 %; `--clear` → gone. `nexterm-cli list` → a table with this terminal
   marked as itself.
2. The same from **PowerShell** and **Git Bash**. In **WSL**:
   `nexterm-cli.exe list` works (interop), and `echo $NEXTERM_CONTROL` shows
   the pipe name.
3. `nexterm-cli new-split --down -- dir` → a split below, `dir` typed and
   run there, the new tab's id printed. `nexterm-cli send --to child:<that id>
   "echo hi" --keys Enter` → refused: typing is off. Turn on Settings ▸
   Terminal ▸ Control ▸ *Let programs type into and read terminals*, repeat →
   typed into the split, which flashes and shows a mark naming the caller;
   *Show Control Log* in the palette lists the call without the text.
   `nexterm-cli read-screen --of child:<id> --lines 20` → its last lines.
   Into any other terminal → refused until *Let programs control other
   terminals* is on. In the split run `ssh localhost` or
   `powershell -c Read-Host -AsSecureString` and, at its password prompt,
   `nexterm-cli send --to child:<id> "x"` → refused (the prompt-line
   heuristic is all Windows has; note any prompt it misses).
   `echo dir | nexterm-cli send --to child:<id> -` → `dir` typed and run.
   From another terminal, `nexterm-cli focus child:<id>` while you are
   typing in NexTerm → the split only flashes and is marked, the keyboard
   stays; with NexTerm minimised → the taskbar button flashes, and when you
   come back the same tab still has the keyboard. Run `gsudo cmd` (if
   installed) or an elevated `sudo` inline in the split, then
   `nexterm-cli send --to child:<id> "whoami"` → refused (elevated).
4. Run `runas /user:<another local account> cmd`, and in that window
   `set NEXTERM_CONTROL=<the pipe name from step 2>` and run any
   `nexterm-cli` command → refused (exit 4), nothing in NexTerm, nothing in
   the log. If no second account exists, say "could not check".
5. Start a second NexTerm while one is open; a token from a terminal of one
   (`set NEXTERM_CONTROL_TOKEN=…` copied into a terminal of the other) →
   `unauthorized`.
6. In a cmd terminal, `set` → `NEXTERM_CONTROL_TOKEN` is printed; close and
   reopen NexTerm → the restored output shows it as `[hidden]`.
7. Turn *Let programs in terminals control NexTerm* off → every call from an
   open terminal fails with "NexTerm is not running, or its control is turned
   off" (exit 5); a new terminal has no `NEXTERM_CONTROL`. On again → new
   terminals work; older ones do not until restarted.
8. Run `nexterm-cli list` in a Windows Terminal or PowerShell window outside
   NexTerm → "Not inside a NexTerm terminal", exit 3.

Note in `%TEMP%\nexterm-qa\report.md` each command's output and exit code
(`echo %ERRORLEVEL%`), and anything refused that should not have been.

### V47 — the UI refresh: violet, bluish greys, one focus rule, panels that fit

Only the render suite read the stylesheet and the class strings; nothing was
looked at in a real window. Check on Windows (WebView2, at 100%, 125% and 150%
scaling) and on macOS (WKWebView), side by side with v0.28.1 where it says so.

- **H1 fields.** Click into each field: the palette (from *Search NexTerm*),
  the terminal find bar, the Explorer filter, Search, the Settings fields,
  select and search, the project-command and startup-command fields, the key
  capture in Keyboard Shortcuts, and every rename (terminal tab, group,
  TERMINALS row, Explorer). Only the field's own 1px border turns violet: no
  inner rectangle, no outline outside it, no text moving by a pixel.
- **H2 the keyboard ring.** A mouse click on a button, tab or chip shows no
  ring. Tab and the arrow keys through the title bar, the dialogs, Settings
  and the theme cards show a light-violet 2px ring on each. On macOS try with
  System Settings ▸ Keyboard ▸ Keyboard navigation off and on, and write down
  which controls Tab reaches in each.
- **H3 active and attention.** With three panes, the active one has a violet
  line; ring a bell in it and the orange ring shows inside the violet line,
  and the two read as two things.
- **H4 no stray blue.** Primary buttons, the status bar's folder item,
  progress bars, activity dots, drop overlays, a separator under the pointer
  and while dragged, and the marks of the activity bar, the region tabs and
  the editor tabs are violet. Blue is left only on info icons.
- **H5 selection.** A selected row is a readable violet tint in the palette,
  the context menu, the ☰ menu, the Explorer, TERMINALS, terminal text,
  editor text and selected text in a field.
- **H6 High Contrast** (Night sky and Desert). A focused field shows a
  Highlight outline; the active pane's line and the attention ring differ; the
  keyboard ring is visible.
- **H7 reduced motion** (the OS setting on macOS and Windows, and NexTerm's
  own). Colour changes on fields, buttons and separators are instant.
- **H8 at 960×640** with both side bars open and a long folder name: the pill
  and the folder name do not overlap; ☰ and the window buttons work; the empty
  title bar still drags the window; the bell stays with a long terminal
  folder; the bottom panel at its smallest shows three or more terminal rows;
  each separator is easy to grab, shows the resize cursor a few pixels either
  side, and is a violet line while dragged; 1px lines are crisp, not doubled,
  at 125% and 150%.
- **H9 native controls.** The Settings select and checkboxes are violet and
  readable on Windows.
- **H10 corners.** Menus, the palette, dialogs and notices have 8px corners
  and nothing is cut off at them; menu rows are inset with corners of their
  own; secondary buttons have an edge.
- **H11 the gallery.** The chosen card has a violet border; the NexTerm Dark
  card shows the new colours; the other 8 cards look as in v0.28.1.
- **H12 side by side with v0.28.1.** The terminal (background, how bright the
  text is, `ls --color`, `git diff`, cmd.exe, the OpenCode and Claude Code
  screens, dim and bright-black text, blue text) and the editor (syntax
  colours, selection, line numbers, indent guides, the find widget, Monaco's
  context menu). Write down anything that reads worse, looks purple on this
  monitor, or is too bright.
- **H13 an imported theme** imported before the change looks as before, but
  for the colours it left out: one Windows Terminal scheme and one Ghostty
  file.

### V48 — prompt marks on the scrollbar

The tracker ran against xterm's headless build and the ruler, the click, the
find colours, the selection and the alternate screen in headless Chromium
(tests/adversarial/prompt_marks.test.js and prompt_marks_headless.test.js);
no shell and no WebView2 or WKWebView was involved. On a release build,
Windows with cmd first:

- **H1 cmd.** A new cmd tab: its first prompt has a mark. Run `dir` three
  times: one mark per prompt, empty Enters included. Scroll to the top and
  click the second mark: that prompt is on the top row.
- **H2 clear.** `cls`, then a few commands: the marks from before `cls` are
  gone and the new prompts have theirs. *Terminal: Clear* (`Ctrl+L` outside a
  terminal, or the palette): one mark is left, on the prompt you are at.
- **H3 PowerShell.** As H1 and H2 in powershell.exe and pwsh, then
  `1..20000 | % { "line $_" }` (more than the scrollback): prompts that left
  the top have no mark, and every mark left lands on its prompt when clicked.
- **H4 OpenCode from cmd.** While OpenCode is up the marks and the scrollbar
  are hidden; after it exits the old marks are back, the scrollbar shows at
  rest again, and the new prompt has one.
- **H5 Claude Code.** The prompt Claude Code was launched from has a mark, and
  so has each message sent to it (blue; V49); the prompt after it exits has
  one.
- **H6 resize.** Drag a separator to make a cmd pane narrower, then wider, and
  click a mark each time: it lands on its prompt. Write down any drift, in
  rows (Windows 10 ConPTY repaints after a resize).
- **H7 High Contrast** (Night sky and Desert): prompt marks in the Highlight
  colour, message marks in LinkText, the box visible with its outline at rest
  as well as with the pointer over the terminal.
- **H8 motion.** With Windows' *Animation effects* off, and with NexTerm's
  reduced-motion setting: the box is shown at rest and nothing fades; on a
  full-screen program it is hidden at once.
- **H9 the keys.** `Ctrl+Shift+↑` / `Ctrl+Shift+↓` step through the prompts in
  cmd and in PowerShell (PSReadLine keeps its own keys otherwise); in OpenCode
  the keys reach OpenCode. Rebind one in Settings ▸ Keyboard and try again.
- **H10 restore.** Restart with Restore Scrollback on: the restored text has no
  marks; the new shell's prompts, below the separator, do.
- **H11 the setting.** Settings ▸ Terminal ▸ *Prompt Marks on Scrollbar* off
  and on: the marks go and come back at once, and the text does not reflow
  (the column count in the status bar or `mode con` stays the same).
- **H12 four terminals flooding** (the V43 scenario) with marks on: no freeze,
  typing still answers, and the marks are on their prompts afterwards.
- **H13 a two-line prompt through ConPTY.** Put a two-line prompt in pwsh's
  `$PROFILE` (`function prompt { "PS $PWD`n> " }`, or oh-my-posh with a
  two-line theme; the shell integration wraps the prompt the profile left),
  open a new pwsh tab and press Enter a few times: a two-line PowerShell
  prompt gets its mark on its first line, the `PS` line, and a click on it
  puts that line on the top row. Then cmd, with `setx PROMPT "$P$_$G"` and a
  new cmd tab (remove the variable afterwards, in Environment Variables). A
  mark on the second line means ConPTY moved the signal behind the prompt
  text: write down which shell and which line, as the README says this is
  unverified on Windows.

On macOS with zsh: H1, H2 and H9 with `⌘⇧↑` / `⌘⇧↓`; a two-line prompt, with
starship or powerlevel10k: write down which line of it each mark is on, over a
few prompts (the first line, or the empty line above it, whether the prompt
is drawn after the signal or comes with it; prompt_marks.test.js PRM-02,
PRM-26); and that the box shows at rest in WKWebView,
brighter on hover.

### V49 — Claude Code's messages on the scrollbar, and the scrollbar at rest

The rules were built from Claude Code 2.1.327 recorded in a pty
(tests/adversarial/fixtures/claude_code/, replayed in
agent_message_marks.test.js) and checked in headless Chromium
(prompt_marks_headless.test.js PMB-14 to PMB-21); no real Claude Code ran in
a NexTerm build. On a release build with real Claude Code, Windows first
(cmd and PowerShell), then macOS:

- **C1 the variable.** In a new terminal, `echo %CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN%`
  (cmd) or `$env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` (PowerShell) prints
  `1`. `claude` starts on the normal screen, and its conversation scrolls with
  the wheel and with the slider.
- **C2 the marks.** Send a short message, a Korean message long enough to
  wrap, and a pasted multi-line block: each has a blue mark on its `❯` row,
  the input box never has one, a click on each puts that message on the top
  row, and `Ctrl+Shift+↑` / `Ctrl+Shift+↓` step through the messages and the
  launch prompt in order.
- **C3 while it works.** A message sent while Claude Code is still working,
  with a todo list or tool progress visible above the box, is marked when it
  shows in the transcript, with no stray mark. Write down any such message
  that gets no mark.
- **C4 commands.** `/model`, `/help` and an empty Enter: write down what is
  marked.
- **C5 redraws.** Make the pane narrower and wider, maximise the window,
  `Ctrl+O` and back, `/compact`, `/clear`: write down whether the marks still
  land on their messages, and any duplicates or drift. Then resize the pane
  while a message waits for its echo (sent while Claude Code works, not yet in
  the transcript): write down whether it gets its mark once it shows.
- **C6 exit.** `/exit`: the marks stay, the next shell prompt has its mark,
  and a second `claude` run is marked as well.
- **C7 the setting.** Settings ▸ Terminal ▸ *Claude Code on the Normal Screen*
  off: in a new terminal the variable is absent, Claude Code runs fullscreen,
  and there are no marks. With the setting on and the variable set to `0` by
  you before NexTerm starts: write down what Claude Code does.
- **C8 /tui.** `/tui fullscreen` with the setting on: write down the result.
- **C9 flicker.** A long streamed answer, compared with fullscreen: acceptable
  or not.
- **C10 restore.** Restart with Restore Scrollback on: the restored text has
  no marks, and new messages do.
- **C11 WSL.** `wsl`, then `claude` there: the variable arrives (`echo
  $CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`) and the scrollback works; no marks
  are expected.
- **C12 OpenCode**: see V50 (mini mode). With *OpenCode in Mini Mode* off
  it is as in v0.30.0: the keys reach it, and the scrollbar is hidden while
  it is up.
- **C13 High Contrast and motion.** The box is visible at rest with its
  outline, and the two kinds of marks can be told apart; with reduced motion
  nothing fades.
- **The right-hand strip.** The scrollbar now takes the pointer in the right
  10 px of a terminal on the normal screen at all times: start a selection
  drag there, and click there in a program that reports the mouse on the
  normal screen (for example `fzf --height=40%`): write down whether the drag
  selects text and the click reaches the program, or the scrollbar takes them.

On macOS: C1 to C6 with `⌘⇧↑` / `⌘⇧↓`, and the box at rest in WKWebView.

### V50 — OpenCode in mini mode, and its messages on the scrollbar

The rules were built from opencode-ai 1.18.34 (V1) recorded in a pty
(tests/adversarial/fixtures/opencode_mini/, replayed in
opencode_mini_marks.test.js); no real OpenCode ran in a NexTerm build. On a
release build with real OpenCode V1, Windows first, then macOS:

- **O1 the start.** New OpenCode Terminal types `opencode --mini --no-replay`;
  mini starts on the normal screen, and the wheel and the slider scroll the
  conversation.
- **O2 the marks.** A short message, a Korean message long enough to wrap,
  and a paste each get a mark on their `›` echo. The composer and the footer
  never do, a click puts the message on the top row, and `Ctrl+Shift+↑` /
  `Ctrl+Shift+↓` step through the messages and the shell prompts.
- **O3 while it works.** A message sent while OpenCode works is marked when
  its echo appears.
- **O4 an empty line.** A message with an empty line in it (`Shift+Enter`
  twice): write down whether it is marked.
- **O5 resize.** Pane narrower and wider, and the window maximised: the marks
  stay on their echoes; write down anything mini erases, and whether the
  session survives (Windows issue #51167).
- **O6 exit.** `/exit`: the marks stay, the session block shows, the next
  prompt is marked, and a second run is marked too.
- **O7 restart.** Quit NexTerm while mini runs, then Restore and Resume:
  write down what is typed. No two terminals share a conversation, and a
  session resumed with `-s` stays exact.
- **O8 the setting off.** *OpenCode in Mini Mode* off: plain `opencode`, the
  full TUI as in v0.31.0, and the keys reach OpenCode.
- **O9 by hand.** `opencode` typed by hand gives the full TUI. `opencode
  --mini` typed by hand is marked; resize it and write down what happens with
  replay on.
- **O10 notifications.** A turn that finishes, and a permission request,
  while the window is unfocused: write down whether a toast shows, in mini
  and in the full TUI (the v0.28.1 report).
- **O11 themes.** Another OpenCode theme (a light one): the echoes are still
  marked; write down their colour.
- **O12 `-s` resume.** Write down whether mini prints earlier messages; none
  of them gets a mark. Then Resume again, type a message and press Enter
  right away, before mini has drawn: write down any mark on the history
  (none is expected; that message itself may get none).
- **O13 other versions.** If possible, an OpenCode older than 1.17.10, or V2:
  NexTerm types plain `opencode`.
  - **O13a upgraded mid-run.** Start OpenCode once, then upgrade or replace
    opencode while NexTerm runs (to V2, if possible) and start it again: the
    answer is kept for the run, so NexTerm still types the flags it chose
    first. Write down what that opencode does; after a NexTerm restart, or
    with the setting off, it gets plain `opencode`.
  - **O13b a folder-pinned version.** In a folder where nvm, mise, asdf or
    volta (or a PowerShell alias) gives another opencode than the login
    PATH: write down `opencode --version` there and what NexTerm types.

On macOS: O1 to O3, O6, O8 and O10 with `⌘⇧↑` / `⌘⇧↓`.

### V51 — open files belong to terminal groups (editor placement, part B)

The store and the restore are covered by tests/adversarial/workbench_*.test.js
under Node. Nothing there runs in a real webview or a real upgrade. On a
release build, Windows first, then macOS:

- **B1 per-group files.** Open two files in Group 1, make Group 2, open a
  third file there. Switching groups shows only that group's files, and a
  group with none shows no editor area. Switching back shows the first two
  again, with the caret, scroll and undo where they were.
- **B2 reveal in another group.** In Group 2, click one of Group 1's files in
  the Explorer: Group 1 comes on screen, showing it, and no second tab opens.
  The same holds for Go to File (`⌘P` / `Ctrl+P`), a search result and a
  file link in a terminal.
- **B3 group close.** Type in a file of Group 2 without saving, then close
  Group 2. The prompt names the file. Cancel leaves the group, its files and
  its terminals running. Don't Save closes them. Save writes the file, then
  closes the group.
- **B4 relaunch.** Two groups, files split in two editor panes in one of
  them, custom pane sizes: quit and start again. Every terminal, every file,
  its group, its pane, the sizes and the active file come back.
- **B5 upgrade.** With files open in v0.32.0, install this build over it.
  Every terminal comes back as it was. Every file comes back in the active
  group, above its terminals, with its splits.
- **B6 Restore Open Files off.** Settings ▸ Editor ▸ Restore Open Files off,
  quit, start again: no file comes back, and the terminals do.
- **B7 the webview.** Drag an editor tab within its strip, onto another
  editor pane, and onto a pane's edge; drag a terminal tab the same way. Both
  behave as in v0.32.0. Then switch groups and type Hangul in a file with the
  IME: the composition is not lost or doubled.
- **B8 downgrade.** Run v0.32.0 again on what this build saved: every terminal
  and every file comes back. Only which group each file was in is lost.
- **B9 last terminal.** Close the last terminal of a group that holds files:
  the group stays, its terminal area shows "No terminal in this pane" with a
  New Terminal button, and it comes back that way after a relaunch.

### V52 — editors and terminals in one layout (editor placement, part C)

Covered under Node by tests/adversarial/workbench_*.test.js and in headless
Chromium by workbench_drag_headless, workbench_focus_headless and
editor_models_headless. Nothing there runs in WebView2 or WKWebView, with a
real OpenCode/cmd session or the Korean IME. On a release build, each check on
**Windows** (WebView2: cmd, OpenCode, Korean IME) **and on macOS** (WKWebView):

1. **V52-1:** With only terminals, open a file from EXPLORER. It opens above the terminals at about 60/40 in the same area. There is no separate editor area and no Maximize Panel button.
2. **V52-2:** Drag a file tab onto the left, right, top and bottom edge of a terminal pane. The indicator names the edge, and the drop splits there. The terminal keeps its scrollback and a running OpenCode/cmd session without a restart.
3. **V52-3:** Drag a terminal tab onto each edge of an editor pane. Over the editor's tab strip, and over the middle of the other kind's pane, only edges are offered, and releasing on the strip changes nothing.
4. **V52-4:** Drag a file tab onto another group's chip. The file moves there.
5. **V52-5:** Type in a file, move it beside a terminal, then Ctrl+Z. The text is restored and the cursor is where it was. Korean IME composition in Monaco works after the move.
6. **V52-6:** Click an editor, then a terminal. Exactly one accent line is shown. Ctrl+S saves the file when the editor is active. Ctrl+W in an editor closes the file tab (with a prompt if it is unsaved); on the last tab the pane goes; in a terminal, Ctrl+W closes the pane. Ctrl+F opens Monaco's find in an editor and the terminal find bar in a terminal. Ctrl+Alt+D (Windows) or ⌘D outside Monaco (macOS) splits the editor into an empty editor pane; ⌘D inside Monaco still adds the next match.
7. **V52-7:** Focus Next/Previous Pane goes through editors and terminals, and typing goes to the focused one (nothing typed after landing on a file reaches the shell).
8. **V52-8:** Toggle Pane Zoom on an editor hides every other pane. Unzoom restores the sizes. The keyboard stays in the zoomed pane. Two more checks, on both release builds: (a) Inside Monaco, press the zoom chord (Ctrl+Shift+Enter on Windows, ⌘⇧Enter on macOS). It inserts a line above and does not zoom: the native menu's accelerator must not take the key first. (b) With the keyboard in a file, run Toggle Pane Zoom from the command palette, then run it again. The file pane zooms and unzooms, and each time the keyboard stays in its editor: what you type goes into the file.
9. **V52-9:** Resize the split between an editor and a terminal, then relaunch. Sizes, files per pane, the active pane and the active group come back.
10. **V52-10:** In a small window (1024x640 or a half-screen snap) with 6 panes, no pane collapses, and every terminal keeps its strip and about 3 rows.
11. **V52-11:** Toggle Terminal Panel hides the files too. Opening a file from EXPLORER while it is hidden shows the area again.
12. **V52-12:** Move the Terminal view to the right side bar. The editors move with it and keep undo.
13. **V52-13:** With an unsaved file in a group that is not on screen, Quit or close the window. One visible prompt appears, and Don't Save quits.
14. **V52-14:** Upgrade from v0.32.0 with saved files and terminals. Everything comes back, with the files above the terminals.
15. **V52-15:** A drag that starts on a tab and passes over Monaco text or an xterm selects no text and still lands.
16. **V52-16:** (Q-C1, option A) In a group with files, close its last terminal. 'No terminal in this pane' with New Terminal remains, without a Close button.

### V53 — Fork Conversation (bundle 1, A1)

Covered under Node by tests/adversarial/agent_fork.test.js (FK-*),
agents.test.js (AG-22, AG-23), agent_sessions_menus.test.js (ASM-19, ASM-20),
agent_history_palette.test.js (AHP-14) and the agent_history.rs tests, all
against the browser mock. Nothing there runs a real Claude Code (2.0.73 or
newer is needed for `--fork-session`) or a real Windows shell. On a release
build, in **PowerShell, cmd and Git Bash** each:

1. **V53-1:** Start Claude Code in a terminal, send it a message, then
   right-click its AGENT SESSIONS row → *Fork Conversation*. A **new** terminal
   opens in the same folder, in the active pane, and after the prompt shows
   exactly `claude --resume <id> --fork-session --session-id <new id>` is typed
   once. Claude Code opens with the earlier messages, and the original
   terminal is unchanged.
2. **V53-2:** The new conversation has its own AGENT SESSIONS row. Its tooltip
   says *Forked from* the original's name. Delete the original's row: the
   fork's tooltip then shows the original's short id.
3. **V53-3:** With the original's terminal active, open the palette and run
   *Fork Conversation*. The same happens. In an OpenCode terminal or a plain
   shell, the palette does not list *Fork Conversation*, and an OpenCode row's
   menu item is off with "OpenCode conversations cannot be forked here".
4. **V53-4:** Fork a row whose folder has been deleted. No terminal opens, and
   a "Folder not found" notice names the folder.
5. **V53-5:** Start Claude Code in a new terminal and quit it before sending
   anything, then fork its row. `claude --session-id <new id>` is typed instead,
   and the terminal and a "New conversation started" notice say why.
6. **V53-6:** Type `claude --resume <id> --fork-session --session-id <uuid>`
   yourself. The new row appears under the new id, *Forked from* the original.

### V54 — the empty pane's launcher (bundle 1, A2)

Covered under Node by tests/adversarial/agent_sessions_menus.test.js (ASM-21,
ASM-22) and workbench_render.test.js (WN-05, WN-08), against the browser mock
and a server render. Nothing there runs a real Claude Code or OpenCode, a real
Windows shell or a real click in WebView2. On a release build, in
**PowerShell, cmd and Git Bash** each:

1. **V54-1:** Open a file so the group keeps a terminal pane, then close its
   last terminal. The pane shows "No terminal in this pane", New Terminal with
   its shortcut, New Claude Code Terminal and New opencode Terminal, and no
   Close. Nothing is typed and no shell starts until you click.
2. **V54-2:** Split a terminal pane, close the terminal in the new pane, make
   the other pane active, then click *New Claude Code Terminal* twice quickly
   in the empty pane. **One** terminal opens, in the empty pane, not the
   active one. After the prompt shows, `claude --session-id <uuid>` is typed
   once. Do the same with *New opencode Terminal*.
3. **V54-3:** With at least four agent sessions in AGENT SESSIONS, one of them
   archived and used most recently, the empty pane lists the three newest
   that are not archived, newest first. Each row shows its title (in italics
   when it has none), its agent and its folder, and its tooltip shows the full
   folder.
4. **V54-4:** Click a recent session. A terminal opens in that empty pane, in
   the session's folder, and after the prompt shows `claude --resume <id>`
   (or `opencode -s <id>`) is typed once. Click a session whose terminal is
   already open: NexTerm switches to that terminal and opens none.
5. **V54-5:** Archive every session, or clear the history. The empty pane
   shows no "Recent agent sessions" section, and the agent buttons are still
   offered.

### V55 — Copy Context (bundle 1, A3)

Covered under Node by tests/adversarial/copy_context.test.js (CC-*),
palette_mounted.test.js (PM-20) and settings_window.test.js (SW-22), against
`@xterm/headless` and a stand-in clipboard. Nothing there writes a real
clipboard, so whether WebView2 (and, for the release check, macOS WebKit and
Linux WebKitGTK) accepts the write inside the click or Enter is checked only
here. On a release build, in **PowerShell, cmd and Git Bash** each:

1. **V55-1:** Print 300 numbered lines (PowerShell: `1..300 | % { "line $_" }`;
   cmd: `for /L %i in (1,1,300) do @echo line %i`; Git Bash: `seq -f 'line %g'
   300`), then right-click the terminal's tab → *Copy Last 200 Lines (Secrets
   Masked)* and paste into Notepad. Exactly 200 lines arrive, the numbered
   ones and then the prompt line last, with no colours or escape codes.
2. **V55-2:** Print a line longer than the terminal is wide, then
   `echo key sk-AAAABBBBCCCCDDDDEEEEFFFF1234 here`, and copy again from the
   TERMINALS row's menu. The long line arrives as one line, and the key line
   arrives as `key sk-[hidden] here`.
3. **V55-3:** Open the palette with the terminal active and run *Copy Last 200
   Lines (Secrets Masked)*, with Enter and once with a click. Each time the
   clipboard holds the lines; no "clipboard denied" message appears.
4. **V55-4:** Set Settings ▸ Terminal ▸ *Copy Context Lines* to 5. The menu
   item reads *Copy Last 5 Lines (Secrets Masked)* and copies 5 lines. Type 0:
   the field becomes 1. Type 20000: it becomes 10000.
5. **V55-5:** Restart NexTerm with two terminals in one pane, the second never
   clicked. Right-click its tab: the item is greyed out, and its tooltip says
   the terminal has not been shown yet. Click the tab, then the item works.
6. **V55-6:** In Git Bash, open a file in `vim` and copy from the tab's menu:
   the vim screen is what arrives. Turn Settings ▸ Terminal ▸ *Restore
   Scrollback* off and copy again: it works the same, as it writes no file.

### V56 — keep the computer awake while an agent works (bundle 1, A4)

Covered under Node by tests/adversarial/keep_awake.test.js (KA-*) and
settings_window.test.js (SW-23), against the real stores and a stand-in for
the backend, and by src-tauri/src/power.rs's own tests against a fake OS call.
Nothing there calls the real `SetThreadExecutionState`, so whether Windows
lists NexTerm's request, and lets the computer sleep again, is checked only
here. `powercfg /requests` needs an **elevated** PowerShell or cmd; run it
from a window outside NexTerm. On a release build, with Power Options set to
put the computer to sleep after a few minutes:

1. **V56-1:** With the setting off (the default), start Claude Code in a
   terminal and send it a message. While its TERMINALS row says Working,
   `powercfg /requests` lists nothing for NexTerm.
2. **V56-2:** Turn on Settings ▸ Terminal ▸ *Keep the Computer Awake While an
   Agent Works*. Its description says the display may still turn off and
   does not say *Not available on this system*. Send Claude Code a message:
   while the row says Working, `powercfg /requests` lists `[PROCESS]` with
   NexTerm's path under **SYSTEM**, and nothing for NexTerm under **DISPLAY**
   or **AWAYMODE**. Task Manager shows no new process under NexTerm.
3. **V56-3:** When the turn ends and the row says Idle, run
   `powercfg /requests` again: NexTerm is gone from SYSTEM. Start another turn
   and end it each of these ways in turn, checking the same after each: quit
   Claude Code (`/exit`), type `exit` in the shell, close the terminal, turn
   the setting off while it works, and quit NexTerm while it works.
4. **V56-4:** Start OpenCode in a terminal and give it work, and in another
   terminal run something that shows a progress bar (`winget upgrade --all`
   or `winget install` of a small package). While either works,
   `powercfg /requests` lists nothing for NexTerm.
5. **V56-5:** With the setting on, give Claude Code a task that works longer
   than the sleep timeout, and leave the PC alone. It does not sleep while the
   row says Working; the display may turn off. After the turn ends, it sleeps
   on its own timeout.

### V57 — a program names its terminal: `nexterm-cli set-title` (bundle 1, A10)

Covered under Node by tests/adversarial/tab_names.test.js (TN-09 to TN-14:
which name wins, `list`, clearing on exit and restart, nothing saved),
control_dispatcher.test.js (CD-55, CD-56), workbench_render.test.js (WN-09),
tests/render/runner.js (RN-231, RN-232) and the nexterm-cli tests (args.rs,
usage.rs, tests/cli.rs), all against the browser mock or a fake socket.
Nothing there runs the real `nexterm-cli.exe` through a Windows shell's
quoting or MSYS's path rewriting. On a release build, in **PowerShell, cmd
and Git Bash** each, in a terminal you have not renamed:

1. **V57-1:** Run `nexterm-cli set-title "Deploy staging"`. It exits 0 and
   prints nothing. The tab chip and its tooltip, the ✕'s tooltip and the
   terminal's TERMINALS row say *Deploy staging*; `nexterm-cli list`, run in
   another terminal, names it so. With that terminal alone in its pane and
   Settings ▸ Terminal ▸ *Hide the Tab Strip of a Single Terminal* on, the
   handle above it says *Deploy staging. Show its tab strip* when hovered. The other terminals
   keep their names.
2. **V57-2:** Run `nexterm-cli set-title 배포 중 2단계` (no quotes): the tab says
   *배포 중 2단계*. A 250-character title is refused: the command exits 2
   and the tab keeps *배포 중 2단계*. A title
   holding `MY_TOKEN=placeholder123` shows the value masked. In Git Bash,
   `nexterm-cli set-title /deploy` shows a Windows path (MSYS rewrote it) and
   `MSYS_NO_PATHCONV=1 nexterm-cli set-title /deploy` shows `/deploy`.
3. **V57-3:** Rename the tab to *mine* (double-click its chip), then run
   `nexterm-cli set-title other`. The tab, its row and `list` still say
   *mine*. Rename it to nothing (clear the field, Enter): it says *other*.
   Run `nexterm-cli set-title --clear`: it says *Terminal N* again.
4. **V57-4:** Set a title, then type `exit`. The struck-through tab says
   *Terminal N*, not the title. Press Enter for a new shell: still *Terminal
   N*. Set a title again, quit NexTerm and start it: the restored terminal is
   *Terminal N*, and a group saved (Save Group) while the title showed opens
   with *Terminal N*, never the program's title.
5. **V57-5:** Turn off Settings ▸ Terminal ▸ *Let Programs in Terminals
   Control NexTerm*; its description names set-title. `nexterm-cli set-title
   x` exits 5 and the tab does not change. Turn it back on. From WSL,
   `nexterm-cli.exe set-title wsl` names the terminal as in V57-1.

### V58 — a guide for agents: `nexterm-cli guide` (bundle 1, A9)

Covered by the nexterm-cli tests (guide.rs, args.rs, main.rs, tests/cli.rs:
exit 0 with `NEXTERM_CONTROL` and `NEXTERM_CONTROL_TOKEN` unset and no
server, exit 2 listing the topics, every example a valid command line, an
empty temporary HOME and folder still empty afterwards, plain ASCII of at
most 80 columns). Nothing there runs the real `nexterm-cli.exe` in a Windows
console. On a release build, in **PowerShell and cmd** each (read the exit
code with `$LASTEXITCODE` in PowerShell, `%ERRORLEVEL%` in cmd):

1. **V58-1:** In a NexTerm terminal, run `nexterm-cli guide`. It exits 0 and
   prints the index: six topics (notify, set-status, set-title,
   set-progress, new-split, read-screen), what each exit code 0 to 5 means
   for the caller, and `nexterm-cli help <command>` for the exact flags. In
   a window 80 columns wide no line wraps, and there is no stray character:
   no colour codes, no `?`, no boxes.
2. **V58-2:** Run `nexterm-cli guide <topic>` for each of the six topics:
   each exits 0 and starts with `nexterm-cli guide <topic> - `. `guide
   read-screen` names the three switches of Settings ▸ Terminal ▸ *Control*
   as the Settings window does (*Let Programs in Terminals Control NexTerm*,
   *Let Programs Type Into and Read Terminals*, *Let Programs Control Other
   Terminals*), says the first is on and the other two off by default, and
   that secrets are masked. `guide set-title` says a name given with Rename
   always wins. `guide new-split` says a split with a command needs the
   second switch.
3. **V58-3:** Run `nexterm-cli guide frob`: it exits 2, prints nothing on
   standard output, and its message lists the six topics. `nexterm-cli guide
   notify extra` exits 2 too. `nexterm-cli help guide` prints the index and
   exits 0.
4. **V58-4:** In a NexTerm terminal run `$env:NEXTERM_CLI` (PowerShell) or
   `echo %NEXTERM_CLI%` (cmd) for the tool's full path. Open a PowerShell
   and a cmd window outside NexTerm (from the Start menu), `cd` into a new,
   empty folder and run the tool there by that path with `guide` (in
   PowerShell, `& "<path>" guide`). It exits 0 with the same text as in
   V58-1, though neither variable is set. `dir` shows the folder still
   empty. `& "<path>" guide notify | more` pages it, and
   `"<path>" guide > guide.txt` in cmd writes the text, nothing more.
5. **V58-5:** Turn off Settings ▸ Terminal ▸ *Let Programs in Terminals
   Control NexTerm* and run `nexterm-cli guide` in a NexTerm terminal: it
   still exits 0 with the same text (it never asks NexTerm). Turn it back
   on. From WSL, `nexterm-cli.exe guide set-status` prints that topic.

### V59 — the Claude Code hook examples, and what an agent's end clears (bundle 1, A11)

Covered by the adversarial tests: agent_lifecycle AL-20 to AL-23 (a status,
a title and notes made while an agent NexTerm started, or one typed by hand,
ran go at the D that ends it; a D at a prompt, another terminal, an
unwatched record, NexTerm's own completion entry and anything set before the
agent started keep theirs; a shell's exit and restart still clear) and
terminal_status TS-24 (the row no longer says *Waiting*). The README's JSON
was parsed and each command line was run through the CLI's parser on macOS.
Nothing there runs a hook in Claude Code, or `nexterm-cli.exe` from
PowerShell or cmd. On a release build, with Claude Code installed, in a
NexTerm terminal whose shell is **PowerShell, then cmd**:

1. **V59-1:** At the prompt, type the commands of README *Control NexTerm
   from a terminal* ▸ the `PermissionRequest`, `StopFailure` and
   `UserPromptSubmit` example as they are inside the JSON, without the `\`
   before each `"`: `nexterm-cli notify "Claude Code" "Needs your
   permission"`, then `nexterm-cli set-status --tone warn Waiting for
   permission`, then `nexterm-cli set-status --tone error Stopped by an API
   error`, then `nexterm-cli set-status --clear`. Each exits 0
   (`$LASTEXITCODE`, `%ERRORLEVEL%`) and prints nothing. The entry's title is
   `Claude Code` (no quote mark left, not split in two), the row shows the
   warning line in the warning colour, then the error line, then none.
2. **V59-2:** In a test project, note the size and modified time of
   `.claude\settings.json` (or that there is none), and of
   `%USERPROFILE%\.claude\settings.json`. Start and quit Claude Code from
   NexTerm (New Claude Code Terminal, then `/exit`), Resume it, and change a
   few NexTerm settings. Neither file changed, and none was made: NexTerm
   never edits Claude Code's settings.
3. **V59-3:** Add the README example (with the `Stop` one) to the test
   project's `.claude\settings.json` yourself and start Claude Code there in
   NexTerm. Ask for something that needs your permission (a shell command).
   With NexTerm in the background, the note *Needs your permission* comes as
   soon as Claude Code asks, not at the end of the turn, and the row says
   *Waiting for permission*. Answer, then send another message: the line
   goes. If you can make a turn end on an API error (take the network away
   during a turn), the row says *Stopped by an API error* in the error
   colour.
4. **V59-4:** With the hooks of V59-3, start Claude Code, let the
   permission hook set its line and list its note, and leave the note
   unread. Have Claude Code run `nexterm-cli set-title Hook title` (the tab
   shows it) and finish one long turn, so NexTerm lists its own completion
   entry. Then `/exit`. The warning line and `Hook title` go (the tab shows
   `Terminal N` again), the hook's note is marked read and the row no longer
   says *Waiting*; NexTerm's own completion entry is still unread. The same
   with `claude` typed at the prompt by hand. Then, at the prompt, run
   `nexterm-cli set-status Before` and `nexterm-cli set-title Before`, start
   Claude Code and `/exit` it without sending anything: the line and the
   title stay. Run `ping -n 2 localhost` with no agent: they stay after it
   ends too.
5. **V59-5:** Quit Claude Code, set the variable for that shell only
   (PowerShell: `$env:CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1"`; cmd: `set
   CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`), start `claude` and ask for a
   permission again. No hook note and no hook line appear (the hooks' calls
   exit 3 without `NEXTERM_CONTROL_TOKEN`); NexTerm's own completion entry
   still comes after a long turn. Close that terminal afterwards so the
   variable goes with it.

### V60 — next/previous tab and Go to Tab (bundle 2, A5-1 and A5-2)

Covered under Node by tests/adversarial/tab_navigation.test.js (TN-01 to
TN-08). The cases press the keys through the window's own lookup, against the
real terminal store and a stand-in page. They cannot show whether WebView2
delivers `Ctrl+PageUp` / `Ctrl+PageDown` to the page, or whether Windows keeps
`Win+1` for itself, so check those here on a release build. Use one group
with a pane of three terminals (`` Ctrl+Shift+` `` twice), named `one`,
`two` and `three` from their tabs' menus, and a second pane beside it (split
right with `Ctrl+Alt+D`).

1. **V60-1:** Click in `one` and press `Ctrl+PageDown` three times. The pane
   shows `two`, then `three`, then `one` again, and the tab strip marks each.
   The other pane never changes. Type `echo hi` and Enter after each press:
   it runs in the terminal shown, so the keyboard went with the switch.
2. **V60-2:** Press `Ctrl+PageUp` three times: `three`, `two`, `one`. Run
   `vim` in `one` (Git Bash has one) and open a second tab page (`:tabnew`). `Ctrl+PageDown`
   still switches NexTerm's tab and does not change vim's tab page. `gt`
   still does. Quit vim with `:qa!`.
3. **V60-3:** In `one`, press `Win+1`, then `Alt+1`, then `Ctrl+Alt+1`. No
   NexTerm tab changes. `Win+1` does what Windows does with it (it opens or
   switches to the first taskbar app). `Alt+1` and `Ctrl+Alt+1` reach the
   shell as they did before this change. In Settings ▸ Keyboard Shortcuts,
   *Go to Tab 1* … *Go to Tab 8* and *Go to Last Tab* read *Unassigned*, with
   no `Cmd+…` chord, and *Next Tab* and *Previous Tab* show only
   `Ctrl+PageDown` and `Ctrl+PageUp`. The note above the list does not name
   *Go to Tab 1* or *Go to Last Tab*, and no row is marked as a conflict.
   (That a user's `Cmd+1` chord is in no conflict with *Go to Tab 1* off
   macOS is checked by TN-07, since Windows keeps `Win+1` for itself.)
4. **V60-4:** In Settings ▸ Keyboard Shortcuts, record `Ctrl+Alt+F1` for *Go
   to Tab 1*, then `Ctrl+Alt+F9` for *Go to Last Tab*. Close Settings. Click
   in `two`. `Ctrl+Alt+F1` shows `one` and `Ctrl+Alt+F9` shows `three`.
   Reset both rows.
5. **V60-5:** Open a file from the Explorer so an editor pane is the active
   pane, and click in its text. `Ctrl+PageDown` and `Ctrl+PageUp` move no
   terminal tab. Click back in a terminal: they switch tabs again.

### V61 — Reopen Closed Terminal (bundle 2, A5-4)

Covered under Node by tests/adversarial/reopen_closed_terminal.test.js (RC-01
to RC-08). The cases close and reopen terminals in the real terminal store
over the IPC mock. They cannot show whether WebView2 delivers `Ctrl+Shift+T`
to the page, what a real ConPTY shell does in a folder that is gone, or that
nothing reaches the disk, so check those here on a release build. Use one
group with two panes side by side (split right with `Ctrl+Alt+D`). The left
pane holds three terminals (`` Ctrl+Shift+` `` twice): name the second one
`build` from its tab's menu and leave the others with their `Terminal N`
names.

1. **V61-1:** In `build`, which runs PowerShell, run `cd $env:TEMP` and then
   `echo before-close`. Close `build` with its tab's ✕. Click in another
   terminal and press `Ctrl+Shift+T`. A tab named `build` comes back as the
   second tab of the left pane, active, with the keyboard in it. `pwd` shows
   the TEMP folder. The screen is empty: `before-close` does not come back.
2. **V61-2:** Open a Git Bash terminal (*New Terminal With ▸ Git Bash*), run
   `cd /c/Windows`, and close it. `Ctrl+Shift+T` reopens a Git Bash (the
   prompt and `echo $BASH_VERSION` show it) in `/c/Windows`.
3. **V61-3:** Close a `Terminal N` tab, then press `Ctrl+Shift+T`. It comes
   back with a `Terminal N` name that no other tab has, not necessarily its
   old number.
4. **V61-4:** Close the right pane with its ✕ (or `Ctrl+W` on its last tab).
   `Ctrl+Shift+T` brings its terminal back into the left pane. Make a second
   group with two terminals, then close the group from the group switcher.
   `Ctrl+Shift+T` twice brings both back into the group on screen, in their
   old order.
5. **V61-5:** Make a folder `C:\Temp\gone` and `cd` into it in a terminal.
   Close that terminal. In another terminal run `Remove-Item C:\Temp\gone`,
   then press `Ctrl+Shift+T`. A terminal opens where a new one starts, with
   no error box.
6. **V61-6:** Close two terminals, then quit NexTerm and start it again.
   `Ctrl+Shift+T` does nothing: the list was in memory only. Search the files
   under `%APPDATA%\com.nexterm.ide` and `%LOCALAPPDATA%\com.nexterm.ide`
   for the name of a terminal you closed: it is not there.
7. **V61-7:** In a terminal, press `Ctrl+T` at a bash prompt with `ab` typed
   (Git Bash): readline swaps the two letters to `ba`, so `Ctrl+T` still
   reaches the shell.

### V62 — the Ctrl+Tab switcher (bundle 2, A5-3)

Covered under Node by tests/adversarial/tab_mru.test.js (MRU-01 to MRU-09)
and the render case RN-233. The cases drive the real terminal store and the
switcher's window listeners with key events built by hand. They cannot show
whether WebView2 delivers `Ctrl+Tab` and the release of `Ctrl` to the page,
or where the keyboard lands on a real screen, so check those here on a
release build. Use two groups: `Group 1` with terminals `one` and `two`, and a
second group `Work` with terminal `three` (name them from their tabs' menus).
Use `one`, then `three`, then `two`, in that order, by clicking in them.

1. **V62-1:** In `two`, press `Ctrl+Tab` and let go at once. `three` comes
   up, in `Work`, with the keyboard in it: type `echo here` and it appears in
   `three`. Press `Ctrl+Tab` again and let go: back in `two`.
2. **V62-2:** Hold `Ctrl` and press `Tab`. An overlay at the top of the
   window lists `two`, `three` and `one`, each with its group and the last
   part of its folder, `three` highlighted. Still holding `Ctrl`, press `Tab`
   twice more: the highlight goes to `one`, then wraps to `two`. Press
   `Shift+Tab` (with `Ctrl` still down): it wraps back to `one`. Press `↓`
   and `↑`: the highlight moves. Let go of `Ctrl`: the highlighted terminal
   is shown and has the keyboard.
3. **V62-3:** Hold `Ctrl`, press `Tab`, press `Esc`, then let go of `Ctrl`.
   The overlay closes and nothing switched; typing still goes to the
   terminal you were in. Hold `Ctrl`, press `Tab`, then `Alt+Tab` to another
   app and back: the overlay is gone and nothing switched.
4. **V62-4:** Hold `Ctrl`, press `Tab`, and click a row: that terminal is
   shown with the keyboard in it.
5. **V62-5:** Open a file from the Explorer and click in it. `Ctrl+Tab` lists
   terminals only, not the file, and letting go puts the keyboard in a
   terminal.
6. **V62-6:** At a Git Bash or PowerShell prompt, type `ec` and press `Tab`:
   completion still works. Close every terminal but one: `Ctrl+Tab` opens
   nothing and sends no `Tab` to the shell.
7. **V62-7:** In Settings ▸ Keyboard Shortcuts, set *Switch to Recent
   Terminal* to `Alt+Q`. Hold `Alt`, press `Q` twice, let go of `Alt`: the
   terminal used two switches ago is shown. Reset the shortcut afterwards.
8. **V62-8:** Turn Windows' animations off (Settings ▸ Accessibility ▸
   Visual effects ▸ Animation effects). The overlay appears and goes without
   any animation, as it does with them on.

### V63 — macOS text-editing keys: nothing changes on Windows (bundle 2, A6)

`⌘←`, `⌘→`, `⌘Backspace` and `⌘Delete` are sent as `Ctrl+A`, `Ctrl+E`,
`Ctrl+U` and `Ctrl+K` on macOS only. Windows has no `⌘` for a terminal key,
so its keys must behave exactly as before. Covered under Node by
tests/adversarial/mac_editing_keys.test.js (ME-02: no mapping off macOS) and
settings_window.test.js (SW-B2-01: no Settings row off macOS); this checks
the release build.

1. **V63-1:** Open Settings ▸ Terminal. There is no *macOS Text-Editing Keys*
   row.
2. **V63-2:** At a PowerShell prompt and a Git Bash prompt, type
   `echo one two three`. `Ctrl+←` and `Ctrl+→` still move one word at a time,
   `Home` and `End` go to the start and the end of the line, and `Backspace`
   and `Delete` still delete one character.
3. **V63-3:** In Git Bash, press the `Windows` key with `←` (Win+←). Windows
   snaps the NexTerm window to the left half of the screen, as before; no
   character appears at the prompt, and the cursor does not move.

### V64 — Option as Meta: no such setting on Windows (bundle 2, A7)

*Use Option as Meta* sets xterm's `macOptionIsMeta`, which means something on
macOS only. Off macOS the setting has no row and never turns the option on,
and `Alt` acts as Meta in xterm as it always did. Covered under Node by
tests/adversarial/option_as_meta.test.js (OM-02: false off macOS whatever the
setting says; OM-03: a live change sets false off macOS) and
settings_window.test.js (SW-B2-01); this checks the release build.

1. **V64-1:** Open Settings ▸ Terminal. There is no *Use Option as Meta* row.
2. **V64-2:** At a Git Bash prompt, type `echo one two three` and press
   `Alt+B` twice, then `Alt+F` once: the cursor moves back two words and
   forward one, as before. `Alt+D` deletes the word after the cursor.
3. **V64-3:** At the same prompt, `Alt+←` and `Alt+→` still move a word, and
   `Alt+Enter` in OpenCode still inserts a newline instead of sending the
   message.
4. **V64-4:** In `vim` with `:set mouse=a`, hold `Shift` and drag over text:
   it is selected, as before.

### V65 — OSC 52: a program sets the clipboard, only when allowed (bundle 2, A8)

A program's OSC 52 reaches the clipboard through `clipboard_write_text`
(src-tauri/src/commands/clipboard.rs), which on Windows opens the one global
clipboard. Covered under Node by tests/adversarial/osc52.test.js (O52-01..09:
writes, refused reads and clears, the 128 KiB limit, kept output, one notice
per terminal, the alternate screen) and by `cargo test` (the size check, and a
200 KB OSC 52 through the PTY filter byte for byte), none of which touches a
real clipboard; this checks the release build against the Windows clipboard.
Put something of your own on the clipboard first (copy the word `before` from
Notepad).

1. **V65-1:** With the setting off (the default), in Git Bash run
   `printf '\e]52;c;%s\a' "$(printf 'from osc52' | base64)"`. One yellow
   `[NexTerm]` notice appears naming *Settings ▸ Terminal ▸ Let Programs Set
   the Clipboard (OSC 52)*, and `Ctrl+V` in Notepad still pastes `before`.
   Run the same line again: no second notice.
2. **V65-2:** Turn the setting on in Settings ▸ Terminal and run the line
   again. `Ctrl+V` in Notepad pastes `from osc52`. No notice appears.
3. **V65-3:** Run `printf '\e]52;c;?\a'`: nothing appears at the prompt (no
   reply is typed into the shell) and the clipboard still holds `from osc52`.
   Run `printf '\e]52;c;\a'`: the clipboard still holds `from osc52`.
4. **V65-4:** Run
   `head -c 140000 /dev/zero | tr '\0' a | base64 -w0 | (printf '\e]52;c;'; cat; printf '\a')`.
   One notice says the copy was refused; the clipboard still holds
   `from osc52`, not a shortened run of `a`.
5. **V65-5:** Turn the setting off again. In a new tab, run
   `printf '\e[?1049h'; printf '\e]52;c;%s\a' "$(printf x | base64)"; sleep 3; printf '\e[?1049l'`.
   For the 3 seconds the alternate screen is up, no notice is drawn on it;
   once it is gone, the notice appears at the prompt, once.
6. **V65-6:** Quit NexTerm. In a Command Prompt, run
   `findstr /s /m ZnJvbSBvc2M1Mg "%APPDATA%\com.nexterm.ide\*" "%LOCALAPPDATA%\com.nexterm.ide\*"`
   — the base64 of `from osc52`, which only the OSC 52 sequences carried and
   nothing typed or shown did. It prints no file: the payload was not saved
   with the scrollback, the notifications or anything else.

### V66 — Reveal in File Explorer and Open Terminal Here (bundle 2, A12-1/A12-2)

The Explorer's menu hands a row to `fs_reveal_path`
(src-tauri/src/fs/reveal.rs), which on Windows runs `explorer.exe /select,`
for a file and opens a folder, and to a terminal started there or nowhere
(`strict_cwd`). Covered under Node by
tests/adversarial/explorer_open_actions.test.js (EXO-01..04: the label per
platform, the path revealed, the folder a terminal starts in, the error when it
cannot) and by tests/e2e/tier1-features/explorer.test.js (TC-EXPL-B2-01..02,
through the mock bridge), none of which opens File Explorer or starts a shell;
this checks the release build against the Windows shell. Open a folder whose
path has spaces, for example `C:\Users\<you>\My Project`, holding a file
`a b.txt` and a folder `sub dir`.

1. **V66-1:** Right-click `a b.txt`. The menu says *Reveal in File Explorer*
   (not Finder, not File Manager). Choose it: a File Explorer window opens on
   `My Project` with `a b.txt` selected, and Notepad or any other editor does
   not start.
2. **V66-2:** Right-click `sub dir` and choose *Reveal in File Explorer*: File
   Explorer opens `sub dir` itself. Right-click the empty space below the rows
   and choose it: File Explorer opens `My Project`.
3. **V66-3:** Right-click `a b.txt` and choose *Open Terminal Here*. A new tab
   opens in the active pane, has the keyboard (type `cd` and press `Enter`
   without clicking), and prints `C:\Users\<you>\My Project` — the file's
   folder, spaces and all. Do the same on `sub dir`: the new terminal is in
   `...\My Project\sub dir`.
4. **V66-4:** In File Explorer, rename `sub dir` to `gone` without refreshing
   NexTerm's Explorer, then right-click `sub dir` in NexTerm and choose *Open
   Terminal Here*. No terminal opens, and the Explorer shows *No terminal
   could be started in ...\sub dir* in red. Rename it back.

### V67 — Open in External Editor: code.cmd, spaces and &, no console (bundle 2, A12-3/A12-4)

*Open in External Editor* runs the command set in *Settings ▸ Files ▸ External
Editor* through `fs_open_in_external_editor`
(src-tauri/src/fs/external_editor.rs): split without a shell, the path added as
the last argument, a bare name found on `PATH` as `.exe`, `.com`, `.cmd` or
`.bat`. Covered under Node by tests/adversarial/explorer_open_actions.test.js
(EXO-05..06: the item only while an editor is set, what is sent, the refusal in
the Explorer) and tests/e2e/tier1-features/explorer.test.js (TC-EXPL-B2-03,
through the mock bridge), and in Rust by XE-01..05 and XE-07 (the split, the
deny-list, the confinement, the command built, `code` found as `code.cmd`, and
`NoDefaultCurrentDirectoryInExePath=1` set for the editor), none of which
starts an editor; this checks the release build against a real one. Install
VS Code with its `code` command on `PATH` (the installer's default). Open a
folder whose path has spaces, for example `C:\Users\<you>\My Project`, holding
a file `a & b.txt` and a folder `sub dir`.

1. **V67-1:** With the setting empty (the default), right-click `a & b.txt`:
   there is no *Open in External Editor*. Type a few spaces into the setting
   and leave the field: still none.
2. **V67-2:** Set the setting to `code` and right-click `a & b.txt`. Choose
   *Open in External Editor*: VS Code opens `a & b.txt` — the whole name, not
   `a` — and no console window flashes up, not even for a moment. Nothing else
   starts, and Notepad does not open.
3. **V67-3:** Right-click `sub dir`, then the empty space below the rows, and
   choose it each time: VS Code opens `...\My Project\sub dir`, then
   `My Project`. NexTerm stays responsive while VS Code is open, and closing VS
   Code leaves no `cmd.exe` behind in Task Manager.
4. **V67-4:** Set the setting to the full path in quotes, for example
   `"C:\Users\<you>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
   --new-window`: *Open in External Editor* on `a & b.txt` opens it in a new
   VS Code window.
5. **V67-5:** Set the setting to `cmd /c echo` and choose *Open in External
   Editor*: nothing starts, and the Explorer shows in red that `cmd` is a shell
   or opens files in their default app. Do the same with `explorer`, with
   `START` and with `wsl.exe`: refused the same way. Set it to `"code` (an
   unclosed quote): the Explorer says the quote is never closed.
6. **V67-6:** Set the setting to `nosuch-editor`: the Explorer says
   *'nosuch-editor' was not found on PATH (looked for .exe, .com, .cmd and
   .bat)*, and nothing opens. Clear the setting: the item is gone from the
   menu again.
7. **V67-7:** A batch-file editor finds no program in the open folder. Make a
   folder outside the open one, for example `C:\Users\<you>\v67-editor`,
   holding `editor.cmd`:

   ```bat
   @echo off
   v67probe
   echo ran> "%TEMP%\v67-editor-ran.txt"
   ```

   and at the root of `My Project` put `v67probe.bat`:

   ```bat
   @echo off
   echo planted> "%TEMP%\v67-planted-ran.txt"
   ```

   First the control, in a Command Prompt rather than NexTerm (if
   `set NoDefault` shows the variable there, clear it with
   `set NoDefaultCurrentDirectoryInExePath=`): `cd /d "C:\Users\<you>\My Project"`,
   then `"C:\Users\<you>\v67-editor\editor.cmd" x`. `%TEMP%\v67-planted-ran.txt`
   now exists: run in that folder, cmd.exe found the planted `v67probe.bat`.
   Delete both `.txt` files. Now set the setting to
   `"C:\Users\<you>\v67-editor\editor.cmd"` and choose *Open in External
   Editor* on `a & b.txt`: `%TEMP%\v67-editor-ran.txt` appears, so the editor
   ran, and `%TEMP%\v67-planted-ran.txt` does not. Delete `v67probe.bat` and
   clear the setting afterwards.

### V68 — the kitty keyboard protocol through ConPTY (bundle 4, A1; README H4)

Covered under Node by tests/adversarial/kitty_keyboard.test.js (KK-*: the
stacks, the reply naming flag 1 alone, the resets, the keys, the Korean
input source, ⌥ and the password prompt) and control_keys.test.js (CK-10 to
CK-12: `nexterm-cli send --keys` under the flags), against `@xterm/headless`
and stand-in key events. Nothing there runs a real console program, so
whether Windows' own ConPTY carries `CSI ? u`, NexTerm's reply and the
`CSI u` keys between NexTerm and a program is not known; it is checked only
here, and until it is, the README says so. Claude Code's documentation names
Windows Terminal 1.25 or later as working; Windows Terminal ships a ConPTY of
its own, newer than the one in Windows, so that says nothing about
NexTerm's. Write down the Windows build: ConPTY is part of it. On a release
build:

1. **V68-1:** In Git Bash, run each line and write down what it prints:
   `printf '\e[?u'; read -t 1 -rs r; printf '%q\n' "$r"` (NexTerm's answer
   with nothing turned on, `$'\E[?0u'`), then
   `printf '\e[>1u\e[?u'; read -t 1 -rs r; printf '%q\n' "$r"; printf '\e[<u'`
   (with flag 1 pushed, `$'\E[?1u'`), then
   `printf '\e[>1u'; read -t 5 -rs r; printf '\e[<u'; printf '%q\n' "$r"`
   and press `Shift+Enter` within the 5 seconds (`$'\E[13;2u'`). An empty
   line, or other bytes, is a finding: write down exactly what came.
2. **V68-2 (H1 on Windows):** Start Claude Code 2.1.269 or later with *New
   Claude Code Terminal* in a PowerShell terminal. Type `one`, press
   `Shift+Enter`, type `two`: the input box holds two lines and nothing is
   sent. `Enter` sends both lines as one message.
3. **V68-3:** While Claude Code answers, `Esc` interrupts it. With the input
   box empty, `Ctrl+C` does what Claude Code does with it (it says to press
   it again to exit, and a second one exits).
4. **V68-4:** V68-2 and V68-3 again in cmd and in Git Bash.
5. **V68-5 (H3 on Windows):** With Claude Code running, end it from Task
   Manager (End task on its process). At the prompt that follows, run
   `Start-Sleep 30` in PowerShell (`ping -n 30 127.0.0.1` in cmd) and press
   `Ctrl+C`: it stops at once, and the prompt shows no `[99;5u`.
6. **V68-6 (H2 and H5 on Windows):** In OpenCode, `Shift+Enter` is still a
   newline and `Enter` still sends. With the Microsoft Korean IME, type
   `한글 입력` into Claude Code: it arrives whole, with no stray letters.
7. **V68-7:** Turn off Settings ▸ Terminal ▸ *Kitty Keyboard Protocol* and
   run V68-1's first line again: nothing comes back (an empty line). Start
   Claude Code again and write down what `Shift+Enter` does now.

### V69 — a read-only terminal (bundle 4, A3)

Covered under Node by tests/adversarial/read_only.test.js (RO-*: the gate on
xterm's user-input signal, the replies that pass, the refusals of `send`,
startup and project commands and agents, failing closed),
control_dispatcher.test.js (CD-60), terminal_file_drop.test.js (TF-49,
TF-63) and the render suite (RN-240, RN-241: the badge, the mark and the
strip). None of them runs WebView2, ConPTY or the Windows IME. On a release
build, in a PowerShell terminal:

1. **V69-1:** Right-click its tab → *Turn On Read-Only*. The chip shows the
   keyboard-with-a-stroke badge, its TERMINALS row the same mark, and the
   pane a strip above the terminal with **Turn Off**; the terminal's top row
   is still visible.
2. **V69-2:** Type `dir`, press `Enter`, paste with `Ctrl+V` and with a
   right-click, drop a file from File Explorer onto the pane, and type Korean
   with the IME: nothing reaches the prompt, and one error toast says the
   terminal is read-only, however fast you type. Select some output
   and press `Ctrl+C`: it is copied. `Shift+PageUp` scrolls.
3. **V69-3:** In another terminal, with Settings ▸ Terminal ▸ *Control* ▸
   *Let programs type into and read terminals* and *Let programs control
   other terminals* on, run `nexterm-cli send --to <the read-only one> "dir"`
   (its id from `nexterm-cli list`) and `echo $LASTEXITCODE`: 4, the message
   says it is read-only, and nothing is typed there. `nexterm-cli read-screen
   --of <it>` still prints its screen.
4. **V69-4:** Start Claude Code in a terminal, give it work and turn
   read-only on while it works: it goes on working and drawing. Click
   **Turn Off**: typing reaches it again.
5. **V69-5:** Turn read-only on in two terminals and restart NexTerm: every
   terminal comes back writable, with no badge and no strip.

### V70 — Copy Last Command Output (bundle 4, A2)

Covered under Node by tests/adversarial/last_command_output.test.js (LCO-*:
the range between OSC 133 C and D, masking, the reasons, the toasts) against
`@xterm/headless`, where C arrives when it is sent. On Windows it has not:
the v0.6.1 row of [Why this exists](#why-this-exists) records ConPTY holding
PowerShell's OSC 133 "C" until the next frame, so that it arrived with the
command's "D". If it still does, the copy starts too late and misses output,
which is what V70-1 checks. On a release build:

1. **V70-1:** In PowerShell, run `1..5 | % { "line $_" }`, then right-click
   the tab → *Copy Last Command Output (Secrets Masked)* and paste into
   Notepad: exactly `line 1` to `line 5`, nothing else. The toast names the
   command. Do the same for `Get-ChildItem C:\Windows | Select-Object -First 3`.
2. **V70-2:** In Git Bash, run `echo key sk-AAAABBBBCCCCDDDDEEEEFFFF1234 here`
   and copy from the TERMINALS row's menu: `key sk-[hidden] here`.
3. **V70-3:** In cmd, the item is greyed out, its tooltip saying cmd does not
   say where a command's output starts; in the palette its row is greyed
   out too, saying the same, and Enter on it does nothing.
4. **V70-4:** In PowerShell run `Start-Sleep 20`; while it runs the item is
   greyed out ("A command is running"). After it ends, run `dir`, choose
   *Clear Terminal* and copy: the toast says the output is no longer in the
   scrollback.

### V71 — Send to Agent with Windows paths (bundle 4, A4; README H6)

Covered under Node by tests/adversarial/send_to_agent.test.js (STA-*: the
reference, a `C:\` path, the target, the paste and every refusal).
No suite runs Claude Code, so whether it reads a pasted reference — the
file, and the lines named in words after it — is not known on any platform;
here it is checked with Windows paths. Write down Claude Code's version. On a
release build, with a folder open that has `src\a.js` of at least 20 lines:

1. **V71-1:** Start Claude Code with *New Claude Code Terminal* in
   PowerShell. In the editor select lines 3 to 5 of `a.js`, right-click →
   *Send Selection to Agent*. Claude Code's input box holds
   `@C:\…\src\a.js (lines 3-5) ` with the full path, nothing is sent, and a
   toast says Enter was not pressed.
2. **V71-2 (H6 on Windows):** Type `what do these lines do?` and press
   `Enter`. Write down whether Claude Code shows it read `a.js` and whether
   its answer is about lines 3 to 5. This is a finding either way, never a
   PASS unless both are seen.
3. **V71-3:** In the Explorer, right-click the `src` folder → *Send to
   Agent*: `@C:\…\src ` is typed. Rename a file to `my file.js` and try it:
   the item is greyed out, saying the path holds a space.
4. **V71-4:** Change `a.js` without saving and right-click in it → *Send File
   to Agent*: an error toast says to save the file first, and nothing is
   typed. Turn the Claude Code terminal read-only and send again: an error
   toast says it is read-only.
5. **V71-5:** V71-1 and V71-2 again with Claude Code started in Git Bash: the
   path is still typed as `C:\…`; write down whether Claude Code reads it.

## What the first run found

Run on 2026-09-20 against the v0.5.4 portable build, Windows 10 Pro
10.0.19045, WebView2 153.0.4234.48. Ten of twelve passed; the two that did not
are the reason this list is worth keeping.

- **V8 failed.** `Workspace::root` lived only in memory, so every launch began
  with no folder open. `spawn_dir` then refused every saved terminal directory
  and started them all at home — and the write-behind saved *that* over the
  real one, so the session degraded a little more each time it was opened.
- **V11 partially failed.** The off-macOS menu advertised "Split Right —
  Ctrl+D", and pressing it with a terminal focused sent EOF and killed the
  shell. Not a deviation from the design: the design simply had no off-macOS
  spelling for that chord.
- **V7 passed, with a caveat worth repeating.** A screenshot is a discrete
  sample of a continuous thing; seven clean frames is evidence that flicker is
  gone, not proof. Say which it is.

`Ctrl+D` was found by reading the menu, not by using the app — the remaining
`Ctrl+S` (XOFF, which freezes the terminal with no indication of why),
`Ctrl+W`, `Ctrl+P` and `Ctrl+K` are the same class and are still advertised.
None of them *ends* anything, which is why they were left, but a check that
walks the menu asking "what does this chord mean to a shell?" would have found
all five at once.

## What the PR #34 run found

Run on 2026-09-25/26 against PR #34's CI builds (`97d531f`, then `2922413`),
Windows 10 Pro 22H2 19045.5371, WebView2 153.0.4234.48, `claude` 2.1.282–283.
V13, V15 and V16 passed; V14 did not, and why is the reason for the ConPTY
paragraph above. Reported in full on #34.

- **V14 failed on the first build.** On PowerShell the guard missed the first
  command of every session and caught every later one. The backend was not
  missing the "C" marker — it received it *late*: for `Start-Sleep 8`, at
  +9.13 s, 17 ms before "D". A hand-written C as the first command was just as
  late. And an OSC 7 written half a second into a command arrived only with
  the next prompt, at +7.7 s, where the same sequence followed by one visible
  character arrived at +1.6 s. The fix does not try to hurry ConPTY: on
  Windows, a line sent to a shell that reports "D" counts as running if the
  shell has not answered it within 300 ms.
- **Inline suggestions have never worked under WebGL** (#35), which is how the
  app ships; nobody had noticed because nothing looks broken. With the DOM
  renderer they appear, drawn a few cells too far left (#36).
- **A resume check can pass while testing nothing.** Launched from a Claude
  Code session, the app hands `CLAUDECODE` down to its terminals, and a
  `claude` started there saves no transcript — so there is nothing to resume.
  That is why *Before you start* now says where not to launch it from.

## What the PR #56 run found

Run on 2026-10-24 against PR #56's CI build (`15cc607`, reporting 0.20.0),
Windows 10 Pro 22H2 19045.5371 (ko-KR), WebView2 155.0.4283.62. V22–V42: eight
passed, twelve failed, V25 could not be checked (OpenCode was broken on the
machine, independent of NexTerm, so every OpenCode step was "could not
check"). Most failures were Windows 10's console host, not the app — which is
why the fixes below say where ConPTY stops.

- **V30, V37: the Explorer row menu was always the empty-area menu**, on every
  platform, since the tree's rebuild: the row's `contextmenu` reached the
  tree's own handler. Copy, Paste, Rename and Delete were unreachable. The row
  stops its event now.
- **V26: a shell that exited was never reported.** Windows 10's console host
  keeps the output pipe open after its shell has gone, until
  `ClosePseudoConsole` — which ran only after the end it was waiting for. The
  console hosts outlived the app, too. The shell's process is now waited for
  on Windows, and its console closed when it ends. That close also ends what
  is still attached to the console — a `start /b` server, a Git Bash job left
  running with `&` — as Windows Terminal's does; on macOS and Linux they
  outlive the shell.
- **V35, V41: Git Bash under `%TEMP%` is in `/tmp/…`**, a mount only it knows:
  a split there opened at the workspace root and no branch was shown. Git
  Bash now reports its directory as Windows spells it (`pwd -W`). CI's
  runner then showed Git for Windows 2.56 (bash 5.3) calling itself
  `cygwin`, not `msys`; it is `pwd -W` working that decides now.
- **V22: a right-click paste of two lines opened WebView2's menu** over the
  question: on Windows the menu follows the release, which lands on the
  question that opened under the pointer.
- **V29: Ctrl+R reloaded the page** outside a terminal (WebView2 155 no longer
  swallows it), and **Alt+F4 did nothing** with a terminal focused (xterm
  cancelled it). Both handled now; Ctrl+R in a terminal is still the shell's.
  Review then found the fields that keep their keys to themselves (the
  Explorer's name and filter boxes, Search, the rename fields) still reloaded
  on Ctrl+R, F5 and Ctrl+Shift+R: the guards ran in the bubble phase, which
  those keys never reach. They are refused in the capture phase now, and
  Ctrl+R's guard is Windows-only — WKWebView and WebKitGTK never reload on it.
- **V36, V38: two things ConPTY on Windows 10 does not pass on** — the switch
  to the alternate screen, and bracketed paste's markers. A Git Bash that had
  asked for bracketed paste ran the first of two pasted lines unasked; a
  program quiet for more than 3 s while quitting left cmd's question
  unanswered. On Windows 10 (and builds not yet known) neither is relied on
  now. Windows 11 was not measured, and is left as it was.
- **Not the app, so not changed:** Clear Terminal's output coming back after a
  resize (V27) needs `ClearPseudoConsole`, which the inbox ConPTY of Windows 10
  does not have; an OSC 9;4 with nothing visible after it is held by ConPTY
  until the next prompt (V40); PowerShell 7.6 with PSReadLine 2.4.5 never
  turns bracketed paste on, so it is asked about (V38).
- **Doc corrections:** Split Right is Ctrl+Alt+D off macOS (V35 said Ctrl+D,
  which is EOF); Ctrl+click on a printed `..\README.md` is V34's reveal in the
  file manager — the editor's terminal links need `path:line` (V39).

## Reporting

One line per check — `PASS` / `FAIL` / `could not check` — each with its
evidence: a screenshot path, a number, a command's output. Plus the first and
last contents of `.window-state.json`, the Windows build
(`[System.Environment]::OSVersion`), the WebView2 runtime version and the app
version.

**"Could not check" is a result.** The failure mode this whole document exists
to prevent is a green report that nobody actually looked at, so a check that
was not made must never be written down as one that passed.
