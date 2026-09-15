/**
 * Where the keyboard and the pointer go in the application menu behind the ☰
 * button in the Windows/Linux title row.
 *
 * Two levels: the menu titles (File, View, Terminal) and, beside the title
 * that is expanded, its items. `top` is the highlighted title, `expanded` the
 * title whose items are showing, and `sub` the highlighted item in them (-1
 * when the keyboard is still on the titles). Pure functions only — the
 * component owns the DOM.
 */

export const CLOSED = Object.freeze({ open: false, top: -1, expanded: -1, sub: -1 });

const isSelectable = (item) => Boolean(item) && item.type !== 'separator' && !item.disabled;

/** The next selectable index after `from` in direction `dir`, wrapping. */
function step(items, from, dir) {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (isSelectable(items[i])) return i;
  }
  return -1;
}

/** Just opened: the first title is highlighted, nothing is expanded yet. */
export function openMenu() {
  return { open: true, top: 0, expanded: -1, sub: -1 };
}

/** The pointer is over a title: highlight it and show its items. */
export function hoverTitle(state, index) {
  return { ...state, top: index, expanded: index, sub: -1 };
}

/** The pointer is over an item of the expanded menu. */
export function hoverItem(state, index) {
  return { ...state, sub: index };
}

/**
 * Apply one key.
 *
 * Returns `{ state, run, handled }`. `run` is the id of the item to activate —
 * `state` is already closed when it is set. `handled` is false for keys the
 * menu does not use, and for every key while the menu is closed, so the
 * terminal keeps them.
 */
export function menuKey(menus, state, key) {
  if (!state.open) return { state, handled: false };

  const items = state.expanded === -1 ? [] : menus[state.expanded]?.items ?? [];
  const inItems = state.expanded !== -1 && state.sub !== -1;

  switch (key) {
    case 'Escape':
      // One level at a time, like every desktop menu.
      return {
        state: state.expanded === -1 ? CLOSED : { ...state, expanded: -1, sub: -1 },
        handled: true,
      };

    case 'ArrowDown':
    case 'ArrowUp': {
      const dir = key === 'ArrowDown' ? 1 : -1;
      if (inItems) return { state: { ...state, sub: step(items, state.sub, dir) }, handled: true };
      const n = menus.length;
      const top = state.top === -1 ? (dir > 0 ? 0 : n - 1) : (state.top + dir + n) % n;
      return { state: { ...state, top, expanded: -1, sub: -1 }, handled: true };
    }

    case 'ArrowRight':
    case 'Enter':
    case ' ': {
      if (inItems) {
        if (key === 'ArrowRight') return { state, handled: true };
        const item = items[state.sub];
        return isSelectable(item)
          ? { state: CLOSED, run: item.id, handled: true }
          : { state, handled: true };
      }
      if (state.top === -1) return { state, handled: true };
      const sub = step(menus[state.top]?.items ?? [], -1, 1);
      return { state: { ...state, expanded: state.top, sub }, handled: true };
    }

    case 'ArrowLeft':
      return { state: { ...state, expanded: -1, sub: -1 }, handled: true };

    case 'Tab':
      return { state: CLOSED, handled: true };

    default:
      return { state, handled: false };
  }
}
