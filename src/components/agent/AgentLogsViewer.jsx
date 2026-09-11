import React, { useRef, useEffect, useState } from 'react';
import { X, Terminal } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore.js';
import { formatTimestamp, cn } from '../../lib/utils.js';

const LEVEL_CLASS = {
  INFO: 'text-ansi-blue',
  DEBUG: 'text-ansi-magenta',
  WARN: 'text-ansi-yellow',
  ERROR: 'text-ansi-red',
};

export function AgentLogsViewer() {
  const isLogsDrawerOpen = useAgentStore((s) => s.isLogsDrawerOpen);
  const setLogsDrawerOpen = useAgentStore((s) => s.setLogsDrawerOpen);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const agents = useAgentStore((s) => s.agents);
  const agentLogs = useAgentStore((s) => s.agentLogs);

  const [filterLevel, setFilterLevel] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const logsEndRef = useRef(null);

  const currentAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const logs = currentAgent ? (agentLogs.get(currentAgent.id) || []) : [];

  const filteredLogs = logs.filter((log) => {
    if (filterLevel !== 'ALL' && log.level !== filterLevel) return false;
    if (searchQuery && !log.message?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  useEffect(() => {
    if (isLogsDrawerOpen) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, isLogsDrawerOpen]);

  if (!isLogsDrawerOpen) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 h-[380px] bg-vsc-panel border-t border-vsc-border shadow-widget flex flex-col select-none">
      {/* Drawer Header */}
      <div className="flex items-center justify-between h-panel-header px-3 border-b border-vsc-border flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 text-vsc-fg">
            <Terminal size={14} />
            <span className="text-ui font-semibold truncate">
              {currentAgent ? `${currentAgent.name} Execution Stream` : 'Agent Logs'}
            </span>
          </div>

          <span className="text-ui-sm text-vsc-muted flex-shrink-0">
            {logs.length} entries
          </span>
        </div>

        {/* Filter Controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="h-[24px] px-2 rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg placeholder:text-vsc-placeholder text-ui-sm outline-none focus:border-vsc-focus w-36"
          />

          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            className="h-[24px] px-1.5 rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg text-ui-sm outline-none focus:border-vsc-focus"
          >
            <option value="ALL">All Levels</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
          </select>

          <button
            type="button"
            onClick={() => setLogsDrawerOpen(false)}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
            title="Close Drawer"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Log Stream Output */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1 bg-vsc-editor select-text font-mono text-code">
        {filteredLogs.length > 0 ? (
          filteredLogs.map((log, idx) => {
            const level = log.level || 'INFO';
            const levelClass = LEVEL_CLASS[level] || 'text-vsc-muted';

            return (
              <div key={log.id || idx} className="flex items-start gap-3 leading-relaxed">
                <span className="text-vsc-muted flex-shrink-0">
                  {formatTimestamp(log.timestamp)}
                </span>

                <span className={cn('font-semibold flex-shrink-0 w-14', levelClass)}>
                  {level}
                </span>

                <span className="text-vsc-fg flex-1 break-words">
                  {log.message}
                </span>
              </div>
            );
          })
        ) : (
          <div className="text-vsc-muted italic py-8 text-center">
            No log entries matching criteria.
          </div>
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

export default AgentLogsViewer;
