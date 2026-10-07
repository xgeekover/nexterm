/**
 * What the editor does when the backend will not read a file.
 *
 * `fs_read_file` refuses a file over 50 MB, one that is not UTF-8 text, and
 * a path through a link that leads nowhere, each in fixed words ending in
 * the path (src-tauri/src/fs/mod.rs, read_file and resolve_inside):
 *
 *   File is too large to open (60.1 MB; the limit is 50 MB): <path>
 *   File is not UTF-8 text: <path>
 *   Path goes through a broken link (<link>): <path>
 *   File not found: <path>
 *
 * Opening such a file failed with nothing on screen: the refusal went to the
 * console, and the click did nothing at all. And a save reads the file back
 * first, to see whether something else changed it, and took ANY failure of
 * that read for "the file is gone, write it": a log opened under the limit
 * and appended to past it since was refused as too large, and then
 * overwritten with the tab's older, shorter text without a question.
 *
 * Tauri rejects with the command's own string, so the refusals are handed
 * to the store as strings here, through the browser mock's `invoke`.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore, isFileNotFound, readFailureReason } from '../../src/stores/editorStore.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';

const S = useEditorStore;
let counter = 0;

const TOO_LARGE = (path) => `File is too large to open (60.1 MB; the limit is 50 MB): ${path}`;
const NOT_TEXT = (path) => `File is not UTF-8 text: ${path}`;
const BROKEN_LINK = (path) => `Path goes through a broken link (/workspace/_gone_link): ${path}`;
const NOT_A_FILE = (path) => `Failed to read file '${path}': it is not a file`;
const NOT_FOUND = (path) => `File not found: ${path}`;

/**
 * Answer IPC calls through `handler` for as long as `fn` runs. `real()` is
 * the browser mock's own answer.
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

/** The backend refusing to read `path` with `words`; everything else as the mock answers it. */
const refusing = (path, words, seen = []) => (command, args, real) => {
  seen.push(command);
  if (command === 'fs_read_file' && args.path === path) return Promise.reject(words);
  return real();
};

/** What `promise` rejected with; a case fails if it did not. The store's console report is kept out of the output. */
async function failureOf(promise) {
  const report = console.error;
  console.error = () => {};
  try {
    await promise;
  } catch (err) {
    return err;
  } finally {
    console.error = report;
  }
  throw new Error('it did not fail');
}

const scratch = (ext = 'log') => {
  counter += 1;
  return `/workspace/_read_failures_${Date.now()}_${counter}.${ext}`;
};

const emptyEditor = () => ({
  tabs: [],
  activeTabId: null,
  pendingClose: null,
  pendingOverwrite: null,
  openFailure: null,
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
  activeEditorPaneId: 'editor-pane-root',
});

// ---- Opening ---------------------------------------------------------------

describe('Opening a file the backend will not read', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('RF-01: a file over the size limit opens no tab, and the editor says which file and why — in the backend\'s words', async () => {
    const path = scratch();
    await invoke('fs_write_file', { path, content: 'big' });

    const err = await withInvoke(refusing(path, TOO_LARGE(path)), () => failureOf(S.getState().openFile(path)));

    assert.equal(err, TOO_LARGE(path), 'the caller still hears of it');
    assert.deepEqual(S.getState().tabs, []);
    assert.deepEqual(S.getState().openFailure, {
      path,
      fileName: path.split('/').pop(),
      reason: 'File is too large to open (60.1 MB; the limit is 50 MB)',
    }, 'the refusal went to the console and nowhere else');
  });

  test('RF-02: a binary file, a broken link, something that is not a file, a file gone — each says why', async () => {
    for (const [words, reason] of [
      [NOT_TEXT, 'File is not UTF-8 text'],
      [BROKEN_LINK, 'Path goes through a broken link (/workspace/_gone_link)'],
      [NOT_A_FILE, 'Failed to read file: it is not a file'],
      [NOT_FOUND, 'File not found'],
    ]) {
      const path = scratch('bin');
      await withInvoke(refusing(path, words(path)), () => failureOf(S.getState().openFile(path)));
      assert.equal(S.getState().openFailure?.reason, reason, words(path));
      assert.equal(S.getState().openFailure?.path, path);
    }
    assert.deepEqual(S.getState().tabs, []);
  });

  test('RF-03: the notice goes when it is dismissed, and when a file opens — a new one or one already open', async () => {
    const big = scratch();
    const small = scratch('txt');
    await invoke('fs_write_file', { path: small, content: 'small' });
    const fail = () => withInvoke(refusing(big, TOO_LARGE(big)), () => failureOf(S.getState().openFile(big)));

    await fail();
    S.getState().dismissOpenFailure();
    assert.equal(S.getState().openFailure, null, 'dismissed');

    await fail();
    await S.getState().openFile(small);
    assert.equal(S.getState().openFailure, null, 'a file opened after it');

    await fail();
    await S.getState().openFile(small);
    assert.equal(S.getState().openFailure, null, 'a file already open, brought to the front');
    assert.equal(S.getState().tabs.length, 1);
  });

  test('RF-04: why, from what the backend said (pure) — a string from Tauri or an Error from the mock, the path it ends with left off', () => {
    const path = '/w/logs/app.log';
    assert.equal(readFailureReason(TOO_LARGE(path), path), 'File is too large to open (60.1 MB; the limit is 50 MB)');
    assert.equal(readFailureReason(new Error(NOT_TEXT(path)), path), 'File is not UTF-8 text');
    // read_file names the file as it resolved it: links followed, the disk's
    // own case, which need not be how it was asked for.
    assert.equal(readFailureReason(TOO_LARGE('/private/w/logs/app.log'), path), 'File is too large to open (60.1 MB; the limit is 50 MB)');
    assert.equal(readFailureReason(NOT_FOUND('/W/Logs/App.log'), path), 'File not found');
    assert.equal(readFailureReason(NOT_A_FILE('/private/w/logs/app.log'), path), 'Failed to read file: it is not a file');
    assert.equal(readFailureReason("Failed to read file '/w/x': Permission denied (os error 13)", '/w/x'), 'Failed to read file: Permission denied (os error 13)');
    assert.equal(readFailureReason('No folder is open', path), 'No folder is open', 'words it does not know are kept whole');
    assert.equal(readFailureReason(new Error(''), path), 'Unknown error');
    assert.equal(readFailureReason(undefined, path), 'Unknown error');
  });
});

