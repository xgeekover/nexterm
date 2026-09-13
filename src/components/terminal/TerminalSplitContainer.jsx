import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Plus,
  TerminalSquare,
  Pencil,
  Copy,
  Files,
  LayoutGrid,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { TerminalView } from './TerminalView.jsx';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

// ---------------------------------------------------------------------------
// The two-level model this renders (see terminalStore.js's header):
//
//   Pane  = { type:'leaf',  id, tabIds, activeTabId }
//   Split = { type:'split', id, direction, children, sizes }
//   Group = { id, name, createdAt, tree: Pane|Split, activePaneId }
//
// Exactly ONE group is on screen at a time and fills the whole terminal area:
// this component renders `getActiveGroup().tree` and nothing else. The other
// groups' terminals keep running (their xterm instances live in
// terminalRegistry, not in React), they are simply not mounted. The group
// switcher at the top is the only way to move between them.
// ---------------------------------------------------------------------------

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
/** Percentage-point slack before a stored layout counts as "different". */
const SIZE_EPSILON = 0.25;

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
/**
 * What a drop at this point would do.
 *
 * The terminal surface splits by quarter; the TAB STRIP means "put it in this
 * pane as a tab", which is how a split is merged back. The strip used not to
 * be a target at all, so dragging a tab onto the one place it visibly belongs
 * did nothing at all.
 */
function dropTargetAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);

  const strip = el?.closest?.('[data-tab-strip]');
  if (strip) {
    return { paneId: strip.getAttribute('data-tab-strip'), zone: 'tabs' };
  }

  const body = el?.closest?.('[data-pane-body]');
  if (!body) return null;
  const rect = body.getBoundingClientRect();
  return {
    paneId: body.getAttribute('data-pane-body'),
    zone: zoneFromPoint(rect, clientX, clientY),
  };
}

/** Resolve the group-switcher chip under the pointer, if any. */
function groupChipAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const chip = el?.closest?.('[data-group-chip]');
  if (!chip) return null;
  return { groupId: chip.getAttribute('data-group-chip') };
}

/** Collects every pane of one group's tree, in DOM order. Mirrors
 * terminalStore.js's own `collectLeaves`, kept local here since this
 * component only ever needs read-only traversal. */
function collectPanes(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') {
    acc.push(node);
    return acc;
  }
  node.children.forEach((child) => collectPanes(child, acc));
  return acc;
}

/** How many terminals a whole group holds — shown on its switcher chip. */
function countTerminals(tree) {
  return collectPanes(tree).reduce((sum, pane) => sum + pane.tabIds.length, 0);
}

/**
 * A split's child sizes as percentages summing to 100, falling back to an even
 * split for anything missing or malformed (the store normalizes on write, so
 * this only matters for hand-edited/older persisted state).
 */
