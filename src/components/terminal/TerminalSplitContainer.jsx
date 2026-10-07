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
import { createPortal, flushSync } from 'react-dom';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import {
  sizesOf,
  layoutOf,
  panelMinSize,
  shouldReconcile,
  sizesFromLayout,
} from './splitLayout.js';
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
  Sparkles,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useTerminalStore, treeOnScreen, zoomedPaneOf } from '../../stores/terminalStore.js';
import { TerminalView } from './TerminalView.jsx';
import { AgentResumeBanner } from './AgentResumeBanner.jsx';
import { AGENT_IDS, agentLabel } from '../../lib/agents.js';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { cn } from '../../lib/utils.js';
import { ActivityDot } from './ActivityDot.jsx';
import { activityLabel, groupActivity } from '../../lib/tabActivity.js';
import { useShortcuts } from '../../hooks/useShortcuts.js';
import { copyText } from '../../lib/copyText.js';

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
//
// A zoomed group (`zoomedPaneId`, tmux's `Prefix z`) is drawn the same way one
// level down: only the zoomed pane is mounted, filling the area, and the panes
// it hides are unmounted exactly like another group's — alive, running, and
// told by TerminalView that they lost focus. `treeOnScreen` decides which.
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

/** Width of the insertion marker, which sits in the 2px gap beside a chip. */
const MARKER_PX = 2;
/** How near an edge of a row of chips a drag starts scrolling it. */
const AUTO_SCROLL_EDGE_PX = 28;
/** Scroll per frame with the pointer right on that edge; less short of it, more past it… */
const AUTO_SCROLL_STEP_PX = 8;
/** …up to this many times as much, however far past the edge the pointer goes. */
const AUTO_SCROLL_MAX_FACTOR = 3;
/**
 * How far a drag must have travelled from its press before it may scroll a
 * row at all. A click that jitters past DRAG_THRESHOLD_PX on a chip near an
 * edge would otherwise scroll the row out from under a pointer that never
 * meant to go anywhere, and land as a reorder.
 */
const AUTO_SCROLL_ARM_PX = 16;

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

// ---------------------------------------------------------------------------
// Where a dragged chip lands along a ROW of chips — a pane's tab strip, or the
// group switcher. Both rows scroll sideways once they hold more chips than
// fit, so a chip can be partly or wholly out of view, and both sit in a bar
// that also holds buttons (a pane's split/close buttons, the region chrome
// beside the switcher) which still count as "over the row".
//
// The arithmetic is kept apart from the DOM — rects in, numbers out — so it
// can be tested without a browser (tests/adversarial/tab_reorder_ui.test.js);
// `readChipRow` is the one place a row's geometry is read off the page.
// ---------------------------------------------------------------------------

/**
 * Where along a row of chips a drop at `x` would land, as a SLOT: how many of
 * the chips have their middle to the left of the pointer. 0 is before the
 * first chip and `chips.length` after the last — the numbering
 * `moveTabInStrip` and `reorderGroup` take. Every chip in the row is counted,
 * the dragged one included: it is still in its row, faded, which is what they
 * expect (one place right is two slots on).
 *
 * `chips` are the chips' rects (`{ left, right }`) in row order, scrolled-out
 * ones included; `visible` is the rect of the scrolling row they sit in — the
 * part of it on screen. With it:
 *
 *  - The pointer is clamped into `visible` first. Over a button beside the
 *    row it counts as the row's edge, never as a place among the chips
 *    scrolled out of view behind that button.
 *  - The slot is kept to the gaps that are on screen, so the marker drawn
 *    there can always be seen. Clamping alone does not do that: a chip cut
 *    off by the edge can have its middle on screen and its far side not, and
 *    "after it" would be drawn where nobody can see it.
 *
 * Getting to a chip that is out of view is auto-scroll's job, not this one's
 * (see `autoScrollStep`): the slot always says what the user can see.
 */
export function slotAtX(chips, x, visible = null) {
  const n = chips.length;
  const lo = visible ? visible.left : -Infinity;
  const hi = visible ? visible.right : Infinity;
  const px = Math.min(Math.max(x, lo), hi);

  let slot = 0;
  for (const chip of chips) {
    if (px > (chip.left + chip.right) / 2) slot += 1;
  }
  if (!visible || n === 0) return slot;

  // The marker for slot i fills the gap just before chip i; for slot n, the
  // one just after the last chip (see InsertionMarker). Half a pixel of slack
  // for fractional layout.
  const onScreen = (i) => {
    const start = i < n ? chips[i].left - MARKER_PX : chips[n - 1].right;
    return start >= lo - 0.5 && start + MARKER_PX <= hi + 0.5;
  };
  let first = 0;
  while (first <= n && !onScreen(first)) first += 1;
  let last = n;
  while (last >= first && !onScreen(last)) last -= 1;
  // No gap on screen at all (one chip wider than the row): nothing better to offer.
  if (first > last) return slot;
  return Math.min(Math.max(slot, first), last);
}

/**
 * A row's geometry, read off the page: the rect of the scrolling row (what is
 * on screen of it) and every chip in it, in row order. Every chip — the one
 * being dragged is still there, faded, and `slotAtX` counts it.
 */
