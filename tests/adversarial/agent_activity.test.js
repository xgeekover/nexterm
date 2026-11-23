/**
 * Claude Code's working and idle state, from the terminal title it sets, and
 * the entry NexTerm lists when one of its turns ends (F1-F12).
 *
 * AC1 — `claudeActivityOf` (src/lib/agents.js). AC2-AC5 — the store's
 * `agentActivity` map, driven through `mockBridge.emit('pty-title', …)` with
 * the titles real Claude Code 2.1.323 sent in a pty (the Queen's recording,
 * runtime/reports/T-20261114-192901-6863/claude-code-terminal-titles.txt),
 * on injected clocks and an injected settle timer
 * (`__setAgentActivityClocks`). AC6 (control part) — `nexterm-cli` list.
 * AC7-AC11 — the completion's route, threshold and the one-entry rule.
 *
 * Writes to the terminals are held. AA-99 puts the clocks, the attention
 * source, the desktop gate, the settings and the store back.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { useSettingsStore, SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { claudeActivityOf, claudeTitleOf } from '../../src/lib/agents.js';
import { makeNote } from '../../src/lib/programNotifications.js';
import { terminalStatus } from '../../src/lib/terminalStatus.js';
import { createControlDispatcher } from '../../src/lib/controlDispatcher.js';
import {
  AGENT_IDLE_SETTLE_MS,
  NO_AGENT_ACTIVITY,
  agentDoneBody,
  agentDoneDecision,
  nextAgentActivity,
  settleAgentActivity,
} from '../../src/lib/agentActivity.js';

const T = terminalStore.useTerminalStore;
const { __setAgentActivityClocks, __setAttentionSource, setProgramDesktopGate } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const IDLE = '✳';
const SPIN_A = '◐';
const SPIN_B = '◑';
const TITLE = 'NexTerm 세션 기록 기능 테스트';
/** u3: a session that sent one message — its seven title changes, as recorded. */
const U3 = [
  `${IDLE} Claude Code`,
  `${SPIN_A} Claude Code`,
  `${SPIN_B} Claude Code`,
  `${SPIN_A} Claude Code`,
  `${SPIN_A} ${TITLE}`,
  `${SPIN_B} ${TITLE}`,
  `${IDLE} ${TITLE}`,
];
/** u2: a session that sent nothing. */
const U2 = [`${IDLE} Claude Code`];

const FOCUSED = Object.freeze({ focused: true, visible: true });
const BACKGROUND = Object.freeze({ focused: false, visible: true });

const prompt = (tab, exitCode = 0) => mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
const show = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });

/**
 * Clocks the store's agent state runs on: `now` monotonic, `wall` a
 * `Date.now()`, and a settle timer that fires only when `advance` passes it.
 */
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
    pending: () => timers.filter((t) => t.live).length,
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

let clocks = null;
let focused = true;
let saved = null;

/** `fn` with fresh clocks, a started store, writes held, and two terminals: `claude` running Claude Code and `other`, active. */
async function withClaude(fn, { agent = 'claude' } = {}) {
  if (!saved) {
    saved = {
      clocks: __setAgentActivityClocks({}),
      source: __setAttentionSource(() => (focused ? FOCUSED : BACKGROUND)),
      gate: setProgramDesktopGate(null),
    };
  }
  clocks = fakeClocks();
  __setAgentActivityClocks(clocks);
  __setAttentionSource(() => (focused ? FOCUSED : BACKGROUND));
  focused = true;
  useSettingsStore.setState({
    terminalAgentDoneAfterSeconds: SETTINGS_DEFAULTS.terminalAgentDoneAfterSeconds,
    terminalBellAttention: true,
    terminalAttentionFlashFocused: false,
  });
  const unsink = setTerminalNoticeSink(() => true);
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') return null;
    return original.call(this, command, args, ...rest);
  };
  try {
    await T.getState().init();
    const a = await T.getState().createTab({ cwd: '/workspace' });
    await prompt(tabById(a.id));
    const b = await T.getState().createTab({ cwd: '/workspace' });
    await prompt(tabById(b.id));
    if (agent === 'claude' || agent === 'opencode') await T.getState().startAgent(a.id, agent);
    T.setState({ activeTabId: b.id, notifications: [] });
    mockBridge.desktopNotifications.length = 0;
    await fn({ claude: tabById(a.id), other: tabById(b.id) });
  } finally {
    mockBridge.invoke = original;
    unsink();
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ notifications: [] });
    mockBridge.desktopNotifications.length = 0;
  }
}

const activity = (tab) => T.getState().agentActivity[tab.id];
const stateOf = (tab) => activity(tab)?.state ?? null;
const entriesOf = (tab) => T.getState().notifications.filter((n) => n.tabId === tab.id);
const desktops = () => mockBridge.desktopNotifications;

