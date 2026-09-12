/**
 * Terminal tab layout: each pane is a group holding its own tabs, and a tab can
 * be dragged into another group or onto a group's edge to split it.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';

const S = useTerminalStore;
const tree = () => S.getState().splitTree;

function leaves(node = tree(), acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') acc.push(node);
  else node.children.forEach((c) => leaves(c, acc));
  return acc;
}
const leafOf = (tabId) => leaves().find((l) => l.tabIds.includes(tabId));

describe('Terminal layout: tab groups and drag-drop placement', () => {
  beforeEach(async () => {
    // Fresh tree + tabs for every case.
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    S.setState({
      splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },
      activePaneId: 'pane-root',
    });
    await S.getState().init();
  });

  test('TL-01: a new tab joins the active group and becomes its visible tab', async () => {
    const first = leaves()[0];
    const startCount = first.tabIds.length;
    const tab = await S.getState().createTab();
    const leaf = leafOf(tab.id);
    assert.equal(leaves().length, 1, 'creating a tab must not split');
    assert.equal(leaf.id, 'pane-root');
    assert.equal(leaf.tabIds.length, startCount + 1);
    assert.equal(leaf.activeTabId, tab.id);
  });

  test('TL-02: dropping a tab on a pane edge splits that pane', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');

    assert.equal(tree().type, 'split');
    assert.equal(tree().direction, 'horizontal');
    assert.equal(leaves().length, 2);
    // Dropped on the right → the new group is the second child.
    assert.deepEqual(tree().children[0].tabIds, [a]);
    assert.deepEqual(tree().children[1].tabIds, [b]);
    assert.equal(S.getState().activePaneId, tree().children[1].id);
  });

  test('TL-03: "left"/"top" place the dragged tab before the target', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'top');

    assert.equal(tree().direction, 'vertical');
    assert.deepEqual(tree().children[0].tabIds, [b], 'dragged tab goes first');
    assert.deepEqual(tree().children[1].tabIds, [a]);
  });

  test('TL-04: dropping on a pane centre moves the tab into that group', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    const rightPane = leafOf(b).id;

    // Drag `a` into the right-hand group.
    S.getState().dropTabOnPane(a, rightPane, 'center');
    assert.equal(leaves().length, 1, 'source group is pruned once empty');
    assert.deepEqual(leaves()[0].tabIds, [b, a]);
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('TL-05: splitting a group off its only tab is a no-op', async () => {
    const a = leaves()[0].tabIds[0];
    const before = JSON.stringify(tree());
    S.getState().dropTabOnPane(a, 'pane-root', 'right');
    assert.equal(JSON.stringify(tree()), before, 'tree must be unchanged');
    assert.equal(leaves().length, 1);
  });

  test('TL-06: dropping a tab back on its own group just focuses it', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    assert.equal(leaves()[0].activeTabId, b);
    S.getState().dropTabOnPane(a, 'pane-root', 'center');
    assert.equal(leaves().length, 1);
    assert.deepEqual(leaves()[0].tabIds, [a, b], 'order is preserved');
    assert.equal(leaves()[0].activeTabId, a);
  });

  test('TL-07: closing the last tab of a group collapses that group', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    assert.equal(leaves().length, 2);

    await S.getState().closeTab(b);
    assert.equal(leaves().length, 1, 'emptied group is removed');
    assert.deepEqual(leaves()[0].tabIds, [a]);
    assert.ok(leaves().some((l) => l.id === S.getState().activePaneId), 'active pane still exists');
  });

  test('TL-08: closing a group kills only the tabs no other group shows', async () => {
    const a = leaves()[0].tabIds[0];
    const b = (await S.getState().createTab()).id;
    S.getState().dropTabOnPane(b, 'pane-root', 'right');
    const rightPane = leafOf(b).id;

    await S.getState().closePane(rightPane);
    assert.equal(leaves().length, 1);
    assert.ok(!S.getState().tabs.some((t) => t.id === b), 'its tab is gone');
    assert.ok(S.getState().tabs.some((t) => t.id === a), 'the other tab survives');
  });

  test('TL-09: a tab dropped on an unknown pane is ignored', async () => {
    const a = leaves()[0].tabIds[0];
    const before = JSON.stringify(tree());
    S.getState().dropTabOnPane(a, 'pane-does-not-exist', 'center');
    assert.equal(JSON.stringify(tree()), before);
  });

  test('TL-10: every tab lives in exactly one group after a shuffle', async () => {
    const ids = [leaves()[0].tabIds[0]];
    for (let i = 0; i < 3; i++) ids.push((await S.getState().createTab()).id);

    S.getState().dropTabOnPane(ids[1], 'pane-root', 'right');
    S.getState().dropTabOnPane(ids[2], leafOf(ids[1]).id, 'bottom');
    S.getState().dropTabOnPane(ids[3], leafOf(ids[0]).id, 'center');
    S.getState().dropTabOnPane(ids[0], leafOf(ids[2]).id, 'center');

    const placements = ids.map((id) => leaves().filter((l) => l.tabIds.includes(id)).length);
    assert.deepEqual(placements, [1, 1, 1, 1], 'no tab is duplicated or lost');
    assert.ok(leaves().every((l) => l.tabIds.length > 0), 'no empty group survives');
    assert.ok(
      leaves().every((l) => l.tabIds.includes(l.activeTabId)),
      'each group shows one of its own tabs'
    );
  });
});
