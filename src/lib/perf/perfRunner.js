/**
 * Performance mode's scenarios (stage 4): the loads several agents put on
 * the app, run inside the real app against real shells, and written up.
 *
 * Started by perfMode.js when the app was launched with
 * NEXTERM_PERF_SCENARIOS — never from the UI — so the same run can be made
 * on any machine with one command line and nobody at the keyboard
 * (TEST_INFRA.md, WINDOWS_VERIFICATION.md V43):
 *
 *   S1  one terminal takes 50 MB at once           how long until it has drawn it all
 *   S2  four terminals flood for 10 s              frames and CPU under the heaviest load
 *   S3  four full-screen programs at 60 fps        what four OpenCodes redrawing cost
 *   S4  typing beside three flooding terminals     input latency where the user is
 *   S5  typing while a hidden group of four floods what work nobody can see costs
 *
 * Each runs in groups of its own that are closed afterwards; the group that
 * was on screen comes back. The load is tests/perf/flood.js, typed into the
 * shells the way a startup command is (`typeStartupCommand`: after the first
 * prompt, never into a password prompt). CPU is sampled from outside by
 * tests/perf/cpu.js, in a terminal of its own, and tests/perf/summarize.js
 * puts it all in a table at the end.
 *
 * Typing is `term.input(…, true)` — what xterm does with a key it was given
 * — and its latency runs from when the key was due to the frame after the
 * shell's echo was read: a key the page is too busy to take is late from
 * the moment it was pressed.
 */
import { invoke, pathKinds } from '../ipc.js';
import { quotePath, shellKindFor } from '../dropPaths.js';
import { joinPath, nodeCommand } from './perfCommands.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { existingTerminal, focusTerminalView, getGpuStats } from '../../components/terminal/terminalRegistry.js';
import { checkSequence, counterDelta, parseGeneratorSummary, summarizeTimes } from './perfStats.js';

export const LOAD_SECONDS = 10;
const FLOOD = `flood --seconds ${LOAD_SECONDS}`;
const TUI = `tui --fps 60 --seconds ${LOAD_SECONDS}`;

export const SCENARIOS = {
  S1: { title: 'One terminal takes 50 MB at once', loads: ['bulk --mb 50'], timeoutMs: 180_000 },
  S2: { title: 'Four terminals flood for 10 s', loads: [FLOOD, FLOOD, FLOOD, FLOOD] },
  S3: { title: 'Four full-screen programs redraw at 60 fps for 10 s', loads: [TUI, TUI, TUI, TUI] },
  S4: { title: 'Typing beside three flooding terminals', loads: [FLOOD, FLOOD, FLOOD], typing: 'beside' },
  S5: { title: 'Typing while a hidden group of four floods', loads: [FLOOD, FLOOD, FLOOD, FLOOD], typing: 'hidden' },
};

/** Between one key and the next while measuring typing. */
export const KEY_INTERVAL_MS = 200;
/** A key whose echo has not been read by then counts as lost, not as late. */
export const ECHO_TIMEOUT_MS = 3000;

const now = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function until(test, timeoutMs, everyMs = 100) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = test();
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(everyMs);
  }
}

function leavesOf(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else for (const child of node.children) leavesOf(child, acc);
  return acc;
}

/**
 * Lines of the terminal's normal screen and scrollback from row `from` to
 * row `to` (exclusive), each wrapped line joined back into one: a pane two
 * by two is about fifty columns wide, and the generator's summary is longer.
 */
function bufferRows(term, from = 0, to = term.buffer.normal.length) {
  const buf = term.buffer.normal;
  const rows = [];
  let current = null;
  for (let y = Math.max(0, from); y < Math.min(to, buf.length); y += 1) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && current !== null) current += text;
    else {
      if (current !== null) rows.push(current);
      current = text;
    }
  }
  if (current !== null) rows.push(current);
  return rows;
}

/**
 * The last `count` rows up to and including the cursor's, as text. Up to
 * the cursor, not the end of the buffer: a terminal that has not filled its
 * screen yet has its text at the top and blank rows below.
 */
function tailText(term, count = 16) {
  const buf = term.buffer.normal;
  const cursorRow = buf.baseY + buf.cursorY;
  return bufferRows(term, cursorRow - count + 1, cursorRow + 1).join('\n');
}

/** A new group of `count` terminals (one, two side by side, or two by two); its id and tab ids in pane order. */
async function openGroup(name, count) {
  const store = useTerminalStore.getState();
  const group = await store.createGroup({ name });
  if (!group) throw new Error('could not open a terminal group');
  const panes = [group.activePaneId];
  if (count >= 2) panes.push(await store.splitPane(panes[0], 'horizontal', group.id));
  if (count >= 3) panes.push(await store.splitPane(panes[0], 'vertical', group.id));
  if (count >= 4) panes.push(await store.splitPane(panes[1], 'vertical', group.id));
  const tree = useTerminalStore.getState().groups.find((g) => g.id === group.id)?.tree;
  const leaves = leavesOf(tree);
  const tabIds = panes.map((paneId) => leaves.find((l) => l.id === paneId)?.activeTabId).filter(Boolean);
  if (tabIds.length !== count) throw new Error(`opened ${tabIds.length} of ${count} terminals`);
  // Every one drawn once, so each has its xterm: a group is shown as it opens.
  const drawn = await until(() => tabIds.every((id) => existingTerminal(id)), 15_000);
  if (!drawn) throw new Error('the terminals were never drawn');
  return { groupId: group.id, panes, tabIds };
}

