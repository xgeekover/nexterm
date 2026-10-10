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
- When it fails, say which half: an offer that only ever says *the most
  recent opencode conversation in this folder* — even after the reply — is
  the title or the lookup. With Developer Tools open, the console says
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

## Reporting

One line per check — `PASS` / `FAIL` / `could not check` — each with its
evidence: a screenshot path, a number, a command's output. Plus the first and
last contents of `.window-state.json`, the Windows build
(`[System.Environment]::OSVersion`), the WebView2 runtime version and the app
version.

**"Could not check" is a result.** The failure mode this whole document exists
to prevent is a green report that nobody actually looked at, so a check that
was not made must never be written down as one that passed.
