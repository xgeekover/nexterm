import React from 'react';
import { Play, Pause, Terminal, MessageSquare } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { cn } from '../../lib/utils.js';

const STATUS_PILL = {
  active: {
    label: 'Active',
    className: 'text-vsc-ok bg-[color-mix(in_srgb,var(--vsc-ok)_15%,transparent)]',
  },
  waiting: {
    label: 'Waiting',
    className: 'text-vsc-warn bg-[color-mix(in_srgb,var(--vsc-warn)_15%,transparent)]',
  },
  idle: {
    label: 'Idle',
    className: 'text-vsc-muted bg-[color-mix(in_srgb,var(--vsc-muted)_15%,transparent)]',
  },
  completed: {
    label: 'Completed',
    className: 'text-vsc-muted bg-[color-mix(in_srgb,var(--vsc-muted)_15%,transparent)]',
  },
  paused: {
    label: 'Paused',
    className: 'text-vsc-warn bg-[color-mix(in_srgb,var(--vsc-warn)_15%,transparent)]',
  },
  failed: {
    label: 'Failed',
    className: 'text-vsc-error bg-[color-mix(in_srgb,var(--vsc-error)_15%,transparent)]',
  },
};

export function AgentCard({ agent }) {
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const setLogsDrawerOpen = useAgentStore((s) => s.setLogsDrawerOpen);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const isActive = agent.status === 'active';
  const isIdle = agent.status === 'idle';
  const isPaused = agent.status === 'paused';

  const pill = STATUS_PILL[agent.status] || STATUS_PILL.idle;

  const handleTogglePause = async () => {
    if (isActive) {
      await updateAgentStatus(agent.id, 'paused');
    } else if (isPaused || isIdle) {
      await updateAgentStatus(agent.id, 'active');
    }
  };

  const handleOpenLogs = () => {
    selectAgent(agent.id);
    setLogsDrawerOpen(true);
  };

  const handleChatWithAgent = () => {
    selectAgent(agent.id);
    setActiveView('chat');
  };

  const progress = Math.min(100, Math.max(0, agent.progress || 0));

  return (
    <div className="group flex items-center gap-3 px-3 py-2 border-b border-vsc-border hover:bg-vsc-hover transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-ui font-semibold text-vsc-fg truncate">{agent.name}</span>
          <span className={cn('text-ui-sm rounded-sm px-1.5 flex-shrink-0', pill.className)}>
            {pill.label}
          </span>
        </div>

        <div className="text-ui-sm text-vsc-muted truncate mt-0.5">
          {agent.role} &middot; {agent.model}
          {agent.dependency && <> &middot; chained: {agent.dependency.replace('agent-', '')}</>}
        </div>

        {/* Progress bar */}
        <div className="mt-1.5 h-[2px] w-full bg-vsc-border overflow-hidden">
          <div
            className="h-full bg-vsc-accent transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Telemetry */}
      <div className="hidden sm:flex flex-col items-end text-ui-sm text-vsc-muted font-mono flex-shrink-0 w-24">
        <span>{(agent.tokens || 0).toLocaleString()} tok</span>
        <span>${(agent.cost || 0).toFixed(3)}</span>
      </div>

      {/* Row actions (hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
        <button
          type="button"
          onClick={handleTogglePause}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          title={isActive ? 'Pause Agent' : 'Resume Agent'}
        >
          {isActive ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <button
          type="button"
          onClick={handleOpenLogs}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          title="View Streamed Logs"
        >
          <Terminal size={14} />
        </button>

        <button
          type="button"
          onClick={handleChatWithAgent}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          title="Chat with Agent"
        >
          <MessageSquare size={14} />
        </button>
      </div>
    </div>
  );
}

export default AgentCard;
