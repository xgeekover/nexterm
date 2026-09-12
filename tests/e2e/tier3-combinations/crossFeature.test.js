import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 3: Cross-Feature Combinations (Pairwise Interactions)', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-XF-02: Explorer Click -> Monaco Edit -> Save -> Run in Terminal', async () => {
    // 1. Click file in Explorer
    const targetPath = '/workspace/src/calculator.js';
    const editorTab = await app.openFile(targetPath);
    assert.equal(editorTab.filePath, targetPath);
    assert.equal(editorTab.isDirty, false);

    // 2. Edit code in Monaco editor
    const fixedCode = 'export function calculateTotal(items) {\n  return items.reduce((acc, item) => acc + item.price, 0);\n}\n';
    app.editBuffer(editorTab.id, fixedCode);
    assert.equal(editorTab.isDirty, true, 'Editor tab should be marked dirty');

    // 3. Save file to disk
    await app.saveFile(editorTab.id);
    assert.equal(editorTab.isDirty, false, 'Editor tab should no longer be dirty');

    // Verify disk content
    const diskContent = await app.ipc.invoke('fs_read_file', { path: targetPath });
    assert.equal(diskContent, fixedCode, 'Filesystem must be updated with saved content');

    // 4. Run tests in Terminal
    const testBlock = await app.executeTerminalCommand('npm test');
    assert.equal(testBlock.status, 'completed');
    assert.equal(testBlock.exitCode, 0, 'Test must exit with 0 code after fix is saved');
    assert.ok(testBlock.output.includes('PASS'));
  });

  test('TC-XF-04: Command Palette Open File -> Edit in Monaco -> Quick Palette Action Save All', async () => {
    // 1. Open file via Command Palette
    app.openCommandPalette();
    const search = app.searchPalette('README');
    assert.ok(search.files.length > 0);
    await app.executePaletteItem(search.files[0]);

    const activeTab = app.getActiveEditorTab();
    assert.equal(activeTab.fileName, 'README.md');

    // 2. Edit content
    app.editBuffer(activeTab.id, '# NexTerm v2\nUpdated from Command Palette.\n');
    assert.equal(activeTab.isDirty, true);

    // 3. Open Command Palette and execute "Save All Files"
    app.openCommandPalette();
    const cmdSearch = app.searchPalette('save all');
    assert.ok(cmdSearch.commands.length > 0);
    await app.executePaletteItem(cmdSearch.commands[0]);

    assert.equal(activeTab.isDirty, false, 'Tab should be saved after palette Save All action');
  });

  test('TC-XF-05: Dark theme stays consistent across Monaco and Terminal (no toggle exists)', async () => {
    // 1. Initial (and only) dark state
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');

    // 2. Open an editor tab and execute a terminal command
    await app.openFile('/workspace/src/App.jsx');
    const block = await app.executeTerminalCommand('ls');
    assert.equal(block.status, 'completed');

    // 3. Theme is still dark — there is no toggle to invoke
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco must remain nexterm-dark');

    // 4. Terminal remains interactive
    const secondBlock = await app.executeTerminalCommand('pwd');
    assert.equal(secondBlock.status, 'completed');
  });
});
