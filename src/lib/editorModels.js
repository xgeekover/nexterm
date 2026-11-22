/**
 * The Monaco text models of the editor's open files: one per file, for as
 * long as a tab is open on it.
 *
 * A model is the file's text together with its undo and redo history, and
 * Monaco throws both away with it. @monaco-editor/react makes a file's model
 * the first time an editor is handed its `path`, and with `keepCurrentModel`
 * leaves it alone when that editor moves on to another path or unmounts —
 * which every editor group does all the time: a tab switch, a tab dragged to
 * another group, a split (the group is drawn somewhere else in the tree and
 * remounts), the editor region hidden. So the models outlive every editor,
 * and this module is what disposes of them, when no tab is open on the file
 * any more: its last tab closed, the group holding it closed, another folder
 * opened (every tab goes with it). One file shown in two groups is one model
 * and is not disposed while either still shows it, because what counts is
 * the tabs of the store, not the editors.
 *
 * A file renamed or moved while open gets a model at its new path holding
 * the same text — Monaco cannot change a model's URI — and the old one is
 * disposed. Its undo history stays behind with it; nothing promises more.
 *
 * Reload From Disk replaces a model's text, and its line ending where the
 * file's changed, with one edit of the model (`replaceModelText`), so it is
 * undone like any other.
 *
 * The caret, selection and scroll of each file (Monaco's view state) are kept
 * here too. The library has a view-state map of its own, but it saves an
 * unmounting editor's state under the path that editor was FIRST given
 * (its cleanup closes over the first render), and a group that takes a tab
 * from another restores before the other has saved, depending on which is
 * drawn first. EditorPanel turns it off (`saveViewState={false}`) and saves
 * here, keyed by model, just before an editor's model changes or the editor
 * goes, and restores here once the editor holds the model again. So one file
 * shown in two groups has one saved caret and scroll, not one per group: the
 * one saved last wins.
 *
 * Models are named by `Uri.file` of the path (`uriOf`), which keeps a literal
 * `%20` in a file name apart from a space, and a model's line endings are its
 * own: Monaco gives a file with CRLF and LF mixed the kind most of its lines
 * have, and keeps a UTF-8 BOM out of the text, and `editorValue` keeps the
 * library from taking either for an edit (`bufferText` keeps the BOM in the
 * tab's text, which Save writes).
 *
 * Nothing here imports Monaco or the store: EditorPanel hands both over
 * (`watchEditorModels`) the first time an editor is about to be made, so
 * that the store can call `replaceModelText` without pulling Monaco into the
 * startup bundle, and a test can hand over stand-ins.
 */

/** { monaco, store, tabs, unsubscribe, stop } while watching (`tabs`: the store's, as last seen), else null. */
let watched = null;
/** Model URI (as a string) -> the view state last saved for it. */
const viewStates = new Map();
/** Every live editor, so that a model can be moved with the caret it shows. */
const editors = new Set();
/**
 * Every file a tab has named while watching, URI string -> URI: the files
 * whose models are this module's to dispose. A model can be made after its
 * tab has closed — the library and `showFile` make them in effects, from the
 * tab of the render that scheduled them — so what goes is every one of these
 * that no tab is open on (`release`), not only the ones whose tab just closed.
 */
const named = new Map();

/**
 * The URI a file's model is named by: `Uri.file`, which encodes the path.
 * The library names a model `Uri.parse(path)`, which decodes it: handed the
 * bare path, `a%20b.js` and `a b.js` were one model, and undo in one brought
 * in the other's text. EditorPanel hands it `modelPath` instead, which parses
 * back to this.
 */
function uriOf(monaco, path) {
  return monaco.Uri.file(path);
}

/** What EditorPanel hands <Editor> as `path` for a file: `Uri.parse` of it is `uriOf`'s URI. */
export function modelPath(Uri, filePath) {
  return Uri.file(filePath).toString();
}

/**
 * The model URIs the open tabs name. A file is open while at least one tab
 * names it, in any group: one tab shown in two groups is one entry of the
 * store's tabs, and closing either group leaves it there (`closeEditorPane`
 * closes only the tabs no other group still holds).
 */
