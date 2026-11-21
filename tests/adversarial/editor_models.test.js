/**
 * src/lib/editorModels.js against the real editor store and a stand-in for
 * Monaco: which models live and which are disposed, as the tabs change. The
 * same rules under real Monaco and the real EditorPanel are
 * editor_models_headless.test.js; this half runs everywhere.
 *
 * A model is made the way @monaco-editor/react makes one when an editor is
 * handed a tab's path (`show`): only then does a file have one. The rules:
 *
 *   - EM-01…EM-03: a file's model lives while any tab is open on it, in any
 *     group, and is disposed when the last one closes — by its own close, its
 *     group's, or another folder opening.
 *   - EM-04, EM-05: a rename or a move gives the new path a model holding the
 *     same text, and disposes the old: one model, at the new path.
 *   - EM-06: Reload From Disk is one edit of the model, between undo stops.
 *   - EM-07: typing makes and disposes nothing; a model no tab named is left
 *     alone; watching twice is watching once, and stopping stops.
 *   - EM-08: the caret and scroll kept per file, moved with a rename and
 *     forgotten with the model.
 *   - EM-09 (AC3): EditorPanel wires it: no `key` on <Editor>,
 *     `keepCurrentModel`, the library's own view states off, the model's
 *     URI as `path`, the text through `editorValue`, and a comment that says
 *     what is true.
 *   - EM-10: models are named by Monaco's own `Uri.file`, which the library's
 *     `Uri.parse` of `modelPath` gives back — for a literal `%20` and its
 *     decoded twin (two files, two models), `#`, `?`, and Windows paths with
 *     drive letters and backslashes.
 *   - EM-11: a model made after its tab closed is disposed by the next
 *     change of the tabs, or once the editor showing it moves on.
 *   - EM-12: a shown file's model is kept on its editor until the editor
 *     moves on; a file closed and opened again at once, with other text,
 *     hands that editor a new model holding it — never none.
 *   - EM-13: line endings: the library is handed the model's text where
 *     only the line endings differ, nothing before the model exists, and
 *     Reload From Disk makes no edit for line endings alone, but gives the
 *     model the file's line ending where that changed, in the same step,
 *     with the text edit made while the model has CRLF.
 *   - EM-14: a UTF-8 BOM, which the tab keeps and the model does not, makes
 *     no difference to `editorValue` or Reload From Disk, is never handed
 *     to the model, and stays in the tab's text when the editor edits it
 *     (`bufferText`).
 *   - EM-15: a tab replaced on its path by a new tab in one update gets a
 *     model of its own; a tab kept, or joined by a second tab on its path,
 *     keeps it.
 */
import { readFileSync } from 'node:fs';
import { URI } from 'monaco-editor/base/common/uri.js';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { setEditorLayout, editorTree, editorPane, EMPTY_EDITOR_ROOT, setEditorPaneTabIds } from '../e2e/harness/workbench.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import {
  bufferText,
  editorValue,
  modelPath,
  replaceModelText,
  saveViewState,
  showFile,
  syncEditorModels,
  trackEditor,
  watchEditorModels,
} from '../../src/lib/editorModels.js';

const S = useEditorStore;
const ROOT = '/workspace';
/** Monaco's EndOfLineSequence. */
const EOL_LF = 0;
const EOL_CRLF = 1;

/**
 * Monaco as far as editorModels.js uses it: URIs, and models that can be
 * disposed. `Uri` is a stand-in unless Monaco's own is handed in. A model
 * keeps a leading BOM out of its text, and its line ending is CRLF when its
 * text has one, as Monaco's are for the texts used here.
 */