function sizesOf(node) {
  const count = node.children.length;
  const raw = Array.isArray(node.sizes) && node.sizes.length === count ? node.sizes : null;
  const usable =
    raw && raw.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ? raw : null;
  if (!usable) return new Array(count).fill(100 / count);
  const total = usable.reduce((a, b) => a + b, 0);
  return usable.map((v) => (v / total) * 100);
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
/**
 * What will happen if the tab is dropped here.
 *
 * Showing only a tinted rectangle left the user guessing whether an edge drop
 * would split or move, so each zone names itself: the edges say which way the
 * pane will divide, the middle and the tab strip say the tab joins this pane.
 */
function DropIndicator({ zone }) {
  if (!zone) return null;
  if (zone === 'tabs') return null; // the strip highlights itself

  const box = {
    center: 'inset-0',
    left: 'left-0 top-0 bottom-0 w-1/2',
    right: 'right-0 top-0 bottom-0 w-1/2',
    top: 'left-0 right-0 top-0 h-1/2',
    bottom: 'left-0 right-0 bottom-0 h-1/2',
  }[zone];

  const label = {
    center: 'Add as a tab here',
    left: 'Split left',
    right: 'Split right',
    top: 'Split up',
    bottom: 'Split down',
  }[zone];

  return (
    <div
      aria-hidden="true"
      className={cn(
        'absolute z-20 pointer-events-none flex items-center justify-center',
        'border-2 border-vsc-accent rounded-sm',
        'bg-[color-mix(in_srgb,var(--vsc-accent)_18%,transparent)]',
        'transition-[top,left,right,bottom,width,height] duration-100 ease-out',
        box
      )}
    >
      <span className="px-2 py-0.5 rounded-sm bg-vsc-accent text-vsc-accent-fg text-ui-sm font-medium shadow-widget">
        {label}
      </span>
    </div>
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
 * One pane of the active group's tree: its own tab strip plus the persistent
 * xterm for whichever of *its* tabs is active. Tabs can be dragged between
 * panes, onto a pane's edge to split it, or onto another group's switcher chip
 * to move them to that group.
 */
function TerminalPane({ node, groupId, isActivePane, onSplitH, onSplitV, onClose, canClose, onRenameGroup }) {
  const paneId = node.id;
  const tabs = useTerminalStore((s) => s.tabs);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const createTab = useTerminalStore((s) => s.createTab);
  const duplicateTab = useTerminalStore((s) => s.duplicateTab);
  const renameTab = useTerminalStore((s) => s.renameTab);

  const { drag, beginDrag, cancelActiveDrag } = useContext(DragContext);

  // Inline "rename a tab" editor state — which tab (if any) is being edited.
  const [renamingTabId, setRenamingTabId] = useState(null);
  const [tabDraft, setTabDraft] = useState('');
  // Right-click menus: a tab chip's "Rename", and the strip's empty area.
  const [chipMenu, setChipMenu] = useState(null); // { x, y, tabId }
  const [paneMenu, setPaneMenu] = useState(null); // { x, y }

  const dropZone = drag?.active && drag.targetPaneId === paneId ? drag.zone : null;

  // Only the tabs that belong to this pane, in its own order.
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

  return (
    <div
      onMouseDown={() => setActivePane(paneId, groupId)}
      onFocusCapture={() => setActivePane(paneId, groupId)}
      className={cn(
        'flex flex-col h-full w-full bg-vsc-terminal overflow-hidden',
        isActivePane && 'ring-1 ring-inset ring-vsc-focus'
      )}
    >
      {/* Tab strip — each chip is a drag handle. Right-clicking empty space
          in the strip (not a chip or a button) opens the pane menu. */}
      <div
        data-tab-strip={paneId}
        className={cn(
          'relative h-7 shrink-0 flex items-center bg-vsc-panel border-b border-vsc-border select-none',
          // Dropping a tab here is how a pane is merged back into tabs, so it
          // has to look like somewhere you can drop.
          dropZone === 'tabs' && 'bg-vsc-accent/15 ring-1 ring-inset ring-vsc-accent'
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          setPaneMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex-1 flex items-center gap-0.5 px-1 h-full overflow-x-auto">
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
                title={
                  tab.exited
                    ? `${tab.title} — this shell has exited${
                        tab.exited.code === null ? '' : ` (code ${tab.exited.code})`
                      }`
                    : `${tab.title} — drag onto a terminal to move or split it, onto a group chip to move it there, double-click to rename`
                }
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  beginDrag(tab, e);
                }}
                onClick={() => {
                  if (Date.now() - lastDragEndAt < 200) return;
                  bindPaneToTab(paneId, tab.id, groupId);
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
                    bindPaneToTab(paneId, tab.id, groupId);
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
                <span
                  className={cn(
                    'truncate max-w-[120px]',
                    // A shell that has exited still has its scrollback worth
                    // reading, so the tab stays — but it should not look live.
                    tab.exited && 'line-through opacity-60'
                  )}
                >
                  {tab.title}
                </span>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => createTab(null, { paneId, groupId })}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={cn(paneHeaderBtn, 'shrink-0')}
            title={`New Terminal in this pane (${chord('ctrl', 'shift', '`')})`}
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
              title={`Close Pane (${chord('mod', 'w')})`}
            >
              <X size={14} />
            </button>
          )}
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

      {/* A pane has no name of its own any more — the only nameable thing is
          the group it belongs to, so this points at the switcher's own inline
          editor rather than duplicating one down here. */}
      <ContextMenu
        open={Boolean(paneMenu)}
        x={paneMenu?.x ?? 0}
        y={paneMenu?.y ?? 0}
        onClose={() => setPaneMenu(null)}
        items={[
          {
            key: 'rename-group',
            label: 'Rename Group…',
            icon: Pencil,
            onSelect: () => onRenameGroup?.(groupId),
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
 * One resizable row/column of a group's tree.
 *
 * Sizes are OWNED BY THE STORE (`node.sizes`, percentages) because every group
 * switch unmounts the whole tree, which throws away everything
 * react-resizable-panels keeps in component state. Three things keep the two
 * in sync:
 *
 *  1. `defaultLayout` (+ a matching `defaultSize` per Panel) seeds the layout
 *     at mount — the only time the library reads a "default" at all.
 *  2. `onLayoutChanged` writes a user-driven resize back with `setPaneSizes`.
 *     `meta.isUserInteraction === false` (mount, constraint recompute, our own
 *     `setLayout`) is ignored so the library can never clobber the store.
 *  3. A layout effect reconciles the live Group to `node.sizes` whenever those
 *     change without a matching user drag — a restored/undone layout, or React
 *     reusing this Group instance across a group switch (children change but
 *     the component does not remount, so step 1 never re-runs).
 */
function ResizableSplit({ node, groupId, renderChild }) {
  const setPaneSizes = useTerminalStore((s) => s.setPaneSizes);
  const groupRef = useGroupRef();

  const childIds = node.children.map((c) => c.id);
  const sizes = sizesOf(node);
  // Cheap structural identity for the memo/effect below: ids + sizes.
  const layoutKey = childIds.map((id, i) => `${id}:${sizes[i].toFixed(2)}`).join(',');

  const layout = useMemo(() => {
    const next = {};
    childIds.forEach((id, i) => {
      next[id] = sizes[i];
    });
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useLayoutEffect(() => {
    const handle = groupRef.current;
    if (!handle) return;
    let current;
    try {
      current = handle.getLayout();
    } catch (_) {
      return;
    }
    const ids = Object.keys(layout);
    // `setLayout` throws unless the layout names exactly the Group's panels.
    if (Object.keys(current).length !== ids.length) return;
    if (!ids.every((id) => typeof current[id] === 'number')) return;
    if (ids.every((id) => Math.abs(current[id] - layout[id]) <= SIZE_EPSILON)) return;
    try {
      handle.setLayout(layout);
    } catch (_) {
      // A transient mismatch (panels mid-registration) — the next store
      // change, or the next mount's `defaultLayout`, puts it right.
    }
  }, [layout, groupRef]);

  const handleLayoutChanged = useCallback(
    (nextLayout, meta) => {
      // Only a real separator drag / resize keypress writes back; every other
      // trigger is the library echoing what we just told it.
      if (meta && meta.isUserInteraction === false) return;
      const next = childIds.map((id) => nextLayout?.[id]);
      if (!next.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return;
      setPaneSizes(groupId, node.id, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childIds.join(','), groupId, node.id, setPaneSizes]
  );

  const direction = node.direction === 'vertical' ? 'vertical' : 'horizontal';
  // A pane may never be squeezed to nothing, but "15%" stops being satisfiable
  // past six children, which the library rejects — scale it down instead.
  const minSize = String(Math.max(4, Math.min(15, Math.floor(90 / node.children.length))));

  return (
    <Group
      orientation={direction}
      className="h-full w-full"
      groupRef={groupRef}
      defaultLayout={layout}
      onLayoutChanged={handleLayoutChanged}
    >
      {node.children.map((child, i) => (
        <React.Fragment key={child.id}>
          {i > 0 && <Separator className={direction === 'horizontal' ? 'w-px' : 'h-px'} />}
          <Panel id={child.id} minSize={minSize} defaultSize={String(sizes[i])}>
            {renderChild(child)}
          </Panel>
        </React.Fragment>
      ))}
    </Group>
  );
}

/**
 * Recursively renders ONE group's tree: a "leaf" is a pane (a terminal with
 * its own tab strip), a "split" is a resizable row/column of children.
 */
function SplitNode({ node, groupId, activePaneId, onSplit, onClose, canClose, onRenameGroup }) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        node={node}
        groupId={groupId}
        isActivePane={activePaneId === node.id}
        onSplitH={() => onSplit(node.id, 'horizontal')}
        onSplitV={() => onSplit(node.id, 'vertical')}
        onClose={() => onClose(node.id)}
        canClose={canClose}
        onRenameGroup={onRenameGroup}
      />
    );
  }

  return (
    <ResizableSplit
      node={node}
      groupId={groupId}
      renderChild={(child) => (
        <SplitNode
          node={child}
          groupId={groupId}
          activePaneId={activePaneId}
          onSplit={onSplit}
          onClose={onClose}
          canClose={true}
          onRenameGroup={onRenameGroup}
        />
      )}
    />
  );
}

/**
 * The group switcher: the primary UI for `state.groups`. One chip per group —
 * click to bring that group's whole arrangement on screen, double-click (or
 * the context menu) to rename it inline, × to close it, "+" to create one.
 *
 * Each chip is also a DROP TARGET: dragging a terminal tab onto another
 * group's chip moves the terminal into that group (`moveTabToGroup`), which
 * also switches to it. Hit-testing goes through `data-group-chip`, the same
 * `elementFromPoint` path the panes' `data-pane-body` uses.
 */
function GroupSwitcher({ groups, activeGroupId, renamingGroupId, setRenamingGroupId, headerSlot }) {
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const createGroup = useTerminalStore((s) => s.createGroup);
  const closeGroup = useTerminalStore((s) => s.closeGroup);
  const renameGroup = useTerminalStore((s) => s.renameGroup);

  const { drag } = useContext(DragContext);

  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, groupId }
  const [creating, setCreating] = useState(false);

  const beginRename = (group) => {
    setDraft(group.name || '');
    setRenamingGroupId(group.id);
  };

  // The editor can also be opened from outside (a pane's "Rename Group…"),
  // which cannot seed the draft itself — do it here for both paths.
  useEffect(() => {
    if (!renamingGroupId) return;
    const target = groups.find((g) => g.id === renamingGroupId);
    setDraft(target?.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingGroupId]);

  const commitRename = (groupId) => {
    // Functional update so a stray second blur (the input unmounting right
    // after Enter already committed) cannot re-apply the same rename.
    setRenamingGroupId((was) => {
      if (was === groupId) renameGroup(groupId, draft);
      return null;
    });
  };

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createGroup({});
    } finally {
      setCreating(false);
    }
  };

  const canClose = groups.length > 1;

  return (
    <div
      data-group-switcher=""
      className="h-7 shrink-0 flex items-center gap-1 px-1 bg-vsc-panel border-b border-vsc-border select-none"
    >
      <LayoutGrid size={12} className="shrink-0 ml-0.5 text-vsc-muted" />
      <div role="tablist" aria-label="Terminal groups" className="flex-1 flex items-center gap-0.5 overflow-x-auto">
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          const isDropTarget = Boolean(drag?.active) && drag.targetGroupId === group.id;
          const terminals = countTerminals(group.tree);

          if (renamingGroupId === group.id) {
            return (
              <input
                key={group.id}
                autoFocus
                value={draft}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename(group.id);
                  else if (e.key === 'Escape') setRenamingGroupId(null);
                }}
                onBlur={() => commitRename(group.id)}
                placeholder="Group name"
                className="shrink-0 w-28 h-[20px] px-1 rounded-sm bg-vsc-input border border-vsc-focus text-ui-sm text-vsc-fg outline-none"
              />
            );
          }

          return (
            <div
              key={group.id}
              data-group-chip={group.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              title={`${group.name} — ${terminals} terminal${terminals === 1 ? '' : 's'}. Click to switch, drop a terminal here to move it, double-click to rename.`}
              onClick={() => {
                if (Date.now() - lastDragEndAt < 200) return;
                setActiveGroup(group.id);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                beginRename(group);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveGroup(group.id);
                } else if (e.key === 'F2') {
                  e.preventDefault();
                  beginRename(group);
                }
              }}
              className={cn(
                'shrink-0 flex items-center gap-1 pl-2 pr-1 h-[20px] rounded-sm text-ui-sm cursor-pointer transition-colors',
                isActive
                  ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                  : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover',
                isDropTarget &&
                  'ring-1 ring-vsc-focus bg-[color-mix(in_srgb,var(--vsc-accent)_25%,transparent)]'
              )}
            >
              <span className="truncate max-w-[140px]">{group.name}</span>
              <span className="text-[10px] tabular-nums opacity-60">{terminals}</span>
              {canClose && (
                <button
                  type="button"
                  tabIndex={-1}
                  title={`Close ${group.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeGroup(group.id);
                  }}
                  className="p-0.5 rounded-sm opacity-50 hover:opacity-100 hover:bg-vsc-item-hover hover:text-vsc-error"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className={cn(paneHeaderBtn, 'shrink-0 disabled:opacity-40')}
          title="New Terminal Group"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Region chrome (drag handle, maximize, hide) merged in from the layout
          so the terminal shows one bar of chrome, not two. */}
      {headerSlot ? <div className="flex items-center gap-0.5 shrink-0">{headerSlot}</div> : null}

      <ContextMenu
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                {
                  key: 'rename-group',
                  label: 'Rename Group…',
                  icon: Pencil,
                  onSelect: () => {
                    const target = groups.find((g) => g.id === menu.groupId);
                    if (target) beginRename(target);
                  },
                },
                {
                  key: 'new-group',
                  label: 'New Group',
                  icon: Plus,
                  onSelect: handleCreate,
                },
                { type: 'separator', key: 'sep' },
                {
                  key: 'close-group',
                  label: 'Close Group',
                  icon: X,
                  danger: true,
                  disabled: !canClose,
                  disabledReason: canClose ? undefined : 'This is the only group',
                  onSelect: () => closeGroup(menu.groupId),
                },
              ]
            : []
        }
      />
    </div>
  );
}

/**
 * Top-level container for the terminal area. Renders the group switcher plus
 * the ACTIVE group's split tree, full size — never more than one group at a
 * time. Owns the drag gesture so every pane (and every group chip) can render
 * the drop indicator for the pointer's current target.
 */
export function TerminalSplitContainer({ headerSlot = null }) {
  const groups = useTerminalStore((s) => s.groups);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const dropTabOnPane = useTerminalStore((s) => s.dropTabOnPane);
  const moveTabToGroup = useTerminalStore((s) => s.moveTabToGroup);
  const setActivePane = useTerminalStore((s) => s.setActivePane);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || groups[0] || null;

  // Which group's switcher chip is currently being renamed inline. Lifted here
  // so a pane's "Rename Group…" menu item can open the switcher's editor
  // rather than duplicating one inside the pane.
  const [renamingGroupId, setRenamingGroupId] = useState(null);

  // null while idle; { tabId, title, startX, startY, x, y, active, targetPaneId, zone, targetGroupId }
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const cleanupRef = useRef(null);
  // Read inside the pointer handlers, which are created once per gesture.
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroup?.id ?? null;

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

        const hit = dropTargetAtPoint(ev.clientX, ev.clientY);
        // A group chip is only considered when the pointer isn't over a pane —
        // the switcher sits above the panes, never on top of one.
        const chip = hit ? null : groupChipAtPoint(ev.clientX, ev.clientY);
        const next = {
          ...cur,
          active: true,
          x: ev.clientX,
          y: ev.clientY,
          targetPaneId: hit?.paneId ?? null,
          zone: hit?.zone ?? null,
          // Dropping on the chip of the group the tab already lives in (the
          // active one — only its tabs are on screen) is a no-op, so it is
          // never highlighted as a target.
          targetGroupId:
            chip && chip.groupId !== activeGroupIdRef.current ? chip.groupId : null,
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
        if (!cur?.active) return;
        if (cur.targetPaneId) {
          // 'tabs' and 'center' both mean "into this pane"; only the
          // edges split.
          dropTabOnPane(cur.tabId, cur.targetPaneId, cur.zone === 'tabs' ? 'center' : cur.zone || 'center');
        } else if (cur.targetGroupId) {
          moveTabToGroup(cur.tabId, cur.targetGroupId);
        }
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
        targetGroupId: null,
      };
      dragRef.current = started;
      setDrag(started);

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      cleanupRef.current = detach;
    },
    [dropTabOnPane, moveTabToGroup]
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
  const handleSplit = useCallback(
    async (paneId, direction) => {
      const groupId = activeGroupIdRef.current;
      const newPaneId = await splitPane(paneId, direction, groupId);
      if (newPaneId) setActivePane(newPaneId, groupId);
    },
    [splitPane, setActivePane]
  );

  const handleClose = useCallback(
    (paneId) => {
      closePane(paneId, activeGroupIdRef.current);
    },
    [closePane]
  );

  const dragValue = useMemo(
    () => ({ drag, beginDrag, cancelActiveDrag }),
    [drag, beginDrag, cancelActiveDrag]
  );

  if (!activeGroup?.tree) return null;

  return (
    <DragContext.Provider value={dragValue}>
      <div className={cn('h-full w-full flex flex-col overflow-hidden', drag?.active && 'cursor-grabbing')}>
        <GroupSwitcher
          groups={groups}
          activeGroupId={activeGroup.id}
          renamingGroupId={renamingGroupId}
          setRenamingGroupId={setRenamingGroupId}
          headerSlot={headerSlot}
        />
        {/* Keyed by group: switching groups mounts a completely fresh tree, so
            react-resizable-panels re-reads `defaultLayout` from the group's
            own stored sizes instead of carrying the previous group's layout
            over. The terminals themselves live in terminalRegistry, so
            remounting costs nothing but a re-attach. */}
        <div key={activeGroup.id} className="flex-1 overflow-hidden">
          <SplitNode
            node={activeGroup.tree}
            groupId={activeGroup.id}
            activePaneId={activeGroup.activePaneId}
            onSplit={handleSplit}
            onClose={handleClose}
            canClose={activeGroup.tree.type !== 'leaf'}
            onRenameGroup={setRenamingGroupId}
          />
        </div>
        <DragPreview drag={drag} />
      </div>
    </DragContext.Provider>
  );
}

export default TerminalSplitContainer;
