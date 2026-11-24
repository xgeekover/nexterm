/**
 * TerminalSplitContainer, the workbench, bundled for a server render (editor
 * placement, sibling C) — the technique of workbench_prompts_mounted.test.js.
 *
 * Node cannot import a .jsx file, so the workbench and the components it
 * draws are bundled with esbuild and imported from a data: URL: nothing is
 * registered process-wide. The stores and every other plain module are the
 * app's own, imported by file URL — the very instances a case arranges.
 * React, react-dom and the icons are real. Stood in:
 *  - TerminalView.jsx, the xterm, by a box naming its terminal;
 *  - EditorPanel.jsx, the Monaco body, by a box naming its file — it is
 *    reached only through EditorPane's `React.lazy`, so a server render draws
 *    the Suspense fallback in its place, and a stand-in drawn means it was
 *    imported statically;
 *  - MarkdownPreview.jsx, the Markdown preview's body (Orca bundle 5, step
 *    P7), the same way: reached only through EditorPane's `React.lazy`, so
 *    a server render draws the fallback and a stand-in drawn means a static
 *    import. Stood in rather than bundled, because it brings the renderer's
 *    hast-util-to-jsx-runtime and the worker factory's Vite-only `?worker`
 *    with it, which neither this suite nor Node can load (WV-06b reads the
 *    sources, and fails on a static import of either);
 *  - react-resizable-panels, by boxes that print what each Panel is handed
 *    (its id, `defaultSize` and `minSize`), so the sizes a split is drawn at
 *    can be read back.
 */
import { build } from 'esbuild';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';

const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));

/** Kept real. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'lucide-react', 'zustand', 'zustand/react/shallow']);

const STAND_INS = [
  [
    /\/TerminalView\.jsx$/,
    "import { createElement } from 'react';\nexport function TerminalView({ tabId, active }) { return createElement('div', { 'data-stand-in': 'TerminalView', 'data-tab': tabId, 'data-active': String(Boolean(active)) }); }",
  ],
  [
    /\/EditorPanel\.jsx$/,
    "import { createElement } from 'react';\nexport default function EditorBody({ activeTab }) { return createElement('div', { 'data-stand-in': 'EditorBody', 'data-file': activeTab?.filePath ?? '' }); }",
  ],
  [
    /\/MarkdownPreview\.jsx$/,
    "import { createElement } from 'react';\nexport default function MarkdownBody({ tab }) { return createElement('div', { 'data-stand-in': 'MarkdownBody', 'data-file': tab?.filePath ?? '' }); }",
  ],
  [
    /^react-resizable-panels$/,
    [
      "import { createElement, useRef } from 'react';",
      "export const Group = ({ children, orientation }) => createElement('div', { 'data-split': orientation }, children);",
      "export const Panel = ({ children, id, defaultSize, minSize }) => createElement('div', { 'data-panel-id': id, 'data-default-size': String(defaultSize), 'data-min-size': String(minSize) }, children);",
      "export const Separator = () => createElement('div', { 'data-separator-stand-in': '' });",
      'export const useGroupRef = () => useRef(null);',
    ].join('\n'),
  ],
];

let loading = null;

/** The bundle: `{ TerminalSplitContainer, keptTerminalPaneOf, dropTargetAtPoint, edgeZoneFromPoint }`. */
export function loadWorkbench() {
  loading ??= build({
    stdin: {
      contents: "export { TerminalSplitContainer, keptTerminalPaneOf, dropTargetAtPoint, edgeZoneFromPoint } from './TerminalSplitContainer.jsx';",
      resolveDir: TERMINAL_DIR,
      sourcefile: 'workbench-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'workbench-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const index = STAND_INS.findIndex(([re]) => re.test(args.path));
            if (index !== -1) return { path: String(index), namespace: 'stand-in' };
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            if (args.path.startsWith('.') && /\.jsx$/.test(args.path)) return undefined;
            // The app's plain modules — the stores above all — by file URL:
            // the instances the cases drive, not copies.
            if (args.path.startsWith('.') && /\.js$/.test(args.path) && args.resolveDir) {
              return { path: pathToFileURL(resolvePath(args.resolveDir, args.path)).href, external: true };
            }
            if (args.kind === 'entry-point') return undefined;
            throw new Error(`the workbench imports ${args.path}, which this suite has no stand-in for`);
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: STAND_INS[Number(args.path)][1],
            loader: 'js',
            resolveDir: TERMINAL_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

// The agent session history too: the empty pane's launcher draws its recent entries.
const STORES = [useTerminalStore, useEditorStore, useSettingsStore, useAgentHistoryStore];

/**
 * The workbench as a server render draws it, with the stores as they are now.
 *
 * A server render reads a store's INITIAL state (zustand hands
 * `getInitialState` to useSyncExternalStore as the server snapshot), so the
 * current state is copied into it for the render — as tests/render/runner.js
 * does — and the initial state is put back after.
 */
export async function drawWorkbench() {
  const ui = await loadWorkbench();
  const initials = STORES.map((s) => {
    const initial = s.getInitialState();
    const before = { ...initial };
    Object.assign(initial, s.getState());
    return () => {
      for (const key of Object.keys(initial)) if (!(key in before)) delete initial[key];
      Object.assign(initial, before);
    };
  });
  const report = console.error;
  console.error = (first, ...rest) => {
    // React says, once per render, that a layout effect does nothing on the
    // server — with a stack holding the whole bundle's data: URL. Only that.
    if (typeof first === 'string' && first.includes('useLayoutEffect does nothing on the server')) return;
    report(first, ...rest);
  };
  try {
    return renderToString(React.createElement(ui.TerminalSplitContainer));
  } finally {
    console.error = report;
    initials.forEach((restore) => restore());
  }
}

// --- Reading the markup back ---------------------------------------------------

/** Every pane body, of either kind, in the order drawn: `kind:id`. */
export const panesInOrder = (html) =>
  [...html.matchAll(/data-(editor-pane-body|pane-body)="([^"]+)"/g)].map((m) => `${m[1] === 'pane-body' ? 'terminal' : 'editor'}:${m[2]}`);
export const editorPanesIn = (html) => [...html.matchAll(/data-editor-pane-body="([^"]+)"/g)].map((m) => m[1]);
export const terminalPanesIn = (html) => [...html.matchAll(/data-pane-body="([^"]+)"/g)].map((m) => m[1]);
export const chipsIn = (html) => [...html.matchAll(/data-tab-chip="([^"]+)"/g)].map((m) => m[1]);

/** The ids of the panes whose body holds an active line, in order. */
export function activeLinesIn(html) {
  return [...html.matchAll(/data-active-pane=""/g)].map((m) => {
    const before = [...html.slice(0, m.index).matchAll(/data-(editor-pane-body|pane-body)="([^"]+)"/g)];
    return before.length ? before[before.length - 1][2] : null;
  });
}

/** The markup of pane `id` (either kind) up to the next pane's strip or body. */
export function paneMarkup(html, id) {
  const start = html.search(new RegExp(`data-(editor-tab-strip|tab-strip)="${id}"`));
  if (start === -1) return null;
  const rest = html.slice(start + 1);
  const next = rest.search(/data-(editor-tab-strip|tab-strip)="/);
  return next === -1 ? html.slice(start) : html.slice(start, start + 1 + next);
}

/** What the stand-in Panel holding `id` was handed: `{ defaultSize, minSize }`, or null. */
export function panelOf(html, id) {
  const m = new RegExp(`data-panel-id="${id}" data-default-size="([^"]*)" data-min-size="([^"]*)"`).exec(html);
  return m ? { defaultSize: m[1], minSize: m[2] } : null;
}
