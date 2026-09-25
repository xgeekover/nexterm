/**
 * A command whose start marker is held back.
 *
 * Found on a real Windows 10 machine (19045), not in any suite: in a PowerShell
 * terminal, the FIRST command of every session never read as running. The
 * backend's `pty-command-started` for it arrived when the command ended, a few
 * milliseconds before `pty-command-done` — so for the whole run the tab looked
 * idle and Resume typed straight into whatever was running.
 *
 * The cause is ConPTY. It forwards an escape sequence that changes nothing on
 * screen only with the next frame that does. OSC 133 "C" is such a sequence,
 * and for a session's first command PowerShell's integration writes it after
 * the frame that carried the Enter has already gone. With a visible character
 * after it, the same sequence arrived on time; without one, only with the next
 * prompt. Later commands were unaffected.
 *
 * So on Windows a line that was submitted, and that the shell has not answered
 * within a moment, counts as a running command. These cases pin that, and pin
 * the three places it must NOT apply: a shell that never reports an end (it
 * would stay "running" forever), a line the shell answers at once (an empty
 * Enter must not flicker), and every other platform (where C arrives on time,
 * and a continuation line the shell is still waiting on would read as busy).
 *
 * The mock's `pty_write` emits nothing at all for a bare "\r", which is exactly
 * a shell whose C is still being held.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import * as activity from '../../src/lib/tabActivity.js';
import { startCommand } from '../../src/lib/agents.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const T = terminalStore.useTerminalStore;
const GRACE_MS = terminalStore.SUBMIT_GRACE_MS ?? 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

/** Pretend to be on Windows (or not) for the length of `fn`. */
async function onWindows(on, fn) {
  const set = terminalStore.__setSubmitInfersRunning;
  const previous = set ? set(on) : undefined;
  try {
    await fn();
  } finally {
    if (set) set(previous);
  }
}

/** Everything typed into a terminal while `fn` ran. */
async function typedDuring(fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') typed.push(args?.data);
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

/** A terminal whose shell has already drawn one prompt, with its D. */
async function shellThatReportsEnds() {
  await T.getState().init();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
  return tab;
}

describe('A start marker that arrives late', () => {
  test('HM-01: on Windows, a submitted line the shell has not answered is running, and Resume waits', async () => {
    await onWindows(true, async () => {
      const tab = await shellThatReportsEnds();
      try {
        const { agent } = startCommand('claude');
        T.setState((s) => ({
          tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, agent, agentResumeOffered: true } : t)),
        }));

        // Enter on `Start-Sleep 20`, with its C held back by ConPTY.
        await T.getState().writeRaw(tab.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, true, 'the first command of the session read as idle');
        assert.equal(typeof tabById(tab.id).runStartedAt, 'number', 'no start time for the notification');

        let resumed;
        const typed = await typedDuring(async () => {
          resumed = await T.getState().resumeAgent(tab.id);
        });
        assert.equal(resumed, false, 'Resume went ahead while the command ran');
        assert.deepEqual(typed, [], 'typed into the running command');
        assert.equal(tabById(tab.id).agentResumeOffered, true, 'the offer went away unused');

        // The held C finally arrives, then D, as they did on the real machine.
        await mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
        assert.equal(tabById(tab.id).running, true);
        await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
        assert.equal(tabById(tab.id).running, false, 'still running after the shell said it was done');

        const typedAfter = await typedDuring(async () => {
          resumed = await T.getState().resumeAgent(tab.id);
        });
        assert.equal(resumed, true, 'back at the prompt, the offer should work');
        assert.deepEqual(typedAfter, [`claude --resume ${agent.sessionId}\r`]);
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('HM-02: a line the shell answers at once never flickers as running', async () => {
    await onWindows(true, async () => {
      const tab = await shellThatReportsEnds();
      const seen = [];
      const stop = T.subscribe((s) => seen.push(s.tabs.find((t) => t.id === tab.id)?.running));
      try {
        // An empty Enter: the shell just draws the next prompt, with its D.
        await T.getState().writeRaw(tab.id, '\r');
        await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
        await sleep(GRACE_MS + 150);
        assert.equal(seen.includes(true), false, 'an answered line was drawn as a running command');
      } finally {
        stop();
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('HM-03: a shell that never reports an end is left alone', async () => {
    // cmd, fish and sh send OSC 7 and nothing else. Nothing would ever clear
    // `running` for them, so it must never be set by guesswork.
    await onWindows(true, async () => {
      await T.getState().init();
      const tab = await T.getState().createTab();
      try {
        await T.getState().writeRaw(tab.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, false, 'a cmd terminal would pulse forever');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('HM-04: what counts is that THIS session reports ends, not another one', async () => {
    await onWindows(true, async () => {
      const other = await shellThatReportsEnds();
      const ownSession = other.sessionId;
      const tab = await T.getState().createTab();
      const setSession = (id, sessionId) =>
        T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)) }));
      try {
        assert.notEqual(tab.sessionId, other.sessionId, 'setup: two shells');
        await T.getState().writeRaw(tab.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, false, "another shell's D opened the gate for this one");

        // A tab whose shell is replaced keeps its id but not its session: the
        // old shell's D says nothing about the new one.
        setSession(other.id, tab.sessionId);
        await T.getState().writeRaw(other.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(other.id).running, false, "a respawned shell inherited the old one's D");
      } finally {
        setSession(other.id, ownSession);
        await T.getState().closeTab(tab.id);
        await T.getState().closeTab(other.id);
      }
    });
  });

  test('HM-05: off Windows nothing changes — C arrives on time there', async () => {
    await onWindows(false, async () => {
      const tab = await shellThatReportsEnds();
      try {
        await T.getState().writeRaw(tab.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, false, 'a continuation line would read as busy on macOS');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('HM-06: only a line the shell is asked to run counts as submitted', () => {
    const { submitsLine } = activity;
    assert.equal(typeof submitsLine, 'function', 'no submitsLine in tabActivity.js');
    assert.equal(submitsLine('\r'), true, 'the Enter key');
    assert.equal(submitsLine('claude --resume x\r'), true, 'a command typed by the app');
    // A bracketed paste is held by the shell until the user presses Enter.
    assert.equal(submitsLine('\x1b[200~echo a\recho b\r\x1b[201~'), false);
    assert.equal(submitsLine('\x1b[200~echo a\r'), false);
    // Alt+Enter inserts a newline in PSReadLine; it runs nothing.
    assert.equal(submitsLine('\x1b\r'), false);
    assert.equal(submitsLine('ls'), false);
    assert.equal(submitsLine(''), false);
    assert.equal(submitsLine(undefined), false);
  });

  test('HM-08: a command that starts and finishes on time is not left running', async () => {
    // The ordinary case on Windows from the second command on: C and D both
    // arrive, fast. The guess must not outlive them.
    await onWindows(true, async () => {
      const tab = await shellThatReportsEnds();
      try {
        await T.getState().writeRaw(tab.id, 'echo hi\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, false, 'a finished command was marked running after the fact');
        assert.equal(tabById(tab.id).lastExitCode, 0);
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('HM-07: teardown — no guessed run is left behind for the next suite', async () => {
    // Every case above closed its own terminals and put the platform back
    // (`onWindows` restores it in a finally). What remains is to make sure no
    // grace timer from them can still land.
    await sleep(GRACE_MS + 50);
    assert.equal(T.getState().tabs.some((t) => t.running), false, 'a terminal is still marked running');
  });
});
