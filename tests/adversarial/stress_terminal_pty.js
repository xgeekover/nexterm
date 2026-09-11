/**
 * NexTerm Adversarial & Stress Test Suite
 * Terminal & PTY Backend (R1) + File Explorer & Monaco Editor (R2)
 */

import assert from 'node:assert/strict';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { MockIpcBridge } from '../e2e/harness/mockIpc.js';
import { parseAnsiTokens, stripAnsi } from '../../src/lib/ansiParser.js';

// Color formatting for console
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const findings = [];

function recordFinding(severity, title, description, reproduction) {
  findings.push({ severity, title, description, reproduction });
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log(`${c.green}PASS${c.reset}`);
  } catch (err) {
    failedTests++;
    console.log(`${c.red}FAIL: ${err.message}${c.reset}`);
  }
}

console.log(`\n${c.bold}${c.cyan}====================================================${c.reset}`);
console.log(`${c.bold}${c.cyan}  NexTerm Adversarial Stress & Bug Hunter Suite     ${c.reset}`);
console.log(`${c.bold}${c.cyan}====================================================${c.reset}\n`);

// =========================================================================
// SECTION 1: TERMINAL BLOCKS & RAPID SEQUENTIAL SUBMISSIONS
// =========================================================================
console.log(`${c.bold}▶ SECTION 1: Terminal Blocks & Command Sequencing${c.reset}`);

await runTest('TC-ADV-TERM-01: Sequential execution with await correctly isolates outputs', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const b1 = await env.executeTerminalCommand('echo 1');
  assert.equal(b1.status, 'completed');
  assert.equal(b1.output.trim(), '1');

  const b2 = await env.executeTerminalCommand('echo 2');
  assert.equal(b2.status, 'completed');
  assert.equal(b2.output.trim(), '2');

  const b3 = await env.executeTerminalCommand('ls');
  assert.equal(b3.status, 'completed');
  assert.ok(b3.output.length > 0);
  env.destroy();
});

await runTest('TC-ADV-TERM-02: Rapid sequential command submissions without waiting (BURST)', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const activeTab = env.getActiveTerminalTab();

  // Rapid dispatch without awaiting each one sequentially
  const p1 = env.executeTerminalCommand('echo 1');
  const p2 = env.executeTerminalCommand('echo 2');
  const p3 = env.executeTerminalCommand('ls');

  await Promise.all([p1, p2, p3]);

  // Check the state of all 3 blocks
  const blocks = activeTab.blocks;
  assert.equal(blocks.length, 3, 'Should have created 3 distinct blocks');

  const b1 = blocks[0];
  const b2 = blocks[1];
  const b3 = blocks[2];

  // BUG INVESTIGATION:
  // In AppEnvironment and terminalStore, output listener updates:
  // tab.blocks[tab.blocks.length - 1]
  // Because all 3 blocks were pushed synchronously, tab.blocks.length - 1 was ALWAYS block 3!
  const b1Finished = b1.status === 'completed';
  const b2Finished = b2.status === 'completed';
  const b3Finished = b3.status === 'completed';

  const b1HasOutput = b1.output.trim() === '1';
  const b2HasOutput = b2.output.trim() === '2';

  if (!b1Finished || !b1HasOutput || !b2Finished || !b2HasOutput) {
    recordFinding(
      'CRITICAL',
      'Rapid sequential terminal commands suffer from Block Output Collision & Orphaned Running State',
      `When multiple commands are submitted rapidly in sequence before PTY output/exit events arrive, ` +
      `the listener indexing logic (tab.blocks[tab.blocks.length - 1]) directs all output to the newest block ` +
      `and leaves previous blocks permanently stuck in 'running' status with empty output. ` +
      `Block 1 status: '${b1.status}', output: '${b1.output}'. Block 2 status: '${b2.status}', output: '${b2.output}'. ` +
      `Block 3 status: '${b3.status}', output: '${b3.output.slice(0, 30)}...'`,
      `Submit multiple commands without awaiting: Promise.all([execute('echo 1'), execute('echo 2'), execute('ls')])`
    );
    throw new Error(`Block output collision: B1 status=${b1.status}, B2 status=${b2.status}, B3 status=${b3.status}`);
  }

  env.destroy();
});

// =========================================================================
// SECTION 2: COMMANDS WITH FAILURE EXIT CODES & UNKNOWN COMMANDS
// =========================================================================
console.log(`\n${c.bold}▶ SECTION 2: Terminal Failure Exit Codes & Error Handling${c.reset}`);

