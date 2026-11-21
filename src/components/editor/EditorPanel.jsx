import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import Editor from '@monaco-editor/react';
// Monaco itself, its workers and its themes arrive with this module rather
// than with the app: imported from main.jsx they were part of the JavaScript
// every launch loaded before anyone had opened a file. The workbench's editor
// pane (EditorPane.jsx) loads this module lazily.
import '../../lib/monaco.js';
import { Uri } from 'monaco-editor';
import { useEditorStore } from '../../stores/editorStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import {
  bufferText,
  editorValue,
  modelPath,
  saveViewState,
  showFile,
  trackEditor,
  watchEditorModels,
} from '../../lib/editorModels.js';

// The pane around the editor — its strip, breadcrumb, frame and drop target —
// is EditorPane.jsx, drawn by the workbench (editor placement, sibling C).
// Nothing is re-exported from it here: this module is the lazy Monaco chunk,
// and an eager module importing anything from it would pull Monaco into the
// first chunk (C1 review M-05; WV-06 forbids any static import of it).

// The app is dark-only (light mode was removed from settingsStore), so the
// Monaco theme is a fixed constant instead of a live settingsStore read.
const MONACO_THEME = 'nexterm-dark';

// Everything here is fixed; the four the Settings window offers are merged in
// per render by `useMonacoOptions`. They used to be hardcoded HERE, so Font
// Size, Tab Size, Word Wrap and Minimap changed the settings window and
// nothing else.
const MONACO_OPTIONS = {
  fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  bracketPairColorization: { enabled: true },
  padding: { top: 8 },
  automaticLayout: true,
};

/** MONACO_OPTIONS plus the four settings the user can actually change. */
function useMonacoOptions() {
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const minimap = useSettingsStore((s) => s.editorMinimap);
  return useMemo(
    () => ({
      ...MONACO_OPTIONS,
      fontSize,
      lineHeight: Math.round(fontSize * 1.5),
      tabSize,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: minimap },
    }),
    [fontSize, tabSize, wordWrap, minimap]
  );
}

/**
 * Keep `editor`, a pane's Monaco editor, in `ref` for as long as it lives.
 *
 * A pane keeps one editor for all the tabs it shows, but not for ever: it
 * is disposed when the pane is left with no tab, and when the pane itself
 * unmounts — a split, a move or a zoom draws it somewhere else in the
 * workbench tree, and hiding the terminal view unmounts them all — and the
 * next one mounts asynchronously, Monaco loading first. Left in the ref, a
 * disposed editor was handed the next request meant for the new one — Go to
 * File asking for the keyboard, a terminal link's line: a disposed editor
 * moves no caret and takes no focus, and the request was spent on it. Let
 * go, the request waits for the new editor's `onMount`.
 */
export function holdEditor(ref, editor) {
  ref.current = editor;
  editor.onDidDispose?.(() => {
    if (ref.current === editor) ref.current = null;
  });
}

/** The caret and scroll of the file the editor in `ref` shows, kept (src/lib/editorModels.js). */
function saveHeldViewState(ref) {
  saveViewState(ref.current);
}

/**
 * The Monaco editor of one editor pane, for `activeTab`, the tab the pane
 * shows. Drawn inside the pane's `data-editor-pane-body` box by EditorPane.jsx.
 */
