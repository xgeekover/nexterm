import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { SplitSquareHorizontal, SplitSquareVertical, X, Plus, TerminalSquare, Pencil, Copy, Files, LayoutGrid } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalView } from './TerminalView.jsx';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const paneHeaderBtn =
  'p-1 rounded-sm text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

/**
 * When a drag ends the browser may still deliver a `click` to the chip the
 * gesture started on; ignore clicks that land right after a real drag.
 */
let lastDragEndAt = 0;

/** Pointer travel before a press turns into a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How deep into a pane counts as an edge (split) rather than the centre (move). */
const EDGE_FRACTION = 0.25;

/**
 * Dragging is done with pointer events rather than HTML5 drag & drop.
 * WKWebView (what Tauri uses on macOS) refuses to start a native drag on an
 * element inside a `user-select: none` subtree — which the tab strip is — so
 * the native pipeline silently does nothing there. Pointer events behave the
 * same in every webview and let us draw our own preview and drop zones.
 */
const DragContext = createContext(null);

/** Which edge (or the centre) of a rect the point is in. */
function zoneFromPoint(rect, clientX, clientY) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const candidates = [
    { zone: 'left', d: x },
    { zone: 'right', d: 1 - x },
    { zone: 'top', d: y },
    { zone: 'bottom', d: 1 - y },
  ].sort((a, b) => a.d - b.d);
  return candidates[0].d < EDGE_FRACTION ? candidates[0].zone : 'center';
}

/** Resolve the pane body under the pointer, if any. */
function paneAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const body = el?.closest?.('[data-pane-body]');
  if (!body) return null;
  return { paneId: body.getAttribute('data-pane-body'), rect: body.getBoundingClientRect() };
}

/** Collects every leaf (group) of a split-tree, in DOM order. Mirrors
 * terminalStore.js's own `collectLeaves`, kept local here since this
 * component only ever needs read-only traversal for the group switcher. */
function collectLeafNodes(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  node.children.forEach((child) => collectLeafNodes(child, acc));
  return acc;
}

/**
 * Copy text to the clipboard. Prefers the async Clipboard API (works inside
 * Tauri's webview for a click-triggered call); falls back to the classic
 * hidden-textarea + execCommand trick for any environment where that API is
 * unavailable or throws (e.g. an insecure context).
 */
async function copyToClipboard(text) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) {
    // fall through to the legacy fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (_) {
    // Best effort — nothing else we can do without a clipboard API.
  }
}

/** Translucent overlay showing where the dropped tab will land. */
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
 * The chip that follows the cursor while dragging. Portaled straight onto
 * <body> — this pane is a descendant of a panel that keeps a permanent
 * non-`none` `transform` on itself after its mount animation finishes
 * (`.animate-panel-in` + `animation-fill-mode: both`, see index.css), which
 * makes that panel the containing block for `position: fixed` descendants
 * and would otherwise offset this chip away from the actual cursor — the
 * same bug ContextMenu.jsx works around the same way.
 */
function DragPreview({ drag }) {
  if (!drag?.active) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className="fixed z-50 pointer-events-none flex items-center gap-1 px-2 h-[22px] rounded-sm text-ui-sm
                 bg-vsc-tab-active text-vsc-tab-active-fg border border-vsc-focus shadow-widget"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <TerminalSquare size={12} />
      <span className="truncate max-w-[140px]">{drag.title}</span>
    </div>,
    document.body
  );
}

/**
 * One terminal group (leaf of the split tree): its own tab strip plus the
 * persistent xterm for whichever of *its* tabs is active. Tabs can be dragged
 * between groups, or onto a group's edge to split it.
 */
