import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';

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

let unlisteners = [];
let listening = false;

export const useTerminalStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  history: [],
  historyIndex: -1,
  cwd: '/workspace',
  isInitialized: false,

  // Split tree: recursive tree of { type: 'leaf', id, tabId } or { type: 'split', id, direction, children }
  splitTree: { type: 'leaf', id: 'pane-root', tabId: null },

  // The pane currently focused for keyboard shortcuts / block-selection / split-origin.
  activePaneId: 'pane-root',

  /**
   * Mark a pane as the active one (called on click/focus of a pane).
   */
  setActivePane: (paneId) => set({ activePaneId: paneId }),

  /**
   * Split a leaf pane into two children (horizontal or vertical).
   * Returns the new pane's id (or null if the split could not be created).
   */
  splitPane: async (paneId, direction = 'horizontal') => {
    const { createTab } = get();
    const newTab = await createTab();
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
            { type: 'leaf', id: newPaneId, tabId: newTab.id },
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
    const tabId = closingLeaf ? closingLeaf.tabId : null;

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

    const nextTree = removeNode(splitTree);
    set({ splitTree: nextTree });

    // Re-focus active pane if we just closed it — hand focus to the sibling
    // that took its place.
    if (get().activePaneId === paneId && replacementLeafId) {
      set({ activePaneId: replacementLeafId });
    }

    if (!tabId) return;

    const stillReferenced = collectLeaves(nextTree).some((leaf) => leaf.tabId === tabId);
    if (stillReferenced) return;

    // No pane references this tab anymore — kill its PTY and drop it.
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    try {
      await invoke('pty_kill', { session_id: tab.sessionId });
    } catch (e) {
      console.warn('[TerminalStore] pty_kill failed:', e);
    }

    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActiveId = nextTabs[0]?.id || null;
      }
      return { tabs: nextTabs, activeTabId: nextActiveId };
    });
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
   * Bind a pane to a specific tab.
   */
  bindPaneToTab: (paneId, tabId) => {
    const { splitTree } = get();

    const updateBinding = (node) => {
      if (node.type === 'leaf' && node.id === paneId) {
        return { ...node, tabId };
      }
      if (node.type === 'split') {
        return { ...node, children: node.children.map(updateBinding) };
      }
      return node;
    };

    set({ splitTree: updateBinding(splitTree) });
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

      const ptySession = await invoke('pty_spawn', {
        cols: 80,
        rows: 24,
        cwd: rootPath,
      });

      const initialTab = {
        id: 'tab-term-1',
        title: 'Terminal 1',
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
        splitTree: { type: 'leaf', id: 'pane-root', tabId: initialTab.id },
        activePaneId: 'pane-root',
      });

      // Register PTY output listener

      // Register PTY exit listener
      // Shell integration (OSC 133): the shell reported that a command finished.
      // This is the real completion signal in the desktop app; `pty-exit`
      // below only fires when the shell itself dies (or from the browser mock).

      await get().attachListeners();
    } catch (err) {
      console.error('[TerminalStore] Failed to initialize terminal session:', err);
    }
  },

  createTab: async (title = null) => {
    try {
      const ptySession = await invoke('pty_spawn', {
        cols: 80,
        rows: 24,
        cwd: get().cwd || '/workspace',
      });

      const nextIndex = get().tabs.length + 1;
      const newTab = {
        id: `tab-term-${Date.now()}-${nextIndex}`,
        title: title || `Terminal ${nextIndex}`,
        sessionId: ptySession.session_id,
        cwd: ptySession.cwd || get().cwd,
        blocks: [],
        activePrompt: '',
      };

      set((state) => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      }));

      return newTab;
    } catch (err) {
      console.error('[TerminalStore] Failed to create terminal tab:', err);
    }
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

    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActiveId = nextTabs[0]?.id || null;
      }
      return {
        tabs: nextTabs,
        activeTabId: nextActiveId,
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
}));

export default useTerminalStore;
