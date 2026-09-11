import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  FileCode,
  Terminal,
  Sparkles,
  Sun,
  Plus,
  Save,
  Cpu,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useAgentStore } from '../../stores/agentStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { fuzzyMatch, cn } from '../../lib/utils.js';

export function CommandPalette() {
  const isOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const setOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const fileTree = useEditorStore((s) => s.fileTree);
  const openFile = useEditorStore((s) => s.openFile);
  const saveAll = useEditorStore((s) => s.saveAll);

  const createTerminalTab = useTerminalStore((s) => s.createTab);
  const clearTerminalBlocks = useTerminalStore((s) => s.clearBlocks);

  const setNewAgentModalOpen = useAgentStore((s) => s.setNewAgentModalOpen);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const [query, setQuery] = useState('');

  const paletteMode = useSettingsStore((st) => st.commandPaletteMode);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Build items list
  const q = query.toLowerCase().trim();

  // 1. Files
  const fileItems = fileTree
    .filter((node) => !node.is_dir)
    .filter((node) => fuzzyMatch(q, node.path) || fuzzyMatch(q, node.name))
    .map((node) => ({
      type: 'file',
      hint: 'File',
      id: `file-${node.path}`,
      title: node.name,
      subtitle: node.path,
      icon: <FileCode size={16} />,
      action: async () => {
        await openFile(node.path);
        setActiveView('editor');
      },
    }));

  // 2. Built-in Commands
  const commandItems = [
    {
      type: 'command',
      hint: '⌘K',
      id: 'cmd-switch-theme',
      title: 'Switch Dark / Light Theme',
      subtitle: 'Toggles global theme color palette',
      icon: <Sun size={16} />,
      action: () => toggleTheme(),
    },
    {
      type: 'command',
      hint: '⌃⇧`',
      id: 'cmd-new-terminal',
      title: 'New Terminal Tab',
      subtitle: 'Spawns a new independent PTY terminal session',
      icon: <Terminal size={16} />,
      action: async () => {
        await createTerminalTab();
        setActiveView('terminal');
      },
    },
    {
      type: 'command',
      hint: '⌘L',
      id: 'cmd-clear-terminal',
      title: 'Clear Terminal Output',
      subtitle: 'Purges unpinned blocks in current terminal tab',
      icon: <Terminal size={16} />,
      action: () => clearTerminalBlocks(),
    },
    {
      type: 'command',
      hint: '',
      id: 'cmd-new-agent',
      title: 'Deploy New Agent',
      subtitle: 'Opens modal to create and launch an autonomous agent',
      icon: <Plus size={16} />,
      action: () => {
        setNewAgentModalOpen(true);
        setActiveView('agents');
      },
    },
    {
      type: 'command',
      hint: '⌘S',
      id: 'cmd-save-all',
      title: 'Save All Files',
      subtitle: 'Writes all dirty editor buffers to disk',
      icon: <Save size={16} />,
      action: async () => await saveAll(),
    },
  ].filter((cmd) => fuzzyMatch(q, cmd.title) || fuzzyMatch(q, cmd.subtitle));

  // 3. AI Actions
  const aiItems = [
    {
      type: 'ai_action',
      hint: 'AI',
      id: 'ai-explain-error',
      title: 'Explain Terminal Error with AI',
      subtitle: 'Analyze failure stack trace and suggest fixes',
      icon: <Sparkles size={16} />,
      action: () => {
        setActiveView('chat');
        sendMessage('agent-architect-01', 'Explain the most recent terminal error and provide the solution.');
      },
    },
    {
      type: 'ai_action',
      hint: 'AI',
      id: 'ai-generate-tests',
      title: 'Generate E2E Tests',
      subtitle: 'Prompt AI Test Engineer to draft test cases',
      icon: <Cpu size={16} />,
      action: () => {
        setActiveView('chat');
        sendMessage('agent-test-eng-02', 'Generate comprehensive test cases for our recent code changes.');
      },
    },
  ].filter((ai) => fuzzyMatch(q, ai.title) || fuzzyMatch(q, ai.subtitle));

  const groups = [
    { label: 'files', items: fileItems },
    { label: 'commands', items: commandItems },
    { label: 'ai actions', items: aiItems },
  ]
    .filter((g) => g.items.length > 0)
    .filter((g) => paletteMode === 'all' || g.label === 'files');

  const allFiltered = [...fileItems, ...commandItems, ...aiItems];

  const handleSelect = async (item) => {
    if (!item) return;
    setOpen(false);
    try {
      await item.action();
    } catch (err) {
      console.error('Error executing palette item:', err);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, allFiltered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + allFiltered.length) % Math.max(1, allFiltered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allFiltered[selectedIndex]) {
        handleSelect(allFiltered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  let runningIndex = -1;

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-[8px] left-1/2 -translate-x-1/2 w-[600px] max-w-[90vw] bg-vsc-quickinput border border-vsc-widget-border shadow-widget rounded-[6px] overflow-hidden"
      >
        {/* Search Input Bar */}
        <div className="p-2 border-b border-vsc-widget-border">
          <div className="flex items-center gap-2 h-[30px] px-2 rounded-[3px] bg-vsc-input border border-vsc-input-border focus-within:border-vsc-focus transition-colors">
            <Search size={16} className="text-vsc-muted flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={paletteMode === 'files' ? 'Search files by name…' : 'Type a command or search files…'}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-ui text-vsc-fg placeholder:text-vsc-placeholder"
            />
          </div>
        </div>

        {/* Results List */}
        <div className="max-h-[400px] overflow-auto py-1">
          {groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.label}>
                <div className="px-2 h-[22px] flex items-center text-ui-sm text-vsc-muted uppercase tracking-wide">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={item.id}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={cn(
                        'h-[22px] px-2 flex items-center gap-2 text-ui cursor-pointer',
                        isSelected ? 'bg-vsc-selection text-vsc-selection-fg' : 'text-vsc-fg'
                      )}
                    >
                      <span className="flex-shrink-0">{item.icon}</span>
                      <span className="truncate">{item.title}</span>
                      {item.subtitle && (
                        <span
                          className={cn(
                            'truncate text-ui-sm flex-shrink',
                            isSelected ? 'text-vsc-selection-fg' : 'text-vsc-muted'
                          )}
                        >
                          {item.subtitle}
                        </span>
                      )}
                      <span className="flex-1" />
                      {item.hint && (
                        <kbd className="flex-shrink-0 bg-vsc-button-secondary border border-vsc-border rounded-sm px-1 font-mono text-ui-sm text-vsc-muted">
                          {item.hint}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="py-8 text-center text-vsc-muted text-ui-sm italic">
              No matching commands or files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