function TerminalPane({ node, onSplitH, onSplitV, onClose, canClose, headerSlot = null }) {
  const paneId = node.id;
  const tabs = useTerminalStore((s) => s.tabs);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const createTab = useTerminalStore((s) => s.createTab);
  const duplicateTab = useTerminalStore((s) => s.duplicateTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const renameGroup = useTerminalStore((s) => s.renameGroup);

  const { drag, beginDrag, cancelActiveDrag } = useContext(DragContext);

  // Inline "rename a tab" editor state — which tab (if any) is being edited.
  const [renamingTabId, setRenamingTabId] = useState(null);
  const [tabDraft, setTabDraft] = useState('');
  // Inline "name this group" editor state.
  const [isRenamingGroup, setIsRenamingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState('');
  // Right-click menus: a tab chip's "Rename", and the strip's empty-area "Name Group".
  const [chipMenu, setChipMenu] = useState(null); // { x, y, tabId }
  const [paneMenu, setPaneMenu] = useState(null); // { x, y }

  const isActivePane = activePaneId === paneId;
  const dropZone = drag?.active && drag.targetPaneId === paneId ? drag.zone : null;

  // Only the tabs that belong to this group, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const boundTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;

  const beginRenameTab = (tab) => {
    setRenamingTabId(tab.id);
    setTabDraft(tab.title);
  };
  const commitRenameTab = () => {
    setRenamingTabId((id) => {
      if (id) renameTab(id, tabDraft);
      return null;
    });
  };
  const cancelRenameTab = () => setRenamingTabId(null);

  const beginRenameGroup = () => {
    setGroupDraft(node.name || '');
    setIsRenamingGroup(true);
  };
  const commitRenameGroup = () => {
    // Functional update, mirroring commitRenameTab: guards against a stray
    // extra blur firing (e.g. the input unmounting right after Enter already
    // committed) re-applying the same rename a second time.
    setIsRenamingGroup((was) => {
      if (was) renameGroup(paneId, groupDraft);
      return false;
    });
  };
  const cancelRenameGroup = () => setIsRenamingGroup(false);

  return (
    <div
      onMouseDown={() => setActivePane(paneId)}
      onFocusCapture={() => setActivePane(paneId)}
      className={cn(
        'flex flex-col h-full w-full bg-vsc-terminal overflow-hidden',
        isActivePane && 'ring-1 ring-inset ring-vsc-focus'
      )}
    >
      {/* Tab strip — each chip is a drag handle. Right-clicking empty space
          in the strip (not a chip or a button) opens "Name Group". */}
      <div
        className="h-7 shrink-0 flex items-center bg-vsc-panel border-b border-vsc-border select-none"
        onContextMenu={(e) => {
          e.preventDefault();
          setPaneMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex-1 flex items-center gap-0.5 px-1 h-full overflow-x-auto">
          {isRenamingGroup ? (
            <input
              autoFocus
              value={groupDraft}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setGroupDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRenameGroup();
                else if (e.key === 'Escape') cancelRenameGroup();
              }}
              onBlur={commitRenameGroup}
              placeholder="Group name"
              className="shrink-0 w-24 h-[20px] px-1 mr-1 rounded-sm bg-vsc-input border border-vsc-focus text-ui-sm text-vsc-fg outline-none"
            />
          ) : node.name ? (
            <span
              className="shrink-0 pl-1 pr-2 text-ui-sm text-vsc-muted uppercase truncate max-w-[100px]"
              title={node.name}
            >
              {node.name}
            </span>
          ) : null}

          {paneTabs.map((tab) => {
            const isActive = tab.id === boundTab?.id;
            const isBeingDragged = drag?.active && drag.tabId === tab.id;

            if (renamingTabId === tab.id) {
              return (
                <div key={tab.id} className="flex items-center h-[22px]">
                  <input
                    autoFocus
                    value={tabDraft}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setTabDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitRenameTab();
                      else if (e.key === 'Escape') cancelRenameTab();
                    }}
                    onBlur={commitRenameTab}
                    className="w-[110px] h-[20px] px-1 rounded-sm bg-vsc-input border border-vsc-focus text-ui-sm text-vsc-fg outline-none"
                  />
                </div>
              );
            }

            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                aria-grabbed={isBeingDragged}
                data-tab-chip={tab.id}
                title={`${tab.title} — drag onto a terminal to move or split it, double-click to rename`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  beginDrag(tab, e);
                }}
                onClick={() => {
                  if (Date.now() - lastDragEndAt < 200) return;
                  bindPaneToTab(paneId, tab.id);
                  switchTab(tab.id);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // A dblclick is two down/up cycles under the same 4px
                  // threshold that gates a real drag, so neither should ever
                  // arm one — this just guarantees it, defensively.
                  cancelActiveDrag();
                  beginRenameTab(tab);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setChipMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    bindPaneToTab(paneId, tab.id);
                    switchTab(tab.id);
                  }
                }}
                className={cn(
                  'flex items-center px-2 h-[22px] rounded-sm text-ui-sm whitespace-nowrap',
                  'cursor-grab active:cursor-grabbing touch-none transition-colors',
                  isActive
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                    : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover',
                  isBeingDragged && 'opacity-40'
                )}
              >
                <span className="truncate max-w-[120px]">{tab.title}</span>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => createTab(null, { paneId })}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={cn(paneHeaderBtn, 'shrink-0')}
            title={`New Terminal in this group (${chord('ctrl', 'shift', '`')})`}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="flex items-center gap-0.5 px-1 shrink-0">
          <button
            type="button"
            onClick={onSplitH}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={paneHeaderBtn}
            title={`Split Right (${chord('mod', 'd')})`}
          >
            <SplitSquareHorizontal size={14} />
          </button>
          <button
            type="button"
            onClick={onSplitV}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={paneHeaderBtn}
            title={`Split Down (${chord('mod', 'shift', 'd')})`}
          >
            <SplitSquareVertical size={14} />
          </button>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
              className={cn(paneHeaderBtn, 'hover:text-vsc-error')}
              title={`Close Group (${chord('mod', 'w')})`}
            >
              <X size={14} />
            </button>
          )}
          {/* Region chrome (drag handle, maximize, hide) merged in from the
              layout so a single-pane terminal shows one bar, not two. */}
          {headerSlot}
        </div>
      </div>

      <ContextMenu
        open={Boolean(chipMenu)}
        x={chipMenu?.x ?? 0}
        y={chipMenu?.y ?? 0}
        onClose={() => setChipMenu(null)}
        items={
          chipMenu
            ? [
                {
                  key: 'rename',
                  label: 'Rename',
                  icon: Pencil,
                  onSelect: () => {
                    const target = paneTabs.find((t) => t.id === chipMenu.tabId);
                    if (target) beginRenameTab(target);
                  },
                },
                {
                  key: 'duplicate-tab',
                  label: 'Copy Tab',
                  icon: Files,
                  onSelect: () => {
                    duplicateTab(chipMenu.tabId);
                  },
                },
                {
                  key: 'copy-path',
                  label: 'Copy Path',
                  icon: Copy,
                  onSelect: () => {
                    const target = paneTabs.find((t) => t.id === chipMenu.tabId);
                    if (target?.cwd) copyToClipboard(target.cwd);
                  },
                },
              ]
            : []
        }
      />

      <ContextMenu
        open={Boolean(paneMenu)}
        x={paneMenu?.x ?? 0}
        y={paneMenu?.y ?? 0}
        onClose={() => setPaneMenu(null)}
        items={[
          {
            key: 'rename-group',
            label: node.name ? 'Rename Group…' : 'Name Group…',
            icon: Pencil,
            onSelect: beginRenameGroup,
          },
        ]}
      />

      {/* Live terminal surface — also the drop target */}
      <div data-pane-body={paneId} className="relative flex-1 overflow-hidden">
        {boundTab ? (
          <TerminalView tabId={boundTab.id} active={isActivePane} />
        ) : (
          <div className="h-full flex items-center justify-center text-ui-sm text-vsc-muted select-none">
            No terminal
          </div>
        )}
        {/* While dragging, swallow pointer events so the xterm cannot eat them. */}
        {drag?.active && <div aria-hidden="true" className="absolute inset-0 z-10" />}
        <DropIndicator zone={dropZone} />
      </div>
    </div>
  );
}

