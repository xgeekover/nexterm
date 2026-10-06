/**
 * The editor with the paths Windows actually has.
 *
 * The backend hands back `C:\proj\src\main.js` on Windows, and the editor
 * store still put paths together and took them apart with '/':
 *
 * - deleting a folder closed the tabs whose path started with `C:\proj\src/`
 *   — none — so its files stayed open, and saving one recreated the folder;
 * - a rename built `C:\proj\src/b.js`, which no Explorer click matched, so the
 *   file opened a second time in a second tab, as did a terminal link
 *   (`C:\proj\src/App.jsx`);
 * - a name with '\' in it moved the file into a new folder;
 * - the breadcrumb split on '/' only, and showed the path as one segment.
 *
 * The browser mock keys files by whatever string it is given, so a Windows
 * workspace is set up in it by spelling the paths the way Windows does. The
 * helpers that are new are read through the module namespace, so that one
 * missing fails its own case rather than the whole file.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import * as paths from '../../src/lib/paths.js';

const S = useEditorStore;
const ROOT = 'C:\\proj';
let counter = 0;

/** A fresh folder under the Windows root, with these files in it. */
async function windowsFolder(files) {
  counter += 1;
  const dir = `${ROOT}\\src${counter}`;
  mockBridge.directories.add(dir);
  for (const [name, content] of Object.entries(files)) {
    await invoke('fs_write_file', { path: `${dir}\\${name}`, content });
  }
  return dir;
}

const tabOf = (id) => S.getState().tabs.find((t) => t.id === id);

/**
 * How a terminal link names `name` in `dir`: resolveLinkPath joins the
 * printed `src1/App.jsx` onto the root with '\', and keeps the '/' it printed.
 */
const linkTo = (dir, name) => `${ROOT}\\${dir.split('\\').pop()}/${name}`;

