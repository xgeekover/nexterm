import React from 'react';
import {
  Files,
  Search,
  SquareTerminal,
  Settings,
  Sun,
  Moon,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useTheme } from '../../hooks/useTheme.js';
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
  const sidebarVisible = useSettingsStore((s) => s.sidebarVisible);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const panelVisible = useSettingsStore((s) => s.panelVisible);
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const secondarySidebarVisible = useSettingsStore((s) => s.secondarySidebarVisible);
  const secondaryTab = useSettingsStore((s) => s.secondaryTab);
  const toggleSecondarySidebar = useSettingsStore((s) => s.toggleSecondarySidebar);
  const isCommandPaletteOpen = useSettingsStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const setSettingsModalOpen = useSettingsStore((s) => s.setSettingsModalOpen);
  const { theme, toggleTheme } = useTheme();

  const topItems = [
    {
      id: 'explorer',
      label: 'Explorer',
      icon: Files,
      isActive: sidebarVisible,
      onClick: toggleSidebar,
    },
    {
      id: 'search',
      label: 'Search',
      icon: Search,
      isActive: isCommandPaletteOpen,
      onClick: () => setCommandPaletteOpen(true),
    },
    {
      id: 'terminal',
      label: 'Terminal',
      icon: SquareTerminal,
      isActive: panelVisible,
      onClick: togglePanel,
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
          onClick={() => setSettingsModalOpen(true)}
          title="Settings"
          className="w-full h-activitybar flex items-center justify-center text-vsc-activitybar-muted hover:text-vsc-activitybar-fg transition-colors"
        >
          <Settings size={24} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`}
          className="w-full h-activitybar flex items-center justify-center text-vsc-activitybar-muted hover:text-vsc-activitybar-fg transition-colors"
        >
          {theme === 'dark' ? <Sun size={24} strokeWidth={1.75} /> : <Moon size={24} strokeWidth={1.75} />}
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
