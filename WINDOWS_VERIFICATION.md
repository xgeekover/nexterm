# Verifying NexTerm on Windows

NexTerm is built on a Mac and used on Windows. That asymmetry has a cost, and
this document is what the project does about it.

## Why this exists

Three consecutive releases fixed bugs that **only appear on Windows**, and
every one of them shipped green: `cargo test`, three platform test jobs, three
platform builds, all passing, for months in one case.

| Release | What was wrong | Why nothing caught it |
| --- | --- | --- |
| v0.5.2 | The native title bar sat above the app's own, with a second set of window buttons | `tauri.conf.json` was correct. `tauri-plugin-window-state` restored a saved `decorated: true` **after** the window was built, and only a machine that had run v0.1.x had that value. Survived eleven releases. |
| v0.5.3 | Opening a folder froze the window | A plain `fn` command is `ExecutionContext::Blocking` — the event-loop thread. macOS hides it, because `NSOpenPanel` keeps pumping the loop while modal. |
| v0.5.3 | A terminal's directory never followed `cd` | cmd is the Windows default shell and had no shell integration at all, so no OSC 7 was ever emitted. |
| v0.5.3 | Restored sessions lost every directory | OSC 7 reports `/C:/Users/dev`; nothing turned it back into a path Windows can open, so respawning hit the fallback silently. |
| v0.5.4 | A console window flashed whenever git ran | `git` is a console program, and a child gets its own console unless given `CREATE_NO_WINDOW`. |

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

**Do not delete `%APPDATA%\com.nexterm.ide\.window-state.json`.** Read it and
keep a copy of what it said. Whether the app is correct *with that file still
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

A console window opened by a child process brings a `conhost.exe` with it, so
counting them catches a flash too short to see:

```powershell
function Watch-Conhost($seconds = 15) {
  $peak = 0
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $n = @(Get-Process conhost -ErrorAction SilentlyContinue).Count
    if ($n -gt $peak) { $peak = $n }
    Start-Sleep -Milliseconds 100
  }
  $peak
}
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

Note that a release build has **no** `window.__nexterm` handle — that is gated
on a dev build or `?debug` — so this gives you the DOM and nothing else.

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

## Reporting

One line per check — `PASS` / `FAIL` / `could not check` — each with its
evidence: a screenshot path, a number, a command's output. Plus the first and
last contents of `.window-state.json`, the Windows build
(`[System.Environment]::OSVersion`), the WebView2 runtime version and the app
version.

**"Could not check" is a result.** The failure mode this whole document exists
to prevent is a green report that nobody actually looked at, so a check that
was not made must never be written down as one that passed.
