import React, { createContext, useContext } from 'react';
import { X, Circle, FileCode2, FileJson, FileText, File, SplitSquareHorizontal, SplitSquareVertical } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';

const paneHeaderBtn =
  'p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

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

/**
 * Pointer-drag state shared by every editor pane's tab strip and the split
 * container that owns the gesture and renders drop indicators — see the
 * `beginDrag` set up in EditorPanel.jsx. Value: { drag, beginDrag }.
 */
export const EditorDragContext = createContext({ drag: null, beginDrag: () => {} });

/**
 * When a drag ends, the browser may still deliver a trailing `click` to the
 * chip the gesture started on; EditorPanel.jsx calls this from its pointerup
 * handler so the click below can be ignored (mirrors TerminalSplitContainer's
 * `lastDragEndAt` guard).
 */
let lastDragEndAt = 0;
export function markEditorDragEnded() {
  lastDragEndAt = Date.now();
}
function wasJustDragged() {
  return Date.now() - lastDragEndAt < 200;
}

/**
 * Where a dragged tab will land in this strip: a thin bar in the gap.
 *
 * The box itself is zero-width so that showing it never moves a chip. A
 * marker that pushed the chips apart would shift the very midpoints the gap
 * is measured against (see `dropTargetAtPoint` in EditorPanel.jsx), and under
 * a still pointer the gap would flicker between two values. It has a height
 * of its own rather than stretching to the chips': an empty group's strip has
 * no chips to stretch to, and there the bar came out zero pixels tall — in
 * the strip of a group just split off, which is waiting for exactly this
 * drop. The first gap sits on the strip's scrolling edge, so its bar starts
 * there rather than half outside it, where it would be clipped.
 */
function TabDropMarker({ first }) {
  return (
    <div aria-hidden="true" data-tab-drop-marker="" className="relative h-tab w-0 shrink-0 pointer-events-none">
      <div className={cn('absolute z-10 top-1 bottom-1 w-0.5 rounded-full bg-vsc-accent', first ? 'left-0' : '-left-px')} />
    </div>
  );
}

/**
 * One editor pane's own tab strip: only the tabs that belong to that group,
 * plus the split/close controls for the group itself. Each chip is a drag
 * handle (pointer events — see EditorPanel.jsx for why) that can be dropped
 * on another pane's centre (move) or edge (split), or on a tab strip — this
 * one or another group's — at the position the marker shows.
 */
export function EditorTabs({ node, onSplitH, onSplitV, onClose, canClose = false }) {
  const paneId = node.id;
  const tabs = useEditorStore((s) => s.tabs);
  const bindEditorPaneToTab = useEditorStore((s) => s.bindEditorPaneToTab);
  const requestCloseTab = useEditorStore((s) => s.requestCloseTab);
  const { drag, beginDrag } = useContext(EditorDragContext);

  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;
  // The gap a drop here would land in, while a drag is over this strip.
  const dropIndex =
    drag?.active && drag.targetPaneId === paneId && drag.zone === 'tabs' ? drag.index : null;

  return (
    <div
      data-editor-tab-strip={paneId}
      className="flex items-center h-tab bg-vsc-tab-inactive border-b border-vsc-border select-none"
    >
      <div className="flex-1 flex items-center overflow-x-auto no-scrollbar">
        {paneTabs.map((tab, i) => {
          const isActive = tab.id === activeTab?.id;
          const isBeingDragged = drag?.active && drag.tabId === tab.id;
          return (
            // The marker is the chip's sibling, never its child: inside the
            // chip being dragged it would be dimmed along with it, and right
            // beside that chip is where the marker is shown most often.
            <React.Fragment key={tab.id}>
              {dropIndex === i && <TabDropMarker first={i === 0} />}
              <div
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                aria-grabbed={isBeingDragged}
                data-tab-chip={tab.id}
                title={tab.filePath}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  beginDrag(tab, e);
                }}
                onMouseDown={(e) => {
                  // Middle-click closes the tab.
                  if (e.button === 1) {
                    e.preventDefault();
                    requestCloseTab(tab.id);
                  }
                }}
                onClick={() => {
                  if (wasJustDragged()) return;
                  bindEditorPaneToTab(paneId, tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    bindEditorPaneToTab(paneId, tab.id);
                  }
                }}
                className={cn(
                  'group relative flex items-center gap-2 h-tab px-3 text-ui border-r border-vsc-border shrink-0 whitespace-nowrap',
                  'cursor-grab active:cursor-grabbing touch-none transition-colors',
                  isActive
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg shadow-[inset_0_1px_0_0_var(--vsc-focus)]'
                    : 'text-vsc-tab-inactive-fg hover:text-vsc-tab-active-fg',
                  isBeingDragged && 'opacity-40'
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
                      requestCloseTab(tab.id);
                    }}
                    title="Close"
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
            </React.Fragment>
          );
        })}
        {dropIndex !== null && dropIndex >= paneTabs.length && (
          <TabDropMarker first={paneTabs.length === 0} />
        )}
      </div>

      <div className="flex items-center gap-0.5 px-1 shrink-0">
        <button type="button" onClick={onSplitH} className={paneHeaderBtn} title="Split Right">
          <SplitSquareHorizontal size={14} />
        </button>
        <button type="button" onClick={onSplitV} className={paneHeaderBtn} title="Split Down">
          <SplitSquareVertical size={14} />
        </button>
        {canClose && (
          <button
            type="button"
            onClick={onClose}
            className={cn(paneHeaderBtn, 'hover:text-vsc-error')}
            title="Close Group"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export default EditorTabs;
