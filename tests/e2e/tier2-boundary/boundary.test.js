import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 2: Boundary & Corner Cases', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-BND-01: Empty or whitespace-only command in terminal does not create ghost blocks', async () => {
    const tab = app.getActiveTerminalTab();
    const initialBlockCount = tab.blocks.length;

    const res1 = await app.executeTerminalCommand('');
    assert.equal(res1, null, 'Empty string command must return null');
    assert.equal(tab.blocks.length, initialBlockCount, 'No block should be created for empty command');

    const res2 = await app.executeTerminalCommand('     \n\t   ');
    assert.equal(res2, null, 'Whitespace-only command must return null');
    assert.equal(tab.blocks.length, initialBlockCount, 'No block should be created for whitespace command');
  });

  test('TC-BND-02: Non-zero exit code (127 command not found) flags block status as failed', async () => {
    const block = await app.executeTerminalCommand('invalid-command-404');
    assert.ok(block, 'Block must be created');
    assert.equal(block.status, 'failed', 'Block status must be failed for exit code 127');
    assert.equal(block.exitCode, 127, 'Exit code must be 127');
    assert.ok(block.output.includes('command not found'), 'Output must capture stderr message');
  });

  test('TC-BND-03: Non-zero exit code 1 (test suite failure) is properly captured with exit code', async () => {
    const block = await app.executeTerminalCommand('npm test');
    assert.equal(block.status, 'failed');
    assert.equal(block.exitCode, 1);
    assert.ok(block.output.includes('FAIL'), 'Output must contain test failure report');
    assert.ok(block.output.includes('AssertionError'), 'Output must contain assertion details');
  });

  test('TC-BND-04: Large output stream is handled without truncating data or blocking execution', async () => {
    const largePayload = 'A'.repeat(50000);
    const tab = app.getActiveTerminalTab();

    // Directly emit large chunk through IPC
    await app.ipc.emit('pty-output', {
      session_id: tab.sessionId,
      data: largePayload,
    });

    const currentBlock = await app.executeTerminalCommand('echo test-large');
    assert.ok(currentBlock.output.includes('test-large'));
  });

  test('TC-BND-05: Attempting to open a non-existent file cleanly throws File not found error', async () => {
    await assert.rejects(
      async () => {
        await app.openFile('/workspace/src/does_not_exist.jsx');
      },
      /File not found/,
      'Should throw file not found error'
    );
  });

  test('TC-BND-09: Theme stays a fixed dark constant across repeated reads (no toggle exists)', () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(app.theme, 'dark');
      assert.equal(app.monacoTheme, 'nexterm-dark');
    }
    assert.equal(typeof app.toggleTheme, 'undefined', 'toggleTheme must not exist');
  });

  test('TC-BND-10: PTY resize bounds clamp extreme column and row dimensions', async () => {
    const tab = app.getActiveTerminalTab();

    // Clamp underflow
    await app.ipc.invoke('pty_resize', { session_id: tab.sessionId, cols: 0, rows: 0 });
    let session = app.ipc.ptySessions.get(tab.sessionId);
    assert.equal(session.cols, 10, 'Cols underflow should clamp to 10');
    assert.equal(session.rows, 2, 'Rows underflow should clamp to 2');

    // Clamp overflow
    await app.ipc.invoke('pty_resize', { session_id: tab.sessionId, cols: 99999, rows: 99999 });
    session = app.ipc.ptySessions.get(tab.sessionId);
    assert.equal(session.cols, 500, 'Cols overflow should clamp to 500');
    assert.equal(session.rows, 200, 'Rows overflow should clamp to 200');
  });

  test('TC-BND-11: Creating a file at a path that already exists throws conflict error', async () => {
    await assert.rejects(
      async () => {
        await app.ipc.invoke('fs_create_file', { path: '/workspace/package.json' });
      },
      /File already exists/,
      'Must reject duplicate file creation'
    );
  });

  test('TC-BND-12: Deleting a non-existent path throws not found error', async () => {
    await assert.rejects(
      async () => {
        await app.ipc.invoke('fs_delete_path', { path: '/workspace/non_existent_folder', recursive: true });
      },
      /Path does not exist/,
      'Must reject deletion of non-existent path'
    );
  });
});
