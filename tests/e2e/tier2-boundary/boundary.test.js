import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 2: Boundary & Corner Cases', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-BND-02: Non-zero exit code (127 command not found) is kept on the tab', async () => {
    const run = await app.runTerminalCommand('invalid-command-404');
    assert.equal(run.exitCode, 127, 'Exit code must be 127');
    assert.equal(app.getActiveTerminalTab().lastExitCode, 127, 'The tab keeps it for the tab strip and the status bar');
    assert.ok(run.output.includes('command not found'), "The terminal must show the shell's message");
  });

  test('TC-BND-03: Non-zero exit code 1 (test suite failure) is properly captured with exit code', async () => {
    const run = await app.runTerminalCommand('npm test');
    assert.equal(run.exitCode, 1);
    assert.ok(run.output.includes('FAIL'), 'Output must contain test failure report');
    assert.ok(run.output.includes('AssertionError'), 'Output must contain assertion details');
  });

  test('TC-BND-04: Large output stream is handled without truncating data or blocking execution', async () => {
    const largePayload = 'A'.repeat(50000);
    const tab = app.getActiveTerminalTab();

    // Directly emit large chunk through IPC, before anything shows the tab
    await app.ipc.emit('pty-output', {
      session_id: tab.sessionId,
      data: largePayload,
    });

    const run = await app.runTerminalCommand('echo test-large');
    assert.equal(run.exitCode, 0, 'The next command must still run');
    assert.ok(run.output.includes('test-large'));
    assert.ok(app.terminalOutput(tab.id).includes(largePayload), 'The large chunk must reach the terminal whole');
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
