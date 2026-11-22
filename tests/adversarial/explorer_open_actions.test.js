/**
 * The Explorer menu's Reveal, Open Terminal Here and Open in External Editor
 * (bundle 2, A12-1 to A12-3; AC10: EXO-01 to EXO-04, AC12: EXO-05, EXO-06).
 *
 * The items come from the pure `buildOpenActionItems`
 * (src/components/explorer/explorerOpenActions.js), called here with fakes
 * for what they reach — the `fs_reveal_path` and `fs_open_in_external_editor`
 * wrappers, the terminal store's `createTab`, the terminal focus and the
 * Explorer's error line — so no file manager or editor is opened and no
 * shell is started. EXO-06 also goes through the real wrapper and the IPC
 * mock (src/lib/ipc.js), which records what it was asked and starts nothing.
 * A source check pins that FileExplorer's menu builds them with the real
 * ones, after Copy Relative Path.
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import {
  buildOpenActionItems,
  externalEditorCommandOf,
  revealLabel,
  revealPathFor,
  terminalFailedText,
  terminalFolderFor,
} from '../../src/components/explorer/explorerOpenActions.js';
import { mockBridge, openInExternalEditor } from '../../src/lib/ipc.js';

const ROOT = '/w/proj';
const FILE = { type: 'file', path: '/w/proj/src/a b.txt', isDir: false, name: 'a b.txt' };
const FOLDER = { type: 'folder', path: '/w/proj/src', isDir: true, name: 'src' };
const EMPTY = { type: 'empty', path: ROOT, isDir: true, name: ROOT };

/** What the items did, in order. */
let calls = [];
/** What the fake `createTab` resolves with, or the error it throws. */
let tabResult = { id: 't-1' };
let tabError = null;
let revealError = null;
let editorError = null;

function deps(overrides = {}) {
  return {
    os: 'macos',
    rootPath: ROOT,
    reveal: async (path) => {
      calls.push(['reveal', path]);
      if (revealError) throw revealError;
      return null;
    },
    createTab: async (options) => {
      calls.push(['createTab', options]);
      if (tabError) throw tabError;
      return tabResult;
    },
    focusTerminal: () => calls.push(['focus']),
    externalEditorCommand: '',
    openInExternalEditor: async (command, path) => {
      calls.push(['editor', { command, path }]);
      if (editorError) throw editorError;
      return null;
    },
    setError: (text) => calls.push(['error', text]),
    ...overrides,
  };
}

const itemsFor = (target, overrides) => buildOpenActionItems(target, deps(overrides));
const item = (target, key, overrides) => itemsFor(target, overrides).find((i) => i.key === key);

function reset() {
  calls = [];
  tabResult = { id: 't-1' };
  tabError = null;
  revealError = null;
  editorError = null;
}

