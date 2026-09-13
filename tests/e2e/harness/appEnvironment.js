/**
 * The e2e harness's view of the running app.
 *
 * This is a FAÇADE, not a re-implementation: every method below delegates to
 * the same store the UI calls, over the same browser IPC mock the app uses
 * when it runs outside Tauri. An earlier version of this file was a parallel
 * app of its own — deleting `src/stores/terminalStore.js` outright left the
 * whole suite green, because nothing here imported it. The names are kept so
 * the test files did not have to change; what they exercise did.
 *
 * Two shapes have to be bridged:
 *
 *  - The stores update immutably (`set(state => ...)` hands back new objects),
 *    while the tests hold a reference and read it after awaiting. So tabs and
 *    blocks are handed out as LIVE VIEWS that re-read the store by id on every
 *    property access — see `liveView`.
 *  - The stores are module singletons, but each test builds a fresh
 *    `AppEnvironment`. The constructor resets all three stores and the mock
 *    backend, so cases stay independent.
 */

import { useTerminalStore } from '../../../src/stores/terminalStore.js';
import { useEditorStore } from '../../../src/stores/editorStore.js';
import { useSettingsStore } from '../../../src/stores/settingsStore.js';
import { mockBridge } from '../../../src/lib/ipc.js';
import { buildPaletteGroups } from '../../../src/lib/paletteItems.js';
import { DEFAULT_PROJECT_FILES } from '../../../src/lib/constants.js';
import { getLanguageFromPath } from '../../../src/lib/utils.js';

// --- Node has no localStorage; the stores guard for that, but persisting for
// real exercises the save/restore path the app actually runs. ---------------
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
    key: (i) => Array.from(backing.keys())[i] ?? null,
    get length() {
      return backing.size;
    },
  };
}

/**
 * A stand-in for one store-owned object (a tab, a block) that always reflects
 * the store's CURRENT copy of it. `read()` re-resolves it by id on each access,
 * so `const tab = app.getActiveTerminalTab()` stays correct after the store has
 * replaced `tab` several times over.
 */
function liveView(read) {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const target = read();
        if (!target) return undefined;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has: (_t, prop) => {
        const target = read();
        return target ? prop in target : false;
      },
      ownKeys: () => {
        const target = read();
        return target ? Reflect.ownKeys(target) : [];
      },
      getOwnPropertyDescriptor: (_t, prop) => {
        const target = read();
        if (!target) return undefined;
        const desc = Reflect.getOwnPropertyDescriptor(target, prop);
        return desc ? { ...desc, configurable: true } : undefined;
      },
    }
  );
}

/**
 * Record every command that reaches the mock backend.
 *
 * The wrapper goes on the singleton itself, not on the harness's own handle,
 * because the calls worth asserting on are the ones the STORES make —
 * `closeTab`'s `pty_kill`, `saveFile`'s `fs_write_file`. `src/lib/ipc.js`
 * resolves `mockBridge.invoke` per call, so patching the instance sees them
 * all, and production code carries no test scaffolding.
 */
function installRecorder(bridge) {
  if (bridge.__ntRecorder) return;
  const original = bridge.invoke.bind(bridge);
  bridge.__ntCalls = [];
  bridge.invoke = (command, args = {}) => {
    bridge.__ntCalls.push({ command, args, at: Date.now() });
    return original(command, args);
  };
  bridge.__ntRecorder = true;
}

/** The mock backend, plus the call log and the fields tests reach into. */
class RecordingBridge {
  constructor(bridge) {
    this.bridge = bridge;
  }

  get calls() {
    return this.bridge.__ntCalls;
  }

  get files() {
    return this.bridge.files;
  }

  get directories() {
    return this.bridge.directories;
  }

  get ptySessions() {
    return this.bridge.ptySessions;
  }

  async invoke(command, args = {}) {
    return this.bridge.invoke(command, args);
  }

  listen(event, callback) {
    return this.bridge.listen(event, callback);
  }

  emit(event, payload) {
    return this.bridge.emit(event, payload);
  }