await runTest('TC-ADV-TERM-03: Arbitrary non-existent command flags error and non-zero exit code', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const b = await env.executeTerminalCommand('nonexistent_command_xyz');
  
  if (b.status !== 'failed' || b.exitCode !== 127) {
    recordFinding(
      'HIGH',
      'Non-existent command "nonexistent_command_xyz" incorrectly marked as completed with exit code 0 in MockIpc',
      `Executing an arbitrary non-existent command like 'nonexistent_command_xyz' emits exit_code: 0 and status: 'completed' ` +
      `because MockIpc only checks for hardcoded 'invalid-command-404'. Any real shell returns 127 command not found. ` +
      `Observed: status='${b.status}', exitCode=${b.exitCode}`,
      `await env.executeTerminalCommand('nonexistent_command_xyz'); -> check block.status and block.exitCode`
    );
    throw new Error(`Command was not flagged as failed: status=${b.status}, exitCode=${b.exitCode}`);
  }

  env.destroy();
});

await runTest('TC-ADV-TERM-04: Hardcoded failing test command correctly flags failed status', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const b = await env.executeTerminalCommand('npm test');
  assert.equal(b.status, 'failed');
  assert.equal(b.exitCode, 1);
  assert.ok(b.output.includes('FAIL'));

  env.destroy();
});

await runTest('TC-ADV-TERM-05: Known 404 command flags failed status and exit code 127', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const b = await env.executeTerminalCommand('invalid-command-404');
  assert.equal(b.status, 'failed');
  assert.equal(b.exitCode, 127);
  assert.ok(b.output.includes('command not found'));

  env.destroy();
});

// =========================================================================
// SECTION 3: ANSI ESCAPE PARSER ADVERSARIAL STRESS
// =========================================================================
console.log(`\n${c.bold}▶ SECTION 3: ANSI Color & Escape Sequence Parser Stress${c.reset}`);

await runTest('TC-ADV-ANSI-01: Standard SGR color tokens and styling', async () => {
  const raw = '\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[1mBold\x1b[0m';
  const tokens = parseAnsiTokens(raw);
  assert.ok(tokens.length >= 3);
  assert.ok(tokens[0].className.includes('text-ansi-red'));
  assert.equal(tokens[0].text, 'Red');
  assert.ok(tokens[2].className.includes('text-ansi-green'));
  assert.equal(tokens[2].text, 'Green');
});

await runTest('TC-ADV-ANSI-02: Non-SGR escape sequences (Cursor & Clear Screen) leakage check', async () => {
  // \x1b[2J is clear screen, \x1b[H is cursor home, \x1b[K is clear line
  const raw = '\x1b[2J\x1b[HHello World\x1b[K\nNext line';
  const tokens = parseAnsiTokens(raw);

  // Check if any token text contains raw ESC (\x1b) bytes
  const containsRawEsc = tokens.some((t) => t.text.includes('\x1b'));
  if (containsRawEsc) {
    recordFinding(
      'HIGH',
      'ANSI parser outputs raw escape bytes for non-SGR sequences (cursor moves, screen clears)',
      `parseAnsiTokens uses regex /\\x1b\\[([0-9;]*)m/g which only matches 'm' (SGR sequences). ` +
      `Non-SGR sequences such as \\x1b[2J (clear screen), \\x1b[H (cursor home), \\x1b[K (clear line), ` +
      `and \\x1b[?25h (show cursor) are NOT stripped or parsed, leaving raw '\\x1b[' escape control bytes ` +
      `in the output text rendered to users. Tokens: ${JSON.stringify(tokens)}`,
      `parseAnsiTokens('\\x1b[2J\\x1b[HHello World\\x1b[K')`
    );
    throw new Error(`Raw escape bytes found in token text: ${JSON.stringify(tokens)}`);
  }
});

await runTest('TC-ADV-ANSI-03: 256-color and 24-bit TrueColor sequences handling', async () => {
  const raw = '\x1b[38;5;196m256-Red\x1b[0m \x1b[38;2;255;128;0mTrueColor-Orange\x1b[0m';
  const tokens = parseAnsiTokens(raw);
  // Parser shouldn't crash or output raw escape bytes
  assert.ok(tokens.length >= 2);
  for (const t of tokens) {
    assert.ok(!t.text.includes('\x1b'), 'Tokens must not contain raw escape bytes');
  }
});

