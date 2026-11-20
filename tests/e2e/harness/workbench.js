/**
 * The editor's layout as tests arrange and read it, now that it lives on the
 * workbench (editor placement, sibling B).
 *
 * Until v0.32.0 editorStore held its own tree (`editorSplitTree`) and active
 * pane (`activeEditorPaneId`). Files are now placed in the terminal groups'
 * trees, in leaves of kind 'editor', and a group's `editorPaneId` is its
 * active editor pane. The suites written against the old fields use these
 * instead, so their edits stay mechanical:
 *
 *   S.setState({ editorSplitTree: X, activeEditorPaneId: Y })  ->  setEditorLayout(X, Y)
 *   S.getState().editorSplitTree                               ->  editorTree()
 *   S.getState().activeEditorPaneId                            ->  editorPane()
 *
 * `setEditorLayout` puts the tree, leaf ids kept, above an empty terminal
 * pane of one group — where a file opened into a group with no editor leaf
 * goes (FB4) — and `editorTree` hands back the editor projection of the group
 * on screen in the old shape (no `kind` on its leaves), or null when that
 * group has no editor leaf: the editor area is hidden then.
 */
import { useTerminalStore, __settleLayout } from '../../../src/stores/terminalStore.js';
import { registerEditorBridge } from '../../../src/stores/editorStore.js';
import { EDITOR_KIND, projectTree } from '../../../src/components/terminal/splitLayout.js';

/** The old empty editor: one leaf with no file, the pane a first file opened into. */
export const EMPTY_EDITOR_ROOT = Object.freeze({ type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null });

const TERMINAL_PANE = 'pane-wb-terminal';

const kinded = (node) =>
  node.type === 'leaf'
    ? { ...node, kind: EDITOR_KIND, tabIds: [...(node.tabIds || [])] }
    : { ...node, id: node.id || `split-wb-${Math.random().toString(36).slice(2, 8)}`, children: node.children.map(kinded) };

/**
 * One group whose tree is the editor tree `tree` (old shape) above an empty
 * terminal pane, with `activePane` its editor pane. `tree` null: no editor
 * leaf at all, as a fresh start has. The editor bridge is registered again,
 * in case a suite left a fake one.
 *
 * `settle: false` puts the group in exactly as built, unrepaired, as
 * `setState({ editorSplitTree })` did: the editor models harness puts one
 * file in two leaves by hand, a state no action makes, to see two editors
 * share its model. The next action on the workbench settles it.
 */
export function setEditorLayout(tree = EMPTY_EDITOR_ROOT, activePane = undefined, { settle = true } = {}) {
  registerEditorBridge();
  const terminal = { type: 'leaf', id: TERMINAL_PANE, tabIds: [], activeTabId: null };
  const group = {
    id: 'group-wb',
    name: 'Group 1',
    createdAt: 1,
    tree: tree
      ? { type: 'split', id: 'split-wb-root', direction: 'vertical', children: [kinded(tree), terminal], sizes: [60, 40] }
      : terminal,
    activePaneId: TERMINAL_PANE,
  };
  if (tree) group.editorPaneId = activePane ?? firstLeaf(tree).id;
  useTerminalStore.setState({ groups: [group], activeGroupId: group.id, activeTabId: null });
  if (settle) useTerminalStore.setState(__settleLayout(useTerminalStore.getState()));
}

function firstLeaf(node) {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0]);
}

const plain = (node) => {
  if (!node) return null;
  if (node.type === 'leaf') {
    const { kind: _kind, ...rest } = node;
    return rest;
  }
  return { ...node, children: node.children.map(plain) };
};

/** The editor tree of the group on screen, in the old shape, or null. */
export function editorTree() {
  const state = useTerminalStore.getState();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  return plain(projectTree(group?.tree, EDITOR_KIND));
}

/** The editor pane of the group on screen, or null. */
export function editorPane() {
  const state = useTerminalStore.getState();
  return state.groups.find((g) => g.id === state.activeGroupId)?.editorPaneId ?? null;
}

/**
 * Rewrite the tab ids of the editor pane of the group on screen through `fn`
 * — what a suite did with `{ ...editorSplitTree, tabIds: fn(tabIds) }` when
 * the editor was one leaf. Its shown tab stays when it is still there.
 */
export function setEditorPaneTabIds(fn) {
  const state = useTerminalStore.getState();
  const group = state.groups.find((g) => g.id === state.activeGroupId);
  const paneId = group?.editorPaneId;
  if (!paneId) return;
  const rewrite = (node) => {
    if (node.type !== 'leaf') return { ...node, children: node.children.map(rewrite) };
    if (node.id !== paneId) return node;
    const tabIds = fn([...node.tabIds]);
    return { ...node, tabIds, activeTabId: tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0] ?? null };
  };
  const groups = state.groups.map((g) => (g.id === group.id ? { ...g, tree: rewrite(g.tree) } : g));
  useTerminalStore.setState(__settleLayout(state, { groups }));
}
