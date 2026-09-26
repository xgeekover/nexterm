/**
 * An agent record that outlived its agent (#37).
 *
 * The record a terminal keeps of the agent it is running (`tab.agent`) used to
 * be cleared by Dismiss and by nothing else. So an agent the user had long
 * since quit was offered back on every restart — and one that had never been
 * sent a message could not be resumed at all: `claude --session-id` writes no
 * transcript until the first message, `claude --resume` answered "No
 * conversation found", and the same offer came back on the next launch, and
 * the one after that. Seen on Windows 10 with cmd while verifying #34.
 *
 * The record now ends with the agent: the shell reports "D" (OSC 133) when the
 * command it was running ends, and the first D after the agent command went
 * out is the agent exiting. The offer is then only ever made for an agent that
 * was still running when the app closed.
 *
 * Which D that is has one trap. New Claude Code Terminal typed the command
 * into a shell that had not drawn its first prompt yet, and drawing that
 * prompt sends a D of its own — so "the next D after typing" was the shell
 * starting, not the agent ending. The agent is therefore typed only once the
 * shell has drawn its first prompt, which also stops the command being echoed
 * twice (once by the tty as typeahead, once more by the line editor). A shell
 * that never reports a D (fish, sh) is typed into anyway once the wait is up,
 * and keeps its record as before: nothing can tell when its agent exits.
 *
 * Writes are held here rather than answered by the mock. The mock answers
 * every command it does not know with "command not found" and a D at once,
 * which for an agent is the agent exiting the moment it starts.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { startCommand } from '../../src/lib/agents.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';

const T = terminalStore.useTerminalStore;
const { PERSIST_KEY } = terminalStore;
const GRACE_MS = terminalStore.SUBMIT_GRACE_MS ?? 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

/** The shell drew a prompt: the D its integration sends with every one. */
const prompt = (tab, exitCode = 0) =>
  mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });

/**
 * Everything typed into a terminal while `fn` ran, held the way a shell holds
 * a line it is busy running. `fn` gets the list as it fills.
 */
async function holdingWrites(fn) {
  const original = mockBridge.invoke;
  const typed = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command === 'pty_write') {
      typed.push(args?.data);
      return Promise.resolve(null);
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(typed);
  } finally {
    mockBridge.invoke = original;
  }
  return typed;
}

/** Scope a store test hook to `fn`, if this build has it. */
async function withHook(name, value, fn) {
  const set = terminalStore[name];
  const previous = set ? set(value) : undefined;
  try {
    await fn();
  } finally {
    if (set) set(previous);
  }
}

/** How long a shell gets to draw its first prompt, for the length of `fn`. */
const withPromptWait = (ms, fn) => withHook('__setAgentPromptWaitMs', ms, fn);

/** On Windows (true) or anywhere else (false), for the length of `fn`. */
const onWindows = (on, fn) => withHook('__setSubmitInfersRunning', on, fn);

/** A fresh terminal whose shell has not drawn anything yet. */
async function freshTerminal() {
  await T.getState().init();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  return tab;
}

/** A restored terminal offering `agent` back. */
function offer(tab, agent) {
  T.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, agent, agentResumeOffered: true } : t)),
  }));
}

describe('An agent terminal types into a shell that is ready for it', () => {
  test("AL-01: New Claude Code Terminal waits for the shell's first prompt before typing", async () => {
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      try {
        let agent;
        await holdingWrites(async (typed) => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await sleep(100);
          assert.deepEqual(typed, [], 'typed before the shell had drawn a prompt — typeahead, echoed twice');

          await prompt(tab);
          agent = await pending;
          assert.ok(agent, 'startAgent gave up');
          assert.deepEqual(typed, [`claude --session-id ${agent.sessionId}\r`], 'not typed once the prompt was there');
        });
        assert.deepEqual(tabById(tab.id).agent, agent, 'the terminal does not know what it is running');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-02: a shell that never reports a prompt gets the agent once the wait is up, and keeps the record', async () => {
    // fish and sh have no integration and send no D, ever.
    await onWindows(false, () =>
      withPromptWait(150, async () => {
        const tab = await freshTerminal();
        try {
          let agent;
          const asked = Date.now();
          await holdingWrites(async (typed) => {
            agent = await T.getState().startAgent(tab.id, 'claude');
            assert.ok(agent, 'startAgent gave up on a shell that sends no D');
            assert.deepEqual(typed, [`claude --session-id ${agent.sessionId}\r`], 'never typed at all');
          });
          assert.ok(Date.now() - asked >= 120, 'typed before the shell had its chance to draw a prompt');

          // Typed without a prompt to go by, the next D could be the shell's
          // own first one — a slow start rather than fish — so it says nothing
          // about the agent. The record stays, as it always did.
          await prompt(tab);
          assert.deepEqual(tabById(tab.id).agent, agent, 'a late first prompt was taken for the agent exiting');
        } finally {
          await T.getState().closeTab(tab.id);
        }
      })
    );
  });

  test('AL-03: a terminal closed while its agent waits for a prompt gets nothing typed', async () => {
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      const typed = await holdingWrites(async () => {
        const pending = T.getState().startAgent(tab.id, 'claude');
        await T.getState().closeTab(tab.id);
        assert.equal(await pending, null, 'claimed to start an agent in a terminal that is gone');
      });
      assert.deepEqual(typed, [], 'typed into a closed terminal');
    });
  });
});

