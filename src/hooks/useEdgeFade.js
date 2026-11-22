import { useEffect, useRef } from 'react';
import { followEdgeFade } from '../lib/edgeFade.js';

/**
 * Fades the edge of a tab strip that has more to scroll to (bundle 3, U3; see
 * src/lib/edgeFade.js and the `[data-edge-fade]` rules in index.css).
 *
 * `ref` is the strip's scroller (the element with `overflow-x-auto
 * no-scrollbar`), the ref it already has if it has one. `suspended` is the
 * strip's own drag state, true while a drag is over it: no fade then, so the
 * insertion and drop markers are drawn whole.
 *
 * No state: the watcher writes `data-edge-fade` on the element itself, and
 * only when the value changes, so scrolling renders nothing. The effect runs
 * after every render but does work only when the element or the flag
 * changed — a terminal strip moves into its overlay and back as a new
 * element. Nothing runs on the server (an effect), and a missing
 * ResizeObserver is the watcher's to guard.
 *
 * @param {{ current: Element | null }} ref
 * @param {boolean} [suspended]
 */
export function useEdgeFade(ref, suspended = false) {
  const watched = useRef(null);
  const held = Boolean(suspended);

  useEffect(() => {
    watched.current = followEdgeFade(watched.current, ref?.current ?? null, held);
  });

  useEffect(
    () => () => {
      watched.current = followEdgeFade(watched.current, null, false);
    },
    []
  );
}
