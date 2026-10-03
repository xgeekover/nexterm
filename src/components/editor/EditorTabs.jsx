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
export function wasJustDragged() {
  return Date.now() - lastDragEndAt < 200;
}

/**
 * Where the drop marker's 2px bar is drawn, from-to, relative to its gap —
 * exactly what TabDropMarker draws. The first gap's bar starts at the gap and
 * an inner gap's is centred on it. The last gap's ends a pixel short of it: a
 * row's scrollWidth and clientWidth are whole pixels while its box is not, so
 * scrolled as far as the browser will take it, a row can still end most of a
 * pixel past its own visible edge (0.67px in a real split group), and a bar
 * centred on the end was cut off there.
 */
const MARKER_BAR = { first: [0, 2], inner: [-1, 1], last: [-3, -1] };
/** Float noise in a box measured through a transformed ancestor. */
const ROUNDING_PX = 0.05;

/**
 * Where a drop at `clientX` lands in a tab strip, as a GAP: 0 before the first
 * chip, `chips.length` after the last — the numbering `moveEditorTabInStrip`
 * takes.
 *
 * `chips` are the boxes of every chip in the strip, in order: the dragged one
 * included, since it stays in its strip, dimmed, for the whole gesture, and
 * the ones scrolled out of view included. `row` is the box of the strip's
 * scrolling row — the part of the strip the chips are actually seen in.
 *
 * Over a chip's left half the tab goes in before it, over its right half
 * after it. But only a gap whose marker would be wholly ON SCREEN is ever
 * offered: anywhere else — past either end of the row, over the strip's own
 * buttons — gets the nearest gap that can be seen. Counting every chip
 * instead put the drop, and its marker, wherever the HIDDEN chips happened
 * to be: over the buttons of a strip of ten whose row ended partway into the
 * fourth chip, a tab went in at gap 4 with its marker drawn past the end of
 * the row, and the end of the strip could not be reached at all. Clamping
 * the pointer to the row is not enough on its own either — that fourth chip,
 * cut by the edge with more than half of it showing, still puts the gap after
 * it out of view. The rest of the strip is reached by scrolling it, which a
 * drag held near either end of the row does (see `createStripAutoScroller` in
 * EditorPanel.jsx).
 */
export function stripSlotAt(chips, row, clientX) {
  if (chips.length === 0) return 0;
  let slot = 0;
  for (const chip of chips) {
    if (clientX > (chip.left + chip.right) / 2) slot += 1;
  }
  const inView = (gap) => {
    const x = gap < chips.length ? chips[gap].left : chips[chips.length - 1].right;
    const [from, to] = MARKER_BAR[gap === 0 ? 'first' : gap === chips.length ? 'last' : 'inner'];
    return x + from >= row.left - ROUNDING_PX && x + to <= row.right + ROUNDING_PX;
  };
  let first = 0;
  while (first <= chips.length && !inView(first)) first += 1;
  let last = chips.length;
  while (last >= first && !inView(last)) last -= 1;
  // A single chip wider than the whole row leaves no gap on screen at all.
  if (first > last) return slot;
  return Math.min(Math.max(slot, first), last);
}

/**
 * Which gap of a strip holding `tabIds` to draw the drop marker in, or null
 * for none.
 *
 * The two gaps either side of the dragged chip's own place leave it where it
 * is, so they draw nothing: a marker always means the drop will move
 * something, and the dimmed chip already shows where it is now. The same rule
 * as the terminal's rows (`markerSlot` in TerminalSplitContainer.jsx).
 */
export function markerSlot(slot, tabIds, draggedTabId) {
  if (typeof slot !== 'number') return null;
  const from = tabIds.indexOf(draggedTabId);
  if (from !== -1 && (slot === from || slot === from + 1)) return null;
  return slot;
}

/**
 * Where a dragged tab will land in this strip: a thin bar in the gap.
 *
 * The box itself is zero-width so that showing it never moves a chip. A
 * marker that pushed the chips apart would shift the very midpoints the gap
 * is measured against (see `stripSlotAt`), and under a still pointer the gap
 * would flicker between two values. It has a height of its own rather than
 * stretching to the chips': an empty group's strip has no chips to stretch
 * to, and there the bar came out zero pixels tall — in the strip of a group
 * just split off, which is waiting for exactly this drop. The first gap and
 * the last sit on the row's own edges when it is scrolled all the way to
 * either end, so their bars are drawn inside the row rather than centred on
 * the gap, where they would be cut off (see MARKER_BAR, which `stripSlotAt`
 * judges what is in view by).
 */
function TabDropMarker({ first = false, last = false }) {
  return (
    <div aria-hidden="true" data-tab-drop-marker="" className="relative h-tab w-0 shrink-0 pointer-events-none">
      <div
        className={cn(
          'absolute z-10 top-1 bottom-1 w-0.5 rounded-full bg-vsc-accent',
          first ? 'left-0' : last ? '-left-[3px]' : '-left-px'
        )}
      />
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
  // The gap a drop here would land in, while a drag is over this strip —
  // unless that drop would leave the tab where it is (see `markerSlot`).
  const dropIndex =
    drag?.active && drag.targetPaneId === paneId && drag.zone === 'tabs'
      ? markerSlot(drag.index, paneTabs.map((t) => t.id), drag.tabId)
      : null;

  return (
    <div
      data-editor-tab-strip={paneId}
      className="flex items-center h-tab bg-vsc-tab-inactive border-b border-vsc-border select-none"
    >
      {/* The row scrolls when there are more tabs than fit, and only what of
          it is on screen counts as a place to drop (see `stripSlotAt`). */}
      <div data-editor-tab-row={paneId} className="flex-1 flex items-center overflow-x-auto no-scrollbar">
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
          <TabDropMarker first={paneTabs.length === 0} last />
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
