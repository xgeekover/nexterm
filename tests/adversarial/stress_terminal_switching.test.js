/**
 * NexTerm Adversarial Stress Test Suite:
 * Rapid Terminal Commands & Multi-Session Tab Switching
 */

import assert from 'node:assert/strict';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

// Console color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

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
    if (err.stack) {
      console.error(err.stack);
    }
  }
}

console.log(`\n${c.bold}${c.cyan}====================================================${c.reset}`);
console.log(`${c.bold}${c.cyan}  NexTerm Adversarial Stress: Commands & Switching   ${c.reset}`);
console.log(`${c.bold}${c.cyan}====================================================${c.reset}\n`);

// =========================================================================
// TEST 1: Rapid 50-command burst in a single terminal tab
// =========================================================================
await runTest('TC-ADV-SW-01: High-volume 50-command burst in single tab preserves strict FIFO ordering', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const tab = env.getActiveTerminalTab();
  const COUNT = 50;
  const promises = [];

  for (let i = 0; i < COUNT; i++) {
    promises.push(env.executeTerminalCommand(`echo burst_${i}`));
  }

  await Promise.all(promises);

  assert.equal(tab.blocks.length, COUNT, `Expected ${COUNT} blocks, got ${tab.blocks.length}`);

  for (let i = 0; i < COUNT; i++) {
    const b = tab.blocks[i];
    assert.equal(b.status, 'completed', `Block ${i} status should be completed, got ${b.status}`);
    assert.equal(b.exitCode, 0, `Block ${i} exitCode should be 0, got ${b.exitCode}`);
    assert.equal(b.command, `echo burst_${i}`, `Block ${i} command mismatch`);
    assert.equal(b.output.trim(), `burst_${i}`, `Block ${i} output mismatch: expected 'burst_${i}', got '${b.output.trim()}'`);
  }

  env.destroy();
});

// =========================================================================
// TEST 2: Interleaved commands across 5 tabs with concurrent session switching
// =========================================================================
await runTest('TC-ADV-SW-02: Interleaved multi-tab concurrent execution with rapid session switching', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  // Create 4 additional tabs (5 total)
  const tabIds = [env.getActiveTerminalTab().id];
  for (let i = 2; i <= 5; i++) {
    const t = await env.createTerminalTab(`Terminal ${i}`);
    tabIds.push(t.id);
  }
  assert.equal(env.terminalTabs.length, 5);

  // Define commands per tab
  const tabCommands = {
    [tabIds[0]]: ['echo tab0_1', 'echo tab0_2', 'pwd'],
    [tabIds[1]]: ['echo tab1_1', 'echo tab1_2', 'whoami'],
    [tabIds[2]]: ['echo tab2_1', 'date', 'echo tab2_3'],
    [tabIds[3]]: ['git status', 'echo tab3_2', 'git branch'],
    [tabIds[4]]: ['echo tab4_1', 'echo tab4_2', 'echo tab4_3'],
  };

  const commandPromises = [];

  // Launch commands across tabs in interleaved round-robin fashion
  for (let cmdIdx = 0; cmdIdx < 3; cmdIdx++) {
    for (let tabIdx = 0; tabIdx < 5; tabIdx++) {
      const currentTabId = tabIds[tabIdx];
      const cmd = tabCommands[currentTabId][cmdIdx];

      // Rapidly switch active tab before dispatch
      env.switchTerminalTab(currentTabId);
      assert.equal(env.activeTerminalTabId, currentTabId);

      commandPromises.push(env.executeTerminalCommand(cmd, currentTabId));
    }
  }

  // Simultaneously perform rapid session switching while promises resolve
  for (let s = 0; s < 25; s++) {
    const randomTabId = tabIds[s % tabIds.length];
    env.switchTerminalTab(randomTabId);
  }

  await Promise.all(commandPromises);

  // Validate isolation for each tab
  for (let tabIdx = 0; tabIdx < 5; tabIdx++) {
    const targetTabId = tabIds[tabIdx];
    const targetTab = env.terminalTabs.find((t) => t.id === targetTabId);
    assert.ok(targetTab, `Tab ${targetTabId} must exist`);
    assert.equal(targetTab.blocks.length, 3, `Tab ${tabIdx} should have 3 blocks`);

    const expectedCmds = tabCommands[targetTabId];
    for (let bIdx = 0; bIdx < 3; bIdx++) {
      const block = targetTab.blocks[bIdx];
      assert.equal(block.command, expectedCmds[bIdx]);
      assert.equal(block.status, 'completed', `Block ${bIdx} in tab ${tabIdx} must be completed`);
      assert.equal(block.exitCode, 0, `Block ${bIdx} in tab ${tabIdx} must have exitCode 0`);
      assert.ok(block.output.length > 0, `Block ${bIdx} in tab ${tabIdx} must have output`);

      // Ensure no crosstalk: verify output doesn't contain output from other tabs
      for (let otherIdx = 0; otherIdx < 5; otherIdx++) {
        if (otherIdx !== tabIdx) {
          assert.ok(
            !block.output.includes(`tab${otherIdx}_`),
            `Crosstalk detected! Tab ${tabIdx} block output contains tab${otherIdx} string: ${block.output}`
          );
        }
      }
    }
  }

  env.destroy();
});