function tabOf(tabId) {
  return useTerminalStore.getState().tabs.find((t) => t.id === tabId) ?? null;
}

/** Type `line` into `tabId` once its shell is ready; whether it was typed. */
async function typeLine(tabId, line) {
  return useTerminalStore.getState().typeStartupCommand(tabId, line);
}

/** Wait for `tabId`'s first prompt by having it echo something. */
async function ready(tabId) {
  const typed = await typeLine(tabId, 'echo ready');
  if (!typed) return false;
  // The echo's own line — the command as typed carries `echo` before it.
  return Boolean(await until(() => !tabOf(tabId)?.running && /^ready\s*$/m.test(tailText(existingTerminal(tabId), 8)), 15_000));
}

function echoed(term, beforeX, beforeY) {
  return new Promise((resolve) => {
    let sub = null;
    const finish = (value) => {
      clearTimeout(timer);
      sub?.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ECHO_TIMEOUT_MS);
    sub = term.onWriteParsed(() => {
      const buf = term.buffer.active;
      if (buf.cursorX !== beforeX || buf.cursorY !== beforeY) finish(now());
    });
  });
}

/**
 * Keys typed into `tabId` every KEY_INTERVAL_MS until `stop()` says so;
 * the latency of each, and the line cleared again with Ctrl+C afterwards.
 */
async function measureTyping(tabId, stop) {
  const term = existingTerminal(tabId);
  const latencies = [];
  const timerLags = [];
  let lost = 0;
  const started = now();
  for (let i = 0; !stop(); i += 1) {
    const due = started + i * KEY_INTERVAL_MS;
    const wait = due - now();
    if (wait > 0) await sleep(wait);
    timerLags.push(Math.max(0, now() - due));
    const buf = term.buffer.active;
    const echo = echoed(term, buf.cursorX, buf.cursorY);
    term.input(String(i % 10), true);
    const at = await echo;
    if (at === null) {
      lost += 1;
      continue;
    }
    await nextFrame();
    latencies.push(now() - due);
    // A line long enough to wrap would move the cursor back: start again.
    if (i % 40 === 39) {
      term.input('\x03', true);
      await sleep(KEY_INTERVAL_MS);
    }
  }
  term.input('\x03', true);
  return { ...summarizeTimes(latencies), lost, timerLag: summarizeTimes(timerLags) };
}

async function counters() {
  try {
    return await invoke('perf_counters');
  } catch {
    return null;
  }
}

/** One run of `scenario`: what it measured, or why it could not. */
export async function runScenario(id, { tools, probe, platform }) {
  const scenario = SCENARIOS[id];
  if (!scenario) return { scenario: id, error: 'no such scenario' };
  const store = useTerminalStore.getState();
  const opened = [];
  const run = { scenario: id, title: scenario.title };
  try {
    let typingTab = null;
    let typingGroup = null;
    if (scenario.typing === 'hidden') {
      typingGroup = await openGroup(`perf ${id} typing`, 1);
      opened.push(typingGroup.groupId);
      typingTab = typingGroup.tabIds[0];
      if (!(await ready(typingTab))) throw new Error('the typing terminal never showed its prompt');
    }
    const count = scenario.loads.length + (scenario.typing === 'beside' ? 1 : 0);
    const group = await openGroup(`perf ${id}`, count);
    opened.push(group.groupId);
    const loadTabs = group.tabIds.slice(0, scenario.loads.length);
    if (scenario.typing === 'beside') {
      typingTab = group.tabIds[scenario.loads.length];
      if (!(await ready(typingTab))) throw new Error('the typing terminal never showed its prompt');
    }

    const script = joinPath(tools, 'flood.js', platform);
    const lines = loadTabs.map((tabId, i) => nodeCommand(script, scenario.loads[i], shellKindFor(tabOf(tabId)?.shell, platform)));
    if (lines.some((line) => !line)) throw new Error(`cannot quote ${script} for these shells`);

    const before = await counters();
    probe.reset();
    probe.startFrames();
    run.startedAtEpoch = Date.now();
    const startedAt = now();
    const typed = await Promise.all(loadTabs.map((tabId, i) => typeLine(tabId, lines[i])));
    if (typed.some((ok) => !ok)) throw new Error('a load command was not typed');
    const typedAt = now();

    // Where the user is: the typing terminal, focused, on the group on screen.
    if (typingTab) {
      if (scenario.typing === 'hidden') store.setActiveGroup(typingGroup.groupId);
      else store.setActivePane(group.panes[scenario.loads.length], group.groupId);
      await nextFrame();
      focusTerminalView(typingTab);
    }

    const finishedAt = new Map();
    const allFinished = () => {
      for (const tabId of loadTabs) {
        if (!finishedAt.has(tabId) && parseGeneratorSummary(tailText(existingTerminal(tabId)))) finishedAt.set(tabId, now());
      }
      return finishedAt.size === loadTabs.length;
    };
    const timeoutMs = scenario.timeoutMs ?? LOAD_SECONDS * 1000 + 60_000;
    const typing = typingTab ? measureTyping(typingTab, () => finishedAt.size > 0 || now() - typedAt > timeoutMs) : null;
    const done = await until(allFinished, timeoutMs);
    run.typing = typing ? await typing : null;
    probe.stopFrames();
    run.endedAtEpoch = Date.now();
    run.durationMs = Math.round(now() - startedAt);
    run.page = probe.snapshot();
    run.backend = counterDelta(before, await counters());
    run.timedOut = !done;
    run.terminals = loadTabs.map((tabId) => {
      const term = existingTerminal(tabId);
      return {
        load: scenario.loads[loadTabs.indexOf(tabId)],
        shell: tabOf(tabId)?.shell ?? null,
        cols: term?.cols ?? null,
        rows: term?.rows ?? null,
        // From the command being typed to the generator's last line read.
        drainMs: finishedAt.has(tabId) ? Math.round(finishedAt.get(tabId) - typedAt) : null,
        generator: term ? parseGeneratorSummary(tailText(term)) : null,
        sequence: term ? checkSequence(bufferRows(term)) : null,
      };
    });
  } catch (err) {
    probe.stopFrames();
    run.error = String(err?.message || err);
  } finally {
    for (const groupId of opened.reverse()) {
      await useTerminalStore.getState().closeGroup(groupId);
    }
  }
  return run;
}

