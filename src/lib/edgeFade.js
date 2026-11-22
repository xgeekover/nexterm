/**
 * The fade at the edge of a tab strip that has more to scroll to (bundle 3,
 * U3-F1/F2).
 *
 * The four tab strips (a region's view tabs, a terminal pane's chips, the
 * group chips and an editor pane's tabs) scroll sideways and show no scroll
 * bar (`.no-scrollbar`), so nothing said there was more. Now the side with
 * more content fades out over its last 20px: index.css masks the scroller
 * (`mask-image`, and `-webkit-mask-image` for WebKit) by its
 * `data-edge-fade` attribute, one of `EDGE_FADE_SIDES`.
 *
 * A mask is not an element: nothing is added to the strip, nothing can take a
 * pointer event, and a click on a half-faded tab is a click on that tab. It
 * does fade whatever is drawn in the scroller, the insertion and drop markers
 * too, so a strip a drag is over is not faded at all (`suspended`).
 *
 * `edgeFadeSides` is the rule, pure. `watchEdgeFade` keeps one scroller's
 * attribute up to date — on scroll, when the scroller or a tab in it changes
 * size, and when a tab comes or goes — and writes it only when the value
 * changes. `followEdgeFade` is what the hook (src/hooks/useEdgeFade.js) does
 * on each render: keep the watcher, tell it the suspend flag, or move it to
 * the strip's new element.
 */

/** The attribute index.css reads. */
export const EDGE_FADE_ATTRIBUTE = 'data-edge-fade';

/** Every value of the attribute: nothing, the left side, the right side, both. */
export const EDGE_FADE_SIDES = Object.freeze(['none', 'start', 'end', 'both']);

/**
 * How far from an end still counts as being at it, in CSS pixels. A zoomed or
 * scaled window scrolls in fractions of a pixel and stops short of the end by
 * one; a strip that overflows by no more than this does not fade at all.
 */
export const EDGE_FADE_TOLERANCE = 1;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Which side(s) of a scroller have more content to scroll to.
 *
 * @param {{ scrollLeft: number, scrollWidth: number, clientWidth: number } | null | undefined} box
 *   the scroller, or anything with its three numbers
 * @param {boolean} [suspended] true while a drag is over the strip: no fade
 * @returns {'none' | 'start' | 'end' | 'both'} 'end' at the start, 'both' in
 *   the middle, 'start' at the end, 'none' when nothing overflows
 */
export function edgeFadeSides(box, suspended = false) {
  if (suspended || !box) return 'none';
  const { scrollLeft, scrollWidth, clientWidth } = box;
  if (!finite(scrollLeft) || !finite(scrollWidth) || !finite(clientWidth)) return 'none';
  const max = scrollWidth - clientWidth;
  if (max <= EDGE_FADE_TOLERANCE) return 'none';
  // Past either end (an elastic overscroll) is at that end.
  const at = Math.min(Math.max(scrollLeft, 0), max);
  const before = at > EDGE_FADE_TOLERANCE;
  const after = at < max - EDGE_FADE_TOLERANCE;
  if (before && after) return 'both';
  if (after) return 'end';
  if (before) return 'start';
  return 'none';
}

const constructorOr = (given, name) => {
  if (given !== undefined) return typeof given === 'function' ? given : null;
  const found = globalThis[name];
  return typeof found === 'function' ? found : null;
};

const NO_WATCH = Object.freeze({ update() {}, setSuspended() {}, stop() {} });

/**
 * Keeps `el`'s `data-edge-fade` up to date until `stop()`.
 *
 * Listens for `scroll` on `el` (passive), observes the size of `el` and of
 * each of its children with a ResizeObserver, and the children coming and
 * going with a MutationObserver. Either observer may be missing (an old
 * WebView, a test): what is left still works, and scrolling always does.
 *
 * @param {Element | null | undefined} el the scroller
 * @param {{ suspended?: boolean, ResizeObserver?: Function | null, MutationObserver?: Function | null }} [options]
 *   the observers default to the globals; pass `null` for none
 * @returns {{ update(): void, setSuspended(next: boolean): void, stop(): void }}
 */
export function watchEdgeFade(el, options = {}) {
  if (!el || typeof el.addEventListener !== 'function' || typeof el.setAttribute !== 'function') {
    return NO_WATCH;
  }
  const Resize = constructorOr(options.ResizeObserver, 'ResizeObserver');
  const Mutation = constructorOr(options.MutationObserver, 'MutationObserver');
  let suspended = Boolean(options.suspended);
  let written = null;
  let stopped = false;

  const update = () => {
    if (stopped) return;
    const next = edgeFadeSides(el, suspended);
    if (next === written) return;
    written = next;
    el.setAttribute(EDGE_FADE_ATTRIBUTE, next);
  };

  el.addEventListener('scroll', update, { passive: true });

  let resize = null;
  if (Resize) {
    resize = new Resize(update);
    resize.observe(el);
    for (const child of Array.from(el.children ?? [])) resize.observe(child);
  }

  let mutation = null;
  if (Mutation) {
    mutation = new Mutation((records) => {
      for (const record of records ?? []) {
        for (const node of Array.from(record.addedNodes ?? [])) {
          if (resize && node && node.nodeType === 1) resize.observe(node);
        }
        for (const node of Array.from(record.removedNodes ?? [])) {
          if (resize && node && node.nodeType === 1) resize.unobserve(node);
        }
      }
      update();
    });
    mutation.observe(el, { childList: true });
  }

  update();

  return {
    update,
    setSuspended(next) {
      const value = Boolean(next);
      if (value === suspended) return;
      suspended = value;
      update();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      el.removeEventListener('scroll', update, { passive: true });
      resize?.disconnect();
      mutation?.disconnect();
      if (written !== null && typeof el.removeAttribute === 'function') el.removeAttribute(EDGE_FADE_ATTRIBUTE);
      written = null;
    },
  };
}

/**
 * One render's worth of the hook: `current` is what the last render left
 * (`{ el, watcher }` or null), `el` the strip's element now.
 *
 * The same element keeps its watcher and is told the suspend flag. A new one
 * (a hidden terminal strip moved into its overlay, or back) gets a new
 * watcher, and the old one is stopped. No element stops it.
 *
 * @param {{ el: Element, watcher: ReturnType<typeof watchEdgeFade> } | null} current
 * @param {Element | null | undefined} el
 * @param {boolean} suspended
 * @param {typeof watchEdgeFade} [watch]
 * @returns {{ el: Element, watcher: ReturnType<typeof watchEdgeFade> } | null}
 */
export function followEdgeFade(current, el, suspended, watch = watchEdgeFade) {
  if (current && el && current.el === el) {
    current.watcher.setSuspended(suspended);
    return current;
  }
  current?.watcher.stop();
  return el ? { el, watcher: watch(el, { suspended: Boolean(suspended) }) } : null;
}
