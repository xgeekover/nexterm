/**
 * NexTerm Adversarial Deep Stress & Fuzzing Harness
 * Terminal & PTY Challenger — Iteration 2
 */

import assert from 'node:assert/strict';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  process.stdout.write(`[DEEP CHALLENGE] ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log(`❌ FAIL: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

console.log('\n======================================================');
console.log('  CHALLENGER DEEP VERIFICATION & ADVERSARIAL FUZZING  ');
console.log('======================================================\n');

// -------------------------------------------------------------
// 1. 100-COMMAND RAPID BURST WITH MIXED EXIT CODES (FIFO & ATTRIBUTION)
// -------------------------------------------------------------
await test('CHG-01: 100-command rapid burst with mixed exit codes maintains strict FIFO & attribution', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const commands = [];
  const expected = [];

  for (let i = 0; i < 100; i++) {
    const mod = i % 5;
    if (mod === 0) {
      commands.push(`echo success_${i}`);
      expected.push({ status: 'completed', exitCode: 0, text: `success_${i}` });
    } else if (mod === 1) {
      commands.push(`nonexistent_binary_${i}`);
      expected.push({ status: 'failed', exitCode: 127, text: 'command not found' });
    } else if (mod === 2) {
      commands.push(`pwd`);
      expected.push({ status: 'completed', exitCode: 0, text: '/workspace' });
    } else if (mod === 3) {
      commands.push(`invalid_flag_cmd_${i} --fail`);
      expected.push({ status: 'failed', exitCode: 127, text: 'command not found' });
    } else {
      commands.push(`whoami`);
      expected.push({ status: 'completed', exitCode: 0, text: 'developer' });
    }
  }

  // Fire all 100 commands without awaiting individually
  const promises = commands.map((c) => env.executeTerminalCommand(c));
  await Promise.all(promises);

  const tab = env.getActiveTerminalTab();
  assert.equal(tab.blocks.length, 100, 'Should have exactly 100 blocks created');

  for (let i = 0; i < 100; i++) {
    const block = tab.blocks[i];
    const exp = expected[i];

    assert.equal(block.command, commands[i], `Block ${i} command mismatch`);
    assert.equal(
      block.status,
      exp.status,
      `Block ${i} status mismatch: expected ${exp.status}, got ${block.status} (cmd: ${commands[i]})`
    );
    assert.equal(
      block.exitCode,
      exp.exitCode,
      `Block ${i} exitCode mismatch: expected ${exp.exitCode}, got ${block.exitCode}`
    );
    assert.ok(
      block.output.includes(exp.text),
      `Block ${i} output missing expected snippet '${exp.text}': got '${block.output}'`
    );
  }

  env.destroy();
});

// -------------------------------------------------------------
// 2. 10 CONCURRENT TABS WITH 10 RAPID COMMANDS EACH (100 TOTAL)
// -------------------------------------------------------------
await test('CHG-02: 10 concurrent tabs x 10 rapid commands isolation & attribution', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const tabs = [env.getActiveTerminalTab()];
  for (let t = 1; t < 10; t++) {
    tabs.push(await env.createTerminalTab(`Tab-${t}`));
  }

  const allPromises = [];

  for (let t = 0; t < 10; t++) {
    const targetTab = tabs[t];
    for (let c = 0; c < 10; c++) {
      const cmd = `echo tab_${t}_cmd_${c}`;
      allPromises.push(env.executeTerminalCommand(cmd, targetTab.id));
    }
  }

  await Promise.all(allPromises);

  // Validate each tab
  for (let t = 0; t < 10; t++) {
    const tab = tabs[t];
    assert.equal(tab.blocks.length, 10, `Tab ${t} must have exactly 10 blocks`);
    for (let c = 0; c < 10; c++) {
      const b = tab.blocks[c];
      assert.equal(b.status, 'completed');
      assert.equal(b.exitCode, 0);
      assert.equal(b.command, `echo tab_${t}_cmd_${c}`);
      assert.equal(b.output.trim(), `tab_${t}_cmd_${c}`);
    }
  }

  env.destroy();
});