// ---- Saving ----------------------------------------------------------------

/** What a save came to: the error it was refused with, or null when it wrote. */
const outcome = (saving) => saving.then(() => null, (err) => err);

/** The writes among the commands the backend was sent. */
const writes = (seen) => seen.filter((command) => command === 'fs_write_file');

/** A file opened as `content`, its tab edited to `edited`. */
async function openEdited(content = 'line 1\n', edited = 'line 1\nmy note\n') {
  const path = scratch();
  await invoke('fs_write_file', { path, content });
  const tab = await S.getState().openFile(path);
  S.getState().editBuffer(tab.id, edited);
  return { path, tab };
}

describe('Saving a file that cannot be read back first', () => {
  beforeEach(() => {
    S.setState(emptyEditor());
  });

  test('RF-05: a log appended to past the size limit since it was opened is not overwritten — the save asks first, and says why', async () => {
    const { path, tab } = await openEdited();
    const seen = [];

    const err = await withInvoke(refusing(path, TOO_LARGE(path), seen), () => outcome(S.getState().saveFile(tab.id)));

    assert.deepEqual(writes(seen), [], 'the newer, bigger file was written over without a question');
    assert.equal(err?.code, 'EXTERNAL_CHANGE');
    assert.deepEqual(S.getState().pendingOverwrite, {
      tabId: tab.id,
      fileName: tab.fileName,
      diskContent: null,
      unreadable: 'File is too large to open (60.1 MB; the limit is 50 MB)',
    });
    const after = S.getState().tabs.find((t) => t.id === tab.id);
    assert.equal(after.isDirty, true, 'the edit is still unsaved');
    assert.equal(await invoke('fs_read_file', { path }), 'line 1\n');
  });

  test('RF-06: every failure but "File not found" asks; a file that is gone is saved without asking, made again', async () => {
    for (const words of [NOT_TEXT, BROKEN_LINK, NOT_A_FILE, () => 'Unknown IPC command: fs_read_file']) {
      S.setState(emptyEditor());
      const { path, tab } = await openEdited();
      const seen = [];
      const err = await withInvoke(refusing(path, words(path), seen), () => outcome(S.getState().saveFile(tab.id)));
      assert.deepEqual(writes(seen), [], `${words(path)}: written without asking`);
      assert.equal(err?.code, 'EXTERNAL_CHANGE', words(path));
      assert.equal(S.getState().pendingOverwrite?.unreadable, readFailureReason(words(path), path));
    }

    S.setState(emptyEditor());
    const { path, tab } = await openEdited();
    await withInvoke(refusing(path, NOT_FOUND(path)), () => S.getState().saveFile(tab.id));
    assert.equal(S.getState().pendingOverwrite, null, 'a deleted file is saved back without a question, as before');
    assert.equal(await invoke('fs_read_file', { path }), 'line 1\nmy note\n');

    assert.equal(isFileNotFound(NOT_FOUND(path)), true);
    assert.equal(isFileNotFound(new Error(NOT_FOUND(path))), true);
    for (const words of [TOO_LARGE, NOT_TEXT, BROKEN_LINK, NOT_A_FILE]) assert.equal(isFileNotFound(words(path)), false, words(path));
  });

  test('RF-07: Overwrite writes the tab anyway — the user said so', async () => {
    const { path, tab } = await openEdited();
    await withInvoke(refusing(path, TOO_LARGE(path)), async () => {
      await failureOf(S.getState().saveFile(tab.id));
      await S.getState().confirmPendingOverwrite();
    });
    assert.equal(await invoke('fs_read_file', { path }), 'line 1\nmy note\n');
    assert.equal(S.getState().pendingOverwrite, null);
    assert.equal(S.getState().tabs.find((t) => t.id === tab.id).isDirty, false);
  });

  test('RF-08: Save in "Save a.js?" asks the same question in its place — nothing written, the tab kept', async () => {
    const { path, tab } = await openEdited();
    S.getState().requestCloseTab(tab.id);
    const seen = [];

    const err = await withInvoke(refusing(path, TOO_LARGE(path), seen), () => outcome(S.getState().savePendingClose()));

    assert.deepEqual(writes(seen), [], 'written over, then closed');
    assert.ok(S.getState().tabs.some((t) => t.id === tab.id), 'the tab was closed');
    assert.equal(err?.code, 'EXTERNAL_CHANGE');
    assert.equal(S.getState().pendingClose, null, 'never both questions at once');
    assert.equal(S.getState().pendingOverwrite?.tabId, tab.id);
  });

  test('RF-09: teardown', () => {
    S.setState(emptyEditor());
    assert.equal(S.getState().openFailure, null);
  });
});