/** A Claude Code turn in `tab`: working for `ms`, then idle, then the settle time. */
async function turn(tab, ms, { idleTitle = `${IDLE} Claude Code`, settle = true } = {}) {
  await show(tab, `${SPIN_A} Claude Code`);
  clocks.advance(ms);
  await show(tab, idleTitle);
  if (settle) clocks.advance(AGENT_IDLE_SETTLE_MS);
}

describe("Agent activity: reading Claude Code's title (F1, AC1)", () => {
  test('AA-01: working for ◐ ◑ ◒ ◓, idle for ✳, each with or without U+FE0F; null for anything else', () => {
    for (const glyph of ['◐', '◑', '◒', '◓']) {
      assert.equal(claudeActivityOf(`${glyph} x`), 'working', glyph);
      assert.equal(claudeActivityOf(`${glyph}️ x`), 'working', `${glyph} + FE0F`);
      assert.equal(claudeActivityOf(`${glyph} Claude Code`), 'working');
    }
    assert.equal(claudeActivityOf('✳ Claude Code'), 'idle', 'its default title too');
    assert.equal(claudeActivityOf('✳️ x'), 'idle');
    assert.equal(claudeActivityOf(`✳ ${TITLE}`), 'idle');
    for (const other of [null, undefined, 42, {}, '', '✳', '✳x', '✳   ', 'OC | x', 'user@host: ~', '⠋ Claude Code', '✶ x', '● x', ' ✳ x', '◔ x']) {
      assert.equal(claudeActivityOf(other), null, JSON.stringify(other));
    }
    // claudeTitleOf is untouched (F23): the default still names no conversation.
    assert.equal(claudeTitleOf('✳ Claude Code'), null);
    assert.equal(claudeTitleOf(`◐ ${TITLE}`), TITLE);
  });

  test('AA-02: the pure turn machine — working at once, idle only once settled, the turn measured from its first working title', () => {
    let step = nextAgentActivity(NO_AGENT_ACTIVITY, 'working', 100, 5000);
    assert.deepEqual([step.record.shown, step.changed, step.record.turn.startedAt], ['working', true, 100]);
    const first = step.record;
    step = nextAgentActivity(first, 'working', 200, 5100);
    assert.equal(step.changed, false, 'another frame changes nothing shown');
    step = nextAgentActivity(step.record, 'idle', 900, 5800);
    assert.deepEqual([step.record.shown, step.settle, step.changed], ['working', 'start', false]);
    assert.equal(nextAgentActivity(step.record, 'idle', 950, 5850).record, step.record, 'a second ✳ while waiting: the same record');
    const settled = settleAgentActivity(step.record);
    assert.deepEqual([settled.record.shown, settled.record.since, settled.done.durationMs, settled.done.from], ['idle', 5800, 800, 5100]);
    assert.equal(nextAgentActivity(settled.record, 'idle', 1000, 6000).record, settled.record, 'idle while idle: nothing');
    const fresh = nextAgentActivity(NO_AGENT_ACTIVITY, 'idle', 1, 2);
    assert.deepEqual([fresh.record.shown, fresh.record.turn, settleAgentActivity(fresh.record).done], ['idle', null, null], 'never seen working: no turn');
    assert.equal(nextAgentActivity(NO_AGENT_ACTIVITY, null, 1, 2).record, NO_AGENT_ACTIVITY);
    assert.equal(agentDoneDecision({ durationMs: 9999, thresholdMs: 10000, route: { inApp: true, desktop: true } }).list, false);
    assert.deepEqual(agentDoneDecision({ durationMs: 10000, thresholdMs: 10000, signals: ['bell'], route: { inApp: true, desktop: true } }), {
      list: false,
      desktop: true,
      flash: false,
    });
    assert.deepEqual(agentDoneDecision({ durationMs: 1e6, thresholdMs: 0, route: { inApp: true, desktop: true } }).list, false, '0 is off');
    assert.equal(agentDoneBody(12_000, null), 'Waiting for you after 12s of work');
    assert.equal(agentDoneBody(65_000, 'Fix it'), 'Waiting for you after 1m 5s of work \u{2014} Fix it');
  });
});

