/**
 * Show CPU and Memory (bundle 4, B8), the page side: the words and figures
 * (src/lib/resourceUsage.js), the store of the latest sample
 * (src/stores/resourceUsageStore.js), and when the sampler asks the backend
 * (src/hooks/useResourceSampler.js, `startResourceSampler`), on fake interval
 * timers and a mocked `invoke` handed in.
 *
 *   AC-B8-4  `pty_resource_usage` every 5 s only while the setting is on, the
 *            window can be seen and the TERMINALS panel or a hover card is
 *            on screen — at the start of each run a call at once and one
 *            more 1 s after its answer (human decision, 2026-11-24), no
 *            figure from an earlier run shown; with the setting off, no
 *            call at all (RU-20..33, RU-44)
 *   AC-B8-5  '0%', '12%', '340 MB', '1.2 GB', 'measuring' for a null CPU, the
 *            partial and WSL labels (RU-01..07)
 *   AC-B8-6  the setting's default is pinned in settings.test.js,
 *            settings_window.test.js and terminal_status.test.js (TS-17);
 *            RU-08 checks it is the one the sampler reads.
 *   B8-F4    the TERMINALS row's figure and the hover card, mounted on the
 *            hand-written page of react_page.js (RU-40..43): a card counts
 *            as shown for the sampler while it is open with the setting on,
 *            and lets go when it closes; each figure listens to its own
 *            terminal only, so a sample redraws nothing else. What they
 *            draw, on and off, is the render suite's (RN-244, RN-245).
 *
 * The real settings store is used, for its view and region state; for the
 * sampler, the terminal and system stores are small fakes. The mounted cases
 * draw StatusBoard.jsx and TabHoverCard.jsx, bundled with esbuild (Node
 * cannot import JSX) around the real stores, and put the terminal and system
 * stores back after them. RU-99 puts the settings and the usage store back
 * (afterEach runs only when a case passes, so the teardown is a case of its
 * own, last).
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { create } from 'zustand';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage } from './react_page.js';
import {
  RESOURCE_MEASURING,
  RESOURCE_NOT_MEASURABLE,
  RESOURCE_PARTIAL,
  RESOURCE_FOLLOW_UP_MS,
  RESOURCE_SAMPLE_MS,
  RESOURCE_SETTING,
  documentVisible,
  formatCpu,
  formatMemory,
  isWslTerminal,
  resourceUsageLabel,
  resourceUsageWords,
  shouldSample,
  usageEntry,
} from '../../src/lib/resourceUsage.js';
import { HOVER_CARD_CLOSE_MS, HOVER_CARD_OPEN_MS, createHoverCardController } from '../../src/lib/tabHoverCard.js';
import { useResourceUsageStore } from '../../src/stores/resourceUsageStore.js';
import { SETTINGS_DEFAULTS, useSettingsStore } from '../../src/stores/settingsStore.js';
import { startResourceSampler } from '../../src/hooks/useResourceSampler.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useSystemStore } from '../../src/stores/systemStore.js';

const S = useSettingsStore;
const U = useResourceUsageStore;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The settings the sampler reads, put back to how the app starts. */
const VIEW_DEFAULTS = {
  viewLocations: { explorer: 'left', search: 'left', terminal: 'bottom', terminals: 'right' },
  chosenViews: {},
  sidebarVisible: true,
  panelVisible: true,
  secondarySidebarVisible: true,
};
function resetSettings(patch = {}) {
  S.setState({ ...VIEW_DEFAULTS, [RESOURCE_SETTING]: SETTINGS_DEFAULTS[RESOURCE_SETTING], terminalDefaultShell: 'default', ...patch });
}
const resetUsage = () => U.setState({ byTab: {}, sampledAt: null, cardsShown: 0 });

/**
 * Fake setInterval / clearInterval and setTimeout / clearTimeout on one
 * clock: a timer fires only when `advance` passes it (a timeout once). The
 * answers of the mocked calls settle only when a case awaits; `pass` does
 * that between the timers it passes.
 */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => {
    seq += 1;
    timers.set(seq, { fn, ms, at: now + ms, repeat });
    return seq;
  };
  const clock = {
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: (id) => {
      timers.delete(id);
    },
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** How many timers are set; `timeouts` how many of them fire once. */
    get live() {
      return timers.size;
    },
    get timeouts() {
      return [...timers.values()].filter((t) => !t.repeat).length;
    },
    now: () => now,
    /** When the next timer fires, or null. */
    nextDue() {
      let at = null;
      for (const timer of timers.values()) if (at === null || timer.at < at) at = timer.at;
      return at;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        let dueId = null;
        for (const [id, timer] of timers) if (timer.at <= end && (!due || timer.at < due.at)) [due, dueId] = [timer, id];
        if (!due) break;
        now = due.at;
        if (due.repeat) due.at += due.ms;
        else timers.delete(dueId);
        due.fn();
      }
      now = end;
    },
    /** `ms` going by, the calls' answers settling after each timer that fires, as in the app. */
    async pass(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const at = clock.nextDue();
        if (at === null || at > end) break;
        clock.advance(at - now);
        await flush();
      }
      clock.advance(end - now);
      await flush();
    },
  };
  return clock;
}

