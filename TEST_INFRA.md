# NexTerm E2E Testing Infrastructure

## 1. Testing Philosophy

The NexTerm E2E Testing Track provides an autonomous, opaque-box testing suite designed strictly against the user requirements, interface contracts, and system specifications defined in:
- `ORIGINAL_REQUEST.md` (2026-09-05T23:55:47Z)
- `PROJECT.md` (Dual-track architecture, 52 mined features, 17 Tauri IPC commands, 6 events)
- `multi_ai_terminal_ide_plan.md` (Warp block UX, Monaco editor, Mission Control, MCP, BYOK)

### Core Tenets:
1. **Strict Pure JavaScript Architecture**: 100% of the test suite and test runner is written in pure ECMAScript (`.js`), strictly enforcing the zero `.ts`/`.tsx` project constraint.
2. **Zero External Runtime Dependencies**: The test runner executes directly on standard Node.js (v18+) using native assertions (`node:assert/strict`), requiring zero external npm dependencies to install or compile before running tests.
3. **High-Fidelity Virtual Emulation**: Built-in mock IPC bridge (`MockIpcBridge`) and virtual application environment (`AppEnvironment`) faithfully simulate all 17 Tauri IPC commands, 6 asynchronous streaming events, Monaco editor tab lifecycle, terminal PTY processes, and Mission Control agent state machines.
4. **Authoritative Output Derivation**: Every test case exercises real state mutations, data transfers, and boundary conditions, eliminating facade tests and verifying explicit expected outputs derived from specification contracts.

---

## 2. Test Runner Execution & CLI Guide

The E2E test runner can be executed directly with `node` or via `npm test`.

### Basic Execution:
```bash
# Run all 4 test tiers (all 68 tests)
node tests/e2e/runner.js

# Or if package.json script is linked:
npm test
```

### Advanced CLI Flags:
```bash
# Execute specific tier only (e.g. Tier 1 Feature Coverage)
node tests/e2e/runner.js --tier=1

# Execute Tier 2 Boundary & Corner Cases
node tests/e2e/runner.js --tier=2

# Execute Tier 3 Cross-Feature Combinations
node tests/e2e/runner.js --tier=3

# Execute Tier 4 Real-World End-to-End Scenarios
node tests/e2e/runner.js --tier=4

# Filter tests or suites by name pattern
node tests/e2e/runner.js --filter="Terminal"
node tests/e2e/runner.js --filter="Mission Control"

# Stop execution immediately upon first failure
node tests/e2e/runner.js --bail

# Display command-line help
node tests/e2e/runner.js --help
```

---

## 3. 4-Tier Test Suite Structure

```
tests/e2e/
├── package.json                   # ESM module configuration ({ "type": "module" })
├── runner.js                      # Central test runner with CLI flags, timing, colored reporter
├── harness/
│   ├── index.js                   # Unified exports for test suites
│   ├── testFramework.js           # Lightweight zero-dep test harness (describe, it, beforeEach, assert)
│   ├── mockIpc.js                 # Complete Tauri v2 IPC bridge emulator (17 commands, 6 events)
│   └── appEnvironment.js          # High-fidelity virtual NexTerm application state manager
├── fixtures/
│   ├── mockAgents.js              # Baseline agents & chat seed data
│   └── sampleFiles.js             # Initial virtual filesystem files
├── tier1-features/                # Tier 1: Feature Coverage (>=5 test cases per feature)
│   ├── terminal.test.js           # 7 tests: Blocks, stdout streaming, duration, tabs, pin, clear, kill
│   ├── editor.test.js             # 7 tests: File loading, syntax mode, dirty state, save, theme, tabs
│   ├── explorer.test.js           # 7 tests: Directory tree, expand/collapse, open file, CRUD, refresh
│   ├── missionControl.test.js     # 7 tests: Baseline agents, status indicators, create modal, logs, chaining
│   ├── chat.test.js               # 6 tests: Seed history, markdown code blocks, streaming tokens, context, BYOK
│   ├── commandPalette.test.js     # 6 tests: ⌘K modal, fuzzy search files/commands/AI, selection execution
│   └── theme.test.js              # 6 tests: Dark/Light switching, Monaco theme sync, validation
├── tier2-boundary/                # Tier 2: Boundary & Corner Cases
│   └── boundary.test.js           # 12 tests: Empty commands, non-zero exit codes, large streams, validation
├── tier3-combinations/            # Tier 3: Cross-Feature Combinations (Pairwise interactions)
│   └── crossFeature.test.js       # 6 tests: Terminal error -> AI, Explorer -> Monaco -> Terminal, Agent logs -> Chat
└── tier4-scenarios/               # Tier 4: Real-World Scenarios (End-to-end user journeys)
    └── realWorldScenarios.test.js # 4 journeys: Full bug-fix, multi-agent orchestration, keyboard-first, resilience
```

