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
 * The record now ends with the agent. The shell reports "D" (OSC 133) when a
 * command ends, and the agent has exited at the first D after its command
 * went out that arrives while the terminal is running something — a C was
 * seen, or on Windows the line has gone unanswered long enough to count as
 * running. The offer is then only made for an agent still running when the
 * app closed.
 *
 * Not every D is a command ending. The shell's first prompt sends one; so do
 * a second integration in the user's rc (iTerm2's prints its own D before
 * NexTerm's at every prompt), a D the user put in cmd's PROMPT themselves
 * (Windows Terminal's documented setup), and a transient prompt redrawn on
 * Enter (oh-my-posh, starship), or zsh-defer re-running precmd. All of those
 * arrive at a prompt, with nothing running, and none of them counts.
 *
 * The agent is typed only once the shell has drawn its first prompt, which
 * stops the command being echoed twice (once by the tty as typeahead, once
 * more by the line editor). A shell that never reports a D (fish, sh) is
 * typed into anyway once the wait is up, and keeps its record as before.
 *
 * And that first prompt must not be missed. A light zsh draws it within tens
 * of milliseconds of being spawned and cmd sooner — while the app is still
 * restoring the workspace, before the store listened or before the tab
 * holding that shell existed. Lost, it made a restored shell look like one
 * that never reports anything: Resume sat out the wait and was not watched.
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

/** The shell started running the line: OSC 133 C. */
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });

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

/**
 * Shells that draw their first prompt at once: every `pty_spawn` in `fn`
 * reports its session's first D before the spawn has even returned — so
 * before any terminal in the store holds that session.
 */
async function promptingAtSpawn(exitCode, fn) {
  const original = mockBridge.invoke;
  mockBridge.invoke = async function (command, args, ...rest) {
    const result = await original.call(this, command, args, ...rest);
    if (command === 'pty_spawn') {
      await mockBridge.emit('pty-command-done', { session_id: result.session_id, exit_code: exitCode });
    }
    return result;
  };
  try {
    return await fn();
  } finally {
    mockBridge.invoke = original;
  }
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

// ---- A disk of our own, for the cases that relaunch -----------------------

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

/** `fn` with this file's localStorage in place, handed back — and the store disposed — however it ends. */
async function withOwnDisk(fn) {
  const borrowed = globalThis.localStorage;
  globalThis.localStorage = shim;
  try {
    await fn();
  } finally {
    T.getState().dispose();
    globalThis.localStorage = borrowed;
  }
}

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
      withPromptWait(300, async () => {
        const opened = Date.now();
        const tab = await freshTerminal();
        try {
          let agent;
          await holdingWrites(async (typed) => {
            agent = await T.getState().startAgent(tab.id, 'claude');
            assert.ok(agent, 'startAgent gave up on a shell that sends no D');
            assert.deepEqual(typed, [`claude --session-id ${agent.sessionId}\r`], 'never typed at all');
          });
          // The wait runs from the spawn, which came after `opened`, so a slow
          // machine only makes this longer. Half the wait is the bound.
          assert.ok(Date.now() - opened >= 150, 'typed before the shell had its chance to draw a prompt');

          // Typed with no prompt to go by, nothing says where that line
          // stands, so nothing is watched: a late first prompt, and a command
          // starting and ending after it, leave the record as it always was.
          await prompt(tab);
          await started(tab);
          await prompt(tab);
          assert.deepEqual(tabById(tab.id).agent, agent, 'a record typed without a prompt to go by was ended');
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
        await started(other);
        await prompt(other, 1);
        assert.deepEqual(tabById(tab.id).agent, agent, "another terminal's D ended this terminal's agent");

        // claude runs, then the user quits it and the shell draws its prompt.
        await started(tab);
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
    // agent is running only by inference from its submitted line, and the C
    // comes out at the end, just before the D.
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

        await started(tab);
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

        // The new shell draws its prompt, runs a command, finishes it.
        setSession(replacement.session_id);
        const next = { sessionId: replacement.session_id };
        await prompt(next);
        await started(next);
        await prompt(next);
        assert.deepEqual(tabById(tab.id).agent, agent, "the new shell's command was taken for the agent exiting");
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

        await started(tab);
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

        await started(tab);
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
      withPromptWait(600, async () => {
        const tab = await freshTerminal();
        try {
          await sleep(650);
          const { agent } = startCommand('claude');
          offer(tab, agent);

          // Waiting again would take the whole 600 ms; half of it is the
          // bound, so a slow machine has 300 ms to spare either way.
          const clicked = Date.now();
          const typed = await holdingWrites(async () => {
            assert.equal(await T.getState().resumeAgent(tab.id), true);
          });
          assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);
          assert.ok(Date.now() - clicked < 300, `Resume waited ${Date.now() - clicked}ms for a prompt that was never coming`);
        } finally {
          await T.getState().closeTab(tab.id);
        }
      })
    );
  });
});

