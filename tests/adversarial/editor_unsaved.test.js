/**
 * Closing an editor tab used to drop unsaved edits with no prompt: `closeTab`
 * never looked at `isDirty` and neither the X button nor a middle-click asked.
 * The store keeps `closeTab`/`closeEditorPane` unconditional and the UI now
 * goes through `requestClose*`, which parks the close in `pendingClose` until
 * the user answers.
 */

import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';

const S = useEditorStore;
let counter = 0;

/**
 * Answer IPC calls through `handler` for as long as `fn` runs. `real()` is
 * the browser mock's own answer, so a handler can delay a call, count it or
 * replace it.
 */
async function withInvoke(handler, fn) {
  const real = Object.getPrototypeOf(mockBridge).invoke;
  mockBridge.invoke = (command, args) => handler(command, args, () => real.call(mockBridge, command, args));
  try {
    return await fn();
  } finally {
    delete mockBridge.invoke;
  }
}

/** A promise and the function that settles it. */
function signal() {
  let fire;
  const fired = new Promise((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

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

const emptyEditor = () => ({
  tabs: [],
  activeTabId: null,
  pendingClose: null,
  pendingOverwrite: null,
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
  activeEditorPaneId: 'editor-pane-root',
});

const tabOf = (id) => S.getState().tabs.find((t) => t.id === id);

/**
 * A save writes a snapshot of the buffer, but Monaco reports every keystroke
 * and the save takes two round trips: it reads the file back to look for an
 * external change, then writes. The text typed in between used to be marked
 * as saved, though it never reached the disk.
 */
describe('Saving while typing', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('ES-01: what is typed while a save is under way stays unsaved, and the next save writes it', async () => {
    const { path, tab } = await openDirtyFile('v0', 'v1');
    const landed = signal();
    const answer = signal();

    await withInvoke(
      async (command, args, real) => {
        const result = await real();
        if (command === 'fs_write_file' && args.path === path) {
          landed.fire(); // on disk, and the store has not heard back yet
          await answer.fired;
        }
        return result;
      },
      async () => {
        const saving = S.getState().saveFile(tab.id);
        await landed.fired;
        S.getState().editBuffer(tab.id, 'v1 and more');
        answer.fire();
        await saving;
      }
    );

    assert.equal(await invoke('fs_read_file', { path }), 'v1');
    const after = tabOf(tab.id);
    assert.equal(after.content, 'v1 and more');
    assert.equal(after.savedContent, 'v1', 'what was written is what counts as saved');
    assert.equal(after.isDirty, true, 'the text typed during the save never reached the disk');

    // Compared against what was written, the file on disk is this tab's own.
    await S.getState().saveFile(tab.id);
    assert.equal(S.getState().pendingOverwrite, null, 'its own last write taken for an external change');
    assert.equal(await invoke('fs_read_file', { path }), 'v1 and more');
    assert.equal(tabOf(tab.id).isDirty, false);
  });

  test('ES-02: a second save while the first is under way waits for it, rather than calling it an external change', async () => {
    const { path, tab } = await openDirtyFile('v0', 'v1');
    const landed = signal();
    const answer = signal();
    let held = false;

    await withInvoke(
      async (command, args, real) => {
        const result = await real();
        if (command === 'fs_write_file' && args.path === path && !held) {
          held = true;
          landed.fire();
          await answer.fired;
        }
        return result;
      },
      async () => {
        const first = S.getState().saveFile(tab.id);
        await landed.fired; // v1 is on disk; the first save has not heard back
        S.getState().editBuffer(tab.id, 'v2');
        const second = S.getState().saveFile(tab.id);
        answer.fire();
        await first;
        await second;
      }
    );

    assert.equal(S.getState().pendingOverwrite, null);
    assert.equal(await invoke('fs_read_file', { path }), 'v2');
    assert.equal(tabOf(tab.id).isDirty, false);
  });
});

describe('Saving from the close prompt into a file that changed on disk', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('ES-03: the overwrite question replaces the close question — never both open at once', async () => {
    // Both on screen, one Enter answered both: a plain save and a forced
    // overwrite of the same file, racing each other.
    const { path, tab } = await openDirtyFile('v0', 'mine');
    await invoke('fs_write_file', { path, content: 'theirs' });
    S.getState().requestCloseTab(tab.id);

    await assert.rejects(() => S.getState().savePendingClose(), /changed on disk/);

    assert.equal(S.getState().pendingClose, null, 'the close prompt stayed open under the overwrite prompt');
    assert.equal(S.getState().pendingOverwrite?.tabId, tab.id);
    assert.ok(tabOf(tab.id), 'the tab closed over an edit that never reached disk');
    assert.equal(await invoke('fs_read_file', { path }), 'theirs');
  });

  test('ES-04: Save pressed twice while the first is still writing saves once and closes once', async () => {
    const { path, tab } = await openDirtyFile('v0', 'mine');
    S.getState().requestCloseTab(tab.id);
    const landed = signal();
    const answer = signal();
    let writes = 0;

    await withInvoke(
      async (command, args, real) => {
        const result = await real();
        if (command === 'fs_write_file' && args.path === path) {
          writes += 1;
          landed.fire();
          await answer.fired;
        }
        return result;
      },
      async () => {
        const first = S.getState().savePendingClose();
        await landed.fired;
        const second = S.getState().savePendingClose();
        answer.fire();
        await Promise.all([first, second]);
      }
    );

    assert.equal(writes, 1);
    assert.equal(S.getState().pendingClose, null);
    assert.equal(tabOf(tab.id), undefined);
  });
});

/**
 * Open Folder…, Open Recent and the Explorer's folder button replaced every
 * editor tab with nothing, unsaved or not — re-opening the folder that was
 * already open (always the first entry in Open Recent) included.
 */
describe('Opening another folder with unsaved tabs', () => {
  const ROOT = '/workspace';
  const OTHER = '/workspace/src';

  beforeEach(() => {
    delete mockBridge.root;
    S.setState({ ...emptyEditor(), rootPath: ROOT, expandedFolders: new Set([ROOT]) });
  });

  test('ES-05: Open Recent asks first, and Cancel keeps the folder, the tab and the edit', async () => {
    const { tab } = await openDirtyFile();

    const opening = S.getState().openRoot(OTHER);
    const pending = S.getState().pendingClose;
    assert.ok(pending, 'the folder changed without a question');
    assert.equal(pending.kind, 'root');
    assert.deepEqual(pending.tabIds, [tab.id]);

    S.getState().cancelPendingClose();
    assert.equal(await opening, null);
    assert.equal(S.getState().rootPath, ROOT);
    assert.equal(tabOf(tab.id).content, 'edited in the buffer');
    assert.equal(tabOf(tab.id).isDirty, true);
  });

  test("ES-06: \"Don't Save\" opens the folder and leaves the file as it was", async () => {
    const { path } = await openDirtyFile();

    const opening = S.getState().openRoot(OTHER);
    await S.getState().discardPendingClose();

    assert.equal(await opening, OTHER);
    assert.equal(S.getState().rootPath, OTHER);
    assert.equal(S.getState().tabs.length, 0);
    assert.equal(await invoke('fs_read_file', { path }), 'on disk');
  });

  test('ES-07: "Save" writes the edit, then opens the folder', async () => {
    const { path } = await openDirtyFile();

    const opening = S.getState().openRoot(OTHER);
    await S.getState().savePendingClose();

    assert.equal(await opening, OTHER);
    assert.equal(await invoke('fs_read_file', { path }), 'edited in the buffer');
    assert.equal(S.getState().tabs.length, 0);
  });

  test('ES-08: choosing the folder that is already open closes nothing and asks nothing', async () => {
    const { tab } = await openDirtyFile();

    assert.equal(await S.getState().openRoot(ROOT), ROOT);

    assert.equal(S.getState().pendingClose, null);
    assert.ok(tabOf(tab.id), 'the tab was thrown away');
    assert.equal(tabOf(tab.id).isDirty, true);
  });

  test('ES-09: Open Folder… asks before the picker opens — the picker moves the root as it returns', async () => {
    const { tab } = await openDirtyFile();
    const picked = [];

    await withInvoke(
      async (command, args, real) => {
        if (command !== 'fs_pick_root') return real();
        picked.push(command);
        mockBridge.root = '/workspace/tests';
        return '/workspace/tests';
      },
      async () => {
        const picking = S.getState().pickRoot();
        await Promise.resolve();
        assert.deepEqual(picked, [], 'the picker opened, and moved the root, before anyone was asked');
        assert.equal(S.getState().pendingClose?.kind, 'root');
        assert.deepEqual(S.getState().pendingClose.tabIds, [tab.id]);

        await S.getState().discardPendingClose();
        assert.equal(await picking, '/workspace/tests');
      }
    );

    assert.deepEqual(picked, ['fs_pick_root']);
    assert.equal(S.getState().rootPath, '/workspace/tests');
    assert.equal(S.getState().tabs.length, 0);
  });

  test("ES-10: cancelling the picker after \"Don't Save\" gives nothing up", async () => {
    const { tab } = await openDirtyFile();

    await withInvoke(
      async (command, args, real) => (command === 'fs_pick_root' ? null : real()),
      async () => {
        const picking = S.getState().pickRoot();
        await S.getState().discardPendingClose();
        assert.equal(await picking, null);
      }
    );

    assert.equal(S.getState().rootPath, ROOT);
    assert.equal(tabOf(tab.id).isDirty, true);
    assert.equal(tabOf(tab.id).content, 'edited in the buffer');
  });

  test('ES-11: picking the folder that is already open keeps every tab', async () => {
    const { tab } = await openDirtyFile('same', 'same'); // clean: nothing to ask about

    await withInvoke(
      async (command, args, real) => (command === 'fs_pick_root' ? ROOT : real()),
      async () => {
        assert.equal(await S.getState().pickRoot(), ROOT);
      }
    );

    assert.ok(tabOf(tab.id), 're-picking the open folder closed its tabs');
  });

  test('ES-12: teardown', () => {
    delete mockBridge.root;
    S.setState({ ...emptyEditor(), rootPath: ROOT, expandedFolders: new Set([ROOT]) });
    assert.equal(S.getState().rootPath, ROOT);
  });
});
