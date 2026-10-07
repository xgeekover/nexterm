import React from 'react';
import {
  Files,
  Search,
  SquareTerminal,
  Settings,
} from 'lucide-react';
import { useSettingsStore, isViewShown } from '../../stores/settingsStore.js';
import { cn } from '../../lib/utils.js';

function ActivityBarButton({ icon: Icon, label, isActive, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'relative w-full h-activitybar flex items-center justify-center transition-colors',
        isActive
          ? 'text-vsc-activitybar-fg'
          : 'text-vsc-activitybar-muted hover:text-vsc-activitybar-fg'
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-vsc-focus" aria-hidden="true" />
      )}
      <Icon size={24} strokeWidth={1.75} />
    </button>
  );
}

export function Sidebar() {
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const showView = useSettingsStore((s) => s.showView);
  const toggleView = useSettingsStore((s) => s.toggleView);
  // Lit for the view on screen — the same answer the layout draws from.
  const explorerShown = useSettingsStore((s) => isViewShown(s, 'explorer'));
  const searchShown = useSettingsStore((s) => isViewShown(s, 'search'));
  const setSettingsModalOpen = useSettingsStore((s) => s.setSettingsModalOpen);

  // Order: 1) Terminal, 2) Explorer, 3) Search.
  const topItems = [
    {
      id: 'terminal',
      label: 'Terminal',
      icon: SquareTerminal,
      isActive: panelVisible,
      onClick: togglePanel,
    },
    {
      id: 'explorer',
      label: 'Explorer',
      icon: Files,
      isActive: explorerShown,
      // Now that the left region hosts two views, "Explorer" has to mean the
      // Explorer rather than "toggle whatever is over there": hidden again
      // only when it is the view on screen, brought on screen otherwise.
      onClick: () => toggleView('explorer'),
    },
    {
      id: 'search',
      label: 'Search',
      icon: Search,
      // This button has been here since the first release, with a magnifying
      // glass, labelled "Search", in exactly the slot VS Code puts search in —
      // and it opened the command palette. A control that says one thing and
      // does another is the same family as the notifications bell with no
      // handler and the status bar's invented git branch. It searches now.
      isActive: searchShown,
      onClick: () => showView('search'),
    },
  ];

  return (
    <aside className="w-activitybar h-full flex flex-col justify-between bg-vsc-activitybar border-r border-vsc-border select-none">
      <div className="flex flex-col">
        {topItems.map((item) => (
          <ActivityBarButton
            key={item.id}
            icon={item.icon}
            label={item.label}
            isActive={item.isActive}
            onClick={item.onClick}
          />
        ))}
      </div>

      <div className="flex flex-col">
        <button
          type="button"
          // A click leaves focus where it was — the terminal or the editor —
          // so that Settings, which gives focus back to whatever had it when
          // it opened, gives it back there rather than to this icon. Tab
          // still reaches it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSettingsModalOpen(true)}
          title="Settings"
          className="w-full h-activitybar flex items-center justify-center text-vsc-activitybar-muted hover:text-vsc-activitybar-fg transition-colors"
        >
          <Settings size={24} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