describe('Agent activity: the store follows the title (F2-F4, AC2-AC4)', () => {
  test('AA-10: the u3 replay — idle, working at the first ◐ with one change for every frame, idle only after the settle time (AC2)', async () => {
    await withClaude(async ({ claude }) => {
      let changes = 0;
      const stop = T.subscribe((s, prev) => {
        if (s.agentActivity !== prev.agentActivity) changes += 1;
      });
      try {
        await show(claude, U3[0]);
        assert.equal(stateOf(claude), 'idle', 'seen idle first: Idle at once');
        assert.equal(changes, 1);
        await show(claude, U3[1]);
        assert.equal(stateOf(claude), 'working', 'working at the first ◐, with no delay');
        const map = T.getState().agentActivity;
        for (const title of U3.slice(2, 6)) await show(claude, title);
        assert.equal(changes, 2, 'one change for all of the working frames');
        assert.equal(T.getState().agentActivity, map, 'a frame of the state shown leaves the map identical');
        await show(claude, U3[6]);
        assert.equal(stateOf(claude), 'working', 'not idle yet');
        clocks.advance(AGENT_IDLE_SETTLE_MS - 1);
        assert.equal(stateOf(claude), 'working', 'not idle 1 ms before the settle time');
        clocks.advance(1);
        assert.equal(stateOf(claude), 'idle', 'idle once it has passed');
        assert.equal(changes, 3);
        assert.equal(Object.isFrozen(activity(claude)), true);
        assert.equal(entriesOf(claude).length, 0, 'a turn of no time lists nothing');
        assert.equal(terminalStatus(tabById(claude.id), { activity: activity(claude) }).word, 'Idle');
      } finally {
        stop();
      }
    });
  });

  test('AA-11: the u2 replay — idle, and no entry ever (AC2)', async () => {
    await withClaude(async ({ claude }) => {
      for (const title of U2) await show(claude, title);
      assert.equal(stateOf(claude), 'idle');
      clocks.advance(60_000);
      assert.equal(entriesOf(claude).length, 0);
      assert.equal(clocks.pending(), 0, 'no timer for a session never seen working');
    });
  });

  test('AA-12: a ✳ between working frames within the settle time never shows Idle, and the turn runs from its first working title (AC3)', async () => {
    await withClaude(async ({ claude }) => {
      const seen = [];
      const stop = T.subscribe((s) => seen.push(s.agentActivity[claude.id]?.state ?? null));
      try {
        await show(claude, `${SPIN_A} Claude Code`);
        assert.equal(stateOf(claude), 'working', 'at once');
        clocks.advance(5_000);
        await show(claude, `${IDLE} Claude Code`);
        clocks.advance(AGENT_IDLE_SETTLE_MS - 500);
        await show(claude, `${SPIN_B} Claude Code`);
        clocks.advance(10_000);
        assert.equal(entriesOf(claude).length, 0, 'no entry for the flicker');
        assert.equal(seen.includes('idle'), false, `Idle was never shown: ${seen}`);
        clocks.advance(5_000);
        await show(claude, `${IDLE} Claude Code`);
        clocks.advance(AGENT_IDLE_SETTLE_MS);
      } finally {
        stop();
      }
      const [entry] = entriesOf(claude);
      // 5 s + 1 s + 10 s + 5 s from the first ◐ to the last ✳.
      assert.equal(entry?.body, 'Waiting for you after 21s of work', 'measured from the first working title');
      assert.equal(entry.durationMs, 21_000);
    });
  });

  test('AA-13: a title not Claude Code’s forgets the state and the waiting idle; id-less claude is read; opencode, offered and agent-less tabs are not (AC4)', async () => {
    await withClaude(async ({ claude, other }) => {
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(12_000);
      await show(claude, `${IDLE} Claude Code`);
      await show(claude, 'user@host: ~');
      assert.equal(activity(claude), undefined, 'unknown');
      assert.equal(clocks.pending(), 0, 'the settle timer is gone');
      clocks.advance(5_000);
      assert.equal(entriesOf(claude).length, 0, 'no entry after the settle time');
      assert.equal(activity(claude), undefined);

      await show(other, `${SPIN_A} Claude Code`);
      assert.equal(activity(other), undefined, 'a terminal with no agent record gets no state');
      T.getState().noteAgentActivity(other.id, `${SPIN_A} Claude Code`);
      assert.equal(activity(other), undefined);

      // An id-less claude: typed by hand with --continue.
      await T.getState().writeRaw(other.id, 'claude --continue\r');
      await sleep(10);
      assert.equal(tabById(other.id).agent?.kind, 'claude', 'premise: recorded');
      assert.equal(tabById(other.id).agent.sessionId ?? null, null, 'premise: no id');
      await show(other, `${SPIN_B} x`);
      assert.equal(stateOf(other), 'working', 'an id-less record gets a state');

      // Offered back: not read.
      T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === claude.id ? { ...t, agentResumeOffered: true } : t)) }));
      await show(claude, `${SPIN_A} Claude Code`);
      assert.equal(activity(claude), undefined, 'an offered record gets no state');
    });
    await withClaude(
      async ({ claude }) => {
        assert.equal(tabById(claude.id).agent?.kind, 'opencode', 'premise');
        await show(claude, `${SPIN_A} Claude Code`);
        assert.equal(activity(claude), undefined, 'an opencode record gets no state');
      },
      { agent: 'opencode' }
    );
  });

  test('AA-14: a tab whose agent is not believed to run shows what it shows today, whatever its entry says (AC4)', async () => {
    await withClaude(async ({ claude }) => {
      await show(claude, `${SPIN_A} Claude Code`);
      assert.equal(terminalStatus(tabById(claude.id), { activity: activity(claude) }).state, 'working');
      T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === claude.id ? { ...t, agentTyped: null, running: true } : t)) }));
      assert.equal(stateOf(claude), 'working', 'the entry is still there');
      assert.equal(terminalStatus(tabById(claude.id), { activity: activity(claude) }).state, 'running', 'today’s status');
    });
  });
});