export function EditorBody({ activeTab, paneId = null }) {
  const monacoOptions = useMonacoOptions();
  const editBuffer = useEditorStore((s) => s.editBuffer);
  const pendingReveal = useEditorStore((s) => s.pendingReveal);
  const clearReveal = useEditorStore((s) => s.clearReveal);
  const editorRef = useRef(null);
  // The tab this pane shows, for what runs outside a render: `onMount` is
  // called with the closure of the render that MADE the editor, and the tab
  // may have changed while Monaco loaded.
  const shownTabRef = useRef(null);

  /**
   * Put the caret where a terminal link asked for, if that link meant the file
   * THIS pane is showing.
   *
   * Every pane runs this, and the first one holding the file wins and clears
   * the request — the same file can be open in two groups, and jumping in both
   * would move a caret the user was not looking at.
   */
  const applyPendingReveal = useCallback(
    (editor, filePath) => {
      const reveal = useEditorStore.getState().pendingReveal;
      if (!editor || !reveal) return;
      // A request for one pane (`focusEditorPane`) is that pane's alone, for
      // whichever of its files it shows by now (C2 review N-02): kept for
      // the file it showed when asked, it took the keyboard later, when that
      // file came back. Any other request is the file's.
      if (reveal.paneId != null ? reveal.paneId !== paneId : reveal.filePath !== filePath) return;
      // Only the keyboard was asked for (`focusEditor`): the caret stays.
      if (reveal.line == null) {
        editor.focus();
        // Find with the keyboard outside the editor (FC10): Monaco's own.
        if (reveal.find) editor.getAction?.('actions.find')?.run?.();
        clearReveal();
        return;
      }
      // A line is the file's, in whichever pane asked.
      if (reveal.filePath !== filePath) return;
      const lineCount = editor.getModel()?.getLineCount?.() ?? reveal.line;
      // A stack trace can name a line past the end of a file that has since
      // been edited. Land on the last line rather than refusing to move.
      const line = Math.min(Math.max(1, reveal.line), Math.max(1, lineCount));
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: Math.max(1, reveal.column || 1) });
      editor.focus();
      clearReveal();
    },
    [clearReveal, paneId]
  );

  const language = activeTab?.language || 'javascript';
  shownTabRef.current = activeTab ? { filePath: activeTab.filePath, content: activeTab.content, language } : null;
  const shownId = activeTab?.id ?? null;
  const shownPath = activeTab?.filePath ?? null;
  const shownContent = activeTab?.content ?? '';
  // The file's text as the library is handed it (`editorValue`): the tab's,
  // unless only its line endings or a BOM differ from what the model holds.
  // Worked out again only when the file or its text changes.
  const shownValue = useMemo(
    () => (shownPath === null ? undefined : editorValue(shownPath, shownContent)),
    [shownPath, shownContent]
  );

  // The caret and scroll of the file shown, saved before anything takes them
  // away: the library swaps the model, and disposes an unmounting editor, in
  // effects of its own, which run after every layout effect of the commit.
  // Saved any later, a pane taking this tab from this one could restore
  // them before they were saved: which goes first is only the order the
  // panes are drawn in.
  useLayoutEffect(() => () => saveHeldViewState(editorRef), [shownId, shownPath]);

  // Once the library has swapped the model (an effect of <Editor>, which runs
  // before this pane's), the caret and scroll the file had.
  useEffect(() => {
    showFile(editorRef.current, shownTabRef.current, shownTabRef.current?.language);
  }, [shownId, shownPath]);

  // Neither a tab switch nor a second link into the file already shown
  // remounts the editor, so `onMount` does not fire again and this is what
  // moves the caret. Declared after the effect above: the file's own caret
  // first, then the line asked for.
  useEffect(() => {
    if (!pendingReveal || !activeTab) return;
    applyPendingReveal(editorRef.current, activeTab.filePath);
  }, [pendingReveal, activeTab, applyPendingReveal]);

  if (!activeTab) return null;

  /* Monaco Editor — one instance per pane, NOT keyed by the tab: a tab
     switch is a change of `path`, on which the library swaps the editor's
     model. Each open file has one model, holding its text and its undo and
     redo history, and `keepCurrentModel` keeps it when the editor moves on or
     unmounts — a switch, a tab dragged to another pane, a split or a move
     (the pane remounts), a zoom, the terminal view hidden. Keyed by path, as
     it was, every switch remounted the editor and the library disposed the
     model with it: undo, caret and scroll were lost, and one file in two
     panes lost its model under the other when either closed. Models are
     disposed in src/lib/editorModels.js once no tab is open on their file,
     and the caret and scroll are kept there too (the library's own
     view-state map, `saveViewState`, saves under the wrong path). `path` is
     the URI that module names the model by (`modelPath`), and `value` the
     text as `editorValue` gives it: a new model is made from `defaultValue`,
     the tab's text. An edit goes to the store with the BOM the tab's text
     starts with (`bufferText`): Monaco keeps a file's BOM out of the text it
     hands over. */
  return (
    <Editor
      path={modelPath(Uri, activeTab.filePath)}
      keepCurrentModel
      saveViewState={false}
      height="100%"
      language={language}
      theme={MONACO_THEME}
      defaultValue={activeTab.content}
      value={shownValue}
      onChange={(value) => editBuffer(activeTab.id, bufferText(activeTab.content, value ?? ''))}
      beforeMount={(monaco) => watchEditorModels(monaco, useEditorStore)}
      onMount={(editor) => {
        holdEditor(editorRef, editor);
        trackEditor(editor);
        const tab = shownTabRef.current;
        showFile(editor, tab, tab?.language);
        applyPendingReveal(editor, tab?.filePath);
      }}
      options={monacoOptions}
    />
  );
}

export default EditorBody;
