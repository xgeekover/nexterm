/**
 * Editor tab layout: each pane is a group holding its own file tabs, and a
 * tab can be dragged into another group or onto a group's edge to split it.
 * Mirrors tests/adversarial/terminal_layout.test.js — same tree shape and
 * helpers (mapTree/leafHoldingTab/removeTabFromTree/pruneTree/addTabToPane),
 * adapted from terminal sessions to opened files.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { invoke } from '../../src/lib/ipc.js';

const S = useEditorStore;
const tree = () => S.getState().editorSplitTree;

function leaves(node = tree(), acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
}
const leafOf = (tabId) => leaves().find((l) => l.tabIds.includes(tabId));

let scratchCounter = 0;
let files;

// Fresh scratch files per test so this suite never depends on (or disturbs)
// the shared /workspace fixture other suites read from.
async function makeScratchFiles(n) {
  scratchCounter += 1;
  const dir = `/workspace/_editor_layout_scratch_${Date.now()}_${scratchCounter}`;
  await invoke('fs_create_dir', { path: dir });
  const paths = [];
  for (let i = 0; i < n; i++) {
    const p = `${dir}/file-${i}.js`;
    await invoke('fs_create_file', { path: p });
    await invoke('fs_write_file', { path: p, content: `// file ${i}\n` });
    paths.push(p);
  }
  return paths;
}

describe('Editor layout: tab groups and drag-drop placement', () => {
  beforeEach(async () => {
    // Fresh tree + tabs for every case.
    S.setState({
      tabs: [],
      activeTabId: null,
      editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },
      activeEditorPaneId: 'editor-pane-root',
    });
    files = await makeScratchFiles(5);
  });

  test('EL-01: opening a file joins the active group and becomes its visible tab', async () => {
    const tab = await S.getState().openFile(files[0]);
    assert.equal(leaves().length, 1, 'opening a file must not split');
    const leaf = leafOf(tab.id);
    assert.equal(leaf.id, 'editor-pane-root');
    assert.deepEqual(leaf.tabIds, [tab.id]);
    assert.equal(leaf.activeTabId, tab.id);
    assert.equal(S.getState().activeTabId, tab.id);
  });

  test('EL-02: dropping a tab on a pane edge splits that pane', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'right');

    assert.equal(tree().type, 'split');
    assert.equal(tree().direction, 'horizontal');
    assert.equal(leaves().length, 2);
    // Dropped on the right → the new group is the second child.
    assert.deepEqual(tree().children[0].tabIds, [a]);
    assert.deepEqual(tree().children[1].tabIds, [b]);
    assert.equal(S.getState().activeEditorPaneId, tree().children[1].id);
  });

  test('EL-03: "left"/"top" place the dragged tab before the target', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'top');

    assert.equal(tree().direction, 'vertical');
    assert.deepEqual(tree().children[0].tabIds, [b], 'dragged tab goes first');
    assert.deepEqual(tree().children[1].tabIds, [a]);
  });

  test('EL-04: dropping on a pane centre moves the tab into that group', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'right');
    const rightPane = leafOf(b).id;

    // Drag `a` into the right-hand group.
    S.getState().dropEditorTabOnPane(a, rightPane, 'center');
    assert.equal(leaves().length, 1, 'source group is pruned once empty');
    assert.deepEqual(leaves()[0].tabIds, [b, a]);
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('EL-05: splitting a group off its only tab is a no-op', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const before = JSON.stringify(tree());
    S.getState().dropEditorTabOnPane(a, 'editor-pane-root', 'right');
    assert.equal(JSON.stringify(tree()), before, 'tree must be unchanged');
    assert.equal(leaves().length, 1);
  });

  test('EL-06: dropping a tab back on its own group just focuses it', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    assert.equal(leaves()[0].activeTabId, b);
    S.getState().dropEditorTabOnPane(a, 'editor-pane-root', 'center');
    assert.equal(leaves().length, 1);
    assert.deepEqual(leaves()[0].tabIds, [a, b], 'order is preserved');
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('EL-07: closing the last tab of a group collapses that group', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'right');
    assert.equal(leaves().length, 2);

    S.getState().closeTab(b);
    assert.equal(leaves().length, 1, 'emptied group is removed');
    assert.deepEqual(leaves()[0].tabIds, [a]);
    assert.ok(leaves().some((l) => l.id === S.getState().activeEditorPaneId), 'active pane still exists');
  });

  test('EL-08: closing a pane removes only the tabs no other group shows', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'right');
    const rightPane = leafOf(b).id;

    S.getState().closeEditorPane(rightPane);
    assert.equal(leaves().length, 1);
    assert.ok(!S.getState().tabs.some((t) => t.id === b), 'its tab is gone');
    assert.ok(S.getState().tabs.some((t) => t.id === a), 'the other tab survives');
  });

  test('EL-09: a tab dropped on an unknown pane is ignored', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const before = JSON.stringify(tree());
    S.getState().dropEditorTabOnPane(a, 'pane-does-not-exist', 'center');
    assert.equal(JSON.stringify(tree()), before);
  });

  test('EL-10: reopening an already-open file reveals it without moving or duplicating it', async () => {
    const a = (await S.getState().openFile(files[0])).id;
    const b = (await S.getState().openFile(files[1])).id;
    S.getState().dropEditorTabOnPane(b, 'editor-pane-root', 'right');
    const leftPane = leafOf(a).id;
    const rightPane = leafOf(b).id;

    // Focus the right pane, then reopen the file that lives in the left pane.
    S.getState().setActiveEditorPane(rightPane);
    const reopened = await S.getState().openFile(files[0]);
    assert.equal(reopened.id, a, 'must return the existing tab, not a new one');
    assert.equal(leaves().length, 2, 'must not move the tab into a new group');
    assert.equal(leafOf(a).id, leftPane, 'tab stays in the group that already showed it');
    assert.equal(S.getState().activeEditorPaneId, leftPane, 'focus follows the revealed tab');
  });

  test('EL-11: every tab lives in exactly one group after a shuffle', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await S.getState().openFile(files[i])).id);

    S.getState().dropEditorTabOnPane(ids[1], 'editor-pane-root', 'right');
    S.getState().dropEditorTabOnPane(ids[2], leafOf(ids[1]).id, 'bottom');
    S.getState().dropEditorTabOnPane(ids[3], leafOf(ids[0]).id, 'center');
    S.getState().dropEditorTabOnPane(ids[0], leafOf(ids[2]).id, 'center');

    const placements = ids.map((id) => leaves().filter((l) => l.tabIds.includes(id)).length);
    assert.deepEqual(placements, [1, 1, 1, 1], 'no tab is duplicated or lost');
    assert.ok(leaves().every((l) => l.tabIds.length > 0), 'no empty group survives');
    assert.ok(
      leaves().every((l) => l.tabIds.includes(l.activeTabId)),
      'each group shows one of its own tabs'
    );
  });
});