describe('Agent activity: every end forgets the turn (F3, AC5)', () => {
  /** Working for 12 s, then the idle title, its settle time not yet up — unfocused, so a completion would reach the desktop. */
  const pendingIdle = async (tab) => {
    focused = false;
    await turn(tab, 12_000, { settle: false });
    assert.equal(clocks.pending(), 1, 'premise: waiting out the idle title');
  };
  const nothingAfter = (tab, what) => {
    clocks.advance(AGENT_IDLE_SETTLE_MS * 2);
    assert.equal(T.getState().agentActivity[tab.id], undefined, `${what}: its key is gone`);
    assert.equal(T.getState().notifications.filter((n) => n.tabId === tab.id).length, 0, `${what}: no entry`);
    assert.equal(desktops().length, 0, `${what}: no desktop record`);
    assert.equal(clocks.pending(), 0, `${what}: no timer left`);
  };

  test('AA-20: the agent ends at its command end', async () => {
    await withClaude(async ({ claude }) => {
      await started(claude);
      await pendingIdle(claude);
      await prompt(claude, 0);
      assert.equal(tabById(claude.id).agent, null, 'premise: the agent ended');
      nothingAfter(claude, 'agent end');
    });
  });

  test('AA-21: the shell exits (pty-exit)', async () => {
    await withClaude(async ({ claude }) => {
      await pendingIdle(claude);
      await mockBridge.emit('pty-exit', { session_id: claude.sessionId, exit_code: 0 });
      nothingAfter(claude, 'pty-exit');
    });
  });

  test('AA-22: the terminal is closed', async () => {
    await withClaude(async ({ claude }) => {
      await pendingIdle(claude);
      await T.getState().closeTab(claude.id);
      nothingAfter(claude, 'close');
    });
  });

  test('AA-23: the shell is restarted (titles that came after its exit included)', async () => {
    await withClaude(async ({ claude }) => {
      await mockBridge.emit('pty-exit', { session_id: claude.sessionId, exit_code: 0 });
      await pendingIdle(claude);
      assert.equal(stateOf(claude), 'working', 'premise: late titles were read');
      assert.equal(await T.getState().restartShell(claude.id), true, 'premise: restarted');
      nothingAfter(claude, 'restart');
    });
  });

  test('AA-24: a new agent record', async () => {
    await withClaude(async ({ claude }) => {
      await pendingIdle(claude);
      await T.getState().startAgent(claude.id, 'claude');
      nothingAfter(claude, 'recordAgent');
    });
  });

  test('AA-25: the upkeep prune — the tab leaves `tabs` by any other way', async () => {
    await withClaude(async ({ claude }) => {
      await pendingIdle(claude);
      T.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== claude.id) }));
      nothingAfter(claude, 'prune');
    });
  });
});

