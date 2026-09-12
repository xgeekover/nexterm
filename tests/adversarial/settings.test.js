/**
 * Settings store: the VS Code-style Settings window (SettingsWindow.jsx)
 * writes exclusively through `setSetting`/`resetSettings` and reads
 * `settingsDefaults` to decide when to show a per-row "Reset" affordance.
 * These tests hold the store itself to that contract — the UI layer owns
 * range-clamping (font size 8-32, line height 1-2, tab size 1-8, scrollback
 * 100-100000), so it is not re-asserted here.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';

const S = useSettingsStore;

// Every key the Settings window renders a control for.
const SETTINGS_KEYS = [
  'terminalFontFamily',
  'terminalFontSize',
  'terminalLineHeight',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalScrollback',
  'terminalTheme',
  'terminalSuggestions',
  'editorFontSize',
  'editorTabSize',
  'editorWordWrap',
  'editorMinimap',
  'reducedMotion',
];

describe('Settings store: setSetting / resetSettings contract', () => {
  beforeEach(() => {
    S.getState().resetSettings();
  });

  test('SET-01: settingsDefaults has an entry for every setting the window exposes', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(defaults, key),
        `settingsDefaults is missing "${key}"`
      );
    }
  });

  test('SET-02: settingsDefaults has no stray keys the window does not render', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of Object.keys(defaults)) {
      assert.ok(SETTINGS_KEYS.includes(key), `settingsDefaults has an unexpected key "${key}"`);
    }
  });

  test('SET-03: the live store value for every default starts out equal to its default', () => {
    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.deepEqual(S.getState()[key], defaults[key], `initial ${key} must match settingsDefaults`);
    }
  });

  test('SET-04: setSetting writes exactly the key it is given, immediately', () => {
    S.getState().setSetting('terminalFontSize', 18);
    assert.equal(S.getState().terminalFontSize, 18);
    // Sibling settings must be untouched.
    assert.equal(S.getState().editorFontSize, S.getState().settingsDefaults.editorFontSize);
    assert.equal(S.getState().terminalScrollback, S.getState().settingsDefaults.terminalScrollback);
  });

  test('SET-05: setSetting round-trips every settings key', () => {
    const probes = {
      terminalFontFamily: 'Fira Code, monospace',
      terminalFontSize: 20,
      terminalLineHeight: 1.8,
      terminalCursorStyle: 'block',
      terminalCursorBlink: false,
      terminalScrollback: 10000,
      terminalTheme: 'dracula',
      terminalSuggestions: false,
      editorFontSize: 16,
      editorTabSize: 4,
      editorWordWrap: true,
      editorMinimap: false,
      reducedMotion: true,
    };
    const defaults = S.getState().settingsDefaults;

    for (const [key, value] of Object.entries(probes)) {
      // Every probe must actually differ from its default, otherwise a
      // no-op setSetting could pass this test by accident.
      assert.notEqual(value, defaults[key], `probe for "${key}" must differ from its default`);
      S.getState().setSetting(key, value);
      assert.deepEqual(S.getState()[key], value, `setSetting did not round-trip "${key}"`);
    }
  });

  test('SET-06: resetSettings restores every key to settingsDefaults in one call', () => {
    S.getState().setSetting('terminalFontSize', 30);
    S.getState().setSetting('terminalCursorStyle', 'underline');
    S.getState().setSetting('editorWordWrap', true);
    S.getState().setSetting('editorMinimap', false);

    S.getState().resetSettings();

    const defaults = S.getState().settingsDefaults;
    for (const key of SETTINGS_KEYS) {
      assert.deepEqual(S.getState()[key], defaults[key], `resetSettings did not restore "${key}"`);
    }
  });

  test('SET-07: resetSettings leaves unrelated shell/window state alone', () => {
    S.getState().setSettingsModalOpen(true);
    S.getState().setSetting('terminalScrollback', 42000);

    S.getState().resetSettings();

    assert.equal(S.getState().isSettingsModalOpen, true, 'resetSettings must not close the Settings window');
    assert.equal(S.getState().terminalScrollback, S.getState().settingsDefaults.terminalScrollback);

    S.getState().setSettingsModalOpen(false);
  });
});
