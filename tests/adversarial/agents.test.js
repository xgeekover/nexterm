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
