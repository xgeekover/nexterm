/**
 * The Explorer's delete moves to the Trash — the Recycle Bin on Windows —
 * with `files.enableTrash` on (src-tauri/src/fs/trash.rs). Before, every
 * delete was permanent behind one question.
 *
 * On Windows the shell, told not to ask, deletes PERMANENTLY wherever a drive
 * has no Recycle Bin — a network drive, a USB stick. The backend refuses such
 * a move before asking the shell, every failure of the move says so in fixed
 * words, and the Explorer turns those — and only those — into a second
 * question about a permanent delete. These cases hold the wording per setting
 * and platform, that a failed move deletes nothing and leads to the question,
 * that any other refusal does not, that the setting off is the old flow, and
 * that the words the frontend looks for are the words the backend writes.
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  deleteConfirmLabel,
  deletePromptMessage,
  deletesToTrash,
  failureText,
  permanentDeletePromptMessage,
  queuePermanent,
  trashFailureReason,
  trashName,
} from '../../src/components/explorer/treeRows.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { SETTINGS_DEFAULTS } from '../../src/stores/settingsStore.js';
import { mockBridge, invoke } from '../../src/lib/ipc.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** A folder of its own in the mock, for one case. */
async function scratch(tag) {
  const dir = `/workspace/_explorer_trash_${tag}_${Date.now()}`;
  await invoke('fs_create_dir', { path: dir });
  return dir;
}

describe('Delete to the Trash: what the questions say', () => {
  test('ET-01: with the setting on, the question says Trash — Recycle Bin on Windows — and so does its button', () => {
    const file = { name: 'notes.txt', isDir: false, isLink: false };
    const folder = { name: 'src', isDir: true, isLink: false };
    const link = { name: 'shared', isDir: true, isLink: true };

    assert.equal(deletePromptMessage(file, [], { trash: true, os: 'macos' }), "Move 'notes.txt' to the Trash? You can restore it from the Trash.");
    assert.equal(
      deletePromptMessage(file, [], { trash: true, os: 'windows' }),
      "Move 'notes.txt' to the Recycle Bin? You can restore it from the Recycle Bin."
    );
    assert.equal(deletePromptMessage(file, [], { trash: true, os: 'linux' }), "Move 'notes.txt' to the Trash? You can restore it from the Trash.");
    assert.equal(
      deletePromptMessage(folder, ['a.js', 'b.js'], { trash: true, os: 'windows' }),
      "Move 'src' to the Recycle Bin? Its contents go with it. You can restore it from the Recycle Bin. Unsaved changes in a.js and b.js will be lost."
    );
    assert.equal(
      deletePromptMessage(link, ['index.js'], { trash: true, os: 'macos' }),
      "Move the link 'shared' to the Trash? What it points to is not touched. Unsaved changes in index.js will be lost; save them first to keep them in what it points to."
    );

    assert.equal(deleteConfirmLabel({ trash: true, os: 'macos' }), 'Move to Trash');
    assert.equal(deleteConfirmLabel({ trash: true, os: 'windows' }), 'Move to Recycle Bin');
    assert.equal(deleteConfirmLabel({ trash: true, os: 'linux' }), 'Move to Trash');
    assert.equal(trashName('windows'), 'Recycle Bin');
    assert.equal(trashName(undefined), 'Trash');
  });

  test('ET-02: with the setting off, the question is today\'s permanent delete, word for word', () => {
    assert.equal(deleteConfirmLabel({ trash: false, os: 'windows' }), 'Delete');
    assert.equal(deleteConfirmLabel(), 'Delete');
    assert.equal(
      deletePromptMessage({ name: 'src', isDir: true, isLink: false }, ['a.js', 'b.js'], { trash: false, os: 'windows' }),
      "Are you sure you want to delete 'src'? Its contents will be deleted too. Unsaved changes in a.js and b.js will be lost."
    );
    assert.equal(deletePromptMessage({ name: 'x.txt', isDir: false, isLink: false }), "Are you sure you want to delete 'x.txt'?");
    assert.equal(SETTINGS_DEFAULTS.filesEnableTrash, true, 'on by default');
  });

  test('ET-03: only a failure of the move is one — refusals of the path itself are not', () => {
    assert.equal(
      trashFailureReason('Not moved to the Recycle Bin: No Recycle Bin on this drive — it is a network drive'),
      'No Recycle Bin on this drive — it is a network drive'
    );
    assert.equal(trashFailureReason("Not moved to the Trash: 'C:\\x' is still there"), "'C:\\x' is still there");
    assert.equal(trashFailureReason('Not moved to the Trash: line one\nline two'), 'line one\nline two');
    for (const other of [
      'Path does not exist: /workspace/gone.txt',
      'Path is on another machine or a device: \\\\host\\share\\x',
      'Refusing to delete the workspace root',
      "Failed to delete directory '/w/full': it is not empty",
      'Moved to the Trash: nothing',
      '',
      undefined,
    ]) {
      assert.equal(trashFailureReason(other), null, JSON.stringify(other));
    }
    // Tauri rejects with the command's string, the mock with an Error.
    assert.equal(failureText('Not moved to the Trash: x'), 'Not moved to the Trash: x');
    assert.equal(failureText(new Error('Not moved to the Trash: x')), 'Not moved to the Trash: x');
  });

  test('ET-04: the second question says why, that it cannot be undone, and what goes with it', () => {
    const reason = 'No Recycle Bin on this drive — it is a network drive';
    assert.equal(
      permanentDeletePromptMessage({ name: 'build', isDir: true, isLink: false }, reason, ['main.c'], { os: 'windows' }),
      "'build' could not be moved to the Recycle Bin: No Recycle Bin on this drive — it is a network drive. Delete it permanently instead? This cannot be undone. Its contents will be deleted too. Unsaved changes in main.c will be lost."
    );
    assert.equal(
      permanentDeletePromptMessage({ name: 'AGENTS.md', isDir: false, isLink: true }, 'the volume has no Trash.', [], { os: 'macos' }),
      "The link 'AGENTS.md' could not be moved to the Trash: the volume has no Trash. Delete the link permanently instead? What it points to is not touched."
    );
    assert.match(permanentDeletePromptMessage({ name: 'a', isDir: false }, '', [], { os: 'linux' }), /^'a' could not be moved to the Trash\. Delete it permanently instead\?/);
  });
});

