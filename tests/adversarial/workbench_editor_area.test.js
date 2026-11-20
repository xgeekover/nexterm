/**
 * The editor area draws the group on screen (editor placement, sibling B,
 * FB12 / AC-B9): EditorPanel renders the editor projection of the active
 * group's tree — exactly its editor leaves, ids kept — and nothing at all for
 * a group with no editor leaf.
 *
 * The render suite cannot check this: PanelLayout loads EditorPanel through
 * React.lazy, so a server render of the app draws none of its panes. So the
 * panel is bundled here with esbuild, as editor_tab_reorder_ui.test.js does:
 * React and the layout libraries kept real, the panel's own files and the
 * pure split-layout module bundled as they are, the three stores replaced by
 * a state the case sets, and Monaco by an empty stand-in. The bundle is
 * imported from a data: URL, so nothing is registered process-wide.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const EDITOR_DIR = fileURLToPath(new URL('../../src/components/editor/', import.meta.url));

/** Bundled as they are: the panel, its tabs and dialog, and the pure helpers they draw with. */
const BUNDLED = [
  /^\.\/Editor(Panel|Tabs)\.jsx$/,
  /\/common\/ConfirmDialog\.jsx$/,
  /\/terminal\/splitLayout\.js$/,
  /\/lib\/utils\.js$/,
  /\/lib\/paths\.js$/,
];
/** Kept real, so that the panes really draw. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'lucide-react', 'react-resizable-panels']);

/** A store as far as the panel reads it: the state the case sets. */
const fakeStore = (name, initial) => `
let state = ${initial};
export function ${name}(select) { return select(state); }
${name}.getState = () => state;
${name}.setState = () => {};
${name}.subscribe = () => () => {};
export function setFake(next) { state = next; }
`;

/** Every other import the panel has, by what it is: nothing these renders call does anything. */
const STAND_INS = [
  [/\/stores\/editorStore\.js$/, fakeStore('useEditorStore', '{ tabs: [] }').replace('setFake', 'setFakeEditorState')],
  [/\/stores\/terminalStore\.js$/, fakeStore('useTerminalStore', '{ groups: [], activeGroupId: null }').replace('setFake', 'setFakeTerminalState')],
  [/\/stores\/settingsStore\.js$/, fakeStore('useSettingsStore', "{ editorFontSize: 14, editorTabSize: 2, editorWordWrap: 'off', editorMinimap: false }")],
  [/^@monaco-editor\/react$/, 'export default function Editor() { return null; }'],
  [/^monaco-editor$/, "export const Uri = { file: (path) => ({ path, toString: () => 'file://' + path }) };"],
  [/\/lib\/monaco\.js$/, ''],
  [
    /\/lib\/editorModels\.js$/,
    [
      "export const bufferText = () => '';",
      "export const editorValue = () => '';",
      'export const modelPath = (path) => path;',
      'export const saveViewState = () => {};',
      'export const showFile = () => {};',
      'export const trackEditor = () => () => {};',
      'export const watchEditorModels = () => () => {};',
    ].join('\n'),
  ],
  [/\/hooks\/useShortcuts\.js$/, "export function useShortcuts() { return { shortcut: () => '' }; }"],
  [/\/lib\/workspaceFocus\.js$/, 'export const focusWorkspace = () => {};'],
];