await runTest('TC-ADV-ANSI-04: Malformed / partial escape sequences resilience', async () => {
  const malformedInputs = [
    '\x1b[31',             // unclosed
    '\x1b',               // solitary ESC
    '\x1b[m',             // missing code
    '\x1b[;;;m',          // empty parameters
    '\x1b[9999999m',      // out of range code
    null,
    undefined,
    '',
    12345,
  ];

  for (const input of malformedInputs) {
    const tokens = parseAnsiTokens(input);
    assert.ok(Array.isArray(tokens), `Must return array for input: ${input}`);
  }
});

await runTest('TC-ADV-ANSI-05: Massive ANSI payload stress (10,000 colored tokens)', async () => {
  let largeAnsi = '';
  for (let i = 0; i < 5000; i++) {
    largeAnsi += `\x1b[3${i % 8}mtoken_${i}\x1b[0m `;
  }
  const t0 = Date.now();
  const tokens = parseAnsiTokens(largeAnsi);
  const duration = Date.now() - t0;
  assert.ok(tokens.length > 5000);
  assert.ok(duration < 1000, `Parsing 10,000 tokens took ${duration}ms, must be < 1000ms`);
});

// =========================================================================
// SECTION 4: PTY LIFECYCLE, MULTI-TAB & CONCURRENCY
// =========================================================================
console.log(`\n${c.bold}▶ SECTION 4: PTY Lifecycle, Multi-Tab & Concurrency${c.reset}`);

await runTest('TC-ADV-PTY-01: High tab churn (create and close 20 tabs rapidly)', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const createdTabs = [];
  for (let i = 0; i < 20; i++) {
    const tab = await env.createTerminalTab(`Churn Tab ${i}`);
    createdTabs.push(tab);
  }

  assert.equal(env.terminalTabs.length, 21); // initial + 20

  // Close all created tabs
  for (const tab of createdTabs) {
    await env.closeTerminalTab(tab.id);
  }

  assert.equal(env.terminalTabs.length, 1);
  assert.equal(env.activeTerminalTabId, 'tab-term-1');
  env.destroy();
});

await runTest('TC-ADV-PTY-02: Closing the active tab gracefully reallocates active tab', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const t2 = await env.createTerminalTab('Terminal 2');
  const t3 = await env.createTerminalTab('Terminal 3');

  env.switchTerminalTab(t3.id);
  assert.equal(env.activeTerminalTabId, t3.id);

  // Close active tab t3
  await env.closeTerminalTab(t3.id);
  assert.ok(env.activeTerminalTabId === 'tab-term-1' || env.activeTerminalTabId === t2.id);

  // Close all remaining tabs
  await env.closeTerminalTab(t2.id);
  await env.closeTerminalTab('tab-term-1');
  assert.equal(env.terminalTabs.length, 0);
  assert.equal(env.activeTerminalTabId, null);

  env.destroy();
});

await runTest('TC-ADV-PTY-03: Invalid session pty_write cleanly throws error', async () => {
  const ipc = new MockIpcBridge();
  await assert.rejects(
    async () => {
      await ipc.invoke('pty_write', { session_id: 'non-existent-session-999', data: 'ls\n' });
    },
    /PTY session not found/
  );
});

await runTest('TC-ADV-PTY-04: pty_resize bounds clamping', async () => {
  const ipc = new MockIpcBridge();
  const session = await ipc.invoke('pty_spawn', { cols: 80, rows: 24 });
  
  // Test extreme boundaries
  await ipc.invoke('pty_resize', { session_id: session.session_id, cols: 0, rows: 0 });
  const s = ipc.ptySessions.get(session.session_id);
  assert.equal(s.cols, 10, 'Cols clamped to min 10');
  assert.equal(s.rows, 2, 'Rows clamped to min 2');

  await ipc.invoke('pty_resize', { session_id: session.session_id, cols: 10000, rows: 5000 });
  assert.equal(s.cols, 500, 'Cols clamped to max 500');
  assert.equal(s.rows, 200, 'Rows clamped to max 200');
});

// =========================================================================
// SECTION 5: FILE EXPLORER & MONACO EDITOR STRESS
// =========================================================================
console.log(`\n${c.bold}▶ SECTION 5: File Explorer & Monaco Editor Stress${c.reset}`);

await runTest('TC-ADV-FS-01: Reading non-existent file cleanly throws error', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  await assert.rejects(
    async () => {
      await env.openFile('/workspace/non_existent_file_xyz.txt');
    },
    /File not found/
  );

  assert.equal(env.editorTabs.length, 0, 'No invalid tab should be added');
  env.destroy();
});

