import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { getLanguageFromPath } from '../lib/utils.js';

let unlisteners = [];
let listening = false;
let refreshTimer = null;

// --- Path helpers shared by the move/rename/duplicate flows below ---------

function parentDirOf(path) {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function remapPathPrefix(path, fromPath, toPath) {
  if (path === fromPath) return toPath;
  if (path.startsWith(`${fromPath}/`)) return toPath + path.slice(fromPath.length);
  return path;
}

// After a move/rename from `fromPath` to `toPath`, re-point tabs, expanded
// folders and the current selection instead of silently orphaning them.
function remapAfterMove(state, fromPath, toPath) {
  const nextExpanded = new Set(
    Array.from(state.expandedFolders).map((p) => remapPathPrefix(p, fromPath, toPath))
  );
  const nextTabs = state.tabs.map((t) => {
    const newPath = remapPathPrefix(t.filePath, fromPath, toPath);
    if (newPath === t.filePath) return t;
    return { ...t, filePath: newPath, fileName: newPath.split('/').pop() };
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
async function copyDirRecursive(srcPath, destPath) {
  await invoke('fs_create_dir', { path: destPath });
  const nodes = (await invoke('fs_read_dir', { path: srcPath, max_depth: 1000 })) || [];

  const dirs = [];
  const files = [];
  for (const node of nodes) {
    if (node.path === srcPath || !node.path.startsWith(`${srcPath}/`)) continue;
    const rel = node.path.slice(srcPath.length);
    const newPath = destPath + rel;
    if (node.is_dir) dirs.push(newPath);
    else files.push({ from: node.path, to: newPath });
  }

  // Parents before children so a nested fs_create_dir never races ahead of
  // the directory it is supposed to live inside.
  dirs.sort((a, b) => a.split('/').length - b.split('/').length);
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

  // --- Context-menu-driven UI state ---------------------------------------
  selectedPath: null,   // row highlighted by click or right-click
  clipboard: null,      // { mode: 'copy' | 'cut', path, isDir } | null
  creatingEntry: null,  // { parentPath, type: 'file' | 'folder' } | null
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
      set({ rootPath, expandedFolders: new Set([rootPath]), tabs: [], activeTabId: null, diffView: null });
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
    // Check if already open
    const existing = get().tabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeTabId: existing.id });
      return existing;
    }

    try {
      const content = await invoke('fs_read_file', { path: filePath });
      const fileName = filePath.split('/').pop();
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

  saveFile: async (tabId = null) => {
    const targetId = tabId || get().activeTabId;
    const tab = get().tabs.find((t) => t.id === targetId);
    if (!tab) return;

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

  closeTab: (tabId) => {
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActive = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActive = nextTabs[0]?.id || null;
      }
      return {
        tabs: nextTabs,
        activeTabId: nextActive,
      };
    });
  },

  switchTab: (tabId) => {
    set({ activeTabId: tabId });
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
      // Close tab if deleted file was open
      const openTab = get().tabs.find((t) => t.filePath === path);
      if (openTab) {
        get().closeTab(openTab.id);
      }
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

  // Rename is implemented as read+write+delete for a file, or a recursive
  // directory duplication followed by a recursive delete for a folder —
  // there is no native rename/move IPC command to call instead.
  renamePath: async (oldPath, rawName) => {
    const trimmed = (rawName || '').trim();
    if (!trimmed || trimmed.includes('/')) {
      throw new Error('Name cannot be empty or contain "/"');
    }

    const parent = parentDirOf(oldPath);
    const newPath = parent === '/' ? `/${trimmed}` : `${parent}/${trimmed}`;
    if (newPath === oldPath) return;

    const node = get().fileTree.find((n) => n.path === oldPath);
    const isDir = node ? Boolean(node.is_dir) : get().expandedFolders.has(oldPath);

    try {
      if (isDir) {
        await copyDirRecursive(oldPath, newPath);
        await invoke('fs_delete_path', { path: oldPath, recursive: true });
      } else {
        const content = await invoke('fs_read_file', { path: oldPath });
        await invoke('fs_write_file', { path: newPath, content });
        await invoke('fs_delete_path', { path: oldPath, recursive: false });
      }
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
    const targetBase = targetFolderPathRaw.replace(/\/+$/, '');
    const name = srcPath.split('/').pop();
    const sameLocation = parentDirOf(srcPath) === targetBase;

    if (isDir && (targetBase === srcPath || targetBase.startsWith(`${srcPath}/`))) {
      throw new Error('Cannot paste a folder into itself or one of its own subfolders.');
    }

    if (mode === 'cut' && sameLocation) {
      // Moving something back into the folder it already lives in is a no-op.
      set({ clipboard: null });
      return;
    }

    const siblingNames = new Set(
      get()
        .fileTree.filter((n) => parentDirOf(n.path) === targetBase)
        .map((n) => n.name)
    );

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

    const destPath = `${targetBase}/${destName}`;

    try {
      if (isDir) {
        await copyDirRecursive(srcPath, destPath);
      } else {
        const content = await invoke('fs_read_file', { path: srcPath });
        await invoke('fs_write_file', { path: destPath, content });
      }

      if (mode === 'cut') {
        await invoke('fs_delete_path', { path: srcPath, recursive: isDir });
        set((state) => remapAfterMove(state, srcPath, destPath));
        set({ clipboard: null });
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