function fakeMonaco(Uri = { file: (path) => ({ path, toString: () => `file://${path}` }) }) {
  const models = new Map(); // URI string -> model
  const createModel = (value, language, uri) => {
    const key = uri.toString();
    assert.ok(!models.has(key), `a second model for ${key}`);
    const model = {
      uri,
      value: value.startsWith('\uFEFF') ? value.slice(1) : value,
      language,
      disposed: false,
      edits: [],
      stops: 0,
      getValue: () => model.value,
      getEOL: () => (model.value.includes('\r\n') ? '\r\n' : '\n'),
      getLanguageId: () => model.language,
      isDisposed: () => model.disposed,
      dispose() {
        model.disposed = true;
        models.delete(key);
      },
      getFullModelRange: () => ({ full: true }),
      pushStackElement() {
        model.stops += 1;
        model.edits.push('stop');
      },
      pushEditOperations(_selections, operations) {
        model.edits.push(operations);
        model.value = operations[0].text;
        return null;
      },
      pushEOL(eol) {
        model.edits.push({ eol });
        model.value = model.value.replace(/\r\n|\r|\n/g, eol === EOL_CRLF ? '\r\n' : '\n');
      },
    };
    models.set(key, model);
    return model;
  };
  return {
    Uri,
    editor: {
      EndOfLineSequence: { LF: EOL_LF, CRLF: EOL_CRLF },
      getModel: (uri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
      createModel,
    },
    /** What the library does when an editor is handed `path` (`modelPath`): its model, or a new one. */
    show(path, content = '', language = 'javascript') {
      return models.get(Uri.file(path).toString()) ?? createModel(content, language, Uri.file(path));
    },
    paths: () => [...models.values()].map((m) => m.uri.path).sort(),
  };
}

/** A Monaco editor as far as editorModels.js uses it. */
function fakeEditor(model = null) {
  let disposeListeners = [];
  const modelListeners = [];
  const editor = {
    model,
    restored: [],
    view: null,
    getModel: () => editor.model,
    setModel(next) {
      editor.model = next;
      editor.view = null;
      modelListeners.forEach((l) => l());
    },
    onDidChangeModel(listener) {
      modelListeners.push(listener);
    },
    saveViewState: () => (editor.model ? { ...editor.view, of: editor.model.uri.path } : null),
    restoreViewState(state) {
      editor.restored.push(state);
      editor.view = { ...state };
    },
    onDidDispose(listener) {
      disposeListeners.push(listener);
    },
    dispose() {
      disposeListeners.forEach((l) => l());
      disposeListeners = [];
    },
  };
  return editor;
}

let monaco;
let stop;
let scratch = 0;

/** Files of their own, so that no other suite's are touched. */
async function scratchFiles(...names) {
  scratch += 1;
  const dir = `${ROOT}/_editor_models_${Date.now()}_${scratch}`;
  await invoke('fs_create_dir', { path: dir });
  const paths = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    await invoke('fs_create_file', { path });
    await invoke('fs_write_file', { path, content: `// ${name}\n` });
    paths.push(path);
  }
  return { dir, paths };
}

const tabOn = (path) => S.getState().tabs.find((t) => t.filePath === path);
const leaves = (node = editorTree(), acc = []) => {
  if (node?.type === 'leaf') acc.push(node);
  else node?.children.forEach((c) => leaves(c, acc));
  return acc;
};

