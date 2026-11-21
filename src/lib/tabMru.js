/**
 * The terminals most recently used, most recent first (Bundle 2, A5-3): what
 * the Ctrl+Tab switcher lists (tabSwitcherStore.js, TabSwitcher.jsx).
 *
 * Pure. The list is kept by tab id and lives in memory only: nothing here is
 * saved, and a restart starts it again from the terminal on screen. It
 * follows the terminal store's `activeTabId` — a click in a pane, a tab
 * chip, Next Tab, a group switch all end there — and drops a closed tab.
 *
 * Only terminal tabs placed in a group are switched to: an editor leaf's
 * files and a spawned-but-unplaced tab (`spawnTab`) are never listed
 * (`switcherOrder`).
 */
import { TERMINAL_KIND, tabIdsOfKind } from '../components/terminal/splitLayout.js';

/** A most-recent-first list of ids: `touch` puts one first, `prune` keeps the live ones. */
export function createTabMru() {
  let ids = [];
  return {
    /** `id` is the one used now. Null and undefined are no tab. */
    touch(id) {
      if (id == null) return;
      ids = [id, ...ids.filter((x) => x !== id)];
    },
    /** Keep only the ids in `liveIds` (the tabs that still exist). */
    prune(liveIds) {
      const live = new Set(liveIds ?? []);
      ids = ids.filter((id) => live.has(id));
    },
    /** A copy, most recent first. */
    order() {
      return [...ids];
    },
    clear() {
      ids = [];
    },
  };
}

/**
 * Every terminal tab placed in a group, in switcher order — group by group,
 * and in each group its terminal panes' strips as drawn — with the group it
 * is in. Editor leaves hold files, not terminals, and are skipped.
 */
export function placedTerminalTabs(groups) {
  const placed = [];
  const seen = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const tabId of tabIdsOfKind(group?.tree, TERMINAL_KIND)) {
      if (tabId == null || seen.has(tabId)) continue;
      seen.add(tabId);
      placed.push({ tabId, groupId: group.id, groupName: group.name ?? '' });
    }
  }
  return placed;
}

/**
 * The ids the switcher lists: the placed terminal tabs, those in `mruIds`
 * first in that order, then any never yet used (a restored workspace's) in
 * switcher order. An id in `mruIds` that is no placed terminal tab is left
 * out.
 */
export function switcherOrder(mruIds, groups) {
  const placed = placedTerminalTabs(groups).map((p) => p.tabId);
  const isPlaced = new Set(placed);
  const recent = [];
  const listed = new Set();
  for (const id of Array.isArray(mruIds) ? mruIds : []) {
    if (!isPlaced.has(id) || listed.has(id)) continue;
    listed.add(id);
    recent.push(id);
  }
  return [...recent, ...placed.filter((id) => !listed.has(id))];
}

/** The last segment of a folder, either separator: `/a/b/` and `C:\a\b` give `b`. */
export function folderName(cwd) {
  if (typeof cwd !== 'string') return '';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (trimmed === '') return cwd.startsWith('/') ? '/' : '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