/** FileExplorer as checked out; Windows checks it out with CRLF. */
const EXPLORER_SOURCE = readFileSync(
  new URL('../../src/components/explorer/FileExplorer.jsx', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n');

describe('Explorer: Reveal, Open Terminal Here and Open in External Editor (A12-1 to A12-3)', () => {
  beforeEach(() => reset());

  test('EXO-01: the Reveal label names the file manager of the platform', () => {
    assert.equal(revealLabel('macos'), 'Reveal in Finder');
    assert.equal(revealLabel('windows'), 'Reveal in File Explorer');
    assert.equal(revealLabel('linux'), 'Reveal in File Manager');
    assert.equal(revealLabel(undefined), 'Reveal in File Manager', 'an unknown platform: the generic name');
    for (const [os, label] of [
      ['macos', 'Reveal in Finder'],
      ['windows', 'Reveal in File Explorer'],
      ['linux', 'Reveal in File Manager'],
    ]) {
      for (const target of [FILE, FOLDER, EMPTY]) {
        const reveal = item(target, 'reveal', { os });
        assert.equal(reveal.label, label, `${os}, ${target.type}`);
        assert.equal(reveal.disabled, false, `${os}, ${target.type}: offered`);
      }
    }
    assert.deepEqual(
      itemsFor(FILE).map((i) => i.key),
      ['reveal', 'open-terminal-here'],
      'Reveal, then Open Terminal Here'
    );
    assert.deepEqual(calls, [], 'building the menu calls nothing');
  });

  test('EXO-02: Reveal shows the row, or the open folder for the empty area', async () => {
    await item(FILE, 'reveal').onSelect();
    await item(FOLDER, 'reveal').onSelect();
    await item(EMPTY, 'reveal').onSelect();
    assert.deepEqual(calls, [
      ['reveal', FILE.path],
      ['reveal', FOLDER.path],
      ['reveal', ROOT],
    ]);
    // The empty area stands for the open folder even when its target says otherwise.
    reset();
    await item({ ...EMPTY, path: '/elsewhere' }, 'reveal').onSelect();
    assert.deepEqual(calls, [['reveal', ROOT]], 'the open folder, not the target path');

    // A refusal is the Explorer's error, in the backend's words (a bare string, as Tauri rejects).
    reset();
    revealError = "Cannot show '/w/proj/src/a b.txt': No such file or directory";
    await item(FILE, 'reveal').onSelect();
    assert.deepEqual(calls, [
      ['reveal', FILE.path],
      ['error', "Cannot show '/w/proj/src/a b.txt': No such file or directory"],
    ]);
    reset();
    revealError = new Error('Path is on another machine or a device: //srv/x');
    await item(FOLDER, 'reveal').onSelect();
    assert.deepEqual(calls.at(-1), ['error', 'Path is on another machine or a device: //srv/x']);

    // No folder open: nothing to reveal, offered greyed out with a reason, and nothing called.
    reset();
    const none = item(EMPTY, 'reveal', { rootPath: null });
    assert.equal(none.disabled, true);
    assert.equal(none.disabledReason, 'No folder is open');
    assert.equal(revealPathFor(EMPTY, '  '), null, 'a blank open folder is none');
    assert.equal(revealPathFor({ type: 'file', path: '' }, ROOT), null, 'a row with no path is none');
    assert.deepEqual(calls, []);
  });

  test('EXO-03: Open Terminal Here starts in the folder, a file\'s folder or the open folder, strictly', async () => {
    assert.equal(terminalFolderFor(FILE, ROOT), '/w/proj/src', "a file: its folder");
    assert.equal(terminalFolderFor(FOLDER, ROOT), '/w/proj/src', 'a folder: itself');
    assert.equal(terminalFolderFor(EMPTY, ROOT), ROOT, 'the empty area: the open folder');
    assert.equal(
      terminalFolderFor({ type: 'file', path: 'C:\\Users\\Me\\My Project\\b.txt' }, 'C:\\Users\\Me\\My Project'),
      'C:\\Users\\Me\\My Project',
      'a Windows file in a folder with spaces: its folder, backslashes kept'
    );
    assert.equal(terminalFolderFor({ type: 'file', path: 'C:\\b.txt' }, 'C:\\'), 'C:\\', 'a file at a drive root: the drive root');

    await item(FILE, 'open-terminal-here').onSelect();
    await item(FOLDER, 'open-terminal-here').onSelect();
    await item(EMPTY, 'open-terminal-here').onSelect();
    assert.deepEqual(calls, [
      ['createTab', { cwd: '/w/proj/src', strictCwd: true }],
      ['focus'],
      ['createTab', { cwd: '/w/proj/src', strictCwd: true }],
      ['focus'],
      ['createTab', { cwd: ROOT, strictCwd: true }],
      ['focus'],
    ], 'one strict createTab each, then the new terminal takes the keyboard');

    reset();
    const none = item(EMPTY, 'open-terminal-here', { rootPath: '' });
    assert.equal(none.disabled, true, 'no folder open: greyed out');
    assert.equal(none.disabledReason, 'No folder is open');
    assert.deepEqual(calls, []);
  });

  test('EXO-04: a terminal that cannot start there is an Explorer error naming the folder', async () => {
    tabResult = null;
    await item(FILE, 'open-terminal-here').onSelect();
    assert.deepEqual(calls, [
      ['createTab', { cwd: '/w/proj/src', strictCwd: true }],
      ['error', 'No terminal could be started in /w/proj/src.'],
    ], 'null: an error, and no focus');

    reset();
    tabError = new Error('Permission denied (os error 13)');
    await item(EMPTY, 'open-terminal-here').onSelect();
    assert.deepEqual(calls, [
      ['createTab', { cwd: ROOT, strictCwd: true }],
      ['error', `No terminal could be started in ${ROOT}: Permission denied (os error 13)`],
    ], 'a rejection: the reason with the folder');
    assert.equal(terminalFailedText('/x'), 'No terminal could be started in /x.');
  });

  test('EXO-05: no Open in External Editor while the setting is empty or only whitespace', () => {
    for (const setting of ['', ' ', '  \t\n ', undefined, null, 42]) {
      for (const target of [FILE, FOLDER, EMPTY]) {
        const keys = itemsFor(target, { externalEditorCommand: setting }).map((i) => i.key);
        assert.deepEqual(keys, ['reveal', 'open-terminal-here'], `${JSON.stringify(setting)}, ${target.type}: not in the menu`);
      }
      assert.equal(externalEditorCommandOf(setting), null, `${JSON.stringify(setting)} is no editor`);
    }
    // Set: after Open Terminal Here, for files, folders and the empty area alike.
    for (const target of [FILE, FOLDER, EMPTY]) {
      const items = itemsFor(target, { externalEditorCommand: 'code' });
      assert.deepEqual(items.map((i) => i.key), ['reveal', 'open-terminal-here', 'open-in-external-editor'], target.type);
      const editor = items.at(-1);
      assert.equal(editor.label, 'Open in External Editor');
      assert.equal(editor.disabled, false, `${target.type}: offered`);
    }
    // Set, but no folder open: the empty area has nothing to open, greyed out with a reason.
    const none = item(EMPTY, 'open-in-external-editor', { externalEditorCommand: 'code', rootPath: null });
    assert.equal(none.disabled, true);
    assert.equal(none.disabledReason, 'No folder is open');
    assert.equal(externalEditorCommandOf('  subl -w \n'), 'subl -w', 'trimmed');
    assert.deepEqual(calls, [], 'building the menu calls nothing');
  });

  test("EXO-06: with 'subl -w' set, the item asks for { command: 'subl -w', path } and a refusal is the Explorer error", async () => {
    await item(FILE, 'open-in-external-editor', { externalEditorCommand: 'subl -w' }).onSelect();
    await item(FOLDER, 'open-in-external-editor', { externalEditorCommand: 'subl -w' }).onSelect();
    await item({ ...EMPTY, path: '/elsewhere' }, 'open-in-external-editor', { externalEditorCommand: '  subl -w  ' }).onSelect();
    assert.deepEqual(calls, [
      ['editor', { command: 'subl -w', path: FILE.path }],
      ['editor', { command: 'subl -w', path: FOLDER.path }],
      ['editor', { command: 'subl -w', path: ROOT }],
    ], 'the row, or the open folder for the empty area; the command trimmed; no error, nothing else');

    // The backend's refusal, in its words (a bare string, as Tauri rejects, or an Error).
    reset();
    editorError = "'bash' is a shell or opens files in their default app, so NexTerm does not run it as the external editor. Set the editor itself, for example code or subl -w";
    await item(FILE, 'open-in-external-editor', { externalEditorCommand: 'bash -c' }).onSelect();
    assert.deepEqual(calls, [
      ['editor', { command: 'bash -c', path: FILE.path }],
      ['error', editorError],
    ]);
    reset();
    editorError = new Error("Could not start the external editor 'subl': No such file or directory (os error 2)");
    await item(FOLDER, 'open-in-external-editor', { externalEditorCommand: 'subl -w' }).onSelect();
    assert.deepEqual(calls.at(-1), ['error', "Could not start the external editor 'subl': No such file or directory (os error 2)"]);

    // Through the real wrapper and the IPC mock: what reaches
    // fs_open_in_external_editor, and what the mock refuses as the backend
    // does. Nothing is started; the mock only records.
    const savedRoot = mockBridge.root;
    const savedInvoke = mockBridge.invoke;
    const ownInvoke = Object.prototype.hasOwnProperty.call(mockBridge, 'invoke');
    const sent = [];
    mockBridge.root = null; // the mock's own open folder, /workspace
    mockBridge.invoke = function spy(command, args) {
      if (command === 'fs_open_in_external_editor') sent.push(args);
      return savedInvoke.call(this, command, args);
    };
    try {
      mockBridge.externalEditorOpens.length = 0;
      reset();
      const real = { rootPath: '/workspace', openInExternalEditor };
      const src = { type: 'folder', path: '/workspace/src', isDir: true, name: 'src' };
      await item(src, 'open-in-external-editor', { ...real, externalEditorCommand: 'subl -w' }).onSelect();
      assert.deepEqual(mockBridge.externalEditorOpens, [{ command: 'subl -w', path: '/workspace/src' }]);
      assert.deepEqual(sent, [{ command: 'subl -w', path: '/workspace/src' }], 'exactly { command, path }');
      assert.deepEqual(calls, [], 'no error');
      for (const [command, reason] of [
        ['open -a TextEdit', /^'open' is a shell or opens files in their default app/],
        ['"C:\\Windows\\System32\\CMD.EXE" /c', /^'C:\\Windows\\System32\\CMD\.EXE' is a shell/],
        ['"code', /never closed/],
      ]) {
        reset();
        await item(src, 'open-in-external-editor', { ...real, externalEditorCommand: command }).onSelect();
        assert.equal(calls.length, 1, command);
        assert.equal(calls[0][0], 'error', command);
        assert.match(calls[0][1], reason, command);
      }
      reset();
      await item({ type: 'file', path: '/elsewhere/x.txt' }, 'open-in-external-editor', { ...real, externalEditorCommand: 'code' }).onSelect();
      assert.deepEqual(calls, [['error', 'Path is outside the open folder: /elsewhere/x.txt']]);
      assert.equal(mockBridge.externalEditorOpens.length, 1, 'nothing refused was recorded');
    } finally {
      mockBridge.externalEditorOpens.length = 0;
      if (ownInvoke) mockBridge.invoke = savedInvoke;
      else delete mockBridge.invoke;
      mockBridge.root = savedRoot;
    }
  });

  test('EXO-90: FileExplorer builds them with the real wrapper, store and focus, after Copy Relative Path', () => {
    const copyRel = EXPLORER_SOURCE.indexOf("key: 'copy-relative-path'");
    const open = EXPLORER_SOURCE.indexOf('...buildOpenActionItems(target, {');
    const rename = EXPLORER_SOURCE.indexOf("key: 'rename'");
    assert.ok(copyRel > 0 && open > copyRel && rename > open, 'between Copy Relative Path and Rename');
    const call = EXPLORER_SOURCE.slice(open, rename);
    assert.match(call, /\breveal: revealInFileManager,/, 'the fs_reveal_path wrapper');
    assert.match(call, /createTab: \(options\) => useTerminalStore\.getState\(\)\.createTab\(options\)/);
    assert.match(call, /focusTerminal\(\)/);
    assert.match(call, /setError: setExplorerError,/);
    assert.match(call, /\bos,/);
    assert.match(call, /\brootPath,/);
    // The external editor: the saved setting, and the fs_open_in_external_editor wrapper.
    assert.match(call, /externalEditorCommand: useSettingsStore\.getState\(\)\.externalEditorCommand,/);
    assert.match(call, /\bopenInExternalEditor,/);
    assert.match(EXPLORER_SOURCE, /import \{ openInExternalEditor, revealInFileManager \} from '\.\.\/\.\.\/lib\/ipc\.js';/);
  });

  test('EXO-99: teardown — nothing left for the next suite', () => {
    reset();
    assert.deepEqual(calls, []);
  });
});
