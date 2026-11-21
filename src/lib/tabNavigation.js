/**
 * Which tab the tab commands switch to (Bundle 2, A5-1 and A5-2): Next and
 * Previous Tab, Go to Tab 1-8 and Go to Last Tab, all within THE active pane
 * of the group on screen.
 *
 * Pure: a pane tree in, a tab id out. Switching (terminalStore's
 * `switchTab`) and handing the keyboard over (`focusActivePane`) are
 * workbenchCommands.js's, which is also where "the active pane" is read
 * (`activePaneOf`, `activeKindOf`), as Focus Next Pane reads it.
 */
import { EDITOR_KIND, leafKind } from '../components/terminal/splitLayout.js';

function leafIn(node, id) {
  if (!node || id == null) return null;
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children ?? []) {
    const found = leafIn(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * The tabs of terminal pane `paneId` in `tree`, in the order its tab strip
 * draws them, and the one it shows: `{ tabIds, activeTabId }`. Null when
 * the pane is not there, is an editor pane — the tab commands are a
 * terminal pane's — or holds no tab.
 */
export function paneTabs(tree, paneId) {
  const leaf = leafIn(tree, paneId);
  if (!leaf || leafKind(leaf) === EDITOR_KIND) return null;
  const tabIds = (Array.isArray(leaf.tabIds) ? leaf.tabIds : []).filter((id) => id != null);
  if (tabIds.length === 0) return null;
  const activeTabId = tabIds.includes(leaf.activeTabId) ? leaf.activeTabId : tabIds[0];
  return { tabIds, activeTabId };
}

/**
 * The tab `move` lands on in `pane` (from `paneTabs`), or null for none:
 *
 *   'next' / 'previous'  the neighbour, wrapping at both ends
 *   1..n                 the Nth tab; null past the last one
 *   'last'               the last tab
 *
 * Null as well when the tab it names is the one already shown, so a caller
 * can tell "nothing to do" from a switch.
 */
export function tabTarget(pane, move) {
  const tabIds = pane?.tabIds;
  if (!Array.isArray(tabIds) || tabIds.length === 0) return null;
  const at = Math.max(0, tabIds.indexOf(pane.activeTabId));
  let target = null;
  if (move === 'next' || move === 'previous') {
    const delta = move === 'next' ? 1 : -1;
    target = tabIds[(at + delta + tabIds.length) % tabIds.length];
  } else if (move === 'last') {
    target = tabIds[tabIds.length - 1];
  } else if (Number.isInteger(move) && move >= 1) {
    target = tabIds[move - 1] ?? null;
  }
  return target != null && target !== tabIds[at] ? target : null;
}
