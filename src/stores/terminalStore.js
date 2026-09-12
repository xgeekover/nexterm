import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { loadState, saveState } from '../lib/persistence.js';

let paneCounter = 1;
const makePaneId = () => `pane-${paneCounter++}`;

/** Walks a split-tree node and returns the id of its first leaf (DOM order). */
function firstLeafId(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id;
  return firstLeafId(node.children[0]);
}

/** Collects every leaf node of a split-tree, in DOM order. */
function collectLeaves(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  for (const child of node.children) collectLeaves(child, acc);
  return acc;
}

/**
 * Rebuild a tree, letting `fn` replace any node. A leaf that `fn` turns into a
 * split is returned as-is (we must not recurse into the replacement, which
 * still contains the original leaf).
 */
function mapTree(node, fn) {
  if (!node) return null;
  if (node.type === 'leaf') return fn(node);
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  return { ...node, children: node.children.map((child) => mapTree(child, fn)) };
}

/** The leaf that currently hosts `tabId`, or null. */
function leafHoldingTab(node, tabId) {
  return collectLeaves(node).find((leaf) => leaf.tabIds.includes(tabId)) || null;
}

/** Remove a tab from whichever leaf holds it, keeping that leaf's active tab valid. */
function removeTabFromTree(node, tabId) {
  return mapTree(node, (n) => {
    if (n.type !== 'leaf' || !n.tabIds.includes(tabId)) return n;
    const tabIds = n.tabIds.filter((id) => id !== tabId);
    return {
      ...n,
      tabIds,
      activeTabId: n.activeTabId === tabId ? tabIds[0] ?? null : n.activeTabId,
    };
  });
}

/**
 * Drop leaves that hold no tabs and collapse splits left with a single child.
 * Returns null when the whole tree is empty.
 */
function pruneTree(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node.tabIds.length > 0 ? node : null;
  const children = node.children.map(pruneTree).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** Append a tab to a pane (falling back to the first leaf) and make it active there. */
function addTabToPane(node, paneId, tabId) {
  let placed = false;
  const next = mapTree(node, (n) => {
    if (n.type !== 'leaf' || n.id !== paneId) return n;
    placed = true;
    return { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId };
  });
  if (placed) return next;
  const first = collectLeaves(node)[0];
  if (!first) return { type: 'leaf', id: paneId || makePaneId(), tabIds: [tabId], activeTabId: tabId };
  return mapTree(node, (n) =>
    n.type === 'leaf' && n.id === first.id
      ? { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId }
      : n
  );
}

/** An empty root, used when the last terminal goes away. */
const emptyTree = () => ({ type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null });

// --- Persistence (Task: remember the layout across relaunches) -----------
//
// We persist only what can be meaningfully restored: the split tree's shape
// (pane ids, optional names, tab order, each pane's active tab) and each
// tab's `title`/`cwd`. PTY sessions and scrollback are process state and
// cannot survive a relaunch — `init()` spawns a *fresh* PTY per saved tab.
export const PERSIST_KEY = 'nexterm.terminal.workspace';
/** Named group snapshots the user saves explicitly (separate from the live layout). */
export const SAVED_GROUPS_KEY = 'nexterm.terminal.savedGroups';

/** Read the saved-group list, tolerating a corrupt or stale payload. */
function loadSavedGroups() {
  const list = loadState(SAVED_GROUPS_KEY, []);
  return Array.isArray(list) ? list.filter((g) => g && typeof g.id === 'string' && Array.isArray(g.tabs)) : [];
}

const PERSIST_DEBOUNCE_MS = 300;

let persistTimer = null;

/** Strip a split-tree node down to the fields worth persisting. */
function serializeTreeForPersist(node) {
  if (!node) return null;
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      ...(node.name ? { name: node.name } : {}),
      tabIds: [...node.tabIds],
      activeTabId: node.activeTabId,
    };
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeTreeForPersist),
  };
}

function buildPersistedPayload(state) {
  return {
    splitTree: serializeTreeForPersist(state.splitTree),
    tabs: state.tabs.map((t) => ({ id: t.id, title: t.title, cwd: t.cwd })),
    activePaneId: state.activePaneId,
    groupViewMode: state.groupViewMode,
    focusedPaneId: state.focusedPaneId,
  };
}

/** Debounced write-behind so a burst of state changes only saves once. */
function schedulePersist(state) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    saveState(PERSIST_KEY, buildPersistedPayload(state));
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Rebuild a saved split-tree, dropping any reference to a tab that failed to
 * restore and defaulting malformed/missing ids. `pruneTree` (below) then
 * removes any leaf that ends up empty and collapses single-child splits.
 */