function openUris(monaco, tabs) {
  const open = new Map(); // URI string -> URI
  for (const tab of tabs) {
    const uri = uriOf(monaco, tab.filePath);
    open.set(uri.toString(), uri);
  }
  return open;
}

/** Whether two tab lists open the same files: the same tabs on the same paths, in the same order. */
function sameFiles(a, b) {
  return a.length === b.length && a.every((tab, i) => tab.id === b[i].id && tab.filePath === b[i].filePath);
}

function liveModel(monaco, uri) {
  const model = monaco.editor.getModel(uri);
  return model && !model.isDisposed?.() ? model : null;
}

/** Every live editor showing `model`: Monaco's list where there is one, which has the editors not yet mounted too. */
function editorsShowing(monaco, model) {
  const all = monaco.editor.getEditors?.() ?? [...editors];
  return all.filter((editor) => editor.getModel?.() === model);
}

/**
 * A UTF-8 byte order mark. The backend leaves it at the start of a file's
 * text, so a tab holds it; Monaco keeps it out of a model's text, and puts
 * one handed in an edit into the text as an ordinary, invisible character.
 */
const BOM = '\uFEFF';

function withoutBOM(text) {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Whether two texts are the same lines, whatever their line endings and a leading BOM. */
function sameLines(a, b) {
  const x = withoutBOM(a);
  const y = withoutBOM(b);
  return x === y || x.replace(/\r\n?/g, '\n') === y.replace(/\r\n?/g, '\n');
}

/**
 * The line ending a model made from `text` has: Monaco's rule, CRLF where
 * more than half the line breaks have a CR. Null without a line break.
 */
function lineEndingOf(text) {
  const breaks = text.match(/\r\n|\r|\n/g);
  if (!breaks) return null;
  const withCR = breaks.reduce((n, b) => (b === '\n' ? n : n + 1), 0);
  return withCR > breaks.length / 2 ? '\r\n' : '\n';
}

/**
 * What the store keeps as a tab's text when the editor hands it `value`:
 * the editor's text, after the BOM the tab's text (`content`) starts with.
 * Monaco never shows the BOM nor hands it over, so without it an edited BOM
 * file was saved without its BOM, and undone to the text as read was unsaved.
 */
export function bufferText(content, value) {
  return content?.startsWith(BOM) && !value.startsWith(BOM) ? BOM + value : value;
}

function disposeModel(model) {
  viewStates.delete(model.uri.toString());
  model.dispose();
}

/**
 * The tab `from` became `to` (same tab, a new path): give the new path a
 * model holding the text the old one had, with the caret and scroll of the
 * editor showing it, unless a tab already open there gave it one.
 */
function moveModel(monaco, fromPath, toPath) {
  const from = liveModel(monaco, uriOf(monaco, fromPath));
  const toUri = uriOf(monaco, toPath);
  if (!from || liveModel(monaco, toUri)) return;
  const fromKey = from.uri.toString();
  const toKey = toUri.toString();
  const [shownIn] = editorsShowing(monaco, from);
  const state = shownIn?.saveViewState?.() ?? viewStates.get(fromKey);
  monaco.editor.createModel(from.getValue(), from.getLanguageId?.(), toUri);
  if (state) viewStates.set(toKey, state);
}

/**
 * Dispose the model of every file a tab named and none is open on (`open`),
 * except one an editor still shows, which goes once none does (`trackEditor`).
 * Monaco takes a disposed model out of the editors showing it, and an editor
 * left with none until React next renders is one the library then edits
 * without a model: its `value` effect asks the model for its range, and
 * throws. That is what a tab closed and a new tab on its path, with other
 * text, in one render did. A closed file's editor is moved on, or disposed,
 * by that render.
 */
function release(monaco, open) {
  for (const [key, uri] of named) {
    if (open.has(key)) continue;
    const model = liveModel(monaco, uri);
    if (!model) viewStates.delete(key);
    else if (editorsShowing(monaco, model).length === 0) disposeModel(model);
  }
}

/**
 * Bring the models in line with the store's tabs, from `before` to `after`:
 * renew the model of a file opened again, move the model of a tab whose path
 * changed, then dispose the model of every file no tab is open on any more
 * (`release`). Only files a tab named are ever disposed — a model anyone
 * else made is not this module's.
 */
export function syncEditorModels(monaco, before, after) {
  if (sameFiles(before, after)) return;
  const wasOpen = openUris(monaco, before);
  const open = openUris(monaco, after);
  const was = new Map(before.map((tab) => [tab.id, tab]));
  const now = new Set(after.map((tab) => tab.id));
  // The files a tab of `before` still in `after` was on. This takes it that
  // no update renames a tab away from a path and opens a new tab on that
  // path at once: the path stays in here, so the new tab would take the
  // model the renamed tab leaves behind, undo and all. No store action does
  // both in one update (opening is async; `openFile` and `mergeRestored`
  // only append tabs).
  const kept = new Set(before.filter((tab) => now.has(tab.id)).map((tab) => uriOf(monaco, tab.filePath).toString()));
  // A file closed and opened again: a model still here from before (an
  // editor still showed it, or it was made late) holds the closed tab's
  // text and undo, not the new tab's. It goes, and an editor that showed it
  // is given a new one at once, from the new tab's text — never none. So
  // does a file whose tab went and a new tab took its place in the same
  // update: open before and after, but not by the same tab.
  const reopened = [];
  for (const tab of after) {
    const uri = uriOf(monaco, tab.filePath);
    const key = uri.toString();
    const replaced = !was.has(tab.id) && !kept.has(key);
    if ((wasOpen.has(key) && !replaced) || !named.has(key)) continue;
    const model = liveModel(monaco, uri);
    if (!model) continue;
    reopened.push({ tab, uri, language: model.getLanguageId?.(), shownIn: editorsShowing(monaco, model) });
    disposeModel(model);
  }
  for (const tab of after) {
    const old = was.get(tab.id);
    if (old && old.filePath !== tab.filePath) moveModel(monaco, old.filePath, tab.filePath);
  }
  for (const { tab, uri, language, shownIn } of reopened) {
    if (shownIn.length === 0) continue;
    const model = liveModel(monaco, uri) ?? monaco.editor.createModel(tab.content ?? '', tab.language || language, uri);
    for (const editor of shownIn) editor.setModel(model);
  }
  for (const [key, uri] of open) named.set(key, uri);
  release(monaco, open);
}

/**
 * Start keeping `store`'s models (see the top of this file). Called every
 * time an editor is about to be made; only the first call per Monaco does
 * anything. Returns the function that stops it — for a test: the app never
 * stops.
 */
export function watchEditorModels(monaco, store) {
  if (watched && watched.monaco === monaco && watched.store === store) return watched.stop;
  watched?.stop();
  const state = { monaco, store, tabs: store.getState().tabs };
  for (const [key, uri] of openUris(monaco, state.tabs)) named.set(key, uri);
  state.unsubscribe = store.subscribe((next) => {
    if (next.tabs === state.tabs) return;
    const before = state.tabs;
    state.tabs = next.tabs;
    syncEditorModels(monaco, before, next.tabs);
  });
  state.stop = () => {
    state.unsubscribe();
    if (watched === state) {
      watched = null;
      named.clear();
    }
  };
  watched = state;
  return state.stop;
}

/**
 * Keep `editor` in sight for as long as it lives (see `moveModel`), and let
 * a closed file's model go once it shows it no more (see `release`).
 */
export function trackEditor(editor) {
  editors.add(editor);
  const letGo = () => {
    if (watched) release(watched.monaco, openUris(watched.monaco, watched.tabs));
  };
  // Not from inside the event: Monaco still cleans up the model it let go
  // after telling, and throws on one disposed by then.
  editor.onDidChangeModel?.(() => queueMicrotask(letGo));
  editor.onDidDispose?.(() => {
    editors.delete(editor);
    letGo();
  });
}

/** Keep the caret, selection and scroll `editor` shows, for its model. */
export function saveViewState(editor) {
  const model = editor?.getModel?.();
  if (!model) return;
  const state = editor.saveViewState();
  if (state) viewStates.set(model.uri.toString(), state);
}

/**
 * Show `tab`'s file ({ filePath, content }) in `editor`: its model — the one
 * kept, else a new one holding the tab's text in `language` — and the caret
 * and scroll last saved for it.
 *
 * The library swaps models itself on a change of `path`, but only once its
 * editor is ready: a tab switched while Monaco was still loading left the
 * editor on the first file. An editor holding no model is given one here
 * too, but only after the library's own effects of the same render, and its
 * `value` effect throws without one: what keeps an editor from being left
 * with none is `release`, which never disposes a model an editor shows.
 */
export function showFile(editor, tab, language) {
  const monaco = watched?.monaco;
  if (!monaco || !editor || !tab) return;
  const uri = uriOf(monaco, tab.filePath);
  const current = editor.getModel();
  if (!current || current.uri.toString() !== uri.toString()) {
    editor.setModel(liveModel(monaco, uri) ?? monaco.editor.createModel(tab.content ?? '', language, uri));
  }
  const state = viewStates.get(uri.toString());
  if (state) editor.restoreViewState(state);
}

/**
 * Replace the text of `path`'s model, if it has one, as one edit that undo
 * takes back. Returns whether there was a model. The store calls this before
 * it takes the new text itself, so that the editor finds its value already
 * there and does not replace it a second time.
 *
 * The model takes the line ending the text has, in the same undo step: a
 * file converted outside the app (CRLF to LF, or back) and reloaded kept the
 * old one, and the next Save after an edit wrote it back over the conversion.
 */
export function replaceModelText(path, text) {
  const monaco = watched?.monaco;
  if (!monaco) return false;
  const model = liveModel(monaco, uriOf(monaco, path));
  if (!model) return false;
  // The same lines, whatever the line endings and a BOM: the model keeps its
  // text (see the top of this file), and the editor takes the tab's for the same.
  const same = sameLines(model.getValue(), text);
  const eol = lineEndingOf(text);
  const newEOL = eol !== null && eol !== model.getEOL() ? eol : null;
  if (same && newEOL === null) return true;
  const { CRLF, LF } = monaco.editor.EndOfLineSequence;
  // Other lines and another line ending: the text edit is made while the
  // model has CRLF, so after the change to CRLF and before the change to LF.
  // Monaco keeps a step's text edit at the offsets it had in the text of
  // that moment, and undo (redo) puts the old (new) text back at those
  // offsets in the text as it is then, before it restores the line ending;
  // only an offset past the end is cut back to the end. Made under LF, the
  // offsets of the whole text fall short of it under CRLF, by one per line
  // break: undo from LF to CRLF left the reloaded text's last characters
  // behind. Made under CRLF, they reach the end in either line ending.
  model.pushStackElement();
  if (newEOL === '\r\n') model.pushEOL(CRLF);
  if (!same) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: withoutBOM(text) }], () => null);
  if (newEOL === '\n') model.pushEOL(LF);
  model.pushStackElement();
  return true;
}

