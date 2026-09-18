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
| `cargo test` (`src-tauri/`) | 80 | The backend against the real machine: PTYs, real shells, the real filesystem, OSC parsing, path confinement, the native menu |
| `tests/e2e/` | 44 | The app's own stores and flows, through the browser IPC mock |
| `tests/adversarial/` | 367 | Everything that has ever gone wrong, plus the invariants that keep it from going wrong again |
| `tests/render/` | 13 | Whether the app DRAWS — the only suite that mounts a component |

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

## CI

`.github/workflows/build.yml` runs all three suites on Ubuntu, Windows and
macOS, then builds on all three, and publishes only from a `v*` tag. The
Windows build job also reads the PE header of the binary it just produced and
refuses anything but `Subsystem=2` — a release once shipped as a console
application and users got an empty black terminal window beside the app, which
no source-level test can catch.