  /** Every `invoke` of `command` so far, oldest first. */
  getCalls(command) {
    return this.calls.filter((c) => c.command === command);
  }
}

/** Put the mock backend back to a just-launched state. */
function resetBridge(bridge) {
  installRecorder(bridge);
  bridge.__ntCalls.length = 0;
  bridge.sessionCounter = 1;
  bridge.ptySessions.clear();
  bridge.eventListeners.clear();
  bridge.files = new Map(Object.entries(DEFAULT_PROJECT_FILES));
  bridge.directories = new Set(['/workspace', '/workspace/src', '/workspace/tests']);
}

export class AppEnvironment {
  constructor() {
    // Drop the previous case's listeners and pending persist timer before the
    // backend forgets the sessions those listeners were about.
    try {
      useTerminalStore.getState().dispose();
      useEditorStore.getState().dispose();
    } catch (_) {
      // first construction — nothing attached yet
    }
    globalThis.localStorage.clear();
    resetBridge(mockBridge);

    useTerminalStore.setState({
      tabs: [],
      activeTabId: null,
      history: [],
      historyIndex: -1,
      cwd: '/workspace',
      isInitialized: false,
      savedGroups: [],
      savedWorkspaces: [],
      workspaceName: 'Default',
    });
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      fileTree: [],
      rootPath: '/workspace',
      expandedFolders: new Set(['/workspace']),
      diffView: null,
      pendingClose: null,
      pendingOverwrite: null,
    });
    useSettingsStore.setState({
      isCommandPaletteOpen: false,
      commandPaletteMode: 'all',
      activeView: 'terminal',
    });

    this.ipc = new RecordingBridge(mockBridge);

    // The app is dark-only — light mode was removed, so these are constants
    // and there is deliberately no setTheme/toggleTheme to call.
    this.theme = 'dark';
    this.monacoTheme = 'nexterm-dark';
  }

  get terminal() {
    return useTerminalStore.getState();
  }

  get editor() {
    return useEditorStore.getState();
  }

  async initialize() {
    await this.terminal.init();
    await this.editor.init();
  }

  destroy() {
    this.terminal.dispose();
    this.editor.dispose();
  }

  // --- TERMINAL ------------------------------------------------------------

  /** Live views of every terminal tab, in store order. */
  get terminalTabs() {
    return this.terminal.tabs.map((t) => this.#liveTab(t.id));
  }

  get activeTerminalTabId() {
    return this.terminal.activeTabId;
  }

  #liveTab(tabId) {
    return liveView(() => useTerminalStore.getState().tabs.find((t) => t.id === tabId) || null);
  }

  #liveBlock(tabId, blockId) {
    return liveView(() => {
      const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
      return tab ? tab.blocks.find((b) => b.id === blockId) || null : null;
    });
  }

  getActiveTerminalTab() {
    const tab = this.terminal.getActiveTab();
    return tab ? this.#liveTab(tab.id) : null;
  }

  async createTerminalTab(title = null) {
    const tab = await this.terminal.createTab(title);
    return tab ? this.#liveTab(tab.id) : null;
  }

  switchTerminalTab(tabId) {
    if (!this.terminal.tabs.some((t) => t.id === tabId)) {
      throw new Error(`Terminal tab not found: ${tabId}`);
    }
    this.terminal.switchTab(tabId);
  }

  async closeTerminalTab(tabId) {
    await this.terminal.closeTab(tabId);
  }

  async executeTerminalCommand(commandText, tabId = null) {
    const targetId = tabId || this.terminal.activeTabId;
    const block = await this.terminal.executeCommand(commandText, tabId);
    return block ? this.#liveBlock(targetId, block.id) : null;
  }

  pinBlock(blockId) {
    const found = this.terminal.tabs.some((t) => t.blocks.some((b) => b.id === blockId));
    if (!found) throw new Error(`Block not found: ${blockId}`);
    return this.terminal.pinBlock(blockId);
  }

  clearTerminalBlocks(tabId = null) {
    this.terminal.clearBlocks(tabId);
  }

  // --- MONACO EDITOR -------------------------------------------------------

  get editorTabs() {
    return this.editor.tabs.map((t) => this.#liveEditorTab(t.id));
  }

  get activeEditorTabId() {
    return this.editor.activeTabId;
  }

  #liveEditorTab(tabId) {
    return liveView(() => useEditorStore.getState().tabs.find((t) => t.id === tabId) || null);
  }

  /**
   * `useEditorStore.openFile` swallows a read failure and returns null so the
   * UI does not crash on a file that vanished; the harness surfaces it so the
   * boundary cases can assert on the backend's own error.
   */
  async openFile(filePath) {
    const already = this.editor.tabs.some((t) => t.filePath === filePath);
    if (!already) {
      await this.ipc.invoke('fs_read_file', { path: filePath });
    }
    const tab = await this.editor.openFile(filePath);
    if (!tab) throw new Error(`File not found: ${filePath}`);
    return this.#liveEditorTab(tab.id);
  }

  editBuffer(tabId, newContent) {
    if (!this.editor.tabs.some((t) => t.id === tabId)) {
      throw new Error(`Editor tab not found: ${tabId}`);
    }
    this.editor.editBuffer(tabId, newContent);
  }

  async saveFile(tabId = null) {
    const targetId = tabId || this.editor.activeTabId;
    if (!this.editor.tabs.some((t) => t.id === targetId)) {
      throw new Error('No active editor tab to save');
    }
    await this.editor.saveFile(targetId);
  }

  closeEditorTab(tabId) {
    this.editor.closeTab(tabId);
  }

  getActiveEditorTab() {
    const tab = this.editor.getActiveTab();
    return tab ? this.#liveEditorTab(tab.id) : null;
  }

  /** The language Monaco is handed for a path — same rule the editor uses. */
  languageFor(filePath) {
    return getLanguageFromPath(filePath);
  }

  // --- EXPLORER ------------------------------------------------------------

  /** The nested tree, exactly as `fs_read_dir` returns it. */
  get explorerTree() {
    return this.editor.fileTree;
  }

  get expandedFolders() {
    return this.editor.expandedFolders;
  }

  async refreshExplorer() {
    await this.editor.refreshExplorer();
    return this.editor.fileTree;
  }

  toggleFolder(folderPath) {
    this.editor.toggleFolder(folderPath);
  }

  // --- COMMAND PALETTE (⌘K) ------------------------------------------------

  get paletteOpen() {
    return useSettingsStore.getState().isCommandPaletteOpen;
  }

  get paletteQuery() {
    return this._paletteQuery || '';
  }

  openCommandPalette(mode = 'all') {
    this._paletteQuery = '';
    useSettingsStore.getState().setCommandPaletteOpen(true, mode);
  }

  closeCommandPalette() {
    this._paletteQuery = '';
    useSettingsStore.getState().setCommandPaletteOpen(false);
  }

  /**
   * What the palette would show for `query`, flattened into the two groups the
   * tests name. Backed by `src/lib/paletteItems.js` — the same call the
   * component makes.
   */
  searchPalette(query) {
    this._paletteQuery = query;
    const groups = buildPaletteGroups({
      fileTree: this.editor.fileTree,
      query,
      mode: useSettingsStore.getState().commandPaletteMode,
    });
    const itemsOf = (label) => groups.find((g) => g.label === label)?.items || [];
    return { files: itemsOf('files'), commands: itemsOf('commands') };
  }

  /** Run one palette row, mirroring `CommandPalette`'s dispatch. */
  async executePaletteItem(item) {
    this.closeCommandPalette();
    if (!item) return null;
    if (item.type === 'file') {
      return this.openFile(item.path);
    }
    switch (item.command) {
      case 'new_terminal': {
        const tab = await this.terminal.createTab();
        return tab ? this.#liveTab(tab.id) : null;
      }
      case 'clear_terminal':
        this.terminal.clearBlocks();
        return null;
      case 'save_all':
        await this.editor.saveAll();
        return null;
      default:
        return null;
    }
  }
}
