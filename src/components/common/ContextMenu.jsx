import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';

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
 */
export function ContextMenu({ open, x = 0, y = 0, items = [], onClose }) {
  const menuRef = useRef(null);
  const [placement, setPlacement] = useState({ left: x, top: y, ready: false });
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectableIndexes = items.reduce((acc, item, idx) => {
    if (item.type !== 'separator' && !item.disabled) acc.push(idx);
    return acc;
  }, []);

  // Reset position/selection every time the menu (re)opens at a new spot.
  useLayoutEffect(() => {
    if (!open) return;
    setPlacement({ left: x, top: y, ready: false });
    setActiveIndex(-1);
  }, [open, x, y]);

  // Flip inward once we know the rendered size, so the menu never runs off
  // the right or bottom edge of the window.
  useLayoutEffect(() => {
    if (!open || placement.ready) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
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

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.focus();

    const moveActive = (dir) => {
      if (selectableIndexes.length === 0) return;
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
        e.preventDefault();
        setActiveIndex((current) => {
          activateIndex(current);
          return current;
        });
      }
    };

    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose?.();
      }
    };

    const handleDismiss = () => onClose?.();

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [open, items, onClose, selectableIndexes]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        visibility: placement.ready ? 'visible' : 'hidden',
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
            role="menuitem"
            aria-disabled={item.disabled ? 'true' : undefined}
            title={item.disabled ? item.disabledReason : undefined}
            onMouseEnter={() => setActiveIndex(item.disabled ? -1 : idx)}
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
    </div>
  );
}

export default ContextMenu;
