import React, { useCallback } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalView } from './TerminalView.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const paneHeaderBtn =
  'p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

/**
 * A single terminal pane (leaf node in the split tree).
 * Renders its own tab strip and a persistent xterm surface for whichever
 * tab is bound to it — a real terminal, not a block list with a separate
 * input. The xterm instance itself is owned by `TerminalView`/the module
 * -level registry, so switching which tab a pane shows never loses either
 * side's scrollback.
 */
function TerminalPane({ paneId, tabId, onSplitH, onSplitV, onClose, canClose }) {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);

  const isActivePane = activePaneId === paneId;

  // This pane shows the tab bound to it, or falls back to active tab
  const boundTab = tabs.find((t) => t.id === tabId) || tabs.find((t) => t.id === activeTabId) || tabs[0] || null;

  return (
    <div
      onMouseDown={() => setActivePane(paneId)}
      onFocusCapture={() => setActivePane(paneId)}
      className={cn(
        'flex flex-col h-full w-full bg-vsc-terminal overflow-hidden',
        isActivePane && 'ring-1 ring-inset ring-vsc-focus'
      )}
    >
      {/* Pane header: bound-tab chips + split / close controls */}
      <div className="h-7 shrink-0 flex items-center bg-vsc-panel border-b border-vsc-border select-none">
        <div className="flex-1 flex items-center gap-0.5 px-1 h-full overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === (boundTab?.id);
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  bindPaneToTab(paneId, tab.id);
                  switchTab(tab.id);
                }}
                className={cn(
                  'flex items-center px-2 h-[22px] rounded-sm text-ui-sm whitespace-nowrap transition-colors',
                  isActive
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                    : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover'
                )}
              >
                <span className="truncate max-w-[100px]">{tab.title}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-0.5 px-1 shrink-0">
          <button type="button" onClick={onSplitH} className={paneHeaderBtn} title={`Split Right (${chord('mod', 'd')})`}>
            <SplitSquareHorizontal size={14} />
          </button>
          <button type="button" onClick={onSplitV} className={paneHeaderBtn} title={`Split Down (${chord('mod', 'shift', 'd')})`}>
            <SplitSquareVertical size={14} />
          </button>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className={cn(paneHeaderBtn, 'hover:text-vsc-error')}
              title={`Close Pane (${chord("mod", "w")})`}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Live terminal surface */}
      <div className="flex-1 overflow-hidden">
        {boundTab ? (
          <TerminalView tabId={boundTab.id} active={isActivePane} />
        ) : (
          <div className="h-full flex items-center justify-center text-ui-sm text-vsc-muted select-none">
            No terminal
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Recursively renders the split tree.
 * Each node is either a "leaf" (terminal pane) or a "split" (horizontal/vertical with children).
 */
function SplitNode({ node, onSplit, onClose, canClose }) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        paneId={node.id}
        tabId={node.tabId}
        onSplitH={() => onSplit(node.id, 'horizontal')}
        onSplitV={() => onSplit(node.id, 'vertical')}
        onClose={() => onClose(node.id)}
        canClose={canClose}
      />
    );
  }

  // It's a split node
  const direction = node.direction; // 'horizontal' | 'vertical'
  return (
    <Group orientation={direction} className="h-full w-full">
      {node.children.map((child, i) => (
        <React.Fragment key={child.id}>
          {i > 0 && <Separator className={direction === 'horizontal' ? 'w-px' : 'h-px'} />}
          <Panel minSize="15" defaultSize={String(100 / node.children.length)}>
            <SplitNode node={child} onSplit={onSplit} onClose={onClose} canClose={true} />
          </Panel>
        </React.Fragment>
      ))}
    </Group>
  );
}

/**
 * Top-level container for the terminal split system.
 * Manages the split tree state and delegates rendering to SplitNode.
 */
export function TerminalSplitContainer() {
  const splitTree = useTerminalStore((s) => s.splitTree);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);

  const handleSplit = useCallback((paneId, direction) => {
    splitPane(paneId, direction);
  }, [splitPane]);

  const handleClose = useCallback((paneId) => {
    closePane(paneId);
  }, [closePane]);

  if (!splitTree) {
    return null;
  }

  const canClose = splitTree.type !== 'leaf';

  return (
    <div className="h-full w-full overflow-hidden">
      <SplitNode
        node={splitTree}
        onSplit={handleSplit}
        onClose={handleClose}
        canClose={canClose}
      />
    </div>
  );
}

export default TerminalSplitContainer;
