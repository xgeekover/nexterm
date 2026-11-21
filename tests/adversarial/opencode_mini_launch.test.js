/**
 * OpenCode V1 in mini mode, started and resumed by NexTerm: the flags
 * (agents.js `withOpencodeMini`), the decision (src/lib/opencodeLaunch.js:
 * the setting and a cached `opencode --version` probe, failing safe), and
 * what `startAgent` and `resumeAgent` type (terminalStore.js), with the ipc
 * mock standing in for the backend's `opencode_version`. No opencode runs.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { OPENCODE_MINI_FLAGS, agentFromCommandLine, agentLabel, resumeCommand, startCommand, withOpencodeMini } from '../../src/lib/agents.js';
import { createOpencodeLaunch, resetOpencodeLaunch } from '../../src/lib/opencodeLaunch.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { useSettingsStore as S } from '../../src/stores/settingsStore.js';
import {
  PERSIST_KEY,
  __setAgentPromptWaitMs,
  __setTypingGuardProbe,
  setAgentLaunchObserver,
  useTerminalStore as T,
} from '../../src/stores/terminalStore.js';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
}

const SES = 'ses_ef45006f5ffeAMtumN5ySj4VmT';
const SES_B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';
const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);
const prompt = (tab) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('Mini mode: the flags (AC7)', () => {
  test('OML-01: `withOpencodeMini` puts `--mini --no-replay` after the program name of an opencode line, and nothing else changes', () => {
    assert.equal(OPENCODE_MINI_FLAGS, '--mini --no-replay');
    assert.equal(withOpencodeMini('opencode'), 'opencode --mini --no-replay');
    assert.equal(withOpencodeMini(`opencode -s ${SES}`), `opencode --mini --no-replay -s ${SES}`);
    assert.equal(withOpencodeMini('opencode --continue'), 'opencode --mini --no-replay --continue');
    for (const line of ['claude', `claude --session-id ${UUID}`, `claude --resume ${UUID}`, 'claude --continue', 'opencodex', 'opencode --mini', 'xopencode', '', null]) {
      assert.equal(withOpencodeMini(line), line, JSON.stringify(line));
    }
  });

  test('OML-02: `startCommand` and `resumeCommand` type what v0.31.0 typed; a line with the flags is still opencode, with its id', () => {
    assert.equal(startCommand('opencode').command, 'opencode');
    assert.match(startCommand('claude').command, /^claude --session-id [0-9a-f-]{36}$/);
    assert.equal(resumeCommand({ kind: 'opencode', sessionId: SES }), `opencode -s ${SES}`);
    assert.equal(resumeCommand({ kind: 'opencode', sessionId: null }), 'opencode --continue');
    assert.equal(resumeCommand({ kind: 'claude', sessionId: UUID }), `claude --resume ${UUID}`);
    assert.deepEqual(agentFromCommandLine(`opencode --mini --no-replay -s ${SES}`), { kind: 'opencode', sessionId: SES });
    assert.deepEqual(agentFromCommandLine('opencode --mini'), { kind: 'opencode', sessionId: null });
    assert.deepEqual(agentFromCommandLine('opencode --mini --no-replay --continue'), { kind: 'opencode', sessionId: null });
  });
});

describe('Mini mode: the decision, cached and failing safe (AC8)', () => {
  test('OML-03: one probe for many lines, none with the setting off or for claude; a failure is asked again only after a minute', async () => {
    let clock = 0;
    let calls = 0;
    let answer = () => ({ version: '1.18.34', mini: true });
    let on = true;
    const launch = createOpencodeLaunch({ probe: async () => (calls += 1, answer()), enabled: () => on, now: () => clock });
    on = false;
    assert.equal(await launch.line('opencode', 'opencode'), 'opencode', 'setting off');
    assert.equal(calls, 0, 'not probed with the setting off');
    on = true;
    assert.equal(await launch.line('claude', 'claude'), 'claude');
    assert.equal(calls, 0, 'never for claude');
    const [a, b] = await Promise.all([launch.line('opencode', 'opencode'), launch.line('opencode', 'opencode --continue')]);
    assert.deepEqual([a, b], ['opencode --mini --no-replay', 'opencode --mini --no-replay --continue']);
    assert.equal(await launch.line('opencode', `opencode -s ${SES}`), `opencode --mini --no-replay -s ${SES}`);
    assert.equal(calls, 1, 'one probe, in flight once, kept');
    assert.deepEqual(launch.answer, { version: '1.18.34', mini: true });

    const failing = createOpencodeLaunch({ probe: async () => (calls += 1, answer()), enabled: () => true, now: () => clock, timeoutMs: 20 });
    calls = 0;
    answer = () => {
      throw new Error('opencode was not found on PATH');
    };
    assert.equal(await failing.line('opencode', 'opencode'), 'opencode');
    clock += 59_000;
    assert.equal(await failing.line('opencode', 'opencode'), 'opencode');
    assert.equal(calls, 1, 'not again within the minute');
    clock += 2_000;
    answer = () => new Promise(() => {});
    assert.equal(await failing.line('opencode', 'opencode'), 'opencode', 'no answer in time');
    assert.equal(calls, 2);
    clock += 61_000;
    answer = () => ({ version: '1.17.10', mini: true });
    assert.equal(await failing.line('opencode', 'opencode'), 'opencode --mini --no-replay', 'asked again, and it answers now');
    for (const bad of [null, 'yes', { mini: 'true' }, { version: '1.18.34' }]) {
      const launch2 = createOpencodeLaunch({ probe: async () => bad, enabled: () => true });
      assert.equal(await launch2.line('opencode', 'opencode'), 'opencode', JSON.stringify(bad));
    }
  });

  test('OML-04: the ipc mock answers `opencode_version` by the backend\'s rule', async () => {
    const saved = mockBridge.opencodeVersion;
    try {
      delete mockBridge.opencodeVersion;
      await assert.rejects(() => mockBridge.invoke('opencode_version', {}), /not found/);
      const answers = { '1.18.34': true, '1.17.10': true, 'opencode 1.19.6': true, '1.17.9': false, '0.9.0': false, '2.3.2': false, 'v2.0.0': false, garbage: false, '': false };
      for (const [printed, mini] of Object.entries(answers)) {
        mockBridge.opencodeVersion = printed;
        assert.equal((await mockBridge.invoke('opencode_version', {})).mini, mini, printed);
      }
      mockBridge.opencodeVersion = new Error('opencode --version: gave up after 5 s');
      await assert.rejects(() => mockBridge.invoke('opencode_version', {}), /gave up/);
    } finally {
      mockBridge.opencodeVersion = saved;
    }
  });
});

/** A fresh store with one terminal whose shell has drawn its prompt (unless `prompted` is false). */
async function freshTerminal({ prompted = true } = {}) {
  T.getState().dispose();
  localStorage.removeItem(PERSIST_KEY);
  T.setState({ tabs: [], activeTabId: null, isInitialized: false });
  await T.getState().init();
  const tab = await T.getState().createTab();
  if (prompted) await prompt(tab);
  return tabById(tab.id);
}

