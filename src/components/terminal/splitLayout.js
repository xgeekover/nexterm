/**
 * The arithmetic behind a resizable split, with no React in it.
 *
 * `ResizableSplit` (TerminalSplitContainer.jsx) is where the store's
 * `node.sizes` meets react-resizable-panels. That handshake is the half of
 * layout restoration a store-only test cannot see: a group's remembered
 * arrangement is only actually restored if these values reach the Group and
 * its Panels. Keeping the rules here lets them be checked directly.
 */

/** Percentage-point slack before a stored layout counts as "different". */
export const SIZE_EPSILON = 0.25;

/**
 * A split's child sizes as percentages summing to 100.
 *
 * Missing, malformed, or non-summing-to-100 `sizes` fall back to an even
 * split / are rescaled, so a hand-edited or older persisted payload can never
 * render a pane at zero width.
 */
export function sizesOf(node) {
  const count = node.children.length;
  const raw = Array.isArray(node.sizes) && node.sizes.length === count ? node.sizes : null;
  const usable =
    raw && raw.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ? raw : null;
  if (!usable) return new Array(count).fill(100 / count);
  const total = usable.reduce((a, b) => a + b, 0);
  return usable.map((v) => (v / total) * 100);
}

/**
 * The `defaultLayout` for a Group: child id → percentage.
 *
 * This is what seeds the layout at mount — the only moment the library reads
 * a "default" at all — so a restored group comes up in its remembered shape
 * rather than an even split.
 */
export function layoutOf(node) {
  const sizes = sizesOf(node);
  const layout = {};
  node.children.forEach((child, i) => {
    layout[child.id] = sizes[i];
  });
  return layout;
}

/**
 * A Panel's `minSize`, as the string percentage the library expects.
 *
 * A pane may never be squeezed to nothing, but "15%" stops being satisfiable
 * past six children and the library rejects the whole layout — so it scales
 * down with the child count instead, never below 4%.
 */
export function panelMinSize(childCount) {
  return String(Math.max(4, Math.min(15, Math.floor(90 / Math.max(1, childCount)))));
}

/**
 * Whether the live Group has to be pushed back to `layout`.
 *
 * False when they already agree (within `SIZE_EPSILON`) and false whenever
 * `setLayout` would throw — it rejects any layout that does not name exactly
 * the Group's current panels, which happens while panels are mid-registration.
 */
export function shouldReconcile(current, layout) {
  if (!current || typeof current !== 'object') return false;
  const ids = Object.keys(layout);
  if (Object.keys(current).length !== ids.length) return false;
  if (!ids.every((id) => typeof current[id] === 'number')) return false;
  return !ids.every((id) => Math.abs(current[id] - layout[id]) <= SIZE_EPSILON);
}

/**
 * The sizes to persist for an `onLayoutChanged`, or null to ignore it.
 *
 * Only a real separator drag / resize keypress writes back. Every other
 * trigger — mount, a constraint recompute, our own `setLayout` — is the
 * library echoing what the store just told it, and writing those back would
 * let the library clobber a layout it was in the middle of being given.
 */
export function sizesFromLayout(childIds, nextLayout, meta) {
  if (meta && meta.isUserInteraction === false) return null;
  const next = childIds.map((id) => nextLayout?.[id]);
  if (!next.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null;
  return next;
}
