import React, { useCallback, useRef, useState, useEffect } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalBlock } from './TerminalBlock.jsx';
import { CommandInput } from './CommandInput.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const paneHeaderBtn =
  'p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

let cachedCell = null;
/** Width/height of one monospace character cell, measured once from the real font. */
function measureCell(container) {
  if (cachedCell) return cachedCell;
  const probe = document.createElement('span');
  probe.className = 'font-mono text-code';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  probe.textContent = 'W'.repeat(20);
  container.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  container.removeChild(probe);
  cachedCell = { width: rect.width / 20 || 7.2, height: rect.height || 18 };
  return cachedCell;
}

/**
 * A single terminal pane (leaf node in the split tree).
 * Renders its own tab strip, blocks, and command input —
 * scoped to its assigned tabId.
 */
function TerminalPane({ paneId, tabId, onSplitH, onSplitV, onClose, canClose }) {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const executeCommand = useTerminalStore((s) => s.executeCommand);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const writeRaw = useTerminalStore((s) => s.writeRaw);
  const resizePty = useTerminalStore((s) => s.resizePty);
  const blocksEndRef = useRef(null);
  const outputRef = useRef(null);

  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [paneHeight, setPaneHeight] = useState(0);

  const isActivePane = activePaneId === paneId;

  // This pane shows the tab bound to it, or falls back to active tab
  const boundTab = tabs.find((t) => t.id === tabId) || tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
  const isRunning = !!boundTab?.blocks?.some((b) => b.status === 'running');

  // Read fresh inside the ResizeObserver callback without tearing the
  // observer down every time a command starts/stops.
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  // Keep the backend PTY sized to this pane so real shell output wraps correctly.
  useEffect(() => {
    const el = outputRef.current;
    const boundId = boundTab?.id;
    if (!el || !boundId || typeof ResizeObserver === 'undefined') return undefined;
    let timer = null;
    const measure = () => {
      setPaneHeight(el.clientHeight);
      // While a block is running, its own <XtermSurface> owns PTY sizing —
      // the pane-level observer must not fight it with a second resize.
      if (isRunningRef.current) return;
      const cell = measureCell(el);
      const cols = Math.max(20, Math.floor((el.clientWidth - 24) / cell.width));
      const rows = Math.max(5, Math.floor(el.clientHeight / cell.height));
      resizePty(boundId, cols, rows);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    observer.observe(el);
    measure();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [boundTab?.id, resizePty]);

  useEffect(() => {
    blocksEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [boundTab?.blocks?.length, boundTab?.blocks?.[boundTab?.blocks?.length - 1]?.output]);

  const handleNavigateBlock = (delta) => {
    const blocks = boundTab?.blocks || [];
    if (blocks.length === 0) return;
    const currentIdx = selectedBlockId ? blocks.findIndex((b) => b.id === selectedBlockId) : -1;
    const nextIdx =
      currentIdx === -1 ? (delta < 0 ? blocks.length - 1 : 0) : Math.min(blocks.length - 1, Math.max(0, currentIdx + delta));
    setSelectedBlockId(blocks[nextIdx].id);
  };

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

      {/* Blocks */}
      <div ref={outputRef} className="flex-1 overflow-y-auto">
        {(!boundTab || boundTab.blocks.length === 0) ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center select-none">
            <p className="text-ui-sm text-vsc-muted">Type a command below</p>
            <div className="flex items-center gap-3 text-ui-sm text-vsc-muted">
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1 rounded-sm bg-vsc-button-secondary font-mono text-ui-sm">{chord('mod', 'd')}</kbd>
                split right
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1 rounded-sm bg-vsc-button-secondary font-mono text-ui-sm">{chord('mod', 'shift', 'd')}</kbd>
                split down
              </span>
            </div>
          </div>
        ) : (
          <>
            {boundTab.blocks.map((block) => (
              <TerminalBlock
                key={block.id}
                block={block}
                tabId={boundTab.id}
                selected={block.id === selectedBlockId}
                onSelect={setSelectedBlockId}
                paneHeight={paneHeight}
              />
            ))}
            <div ref={blocksEndRef} />
          </>
        )}
      </div>

      {/* Command Input */}
      <CommandInput
        isRunning={isRunning}
        onRawInput={(data) => writeRaw(boundTab?.id, data)}
        onExecute={(cmd) => executeCommand(cmd, boundTab?.id)}
        onNavigateBlock={handleNavigateBlock}
      />
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