/** What `fn` typed, with `opencode --version` printing `version` (a string, an Error, or nothing). */
async function typedWith({ version, setting = true }, fn) {
  const original = mockBridge.invoke;
  const saved = mockBridge.opencodeVersion;
  const calls = { writes: [], probes: 0 };
  resetOpencodeLaunch({ timeoutMs: 50 });
  S.getState().setSetting('terminalOpencodeMini', setting);
  if (version === undefined) delete mockBridge.opencodeVersion;
  else mockBridge.opencodeVersion = version;
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      calls.writes.push(args?.data);
      return null;
    }
    if (command === 'opencode_version') {
      calls.probes += 1;
      if (version === 'hang') return new Promise(() => {});
    }
    if (command === 'agent_sessions') throw new Error('opencode was not found on PATH');
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
    mockBridge.opencodeVersion = saved;
    S.getState().setSetting('terminalOpencodeMini', true);
    resetOpencodeLaunch();
  }
  return calls;
}

/** A restored terminal offering `agent` back. */
function offer(tab, agent) {
  T.setState((state) => ({
    tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, agent: { startedAt: 1, title: null, ...agent }, agentResumeOffered: true } : t)),
  }));
}

/** Every start and resume NexTerm types, for one probe answer and setting. */
async function everyLine(options) {
  const lines = {};
  const calls = await typedWith(options, async (c) => {
    const at = () => c.writes.length;
    let tab = await freshTerminal();
    let from = at();
    await T.getState().startAgent(tab.id, 'opencode');
    lines.start = c.writes.slice(from);
    from = at();
    await T.getState().startAgent((await freshTerminal()).id, 'opencode');
    lines.secondStart = c.writes.slice(from);
    tab = await freshTerminal();
    offer(tab, { kind: 'opencode', sessionId: SES });
    from = at();
    assert.equal(await T.getState().resumeAgent(tab.id), true, 'an exact record');
    lines.exact = c.writes.slice(from);
    tab = await freshTerminal();
    offer(tab, { kind: 'opencode', sessionId: null, title: 'Alpha' });
    from = at();
    assert.equal(await T.getState().resumeAgent(tab.id, { sessionId: SES_B, title: 'Bravo' }), true, 'a banner pick');
    lines.pick = c.writes.slice(from);
    tab = await freshTerminal();
    offer(tab, { kind: 'opencode', sessionId: null, title: 'Alpha' });
    from = at();
    assert.equal(await T.getState().resumeAgent(tab.id), true, 'alone, with no list');
    lines.alone = c.writes.slice(from);
    // From the agent history: a new terminal in the entry's folder.
    await freshTerminal();
    const { key } = await mockBridge.invoke('agent_history_upsert', {
      entry: { kind: 'opencode', sessionId: SES, cwd: '/workspace/src', title: 'Fix the build', startedAt: 1000, lastUsedAt: 2000, endedAt: 2000, endReason: 'closed' },
    });
    const before = T.getState().tabs.length;
    from = at();
    const pending = T.getState().resumeFromHistory(key);
    for (let i = 0; i < 200 && T.getState().tabs.length === before; i += 1) await sleep(5);
    await sleep(20);
    await prompt(tabById(T.getState().activeTabId));
    const result = await pending;
    assert.equal(result.outcome, 'opened', JSON.stringify(result));
    lines.history = c.writes.slice(from);
    tab = await freshTerminal();
    from = at();
    const claude = await T.getState().startAgent(tab.id, 'claude');
    lines.claudeStart = c.writes.slice(from);
    assert.deepEqual(lines.claudeStart, [`claude --session-id ${claude.sessionId}\r`]);
    tab = await freshTerminal();
    offer(tab, { kind: 'claude', sessionId: UUID });
    from = at();
    await T.getState().resumeAgent(tab.id);
    lines.claudeResume = c.writes.slice(from);
  });
  return { lines, probes: calls.probes };
}

