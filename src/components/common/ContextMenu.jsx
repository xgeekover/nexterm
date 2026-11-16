import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';

/** How far the menu keeps from the window's edges. */
const EDGE_MARGIN = 4;

/**
 * Generic VS Code-style popup menu, positioned at an arbitrary viewport
 * point (typically a right-click's clientX/clientY). It deliberately knows
 * nothing about files/folders or any other domain — callers hand it a flat
 * list of item/separator descriptors and it takes care of positioning
 * (including flipping off the window edges), keyboard navigation, outside
 * click/scroll/escape dismissal, and the ARIA menu roles.
 *
 * Item shape:
 *   { key, label, icon?: LucideIconComponent, shortcut?: string,
 *     disabled?: boolean, disabledReason?: string, danger?: boolean,
 *     onSelect?: () => void }
 * Separator shape:
 *   { type: 'separator', key }
 *
 * `focusedKeys`: take keys only while focus is inside the menu — or inside
 * `keysWithin`, the element it belongs to. A menu opened by a click is the
 * only one open, and takes the window's keys; one that opens by itself may
 * not be (the resume offer's list, one per pane), and two of them listening
 * to the window both took the same Enter.
 *
 * `takeFocus`: focus the menu as it opens (the default). One that opens by
 * itself does not: whoever was typing somewhere else keeps typing there,
 * and the menu waits for a click, or for focus to come to it or to
 * `keysWithin`.
 *
 * A menu with more items than the window has room for (Move to Group ▸ with
 * many groups) is no taller than the window less EDGE_MARGIN on each side,
 * and scrolls: a scroll inside it does not close it, and one that reaches
 * its end does not go on to what is behind it. A key that moves the active
 * item brings that item into view; the pointer moving onto one does not.
 *
 * The pointer makes an item active only by really moving over it: a
 * `mousemove` at another point than the last one seen over the menu. The
 * list scrolling under a pointer that rests (a key's scroll, the wheel) has
 * the engine send the row now under it a `mouseover`, and some engines a
 * `mousemove` at the same point; neither changes the active item, nor does
 * the first move after the menu opens, which only notes where the pointer
 * is. An active item that the menu's own scroll takes wholly out of its box
 * is active no more, so Enter never picks a row out of sight.
 */
