/**
 * The workbench draws the files of the group on screen, and the bridge is
 * gone (editor placement, sibling C, FC2 / AC-C2; was sibling B's FB12 /
 * AC-B9, RN-B9a).
 *
 * Rewritten for sibling C. Sibling B's editor area, EditorPanel, drew the
 * editor PROJECTION of the group on screen above the terminals, and this
 * suite bundled it alone. That area is retired: TerminalSplitContainer draws
 * the full tree, editor leaves included. The old assertions map as follows:
 *
 *   WV-01 "the editor area draws exactly the editor leaves of the group on
 *         screen, in order, and their files only"
 *     -> WV-01 below, on the workbench: the same groups, the same editor
 *        leaves and files, and now the group's terminals beside them.
 *   WV-01 "no terminal pane in the editor area"
 *     -> WV-01: no editor leaf is drawn as a terminal pane (the terminal
 *        panes are the group's terminal leaves exactly); there is no
 *        separate editor area to hold none.
 *   WV-02 "a group with no editor leaf draws no editor area at all, though
 *         files are open in other groups"
 *     -> WV-02: such a group draws no editor pane, only its terminals; and
 *        PanelLayout draws no editor area for any group (WV-06).
 *   WV-02 "nor for a group that is gone"
 *     -> WV-02: with the active group gone the workbench draws the first
 *        group, as it does for terminals, never another group's files.
 *   (new) WV-06: the source checks of AC-C2 — no static import of
 *        EditorPanel.jsx or `@monaco-editor/react` in the workbench or the
 *        layout, and `liftSizes` and the projections gone from the UI.
 *
 * The workbench is bundled with esbuild (workbench_bundle.js) and drawn with
 * the app's own stores, arranged here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { chipsIn, drawWorkbench, editorPanesIn, loadWorkbench, terminalPanesIn } from './workbench_bundle.js';

const T = useTerminalStore;
const E = useEditorStore;
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

const fileTab = (id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' });
const termTab = (id) => ({ id, title: `shell ${id}`, cwd: '/workspace' });
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

let saved = null;

/** The workbench drawn with group `activeGroupId` on screen. */
function drawFor(activeGroupId) {
  E.setState({ tabs: ['e1', 'e2', 'e3'].map(fileTab), activeTabId: 'e2', rootPath: '/workspace', pendingReveal: null });
  T.setState({ tabs: ['t1', 't2', 't3', 't4'].map(termTab), groups: GROUPS, activeGroupId, notifications: [] });
  return drawWorkbench();
}

/** Every file under `dir` (relative to src/) whose name matches `re`. */
function filesUnder(dir, re) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (re.test(name)) out.push(path.slice(SRC.length));
    }
  };
  walk(join(SRC, dir));
  return out;
}

/** The module specifiers of `text`'s static imports (and re-exports). */
const staticImports = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);

describe('Workbench: the files of the group on screen are drawn in the workbench (AC-C2, was AC-B9)', () => {
  beforeEach(async () => {
    await loadWorkbench();
    saved = { t: T.getState(), e: E.getState() };
  });
  afterEach(() => {
    T.setState(saved.t, true);
    E.setState(saved.e, true);
  });

  test('WV-01: the workbench draws exactly the editor leaves of the group on screen, in order, their files only, and its terminal leaves as terminal panes', async () => {
    const one = await drawFor('group-1');
    assert.deepEqual(editorPanesIn(one), ['pane-e1', 'pane-e2'], 'group 1: its two editor leaves');
    assert.deepEqual(terminalPanesIn(one), ['pane-t1', 'pane-t2'], 'group 1: its terminal leaves, and no editor leaf, as terminal panes');
    assert.deepEqual(chipsIn(one), ['e1', 'e2', 't1', 't2'], 'group 1: its files, none of group 2\u{2019}s');

    const two = await drawFor('group-2');
    assert.deepEqual(editorPanesIn(two), ['pane-e3'], 'group 2: its one editor leaf');
    assert.deepEqual(chipsIn(two), ['e3', 't3']);
  });

  test('WV-02: a group with no editor leaf draws no editor pane, though files are open in other groups; a group that is gone draws the first one', async () => {
    const three = await drawFor('group-3');
    assert.deepEqual(editorPanesIn(three), [], 'no editor pane');
    assert.deepEqual(terminalPanesIn(three), ['pane-t4'], 'only its terminal');
    const gone = await drawFor('no-such-group');
    assert.deepEqual(editorPanesIn(gone), ['pane-e1', 'pane-e2'], 'the first group, as for terminals: never a mix of groups');
  });

  test('WV-06: no static import of EditorPanel.jsx or Monaco in the workbench or the layout; liftSizes and the projections are gone from the UI', () => {
    const eager = [
      'components/terminal/TerminalSplitContainer.jsx',
      'components/layout/PanelLayout.jsx',
      'components/editor/EditorPane.jsx',
      'components/editor/EditorTabs.jsx',
    ];
    for (const file of eager) {
      const imports = staticImports(read(file));
      assert.ok(imports.length > 0, `setup: ${file} has imports`);
      assert.equal(imports.some((spec) => /EditorPanel\.jsx$/.test(spec)), false, `${file} imports EditorPanel.jsx statically`);
      assert.equal(imports.some((spec) => /^@monaco-editor\/react$|^monaco-editor/.test(spec)), false, `${file} imports Monaco statically`);
    }
    assert.match(read('components/editor/EditorPane.jsx'), /lazy\(\(\) => import\('\.\/EditorPanel\.jsx'\)\)/, 'the Monaco body is not loaded lazily');
    assert.equal(/EditorPanel/.test(read('components/layout/PanelLayout.jsx').replace(/\/\/[^\n]*/g, '')), false, 'PanelLayout still names the editor area');

    for (const file of filesUnder('components', /\.jsx?$/)) {
      assert.equal(/liftSizes/.test(read(file).replace(/\/\/[^\n]*/g, '')), false, `${file} still uses liftSizes`);
    }
    assert.equal(/export function liftSizes/.test(read('components/terminal/splitLayout.js')), false, 'liftSizes is still defined');
    // The bridge's projections. TerminalsPanel's terminal-only list keeps its
    // own, legitimately (it lists terminals), and the stores keep theirs.
    for (const file of ['components/terminal/TerminalSplitContainer.jsx', 'components/editor/EditorPanel.jsx', 'components/editor/EditorPane.jsx', 'components/editor/EditorTabs.jsx', 'components/layout/PanelLayout.jsx']) {
      const code = read(file).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
      assert.equal(/projectTree/.test(code), false, `${file} still draws a projection`);
    }
    assert.equal(/terminalView/.test(read('components/terminal/TerminalSplitContainer.jsx')), false, 'the terminal projection is still drawn');
    assert.equal(/hasEditorTabs/.test(read('components/layout/PanelLayout.jsx')), false, 'PanelLayout still asks whether the group has files');
  });
});
