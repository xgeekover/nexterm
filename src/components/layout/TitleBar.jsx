import React from 'react';
import { Search, PanelLeft, PanelBottom, PanelRight } from 'lucide-react';
import { APP_NAME } from '../../lib/constants.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { chord, isMac } from '../../lib/platform.js';
import { basename } from '../../lib/paths.js';
import { MenuBar } from './MenuBar.jsx';
import { WindowControls } from './WindowControls.jsx';

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

  // basename reads either separator; splitting on '/' kept the whole Windows path.
  const workspaceName = rootPath ? basename(rootPath) || rootPath : '';

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative h-[35px] shrink-0 flex items-stretch bg-vsc-titlebar border-b border-vsc-border select-none text-ui-sm",
        // macOS draws the traffic lights over the webview (titleBarStyle: Overlay),
        // so keep their corner clear instead of letting them cover our content.
        // Off macOS the window is frameless and this row is the whole title bar,
        // so the window buttons sit flush in the corner and only the left pads.
        isMac ? "pl-[78px] pr-3" : "pl-2"
      )}
    >
      {/* Left: menu (own-drawn off macOS) + app name + workspace folder */}
      <div className="relative z-10 flex items-center gap-2 min-w-0">
        {!isMac && <MenuBar />}
        <span className="font-medium text-vsc-fg whitespace-nowrap">{APP_NAME}</span>
        {workspaceName && (
          <>
            <span className="text-vsc-muted">—</span>
            <span className="text-vsc-muted truncate" title={rootPath}>{workspaceName}</span>
          </>
        )}
      </div>

      {/* Center: command-center search pill. Absolutely centred so it does not
          drift when the left side grows a menu bar or a long workspace name;
          pointer-events-none on the wrapper keeps the rest of the row draggable. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className="pointer-events-auto flex items-center justify-center gap-2 h-[22px] w-[38%] max-w-[600px] rounded-md bg-vsc-input border border-vsc-input-border text-vsc-muted text-ui-sm hover:text-vsc-fg transition-colors"
        >
          <Search size={14} />
          <span>Search NexTerm ({chord('mod', 'k')})</span>
        </button>
      </div>

      {/* Right: shell layout toggles, then the window buttons off macOS */}
      <div className="relative z-10 ml-auto flex items-center gap-1">
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
        {!isMac && <div className="w-1" />}
      </div>

      {!isMac && <WindowControls />}
    </header>
  );
}

export default TitleBar;