export function ContextMenu({
  open,
  x = 0,
  y = 0,
  items = [],
  onClose,
  focusedKeys = false,
  keysWithin = null,
  takeFocus = true,
}) {
  const menuRef = useRef(null);
  const [placement, setPlacement] = useState({ left: x, top: y, ready: false });
  const [activeIndex, setActiveIndex] = useState(-1);
  // The row Enter picks, as last drawn. Enter used to read it inside a state
  // updater and pick from there: an item's `onSelect` then ran during a
  // render — React warns of it, and StrictMode runs an updater twice, which
  // picked twice.
  const activeRef = useRef(-1);
  activeRef.current = activeIndex;
  // Each item's element, by its index in `items`, and how many times a key
  // has moved the active item: the item is scrolled into view after each.
  const itemEls = useRef([]);
  const [keyMoves, setKeyMoves] = useState(0);
  // Where the pointer was last seen moving over the menu: null until its
  // first move after the menu opens.
  const pointerAt = useRef(null);

  const selectableIndexes = items.reduce((acc, item, idx) => {
    if (item.type !== 'separator' && !item.disabled) acc.push(idx);
    return acc;
  }, []);

  // Reset position/selection every time the menu (re)opens at a new spot.
  useLayoutEffect(() => {
    if (!open) return;
    setPlacement({ left: x, top: y, ready: false });
    setActiveIndex(-1);
    pointerAt.current = null;
  }, [open, x, y]);

  // Flip inward once we know the rendered size, so the menu never runs off
  // the right or bottom edge of the window.
  useLayoutEffect(() => {
    if (!open || placement.ready) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = EDGE_MARGIN;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, x - rect.width);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, y - rect.height);
    }
    setPlacement({ left, top, ready: true });
  }, [open, placement.ready, x, y]);

  // The item a key made active, into view at the nearest edge.
  useEffect(() => {
    if (keyMoves === 0) return;
    itemEls.current[activeRef.current]?.scrollIntoView({ block: 'nearest' });
  }, [keyMoves]);

  useEffect(() => {
    if (!open) return undefined;
    if (takeFocus) menuRef.current?.focus();

    const moveActive = (dir) => {
      if (selectableIndexes.length === 0) return;
      setKeyMoves((n) => n + 1);
      setActiveIndex((current) => {
        const at = selectableIndexes.indexOf(current);
        const nextAt =
          at === -1
            ? (dir > 0 ? 0 : selectableIndexes.length - 1)
            : (at + dir + selectableIndexes.length) % selectableIndexes.length;
        return selectableIndexes[nextAt];
      });
    };

    const activateIndex = (idx) => {
      const item = items[idx];
      if (!item || item.type === 'separator' || item.disabled) return;
      onClose?.();
      item.onSelect?.();
    };

    const handleKeyDown = (e) => {
      if (focusedKeys) {
        const at = document.activeElement;
        if (!menuRef.current?.contains(at) && !keysWithin?.current?.contains(at)) return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        // Taken from the owner (`keysWithin`) with no row picked yet, the key
        // is the owner's own: Enter on its focused button presses it.
        if (focusedKeys && activeRef.current < 0 && !menuRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        activateIndex(activeRef.current);
      }
    };

    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose?.();
      }
    };

    const handleDismiss = () => onClose?.();

    // The menu's own list scrolling leaves it open; any other scroll closes
    // it. A target that is no node (the window) is not inside it. After its
    // own scroll, an active item wholly outside the menu's box is active no
    // more; a box with no height (nothing laid out) is not looked at.
    const handleScroll = (e) => {
      const target = e?.target;
      if (target?.nodeType && menuRef.current?.contains(target)) {
        const row = itemEls.current[activeRef.current];
        const box = menuRef.current.getBoundingClientRect();
        if (row && box.bottom > box.top) {
          const at = row.getBoundingClientRect();
          if (at.bottom <= box.top || at.top >= box.bottom) setActiveIndex(-1);
        }
        return;
      }
      onClose?.();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [open, items, onClose, selectableIndexes, focusedKeys, keysWithin, takeFocus]);

  // A move at another point than the last one seen makes the item under the
  // pointer active (none for one that is off); over a separator or the
  // padding it leaves the active item as it is.
  const handleMouseMove = (e) => {
    const seen = pointerAt.current;
    pointerAt.current = { x: e.clientX, y: e.clientY };
    if (!seen || (seen.x === e.clientX && seen.y === e.clientY)) return;
    let idx = -1;
    for (let n = e.target; n && n !== e.currentTarget && idx === -1; n = n.parentNode) {
      idx = itemEls.current.indexOf(n);
    }
    if (idx !== -1) setActiveIndex(items[idx]?.disabled ? -1 : idx);
  };

  if (!open) return null;

  // Rendered through a portal straight onto <body> — never as a descendant of
  // whichever panel happened to invoke it. Several panels (see PanelLayout.jsx
  // / src/styles/index.css `.animate-panel-in`) keep a non-`none` `transform`
  // on themselves permanently (`animation-fill-mode: both` retains the final
  // keyframe, which is `transform: scale(1) translateY(0)` — not `none`). A
  // transformed ancestor becomes the containing block for `position: fixed`
  // descendants, which silently breaks `left`/`top` being viewport-relative.
  // Portaling to `document.body` sidesteps that regardless of which panel
  // (present or future) triggers this menu.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      // A menu that opened by itself takes no keyboard and waits to be
      // clicked; one that took the keyboard holds commands that would move it
      // (`menuOnScreen` in src/lib/workspaceFocus.js) until it closes.
      data-opened-by-itself={takeFocus ? undefined : ''}
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onMouseMove={handleMouseMove}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        visibility: placement.ready ? 'visible' : 'hidden',
        // Never taller than the window: the placement above then keeps all
        // of it inside, and a longer list scrolls.
        maxHeight: `calc(100vh - ${2 * EDGE_MARGIN}px)`,
        overflowX: 'hidden',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
      className="z-[70] min-w-[220px] py-1 rounded-[6px] bg-vsc-menu border border-vsc-widget-border shadow-widget outline-none"
    >
      {items.map((item, idx) => {
        if (item.type === 'separator') {
          return <div key={item.key} role="separator" className="my-1 border-t border-vsc-widget-border" />;
        }

        const Icon = item.icon;
        const isActive = idx === activeIndex && !item.disabled;

        return (
          <div
            key={item.key}
            ref={(el) => {
              itemEls.current[idx] = el;
            }}
            role="menuitem"
            aria-disabled={item.disabled ? 'true' : undefined}
            title={item.disabled ? item.disabledReason : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (item.disabled) return;
              onClose?.();
              item.onSelect?.();
            }}
            className={cn(
              'flex items-center gap-2 h-[22px] px-3 text-ui select-none',
              item.disabled
                ? 'text-vsc-muted cursor-default'
                : cn(
                    'cursor-pointer',
                    isActive ? 'bg-vsc-selection text-vsc-selection-fg' : 'text-vsc-fg',
                    item.danger && 'text-vsc-error'
                  )
            )}
          >
            {Icon ? <Icon size={14} className="shrink-0" /> : null}
            <span className="flex-1 min-w-0 truncate">{item.label}</span>
            {item.shortcut ? (
              <span className="text-ui-sm text-vsc-muted shrink-0 pl-3">{item.shortcut}</span>
            ) : null}
          </div>
        );
      })}
    </div>,
    document.body
  );
}

export default ContextMenu;
