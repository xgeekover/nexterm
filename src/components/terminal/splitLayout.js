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

// ---------------------------------------------------------------------------
// Equal shares (spec P2): "Equalize Splits", and the setting that equalizes
// the line a new split lands in.
//
// A group's tree is built by splitting one pane at a time, so three panes side
// by side are never one split of three: they are [[a | b] | c], a split inside
// a split. Halving every split would give a and b a quarter each and c a half,
// which is not what anyone means by "equal". So a share is counted in PANES
// along the split's direction (`spanAlong`): [a | b] is two panes wide and c
// one, so the outer split is 2:1 and every pane comes out a third.
//
// A split across the direction counts as its widest row: a column holding b
// above a c|d row is two panes wide, so its neighbour a gets a third and c and
// d a third each, while b stretches over both.
// ---------------------------------------------------------------------------

const directionOf = (node) => (node?.direction === 'vertical' ? 'vertical' : 'horizontal');
const isSplit = (node) => node?.type === 'split' && Array.isArray(node.children) && node.children.length > 0;
const round2 = (value) => Math.round(value * 100) / 100;

/** How many panes `node` lines up along `direction` (see above). */
export function spanAlong(node, direction) {
  if (!isSplit(node)) return 1;
  const spans = node.children.map((child) => spanAlong(child, direction));
  return directionOf(node) === direction ? spans.reduce((a, b) => a + b, 0) : Math.max(...spans);
}

/**
 * `shares` (percentages summing to 100) with none under `min`, the rest
 * scaled down to make room. A panel the library is handed below its
 * `minSize` is pushed back up by the library itself, and the store would
 * then hold a size nobody sees — so it never gets one. Unsatisfiable
 * minimums (more panels than 100 / min) leave the shares as they are; the
 * min shrinks with the count (`panelMinSize`), so that does not happen.
 */
function atLeast(shares, min) {
  if (min * shares.length > 100) return shares;
  const pinned = new Set();
  let out = [...shares];
  for (let pass = 0; pass < shares.length; pass += 1) {
    const low = out.map((v, i) => !pinned.has(i) && v < min);
    if (!low.some(Boolean)) break;
    low.forEach((isLow, i) => isLow && pinned.add(i));
    const free = out.reduce((total, v, i) => (pinned.has(i) ? total : total + v), 0);
    const room = 100 - pinned.size * min;
    out = out.map((v, i) => (pinned.has(i) ? min : free > 0 ? (v / free) * room : room / (out.length - pinned.size)));
  }
  return out;
}

/** Percentages to two decimals, the last one taking the rounding so they sum to exactly 100 — what the store keeps. */
function roundedShares(shares) {
  const out = shares.map(round2);
  out[out.length - 1] = round2(100 - out.slice(0, -1).reduce((a, b) => a + b, 0));
  return out;
}

/**
 * The `minSize` for the panels of split `node`: `panelMinSize`'s, or less —
 * the share of its smallest child when its line is split equally, so that n
 * panes in a line can be truly equal. Seven panes made by splitting right
 * six times put a 1/7 share (14.29%) in a split of two, whose panels were
 * held to 15%: equalized, the panes came out unequal (review). Floored to
 * hundredths, so the equal share, rounded, is never under it.
 */
export function panelMinSizeOf(node) {
  const base = Number(panelMinSize(node?.children?.length ?? 1));
  if (!isSplit(node)) return String(base);
  const direction = directionOf(node);
  const spans = node.children.map((child) => spanAlong(child, direction));
  const total = spans.reduce((a, b) => a + b, 0);
  const smallest = (Math.min(...spans) / total) * 100;
  return String(Math.min(base, Math.floor(smallest * 100) / 100));
}

/** The equal sizes of ONE split's children: by panes along its direction, never under its panels' minimum. */
export function equalSizesOf(node) {
  const direction = directionOf(node);
  const spans = node.children.map((child) => spanAlong(child, direction));
  const total = spans.reduce((a, b) => a + b, 0);
  const raw = spans.map((span) => (span / total) * 100);
  return roundedShares(atLeast(raw, Number(panelMinSizeOf(node))));
}

const sameSizes = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * `node` with equal sizes on every split `within(split)` says to touch, and
 * its children rebuilt only where `descend(child)` says so. The very same
 * object comes back whenever nothing changed, so a store write that would
 * change nothing can be skipped (nothing redrawn, nothing saved).
 */
function equalized(node, within, descend) {
  if (!isSplit(node)) return node;
  const children = node.children.map((child) => (descend(node, child) ? equalized(child, within, descend) : child));
  const childrenSame = children.every((child, i) => child === node.children[i]);
  const sizes = within(node) ? equalSizesOf(node) : node.sizes;
  if (childrenSame && (sizes === node.sizes || sameSizes(node.sizes, sizes))) return node;
  return { ...node, children, ...(sizes ? { sizes } : {}) };
}

/** Every split of `tree` at equal shares — "Equalize Splits". */
export function equalizeAll(tree) {
  return equalized(tree, () => true, () => true);
}

