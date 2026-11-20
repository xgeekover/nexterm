/**
 * The workbench draws both kinds of pane (editor placement, sibling C, FC2,
 * FC6, FC8, FC9; AC-C2, AC-C6, the render half of AC-C8).
 *
 * TerminalSplitContainer draws the group on screen's FULL tree: a terminal
 * leaf as a TerminalPane, an editor leaf as an EditorPane — its own strip and
 * `data-editor-pane-body`, never the terminal attributes — in tree order, at
 * the sizes the store holds. One active line is drawn across both kinds, by
 * the terminal's rule. The group's one terminal pane, kept empty beside its
 * files, has no Close.
 *
 * The workbench is bundled with esbuild (workbench_bundle.js) and drawn with
 * the app's own stores, arranged here.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import {
  activeLinesIn,
  chipsIn,
  drawWorkbench,
  loadWorkbench,
  paneMarkup,
  panelOf,
  panesInOrder,
} from './workbench_bundle.js';

const T = useTerminalStore;
const E = useEditorStore;

const fileTab = (id) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: 'x', savedContent: 'x', isDirty: false, language: 'javascript' });
const termTab = (id) => ({ id, title: `shell ${id}`, cwd: '/workspace' });
const editorLeaf = (id, tabIds, activeTabId = tabIds[0] ?? null) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId });
const terminalLeaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });

/** [ [e1 | t1] over [t2 | e2] ], sizes 70/30, 50/50 and 40/60. */
const mixedTree = () => ({
  type: 'split', id: 's-root', direction: 'vertical', sizes: [70, 30],
  children: [
    { type: 'split', id: 's-top', direction: 'horizontal', sizes: [50, 50], children: [editorLeaf('pane-e1', ['e1', 'e2'], 'e2'), terminalLeaf('pane-t1', ['t1'])] },
    { type: 'split', id: 's-bottom', direction: 'horizontal', sizes: [40, 60], children: [terminalLeaf('pane-t2', ['t2']), editorLeaf('pane-e2', ['e3'])] },
  ],
});

let saved = null;

function arrange(group, { files = ['e1', 'e2', 'e3'], terminals = ['t1', 't2'] } = {}) {
  E.setState({ tabs: files.map(fileTab), activeTabId: files[0] ?? null, rootPath: '/workspace', pendingReveal: null });
  T.setState({
    tabs: terminals.map(termTab),
    activeTabId: terminals[0] ?? null,
    groups: [{ id: 'g1', name: 'Group 1', createdAt: 0, ...group }],
    activeGroupId: 'g1',
    notifications: [],
  });
}