/**
 * A start or resume (`how`) of an opencode line whose probe is held until
 * `drive(tab, gap)` lets it answer (`gap.release()`); `gap.until(what)`
 * waits for an entry of `gap.order`. The prompt wait is short, so a terminal
 * still asking for a password gives up soon. What happened: `order` (each
 * check of the typing guard, unmerged), `checks`, `writes`, the terminal's
 * `notes`, the `launches` noted, the `result` and the `tab` after it.
 */
async function heldProbe(how, drive, { prompted = true } = {}) {
  const original = mockBridge.invoke;
  const savedVersion = mockBridge.opencodeVersion;
  const run = { order: [], checks: 0, writes: [], notes: [], launches: [], result: undefined, tab: null };
  let release = null;
  resetOpencodeLaunch({ timeoutMs: 5000 });
  S.getState().setSetting('terminalOpencodeMini', true);
  mockBridge.opencodeVersion = '1.18.34';
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      run.order.push('typed');
      run.writes.push(args?.data);
      return null;
    }
    if (command === 'opencode_version') {
      run.order.push('probe asked');
      await new Promise((resolve) => {
        release = resolve;
      });
      run.order.push('probe answered');
    }
    return original.call(this, command, args, ...rest);
  };
  const guard = __setTypingGuardProbe(() => {
    run.checks += 1;
    run.order.push('prompt checked');
  });
  const unsink = setTerminalNoticeSink((tabId, message) => {
    run.notes.push(message);
    return true;
  });
  const observer = setAgentLaunchObserver((tabId) => run.launches.push(tabId));
  const wait = __setAgentPromptWaitMs(600);
  const gap = {
    order: run.order,
    release: () => release(),
    async until(what) {
      for (let i = 0; i < 200 && !run.order.includes(what); i += 1) await sleep(5);
      assert.ok(run.order.includes(what), `setup: no ${what} in ${JSON.stringify(run.order)}`);
    },
  };
  try {
    const tab = await freshTerminal({ prompted });
    if (how === 'resume') offer(tab, { kind: 'opencode', sessionId: SES });
    const done = how === 'start' ? T.getState().startAgent(tab.id, 'opencode') : T.getState().resumeAgent(tab.id);
    await drive(tabById(tab.id), gap);
    run.result = await done;
    await sleep(10);
    run.tab = tabById(tab.id);
  } finally {
    __setAgentPromptWaitMs(wait);
    setAgentLaunchObserver(observer);
    unsink();
    __setTypingGuardProbe(guard);
    mockBridge.invoke = original;
    mockBridge.opencodeVersion = savedVersion;
    resetOpencodeLaunch();
    T.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
  }
  return run;
}

