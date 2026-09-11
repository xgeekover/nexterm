import React from 'react';
import { GitBranch, Cpu, Sun, Moon, Bell } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useTheme } from '../../hooks/useTheme.js';
import { cn } from '../../lib/utils.js';

const item = 'h-full px-2 flex items-center gap-1.5 hover:bg-vsc-item-hover cursor-default';

export function StatusBar() {
  const telemetry = useAgentStore((s) => s.telemetry);
  const cwd = useTerminalStore((s) => s.cwd);
  const { theme, toggleTheme } = useTheme();

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
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              telemetry.activeCount > 0 ? 'bg-vsc-ok animate-pulse' : 'bg-vsc-muted'
            )}
          />
          <span>{telemetry.activeCount} Active</span>
          {telemetry.waitingCount > 0 && (
            <span className="text-vsc-warn">({telemetry.waitingCount} Waiting)</span>
          )}
        </div>

        <div className={item}>
          <Cpu size={14} />
          <span>{telemetry.totalTokens.toLocaleString()} tokens</span>
        </div>

        <div className={item}>
          <span>zsh</span>
        </div>

        <button type="button" onClick={toggleTheme} className={item} title="Toggle Theme">
          {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
          <span>{theme === 'dark' ? 'Dark Modern' : 'Light Modern'}</span>
        </button>

        <button type="button" className={item} title="Notifications">
          <Bell size={14} />
        </button>
      </div>
    </footer>
  );
}

export default StatusBar;
