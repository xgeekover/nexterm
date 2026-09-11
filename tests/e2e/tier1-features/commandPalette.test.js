import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Command Palette (⌘K) Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-PAL-01: Command palette opens and closes, resetting input query', () => {
    assert.equal(app.paletteOpen, false, 'Palette should be closed initially');

    app.openCommandPalette();
    assert.equal(app.paletteOpen, true, 'Palette should be open');
    assert.equal(app.paletteQuery, '', 'Palette search query should be empty');

    app.closeCommandPalette();
    assert.equal(app.paletteOpen, false, 'Palette should be closed');
  });

  test('TC-PAL-02: Searching files filters matches across filesystem paths', () => {
    app.openCommandPalette();
    const results = app.searchPalette('calc');

    assert.ok(results.files.length > 0, 'Should find matching file for "calc"');
    assert.equal(results.files[0].path, '/workspace/src/calculator.js');
    assert.equal(results.files[0].title, 'calculator.js');
  });

  test('TC-PAL-03: Searching commands filters built-in IDE actions', () => {
    app.openCommandPalette();
    const results = app.searchPalette('theme');

    assert.ok(results.commands.length > 0, 'Should find matching command for "theme"');
    assert.equal(results.commands[0].title, 'Switch Dark/Light Theme');
    assert.equal(results.commands[0].action, 'switch_theme');
  });

  test('TC-PAL-04: Searching AI actions filters quick prompt actions', () => {
    app.openCommandPalette();
    const results = app.searchPalette('explain');

    assert.ok(results.aiActions.length > 0, 'Should find matching AI action');
    assert.equal(results.aiActions[0].title, 'Explain Error with AI');
    assert.equal(results.aiActions[0].prompt, 'Explain this error');
  });

  test('TC-PAL-05: Selecting a file result from palette opens file in Monaco editor', async () => {
    app.openCommandPalette();
    const results = app.searchPalette('App.jsx');
    assert.ok(results.files.length > 0);

    await app.executePaletteItem(results.files[0]);
    assert.equal(app.paletteOpen, false, 'Palette should close after item execution');
    assert.ok(app.editorTabs.length > 0, 'Editor tab should be opened');
    assert.equal(app.getActiveEditorTab().filePath, '/workspace/src/App.jsx');
  });

  test('TC-PAL-06: Selecting an IDE command from palette executes corresponding action', async () => {
    assert.equal(app.theme, 'dark');

    app.openCommandPalette();
    const results = app.searchPalette('switch');
    const themeCmd = results.commands.find((c) => c.action === 'switch_theme');
    assert.ok(themeCmd, 'Theme switch command must exist');

    await app.executePaletteItem(themeCmd);
    assert.equal(app.theme, 'light', 'Theme should switch to light');
    assert.equal(app.paletteOpen, false, 'Palette should close');
  });
});
