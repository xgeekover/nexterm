import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { getLanguageFromPath } from '../lib/utils.js';

let unlisteners = [];
let listening = false;
let refreshTimer = null;
export const useEditorStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  fileTree: [],
  rootPath: '/workspace',
  expandedFolders: new Set(['/workspace', '/workspace/src', '/workspace/tests']),
  isLoadingTree: false,
  diffView: null,

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
