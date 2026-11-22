import React from 'react';
import { Search, PanelLeft, PanelBottom, PanelRight } from 'lucide-react';
import { APP_NAME } from '../../lib/constants.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { isMac } from '../../lib/platform.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';
import { basename } from '../../lib/paths.js';
import { MenuBar } from './MenuBar.jsx';
import { WindowControls } from './WindowControls.jsx';

const layoutButton =
  'w-6 h-6 flex items-center justify-center rounded transition-colors';

export function TitleBar() {
  const { shortcut } = useShortcuts();
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const sidebarVisible = useSettingsStore((s) => s.sidebarVisible);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const secondarySidebarVisible = useSettingsStore((s) => s.secondarySidebarVisible);
  const toggleSecondarySidebar = useSettingsStore((s) => s.toggleSecondarySidebar);
  // Null until the backend has been asked, and while no folder is open.
  const rootPath = useEditorStore((s) => (s.rootResolved ? s.rootPath : null));

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
      {/* Left: menu (own-drawn off macOS) + app name + workspace folder.
          Capped so it ends 8px before the pill, which is centred on the whole
          bar and clamp(180px, 38%, 600px) of it wide: the cap is that, worked
          out in this row's own percentages (its content box, the bar less
          its padding) — 50% + (left pad + right pad) / 2 - half the pill
          - 8px - left pad. A long folder name truncates there, its whole path
          in the tooltip, instead of running under the pill. */}
      <div
        className={cn(
          'relative z-10 flex items-center gap-2 min-w-0',
          isMac
            ? 'max-w-[calc(50%_-_clamp(90px,_19%_+_17.1px,_300px)_-_41px)]'
            : 'max-w-[calc(50%_-_clamp(90px,_19%_+_1.52px,_300px)_-_12px)]'
        )}
      >
        {!isMac && <MenuBar />}
        <span className="shrink-0 font-medium text-vsc-fg whitespace-nowrap">{APP_NAME}</span>
        {workspaceName && (
          <>
            <span className="shrink-0 text-vsc-muted">—</span>
            <span className="min-w-0 text-vsc-muted truncate" title={rootPath}>{workspaceName}</span>
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
          className="ui-field pointer-events-auto flex items-center justify-center gap-2 h-[22px] w-[38%] min-w-[180px] max-w-[600px] px-2 text-vsc-muted text-ui-sm hover:text-vsc-fg transition-colors"
        >
          <Search size={14} className="shrink-0" />
          <span className="min-w-0 truncate">Search NexTerm ({shortcut('command-palette')})</span>
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
