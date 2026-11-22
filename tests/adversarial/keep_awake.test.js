/**
 * Keep the computer awake while an agent works (bundle 1, A4; F12, AC13):
 * src/lib/keepAwake.js deciding when the backend is told
 * `power_set_keep_awake`, and the browser mock's two power commands.
 *
 * The rule (`keepAwakeWanted`) is checked on hand-made tabs; the page logic
 * (`startKeepAwake`) on the real terminal and settings stores, driven through
 * `mockBridge.emit` as agent_activity.test.js drives them — Claude Code's own
 * titles, the command end, pty-exit, closing — with a fake `invoke` that
 * records every power call. The store's agent clocks are injected, so an
 * idle title settles when a case says so.
 *
 * Writes to the terminals are held. KA-99 puts the clocks, the attention
 * source, the settings, the store and the mock back (afterEach runs only
 * when a case passes, so the teardown is a case of its own, last).
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { AGENT_IDLE_SETTLE_MS } from '../../src/lib/agentActivity.js';
import { terminalStatus } from '../../src/lib/terminalStatus.js';
import {
  KEEP_AWAKE_SETTING,
  agentWorks,
  askKeepAwakeSupport,
  keepAwakeDescription,
  keepAwakeWanted,
  startKeepAwake,
  supportFrom,
} from '../../src/lib/keepAwake.js';

const T = terminalStore.useTerminalStore;
const S = useSettingsStore;
const { __setAgentActivityClocks, __setAttentionSource } = terminalStore;
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const IDLE = '✳';
const SPIN = ['◐', '◑', '◒', '◓'];

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
const show = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });

/** Clocks for the store's agent state: a settle timer fires only when `advance` passes it. */
function fakeClocks() {
  let mono = 1_000;
  let wall = 1_700_000_000_000;
  const timers = [];
  return {
    now: () => mono,
    wall: () => wall,
    schedule: (fn, ms) => {
      const timer = { at: mono + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms) {
      const end = mono + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        wall += due.at - mono;
        mono = due.at;
        due.live = false;
        due.fn();
      }
      wall += end - mono;
      mono = end;
    },
  };
}

/**
 * A fake `invoke` for `startKeepAwake`: answers support with `support` (an
 * object, or an Error to reject with) and `power_set_keep_awake` with `held`
 * (a function of `on`, or an Error). `power` lists the booleans it was
 * asked, `supportAsked` how often support was.
 */
function fakeInvoke({ support = { supported: true, method: 'caffeinate' }, held = (on) => on } = {}) {
  const record = { power: [], supportAsked: 0, other: [] };
  record.invoke = async (command, args) => {
    if (command === 'power_keep_awake_support') {
      record.supportAsked += 1;
      if (support instanceof Error) throw support;
      return support;
    }
    if (command === 'power_set_keep_awake') {
      record.power.push(args?.on);
      if (held instanceof Error) throw held;
      return held(args?.on);
    }
    record.other.push(command);
    return null;
  };
  return record;
}

