import React, { useCallback, useRef, useState } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { SplitSquareHorizontal, SplitSquareVertical, X, Plus } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalView } from './TerminalView.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const paneHeaderBtn =
  'p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

const DRAG_MIME = 'application/x-nexterm-tab';

/**
 * The tab being dragged. `dataTransfer` only exposes its payload on `drop`,
 * but the drop zones need to know a drag is in progress during `dragover`, so
 * the id is mirrored here for the duration of the gesture.
 */
let draggingTabId = null;

/** Which edge (or the centre) of a pane the pointer is over, as a fraction. */
function zoneFromPoint(rect, clientX, clientY) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const edge = 0.25;
  // Whichever edge the pointer is deepest into wins; the middle stays 'center'.
  const distances = [
    { zone: 'left', d: x },
    { zone: 'right', d: 1 - x },
    { zone: 'top', d: y },
    { zone: 'bottom', d: 1 - y },
  ].sort((a, b) => a.d - b.d);
  return distances[0].d < edge ? distances[0].zone : 'center';
}

/** Translucent overlay showing where a dropped tab will land. */
function DropIndicator({ zone }) {
  if (!zone) return null;
  const box = {
    center: 'inset-0',
    left: 'left-0 top-0 bottom-0 w-1/2',
    right: 'right-0 top-0 bottom-0 w-1/2',
    top: 'left-0 right-0 top-0 h-1/2',
    bottom: 'left-0 right-0 bottom-0 h-1/2',
  }[zone];
  return (
    <div
      aria-hidden="true"
      className={cn(
        'absolute z-20 pointer-events-none border border-vsc-focus',
        'bg-[color-mix(in_srgb,var(--vsc-accent)_18%,transparent)]',
        box
      )}
    />
  );
}

/**
 * One terminal group (leaf of the split tree): its own tab strip plus the
 * persistent xterm for whichever of *its* tabs is active. Tabs can be dragged
 * between groups, or onto a group's edge to split it.
 */
function TerminalPane({ node, onSplitH, onSplitV, onClose, canClose }) {
  const paneId = node.id;
  const tabs = useTerminalStore((s) => s.tabs);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const dropTabOnPane = useTerminalStore((s) => s.dropTabOnPane);
  const createTab = useTerminalStore((s) => s.createTab);

  const [dropZone, setDropZone] = useState(null);
  const bodyRef = useRef(null);

  const isActivePane = activePaneId === paneId;

  // Only the tabs that belong to this group, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const boundTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;

  const handleDragOver = (e) => {
    if (!draggingTabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (rect) setDropZone(zoneFromPoint(rect, e.clientX, e.clientY));
  };

  const handleDrop = (e) => {
    const tabId = e.dataTransfer.getData(DRAG_MIME) || draggingTabId;
    const zone = dropZone;
    setDropZone(null);
    if (!tabId) return;
    e.preventDefault();
    e.stopPropagation();
    dropTabOnPane(tabId, paneId, zone || 'center');
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
      {/* Tab strip — each chip is a drag handle */}
      <div className="h-7 shrink-0 flex items-center bg-vsc-panel border-b border-vsc-border select-none">
        <div className="flex-1 flex items-center gap-0.5 px-1 h-full overflow-x-auto">
          {paneTabs.map((tab) => {
            const isActive = tab.id === boundTab?.id;
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                aria-grabbed={draggingTabId === tab.id}
                draggable
                title={`${tab.title} — drag to rearrange`}
                onDragStart={(e) => {
                  draggingTabId = tab.id;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData(DRAG_MIME, tab.id);
                  // Some browsers require text/plain for a drag to start at all.
                  e.dataTransfer.setData('text/plain', tab.title);
                }}
                onDragEnd={() => {
                  draggingTabId = null;
                }}
                onClick={() => {
                  bindPaneToTab(paneId, tab.id);
                  switchTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    bindPaneToTab(paneId, tab.id);
                    switchTab(tab.id);
                  }
                }}
                className={cn(
                  'flex items-center px-2 h-[22px] rounded-sm text-ui-sm whitespace-nowrap cursor-grab active:cursor-grabbing transition-colors',
                  isActive
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                    : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover'
                )}
              >
                <span className="truncate max-w-[120px]">{tab.title}</span>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => createTab()}
            className={cn(paneHeaderBtn, 'shrink-0')}
            title={`New Terminal (${chord('ctrl', 'shift', '`')})`}
          >
            <Plus size={14} />
          </button>
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
              title={`Close Group (${chord('mod', 'w')})`}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Live terminal surface + drop target */}
      <div
        ref={bodyRef}
        className="relative flex-1 overflow-hidden"
        aria-dropeffect={draggingTabId ? 'move' : 'none'}
        onDragOver={handleDragOver}
        onDragLeave={(e) => {
          // Ignore drags moving between children of this pane.
          if (!bodyRef.current?.contains(e.relatedTarget)) setDropZone(null);
        }}
        onDrop={handleDrop}
      >
        {boundTab ? (
          <TerminalView tabId={boundTab.id} active={isActivePane} />
        ) : (
          <div className="h-full flex items-center justify-center text-ui-sm text-vsc-muted select-none">
            No terminal
          </div>
        )}
        <DropIndicator zone={dropZone} />
      </div>
    </div>
  );
}

/**
 * Recursively renders the split tree: a "leaf" is a terminal group, a "split"
 * is a resizable row/column of children.
 */
function SplitNode({ node, onSplit, onClose, canClose }) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        node={node}
        onSplitH={() => onSplit(node.id, 'horizontal')}
        onSplitV={() => onSplit(node.id, 'vertical')}
        onClose={() => onClose(node.id)}
        canClose={canClose}
      />
    );
  }

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

  if (!splitTree) return null;

  const canClose = splitTree.type !== 'leaf';

  return (
    <div className="h-full w-full overflow-hidden">
      <SplitNode node={splitTree} onSplit={handleSplit} onClose={handleClose} canClose={canClose} />
    </div>
  );
}

export default TerminalSplitContainer;