describe('Mini mode: what the store types (AC8)', () => {
  test('OML-05: setting on and opencode 1.18.34: every opencode start and resume in mini mode; claude as before; one probe', async () => {
    const { lines, probes } = await everyLine({ version: '1.18.34' });
    assert.deepEqual(lines.start, ['opencode --mini --no-replay\r']);
    assert.deepEqual(lines.secondStart, ['opencode --mini --no-replay\r']);
    assert.deepEqual(lines.exact, [`opencode --mini --no-replay -s ${SES}\r`]);
    assert.deepEqual(lines.pick, [`opencode --mini --no-replay -s ${SES_B}\r`]);
    assert.deepEqual(lines.alone, ['opencode --mini --no-replay --continue\r']);
    assert.deepEqual(lines.history, [`opencode --mini --no-replay -s ${SES}\r`]);
    assert.deepEqual(lines.claudeResume, [`claude --resume ${UUID}\r`]);
    assert.equal(probes, 1, 'probed once for the app run');
  });

  test('OML-06: the setting off, or an opencode without mini mode, or a probe that fails: exactly the v0.31.0 lines', async () => {
    const cases = [
      { setting: false, version: '1.18.34', probes: 0 },
      { version: '1.17.9', probes: 1 },
      { version: '2.3.2', probes: 1 },
      { version: new Error('opencode --version failed: exit code 1'), probes: 1 },
      { version: 'hang', probes: 1 },
      { version: undefined, probes: 1 },
    ];
    for (const c of cases) {
      const { lines, probes } = await everyLine(c);
      const what = `${c.setting === false ? 'setting off' : String(c.version)}`;
      assert.deepEqual(lines.start, ['opencode\r'], what);
      assert.deepEqual(lines.secondStart, ['opencode\r'], what);
      assert.deepEqual(lines.exact, [`opencode -s ${SES}\r`], what);
      assert.deepEqual(lines.pick, [`opencode -s ${SES_B}\r`], what);
      assert.deepEqual(lines.alone, ['opencode --continue\r'], what);
      assert.deepEqual(lines.history, [`opencode -s ${SES}\r`], what);
      assert.deepEqual(lines.claudeResume, [`claude --resume ${UUID}\r`], what);
      assert.equal(probes, c.probes, `${what}: probes (a failure is not asked again within the minute)`);
    }
    T.getState().dispose();
    localStorage.removeItem(PERSIST_KEY);
  });

  test('OML-09: the probe runs while NexTerm waits for the prompt and is awaited after it, then the prompt is checked again; claude never waits for it', async () => {
    const original = mockBridge.invoke;
    const savedVersion = mockBridge.opencodeVersion;
    const order = [];
    let release = null;
    const writes = [];
    resetOpencodeLaunch({ timeoutMs: 5000 });
    S.getState().setSetting('terminalOpencodeMini', true);
    mockBridge.opencodeVersion = '1.18.34';
    mockBridge.invoke = async function (command, args, ...rest) {
      if (command === 'pty_write') {
        order.push('typed');
        writes.push(args?.data);
        return null;
      }
      if (command === 'opencode_version') {
        order.push('probe asked');
        // Held until the test lets it answer, as a slow opencode would.
        await new Promise((resolve) => {
          release = resolve;
        });
        order.push('probe answered');
      }
      return original.call(this, command, args, ...rest);
    };
    const guard = __setTypingGuardProbe(() => {
      if (order.at(-1) !== 'prompt checked') order.push('prompt checked');
    });
    try {
      for (const how of ['start', 'resume']) {
        order.length = 0;
        writes.length = 0;
        resetOpencodeLaunch({ timeoutMs: 5000 });
        const tab = await freshTerminal();
        if (how === 'resume') offer(tab, { kind: 'opencode', sessionId: SES });
        const done = how === 'start' ? T.getState().startAgent(tab.id, 'opencode') : T.getState().resumeAgent(tab.id);
        for (let i = 0; i < 100 && !order.includes('prompt checked'); i += 1) await sleep(5);
        await sleep(20);
        assert.deepEqual(order, ['probe asked', 'prompt checked'], `${how}: the prompt is checked while the probe is out`);
        assert.deepEqual(writes, [], `${how}: nothing typed before the probe answered`);
        release();
        await done;
        // The probe answered after the check: the terminal is checked again before typing (Y-01).
        assert.deepEqual(order, ['probe asked', 'prompt checked', 'probe answered', 'prompt checked', 'typed'], how);
        assert.deepEqual(writes, [how === 'start' ? 'opencode --mini --no-replay\r' : `opencode --mini --no-replay -s ${SES}\r`], how);
      }
      // Claude Code: typed at the prompt, no probe asked, nothing waited for.
      order.length = 0;
      writes.length = 0;
      const tab = await freshTerminal();
      const claude = await T.getState().startAgent(tab.id, 'claude');
      assert.deepEqual(writes, [`claude --session-id ${claude.sessionId}\r`]);
      assert.ok(!order.includes('probe asked'), JSON.stringify(order));
    } finally {
      __setTypingGuardProbe(guard);
      mockBridge.invoke = original;
      mockBridge.opencodeVersion = savedVersion;
      resetOpencodeLaunch();
      T.getState().dispose();
      localStorage.removeItem(PERSIST_KEY);
    }
  });

  test('OML-10 (Y-01): a password prompt that comes up after the check and before a late probe answers: nothing typed, the note shown', async () => {
    for (const how of ['start', 'resume']) {
      for (const via of ['backend', 'events']) {
        const what = `${how}, told by the ${via}`;
        const run = await heldProbe(how, async (tab, gap) => {
          await gap.until('prompt checked');
          // `sudo` from a hook, a `read -s`: the terminal hides typing now.
          if (via === 'backend') mockBridge.ptySessions.get(tab.sessionId).secret = true;
          else await mockBridge.emit('pty-echo', { session_id: tab.sessionId, secret: true });
          gap.release();
        });
        assert.deepEqual(run.writes, [], `${what}: typed into the password prompt`);
        assert.equal(run.result, how === 'start' ? null : false, what);
        const answered = run.order.indexOf('probe answered');
        assert.ok(answered > 0 && run.order[answered + 1] === 'prompt checked', `${what}: ${JSON.stringify(run.order)}`);
        assert.ok(!run.order.includes('typed'), what);
        assert.equal(run.notes.length, 1, `${what}: ${JSON.stringify(run.notes)}`);
        const note = how === 'start' ? `${agentLabel('opencode')} not started — this terminal was asking for a password` : 'Not resumed — this terminal is asking for a password';
        assert.ok(run.notes[0].startsWith(note), `${what}: ${run.notes[0]}`);
        assert.deepEqual(run.launches, [], `${what}: no launch noted`);
        assert.ok(!run.tab.agentTyped, `${what}: no agent watched`);
        if (how === 'start') assert.equal(run.tab.agent ?? null, null, `${what}: no agent recorded`);
        else assert.equal(run.tab.agentResumeOffered, true, `${what}: the offer is back`);
      }
    }
  });

  test('OML-11 (Y-01): the shell gone after the check and before a late probe answers: nothing typed, no agent recorded; a resume stops when the terminal holds another agent', async () => {
    const gaps = {
      exited: async (tab) => {
        await mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: 0 });
      },
      restarted: async (tab) => {
        await mockBridge.emit('pty-exit', { session_id: tab.sessionId, exit_code: 0 });
        assert.equal(await T.getState().restartShell(tab.id), true, 'setup: restarted');
        assert.notEqual(tabById(tab.id).sessionId, tab.sessionId, 'setup: a new shell');
      },
    };
    for (const how of ['start', 'resume']) {
      for (const [name, inGap] of Object.entries(gaps)) {
        const what = `${how}, the shell ${name}`;
        const run = await heldProbe(how, async (tab, gap) => {
          await gap.until('prompt checked');
          await inGap(tab);
          gap.release();
        });
        assert.deepEqual(run.writes, [], `${what}: typed`);
        assert.equal(run.result, how === 'start' ? null : false, what);
        assert.deepEqual(run.launches, [], `${what}: a launch noted on a gone shell`);
        assert.ok(!run.tab.agentTyped, `${what}: an agent watched on a gone shell`);
        if (how === 'start') assert.equal(run.tab.agent ?? null, null, `${what}: an agent recorded on a gone shell`);
      }
    }
    // Resume: an agent typed by hand in the gap holds the terminal now.
    const other = { kind: 'opencode', sessionId: SES_B, startedAt: 2, title: null };
    const run = await heldProbe('resume', async (tab, gap) => {
      await gap.until('prompt checked');
      T.setState((state) => ({ tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, agent: other } : t)) }));
      gap.release();
    });
    assert.deepEqual(run.writes, [], 'typed over another agent');
    assert.equal(run.result, false);
    assert.deepEqual(run.launches, []);
    assert.equal(run.tab.agent, other, 'the other agent kept');
  });

  test('OML-12 (Y-01): a probe that answers before the check: one check only, then typed', async () => {
    for (const how of ['start', 'resume']) {
      const run = await heldProbe(
        how,
        async (tab, gap) => {
          // Answered while the shell has not drawn its first prompt yet.
          await gap.until('probe asked');
          gap.release();
          await gap.until('probe answered');
          await sleep(10);
          assert.ok(!gap.order.includes('prompt checked'), `${how}: checked before the prompt`);
          await prompt(tabById(tab.id));
        },
        { prompted: false }
      );
      assert.deepEqual(run.order, ['probe asked', 'probe answered', 'prompt checked', 'typed'], how);
      assert.equal(run.checks, 1, `${how}: one check`);
      assert.deepEqual(run.writes, [how === 'start' ? 'opencode --mini --no-replay\r' : `opencode --mini --no-replay -s ${SES}\r`], how);
      assert.equal(run.launches.length, 1, how);
      assert.ok(run.tab.agentTyped, `${how}: watched`);
    }
  });

  test('OML-07: only the import block, `startAgent` and `resumeAgent` of terminalStore.js know of it', () => {
    const store = read('../../src/stores/terminalStore.js');
    const uses = [...store.matchAll(/opencodeLaunchLine/g)].map((m) => m.index);
    assert.equal(uses.length, 3, 'the import and two calls');
    const start = store.indexOf('    startAgent: async (tabId, kind) => {');
    const resume = store.indexOf('    resumeAgent: async (tabId, choice = null) => {');
    const after = store.indexOf('    agentHistoryNotice: null,');
    assert.ok(uses[0] < start && uses[1] > start && uses[1] < resume && uses[2] > resume && uses[2] < after);
  });
});