/**
 * The line split `splitId` belongs to, at equal shares, and nothing else —
 * what a new split does with "Equal Splits" on.
 *
 * The line is every split of the same direction joined to it: up through
 * same-direction parents to the topmost, and from there down through
 * same-direction children. A split across the line stops it — its own sizes
 * are another direction's, and the panes in it are not siblings in this one.
 * An unknown `splitId` changes nothing.
 */
export function equalizeLineOf(tree, splitId) {
  const path = [];
  const find = (node) => {
    path.push(node);
    if (node?.id === splitId && isSplit(node)) return true;
    if (isSplit(node) && node.children.some(find)) return true;
    path.pop();
    return false;
  };
  if (!find(tree)) return tree;
  const direction = directionOf(path[path.length - 1]);
  let top = path.length - 1;
  while (top > 0 && isSplit(path[top - 1]) && directionOf(path[top - 1]) === direction) top -= 1;
  const sameLine = (node) => isSplit(node) && directionOf(node) === direction;
  const equalTop = equalized(path[top], sameLine, (_parent, child) => sameLine(child));
  if (equalTop === path[top]) return tree;
  // Put the rebuilt top back in place, copying only the splits above it.
  let rebuilt = equalTop;
  for (let i = top - 1; i >= 0; i -= 1) {
    const parent = path[i];
    rebuilt = { ...parent, children: parent.children.map((child) => (child === path[i + 1] ? rebuilt : child)) };
  }
  return rebuilt;
}

// ---------------------------------------------------------------------------
// Where a pane is (spec P3): "Swap Pane With…" names the other panes by the
// terminal each shows and by where it is — "top right", "left" — read from
// the sizes the tree is drawn at.
// ---------------------------------------------------------------------------

/**
 * Every pane's rectangle within its group, as fractions of the group's area
 * (`{ left, top, right, bottom }`, 0 to 1), by pane id — from the same sizes
 * the splits are drawn with (`sizesOf`).
 */
export function paneRects(node, rect = { left: 0, top: 0, right: 1, bottom: 1 }, acc = new Map()) {
  if (!node) return acc;
  if (!isSplit(node)) {
    if (node.type === 'leaf') acc.set(node.id, rect);
    return acc;
  }
  const sizes = sizesOf(node);
  const across = directionOf(node) === 'horizontal';
  let at = 0;
  node.children.forEach((child, i) => {
    const from = at;
    at += sizes[i] / 100;
    const childRect = across
      ? { ...rect, left: rect.left + (rect.right - rect.left) * from, right: rect.left + (rect.right - rect.left) * at }
      : { ...rect, top: rect.top + (rect.bottom - rect.top) * from, bottom: rect.top + (rect.bottom - rect.top) * at };
    paneRects(child, childRect, acc);
  });
  return acc;
}

const EDGE = 0.001;

/**
 * Where a pane's rectangle is, in words: "top left", "right", "middle",
 * "bottom". A pane as wide as the group says nothing about left or right,
 * one as tall says nothing about top or bottom; the middle third of either
 * is "middle". Words rather than a picture because they go in a menu row
 * and a palette row, and are read out as they are.
 */
export function placeOf(rect) {
  if (!rect) return '';
  const wide = rect.left <= EDGE && rect.right >= 1 - EDGE;
  const tall = rect.top <= EDGE && rect.bottom >= 1 - EDGE;
  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  const across = wide ? '' : x < 0.4 ? 'left' : x > 0.6 ? 'right' : 'middle';
  const down = tall ? '' : y < 0.4 ? 'top' : y > 0.6 ? 'bottom' : 'middle';
  if (across && down) return across === 'middle' && down === 'middle' ? 'middle' : `${down} ${across}`;
  return down || across || 'whole group';
}

function leavesIn(node, acc = []) {
  if (!node) return acc;
  if (isSplit(node)) node.children.forEach((child) => leavesIn(child, acc));
  else if (node.type === 'leaf') acc.push(node);
  return acc;
}

/**
 * The panes `fromPaneId` can swap with, in the order they are drawn: each
 * one's id, the title of the terminal it shows (what its strip, or the
 * overlay of a hidden strip, says), where it is (`placeOf`), its number among
 * the group's panes (`index` of `count`) and how many terminals it holds.
 */
export function swapChoices(tree, tabs, fromPaneId) {
  const leaves = leavesIn(tree);
  const rects = paneRects(tree);
  const titleOf = (tabId) => tabs.find((t) => t.id === tabId)?.title ?? 'No terminal';
  return leaves
    .map((leaf, index) => ({
      paneId: leaf.id,
      title: titleOf(leaf.activeTabId ?? leaf.tabIds?.[0]),
      place: placeOf(rects.get(leaf.id)),
      index,
      count: leaves.length,
      terminals: Array.isArray(leaf.tabIds) ? leaf.tabIds.length : 0,
    }))
    .filter((choice) => choice.paneId !== fromPaneId);
}

/**
 * A pane menu's row for one of `swapChoices`: the terminal it shows, where
 * it is, and which pane of how many — two panes can show terminals of the
 * same name in the same place words ("claude", "right"), and the two rows
 * must not read the same. The palette says the same in its own columns.
 */
export function swapLabel(choice) {
  return `Swap with ${choice.title} (${choice.place}, pane ${choice.index + 1} of ${choice.count})`;
}