// =========================================================================
// TEST 3: Mixed valid and non-existent commands burst with session switching
// =========================================================================
await runTest('TC-ADV-SW-03: Alternating success and failure commands under rapid switching', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const t1 = env.getActiveTerminalTab();
  const t2 = await env.createTerminalTab('Terminal 2');

  // Submit mixed commands to t1 and t2
  const t1Cmds = [
    { cmd: 'echo valid_1', expectSuccess: true, expectCode: 0 },
    { cmd: 'nonexistent_foo_123', expectSuccess: false, expectCode: 127 },
    { cmd: 'echo valid_2', expectSuccess: true, expectCode: 0 },
    { cmd: 'nonexistent_bar_456', expectSuccess: false, expectCode: 127 },
  ];

  const t2Cmds = [
    { cmd: 'unknown_cmd_t2_1', expectSuccess: false, expectCode: 127 },
    { cmd: 'echo t2_ok', expectSuccess: true, expectCode: 0 },
    { cmd: 'unknown_cmd_t2_2', expectSuccess: false, expectCode: 127 },
  ];

  const p1 = Promise.all(t1Cmds.map((c) => env.executeTerminalCommand(c.cmd, t1.id)));
  env.switchTerminalTab(t2.id);
  const p2 = Promise.all(t2Cmds.map((c) => env.executeTerminalCommand(c.cmd, t2.id)));
  env.switchTerminalTab(t1.id);

  await Promise.all([p1, p2]);

  // Check t1 blocks
  assert.equal(t1.blocks.length, 4);
  for (let i = 0; i < 4; i++) {
    const b = t1.blocks[i];
    const spec = t1Cmds[i];
    assert.equal(b.command, spec.cmd);
    assert.equal(b.status, spec.expectSuccess ? 'completed' : 'failed');
    assert.equal(b.exitCode, spec.expectCode);
  }

  // Check t2 blocks
  assert.equal(t2.blocks.length, 3);
  for (let i = 0; i < 3; i++) {
    const b = t2.blocks[i];
    const spec = t2Cmds[i];
    assert.equal(b.command, spec.cmd);
    assert.equal(b.status, spec.expectSuccess ? 'completed' : 'failed');
    assert.equal(b.exitCode, spec.expectCode);
  }

  env.destroy();
});

