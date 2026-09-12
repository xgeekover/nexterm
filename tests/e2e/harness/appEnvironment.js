import { MockIpcBridge } from './mockIpc.js';

export class AppEnvironment {
  constructor(ipc = null) {
    this.ipc = ipc || new MockIpcBridge();

    // Theme state
    this.theme = 'dark';
    this.monacoTheme = 'nexterm-dark';

    // Terminal subsystem
    this.terminalTabs = [];
    this.activeTerminalTabId = null;

    // Editor subsystem
    this.editorTabs = [];
    this.activeEditorTabId = null;

    // Explorer subsystem
    this.explorerTree = [];
    this.expandedFolders = new Set(['/workspace']);

    // Mission Control subsystem
    this.agentLogs = new Map();

    // AI Chat subsystem
    this.chatContext = null;
    this.byokSettings = {
      openaiKey: '',
      claudeKey: '',
      geminiKey: '',
    };

    // Command Palette subsystem
    this.paletteOpen = false;
    this.paletteQuery = '';

    // Event unlisteners
    this.unlisteners = [];
  }

  async initialize() {
    // 1. Initial terminal tab
    const ptySession = await this.ipc.invoke('pty_spawn', {
      cols: 80,
      rows: 24,
      cwd: '/workspace',
      shell: '/bin/zsh',
    });

    const initialTab = {
      id: 'tab-term-1',
      title: 'Terminal 1',
      sessionId: ptySession.session_id,
      cwd: ptySession.cwd,
      blocks: [],
      activePrompt: '',
    };
    this.terminalTabs.push(initialTab);
    this.activeTerminalTabId = initialTab.id;

    // 2. Load Explorer tree
    await this.refreshExplorer();

    // 3. Load Agents

    // 4. Load Chat Messages

    // 5. Setup event subscriptions
    this.setupSubscriptions();
  }

  setupSubscriptions() {
    // pty-output
    const unlistenPtyOutput = this.ipc.listen('pty-output', (payload) => {
      const { session_id, data } = payload;
      for (const tab of this.terminalTabs) {
        if (tab.sessionId === session_id) {
          const currentBlock = tab.blocks.find((b) => b.status === 'running') || tab.blocks[tab.blocks.length - 1];
          if (currentBlock && currentBlock.status === 'running') {
            currentBlock.output += data;
          }
        }
      }
    });
    this.unlisteners.push(unlistenPtyOutput);

    // pty-exit
    const unlistenPtyExit = this.ipc.listen('pty-exit', (payload) => {
      const { session_id, exit_code } = payload;
      for (const tab of this.terminalTabs) {
        if (tab.sessionId === session_id) {
          const currentBlock = tab.blocks.find((b) => b.status === 'running');
          if (currentBlock && currentBlock.status === 'running') {
            currentBlock.status = exit_code === 0 ? 'completed' : 'failed';
            currentBlock.exitCode = exit_code;
            currentBlock.durationMs = Date.now() - currentBlock.startTime;
          }
        }
      }
    });
    this.unlisteners.push(unlistenPtyExit);

    // agent-updated

    // chat-token
  }

  destroy() {
    for (const unlisten of this.unlisteners) {
      if (typeof unlisten === 'function') unlisten();
    }
  }