describe('Mini mode: the setting (AC10)', () => {
  test('OML-08: `terminalOpencodeMini` is on by default, saved when turned off and read back; the row sits by Claude Code\'s', async () => {
    assert.equal(S.getState().settingsDefaults.terminalOpencodeMini, true);
    const backing = new Map();
    const borrowed = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
      clear: () => backing.clear(),
    };
    try {
      const launch = () => import(`../../src/stores/settingsStore.js?opencode-mini=${Math.random()}`);
      const first = await launch();
      assert.equal(first.useSettingsStore.getState().terminalOpencodeMini, true);
      first.useSettingsStore.getState().setSetting('terminalOpencodeMini', false);
      assert.equal(JSON.parse(backing.get('nexterm.settings')).data.terminalOpencodeMini, false, 'saved');
      const second = await launch();
      assert.equal(second.useSettingsStore.getState().terminalOpencodeMini, false, 'read back');
      second.useSettingsStore.getState().setSetting('terminalOpencodeMini', true);
      assert.equal('terminalOpencodeMini' in JSON.parse(backing.get('nexterm.settings')).data, false, 'the default is not stored');
    } finally {
      globalThis.localStorage = borrowed;
    }
    const window = read('../../src/components/common/SettingsWindow.jsx');
    const row = window.slice(window.indexOf("id: 'terminalOpencodeMini',"));
    const body = row.slice(0, row.indexOf('},'));
    assert.match(body, /section: 'terminal',\s*key: 'terminalOpencodeMini',\s*settingKey: 'terminal\.integrated\.opencodeMiniMode',\s*title: 'OpenCode in Mini Mode',/);
    assert.match(body, /`opencode --mini --no-replay`/);
    assert.match(body, /V1 1\.17\.10 or newer/);
    assert.match(body, /full TUI/);
    assert.match(body, /control: 'checkbox',/);
    const claudeRow = window.indexOf("id: 'terminalClaudeNormalScreen',");
    const next = window.indexOf("id: '", claudeRow + 10);
    assert.equal(next, window.indexOf("id: 'terminalOpencodeMini',"), 'right after Claude Code on the Normal Screen');
    assert.match(window, /const terminalOpencodeMini = useSettingsStore\(\(s\) => s\.terminalOpencodeMini\);/);
  });
});