describe('The record ends when the agent does', () => {
  test("AL-04: the agent's own exit clears it — the shell's first prompt does not", async () => {
    await onWindows(false, async () => {
      const other = await freshTerminal();
      await prompt(other);
      const tab = await T.getState().createTab();
      try {
        let agent;
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab); // the shell's first prompt, before anything is typed
          agent = await pending;
        });
        assert.ok(agent, 'setup: the agent started');
        assert.deepEqual(tabById(tab.id).agent, agent, "the shell's first prompt was taken for the agent exiting");

        // Another terminal finishing a command says nothing about this one.
        await prompt(other, 1);
        assert.deepEqual(tabById(tab.id).agent, agent, "another terminal's D ended this terminal's agent");

        // The user quits claude; the shell draws its next prompt.
        await prompt(tab);
        assert.equal(tabById(tab.id).agent, null, 'an agent that has exited is still offered after a restart');
        assert.equal(tabById(tab.id).agentResumeOffered, false);
      } finally {
        await T.getState().closeTab(tab.id);
        await T.getState().closeTab(other.id);
      }
    });
  });

  test('AL-05: on Windows the agent reads as running while it runs, and its exit ends both', async () => {
    // ConPTY holds the first command's C back (see held_start_marker), so the
    // agent is running only by inference from its submitted line. The D that
    // ends it has to end the inferred run and the record together.
    await onWindows(true, async () => {
      const tab = await freshTerminal();
      try {
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab);
          await pending;
        });
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, true, 'setup: the agent reads as running');
        assert.ok(tabById(tab.id).agent, 'the record went while the agent was still running');

        await prompt(tab);
        assert.equal(tabById(tab.id).running, false);
        assert.equal(tabById(tab.id).agent, null, 'the agent exited and the record stayed');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-11: a shell replaced under the agent says nothing about it', async () => {
    // The same discipline as HM-04: a tab can keep its id while its shell is
    // replaced, and the new shell's D's are about the new shell. The agent
    // went down with the old one rather than exiting, so it stays on offer,
    // like an agent that was running when the app closed.
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      const own = tab.sessionId;
      const setSession = (sessionId) =>
        T.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, sessionId } : t)) }));
      const replacement = await mockBridge.invoke('pty_spawn', { cols: 80, rows: 24, cwd: null, shell: '/bin/zsh' });
      try {
        let agent;
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab);
          agent = await pending;
        });

        setSession(replacement.session_id);
        await mockBridge.emit('pty-command-done', { session_id: replacement.session_id, exit_code: 0 });
        assert.deepEqual(tabById(tab.id).agent, agent, "the new shell's first prompt was taken for the agent exiting");
      } finally {
        setSession(own);
        await mockBridge.invoke('pty_kill', { session_id: replacement.session_id });
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test("AL-06: a resumed agent's exit clears it too", async () => {
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      try {
        await prompt(tab); // a restored shell, sitting at its prompt
        const { agent } = startCommand('claude');
        offer(tab, agent);

        let resumed;
        const typed = await holdingWrites(async () => {
          resumed = await T.getState().resumeAgent(tab.id);
        });
        assert.equal(resumed, true);
        assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);
        assert.deepEqual(tabById(tab.id).agent, agent, 'the record went before the agent had even exited');

        await prompt(tab);
        assert.equal(tabById(tab.id).agent, null, 'the resumed agent exited and the record stayed');
        assert.equal(tabById(tab.id).agentResumeOffered, false);
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-07: Resume pressed before the restored shell has a prompt waits for it', async () => {
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      try {
        const { agent } = startCommand('claude');
        offer(tab, agent);

        await holdingWrites(async (typed) => {
          const pending = T.getState().resumeAgent(tab.id);
          await sleep(100);
          assert.deepEqual(typed, [], 'typed into a shell that was still starting');
          assert.equal(tabById(tab.id).agentResumeOffered, false, 'the offer stayed up while it was being taken');

          await prompt(tab);
          assert.equal(await pending, true, 'Resume gave up');
          assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);
        });
        assert.deepEqual(tabById(tab.id).agent, agent, "the shell's first prompt was taken for the agent exiting");

        await prompt(tab, 1);
        assert.equal(tabById(tab.id).agent, null);
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-08: Resume in a shell that never reports a prompt does not sit out the wait again', async () => {
    // The wait is for a shell that is still starting. One that has been up
    // longer than any first prompt takes is not going to send one, so the
    // wait is counted from when the shell started, not from the click.
    await onWindows(false, () =>
      withPromptWait(200, async () => {
        const tab = await freshTerminal();
        try {
          await sleep(250);
          const { agent } = startCommand('claude');
          offer(tab, agent);

          const clicked = Date.now();
          const typed = await holdingWrites(async () => {
            assert.equal(await T.getState().resumeAgent(tab.id), true);
          });
          assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);
          assert.ok(Date.now() - clicked < 100, `Resume waited ${Date.now() - clicked}ms for a prompt that was never coming`);
        } finally {
          await T.getState().closeTab(tab.id);
        }
      })
    );
  });
});