function sanitizeRestoredTree(node, validTabIds) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'leaf') {
    const tabIds = Array.isArray(node.tabIds) ? node.tabIds.filter((id) => validTabIds.has(id)) : [];
    const activeTabId = tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0] ?? null;
    return {
      type: 'leaf',
      id: typeof node.id === 'string' && node.id ? node.id : makePaneId(),
      ...(typeof node.name === 'string' && node.name ? { name: node.name } : {}),
      tabIds,
      activeTabId,
    };
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    return {
      type: 'split',
      id: typeof node.id === 'string' && node.id ? node.id : `split-${Date.now()}`,
      direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
      children: node.children.map((c) => sanitizeRestoredTree(c, validTabIds)).filter(Boolean),
    };
  }
  return null;
}

/** Bump the pane id counter past anything found in a restored tree so freshly split panes never collide with restored ones. */
function bumpPaneCounterPastRestoredIds(node) {
  for (const leaf of collectLeaves(node)) {
    const match = /^pane-(\d+)$/.exec(leaf.id);
    if (match) {
      const n = Number(match[1]);
      if (n >= paneCounter) paneCounter = n + 1;
    }
  }
}

let unlisteners = [];
let listening = false;

/**
 * Drop the persistent xterm instance a closed tab owned (see
 * `components/terminal/terminalRegistry.js`). Guarded by `document` so this
 * store — imported directly by Node-run tests — never eagerly pulls in
 * `@xterm/addon-fit`, which throws (`self is not defined`) when evaluated
 * outside a browser-like environment.
 */
async function disposeTerminalView(tabId) {
  if (typeof document === 'undefined') return;
  try {
    const { disposeTerminal } = await import('../components/terminal/TerminalView.jsx');
    disposeTerminal(tabId);
  } catch (_) {
    // Terminal view module unavailable — nothing to dispose.
  }
}