describe('Agent activity: the completion entry (F8-F10, AC7-AC8)', () => {
  test('AA-30: a 12 s turn in a background terminal of a focused window — one unread entry, no desktop record (AC7)', async () => {
    await withClaude(async ({ claude }) => {
      await turn(claude, 12_000);
      const list = entriesOf(claude);
      assert.equal(list.length, 1, JSON.stringify(list));
      const [entry] = list;
      assert.equal(entry.kind, 'program');
      assert.equal(entry.origin, 'agent-done');
      assert.equal(entry.agent, 'claude');
      assert.equal(entry.title, 'Claude Code');
      assert.equal(entry.read, false);
      assert.ok(entry.body.startsWith('Waiting for you after 12s of work'), entry.body);
      assert.ok(entry.id.startsWith(`agent-${claude.id}-`), entry.id);
      assert.equal(entry.durationMs, 12_000);
      assert.equal(entry.tabTitle, tabById(claude.id).title || tabById(claude.id).defaultTitle || 'Terminal');
      assert.equal(desktops().length, 0);
    });
  });

  test('AA-31: unfocused — the entry and exactly one desktop record titled after the terminal (AC7)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await turn(claude, 12_000);
      assert.equal(entriesOf(claude).length, 1);
      assert.equal(desktops().length, 1);
      const [entry] = entriesOf(claude);
      assert.deepEqual(desktops()[0], { title: `Claude Code in ${entry.tabTitle}`, body: entry.body });
    });
  });

  test('AA-32: the terminal being typed into — focused: nothing; unfocused: entry and desktop record (AC7)', async () => {
    await withClaude(async ({ claude }) => {
      T.setState({ activeTabId: claude.id });
      await turn(claude, 12_000);
      assert.equal(entriesOf(claude).length, 0, 'typed into: no entry');
      assert.equal(desktops().length, 0);
      focused = false;
      await turn(claude, 12_000);
      assert.equal(entriesOf(claude).length, 1, 'the window is elsewhere: listed');
      assert.equal(desktops().length, 1);
      // Typed into with 'Flash the Terminal You Are In' on: a flash, nothing listed.
      focused = true;
      useSettingsStore.setState({ terminalAttentionFlashFocused: true });
      await turn(claude, 12_000);
      assert.equal(entriesOf(claude).length, 1, 'no second entry');
      assert.ok(T.getState().attentionFlash[claude.id], 'the pane flashes');
      assert.equal(desktops().length, 1);
    });
  });

  test('AA-33: a conversation title holding a token is masked in the entry and the desktop body (AC7)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await turn(claude, 12_000, { idleTitle: `${IDLE} Deploy with ${TOKEN}` });
      const [entry] = entriesOf(claude);
      assert.ok(entry.body.startsWith('Waiting for you after 12s of work \u{2014} Deploy with'), entry.body);
      assert.equal(entry.body.includes(TOKEN), false, 'masked in the entry');
      assert.equal(desktops()[0].body.includes(TOKEN), false, 'masked on the desktop');
      assert.equal(desktops()[0].body, entry.body);
    });
  });

  test('AA-34: a 9 s turn lists nothing at 10; 0 lists nothing while the state still shows; a change applies to the next turn (AC8)', async () => {
    assert.equal(SETTINGS_DEFAULTS.terminalAgentDoneAfterSeconds, 10, 'the default is 10 s');
    await withClaude(async ({ claude }) => {
      await turn(claude, 9_000);
      assert.equal(entriesOf(claude).length, 0, 'below the threshold');
      useSettingsStore.getState().setSetting('terminalAgentDoneAfterSeconds', 0);
      await turn(claude, 120_000);
      assert.equal(entriesOf(claude).length, 0, '0 is off');
      assert.equal(stateOf(claude), 'idle', 'the state display still works');
      useSettingsStore.getState().setSetting('terminalAgentDoneAfterSeconds', 5);
      await turn(claude, 6_000);
      assert.equal(entriesOf(claude).length, 1, 'the new setting, without a reload');
    });
  });
});

