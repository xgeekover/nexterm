import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { X, Circle, FileCode2, FileJson, FileText, File, SplitSquareHorizontal, SplitSquareVertical } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { moveEditorToNewPane } from '../../lib/workbenchCommands.js';

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
 * Pointer-drag state shared by every editor pane's tab strip and the
 * workbench that owns the gesture and renders the drop indicators: the ONE
 * drag of TerminalSplitContainer.jsx (editor placement, sibling C, FC3),
 * which hands its editor chips' presses to `trackTabDrag` below. Value:
 * { drag, beginDrag }.
 */
export const EditorDragContext = createContext({ drag: null, beginDrag: () => {} });

/**
 * When a drag ends, the browser may still deliver a trailing `click` to the
 * chip the gesture started on; `trackTabDrag` calls this on pointerup so the
 * click below can be ignored (mirrors TerminalSplitContainer's
 * `lastDragEndAt` guard).
 */
let lastDragEndAt = 0;
export function markEditorDragEnded() {
  lastDragEndAt = Date.now();
}
export function wasJustDragged() {
  return Date.now() - lastDragEndAt < 200;
}

/** Pointer travel before a press turns into a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How deep into a pane counts as an edge (split) rather than the centre (move). */
const EDGE_FRACTION = 0.25;
/** How near either end of a tab row a dragged tab starts scrolling it. */
const AUTO_SCROLL_ZONE_PX = 32;
/** Scrolling speed, in px per second, with the pointer at the very end of a row. */
const AUTO_SCROLL_PX_PER_S = 480;
/** Past the end — over the strip's own buttons — it keeps speeding up, to this many times that. */
const AUTO_SCROLL_MAX_FACTOR = 3;

/**
 * Dragging is done with pointer events rather than HTML5 drag & drop — same
 * reasoning as TerminalSplitContainer.jsx: WKWebView (what Tauri uses on
 * macOS) refuses to start a native drag on an element inside a
 * `user-select: none` subtree, which the tab strip is. Pointer events behave
 * the same in every webview and let us draw our own preview and drop zones.
 *
 * These helpers came here from EditorPanel.jsx (sibling C): that module is
 * Monaco's and loads lazily, while the strip and its gesture are drawn by the
 * workbench at once. They import nothing of Monaco.
 */

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

/**
 * What a drop at this point would do, over the EDITOR panes only — the
 * editor half of the workbench's one hit test (`dropTargetAtPoint` in
 * TerminalSplitContainer.jsx, which adds the kinds and the cross-kind rule).
 *
 * Over a pane's BODY, the centre moves the tab into that group and the edges
 * split it. Over a TAB STRIP — its row of chips or its own buttons — the tab
 * goes into that strip at a gap, which is how the order of the tabs is
 * changed at all. `stripSlotAt` picks the gap: before or after the chip under
 * the pointer, counting the dragged chip like any other (it stays in its
 * strip, dimmed, for the whole gesture), which is exactly how
 * `moveEditorTabInStrip` takes it. Only the part of the row that is on screen
 * counts: past the last chip that can be seen — over the buttons of a strip
 * with more tabs than fit, say — the gap is the last one in view, not the end
 * of the strip. The end is reached by scrolling the row, which holding the
 * drag near it does (`createStripAutoScroller`).
 *
 * `doc` is a parameter only so that a test can stand in for the page.
 */
export function dropTargetAtPoint(clientX, clientY, doc = document) {
  const el = doc.elementFromPoint(clientX, clientY);

  const strip = el?.closest?.('[data-editor-tab-strip]');
  if (strip) {
    const row = strip.querySelector('[data-editor-tab-row]') ?? strip;
    const chips = Array.from(strip.querySelectorAll('[data-tab-chip]'), (chip) => chip.getBoundingClientRect());
    return {
      paneId: strip.getAttribute('data-editor-tab-strip'),
      zone: 'tabs',
      index: stripSlotAt(chips, row.getBoundingClientRect(), clientX),
    };
  }

  const body = el?.closest?.('[data-editor-pane-body]');
  if (!body) return null;
  return {
    paneId: body.getAttribute('data-editor-pane-body'),
    zone: zoneFromPoint(body.getBoundingClientRect(), clientX, clientY),
    index: null,
  };
}

