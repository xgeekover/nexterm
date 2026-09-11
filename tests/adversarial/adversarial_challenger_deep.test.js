/**
 * NexTerm Adversarial Deep Stress & Fuzzing Harness
 * Terminal & PTY Challenger — Iteration 2
 */

import assert from 'node:assert/strict';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { parseAnsiTokens, stripAnsi } from '../../src/lib/ansiParser.js';

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
// 5. ANSI CSI CODES STRIPPING (CURSOR, CLEAR, MODES) WITHOUT LEAKAGE
// -------------------------------------------------------------
await test('CHG-05: CSI escape sequences stripped without leaking raw \\x1b bytes', async () => {
  const csiTestCases = [
    {
      name: 'Cursor movements & Clear Screen',
      raw: '\x1b[2J\x1b[H\x1b[1;1H\x1b[2K\x1b[1A\x1b[2B\x1b[3C\x1b[4DTop Left Content\x1b[K\nBottom Line',
      expectedTextSnippet: 'Top Left Content',
    },
    {
      name: 'Private Modes (show/hide cursor, alternate buffer)',
      raw: '\x1b[?25hVisible Cursor\x1b[?25lHidden Cursor\x1b[?1049hAlt Buffer\x1b[?1049lMain Buffer',
      expectedTextSnippet: 'Visible CursorHidden CursorAlt BufferMain Buffer',
    },
    {
      name: 'Save & Restore cursor position',
      raw: '\x1b[sSaved\x1b[uRestored',
      expectedTextSnippet: 'SavedRestored',
    },
    {
      name: 'Device status / reports',
      raw: '\x1b[6nStatus Text\x1b[5n',
      expectedTextSnippet: 'Status Text',
    },
    {
      name: 'Combined CSI with SGR Colors',
      raw: '\x1b[2J\x1b[1m\x1b[31mError:\x1b[0m \x1b[32mFile OK\x1b[0m\x1b[K',
      expectedTextSnippet: 'Error: File OK',
    },
  ];

  for (const tc of csiTestCases) {
    const tokens = parseAnsiTokens(tc.raw);
    const stripped = stripAnsi(tc.raw);

    // 1. Zero raw \x1b bytes in any token
    for (const t of tokens) {
      assert.ok(
        !t.text.includes('\x1b'),
        `[${tc.name}] Raw \\x1b found in token text: ${JSON.stringify(t)}`
      );
      assert.ok(
        !t.text.includes('\x1b['),
        `[${tc.name}] Unparsed bracket escape artifact found in token text: ${JSON.stringify(t)}`
      );
    }

    // 2. Zero raw \x1b bytes in stripAnsi
    assert.ok(
      !stripped.includes('\x1b'),
      `[${tc.name}] stripAnsi leaked raw \\x1b: ${JSON.stringify(stripped)}`
    );

    // 3. Meaningful content preserved
    const combinedText = tokens.map((t) => t.text).join('');
    assert.ok(
      combinedText.includes(tc.expectedTextSnippet),
      `[${tc.name}] Combined text did not include expected snippet '${tc.expectedTextSnippet}'. Got: '${combinedText}'`
    );
  }
});

// -------------------------------------------------------------
// 6. ANSI OSC CODES STRIPPING (TITLES, HYPERLINKS, BEL/ST TERMINATORS)
// -------------------------------------------------------------
await test('CHG-06: OSC escape sequences stripped without leaking raw \\x1b bytes', async () => {
  const oscTestCases = [
    {
      name: 'Set Window Title (BEL terminated \\x07)',
      raw: '\x1b]0;NexTerm Shell Title\x07Hello from Terminal',
      expectedTextSnippet: 'Hello from Terminal',
    },
    {
      name: 'Set Window Title (ST terminated \\x1b\\)',
      raw: '\x1b]2;Another Window Title\x1b\\Active Output Stream',
      expectedTextSnippet: 'Active Output Stream',
    },
    {
      name: 'Terminal Hyperlink OSC 8',
      raw: '\x1b]8;;https://example.com\x07Clickable Link Text\x1b]8;;\x07',
      expectedTextSnippet: 'Clickable Link Text',
    },
    {
      name: 'Shell integration markers (OSC 133)',
      raw: '\x1b]133;A\x07Prompt\x1b]133;B\x07Command\x1b]133;C\x07Output Data\x1b]133;D;0\x07',
      expectedTextSnippet: 'PromptCommandOutput Data',
    },
  ];

  for (const tc of oscTestCases) {
    const tokens = parseAnsiTokens(tc.raw);
    const stripped = stripAnsi(tc.raw);

    for (const t of tokens) {
      assert.ok(
        !t.text.includes('\x1b'),
        `[${tc.name}] Raw \\x1b leaked in token: ${JSON.stringify(t)}`
      );
      assert.ok(
        !t.text.includes('\x07'),
        `[${tc.name}] BEL byte leaked in token: ${JSON.stringify(t)}`
      );
    }

    assert.ok(
      !stripped.includes('\x1b'),
      `[${tc.name}] stripAnsi leaked raw \\x1b: ${JSON.stringify(stripped)}`
    );
    assert.ok(
      !stripped.includes('\x07'),
      `[${tc.name}] stripAnsi leaked BEL byte: ${JSON.stringify(stripped)}`
    );

    const combined = tokens.map((t) => t.text).join('');
    assert.ok(
      combined.includes(tc.expectedTextSnippet),
      `[${tc.name}] Expected snippet '${tc.expectedTextSnippet}' in '${combined}'`
    );
  }
});