describe('Agent activity: one entry per completion (F11, AC9-AC11)', () => {
  const note = (title = 'Claude Code', body = 'Claude is waiting for your input') => makeNote(title, body, 'always');

  test('AA-40: Claude Code’s own note inside the idle period, before the decision — one entry (the note’s), one desktop record at most (AC9)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(12_000);
      T.getState().notifyFromProgram(claude.id, note(), BACKGROUND);
      await show(claude, `${IDLE} Claude Code`);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      const list = entriesOf(claude);
      assert.equal(list.length, 1, JSON.stringify(list));
      assert.equal(list[0].origin, undefined, "the note's entry");
      assert.equal(desktops().length, 1, "the note's own desktop record, nothing more");
      // After the idle title, before the settle time: the same.
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(12_000);
      await show(claude, `${IDLE} Claude Code`);
      T.getState().notifyFromProgram(claude.id, note(), FOCUSED);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      assert.equal(entriesOf(claude).length, 2, 'the second note, and no completion');
      assert.equal(entriesOf(claude).some((n) => n.origin === 'agent-done'), false);
    });
  });

  test('AA-41: a ring inside the idle period before the decision — one entry (the bell’s), plus the completion’s desktop record when unfocused (AC9)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await turn(claude, 12_000, { settle: false });
      T.getState().bellFromTerminal(claude.id, BACKGROUND, 1);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      const list = entriesOf(claude);
      assert.deepEqual(list.map((n) => n.kind), ['bell'], JSON.stringify(list));
      assert.equal(desktops().length, 1, "the completion's desktop record");
      assert.equal(desktops()[0].title.startsWith('Claude Code in '), true);
    });
    await withClaude(async ({ claude }) => {
      await turn(claude, 12_000, { settle: false });
      T.getState().bellFromTerminal(claude.id, FOCUSED, 1);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      assert.deepEqual(entriesOf(claude).map((n) => n.kind), ['bell']);
      assert.equal(desktops().length, 0, 'focused: no desktop record');
    });
  });

  test('AA-42: after a completion entry — a live note (also 60 s later), a kept note and a ring in the idle period add nothing; the next working title ends it (AC10)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await turn(claude, 12_000);
      const [entry] = entriesOf(claude);
      assert.equal(entry.origin, 'agent-done', 'premise');
      assert.equal(desktops().length, 1, 'premise');
      const route = T.getState().notifyFromProgram(claude.id, note('Claude Code', 'Claude is waiting for your input'), BACKGROUND);
      assert.deepEqual(route, { inApp: false, desktop: false });
      let list = entriesOf(claude);
      assert.equal(list.length, 1, 'no new entry');
      assert.equal(desktops().length, 1, 'no new desktop record');
      assert.equal(list[0].id, entry.id, 'the same entry');
      assert.equal(list[0].at, entry.at);
      assert.deepEqual([list[0].title, list[0].body], ['Claude Code', 'Claude is waiting for your input'], "the note's words");

      clocks.advance(60_000);
      T.getState().notifyFromProgram(claude.id, note('Claude Code', 'Still waiting'), BACKGROUND);
      assert.equal(entriesOf(claude).length, 1, '60 s later: still the same moment');
      assert.equal(entriesOf(claude)[0].body, 'Still waiting');
      assert.equal(desktops().length, 1);

      T.getState().notifyFromProgram(claude.id, note('Kept', 'printed in the idle period'), BACKGROUND, { keptAt: clocks.wall() - 1_000 });
      assert.equal(entriesOf(claude).length, 1, 'a kept note with keptAt in P adds nothing');
      assert.equal(entriesOf(claude)[0].title, 'Kept');
      assert.equal(entriesOf(claude)[0].read, false, 'still unread');

      T.getState().bellFromTerminal(claude.id, BACKGROUND, 1);
      assert.equal(entriesOf(claude).length, 1, 'a ring in P is not listed');
      assert.equal(desktops().length, 1);

      await show(claude, `${SPIN_A} Claude Code`);
      T.getState().notifyFromProgram(claude.id, note('Claude Code', 'a new moment'), BACKGROUND);
      assert.equal(entriesOf(claude).length, 2, 'after the next working title, a note is listed as today');
      assert.equal(desktops().length, 2);
    });
  });

  test('AA-43: a kept note printed before the idle period is listed as today (AC10, F11(d))', async () => {
    await withClaude(async ({ claude }) => {
      const before = clocks.wall();
      await turn(claude, 12_000);
      T.getState().notifyFromProgram(claude.id, note('Earlier', 'before the turn'), FOCUSED, { keptAt: before - 5_000 });
      assert.equal(entriesOf(claude).length, 2, 'outside P: listed');
    });
  });

  test('AA-44: a mid-turn permission note, more work, then the end — two entries (AC11)', async () => {
    await withClaude(async ({ claude }) => {
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(4_000);
      T.getState().notifyFromProgram(claude.id, note('Claude Code', 'Claude needs your permission to use Bash'), FOCUSED);
      clocks.advance(2_000);
      await show(claude, `${SPIN_B} Claude Code`);
      clocks.advance(8_000);
      await show(claude, `${IDLE} Claude Code`);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      const list = entriesOf(claude);
      assert.equal(list.length, 2, JSON.stringify(list));
      assert.equal(list.filter((n) => n.origin === 'agent-done').length, 1, 'the completion');
      assert.ok(list.find((n) => n.origin === 'agent-done').body.startsWith('Waiting for you after 14s of work'));
    });
  });

  test('AA-45: a completion that lists nothing leaves notes and rings as today (F11(c))', async () => {
    await withClaude(async ({ claude }) => {
      await turn(claude, 3_000);
      T.getState().notifyFromProgram(claude.id, note(), FOCUSED);
      T.getState().bellFromTerminal(claude.id, FOCUSED, 1);
      assert.deepEqual(entriesOf(claude).map((n) => n.kind).sort(), ['bell', 'program']);
    });
  });

  /** A kept note (read from output nobody had shown yet), printed at wall time `keptAt`. */
  const kept = (tab, keptAt, body, title = 'Claude Code') => T.getState().notifyFromProgram(tab.id, note(title, body), BACKGROUND, { keptAt });

  test('AA-46: a kept note printed in a listed completion’s idle period, read only after the next turn began — folded into that entry, no new entry, no desktop record (FX-1, G-01)', async () => {
    await withClaude(async ({ claude }) => {
      focused = false;
      await turn(claude, 12_000);
      const [entry] = entriesOf(claude);
      assert.equal(entry.origin, 'agent-done', 'premise');
      assert.equal(desktops().length, 1, "premise: the completion's desktop record");
      // Claude Code's own OSC 9 note as the turn ended, waiting in the
      // terminal's kept output; a new turn begins before anyone shows it.
      const printed = clocks.wall() - 1_000;
      clocks.advance(5_000);
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(3_000);
      const route = kept(claude, printed, 'Claude is waiting for your input');
      assert.deepEqual(route, { inApp: false, desktop: false });
      let list = entriesOf(claude);
      assert.equal(list.length, 1, `no second entry: ${JSON.stringify(list)}`);
      assert.equal(desktops().length, 1, 'no new desktop record');
      assert.equal(list[0].id, entry.id, 'the same entry');
      assert.equal(list[0].at, entry.at);
      assert.equal(list[0].read, false);
      assert.equal(list[0].body, 'Claude is waiting for your input', "the note's words");
      // Read meanwhile: it stays read.
      T.setState({ notifications: T.getState().notifications.map((n) => (n.id === entry.id ? { ...n, read: true } : n)) });
      kept(claude, printed + 100, 'Still the same moment');
      list = entriesOf(claude);
      assert.equal(list.length, 1);
      assert.deepEqual([list[0].id, list[0].read, list[0].body], [entry.id, true, 'Still the same moment']);
      // Dismissed meanwhile: nothing to fold into, and nothing listed either.
      T.setState({ notifications: T.getState().notifications.filter((n) => n.id !== entry.id) });
      assert.deepEqual(kept(claude, printed + 200, 'Gone'), { inApp: false, desktop: false });
      assert.equal(entriesOf(claude).length, 0, 'a dismissed completion is not listed again');
      assert.equal(desktops().length, 1);
      // The new turn's end is still its own moment.
      clocks.advance(9_000);
      await show(claude, `${IDLE} Claude Code`);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      list = entriesOf(claude);
      assert.equal(list.length, 1, JSON.stringify(list));
      assert.equal(list[0].origin, 'agent-done');
      assert.ok(list[0].body.startsWith('Waiting for you after 12s of work'), list[0].body);
      assert.equal(desktops().length, 2);
    });
  });

  test('AA-47: the same for two past turns, each folded into its own entry; a kept note outside every idle period is still listed (FX-1)', async () => {
    await withClaude(async ({ claude }) => {
      const beforeAll = clocks.wall() - 5_000;
      await turn(claude, 12_000);
      const inFirst = clocks.wall() - 500;
      clocks.advance(2_000);
      // The second turn: its first working title ends the first idle period.
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(4_000);
      const midTurn = clocks.wall();
      clocks.advance(4_000);
      await show(claude, `${SPIN_B} Claude Code`);
      clocks.advance(4_000);
      await show(claude, `${IDLE} Claude Code`);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      const inSecond = clocks.wall() - 500;
      const [second, first] = entriesOf(claude);
      assert.deepEqual([first?.origin, second?.origin], ['agent-done', 'agent-done'], `premise: ${JSON.stringify(entriesOf(claude))}`);
      clocks.advance(2_000);
      // The third turn begins: the second idle period is over too.
      await show(claude, `${SPIN_A} Claude Code`);
      clocks.advance(1_000);

      kept(claude, inFirst, 'the first');
      kept(claude, inSecond, 'the second');
      let list = entriesOf(claude);
      assert.equal(list.length, 2, `no new entry: ${JSON.stringify(list)}`);
      assert.equal(list.find((n) => n.id === first.id)?.body, 'the first', 'folded into the first entry');
      assert.equal(list.find((n) => n.id === second.id)?.body, 'the second', 'folded into the second entry');
      assert.equal(desktops().length, 0);

      // Outside every idle period: while the second turn worked, and before any turn.
      assert.equal(kept(claude, midTurn, 'a permission request').inApp, true);
      assert.equal(kept(claude, beforeAll, 'from before').inApp, true);
      list = entriesOf(claude);
      assert.equal(list.length, 4, JSON.stringify(list));
      assert.deepEqual(list.filter((n) => n.origin === undefined).map((n) => n.body).sort(), ['a permission request', 'from before']);
      assert.equal(desktops().length, 0, 'kept notes never reach the desktop');

      // The third turn's end is its own moment, the kept notes before it notwithstanding.
      clocks.advance(11_000);
      await show(claude, `${IDLE} Claude Code`);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      assert.equal(entriesOf(claude).filter((n) => n.origin === 'agent-done').length, 3);
    });
  });

  test('AA-48: four ended idle periods at most are kept per terminal, and the agent’s end lets them go (FX-1)', async () => {
    await withClaude(async ({ claude }) => {
      await started(claude);
      const printed = [];
      for (let i = 0; i < 5; i += 1) {
        await turn(claude, 12_000);
        printed.push(clocks.wall() - 500);
        clocks.advance(2_000);
      }
      await show(claude, `${SPIN_A} Claude Code`);
      assert.equal(entriesOf(claude).length, 5, 'premise: five completions');
      kept(claude, printed[1], 'the second');
      kept(claude, printed[4], 'the fifth');
      assert.equal(entriesOf(claude).length, 5, 'the four latest periods are kept');
      assert.equal(kept(claude, printed[0], 'the first').inApp, true, 'the oldest is let go');
      assert.equal(entriesOf(claude).length, 6);
      // The agent's end ends what was kept of it (F3): what it printed is listed as today.
      await prompt(claude, 0);
      assert.equal(tabById(claude.id).agent, null, 'premise: the agent ended');
      assert.equal(kept(claude, printed[3], 'after the end').inApp, true);
      assert.equal(entriesOf(claude).length, 7);
    });
  });

  test('AA-49: a note that went nowhere — kitty’s unfocused, aimed at the terminal being typed into — does not stand in for the completion: one entry, the completion’s (FX-2, G-04)', async () => {
    await withClaude(async ({ claude, other }) => {
      T.setState({ activeTabId: claude.id });
      await turn(claude, 12_000, { settle: false });
      const route = T.getState().notifyFromProgram(claude.id, makeNote('Claude Code', 'Claude is waiting for your input', 'unfocused'), FOCUSED);
      assert.deepEqual(route, { inApp: false, desktop: false }, 'premise: it went nowhere');
      assert.equal(entriesOf(claude).length, 0, 'premise');
      // You move to another terminal before the turn's end is decided.
      T.setState({ activeTabId: other.id });
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      const list = entriesOf(claude);
      assert.equal(list.length, 1, JSON.stringify(list));
      assert.equal(list[0].origin, 'agent-done', "the completion's entry");
      assert.equal(desktops().length, 0, 'focused: no desktop record');
    });
    // Heard — the same note about a terminal not being typed into — it is the news, and the completion lists nothing.
    await withClaude(async ({ claude }) => {
      await turn(claude, 12_000, { settle: false });
      assert.equal(T.getState().notifyFromProgram(claude.id, makeNote('Claude Code', 'Claude is waiting for your input', 'unfocused'), FOCUSED).inApp, true);
      clocks.advance(AGENT_IDLE_SETTLE_MS);
      assert.deepEqual(entriesOf(claude).map((n) => n.origin ?? 'note'), ['note']);
    });
  });
});