/** A document whose visibility a case sets; `visibilitychange` goes to its listeners. */
function fakeDocument(state = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: state,
    listeners,
    addEventListener: (type, fn) => {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
    set(next) {
      this.visibilityState = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

/**
 * A mocked `invoke`: records every call; answers `pty_resource_usage` with
 * `answer(ids, n)` (by default every session asked, CPU null on the first
 * call), or holds each call until `release()` when `hold` is set, or rejects
 * when `fail` is set. Any other command is a failure of the case.
 */
function fakeInvoke() {
  const fake = {
    calls: [],
    held: [],
    hold: false,
    fail: null,
    answer: (ids, n) => ids.map((id) => ({ session_id: id, cpu_percent: n === 1 ? null : 12, memory_bytes: 340 * MIB, processes: 3, partial: false })),
    invoke: (cmd, args) => {
      assert.equal(cmd, 'pty_resource_usage', `only pty_resource_usage is asked, not ${cmd}`);
      fake.calls.push(args);
      if (fake.fail) return Promise.reject(fake.fail);
      const value = fake.answer(args.session_ids, fake.calls.length);
      if (!fake.hold) return Promise.resolve(value);
      return new Promise((resolve) => fake.held.push(() => resolve(value)));
    },
    release() {
      const pending = fake.held.splice(0);
      for (const go of pending) go();
    },
  };
  return fake;
}

const terminals = (tabs) => create(() => ({ tabs }));
const system = (os = 'macos', defaultShell = '/bin/zsh') => create(() => ({ os, defaultShell }));
const tab = (id, sessionId, extra = {}) => ({ id, sessionId, exited: null, ...extra });

/** Lets the mocked calls' promises settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A sampler on fakes; `stop` must be called by the case. */
function sampler({ tabs = [tab('a', 's1'), tab('b', 's2')], os = 'macos', doc = fakeDocument(), fake = fakeInvoke(), clock = fakeTimers() } = {}) {
  const store = terminals(tabs);
  const stop = startResourceSampler({
    store,
    settings: S,
    system: system(os),
    usage: U,
    invoke: fake.invoke,
    doc,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  return { stop, store, doc, fake, clock };
}

describe('Show CPU and Memory: the figures (AC-B8-5)', () => {
  test("RU-01: CPU is a whole percent of one core — '0%', '12%', '140%' — and 'measuring' for null or no figure", () => {
    assert.equal(formatCpu(0), '0%');
    assert.equal(formatCpu(12), '12%');
    assert.equal(formatCpu(12.4), '12%');
    assert.equal(formatCpu(11.5), '12%');
    assert.equal(formatCpu(0.4), '0%');
    assert.equal(formatCpu(100), '100%');
    assert.equal(formatCpu(140), '140%', 'more than one core');
    assert.equal(RESOURCE_MEASURING, 'measuring');
    for (const none of [null, undefined, Number.NaN, Infinity, -1, '12', {}]) {
      assert.equal(formatCpu(none), 'measuring', `${String(none)} is no figure`);
    }
  });

  test("RU-02: memory in binary units labelled MB and GB — '340 MB', '1.2 GB' — whole MB under 1 GB, one decimal from it", () => {
    assert.equal(formatMemory(340 * MIB), '340 MB');
    assert.equal(formatMemory(1.2 * GIB), '1.2 GB');
    assert.equal(formatMemory(340_000_000), '324 MB', 'binary, as Activity Monitor and Task Manager count: not 340');
    assert.equal(formatMemory(0), '0 MB');
    assert.equal(formatMemory(1), '<1 MB');
    assert.equal(formatMemory(MIB - 1), '<1 MB');
    assert.equal(formatMemory(MIB), '1 MB');
    assert.equal(formatMemory(1023.4 * MIB), '1023 MB');
    assert.equal(formatMemory(1023.6 * MIB), '1.0 GB', 'what would round to 1024 MB is a GB');
    assert.equal(formatMemory(GIB), '1.0 GB');
    assert.equal(formatMemory(12.34 * GIB), '12.3 GB');
    for (const none of [null, undefined, Number.NaN, -1, '340', Infinity]) {
      assert.equal(formatMemory(none), '', `${String(none)} is no count of bytes`);
    }
  });

  test("RU-03: the short label — '12% · 340 MB', 'measuring' first, '· partial', 'not measurable' for WSL, '' with no sample", () => {
    const entry = { cpuPercent: 12, memoryBytes: 340 * MIB, processes: 3, partial: false };
    assert.equal(resourceUsageLabel(entry), '12% \u{00B7} 340 MB');
    assert.equal(resourceUsageLabel({ ...entry, cpuPercent: 0 }), '0% \u{00B7} 340 MB');
    assert.equal(resourceUsageLabel({ ...entry, cpuPercent: null, memoryBytes: 1.2 * GIB }), 'measuring \u{00B7} 1.2 GB');
    assert.equal(RESOURCE_PARTIAL, 'partial');
    assert.equal(resourceUsageLabel({ ...entry, partial: true }), '12% \u{00B7} 340 MB \u{00B7} partial');
    assert.equal(resourceUsageLabel({ ...entry, partial: 'yes' }), '12% \u{00B7} 340 MB', 'only true marks it');
    assert.equal(RESOURCE_NOT_MEASURABLE, 'not measurable');
    assert.equal(resourceUsageLabel(entry, { wsl: true }), 'not measurable', 'a WSL terminal never shows figures');
    assert.equal(resourceUsageLabel(null, { wsl: true }), 'not measurable');
    assert.equal(resourceUsageLabel(null), '');
    assert.equal(resourceUsageLabel(undefined), '');
    assert.equal(resourceUsageLabel({ cpuPercent: 12 }), '', 'no memory, no label');
  });

  test("RU-04: the words for a tooltip say '% of one core', the process count, measuring, partial and why WSL has none", () => {
    const entry = { cpuPercent: 12, memoryBytes: 340 * MIB, processes: 3, partial: false };
    assert.equal(resourceUsageWords(entry), 'CPU 12% of one core, memory 340 MB, in 3 processes.');
    assert.equal(resourceUsageWords({ ...entry, cpuPercent: 140, processes: 1 }), 'CPU 140% of one core, memory 340 MB, in 1 process.');
    assert.equal(resourceUsageWords({ ...entry, cpuPercent: null }), 'CPU still being measured, memory 340 MB, in 3 processes.');
    assert.equal(resourceUsageWords({ ...entry, processes: 0 }), 'CPU 12% of one core, memory 340 MB.');
    assert.equal(
      resourceUsageWords({ ...entry, partial: true }),
      'CPU 12% of one core, memory 340 MB, in 3 processes. Some of its processes could not be read, so the figures leave them out.'
    );
    const wsl = resourceUsageWords(entry, { wsl: true });
    assert.match(wsl, /not measurable in a WSL terminal/);
    assert.match(wsl, /Windows cannot see them/);
    assert.equal(resourceUsageWords(null), '');
  });

  test('RU-05: a WSL terminal is told by the shell it reported or would get, on Windows only', () => {
    const win = { platform: 'windows', systemShell: 'C:\\Windows\\System32\\cmd.exe' };
    assert.equal(isWslTerminal({ shell: 'wsl.exe' }, win), true);
    assert.equal(isWslTerminal({ shell: 'C:\\Windows\\System32\\wsl.exe' }, win), true);
    assert.equal(isWslTerminal({ shell: 'ubuntu2204.exe' }, win), true, 'a distribution launcher');
    assert.equal(isWslTerminal({ shell: 'cmd.exe' }, win), false);
    assert.equal(isWslTerminal({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, win), false);
    assert.equal(isWslTerminal({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }, win), false, "Git Bash's bash is MSYS2");
    assert.equal(isWslTerminal({}, { ...win, defaultShell: 'wsl.exe' }), true, 'no reported shell: the Default Shell setting');
    assert.equal(isWslTerminal({}, win), false, 'no reported shell, default setting: the system shell');
    assert.equal(isWslTerminal({ shell: 'wsl' }, { platform: 'macos' }), false, 'never off Windows');
    assert.equal(isWslTerminal({ shell: 'wsl' }, { platform: 'linux' }), false);
    assert.equal(isWslTerminal(null, win), false);
  });

  test('RU-06: shouldSample — the setting on, the window visible, and the panel or a card; every other case no', () => {
    const flags = ['settingOn', 'windowVisible', 'panelVisible', 'cardShown'];
    for (let bits = 0; bits < 16; bits += 1) {
      const input = Object.fromEntries(flags.map((flag, i) => [flag, Boolean(bits & (1 << i))]));
      const expected = input.settingOn && input.windowVisible && (input.panelVisible || input.cardShown);
      assert.equal(shouldSample(input), expected, JSON.stringify(input));
    }
    assert.equal(shouldSample(), false, 'nothing said, no');
    assert.equal(shouldSample({ settingOn: 1, windowVisible: true, panelVisible: true }), false, 'exactly true only');
    assert.equal(shouldSample({ settingOn: true, windowVisible: 'yes', panelVisible: true }), false);
    assert.equal(shouldSample({ settingOn: true, windowVisible: true, cardShown: 1 }), false);
    // The window's side: visible only when the document says so.
    assert.equal(documentVisible({ visibilityState: 'visible' }), true);
    assert.equal(documentVisible({ visibilityState: 'hidden' }), false, 'minimised or hidden');
    assert.equal(documentVisible({ hidden: false }), true);
    assert.equal(documentVisible({ hidden: true }), false);
    assert.equal(documentVisible(null), false);
  });

  test("RU-07: an answer's item becomes an entry only when it is one; `measuring` makes its CPU null", () => {
    const item = { session_id: 's1', cpu_percent: 12.5, memory_bytes: 340 * MIB, processes: 3, partial: true };
    assert.deepEqual(usageEntry(item), { sessionId: 's1', cpuPercent: 12.5, memoryBytes: 340 * MIB, processes: 3, partial: true });
    assert.equal(usageEntry(item, { measuring: true }).cpuPercent, null);
    assert.equal(usageEntry({ ...item, cpu_percent: null }).cpuPercent, null);
    assert.equal(usageEntry({ ...item, cpu_percent: -3 }).cpuPercent, null, 'no negative CPU');
    assert.equal(usageEntry({ ...item, processes: 1.5 }).processes, 0);
    assert.equal(usageEntry({ ...item, partial: 1 }).partial, false);
    for (const bad of [null, 'x', {}, { ...item, session_id: '' }, { ...item, session_id: 7 }, { ...item, memory_bytes: -1 }, { ...item, memory_bytes: '9' }]) {
      assert.equal(usageEntry(bad), null, JSON.stringify(bad));
    }
  });

  test('RU-08: the setting the sampler reads is Show CPU and Memory, off by default (OQ1)', () => {
    assert.equal(RESOURCE_SETTING, 'terminalShowResources');
    assert.equal(SETTINGS_DEFAULTS[RESOURCE_SETTING], false);
    assert.equal(RESOURCE_SAMPLE_MS, 5000);
  });
});

describe('Show CPU and Memory: the store of the latest sample', () => {
  test('RU-10: an answer replaces the last one whole; sessions nobody asked about and malformed items are dropped', () => {
    resetUsage();
    const bySession = new Map([['s1', 'a'], ['s2', 'b']]);
    U.getState().apply(
      [
        { session_id: 's1', cpu_percent: null, memory_bytes: 10 * MIB, processes: 1, partial: false },
        { session_id: 's2', cpu_percent: 5, memory_bytes: 20 * MIB, processes: 2, partial: true },
        { session_id: 's9', cpu_percent: 5, memory_bytes: 20 * MIB, processes: 2, partial: false },
        { session_id: 's1', cpu_percent: 99, memory_bytes: 99 * MIB, processes: 9, partial: false },
        { nonsense: true },
      ],
      bySession,
      { at: 1234 }
    );
    assert.deepEqual(Object.keys(U.getState().byTab).sort(), ['a', 'b']);
    assert.equal(U.getState().byTab.a.memoryBytes, 10 * MIB, 'the first item for a session counts');
    assert.equal(U.getState().byTab.b.partial, true);
    assert.equal(U.getState().sampledAt, 1234);
    U.getState().apply([{ session_id: 's2', cpu_percent: 7, memory_bytes: 21 * MIB, processes: 2, partial: false }], bySession, { at: 2000 });
    assert.deepEqual(Object.keys(U.getState().byTab), ['b'], 'the latest sample only: a left out is gone');
    assert.equal(U.getState().byTab.b.cpuPercent, 7);
    assert.equal(U.getState().sampledAt, 2000);
    const before = U.getState().byTab;
    U.getState().apply('not a list', bySession, { at: 3000 });
    U.getState().apply(null, bySession, { at: 3000 });
    assert.equal(U.getState().byTab, before, 'what is no answer changes nothing');
    assert.equal(U.getState().sampledAt, 2000);
    resetUsage();
  });

  test('RU-11: prune drops a terminal that is gone or runs another session; clear forgets everything; a card counts once', () => {
    resetUsage();
    const item = (id) => ({ session_id: id, cpu_percent: 1, memory_bytes: MIB, processes: 1, partial: false });
    U.getState().apply([item('s1'), item('s2'), item('s3')], new Map([['s1', 'a'], ['s2', 'b'], ['s3', 'c']]), { at: 1 });
    const byTab = U.getState().byTab;
    U.getState().prune(new Map([['a', 's1'], ['b', 's2'], ['c', 's3']]));
    assert.equal(U.getState().byTab, byTab, 'nothing gone, nothing changed');
    U.getState().prune(new Map([['a', 's1'], ['b', 's2-restarted']]));
    assert.deepEqual(Object.keys(U.getState().byTab), ['a']);
    U.getState().clear();
    assert.deepEqual(U.getState().byTab, {});
    assert.equal(U.getState().sampledAt, null);
    const one = U.getState().noteCardShown();
    const two = U.getState().noteCardShown();
    assert.equal(U.getState().cardsShown, 2);
    one();
    one();
    assert.equal(U.getState().cardsShown, 1, 'a let-go counts once');
    two();
    assert.equal(U.getState().cardsShown, 0);
    resetUsage();
  });
});

describe('Show CPU and Memory: when the page asks (AC-B8-4)', () => {
  test('RU-20: with the setting off — its default — not one call, however long, with the panel and the window showing', async () => {
    resetSettings();
    resetUsage();
    const { stop, fake, clock } = sampler();
    assert.equal(clock.live, 0, 'no timer at all');
    clock.advance(60_000);
    await flush();
    assert.equal(fake.calls.length, 0);
    // A card showing does not change that.
    const release = U.getState().noteCardShown();
    clock.advance(60_000);
    await flush();
    assert.equal(fake.calls.length, 0, 'not for a card either');
    assert.equal(clock.live, 0);
    release();
    stop();
  });

  test('RU-21: on, with the panel and the window showing: a call at once, one more 1 s after its answer, then one every 5 s, for the running terminals', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    assert.equal(RESOURCE_SAMPLE_MS, 5_000);
    assert.equal(RESOURCE_FOLLOW_UP_MS, 1_000);
    const { stop, fake, clock } = sampler({ tabs: [tab('a', 's1'), tab('b', 's2'), tab('c', 's3', { exited: { code: 0 } }), tab('d', null)] });
    assert.equal(fake.calls.length, 1, 'at once');
    assert.deepEqual(fake.calls[0], { session_ids: ['s1', 's2'] }, 'running terminals only: not an exited one, not one without a shell yet');
    assert.equal(clock.timeouts, 0, 'no follow-up before the first answer');
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, null, 'the first answer: measuring');
    assert.equal(clock.timeouts, 1, 'the follow-up waits');
    clock.advance(999);
    await flush();
    assert.equal(fake.calls.length, 1, 'not before 1 s after the first answer');
    clock.advance(1);
    assert.equal(fake.calls.length, 2, '1 s after the first answer: one more');
    assert.deepEqual(fake.calls[1], { session_ids: ['s1', 's2'] });
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, 12, 'its CPU is a real figure');
    assert.equal(clock.timeouts, 0, 'one follow-up only');
    clock.advance(3_999);
    await flush();
    assert.equal(fake.calls.length, 2, 'not before 5 s');
    clock.advance(1);
    await flush();
    assert.equal(fake.calls.length, 3, 'at 5 s');
    for (let i = 0; i < 4; i += 1) {
      await clock.pass(5_000);
    }
    assert.equal(fake.calls.length, 7, 'every 5 s, and no other follow-up');
    assert.equal(clock.live, 1, 'one timer');
    stop();
    assert.equal(clock.live, 0, 'stopped: no timer');
    clock.advance(60_000);
    await flush();
    assert.equal(fake.calls.length, 7, 'and no call');
  });

  test('RU-22: minimised or hidden, it stops at once and forgets the figures; visible again, it asks at once, its CPU measuring, a real one 1 s later, then every 5 s', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const { stop, fake, clock, doc } = sampler();
    await clock.pass(5_000);
    assert.equal(fake.calls.length, 3, 'at once, the follow-up, at 5 s');
    assert.equal(U.getState().byTab.a.cpuPercent, 12, 'a later sample has a CPU');
    doc.set('hidden');
    assert.equal(clock.live, 0, 'stopped at once');
    assert.deepEqual(U.getState().byTab, {}, 'the figures are forgotten: none from before the pause can show');
    assert.equal(U.getState().sampledAt, null);
    await clock.pass(120_000);
    assert.equal(fake.calls.length, 3, 'no call while hidden');
    doc.set('visible');
    assert.equal(fake.calls.length, 4, 'at once when visible again');
    assert.deepEqual(U.getState().byTab, {}, 'no old figure while the first answer is out');
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, null, 'measured over the pause: shown as measuring');
    assert.equal(U.getState().byTab.a.memoryBytes, 340 * MIB, 'memory is what it is now');
    await clock.pass(1_000);
    assert.equal(fake.calls.length, 5, '1 s after that answer, one more');
    assert.equal(U.getState().byTab.a.cpuPercent, 12, '1 s later, a real figure');
    await clock.pass(4_000);
    assert.equal(fake.calls.length, 6, 'then every 5 s from the start');
    // Hidden while the follow-up waits: it never comes.
    doc.set('hidden');
    doc.set('visible');
    assert.equal(fake.calls.length, 7);
    await flush();
    assert.equal(clock.timeouts, 1);
    doc.set('hidden');
    assert.equal(clock.live, 0, 'the follow-up goes with the stop');
    await clock.pass(30_000);
    assert.equal(fake.calls.length, 7, 'no follow-up after a stop');
    // A document that starts hidden never asks.
    stop();
    resetUsage();
    const hidden = sampler({ doc: fakeDocument('hidden') });
    await hidden.clock.pass(30_000);
    assert.equal(hidden.fake.calls.length, 0, 'started hidden: no call');
    hidden.stop();
    assert.equal(hidden.doc.listeners.size, 0, 'stop takes its visibility listener away');
  });

  test('RU-23: with neither the panel nor a card on screen it does not ask; a card starts it, the last card going stops it', async () => {
    resetSettings({ [RESOURCE_SETTING]: true, secondarySidebarVisible: false });
    resetUsage();
    const { stop, fake, clock } = sampler();
    await clock.pass(30_000);
    assert.equal(fake.calls.length, 0, 'the side bar holding the panel is hidden');
    const one = U.getState().noteCardShown();
    assert.equal(fake.calls.length, 1, 'a card: at once');
    await flush();
    const two = U.getState().noteCardShown();
    await clock.pass(1_000);
    assert.equal(fake.calls.length, 2, 'one more 1 s after the first answer');
    await clock.pass(4_000);
    assert.equal(fake.calls.length, 3, 'every 5 s while a card shows');
    one();
    await clock.pass(5_000);
    assert.equal(fake.calls.length, 4, 'one card still shows');
    two();
    assert.equal(clock.live, 0, 'the last card gone: stopped at once');
    assert.deepEqual(U.getState().byTab, {}, 'and its figures forgotten');
    await clock.pass(30_000);
    assert.equal(fake.calls.length, 4);
    // The panel's side bar shown again: it asks again.
    S.setState({ secondarySidebarVisible: true });
    assert.equal(fake.calls.length, 5);
    await flush();
    // The panel moved into the left side bar, where the Explorer is chosen: not on screen.
    S.setState({ viewLocations: { ...VIEW_DEFAULTS.viewLocations, terminals: 'left' }, chosenViews: { left: 'explorer' } });
    assert.equal(clock.live, 0, 'the view is not the one its region shows; its follow-up is gone too');
    await clock.pass(30_000);
    assert.equal(fake.calls.length, 5);
    S.setState({ chosenViews: { left: 'terminals' } });
    assert.equal(fake.calls.length, 6, 'chosen there: on screen again');
    await flush();
    stop();
    resetSettings();
  });

  test('RU-24: turned off, it stops at once and the figures are forgotten — an answer still out is dropped', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const fake = fakeInvoke();
    const { stop, clock } = sampler({ fake });
    await clock.pass(5_000);
    assert.equal(fake.calls.length, 3);
    assert.equal(Object.keys(U.getState().byTab).length, 2);
    fake.hold = true;
    clock.advance(5_000);
    assert.equal(fake.calls.length, 4, 'a call is out');
    S.setState({ [RESOURCE_SETTING]: false });
    assert.equal(clock.live, 0, 'stopped at once');
    assert.deepEqual(U.getState().byTab, {}, 'forgotten at once');
    assert.equal(U.getState().sampledAt, null);
    fake.release();
    await flush();
    assert.deepEqual(U.getState().byTab, {}, 'the late answer is dropped');
    await clock.pass(60_000);
    assert.equal(fake.calls.length, 4, 'no call while off');
    // On again: a fresh first sample, and its follow-up.
    fake.hold = false;
    S.setState({ [RESOURCE_SETTING]: true });
    assert.equal(fake.calls.length, 5);
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, null, 'measuring first');
    await clock.pass(1_000);
    assert.equal(fake.calls.length, 6);
    assert.equal(U.getState().byTab.a.cpuPercent, 12, 'a real figure 1 s later');
    stop();
    assert.deepEqual(U.getState().byTab, {}, 'stopping forgets too');
    resetSettings();
  });

  test('RU-25: never two calls at once — a tick or the follow-up while one is out is skipped, even across a stop and start', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const fake = fakeInvoke();
    fake.hold = true;
    const { stop, clock, doc } = sampler({ fake });
    assert.equal(fake.calls.length, 1);
    await clock.pass(30_000);
    assert.equal(fake.calls.length, 1, 'six ticks while it was out: no second call');
    doc.set('hidden');
    doc.set('visible');
    assert.equal(fake.calls.length, 1, 'started again while the old call is out: still one');
    fake.release();
    await flush();
    assert.deepEqual(U.getState().byTab, {}, "the old run's answer is dropped");
    assert.equal(fake.calls.length, 2, 'the new run asks as soon as the old call is back');
    assert.equal(fake.held.length, 1);
    fake.release();
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, null, "the new run's first answer: measuring");
    clock.advance(1_000);
    assert.equal(fake.calls.length, 3, 'its follow-up');
    // The follow-up is out when the 5 s tick comes: the tick is skipped.
    clock.advance(4_000);
    await flush();
    assert.equal(fake.calls.length, 3, 'a tick while the follow-up was out asked');
    assert.equal(fake.held.length, 1, 'two calls out at once');
    fake.release();
    await flush();
    assert.equal(U.getState().byTab.a.cpuPercent, 12);
    clock.advance(5_000);
    assert.equal(fake.calls.length, 4, 'the next tick asks');
    fake.release();
    await flush();
    // A first answer that comes late: the 5 s tick that comes before its
    // follow-up gives the real figure, and the follow-up is not made.
    stop();
    resetUsage();
    const slow = fakeInvoke();
    slow.hold = true;
    const late = sampler({ fake: slow });
    late.clock.advance(4_500);
    slow.release();
    await flush();
    assert.equal(late.clock.timeouts, 1, 'the follow-up waits');
    late.clock.advance(500);
    assert.equal(slow.calls.length, 2, 'the tick at 5 s');
    assert.equal(late.clock.timeouts, 0, 'took the follow-up\'s place');
    slow.release();
    await flush();
    late.clock.advance(1_000);
    assert.equal(slow.calls.length, 2, 'no follow-up after it');
    assert.equal(U.getState().byTab.a.cpuPercent, 12);
    late.stop();
  });

  test('RU-26: a call that fails leaves the figures as they were, throws nothing, and is said once', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const fake = fakeInvoke();
      const { stop, clock } = sampler({ fake });
      await clock.pass(5_000);
      const kept = U.getState().byTab;
      const at = U.getState().sampledAt;
      fake.fail = new Error('the processes cannot be listed');
      for (let i = 0; i < 3; i += 1) {
        await clock.pass(5_000);
      }
      assert.equal(fake.calls.length, 6, 'it keeps asking every 5 s');
      assert.equal(U.getState().byTab, kept, 'the old figures stay');
      assert.equal(U.getState().sampledAt, at);
      assert.equal(warnings.length, 1, `said once: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /could not measure/);
      fake.fail = null;
      clock.advance(5_000);
      await flush();
      assert.equal(U.getState().byTab.a.cpuPercent, 12, 'a new answer is kept');
      stop();
      // An invoke that throws instead of rejecting is the same.
      resetUsage();
      let thrown = 0;
      const thrower = sampler({
        fake: {
          invoke: () => {
            thrown += 1;
            throw new Error('no bridge');
          },
        },
      });
      await thrower.clock.pass(5_000);
      assert.equal(thrown, 2, 'asked at once and at 5 s — no follow-up after a first call that failed — nothing thrown out of the tick');
      assert.deepEqual(U.getState().byTab, {});
      assert.equal(warnings.length, 2, 'this sampler said it once too');
      thrower.stop();
    } finally {
      console.warn = warn;
    }
  });

  test('RU-27: the store holds each running terminal by tab, and a terminal closed, exited or restarted loses its figures at once', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const fake = fakeInvoke();
    fake.answer = (ids, n) => [
      ...ids.map((id, i) => ({ session_id: id, cpu_percent: n === 1 ? null : 10 + i, memory_bytes: (100 + i) * MIB, processes: 2, partial: i === 1 })),
      { session_id: 'nobody', cpu_percent: 1, memory_bytes: 1, processes: 1, partial: false },
    ];
    const { stop, clock, store } = sampler({ fake, tabs: [tab('a', 's1'), tab('b', 's2'), tab('c', 's3')] });
    await flush();
    assert.deepEqual(Object.keys(U.getState().byTab).sort(), ['a', 'b', 'c'], 'an answer for a session not asked about is dropped');
    assert.equal(U.getState().byTab.a.cpuPercent, null, 'first sample: the backend has nothing to measure against');
    assert.equal(U.getState().sampledAt, clock.now());
    await clock.pass(1_000);
    assert.deepEqual(U.getState().byTab.b, { sessionId: 's2', cpuPercent: 11, memoryBytes: 101 * MIB, processes: 2, partial: true });
    assert.equal(U.getState().sampledAt, 1_000);
    await clock.pass(4_000);
    assert.equal(U.getState().sampledAt, 5_000);
    store.setState({ tabs: [tab('a', 's1'), tab('b', 's2', { exited: { code: 1 } }), tab('c', 's3-new')] });
    assert.deepEqual(Object.keys(U.getState().byTab), ['a'], 'closed, exited or restarted: gone before the next sample');
    store.setState({ tabs: [tab('a', 's1')] });
    // A terminal closed while a call is out does not come back with its answer.
    fake.hold = true;
    store.setState({ tabs: [tab('a', 's1'), tab('z', 's26')] });
    clock.advance(5_000);
    assert.deepEqual(fake.calls.at(-1), { session_ids: ['s1', 's26'] });
    store.setState({ tabs: [tab('a', 's1')] });
    fake.release();
    await flush();
    assert.deepEqual(Object.keys(U.getState().byTab), ['a'], 'z closed while its call was out');
    stop();
  });

  test('RU-28: a WSL terminal is not asked about, and with nothing to ask about no call is made', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const { stop, fake } = sampler({ os: 'windows', tabs: [tab('w', 's1', { shell: 'C:\\Windows\\System32\\wsl.exe' }), tab('p', 's2', { shell: 'pwsh.exe' })] });
    assert.deepEqual(fake.calls, [{ session_ids: ['s2'] }]);
    await flush();
    stop();
    resetUsage();
    const empty = sampler({ os: 'windows', tabs: [tab('w', 's1', { shell: 'wsl.exe' })] });
    empty.clock.advance(30_000);
    await flush();
    assert.equal(empty.fake.calls.length, 0, 'only a WSL terminal: nothing asked');
    empty.stop();
    const none = sampler({ tabs: [] });
    none.clock.advance(30_000);
    await flush();
    assert.equal(none.fake.calls.length, 0, 'no terminal: nothing asked');
    none.stop();
  });

  test('RU-29: stop lets go of everything — no timer, no listener, no call when the stores change afterwards', async () => {
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const { stop, fake, clock, doc, store } = sampler();
    await flush();
    stop();
    stop();
    assert.equal(clock.live, 0);
    assert.equal(doc.listeners.size, 0);
    S.setState({ [RESOURCE_SETTING]: false });
    S.setState({ [RESOURCE_SETTING]: true });
    U.getState().noteCardShown()();
    doc.set('visible');
    store.setState({ tabs: [tab('x', 's9')] });
    clock.advance(30_000);
    await flush();
    assert.equal(fake.calls.length, 1, 'only the call made before the stop');
    resetSettings();
  });

  test('RU-30: wired — the app starts the sampler once, and the hook stops it on unmount', () => {
    const app = source('../../src/App.jsx');
    assert.match(app, /import \{ useResourceSampler \} from '\.\/hooks\/useResourceSampler\.js';/);
    assert.equal((app.match(/useResourceSampler\(\);/g) ?? []).length, 1, 'started once');
    const hook = source('../../src/hooks/useResourceSampler.js');
    assert.match(hook, /export function useResourceSampler\(\) \{\n {2}useEffect\(\(\) => startResourceSampler\(\), \[\]\);\n\}/);
    assert.match(hook, /useEffect\(\(\) => \(shown \? useResourceUsageStore\.getState\(\)\.noteCardShown\(\) : undefined\), \[shown\]\);/);
  });
});

// ---- What shows it, mounted (B8-F4) ------------------------------------------

const h = React.createElement;
const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));

/** lucide's icons, as components that draw nothing: the names StatusBoard.jsx imports. */
function lucideStandIn() {
  const board = source('../../src/components/terminal/StatusBoard.jsx');
  const names = (/import \{([^}]*)\} from 'lucide-react';/.exec(board)?.[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  return `const Icon = () => null; export const ${names.map((n) => `${n} = Icon`).join(', ')};`;
}

/**
 * TabHoverCard.jsx and StatusBoard.jsx, bundled: only the .jsx files go in
 * the bundle. Every other module — the stores, the hooks, the helpers, React
 * and zustand — is imported from where it is, so the stores the components
 * read are the ones this file sets.
 */
let loadingUi = null;
function loadUi() {
  loadingUi ??= build({
    stdin: {
      contents: "export { TabHoverCardContent } from './TabHoverCard.jsx';\nexport { TerminalStatusLine } from './StatusBoard.jsx';",
      resolveDir: TERMINAL_DIR,
      sourcefile: 'resource-usage-ui-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'real-modules',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'lucide-react') return { path: 'lucide', namespace: 'stand-in' };
            if (/^[^./]/.test(args.path)) return { path: import.meta.resolve(args.path), external: true };
            if (args.path.endsWith('.jsx')) return undefined;
            return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: lucideStandIn(), loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loadingUi;
}

/** A store entry, as `usageEntry` makes one. */
const entry = (sessionId, cpuPercent, memoryBytes, { processes = 3, partial = false } = {}) => ({ sessionId, cpuPercent, memoryBytes, processes, partial });

/**
 * Run `fn` on a page with terminals `tabs` in the real terminal store and
 * `os` in the system store, both put back afterwards whatever happens.
 */
async function withTerminals(tabs, fn, { os = 'macos' } = {}) {
  const terminal = useTerminalStore.getState();
  const system = useSystemStore.getState();
  try {
    useTerminalStore.setState({ tabs, notifications: [], progress: {}, agentActivity: {}, secretInput: {}, readOnly: {}, reportedStatus: {} });
    useSystemStore.setState({ os, defaultShell: null });
    await onPage(fn);
  } finally {
    useTerminalStore.setState(terminal, true);
    useSystemStore.setState(system, true);
  }
}

/** The text of the first element on page `p` matching `selector`, or null. */
const textOf = (p, selector) => p.document.querySelector(selector)?.textContent ?? null;

describe('Show CPU and Memory: the hover card and the TERMINALS row, mounted (B8-F4)', () => {
  test('RU-40: a hover card counts as shown while it is open with the setting on, and lets go when it closes, unmounts or the setting goes off', async () => {
    const ui = await loadUi();
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    await withTerminals([tab('t1', 's1'), tab('t2', 's2')], async (p) => {
      const card = (tabId, key = tabId) => h(ui.TabHoverCardContent, { key, tabId, id: `card-${key}` });
      p.render(card('t1'));
      assert.equal(U.getState().cardsShown, 1, 'an open card is counted');
      assert.ok(p.document.querySelector('[data-hover-card="t1"]'), 'the card is drawn');
      p.render(h(React.Fragment, null, card('t1'), card('t2')));
      assert.equal(U.getState().cardsShown, 2, 'two cards, two counts');
      p.render(null);
      assert.equal(U.getState().cardsShown, 0, 'closed: let go');
      p.render(card('t1'));
      assert.equal(U.getState().cardsShown, 1);
      p.unmount();
      assert.equal(U.getState().cardsShown, 0, 'unmounted: let go');

      // The setting off: an open card shows no figures and is not counted.
      p.settled(() => S.setState({ [RESOURCE_SETTING]: false }));
      p.render(card('t1'));
      assert.equal(U.getState().cardsShown, 0, 'counted with the setting off');
      p.settled(() => S.setState({ [RESOURCE_SETTING]: true }));
      assert.equal(U.getState().cardsShown, 1, 'the setting turned on while the card is open');
      p.settled(() => S.setState({ [RESOURCE_SETTING]: false }));
      assert.equal(U.getState().cardsShown, 0, 'the setting turned off while the card is open');
      p.settled(() => S.setState({ [RESOURCE_SETTING]: true }));
      p.render(null);
      assert.equal(U.getState().cardsShown, 0);

      // A card for a terminal that is not there draws nothing and counts nothing.
      p.render(card('gone'));
      assert.ok(!p.document.querySelector('[data-hover-card]'));
      assert.equal(U.getState().cardsShown, 0, 'a card for no terminal is counted');
      p.render(null);
    });
    assert.equal(U.getState().cardsShown, 0, 'nothing held after the page');
    resetSettings();
  });

  test("RU-41: an open card's figure comes from its own entry of the usage store: a new sample redraws it, an equal one or another terminal's does not", async () => {
    const ui = await loadUi();
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    await withTerminals([tab('t1', 's1'), tab('t2', 's2')], async (p) => {
      let commits = 0;
      p.render(h(React.Profiler, { id: 'card', onRender: () => (commits += 1) }, h(ui.TabHoverCardContent, { tabId: 't1', id: 'c' })));
      assert.ok(!p.document.querySelector('[data-card-row="usage"]'), 'no sample yet: no row, no placeholder');
      commits = 0;
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 12, 340 * MIB), t2: entry('s2', 1, 10 * MIB) } }));
      assert.equal(commits, 1, 'the first sample draws the row');
      const shown = () => p.document.querySelectorAll('[data-card-row="usage"] span').map((n) => n.textContent);
      assert.deepEqual(shown(), ['Usage ', '12% \u{00B7} 340 MB', 'CPU 12% of one core, memory 340 MB, in 3 processes.']);
      commits = 0;
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 12, 340 * MIB), t2: entry('s2', 90, 900 * MIB) } }));
      assert.equal(commits, 0, "an equal figure, or another terminal's, redraws the card");
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 99.6, 1.25 * GIB, { partial: true }), t2: entry('s2', 1, 10 * MIB) } }));
      assert.equal(commits, 1, 'a new figure redraws the card once');
      assert.equal(shown()[1], '100% \u{00B7} 1.3 GB \u{00B7} partial');
      p.settled(() => U.setState({ byTab: {} }));
      assert.ok(!p.document.querySelector('[data-card-row="usage"]'), 'the figure gone from the store is gone from the card');
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 12, 340 * MIB) } }));
      p.settled(() => S.setState({ [RESOURCE_SETTING]: false }));
      assert.ok(!p.document.querySelector('[data-card-row="usage"]'), 'the setting off: no row');
      assert.ok(!/MB|measuring|measurable|Usage/.test(textOf(p, '[data-hover-card]')), 'the setting off: no figure text');
      commits = 0;
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 50, 500 * MIB) } }));
      assert.equal(commits, 0, 'with the setting off a sample redraws the card');
    });
    resetSettings();
    resetUsage();
  });

  test('RU-42: each TERMINALS line listens to its own terminal: a sample redraws the lines whose figure changed and no other, and none with the setting off', async () => {
    const ui = await loadUi();
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3')];
    await withTerminals(tabs, async (p) => {
      const commits = { t1: 0, t2: 0, t3: 0 };
      const board = (showResources) =>
        h(
          'div',
          null,
          tabs.map((t) =>
            h(
              React.Profiler,
              { key: t.id, id: t.id, onRender: () => (commits[t.id] += 1) },
              h(ui.TerminalStatusLine, { tab: t, showAgent: false, showBranch: false, showLastNote: false, showResources })
            )
          )
        );
      const zero = () => Object.keys(commits).forEach((k) => (commits[k] = 0));
      const figure = (id) => textOf(p, `[data-status-line="${id}"] [data-resource-usage] [aria-hidden="true"]`);
      U.setState({ byTab: { t1: entry('s1', 12, 340 * MIB), t2: entry('s2', 5, 100 * MIB) } });
      p.render(board(true));
      assert.equal(figure('t1'), '12% \u{00B7} 340 MB');
      assert.equal(figure('t2'), '5% \u{00B7} 100 MB');
      assert.ok(!p.document.querySelector('[data-status-line="t3"] [data-resource-usage]'), 'no sample: no figure');
      assert.equal(textOf(p, '[data-status-line="t3"]'), '', 'no sample: nothing on the line, not even a pause');
      zero();
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 13, 341 * MIB), t2: entry('s2', 5, 100 * MIB) } }));
      assert.deepEqual(commits, { t1: 1, t2: 0, t3: 0 }, 'only the line whose figure changed is redrawn');
      assert.equal(figure('t1'), '13% \u{00B7} 341 MB');
      zero();
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 13, 341 * MIB), t2: entry('s2', 5, 100 * MIB) }, sampledAt: 1 }));
      assert.deepEqual(commits, { t1: 0, t2: 0, t3: 0 }, 'an equal sample redraws a line');
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 13, 341 * MIB), t2: entry('s2', 5, 100 * MIB), t3: entry('s3', null, 20 * MIB) } }));
      assert.deepEqual(commits, { t1: 0, t2: 0, t3: 1 });
      assert.equal(figure('t3'), 'measuring \u{00B7} 20 MB');
      const words = textOf(p, '[data-status-line="t1"] [data-resource-usage] .sr-only');
      assert.equal(words, 'CPU 13% of one core, memory 341 MB, in 3 processes.', 'the words are read out');
      assert.equal(p.document.querySelector('[data-status-line="t1"] [data-resource-usage]').getAttribute('title'), words, 'and are its tooltip');

      // Off: no figure, and a sample redraws nothing.
      p.render(board(false));
      assert.ok(!p.document.querySelector('[data-resource-usage]'), 'a figure with the setting off');
      zero();
      p.settled(() => U.setState({ byTab: { t1: entry('s1', 70, 700 * MIB), t2: entry('s2', 70, 700 * MIB), t3: entry('s3', 70, 700 * MIB) } }));
      assert.deepEqual(commits, { t1: 0, t2: 0, t3: 0 }, 'with the setting off a sample redraws a line');
    });
    resetSettings();
    resetUsage();
  });

  test('RU-43: a WSL terminal says not measurable, on its line and its card, while its shell runs; the panel never reads the figures', async () => {
    const ui = await loadUi();
    resetSettings({ [RESOURCE_SETTING]: true });
    resetUsage();
    const wsl = tab('w', 's1', { shell: 'C:\\Windows\\System32\\wsl.exe' });
    const gone = tab('x', 's2', { shell: 'wsl.exe', exited: { code: 0 } });
    await withTerminals(
      [wsl, gone],
      async (p) => {
        p.render(
          h(
            'div',
            null,
            h(ui.TerminalStatusLine, { tab: wsl, showAgent: false, showBranch: false, showLastNote: false, showResources: true }),
            h(ui.TerminalStatusLine, { tab: gone, showAgent: false, showBranch: false, showLastNote: false, showResources: true }),
            h(ui.TabHoverCardContent, { tabId: 'w', id: 'c' })
          )
        );
        assert.equal(textOf(p, '[data-status-line="w"] [data-resource-usage="not-measurable"] [aria-hidden="true"]'), RESOURCE_NOT_MEASURABLE);
        assert.match(textOf(p, '[data-status-line="w"] [data-resource-usage] .sr-only'), /not measurable in a WSL terminal/);
        assert.ok(!p.document.querySelector('[data-status-line="x"] [data-resource-usage]'), 'an exited WSL terminal has nothing to say');
        assert.ok(p.document.querySelector('[data-card-row="usage"][data-usage-wsl]'), 'the card marks it');
        assert.match(textOf(p, '[data-card-row="usage"]'), /not measurable/);
      },
      { os: 'windows' }
    );
    resetSettings();
    // Only what shows a figure reads the store: the panel reads the setting alone.
    const panel = source('../../src/components/terminal/TerminalsPanel.jsx');
    assert.ok(!/useResourceUsageStore|resourceUsageStore/.test(panel), 'the TERMINALS panel subscribes to the usage store');
    assert.match(panel, /const showResources = useSettingsStore\(\(s\) => s\.terminalShowResources === true\);/);
    assert.match(panel, /showResources=\{showResources\}/);
    const card = source('../../src/components/terminal/TabHoverCard.jsx');
    assert.match(card, /useResourceCardShown\(showUsage && tab !== null\);/);
    assert.ok(!/useMinuteNow|minuteClock/.test(card.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'the card listens to the minute clock');
  });

  test('RU-44: with the TERMINALS panel hidden, a card shows its CPU 1.6 s after the pointer came onto its tab — 600 ms to open, measuring, a real figure 1 s later — and never a figure from an earlier opening', async () => {
    const ui = await loadUi();
    resetSettings({ [RESOURCE_SETTING]: true, secondarySidebarVisible: false });
    resetUsage();
    const clock = fakeTimers();
    const fake = fakeInvoke();
    // Each call's figures differ, so a figure from an earlier call shows as one.
    fake.answer = (ids, n) => ids.map((id) => ({ session_id: id, cpu_percent: 10 * n, memory_bytes: 100 * n * MIB, processes: 2, partial: false }));
    await withTerminals([tab('t1', 's1'), tab('t2', 's2')], async (p) => {
      const stop = startResourceSampler({
        store: useTerminalStore,
        settings: S,
        system: useSystemStore,
        usage: U,
        invoke: fake.invoke,
        doc: fakeDocument(),
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        now: clock.now,
      });
      // The chip's controller on the same clock; its card drawn as the pane draws it.
      const card = createHoverCardController({
        onChange: (id) => p.render(id ? h(ui.TabHoverCardContent, { key: id, tabId: id, id: 'card' }) : null),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      // The figure as drawn (its words for a screen reader are another span).
      const usageShown = () => p.document.querySelectorAll('[data-hover-card="t1"] [data-card-row="usage"] span')[1]?.textContent ?? null;
      try {
        assert.equal(fake.calls.length, 0, 'the panel is hidden and no card is open: no call');
        card.enter('t1');
        await clock.pass(HOVER_CARD_OPEN_MS - 1);
        assert.equal(card.shown, null);
        assert.equal(fake.calls.length, 0, 'no call before the card opens');
        await clock.pass(1);
        assert.ok(p.document.querySelector('[data-hover-card="t1"]') !== null, 'the card opened at 600 ms');
        assert.equal(fake.calls.length, 1, 'the card asks at once');
        assert.equal(usageShown(), 'measuring \u{00B7} 100 MB', 'its first answer: CPU measuring');
        await clock.pass(RESOURCE_FOLLOW_UP_MS - 1);
        assert.equal(usageShown(), 'measuring \u{00B7} 100 MB', 'still measuring at 1.599 s');
        await clock.pass(1);
        assert.equal(fake.calls.length, 2);
        assert.equal(usageShown(), '20% \u{00B7} 200 MB', 'a real CPU figure at 1.6 s');
        await clock.pass(5_000);
        assert.equal(usageShown(), '30% \u{00B7} 300 MB', 'then every 5 s while it is open');

        // Closed: the sampler stops and forgets.
        card.leave('t1');
        await clock.pass(HOVER_CARD_CLOSE_MS);
        assert.equal(p.document.querySelector('[data-hover-card]'), null, 'closed');
        assert.deepEqual(U.getState().byTab, {}, 'the figures are forgotten with the last card');
        await clock.pass(60_000);
        assert.equal(fake.calls.length, 3, 'no call while no card is open');

        // Open again with the answer slow: no old figure on the card meanwhile.
        fake.hold = true;
        card.enter('t1');
        await clock.pass(HOVER_CARD_OPEN_MS);
        assert.ok(p.document.querySelector('[data-hover-card="t1"]') !== null, 'open again');
        assert.equal(fake.calls.length, 4);
        assert.equal(usageShown(), null, 'a figure from the earlier opening shows while the first answer is out');
        fake.release();
        await clock.pass(0);
        assert.equal(usageShown(), 'measuring \u{00B7} 400 MB');
        await clock.pass(RESOURCE_FOLLOW_UP_MS);
        fake.release();
        await clock.pass(0);
        assert.equal(usageShown(), '50% \u{00B7} 500 MB', 'a real figure 1 s later again');
      } finally {
        card.hide();
        stop();
      }
    });
    assert.equal(U.getState().cardsShown, 0);
    resetSettings();
    resetUsage();
  });
});

describe('Show CPU and Memory: teardown', () => {
  test('RU-99: the settings and the usage store are put back', () => {
    resetSettings();
    resetUsage();
    assert.equal(S.getState()[RESOURCE_SETTING], false);
    assert.equal(S.getState().secondarySidebarVisible, true);
    assert.deepEqual(U.getState().byTab, {});
    assert.equal(U.getState().cardsShown, 0);
  });
});