/** Let the stores' events and the keep-awake queue settle. */
async function settle(stop) {
  for (let i = 0; i < 3; i += 1) {
    await stop.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let saved = null;
let clocks = null;

/**
 * `fn` with fresh clocks, a started store, writes held, the setting as
 * `setting`, keep-awake started on the real stores with a fake invoke, and two
 * terminals: `claude` running Claude Code (or `agent`) and `other`, active.
 * `fn` runs once the start-up steps have settled, or at once with
 * `settleStart: false`. The keep-awake is stopped, the setting restored and
 * the terminals closed whatever happens.
 */
async function withKeepAwake(fn, { agent = 'claude', setting = true, fake = fakeInvoke(), settleStart = true } = {}) {
  if (!saved) {
    saved = {
      clocks: __setAgentActivityClocks({}),
      source: __setAttentionSource(() => ({ focused: true, visible: true })),
      mock: { method: mockBridge.keepAwakeMethod, calls: mockBridge.keepAwakeCalls.length, held: mockBridge.keepAwakeHeld },
    };
  }
  clocks = fakeClocks();
  __setAgentActivityClocks(clocks);
  __setAttentionSource(() => ({ focused: true, visible: true }));
  const unsink = setTerminalNoticeSink(() => true);
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') return null;
    return original.call(this, command, args, ...rest);
  };
  const mockCallsBefore = mockBridge.keepAwakeCalls.length;
  let stop = null;
  try {
    S.setState({ [KEEP_AWAKE_SETTING]: setting });
    await T.getState().init();
    const a = await T.getState().createTab({ cwd: '/workspace' });
    await prompt(tabById(a.id));
    const b = await T.getState().createTab({ cwd: '/workspace' });
    await prompt(tabById(b.id));
    if (agent === 'claude' || agent === 'opencode') await T.getState().startAgent(a.id, agent);
    T.setState({ activeTabId: b.id, notifications: [] });
    stop = startKeepAwake({ store: T, settings: S, invoke: fake.invoke });
    if (settleStart) await settle(stop);
    await fn({ claude: tabById(a.id), other: tabById(b.id), fake, stop, settle: () => settle(stop) });
    // The page logic went through the invoke it was given, never the mock.
    assert.equal(mockBridge.keepAwakeCalls.length, mockCallsBefore, 'a power call reached the browser mock');
  } finally {
    stop?.();
    if (stop) await settle(stop);
    mockBridge.invoke = original;
    unsink();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ notifications: [] });
    S.setState({ [KEEP_AWAKE_SETTING]: SETTINGS_DEFAULTS[KEEP_AWAKE_SETTING] });
  }
}

/** A Claude Code turn starting: its working title, `frames` of them. */
async function working(tab, frames = 1) {
  for (let i = 0; i < frames; i += 1) await show(tab, `${SPIN[i % SPIN.length]} Claude Code`);
}

/** Claude Code's idle title, and its settle time passing. */
async function idle(tab) {
  await show(tab, `${IDLE} Claude Code`);
  clocks.advance(AGENT_IDLE_SETTLE_MS * 2);
}

const stateOf = (tab) => T.getState().agentActivity[tab.id]?.state ?? null;

// ---- The rule -----------------------------------------------------------------

/** A tab Claude Code is believed to run in (`agentRuns`), by hand. */
const claudeTab = (over = {}) => ({
  id: 't1',
  sessionId: 'pty-1',
  exited: false,
  agent: { kind: 'claude', sessionId: 'c-1' },
  agentResumeOffered: false,
  agentTyped: { sessionId: 'pty-1' },
  ...over,
});
const ON = Object.freeze({ [KEEP_AWAKE_SETTING]: true });
const WORKING = Object.freeze({ t1: Object.freeze({ state: 'working', since: 1 }) });

