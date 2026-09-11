import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';

describe('Tier 1: File Explorer Tree & Click-to-Open Feature Coverage', () => {
  let app;

  beforeEach(async () => {
    app = new AppEnvironment();
    await app.initialize();
  });

  test('TC-EXPL-01: Explorer displays directory tree populated from filesystem via fs_read_dir', async () => {
    const tree = app.explorerTree;
    assert.ok(Array.isArray(tree), 'Explorer tree must be an array of nodes');
    assert.ok(tree.length > 0, 'Explorer tree must not be empty');

    const filePaths = tree.map((n) => n.path);
    assert.ok(filePaths.includes('/workspace/package.json'), 'package.json must be present in tree');
    assert.ok(filePaths.includes('/workspace/src/App.jsx'), 'src/App.jsx must be present in tree');
  });

  test('TC-EXPL-02: Folder node click toggles expanded and collapsed state', () => {
    assert.equal(app.expandedFolders.has('/workspace'), true, 'Root workspace is expanded initially');

    app.toggleFolder('/workspace/src');
    assert.equal(app.expandedFolders.has('/workspace/src'), true, 'src folder should now be expanded');

    app.toggleFolder('/workspace/src');
    assert.equal(app.expandedFolders.has('/workspace/src'), false, 'src folder should now be collapsed');
  });

  test('TC-EXPL-03: Clicking a file in explorer opens it in the Monaco editor and switches active tab', async () => {
    assert.equal(app.editorTabs.length, 0, 'Initially no editor tabs open');

    const openedTab = await app.openFile('/workspace/src/calculator.js');
    assert.ok(openedTab, 'Opening file from explorer must return tab');
    assert.equal(app.editorTabs.length, 1);
    assert.equal(app.activeEditorTabId, openedTab.id);
    assert.equal(openedTab.filePath, '/workspace/src/calculator.js');
  });

  test('TC-EXPL-04: Creating a new file via fs_create_file updates filesystem and explorer tree', async () => {
    const newFilePath = '/workspace/src/utils.js';
    await app.ipc.invoke('fs_create_file', { path: newFilePath });

    await app.refreshExplorer();
    const treePaths = app.explorerTree.map((n) => n.path);
    assert.ok(treePaths.includes(newFilePath), 'Newly created file must appear in explorer tree');
  });

  test('TC-EXPL-05: Creating a new folder via fs_create_dir updates filesystem and explorer tree', async () => {
    const newDirPath = '/workspace/docs';
    await app.ipc.invoke('fs_create_dir', { path: newDirPath });

    await app.refreshExplorer();
    const dirNodes = app.explorerTree.filter((n) => n.is_dir).map((n) => n.path);
    assert.ok(dirNodes.includes(newDirPath), 'Newly created directory must appear in explorer tree');
  });

  test('TC-EXPL-06: Deleting a file via fs_delete_path removes it from tree', async () => {
    const targetFile = '/workspace/README.md';
    await app.ipc.invoke('fs_delete_path', { path: targetFile, recursive: false });

    await app.refreshExplorer();
    const treePaths = app.explorerTree.map((n) => n.path);
    assert.equal(treePaths.includes(targetFile), false, 'Deleted file must not be present in explorer tree');
  });

  test('TC-EXPL-07: Refresh button reloads filesystem while preserving user expanded folders', async () => {
    app.expandedFolders.add('/workspace/src');
    app.expandedFolders.add('/workspace/tests');

    await app.refreshExplorer();

    assert.equal(app.expandedFolders.has('/workspace/src'), true, 'Expanded src folder state preserved');
    assert.equal(app.expandedFolders.has('/workspace/tests'), true, 'Expanded tests folder state preserved');
  });
});