// =========================================================================
// TEST 4: Closing active and background tabs while commands are in flight
// =========================================================================
await runTest('TC-ADV-SW-04: Closing background and active tabs with queued commands does not crash', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const tabA = env.getActiveTerminalTab();
  const tabB = await env.createTerminalTab('Terminal B');
  const tabC = await env.createTerminalTab('Terminal C');

  // Queue commands in tabB
  const pB1 = env.executeTerminalCommand('echo b_1', tabB.id);
  const pB2 = env.executeTerminalCommand('echo b_2', tabB.id);

  // Close tabB immediately while commands were initiated
  await env.closeTerminalTab(tabB.id);

  // tabB should no longer be in terminalTabs
  assert.ok(!env.terminalTabs.some((t) => t.id === tabB.id));

  // Now execute in tabC and tabA
  const bA = await env.executeTerminalCommand('echo a_ok', tabA.id);
  const bC = await env.executeTerminalCommand('echo c_ok', tabC.id);

  assert.equal(bA.status, 'completed');
  assert.equal(bA.output.trim(), 'a_ok');
  assert.equal(bC.status, 'completed');
  assert.equal(bC.output.trim(), 'c_ok');

  env.destroy();
});

// =========================================================================
// TEST 5: Direct Zustand useTerminalStore stress testing
// =========================================================================
await runTest('TC-ADV-SW-05: Direct useTerminalStore concurrent tab operations & session switching', async () => {
  const store = useTerminalStore.getState();
  await store.init();

  const initialTab = store.getActiveTab();
  assert.ok(initialTab);

  // Create 2 new tabs
  const t2 = await store.createTab('Zustand Tab 2');
  const t3 = await store.createTab('Zustand Tab 3');

  assert.ok(useTerminalStore.getState().tabs.length >= 3);

  // Switch to t2
  store.switchTab(t2.id);
  assert.equal(useTerminalStore.getState().activeTabId, t2.id);

  // Burst commands in t2
  const p1 = store.executeCommand('echo zustand_t2_1', t2.id);
  const p2 = store.executeCommand('echo zustand_t2_2', t2.id);
  const p3 = store.executeCommand('echo zustand_t2_3', t2.id);

  // Burst commands in t3
  const p4 = store.executeCommand('echo zustand_t3_1', t3.id);
  const p5 = store.executeCommand('echo zustand_t3_2', t3.id);

  // Switch tab in middle
  store.switchTab(t3.id);
  assert.equal(useTerminalStore.getState().activeTabId, t3.id);

  await Promise.all([p1, p2, p3, p4, p5]);

  const state = useTerminalStore.getState();
  const tab2Fresh = state.tabs.find((t) => t.id === t2.id);
  const tab3Fresh = state.tabs.find((t) => t.id === t3.id);

  assert.equal(tab2Fresh.blocks.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(tab2Fresh.blocks[i].status, 'completed');
    assert.equal(tab2Fresh.blocks[i].output.trim(), `zustand_t2_${i + 1}`);
  }

  assert.equal(tab3Fresh.blocks.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(tab3Fresh.blocks[i].status, 'completed');
    assert.equal(tab3Fresh.blocks[i].output.trim(), `zustand_t3_${i + 1}`);
  }

  // Close tab 2 and tab 3
  await store.closeTab(t2.id);
  await store.closeTab(t3.id);

  const finalTabs = useTerminalStore.getState().tabs;
  assert.ok(!finalTabs.some((t) => t.id === t2.id));
  assert.ok(!finalTabs.some((t) => t.id === t3.id));
});

// =========================================================================
// SUMMARY
// =========================================================================
console.log(`\n${c.bold}----------------------------------------------------${c.reset}`);
console.log(`${c.bold}Rapid Commands & Session Switching Summary:${c.reset}`);
console.log(`  Total Tests:  ${totalTests}`);
console.log(`  Passed:       ${c.green}${passedTests}${c.reset}`);
console.log(`  Failed:       ${failedTests > 0 ? c.red : c.green}${failedTests}${c.reset}`);
console.log(`${c.bold}----------------------------------------------------${c.reset}\n`);

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
