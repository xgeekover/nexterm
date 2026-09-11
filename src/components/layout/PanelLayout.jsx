import React, { useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalSplitContainer } from '../terminal/TerminalSplitContainer.jsx';
import { EditorPanel } from '../editor/EditorPanel.jsx';
import { FileExplorer } from '../explorer/FileExplorer.jsx';
import { MissionControl } from '../agent/MissionControl.jsx';
import { ChatPanel } from '../chat/ChatPanel.jsx';
import {
  SquareSplitHorizontal,
  SquareSplitVertical,
  Plus,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';

const panelButton =
  'w-6 h-6 flex items-center justify-center rounded text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover active:bg-vsc-item-active transition-colors';

function TerminalPanelHeader({ maximized, onToggleMaximize }) {
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const splitActivePane = useTerminalStore((s) => s.splitActivePane);
  const createTab = useTerminalStore((s) => s.createTab);

  return (
    <div className="h-panel-header shrink-0 flex items-center justify-between border-b border-vsc-border pr-1.5 select-none">
      <div className="h-full flex items-center">
        <div className="h-full flex items-center px-3 text-ui-sm font-medium tracking-wide text-vsc-fg border-b border-vsc-focus -mb-px">
          TERMINAL
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className={panelButton}
          title="Split Terminal Right"
          onClick={() => splitActivePane?.('horizontal')}
        >
          <SquareSplitHorizontal size={16} />
        </button>
        <button
          type="button"
          className={panelButton}
          title="Split Terminal Down"
          onClick={() => splitActivePane?.('vertical')}
        >
          <SquareSplitVertical size={16} />
        </button>
        <button
          type="button"
          className={panelButton}
          title="New Terminal"
          onClick={() => createTab?.()}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className={panelButton}
          title={maximized ? 'Restore Panel Size' : 'Maximize Panel'}
          onClick={onToggleMaximize}
        >
          {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className={panelButton}
          title="Close Panel"
          onClick={() => togglePanel()}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export function PanelLayout() {
  const sidebarVisible = useSettingsStore((s) => s.sidebarVisible);
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const secondarySidebarVisible = useSettingsStore((s) => s.secondarySidebarVisible);
  const secondaryTab = useSettingsStore((s) => s.secondaryTab);

  const [panelMaximized, setPanelMaximized] = useState(false);

  return (
    <Group orientation="horizontal" className="flex-1 h-full w-full overflow-hidden">
      {sidebarVisible && (
        <>
          <Panel
            id="primary-sidebar"
            defaultSize={260}
            minSize={170}
            className="h-full overflow-hidden bg-vsc-sidebar"
          >
            <FileExplorer />
          </Panel>
          <Separator className="w-px" />
        </>
      )}

      <Panel id="center" minSize="20" className="h-full overflow-hidden">
        <Group orientation="vertical" className="h-full w-full overflow-hidden">
          <Panel id="editor-group" minSize="20" className="h-full overflow-hidden bg-vsc-editor">
            <EditorPanel />
          </Panel>

          {panelVisible && (
            <>
              <Separator className="h-px" />
              <Panel
                id="bottom-panel"
                defaultSize={panelMaximized ? '100' : '40'}
                minSize="15"
                className={cn(
                  'h-full overflow-hidden bg-vsc-panel flex flex-col'
                )}
              >
                <TerminalPanelHeader
                  maximized={panelMaximized}
                  onToggleMaximize={() => setPanelMaximized((m) => !m)}
                />
                <div className="flex-1 overflow-hidden">
                  <TerminalSplitContainer />
                </div>
              </Panel>
            </>
          )}
        </Group>
      </Panel>

      {secondarySidebarVisible && (
        <>
          <Separator className="w-px" />
          <Panel
            id="secondary-sidebar"
            defaultSize={320}
            minSize={220}
            className="h-full overflow-hidden bg-vsc-sidebar flex flex-col"
          >
            {secondaryTab === 'agents' ? <MissionControl /> : <ChatPanel />}
          </Panel>
        </>
      )}
    </Group>
  );
}

export default PanelLayout;
