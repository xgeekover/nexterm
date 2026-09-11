import React from 'react';
import { X, Circle, FileCode2, FileJson, FileText, File } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

function getTabIcon(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const className = 'text-vsc-muted shrink-0';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return <FileCode2 size={14} className={className} />;
    case 'json':
      return <FileJson size={14} className={className} />;
    case 'md':
    case 'txt':
      return <FileText size={14} className={className} />;
    default:
      return <File size={14} className={className} />;
  }
}

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);
  const closeTab = useEditorStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center h-tab bg-vsc-tab-inactive border-b border-vsc-border overflow-x-auto select-none">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            onMouseDown={(e) => {
              // Middle-click closes the tab.
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            title={tab.filePath}
            className={cn(
              'group relative flex items-center gap-2 h-tab px-3 text-ui border-r border-vsc-border cursor-pointer shrink-0',
              isActive
                ? 'bg-vsc-tab-active text-vsc-tab-active-fg shadow-[inset_0_1px_0_0_var(--vsc-focus)]'
                : 'text-vsc-tab-inactive-fg hover:text-vsc-tab-active-fg'
            )}
          >
            {getTabIcon(tab.fileName)}
            <span className="truncate max-w-[160px]">{tab.fileName}</span>

            <div className="relative flex items-center justify-center w-3.5 h-3.5 shrink-0">
              {tab.isDirty && (
                <Circle size={14} className="fill-vsc-fg text-vsc-fg group-hover:hidden" />
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                title={`Close (${chord('mod', 'w')})`}
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-sm hover:bg-vsc-item-hover',
                  tab.isDirty
                    ? 'hidden group-hover:flex'
                    : cn('opacity-0 group-hover:opacity-100', isActive && 'opacity-100')
                )}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default EditorTabs;
