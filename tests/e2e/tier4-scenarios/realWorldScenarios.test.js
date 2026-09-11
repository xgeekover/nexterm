import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 4: Real-World Scenarios (End-to-End User Journeys)', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-SCENARIO-01: Full Developer Bug-Fixing Journey (Inspect -> Test -> Error -> AI Fix -> Edit -> Retest)', async () => {
    // Step 1: Open project and inspect explorer tree
    const tree = app.explorerTree;
    assert.ok(tree.some((n) => n.path === '/workspace/src/calculator.js'));

    // Step 2: Open terminal and execute tests -> observe failure
    const failBlock = await app.executeTerminalCommand('npm test');
    assert.equal(failBlock.status, 'failed');
    assert.equal(failBlock.exitCode, 1);
    assert.ok(failBlock.output.includes('FAIL'), 'Output must indicate test failure');
    assert.ok(failBlock.output.includes('AssertionError'), 'Output must contain assertion failure details');

    // Step 3: Trigger "Ask AI about this error"
    app.attachContext({
      title: 'Terminal Test Failure',
      content: failBlock.output,
    });
    const aiReply = await app.sendChatMessage('agent-architect-01', 'Diagnose this test failure and provide the corrected code.');
    assert.ok(aiReply);
    assert.equal(aiReply.sender, 'assistant');
    assert.ok(aiReply.text.includes('```'), 'AI reply should contain a markdown code block');
    assert.ok(/fix|solution|calculat|reduce|sum/i.test(aiReply.text), 'AI reply should provide actionable diagnostic advice');

    // Step 4: Open file in Monaco editor and apply the AI-suggested fix
    const editorTab = await app.openFile('/workspace/src/calculator.js');
    const fixedContent = 'export function calculateTotal(items) {\n  return items.reduce((acc, item) => acc + item.price, 0);\n}\n';
    app.editBuffer(editorTab.id, fixedContent);
    assert.equal(editorTab.isDirty, true);

    // Step 5: Save file to disk
    await app.saveFile(editorTab.id);
    assert.equal(editorTab.isDirty, false);

    // Step 6: Re-run test in terminal -> verify clean pass with exit code 0
    const passBlock = await app.executeTerminalCommand('npm test');
    assert.equal(passBlock.status, 'completed');
    assert.equal(passBlock.exitCode, 0);
    assert.ok(passBlock.output.includes('PASS'));

    // Step 7: Verify terminal history contains both blocks
    const activeTab = app.getActiveTerminalTab();
    assert.equal(activeTab.blocks.length, 2);
    assert.equal(activeTab.blocks[0].status, 'failed');
    assert.equal(activeTab.blocks[1].status, 'completed');
  });

  test('TC-SCENARIO-02: Multi-Agent Parallel Orchestration & Telemetry Journey', async () => {
    // Step 1: Inspect initial Mission Control state
    const initialTelemetry = app.getTelemetry();
    assert.ok(initialTelemetry.totalAgents >= 2);

    // Step 2: Register a third agent "Performance Profiler"
    const profiler = await app.createAgent({
      name: 'Performance Profiler',
      role: 'Benchmarking Expert',
      model: 'Gemini 3.8 Flash',
      systemPrompt: 'Profile memory, CPU, and IPC latency.',
    });
    assert.ok(profiler);
    assert.equal(app.agents.length, initialTelemetry.totalAgents + 1);

    // Step 3: Architect finishes its architecture phase
    const architect = app.agents.find((a) => a.name === 'Architect');
    await app.updateAgentStatus(architect.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === architect.id).status, 'completed');
    assert.equal(app.agents.find((a) => a.id === architect.id).progress, 100);

    // Step 4: Dependent agent "Test Engineer" transitions to active
    const testEng = app.agents.find((a) => a.name === 'Test Engineer');
    assert.equal(testEng.status, 'active', 'Test Engineer should now be active');

    // Step 5: Test Engineer executes tasks and completes
    await app.updateAgentStatus(testEng.id, 'completed');
    assert.equal(app.agents.find((a) => a.id === testEng.id).status, 'completed');

    // Step 6: Verify final aggregated telemetry
    const finalTelemetry = app.getTelemetry();
    assert.ok(finalTelemetry.totalTokens >= initialTelemetry.totalTokens);
    assert.equal(finalTelemetry.waitingCount, 0, 'No agents should remain in waiting state');
  });

  test('TC-SCENARIO-03: Keyboard-First Power User Navigation Journey', async () => {
    // Step 1: Start in Dark Theme
    assert.equal(app.theme, 'dark');

    // Step 2: Open Command Palette (⌘K) and navigate to package.json
    app.openCommandPalette();
    const pkgResult = app.searchPalette('package.json');
    assert.ok(pkgResult.files.length > 0);
    await app.executePaletteItem(pkgResult.files[0]);

    const activeTab = app.getActiveEditorTab();
    assert.equal(activeTab.fileName, 'package.json');
    assert.equal(activeTab.language, 'json');

    // Step 3: Switch Theme to Light via Command Palette
    app.openCommandPalette();
    const themeCmd = app.searchPalette('switch').commands.find((c) => c.action === 'switch_theme');
    await app.executePaletteItem(themeCmd);
    assert.equal(app.theme, 'light');
    assert.equal(app.monacoTheme, 'nexterm-light');

    // Step 4: Create a dedicated build terminal tab
    const buildTab = await app.createTerminalTab('Build & Lint');
    assert.equal(app.activeTerminalTabId, buildTab.id);

    // Step 5: Execute build commands
    const b1 = await app.executeTerminalCommand('echo building');
    const b2 = await app.executeTerminalCommand('echo linting');
    assert.equal(buildTab.blocks.length, 2);

    // Step 6: Pin the important build block and clear others
    app.pinBlock(b1.id);
    app.clearTerminalBlocks(buildTab.id);
    assert.equal(buildTab.blocks.length, 1);
    assert.equal(buildTab.blocks[0].id, b1.id);

    // Step 7: Switch back to default terminal tab
    app.switchTerminalTab('tab-term-1');
    assert.equal(app.activeTerminalTabId, 'tab-term-1');
  });

  test('TC-SCENARIO-04: Disaster Recovery & Error Resilience Journey', async () => {
    // Step 1: Execute command and simulate process cancellation / kill
    const activeTab = app.getActiveTerminalTab();
    const block = await app.executeTerminalCommand('echo starting-long-job');
    assert.ok(block);

    // Trigger pty_kill
    await app.ipc.invoke('pty_kill', { session_id: activeTab.sessionId });

    // Step 2: Gracefully handle missing file in editor
    await assert.rejects(
      async () => {
        await app.openFile('/workspace/non_existent_config.json');
      },
      /File not found/,
      'System handles missing file gracefully'
    );
    assert.equal(app.editorTabs.length, 0, 'No corrupt editor tab is created');

    // Step 3: Reject invalid agent submission without corrupting state
    const agentCountBefore = app.agents.length;
    await assert.rejects(
      async () => {
        await app.createAgent({ name: '   ', model: '' });
      },
      /Agent name is required/
    );
    assert.equal(app.agents.length, agentCountBefore, 'Agent store remains clean');

    // Step 4: Verify chat functions with BYOK key update
    app.setByokKey('openaiKey', 'sk-test-resilience-key');
    assert.equal(app.byokSettings.openaiKey, 'sk-test-resilience-key');
  });
});
