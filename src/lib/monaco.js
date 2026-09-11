/**
 * Bundle Monaco locally instead of pulling it from a CDN at runtime.
 * This makes the editor work offline inside the desktop shell and lets the
 * app run under a strict Content-Security-Policy (no remote script hosts).
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Editor themes that share the app's VS Code Modern palette (see styles/index.css).
monaco.editor.defineTheme('nexterm-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editor.lineHighlightBorder': '#282828',
    'editor.selectionBackground': '#264f78',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorGutter.background': '#1f1f1f',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#313131',
    'editorCursor.foreground': '#aeafad',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'focusBorder': '#0078d4',
    'input.background': '#313131',
    'input.border': '#3c3c3c',
    'list.hoverBackground': '#2a2d2e',
    'list.activeSelectionBackground': '#04395e',
    'diffEditor.insertedTextBackground': '#9ccc2c33',
    'diffEditor.removedTextBackground': '#ff000033',
  },
});

monaco.editor.defineTheme('nexterm-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#3b3b3b',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#171184',
    'editor.lineHighlightBorder': '#eeeeee',
    'editor.selectionBackground': '#add6ff',
    'editorIndentGuide.background1': '#d3d3d3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorGutter.background': '#ffffff',
    'editorWidget.background': '#f8f8f8',
    'editorWidget.border': '#e5e5e5',
    'focusBorder': '#005fb8',
    'input.background': '#ffffff',
    'input.border': '#cecece',
    'list.hoverBackground': '#f2f2f2',
    'list.activeSelectionBackground': '#e8e8e8',
  },
});

loader.config({ monaco });