/**
 * How fast a tab row should scroll with a dragged tab held at `clientX`, in
 * px per second: negative toward its start, positive toward its end, 0
 * anywhere but near one of them. Within AUTO_SCROLL_ZONE_PX of an end the
 * speed grows in proportion to how near the pointer is, reaching
 * AUTO_SCROLL_PX_PER_S at the end itself, and past the end — over the strip's
 * own buttons — it keeps growing, up to AUTO_SCROLL_MAX_FACTOR times that. A
 * row too narrow for two zones is split between them.
 */
export function stripAutoScrollSpeed(row, clientX) {
  const zone = Math.min(AUTO_SCROLL_ZONE_PX, (row.right - row.left) / 2);
  if (!(zone > 0)) return 0;
  const towardEnd = (clientX - (row.right - zone)) / zone;
  if (towardEnd > 0) return AUTO_SCROLL_PX_PER_S * Math.min(towardEnd, AUTO_SCROLL_MAX_FACTOR);
  const towardStart = (row.left + zone - clientX) / zone;
  if (towardStart > 0) return -AUTO_SCROLL_PX_PER_S * Math.min(towardStart, AUTO_SCROLL_MAX_FACTOR);
  return 0;
}

/**
 * Scrolls a tab strip's row while a dragged tab is held near either end of
 * it, so that every gap of a strip with more tabs than fit can be reached —
 * a drop only ever goes into a gap that is on screen (see `stripSlotAt`).
 *
 * Call `follow(paneId, x)` whenever the pointer moves, with the pane whose
 * strip it is over (null for none), and `stop()` when the gesture ends,
 * however it ends. Between the two it runs at most one requestAnimationFrame
 * loop, which ends by itself as soon as there is nothing to do: the pointer
 * is not near an end, or the row is already as far as it goes. It only
 * scrolls; what is under the pointer is measured again by whoever listens for
 * the row's `scroll` events.
 *
 * `rowOf(paneId)` finds a strip's scrolling row. The frame functions are
 * parameters only so that a test can run the loop on a clock of its own.
 */
export function createStripAutoScroller({
  rowOf,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
}) {
  let pointer = null; // { paneId, x } while the pointer is over a tab strip
  let frame = 0;
  let lastTime = null;
  let owed = 0; // the part of a pixel not scrolled yet

  const idle = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    lastTime = null;
    owed = 0;
  };

  const tick = (time) => {
    frame = 0;
    const row = pointer ? rowOf(pointer.paneId) : null;
    const speed = row ? stripAutoScrollSpeed(row.getBoundingClientRect(), pointer.x) : 0;
    const from = row ? row.scrollLeft : 0;
    const max = row ? row.scrollWidth - row.clientWidth : 0;
    if (speed === 0 || (speed < 0 ? from <= 0 : from >= max)) {
      idle();
      return;
    }

    // Per second, not per frame — a 120Hz screen scrolls no faster — and a
    // long wait between frames (a hidden window) is not made up in one jump.
    const elapsed = lastTime === null ? 1000 / 60 : Math.min(Math.max(time - lastTime, 0), 50);
    lastTime = time;
    owed += (speed * elapsed) / 1000;
    const step = Math.trunc(owed);
    owed -= step;
    // The next frame is asked for before scrolling, so that anything the
    // scroll sets off before this returns — a `follow` included — finds one
    // already asked for and never starts a second loop.
    frame = requestFrame(tick);
    if (step === 0) return;
    row.scrollLeft = Math.min(Math.max(from + step, 0), max);
    // A row that did not move is as far as it goes.
    if (row.scrollLeft === from) idle();
  };

  return {
    follow(paneId, x) {
      pointer = paneId == null ? null : { paneId, x };
      if (pointer && !frame) frame = requestFrame(tick);
    },
    stop() {
      pointer = null;
      idle();
    },
  };
}

