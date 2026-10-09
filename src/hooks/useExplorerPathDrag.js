import { useCallback, useEffect, useRef, useState } from 'react';
import { createExplorerDrag, followExplorerPress, pressArmsDrag } from '../lib/explorerDrag.js';
import { paneIdAtPoint } from '../lib/terminalFileDrop.js';
import { usePathDropStore } from '../stores/pathDropStore.js';
import { useSystemStore } from '../stores/systemStore.js';
import { insertPathsIntoPane, planPathsIntoPane } from '../components/terminal/insertPathsIntoPane.js';

/** How far from the pointer the ghost chip sits, so it never hides what is under it. */
const GHOST_OFFSET_PX = 12;

/**
 * A press on a row of the Explorer: opened by its own release, or dragged
 * onto a terminal pane to insert its path there. What the press means is
 * src/lib/explorerDrag.js's to decide (`followExplorerPress`); this binds it
 * to the page — the pane highlight, the chip, the insert.
 *
 * `onActivate(row)` opens a row; the latest one given is used. Returns, for
 * FileExplorer:
 *
 *   onRowPointerDown(event, row, { renaming })  a row's pointerdown
 *   ghost           `{ name, isFolder }` while a row is being dragged, else null
 *   ghostRef        the ref of the chip drawn for it
 *
 * Once the press becomes a drag the row also captures the pointer, so the
 * terminal under it never sees the pointer go by — no selection, no mouse
 * report to a program — and the release still comes back here. The chip
 * follows the pointer by its style alone; the Explorer renders twice per
 * drag, at the start and the end, not on every move.
 */
export function useExplorerPathDrag({ onActivate } = {}) {
  const gestureRef = useRef(null);
  if (gestureRef.current === null) gestureRef.current = createExplorerDrag();
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const stopRef = useRef(null);
  const chipRef = useRef(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const [ghost, setGhost] = useState(null);

  /** Put the chip at the pointer — on every move, and the moment it is drawn. */
  const placeChip = useCallback(() => {
    const chip = chipRef.current;
    if (!chip) return;
    chip.style.left = `${pointRef.current.x + GHOST_OFFSET_PX}px`;
    chip.style.top = `${pointRef.current.y + GHOST_OFFSET_PX}px`;
  }, []);

  const ghostRef = useCallback(
    (el) => {
      chipRef.current = el;
      placeChip();
    },
    [placeChip]
  );

  const onRowPointerDown = useCallback(
    (e, row, { renaming = false } = {}) => {
      if (!pressArmsDrag(e, e.target, { renaming, platform: useSystemStore.getState().os })) return;
      stopRef.current?.();

      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      const path = row.node.path;

      stopRef.current = followExplorerPress(e, row, {
        win: window,
        gesture: gestureRef.current,
        onActivate: (pressed) => activateRef.current?.(pressed),
        onDragStart: () => {
          try {
            handle.setPointerCapture?.(pointerId);
          } catch (_) {
            // The pointer is already gone; the window still hears its release.
          }
          setGhost({ name: row.node.name, isFolder: Boolean(row.isFolder) });
        },
        onDragMove: (point) => {
          pointRef.current = point;
          placeChip();
          // The pane a drop here would insert into, highlighted as an OS drop's is.
          const paneId = paneIdAtPoint(point.x, point.y, document);
          const plan = paneId ? planPathsIntoPane(paneId, [path]) : null;
          usePathDropStore.getState().setTarget(plan?.ok ? { paneId, count: plan.count } : null);
        },
        onDrop: (point) => {
          const paneId = paneIdAtPoint(point.x, point.y, document);
          if (paneId) insertPathsIntoPane(paneId, [path]);
        },
        onEnd: () => {
          stopRef.current = null;
          usePathDropStore.getState().clearTarget();
          setGhost(null);
        },
      });
    },
    [placeChip]
  );

  // Never leave listeners, a highlight or a chip behind if the Explorer goes mid-drag.
  useEffect(() => () => stopRef.current?.(), []);

  return { onRowPointerDown, ghost, ghostRef };
}

export default useExplorerPathDrag;