function environment(info) {
  const settings = useSettingsStore.getState();
  const system = useSystemStore.getState();
  return {
    appVersion: system.appVersion ?? null,
    os: system.os ?? null,
    userAgent: navigator.userAgent,
    window: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    terminal: {
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      shell: settings.terminalDefaultShell ?? null,
    },
    gpu: getGpuStats(),
    repeat: info.repeat,
    scenarios: info.scenarios,
  };
}

function stampOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The whole run: every scenario `info.scenarios` names, `info.repeat` times
 * each, the CPU sampled meanwhile, the report written to `info.out_dir`.
 * Resolves with the report's path; any failure is in the report.
 */
export async function runScenarios(info, probe) {
  const platform = useSystemStore.getState().os || 'macos';
  const root = useTerminalStore.getState().rootPath;
  const tools = info.tools_dir || (root ? joinPath(joinPath(root, 'tests', platform), 'perf', platform) : null);
  const stamp = stampOf();
  const report = { version: 1, startedAt: new Date().toISOString(), tools, environment: environment(info), runs: [] };
  const write = (name, text) => invoke('perf_write', { name, text });

  const floodKind = tools ? (await pathKinds([joinPath(tools, 'flood.js', platform)]).catch(() => [null]))[0] : null;
  if (floodKind !== 'file') {
    report.error = `tests/perf/flood.js not found in ${tools ?? '(no folder open)'} — open the NexTerm repository, or set NEXTERM_PERF_TOOLS`;
    return write(`report-${stamp}.json`, JSON.stringify(report, null, 2));
  }

  const shownGroup = useTerminalStore.getState().activeGroupId;
  const cpuFile = joinPath(info.out_dir, `cpu-${stamp}.jsonl`, platform);
  const sampler = await openGroup('perf: cpu', 1);
  const samplerKind = shellKindFor(tabOf(sampler.tabIds[0])?.shell, platform);
  const cpuOut = quotePath(cpuFile, samplerKind);
  const samplerLine = nodeCommand(joinPath(tools, 'cpu.js', platform), `--pid ${info.pid} --out ${cpuOut}`, samplerKind);
  report.cpuFile = cpuFile;
  if (!cpuOut || !samplerLine || !(await typeLine(sampler.tabIds[0], samplerLine))) report.cpuError = 'the CPU sampler could not be started';
  if (shownGroup) useTerminalStore.getState().setActiveGroup(shownGroup);
  // Let the app settle after starting up: the restore, the first prompts.
  await sleep(3000);

  for (const id of info.scenarios) {
    for (let repeat = 1; repeat <= info.repeat; repeat += 1) {
      const run = await runScenario(id, { tools, probe, platform });
      report.runs.push({ ...run, repeat });
      if (shownGroup) useTerminalStore.getState().setActiveGroup(shownGroup);
      await sleep(2000);
    }
  }
  report.endedAt = new Date().toISOString();
  const reportPath = await write(`report-${stamp}.json`, JSON.stringify(report, null, 2));

  // Stop sampling, and put the table where it was sampled.
  const samplerTab = sampler.tabIds[0];
  existingTerminal(samplerTab)?.input('\x03', true);
  await until(() => !tabOf(samplerTab)?.running, 5000);
  const summary = nodeCommand(joinPath(tools, 'summarize.js', platform), quotePath(reportPath, samplerKind), samplerKind);
  if (summary) await typeLine(samplerTab, summary);
  useTerminalStore.getState().setActiveGroup(sampler.groupId);
  return reportPath;
}
