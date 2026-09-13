/**
 * Store-level coverage for the Explorer's VS Code-style context menu logic
 * added to src/stores/editorStore.js: the cut/copy/paste clipboard and the
 * rename flow. Moves and renames go through the single `fs_rename_path`
 * command; only a copy still walks the tree. These tests exercise the actual
 * store + the real browser mock bridge from src/lib/ipc.js rather than a
 * stand-alone reimplementation.
 *
 * The last four cases are regressions for the copy-then-delete era, when a
 * folder rename dropped everything below the first level and a rename that
 * only changed capitalisation deleted the file outright.
 */

import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke } from '../../src/lib/ipc.js';

let scratchCounter = 0;
let scratchDir;

async function makeScratchDir() {
  scratchCounter += 1;
  const dir = `/workspace/_explorer_actions_scratch_${Date.now()}_${scratchCounter}`;
  await invoke('fs_create_dir', { path: dir });
  return dir;
}

function resetMenuState() {
  useEditorStore.setState({
    clipboard: null,
    creatingEntry: null,
    renamingPath: null,
    selectedPath: null,
    tabs: [],
    activeTabId: null,
  });
}

describe('Explorer context menu — clipboard (Cut/Copy/Paste)', () => {
  beforeEach(async () => {
    resetMenuState();
    scratchDir = await makeScratchDir();
    await useEditorStore.getState().refreshExplorer();
  });

  test('copyToClipboard/cutToClipboard/clearClipboard set and clear clipboard state', () => {
    const store = useEditorStore.getState();

    store.copyToClipboard('/workspace/a.js', false);
    assert.deepEqual(useEditorStore.getState().clipboard, {
      mode: 'copy',
      path: '/workspace/a.js',
      isDir: false,
    });

    store.cutToClipboard('/workspace/folder', true);
    assert.deepEqual(useEditorStore.getState().clipboard, {
      mode: 'cut',
      path: '/workspace/folder',
      isDir: true,
    });

    store.clearClipboard();
    assert.equal(useEditorStore.getState().clipboard, null);
  });

  test('Copy + Paste duplicates a file and resolves name conflicts like VS Code', async () => {
    const filePath = `${scratchDir}/note.txt`;
    await invoke('fs_write_file', { path: filePath, content: 'hello world' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(filePath, false);
    await useEditorStore.getState().pasteClipboard(scratchDir);

    const firstDup = `${scratchDir}/note copy.txt`;
    assert.equal(await invoke('fs_read_file', { path: firstDup }), 'hello world');
    // Original must still exist — this was a copy, not a move.
    assert.equal(await invoke('fs_read_file', { path: filePath }), 'hello world');
    assert.ok(useEditorStore.getState().clipboard, 'copy clipboard should persist so it can be pasted again');

    // Paste again: the "note copy.txt" name is now taken too.
    await useEditorStore.getState().refreshExplorer();
    await useEditorStore.getState().pasteClipboard(scratchDir);
    const secondDup = `${scratchDir}/note copy 2.txt`;
    assert.equal(await invoke('fs_read_file', { path: secondDup }), 'hello world');
  });

  test('Cut + Paste moves a file, follows an open tab to the new path, and clears the clipboard', async () => {
    const srcDir = `${scratchDir}/src`;
    const destDir = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: srcDir });
    await invoke('fs_create_dir', { path: destDir });
    const filePath = `${srcDir}/moved.txt`;
    await invoke('fs_write_file', { path: filePath, content: 'move me' });
    await useEditorStore.getState().refreshExplorer();

    const openedTab = await useEditorStore.getState().openFile(filePath);

    useEditorStore.getState().cutToClipboard(filePath, false);
    await useEditorStore.getState().pasteClipboard(destDir);

    const newPath = `${destDir}/moved.txt`;
    assert.equal(await invoke('fs_read_file', { path: newPath }), 'move me');
    await assert.rejects(
      () => invoke('fs_read_file', { path: filePath }),
      /File not found/,
      'source file must be gone after a move'
    );

    const movedTab = useEditorStore.getState().tabs.find((t) => t.id === openedTab.id);
    assert.ok(movedTab, 'the tab for the moved file must still exist');
    assert.equal(movedTab.filePath, newPath, 'open tab must follow the file to its new location');
    assert.equal(movedTab.fileName, 'moved.txt');

    assert.equal(useEditorStore.getState().clipboard, null, 'cut clipboard must clear after a successful paste');
  });

  test('Cut + Paste recursively moves a folder, its files, and remaps expanded state', async () => {
    const folderPath = `${scratchDir}/folderToMove`;
    const destParent = `${scratchDir}/destParent`;
    await invoke('fs_create_dir', { path: folderPath });
    await invoke('fs_create_dir', { path: destParent });
    await invoke('fs_create_dir', { path: `${folderPath}/nested` });
    await invoke('fs_write_file', { path: `${folderPath}/a.txt`, content: 'A' });
    await invoke('fs_write_file', { path: `${folderPath}/nested/b.txt`, content: 'B' });
    await useEditorStore.getState().refreshExplorer();
    useEditorStore.getState().toggleFolder(folderPath);
    assert.ok(useEditorStore.getState().expandedFolders.has(folderPath));

    useEditorStore.getState().cutToClipboard(folderPath, true);
    await useEditorStore.getState().pasteClipboard(destParent);

    const newFolder = `${destParent}/folderToMove`;
    assert.equal(await invoke('fs_read_file', { path: `${newFolder}/a.txt` }), 'A');
    assert.equal(await invoke('fs_read_file', { path: `${newFolder}/nested/b.txt` }), 'B');
    await assert.rejects(() => invoke('fs_read_file', { path: `${folderPath}/a.txt` }), /File not found/);

    assert.equal(useEditorStore.getState().expandedFolders.has(newFolder), true, 'expanded state must follow the moved folder');
    assert.equal(useEditorStore.getState().expandedFolders.has(folderPath), false);
  });

  test('Cut + Paste into the same parent folder is a no-op that still clears the clipboard', async () => {
    const filePath = `${scratchDir}/same.txt`;
    await invoke('fs_write_file', { path: filePath, content: 'stay put' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().cutToClipboard(filePath, false);
    await useEditorStore.getState().pasteClipboard(scratchDir);

    assert.equal(await invoke('fs_read_file', { path: filePath }), 'stay put');
    assert.equal(useEditorStore.getState().clipboard, null);
  });

  test('Pasting a cut/copied folder into itself or one of its own children throws', async () => {
    const folderPath = `${scratchDir}/guardFolder`;
    await invoke('fs_create_dir', { path: folderPath });
    await invoke('fs_create_dir', { path: `${folderPath}/child` });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(folderPath, true);
    await assert.rejects(() => useEditorStore.getState().pasteClipboard(folderPath));
    await assert.rejects(() => useEditorStore.getState().pasteClipboard(`${folderPath}/child`));
  });

  test('pasteClipboard resolves without effect when nothing was cut or copied', async () => {
    resetMenuState();
    await assert.doesNotReject(() => useEditorStore.getState().pasteClipboard(scratchDir));
    assert.equal(useEditorStore.getState().clipboard, null);
  });
});

describe('Explorer context menu — Rename', () => {
  beforeEach(async () => {
    resetMenuState();
    scratchDir = await makeScratchDir();
    await useEditorStore.getState().refreshExplorer();
  });

  test('renamePath renames a file and updates its open tab', async () => {
    const oldPath = `${scratchDir}/old.txt`;
    await invoke('fs_write_file', { path: oldPath, content: 'rename me' });
    await useEditorStore.getState().refreshExplorer();

    const tab = await useEditorStore.getState().openFile(oldPath);

    await useEditorStore.getState().renamePath(oldPath, 'new.txt');

    const newPath = `${scratchDir}/new.txt`;
    assert.equal(await invoke('fs_read_file', { path: newPath }), 'rename me');
    await assert.rejects(() => invoke('fs_read_file', { path: oldPath }), /File not found/);

    const renamedTab = useEditorStore.getState().tabs.find((t) => t.id === tab.id);
    assert.equal(renamedTab.filePath, newPath);
    assert.equal(renamedTab.fileName, 'new.txt');
  });

  test('renamePath recursively renames a folder and remaps expanded state', async () => {
    const oldFolder = `${scratchDir}/oldFolder`;
    await invoke('fs_create_dir', { path: oldFolder });
    await invoke('fs_write_file', { path: `${oldFolder}/x.txt`, content: 'X' });
    await useEditorStore.getState().refreshExplorer();
    useEditorStore.getState().toggleFolder(oldFolder);

    await useEditorStore.getState().renamePath(oldFolder, 'newFolder');

    const newFolder = `${scratchDir}/newFolder`;
    assert.equal(await invoke('fs_read_file', { path: `${newFolder}/x.txt` }), 'X');
    await assert.rejects(() => invoke('fs_read_file', { path: `${oldFolder}/x.txt` }), /File not found/);
    assert.equal(useEditorStore.getState().expandedFolders.has(newFolder), true);
    assert.equal(useEditorStore.getState().expandedFolders.has(oldFolder), false);
  });

  test('renamePath rejects an empty name or a name containing "/"', async () => {
    const oldPath = `${scratchDir}/keep.txt`;
    await invoke('fs_write_file', { path: oldPath, content: 'keep' });
    await useEditorStore.getState().refreshExplorer();

    await assert.rejects(() => useEditorStore.getState().renamePath(oldPath, ''));
    await assert.rejects(() => useEditorStore.getState().renamePath(oldPath, '   '));
    await assert.rejects(() => useEditorStore.getState().renamePath(oldPath, 'a/b'));

    // Nothing should have moved after the rejected attempts.
    assert.equal(await invoke('fs_read_file', { path: oldPath }), 'keep');
  });

  test('renamePath is a no-op when the new name equals the current name', async () => {
    const oldPath = `${scratchDir}/same-name.txt`;
    await invoke('fs_write_file', { path: oldPath, content: 'same' });
    await useEditorStore.getState().refreshExplorer();

    await useEditorStore.getState().renamePath(oldPath, 'same-name.txt');
    assert.equal(await invoke('fs_read_file', { path: oldPath }), 'same');
  });
});

describe('Explorer context menu — selection, inline create and rename UI state', () => {
  beforeEach(() => {
    resetMenuState();
  });

  test('setCreatingEntry auto-expands a collapsed target folder so its inline row is visible', () => {
    const folder = '/workspace/src';
    useEditorStore.setState((state) => {
      const next = new Set(state.expandedFolders);
      next.delete(folder);
      return { expandedFolders: next };
    });
    assert.equal(useEditorStore.getState().expandedFolders.has(folder), false);

    useEditorStore.getState().setCreatingEntry({ parentPath: folder, type: 'file' });

    assert.equal(useEditorStore.getState().expandedFolders.has(folder), true);
    assert.deepEqual(useEditorStore.getState().creatingEntry, { parentPath: folder, type: 'file' });
  });

  test('setCreatingEntry does not need to touch expandedFolders for the workspace root', () => {
    const rootPath = useEditorStore.getState().rootPath;
    useEditorStore.getState().setCreatingEntry({ parentPath: rootPath, type: 'folder' });
    assert.deepEqual(useEditorStore.getState().creatingEntry, { parentPath: rootPath, type: 'folder' });
  });

  test('setCreatingEntry(null) clears the pending entry', () => {
    useEditorStore.getState().setCreatingEntry({ parentPath: '/workspace', type: 'folder' });
    assert.ok(useEditorStore.getState().creatingEntry);
    useEditorStore.getState().setCreatingEntry(null);
    assert.equal(useEditorStore.getState().creatingEntry, null);
  });

  test('beginRename selects the row and sets renamingPath; cancelRename clears it', () => {
    useEditorStore.getState().beginRename('/workspace/README.md');
    assert.equal(useEditorStore.getState().renamingPath, '/workspace/README.md');
    assert.equal(useEditorStore.getState().selectedPath, '/workspace/README.md');

    useEditorStore.getState().cancelRename();
    assert.equal(useEditorStore.getState().renamingPath, null);
  });

  test('setSelectedPath updates and clears the highlighted row', () => {
    useEditorStore.getState().setSelectedPath('/workspace/src');
    assert.equal(useEditorStore.getState().selectedPath, '/workspace/src');
    useEditorStore.getState().setSelectedPath(null);
    assert.equal(useEditorStore.getState().selectedPath, null);
  });
});

describe('Explorer context menu — Reveal in Finder/Explorer (documented no-op)', () => {
  test('revealPath resolves without throwing since no reveal IPC command exists', async () => {
    await assert.doesNotReject(() => useEditorStore.getState().revealPath('/workspace/README.md'));
  });

  test('copying a folder duplicates every level of it', async () => {
    const src = `${scratchDir}/lib`;
    const dest = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: src });
    await invoke('fs_create_dir', { path: `${src}/deep` });
    await invoke('fs_create_dir', { path: `${src}/deep/deeper` });
    await invoke('fs_write_file', { path: `${src}/top.js`, content: 't' });
    await invoke('fs_write_file', { path: `${src}/deep/mid.js`, content: 'm' });
    await invoke('fs_write_file', { path: `${src}/deep/deeper/leaf.js`, content: 'l' });
    await invoke('fs_create_dir', { path: dest });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(src, true);
    await useEditorStore.getState().pasteClipboard(dest);

    // fs_read_dir nests its results; a copy that walks only the top level
    // silently produces empty directories below the first level.
    assert.equal(await invoke('fs_read_file', { path: `${dest}/lib/top.js` }), 't');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/lib/deep/mid.js` }), 'm');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/lib/deep/deeper/leaf.js` }), 'l');
    // the original must be untouched by a copy
    assert.equal(await invoke('fs_read_file', { path: `${src}/deep/deeper/leaf.js` }), 'l');
  });

  test('renamePath keeps every descendant of a folder, not just the first level', async () => {
    const src = `${scratchDir}/proj`;
    await invoke('fs_create_dir', { path: src });
    await invoke('fs_create_dir', { path: `${src}/src` });
    await invoke('fs_create_dir', { path: `${src}/src/nested` });
    await invoke('fs_write_file', { path: `${src}/top.txt`, content: 'top' });
    await invoke('fs_write_file', { path: `${src}/src/a.js`, content: 'a' });
    await invoke('fs_write_file', { path: `${src}/src/nested/b.js`, content: 'b' });
    await useEditorStore.getState().refreshExplorer();

    await useEditorStore.getState().renamePath(src, 'proj2');

    const dest = `${scratchDir}/proj2`;
    assert.equal(await invoke('fs_read_file', { path: `${dest}/top.txt` }), 'top');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/src/a.js` }), 'a');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/src/nested/b.js` }), 'b');
    await assert.rejects(() => invoke('fs_read_file', { path: `${src}/src/nested/b.js` }));
  });

  test('renamePath refuses to overwrite an existing sibling', async () => {
    const keep = `${scratchDir}/keep.txt`;
    const other = `${scratchDir}/other.txt`;
    await invoke('fs_write_file', { path: keep, content: 'KEEP ME' });
    await invoke('fs_write_file', { path: other, content: 'other' });
    await useEditorStore.getState().refreshExplorer();

    await assert.rejects(
      () => useEditorStore.getState().renamePath(other, 'keep.txt'),
      /already exists/
    );
    assert.equal(await invoke('fs_read_file', { path: keep }), 'KEEP ME');
    assert.equal(await invoke('fs_read_file', { path: other }), 'other');
  });

  test('cutting a folder into another folder moves the whole subtree', async () => {
    const src = `${scratchDir}/pkg`;
    const dest = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: src });
    await invoke('fs_create_dir', { path: `${src}/lib` });
    await invoke('fs_create_dir', { path: dest });
    await invoke('fs_write_file', { path: `${src}/index.js`, content: 'i' });
    await invoke('fs_write_file', { path: `${src}/lib/util.js`, content: 'u' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().cutToClipboard(src, true);
    await useEditorStore.getState().pasteClipboard(dest);

    assert.equal(await invoke('fs_read_file', { path: `${dest}/pkg/index.js` }), 'i');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/pkg/lib/util.js` }), 'u');
    await assert.rejects(() => invoke('fs_read_file', { path: `${src}/lib/util.js` }));
  });

  test('pasting into a nested folder suffixes a name collision instead of clobbering it', async () => {
    const sub = `${scratchDir}/sub`;
    await invoke('fs_create_dir', { path: sub });
    await invoke('fs_write_file', { path: `${scratchDir}/keep.txt`, content: 'ROOT COPY' });
    await invoke('fs_write_file', { path: `${sub}/keep.txt`, content: 'SUB PRECIOUS' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(`${scratchDir}/keep.txt`, false);
    await useEditorStore.getState().pasteClipboard(sub);

    // The sibling set must be read from the nested tree, not just the root's
    // own children, or the suffix never triggers and the destination is lost.
    assert.equal(await invoke('fs_read_file', { path: `${sub}/keep.txt` }), 'SUB PRECIOUS');
    assert.equal(await invoke('fs_read_file', { path: `${sub}/keep copy.txt` }), 'ROOT COPY');
  });
});