describe('A conversation that never started is offered once, not forever', () => {
  // Through the disk, because the bug was what the NEXT launch offered.
  const backing = new Map();
  const shim = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  const onDisk = () => {
    const raw = backing.get(PERSIST_KEY);
    return raw ? JSON.parse(raw).data : null;
  };

  /** A workspace as this build writes it: one terminal, which was running `agent`. */
  const workspaceRunning = (agent) => ({
    workspaceName: 'Default',
    activeGroupId: 'group-agent',
    groups: [
      {
        id: 'group-agent', name: 'Agents', createdAt: 1, activePaneId: 'pane-agent',
        tree: { type: 'leaf', id: 'pane-agent', tabIds: ['tab-agent'], activeTabId: 'tab-agent' },
      },
    ],
    tabs: [{ id: 'tab-agent', title: 'Terminal 1', cwd: '/workspace', agent }],
  });

  /** Quit and start again — from `seed`, or from what the last run saved. */
  async function relaunch({ seed = null } = {}) {
    T.getState().dispose();
    if (seed) {
      backing.clear();
      backing.set(PERSIST_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: seed }));
    }
    T.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await T.getState().init();
  }

  test('AL-09: the failed resume of a never-messaged agent clears the record, and the next launch offers nothing', async () => {
    const borrowed = globalThis.localStorage;
    globalThis.localStorage = shim;
    try {
      await onWindows(false, async () => {
        const { agent } = startCommand('claude');
        await relaunch({ seed: workspaceRunning(agent) });
        const tab = T.getState().tabs[0];
        assert.equal(tab.agentResumeOffered, true, 'setup: the saved agent is offered');

        await prompt(tab); // the restored shell draws its prompt
        const typed = await holdingWrites(async () => {
          assert.equal(await T.getState().resumeAgent(tab.id), true);
        });
        assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);

        // "No conversation found with session ID …": claude exits 1.
        await prompt(tab, 1);
        assert.equal(tabById(tab.id).agent, null, 'a resume that failed left the record behind');
        assert.equal(tabById(tab.id).agentResumeOffered, false);

        await sleep(400);
        assert.equal(onDisk().tabs[0].agent, null, 'the cleared record never reached disk');

        await relaunch();
        const again = T.getState().tabs[0];
        assert.ok(again, 'the terminal itself did not come back');
        assert.equal(again.agent, null);
        assert.equal(again.agentResumeOffered, false, 'the same dead conversation was offered again');
      });
    } finally {
      T.getState().dispose();
      globalThis.localStorage = borrowed;
    }
  });

  test('AL-10: teardown — nothing is left waiting or running for the next suite', async () => {
    // Every case closed its terminals or disposed the store, and put the hooks
    // back in a finally. What remains is a grace timer that could still land.
    await sleep(GRACE_MS + 50);
    assert.equal(T.getState().tabs.some((t) => t.running), false, 'a terminal is still marked running');
  });
});
