/**
 * Adversarial & Stress Test Runner
 */

import { runnerContext } from '../e2e/harness/testFramework.js';
import './stress_agent_chat_palette.test.js';

async function run() {
  console.log('====================================================');
  console.log('  NexTerm — Multi-Agent & Chat Adversarial Suite    ');
  console.log('====================================================');

  const { stats, results } = await runnerContext.run();

  for (const suite of results) {
    console.log(`\n▶ ${suite.name}`);
    for (const t of suite.tests) {
      if (t.status === 'passed') {
        console.log(`  ✔ ${t.name} (${t.durationMs}ms)`);
      } else {
        console.log(`  ✖ ${t.name} (${t.durationMs}ms)`);
        if (t.error) {
          console.log(`    Error: ${t.error.stack || t.error.message}`);
        }
      }
    }
  }

  console.log('\n----------------------------------------------------');
  console.log('Adversarial Test Execution Summary:');
  console.log(`  Suites:   ${stats.totalSuites} executed`);
  console.log(`  Tests:    ${stats.totalTests} total`);
  console.log(`  Passed:   ${stats.passed}`);
  console.log(`  Failed:   ${stats.failed}`);
  console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log('----------------------------------------------------');

  if (stats.failed > 0) {
    console.log('\n❌ ADVERSARIAL STRESS TEST DETECTED DEFECTS!\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL ADVERSARIAL STRESS TESTS PASSED!\n');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Runner failure:', err);
  process.exit(1);
});
