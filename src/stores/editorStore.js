import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { getLanguageFromPath } from '../lib/utils.js';
import {
  basename,
  depthOf,
  dirname,
  isInside,
  join,
  reparent,
  samePath,
  stripTrailingSep,
} from '../lib/paths.js';

let unlisteners = [];
let listening = false;
let refreshTimer = null;

// --- Editor split tree ------------------------------------------------------
// Mirrors src/stores/terminalStore.js's split-tree model so the editor
// workspace can be arranged the same way the terminal already is:
//   { type: 'leaf', id, tabIds: [], activeTabId } |
//   { type: 'split', id, direction: 'horizontal'|'vertical', children: [...] }
// Each leaf is an editor group holding its own file tabs, so a tab can be
// dragged into another group or dropped on a group's edge to split it.

let editorPaneCounter = 1;
const makeEditorPaneId = () => `editor-pane-${editorPaneCounter++}`;

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
  if (!first) return { type: 'leaf', id: paneId || makeEditorPaneId(), tabIds: [tabId], activeTabId: tabId };
  return mapTree(node, (n) =>
    n.type === 'leaf' && n.id === first.id
      ? { ...n, tabIds: [...n.tabIds, tabId], activeTabId: tabId }
      : n
  );
}

/** An empty root, used when the last editor tab goes away. */
const emptyEditorTree = () => ({ type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null });

// --- Path helpers shared by the move/rename/duplicate flows below ---------

const parentDirOf = dirname;
const remapPathPrefix = reparent;

// After a move/rename from `fromPath` to `toPath`, re-point tabs, expanded
// folders and the current selection instead of silently orphaning them.
function remapAfterMove(state, fromPath, toPath) {
  const nextExpanded = new Set(
    Array.from(state.expandedFolders).map((p) => remapPathPrefix(p, fromPath, toPath))
  );
  const nextTabs = state.tabs.map((t) => {
    const newPath = remapPathPrefix(t.filePath, fromPath, toPath);
    if (newPath === t.filePath) return t;
    return { ...t, filePath: newPath, fileName: basename(newPath) };
  });
  const nextSelected = state.selectedPath
    ? remapPathPrefix(state.selectedPath, fromPath, toPath)
    : state.selectedPath;
  return { expandedFolders: nextExpanded, tabs: nextTabs, selectedPath: nextSelected };
}

// There is no native rename/move/copy IPC command, so a directory is
// duplicated by re-creating its structure and re-writing every file
// underneath it one at a time via the existing fs_read_dir/fs_read_file/
// fs_write_file/fs_create_dir surface.
/** Depth-first flatten of the nested FileNode[] that `fs_read_dir` returns. */
function flattenNodes(nodes, acc = []) {
  for (const node of nodes || []) {
    acc.push(node);
    if (node.children && node.children.length) flattenNodes(node.children, acc);
  }
  return acc;
}

/** Names of everything that already lives directly inside `dirPath`. */
function siblingNamesIn(nodes, dirPath) {
  return new Set(
    flattenNodes(nodes)
      .filter((n) => samePath(parentDirOf(n.path), dirPath))
      .map((n) => n.name)
  );
}

async function copyDirRecursive(srcPath, destPath) {
  await invoke('fs_create_dir', { path: destPath });
  const tree = (await invoke('fs_read_dir', { path: srcPath, max_depth: 1000 })) || [];
  // `fs_read_dir` nests its results; walking only the top level would copy
  // one layer and — where the caller then deletes the source — lose the rest.
  const nodes = flattenNodes(tree);

  const dirs = [];
  const files = [];
  for (const node of nodes) {
    if (!isInside(srcPath, node.path)) continue;
    const newPath = reparent(node.path, srcPath, destPath);
    if (node.is_dir) dirs.push(newPath);
    else files.push({ from: node.path, to: newPath });
  }

  // Parents before children so a nested fs_create_dir never races ahead of
  // the directory it is supposed to live inside.
  dirs.sort((a, b) => depthOf(a) - depthOf(b));
  for (const dirPath of dirs) {
    await invoke('fs_create_dir', { path: dirPath });
  }
  for (const file of files) {
    const content = await invoke('fs_read_file', { path: file.from });
    await invoke('fs_write_file', { path: file.to, content });
  }
}