describe('Delete to the Trash: through the store and the mock bridge', () => {
  test('ET-05: moved to the Trash — gone from the tree, its tabs closed, the move recorded', async () => {
    const dir = await scratch('moved');
    await invoke('fs_create_dir', { path: `${dir}/src` });
    await invoke('fs_create_dir', { path: `${dir}/src-old` });
    await invoke('fs_write_file', { path: `${dir}/src/a.js`, content: 'a' });
    await invoke('fs_write_file', { path: `${dir}/src-old/b.js`, content: 'b' });
    await useEditorStore.getState().openFile(`${dir}/src/a.js`);
    const before = mockBridge.trashed.length;

    await useEditorStore.getState().deletePath(`${dir}/src`, true, { trash: true });

    assert.deepEqual(mockBridge.trashed.slice(before), [{ path: `${dir}/src`, recursive: true }]);
    await assert.rejects(() => invoke('fs_read_file', { path: `${dir}/src/a.js` }));
    assert.equal(await invoke('fs_read_file', { path: `${dir}/src-old/b.js` }), 'b', 'a sibling whose name only begins the same stays');
    assert.equal(useEditorStore.getState().tabs.some((t) => t.filePath.startsWith(`${dir}/src/`)), false);
  });

  test('ET-06: a move that fails deletes nothing, and leads to the permanent-delete question; only its answer deletes', async () => {
    const dir = await scratch('refused');
    await invoke('fs_write_file', { path: `${dir}/a.txt`, content: 'a' });
    const os = mockBridge.systemInfo.os;
    mockBridge.systemInfo.os = 'windows';
    mockBridge.trashRefusal = 'No Recycle Bin on this drive — it is a network drive';
    let failure = null;
    try {
      await useEditorStore.getState().deletePath(`${dir}/a.txt`, false, { trash: true });
    } catch (err) {
      failure = err;
    } finally {
      mockBridge.trashRefusal = null;
      mockBridge.systemInfo.os = os;
    }
    assert.ok(failure, 'the move was refused');
    assert.equal(trashFailureReason(failureText(failure)), 'No Recycle Bin on this drive — it is a network drive', 'so the Explorer asks');
    assert.equal(await invoke('fs_read_file', { path: `${dir}/a.txt` }), 'a', 'and nothing was deleted');

    // "Delete Permanently".
    const before = mockBridge.trashed.length;
    await useEditorStore.getState().deletePath(`${dir}/a.txt`, false);
    await assert.rejects(() => invoke('fs_read_file', { path: `${dir}/a.txt` }));
    assert.equal(mockBridge.trashed.length, before, 'for good, not to the Trash');
  });

  test('ET-07: any other refusal is reported, never turned into the permanent-delete question', async () => {
    let failure = null;
    try {
      await useEditorStore.getState().deletePath('/workspace/_explorer_trash_never_there.txt', false, { trash: true });
    } catch (err) {
      failure = err;
    }
    assert.ok(failure);
    assert.equal(trashFailureReason(failureText(failure)), null);
    assert.match(failureText(failure), /^Path does not exist/);
  });

  test('ET-08: the setting off is the old permanent delete — nothing goes to the Trash', async () => {
    const dir = await scratch('off');
    await invoke('fs_write_file', { path: `${dir}/a.txt`, content: 'a' });
    const before = mockBridge.trashed.length;
    const calls = [];
    const original = mockBridge.invoke;
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'fs_delete_path') calls.push({ ...args });
      return original.call(this, command, args, ...rest);
    };
    try {
      await useEditorStore.getState().deletePath(`${dir}/a.txt`, false);
    } finally {
      mockBridge.invoke = original;
    }
    assert.deepEqual(calls, [{ path: `${dir}/a.txt`, recursive: false, trash: false }]);
    assert.equal(mockBridge.trashed.length, before);
    await assert.rejects(() => invoke('fs_read_file', { path: `${dir}/a.txt` }));
  });
});

