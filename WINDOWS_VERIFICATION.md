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
- **`window.__TAURI_INTERNALS__`** is there. `invoke('plugin:event|listen', …)`
  subscribes the page to the backend's own events — `pty-command-started`,
  `pty-command-done`, `pty-cwd` — so you can timestamp what the backend
  actually parsed. `pty-output` arrives with the OSC markers already stripped.

Driving it over CDP:

- The terminal is drawn with WebGL: there is no `.xterm-rows` and no terminal
  text in the DOM. Read it from screenshots (`Page.captureScreenshot` works).
- Adding `--disable-webgl` to `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` puts xterm
  on its DOM renderer, where the text is readable from `.xterm-rows` and the
  inline suggestions appear (under WebGL they never do, #35). That is not the
  shipped configuration — say so whenever you use it.
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

Command blocks, the sticky header and completion notifications still do not
work on cmd, by design: it can report a directory and nothing else. Switching
the default shell to PowerShell should bring those back, which is worth
checking at the same time.

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

### V14 — Resume waits while something runs

With PowerShell as the default shell, give a restored offer a long **first**
command (`Start-Sleep 20`): *Resume* is disabled with a reason for the whole
run and enabled again after it. Repeat on Windows PowerShell 5.1 and on
PowerShell 7 — the first command is the one ConPTY delays, see below. Three
empty Enters must not flicker it. On cmd it is never disabled, by design (cmd
reports no command boundaries); note what it does and check that nothing is
left marked as running.

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
relaunch. In the History palette and with Tab after `echo S` (Tab needs
`--disable-webgl` until #35 is fixed), only the control is offered, and
`INJECTED` is never printed.

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
