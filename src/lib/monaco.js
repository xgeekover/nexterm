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

// The editor's theme. Monaco cannot read CSS custom properties, so each
// colour below is a copy of its src/styles/index.css token (named beside it);
// RN-229 (tests/render/runner.js) fails the build when the two drift apart.
// The three that have no token of their own are derived from the palette:
// the text selection is a violet as light as the old #264f78, the current-line
// border a 1.14 step on the editor, and the scrollbar slider --vsc-scrollbar's
// #9BA3AF at its two alphas.
monaco.editor.defineTheme('nexterm-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#15171C', // --vsc-editor-bg
    'editor.foreground': '#E7E9EE', // --vsc-fg
    'editorLineNumber.foreground': '#6B7280', // --vsc-line-number
    'editorLineNumber.activeForeground': '#E7E9EE', // --vsc-line-number-active
    'editor.lineHighlightBorder': '#1F232B',
    'editor.selectionBackground': '#523F8A',
    'editorIndentGuide.background1': '#3A4150', // --vsc-indent-guide
    'editorIndentGuide.activeBackground1': '#6B7280', // --vsc-indent-guide-active
    'editorGutter.background': '#15171C', // --vsc-editor-bg
    'editorWidget.background': '#1B1E25', // --vsc-widget-bg
    'editorWidget.border': '#3A4150', // --vsc-widget-border
    'editorCursor.foreground': '#E7E9EE', // --vsc-fg
    'scrollbarSlider.background': '#9BA3AF47',
    'scrollbarSlider.hoverBackground': '#9BA3AF73',
    'focusBorder': '#8B5CF6', // the focused-field border token
    'input.background': '#232731', // --vsc-input-bg
    'input.border': '#3A4150', // --vsc-input-border
    'inputOption.activeBorder': '#8B5CF6', // --vsc-accent
    'list.hoverBackground': '#232731', // --vsc-hover
    'list.activeSelectionBackground': '#3B2C5B', // --vsc-selection
    // Monaco's own context menu; without these it keeps vs-dark's grey.
    'menu.background': '#1B1E25', // --vsc-menu-bg
    'menu.foreground': '#E7E9EE', // --vsc-fg
    'menu.selectionBackground': '#3B2C5B', // --vsc-selection
    'menu.border': '#3A4150', // --vsc-widget-border
    'diffEditor.insertedTextBackground': '#9ccc2c33',
    'diffEditor.removedTextBackground': '#ff000033',
  },
});

loader.config({ monaco });
