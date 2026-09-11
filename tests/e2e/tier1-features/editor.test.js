import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: Monaco Editor & File Tabs Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-EDIT-01: Opening a file loads content into Monaco buffer with automatic language detection', async () => {
    const tab = await app.openFile('/workspace/src/App.jsx');
    assert.ok(tab, 'File tab must be created');
    assert.equal(tab.filePath, '/workspace/src/App.jsx');
    assert.equal(tab.fileName, 'App.jsx');
    assert.equal(tab.language, 'javascript', 'Language should be detected as javascript for .jsx');
    assert.ok(tab.content.includes('NexTerm IDE'), 'Buffer content must match filesystem content');
    assert.equal(tab.isDirty, false, 'Newly opened file should not be dirty');
  });

  test('TC-EDIT-02: Multiple files can be opened simultaneously across independent editor tabs', async () => {
    const tab1 = await app.openFile('/workspace/package.json');
    const tab2 = await app.openFile('/workspace/README.md');

    assert.equal(app.editorTabs.length, 2, 'Should have 2 open editor tabs');
    assert.equal(app.activeEditorTabId, tab2.id, 'Active tab should be the most recently opened file');
    assert.equal(tab1.language, 'json');
    assert.equal(tab2.language, 'markdown');
  });

  test('TC-EDIT-03: Editing editor buffer sets dirty indicator state', async () => {
    const tab = await app.openFile('/workspace/src/App.jsx');
    assert.equal(tab.isDirty, false);

    app.editBuffer(tab.id, 'export default function App() { return <h1>Modified</h1>; }');
    assert.equal(tab.isDirty, true, 'Dirty state must be true after modifying buffer');
    assert.equal(tab.content, 'export default function App() { return <h1>Modified</h1>; }');

    // Reverting back to original content clears dirty flag
    app.editBuffer(tab.id, tab.savedContent);
    assert.equal(tab.isDirty, false, 'Reverting to saved content must clear dirty state');
  });

  test('TC-EDIT-04: Saving dirty file writes to disk via fs_write_file and resets dirty state', async () => {
    const tab = await app.openFile('/workspace/README.md');
    const newContent = '# NexTerm Desktop\nUpdated documentation.\n';
    app.editBuffer(tab.id, newContent);
    assert.equal(tab.isDirty, true);

    await app.saveFile(tab.id);
    assert.equal(tab.isDirty, false, 'Dirty state must be reset upon save');

    // Verify filesystem state in mock IPC
    const savedDiskContent = await app.ipc.invoke('fs_read_file', { path: '/workspace/README.md' });
    assert.equal(savedDiskContent, newContent, 'Filesystem must reflect saved content');

    const writeCalls = app.ipc.getCalls('fs_write_file');
    assert.ok(writeCalls.length > 0);
    assert.equal(writeCalls[writeCalls.length - 1].args.path, '/workspace/README.md');
  });

  test('TC-EDIT-05: Monaco editor theme synchronizes with application dark/light mode', () => {
    assert.equal(app.theme, 'dark');
    assert.equal(app.monacoTheme, 'nexterm-dark');

    app.setTheme('light');
    assert.equal(app.theme, 'light');
    assert.equal(app.monacoTheme, 'nexterm-light', 'Monaco theme must switch to vs-light in light mode');

    app.setTheme('dark');
    assert.equal(app.monacoTheme, 'nexterm-dark', 'Monaco theme must switch back to vs-dark in dark mode');
  });

  test('TC-EDIT-06: Opening an already opened file focuses the existing tab without duplication', async () => {
    const tab1 = await app.openFile('/workspace/package.json');
    await app.openFile('/workspace/README.md');
    assert.equal(app.editorTabs.length, 2);

    const reopenedTab = await app.openFile('/workspace/package.json');
    assert.equal(app.editorTabs.length, 2, 'Tab count must not increase when reopening an existing file');
    assert.equal(reopenedTab.id, tab1.id, 'Should return the existing tab');
    assert.equal(app.activeEditorTabId, tab1.id, 'Active tab must be focused to existing tab');
  });

  test('TC-EDIT-07: Closing an editor tab removes it and activates another tab', async () => {
    const tab1 = await app.openFile('/workspace/package.json');
    const tab2 = await app.openFile('/workspace/README.md');
    assert.equal(app.editorTabs.length, 2);

    app.closeEditorTab(tab2.id);
    assert.equal(app.editorTabs.length, 1, 'Only 1 tab should remain');
    assert.equal(app.activeEditorTabId, tab1.id, 'Active tab should switch to tab 1');
  });
});