  // --- THEME ---
  setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') {
      throw new Error(`Invalid theme: ${theme}`);
    }
    this.theme = theme;
    this.monacoTheme = theme === 'dark' ? 'nexterm-dark' : 'nexterm-light';
  }

  toggleTheme() {
    this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
  }

  // --- TERMINAL ---
  async createTerminalTab(title = null) {
    const ptySession = await this.ipc.invoke('pty_spawn', {
      cols: 80,
      rows: 24,
      cwd: '/workspace',
      shell: '/bin/zsh',
    });
    const tabId = `tab-term-${this.terminalTabs.length + 1}`;
    const newTab = {
      id: tabId,
      title: title || `Terminal ${this.terminalTabs.length + 1}`,
      sessionId: ptySession.session_id,
      cwd: ptySession.cwd,
      blocks: [],
      activePrompt: '',
    };
    this.terminalTabs.push(newTab);
    this.activeTerminalTabId = tabId;
    return newTab;
  }

  switchTerminalTab(tabId) {
    const tab = this.terminalTabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`Terminal tab not found: ${tabId}`);
    this.activeTerminalTabId = tabId;
  }

  async closeTerminalTab(tabId) {
    const idx = this.terminalTabs.findIndex((t) => t.id === tabId);
    if (idx >= 0) {
      const tab = this.terminalTabs[idx];
      await this.ipc.invoke('pty_kill', { session_id: tab.sessionId });
      this.terminalTabs.splice(idx, 1);
      if (this.activeTerminalTabId === tabId) {
        this.activeTerminalTabId = this.terminalTabs[0]?.id || null;
      }
    }
  }

  getActiveTerminalTab() {
    return this.terminalTabs.find((t) => t.id === this.activeTerminalTabId) || null;
  }

  async executeTerminalCommand(commandText, tabId = null) {
    const targetTab = tabId
      ? this.terminalTabs.find((t) => t.id === tabId)
      : this.getActiveTerminalTab();

    if (!targetTab) throw new Error('No active terminal tab');

    const trimmed = (commandText || '').trim();
    if (!trimmed) {
      // Empty commands should not create empty running blocks
      return null;
    }

    const blockId = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const block = {
      id: blockId,
      command: trimmed,
      output: '',
      exitCode: null,
      durationMs: 0,
      startTime: Date.now(),
      status: 'running',
      pinned: false,
    };
    targetTab.blocks.push(block);

    await this.ipc.invoke('pty_write', {
      session_id: targetTab.sessionId,
      data: `${trimmed}\n`,
    });

    return block;
  }

  pinBlock(blockId) {
    for (const tab of this.terminalTabs) {
      const block = tab.blocks.find((b) => b.id === blockId);
      if (block) {
        block.pinned = !block.pinned;
        return block.pinned;
      }
    }
    throw new Error(`Block not found: ${blockId}`);
  }

  clearTerminalBlocks(tabId = null) {
    const targetTab = tabId
      ? this.terminalTabs.find((t) => t.id === tabId)
      : this.getActiveTerminalTab();
    if (targetTab) {
      // Retain pinned blocks
      targetTab.blocks = targetTab.blocks.filter((b) => b.pinned);
    }
  }

  // --- MONACO EDITOR ---
  async openFile(filePath) {
    // Check if already open
    const existing = this.editorTabs.find((t) => t.filePath === filePath);
    if (existing) {
      this.activeEditorTabId = existing.id;
      return existing;
    }

    const content = await this.ipc.invoke('fs_read_file', { path: filePath });
    const ext = filePath.split('.').pop();
    const languageMap = {
      js: 'javascript',
      jsx: 'javascript',
      json: 'json',
      rs: 'rust',
      md: 'markdown',
      py: 'python',
      html: 'html',
      css: 'css',
    };

    const tabId = `tab-edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tab = {
      id: tabId,
      filePath,
      fileName: filePath.split('/').pop(),
      content,
      savedContent: content,
      isDirty: false,
      language: languageMap[ext] || 'plaintext',
    };

    this.editorTabs.push(tab);
    this.activeEditorTabId = tabId;
    return tab;
  }

  editBuffer(tabId, newContent) {
    const tab = this.editorTabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`Editor tab not found: ${tabId}`);
    tab.content = newContent;
    tab.isDirty = tab.content !== tab.savedContent;
  }

  async saveFile(tabId = null) {
    const targetTabId = tabId || this.activeEditorTabId;
    const tab = this.editorTabs.find((t) => t.id === targetTabId);
    if (!tab) throw new Error(`No active editor tab to save`);

    await this.ipc.invoke('fs_write_file', {
      path: tab.filePath,
      content: tab.content,
    });
    tab.savedContent = tab.content;
    tab.isDirty = false;
  }

  closeEditorTab(tabId) {
    const idx = this.editorTabs.findIndex((t) => t.id === tabId);
    if (idx >= 0) {
      this.editorTabs.splice(idx, 1);
      if (this.activeEditorTabId === tabId) {
        this.activeEditorTabId = this.editorTabs[0]?.id || null;
      }
    }
  }

  getActiveEditorTab() {
    return this.editorTabs.find((t) => t.id === this.activeEditorTabId) || null;
  }

  // --- EXPLORER ---
  async refreshExplorer() {
    this.explorerTree = await this.ipc.invoke('fs_read_dir', {
      path: '/workspace',
      max_depth: 5,
    });
    return this.explorerTree;
  }

  toggleFolder(folderPath) {
    if (this.expandedFolders.has(folderPath)) {
      this.expandedFolders.delete(folderPath);
    } else {
      this.expandedFolders.add(folderPath);
    }
  }

  // --- MISSION CONTROL ---

  getTelemetry() {
    let totalTokens = 0;
    let totalCost = 0;
    let activeCount = 0;
    let waitingCount = 0;

    return {
      totalTokens,
      totalCost,
      activeCount,
      waitingCount,
    };
  }

  // --- AI CHAT ---

  attachContext(contextObj) {
    this.chatContext = contextObj;
  }

  clearContext() {
    this.chatContext = null;
  }

  setByokKey(provider, key) {
    this.byokSettings[provider] = key;
  }

  // --- COMMAND PALETTE (⌘K) ---
  openCommandPalette() {
    this.paletteOpen = true;
    this.paletteQuery = '';
  }

  closeCommandPalette() {
    this.paletteOpen = false;
    this.paletteQuery = '';
  }

  searchPalette(query) {
    this.paletteQuery = query;
    const q = (query || '').toLowerCase().trim();

    const files = Array.from(this.ipc.files.keys())
      .filter((p) => p.toLowerCase().includes(q))
      .map((p) => ({
        type: 'file',
        title: p.split('/').pop(),
        path: p,
      }));

    const commands = [
      { type: 'command', id: 'cmd_toggle_term', title: 'Toggle Terminal', action: 'toggle_terminal' },
      { type: 'command', id: 'cmd_new_agent', title: 'New Agent', action: 'new_agent' },
      { type: 'command', id: 'cmd_switch_theme', title: 'Switch Dark/Light Theme', action: 'switch_theme' },
      { type: 'command', id: 'cmd_save_all', title: 'Save All Files', action: 'save_all' },
    ].filter((c) => c.title.toLowerCase().includes(q));

    const aiActions = [
      { type: 'ai_action', id: 'ai_explain_error', title: 'Explain Error with AI', prompt: 'Explain this error' },
      { type: 'ai_action', id: 'ai_generate_tests', title: 'Generate E2E Tests', prompt: 'Generate test cases' },
    ].filter((a) => a.title.toLowerCase().includes(q));

    return { files, commands, aiActions };
  }

  async executePaletteItem(item) {
    let result = null;
    if (item.type === 'file') {
      result = await this.openFile(item.path);
    } else if (item.type === 'command') {
      if (item.action === 'switch_theme') {
        this.toggleTheme();
      } else if (item.action === 'new_agent') {
        // opens agent create modal or registers agent
      } else if (item.action === 'save_all') {
        for (const tab of this.editorTabs) {
          if (tab.isDirty) await this.saveFile(tab.id);
        }
      }
    } else if (item.type === 'ai_action') {
      result = await this.sendChatMessage('agent-architect-01', item.prompt);
    }
    this.closeCommandPalette();
    return result;
  }
}
