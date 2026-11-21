import React from 'react';
import { cn } from '../../lib/utils.js';
import { displayTitle } from '../../lib/tabTitle.js';
import { folderName, placedTerminalTabs } from '../../lib/tabMru.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useTabSwitcherStore } from '../../stores/tabSwitcherStore.js';

/** The id of row `tabId`, for the listbox's `aria-activedescendant`. */
export const switcherRowId = (tabId) => `tab-switcher-${tabId}`;

/**
 * The Ctrl+Tab switcher (Bundle 2, A5-3): the terminals most recently used,
 * every group's, most recent first — each row its name, its group and the
 * last part of its folder — with the one letting go of Ctrl picks marked.
 * What it lists and what the keys do is tabSwitcherStore.js; this only
 * draws it, and picks the row clicked.
 *
 * It never takes the keyboard, so a mouse press on a row keeps it where it
 * is (the terminal), and nothing moves: no transition or animation at all,
 * so a reduce-motion setting has nothing to turn off. The theme's `vsc-*`
 * colours only, as the command palette's.
 */
export function TabSwitcher() {
  const open = useTabSwitcherStore((s) => s.open);
  const items = useTabSwitcherStore((s) => s.items);
  const selectedIndex = useTabSwitcherStore((s) => s.selectedIndex);
  const commit = useTabSwitcherStore((s) => s.commit);
  const tabs = useTerminalStore((s) => s.tabs);
  const groups = useTerminalStore((s) => s.groups);

  if (!open || !Array.isArray(items) || items.length === 0) return null;

  const tabById = new Map((tabs ?? []).map((t) => [t.id, t]));
  const groupOf = new Map(placedTerminalTabs(groups).map((p) => [p.tabId, p.groupName]));
  const selectedId = items[selectedIndex] ?? null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none" data-tab-switcher="">
      <div
        role="listbox"
        aria-label="Recent terminals"
        aria-activedescendant={selectedId ? switcherRowId(selectedId) : undefined}
        className="pointer-events-auto absolute top-[8px] left-1/2 -translate-x-1/2 w-[480px] max-w-[90vw] bg-vsc-quickinput border border-vsc-widget-border shadow-widget rounded-popover overflow-hidden p-1"
      >
        {items.map((tabId, index) => {
          const tab = tabById.get(tabId);
          if (!tab) return null;
          const selected = index === selectedIndex;
          const title = displayTitle(tab);
          const folder = folderName(tab.cwd);
          return (
            <div
              key={tabId}
              id={switcherRowId(tabId)}
              role="option"
              aria-selected={selected}
              data-tab-switcher-row={tabId}
              title={tab.cwd || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(index)}
              className={cn(
                'h-[22px] px-2 rounded-control flex items-center gap-2 text-ui cursor-pointer select-none',
                selected ? 'bg-vsc-selection text-vsc-selection-fg' : 'text-vsc-fg'
              )}
            >
              <span className="truncate" data-tab-switcher-title="">
                {title}
              </span>
              <span
                className={cn('truncate text-ui-sm flex-shrink', selected ? 'text-vsc-selection-fg' : 'text-vsc-muted')}
                data-tab-switcher-group=""
              >
                {groupOf.get(tabId) ?? ''}
              </span>
              <span className="flex-1" />
              {folder && (
                <span
                  className={cn('truncate text-ui-sm flex-shrink-0', selected ? 'text-vsc-selection-fg' : 'text-vsc-muted')}
                  data-tab-switcher-folder=""
                >
                  {folder}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TabSwitcher;
