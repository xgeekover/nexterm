import { describe, test, beforeEach, assert, AppEnvironment } from '../harness/index.js';
import { buildOpenActionItems } from '../../../src/components/explorer/explorerOpenActions.js';
import { openInExternalEditor, revealInFileManager } from '../../../src/lib/ipc.js';

/**
 * `fs_read_dir` returns a NESTED tree — a directory carries its own
 * `children` — which is what the Rust backend does. Reading only the top level
 * is exactly the mistake that hid missing subfolders in the explorer and made
 * ⌘P unable to find anything under `src/`, so these cases walk it.
 */
function flatten(nodes, acc = []) {
  for (const node of nodes || []) {
    acc.push(node);
    if (node.is_dir) flatten(node.children, acc);
  }
  return acc;
}
const pathsIn = (tree) => flatten(tree).map((n) => n.path);

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

    const topLevel = tree.map((n) => n.path);
    assert.ok(topLevel.includes('/workspace/package.json'), 'package.json must be present at the top level');
    assert.equal(
      topLevel.includes('/workspace/src/App.jsx'),
      false,
      'a nested file must NOT be flattened onto the top level'
    );

    const src = tree.find((n) => n.path === '/workspace/src');
    assert.ok(src && src.is_dir, 'src must be present as a directory node');
    assert.ok(
      src.children.some((c) => c.path === '/workspace/src/App.jsx'),
      'src/App.jsx must hang off its own parent directory'
    );
    assert.ok(pathsIn(tree).includes('/workspace/src/App.jsx'), 'src/App.jsx must be reachable in the tree');
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
    assert.ok(pathsIn(app.explorerTree).includes(newFilePath), 'Newly created file must appear in explorer tree');
  });

  test('TC-EXPL-05: Creating a new folder via fs_create_dir updates filesystem and explorer tree', async () => {
    const newDirPath = '/workspace/docs';
    await app.ipc.invoke('fs_create_dir', { path: newDirPath });

    await app.refreshExplorer();
    const dirNodes = flatten(app.explorerTree).filter((n) => n.is_dir).map((n) => n.path);
    assert.ok(dirNodes.includes(newDirPath), 'Newly created directory must appear in explorer tree');
  });

  test('TC-EXPL-06: Deleting a file via fs_delete_path removes it from tree', async () => {
    const targetFile = '/workspace/README.md';
    await app.ipc.invoke('fs_delete_path', { path: targetFile, recursive: false });

    await app.refreshExplorer();
    const treePaths = pathsIn(app.explorerTree);
    assert.equal(treePaths.includes(targetFile), false, 'Deleted file must not be present in explorer tree');
  });

  test('TC-EXPL-07: Refresh button reloads filesystem while preserving user expanded folders', async () => {
    app.expandedFolders.add('/workspace/src');
    app.expandedFolders.add('/workspace/tests');

    await app.refreshExplorer();

    assert.equal(app.expandedFolders.has('/workspace/src'), true, 'Expanded src folder state preserved');
    assert.equal(app.expandedFolders.has('/workspace/tests'), true, 'Expanded tests folder state preserved');
  });

  /**
   * The Explorer menu's Reveal and Open Terminal Here (A12-1, A12-2) with the
   * real `fs_reveal_path` wrapper and the real terminal store, through the
   * mock bridge: what was revealed is the bridge's `revealed`, and the shell
   * is the bridge's `pty_spawn`.
   */
  function openActions(target, errors, externalEditorCommand = '') {
    return buildOpenActionItems(target, {
      os: 'linux',
      rootPath: '/workspace',
      reveal: revealInFileManager,
      createTab: (options) => app.terminal.createTab(options),
      focusTerminal: () => {},
      externalEditorCommand,
      openInExternalEditor,
      setError: (text) => errors.push(text),
    });
  }
  const pick = (items, key) => items.find((i) => i.key === key);

  test('TC-EXPL-B2-01: Reveal sends fs_reveal_path for the row, and the open folder for the empty area', async () => {
    app.ipc.bridge.revealed.length = 0;
    const errors = [];
    const file = { type: 'file', path: '/workspace/src/calculator.js', isDir: false, name: 'calculator.js' };
    const empty = { type: 'empty', path: '/workspace', isDir: true, name: '/workspace' };

    const reveal = pick(openActions(file, errors), 'reveal');
    assert.equal(reveal.label, 'Reveal in File Manager');
    await reveal.onSelect();
    await pick(openActions(empty, errors), 'reveal').onSelect();
    assert.deepEqual(app.ipc.bridge.revealed, [
      { path: '/workspace/src/calculator.js', kind: 'file' },
      { path: '/workspace', kind: 'dir' },
    ]);
    assert.deepEqual(
      app.ipc.calls.filter((c) => c.command === 'fs_reveal_path').map((c) => c.args),
      [{ path: '/workspace/src/calculator.js' }, { path: '/workspace' }]
    );
    assert.deepEqual(errors, []);

    // What the backend refuses is the Explorer's error, and nothing is revealed.
    const gone = { type: 'file', path: '/workspace/src/gone.js', isDir: false, name: 'gone.js' };
    await pick(openActions(gone, errors), 'reveal').onSelect();
    assert.equal(app.ipc.bridge.revealed.length, 2, 'nothing new revealed');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /No such file or directory/);
  });

  test("TC-EXPL-B2-02: Open Terminal Here starts a shell in the file's folder, strictly, as the active terminal", async () => {
    const errors = [];
    const before = app.terminal.tabs.length;
    const file = { type: 'file', path: '/workspace/src/calculator.js', isDir: false, name: 'calculator.js' };
    await pick(openActions(file, errors), 'open-terminal-here').onSelect();
    assert.deepEqual(errors, []);
    const spawns = app.ipc.calls.filter((c) => c.command === 'pty_spawn').map((c) => c.args);
    const last = spawns.at(-1);
    assert.equal(last.cwd, '/workspace/src', "the file's folder");
    assert.equal(last.strict_cwd, true, 'there or nowhere');
    assert.equal(app.terminal.tabs.length, before + 1, 'one new terminal');
    const added = app.terminal.tabs.at(-1);
    assert.equal(app.activeTerminalTabId, added.id, 'and it is the active one');

    // A folder the shell cannot start in: no terminal, and an error naming it.
    const count = app.terminal.tabs.length;
    const missing = { type: 'folder', path: '/workspace/not-there', isDir: true, name: 'not-there' };
    await pick(openActions(missing, errors), 'open-terminal-here').onSelect();
    assert.equal(app.terminal.tabs.length, count, 'no terminal anywhere else');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith('No terminal could be started in /workspace/not-there'), errors[0]);
  });

  test('TC-EXPL-B2-03: Open in External Editor sends fs_open_in_external_editor only while an editor is set', async () => {
    app.ipc.bridge.externalEditorOpens.length = 0;
    const errors = [];
    const file = { type: 'file', path: '/workspace/src/calculator.js', isDir: false, name: 'calculator.js' };
    const empty = { type: 'empty', path: '/workspace', isDir: true, name: '/workspace' };

    // Not set: not in the menu, and nothing asked of the backend.
    assert.equal(pick(openActions(file, errors, '   '), 'open-in-external-editor'), undefined);

    await pick(openActions(file, errors, 'subl -w'), 'open-in-external-editor').onSelect();
    await pick(openActions(empty, errors, 'code'), 'open-in-external-editor').onSelect();
    assert.deepEqual(errors, []);
    assert.deepEqual(
      app.ipc.calls.filter((c) => c.command === 'fs_open_in_external_editor').map((c) => c.args),
      [{ command: 'subl -w', path: '/workspace/src/calculator.js' }, { command: 'code', path: '/workspace' }]
    );
    assert.deepEqual(app.ipc.bridge.externalEditorOpens, [
      { command: 'subl -w', path: '/workspace/src/calculator.js' },
      { command: 'code', path: '/workspace' },
    ]);

    // A shell is refused, in the backend's words, and nothing is recorded.
    await pick(openActions(file, errors, 'zsh -c'), 'open-in-external-editor').onSelect();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^'zsh' is a shell or opens files in their default app/);
    assert.equal(app.ipc.bridge.externalEditorOpens.length, 2, 'nothing new recorded');
  });
});
