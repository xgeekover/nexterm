import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Menu } from 'lucide-react';
import { MENU_BAR, runMenuAction } from '../../lib/menuActions.js';
import { CLOSED, hoverItem, hoverTitle, menuKey, openMenu } from '../../lib/appMenuNav.js';
import { cn } from '../../lib/utils.js';

const MARGIN = 4;

const rowClass = (active) =>
  cn(
    'flex items-center gap-2 h-[22px] px-3 text-ui select-none cursor-pointer',
    active ? 'bg-vsc-selection text-vsc-selection-fg' : 'text-vsc-fg'
  );

const popupClass =
  'py-1 rounded-[6px] bg-vsc-menu border border-vsc-widget-border shadow-widget outline-none';

/**
 * The application menu NexTerm draws inside its own title row.
 *
 * macOS puts menus at the top of the screen, so there the native menu is used
 * and this component is not rendered. Windows and Linux get a frameless window
 * (tauri.windows.conf.json) and this: one ☰ button that opens File, View and
 * Terminal as a two-level dropdown, which leaves the title row to the
 * workspace name and the command centre. Where the keyboard and the pointer
 * go is decided in appMenuNav.js; this only renders it.
 *
 * Focus stays wherever it was — usually the terminal — and keys are taken in
 * the capture phase while the menu is open, so closing the menu hands the
 * keyboard straight back without a focus dance.
 */
export function MenuBar() {
  const [state, setState] = useState(CLOSED);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const [subPlacement, setSubPlacement] = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const subRef = useRef(null);
  const titleRefs = useRef([]);

  const close = useCallback(() => setState(CLOSED), []);
  const run = useCallback((id) => {
    setState(CLOSED);
    runMenuAction(id);
  }, []);

  const toggle = () => {
    if (stateRef.current.open) {
      close();
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setAnchor(rect ? { left: rect.left, top: rect.bottom + 2 } : { left: 0, top: 0 });
    setState(openMenu());
  };

  useEffect(() => {
    if (!state.open) return undefined;

    const onKeyDown = (e) => {
      const result = menuKey(MENU_BAR, stateRef.current, e.key);
      // Plain keys must not leak into the terminal behind an open menu;
      // modified chords still reach the app's shortcuts.
      if (result.handled || !(e.ctrlKey || e.metaKey || e.altKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (result.run) run(result.run);
      else if (result.state !== stateRef.current) setState(result.state);
    };
    const onPointerDown = (e) => {
      const inside = [buttonRef, listRef, subRef].some((ref) => ref.current?.contains(e.target));
      if (!inside) close();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [state.open, close, run]);

  // Put the items beside their title, flipping to the left of the list or up
  // from the bottom when the window is too small for them.
  useLayoutEffect(() => {
    if (!state.open || state.expanded === -1) {
      setSubPlacement(null);
      return;
    }
    const row = titleRefs.current[state.expanded]?.getBoundingClientRect();
    const list = listRef.current?.getBoundingClientRect();
    const sub = subRef.current?.getBoundingClientRect();
    if (!row || !list || !sub) return;
    let left = list.right - 1;
    if (left + sub.width > window.innerWidth - MARGIN) left = Math.max(MARGIN, list.left - sub.width + 1);
    let top = row.top - 5; // line the first item up with the title (py-1 + border)
    if (top + sub.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, window.innerHeight - MARGIN - sub.height);
    setSubPlacement({ left, top });
  }, [state.open, state.expanded]);

  const expandedMenu = state.expanded === -1 ? null : MENU_BAR[state.expanded];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Application Menu"
        aria-label="Application Menu"
        aria-haspopup="menu"
        aria-expanded={state.open}
        // Keep focus where it is (usually the terminal).
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className={cn(
          'w-6 h-6 shrink-0 flex items-center justify-center rounded transition-colors',
          state.open ? 'text-vsc-fg bg-vsc-item-active' : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
        )}
      >
        <Menu size={16} />
      </button>

      {/* Portaled for the same reason as ContextMenu: a transformed ancestor
          would make `position: fixed` relative to itself. */}
      {state.open &&
        createPortal(
          <>
            <div
              ref={listRef}
              role="menu"
              aria-label="Application Menu"
              style={{ position: 'fixed', left: anchor.left, top: anchor.top }}
              className={cn('z-[70] min-w-[160px]', popupClass)}
            >
              {MENU_BAR.map((menu, index) => (
                <div
                  key={menu.title}
                  ref={(el) => {
                    titleRefs.current[index] = el;
                  }}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={state.expanded === index}
                  onMouseEnter={() => setState((s) => hoverTitle(s, index))}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setState((s) => hoverTitle(s, index))}
                  className={rowClass(state.top === index)}
                >
                  <span className="flex-1 min-w-0 truncate">{menu.title}</span>
                  <ChevronRight size={14} className="shrink-0 opacity-70" />
                </div>
              ))}
            </div>

            {expandedMenu && (
              <div
                ref={subRef}
                role="menu"
                aria-label={expandedMenu.title}
                style={{
                  position: 'fixed',
                  left: subPlacement?.left ?? 0,
                  top: subPlacement?.top ?? 0,
                  visibility: subPlacement ? 'visible' : 'hidden',
                }}
                className={cn('z-[71] min-w-[260px]', popupClass)}
              >
                {expandedMenu.items.map((item, index) =>
                  item.type === 'separator' ? (
                    <div key={`sep-${index}`} role="separator" className="my-1 border-t border-vsc-widget-border" />
                  ) : (
                    <div
                      key={item.id}
                      role="menuitem"
                      onMouseEnter={() => setState((s) => hoverItem(s, index))}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(item.id)}
                      className={rowClass(state.sub === index)}
                    >
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                      {item.shortcut ? (
                        <span className="text-ui-sm text-vsc-muted shrink-0 pl-3">{item.shortcut}</span>
                      ) : null}
                    </div>
                  )
                )}
              </div>
            )}
          </>,
          document.body
        )}
    </>
  );
}

export default MenuBar;
