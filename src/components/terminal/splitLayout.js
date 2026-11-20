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
  // An editor leaf is named by the file it shows (sibling C: the pane menu
  // offers panes of both kinds); `tabs` then holds the files too.
  const titleOf = (leaf) =>
    tabs.find((t) => t.id === (leaf.activeTabId ?? leaf.tabIds?.[0]))?.title ??
    (leafKind(leaf) === EDITOR_KIND ? 'No file open' : 'No terminal');
  return leaves
    .map((leaf, index) => ({
      paneId: leaf.id,
      title: titleOf(leaf),
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

// ---------------------------------------------------------------------------
// Leaf kinds (editor placement, sibling B). A group's tree is the workbench:
// a leaf with `kind: 'editor'` holds file tabs, any other leaf holds
// terminals. Terminal leaves are written WITHOUT `kind`, so every v0.31.0
// payload keeps its meaning and a terminal-only tree is byte-identical to one
// from before leaves had kinds.
// ---------------------------------------------------------------------------

export const EDITOR_KIND = 'editor';
export const TERMINAL_KIND = 'terminal';

/** A leaf's kind: 'editor' only when it says so, 'terminal' otherwise. */
export function leafKind(leaf) {
  return leaf?.kind === EDITOR_KIND ? EDITOR_KIND : TERMINAL_KIND;
}

/** The leaves of `tree` of one kind, in DOM order. */
export function leavesOfKind(tree, kind) {
  return leavesIn(tree).filter((leaf) => leafKind(leaf) === kind);
}

/** Every tab id held by leaves of one kind, in DOM order. */
export function tabIdsOfKind(tree, kind) {
  return leavesOfKind(tree, kind).flatMap((leaf) => (Array.isArray(leaf.tabIds) ? leaf.tabIds : []));
}

/** How many terminals a group's tree holds: editor leaves count for nothing. */
export function countTerminalTabs(tree) {
  return tabIdsOfKind(tree, TERMINAL_KIND).length;
}

/** `sizes` restricted to `kept` indexes, as percentages summing to 100 (two decimals). */
function keptShares(node, kept) {
  const all = sizesOf(node);
  const raw = kept.map((i) => all[i]);
  const total = raw.reduce((a, b) => a + b, 0);
  return roundedShares(raw.map((v) => (v / total) * 100));
}

/**
 * The part of `tree` one kind of view draws (the releasability bridge, until
 * sibling C draws the workbench whole): only the leaves of `kind`, splits left
 * with one child collapsed into it, the sizes kept renormalized among what is
 * left. Split and leaf ids are kept, and a subtree that is all of `kind` is
 * handed back as the very same object — so a view keyed by node id does not
 * remount (no xterm is torn down) when leaves of the other kind come or go.
 * Null when `tree` has no leaf of `kind`.
 */
export function projectTree(tree, kind) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === 'leaf') return leafKind(tree) === kind ? tree : null;
  if (!isSplit(tree)) return null;
  const kept = [];
  tree.children.forEach((child, i) => {
    const projected = projectTree(child, kind);
    if (projected) kept.push({ node: projected, i });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].node;
  if (kept.length === tree.children.length && kept.every((k, i) => k.node === tree.children[i])) return tree;
  return {
    ...tree,
    children: kept.map((k) => k.node),
    sizes: keptShares(tree, kept.map((k) => k.i)),
  };
}

// `liftSizes`, which wrote a resize made in one kind's projection back to the
// full split, went with the bridge (sibling C): the workbench draws the full
// tree, so a split's sizes are stored as they are dragged.

// ---------------------------------------------------------------------------
// Pixel minimums per kind (FB11, math only: sibling C wires them into
// ResizableSplit). A terminal is still usable at 120 x 88 px (about 14
// columns by 5 rows at the default font); an editor needs room for its tab
// strip and a few lines of Monaco, so 160 x 96 px. A split asks for the sum of
// its children's minimums along its direction and the largest across it. When
// the space cannot hold every minimum they are scaled down together to fit, so
// a window too small for all of them still gets a valid layout with no pane
// at zero or below.
// ---------------------------------------------------------------------------

export const PANE_MIN_PX = Object.freeze({
  terminal: Object.freeze({ width: 120, height: 88 }),
  editor: Object.freeze({ width: 160, height: 96 }),
});

/** The pixels `node` needs along `direction` for every pane in it to get its minimum. */
export function minPxAlong(node, direction) {
  if (!node) return 0;
  if (!isSplit(node)) {
    const min = PANE_MIN_PX[leafKind(node)];
    return direction === 'horizontal' ? min.width : min.height;
  }
  const needs = node.children.map((child) => minPxAlong(child, direction));
  return directionOf(node) === direction ? needs.reduce((a, b) => a + b, 0) : Math.max(...needs);
}

/**
 * The minimum share (percent of `lengthPx`, along the split's direction) of
 * each child of split `node`, capped together so they never sum past 100.
 */
export function minSharesOf(node, lengthPx) {
  if (!isSplit(node)) return [];
  const direction = directionOf(node);
  if (!(typeof lengthPx === 'number' && Number.isFinite(lengthPx) && lengthPx > 0)) return node.children.map(() => 0);
  const needs = node.children.map((child) => minPxAlong(child, direction));
  const total = needs.reduce((a, b) => a + b, 0);
  const scale = total > lengthPx ? lengthPx / total : 1;
  return needs.map((px) => ((px * scale) / lengthPx) * 100);
}

/**
 * The sizes of split `node` (as `sizesOf` reads them) with every child raised
 * to its minimum share at `lengthPx`, the others scaled down to make room.
 * Sizes already above their minimums come back as they were.
 */
export function fitSizesToMinimums(node, lengthPx) {
  if (!isSplit(node)) return [];
  const mins = minSharesOf(node, lengthPx);
  const pinned = new Set();
  let out = sizesOf(node);
  for (let pass = 0; pass < out.length; pass += 1) {
    const low = out.map((v, i) => !pinned.has(i) && v < mins[i] - 1e-9);
    if (!low.some(Boolean)) break;
    low.forEach((isLow, i) => isLow && pinned.add(i));
    const free = out.reduce((total, v, i) => (pinned.has(i) ? total : total + v), 0);
    const room = 100 - [...pinned].reduce((total, i) => total + mins[i], 0);
    const unpinned = out.length - pinned.size;
    out = out.map((v, i) => (pinned.has(i) ? mins[i] : free > 0 ? (v / free) * room : room / unpinned));
  }
  return roundedShares(out);
}

/** `tree` with every split fitted to its minimums (`fitSizesToMinimums`) in a `widthPx` x `heightPx` area. */
export function fitTreeToMinimums(tree, widthPx, heightPx) {
  if (!isSplit(tree)) return tree;
  const across = directionOf(tree) === 'horizontal';
  const sizes = fitSizesToMinimums(tree, across ? widthPx : heightPx);
  const children = tree.children.map((child, i) => {
    const share = sizes[i] / 100;
    return fitTreeToMinimums(child, across ? widthPx * share : widthPx, across ? heightPx : heightPx * share);
  });
  return { ...tree, children, sizes };
}

/** Every pane's size in pixels in a `widthPx` x `heightPx` area: pane id -> `{ width, height }`. */
export function panePixelRects(tree, widthPx, heightPx) {
  const out = new Map();
  for (const [id, r] of paneRects(tree)) {
    out.set(id, { width: (r.right - r.left) * widthPx, height: (r.bottom - r.top) * heightPx });
  }
  return out;
}
