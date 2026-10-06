import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { getLanguageFromPath } from '../lib/utils.js';
import {
  basename,
  dirname,
  isInside,
  join,
  reparent,
  samePath,
  stripTrailingSep,
  withSepOf,
} from '../lib/paths.js';
import { findNode, setChildrenAt } from '../components/explorer/treeRows.js';
import { loadState, saveState } from '../lib/persistence.js';
import { useGitStore } from './gitStore.js';

/** Folders whose read is in flight, so an impatient double-click reads once. */
const loadingDirs = new Set();

let unlisteners = [];
let listening = false;
let refreshTimer = null;
// The init() still running, shared by every caller until it settles — see init.
let initInFlight = null;

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

/**
 * `pruneTree` for one leaf only: drop `leafId` if it holds no tabs, and
 * collapse the split that leaves with a single child.
 *
 * A tab moved out of a group can leave that group empty, and it goes the way
 * an emptied group always goes. But a group the user has just split off and
 * not filled yet is empty too, and moving a tab between two OTHER groups is
 * not the user asking for that one to disappear.
 */
function pruneLeafIfEmpty(node, leafId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === leafId && node.tabIds.length === 0 ? null : node;
  const children = node.children.map((child) => pruneLeafIfEmpty(child, leafId)).filter(Boolean);
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
/** How many folders "Open Recent" remembers. */
const RECENT_ROOT_LIMIT = 12;
const RECENT_ROOTS_KEY = 'nexterm.recentRoots';

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

function splitBaseExt(name, isDir) {
  const dotIndex = name.lastIndexOf('.');
  if (isDir || dotIndex <= 0) return [name, ''];
  return [name.slice(0, dotIndex), name.slice(dotIndex)];
}

/**
 * The name a paste of `name` into `dirPath` should take: `name` itself when
 * nothing there has it (and `mustDiffer` is false), else "<base> copy<ext>",
 * then "<base> copy 2<ext>" and so on, as VS Code does.
 *
 * The folder is listed afresh. The tree in memory is only a few levels deep
 * and as old as its last refresh, and a name missing from it is not a free
 * name: a paste into a folder the tree had not read kept the name and wrote
 * straight over the file of that name.
 *
 * Names are compared without case, because NTFS and APFS treat `Note.txt` and
 * `note.txt` as one file. The listing leaves out the folders the Explorer
 * hides (.git, node_modules, dist…), so a pasted folder of one of those names
 * can still meet one; `fs_copy_path` and `fs_rename_path` both refuse an
 * existing destination, so that ends in an error, never in a merge.
 */
async function freeNameIn(dirPath, name, isDir, mustDiffer) {
  const listing = (await invoke('fs_read_dir', { path: dirPath, max_depth: 1 })) || [];
  const taken = new Set(listing.map((node) => node.name.toLowerCase()));
  if (!mustDiffer && !taken.has(name.toLowerCase())) return name;

  const [base, ext] = splitBaseExt(name, isDir);
  let candidate = `${base} copy${ext}`;
  for (let attempt = 2; taken.has(candidate.toLowerCase()); attempt += 1) {
    candidate = `${base} copy ${attempt}${ext}`;
  }
  return candidate;
}

// --- Unsaved edits ---------------------------------------------------------

/**
 * Each tab's latest save, so that the next one waits for it.
 *
 * A save reads the file back first to see whether something else changed it,
 * and compares what it reads with what the tab last saved. A second Ctrl+S
 * that started while the first was still on its way compared against the
 * text from BEFORE the first, found the first save's own bytes on disk, and
 * called them an external change.
 */
const savesInFlight = new Map(); // tabId -> promise of its last save

/** The prompt whose Save is writing files right now — see `savePendingClose`. */
let savingClose = null;

/**
 * Hold `proceed` behind the Save / Don't Save / Cancel prompt for `dirty`.
 *
 * Returns a promise of how it ended: what `proceed` resolved to once the user
 * saved the edits or gave them up, or null when they cancelled. It never
 * rejects: a failure belongs to whoever answered (`savePendingClose`,
 * `discardPendingClose`), and the code that asked has nothing to do with it.
 */
function holdForAnswer(set, get, { kind, id = null, dirty, proceed }) {
  // A newer question replaces an older one: the window closing covers the
  // tab that was closing.
  get().pendingClose?.abandon?.();
  return new Promise((resolve) => {
    set({
      pendingClose: {
        kind,
        id,
        tabIds: dirty.map((t) => t.id),
        names: dirty.map((t) => t.fileName),
        proceed: async () => {
          try {
            const result = await proceed();
            resolve(result ?? null);
            return result;
          } catch (err) {
            resolve(null);
            throw err;
          }
        },
        abandon: () => resolve(null),
      },
    });
  });
}

/**
 * Write one tab to disk. The body of `saveFile`, which queues it.
 *
 * What reaches the disk is the text as it stands when this starts, and that
 * is what counts as saved afterwards. Monaco reports every keystroke, and
 * typing goes on during the two round trips below: marking the text as it
 * stood at the END as saved hid whatever was typed in between, so the tab
 * closed without asking and the next save saw its own last write as an
 * external change.
 */
async function writeTab(set, get, targetId, { force = false } = {}) {
  const tab = get().tabs.find((t) => t.id === targetId);
  if (!tab) return;
  const written = tab.content;

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
      content: written,
    });

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === targetId
          ? { ...t, savedContent: written, isDirty: t.content !== written }
          : t
      ),
    }));
  } catch (err) {
    console.error(`[EditorStore] Failed to save file ${tab.filePath}:`, err);
    throw err;
  }
}

