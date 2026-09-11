import React from 'react';
import { Search, PanelLeft, PanelBottom, PanelRight } from 'lucide-react';
import { APP_NAME } from '../../lib/constants.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const layoutButton =
  'w-6 h-6 flex items-center justify-center rounded transition-colors';

export function TitleBar() {
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const sidebarVisible = useSettingsStore((s) => s.sidebarVisible);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const secondarySidebarVisible = useSettingsStore((s) => s.secondarySidebarVisible);
  const toggleSecondarySidebar = useSettingsStore((s) => s.toggleSecondarySidebar);
  const rootPath = useEditorStore((s) => s.rootPath);

  const workspaceName = (rootPath || '').split('/').filter(Boolean).pop() || rootPath || '';

  return (
    <header
      data-tauri-drag-region
      className="h-[35px] shrink-0 flex items-center px-3 bg-vsc-titlebar border-b border-vsc-border select-none text-ui-sm"
    >
      {/* Left: app name + workspace folder */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="font-medium text-vsc-fg whitespace-nowrap">{APP_NAME}</span>
        {workspaceName && (
          <>
            <span className="text-vsc-muted">—</span>
            <span className="text-vsc-muted truncate">{workspaceName}</span>
          </>
        )}
      </div>

      {/* Center: command-center search pill */}
      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className="flex items-center justify-center gap-2 h-[22px] w-[38%] max-w-[600px] rounded-md bg-vsc-input border border-vsc-input-border text-vsc-muted text-ui-sm hover:text-vsc-fg transition-colors"
        >
          <Search size={14} />
          <span>Search NexTerm ({chord('mod', 'k')})</span>
        </button>
      </div>

      {/* Right: shell layout toggles */}
      <div className="flex-1 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={toggleSidebar}
          title="Toggle Primary Sidebar"
          className={cn(
            layoutButton,
            sidebarVisible ? 'text-vsc-fg bg-vsc-item-active' : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
          )}
        >
          <PanelLeft size={16} />
        </button>
        <button
          type="button"
          onClick={togglePanel}
          title="Toggle Panel"
          className={cn(
            layoutButton,
            panelVisible ? 'text-vsc-fg bg-vsc-item-active' : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
          )}
        >
          <PanelBottom size={16} />
        </button>
        <button
          type="button"
          onClick={() => toggleSecondarySidebar()}
          title="Toggle Secondary Sidebar"
          className={cn(
            layoutButton,
            secondarySidebarVisible ? 'text-vsc-fg bg-vsc-item-active' : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
          )}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}

export default TitleBar;