export const useTerminalStore = create((set, get) => {
  /**
   * Spawn a PTY-backed tab and register it in `tabs`, WITHOUT placing it
   * anywhere in the split tree — callers decide where it goes. Keeping tree
   * placement out of tab creation is what lets `splitPane` put the new tab
   * only in the freshly-created pane, instead of it also lingering in
   * whichever pane happened to be active when the PTY finished spawning.
   */
  const spawnTab = async (title = null, cwd = null) => {
    try {
      const ptySession = await invoke('pty_spawn', {
        cols: 80,
        rows: 24,
        cwd: cwd || get().cwd || '/workspace',
      });

      const nextIndex = get().tabs.length + 1;
      const defaultTitle = `Terminal ${nextIndex}`;
      const newTab = {
        id: `tab-term-${Date.now()}-${nextIndex}`,
        title: title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || get().cwd,
        blocks: [],
        activePrompt: '',
      };

      set((state) => ({ tabs: [...state.tabs, newTab] }));
      return newTab;
    } catch (err) {
      console.error('[TerminalStore] Failed to create terminal tab:', err);
      return null;
    }
  };

  /**
   * Spawn one fresh PTY per saved tab (processes cannot be restored) and
   * rebuild the saved split tree around the new tab ids. Throws if nothing
   * usable could be restored — the caller falls back to the single-terminal
   * default in that case.
   */
  const restoreSavedLayout = async (saved, rootPath) => {
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0 || !saved.splitTree) {
      throw new Error('No saved terminal layout to restore');
    }

    const newTabs = [];
    for (const savedTab of saved.tabs) {
      if (!savedTab || !savedTab.id) continue;
      const wantedCwd = savedTab.cwd || rootPath;

      let ptySession;
      try {
        ptySession = await invoke('pty_spawn', { cols: 80, rows: 24, cwd: wantedCwd });
      } catch (_) {
        // The saved directory may no longer exist — retry at the workspace root.
        ptySession = await invoke('pty_spawn', { cols: 80, rows: 24, cwd: rootPath });
      }

      const defaultTitle = `Terminal ${newTabs.length + 1}`;
      newTabs.push({
        id: savedTab.id,
        title: savedTab.title || defaultTitle,
        defaultTitle,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || wantedCwd,
        blocks: [],
        activePrompt: '',
      });
    }

    if (newTabs.length === 0) throw new Error('No terminal tabs could be restored');

    const validIds = new Set(newTabs.map((t) => t.id));
    const tree = pruneTree(sanitizeRestoredTree(saved.splitTree, validIds));
    if (!tree) throw new Error('Saved layout had no valid panes once sanitized');

    bumpPaneCounterPastRestoredIds(tree);

    const leaves = collectLeaves(tree);
    const activePaneId = leaves.some((l) => l.id === saved.activePaneId)
      ? saved.activePaneId
      : firstLeafId(tree) || leaves[0]?.id;
    const activeLeaf = leaves.find((l) => l.id === activePaneId);
    const activeTabId = activeLeaf?.activeTabId || activeLeaf?.tabIds?.[0] || newTabs[0].id;
    const activeTab = newTabs.find((t) => t.id === activeTabId) || newTabs[0];

    // A saved focus target only means anything if that group still exists
    // and there is more than one group to switch between — otherwise fall
    // back to the normal split view rather than restoring into a focus mode
    // with nothing valid to focus.
    const wantsFocus = saved.groupViewMode === 'focus' && leaves.length > 1 &&
      leaves.some((l) => l.id === saved.focusedPaneId);

    return {
      tabs: newTabs,
      splitTree: tree,
      activePaneId: activePaneId || 'pane-root',
      activeTabId,
      cwd: activeTab.cwd || rootPath,
      groupViewMode: wantsFocus ? 'focus' : 'split',
      focusedPaneId: wantsFocus ? saved.focusedPaneId : null,
    };
  };

  return {
    tabs: [],
    activeTabId: null,
    history: [],
    historyIndex: -1,
    cwd: '/workspace',
    isInitialized: false,

    // Split tree: { type: 'leaf', id, name?, tabIds: [], activeTabId } | { type: 'split', id, direction, children }
    // Each leaf is a terminal group holding its own tabs, so a tab can be dragged
    // between groups or dropped on a group's edge to split it. `name` is an
    // optional user-assigned label for the group (see `renameGroup`).
    splitTree: { type: 'leaf', id: 'pane-root', tabIds: [], activeTabId: null },

    // The pane currently focused for keyboard shortcuts / block-selection / split-origin.
    activePaneId: 'pane-root',

    // Warp-style group view: 'split' shows every group side by side (the
    // split tree as-is); 'focus' shows only `focusedPaneId`'s group,
    // full-size, while the rest of the tree stays intact but unrendered.
    groupViewMode: 'split',
    focusedPaneId: null,

    // Named group snapshots the user saved explicitly. Unlike the live layout
    // (auto-persisted), these are kept until deleted and can be loaded any time.
    savedGroups: loadSavedGroups(),

    /**
     * Mark a pane as the active one (called on click/focus of a pane).
     */
    setActivePane: (paneId) => set({ activePaneId: paneId }),

    /**
     * Switch to focus view on a single group — everything else in the split
     * tree stays exactly as it is, just unmounted. Also focuses that pane so
     * keyboard shortcuts and split-origin follow the visible group.
     */
    focusGroup: (paneId) => set({ groupViewMode: 'focus', focusedPaneId: paneId, activePaneId: paneId }),

    /**
     * Return to the normal side-by-side split view.
     */
    showAllGroups: () => set({ groupViewMode: 'split' }),

    // ---- Tab management used by the Terminals panel's context menus ----
    /** Close every other terminal in the group that holds `tabId`. */
    closeOthersInGroup: async (tabId) => {
      const leaf = leafHoldingTab(get().splitTree, tabId);
      if (!leaf) return;
      for (const id of leaf.tabIds.filter((x) => x !== tabId)) {
        await get().closeTab(id);
      }
    },

    /** Close the terminals that sit after `tabId` in its group. */
    closeTabsToTheRight: async (tabId) => {
      const leaf = leafHoldingTab(get().splitTree, tabId);
      if (!leaf) return;
      const idx = leaf.tabIds.indexOf(tabId);
      if (idx === -1) return;
      for (const id of leaf.tabIds.slice(idx + 1)) {
        await get().closeTab(id);
      }
    },

    /** Split a terminal out of its group into a new one beside it. */
    moveTabToNewGroup: (tabId, direction = 'horizontal') => {
      const source = leafHoldingTab(get().splitTree, tabId);
      // A group's only tab is already "its own group".
      if (!source || source.tabIds.length <= 1) return null;
      get().dropTabOnPane(tabId, source.id, direction === 'vertical' ? 'bottom' : 'right');
      return get().activePaneId;
    },

    // ---- Saved groups -------------------------------------------------
    /** Snapshot a group's terminals (titles + their live cwd) under a name. */
    saveGroup: (paneId, name) => {
      const state = get();
      const leaf = collectLeaves(state.splitTree).find((l) => l.id === paneId);
      if (!leaf) return null;

      const entry = {
        id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: (name || '').trim() || leaf.name || 'Saved group',
        savedAt: Date.now(),
        tabs: leaf.tabIds
          .map((id) => state.tabs.find((t) => t.id === id))
          .filter(Boolean)
          .map((t) => ({ title: t.title, cwd: t.cwd })),
      };
      if (entry.tabs.length === 0) return null;

      const savedGroups = [...state.savedGroups, entry];
      set({ savedGroups });
      saveState(SAVED_GROUPS_KEY, savedGroups);
      return entry;
    },

    renameSavedGroup: (savedId, name) => {
      const next = get().savedGroups.map((g) =>
        g.id === savedId ? { ...g, name: (name || '').trim() || g.name } : g
      );
      set({ savedGroups: next });
      saveState(SAVED_GROUPS_KEY, next);
    },

    deleteSavedGroup: (savedId) => {
      const next = get().savedGroups.filter((g) => g.id !== savedId);
      set({ savedGroups: next });
      saveState(SAVED_GROUPS_KEY, next);
    },

    /**
     * Re-open a saved group. `mode: 'new-group'` (default) puts its terminals
     * in a brand-new group beside the active one; `'replace'` adds them to the
     * active group. Each terminal respawns at its saved cwd, falling back to
     * the workspace root when that directory is gone.
     */
    loadSavedGroup: async (savedId, { mode = 'new-group' } = {}) => {
      const entry = get().savedGroups.find((g) => g.id === savedId);
      if (!entry || entry.tabs.length === 0) return null;

      const spawned = [];
      for (const saved of entry.tabs) {
        const tab = await spawnTab(saved.title, saved.cwd);
        if (tab) spawned.push(tab);
      }
      if (spawned.length === 0) return null;

      if (mode === 'replace') {
        const target = get().activePaneId;
        set((state) => {
          let tree = state.splitTree;
          for (const t of spawned) tree = addTabToPane(tree, target, t.id);
          return { splitTree: tree, activeTabId: spawned[0].id };
        });
        return target;
      }

      const newPaneId = makePaneId();
      const newLeaf = {
        type: 'leaf',
        id: newPaneId,
        name: entry.name,
        tabIds: spawned.map((t) => t.id),
        activeTabId: spawned[0].id,
      };

      set((state) => {
        const target = state.activePaneId;
        const split = mapTree(state.splitTree, (n) =>
          n.type === 'leaf' && n.id === target
            ? {
                type: 'split',
                id: `split-${Date.now()}`,
                direction: 'horizontal',
                children: [n, newLeaf],
              }
            : n
        );
        return {
          splitTree: pruneTree(split) || newLeaf,
          activePaneId: newPaneId,
          activeTabId: spawned[0].id,
        };
      });
      return newPaneId;
    },


    /**
     * Split a leaf pane into two children (horizontal or vertical). The new
     * tab is spawned directly into the new pane, never into the pane being
     * split, so the same tab can never end up listed in two panes at once.
     * Returns the new pane's id (or null if the split could not be created).
     */
    splitPane: async (paneId, direction = 'horizontal') => {
      const newTab = await spawnTab();
      if (!newTab) return null;

      const newPaneId = makePaneId();

      const splitNode = (node) => {
        if (node.type === 'leaf' && node.id === paneId) {
          return {
            type: 'split',
            id: `split-${Date.now()}`,
            direction,
            children: [
              { ...node },
              { type: 'leaf', id: newPaneId, tabIds: [newTab.id], activeTabId: newTab.id },
            ],
          };
        }
        if (node.type === 'split') {
          return { ...node, children: node.children.map(splitNode) };
        }
        return node;
      };

      set((state) => ({ splitTree: splitNode(state.splitTree) }));
      return newPaneId;
    },

    /**
     * Split the currently active pane and focus the newly created one.
     */
    splitActivePane: async (direction = 'horizontal') => {
      const { activePaneId, splitPane, setActivePane } = get();
      const newPaneId = await splitPane(activePaneId, direction);
      if (newPaneId) setActivePane(newPaneId);
      return newPaneId;
    },

    /**
     * Close a pane. The sibling takes over the parent split.
     * Kills the pane's PTY and drops its tab UNLESS another remaining leaf
     * still references that same tabId.
     */
    closePane: async (paneId) => {
      const { splitTree } = get();

      const closingLeaf = collectLeaves(splitTree).find((leaf) => leaf.id === paneId);
      const closingTabIds = closingLeaf ? [...closingLeaf.tabIds] : [];

      let replacementLeafId = null;

      const removeNode = (node) => {
        if (node.type !== 'split') return node;

        const idx = node.children.findIndex(
          (child) => child.type === 'leaf' && child.id === paneId
        );

        if (idx !== -1) {
          const remaining = node.children.filter((_, i) => i !== idx);
          if (remaining.length === 1) {
            replacementLeafId = firstLeafId(remaining[0]);
            return remaining[0];
          }
          const neighbourIdx = Math.min(idx, remaining.length - 1);
          replacementLeafId = firstLeafId(remaining[neighbourIdx]);
          return { ...node, children: remaining };
        }

        return { ...node, children: node.children.map(removeNode) };
      };

      // Closing the only pane empties it rather than removing the root.
      const nextTree =
        splitTree.type === 'leaf' && splitTree.id === paneId ? emptyTree() : removeNode(splitTree);
      set({ splitTree: nextTree });

      if (get().activePaneId === paneId && replacementLeafId) {
        set({ activePaneId: replacementLeafId });
      }

      // Kill each tab this pane owned that no other pane still shows.
      for (const tabId of closingTabIds) {
        if (leafHoldingTab(get().splitTree, tabId)) continue;

        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab) continue;

        try {
          await invoke('pty_kill', { session_id: tab.sessionId });
        } catch (e) {
          console.warn('[TerminalStore] pty_kill failed:', e);
        }
        await disposeTerminalView(tabId);

        set((state) => {
          const nextTabs = state.tabs.filter((t) => t.id !== tabId);
          return {
            tabs: nextTabs,
            activeTabId: state.activeTabId === tabId ? nextTabs[0]?.id || null : state.activeTabId,
          };
        });
      }
    },

    /**
     * Close whichever pane is currently active.
     */
    closeActivePane: () => {
      const { activePaneId, closePane } = get();
      return closePane(activePaneId);
    },

    /**
     * Move pane focus by `delta` (±1) through the split-tree's leaves in DOM
     * order, wrapping around at the ends.
     */
    focusNextPane: (delta = 1) => {
      const { splitTree, activePaneId } = get();
      const leaves = collectLeaves(splitTree);
      if (leaves.length === 0) return;

      const ids = leaves.map((l) => l.id);
      const currentIdx = ids.indexOf(activePaneId);
      const fromIdx = currentIdx === -1 ? 0 : currentIdx;
      const nextIdx = (fromIdx + delta + ids.length) % ids.length;

      set({ activePaneId: ids[nextIdx] });
    },

    /**
     * Make `tabId` the visible tab of `paneId`. If the tab lives in another
     * group, move it here first (clicking a tab chip never splits).
     */
    bindPaneToTab: (paneId, tabId) => {
      set((state) => {
        const holder = leafHoldingTab(state.splitTree, tabId);
        let tree = state.splitTree;
        if (!holder || holder.id !== paneId) {
          tree = pruneTree(addTabToPane(removeTabFromTree(tree, tabId), paneId, tabId)) || emptyTree();
        } else {
          tree = mapTree(tree, (n) =>
            n.type === 'leaf' && n.id === paneId ? { ...n, activeTabId: tabId } : n
          );
        }
        return { splitTree: tree, activePaneId: paneId, activeTabId: tabId };
      });
    },

    /**
     * Drag & drop a terminal tab onto a pane.
     *
     * `zone` is where inside the target pane it was dropped:
     *   'center'                  → move the tab into that group
     *   'left' | 'right'          → split the group horizontally, tab on that side
     *   'top'  | 'bottom'         → split the group vertically, tab on that side
     */
    dropTabOnPane: (tabId, targetPaneId, zone = 'center') => {
      const state = get();
      const target = collectLeaves(state.splitTree).find((l) => l.id === targetPaneId);
      if (!target || !state.tabs.some((t) => t.id === tabId)) return;

      const source = leafHoldingTab(state.splitTree, tabId);

      // Dropping a tab back on its own group: just focus it. Splitting a group
      // off its only tab would leave the source empty and is a no-op too.
      if (source && source.id === targetPaneId) {
        if (zone === 'center' || source.tabIds.length === 1) {
          get().bindPaneToTab(targetPaneId, tabId);
          return;
        }
      }

      const withoutTab = removeTabFromTree(state.splitTree, tabId);

      if (zone === 'center') {
        const tree = pruneTree(addTabToPane(withoutTab, targetPaneId, tabId)) || emptyTree();
        set({ splitTree: tree, activePaneId: targetPaneId, activeTabId: tabId });
        return;
      }

      const newPaneId = makePaneId();
      const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [tabId], activeTabId: tabId };
      const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
      const insertFirst = zone === 'left' || zone === 'top';

      const split = mapTree(withoutTab, (n) =>
        n.type === 'leaf' && n.id === targetPaneId
          ? {
              type: 'split',
              id: `split-${Date.now()}`,
              direction,
              children: insertFirst ? [newLeaf, n] : [n, newLeaf],
            }
          : n
      );

      set({
        splitTree: pruneTree(split) || emptyTree(),
        activePaneId: newPaneId,
        activeTabId: tabId,
      });
    },

    /**
     * Rename a tab (double-click its chip, or "Rename" from its right-click
     * menu). An empty/whitespace-only name resets it to its auto-generated
     * default (`Terminal N`) rather than leaving a blank label.
     */
    renameTab: (tabId, title) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const trimmed = typeof title === 'string' ? title.trim() : '';
          return { ...t, title: trimmed || t.defaultTitle || t.title };
        }),
      }));
    },

    /**
     * Name (or rename) a group/pane — reachable from a right-click on the
     * pane strip's empty area. An empty name clears it back to unnamed.
     */
    renameGroup: (paneId, name) => {
      set((state) => ({
        splitTree: mapTree(state.splitTree, (n) => {
          if (n.type !== 'leaf' || n.id !== paneId) return n;
          const trimmed = typeof name === 'string' ? name.trim() : '';
          if (!trimmed) {
            const { name: _drop, ...rest } = n;
            return rest;
          }
          return { ...n, name: trimmed };
        }),
      }));
    },

    // Event listeners are attached once and can be torn down (HMR, unmount)
    // without losing the bootstrap state.
    attachListeners: async () => {
      if (listening) return;
      listening = true;
      unlisteners.push(await listen('pty-output', (payload) => {
        const { session_id, data } = payload || {};
        if (!session_id || !data) return;

        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            const blocks = [...tab.blocks];
            const runningIdx = blocks.findIndex((b) => b.status === 'running');
            if (runningIdx !== -1) {
              blocks[runningIdx] = {
                ...blocks[runningIdx],
                output: blocks[runningIdx].output + data,
              };
            }
            // No running block: this is prompt/banner noise — never append it
            // to a finished (possibly pinned) block.
            return { ...tab, blocks };
          }),
        }));
      }));
      unlisteners.push(await listen('pty-command-done', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;
        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            const idx = tab.blocks.findIndex((b) => b.status === 'running');
            if (idx === -1) return tab;
            const blocks = [...tab.blocks];
            const running = blocks[idx];
            const ok = exit_code === null || exit_code === undefined || exit_code === 0;
            blocks[idx] = {
              ...running,
              // zsh pads the last line to the terminal width before the prompt;
              // drop that trailing whitespace so blocks end cleanly.
              output: running.output.replace(/[ \t]+\r?$/, ''),
              status: ok ? 'completed' : 'failed',
              exitCode: exit_code ?? 0,
              durationMs: Date.now() - (running.startTime || Date.now()),
            };
            return { ...tab, blocks };
          }),
        }));
      }));
      unlisteners.push(await listen('pty-exit', (payload) => {
        const { session_id, exit_code } = payload || {};
        if (!session_id) return;

        set((state) => ({
          tabs: state.tabs.map((tab) => {
            if (tab.sessionId !== session_id) return tab;
            const blocks = [...tab.blocks];
            const runningIdx = blocks.findIndex((b) => b.status === 'running');
            if (runningIdx !== -1) {
              const blk = blocks[runningIdx];
              blocks[runningIdx] = {
                ...blk,
                status: exit_code === 0 ? 'completed' : 'failed',
                exitCode: exit_code,
                durationMs: Math.max(1, Date.now() - (blk.startTime || Date.now())),
              };
            }
            return { ...tab, blocks };
          }),
        }));
      }));
      // OSC 7 (see src-tauri/src/pty/osc.rs / shell_integration.rs): the
      // shell reports its live working directory on every prompt. Update
      // only the tab that owns this session — and the store's own `cwd`
      // (used as the default spawn dir for new tabs/panes) only when that
      // tab happens to be the active one — so restoring/duplicating always
      // uses where the user actually is, not just where the tab started.
      unlisteners.push(await listen('pty-cwd', (payload) => {
        const { session_id, cwd } = payload || {};
        if (!session_id || typeof cwd !== 'string' || !cwd) return;
        set((state) => {
          const tab = state.tabs.find((t) => t.sessionId === session_id);
          if (!tab || tab.cwd === cwd) return {};
          return {
            tabs: state.tabs.map((t) => (t.sessionId === session_id ? { ...t, cwd } : t)),
            cwd: tab.id === state.activeTabId ? cwd : state.cwd,
          };
        });
      }));
    },

    dispose: () => {
      for (const off of unlisteners) {
        try {
          if (typeof off === 'function') off();
        } catch (_) {
          // listener already gone
        }
      }
      unlisteners = [];
      listening = false;
      clearTimeout(persistTimer);
    },

    init: async () => {
      if (get().isInitialized) {
        await get().attachListeners();
        return;
      }

      try {
        let rootPath = '/workspace';
        try {
          rootPath = (await invoke('fs_get_root')) || rootPath;
        } catch (_) {
          // browser mock or backend unavailable — keep the virtual default
        }
        set({ cwd: rootPath });

        // Try to bring back last session's groups/tabs/names. Any failure
        // here (corrupt payload, every pty_spawn rejecting, ...) must fall
        // back to the plain single-terminal bootstrap below rather than
        // leaving the app with a half-built tree.
        const saved = loadState(PERSIST_KEY, null);
        let restored = null;
        if (saved) {
          try {
            restored = await restoreSavedLayout(saved, rootPath);
          } catch (err) {
            console.error(
              '[TerminalStore] Failed to restore saved terminal layout — falling back to a single terminal:',
              err
            );
            restored = null;
          }
        }

        if (restored) {
          set({
            tabs: restored.tabs,
            activeTabId: restored.activeTabId,
            cwd: restored.cwd,
            isInitialized: true,
            splitTree: restored.splitTree,
            activePaneId: restored.activePaneId,
            groupViewMode: restored.groupViewMode,
            focusedPaneId: restored.focusedPaneId,
          });
          await get().attachListeners();
          return;
        }

        const ptySession = await invoke('pty_spawn', {
          cols: 80,
          rows: 24,
          cwd: rootPath,
        });

        const defaultTitle = 'Terminal 1';
        const initialTab = {
          id: 'tab-term-1',
          title: defaultTitle,
          defaultTitle,
          sessionId: ptySession.session_id,
          cwd: ptySession.cwd || rootPath,
          blocks: [],
          activePrompt: '',
        };

        set({
          tabs: [initialTab],
          activeTabId: initialTab.id,
          cwd: initialTab.cwd,
          isInitialized: true,
          splitTree: { type: 'leaf', id: 'pane-root', tabIds: [initialTab.id], activeTabId: initialTab.id },
          activePaneId: 'pane-root',
          groupViewMode: 'split',
          focusedPaneId: null,
        });

        await get().attachListeners();
      } catch (err) {
        console.error('[TerminalStore] Failed to initialize terminal session:', err);
      }
    },

    createTab: async (titleOrOptions = null, options = {}) => {
      // Backward/forward-compatible signature: createTab(), createTab('Title'),
      // createTab({ title, paneId }), or createTab('Title', { paneId }). A
      // caller-supplied paneId targets that pane's group directly instead of
      // whichever pane happens to be active (see TerminalSplitContainer's
      // per-pane "+" button).
      let title = null;
      let paneId = null;
      if (titleOrOptions && typeof titleOrOptions === 'object') {
        title = titleOrOptions.title ?? null;
        paneId = titleOrOptions.paneId ?? null;
      } else {
        title = titleOrOptions;
        paneId = options?.paneId ?? null;
      }

      const newTab = await spawnTab(title);
      if (!newTab) return null;

      const targetPaneId = paneId || get().activePaneId;
      set((state) => ({
        activeTabId: newTab.id,
        activePaneId: targetPaneId,
        splitTree: addTabToPane(state.splitTree, targetPaneId, newTab.id),
      }));

      return newTab;
    },

    /**
     * "Copy Tab": open a new terminal in the SAME (live) working directory as
     * `tabId`, placed in that same tab's group, and make it the active tab
     * there. `tab.cwd` is kept current by the `pty-cwd` listener below (OSC
     * 7), so this lands wherever the user actually `cd`'d to — not just
     * where the original tab was first spawned.
     */
    duplicateTab: async (tabId) => {
      const source = get().tabs.find((t) => t.id === tabId);
      if (!source) return null;

      const holder = leafHoldingTab(get().splitTree, tabId);
      const targetPaneId = holder?.id || get().activePaneId;

      const newTab = await spawnTab(null, source.cwd);
      if (!newTab) return null;

      set((state) => ({
        activeTabId: newTab.id,
        activePaneId: targetPaneId,
        splitTree: addTabToPane(state.splitTree, targetPaneId, newTab.id),
      }));

      return newTab;
    },

    switchTab: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      set({ activeTabId: tabId, cwd: tab.cwd });
    },

    closeTab: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;

      try {
        await invoke('pty_kill', { session_id: tab.sessionId });
      } catch (e) {
        console.warn('[TerminalStore] pty_kill failed:', e);
      }
      await disposeTerminalView(tabId);

      set((state) => {
        const nextTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActiveId = state.activeTabId;
        if (state.activeTabId === tabId) {
          nextActiveId = nextTabs[0]?.id || null;
        }
        // Drop it from its group too, collapsing the group if it was the last tab.
        const splitTree = pruneTree(removeTabFromTree(state.splitTree, tabId)) || emptyTree();
        const paneStillThere = collectLeaves(splitTree).some((l) => l.id === state.activePaneId);
        return {
          tabs: nextTabs,
          activeTabId: nextActiveId,
          splitTree,
          activePaneId: paneStillThere ? state.activePaneId : firstLeafId(splitTree) || 'pane-root',
        };
      });
    },

    executeCommand: async (commandText, tabId = null) => {
      const trimmed = (commandText || '').trim();
      if (!trimmed) return null;

      const targetTabId = tabId || get().activeTabId;
      const tab = get().tabs.find((t) => t.id === targetTabId);
      if (!tab) return null;

      const blockId = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const block = {
        id: blockId,
        command: trimmed,
        cwd: tab.cwd || get().cwd,
        output: '',
        exitCode: null,
        durationMs: 0,
        startTime: Date.now(),
        status: 'running',
        pinned: false,
      };

      set((state) => {
        const nextTabs = state.tabs.map((t) => {
          if (t.id !== targetTabId) return t;
          return {
            ...t,
            blocks: [...t.blocks, block],
          };
        });
        const nextHistory = [...state.history, trimmed];
        return {
          tabs: nextTabs,
          history: nextHistory,
          historyIndex: nextHistory.length,
        };
      });

      try {
        await invoke('pty_write', {
          session_id: tab.sessionId,
          data: `${trimmed}\n`,
        });
      } catch (err) {
        console.error('[TerminalStore] Failed to write to PTY:', err);
        set((state) => ({
          tabs: state.tabs.map((t) => {
            if (t.id !== targetTabId) return t;
            return {
              ...t,
              blocks: t.blocks.map((b) =>
                b.id === blockId ? { ...b, status: 'failed', exitCode: 1, output: `Error: ${err.message}\n` } : b
              ),
            };
          }),
        }));
      }

      return block;
    },

    pinBlock: (blockId) => {
      let resultPinned = false;
      set((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          blocks: tab.blocks.map((b) => {
            if (b.id === blockId) {
              resultPinned = !b.pinned;
              return { ...b, pinned: resultPinned };
            }
            return b;
          }),
        })),
      }));
      return resultPinned;
    },

    clearBlocks: (tabId = null) => {
      const targetTabId = tabId || get().activeTabId;
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== targetTabId) return tab;
          return {
            ...tab,
            blocks: tab.blocks.filter((b) => b.pinned),
          };
        }),
      }));
    },

    // Replace a block's recorded output outright. No other field changes.
    // (Bookkeeping only — the live terminal surface renders straight from PTY
    // output and never reads `blocks`; this exists for callers that want to
    // overwrite a block's history entry wholesale, e.g. a future re-run.)
    setBlockOutput: (tabId, blockId, output) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          return {
            ...tab,
            blocks: tab.blocks.map((b) => (b.id === blockId ? { ...b, output } : b)),
          };
        }),
      }));
    },

    // Raw keystrokes for a running command (Ctrl-C, answers to prompts, arrows).
    writeRaw: async (tabId, data) => {
      const tab = get().tabs.find((t) => t.id === (tabId || get().activeTabId));
      if (!tab || !data) return;
      try {
        await invoke('pty_write', { session_id: tab.sessionId, data });
      } catch (err) {
        console.error('[TerminalStore] Raw write failed:', err);
      }
    },

    // Keep the backend PTY's window size in step with the pane (debounced by the caller).
    resizePty: async (tabId, cols, rows) => {
      const tab = get().tabs.find((t) => t.id === (tabId || get().activeTabId));
      if (!tab || !cols || !rows) return;
      const key = `${cols}x${rows}`;
      if (tab.lastSize === key) return;
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, lastSize: key } : t)),
      }));
      try {
        await invoke('pty_resize', { session_id: tab.sessionId, cols, rows });
      } catch (err) {
        console.error('[TerminalStore] Resize failed:', err);
      }
    },

    setCwd: (cwd) => set({ cwd }),

    getActiveTab: () => {
      const { tabs, activeTabId } = get();
      return tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
    },
  };
});

// Debounced write-behind: any change to the tree shape, tab identity, or
// focused pane schedules a save. Guarded on `isInitialized` so the store's
// own bootstrap (or a restore) never immediately overwrites what it just
// loaded, and gated to changes that actually matter to the persisted shape
// so typing into a running command doesn't thrash localStorage.
useTerminalStore.subscribe((state, prevState) => {
  if (!state.isInitialized) return;
  if (
    state.splitTree === prevState.splitTree &&
    state.tabs === prevState.tabs &&
    state.activePaneId === prevState.activePaneId &&
    state.groupViewMode === prevState.groupViewMode &&
    state.focusedPaneId === prevState.focusedPaneId
  ) {
    return;
  }
  schedulePersist(state);
});

export default useTerminalStore;
