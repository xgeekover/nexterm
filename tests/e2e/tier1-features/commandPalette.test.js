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
    const results = app.searchPalette('new terminal');

    assert.ok(results.commands.length > 0, 'Should find matching command for "new terminal"');
    assert.equal(results.commands[0].title, 'New Terminal Tab');
    assert.equal(results.commands[0].command, 'new_terminal');

    const titles = app.searchPalette('').commands.map((c) => c.title);
    assert.deepEqual(
      titles,
      ['New Terminal Tab', 'Clear Terminal Output', 'Save All Files'],
      'The palette offers exactly the three commands the app implements'
    );
  });

  test('TC-PAL-04: Files nested in subfolders are findable, not just top-level ones', () => {
    app.openCommandPalette();
    const results = app.searchPalette('calculator');

    // `fs_read_dir` returns a nested tree; a palette that reads only its top
    // level can never offer anything under `src/`, which is what ⌘P did.
    assert.ok(results.files.length > 0, 'A file two levels down must be offered');
    assert.equal(results.files[0].path, '/workspace/src/calculator.js');
    assert.ok(
      app.searchPalette('').files.some((f) => f.path === '/workspace/tests/calculator.test.js'),
      'Every file in the tree is offered when the query is empty'
    );
  });

  test('TC-PAL-07: Quick-open mode (⌘P) offers files only, never commands', () => {
    app.openCommandPalette('files');
    const results = app.searchPalette('terminal');

    assert.equal(results.commands.length, 0, 'Quick open must not offer commands');
    app.closeCommandPalette();

    app.openCommandPalette('all');
    assert.ok(
      app.searchPalette('terminal').commands.length > 0,
      'The full palette still offers commands for the same query'
    );
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
    app.openCommandPalette();
    const results = app.searchPalette('save all');
    const saveAllCmd = results.commands.find((c) => c.command === 'save_all');
    assert.ok(saveAllCmd, 'Save All command must exist');

    const tab = await app.openFile('/workspace/README.md');
    app.editBuffer(tab.id, '# edited by the palette test\n');
    assert.equal(tab.isDirty, true);

    await app.executePaletteItem(saveAllCmd);
    assert.equal(app.paletteOpen, false, 'Palette should close');
    assert.equal(tab.isDirty, false, 'Save All must write every dirty buffer');
    assert.equal(
      await app.ipc.invoke('fs_read_file', { path: '/workspace/README.md' }),
      '# edited by the palette test\n',
      'Disk must hold what Save All wrote'
    );
  });
});
