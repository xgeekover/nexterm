import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Mission Control Agent Cards & New Agent Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-MC-01: Mission Control initializes with >= 2 pre-populated baseline agent cards', () => {
    assert.ok(app.agents.length >= 2, 'Mission Control must have at least 2 baseline agents');

    const architect = app.agents.find((a) => a.name === 'Architect');
    assert.ok(architect, 'Architect agent must be present');
    assert.equal(architect.role, 'System Architect');
    assert.equal(architect.model, 'Claude Opus 4.6');

    const testEng = app.agents.find((a) => a.name === 'Test Engineer');
    assert.ok(testEng, 'Test Engineer agent must be present');
    assert.equal(testEng.role, 'QA & E2E Specialist');
    assert.equal(testEng.model, 'Gemini 3.8 Flash');
  });

  test('TC-MC-02: Agent cards display current status and progress metrics', () => {
    const architect = app.agents.find((a) => a.name === 'Architect');
    assert.equal(architect.status, 'active');
    assert.equal(architect.progress, 78);
    assert.equal(architect.tokens, 12431);

    const testEng = app.agents.find((a) => a.name === 'Test Engineer');
    assert.equal(testEng.status, 'waiting');
    assert.equal(testEng.progress, 0);
  });

  test('TC-MC-03: New Agent modal creates and registers a new agent card in the dashboard', async () => {
    const initialCount = app.agents.length;

    const created = await app.createAgent({
      name: 'Performance Profiler',
      role: 'Benchmarking Expert',
      model: 'GPT-4o',
      systemPrompt: 'Profile memory and frame render rates.',
    });

    assert.ok(created, 'Agent creation must return agent object');
    assert.ok(created.id.startsWith('agent-'), 'Agent must have unique ID');
    assert.equal(created.name, 'Performance Profiler');
    assert.equal(created.status, 'active');
    assert.equal(app.agents.length, initialCount + 1, 'Agent list must increment by 1');
  });

  test('TC-MC-04: Agent lifecycle controls allow updating status (pause, resume, complete)', async () => {
    const architect = app.agents.find((a) => a.name === 'Architect');

    // Pause agent
    const paused = await app.updateAgentStatus(architect.id, 'paused');
    assert.equal(paused.status, 'paused');
    assert.equal(app.agents.find((a) => a.id === architect.id).status, 'paused');

    // Resume agent
    const resumed = await app.updateAgentStatus(architect.id, 'active');
    assert.equal(resumed.status, 'active');
  });

  test('TC-MC-05: Streamed agent logs drawer retrieves execution logs with timestamp and severity', async () => {
    const architect = app.agents.find((a) => a.name === 'Architect');
    const logs = await app.ipc.invoke('agent_get_logs', { agent_id: architect.id });

    assert.ok(Array.isArray(logs), 'Logs must be an array');
    assert.ok(logs.length > 0, 'Architect agent must have execution logs');
    assert.ok(logs[0].level, 'Log entry must have level');
    assert.ok(logs[0].message, 'Log entry must have message');
    assert.ok(logs[0].timestamp, 'Log entry must have timestamp');
  });

  test('TC-MC-06: Agent dependency chaining activates dependent agent upon predecessor completion', async () => {
    const architect = app.agents.find((a) => a.name === 'Architect');
    const testEng = app.agents.find((a) => a.name === 'Test Engineer');

    assert.equal(testEng.dependency, architect.id, 'Test Engineer depends on Architect');
    assert.equal(testEng.status, 'waiting', 'Test Engineer is waiting');

    // Complete architect agent
    await app.updateAgentStatus(architect.id, 'completed');

    // Test Engineer should now be automatically unblocked and active
    const updatedTestEng = app.agents.find((a) => a.id === testEng.id);
    assert.equal(updatedTestEng.status, 'active', 'Dependent agent must transition to active');
  });

  test('TC-MC-07: Mission Control computes aggregated token count and cost telemetry', () => {
    const telemetry = app.getTelemetry();
    assert.ok(telemetry.totalTokens > 0, 'Total tokens should be computed from agents');
    assert.ok(telemetry.totalCost > 0, 'Total cost should be computed');
    assert.ok(telemetry.totalAgents >= 2, 'Total agents count should be tracked');
    assert.equal(typeof telemetry.activeCount, 'number');
    assert.equal(typeof telemetry.waitingCount, 'number');
  });
});
