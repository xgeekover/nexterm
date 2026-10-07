/**
 * NexTerm Adversarial & Stress Test Suite
 * Terminal & PTY Backend (R1) + File Explorer & Monaco Editor (R2)
 */

import assert from 'node:assert/strict';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { MockIpcBridge } from '../e2e/harness/mockIpc.js';

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
// SECTION 1: PTY LIFECYCLE, MULTI-TAB & CONCURRENCY
// =========================================================================
console.log(`${c.bold}▶ SECTION 1: PTY Lifecycle, Multi-Tab & Concurrency${c.reset}`);

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
// SECTION 2: FILE EXPLORER & MONACO EDITOR STRESS
// =========================================================================
console.log(`\n${c.bold}▶ SECTION 2: File Explorer & Monaco Editor Stress${c.reset}`);

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