describe('Agent activity: the control API (F5, AC6)', () => {
  test('AA-50: nexterm-cli list reports idle and working for a Claude Code terminal', async () => {
    await withClaude(async ({ claude }) => {
      const replies = [];
      useSettingsStore.setState({ terminalControl: true });
      const dispatcher = createControlDispatcher({
        reply: async (message) => replies.push(message),
        attention: () => FOCUSED,
        later: (fn) => fn(),
      });
      const list = async () => {
        replies.length = 0;
        await dispatcher.handle({ id: replies.length + 1, session_id: claude.sessionId, cmd: 'list', args: {} });
        const rows = replies[0]?.result ?? replies[0]?.reply?.result ?? replies[0];
        return (Array.isArray(rows) ? rows : rows?.result ?? []).find((r) => r.id === claude.id)?.status;
      };
      await show(claude, `${IDLE} Claude Code`);
      assert.equal(await list(), 'idle', JSON.stringify(replies));
      await show(claude, `${SPIN_A} Claude Code`);
      assert.equal(await list(), 'working');
      dispatcher.dispose?.();
      useSettingsStore.setState({ terminalControl: SETTINGS_DEFAULTS.terminalControl });
    });
  });

  test("AA-51: list's activity field says idle, then working, for a Claude Code terminal — what the store's agentActivity holds (bundle 4, B2-F7)", async () => {
    await withClaude(async ({ claude }) => {
      const replies = [];
      useSettingsStore.setState({ terminalControl: true });
      const dispatcher = createControlDispatcher({
        reply: async (message) => replies.push(message),
        attention: () => FOCUSED,
        later: (fn) => fn(),
      });
      const rowOf = async () => {
        replies.length = 0;
        await dispatcher.handle({ id: 51, session_id: claude.sessionId, cmd: 'list', args: {} });
        assert.equal(replies[0]?.ok, true, JSON.stringify(replies));
        return replies[0].result.find((r) => r.id === claude.id);
      };
      try {
        await show(claude, `${IDLE} Claude Code`);
        let row = await rowOf();
        assert.deepEqual([row.activity, row.status], ['idle', 'idle']);
        assert.equal(row.activity, T.getState().agentActivity[claude.id].state);
        await show(claude, `${SPIN_A} Claude Code`);
        row = await rowOf();
        assert.deepEqual([row.activity, row.status], ['working', 'working']);
        assert.equal(row.activity, T.getState().agentActivity[claude.id].state);
      } finally {
        dispatcher.dispose?.();
        useSettingsStore.setState({ terminalControl: SETTINGS_DEFAULTS.terminalControl });
      }
    });
  });
});

describe('Agent activity: teardown', () => {
  test('AA-99: the clocks, the attention source, the desktop gate, the settings and the store as the next suite expects', async () => {
    if (saved) {
      __setAgentActivityClocks(saved.clocks);
      __setAttentionSource(saved.source);
      setProgramDesktopGate(saved.gate);
      saved = null;
    }
    useSettingsStore.setState({
      terminalAgentDoneAfterSeconds: SETTINGS_DEFAULTS.terminalAgentDoneAfterSeconds,
      terminalBellAttention: SETTINGS_DEFAULTS.terminalBellAttention,
      terminalAttentionFlashFocused: SETTINGS_DEFAULTS.terminalAttentionFlashFocused,
      terminalControl: SETTINGS_DEFAULTS.terminalControl,
    });
    for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
    T.setState({ notifications: [] });
    assert.deepEqual(T.getState().agentActivity, {}, 'nothing left');
  });
});