describe('The editor on Windows paths', () => {
  beforeEach(() => {
    S.setState({
      rootPath: ROOT,
      expandedFolders: new Set([ROOT]),
      tabs: [],
      activeTabId: null,
      pendingClose: null,
      pendingReveal: null,
      editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
      activeEditorPaneId: 'editor-pane-root',
    });
  });

  test('WE-01: deleting a folder closes the tabs of the files inside it, and only those', async () => {
    const dir = await windowsFolder({ 'main.js': 'm' });
    const sibling = `${dir}x`; // starts the same, is not inside
    mockBridge.directories.add(sibling);
    await invoke('fs_write_file', { path: `${sibling}\\keep.js`, content: 'k' });
    const inside = await S.getState().openFile(`${dir}\\main.js`);
    const outside = await S.getState().openFile(`${sibling}\\keep.js`);

    await S.getState().deletePath(dir, true);

    assert.equal(tabOf(inside.id), undefined, 'left open, a save recreates the folder just deleted');
    assert.ok(tabOf(outside.id), 'closed a tab in a folder whose name merely starts the same');
  });

  test('WE-02: a rename keeps the folder’s separator, and the Explorer finds the same tab', async () => {
    const dir = await windowsFolder({ 'a.js': 'a' });
    const tab = await S.getState().openFile(`${dir}\\a.js`);

    await S.getState().renamePath(`${dir}\\a.js`, 'b.js');

    assert.equal(tabOf(tab.id).filePath, `${dir}\\b.js`);
    assert.equal(await invoke('fs_read_file', { path: `${dir}\\b.js` }), 'a');
    // What a click on the renamed row in the Explorer passes.
    const clicked = await S.getState().openFile(`${dir}\\b.js`);
    assert.equal(clicked.id, tab.id, 'a second tab opened on the same file');
    assert.equal(S.getState().tabs.length, 1);
  });

  test('WE-03: a name with either separator in it is refused, and nothing moves', async () => {
    const dir = await windowsFolder({ 'a.js': 'a' });

    await assert.rejects(() => S.getState().renamePath(`${dir}\\a.js`, 'sub\\a.js'));
    await assert.rejects(() => S.getState().renamePath(`${dir}\\a.js`, 'sub/a.js'));

    assert.equal(await invoke('fs_read_file', { path: `${dir}\\a.js` }), 'a');
  });

  test('WE-04: a terminal link spelled with "/" lands on the tab that is open', async () => {
    const dir = await windowsFolder({ 'App.jsx': 'x' });
    const fromExplorer = await S.getState().openFile(`${dir}\\App.jsx`);

    const fromLink = await S.getState().openFile(linkTo(dir, 'App.jsx'));

    assert.equal(fromLink.id, fromExplorer.id, 'two tabs, two buffers, one file');
    assert.equal(S.getState().tabs.length, 1);
  });

  test('WE-05: a link opened first, then the Explorer: still one tab, spelled as the backend spells it', async () => {
    const dir = await windowsFolder({ 'App.jsx': 'x' });

    const fromLink = await S.getState().openFile(linkTo(dir, 'App.jsx'));
    const fromExplorer = await S.getState().openFile(`${dir}\\App.jsx`);

    assert.equal(fromExplorer.id, fromLink.id);
    assert.equal(fromLink.filePath, `${dir}\\App.jsx`);
  });

  test('WE-06: a link to a line puts the caret in the tab that is open', async () => {
    const dir = await windowsFolder({ 'App.jsx': 'x' });
    const tab = await S.getState().openFile(`${dir}\\App.jsx`);

    await S.getState().openFileAt(linkTo(dir, 'App.jsx'), 7, 3);

    // EditorPanel moves the caret only when this names the tab it shows.
    assert.equal(S.getState().pendingReveal?.filePath, tab.filePath);
    assert.equal(S.getState().pendingReveal?.line, 7);
  });

  test('WE-07: the breadcrumb splits a Windows path, whichever separators it was written with', () => {
    assert.equal(typeof paths.segmentsBelow, 'function', 'paths.js has no segmentsBelow');
    assert.deepEqual(paths.segmentsBelow(ROOT, `${ROOT}\\src\\components\\App.jsx`), ['src', 'components', 'App.jsx']);
    assert.deepEqual(paths.segmentsBelow(ROOT, `${ROOT}\\src/App.jsx`), ['src', 'App.jsx']);
    assert.deepEqual(paths.segmentsBelow('/work/proj', '/work/proj/src/App.jsx'), ['src', 'App.jsx']);
    assert.deepEqual(paths.segmentsBelow('/work/proj', '/elsewhere/a.js'), ['elsewhere', 'a.js'], 'outside the root: the whole path');
    assert.deepEqual(paths.segmentsBelow(null, 'D:\\x\\y.js'), ['D:', 'x', 'y.js']);
  });

  test('WE-08: only "/" ever becomes "\\", and only beside a Windows path', () => {
    assert.equal(typeof paths.withSepOf, 'function', 'paths.js has no withSepOf');
    assert.equal(paths.withSepOf('C:\\proj\\src/App.jsx', ROOT), 'C:\\proj\\src\\App.jsx');
    assert.equal(paths.withSepOf('C:/proj/src/App.jsx', ROOT), 'C:\\proj\\src\\App.jsx');
    // On unix '\' can be part of a name, and '/' is the only separator.
    assert.equal(paths.withSepOf('/work/odd\\name.txt', '/work'), '/work/odd\\name.txt');
    assert.equal(paths.withSepOf('/work/a.txt', null), '/work/a.txt');
  });

  test('WE-09: a file at the root of a drive: its folder is "C:\\", not "C:"', async () => {
    assert.equal(paths.dirname('C:\\a.txt'), 'C:\\');
    assert.equal(paths.join(paths.dirname('C:\\a.txt'), 'b.txt'), 'C:\\b.txt');

    S.setState({ rootPath: 'C:\\' });
    await invoke('fs_write_file', { path: 'C:\\at-the-root.txt', content: 'r' });
    const tab = await S.getState().openFile('C:\\at-the-root.txt');
    await S.getState().renamePath('C:\\at-the-root.txt', 'renamed.txt');

    assert.equal(tabOf(tab.id).filePath, 'C:\\renamed.txt', '"C:/renamed.txt" opens a second tab from the Explorer');
  });

  test('WE-10: teardown', () => {
    S.setState({
      rootPath: '/workspace',
      expandedFolders: new Set(['/workspace']),
      tabs: [],
      activeTabId: null,
      pendingReveal: null,
      editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
      activeEditorPaneId: 'editor-pane-root',
    });
    assert.equal(S.getState().rootPath, '/workspace');
  });
});