describe('Workbench render: editor panes inside the workbench tree (AC-C2, AC-C6, AC-C8)', () => {
  beforeEach(async () => {
    await loadWorkbench();
    saved = { t: T.getState(), e: E.getState() };
  });
  afterEach(() => {
    T.setState(saved.t, true);
    E.setState(saved.e, true);
  });

  test('WN-01: a mixed group draws its editor and terminal leaves in tree order, each by its own kind', async () => {
    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e1' });
    const html = await drawWorkbench();
    assert.deepEqual(panesInOrder(html), ['editor:pane-e1', 'terminal:pane-t1', 'terminal:pane-t2', 'editor:pane-e2']);
    assert.deepEqual(chipsIn(html), ['e1', 'e2', 't1', 't2', 'e3'], 'every pane draws its own chips, in tree order');
  });

  test('WN-02: each editor leaf has its strip and its body; no terminal attribute is drawn on an editor pane; Monaco is not drawn at once', async () => {
    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e1' });
    const html = await drawWorkbench();
    for (const id of ['pane-e1', 'pane-e2']) {
      const pane = paneMarkup(html, id);
      assert.ok(pane, `${id} is drawn`);
      assert.match(pane, new RegExp(`data-editor-tab-strip="${id}"`), `${id}: its strip`);
      assert.match(pane, new RegExp(`data-editor-tab-row="${id}"`), `${id}: its scrolling row`);
      assert.match(pane, new RegExp(`data-editor-pane-body="${id}"`), `${id}: its body, the drop target, drawn at once`);
      assert.equal(/data-pane-body=/.test(pane), false, `${id}: a terminal body on an editor pane`);
      assert.equal(/data-tab-strip=/.test(pane), false, `${id}: a terminal strip on an editor pane`);
    }
    for (const id of ['pane-t1', 'pane-t2']) {
      assert.match(paneMarkup(html, id), new RegExp(`data-pane-body="${id}"`), `${id}: a terminal pane as before`);
    }
    // The Monaco body comes through React.lazy (that it is never imported
    // statically is WV-06's source check). Once loaded, it is drawn INSIDE
    // the pane's body box, for the file the pane shows.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const loaded = await drawWorkbench();
    assert.match(paneMarkup(loaded, 'pane-e1'), /data-editor-pane-body="pane-e1"[^>]*>(?:<!--[^>]*-->)?<div data-stand-in="EditorBody" data-file="\/workspace\/e2\.js"/, 'pane-e1 shows its active file, e2, in its body');
    assert.match(paneMarkup(loaded, 'pane-e2'), /data-stand-in="EditorBody" data-file="\/workspace\/e3\.js"/, 'pane-e2 shows e3');
  });

  test("WN-03: a split's editor child gets the stored size; every split is drawn at the store's sizes", async () => {
    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e1' });
    const html = await drawWorkbench();
    assert.equal(panelOf(html, 'pane-e1')?.defaultSize, '50', 'the top-left editor');
    assert.equal(panelOf(html, 'pane-t1')?.defaultSize, '50');
    assert.equal(panelOf(html, 'pane-t2')?.defaultSize, '40');
    assert.equal(panelOf(html, 'pane-e2')?.defaultSize, '60', 'the bottom-right editor keeps its 60');
    assert.equal(panelOf(html, 's-top')?.defaultSize, '70', 'the row of files and terminals above');
    assert.equal(panelOf(html, 's-bottom')?.defaultSize, '30');
  });

  test('WN-04: one active line across kinds, by the terminal rule: the terminal pane, then the file pane; none for one pane or while zoomed', async () => {
    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e1' });
    let html = await drawWorkbench();
    assert.deepEqual(activeLinesIn(html), ['pane-t1'], 'terminal-active');
    assert.match(html, /data-tab="t1" data-active="true"/, 'its terminal is told it is active');

    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e2', activeKind: 'editor' });
    html = await drawWorkbench();
    assert.deepEqual(activeLinesIn(html), ['pane-e2'], 'editor-active: one line, on the file pane');
    assert.match(html, /data-tab="t1" data-active="false"/, 'the terminal pane is told it lost the focus');

    arrange({ tree: mixedTree(), activePaneId: 'pane-t1', editorPaneId: 'pane-e2', activeKind: 'editor', zoomedPaneId: 'pane-e2' });
    html = await drawWorkbench();
    assert.deepEqual(panesInOrder(html), ['editor:pane-e2'], 'the zoom hides panes of both kinds');
    assert.deepEqual(activeLinesIn(html), [], 'a zoomed pane, alone on screen, draws no active line');
    assert.match(paneMarkup(html, 'pane-e2'), /data-zoomed-chip=""/, "the zoomed file pane's strip says Zoomed");

    arrange({ tree: terminalLeaf('pane-t1', ['t1']), activePaneId: 'pane-t1' });
    html = await drawWorkbench();
    assert.deepEqual(activeLinesIn(html), [], 'a lone pane draws no active line');
  });

  test("WN-05: the group's only terminal pane, empty beside files, has no Close; with a terminal or a second terminal pane it has", async () => {
    const ui = await loadWorkbench();
    const kept = { type: 'split', id: 's', direction: 'vertical', sizes: [60, 40], children: [editorLeaf('pane-e1', ['e1']), terminalLeaf('pane-t1', [])] };
    arrange({ tree: kept, activePaneId: 'pane-t1', editorPaneId: 'pane-e1' }, { terminals: [] });
    let html = await drawWorkbench();
    const pane = paneMarkup(html, 'pane-t1');
    assert.match(pane, /No terminal in this pane/, 'the kept pane says so');
    assert.match(pane, /New Terminal/, 'and offers New Terminal');
    assert.equal(/title="Close Pane/.test(pane), false, 'a Close Pane that would do nothing');
    assert.match(paneMarkup(html, 'pane-e1'), /title="Close Group"/, 'the editor pane beside it can still be closed');
    assert.equal(ui.keptTerminalPaneOf(kept), 'pane-t1');

    const filled = { ...kept, children: [editorLeaf('pane-e1', ['e1']), terminalLeaf('pane-t1', ['t1'])] };
    arrange({ tree: filled, activePaneId: 'pane-t1', editorPaneId: 'pane-e1' });
    html = await drawWorkbench();
    assert.match(paneMarkup(html, 'pane-t1'), /title="Close Pane/, 'a terminal pane with a terminal has its Close');
    assert.equal(ui.keptTerminalPaneOf(filled), null);

    const two = {
      type: 'split', id: 's', direction: 'vertical', sizes: [50, 25, 25],
      children: [editorLeaf('pane-e1', ['e1']), terminalLeaf('pane-t1', []), terminalLeaf('pane-t2', ['t2'])],
    };
    arrange({ tree: two, activePaneId: 'pane-t2', editorPaneId: 'pane-e1' }, { terminals: ['t2'] });
    html = await drawWorkbench();
    assert.match(paneMarkup(html, 'pane-t1'), /title="Close Pane/, 'an empty terminal pane beside another terminal pane has its Close');
    assert.equal(ui.keptTerminalPaneOf(two), null);
    assert.equal(ui.keptTerminalPaneOf(terminalLeaf('pane-t9', [])), null, 'a group with no file keeps no pane');
  });
});