export function readChipRow(row, chipSelector) {
  if (!row) return { chips: [], visible: null };
  const box = row.getBoundingClientRect();
  return {
    visible: { left: box.left, right: box.right },
    chips: [...row.querySelectorAll(chipSelector)].map((chip) => {
      const r = chip.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  };
}

/**
 * What a TAB dropped at this point would do — plus `row`, the row of chips the
 * pointer is over, for auto-scroll (never part of the drag's state).
 *
 * The terminal surface splits by quarter; the TAB STRIP means "put it in this
 * pane as a tab", which is how a split is merged back. The strip used not to
 * be a target at all, so dragging a tab onto the one place it visibly belongs
 * did nothing at all. Where along the strip matters too: the tab goes in at
 * the slot under the pointer, so the same gesture reorders a pane's own tabs.
 *
 * The whole strip is the target, its buttons included — so the row is found
 * through the strip, not under the pointer: over Split Down the pointer is
 * beside the row, and counts as its right edge (see `slotAtX`).
 */
export function dropTargetAtPoint(clientX, clientY, doc = document) {
  const el = doc.elementFromPoint(clientX, clientY);

  const strip = el?.closest?.('[data-tab-strip]');
  if (strip) {
    const row = strip.querySelector('[data-chip-row]');
    const { chips, visible } = readChipRow(row, '[data-tab-chip]');
    return {
      paneId: strip.getAttribute('data-tab-strip'),
      zone: 'tabs',
      slot: slotAtX(chips, clientX, visible),
      row,
    };
  }

  const body = el?.closest?.('[data-pane-body]');
  if (!body) return null;
  const rect = body.getBoundingClientRect();
  return {
    paneId: body.getAttribute('data-pane-body'),
    zone: zoneFromPoint(rect, clientX, clientY),
    row: null,
  };
}

/**
 * The group switcher under the pointer, if any: its scrolling row of chips,
 * and the group whose chip is right under the pointer (null between chips,
 * over "+", or over the region chrome beside the row).
 */
export function switcherAtPoint(clientX, clientY, doc = document) {
  const el = doc.elementFromPoint(clientX, clientY);
  const bar = el?.closest?.('[data-group-switcher]');
  if (!bar) return null;
  return {
    row: bar.querySelector('[data-chip-row]'),
    groupId: el.closest('[data-group-chip]')?.getAttribute('data-group-chip') ?? null,
  };
}

/**
 * Where along the switcher a dragged GROUP chip would land, as a slot (null
 * while the pointer is off the switcher), plus the row for auto-scroll. The
 * whole bar counts, not just the chips: past the last one (the "+" button, the
 * empty space, the region chrome) is as far as the row goes on screen.
 */
export function groupSlotAtPoint(clientX, clientY, doc = document) {
  const switcher = switcherAtPoint(clientX, clientY, doc);
  if (!switcher) return { slot: null, row: null };
  const { chips, visible } = readChipRow(switcher.row, '[data-group-chip]');
  return { slot: slotAtX(chips, clientX, visible), row: switcher.row };
}

/**
 * Which slot of a row to draw the insertion marker at, or null for none.
 *
 * The slots either side of the dragged chip's own position leave it where it
 * is, so they draw nothing: a marker always means the drop will move
 * something, and the faded chip already shows where it is now.
 */
export function markerSlot(slot, ids, draggedId) {
  if (typeof slot !== 'number') return null;
  const from = ids.indexOf(draggedId);
  if (from !== -1 && (slot === from || slot === from + 1)) return null;
  return slot;
}

/**
 * What a group chip let go at `slot` does: `{ type: 'reorder' }` to move it
 * there, `{ type: 'switch' }` to bring it on screen, or null for nothing.
 *
 * Dropped where it already is (either slot beside its own position) it is
 * treated as the click it almost was — as a tab chip dropped in place is
 * shown. A click whose pointer slips past the drag threshold is a drag that
 * goes nowhere, and the click that follows any drag is swallowed, so without
 * this a slightly shaky click on a group no longer switched to it. The group
 * already on screen, or a drop off the switcher, does nothing at all.
 */
export function groupDropAction(ids, groupId, slot, activeGroupId) {
  if (typeof slot !== 'number') return null;
  const from = ids.indexOf(groupId);
  if (from === -1) return null;
  if (slot === from || slot === from + 1) {
    return groupId === activeGroupId ? null : { type: 'switch' };
  }
  return { type: 'reorder' };
}

/**
 * How far to scroll a row this frame (px, negative to the left) with a drag's
 * pointer at `x`: nothing until the pointer is within AUTO_SCROLL_EDGE_PX of an
 * edge of the row on screen, then faster the closer it gets, and faster still
 * past the edge — over a pane's buttons, or the region chrome — up to a cap.
 */
export function autoScrollStep(x, visible) {
  if (!visible || !(visible.right > visible.left)) return 0;
  const toRight = x >= (visible.left + visible.right) / 2;
  const depth = toRight
    ? x - (visible.right - AUTO_SCROLL_EDGE_PX)
    : visible.left + AUTO_SCROLL_EDGE_PX - x;
  if (depth <= 0) return 0;
  const factor = Math.min(depth / AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_FACTOR);
  const step = Math.max(1, Math.round(factor * AUTO_SCROLL_STEP_PX));
  return toRight ? step : -step;
}

/**
 * Scrolls a row of chips, one step per frame, while a drag holds the pointer
 * near or past one of its edges — and calls `onScroll` after every step, so
 * the caller can measure the slot again under a pointer that has not moved.
 * It stops by itself once that end of the row is showing; `stop()` ends it
 * outright (drop, cancel, unmount).
 *
 * `follow(row, x)` says which row the pointer is over now (null for none) and
 * where; `frame`/`cancelFrame` are requestAnimationFrame and its cancel.
 */
export function createAutoScroller({ onScroll, frame, cancelFrame }) {
  let row = null;
  let x = 0;
  let pending = null;

  const tick = () => {
    pending = null;
    if (!row || row.isConnected === false) return;
    const box = row.getBoundingClientRect();
    const step = autoScrollStep(x, { left: box.left, right: box.right });
    if (!step) return;
    const before = row.scrollLeft;
    row.scrollLeft = before + step;
    if (row.scrollLeft === before) return; // that end of the row is showing
    pending = frame(tick); // before `onScroll`, which calls `follow` again
    onScroll();
  };

  return {
    follow(nextRow, nextX) {
      row = nextRow;
      x = nextX;
      if (row && pending === null) pending = frame(tick);
    },
    stop() {
      if (pending !== null) cancelFrame(pending);
      pending = null;
      row = null;
    },
  };
}

/**
 * Commit a tab or group rename left open when a drag starts, as a mouse press
 * would have: pressing a chip with a mouse moves focus to it, the editor's
 * blur commits the rename, and the editor is a chip again before the drag
 * arms. A touch drag moves no focus, so the editor stayed open — and with
 * one of its row's chips replaced by an input, every slot after it was
 * counted one short. Flushed, so the row is whole before it is measured.
 */
export function commitOpenRename(doc = document, flush = flushSync) {
  const el = doc.activeElement;
  if (!el?.matches?.('[data-rename-input]')) return false;
  flush(() => el.blur());
  return true;
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

/** The tab objects a group's tree holds, in pane order. */
function tabsOfGroup(tree, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return collectPanes(tree)
    .flatMap((pane) => pane.tabIds)
    .map((id) => byId.get(id))
    .filter(Boolean);
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
 * The thin bar that says where a dragged chip will land in a row of chips.
 *
 * It sits in the 2px gap beside a chip, absolutely placed, rather than being
 * inserted into the row: an inserted element would push the chips after it
 * along, which moves the very midpoints the slot is measured against under a
 * pointer that has not moved, and the marker would flicker between two slots.
 */
function InsertionMarker({ side }) {
  return (
    <span
      aria-hidden="true"
      data-insertion-marker={side}
      className={cn(
        'absolute top-0 bottom-0 w-0.5 rounded-full bg-vsc-accent pointer-events-none z-10',
        side === 'before' ? '-left-0.5' : '-right-0.5'
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
      {drag.kind === 'group' ? <LayoutGrid size={12} /> : <TerminalSquare size={12} />}
      <span className="truncate max-w-[140px]">{drag.title}</span>
    </div>,
    document.body
  );
}

/**
 * The pane strip's zoom control: a button that zooms the pane, or — while it
 * is zoomed — a chip that says so and unzooms it.
 *
 * The chip is the point. With its siblings hidden a zoomed pane looks exactly
 * like a group that has only one, and the panes it hides are still running:
 * without something on screen saying "Zoomed", a dev server or an agent in one
 * of them is easy to forget. Nothing at all for a group of one pane, which has
 * nothing to hide.
 */
function PaneZoomControl({ zoomed, canZoom, hiddenPanes, onToggle, shortcut }) {
  const keys = shortcut('toggle-pane-zoom');
  const swallowMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (zoomed) {
    const others = `${hiddenPanes} other pane${hiddenPanes === 1 ? '' : 's'}`;
    return (
      <button
        type="button"
        data-zoomed-chip=""
        aria-pressed="true"
        onClick={onToggle}
        onContextMenu={swallowMenu}
        title={`Zoomed — ${others} hidden, still running. Click to show every pane${keys ? ` (${keys})` : ''}`}
        className={cn(
          'shrink-0 flex items-center gap-1 h-[18px] px-1.5 rounded-sm text-ui-sm text-vsc-fg-bright',
          'ring-1 ring-inset ring-vsc-accent transition-colors',
          'bg-[color-mix(in_srgb,var(--vsc-accent)_25%,transparent)]',
          'hover:bg-[color-mix(in_srgb,var(--vsc-accent)_40%,transparent)]'
        )}
      >
        <Minimize2 size={12} />
        <span>Zoomed</span>
      </button>
    );
  }
  if (!canZoom) return null;
  return (
    <button
      type="button"
      aria-pressed="false"
      onClick={onToggle}
      onContextMenu={swallowMenu}
      className={paneHeaderBtn}
      title={`Zoom Pane — fill the group with it${keys ? ` (${keys})` : ''}`}
    >
      <Maximize2 size={14} />
    </button>
  );
}

/**
 * One pane of the active group's tree: its own tab strip plus the persistent
 * xterm for whichever of *its* tabs is active. Tabs can be dragged along a tab
 * strip to reorder them (their own, or another pane's, where they go in at the
 * marker), between panes, onto a pane's edge to split it, or onto another
 * group's switcher chip to move them to that group.
 */
function TerminalPane({
  node,
  groupId,
  isActivePane,
  onSplitH,
  onSplitV,
  onClose,
  canClose,
  onRenameGroup,
  zoomed = false,
  canZoom = false,
  hiddenPanes = 0,
  onToggleZoom,
}) {
  const { shortcut } = useShortcuts();
  const paneId = node.id;
  const tabs = useTerminalStore((s) => s.tabs);
  const switchTab = useTerminalStore((s) => s.switchTab);
  const bindPaneToTab = useTerminalStore((s) => s.bindPaneToTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const createTab = useTerminalStore((s) => s.createTab);
  const duplicateTab = useTerminalStore((s) => s.duplicateTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const startAgent = useTerminalStore((s) => s.startAgent);
  const resumeAgent = useTerminalStore((s) => s.resumeAgent);
  const dismissAgentResume = useTerminalStore((s) => s.dismissAgentResume);
  const listAgentSessions = useTerminalStore((s) => s.listAgentSessions);

  const { drag, beginDrag, cancelActiveDrag } = useContext(DragContext);

  // Inline "rename a tab" editor state — which tab (if any) is being edited.
  const [renamingTabId, setRenamingTabId] = useState(null);
  const [tabDraft, setTabDraft] = useState('');
  // The same, for `commitRenameTab`: a stray second blur (the input unmounting
  // right after Enter committed) must find the editor already closed.
  const renamingTabRef = useRef(null);
  // Right-click menus: a tab chip's "Rename", and the strip's empty area.
  const [chipMenu, setChipMenu] = useState(null); // { x, y, tabId }
  const [paneMenu, setPaneMenu] = useState(null); // { x, y }

  const dropZone = drag?.active && drag.targetPaneId === paneId ? drag.zone : null;

  // Only the tabs that belong to this pane, in its own order.
  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const boundTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;

  // Where in THIS strip the dragged tab would go in, as a slot — the chip it
  // would land before, or `paneTabs.length` for after the last — or null.
  const insertAt =
    dropZone === 'tabs' ? markerSlot(drag.slot, paneTabs.map((t) => t.id), drag.tabId) : null;

  const beginRenameTab = (tab) => {
    renamingTabRef.current = tab.id;
    setRenamingTabId(tab.id);
    setTabDraft(tab.title);
  };
  // The store is written here, never from inside a state updater: React runs
  // an updater during render whenever it cannot run it on the spot, and a
  // store write from there updates other components mid-render. A rename
  // committed by a touch drag's first move (see `commitOpenRename`) did that.
  const commitRenameTab = () => {
    const id = renamingTabRef.current;
    if (!id) return;
    renamingTabRef.current = null;
    renameTab(id, tabDraft);
    setRenamingTabId(null);
  };
  const cancelRenameTab = () => {
    renamingTabRef.current = null;
    setRenamingTabId(null);
  };

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
        {/* The row of chips: it scrolls once they do not fit, and a drag near
            either end of it scrolls it (see `createAutoScroller`). */}
        <div data-chip-row="" className="flex-1 flex items-center gap-0.5 px-1 h-full overflow-x-auto no-scrollbar">
          {paneTabs.map((tab, i) => {
            const isActive = tab.id === boundTab?.id;
            const isBeingDragged = drag?.active && drag.tabId === tab.id;

            if (renamingTabId === tab.id) {
              return (
                <div key={tab.id} className="flex items-center h-[22px]">
                  <input
                    autoFocus
                    data-rename-input=""
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
                // The activity is said in words as well as drawn as a dot —
                // a colour is not something a screen reader can read out, and
                // "why is that one red" should be answerable by hovering.
                title={
                  activityLabel(tab)
                    ? `${tab.title} — ${activityLabel(tab)}`
                    : `${tab.title} — drag along the tabs to reorder it, onto a terminal to move or split it, onto a group chip to move it there, double-click to rename`
                }
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  beginDrag(tab, e);
                }}
                onMouseDown={(e) => {
                  // Middle-click closes the tab, as it does on an editor tab.
                  if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTab(tab.id);
                  }
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
                  'relative group flex items-center px-2 h-[22px] rounded-sm text-ui-sm whitespace-nowrap',
                  'cursor-grab active:cursor-grabbing touch-none transition-colors',
                  isActive
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                    : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover',
                  isBeingDragged && 'opacity-40'
                )}
              >
                {insertAt === i && <InsertionMarker side="before" />}
                {insertAt === paneTabs.length && i === paneTabs.length - 1 && (
                  <InsertionMarker side="after" />
                )}
                <ActivityDot tab={tab} className="mr-1.5" />
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

                {/* Same slot, size and reveal as an editor tab's: a fixed box
                    so the chip does not change width on hover, hidden until
                    the pointer is over the chip, and always there on the
                    active one. Shown on the last tab too — closing it closes
                    the pane, which is what Close Pane does anyway. */}
                <span className="relative flex items-center justify-center w-3.5 h-3.5 shrink-0 ml-1.5">
                  <button
                    type="button"
                    tabIndex={-1}
                    // The chip starts a drag on pointerdown; without this,
                    // pressing the button arms one and the click that would
                    // have closed the tab drags it instead.
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    title="Close Terminal"
                    aria-label={`Close ${tab.title}`}
                    className={cn(
                      'absolute inset-0 flex items-center justify-center rounded-sm hover:bg-vsc-item-hover hover:text-vsc-error',
                      'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                      isActive && 'opacity-100'
                    )}
                  >
                    <X size={14} />
                  </button>
                </span>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => createTab(null, { paneId, groupId })}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={cn(paneHeaderBtn, 'shrink-0')}
            title={`New Terminal in this pane (${shortcut('new-terminal')})`}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="flex items-center gap-0.5 px-1 shrink-0">
          <PaneZoomControl
            zoomed={zoomed}
            canZoom={canZoom}
            hiddenPanes={hiddenPanes}
            onToggle={() => onToggleZoom?.(paneId)}
            shortcut={shortcut}
          />
          <button
            type="button"
            onClick={onSplitH}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={paneHeaderBtn}
            title={`Split Right (${shortcut('split-right')})`}
          >
            <SplitSquareHorizontal size={14} />
          </button>
          <button
            type="button"
            onClick={onSplitV}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={paneHeaderBtn}
            title={`Split Down (${shortcut('split-down')})`}
          >
            <SplitSquareVertical size={14} />
          </button>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
              className={cn(paneHeaderBtn, 'hover:text-vsc-error')}
              title={`Close Pane (${shortcut('close-pane')})`}
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
                    if (target?.cwd) copyText(target.cwd);
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
          // A terminal opened here and told to run an agent, so NexTerm knows
          // which conversation it is and can offer it back after a restart.
          // Typing `claude` yourself still works and always did — it just
          // cannot be picked up again, because nothing recorded the id.
          ...AGENT_IDS.map((kind) => ({
            key: `new-${kind}`,
            label: `New ${agentLabel(kind)} Terminal`,
            icon: Sparkles,
            onSelect: async () => {
              const created = await createTab(null, { paneId, groupId });
              if (created?.id) startAgent(created.id, kind);
            },
          })),
          { type: 'separator', key: 'agents-sep' },
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
          // The resume offer is a row of its own ABOVE the terminal. Laid over
          // it, it hid the first three rows — exactly where a freshly restored
          // shell prints its prompt. The terminal gets the rest; TerminalView's
          // ResizeObserver refits the xterm (and tells the shell) when the
          // offer appears and when it goes. `data-pane-body` stays on the
          // outer box, so the banner still counts as part of the drop target.
          <div className="flex flex-col h-full">
            <AgentResumeBanner
              tab={boundTab}
              onResume={() => resumeAgent(boundTab.id)}
              onDismiss={() => dismissAgentResume(boundTab.id)}
              onListSessions={() => listAgentSessions(boundTab.id)}
              onResumeWith={(choice) => resumeAgent(boundTab.id, choice)}
            />
            <div className="relative flex-1 min-h-0">
              <TerminalView tabId={boundTab.id} active={isActivePane} />
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-ui-sm text-vsc-muted select-none">
            <p className="m-0">No terminal in this pane</p>
            <button
              type="button"
              onClick={() => createTab(null, { paneId, groupId })}
              className="px-3 py-1 rounded-sm bg-vsc-button-secondary hover:bg-vsc-item-hover text-vsc-fg transition"
            >
              New Terminal
              <span className="ml-2 text-vsc-muted font-mono">{shortcut('new-terminal')}</span>
            </button>
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutOf(node), [layoutKey]);

  useLayoutEffect(() => {
    const handle = groupRef.current;
    if (!handle) return;
    let current;
    try {
      current = handle.getLayout();
    } catch (_) {
      return;
    }
    // `setLayout` throws unless the layout names exactly the Group's panels.
    if (!shouldReconcile(current, layout)) return;
    try {
      handle.setLayout(layout);
    } catch (_) {
      // A transient mismatch (panels mid-registration) — the next store
      // change, or the next mount's `defaultLayout`, puts it right.
    }
  }, [layout, groupRef]);

  const handleLayoutChanged = useCallback(
    (nextLayout, meta) => {
      const next = sizesFromLayout(childIds, nextLayout, meta);
      if (!next) return;
      setPaneSizes(groupId, node.id, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childIds.join(','), groupId, node.id, setPaneSizes]
  );

  const direction = node.direction === 'vertical' ? 'vertical' : 'horizontal';
  const minSize = panelMinSize(node.children.length);

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
 *
 * `zoom` is the group's zoom, the same for every pane: `{ paneId, canZoom,
 * hiddenPanes, onToggle }` — the zoomed pane's id (null when none), whether
 * the group has panes enough to zoom one, how many a zoom is hiding.
 */
function SplitNode({ node, groupId, activePaneId, onSplit, onClose, canClose, onRenameGroup, zoom }) {
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
        zoomed={Boolean(zoom?.paneId) && zoom.paneId === node.id}
        canZoom={Boolean(zoom?.canZoom)}
        hiddenPanes={zoom?.hiddenPanes ?? 0}
        onToggleZoom={zoom?.onToggle}
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
          zoom={zoom}
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
 *
 * And each chip is a drag handle of its own: dragged along the switcher it
 * reorders the groups (`reorderGroup`), with the same marker a tab strip
 * shows. Same gesture as a tab chip's — a press only becomes a drag past the
 * threshold, so a click still switches and a double-click still renames.
 */
function GroupSwitcher({ groups, activeGroupId, renamingGroupId, setRenamingGroupId, headerSlot }) {
  // Its own subscription: this component is rendered outside the one that
  // holds the pane tree, so it has no `tabs` of its own to read a group's
  // activity from. (Referencing the other component's binding here compiled
  // fine and white-screened the app at run time — the exact failure mode React
  // has no way to warn about.)
  const tabs = useTerminalStore((s) => s.tabs);
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const createGroup = useTerminalStore((s) => s.createGroup);
  const closeGroup = useTerminalStore((s) => s.closeGroup);
  const renameGroup = useTerminalStore((s) => s.renameGroup);

  const { drag, beginGroupDrag, cancelActiveDrag } = useContext(DragContext);

  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, groupId }
  const [creating, setCreating] = useState(false);

  // Where a dragged group chip would go in, as a slot of `groups` (the chip it
  // would land before, or `groups.length` for after the last) — or null.
  const insertAt =
    drag?.active && drag.kind === 'group'
      ? markerSlot(drag.slot, groups.map((g) => g.id), drag.groupId)
      : null;

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

  // Which group's editor is open as of the latest render, for `commitRename`:
  // a stray second blur (the input unmounting right after Enter already
  // committed) must find it closed and not re-apply the rename. A ref, not a
  // functional update: the store is written outside any state updater, which
  // React may run mid-render (see `commitRenameTab`).
  const renamingRef = useRef(renamingGroupId);
  renamingRef.current = renamingGroupId;

  const commitRename = (groupId) => {
    if (renamingRef.current !== groupId) return;
    renamingRef.current = null;
    renameGroup(groupId, draft);
    setRenamingGroupId(null);
  };
  const cancelRename = () => {
    renamingRef.current = null;
    setRenamingGroupId(null);
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
      {/* `pl-0.5` is room for the insertion marker before the first chip: the
          row scrolls, so it clips whatever is drawn outside its own box. */}
      <div
        role="tablist"
        aria-label="Terminal groups"
        data-chip-row=""
        className="flex-1 flex items-center gap-0.5 pl-0.5 overflow-x-auto no-scrollbar"
      >
        {groups.map((group, i) => {
          const isActive = group.id === activeGroupId;
          const isDropTarget = Boolean(drag?.active) && drag.targetGroupId === group.id;
          const isBeingDragged = Boolean(drag?.active) && drag.kind === 'group' && drag.groupId === group.id;
          const terminals = countTerminals(group.tree);
          // Switching groups replaces the whole arrangement, so a command
          // failing in one you are not looking at is invisible without this.
          const activity = groupActivity(tabsOfGroup(group.tree, tabs));
          // Every group keeps its own zoom across switches, so the chip says
          // which ones will come back with panes hidden.
          const zoomed = Boolean(zoomedPaneOf(group));

          if (renamingGroupId === group.id) {
            return (
              <input
                key={group.id}
                autoFocus
                data-rename-input=""
                value={draft}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename(group.id);
                  else if (e.key === 'Escape') cancelRename();
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
              aria-grabbed={isBeingDragged}
              title={`${group.name} — ${terminals} terminal${terminals === 1 ? '' : 's'}${
                activity === 'running'
                  ? ', one of them running a command'
                  : activity === 'failed'
                    ? ', one of them ended on a failure'
                    : ''
              }${zoomed ? ', one pane zoomed' : ''}. Click to switch, drag to reorder, drop a terminal here to move it, double-click to rename.`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                beginGroupDrag(group, e);
              }}
              onClick={() => {
                if (Date.now() - lastDragEndAt < 200) return;
                setActiveGroup(group.id);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // As on a tab chip: neither press of a double-click travels
                // far enough to arm a drag, and this makes sure of it.
                cancelActiveDrag();
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
                'relative shrink-0 flex items-center gap-1 pl-2 pr-1 h-[20px] rounded-sm text-ui-sm',
                'cursor-grab active:cursor-grabbing touch-none transition-colors',
                isActive
                  ? 'bg-vsc-tab-active text-vsc-tab-active-fg'
                  : 'text-vsc-tab-inactive-fg hover:bg-vsc-hover',
                isDropTarget &&
                  'ring-1 ring-vsc-focus bg-[color-mix(in_srgb,var(--vsc-accent)_25%,transparent)]',
                isBeingDragged && 'opacity-40'
              )}
            >
              {insertAt === i && <InsertionMarker side="before" />}
              {insertAt === groups.length && i === groups.length - 1 && <InsertionMarker side="after" />}
              <ActivityDot state={activity} />
              <span className="truncate max-w-[140px]">{group.name}</span>
              {zoomed && <Maximize2 size={10} aria-label="one pane zoomed" className="shrink-0 opacity-70" />}
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
  const moveTabInStrip = useTerminalStore((s) => s.moveTabInStrip);
  const moveTabToGroup = useTerminalStore((s) => s.moveTabToGroup);
  const reorderGroup = useTerminalStore((s) => s.reorderGroup);
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const togglePaneZoom = useTerminalStore((s) => s.togglePaneZoom);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || groups[0] || null;

  // Which group's switcher chip is currently being renamed inline. Lifted here
  // so a pane's "Rename Group…" menu item can open the switcher's editor
  // rather than duplicating one inside the pane.
  const [renamingGroupId, setRenamingGroupId] = useState(null);

  // null while idle. A terminal tab being dragged:
  //   { kind: 'tab', tabId, title, startX, startY, x, y, active, targetPaneId, zone, slot, targetGroupId }
  // a group chip being dragged along the switcher:
  //   { kind: 'group', groupId, title, startX, startY, x, y, active, slot }
  // `slot` is where in a row of chips it would go in (see `slotAtX`).
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const cleanupRef = useRef(null);
  // Read inside the pointer handlers, which are created once per gesture.
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroup?.id ?? null;

  /**
   * Follow one press from pointerdown to release. `started` is the drag state
   * at the press; `targetAt(x, y)` says what the pointer is over, merged into
   * that state on every move once the press has travelled past the threshold;
   * `drop(drag)` acts on the last of it on release. A press that never
   * travelled that far is a click, and drops nothing.
   *
   * `targetAt` may also name the `row` of chips under the pointer, which is
   * kept out of the state and handed to the auto-scroller: held near either
   * end of a row that overflows, the row scrolls, and the target is measured
   * again after every step — the pointer has not moved, the chips have. The
   * same goes for a row scrolled any other way mid-drag (a wheel, a
   * trackpad): every scroll re-measures, so the marker and the drop follow.
   *
   * Listeners are attached synchronously here rather than from an effect: a
   * quick flick delivers pointermove/up before React has committed the state
   * change, so an effect-bound listener would miss the whole gesture.
   */
  const trackGesture = useCallback((started, targetAt, drop) => {
    // A press while an earlier gesture is still listening — its release went
    // somewhere the window never heard — starts over rather than stacking a
    // second set of listeners that would act on this drag's state.
    cleanupRef.current?.();

    let pointer = null; // where the pointer last was, once the drag is active
    let scrollArmed = false; // see AUTO_SCROLL_ARM_PX

    const aim = () => {
      const cur = dragRef.current;
      if (!cur || !pointer) return;
      const { row = null, ...hit } = targetAt(pointer.x, pointer.y) ?? {};
      const next = { ...cur, active: true, x: pointer.x, y: pointer.y, ...hit };
      // Re-measured after a scroll that moved nothing across a slot, the
      // drag is what it was: no new state, no render.
      const changed = Object.keys(next).some((k) => next[k] !== cur[k]);
      if (changed) {
        dragRef.current = next;
        setDrag(next);
      }
      scroller.follow(scrollArmed ? row : null, pointer.x);
    };

    const scroller = createAutoScroller({
      onScroll: aim,
      frame: (cb) => window.requestAnimationFrame(cb),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
    });

    // Scroll events do not bubble, so this listens in the capture phase.
    const onScroll = () => {
      if (dragRef.current?.active) aim();
    };

    const detach = () => {
      scroller.stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('scroll', onScroll, true);
      cleanupRef.current = null;
    };

    const onMove = (ev) => {
      const cur = dragRef.current;
      if (!cur) return;
      const travelled = Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY);
      if (!cur.active && travelled <= DRAG_THRESHOLD_PX) return;

      // Becoming a drag: a rename still open in a row would be measured as a
      // chip short (see `commitOpenRename`).
      if (!cur.active) commitOpenRename();
      if (travelled >= AUTO_SCROLL_ARM_PX) scrollArmed = true;
      pointer = { x: ev.clientX, y: ev.clientY };
      aim();
    };

    const onUp = () => {
      const cur = dragRef.current;
      detach();
      dragRef.current = null;
      setDrag(null);
      if (cur?.active) lastDragEndAt = Date.now();
      if (!cur?.active) return;
      drop(cur);
    };

    const onCancel = () => {
      detach();
      dragRef.current = null;
      setDrag(null);
    };

    dragRef.current = started;
    setDrag(started);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('scroll', onScroll, true);
    cleanupRef.current = detach;
  }, []);

  /** A terminal tab's chip: onto a pane, a tab strip, or another group's chip. */
  const beginDrag = useCallback(
    (tab, e) => {
      const started = {
        kind: 'tab',
        tabId: tab.id,
        title: tab.title,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        targetPaneId: null,
        zone: null,
        slot: null,
        targetGroupId: null,
      };

      const targetAt = (x, y) => {
        const hit = dropTargetAtPoint(x, y);
        // A group chip is only considered when the pointer isn't over a pane —
        // the switcher sits above the panes, never on top of one. Its row
        // scrolls under a tab too, so a group whose chip is out of view can
        // still be reached.
        const switcher = hit ? null : switcherAtPoint(x, y);
        const groupId = switcher?.groupId ?? null;
        return {
          targetPaneId: hit?.paneId ?? null,
          zone: hit?.zone ?? null,
          slot: hit?.slot ?? null,
          // Dropping on the chip of the group the tab already lives in (the
          // active one — only its tabs are on screen) is a no-op, so it is
          // never highlighted as a target.
          targetGroupId: groupId && groupId !== activeGroupIdRef.current ? groupId : null,
          row: hit ? hit.row : switcher?.row ?? null,
        };
      };

      const drop = (cur) => {
        if (cur.targetPaneId && cur.zone === 'tabs') {
          // Into that pane at the marker. Along its own strip that is a
          // reorder; a drop where it already is changes nothing at all.
          moveTabInStrip(cur.tabId, cur.targetPaneId, cur.slot);
        } else if (cur.targetPaneId) {
          // The centre means "into this pane"; only the edges split.
          dropTabOnPane(cur.tabId, cur.targetPaneId, cur.zone || 'center');
        } else if (cur.targetGroupId) {
          moveTabToGroup(cur.tabId, cur.targetGroupId);
        }
      };

      trackGesture(started, targetAt, drop);
    },
    [trackGesture, dropTabOnPane, moveTabInStrip, moveTabToGroup]
  );

  /**
   * A group's chip, along the switcher. Anywhere else it has nowhere to go:
   * let go off the switcher and nothing moves. Let go where it already is,
   * and it switches to that group, as the click it nearly was would have
   * (see `groupDropAction`).
   */
  const beginGroupDrag = useCallback(
    (group, e) => {
      const started = {
        kind: 'group',
        groupId: group.id,
        title: group.name,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        slot: null,
      };
      trackGesture(
        started,
        (x, y) => groupSlotAtPoint(x, y),
        (cur) => {
          const st = useTerminalStore.getState();
          const action = groupDropAction(
            st.groups.map((g) => g.id),
            cur.groupId,
            cur.slot,
            st.activeGroupId
          );
          if (action?.type === 'reorder') reorderGroup(cur.groupId, cur.slot);
          else if (action?.type === 'switch') setActiveGroup(cur.groupId);
        }
      );
    },
    [trackGesture, reorderGroup, setActiveGroup]
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
  // pane split wasn't already the focused one. Focused by the pane alone,
  // which names its group: a split whose group went away while its shell
  // started lands in another one (see the store's `splitPane`).
  const handleSplit = useCallback(
    async (paneId, direction) => {
      const newPaneId = await splitPane(paneId, direction, activeGroupIdRef.current);
      if (newPaneId) setActivePane(newPaneId);
    },
    [splitPane, setActivePane]
  );

  const handleClose = useCallback(
    (paneId) => {
      closePane(paneId, activeGroupIdRef.current);
    },
    [closePane]
  );

  const handleToggleZoom = useCallback(
    (paneId) => {
      togglePaneZoom?.(paneId, activeGroupIdRef.current);
    },
    [togglePaneZoom]
  );

  const dragValue = useMemo(
    () => ({ drag, beginDrag, beginGroupDrag, cancelActiveDrag }),
    [drag, beginDrag, beginGroupDrag, cancelActiveDrag]
  );

  if (!activeGroup?.tree) return null;

  // Which panes are drawn: all of them, or the zoomed one alone (see
  // `treeOnScreen`). A hidden pane is simply not mounted; its terminal waits
  // in the registry, running, like a terminal in another group.
  const zoomedPane = zoomedPaneOf(activeGroup);
  const shownTree = treeOnScreen(activeGroup);
  const paneCount = collectPanes(activeGroup.tree).length;
  const zoom = {
    paneId: zoomedPane?.id ?? null,
    canZoom: paneCount > 1,
    hiddenPanes: zoomedPane ? paneCount - 1 : 0,
    onToggle: handleToggleZoom,
  };

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
            remounting costs nothing but a re-attach.

            And by zoom, for the same reason: unzooming mounts the splits
            afresh from the stored sizes, which the zoom never touched — that
            is what puts the layout back exactly. Both ways the terminals that
            change size remount and fit, and their programs are told the new
            size (TerminalView's `fitAndReport`), so a TUI redraws for it. */}
        <div
          key={zoomedPane ? `${activeGroup.id}:zoom:${zoomedPane.id}` : activeGroup.id}
          className="flex-1 overflow-hidden"
        >
          <SplitNode
            node={shownTree}
            groupId={activeGroup.id}
            activePaneId={activeGroup.activePaneId}
            onSplit={handleSplit}
            onClose={handleClose}
            canClose={activeGroup.tree.type !== 'leaf'}
            onRenameGroup={setRenamingGroupId}
            zoom={zoom}
          />
        </div>
        <DragPreview drag={drag} />
      </div>
    </DragContext.Provider>
  );
}

export default TerminalSplitContainer;