// -------------------------------------------------------------
// 3. WHITESPACE / EMPTY COMMAND HANDLING UNDER BURST
// -------------------------------------------------------------
await test('CHG-03: Whitespace, empty commands, and blank dispatches', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const tab = env.getActiveTerminalTab();

  const r1 = await env.executeTerminalCommand('');
  const r2 = await env.executeTerminalCommand('   ');
  const r3 = await env.executeTerminalCommand('\t\n\r');
  const r4 = await env.executeTerminalCommand('echo not_empty');

  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null);
  assert.notEqual(r4, null);
  assert.equal(tab.blocks.length, 1, 'Only non-empty command should create a block');
  assert.equal(tab.blocks[0].output.trim(), 'not_empty');

  env.destroy();
});

// -------------------------------------------------------------
// 4. NON-EXISTENT COMMANDS VARIATIONS & EXIT CODE 127
// -------------------------------------------------------------
await test('CHG-04: Non-existent command variants all cleanly return exit code 127', async () => {
  const env = new AppEnvironment();
  await env.initialize();

  const badCommands = [
    'random_gibberish_tool_123',
    'unknown-binary-name --flags --options=42',
    'weird_cmd_with_quotes "arg with space" \'single quote\'',
    'definitely_not_a_valid_program',
  ];

  for (const cmd of badCommands) {
    const b = await env.executeTerminalCommand(cmd);
    assert.equal(b.status, 'failed', `Command '${cmd}' should have status 'failed'`);
    assert.equal(b.exitCode, 127, `Command '${cmd}' should have exitCode 127`);
    assert.ok(b.output.includes('command not found'), `Command '${cmd}' should mention 'command not found'`);
  }

  env.destroy();
});

// -------------------------------------------------------------
// 9. DIRECT Zustand useTerminalStore 50-COMMAND BURST STRESS
// -------------------------------------------------------------
await test('CHG-09: Direct Zustand useTerminalStore 50-command burst & block pinning/clearing', async () => {
  const store = useTerminalStore.getState();
  await store.init();

  const tab = await store.createTab('Zustand Stress Tab');
  store.switchTab(tab.id);

  const burstCmds = [];
  for (let i = 0; i < 50; i++) {
    if (i % 2 === 0) {
      burstCmds.push(store.executeCommand(`echo item_${i}`, tab.id));
    } else {
      burstCmds.push(store.executeCommand(`nonexistent_z_${i}`, tab.id));
    }
  }

  await Promise.all(burstCmds);

  const state = useTerminalStore.getState();
  const freshTab = state.tabs.find((t) => t.id === tab.id);
  assert.equal(freshTab.blocks.length, 50);

  for (let i = 0; i < 50; i++) {
    const b = freshTab.blocks[i];
    if (i % 2 === 0) {
      assert.equal(b.status, 'completed');
      assert.equal(b.exitCode, 0);
      assert.ok(b.output.includes(`item_${i}`));
    } else {
      assert.equal(b.status, 'failed');
      assert.equal(b.exitCode, 127);
      assert.ok(b.output.includes('command not found'));
    }
  }

  // Pin block 0 and block 10
  store.pinBlock(freshTab.blocks[0].id);
  store.pinBlock(freshTab.blocks[10].id);

  // Clear blocks
  store.clearBlocks(tab.id);

  const clearedTab = useTerminalStore.getState().tabs.find((t) => t.id === tab.id);
  assert.equal(clearedTab.blocks.length, 2, 'Only 2 pinned blocks should remain');
  assert.equal(clearedTab.blocks[0].pinned, true);
  assert.equal(clearedTab.blocks[1].pinned, true);

  // Close tab
  await store.closeTab(tab.id);
});

// -------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------
console.log('\n------------------------------------------------------');
console.log(`Challenger Deep Verification Summary:`);
console.log(`  Total:  ${totalTests}`);
console.log(`  Passed: ${passedTests}`);
console.log(`  Failed: ${failedTests}`);
console.log('------------------------------------------------------\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
