import React, { useRef, useState } from 'react';
import { ContextMenu } from '../common/ContextMenu.jsx';
import { MENU_BAR, runMenuAction } from '../../lib/menuActions.js';
import { cn } from '../../lib/utils.js';

/**
 * The menu bar NexTerm draws inside its own title row.
 *
 * macOS puts menus at the top of the screen, so there the native menu is used
 * and this component is not rendered. Windows and Linux get a frameless window
 * (tauri.windows.conf.json) and this, VS Code style: one compact row instead
 * of a native title bar plus a native menu bar.
 */
export function MenuBar() {
  const [open, setOpen] = useState(null); // index of the open menu
  const buttonsRef = useRef([]);

  const anchorFor = (index) => {
    const rect = buttonsRef.current[index]?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 };
  };

  const itemsFor = (index) =>
    MENU_BAR[index].items.map((item, i) =>
      item.type === 'separator'
        ? { type: 'separator', key: `sep-${i}` }
        : {
            key: item.id,
            label: item.label,
            shortcut: item.shortcut,
            onSelect: () => runMenuAction(item.id),
          }
    );

  return (
    <div className="flex items-center shrink-0" role="menubar">
      {MENU_BAR.map((menu, index) => (
        <button
          key={menu.title}
          ref={(el) => {
            buttonsRef.current[index] = el;
          }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === index}
          onClick={() => setOpen(open === index ? null : index)}
          // Once one menu is open, sliding along the bar switches between
          // them without another click — the behaviour every desktop menu has.
          onMouseEnter={() => setOpen((current) => (current === null ? current : index))}
          className={cn(
            'h-[22px] px-2 rounded-sm text-ui-sm whitespace-nowrap transition-colors',
            open === index
              ? 'bg-vsc-item-active text-vsc-fg'
              : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
          )}
        >
          {menu.title}
        </button>
      ))}

      {open !== null && (
        <ContextMenu
          open
          x={anchorFor(open).x}
          y={anchorFor(open).y}
          items={itemsFor(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export default MenuBar;
