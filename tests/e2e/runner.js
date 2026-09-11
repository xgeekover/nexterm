import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runnerContext } from './harness/testFramework.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI styling
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function parseArgs(args) {
  const options = {
    tier: null,
    filter: null,
    verbose: false,
    bail: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--tier=')) {
      options.tier = arg.split('=')[1];
    } else if (arg === '-t' && i + 1 < args.length) {
      options.tier = args[++i];
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.split('=')[1];
    } else if (arg === '-f' && i + 1 < args.length) {
      options.filter = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--bail' || arg === '-b') {
      options.bail = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
${colors.bold}${colors.cyan}NexTerm E2E Test Runner${colors.reset}

Usage:
  node tests/e2e/runner.js [options]
  npm test [-- [options]]

Options:
  -t, --tier=<1|2|3|4>    Execute tests for a specific tier only
  -f, --filter=<pattern>  Filter test suite or test names by substring
  -v, --verbose           Show detailed execution output
  -b, --bail              Stop execution on the first test failure
  -h, --help              Display this help message

Tiers:
  Tier 1: Feature Coverage (Terminal, Editor, Explorer, Mission Control, Chat, Palette, Theme)
  Tier 2: Boundary & Corner Cases (Empty inputs, non-zero exits, large streams, validation)
  Tier 3: Cross-Feature Combinations (Pairwise cross-system interactions)
  Tier 4: Real-World Scenarios (End-to-end full developer workflow journeys)
`);
}

async function loadSuites(tierOption) {
  const suitesToLoad = [];

  const tier1Files = [
    './tier1-features/terminal.test.js',
    './tier1-features/editor.test.js',
    './tier1-features/explorer.test.js',
    './tier1-features/missionControl.test.js',
    './tier1-features/chat.test.js',
    './tier1-features/commandPalette.test.js',
    './tier1-features/theme.test.js',
  ];

  const tier2Files = ['./tier2-boundary/boundary.test.js'];
  const tier3Files = ['./tier3-combinations/crossFeature.test.js'];
  const tier4Files = ['./tier4-scenarios/realWorldScenarios.test.js'];

  if (!tierOption || tierOption === '1') {
    suitesToLoad.push(...tier1Files);
  }
  if (!tierOption || tierOption === '2') {
    suitesToLoad.push(...tier2Files);
  }
  if (!tierOption || tierOption === '3') {
    suitesToLoad.push(...tier3Files);
  }
  if (!tierOption || tierOption === '4') {
    suitesToLoad.push(...tier4Files);
  }

  for (const file of suitesToLoad) {
    await import(file);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`\n${colors.bold}${colors.magenta}====================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  NexTerm Multi-AI Terminal IDE — E2E Test Suite    ${colors.reset}`);
  console.log(`${colors.bold}${colors.magenta}====================================================${colors.reset}`);
  console.log(`${colors.gray}Target: Pure JavaScript E2E Harness (Tauri v2 / React / Rust spec)${colors.reset}`);
  if (options.tier) console.log(`${colors.yellow}Filter: Tier ${options.tier}${colors.reset}`);
  if (options.filter) console.log(`${colors.yellow}Filter Pattern: "${options.filter}"${colors.reset}`);
  console.log();

  try {
    await loadSuites(options.tier);
  } catch (err) {
    console.error(`${colors.red}Failed to load test suites:${colors.reset}`, err);
    process.exit(1);
  }

  const { stats, results } = await runnerContext.run(options);

  for (const suite of results) {
    console.log(`${colors.bold}${colors.cyan}▶ ${suite.name}${colors.reset}`);
    for (const t of suite.tests) {
      if (t.status === 'passed') {
        console.log(`  ${colors.green}✔${colors.reset} ${t.name} ${colors.dim}(${t.durationMs}ms)${colors.reset}`);
      } else {
        console.log(`  ${colors.red}✖${colors.reset} ${colors.bold}${t.name}${colors.reset} ${colors.dim}(${t.durationMs}ms)${colors.reset}`);
        if (t.error) {
          console.log(`    ${colors.red}${t.error.stack || t.error.message}${colors.reset}`);
        }
      }
    }
    console.log();
  }

  console.log(`${colors.bold}----------------------------------------------------${colors.reset}`);
  console.log(`${colors.bold}Test Execution Summary:${colors.reset}`);
  console.log(`  Suites:   ${stats.totalSuites} executed`);
  console.log(`  Tests:    ${colors.bold}${stats.totalTests}${colors.reset} total`);
  console.log(`  Passed:   ${colors.green}${colors.bold}${stats.passed}${colors.reset}`);
  if (stats.failed > 0) {
    console.log(`  Failed:   ${colors.red}${colors.bold}${stats.failed}${colors.reset}`);
  } else {
    console.log(`  Failed:   0`);
  }
  if (stats.skipped > 0) {
    console.log(`  Skipped:  ${colors.yellow}${stats.skipped}${colors.reset}`);
  }
  console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log(`${colors.bold}----------------------------------------------------${colors.reset}\n`);

  if (stats.failed > 0) {
    console.log(`${colors.bold}${colors.red}TEST RUN FAILED${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${colors.bold}${colors.green}ALL E2E TESTS PASSED SUCCESSFULLY!${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`${colors.red}Fatal Runner Error:${colors.reset}`, err);
  process.exit(1);
});