/**
 * Recursively renders the split tree: a "leaf" is a terminal group, a "split"
 * is a resizable row/column of children.
 */
function SplitNode({ node, onSplit, onClose, canClose, headerSlot = null }) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        node={node}
        onSplitH={() => onSplit(node.id, 'horizontal')}
        onSplitV={() => onSplit(node.id, 'vertical')}
        onClose={() => onClose(node.id)}
        canClose={canClose}
        headerSlot={headerSlot}
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
 * Warp-style group switcher: a compact bar listing every group (named or
 * not) alongside an "All" entry. Selecting a group shows only it, full-size;
 * "All" returns to the normal side-by-side split view. Only rendered when
 * there is more than one group — with a single group there is nothing to
 * switch between.
 */
function GroupSwitcher({ leaves, groupViewMode, focusedPaneId, onShowAll, onFocusGroup }) {
  if (leaves.length < 2) return null;
  return (
    <div className="h-6 shrink-0 flex items-center gap-0.5 px-1 bg-vsc-panel border-b border-vsc-border overflow-x-auto select-none">
      <LayoutGrid size={12} className="shrink-0 mr-1 text-vsc-muted" />
      <button
        type="button"
        onClick={onShowAll}
        className={cn(
          'shrink-0 px-2 h-[20px] rounded-sm text-ui-sm transition-colors',
          groupViewMode === 'split'
            ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
            : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover'
        )}
        title="Show all groups side by side"
      >
        All
      </button>
      {leaves.map((leaf, i) => {
        const label = leaf.name || `Group ${i + 1}`;
        const isFocused = groupViewMode === 'focus' && focusedPaneId === leaf.id;
        return (
          <button
            key={leaf.id}
            type="button"
            onClick={() => onFocusGroup(leaf.id)}
            title={`Show only "${label}"`}
            className={cn(
              'shrink-0 px-2 h-[20px] rounded-sm text-ui-sm truncate max-w-[140px] transition-colors',
              isFocused
                ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Top-level container for the terminal split system. Owns the drag gesture so
 * every pane can render the drop indicator for the pointer's current target.
 */
export function TerminalSplitContainer({ headerSlot = null }) {
  const splitTree = useTerminalStore((s) => s.splitTree);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const dropTabOnPane = useTerminalStore((s) => s.dropTabOnPane);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const groupViewMode = useTerminalStore((s) => s.groupViewMode);
  const focusedPaneId = useTerminalStore((s) => s.focusedPaneId);
  const focusGroup = useTerminalStore((s) => s.focusGroup);
  const showAllGroups = useTerminalStore((s) => s.showAllGroups);

  // null while idle; { tabId, title, startX, startY, x, y, active, targetPaneId, zone }
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const cleanupRef = useRef(null);

  /**
   * Listeners are attached synchronously here rather than from an effect: a
   * quick flick delivers pointermove/up before React has committed the state
   * change, so an effect-bound listener would miss the whole gesture.
   */
  const beginDrag = useCallback(
    (tab, e) => {
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        cleanupRef.current = null;
      };

      const onMove = (ev) => {
        const cur = dragRef.current;
        if (!cur) return;
        const movedEnough =
          cur.active ||
          Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY) > DRAG_THRESHOLD_PX;
        if (!movedEnough) return;

        const hit = paneAtPoint(ev.clientX, ev.clientY);
        const next = {
          ...cur,
          active: true,
          x: ev.clientX,
          y: ev.clientY,
          targetPaneId: hit?.paneId ?? null,
          zone: hit ? zoneFromPoint(hit.rect, ev.clientX, ev.clientY) : null,
        };
        dragRef.current = next;
        setDrag(next);
      };

      const onUp = () => {
        const cur = dragRef.current;
        detach();
        dragRef.current = null;
        setDrag(null);
        if (cur?.active) lastDragEndAt = Date.now();
        if (!cur?.active || !cur.targetPaneId) return;
        dropTabOnPane(cur.tabId, cur.targetPaneId, cur.zone || 'center');
      };

      const onCancel = () => {
        detach();
        dragRef.current = null;
        setDrag(null);
      };

      const started = {
        tabId: tab.id,
        title: tab.title,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        targetPaneId: null,
        zone: null,
      };
      dragRef.current = started;
      setDrag(started);

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      cleanupRef.current = detach;
    },
    [dropTabOnPane]
  );

  // Never leave listeners behind if the terminal unmounts mid-gesture.
  useEffect(() => () => cleanupRef.current?.(), []);

  // Lets a chip's double-click (rename) guarantee no drag is left armed,
  // regardless of pointer-event timing.
  const cancelActiveDrag = useCallback(() => {
    cleanupRef.current?.();
    dragRef.current = null;
    setDrag(null);
  }, []);

  // Split whichever pane's own button was clicked, then focus the pane it
  // creates — a clear, visible sign the click did something, even when the
  // pane split wasn't already the focused one.
  const handleSplit = useCallback(async (paneId, direction) => {
    const newPaneId = await splitPane(paneId, direction);
    if (newPaneId) setActivePane(newPaneId);
  }, [splitPane, setActivePane]);

  const handleClose = useCallback((paneId) => {
    closePane(paneId);
  }, [closePane]);

  if (!splitTree) return null;

  const canClose = splitTree.type !== 'leaf';
  const leaves = collectLeafNodes(splitTree);
  // Ignore a stale/closed focus target (e.g. its group was closed) rather
  // than rendering a blank pane — falls back to the normal split view, same
  // as having fewer than two groups.
  const focusedLeaf =
    groupViewMode === 'focus' && leaves.length > 1
      ? leaves.find((l) => l.id === focusedPaneId) || null
      : null;

  return (
    <DragContext.Provider value={{ drag, beginDrag, cancelActiveDrag }}>
      <div className={cn('h-full w-full flex flex-col overflow-hidden', drag?.active && 'cursor-grabbing')}>
        {/* One pane: the chrome lives in that pane's tab strip. Split: a single
            slim bar carries it for the whole group. */}
        {headerSlot && splitTree.type !== 'leaf' && (
          <div className="h-panel-header shrink-0 flex items-center justify-end gap-0.5 px-1 bg-vsc-panel border-b border-vsc-border select-none">
            <span className="mr-auto pl-1.5 text-ui-sm font-medium tracking-wide uppercase text-vsc-fg">Terminal</span>
            {headerSlot}
          </div>
        )}
        <GroupSwitcher
          leaves={leaves}
          groupViewMode={groupViewMode}
          focusedPaneId={focusedPaneId}
          onShowAll={showAllGroups}
          onFocusGroup={focusGroup}
        />
        <div className="flex-1 overflow-hidden">
          {focusedLeaf ? (
            // Focus mode: render only the selected group, full-size. The rest
            // of the split tree is left completely untouched — just not
            // mounted — so switching back to "All" (or splitting/closing this
            // very group) resumes exactly where the tree left off.
            <TerminalPane
              node={focusedLeaf}
              onSplitH={() => handleSplit(focusedLeaf.id, 'horizontal')}
              onSplitV={() => handleSplit(focusedLeaf.id, 'vertical')}
              onClose={() => handleClose(focusedLeaf.id)}
              canClose={true}
            />
          ) : (
            <SplitNode
              node={splitTree}
              onSplit={handleSplit}
              onClose={handleClose}
              canClose={canClose}
              headerSlot={splitTree.type === 'leaf' ? headerSlot : null}
            />
          )}
        </div>
        <DragPreview drag={drag} />
      </div>
    </DragContext.Provider>
  );
}

export default TerminalSplitContainer;
