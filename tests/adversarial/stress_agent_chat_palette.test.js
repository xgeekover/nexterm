/**
 * Adversarial & Stress Test Suite for NexTerm
 * Modules tested:
 * - R3: Multi-Agent Mission Control (Lifecycle, Concurrency, Dependency Chaining, Ring Buffer)
 * - R4: AI Chat (Token Streaming, Cancellation Race Conditions, Markdown Resilience)
 * - R5: Command Palette & Theming (Fuzzy Search, Regex Safety, Rapid Theme Toggle, Monaco Sync)
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
    assert.equal(fuzzyMatch('swth', 'Switch Dark / Light Theme'), true);
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

  test('ADV-THM-01: Rapid 200 theme toggles in tight loop maintain strict synchronization and parity', () => {
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');

    // Toggle 200 times
    for (let i = 0; i < 200; i++) {
      app.toggleTheme();
    }

    // 200 toggles from dark -> dark
    assert.equal(app.theme, 'dark', 'Even number of toggles must return to dark mode');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco theme must match dark mode');

    // 1 more toggle -> light
    app.toggleTheme();
    assert.equal(app.theme, 'light', 'Odd toggle must switch to light mode');
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco theme must switch to vs-light');
  });

  test('ADV-THM-02: Zustand settingsStore setTheme strictly synchronizes monacoTheme without reload', () => {
    useSettingsStore.getState().setTheme('light');
    assert.equal(useSettingsStore.getState().theme, 'light');
    assert.equal(useSettingsStore.getState().monacoTheme, 'nexterm-light');

    useSettingsStore.getState().setTheme('dark');
    assert.equal(useSettingsStore.getState().theme, 'dark');
    assert.equal(useSettingsStore.getState().monacoTheme, 'nexterm-dark');

    assert.throws(
      () => useSettingsStore.getState().setTheme('invalid-color-palette'),
      /Invalid theme/,
      'Invalid theme must throw validation error'
    );
  });
});