/**
 * Point the workspace at `root`, which the backend has already opened.
 *
 * Another folder closes every editor tab — they belong to the folder being
 * left, and the callers have asked about unsaved ones first. The folder that
 * is already open keeps them: it is the first entry in Open Recent, and
 * choosing it again used to throw every tab away.
 */
async function enterRoot(set, get, root) {
  if (samePath(root, get().rootPath)) {
    set({ rootPath: root });
  } else {
    set({
      rootPath: root,
      expandedFolders: new Set([root]),
      tabs: [],
      activeTabId: null,
      diffView: null,
      editorSplitTree: emptyEditorTree(),
      activeEditorPaneId: 'editor-pane-root',
    });
  }
  get().rememberRoot(root);
  await get().refreshExplorer();
  useGitStore.getState().refreshNow();
  return root;
}

export const useEditorStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  fileTree: [],
  rootPath: '/workspace',
  expandedFolders: new Set(['/workspace', '/workspace/src', '/workspace/tests']),
  isLoadingTree: false,
  // False until init() has asked the backend for the real root; until then
  // `rootPath` is only the browser mock's placeholder. See FileExplorer.
  rootResolved: false,
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
  // UI goes through `requestClose*`, and opening another folder, closing the
  // window and quitting go through `askBeforeLeaving`, so nothing is dropped
  // silently. `proceed` does what was asked once the edits are saved or
  // given up; `abandon` settles the asker's promise when nothing will be.
  pendingClose: null,   // { kind: 'tab' | 'pane' | 'root' | 'window' | 'quit', id, tabIds: [], names: [], proceed, abandon } | null
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
      // Git's answer changes with the files. Its own debounce coalesces a
      // checkout's thousands of events into one `git status`.
      useGitStore.getState().refresh();
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
  init: () => {
    // App's effect runs twice under React StrictMode in development, and the
    // second run arrives while the first is still waiting on the backend.
    // Share the run in flight rather than resolving the root and reading the
    // tree twice. Cleared once it settles, so a later init() runs afresh.
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      // The backend owns the workspace root and starts with none, as VS Code
      // does (the browser mock reports '/workspace').
      try {
        const rootPath = await invoke('fs_get_root');
        set(
          rootPath
            ? { rootPath, expandedFolders: new Set([rootPath]) }
            : { rootPath: null, expandedFolders: new Set(), fileTree: [] }
        );
      } catch (err) {
        console.error('[EditorStore] Failed to resolve workspace root:', err);
      }
      // As known as it will get: the placeholder stays if the backend could not say.
      set({ rootResolved: true, recentRoots: loadState(RECENT_ROOTS_KEY, []) || [] });
      useGitStore.getState().refreshNow();
      const opened = get().rootPath;
      if (opened) get().rememberRoot(opened);
      await get().refreshExplorer();

      // Listen to filesystem changes
      await get().attachListeners();
    })().finally(() => {
      initInFlight = null;
    });
    return initInFlight;
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
    // No folder open: there is no tree to read, and the backend would refuse.
    if (!get().rootPath) {
      set({ fileTree: [], isLoadingTree: false });
      return;
    }
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

  /**
   * Folders opened before, newest first.
   *
   * VS Code's "Open Recent". The app opens with no folder and the only way
   * back to one was the native dialog — which on Windows means clicking
   * through a tree to a path you have typed a hundred times in the terminal
   * below. Capped and persisted like everything else the user would be
   * annoyed to lose.
   */
  recentRoots: [],

  /** Remember a root, newest first, without duplicates. */
  rememberRoot: (rootPath) => {
    if (typeof rootPath !== 'string' || !rootPath) return;
    set((state) => {
      const next = [rootPath, ...state.recentRoots.filter((p) => !samePath(p, rootPath))]
        .slice(0, RECENT_ROOT_LIMIT);
      saveState(RECENT_ROOTS_KEY, next);
      return { recentRoots: next };
    });
  },

  /** Drop one — the folder is gone, or the user does not want it listed. */
  forgetRoot: (rootPath) => {
    set((state) => {
      const next = state.recentRoots.filter((p) => !samePath(p, rootPath));
      saveState(RECENT_ROOTS_KEY, next);
      return { recentRoots: next };
    });
  },

  /**
   * Open a folder from the recent list.
   *
   * A recent folder may have been moved, renamed or deleted since. The
   * backend refuses it (`set_root` canonicalises and checks it is a
   * directory), and rather than leaving a row that fails every time it is
   * clicked, the entry comes out of the list.
   *
   * Another folder closes every editor tab, so unsaved ones are asked about
   * first — before `fs_set_root`, which moves the backend's root for good.
   * Resolves to the folder opened, or null when none was (refused, or the
   * user cancelled).
   */
  openRoot: async (rootPath) => {
    const open = async () => {
      try {
        const resolved = await invoke('fs_set_root', { path: rootPath });
        return await enterRoot(set, get, resolved);
      } catch (err) {
        console.error(`[EditorStore] Could not open ${rootPath}:`, err);
        get().forgetRoot(rootPath);
        return null;
      }
    };
    // The folder already open keeps its tabs (see `enterRoot`): nothing to ask.
    if (samePath(rootPath, get().rootPath)) return open();
    return get().askBeforeLeaving('root', open) ?? open();
  },

  /**
   * Open a folder through the native picker.
   *
   * Unsaved tabs are asked about BEFORE the picker opens, not once a folder
   * has been chosen: `fs_pick_root` moves the backend's root as it returns,
   * and the tabs would by then belong to a folder that is no longer open.
   * Cancelling the picker after "Don't Save" gives nothing up — the tabs are
   * only closed when another folder actually opens.
   */
  pickRoot: async () => {
    const pick = async () => {
      try {
        const rootPath = await invoke('fs_pick_root');
        return rootPath ? await enterRoot(set, get, rootPath) : null;
      } catch (err) {
        console.error('[EditorStore] Failed to change workspace root:', err);
        return null;
      }
    };
    return get().askBeforeLeaving('root', pick) ?? pick();
  },

  /**
   * Open or close a folder.
   *
   * `refreshExplorer` only walks a few levels, so a directory at that limit
   * comes back with `children: []` — indistinguishable from a genuinely empty
   * one. Opening such a folder reads it and writes the result into `fileTree`,
   * so the tree stays the single source of truth. It used to be cached in the
   * row component instead, where a refresh could not reach it: a file created
   * inside a deep folder never appeared until the app restarted.
   */
  toggleFolder: (folderPath) => {
    const wasExpanded = get().expandedFolders.has(folderPath);
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (wasExpanded) next.delete(folderPath);
      else next.add(folderPath);
      return { expandedFolders: next };
    });
    if (!wasExpanded) get().ensureChildrenLoaded(folderPath);
  },

  setFolderExpanded: (folderPath, expanded) => {
    if (get().expandedFolders.has(folderPath) === expanded) return;
    get().toggleFolder(folderPath);
  },

  /** Read a folder's entries into the tree if they are not there yet. */
  ensureChildrenLoaded: async (folderPath) => {
    const node = findNode(get().fileTree, folderPath);
    if (!node || !node.is_dir) return;
    if (Array.isArray(node.children) && node.children.length > 0) return;
    if (loadingDirs.has(folderPath)) return;
    loadingDirs.add(folderPath);
    try {
      const children = await get().readDir(folderPath);
      set((state) => ({ fileTree: setChildrenAt(state.fileTree, folderPath, children) }));
    } finally {
      loadingDirs.delete(folderPath);
    }
  },

  /**
   * Where the editor should jump once the file is on screen.
   *
   * A click on `src/main.rs:10:5` in the terminal has to do two things that
   * cannot happen in one step: open the file (async, may fail) and move the
   * caret (only possible once Monaco has mounted that model). So the position
   * is parked here and `EditorPanel` applies it when its editor is ready,
   * which also means a file already open is handled by the same path.
   */
  pendingReveal: null,

  /** Open `filePath` and put the caret on that line. */
  openFileAt: async (filePath, line, column = null) => {
    const tab = await get().openFile(filePath);
    if (Number.isFinite(line) && line > 0) {
      // The tab's own spelling, which is what the editor compares against:
      // a link's `C:\proj\src/App.jsx` lands on the tab of `C:\proj\src\App.jsx`.
      set({ pendingReveal: { filePath: tab.filePath, line, column: Number.isFinite(column) ? column : 1 } });
    }
    return tab;
  },

  /** Applied — or abandoned, if nothing could show it. */
  clearReveal: () => set({ pendingReveal: null }),

  openFile: async (requestedPath) => {
    // Written the way the backend writes the open folder, so that a link
    // printed in a terminal and a click in the Explorer name the same file
    // the same way (see `withSepOf`).
    const filePath = withSepOf(requestedPath, get().rootPath);
    // Check if already open — reveal it in whichever group already shows it
    // (VS Code's "revealIfOpen") rather than yanking it into the active
    // group, which would be surprising if the user deliberately split panes.
    // Compared separator-blind: on Windows `C:\p\a.js` and `C:\p/a.js` are
    // one file, and two tabs on it were two buffers of it, each taking the
    // other's saves for changes made on disk.
    const existing = get().tabs.find((t) => samePath(t.filePath, filePath));
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

  /** Save a tab (the active one by default), after any save of it still under way. */
  saveFile: (tabId = null, options = {}) => {
    const targetId = tabId || get().activeTabId;
    const previous = savesInFlight.get(targetId);
    // The previous save's failure is its own caller's to report.
    const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() =>
      writeTab(set, get, targetId, options)
    );
    savesInFlight.set(targetId, run);
    const forget = () => {
      if (savesInFlight.get(targetId) === run) savesInFlight.delete(targetId);
    };
    run.then(forget, forget);
    return run;
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
    holdForAnswer(set, get, {
      kind: 'tab',
      id: tabId,
      dirty: [tab],
      proceed: () => get().closeTab(tabId),
    });
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
    holdForAnswer(set, get, {
      kind: 'pane',
      id: paneId,
      dirty,
      proceed: () => get().closeEditorPane(paneId),
    });
  },

  /**
   * Ask about every unsaved tab before something that closes them all:
   * opening another folder (`kind` 'root'), closing the window ('window'),
   * quitting ('quit').
   *
   * Returns null when nothing is unsaved, and the caller goes ahead itself.
   * Otherwise `proceed` waits for the answer, and what is returned is the
   * promise of how it ended — `proceed`'s result, or null when cancelled.
   */
  askBeforeLeaving: (kind, proceed) => {
    const dirty = get().tabs.filter((t) => t.isDirty);
    if (dirty.length === 0) return null;
    return holdForAnswer(set, get, { kind, dirty, proceed });
  },

  cancelPendingClose: () => {
    const pending = get().pendingClose;
    set({ pendingClose: null });
    pending?.abandon?.();
  },

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

  /** Go ahead without saving. */
  discardPendingClose: async () => {
    const pending = get().pendingClose;
    // Not while Save is still writing: closing the window over a write that
    // has not finished can leave the file cut short.
    if (!pending || savingClose === pending) return;
    set({ pendingClose: null });
    await pending.proceed();
  },

  /**
   * Save every unsaved tab involved, then go ahead. A failed save keeps the
   * prompt open rather than closing over an edit that never reached disk.
   *
   * Except when the file changed on disk: `saveFile` has then asked its own
   * question (`pendingOverwrite`), and that one takes this one's place. Left
   * open together, one Enter answered both — a plain save and a forced
   * overwrite of the same file, racing.
   */
  savePendingClose: async () => {
    const pending = get().pendingClose;
    // A second click on Save while the first is still writing.
    if (!pending || savingClose === pending) return;
    savingClose = pending;
    try {
      for (const id of pending.tabIds) {
        // A tab closed some other way meanwhile has nothing left to save.
        if (!get().tabs.some((t) => t.id === id)) continue;
        await get().saveFile(id);
      }
    } catch (err) {
      if (err?.code === 'EXTERNAL_CHANGE' && get().pendingClose === pending) {
        set({ pendingClose: null });
        pending.abandon();
      }
      throw err;
    } finally {
      if (savingClose === pending) savingClose = null;
    }
    // Cancelled, or replaced by a newer question, while the files were being
    // written: the saves stand, and nothing else happens.
    if (get().pendingClose !== pending) return;
    set({ pendingClose: null });
    await pending.proceed();
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

  /**
   * Drag & drop a file tab onto a tab strip: reorder it within its own group,
   * or insert it into another group where it was dropped — not at the end, as
   * a drop on the group's body does.
   *
   * `index` is a GAP in the target strip as drawn when the drop happens, with
   * the dragged tab still in it if it lives there: 0 is before the first chip,
   * `tabIds.length` is after the last, and `i` is between chips `i - 1` and
   * `i`. That is what the pointer is measured against — the dragged chip stays
   * on screen, dimmed, for the whole gesture — so the caller passes it
   * straight through and the translation happens here, where it is tested.
   * Both gaps beside the tab's own chip leave it where it is, and every gap
   * to the right of it is one past the slot it lands in, because by then the
   * tab has left its old slot.
   *
   * A number outside the strip is clamped to the nearer end, and a fraction
   * rounds down. A gap that is not a number, an unknown tab or an unknown
   * group changes nothing.
   *
   * The tab becomes its group's visible tab and that group the active one,
   * as a click on the chip would make them. A group the tab leaves empty is
   * pruned; no other group is touched (see `pruneLeafIfEmpty`).
   *
   * A drop that asks for exactly what is already there changes no state at
   * all — not even a new state object, which every subscriber would take as
   * a change and re-render for.
   */
  moveEditorTabInStrip: (tabId, targetPaneId, index) => {
    if (typeof index !== 'number' || Number.isNaN(index)) return;
    const state = get();
    const target = collectLeaves(state.editorSplitTree).find((l) => l.id === targetPaneId);
    if (!target || !state.tabs.some((t) => t.id === tabId)) return;

    let slot = Math.min(Math.max(Math.floor(index), 0), target.tabIds.length);
    const from = target.tabIds.indexOf(tabId);
    if (from !== -1 && slot > from) slot -= 1;
    const tabIds = target.tabIds.filter((id) => id !== tabId);
    tabIds.splice(slot, 0, tabId);

    const source = leafHoldingTab(state.editorSplitTree, tabId);
    const nothingChanges =
      source?.id === targetPaneId &&
      tabIds.every((id, i) => id === target.tabIds[i]) &&
      target.activeTabId === tabId &&
      state.activeEditorPaneId === targetPaneId &&
      state.activeTabId === tabId;
    if (nothingChanges) return;

    const placed = mapTree(removeTabFromTree(state.editorSplitTree, tabId), (n) =>
      n.type === 'leaf' && n.id === targetPaneId ? { ...n, tabIds, activeTabId: tabId } : n
    );
    const vacated = source && source.id !== targetPaneId ? source.id : null;
    set({
      editorSplitTree: (vacated ? pruneLeafIfEmpty(placed, vacated) : placed) || emptyEditorTree(),
      activeEditorPaneId: targetPaneId,
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
      // recreated the directory the user had just deleted. Separator-blind:
      // a `${path}/` prefix never matched a Windows path, so on Windows,
      // where this app is mostly used, that still happened.
      const orphaned = get().tabs.filter(
        (t) => samePath(t.filePath, path) || isInside(path, t.filePath)
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
    // A separator would make this a move into a folder, which the backend
    // creates on the way. '\' is one on Windows only, and a name that means a
    // different thing on each platform is refused on both.
    if (!trimmed || /[\\/]/.test(trimmed)) {
      throw new Error('Name cannot be empty or contain "/" or "\\"');
    }

    // In the separator the folder already uses: `${parent}/${name}` gave
    // `C:\proj\src/b.js`, which no Explorer click matched, so the file opened
    // a second time in a second tab.
    const newPath = join(parentDirOf(oldPath), trimmed);
    if (samePath(newPath, oldPath)) return;

    try {
      await invoke('fs_rename_path', { from: oldPath, to: newPath });
      set((state) => remapAfterMove(state, oldPath, newPath));
      await get().refreshExplorer();
    } catch (err) {
      console.error(`[EditorStore] Failed to rename ${oldPath} -> ${newPath}:`, err);
      throw err;
    }
  },

  // Copy+Paste duplicates a file/folder; Cut+Paste moves it. Neither ever
  // writes over something already in the destination: the name comes from a
  // fresh listing of it (see `freeNameIn`), and both backend commands refuse
  // an existing destination.
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

    try {
      const destName = await freeNameIn(targetBase, name, isDir, mode === 'copy' && sameLocation);
      const destPath = join(targetBase, destName);

      if (mode === 'cut') {
        // A move is a rename: atomic, and it cannot drop part of a subtree
        // the way copy-then-delete does.
        await invoke('fs_rename_path', { from: srcPath, to: destPath });
        set((state) => remapAfterMove(state, srcPath, destPath));
        set({ clipboard: null });
      } else {
        // One backend command, for a file or a whole folder, copying bytes.
        // Copying through fs_read_dir/fs_read_file lost what the Explorer
        // hides (.git, node_modules, dist…) and stopped at the first file
        // that is not UTF-8 text, with half the folder already written.
        await invoke('fs_copy_path', { from: srcPath, to: destPath });
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