describe('Editor models: one per open file, disposed with its last tab', () => {
  beforeEach(() => {
    delete mockBridge.root;
    S.setState({
      rootPath: ROOT,
      expandedFolders: new Set([ROOT]),
      tabs: [],
      activeTabId: null,
      pendingClose: null,
      pendingOverwrite: null,
      clipboard: null,
    });
    setEditorLayout();
    monaco = fakeMonaco();
    stop = watchEditorModels(monaco, S);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    delete mockBridge.root;
  });

  test('EM-01: closing the last tab on a file disposes its model, and no other', async () => {
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const modelA = monaco.show(a, tabOn(a).content);
    monaco.show(b, tabOn(b).content);

    S.getState().closeTab(tabOn(b).id);
    assert.deepEqual(monaco.paths(), [a], 'b.js was closed and kept its model, or a.js lost its own');
    assert.equal(modelA.disposed, false);
    S.getState().closeTab(tabOn(a).id);
    assert.deepEqual(monaco.paths(), [], 'a closed file kept its model');

    // Opened again, it has none until an editor shows it — and then a new one,
    // from what is on disk, not the one disposed.
    await S.getState().openFile(a);
    assert.deepEqual(monaco.paths(), []);
    assert.notEqual(monaco.show(a, tabOn(a).content), modelA);
  });

  test('EM-02: one tab in two groups keeps its model while either group still holds it', async () => {
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const ta = tabOn(a).id;
    const tb = tabOn(b).id;
    setEditorLayout({
      type: 'split',
      id: 'editor-split-em02',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: 'editor-pane-em02-l', tabIds: [ta], activeTabId: ta },
        { type: 'leaf', id: 'editor-pane-em02-r', tabIds: [ta, tb], activeTabId: ta },
      ],
    });
    const modelA = monaco.show(a);
    monaco.show(b);

    S.getState().closeEditorPane('editor-pane-em02-r');
    assert.equal(modelA.disposed, false, 'closing one of two groups disposed the model under the other');
    assert.deepEqual(monaco.paths(), [a], 'b.js closed with its group and kept its model');
    assert.deepEqual(leaves().map((l) => l.tabIds), [[ta]]);

    S.getState().closeEditorPane('editor-pane-em02-l');
    assert.equal(modelA.disposed, true, 'the last group holding a.js closed and its model stayed');
  });

  test('EM-03: two tabs on one path share one model, disposed only with the second; another folder disposes them all', async () => {
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    // A second tab on a.js, as a store change could make one: counted, not assumed away.
    const twin = { ...tabOn(a), id: 'tab-edit-em03-twin' };
    S.setState((state) => ({ tabs: [...state.tabs, twin] }));
    setEditorPaneTabIds((tabIds) => [...tabIds, twin.id]);
    const modelA = monaco.show(a);
    monaco.show(b);
    S.getState().closeTab(twin.id);
    assert.equal(modelA.disposed, false, 'closing one of two tabs on a.js disposed the model the other shows');

    // A model nobody's tab named — not this module's to dispose.
    const foreign = monaco.show('/elsewhere/diff-original.js');
    S.setState({ rootPath: ROOT });
    const opening = await S.getState().openRoot(`${ROOT}/src`);
    assert.equal(opening, `${ROOT}/src`, 'the other folder did not open');
    assert.equal(modelA.disposed, true, 'the folder left kept a.js\'s model');
    assert.deepEqual(monaco.paths(), ['/elsewhere/diff-original.js'], 'the folder left kept models, or a foreign one went');
    assert.equal(foreign.disposed, false);
  });

  test('EM-04: a rename leaves one model, at the new path, holding the same text and language', async () => {
    const { dir, paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const old = monaco.show(a, 'the edited, unsaved text\n', 'javascript');

    await S.getState().renamePath(a, 'renamed.ts');
    const renamed = `${dir}/renamed.ts`;
    assert.ok(tabOn(renamed), 'the tab did not follow the rename');
    assert.equal(old.disposed, true, 'the old path kept its model');
    assert.deepEqual(monaco.paths(), [renamed], 'not one model, at the new path');
    const moved = monaco.editor.getModel(monaco.Uri.file(renamed));
    assert.equal(moved.getValue(), 'the edited, unsaved text\n', 'the renamed file lost its text');
    assert.equal(moved.getLanguageId(), 'javascript', 'the language changed under the editor');

    // A tab no editor has shown has no model, and a rename makes none.
    await S.getState().renamePath(b, 'b2.js');
    assert.deepEqual(monaco.paths(), [renamed]);
  });

  test('EM-05: a move — a file cut and pasted, a folder renamed — moves every model under it', async () => {
    const { dir, paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await invoke('fs_create_dir', { path: `${dir}/sub` });
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    monaco.show(a, 'A\n');
    monaco.show(b, 'B\n');

    S.getState().cutToClipboard(a, false);
    await S.getState().pasteClipboard(`${dir}/sub`);
    assert.deepEqual(monaco.paths(), [b, `${dir}/sub/a.js`].sort());
    assert.equal(monaco.editor.getModel(monaco.Uri.file(`${dir}/sub/a.js`)).getValue(), 'A\n');

    await S.getState().renamePath(dir, `${dir.split('/').pop()}-moved`);
    const movedDir = `${dir}-moved`;
    assert.deepEqual(monaco.paths(), [`${movedDir}/b.js`, `${movedDir}/sub/a.js`].sort(), 'the folder rename left models behind');
    assert.equal(monaco.editor.getModel(monaco.Uri.file(`${movedDir}/b.js`)).getValue(), 'B\n');
  });

  test('EM-06: Reload From Disk replaces the text with one edit of the model, between undo stops', async () => {
    const { paths: [a] } = await scratchFiles('a.js');
    await S.getState().openFile(a);
    const model = monaco.show(a, 'buffer\n');
    S.getState().editBuffer(tabOn(a).id, 'buffer\n');
    await invoke('fs_write_file', { path: a, content: 'on disk\n' });

    await S.getState().reloadFromDisk(tabOn(a).id);
    assert.equal(model.disposed, false, 'Reload From Disk replaced the model rather than its text');
    assert.equal(model.getValue(), 'on disk\n');
    assert.deepEqual(model.edits, ['stop', [{ range: { full: true }, text: 'on disk\n' }], 'stop'], 'not one edit between undo stops');
    const tab = tabOn(a);
    assert.equal(tab.content, 'on disk\n');
    assert.equal(tab.isDirty, false);

    // Without a model — never shown — the tab still takes the text.
    const { paths: [b] } = await scratchFiles('b.js');
    await S.getState().openFile(b);
    await invoke('fs_write_file', { path: b, content: 'new\n' });
    await S.getState().reloadFromDisk(tabOn(b).id);
    assert.equal(tabOn(b).content, 'new\n');
    assert.equal(replaceModelText(b, 'x'), false, 'a model appeared from nowhere');
  });

  test('EM-07: typing makes and disposes nothing; watching twice is once; stopped, nothing is disposed', async () => {
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const model = monaco.show(a);
    for (const text of ['1', '12', '123']) S.getState().editBuffer(tabOn(a).id, text);
    assert.deepEqual(monaco.paths(), [a]);
    assert.equal(model.disposed, false);
    const tabs = S.getState().tabs;
    syncEditorModels(monaco, tabs, tabs.map((t) => ({ ...t })));
    assert.deepEqual(monaco.paths(), [a], 'the same files, as new objects, disposed something');

    assert.equal(watchEditorModels(monaco, S), stop, 'a second watch is a second subscription');
    stop();
    stop = null;
    S.getState().closeTab(tabOn(a).id);
    assert.equal(model.disposed, false, 'a stopped watch still disposes');
    assert.equal(replaceModelText(a, 'x'), false, 'a stopped watch still edits models');
  });

  test('EM-08: the caret and scroll are kept per file, moved with a rename, and forgotten with the model', async () => {
    const { dir, paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const editor = fakeEditor(monaco.show(a));
    trackEditor(editor);
    editor.view = { line: 7 };
    saveViewState(editor);

    // The library swaps to b.js, then the group shows it: nothing kept for b.js.
    editor.setModel(monaco.show(b));
    showFile(editor, { filePath: b, content: '' }, 'javascript');
    assert.deepEqual(editor.restored, []);
    // And back: a.js's caret.
    editor.setModel(monaco.show(a));
    showFile(editor, { filePath: a, content: '' }, 'javascript');
    assert.deepEqual(editor.restored.pop(), { line: 7, of: a });

    // A model the library never set (the editor still on another file): shown anyway.
    editor.setModel(monaco.show(b));
    showFile(editor, { filePath: a, content: '' }, 'javascript');
    assert.equal(editor.getModel().uri.path, a, 'the editor was left on the wrong file');

    // Renamed while shown: the caret it showed goes with it.
    editor.view = { line: 9 };
    await S.getState().renamePath(a, 'a2.js');
    editor.setModel(monaco.show(`${dir}/a2.js`));
    showFile(editor, { filePath: `${dir}/a2.js`, content: '' }, 'javascript');
    assert.deepEqual(editor.restored.pop(), { line: 9, of: a });

    // Closed and opened again: no caret from before.
    S.getState().closeTab(tabOn(`${dir}/a2.js`).id);
    await S.getState().openFile(`${dir}/a2.js`);
    editor.setModel(monaco.show(`${dir}/a2.js`));
    const before = editor.restored.length;
    showFile(editor, { filePath: `${dir}/a2.js`, content: '' }, 'javascript');
    assert.equal(editor.restored.length, before, 'a reopened file was given the caret of the closed one');
    editor.dispose();
  });

  test('EM-10: models are named by Uri.file, which the library gets back from modelPath — %20 twins, #, ?, Windows paths', async () => {
    const paths = [
      '/w/a%20b.js',
      '/w/a b.js',
      '/w/a#b.js',
      '/w/a?b.js',
      'C:\\proj\\src\\a.js',
      'C:/proj/src/a.js',
      '\\\\server\\share\\a.js',
    ];
    for (const path of paths) {
      // What the library does with `path`: Uri.parse.
      assert.equal(URI.parse(modelPath(URI, path)).toString(), URI.file(path).toString(), `${path}: not the URI the model is named by`);
    }
    assert.notEqual(modelPath(URI, '/w/a%20b.js'), modelPath(URI, '/w/a b.js'), 'a literal %20 and a space are one model');
    assert.equal(URI.parse('/w/a%20b.js').toString(), URI.parse('/w/a b.js').toString(), 'Uri.parse no longer decodes: the reason for Uri.file is gone');

    // Through the store, with Monaco's own URIs: two models, and closing one leaves the other.
    stop();
    monaco = fakeMonaco(URI);
    stop = watchEditorModels(monaco, S);
    const { dir } = await scratchFiles();
    const encoded = `${dir}/a%20b.js`;
    const spaced = `${dir}/a b.js`;
    for (const path of [encoded, spaced]) {
      await invoke('fs_create_file', { path });
      await invoke('fs_write_file', { path, content: `// ${path}\n` });
      await S.getState().openFile(path);
    }
    const one = monaco.show(encoded, tabOn(encoded).content);
    const two = monaco.show(spaced, tabOn(spaced).content);
    assert.notEqual(one, two, 'the twins share a model');
    S.getState().closeTab(tabOn(encoded).id);
    assert.equal(one.disposed, true);
    assert.equal(two.disposed, false, 'closing a%20b.js disposed a b.js');
  });

  test('EM-11: a model made after its tab closed goes with the next change of the tabs, or once its editor moves on', async () => {
    const { paths: [a, b, c, d] } = await scratchFiles('a.js', 'b.js', 'c.js', 'd.js');
    for (const path of [a, b, c, d]) await S.getState().openFile(path);
    S.getState().closeTab(tabOn(a).id);
    // Made from the tab of a render before the close, as the library's effects make them.
    const late = monaco.show(a);
    S.getState().closeTab(tabOn(b).id);
    assert.equal(late.disposed, true, 'a model made after its tab closed was left behind');

    // Shown by an editor: kept while it is, gone once the editor moves on.
    const editor = fakeEditor(monaco.show(d));
    trackEditor(editor);
    S.getState().closeTab(tabOn(c).id);
    const shown = monaco.show(c);
    editor.setModel(shown);
    assert.equal(shown.disposed, false, 'a model was disposed under the editor showing it');
    await S.getState().openFile(b);
    assert.equal(shown.disposed, false, 'a model was disposed under the editor showing it');
    editor.setModel(monaco.show(d));
    await null; // released after the event, not inside it
    assert.equal(shown.disposed, true, 'the editor moved on and the closed file kept its model');
    assert.deepEqual(monaco.paths(), [d]);
    editor.dispose();
  });

  test('EM-12: a shown file closed keeps its model on the editor; reopened at once with other text, the editor gets a new model', async () => {
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const old = monaco.show(a, 'the closed tab\'s text\n');
    const editor = fakeEditor(old);
    trackEditor(editor);
    const tab = tabOn(a);

    S.getState().closeTab(tab.id);
    assert.equal(old.disposed, false, 'disposed under the editor showing it: the editor is left with no model');
    assert.equal(editor.getModel(), old);
    // A new tab on a.js, before anything has rendered.
    const again = { ...tab, id: 'tab-edit-em12-again', content: 'the new tab\'s text\n', savedContent: 'the new tab\'s text\n' };
    S.setState((state) => ({ tabs: [...state.tabs, again] }));
    setEditorPaneTabIds((tabIds) => [...tabIds, again.id]);
    assert.equal(old.disposed, true, 'the reopened file kept the closed tab\'s model, text and undo');
    const fresh = editor.getModel();
    assert.ok(fresh && !fresh.disposed, 'the editor was left with no model');
    assert.equal(fresh.getValue(), 'the new tab\'s text\n');
    assert.equal(fresh.uri.toString(), monaco.Uri.file(a).toString());

    // Moved on, the open file keeps it; closed while not shown, it goes at once.
    editor.setModel(monaco.show(b));
    assert.equal(fresh.disposed, false, 'an open file lost its model');
    S.getState().closeTab(again.id);
    assert.equal(fresh.disposed, true);
    editor.dispose();
  });

  test('EM-13: the library is handed the model\'s text where only line endings differ; Reload From Disk ignores line endings alone', async () => {
    const mixed = 'one\r\ntwo\nthree\r\n';
    const held = 'one\r\ntwo\r\nthree\r\n'; // as a Monaco model holds it: the kind most lines have
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await invoke('fs_write_file', { path: a, content: mixed });
    await S.getState().openFile(a);
    await S.getState().openFile(b);

    assert.equal(editorValue(a, mixed), undefined, 'no model yet: the library must make it from defaultValue, not compare');
    const model = monaco.show(a, held);
    assert.equal(editorValue(a, mixed), held, 'only line endings differ, and the library was handed text to replace the model with');
    assert.equal(editorValue(a, 'one\r\nTWO\nthree\r\n'), 'one\r\nTWO\nthree\r\n', 'a real change did not reach the library');
    monaco.show(b, '// b.js\n');
    assert.equal(editorValue(b, '// b.js\n'), '// b.js\n');
    assert.equal(editorValue(b, '// b.js\r\n'), '// b.js\n');

    // Most lines CRLF on disk, as in the model: nothing to change.
    assert.equal(replaceModelText(a, mixed), true);
    assert.deepEqual(model.edits, [], 'Reload From Disk made an edit for line endings alone');
    assert.equal(replaceModelText(a, 'one\r\nTWO\nthree\r\n'), true);
    assert.deepEqual(model.edits, ['stop', [{ range: { full: true }, text: 'one\r\nTWO\nthree\r\n' }], 'stop']);
    // The same lines, most of them LF on disk now: the model takes LF, as one step (FX-8).
    model.edits.length = 0;
    assert.equal(replaceModelText(a, 'one\nTWO\r\nthree\n'), true);
    assert.deepEqual(model.edits, ['stop', { eol: EOL_LF }, 'stop'], 'the model kept CRLF where the file now has LF, or took it as more than its line ending');
    assert.equal(model.getValue(), 'one\nTWO\nthree\n');
    // Other lines and another line ending: both, in one step, the text edit
    // made while the model has CRLF (FX-10): to CRLF, the line ending first.
    model.edits.length = 0;
    assert.equal(replaceModelText(a, 'ONE\r\nTWO\r\nthree\r\n'), true);
    assert.deepEqual(model.edits, ['stop', { eol: EOL_CRLF }, [{ range: { full: true }, text: 'ONE\r\nTWO\r\nthree\r\n' }], 'stop'], 'to CRLF, the text edit was not made after the line ending');
    // And to LF, the text edit first.
    model.edits.length = 0;
    assert.equal(replaceModelText(a, 'one\nTWO\nthree\n'), true);
    assert.deepEqual(model.edits, ['stop', [{ range: { full: true }, text: 'one\nTWO\nthree\n' }], { eol: EOL_LF }, 'stop'], 'to LF, the text edit was not made before the line ending');
    assert.equal(model.getValue(), 'one\nTWO\nthree\n');
    // No line break on disk: the model keeps its own.
    model.edits.length = 0;
    assert.equal(replaceModelText(a, 'ONE'), true);
    assert.deepEqual(model.edits, ['stop', [{ range: { full: true }, text: 'ONE' }], 'stop']);

    stop();
    stop = null;
    assert.equal(editorValue(a, mixed), mixed, 'not watching, the tab\'s text goes as it is');
  });

  test('EM-14: a UTF-8 BOM counts for nothing against the model, is never handed to it, and stays in the tab\'s text', async () => {
    const lf = '\uFEFFexport const bom = 1;\n';
    const crlf = '\uFEFFone\r\ntwo\r\n';
    const { paths: [a, b] } = await scratchFiles('a.js', 'b.js');
    await invoke('fs_write_file', { path: a, content: lf });
    await invoke('fs_write_file', { path: b, content: crlf });
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const modelA = monaco.show(a, tabOn(a).content);
    const modelB = monaco.show(b, tabOn(b).content);
    assert.equal(tabOn(a).content, lf, 'the tab does not hold the file as read');
    assert.equal(modelA.getValue(), lf.slice(1));

    // The library's value: the model's own text, not one with the BOM in it.
    assert.equal(editorValue(a, lf), lf.slice(1), 'a BOM file, LF: the library was handed text to replace the model with');
    assert.equal(editorValue(b, crlf), crlf.slice(1), 'a BOM file, CRLF: the library was handed text to replace the model with');
    assert.equal(editorValue(b, '\uFEFFone\ntwo\r\n'), crlf.slice(1));
    assert.equal(editorValue(a, '\uFEFFexport const bom = 2;\n'), 'export const bom = 2;\n', 'a real change went with a BOM in it');
    assert.equal(editorValue(a, 'export const bom = 2;\n'), 'export const bom = 2;\n');

    // Reload From Disk: no edit for the BOM, and none with a BOM in it.
    assert.equal(replaceModelText(a, lf), true);
    assert.equal(replaceModelText(b, crlf), true);
    assert.deepEqual([modelA.edits, modelB.edits], [[], []], 'Reload From Disk made an edit for the BOM alone');
    assert.equal(replaceModelText(a, '\uFEFFexport const bom = 3;\n'), true);
    assert.deepEqual(modelA.edits, ['stop', [{ range: { full: true }, text: 'export const bom = 3;\n' }], 'stop']);

    // The tab's text, as the editor hands it over: with the BOM the tab had, once.
    assert.equal(bufferText(lf, 'export const bom = 4;\n'), '\uFEFFexport const bom = 4;\n');
    assert.equal(bufferText(lf, lf), lf, 'a BOM twice');
    assert.equal(bufferText(lf, ''), '\uFEFF');
    assert.equal(bufferText('export const x = 1;\n', 'y'), 'y', 'a BOM given to a file without one');
    assert.equal(bufferText(undefined, 'y'), 'y');
    S.getState().editBuffer(tabOn(a).id, bufferText(tabOn(a).content, lf.slice(1)));
    assert.equal(tabOn(a).isDirty, false, 'the text as read, from the editor, is unsaved');
  });

  test('EM-15: a tab replaced on its path by a new tab in one update takes none of the old model; kept, or joined by a second tab, it keeps it', async () => {
    const { paths: [a, b, c] } = await scratchFiles('a.js', 'b.js', 'c.js');
    await S.getState().openFile(a);
    await S.getState().openFile(b);
    const shown = monaco.show(a, 'the old tab\'s text\n');
    const editor = fakeEditor(shown);
    trackEditor(editor);
    const hidden = monaco.show(b, 'the old tab\'s text\n');

    // Another tab opened, these kept: the models stay.
    await S.getState().openFile(c);
    assert.deepEqual([shown.disposed, hidden.disposed], [false, false], 'a tab kept on its path lost its model');

    // Both swapped for new tabs on the same paths, with other text, in one setState.
    const [oldA, oldB] = [tabOn(a), tabOn(b)];
    const newA = { ...oldA, id: 'tab-edit-em15-a', content: 'the new a\n', savedContent: 'the new a\n' };
    const newB = { ...oldB, id: 'tab-edit-em15-b', content: 'the new b\n', savedContent: 'the new b\n' };
    const swap = (id) => (id === oldA.id ? newA.id : id === oldB.id ? newB.id : id);
    S.setState((state) => ({ tabs: state.tabs.map((t) => (t.id === oldA.id ? newA : t.id === oldB.id ? newB : t)) }));
    setEditorPaneTabIds((tabIds) => tabIds.map(swap));
    assert.equal(shown.disposed, true, 'the new tab on a.js inherited the old tab\'s model, text and undo');
    assert.equal(hidden.disposed, true, 'the new tab on b.js inherited the old tab\'s model, text and undo');
    const fresh = editor.getModel();
    assert.ok(fresh && !fresh.disposed, 'the editor was left with no model');
    assert.equal(fresh.getValue(), 'the new a\n');
    assert.equal(monaco.editor.getModel(monaco.Uri.file(b)), null, 'b.js, shown nowhere, has a model nobody asked for');

    // A second tab on a.js, the first still open: one file, one model, kept.
    const second = { ...newA, id: 'tab-edit-em15-a2' };
    S.setState((state) => ({ tabs: [...state.tabs, second] }));
    setEditorPaneTabIds((tabIds) => [...tabIds, second.id]);
    assert.equal(fresh.disposed, false, 'a second tab on a.js took the model of the first, still open');
    assert.equal(editor.getModel(), fresh);
    editor.dispose();
  });
});

describe('EditorPanel keeps one model per file (AC3, source)', () => {
  test('EM-09: no key on <Editor>, keepCurrentModel, its own view states off, the models watched, and a true comment', () => {
    const panel = readFileSync(new URL('../../src/components/editor/EditorPanel.jsx', import.meta.url), 'utf8');
    // The element, not a comment naming it: `<Editor` and a prop after it.
    const element = panel.match(/<Editor\s[\s\S]*?\/>/);
    assert.ok(element, 'no <Editor> in EditorPanel.jsx');
    const props = element[0];
    assert.ok(!/\bkey=/.test(props), 'a key on <Editor> remounts it, and disposes its model, on every tab switch');
    assert.match(props, /\bkeepCurrentModel\b(?!=\{false\})/);
    assert.match(props, /path=\{modelPath\(Uri, activeTab\.filePath\)\}/, 'the model is not named by its URI');
    assert.match(props, /defaultValue=\{activeTab\.content\}/);
    assert.match(props, /value=\{shownValue\}/);
    assert.match(panel, /editorValue\(shownPath, shownContent\)/, 'the text does not go through editorValue');
    assert.match(props, /onChange=\{\(value\) => editBuffer\(activeTab\.id, bufferText\(activeTab\.content, value \?\? ''\)\)\}/, 'the edited text does not keep the BOM (bufferText)');
    assert.match(props, /saveViewState=\{false\}/);
    assert.match(props, /beforeMount=\{\(monaco\) => watchEditorModels\(monaco, useEditorStore\)\}/);
    assert.match(props, /onMount=\{\(editor\) => \{[\s\S]*holdEditor\(editorRef, editor\);[\s\S]*trackEditor\(editor\);[\s\S]*showFile\(/);
    assert.ok(!/Remounting on tab switch is cheap and\s+lossless/.test(panel), 'the comment still says remounting loses nothing');
    assert.match(panel, /src\/lib\/editorModels\.js/, 'the comment does not say where models are disposed');
  });
});
