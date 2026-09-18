import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  FileCode,
  Terminal,
  Save,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { cn } from '../../lib/utils.js';
import { buildPaletteGroups } from '../../lib/paletteItems.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';

export function CommandPalette() {
  const isOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const setOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const fileTree = useEditorStore((s) => s.fileTree);
  const openFile = useEditorStore((s) => s.openFile);
  const saveAll = useEditorStore((s) => s.saveAll);

  const createTerminalTab = useTerminalStore((s) => s.createTab);
  const clearTerminalBlocks = useTerminalStore((s) => s.clearBlocks);

  const [query, setQuery] = useState('');

  const paletteMode = useSettingsStore((st) => st.commandPaletteMode);
  // So a row never advertises a shortcut the user has rebound.
  const { bindings } = useShortcuts();
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

  // The result rows and the order the arrow keys walk them both come from
  // `buildPaletteGroups` (src/lib/paletteItems.js), so the selection can never
  // run past the last visible row onto an item the user cannot see.
  const groups = buildPaletteGroups({ fileTree, query, mode: paletteMode, bindings });
  const allFiltered = groups.flatMap((g) => g.items);

  const iconFor = (item) => {
    if (item.type === 'file') return <FileCode size={16} />;
    if (item.command === 'save_all') return <Save size={16} />;
    return <Terminal size={16} />;
  };

  const runItem = async (item) => {
    if (item.type === 'file') {
      await openFile(item.path);
      setActiveView('editor');
      return;
    }
    switch (item.command) {
      case 'new_terminal':
        await createTerminalTab();
        setActiveView('terminal');
        return;
      case 'clear_terminal':
        clearTerminalBlocks();
        return;
      case 'save_all':
        await saveAll();
        return;
      default:
        return;
    }
  };

  const handleSelect = async (item) => {
    if (!item) return;
    setOpen(false);
    try {
      await runItem(item);
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
                      <span className="flex-shrink-0">{iconFor(item)}</span>
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