/**
 * Follows one press on an editor tab chip from pointerdown to release, and
 * returns the function that ends it early: on an unmount, or on a second
 * press while this one is still listening.
 *
 * `onChange(drag)` is handed the drag state whenever it changes, and null
 * once the gesture is over: { tabKind: 'editor', tabId, title, startX,
 * startY, x, y, active, targetPaneId, paneKind, zone, index, targetGroupId },
 * where `zone` is 'tabs' over an editor tab strip and `index` the gap the
 * pointer is over, or else the body's move/split zone and `index` null. A
 * press only becomes a drag once it has travelled DRAG_THRESHOLD_PX; until
 * then it is a click. `onDrop(drag)` is handed the state a drag was let go
 * in, if that was over somewhere a tab can go — a pane, or another group's
 * chip — the very state the marker was drawn from.
 *
 * `targetAt(x, y)` says what is under the pointer. The workbench hands in its
 * one hit test, which knows both kinds of pane and the group switcher; left
 * out, it is the editor panes' own (`dropTargetAtPoint` above).
 *
 * What is under the pointer is measured again whenever anything scrolls, not
 * only when the pointer moves: a row scrolled by the wheel, or by its own
 * auto-scroll (`createStripAutoScroller`), moves its chips under a pointer
 * that stays put, and the gap — and the marker drawn in it — has to go with
 * them, or a release right after drops the tab in a gap the marker has left.
 *
 * Listeners are attached synchronously here rather than from an effect: a
 * quick flick delivers pointermove/up before React has committed anything, so
 * an effect-bound listener would miss the whole gesture. `win`, `doc` and the
 * frame functions are parameters only so that a test can drive a gesture
 * without a browser.
 */