// -------------------------------------------------------------
// 7. MALFORMED / ADVERSARIAL ANSI FUZZING (NO CRASH, NO LEAKS)
// -------------------------------------------------------------
await test('CHG-07: Malformed and adversarial ANSI fuzzing', async () => {
  const hostilePayloads = [
    '\x1b',
    '\x1b\x1b\x1b\x1b\x1b',
    '\x1b[',
    '\x1b[m',
    '\x1b[;m',
    '\x1b[0;1;31;42;999;m',
    '\x1b[?;;;m',
    '\x1b]0;Unclosed OSC without terminator',
    '\x1b[99999999999999999999999999999999999999999999m',
    '\x1b[31mRed\x1b[32mGreen\x1b[33mYellow\x1b[0mNormal',
    '\x1b[38;2;255;128;64m24-bit TrueColor\x1b[0m',
    '\x1b[48;5;208m256-Color BG\x1b[0m',
    '\x1b[1;31;4;42mBold Underline Red on Green\x1b[0m',
  ];

  for (const payload of hostilePayloads) {
    const tokens = parseAnsiTokens(payload);
    assert.ok(Array.isArray(tokens), `parseAnsiTokens must return array for ${JSON.stringify(payload)}`);

    for (const t of tokens) {
      assert.ok(
        !t.text.includes('\x1b'),
        `Leaked raw \\x1b in token text for payload: ${JSON.stringify(payload)} -> ${JSON.stringify(t)}`
      );
    }

    const stripped = stripAnsi(payload);
    assert.ok(
      !stripped.includes('\x1b'),
      `stripAnsi leaked \\x1b for payload: ${JSON.stringify(payload)} -> ${JSON.stringify(stripped)}`
    );
  }
});

// -------------------------------------------------------------
// 8. SGR COLOR CLASS MAPPING ACCURACY
// -------------------------------------------------------------
await test('CHG-08: SGR standard and bright color class mapping accuracy', async () => {
  const colorChecks = [
    { code: 31, cls: 'text-ansi-red' },
    { code: 32, cls: 'text-ansi-green' },
    { code: 33, cls: 'text-ansi-yellow' },
    { code: 34, cls: 'text-ansi-blue' },
    { code: 35, cls: 'text-ansi-magenta' },
    { code: 36, cls: 'text-ansi-cyan' },
    { code: 91, cls: 'text-ansi-bright-red' },
    { code: 92, cls: 'text-ansi-bright-green' },
    { code: 1, cls: 'font-bold' },
    { code: 3, cls: 'italic' },
    { code: 4, cls: 'underline' },
    { code: 41, cls: 'bg-ansi-red' },
    { code: 42, cls: 'bg-ansi-green' },
  ];

  for (const check of colorChecks) {
    const raw = `\x1b[${check.code}mSampleText\x1b[0m`;
    const tokens = parseAnsiTokens(raw);
    const styledToken = tokens.find((t) => t.text === 'SampleText');
    assert.ok(styledToken, `Token for code ${check.code} not found`);
    assert.ok(
      styledToken.className.includes(check.cls),
      `Token class for code ${check.code} expected to include '${check.cls}', got '${styledToken.className}'`
    );
  }
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
