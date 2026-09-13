/**
 * Closing an editor tab used to drop unsaved edits with no prompt: `closeTab`
 * never looked at `isDirty` and neither the X button nor a middle-click asked.
 * The store keeps `closeTab`/`closeEditorPane` unconditional and the UI now
 * goes through `requestClose*`, which parks the close in `pendingClose` until
 * the user answers.
 */

import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke } from '../../src/lib/ipc.js';

const S = useEditorStore;
let counter = 0;

async function openDirtyFile(content = 'on disk', edited = 'edited in the buffer') {
  counter += 1;
  const path = `/workspace/_unsaved_${Date.now()}_${counter}.txt`;
  await invoke('fs_write_file', { path, content });
  const tab = await S.getState().openFile(path);
  S.getState().editBuffer(tab.id, edited);
  return { path, tab: S.getState().tabs.find((t) => t.id === tab.id) };
}

describe('Closing an editor tab with unsaved edits', () => {
  beforeEach(() => {
    S.setState({
      tabs: [],
      activeTabId: null,
      pendingClose: null,
      editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
      activeEditorPaneId: 'editor-pane-root',
    });
  });

  test('a clean tab closes immediately', async () => {
    const { tab } = await openDirtyFile('same', 'same');
    assert.equal(S.getState().tabs.find((t) => t.id === tab.id).isDirty, false);

    S.getState().requestCloseTab(tab.id);

    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.length, 0);
  });

  test('a dirty tab is held, not closed', async () => {
    const { tab } = await openDirtyFile();
    assert.equal(tab.isDirty, true);

    S.getState().requestCloseTab(tab.id);

    assert.equal(S.getState().tabs.length, 1, 'tab was closed without asking');
    const pending = S.getState().pendingClose;
    assert.equal(pending.kind, 'tab');
    assert.deepEqual(pending.tabIds, [tab.id]);
  });

  test('cancelling keeps the tab and its edits', async () => {
    const { tab } = await openDirtyFile();
    S.getState().requestCloseTab(tab.id);
    S.getState().cancelPendingClose();

    assert.equal(S.getState().pendingClose, null);
    const still = S.getState().tabs.find((t) => t.id === tab.id);
    assert.equal(still.content, 'edited in the buffer');
    assert.equal(still.isDirty, true);
  });

  test("'Don't Save' closes and leaves the file on disk untouched", async () => {
    const { path, tab } = await openDirtyFile();
    S.getState().requestCloseTab(tab.id);
    S.getState().discardPendingClose();

    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.length, 0);
    assert.equal(await invoke('fs_read_file', { path }), 'on disk');
  });

  test("'Save' writes the buffer and then closes", async () => {
    const { path, tab } = await openDirtyFile();
    S.getState().requestCloseTab(tab.id);
    await S.getState().savePendingClose();

    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.length, 0);
    assert.equal(await invoke('fs_read_file', { path }), 'edited in the buffer');
  });

  test('a failed save keeps the prompt and the tab', async () => {
    const { tab } = await openDirtyFile();
    S.getState().requestCloseTab(tab.id);

    const realSave = S.getState().saveFile;
    S.setState({ saveFile: async () => { throw new Error('disk full'); } });
    await assert.rejects(() => S.getState().savePendingClose(), /disk full/);
    S.setState({ saveFile: realSave });

    assert.notEqual(S.getState().pendingClose, null, 'prompt was dismissed after a failed save');
    assert.equal(S.getState().tabs.length, 1, 'tab was closed over an edit that never reached disk');
  });

  test('closing a whole group asks about every unsaved tab in it', async () => {
    const a = await openDirtyFile('a', 'a edited');
    const b = await openDirtyFile('b', 'b');           // clean
    const c = await openDirtyFile('c', 'c edited');
    const paneId = S.getState().activeEditorPaneId;

    S.getState().requestCloseEditorPane(paneId);

    const pending = S.getState().pendingClose;
    assert.equal(pending.kind, 'pane');
    assert.deepEqual(pending.tabIds.sort(), [a.tab.id, c.tab.id].sort());
    assert.equal(pending.tabIds.includes(b.tab.id), false, 'a clean tab should not be listed');
    assert.equal(S.getState().tabs.length, 3);
  });

  test('a group with nothing unsaved closes immediately', async () => {
    await openDirtyFile('x', 'x');
    const paneId = S.getState().activeEditorPaneId;

    S.getState().requestCloseEditorPane(paneId);

    assert.equal(S.getState().pendingClose, null);
    assert.equal(S.getState().tabs.length, 0);
  });
});