let loading = null;
function loadPanel() {
  loading ??= build({
    stdin: {
      contents: [
        "export { EditorPanel } from './EditorPanel.jsx';",
        "export { setFakeEditorState } from '../../stores/editorStore.js';",
        "export { setFakeTerminalState } from '../../stores/terminalStore.js';",
      ].join('\n'),
      resolveDir: EDITOR_DIR,
      sourcefile: 'editor-area-under-test.js',
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
        name: 'editor-area-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (BUNDLED.some((re) => re.test(args.path))) return undefined;
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const index = STAND_INS.findIndex(([re]) => re.test(args.path));
            if (index === -1) throw new Error(`EditorPanel imports ${args.path}, which this suite has no stand-in for`);
            return { path: String(index), namespace: 'stand-in' };
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({ contents: STAND_INS[Number(args.path)][1], loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

let ui = null;

// --- The workbench the cases draw ----------------------------------------------

const fileTab = (id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });
const terminalLeaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });

/** Group 1: [e1 | e2] above two terminals; group 2: e3 above one; group 3: terminals only. */
const GROUPS = [
  {
    id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: 'pane-t1', editorPaneId: 'pane-e2',
    tree: {
      type: 'split', id: 'split-w1', direction: 'vertical', sizes: [60, 40],
      children: [
        { type: 'split', id: 'split-e', direction: 'horizontal', sizes: [50, 50], children: [editorLeaf('pane-e1', ['e1']), editorLeaf('pane-e2', ['e2'])] },
        { type: 'split', id: 'split-t', direction: 'horizontal', sizes: [50, 50], children: [terminalLeaf('pane-t1', ['t1']), terminalLeaf('pane-t2', ['t2'])] },
      ],
    },
  },
  {
    id: 'group-2', name: 'Group 2', createdAt: 0, activePaneId: 'pane-t3', editorPaneId: 'pane-e3',
    tree: { type: 'split', id: 'split-w2', direction: 'vertical', sizes: [60, 40], children: [editorLeaf('pane-e3', ['e3']), terminalLeaf('pane-t3', ['t3'])] },
  },
  { id: 'group-3', name: 'Group 3', createdAt: 0, activePaneId: 'pane-t4', tree: terminalLeaf('pane-t4', ['t4']) },
];

/** EditorPanel drawn with group `activeGroupId` on screen. */
function drawFor(activeGroupId) {
  ui.setFakeEditorState({
    tabs: ['e1', 'e2', 'e3'].map(fileTab),
    activeTabId: 'e2',
    rootPath: '/workspace',
    pendingClose: null,
    pendingOverwrite: null,
    pendingReveal: null,
  });
  ui.setFakeTerminalState({ groups: GROUPS, activeGroupId });
  // React says, once per render, that a layout effect does nothing on the
  // server — with a stack holding the whole bundle's data: URL. Only that.
  const report = console.error;
  console.error = (first, ...rest) => {
    if (typeof first === 'string' && first.includes('useLayoutEffect does nothing on the server')) return;
    report(first, ...rest);
  };
  try {
    return renderToString(React.createElement(ui.EditorPanel));
  } finally {
    console.error = report;
  }
}

const editorPanesIn = (html) => [...html.matchAll(/data-editor-pane-body="([^"]+)"/g)].map((m) => m[1]);
const chipsIn = (html) => [...html.matchAll(/data-tab-chip="([^"]+)"/g)].map((m) => m[1]);

describe('Workbench: the editor area draws the editor leaves of the group on screen (AC-B9)', () => {
  beforeEach(async () => {
    ui = await loadPanel();
  });

  test('WV-01: the editor area draws exactly the editor leaves of the group on screen, in order, and their files only', () => {
    const one = drawFor('group-1');
    assert.deepEqual(editorPanesIn(one), ['pane-e1', 'pane-e2'], 'group 1: its two editor leaves');
    assert.deepEqual(chipsIn(one), ['e1', 'e2'], 'group 1: its files, none of group 2\u{2019}s');
    assert.equal(/data-pane-body="pane-t/.test(one), false, 'no terminal pane in the editor area');

    const two = drawFor('group-2');
    assert.deepEqual(editorPanesIn(two), ['pane-e3'], 'group 2: its one editor leaf');
    assert.deepEqual(chipsIn(two), ['e3']);
  });

  test('WV-02: a group with no editor leaf draws no editor area at all, though files are open in other groups', () => {
    assert.equal(drawFor('group-3'), '', 'nothing drawn');
    assert.equal(drawFor('no-such-group'), '', 'nor for a group that is gone');
  });
});
