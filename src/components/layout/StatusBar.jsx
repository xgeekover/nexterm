import React from 'react';
import { GitBranch, Cpu, Bell } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { cn } from '../../lib/utils.js';

const item = 'h-full px-2 flex items-center gap-1.5 hover:bg-vsc-item-hover cursor-default';

export function StatusBar() {
  const cwd = useTerminalStore((s) => s.cwd);

  const formattedCwd = (cwd || '/workspace').replace('/workspace', '~/workspace');

  return (
    <footer className="h-statusbar shrink-0 flex items-center justify-between bg-vsc-statusbar border-t border-vsc-border text-[12px] text-vsc-fg select-none">
      {/* Left items */}
      <div className="flex items-center h-full min-w-0">
        <div className="h-full px-2 flex items-center bg-vsc-accent text-vsc-accent-fg font-medium shrink-0">
          NexTerm
        </div>

        <div className={item}>
          <GitBranch size={14} />
          <span>main</span>
        </div>

        <div className={cn(item, 'text-vsc-muted truncate min-w-0')}>
          <span className="truncate">{formattedCwd}</span>
        </div>
      </div>

      {/* Right items */}
      <div className="flex items-center h-full shrink-0">
        <div className={item}>
          <span>zsh</span>
        </div>

        <button type="button" className={item} title="Notifications">
          <Bell size={14} />
        </button>
      </div>
    </footer>
  );
}

export default StatusBar;