describe('Only a command ending is the agent exiting', () => {
  test('AL-12: a second integration in the rc — two D\'s at every prompt — keeps the record until the agent exits', async () => {
    // iTerm2's zsh integration (active whenever TERM_PROGRAM is unset, as in
    // a Finder launch) prints its own `133;D;0;aid=…` before NexTerm's
    // `133;D;0` at every prompt. The first says the prompt is there, so the
    // agent is typed between the two, and the second only says it again.
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      try {
        let agent;
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab, null); // iTerm2's: the `;aid=` after the code leaves none
          agent = await pending;
          await prompt(tab, 0); // NexTerm's, for the same prompt
        });
        assert.deepEqual(tabById(tab.id).agent, agent, 'the record went before claude even started');

        await started(tab);
        assert.deepEqual(tabById(tab.id).agent, agent);
        // claude exits: the same pair, for a command that ended.
        await prompt(tab, null);
        await prompt(tab, 0);
        assert.equal(tabById(tab.id).agent, null, 'the agent exited and the record stayed');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test("AL-13: a D of the user's own in cmd's PROMPT — two at every prompt — keeps the record", async () => {
    // Windows Terminal's documented cmd setup puts `$e]133;D$e\` in the
    // user's PROMPT, and NexTerm draws the user's PROMPT after its own D:
    // two D's, neither with a code, every time cmd draws a prompt.
    await onWindows(true, async () => {
      const tab = await freshTerminal();
      try {
        let agent;
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab, null); // NexTerm's
          agent = await pending;
          await prompt(tab, null); // the user's, for the same prompt
        });
        assert.deepEqual(tabById(tab.id).agent, agent, 'the record went before claude even started');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-14: a prompt redrawn on Enter says nothing about the agent — nothing is running yet', async () => {
    // A transient prompt (oh-my-posh, starship) is redrawn the moment Enter
    // is pressed, and in PowerShell that runs `prompt`, NexTerm's hook and
    // all, so a D comes out before the command's C. zsh-defer re-running
    // precmd once its deferred loading is done looks the same.
    await onWindows(false, async () => {
      const tab = await freshTerminal();
      try {
        let agent;
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab);
          agent = await pending;
        });
        await prompt(tab); // the redraw on Enter
        assert.deepEqual(tabById(tab.id).agent, agent, 'the record went before claude even started');

        await started(tab);
        await prompt(tab);
        assert.equal(tabById(tab.id).agent, null, 'the agent exited and the record stayed');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-15: cmd — the agent runs by inference from its unanswered line, and the next prompt ends it and the record', async () => {
    // cmd sends no C at all, so this is the only way its agent is running.
    await onWindows(true, async () => {
      const tab = await freshTerminal();
      try {
        await holdingWrites(async () => {
          const pending = T.getState().startAgent(tab.id, 'claude');
          await prompt(tab, null); // cmd's first prompt
          await pending;
        });
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, true, 'setup: the agent reads as running');

        await prompt(tab, null); // claude exits and cmd draws its prompt
        assert.equal(tabById(tab.id).agent, null, 'the agent exited and the record stayed');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });

  test('AL-16: cmd — a resume that fails before its line counts as running is not counted, and the record stays', async () => {
    // Pinned, not wanted. cmd sends no C, and its line counts as running only
    // once SUBMIT_GRACE_MS has passed unanswered. A `claude --resume` that
    // gives up sooner — "No conversation found" — ends at what looks like a
    // prompt drawn twice, so the record is kept and offered once more.
    await onWindows(true, async () => {
      const tab = await freshTerminal();
      try {
        await prompt(tab, null);
        const { agent } = startCommand('claude');
        offer(tab, agent);
        const typed = await holdingWrites(async () => {
          assert.equal(await T.getState().resumeAgent(tab.id), true);
        });
        assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);

        await prompt(tab, null); // it failed at once
        assert.deepEqual(tabById(tab.id).agent, agent, 'a D at a prompt was taken for the agent exiting');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, false, 'a line the shell had answered was inferred as running');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });
});

describe("A shell's first prompt is never missed", () => {
  test('AL-17: a restored shell whose prompt came before its tab — Resume types at once, and is watched', async () => {
    await withOwnDisk(() =>
      onWindows(false, async () => {
        const { agent } = startCommand('claude');
        await promptingAtSpawn(0, () => relaunch({ seed: workspaceRunning(agent) }));
        const tab = T.getState().tabs[0];
        assert.equal(tab.agentResumeOffered, true, 'setup: the saved agent is offered');

        const clicked = Date.now();
        const typed = await holdingWrites(async () => {
          assert.equal(await T.getState().resumeAgent(tab.id), true);
        });
        assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);
        assert.ok(
          Date.now() - clicked < 1500,
          `Resume waited ${Date.now() - clicked}ms for a prompt the shell had already drawn`
        );

        await started(tab);
        await prompt(tab, 1);
        assert.equal(tabById(tab.id).agent, null, 'the resumed agent exited and the record stayed');
      })
    );
  });

  test("AL-18: a restored cmd terminal's first command reads as running, though its prompt came before its tab", async () => {
    // V14 on cmd. The inference only runs for a session that has reported a
    // D, and a first prompt lost to the restore kept it off for good.
    await withOwnDisk(() =>
      onWindows(true, async () => {
        await promptingAtSpawn(null, () => relaunch({ seed: workspaceRunning(null) }));
        const tab = T.getState().tabs[0];
        await T.getState().writeRaw(tab.id, '\r');
        await sleep(GRACE_MS + 150);
        assert.equal(tabById(tab.id).running, true, 'a running cmd command read as idle, and Resume would type into it');
        await prompt(tab, null);
      })
    );
  });

  test('AL-19: a new terminal whose prompt came before its tab — the agent is typed at once, and watched', async () => {
    await onWindows(false, async () => {
      await T.getState().init();
      const tab = await promptingAtSpawn(0, () => T.getState().createTab());
      try {
        const asked = Date.now();
        let agent;
        const typed = await holdingWrites(async () => {
          agent = await T.getState().startAgent(tab.id, 'claude');
        });
        assert.deepEqual(typed, [`claude --session-id ${agent.sessionId}\r`]);
        assert.ok(Date.now() - asked < 1500, `waited ${Date.now() - asked}ms for a prompt the shell had already drawn`);

        await started(tab);
        await prompt(tab);
        assert.equal(tabById(tab.id).agent, null, 'the agent exited and the record stayed');
      } finally {
        await T.getState().closeTab(tab.id);
      }
    });
  });
});

describe('A conversation that never started is offered once, not forever', () => {
  test('AL-09: the failed resume of a never-messaged agent clears the record, and the next launch offers nothing', async () => {
    await withOwnDisk(() =>
      onWindows(false, async () => {
        const { agent } = startCommand('claude');
        await relaunch({ seed: workspaceRunning(agent) });
        const tab = T.getState().tabs[0];
        assert.equal(tab.agentResumeOffered, true, 'setup: the saved agent is offered');

        await prompt(tab); // the restored shell draws its prompt
        const typed = await holdingWrites(async () => {
          assert.equal(await T.getState().resumeAgent(tab.id), true);
        });
        assert.deepEqual(typed, [`claude --resume ${agent.sessionId}\r`]);

        // "No conversation found with session ID …": claude starts, and exits 1.
        await started(tab);
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
      })
    );
  });

  test('AL-10: teardown — nothing is left waiting or running for the next suite', async () => {
    // Every case closed its terminals or disposed the store, and put the hooks
    // back in a finally. What remains is a grace timer that could still land.
    await sleep(GRACE_MS + 50);
    assert.equal(T.getState().tabs.some((t) => t.running), false, 'a terminal is still marked running');
  });
});
