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

import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';

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

describe('Explorer context menu — Reveal in Finder/Explorer (fs_reveal_path)', () => {
  test('revealPath resolves without throwing for a file that exists, and asks the backend to show it', async () => {
    const before = mockBridge.revealed.length;
    await assert.doesNotReject(() => useEditorStore.getState().revealPath('/workspace/README.md'));
    assert.deepEqual(mockBridge.revealed.slice(before), [{ path: '/workspace/README.md', kind: 'file' }]);
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

/** Every IPC command `fn` sends, in order, answered by the mock as usual. */
async function commandsSentBy(fn) {
  const real = Object.getPrototypeOf(mockBridge).invoke;
  const sent = [];
  mockBridge.invoke = (command, args) => {
    sent.push(command);
    return real.call(mockBridge, command, args);
  };
  try {
    await fn();
  } finally {
    delete mockBridge.invoke;
  }
  return sent;
}

/**
 * Paste picked its " copy" name from the tree in memory, which is a few
 * levels deep and as old as its last refresh. A folder at the depth limit
 * comes back with no children, so a paste into it — src/main/java/com/acme in
 * any Java project — kept the name and wrote over the file there. And a copy
 * was rebuilt from fs_read_dir and fs_read_file: what the Explorer hides was
 * left out, and the first file that is not UTF-8 text stopped it half-way.
 */
describe('Explorer paste never writes over anything', () => {
  beforeEach(async () => {
    resetMenuState();
    scratchDir = await makeScratchDir();
    await useEditorStore.getState().refreshExplorer();
  });

  test('EP-01: a folder too deep for the tree in memory keeps its file; the copy gets its own name', async () => {
    // Four levels under the scratch folder, five under the root: refreshExplorer
    // reads five deep, so this folder is in the tree with no children.
    const deep = `${scratchDir}/main/java/com/acme`;
    for (const dir of [`${scratchDir}/main`, `${scratchDir}/main/java`, `${scratchDir}/main/java/com`, deep]) {
      await invoke('fs_create_dir', { path: dir });
    }
    await invoke('fs_write_file', { path: `${deep}/Util.java`, content: 'PRECIOUS' });
    await invoke('fs_write_file', { path: `${scratchDir}/Util.java`, content: 'the copy' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(`${scratchDir}/Util.java`, false);
    await useEditorStore.getState().pasteClipboard(deep);

    assert.equal(await invoke('fs_read_file', { path: `${deep}/Util.java` }), 'PRECIOUS', 'overwritten');
    assert.equal(await invoke('fs_read_file', { path: `${deep}/Util copy.java` }), 'the copy');
  });

  test('EP-02: a name that differs only in case is taken — NTFS and APFS call them one file', async () => {
    const dest = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: dest });
    await invoke('fs_write_file', { path: `${dest}/Note.txt`, content: 'PRECIOUS' });
    await invoke('fs_write_file', { path: `${scratchDir}/note.txt`, content: 'the copy' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(`${scratchDir}/note.txt`, false);
    await useEditorStore.getState().pasteClipboard(dest);

    assert.equal(await invoke('fs_read_file', { path: `${dest}/note copy.txt` }), 'the copy');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/Note.txt` }), 'PRECIOUS');
  });

  test('EP-03: a copied folder takes along what the Explorer hides', async () => {
    const src = `${scratchDir}/app`;
    const dest = `${scratchDir}/dest`;
    for (const dir of [src, `${src}/.git`, `${src}/node_modules`, `${src}/node_modules/left-pad`, `${src}/dist`, dest]) {
      await invoke('fs_create_dir', { path: dir });
    }
    await invoke('fs_write_file', { path: `${src}/index.js`, content: 'i' });
    await invoke('fs_write_file', { path: `${src}/.git/HEAD`, content: 'ref: refs/heads/main' });
    await invoke('fs_write_file', { path: `${src}/node_modules/left-pad/index.js`, content: 'pad' });
    await invoke('fs_write_file', { path: `${src}/dist/bundle.js`, content: 'bundle' });
    await useEditorStore.getState().refreshExplorer();

    useEditorStore.getState().copyToClipboard(src, true);
    await useEditorStore.getState().pasteClipboard(dest);

    assert.equal(await invoke('fs_read_file', { path: `${dest}/app/index.js` }), 'i');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/app/.git/HEAD` }), 'ref: refs/heads/main');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/app/node_modules/left-pad/index.js` }), 'pad');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/app/dist/bundle.js` }), 'bundle');
  });

  test('EP-04: a copy is one fs_copy_path — nothing is read as text and written back', async () => {
    // fs_read_file is read_to_string: a PNG or a font could not be copied at
    // all, and in a folder the first one stopped the copy half-way through.
    await invoke('fs_write_file', { path: `${scratchDir}/logo.png`, content: 'not really a png' });
    const dest = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: dest });
    await useEditorStore.getState().refreshExplorer();
    useEditorStore.getState().copyToClipboard(`${scratchDir}/logo.png`, false);

    const sent = await commandsSentBy(() => useEditorStore.getState().pasteClipboard(dest));

    assert.ok(sent.includes('fs_copy_path'), `sent: ${sent.join(', ')}`);
    assert.equal(sent.includes('fs_read_file'), false, 'the file was read as text');
    assert.equal(sent.includes('fs_write_file'), false, 'the file was written back as text');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/logo.png` }), 'not really a png');
  });

  test('EP-05: the destination is listed afresh, not looked up in the tree', async () => {
    // Made after the last refresh, so the tree in memory knows nothing of it.
    const dest = `${scratchDir}/fresh`;
    await invoke('fs_create_dir', { path: dest });
    await invoke('fs_write_file', { path: `${dest}/a.txt`, content: 'PRECIOUS' });
    await invoke('fs_write_file', { path: `${scratchDir}/a.txt`, content: 'the copy' });
    useEditorStore.setState({ fileTree: [] });

    useEditorStore.getState().copyToClipboard(`${scratchDir}/a.txt`, false);
    await useEditorStore.getState().pasteClipboard(dest);

    assert.equal(await invoke('fs_read_file', { path: `${dest}/a.txt` }), 'PRECIOUS');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/a copy.txt` }), 'the copy');
  });

  test('EP-07: while a paste copies, a second Paste is refused and the Explorer says what is copying', async () => {
    // Found in review: a big folder takes minutes with no sign of it, the
    // clipboard stays armed, and a second Paste started a second whole copy.
    await invoke('fs_write_file', { path: `${scratchDir}/big/a.txt`, content: 'a' });
    const dest = `${scratchDir}/into`;
    await invoke('fs_create_dir', { path: dest });
    await useEditorStore.getState().refreshExplorer();
    useEditorStore.getState().copyToClipboard(`${scratchDir}/big`, true);

    const real = Object.getPrototypeOf(mockBridge).invoke;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let copies = 0;
    mockBridge.invoke = async (command, args) => {
      if (command === 'fs_copy_path') {
        copies += 1;
        await held;
      }
      return real.call(mockBridge, command, args);
    };
    try {
      const first = useEditorStore.getState().pasteClipboard(dest);
      for (let i = 0; i < 20 && useEditorStore.getState().pasting === null; i += 1) await new Promise((r) => setTimeout(r, 1));
      assert.equal(useEditorStore.getState().pasting, 'big', 'what is copying is known while it copies');
      // Refused at once — not a second copy waiting behind the first.
      const second = useEditorStore.getState().pasteClipboard(dest).then(() => 'a second copy', (err) => err);
      const outcome = await Promise.race([second, new Promise((r) => setTimeout(() => r('still waiting'), 50))]);
      release();
      await first;
      await second;
      assert.ok(outcome instanceof Error && /Still copying 'big'/.test(outcome.message), String(outcome));
    } finally {
      release();
      delete mockBridge.invoke;
    }
    assert.equal(copies, 1, 'one copy, not two');
    assert.equal(useEditorStore.getState().pasting, null, 'and it is over');
    assert.equal(await invoke('fs_read_file', { path: `${dest}/big/a.txt` }), 'a');

    // A copy that fails is over too.
    mockBridge.invoke = async (command, args) =>
      command === 'fs_copy_path' ? Promise.reject(new Error('Failed to copy: disk full')) : real.call(mockBridge, command, args);
    try {
      await assert.rejects(() => useEditorStore.getState().pasteClipboard(`${scratchDir}`), /disk full/);
    } finally {
      delete mockBridge.invoke;
    }
    assert.equal(useEditorStore.getState().pasting, null);

    const explorer = readFileSync(new URL('../../src/components/explorer/FileExplorer.jsx', import.meta.url), 'utf8');
    assert.match(explorer, /const canPaste = Boolean\(clipboard\) && isFolderish && !pasting;/);
    assert.match(explorer, /\{pasting && \(\s*<div role="status"[^>]*>\s*Copying '\{pasting\}'…/);
  });

  test('EP-08: a delete names the unsaved files it will close first — a link\'s too', async () => {
    // Found in review: deleting closed every tab under the path, unsaved ones
    // included, with nothing said. Then (last review) keeping a link's
    // unsaved tabs open made Save put a new folder where the link had been.
    const { deletePromptMessage } = await import('../../src/components/explorer/treeRows.js');
    const store = useEditorStore.getState();
    await invoke('fs_create_dir', { path: `${scratchDir}/src` });
    await invoke('fs_write_file', { path: `${scratchDir}/src/a.js`, content: 'a' });
    await invoke('fs_write_file', { path: `${scratchDir}/src/b.js`, content: 'b' });
    await invoke('fs_write_file', { path: `${scratchDir}/src/c.js`, content: 'c' });
    const a = await store.openFile(`${scratchDir}/src/a.js`);
    const b = await store.openFile(`${scratchDir}/src/b.js`);
    await store.openFile(`${scratchDir}/src/c.js`);
    store.editBuffer(a.id, 'a edited');
    store.editBuffer(b.id, 'b edited');

    const unsaved = useEditorStore.getState().tabsUnder(`${scratchDir}/src`).filter((t) => t.isDirty).map((t) => t.fileName);
    assert.deepEqual(unsaved.sort(), ['a.js', 'b.js']);
    assert.equal(
      deletePromptMessage({ name: 'src', isDir: true, isLink: false }, ['a.js', 'b.js']),
      "Are you sure you want to delete 'src'? Its contents will be deleted too. Unsaved changes in a.js and b.js will be lost."
    );
    assert.equal(
      deletePromptMessage({ name: 'shared', isDir: true, isLink: true }, ['index.js']),
      "Are you sure you want to delete the link 'shared'? What it points to is not touched. Unsaved changes in index.js will be lost; save them first to keep them in what it points to."
    );
    assert.equal(deletePromptMessage({ name: 'x.txt', isDir: false, isLink: false }), "Are you sure you want to delete 'x.txt'?");
    assert.match(deletePromptMessage({ name: 'src', isDir: true }, ['a', 'b', 'c', 'd', 'e']), /in a, b and 3 other files will be lost\.$/);

    // Every tab under what was deleted closes, as the prompt said.
    await useEditorStore.getState().deletePath(`${scratchDir}/src`, true);
    assert.equal(useEditorStore.getState().tabs.some((t) => t.filePath.startsWith(`${scratchDir}/src`)), false);

    const explorer = readFileSync(new URL('../../src/components/explorer/FileExplorer.jsx', import.meta.url), 'utf8');
    assert.match(explorer, /message=\{deletePromptMessage\(deleteConfirm, deleteConfirm\.unsaved\)\}/);
    assert.doesNotMatch(explorer, /keepUnsaved/, 'no delete keeps a tab whose path is gone');
  });

  test('EP-09: a Paste is taken before the folder is even listed — a second one in that moment starts nothing', async () => {
    // Found in the last review: `pasting` was set only once a free name had
    // been found, which lists the destination first — slow on a big or
    // network folder — and a second Paste then started a second whole copy.
    await invoke('fs_write_file', { path: `${scratchDir}/big2/a.txt`, content: 'a' });
    const dest = `${scratchDir}/into2`;
    await invoke('fs_create_dir', { path: dest });
    await useEditorStore.getState().refreshExplorer();
    useEditorStore.getState().copyToClipboard(`${scratchDir}/big2`, true);

    const real = Object.getPrototypeOf(mockBridge).invoke;
    let release;
    const listing = new Promise((resolve) => { release = resolve; });
    let copies = 0;
    mockBridge.invoke = async (command, args) => {
      if (command === 'fs_read_dir' && args?.path === dest) await listing;
      if (command === 'fs_copy_path') copies += 1;
      return real.call(mockBridge, command, args);
    };
    try {
      const first = useEditorStore.getState().pasteClipboard(dest);
      assert.equal(useEditorStore.getState().pasting, 'big2', 'taken before the listing answers');
      const second = await useEditorStore.getState().pasteClipboard(dest).then(() => 'a second paste', (err) => err);
      assert.ok(second instanceof Error && /Still copying 'big2'/.test(second.message), String(second));
      release();
      await first;
    } finally {
      release();
      delete mockBridge.invoke;
    }
    assert.equal(copies, 1);
    assert.equal(useEditorStore.getState().pasting, null);
  });

  test('EP-06: fs_copy_path refuses a destination that exists, and writes nothing (the mock keeps the contract)', async () => {
    const src = `${scratchDir}/src`;
    const dest = `${scratchDir}/dest`;
    await invoke('fs_create_dir', { path: src });
    await invoke('fs_create_dir', { path: dest });
    await invoke('fs_write_file', { path: `${src}/a.txt`, content: 'new' });
    await invoke('fs_write_file', { path: `${dest}/a.txt`, content: 'PRECIOUS' });

    await assert.rejects(() => invoke('fs_copy_path', { from: `${src}/a.txt`, to: `${dest}/a.txt` }), /already exists/);
    await assert.rejects(() => invoke('fs_copy_path', { from: src, to: dest }), /already exists/);
    assert.equal(await invoke('fs_read_file', { path: `${dest}/a.txt` }), 'PRECIOUS');
    await assert.rejects(() => invoke('fs_read_file', { path: `${dest}/src/a.txt` }), /File not found/);
  });
});
