import { create } from 'zustand';

/**
 * Which terminal pane a drop of files would insert into right now — the pane
 * that draws the "Insert path" highlight.
 *
 * Two gestures set it: files dragged in from the OS file manager
 * (`useTerminalFileDrop`) and a row dragged out of NexTerm's own Explorer
 * (`useExplorerPathDrag`). Neither can be in progress while the other is —
 * the OS holds the pointer for the whole of its drag — so one value serves
 * both, and the panes read it without either gesture knowing they exist.
 *
 * A store of its own rather than a field of terminalStore: it changes on
 * every pane the pointer crosses, persists nothing, and is no part of the
 * layout that store keeps.
 *
 * `target` is `{ paneId, count }` — `count` being how many paths the drop
 * would insert — or null when the pointer is over no pane that would take
 * them.
 */
export const usePathDropStore = create((set, get) => ({
  target: null,

  /**
   * Point the highlight at a pane, or nowhere (null). Pointer moves arrive
   * far more often than the target changes; an unchanged target is not
   * written, so no pane re-renders for a move within itself.
   */
  setTarget: (target) => {
    const next =
      target && typeof target.paneId === 'string' && target.paneId && target.count > 0
        ? { paneId: target.paneId, count: target.count }
        : null;
    const current = get().target;
    if (current === next) return;
    if (current && next && current.paneId === next.paneId && current.count === next.count) return;
    set({ target: next });
  },

  clearTarget: () => {
    if (get().target !== null) set({ target: null });
  },
}));

export default usePathDropStore;