---

## 4. Comprehensive Coverage Matrix

| Tier | Test ID | Subsystem / Target | Verified Contract / Behavior |
|:---|:---|:---|:---|
| **Tier 1** | `TC-TERM-01` | Terminal | Executing command creates distinct block container card |
| **Tier 1** | `TC-TERM-02` | Terminal | PTY stdout streaming captures output inside block card |
| **Tier 1** | `TC-TERM-03` | Terminal | Exit code (0) and execution duration metadata recorded |
| **Tier 1** | `TC-TERM-04` | Terminal | Multiple terminal tabs with isolated PTY sessions and active tab switching |
| **Tier 1** | `TC-TERM-05` | Terminal | Block action toolbar toggles pin state (`pinned: true/false`) |
| **Tier 1** | `TC-TERM-06` | Terminal | Clear terminal purges normal blocks while preserving pinned blocks |
| **Tier 1** | `TC-TERM-07` | Terminal | Closing terminal tab invokes `pty_kill` and shifts active tab |
| **Tier 1** | `TC-EDIT-01` | Monaco Editor | Opening file reads content from disk with syntax language detection |
| **Tier 1** | `TC-EDIT-02` | Monaco Editor | Multiple open file tabs with active tab tracking |
| **Tier 1** | `TC-EDIT-03` | Monaco Editor | Buffer modifications toggle `isDirty` state; reverting restores clean state |
| **Tier 1** | `TC-EDIT-04` | Monaco Editor | Saving dirty tab writes to disk via `fs_write_file` and resets dirty flag |
| **Tier 1** | `TC-EDIT-05` | Monaco Editor | Monaco theme synchronizes (`vs-dark` vs `vs-light`) |
| **Tier 1** | `TC-EDIT-06` | Monaco Editor | Re-opening existing file focuses tab without duplicating tab |
| **Tier 1** | `TC-EDIT-07` | Monaco Editor | Closing active tab removes it and activates adjacent tab |
| **Tier 1** | `TC-EXPL-01` | File Explorer | Populates recursive filesystem tree via `fs_read_dir` |
| **Tier 1** | `TC-EXPL-02` | File Explorer | Folder chevron click toggles expanded/collapsed state |
| **Tier 1** | `TC-EXPL-03` | File Explorer | Clicking file node opens file in Monaco editor |
| **Tier 1** | `TC-EXPL-04` | File Explorer | Creating file via `fs_create_file` updates explorer tree |
| **Tier 1** | `TC-EXPL-05` | File Explorer | Creating directory via `fs_create_dir` updates explorer tree |
| **Tier 1** | `TC-EXPL-06` | File Explorer | Deleting path via `fs_delete_path` removes node from explorer |
| **Tier 1** | `TC-EXPL-07` | File Explorer | Refresh preserves user-expanded folder states |
| **Tier 1** | `TC-MC-01` | Mission Control | Initializes >= 2 pre-populated agents (Architect, Test Engineer) |
| **Tier 1** | `TC-MC-02` | Mission Control | Agent status indicators (`active`, `waiting`, `idle`) and progress |
| **Tier 1** | `TC-MC-03` | Mission Control | "New Agent" modal registers new agent via `agent_create` |
| **Tier 1** | `TC-MC-04` | Mission Control | Agent lifecycle controls (`agent_update_status`: pause, resume, complete) |
| **Tier 1** | `TC-MC-05` | Mission Control | Streamed logs drawer retrieves agent logs via `agent_get_logs` |
| **Tier 1** | `TC-MC-06` | Mission Control | Dependency chaining: Predecessor completion unblocks dependent agent |
| **Tier 1** | `TC-MC-07` | Mission Control | Real-time aggregated telemetry (total tokens, total cost, active counts) |
| **Tier 1** | `TC-CHAT-01` | AI Chat | Initializes with seed thread containing >= 1 user and 1 assistant message |
| **Tier 1** | `TC-CHAT-02` | AI Chat | Renders markdown bold text and fenced code blocks with language tags |
| **Tier 1** | `TC-CHAT-03` | AI Chat | Submitting prompt invokes `chat_send_message` and appends to thread |
| **Tier 1** | `TC-CHAT-04` | AI Chat | Streaming tokens via `chat-token` event animate until `done: true` |
| **Tier 1** | `TC-CHAT-05` | AI Chat | Context injection enriches prompt with file/error snippet |
| **Tier 1** | `TC-CHAT-06` | AI Chat | BYOK settings panel securely stores OpenAI, Claude, Gemini API keys |
| **Tier 1** | `TC-PAL-01` | Command Palette | ⌘K opens modal and Escape/close resets query |
| **Tier 1** | `TC-PAL-02` | Command Palette | Real-time fuzzy search filters files |
| **Tier 1** | `TC-PAL-03` | Command Palette | Real-time fuzzy search filters IDE commands |
| **Tier 1** | `TC-PAL-04` | Command Palette | Real-time fuzzy search filters AI prompt actions |
| **Tier 1** | `TC-PAL-05` | Command Palette | Executing file search result opens file in Monaco editor and closes palette |
| **Tier 1** | `TC-PAL-06` | Command Palette | Executing command action toggles theme and closes palette |
| **Tier 1** | `TC-THM-01` | Theming | Default startup theme is dark (`vs-dark`) |
| **Tier 1** | `TC-THM-02` | Theming | Theme toggle switches to light mode without reload |
| **Tier 1** | `TC-THM-03` | Theming | Secondary toggle switches back to dark mode |
| **Tier 1** | `TC-THM-04` | Theming | Explicit `setTheme` updates application and Monaco editor model |
| **Tier 1** | `TC-THM-05` | Theming | Setting invalid theme throws validation error |
| **Tier 1** | `TC-THM-06` | Theming | Theme persists across file tab switches |
| **Tier 2** | `TC-BND-01` | Boundaries | Empty / whitespace command does not create ghost blocks or crash PTY |
| **Tier 2** | `TC-BND-02` | Boundaries | Exit code 127 (command not found) marks block failed and records exit code |
| **Tier 2** | `TC-BND-03` | Boundaries | Exit code 1 (test suite failure) captures failure assertion details |
| **Tier 2** | `TC-BND-04` | Boundaries | Large output streams (50,000+ chars) buffer without execution lockup |
| **Tier 2** | `TC-BND-05` | Boundaries | Opening non-existent file cleanly throws `File not found` |
| **Tier 2** | `TC-BND-06` | Boundaries | Empty agent name submission throws validation error |
| **Tier 2** | `TC-BND-07` | Boundaries | Missing agent model selection throws validation error |
| **Tier 2** | `TC-BND-08` | Boundaries | Setting invalid agent status throws validation error |
| **Tier 2** | `TC-BND-09` | Boundaries | 50 rapid theme toggles complete without race conditions or state desync |
| **Tier 2** | `TC-BND-10` | Boundaries | PTY resize dimensions clamp out-of-bounds inputs (10..500 cols, 2..200 rows) |
| **Tier 2** | `TC-BND-11` | Boundaries | Creating duplicate file throws `File already exists` |
| **Tier 2** | `TC-BND-12` | Boundaries | Deleting non-existent path throws `Path does not exist` |
| **Tier 3** | `TC-XF-01` | Cross-Feature | Terminal Error -> Ask AI Chat context injection and fix generation |
| **Tier 3** | `TC-XF-02` | Cross-Feature | Explorer Click -> Monaco Edit -> Save to disk -> Run in Terminal |
| **Tier 3** | `TC-XF-03` | Cross-Feature | New Agent in Mission Control -> Streamed Logs -> AI Chat Context |
| **Tier 3** | `TC-XF-04` | Cross-Feature | Command Palette Open File -> Edit in Monaco -> Quick Palette "Save All" |
| **Tier 3** | `TC-XF-05` | Cross-Feature | Theme Switch -> Monaco Theme Sync -> Terminal Sync |
| **Tier 3** | `TC-XF-06` | Cross-Feature | Mission Control Agent Dependency Chain -> Terminal Trigger |
| **Tier 4** | `TC-SCENARIO-01` | Real-World | Full Bug-Fixing Journey: Inspect -> Test -> Fail -> AI Fix -> Monaco -> Pass |
| **Tier 4** | `TC-SCENARIO-02` | Real-World | Multi-Agent Parallel Orchestration & Aggregated Telemetry Journey |
| **Tier 4** | `TC-SCENARIO-03` | Real-World | Keyboard-First Power User Navigation Journey (⌘K + Tabs + Pinning) |
| **Tier 4** | `TC-SCENARIO-04` | Real-World | Disaster Recovery & Error Resilience Journey (Kill, Missing File, Invalid Form) |

**Total Test Count:** 68 tests across 10 suites in 4 tiers.