/**
 * What EditorPanel hands <Editor> as `value` for a tab on `path` holding
 * `content`.
 *
 * A model holds one kind of line ending: made from a file with CRLF and LF
 * mixed, it has the kind most of its lines have. The tab keeps the text as
 * read, which Save writes back as it was until the file is edited. Handed
 * that, the library saw its `value` differ from the model's and replaced the
 * whole text with itself: an undo step nobody made, which undone left the
 * tab unsaved with nothing changed. So where only the line endings differ,
 * the library is handed the model's own text; and where the file has no
 * model yet, nothing (`undefined`, which it leaves alone) — it makes the
 * model from `defaultValue`, the tab's text, and there is nothing to compare
 * with until it has.
 *
 * A file starting with a BOM went the same way: the tab keeps the BOM, the
 * model does not. So the BOM counts for nothing here, and the library is
 * never handed one: in an edit it becomes part of the model's text.
 */
export function editorValue(path, content) {
  const monaco = watched?.monaco;
  if (!monaco) return content;
  const model = liveModel(monaco, uriOf(monaco, path));
  if (!model) return undefined;
  // Line feeds only, and no BOM, in a model of line feeds: nothing to differ by.
  if (model.getEOL?.() === '\n' && !content.includes('\r') && !content.startsWith(BOM)) return content;
  const text = model.getValue();
  return sameLines(text, content) ? text : withoutBOM(content);
}