describe('Delete to the Trash: the Explorer and the backend agree', () => {
  test('ET-09: the Explorer decides at the question, asks again on a failed move, and deletes for good only on that answer', () => {
    const explorer = read('../../src/components/explorer/FileExplorer.jsx');
    assert.match(
      explorer,
      /trash: deletesToTrash\(\{\s*enabled: useSettingsStore\.getState\(\)\.filesEnableTrash !== false,\s*isLink: Boolean\(target\.isLink\),\s*os: useSystemStore\.getState\(\)\.os,\s*\}\),/,
      'decided as the question opens'
    );
    assert.match(explorer, /confirmLabel=\{deleteConfirmLabel\(\{ trash: deleteConfirm\.trash, os \}\)\}/);
    assert.match(explorer, /danger=\{!deleteConfirm\.trash\}/);
    // The setting off: the delete as it was.
    assert.match(explorer, /if \(!target\.trash\) \{\s*deletePath\(target\.path, recursive\)\.catch/);
    // On: to the Trash, and a failed move becomes the second question — the
    // catch itself never deletes anything.
    const start = explorer.indexOf('deletePath(target.path, recursive, { trash: true }).catch((err) => {');
    assert.ok(start > 0, 'the move asks for the Trash');
    // Up to the end of the question's onConfirm.
    const handler = explorer.slice(start, explorer.indexOf('onCancel={() => setDeleteConfirm(null)}', start));
    assert.match(handler, /const reason = trashFailureReason\(text\);/);
    assert.match(handler, /if \(reason === null\) setExplorerError\(text\);\s*else setPermanentQueue\(\(queue\) => queuePermanent\(queue, \{ \.\.\.target, reason \}\)\);/);
    assert.equal(handler.split('deletePath(').length, 2, 'no second delete inside the failure handler');
    // The second question: danger, and the only place a permanent delete follows a failed move.
    const second = explorer.slice(explorer.indexOf('title="Delete Permanently?"'));
    assert.match(second, /confirmLabel="Delete Permanently"\s*danger/);
    assert.match(second, /initialFocus="cancel"/, 'opened with Cancel focused: a second Enter is not the answer');
    const dialog = read('../../src/components/common/ConfirmDialog.jsx');
    assert.match(dialog, /\(focusCancelRef\.current \? cancelRef\.current : confirmRef\.current\)\?\.focus\(\);/);
    assert.match(dialog, /<button\s+ref=\{cancelRef\}/);
    assert.match(second, /deletePath\(target\.path, target\.isDir && !target\.isLink\)\.catch/);
    // Review B3: one question at a time, each a dialog of its own, and its
    // answer about its own target.
    assert.match(explorer, /const permanentConfirm = permanentQueue\[0\] \?\? null;/);
    assert.match(explorer, /key=\{permanentConfirm\.id\}\s*open\s*title="Delete Permanently\?"/);
    assert.match(second, /const target = permanentConfirm;\s*closePermanent\(target\.id\);/);
    assert.match(second, /onCancel=\{\(\) => closePermanent\(permanentConfirm\.id\)\}/);
    assert.doesNotMatch(explorer, /setPermanentConfirm/, 'no single slot a second failure could rewrite');
  });

  test('ET-10: the words the Explorer looks for are the words the backend writes, and the store sends the flag', () => {
    const trash = read('../../src-tauri/src/fs/trash.rs');
    assert.match(trash, /pub const BIN: &str = if cfg!\(windows\) \{ "Recycle Bin" \} else \{ "Trash" \};/);
    assert.match(trash, /format!\("Not moved to the \{BIN\}: \{reason\}"\)/);
    for (const bin of ['Recycle Bin', 'Trash']) {
      assert.equal(trashFailureReason(`Not moved to the ${bin}: why`), 'why', bin);
    }
    assert.match(trash, /pub const NO_RECYCLE_BIN: &str = "No Recycle Bin on this drive";/);
    // macOS: NSFileManager, not Finder through AppleScript.
    assert.match(trash, /context\.set_delete_method\(DeleteMethod::NsFileManager\);/);

    const command = read('../../src-tauri/src/commands/fs.rs');
    assert.match(command, /pub fn fs_delete_path\(\s*state: State<AppState>,\s*path: String,\s*recursive: Option<bool>,\s*trash: Option<bool>,?\s*\)/);
    assert.match(command, /if trash\.unwrap_or\(false\) \{\s*trash_in\(&state\.workspace, &path, recursive, fs::trash::move_to_bin\)/);
    const store = read('../../src/stores/editorStore.js');
    assert.ok(store.includes("invoke('fs_delete_path', { path, recursive, trash: Boolean(trash) })"), 'the store sends the flag');
    const cargo = read('../../src-tauri/Cargo.toml');
    assert.match(cargo, /^trash = "5\.2\.9"$/m);
  });
});

describe('Delete to the Trash: after review', () => {
  test('ET-11: two failed moves are two questions, one after the other — never the second written into the first', () => {
    // Review B3: the second failure rewrote the open dialog, and an Enter
    // meant for B deleted A.
    let queue = [];
    queue = queuePermanent(queue, { path: '/w/a.txt', name: 'a.txt', reason: 'one' });
    const first = queue[0];
    queue = queuePermanent(queue, { path: '/w/b.txt', name: 'b.txt', reason: 'two' });
    assert.equal(queue[0], first, 'the question up stays exactly as it was');
    assert.deepEqual(queue.map((t) => t.path), ['/w/a.txt', '/w/b.txt']);
    assert.notEqual(queue[0].id, queue[1].id, 'each a dialog of its own');
    assert.equal(queuePermanent(queue, { path: '/w/a.txt', reason: 'again' }), queue, 'one question per path');
    queue = queue.filter((t) => t.id !== first.id);
    assert.equal(queue[0].path, '/w/b.txt', 'the next opens once the first has closed');
    assert.deepEqual(queuePermanent(null, null), []);
  });

  test('ET-12: a link goes to the Trash on macOS only — elsewhere it is removed as a link, and asked about as one', () => {
    // Review B2: the backend never hands a link to the system on Windows or
    // Linux, so the question must not promise the Recycle Bin.
    assert.equal(deletesToTrash({ enabled: true, isLink: false, os: 'windows' }), true);
    assert.equal(deletesToTrash({ enabled: true, isLink: true, os: 'macos' }), true);
    assert.equal(deletesToTrash({ enabled: true, isLink: true, os: 'windows' }), false);
    assert.equal(deletesToTrash({ enabled: true, isLink: true, os: 'linux' }), false);
    assert.equal(deletesToTrash({ enabled: false, isLink: false, os: 'macos' }), false);
    const link = { name: 'cache', isDir: true, isLink: true };
    const trash = deletesToTrash({ enabled: true, isLink: true, os: 'windows' });
    assert.equal(
      deletePromptMessage(link, [], { trash, os: 'windows' }),
      "Are you sure you want to delete the link 'cache'? What it points to is not touched."
    );
    const rust = read('../../src-tauri/src/fs/trash.rs');
    assert.match(rust, /pub const LINKS_GO_TO_BIN: bool = cfg!\(target_os = "macos"\);/, 'the same rule as the backend');
  });

  test('ET-13: "Delete Permanently?" opens with Cancel focused, and its button ignores the click that follows a double-click', () => {
    // Review B8 — the dialog's own behaviour is held, mounted, in
    // confirm_dialog.test.js (CD-29); this is that the Explorer asks for it.
    const explorer = read('../../src/components/explorer/FileExplorer.jsx');
    assert.match(explorer.slice(explorer.indexOf('title="Delete Permanently?"')), /initialFocus="cancel"/);
  });
});

describe('Delete to the Trash: second review', () => {
  test('ET-14: a folder that became a link since it was listed — the move is refused, and the question is about a link', () => {
    // Review N2: the backend used to remove the link there and then, after a
    // question that promised a move that could be undone.
    const reason = 'It is a link — a link is removed, not moved to the Recycle Bin';
    assert.equal(
      permanentDeletePromptMessage({ name: 'cache', isDir: true, isLink: false }, reason, [], { os: 'windows' }),
      "The link 'cache' could not be moved to the Recycle Bin: It is a link — a link is removed, not moved to the Recycle Bin. Delete the link permanently instead? What it points to is not touched."
    );
    assert.equal(trashFailureReason(`Not moved to the Recycle Bin: ${reason}`), reason, 'a failure of the move: the question is asked');
    const rust = read('../../src-tauri/src/fs/trash.rs');
    assert.match(rust, /format!\("It is a link — a link is removed, not moved to the \{BIN\}"\)/, 'the words the backend writes');
  });
});
