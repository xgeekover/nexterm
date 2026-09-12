/**
 * Adversarial & Stress Test Suite for NexTerm
 * Modules tested:
 * - R3: Multi-Agent Mission Control (Lifecycle, Concurrency, Dependency Chaining, Ring Buffer)
 * - R4: AI Chat (Token Streaming, Cancellation Race Conditions, Markdown Resilience)
 * - R5: Command Palette & Theming (Fuzzy Search, Regex Safety, Dark-Only Theme Invariants)
 */

import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { AppEnvironment } from '../e2e/harness/appEnvironment.js';
import { MockIpcBridge } from '../e2e/harness/mockIpc.js';
import { fuzzyMatch, parseAnsiToSpans, formatBytes, formatDuration } from '../../src/lib/utils.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

describe('Adversarial Stress: R5 Command Palette & Theming', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('ADV-PAL-01: Fuzzy match handles empty queries, null targets, and whitespace gracefully', () => {
    assert.equal(fuzzyMatch('', 'calculator.js'), true, 'Empty query matches any target');
    assert.equal(fuzzyMatch(null, 'calculator.js'), true, 'Null query matches any target');
    assert.equal(fuzzyMatch('calc', ''), false, 'Non-empty query against empty target returns false');
    assert.equal(fuzzyMatch('calc', null), false, 'Non-empty query against null target returns false');
    assert.equal(fuzzyMatch('calc', undefined), false, 'Non-empty query against undefined target returns false');
  });

  test('ADV-PAL-02: Fuzzy match safely handles regex metacharacters without compiling or throwing', () => {
    const dangerousRegexQueries = [
      '.*',
      '[a-z]+',
      '^(.*)$',
      '(\\d+)',
      '???***+++',
      '[\\]\\^$.|?*+()',
      'test{0,5}',
      'a|b|c',
      '\\',
      '\\\\',
    ];

    for (const q of dangerousRegexQueries) {
      assert.doesNotThrow(() => {
        const result = fuzzyMatch(q, 'some/path/file.js');
        assert.equal(typeof result, 'boolean');
      }, `Query "${q}" must not throw regex syntax errors`);
    }
  });

  test('ADV-PAL-03: Fuzzy match accurately matches character subsequences case-insensitively', () => {
    assert.equal(fuzzyMatch('calc', 'src/calculator.js'), true);
    assert.equal(fuzzyMatch('CALC', 'src/calculator.js'), true);
    assert.equal(fuzzyMatch('cross', 'tests/tier3-combinations/crossFeature.test.js'), true);
    assert.equal(fuzzyMatch('tgltrm', 'Toggle Terminal'), true);
    assert.equal(fuzzyMatch('nonexistent12345', 'src/App.jsx'), false);
    assert.equal(fuzzyMatch('abc', 'cba'), false, 'Subsequence order must be strictly preserved');
  });

  test('ADV-PAL-04: Command palette search handles special characters and non-matching queries without failure', () => {
    app.openCommandPalette();

    const specialSearches = [
      '!!!',
      '###',
      '$$$',
      '%%%',
      '***',
      '<<<>>>',
      'non_existent_file_xyz_99999.txt',
      '🚀',
      '한국어',
    ];

    for (const term of specialSearches) {
      assert.doesNotThrow(() => {
        const res = app.searchPalette(term);
        assert.ok(Array.isArray(res.files));
        assert.ok(Array.isArray(res.commands));
        assert.ok(Array.isArray(res.aiActions));
      }, `Search with "${term}" must not throw error`);
    }
  });

  test('ADV-THM-01: Theme is a fixed dark constant — no toggle exists on the mock app', () => {
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');
    assert.equal(typeof app.toggleTheme, 'undefined', 'toggleTheme must not exist; light mode was removed');
    assert.equal(typeof app.setTheme, 'undefined', 'setTheme must not exist; light mode was removed');
  });

  test('ADV-THM-02: Zustand settingsStore has no theme/monacoTheme/setTheme/toggleTheme — light mode was fully removed', () => {
    const state = useSettingsStore.getState();
    assert.equal('theme' in state, false, 'settingsStore must not expose a theme key');
    assert.equal('monacoTheme' in state, false, 'settingsStore must not expose a monacoTheme key');
    assert.equal(typeof state.setTheme, 'undefined', 'settingsStore must not expose setTheme');
    assert.equal(typeof state.toggleTheme, 'undefined', 'settingsStore must not expose toggleTheme');
  });
});
