import React from 'react';
import { Plus, X, Terminal } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { cn } from '../../lib/utils.js';

export function TerminalTabs() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const createTab = useTerminalStore((s) => s.createTab);

  return (
    <div className="flex items-center h-[22px] bg-vsc-panel border-b border-vsc-border overflow-x-auto select-none">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            className={cn(
              'group flex items-center gap-1.5 h-full px-2 text-ui-sm cursor-default border-r border-vsc-border whitespace-nowrap',
              isActive
                ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover'
            )}
          >
            <Terminal size={12} className="opacity-70 shrink-0" />
            <span className="truncate max-w-[120px]">{tab.title}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:bg-vsc-item-hover rounded-sm p-0.5 transition-opacity"
                title="Close Tab"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => createTab()}
        className="h-full px-2 flex items-center text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors"
        title="New Terminal Tab (⌃⇧`)"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export default TerminalTabs;
