import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 3: Cross-Feature Combinations (Pairwise Interactions)', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-XF-01: Terminal Error -> Ask AI Chat context injection and solution streaming', async () => {
    // 1. Run failing command in Terminal
    const failedBlock = await app.executeTerminalCommand('npm test');
    assert.equal(failedBlock.status, 'failed');
    assert.equal(failedBlock.exitCode, 1);

    // 2. Click "Ask AI about this error" on the block
    app.attachContext({
      title: `Terminal Error: ${failedBlock.command}`,
      content: failedBlock.output,
    });

    // 3. Send query to AI Chat
    const chatResponse = await app.sendChatMessage('agent-architect-01', 'Explain why this test failed and propose a fix');
    assert.ok(chatResponse);

    // 4. Verify context was forwarded
    const lastChatCall = app.ipc.getCalls('chat_send_message').pop();
    assert.ok(lastChatCall.args.message.includes('Terminal Error: npm test'), 'Context header should contain failing command');
    assert.ok(lastChatCall.args.message.includes('AssertionError: expected 30, got 0'), 'Context must contain exact error output');
  });

  test('TC-XF-02: Explorer Click -> Monaco Edit -> Save -> Run in Terminal', async () => {
    // 1. Click file in Explorer
    const targetPath = '/workspace/src/calculator.js';
    const editorTab = await app.openFile(targetPath);
    assert.equal(editorTab.filePath, targetPath);
    assert.equal(editorTab.isDirty, false);

    // 2. Edit code in Monaco editor
    const fixedCode = 'export function calculateTotal(items) {\n  return items.reduce((acc, item) => acc + item.price, 0);\n}\n';
    app.editBuffer(editorTab.id, fixedCode);
    assert.equal(editorTab.isDirty, true, 'Editor tab should be marked dirty');

    // 3. Save file to disk
    await app.saveFile(editorTab.id);
    assert.equal(editorTab.isDirty, false, 'Editor tab should no longer be dirty');

    // Verify disk content
    const diskContent = await app.ipc.invoke('fs_read_file', { path: targetPath });
    assert.equal(diskContent, fixedCode, 'Filesystem must be updated with saved content');

    // 4. Run tests in Terminal
    const testBlock = await app.executeTerminalCommand('npm test');
    assert.equal(testBlock.status, 'completed');
    assert.equal(testBlock.exitCode, 0, 'Test must exit with 0 code after fix is saved');
    assert.ok(testBlock.output.includes('PASS'));
  });

  test('TC-XF-03: New Agent in Mission Control -> Streamed Logs -> AI Chat Context', async () => {
    // 1. Create new agent in Mission Control
    const auditor = await app.createAgent({
      name: 'Security Auditor',
      role: 'Vulnerability Scanner',
      model: 'Claude Opus 4.6',
      systemPrompt: 'Scan dependencies and static code for vulnerabilities.',
    });
    assert.ok(auditor);

    // 2. Stream agent logs via event
    const logEntry = {
      id: 'log-sec-101',
      timestamp: Date.now(),
      level: 'WARN',
      message: 'Detected outdated parser dependency in package.json',
    };
    await app.ipc.emit('agent-log', logEntry);

    // 3. In AI chat, query agent findings
    app.attachContext({
      title: `Agent Logs: ${auditor.name}`,
      content: `${logEntry.level}: ${logEntry.message}`,
    });

    const reply = await app.sendChatMessage('agent-architect-01', 'Summarize security auditor warnings');
    assert.ok(reply);

    const chatCall = app.ipc.getCalls('chat_send_message').pop();
    assert.ok(chatCall.args.message.includes('Detected outdated parser dependency'));
  });

  test('TC-XF-04: Command Palette Open File -> Edit in Monaco -> Quick Palette Action Save All', async () => {
    // 1. Open file via Command Palette
    app.openCommandPalette();
    const search = app.searchPalette('README');
    assert.ok(search.files.length > 0);
    await app.executePaletteItem(search.files[0]);

    const activeTab = app.getActiveEditorTab();
    assert.equal(activeTab.fileName, 'README.md');

    // 2. Edit content
    app.editBuffer(activeTab.id, '# NexTerm v2\nUpdated from Command Palette.\n');
    assert.equal(activeTab.isDirty, true);

    // 3. Open Command Palette and execute "Save All Files"
    app.openCommandPalette();
    const cmdSearch = app.searchPalette('save all');
    assert.ok(cmdSearch.commands.length > 0);
    await app.executePaletteItem(cmdSearch.commands[0]);

    assert.equal(activeTab.isDirty, false, 'Tab should be saved after palette Save All action');
  });

  test('TC-XF-05: Theme Switch -> Monaco Theme Sync -> Terminal Theme Sync', async () => {
    // 1. Initial dark state
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');

    // 2. Open an editor tab and execute a terminal command
    await app.openFile('/workspace/src/App.jsx');
    const block = await app.executeTerminalCommand('ls');

    // 3. Switch theme to light
    app.toggleTheme();
    assert.equal(app.theme, 'light');
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco must update to vs-light');

    // 4. Verify terminal remains interactive and accepts commands under light theme
    const lightBlock = await app.executeTerminalCommand('pwd');
    assert.equal(lightBlock.status, 'completed');
  });

  test('TC-XF-06: Mission Control Agent Dependency Chain -> Terminal Trigger', async () => {
    const architect = app.agents.find((a) => a.name === 'Architect');
    const testEng = app.agents.find((a) => a.name === 'Test Engineer');
    assert.equal(testEng.status, 'waiting');

    // 1. Mark Architect completed
    await app.updateAgentStatus(architect.id, 'completed');

    // 2. Test Engineer automatically unblocks
    const unblockedEng = app.agents.find((a) => a.id === testEng.id);
    assert.equal(unblockedEng.status, 'active');

    // 3. Test Engineer applies verified fix and triggers test run in Terminal
    await app.ipc.invoke('fs_write_file', {
      path: '/workspace/src/calculator.js',
      content: 'export function calculateTotal(items) {\n  return items.reduce((acc, item) => acc + item.price, 0);\n}\n',
    });
    const block = await app.executeTerminalCommand('npm test');
    assert.equal(block.exitCode, 0);
    assert.equal(block.status, 'completed');
  });
});