describe('Saving over a file that changed on disk', () => {
  beforeEach(() => {
    S.setState({ tabs: [], activeTabId: null, pendingClose: null, pendingOverwrite: null });
  });

  test('a save that would clobber an external change is refused', async () => {
    counter += 1;
    const path = `/workspace/_ext_${Date.now()}_${counter}.txt`;
    await invoke('fs_write_file', { path, content: 'version A' });
    const tab = await S.getState().openFile(path);
    S.getState().editBuffer(tab.id, 'my edit');

    // git / a formatter / the app's own terminal moves the file underneath us
    await invoke('fs_write_file', { path, content: 'version B from git' });

    await assert.rejects(() => S.getState().saveFile(tab.id), /changed on disk/);
    assert.equal(await invoke('fs_read_file', { path }), 'version B from git');
    assert.equal(S.getState().pendingOverwrite.tabId, tab.id);
  });

  test('confirming the overwrite writes the buffer', async () => {
    counter += 1;
    const path = `/workspace/_ext_${Date.now()}_${counter}.txt`;
    await invoke('fs_write_file', { path, content: 'A' });
    const tab = await S.getState().openFile(path);
    S.getState().editBuffer(tab.id, 'mine');
    await invoke('fs_write_file', { path, content: 'B' });
    await assert.rejects(() => S.getState().saveFile(tab.id));

    await S.getState().confirmPendingOverwrite();

    assert.equal(await invoke('fs_read_file', { path }), 'mine');
    assert.equal(S.getState().pendingOverwrite, null);
    assert.equal(S.getState().tabs.find((t) => t.id === tab.id).isDirty, false);
  });

  test('taking the disk version discards the buffer', async () => {
    counter += 1;
    const path = `/workspace/_ext_${Date.now()}_${counter}.txt`;
    await invoke('fs_write_file', { path, content: 'A' });
    const tab = await S.getState().openFile(path);
    S.getState().editBuffer(tab.id, 'mine');
    await invoke('fs_write_file', { path, content: 'B' });
    await assert.rejects(() => S.getState().saveFile(tab.id));

    await S.getState().reloadFromDisk(tab.id);

    const reloaded = S.getState().tabs.find((t) => t.id === tab.id);
    assert.equal(reloaded.content, 'B');
    assert.equal(reloaded.isDirty, false);
    assert.equal(await invoke('fs_read_file', { path }), 'B');
  });

  test('an ordinary save still works when nothing else touched the file', async () => {
    counter += 1;
    const path = `/workspace/_ext_${Date.now()}_${counter}.txt`;
    await invoke('fs_write_file', { path, content: 'A' });
    const tab = await S.getState().openFile(path);
    S.getState().editBuffer(tab.id, 'A edited');

    await S.getState().saveFile(tab.id);

    assert.equal(await invoke('fs_read_file', { path }), 'A edited');
    assert.equal(S.getState().pendingOverwrite, null);
  });

  test('deleting a folder closes the tabs of files inside it', async () => {
    counter += 1;
    const dir = `/workspace/_deldir_${Date.now()}_${counter}`;
    await invoke('fs_create_dir', { path: dir });
    await invoke('fs_write_file', { path: `${dir}/inside.txt`, content: 'in' });
    const tab = await S.getState().openFile(`${dir}/inside.txt`);
    assert.equal(S.getState().tabs.some((t) => t.id === tab.id), true);

    await S.getState().deletePath(dir, true);

    // Leaving the tab open let a later save recreate the directory the user
    // had just deleted.
    assert.equal(S.getState().tabs.some((t) => t.id === tab.id), false);
  });
});