function splitBaseExt(name, isDir) {
  const dotIndex = name.lastIndexOf('.');
  if (isDir || dotIndex <= 0) return [name, ''];
  return [name.slice(0, dotIndex), name.slice(dotIndex)];
}

export const useEditorStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  fileTree: [],
  rootPath: '/workspace',
  expandedFolders: new Set(['/workspace', '/workspace/src', '/workspace/tests']),
  isLoadingTree: false,
  diffView: null,

  // Split tree: { type: 'leaf', id, tabIds: [], activeTabId } | { type: 'split', id, direction, children }
  // See the "Editor split tree" comment near the top of this file.
  editorSplitTree: { type: 'leaf', id: 'editor-pane-root', tabIds: [], activeTabId: null },

  // The pane currently focused for "open file lands here" / split-origin.
  activeEditorPaneId: 'editor-pane-root',

  // --- Context-menu-driven UI state ---------------------------------------
  selectedPath: null,   // row highlighted by click or right-click
  clipboard: null,      // { mode: 'copy' | 'cut', path, isDir } | null
  creatingEntry: null,  // { parentPath, type: 'file' | 'folder' } | null
  // A close the user asked for that would throw away unsaved edits, held
  // until they answer. `closeTab`/`closeEditorPane` stay unconditional; the
  // UI goes through `requestClose*` so nothing is dropped silently.
  pendingClose: null,   // { kind: 'tab' | 'pane', id, tabIds: [], names: [] } | null
  // A save refused because the file changed on disk after this tab read it.
  pendingOverwrite: null, // { tabId, fileName, diskContent } | null
  renamingPath: null,   // path currently rendered as an inline rename input

  // Event listeners are attached once and can be torn down (HMR, unmount)
  // without losing the bootstrap state.
  attachListeners: async () => {
    if (listening) return;
    listening = true;
    unlisteners.push(await listen('fs-change', () => {
      // A build or install fires hundreds of events; refresh once they settle.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => get().refreshExplorer(), 300);
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
  },
  init: async () => {
    // The backend owns the workspace root; the browser mock reports '/workspace'.
    try {
      const rootPath = await invoke('fs_get_root');
      if (rootPath) set({ rootPath, expandedFolders: new Set([rootPath]) });
    } catch (err) {
      console.error('[EditorStore] Failed to resolve workspace root:', err);
    }
    await get().refreshExplorer();

    // Listen to filesystem changes
    await get().attachListeners();
  },

  /**
   * Read one directory's entries.
   *
   * `refreshExplorer` only walks a few levels deep, and a directory at that
   * limit comes back with an empty `children` that is indistinguishable from a
   * genuinely empty one. The tree calls this the first time such a folder is
   * expanded instead of claiming it is empty.
   */
  readDir: async (path) => {
    try {
      return (await invoke('fs_read_dir', { path, max_depth: 2 })) || [];
    } catch (err) {
      console.error(`[EditorStore] Failed to read ${path}:`, err);
      return [];
    }
  },

  refreshExplorer: async () => {
    set({ isLoadingTree: true });
    try {
      const tree = await invoke('fs_read_dir', {
        path: get().rootPath,
        max_depth: 5,
      });
      set({ fileTree: tree || [], isLoadingTree: false });
    } catch (err) {
      console.error('[EditorStore] Failed to read directory:', err);
      set({ isLoadingTree: false });
    }
  },

  pickRoot: async () => {
    try {
      const rootPath = await invoke('fs_pick_root');
      if (!rootPath) return null;
      set({
        rootPath,
        expandedFolders: new Set([rootPath]),
        tabs: [],
        activeTabId: null,
        diffView: null,
        editorSplitTree: emptyEditorTree(),
        activeEditorPaneId: 'editor-pane-root',
      });
      await get().refreshExplorer();
      return rootPath;
    } catch (err) {
      console.error('[EditorStore] Failed to change workspace root:', err);
      return null;
    }
  },

  toggleFolder: (folderPath) => {
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return { expandedFolders: next };
    });
  },

  openFile: async (filePath) => {
    // Check if already open — reveal it in whichever group already shows it
    // (VS Code's "revealIfOpen") rather than yanking it into the active
    // group, which would be surprising if the user deliberately split panes.
    const existing = get().tabs.find((t) => t.filePath === filePath);
    if (existing) {
      set((state) => {
        const holder = leafHoldingTab(state.editorSplitTree, existing.id);
        const paneId = holder ? holder.id : state.activeEditorPaneId;
        const tree = holder
          ? mapTree(state.editorSplitTree, (n) =>
              n.type === 'leaf' && n.id === holder.id ? { ...n, activeTabId: existing.id } : n
            )
          : addTabToPane(state.editorSplitTree, paneId, existing.id);
        return { activeTabId: existing.id, activeEditorPaneId: paneId, editorSplitTree: tree };
      });
      return existing;
    }

    try {
      const content = await invoke('fs_read_file', { path: filePath });
      const fileName = basename(filePath);
      const language = getLanguageFromPath(filePath);

      const tabId = `tab-edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newTab = {
        id: tabId,
        filePath,
        fileName,
        content: content || '',
        savedContent: content || '',
        isDirty: false,
        language,
      };

      set((state) => ({
        tabs: [...state.tabs, newTab],
        activeTabId: tabId,
        // A newly opened file joins the active group so it is visible immediately.
        editorSplitTree: addTabToPane(state.editorSplitTree, state.activeEditorPaneId, tabId),
      }));

      return newTab;
    } catch (err) {
      console.error(`[EditorStore] Failed to open file ${filePath}:`, err);
      throw err;
    }
  },

  editBuffer: (tabId, newContent) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          content: newContent,
          isDirty: newContent !== tab.savedContent,
        };
      }),
    }));
  },

  saveFile: async (tabId = null, { force = false } = {}) => {
    const targetId = tabId || get().activeTabId;
    const tab = get().tabs.find((t) => t.id === targetId);
    if (!tab) return;

    // The bytes on disk may not be the ones this tab read. git, a formatter,
    // or a command in the app's own terminal can all move them, and writing
    // `tab.content` over that silently destroys the newer version.
    if (!force) {
      let onDisk = null;
      try {
        onDisk = await invoke('fs_read_file', { path: tab.filePath });
      } catch {
        // Gone or unreadable — writing recreates it, which is the expected
        // outcome of saving, so fall through.
      }
      if (onDisk !== null && onDisk !== tab.savedContent) {
        set({ pendingOverwrite: { tabId: tab.id, fileName: tab.fileName, diskContent: onDisk } });
        const err = new Error(
          `${tab.fileName} has changed on disk since it was opened.`
        );
        err.code = 'EXTERNAL_CHANGE';
        throw err;
      }
    }

    try {
      await invoke('fs_write_file', {
        path: tab.filePath,
        content: tab.content,
      });

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === targetId
            ? { ...t, savedContent: t.content, isDirty: false }
            : t
        ),
      }));
    } catch (err) {
      console.error(`[EditorStore] Failed to save file ${tab.filePath}:`, err);
      throw err;
    }
  },

  saveAll: async () => {
    const dirtyTabs = get().tabs.filter((t) => t.isDirty);
    for (const tab of dirtyTabs) {
      await get().saveFile(tab.id);
    }
  },

  /** Close a tab, asking first if it has unsaved edits. */
  requestCloseTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.isDirty) {
      get().closeTab(tabId);
      return;
    }
    set({ pendingClose: { kind: 'tab', id: tabId, tabIds: [tabId], names: [tab.fileName] } });
  },

  /** Close a whole editor group, asking first about any unsaved tab in it. */
  requestCloseEditorPane: (paneId) => {
    const leaf = collectLeaves(get().editorSplitTree).find((l) => l.id === paneId);
    const dirty = (leaf?.tabIds || [])
      .map((id) => get().tabs.find((t) => t.id === id))
      .filter((t) => t && t.isDirty);
    if (dirty.length === 0) {
      get().closeEditorPane(paneId);
      return;
    }
    set({
      pendingClose: {
        kind: 'pane',
        id: paneId,
        tabIds: dirty.map((t) => t.id),
        names: dirty.map((t) => t.fileName),
      },
    });
  },

  cancelPendingClose: () => set({ pendingClose: null }),

  cancelPendingOverwrite: () => set({ pendingOverwrite: null }),

  /** Write this tab over the newer bytes on disk, because the user said so. */
  confirmPendingOverwrite: async () => {
    const pending = get().pendingOverwrite;
    if (!pending) return;
    set({ pendingOverwrite: null });
    await get().saveFile(pending.tabId, { force: true });
  },

  /** Throw away the buffer and take what is on disk instead. */
  reloadFromDisk: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const content = await invoke('fs_read_file', { path: tab.filePath });
    set((state) => ({
      pendingOverwrite: null,
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, content, savedContent: content, isDirty: false } : t
      ),
    }));
  },

  /** Close without saving. */
  discardPendingClose: () => {
    const pending = get().pendingClose;
    if (!pending) return;
    set({ pendingClose: null });
    if (pending.kind === 'tab') get().closeTab(pending.id);
    else get().closeEditorPane(pending.id);
  },

  /** Save every unsaved tab involved, then close. A failed save keeps the
   *  prompt open rather than closing over an edit that never reached disk. */
  savePendingClose: async () => {
    const pending = get().pendingClose;
    if (!pending) return;
    for (const id of pending.tabIds) {
      await get().saveFile(id);
    }
    set({ pendingClose: null });
    if (pending.kind === 'tab') get().closeTab(pending.id);
    else get().closeEditorPane(pending.id);
  },

  closeTab: (tabId) => {
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActive = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActive = nextTabs[0]?.id || null;
      }
      // Drop it from its group too, collapsing the group if it was the last tab.
      const editorSplitTree = pruneTree(removeTabFromTree(state.editorSplitTree, tabId)) || emptyEditorTree();
      const paneStillThere = collectLeaves(editorSplitTree).some((l) => l.id === state.activeEditorPaneId);
      return {
        tabs: nextTabs,
        activeTabId: nextActive,
        editorSplitTree,
        activeEditorPaneId: paneStillThere ? state.activeEditorPaneId : firstLeafId(editorSplitTree) || 'editor-pane-root',
      };
    });
  },

  switchTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  // --- Editor split tree: panes, drag-and-drop placement ------------------

  /** Mark a pane as the active one (called on click/focus of a pane). */
  setActiveEditorPane: (paneId) => set({ activeEditorPaneId: paneId }),

  /**
   * Split a leaf pane into two children (horizontal or vertical). The new
   * pane starts empty — unlike a terminal, a file tab can't be conjured up
   * out of thin air — and becomes active, so the next file opened (or tab
   * dragged in) lands there. Returns the new pane's id.
   */
  splitEditorPane: (paneId, direction = 'horizontal') => {
    const newPaneId = makeEditorPaneId();

    const splitNode = (node) => {
      if (node.type === 'leaf' && node.id === paneId) {
        return {
          type: 'split',
          id: `editor-split-${Date.now()}`,
          direction,
          children: [
            { ...node },
            { type: 'leaf', id: newPaneId, tabIds: [], activeTabId: null },
          ],
        };
      }
      if (node.type === 'split') {
        return { ...node, children: node.children.map(splitNode) };
      }
      return node;
    };

    set((state) => ({ editorSplitTree: splitNode(state.editorSplitTree), activeEditorPaneId: newPaneId }));
    return newPaneId;
  },

  /**
   * Close a pane (an editor group). The sibling takes over the parent split.
   * Every tab that pane held is closed too, UNLESS another remaining leaf
   * still shows that same tabId.
   */
  closeEditorPane: (paneId) => {
    const { editorSplitTree } = get();

    const closingLeaf = collectLeaves(editorSplitTree).find((leaf) => leaf.id === paneId);
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
      editorSplitTree.type === 'leaf' && editorSplitTree.id === paneId
        ? emptyEditorTree()
        : removeNode(editorSplitTree);
    set({ editorSplitTree: nextTree });

    if (get().activeEditorPaneId === paneId && replacementLeafId) {
      set({ activeEditorPaneId: replacementLeafId });
    }

    for (const tabId of closingTabIds) {
      if (leafHoldingTab(get().editorSplitTree, tabId)) continue;
      get().closeTab(tabId);
    }
  },

  /**
   * Make `tabId` the visible tab of `paneId`. If the tab lives in another
   * group, move it here first (clicking a tab chip never splits).
   */
  bindEditorPaneToTab: (paneId, tabId) => {
    set((state) => {
      const holder = leafHoldingTab(state.editorSplitTree, tabId);
      let tree = state.editorSplitTree;
      if (!holder || holder.id !== paneId) {
        tree =
          pruneTree(addTabToPane(removeTabFromTree(tree, tabId), paneId, tabId)) || emptyEditorTree();
      } else {
        tree = mapTree(tree, (n) =>
          n.type === 'leaf' && n.id === paneId ? { ...n, activeTabId: tabId } : n
        );
      }
      return { editorSplitTree: tree, activeEditorPaneId: paneId, activeTabId: tabId };
    });
  },

  /**
   * Drag & drop a file tab onto a pane.
   *
   * `zone` is where inside the target pane it was dropped:
   *   'center'                  → move the tab into that group
   *   'left' | 'right'          → split the group horizontally, tab on that side
   *   'top'  | 'bottom'         → split the group vertically, tab on that side
   */
  dropEditorTabOnPane: (tabId, targetPaneId, zone = 'center') => {
    const state = get();
    const target = collectLeaves(state.editorSplitTree).find((l) => l.id === targetPaneId);
    if (!target || !state.tabs.some((t) => t.id === tabId)) return;

    const source = leafHoldingTab(state.editorSplitTree, tabId);

    // Dropping a tab back on its own group: just focus it. Splitting a group
    // off its only tab would leave the source empty and is a no-op too.
    if (source && source.id === targetPaneId) {
      if (zone === 'center' || source.tabIds.length === 1) {
        get().bindEditorPaneToTab(targetPaneId, tabId);
        return;
      }
    }

    const withoutTab = removeTabFromTree(state.editorSplitTree, tabId);

    if (zone === 'center') {
      const tree = pruneTree(addTabToPane(withoutTab, targetPaneId, tabId)) || emptyEditorTree();
      set({ editorSplitTree: tree, activeEditorPaneId: targetPaneId, activeTabId: tabId });
      return;
    }

    const newPaneId = makeEditorPaneId();
    const newLeaf = { type: 'leaf', id: newPaneId, tabIds: [tabId], activeTabId: tabId };
    const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
    const insertFirst = zone === 'left' || zone === 'top';

    const split = mapTree(withoutTab, (n) =>
      n.type === 'leaf' && n.id === targetPaneId
        ? {
            type: 'split',
            id: `editor-split-${Date.now()}`,
            direction,
            children: insertFirst ? [newLeaf, n] : [n, newLeaf],
          }
        : n
    );

    set({
      editorSplitTree: pruneTree(split) || emptyEditorTree(),
      activeEditorPaneId: newPaneId,
      activeTabId: tabId,
    });
  },

  createFile: async (path) => {
    try {
      await invoke('fs_create_file', { path });
      await get().refreshExplorer();
      await get().openFile(path);
    } catch (err) {
      console.error(`[EditorStore] Failed to create file ${path}:`, err);
      throw err;
    }
  },

  createFolder: async (path) => {
    try {
      await invoke('fs_create_dir', { path });
      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to create dir ${path}:`, err);
      throw err;
    }
  },

  deletePath: async (path, recursive = false) => {
    try {
      await invoke('fs_delete_path', { path, recursive });
      await get().refreshExplorer();
      // Close every tab the delete removed. Matching only the exact path
      // left a deleted folder's files open, and saving one of those
      // recreated the directory the user had just deleted.
      const prefix = `${path}/`;
      const orphaned = get().tabs.filter(
        (t) => t.filePath === path || t.filePath.startsWith(prefix)
      );
      orphaned.forEach((t) => get().closeTab(t.id));
    } catch (err) {
      console.error(`[EditorStore] Failed to delete ${path}:`, err);
      throw err;
    }
  },

  // --- Context menu: selection, inline create/rename, clipboard ----------

  setSelectedPath: (path) => set({ selectedPath: path }),

  setCreatingEntry: (entry) => {
    if (!entry) {
      set({ creatingEntry: null });
      return;
    }
    // The workspace root uses the always-visible pinned form instead, so it
    // never needs auto-expansion. Any other folder must be expanded for its
    // inline "new file/folder" row to actually be visible in the tree.
    if (entry.parentPath !== get().rootPath && !get().expandedFolders.has(entry.parentPath)) {
      const nextExpanded = new Set(get().expandedFolders);
      nextExpanded.add(entry.parentPath);
      set({ creatingEntry: entry, expandedFolders: nextExpanded });
      return;
    }
    set({ creatingEntry: entry });
  },

  beginRename: (path) => set({ renamingPath: path, selectedPath: path }),
  cancelRename: () => set({ renamingPath: null }),

  copyToClipboard: (path, isDir) => set({ clipboard: { mode: 'copy', path, isDir: Boolean(isDir) } }),
  cutToClipboard: (path, isDir) => set({ clipboard: { mode: 'cut', path, isDir: Boolean(isDir) } }),
  clearClipboard: () => set({ clipboard: null }),

  // One `fs_rename_path` call, never copy-then-delete: the kernel decides
  // whether the old and new names are the same entry, which is what makes a
  // case-only or NFC/NFD change safe on a case-insensitive volume, and it
  // refuses to clobber an existing file instead of merging two into one.
  renamePath: async (oldPath, rawName) => {
    const trimmed = (rawName || '').trim();
    if (!trimmed || trimmed.includes('/')) {
      throw new Error('Name cannot be empty or contain "/"');
    }

    const parent = parentDirOf(oldPath);
    const newPath = parent === '/' ? `/${trimmed}` : `${parent}/${trimmed}`;
    if (newPath === oldPath) return;

    try {
      await invoke('fs_rename_path', { from: oldPath, to: newPath });
      set((state) => remapAfterMove(state, oldPath, newPath));
      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to rename ${oldPath} -> ${newPath}:`, err);
      throw err;
    }
  },

  // Copy+Paste duplicates a file/folder; Cut+Paste moves it. Both are built
  // from fs_read_file/fs_write_file/fs_delete_path (and fs_create_dir for
  // folders) since there is no dedicated copy or move IPC command.
  pasteClipboard: async (targetFolderPathRaw) => {
    const clip = get().clipboard;
    if (!clip) return;
    const { mode, path: srcPath, isDir } = clip;
    const targetBase = stripTrailingSep(targetFolderPathRaw);
    const name = basename(srcPath);
    const sameLocation = samePath(parentDirOf(srcPath), targetBase);

    if (isDir && (samePath(targetBase, srcPath) || isInside(srcPath, targetBase))) {
      throw new Error('Cannot paste a folder into itself or one of its own subfolders.');
    }

    if (mode === 'cut' && sameLocation) {
      // Moving something back into the folder it already lives in is a no-op.
      set({ clipboard: null });
      return;
    }

    const siblingNames = siblingNamesIn(get().fileTree, targetBase);

    let destName = name;
    if (siblingNames.has(destName) || (mode === 'copy' && sameLocation)) {
      const [base, ext] = splitBaseExt(name, isDir);
      let attempt = 1;
      let candidate = `${base} copy${ext}`;
      while (siblingNames.has(candidate)) {
        attempt += 1;
        candidate = `${base} copy ${attempt}${ext}`;
      }
      destName = candidate;
    }

    const destPath = join(targetBase, destName);

    try {
      if (mode === 'cut') {
        // A move is a rename: atomic, and it cannot drop part of a subtree
        // the way copy-then-delete does.
        await invoke('fs_rename_path', { from: srcPath, to: destPath });
        set((state) => remapAfterMove(state, srcPath, destPath));
        set({ clipboard: null });
      } else if (isDir) {
        await copyDirRecursive(srcPath, destPath);
      } else {
        const content = await invoke('fs_read_file', { path: srcPath });
        await invoke('fs_write_file', { path: destPath, content });
      }

      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to paste ${srcPath} into ${targetBase}:`, err);
      throw err;
    }
  },

  // "Reveal in Finder/Explorer" needs a shell/OS command the current IPC
  // surface does not expose (no fs_reveal_path-style command). Kept as a
  // documented no-op instead of adding a new Rust command out of scope here.
  revealPath: async (path) => {
    console.warn(`[EditorStore] Reveal in Finder/Explorer is not supported by the current IPC surface (requested for ${path}).`);
  },

  openDiffView: ({ original, modified, title, onAccept, onReject }) => {
    set({
      diffView: {
        open: true,
        original,
        modified,
        title: title || 'Code Diff Review',
        onAccept,
        onReject,
      },
    });
  },

  closeDiffView: () => {
    set({ diffView: null });
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) || null;
  },
}));

export default useEditorStore;
