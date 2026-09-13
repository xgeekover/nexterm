import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Terminal Blocks & Multi-Tab Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-TERM-01: Shell command execution renders a distinct block container with command text', async () => {
    const activeTab = app.getActiveTerminalTab();
    assert.ok(activeTab, 'Active terminal tab must exist on launch');
    assert.equal(activeTab.blocks.length, 0, 'Initially tab should have 0 blocks');

    const block = await app.executeTerminalCommand('echo "Welcome to NexTerm"');
    assert.ok(block, 'Command execution must return a block object');
    assert.equal(block.command, 'echo "Welcome to NexTerm"');
    assert.equal(activeTab.blocks.length, 1, 'Tab should now have 1 block card');
    assert.equal(activeTab.blocks[0].id, block.id);
  });

  test('TC-TERM-02: Executed command receives stdout data streamed from PTY session into block', async () => {
    const block = await app.executeTerminalCommand('echo hello-world');
    assert.ok(block.output.includes('hello-world'), 'Block output must contain stdout stream text');
  });

  test('TC-TERM-03: Block records execution exit code and duration metadata', async () => {
    const block = await app.executeTerminalCommand('ls');
    assert.equal(block.exitCode, 0, 'Successful command must have exit code 0');
    assert.equal(block.status, 'completed', 'Status should be completed');
    assert.ok(typeof block.durationMs === 'number', 'Duration must be a numeric timestamp in ms');
    assert.ok(block.durationMs >= 0, 'Duration must be non-negative');
  });

  test('TC-TERM-04: Multiple terminal tabs can be opened with independent PTY sessions and switched', async () => {
    const initialTab = app.getActiveTerminalTab();
    assert.equal(app.terminalTabs.length, 1);

    const secondTab = await app.createTerminalTab('Build Server');
    assert.equal(app.terminalTabs.length, 2, 'Should have 2 terminal tabs');
    assert.equal(app.activeTerminalTabId, secondTab.id, 'Active tab should switch to newly created tab');
    assert.notEqual(secondTab.sessionId, initialTab.sessionId, 'Tabs must have distinct PTY sessions');

    // Switch back to initial tab
    app.switchTerminalTab(initialTab.id);
    assert.equal(app.activeTerminalTabId, initialTab.id, 'Active tab should switch back to initial tab');
  });

  test('TC-TERM-05: Block action toolbar supports pinning and unpinning blocks', async () => {
    const block = await app.executeTerminalCommand('pwd');
    assert.equal(block.pinned, false, 'Block should not be pinned by default');

    const isPinned = app.pinBlock(block.id);
    assert.equal(isPinned, true, 'Block pin action should toggle pinned state to true');
    assert.equal(block.pinned, true);

    const isUnpinned = app.pinBlock(block.id);
    assert.equal(isUnpinned, false, 'Second pin action should toggle pinned state back to false');
  });

  test('TC-TERM-06: Clearing terminal blocks preserves pinned blocks and purges unpinned blocks', async () => {
    const block1 = await app.executeTerminalCommand('echo one');
    const block2 = await app.executeTerminalCommand('echo two');
    const activeTab = app.getActiveTerminalTab();
    assert.equal(activeTab.blocks.length, 2);

    // Pin block 1
    app.pinBlock(block1.id);

    // Clear blocks
    app.clearTerminalBlocks();
    assert.equal(activeTab.blocks.length, 1, 'Only pinned block should remain after clear');
    assert.equal(activeTab.blocks[0].id, block1.id, 'Remaining block must be the pinned block 1');
  });

  test('TC-TERM-07: Closing a terminal tab kills the backend PTY session and reallocates active tab', async () => {
    const tab1 = app.getActiveTerminalTab();
    const tab2 = await app.createTerminalTab('Tab 2');
    assert.equal(app.terminalTabs.length, 2);

    // Read these before closing: tabs are live views onto the store, so once
    // the app has dropped tab 2 there is nothing left to read them off.
    const tab2Id = tab2.id;
    const tab2SessionId = tab2.sessionId;

    await app.closeTerminalTab(tab2Id);
    assert.equal(app.terminalTabs.length, 1, 'Should now have 1 tab left');
    assert.equal(app.activeTerminalTabId, tab1.id, 'Active tab should fallback to remaining tab 1');

    // Verify pty_kill call was dispatched to IPC
    const killCalls = app.ipc.getCalls('pty_kill');
    assert.ok(killCalls.length > 0, 'pty_kill must be invoked when tab is closed');
    assert.equal(killCalls[killCalls.length - 1].args.session_id, tab2SessionId);
  });
});