describe('Keep-awake: the rule (F12)', () => {
  test('KA-01: off by default — the setting is false, and off wants nothing whatever the terminals do', () => {
    assert.equal(SETTINGS_DEFAULTS[KEEP_AWAKE_SETTING], false, 'on by default');
    assert.equal(KEEP_AWAKE_SETTING, 'terminalKeepAwakeWhileAgentsWork');
    const state = { tabs: [claudeTab()], agentActivity: WORKING };
    assert.equal(keepAwakeWanted(state, ON), true, 'premise: a Working Claude Code terminal is wanted when on');
    assert.equal(keepAwakeWanted(state, SETTINGS_DEFAULTS), false);
    assert.equal(keepAwakeWanted(state, { [KEEP_AWAKE_SETTING]: false }), false);
    assert.equal(keepAwakeWanted(state, { [KEEP_AWAKE_SETTING]: 'true' }), false, 'only true turns it on');
    assert.equal(keepAwakeWanted(state, {}), false);
    assert.equal(keepAwakeWanted(state, null), false);
  });

  test('KA-02: Working is Claude Code believed to run in this shell whose activity says working — nothing else', () => {
    const wanted = (tab, activity = WORKING, extra = {}) => keepAwakeWanted({ tabs: [tab], agentActivity: activity, ...extra }, ON);
    assert.equal(wanted(claudeTab()), true);
    // Idle, unknown, or another tab's entry.
    assert.equal(wanted(claudeTab(), { t1: { state: 'idle', since: 1 } }), false, 'idle');
    assert.equal(wanted(claudeTab(), {}), false, 'no activity entry');
    assert.equal(wanted(claudeTab(), { t2: { state: 'working', since: 1 } }), false, "another tab's entry");
    // Not believed to run (agentRuns): offered back, exited, typed into another shell or at no prompt, no agent.
    assert.equal(wanted(claudeTab({ agentResumeOffered: true })), false, 'offered for Resume');
    assert.equal(wanted(claudeTab({ exited: true })), false, 'the shell exited');
    assert.equal(wanted(claudeTab({ agentTyped: { sessionId: 'pty-0' } })), false, 'typed into the shell before a restart');
    assert.equal(wanted(claudeTab({ agentTyped: null })), false, 'typed with no prompt to go by');
    assert.equal(wanted(claudeTab({ agent: null })), false, 'the agent ended');
    // OpenCode never counts, even with an entry that says working.
    assert.equal(wanted(claudeTab({ agent: { kind: 'opencode', sessionId: 'o-1' } })), false, 'OpenCode');
    // A plain shell with a busy bar is Working on the side bar, never here.
    const shell = claudeTab({ agent: null, agentTyped: null, running: true });
    const bar = { t1: { state: 'indeterminate', value: 0 } };
    assert.equal(terminalStatus(shell, { progress: bar.t1 }).word, 'Working', 'premise: the side bar calls it Working');
    assert.equal(wanted(shell, {}, { progress: bar }), false, 'an indeterminate bar');
    assert.equal(wanted(shell, WORKING, { progress: bar }), false, 'an indeterminate bar with a stray entry');
    // Any one of several is enough; none is none.
    const two = { tabs: [claudeTab({ id: 't0' }), claudeTab()], agentActivity: WORKING };
    assert.equal(keepAwakeWanted(two, ON), true);
    assert.equal(keepAwakeWanted({ tabs: [], agentActivity: WORKING }, ON), false);
    assert.equal(keepAwakeWanted({ tabs: null }, ON), false);
    assert.equal(keepAwakeWanted(null, ON), false);
    assert.equal(agentWorks(null, WORKING), false);
    assert.equal(agentWorks(claudeTab(), null), false);
  });

  test('KA-03: support is held to its shape; a failure or a junk answer is unsupported, and asking never rejects', async () => {
    assert.deepEqual(supportFrom({ supported: true, method: 'caffeinate' }), { supported: true, method: 'caffeinate' });
    assert.deepEqual(supportFrom({ supported: false, method: 'none' }), { supported: false, method: 'none' });
    assert.deepEqual(supportFrom({ supported: 'yes', method: 'caffeinate' }), { supported: false, method: 'caffeinate' });
    assert.deepEqual(supportFrom(null), { supported: false, method: 'none' });
    assert.deepEqual(supportFrom('true'), { supported: false, method: 'none' });
    assert.deepEqual(await askKeepAwakeSupport(async () => { throw new Error('Unknown IPC command'); }), { supported: false, method: 'none' });
    assert.deepEqual(await askKeepAwakeSupport(() => { throw new Error('sync'); }), { supported: false, method: 'none' });
    const asked = [];
    assert.deepEqual(
      await askKeepAwakeSupport(async (cmd, args) => { asked.push([cmd, args]); return { supported: true, method: 'SetThreadExecutionState' }; }),
      { supported: true, method: 'SetThreadExecutionState' }
    );
    assert.deepEqual(asked, [['power_keep_awake_support', undefined]]);
  });

  test("KA-04: the Settings row's words — the display may still sleep; unsupported says not available on this system", () => {
    for (const known of [null, { supported: true, method: 'caffeinate' }]) {
      const words = keepAwakeDescription(known);
      assert.match(words, /The display may still turn off/);
      assert.match(words, /OpenCode terminals and progress bars do not count/);
      assert.doesNotMatch(words, /not available/i);
    }
    assert.match(keepAwakeDescription({ supported: false, method: 'none' }), /The display may still turn off[\s\S]*Not available on this system\.$/);
  });
});