await runTest('TC-ADV-FS-02: Creating a file that already exists throws conflict error', async () => {
  const ipc = new MockIpcBridge();
  await assert.rejects(
    async () => {
      await ipc.invoke('fs_create_file', { path: '/workspace/package.json' });
    },
    /File already exists/
  );
});

await runTest('TC-ADV-FS-03: Deleting a non-existent path throws not found error', async () => {
  const ipc = new MockIpcBridge();
  await assert.rejects(
    async () => {
      await ipc.invoke('fs_delete_path', { path: '/workspace/ghost_dir/file.txt' });
    },
    /Path does not exist/
  );
});

await runTest('TC-ADV-FS-04: Special character filenames (spaces, Unicode, symbols)', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const specialPaths = [
    '/workspace/src/my file with spaces.js',
    '/workspace/src/한글_테스트_컴포넌트.jsx',
    '/workspace/src/🚀_launch_engine.js',
    '/workspace/src/file_with_symbols!@#$%^&()_+.json',
  ];

  for (const p of specialPaths) {
    await env.ipc.invoke('fs_create_file', { path: p });
    await env.ipc.invoke('fs_write_file', { path: p, content: `// Content for ${p}` });
    const tab = await env.openFile(p);
    assert.equal(tab.filePath, p);
    assert.ok(tab.content.includes(`Content for ${p}`));
    env.closeEditorTab(tab.id);
  }

  env.destroy();
});

await runTest('TC-ADV-FS-05: Deep directory hierarchy traversal (15 nested levels)', async () => {
  const ipc = new MockIpcBridge();
  let currentDir = '/workspace';
  for (let level = 1; level <= 15; level++) {
    currentDir += `/level${level}`;
    await ipc.invoke('fs_create_dir', { path: currentDir });
  }

  const deepFile = `${currentDir}/deep_leaf.txt`;
  await ipc.invoke('fs_create_file', { path: deepFile });
  await ipc.invoke('fs_write_file', { path: deepFile, content: 'Leaf Content' });

  // Read directory hierarchy
  const tree = await ipc.invoke('fs_read_dir', { path: '/workspace', max_depth: 20 });
  assert.ok(tree.length > 0);

  const readBack = await ipc.invoke('fs_read_file', { path: deepFile });
  assert.equal(readBack, 'Leaf Content');
});

await runTest('TC-ADV-FS-06: Rapid dirty buffer editing and save-all synchronization', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const tab1 = await env.openFile('/workspace/src/App.jsx');
  const tab2 = await env.openFile('/workspace/package.json');

  env.editBuffer(tab1.id, '// modified app 1');
  env.editBuffer(tab2.id, '// modified pkg 2');

  assert.equal(tab1.isDirty, true);
  assert.equal(tab2.isDirty, true);

  // Save all
  for (const t of env.editorTabs) {
    if (t.isDirty) await env.saveFile(t.id);
  }

  assert.equal(tab1.isDirty, false);
  assert.equal(tab2.isDirty, false);

  // Verify disk
  assert.equal(await env.ipc.invoke('fs_read_file', { path: '/workspace/src/App.jsx' }), '// modified app 1');
  assert.equal(await env.ipc.invoke('fs_read_file', { path: '/workspace/package.json' }), '// modified pkg 2');

  env.destroy();
});

// =========================================================================
// SUMMARY OF FINDINGS
// =========================================================================
console.log(`\n${c.bold}----------------------------------------------------${c.reset}`);
console.log(`${c.bold}Adversarial Execution Summary:${c.reset}`);
console.log(`  Total Tests:  ${totalTests}`);
console.log(`  Passed:       ${c.green}${passedTests}${c.reset}`);
console.log(`  Failed:       ${failedTests > 0 ? c.red : c.green}${failedTests}${c.reset}`);
console.log(`  Findings:     ${findings.length}`);
console.log(`${c.bold}----------------------------------------------------${c.reset}\n`);

if (findings.length > 0) {
  console.log(`${c.bold}${c.yellow}CRITICAL & HIGH FINDINGS DISCOVERED:${c.reset}`);
  for (const f of findings) {
    console.log(`\n[${f.severity}] ${c.bold}${f.title}${c.reset}`);
    console.log(`  Description:  ${f.description}`);
    console.log(`  Reproduction: ${f.reproduction}`);
  }
}

export { findings, totalTests, passedTests, failedTests };

// A failing check must fail the process, otherwise CI and the runner treat a
// red suite as green (this file previously always exited 0).
if (failedTests > 0) {
  process.exitCode = 1;
}