export function trackTabDrag(
  tab,
  press,
  { onChange, onDrop, targetAt = null, win = window, doc = document, requestFrame, cancelFrame }
) {
  let drag = {
    tabKind: 'editor',
    tabId: tab.id,
    title: tab.fileName,
    startX: press.clientX,
    startY: press.clientY,
    x: press.clientX,
    y: press.clientY,
    active: false,
    targetPaneId: null,
    paneKind: null,
    zone: null,
    index: null,
    targetGroupId: null,
  };
  const hitAt = targetAt ?? ((x, y) => dropTargetAtPoint(x, y, doc));

  const scroller = createStripAutoScroller({
    rowOf: (paneId) => doc.querySelector(`[data-editor-tab-row="${paneId}"]`),
    requestFrame,
    cancelFrame,
  });

  const KEYS = ['x', 'y', 'targetPaneId', 'paneKind', 'zone', 'index', 'targetGroupId'];
  const pointAt = (x, y) => {
    const hit = hitAt(x, y);
    const next = {
      ...drag,
      active: true,
      x,
      y,
      targetPaneId: hit?.paneId ?? null,
      paneKind: hit?.paneKind ?? (hit?.paneId ? 'editor' : null),
      zone: hit?.zone ?? null,
      index: hit?.index ?? null,
      targetGroupId: hit?.targetGroupId ?? null,
    };
    if (!drag.active || KEYS.some((key) => next[key] !== drag[key])) {
      drag = next;
      onChange(next);
    }
    // Only an editor strip is scrolled from here: the other kind's strip is
    // no target for a file (FC3).
    scroller.follow(next.zone === 'tabs' && next.paneKind === 'editor' ? next.targetPaneId : null, x);
  };

  const detach = () => {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('pointercancel', onCancel);
    win.removeEventListener('scroll', onScroll, true);
    scroller.stop();
  };

  const onMove = (ev) => {
    const travelled = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
    if (!drag.active && travelled <= DRAG_THRESHOLD_PX) return;
    pointAt(ev.clientX, ev.clientY);
  };

  // `scroll` does not bubble, so the window hears it in the capture phase.
  // Any element's will do: whatever scrolled, the pointer may be over
  // something else now.
  const onScroll = () => {
    if (drag.active) pointAt(drag.x, drag.y);
  };

  const onUp = () => {
    detach();
    const last = drag;
    onChange(null);
    if (!last.active) return;
    markEditorDragEnded();
    if (last.targetPaneId || last.targetGroupId) onDrop(last);
  };

  const onCancel = () => {
    detach();
    onChange(null);
  };

  onChange(drag);
  win.addEventListener('pointermove', onMove);
  win.addEventListener('pointerup', onUp);
  win.addEventListener('pointercancel', onCancel);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return detach;
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
 * The `scrollLeft` that brings the active chip wholly into view of a strip
 * too narrow for its tabs — `row` and `chip` as `getBoundingClientRect`
 * gives them — or the current one when it is in view already. Off the end,
 * a tab opened or picked from the Explorer stayed covered by the next group
 * and could be neither seen nor reached (V39).
 */
export function scrollLeftToShow(row, chip, scrollLeft) {
  if (!row || !chip) return scrollLeft;
  if (chip.left < row.left) return Math.max(0, scrollLeft - (row.left - chip.left));
  if (chip.right > row.right) return scrollLeft + Math.min(chip.right - row.right, chip.left - row.left);
  return scrollLeft;
}

/**
 * Scroll `row`, a strip's scrolling row of chips, until `activeId`'s chip is
 * in view (`scrollLeftToShow`). Returns whether it moved.
 */
export function revealActiveChip(row, activeId) {
  if (!row || !activeId) return false;
  const chip = [...row.querySelectorAll('[data-tab-chip]')].find((el) => el.getAttribute('data-tab-chip') === activeId);
  if (!chip) return false;
  const next = scrollLeftToShow(row.getBoundingClientRect(), chip.getBoundingClientRect(), row.scrollLeft);
  if (next === row.scrollLeft) return false;
  row.scrollLeft = next;
  return true;
}

/**
 * Keep the active chip in view while the strip itself is resized: a split,
 * or a divider dragged, narrowed the group and left its active tab off the
 * end — no tab had changed, so nothing showed it again (V39, found on
 * macOS). The strip as VS Code keeps it. Returns the cleanup; without a
 * `ResizeObserver` there is nothing to follow.
 */
export function revealActiveChipOnResize(row, activeId, { Observer = globalThis.ResizeObserver } = {}) {
  if (!row || !activeId || typeof Observer !== 'function') return () => {};
  const observer = new Observer(() => revealActiveChip(row, activeId));
  observer.observe(row);
  return () => observer.disconnect();
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
export function EditorTabs({ node, onSplitH, onSplitV, onClose, canClose = false, extra = null }) {
  const paneId = node.id;
  const tabs = useEditorStore((s) => s.tabs);
  const bindEditorPaneToTab = useEditorStore((s) => s.bindEditorPaneToTab);
  const requestCloseTab = useEditorStore((s) => s.requestCloseTab);
  const { drag, beginDrag } = useContext(EditorDragContext);
  // A chip's own menu (FC11): `{ x, y, tabId }` while it is open.
  const [menu, setMenu] = useState(null);

  const paneTabs = node.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  const activeTab = paneTabs.find((t) => t.id === node.activeTabId) || paneTabs[0] || null;
  const rowRef = useRef(null);
  const activeId = activeTab?.id ?? null;
  // The active tab in view of a strip too narrow for its tabs (V39) — when
  // it changes, when tabs come and go, and when the strip is resized.
  useEffect(() => {
    revealActiveChip(rowRef.current, activeId);
  }, [activeId, paneTabs.length]);
  useEffect(() => revealActiveChipOnResize(rowRef.current, activeId), [activeId]);
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
      <div ref={rowRef} data-editor-tab-row={paneId} className="flex-1 flex items-center overflow-x-auto no-scrollbar">
        {paneTabs.map((tab, i) => {
          const isActive = tab.id === activeTab?.id;
          // A terminal being dragged never dims a file, whatever its id.
          const isBeingDragged = drag?.active && drag.tabId === tab.id && drag.tabKind !== 'terminal';
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
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
                    ? 'bg-vsc-tab-active text-vsc-tab-active-fg shadow-[inset_0_1px_0_0_var(--vsc-accent)]'
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

      {/* The chip's menu: the editor counterpart of a terminal tab's Move to
          New Pane (FC11), in both directions, and Close. */}
      <ContextMenu
        open={Boolean(menu && node.tabIds.includes(menu.tabId))}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                {
                  key: 'move-new-pane-right',
                  label: 'Move Editor to New Pane Right',
                  disabled: node.tabIds.length <= 1,
                  disabledReason: node.tabIds.length <= 1 ? 'It is already the only file in its pane' : undefined,
                  onSelect: () => moveEditorToNewPane('horizontal', menu.tabId),
                },
                {
                  key: 'move-new-pane-down',
                  label: 'Move Editor to New Pane Down',
                  disabled: node.tabIds.length <= 1,
                  disabledReason: node.tabIds.length <= 1 ? 'It is already the only file in its pane' : undefined,
                  onSelect: () => moveEditorToNewPane('vertical', menu.tabId),
                },
                { type: 'separator', key: 's1' },
                { key: 'close', label: 'Close', onSelect: () => requestCloseTab(menu.tabId) },
              ]
            : []
        }
      />

      <div className="flex items-center gap-0.5 px-1 shrink-0">
        {/* The workbench's own controls for this pane: its zoom (FC8). */}
        {extra}
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