// ---- The page logic on the real stores -------------------------------------------

/**
 * Where supported, the first call is always the start-up "off" (A-R2): it
 * lets go of a hold a reloaded page left in the backend, and it is not a
 * hold. Every list of calls below starts with it; where unsupported (KA-17)
 * nothing at all is told.
 */
const START = false;

describe('Keep-awake: when the backend is told (F12, AC13)', () => {
  test('KA-10: off by default — a Claude Code terminal working never calls power_set_keep_awake(true); nor does turning it off', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, settle }) => {
      assert.equal(S.getState()[KEEP_AWAKE_SETTING], false, 'premise: the default');
      await working(claude, 3);
      await settle();
      assert.equal(stateOf(claude), 'working', 'premise: the store calls it working');
      await idle(claude);
      await working(claude);
      await settle();
    }, { setting: SETTINGS_DEFAULTS[KEEP_AWAKE_SETTING], fake });
    assert.deepEqual(fake.power, [START], 'the backend was told something with the setting off, besides the start-up off');
    assert.ok(!fake.power.includes(true), 'held with the setting off');
    assert.equal(fake.supportAsked, 1, 'support asked more than once, or not at start');
  });

  test('KA-11: on, a Claude Code terminal Working — exactly one call with true, however many frames and terminals; idle — exactly one false', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, other, settle }) => {
      assert.deepEqual(fake.power, [START], 'premise: nothing but the start-up off before the agent works');
      await working(claude, 5);
      await settle();
      assert.equal(stateOf(claude), 'working');
      assert.deepEqual(fake.power, [START, true], 'working');
      // A second Claude Code terminal working adds nothing.
      await T.getState().startAgent(other.id, 'claude');
      await working(tabById(other.id), 3);
      await settle();
      assert.equal(stateOf(other), 'working', 'premise: the second works too');
      assert.deepEqual(fake.power, [START, true], 'a second terminal working called again');
      // One goes idle: the other still works.
      await idle(claude);
      await settle();
      assert.equal(stateOf(claude), 'idle');
      assert.deepEqual(fake.power, [START, true], 'let go while another still works');
      await idle(tabById(other.id));
      await settle();
      assert.deepEqual(fake.power, [START, true, false], 'both idle');
      // An idle title between frames that has not settled is not idle.
      await working(claude);
      await show(claude, `${IDLE} Claude Code`);
      await working(claude);
      await settle();
      assert.deepEqual(fake.power, [START, true, false, true], 'a new turn');
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false, true, false], 'stopping lets go once');
    assert.equal(fake.supportAsked, 1, 'support asked more than once');
  });

  test('KA-12: the agent ends at its command end (D while running) — exactly one false', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, settle }) => {
      await started(claude);
      await working(claude, 2);
      await settle();
      assert.deepEqual(fake.power, [START, true]);
      await prompt(claude, 0);
      await settle();
      assert.equal(tabById(claude.id).agent, null, 'premise: the agent ended');
      assert.deepEqual(fake.power, [START, true, false]);
      await prompt(tabById(claude.id), 0);
      await settle();
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false], 'told again after the end');
  });

  test('KA-13: the shell exits (pty-exit) — exactly one false, and the late titles of a dead shell hold nothing', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, settle }) => {
      await working(claude);
      await settle();
      await mockBridge.emit('pty-exit', { session_id: claude.sessionId, exit_code: 0 });
      await settle();
      assert.ok(tabById(claude.id).exited, 'premise: exited');
      assert.deepEqual(fake.power, [START, true, false]);
      await working(tabById(claude.id), 2);
      await settle();
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false]);
  });

  test('KA-14: the terminal is closed — exactly one false', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, settle }) => {
      await working(claude);
      await settle();
      await T.getState().closeTab(claude.id);
      await settle();
      assert.equal(tabById(claude.id), undefined, 'premise: closed');
      assert.deepEqual(fake.power, [START, true, false]);
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false]);
  });

  test('KA-15: the setting turned off while it works — exactly one false; on again — one true', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, settle }) => {
      await working(claude);
      await settle();
      S.setState({ [KEEP_AWAKE_SETTING]: false });
      await settle();
      assert.deepEqual(fake.power, [START, true, false], 'off');
      await working(claude, 2);
      await settle();
      assert.deepEqual(fake.power, [START, true, false], 'frames while off');
      S.setState({ [KEEP_AWAKE_SETTING]: true });
      await settle();
      assert.deepEqual(fake.power, [START, true, false, true], 'on again while it works');
      // Unrelated settings and store changes call nothing.
      S.setState({ terminalProgress: !S.getState().terminalProgress });
      S.setState({ terminalProgress: SETTINGS_DEFAULTS.terminalProgress });
      T.setState({ notifications: [] });
      await settle();
      assert.deepEqual(fake.power, [START, true, false, true]);
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false, true, false]);
  });

  test('KA-16: an OpenCode terminal, and a plain shell with an indeterminate bar, never count', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, other, settle }) => {
      assert.equal(tabById(claude.id).agent?.kind, 'opencode', 'premise: OpenCode runs');
      await working(claude, 3);
      // Even an entry that says working, put there by hand.
      T.setState((s) => ({ agentActivity: { ...s.agentActivity, [claude.id]: Object.freeze({ state: 'working', since: 1 }) } }));
      // A busy bar on the plain shell: the side bar's Working.
      T.setState((s) => ({ progress: { ...s.progress, [other.id]: { state: 'indeterminate', value: 0 } } }));
      await settle();
      assert.equal(terminalStatus(tabById(other.id), { progress: T.getState().progress[other.id] }).word, 'Working', 'premise: a Working bar');
      assert.deepEqual(fake.power, [START], 'OpenCode or a bar held the computer awake');
    }, { agent: 'opencode', fake });
    assert.deepEqual(fake.power, [START]);
    assert.equal(fake.supportAsked, 1);
  });

  test('KA-17: where unsupported, the backend is never told anything — not even the start-up off — and support is asked once', async () => {
    for (const support of [{ supported: false, method: 'none' }, new Error('Unknown IPC command: power_keep_awake_support')]) {
      const fake = fakeInvoke({ support });
      await withKeepAwake(async ({ claude, settle }) => {
        await working(claude);
        await settle();
        await idle(claude);
        await working(claude);
        await settle();
      }, { fake });
      assert.deepEqual(fake.power, [], `told something where unsupported (${support.message ?? 'supported: false'})`);
      assert.equal(fake.supportAsked, 1, 'support asked again');
    }
  });

  test('KA-18: a hold that answers false or fails is not held — never asked again while it works, nothing to let go', async () => {
    const quiet = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args);
    try {
      for (const held of [() => false, new Error('the helper would not start')]) {
        const fake = fakeInvoke({ held });
        await withKeepAwake(async ({ claude, settle }) => {
          await working(claude, 4);
          await settle();
          assert.deepEqual(fake.power, [START, true]);
          T.setState({ notifications: [] });
          await working(claude, 2);
          await settle();
          assert.deepEqual(fake.power, [START, true], 'asked again in a loop');
          await idle(claude);
          await settle();
          assert.deepEqual(fake.power, [START, true], 'let go of what was not held');
          // The next turn is a change: asked once more.
          await working(claude);
          await settle();
          assert.deepEqual(fake.power, [START, true, true]);
        }, { fake });
        assert.deepEqual(fake.power, [START, true, true], 'stopping let go of what was not held');
      }
      // The failing backend also refused the start-up off: said once, and the
      // holds after it were still asked.
      assert.deepEqual(
        warned.map((args) => args[0]),
        [
          '[keep-awake] could not let the computer sleep again:',
          '[keep-awake] could not keep the computer awake:',
          '[keep-awake] could not keep the computer awake:',
        ],
        'the failed holds are reported, once each'
      );
    } finally {
      console.warn = quiet;
    }
  });

  test('KA-19: stopping while held sends one false; after it, nothing calls; a change while support is asked is kept in order', async () => {
    const fake = fakeInvoke();
    await withKeepAwake(async ({ claude, stop, settle }) => {
      await working(claude);
      await settle();
      assert.deepEqual(fake.power, [START, true]);
      stop();
      stop();
      await settle();
      assert.deepEqual(fake.power, [START, true, false], 'stop');
      await idle(claude);
      await working(claude);
      S.setState({ [KEEP_AWAKE_SETTING]: false });
      S.setState({ [KEEP_AWAKE_SETTING]: true });
      await settle();
      assert.deepEqual(fake.power, [START, true, false], 'called after stop');
    }, { fake });
    assert.deepEqual(fake.power, [START, true, false]);

    // On, off and on again before the support answer comes — support is
    // asked at start, so the changes come while it is out: told in order,
    // the start-up off first.
    let answer;
    const slow = fakeInvoke();
    const invoke = async (command, args) => {
      if (command === 'power_keep_awake_support') {
        await new Promise((resolve) => { answer = resolve; });
      }
      return slow.invoke(command, args);
    };
    await withKeepAwake(async ({ claude, settle }) => {
      await working(claude);
      S.setState({ [KEEP_AWAKE_SETTING]: false });
      S.setState({ [KEEP_AWAKE_SETTING]: true });
      assert.equal(typeof answer, 'function', 'premise: support is still being asked');
      assert.deepEqual(slow.power, [], 'told before the support answer');
      answer();
      await settle();
      assert.deepEqual(slow.power, [START, true], 'the change while asking');
      // Off while asking: nothing held, nothing to let go.
    }, { fake: { invoke }, settleStart: false });
    assert.deepEqual(slow.power, [START, true, false]);
    assert.equal(slow.supportAsked, 1);
  });

  test('KA-20: started by the app on the real stores, stopped on unmount; Settings reads the shared support answer', () => {
    const app = source('../../src/App.jsx');
    assert.match(app, /import \{ startKeepAwake \} from '\.\/lib\/keepAwake\.js';/);
    assert.match(
      app,
      /useEffect\(\(\) => startKeepAwake\(\{ store: useTerminalStore, settings: useSettingsStore \}\), \[\]\);/,
      'not started once, or its stop is not returned to the effect'
    );
    assert.equal((app.match(/startKeepAwake\(/g) ?? []).length, 1);
    const page = source('../../src/lib/keepAwake.js');
    // The only power calls the page makes, and only through `invoke`.
    assert.deepEqual(page.match(/'power_[a-z_]+'/g), ["'power_keep_awake_support'", "'power_set_keep_awake'", "'power_set_keep_awake'"]);
    // In the app, the page logic and the Settings row share one support question.
    assert.match(page, /support \?\?= invoke === ipcInvoke \? keepAwakeSupport\(\) : askKeepAwakeSupport\(invoke\);/);
    assert.match(page, /sharedSupport \?\?= askKeepAwakeSupport\(ipcInvoke\);/);
    // Nothing else in the page tells the backend to hold.
    const settings = source('../../src/components/common/SettingsWindow.jsx');
    assert.match(settings, /keepAwakeSupport\(\)\.then\(/);
    assert.doesNotMatch(settings, /power_set_keep_awake/);
  });

  test('KA-21: a backend a reloaded page left holding is let go of exactly once, first, at start — the setting on or off', async () => {
    // The backend as power.rs keeps it: one holder that outlives the page.
    const backend = () => {
      const state = { holding: true };
      const fake = fakeInvoke({ held: (on) => { state.holding = on; return on; } });
      return { state, fake };
    };
    for (const setting of [true, false]) {
      const { state, fake } = backend();
      await withKeepAwake(async ({ claude, settle }) => {
        assert.deepEqual(fake.power, [false], `not let go of at start (setting ${setting})`);
        assert.equal(state.holding, false, 'the hold the reload left still stands');
        assert.equal(fake.supportAsked, 1);
        await working(claude, 3);
        await settle();
        assert.deepEqual(fake.power, setting ? [false, true] : [false], 'after the start');
        await idle(claude);
        await settle();
      }, { setting, fake });
      assert.deepEqual(fake.power, setting ? [false, true, false] : [false]);
      assert.equal(fake.power.indexOf(false), 0, 'the start-up off was not the first call');
      assert.equal(state.holding, false, 'left holding');
      assert.equal(fake.supportAsked, 1, 'support asked more than once');
    }

    // Working already when it starts: let go first, then held.
    const store = (initial) => {
      let state = initial;
      const listeners = new Set();
      return {
        getState: () => state,
        setState: (next) => {
          state = { ...state, ...next };
          for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    };
    const { state, fake } = backend();
    const settings = store({ ...ON });
    const stop = startKeepAwake({ store: store({ tabs: [claudeTab()], agentActivity: WORKING }), settings, invoke: fake.invoke });
    await settle(stop);
    assert.deepEqual(fake.power, [false, true], 'held before the old hold was let go of');
    assert.equal(state.holding, true);
    settings.setState({ [KEEP_AWAKE_SETTING]: false });
    await settle(stop);
    assert.deepEqual(fake.power, [false, true, false]);
    stop();
    await settle(stop);
    assert.deepEqual(fake.power, [false, true, false], 'stopping let go twice');
    assert.equal(state.holding, false);
    assert.equal(fake.supportAsked, 1);

    // Stopped before the support answer: nothing is told after the stop.
    let answer;
    const late = fakeInvoke();
    const stopEarly = startKeepAwake({
      store: store({ tabs: [], agentActivity: {} }),
      settings: store({ ...ON }),
      invoke: async (command, args) => {
        if (command === 'power_keep_awake_support') await new Promise((resolve) => { answer = resolve; });
        return late.invoke(command, args);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopEarly();
    answer();
    await settle(stopEarly);
    assert.deepEqual(late.power, [], 'told after it was stopped');
  });
});

// ---- The browser mock -----------------------------------------------------------

describe('Keep-awake: the browser mock (F11)', () => {
  test('KA-30: the mock answers as the backend — unsupported in a browser, on twice holds once, quit lets go, `on` checked', async () => {
    const before = { method: mockBridge.keepAwakeMethod, calls: mockBridge.keepAwakeCalls.length, held: mockBridge.keepAwakeHeld, quits: mockBridge.quitRequests };
    try {
      assert.equal(before.method, 'none', 'the browser claims to hold the computer awake');
      assert.deepEqual(await mockBridge.invoke('power_keep_awake_support'), { supported: false, method: 'none' });
      assert.equal(await mockBridge.invoke('power_set_keep_awake', { on: true }), false, 'held where unsupported');
      mockBridge.keepAwakeMethod = 'caffeinate';
      assert.deepEqual(await mockBridge.invoke('power_keep_awake_support'), { supported: true, method: 'caffeinate' });
      assert.equal(await mockBridge.invoke('power_set_keep_awake', { on: true }), true);
      assert.equal(await mockBridge.invoke('power_set_keep_awake', { on: true }), true, 'on twice');
      assert.equal(mockBridge.keepAwakeHeld, true);
      assert.equal(await mockBridge.invoke('power_set_keep_awake', { on: false }), false);
      assert.equal(mockBridge.keepAwakeHeld, false);
      await mockBridge.invoke('power_set_keep_awake', { on: true });
      await mockBridge.invoke('app_quit');
      assert.equal(mockBridge.keepAwakeHeld, false, 'quit kept it held');
      assert.deepEqual(mockBridge.keepAwakeCalls.slice(before.calls), [true, true, true, false, true]);
      await assert.rejects(() => mockBridge.invoke('power_set_keep_awake', {}), /missing required key on/);
      await assert.rejects(() => mockBridge.invoke('power_set_keep_awake', { on: 'true' }), /expected a boolean/);
      assert.equal(mockBridge.keepAwakeCalls.length, before.calls + 5, 'a refused call was recorded');
      // The commands are the backend's, by name and argument.
      const rust = source('../../src-tauri/src/commands/power.rs');
      assert.match(rust, /pub fn power_set_keep_awake\(on: bool\) -> Result<bool, String>/);
      assert.match(rust, /pub fn power_keep_awake_support\(\) -> Support/);
    } finally {
      mockBridge.keepAwakeMethod = before.method;
      mockBridge.keepAwakeCalls.length = before.calls;
      mockBridge.keepAwakeHeld = before.held;
      mockBridge.quitRequests = before.quits;
    }
  });
});

describe('Keep-awake: the docs (AC21)', () => {
  test('KA-40: the README names the setting in Settings and the Coding agents table, a line per OS; V56 checks powercfg /requests', () => {
    const readme = source('../../README.md');
    const NAME = /\*Keep the Computer Awake\s+While an Agent Works\*/;
    const section = (heading) => {
      const at = readme.indexOf(`\n${heading}\n`);
      assert.ok(at >= 0, `no ${heading}`);
      const next = readme.slice(at + heading.length + 2).search(/\n#{2,3} /);
      return readme.slice(at, next < 0 ? undefined : at + heading.length + 2 + next);
    };
    const settings = section('### Settings and themes');
    assert.match(settings, NAME);
    assert.match(settings, /off by default/);
    assert.match(settings, /OpenCode terminals\s+and progress bars do not count/);
    assert.match(settings, /The display may still turn off and lock/);
    assert.match(settings, /\*Not available on this system\*/);
    assert.match(section('### Coding agents'), /\| keep the computer from sleeping while Claude Code works \| Settings ▸ Terminal ▸ \*Keep the Computer Awake While an Agent Works\*/);
    assert.match(section('### macOS'), /\*Keep the Computer Awake While an Agent Works\* runs `caffeinate -i`[\s\S]*`pmset -g assertions`/);
    assert.match(section('### Windows'), /\*Keep the Computer Awake While an Agent Works\* asks Windows itself[\s\S]*`SetThreadExecutionState`[\s\S]*`powercfg \/requests`/);
    const linux = section('### Linux');
    assert.match(linux, /\*Keep the Computer Awake While an Agent Works\* needs `systemd-inhibit`[\s\S]*`systemd-inhibit --list`/);
    // What else it needs (A-R5): GNU coreutils' tail, for its --pid.
    assert.match(linux, /needs `systemd-inhibit` and\s+GNU coreutils `tail` on the PATH/);
    assert.match(linux, /`tail --pid`/);
    assert.match(linux, /busybox/);
    const doc = source('../../WINDOWS_VERIFICATION.md');
    const at = doc.indexOf('\n### V56 — keep the computer awake while an agent works');
    assert.ok(at >= 0, 'no V56');
    const v56 = doc.slice(at, doc.indexOf('\n## ', at));
    for (let i = 1; i <= 5; i += 1) assert.match(v56, new RegExp(`\\*\\*V56-${i}:\\*\\*`), `no V56-${i}`);
    assert.match(v56, /`powercfg \/requests`/);
    assert.match(v56, /\*\*SYSTEM\*\*/);
    assert.match(v56, /OpenCode/);
  });
});

describe('Keep-awake: teardown', () => {
  test('KA-99: the clocks, the attention source, the settings, the store and the mock as the next suite expects', async () => {
    if (saved) {
      __setAgentActivityClocks(saved.clocks);
      __setAttentionSource(saved.source);
      mockBridge.keepAwakeMethod = saved.mock.method;
      mockBridge.keepAwakeCalls.length = saved.mock.calls;
      mockBridge.keepAwakeHeld = saved.mock.held;
      saved = null;
    }
    S.setState({ [KEEP_AWAKE_SETTING]: SETTINGS_DEFAULTS[KEEP_AWAKE_SETTING] });
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ notifications: [] });
    assert.deepEqual(T.getState().agentActivity, {}, 'nothing left');
    assert.equal(S.getState()[KEEP_AWAKE_SETTING], false);
  });
});
