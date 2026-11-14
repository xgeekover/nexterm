# How NexTerm is tested

A lint pass and four suites, run in this order:

```sh
npm run lint
cd src-tauri && cargo test && cd ..
node tests/e2e/runner.js
node tests/adversarial/runner.js
node tests/render/runner.js
```

The order matters — see [The fixtures](#the-fixtures) below.

| Suite | Cases | What it is for |
| --- | --- | --- |
| `cargo test` (`src-tauri/`) | 105 | The backend against the real machine: PTYs, real shells, the real filesystem, OSC parsing, path confinement, the native menu |
| `tests/e2e/` | 44 | The app's own stores and flows, through the browser IPC mock |
| `tests/adversarial/` | 430 | Everything that has ever gone wrong, plus the invariants that keep it from going wrong again |
| `tests/render/` | 16 | Whether the app DRAWS — the only suite that mounts a component |

Counts are what the suites reported on macOS at the time of writing; they are
here to make a large discrepancy obvious, not to be kept to the digit.

## The two nets nothing else provides

**`npm run lint` is not a style check.** Three rules are there because each one
caught a real bug:

| rule | the bug |
| --- | --- |
| `no-undef` | `GroupSwitcher` read the `tabs` binding of a DIFFERENT component in the same file; `FileExplorer` used `cn` without importing it. Both built cleanly, passed every suite, and took the whole React tree down on sight. |
| `react/no-unstable-nested-components` | a component declared inside another's render is a new type every render, so React remounts it — and a real click needs mousedown and mouseup on the SAME element. The buttons rendered perfectly and did nothing; a scripted `.click()` still worked, which is why no test noticed. |
| `react-hooks/rules-of-hooks` | not yet, but a conditional hook reorders state between renders and the symptom is nonsense somewhere else. |

Formatting rules are deliberately absent, so a lint failure always means
something is actually wrong. `--max-warnings 3` is a ratchet over the three
hook-dependency advisories that predate the config; it stops them growing.

**`tests/render/` is the only suite that mounts a component.** Node cannot
parse JSX, which is the whole reason this did not exist: `tests/render/
jsxLoader.mjs` transforms it with esbuild (already present via Vite) and stubs
`@xterm/*`, which touches a canvas at import time. Cases are STATES, not
components — a component rendered with no props proves very little, while
putting the stores into a state a user reaches and rendering the whole tree is
what catches the empty-state and split-pane branches that a smoke-open never
touches. `renderToString` runs each body but no effects, which is the right
depth; effects need the real backend, and that is what driving the app is for.

Both nets were checked by REINTRODUCING the `GroupSwitcher` bug: lint reported
`'tabs' is not defined`, and all twelve render cases failed.

## What each suite can and cannot tell you

**`cargo test` is the only suite that touches the real machine.** It spawns
real shells, opens real PTYs and reads real directories, so it behaves
differently on each platform — ConPTY is not a unix pty, and
`C:\Users\me\project\src` is not a path that any `/`-shaped assumption
survives. Some cases are `#[cfg(unix)]` or `#[cfg(windows)]`, so the totals
differ per platform by design.

**The JS suites run against `BrowserMockBridge`** (`src/lib/ipc.js`), an
in-memory stand-in for the Rust backend. There is no real PTY and no real
filesystem. That makes them fast and deterministic, and it means **a JS suite
passing tells you nothing about the platform it ran on** — with one exception,
below.

When the mock and the real backend disagree, the mock wins the test and the
user loses. That has happened twice and both times the mock was the bug:
`fs_read_dir` returned a flat list where the backend nests, and `pty_write`
emitted `pty-exit` after every command where the backend emits
`pty-command-done`. **If you change the mock, check it against
`src-tauri/src/` first.**

**And there is a third thing neither suite can see: what the app looks like.**
A window drawn twice, a thread that is busy rather than wrong, a console that
opens for a hundredth of a second — none of these returns an error, and all
three shipped on Windows with every job on every platform green. Two partial
answers live in the source: tests that read the dispatch back out of
`commands/fs.rs` and scan the backend for a `Command::new` without
`CREATE_NO_WINDOW`, because those properties are decided by one word in an
attribute that no runtime assertion can reach. The rest is checked by hand,
against a written list — see
[WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md).

## The fixtures

`cargo test` writes `tests/fixtures/backend-tree.json`: what `fs_read_dir`
actually returned for a directory tree that really exists, on the platform the
tests just ran on. `tests/adversarial/backend_tree_contract.test.js` reads
those exact bytes back and pushes them through the real explorer code.

That pair is the one place a JS suite says something about the platform: run on
Windows, it shows that a Windows filesystem listing produces explorer rows. It
exists because the explorer rendered **empty on Windows for two releases** —
the Rust tests ran only on Linux and the JS tests fed themselves hand-written
paths. Neither half was wrong on its own; nothing checked them against each
other.

`cargo test` writes `tests/fixtures/menu-accelerators.json` the same way — the
accelerator `src-tauri/src/menu.rs` gives each menu item on this platform.
`tests/adversarial/native_menu.test.js` checks that what the frontend computes
from the default keybindings is exactly that, item for item. The two halves are
in different languages and either one can be edited alone, and the symptom of
drift is a menu that shows one key at launch and another a moment later, once
the frontend pushes its own down.

`cargo test` also writes `tests/fixtures/agent-history.json`: a set of
scenarios run against the real agent session history
(`src-tauri/src/agent_history.rs`). Each scenario records the commands, what
each returned, the file's bytes after each one, and the `.bad-*` copies it
moved aside. The scenarios cover the 200-entry cap, the 1 MiB size cap, moving
damaged files aside (keep 3), refusing a newer version, and clear deleting the
copies. They also cover every refusal case of the Rust unit test, both as a
write and inside an otherwise valid file (dropped on read), and the text
`JSON.parse` reads but serde_json does not (an escaped lone surrogate, nesting
past 128 levels, `-0`). `tests/adversarial/agent_history_contract.test.js`
(AH-*) replays each scenario against the browser mock's `agent_history_*`
commands (`src/lib/ipc.js`) and requires the same results, the same bytes and
the same copies. AH-02 checks that the scenarios the frontend relies on are
present. Change one side and the replay fails until the other side matches.
One difference is known and accepted: the backend refuses a time or version
written as `5.0` or `1e3`, which the mock cannot tell from `5` and `1000`
(see the note above `MOCK_AGENT_HISTORY_KEY` in `src/lib/ipc.js`).

The fixtures are gitignored: they are per-platform output, not source. Run the
JS suites without them and those cases report `SKIPPED`, never `passed`. In CI
they fail outright, because there `cargo test` always runs first and a missing
fixture means the contract went unchecked.

## Skipped is not passed

The harness (`tests/e2e/harness/testFramework.js`) has `skip(reason)`. A case
that cannot run calls it, and both runners print

```
○ BT-01: … — SKIPPED: no tests/fixtures/backend-tree.json
Skipped:  5   <- checked nothing
```

This exists because four cases used to begin `if (!available) return;` and an
early return counted as `passed`: with no fixture the suite reported 276/276
and had verified none of it. **Never return early to avoid a failure.** Either
the case can run, or it says out loud that it did not.

## `tests/e2e/` — the app's flows

Four tiers, by intent rather than by feature:

```
tier1-features/      one feature at a time: terminal, editor, explorer, palette, theme
tier2-boundary/      empty input, non-zero exits, huge output, missing files, clamped sizes
tier3-combinations/  two features meeting: edit → save → run, palette → editor → save-all
tier4-scenarios/     a whole user journey end to end
```

```sh
node tests/e2e/runner.js --tier=1        # or -t 1
node tests/e2e/runner.js --filter="palette"
node tests/e2e/runner.js --bail --verbose
node tests/e2e/runner.js --help
```

`tests/e2e/harness/appEnvironment.js` is a **façade over the real stores**
(`useTerminalStore`, `useEditorStore`, `useSettingsStore`) and the real mock
bridge — not a re-implementation. It used to be one, and deleting
`src/stores/terminalStore.js` outright left the whole suite green. Tabs and
blocks are handed out as live views that re-read the store by id, because the
stores update immutably while the tests hold a reference and read it after
awaiting.

## `tests/adversarial/` — the regression net

One file per defect or invariant, registered in `tests/adversarial/runner.js`.
The suites share one process and one set of module singletons, so:

- **Register a new file at the end of `runner.js`**, and finish it with a
  teardown case that puts the store back the way the next suite expects.
- **Do not swap `globalThis.localStorage` at module scope.** With top-level
  `await`, a module that yields mid-evaluation comes back to find another file
  has replaced the global underneath it — that broke the terminal-groups suite
  twice. Borrow it inside `beforeEach` and hand it back.
- **Do not `import()` a store from inside a test body.** You get a different
  module instance from the one the app is using, with an empty state, and the
  test then measures nothing.

### Quoting checked through real shells

`project_commands.test.js` does not take its own word for how a value is
quoted for a project command (README *Run a folder's own commands*). PC-24 to
PC-30 and PC-40 hand every value of a table — spaces, quotes, `$`, `%`, `!`,
backslashes, Hangul, emoji — through each shell found on the machine, as
`node -e … <index> <quoted value>`, and compare what node received with what
was typed: sh, bash and zsh here and on macOS CI, fish and zsh on Ubuntu CI
(installed by the workflow for this), cmd (`cmd /d /s /c`), Windows PowerShell
5.1 and PowerShell 7 (`-EncodedCommand`) and Git Bash on Windows CI. node
writes what it got to a file rather than to its output, because Windows
PowerShell re-encodes a program's output in the console code page. Which
values each shell refuses is a fixed list per shell, so a quoting that refused
everything cannot pass. These run a shell with `-c`, where history expansion
is off: what only an interactive prompt does (`!!`, `!"`, `^a^b`) is checked
by reading the command line instead (PC-38), and was measured once through a
pty.

## Adding a test

Write the test first and **watch it fail**. A test added after the fix, that
has never been red, has not been shown to test anything.

Then mutate: undo the fix, or break one rule of the thing under test, and
check that the covering case turns red. Every case in the adversarial suite
was added this way, and the practice has repeatedly found tests that passed
while checking nothing — most recently one whose name claimed it covered the
Windows path bug and which passed with the path handling completely broken.

If a mutation survives, it means one of two things, and it is worth deciding
which: the mutation changed no behaviour (fine — say so), or the behaviour is
untested (not fine).

## The control API — three places to test it

`nexterm-cli` and the socket or pipe behind it (stage 7) are tested where each
part lives, because no one suite can hold all three:

- **The backend** — `cargo test` in `src-tauri`: the protocol parser (fuzzed
  lines, oversize, split and slow frames, invalid UTF-8, a depth bomb), caps
  and timeouts on tokio's paused clock, the connection cap, tokens (issue,
  revoke on kill/exit/retain_only), rate limits, the folder and socket modes
  and link refusal, the peer-uid check on a socketpair, and an end-to-end run
  over a real temporary socket with a fake page. Five tests are Windows-only
  and run in CI's windows-latest job: the pipe's DACL read back, a second
  first-instance server refused, a foreign client turned away, `WSLENV`, and
  the end-to-end run over a real pipe.
- **The CLI** — `cargo test` in `src-tauri/cli` (its own crate; run it from
  that folder so its `.cargo/config.toml` applies, as CI does): argument
  parsing for every command, request building, answer decoding, exit codes,
  the server-owner checks, and the real binary against a tiny fake server.
- **The page** — `tests/adversarial/control_*.test.js`: key and text encoding
  per terminal mode (`control_keys`), argument and target rules
  (`control_scope`), every command through the dispatcher with the store and
  backend mocked (`control_dispatcher`), and the browser mock's refusals
  (`control_backend_mock`). A test there reads `controlScope.js` against the
  backend's error codes and commands so the two cannot drift.

The bundles are checked in CI's build job: every installer and the portable
zip is opened and must contain `nexterm-cli`, and the Windows one must be a
console program that does not need `VCRUNTIME140.dll`.

## Performance mode — measuring the output path

Several agents printing at once is a load no suite produces, and timings are
not something a CI machine can be held to. So the app measures itself, on
purpose and from the environment only (never a setting: left on, it would
slow every later session without saying so):

```sh
NEXTERM_PERF=1 NEXTERM_PERF_SCENARIOS=S1,S2,S3,S4,S5 NEXTERM_PERF_REPEAT=3 \
  NEXTERM_PERF_TOOLS=$PWD/tests/perf NEXTERM_PERF_OUT=/tmp/nexterm-perf \
  path/to/NexTerm.app/Contents/MacOS/nexterm
```

```bat
set NEXTERM_PERF=1& set NEXTERM_PERF_SCENARIOS=S1,S2,S3,S4,S5& set NEXTERM_PERF_TOOLS=%CD%\tests\perf& NexTerm.exe
```

Once its terminals are up the app runs each scenario in groups of its own,
closes them, and writes `report-<stamp>.json` to `NEXTERM_PERF_OUT` (the
temporary folder's `nexterm-perf` by default); the table,
`report-<stamp>.md`, is printed in the *perf: cpu* group it leaves open.

| | Load (`tests/perf/flood.js`) | What it is for |
| --- | --- | --- |
| S1 | one terminal, 50 MB at once | how long until it is all drawn |
| S2 | four terminals flooding for 10 s | frames, CPU and memory under the heaviest load |
| S3 | four full-screen programs redrawing at 60 fps (alternate screen, DEC 2026) | what four OpenCodes cost |
| S4 | typing beside three flooding terminals | latency where the user is |
| S5 | typing while a hidden group of four floods | what work nobody can see costs |
| S6 | typing beside four terminals of 5000 lines that keep printing (`rate --fill 5000`, 30 s) | what saving their scrollback costs (stage 6) |
| S7 | `nexterm-cli set-status` from a terminal, 200 times (`tests/perf/control.js`) | the control API's round trip as an agent's hook pays it (stage 7) |

S6 is not in the list above on purpose: it runs only when named
(`NEXTERM_PERF_SCENARIOS=S6`, or appended to the list), as every scenario
does — nothing runs by default — and it takes 30 s a repeat rather than 10,
long enough for each terminal to be saved at the saver's 10 s ceiling three
times. Restore Scrollback must be on (it is by default); with it off the run
says so instead of measuring nothing.

What each figure means:

- **Events/s, Chars/event, Reads/emit** — how finely the output reached the
  page; every event is a script the page evaluates.
- **Readers held s** — flow control holding PTY readers for a page behind
  (summed over readers).
- **Frame p50/p95/max** — time between animation frames while the scenario
  ran; **Write lag** — how long a chunk waited between `term.write` and
  xterm having read it (one sample per terminal per 50 ms).
- **Typing** — from when a key was due to the frame after its echo was read;
  a key with no echo in 3 s is *lost*.
- **CPU app/webview** — `tests/perf/cpu.js`, from outside: the app's process,
  and the web view's (macOS: the WebKit processes that started with it;
  Windows: every `msedgewebview2.exe` under it). Shells and the load are not
  counted.
- **Lost lines** — every generated line is numbered; a number not following
  the one before in what the terminal kept is a loss or a reordering.
- **S6 only, in a table of its own** — *Saves* and *Serialize p50/p95/max*:
  each scrollback snapshot of the four loaded terminals, timed on the page's
  main thread, which is what the keyboard waits behind (src/lib/
  scrollbackSaver.js serializes one terminal per task); *Largest save*: the
  biggest file written, in MB and lines; *Restore all*: once the load ends,
  the four files read back through the backend and written into four fresh,
  never-shown terminals of the same size at once — as a restored group of
  four is — from the reads to xterm having parsed the last one (the slowest
  of the four in brackets); *Typing*: as in S4.

S7 (stage 7, spec D9) runs only when named, as S6 does
(`NEXTERM_PERF_SCENARIOS=S7`), and needs a build with `nexterm-cli` beside the
app and Settings ▸ Terminal ▸ Control on (the default). It types
`node tests/perf/control.js --count 200 --interval 60` into a terminal of its
own, which calls `$NEXTERM_CLI set-status "perf i/200"` 200 times and clears
the status at the end; the runner reads the script's summary back from the
screen. Each call is timed by the script, from before the CLI is started to
after it has exited — starting the process, connecting to the socket or pipe,
the token, the backend's queue, the page's round trip, the store write and
the answer: everything a hook pays. In a table of its own:
*Calls (failed)*; *Round trip p50/p95/p99/max* in ms; *p95 under 20 ms*, the
spec's target; and, when a call failed, the first failure's exit code and
first line (`refused`, `not_responding` …). The calls are 60 ms apart on
purpose: one token may make 20 requests a second (burst 40), and calls back
to back would measure the rate limit instead. The frame and CPU columns of
the main table are those of the same run — a status set 16 times a second
must redraw one side-bar line, not the panel. To time a CLI by hand, outside
the app: `node tests/perf/control.js --count 50 --cli path/to/nexterm-cli`
from a NexTerm terminal.

Rules that keep the numbers honest:

- **Measure release builds**, built with their own identifier so a run
  touches nothing of a real install:
  `npx tauri build --bundles app --config '{"identifier":"com.nexterm.ide.qa-perf"}'`.
  A dev build has no optimised Rust and goes through Vite's dev server.
- **On macOS, switch App Nap off for that identifier**:
  `defaults write com.nexterm.ide.qa-perf NSAppSleepDisabled -bool YES`
  (`defaults delete …` afterwards). An app whose window is behind another
  app's is napped — timers coalesced, priority lowered — and the same build
  measured 2.9 s and then 7.6 s for S1 an hour apart. Measure the same build
  twice before comparing two builds.
- **Compare in one build.** `NEXTERM_PERF_FLOW_KB=0` (no flow control),
  `NEXTERM_PERF_BATCH_MS=0` (an event per read) and `NEXTERM_PERF_PACE_MS=0`
  (no pacing of terminals without focus) switch this branch's three changes
  off, in a measuring run only — which is how Windows compares before and
  after (WINDOWS_VERIFICATION.md V43).

## CI

`.github/workflows/build.yml` runs all three suites on Ubuntu, Windows and
macOS, then builds on all three, and publishes only from a `v*` tag. The
Windows build job also reads the PE header of the binary it just produced and
refuses anything but `Subsystem=2` — a release once shipped as a console
application and users got an empty black terminal window beside the app, which
no source-level test can catch.
