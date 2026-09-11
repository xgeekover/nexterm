import React, { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore.js';
import { AgentCard } from './AgentCard.jsx';
import { NewAgentModal } from './NewAgentModal.jsx';
import { AgentLogsViewer } from './AgentLogsViewer.jsx';

export function MissionControl() {
  const agents = useAgentStore((s) => s.agents);
  const telemetry = useAgentStore((s) => s.telemetry);
  const initAgents = useAgentStore((s) => s.initAgents);
  const setNewAgentModalOpen = useAgentStore((s) => s.setNewAgentModalOpen);

  useEffect(() => {
    initAgents();
  }, [initAgents]);

  return (
    <div className="flex flex-col h-full w-full bg-vsc-sidebar overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-panel-header px-3 border-b border-vsc-border select-none flex-shrink-0">
        <h2 className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
          Agents
        </h2>

        <button
          type="button"
          onClick={() => setNewAgentModalOpen(true)}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          title="New agent"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Telemetry strip */}
      <div className="flex items-center gap-4 h-[22px] px-3 border-b border-vsc-border select-none flex-shrink-0 overflow-x-auto">
        <span className="text-ui-sm text-vsc-muted whitespace-nowrap">
          Active <strong className="text-vsc-fg font-mono font-normal">{telemetry.activeCount}</strong>
        </span>
        <span className="text-ui-sm text-vsc-muted whitespace-nowrap">
          Waiting <strong className="text-vsc-fg font-mono font-normal">{telemetry.waitingCount}</strong>
        </span>
        <span className="text-ui-sm text-vsc-muted whitespace-nowrap">
          Tokens <strong className="text-vsc-fg font-mono font-normal">{telemetry.totalTokens.toLocaleString()}</strong>
        </span>
        <span className="text-ui-sm text-vsc-muted whitespace-nowrap">
          Cost <strong className="text-vsc-fg font-mono font-normal">${telemetry.totalCost.toFixed(3)}</strong>
        </span>
      </div>

      {/* Agents list */}
      <div className="flex-1 overflow-y-auto">
        {agents.length > 0 ? (
          agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
        ) : (
          <div className="text-ui-sm text-vsc-muted text-center py-8">
            No agents deployed yet.
          </div>
        )}
      </div>

      {/* Modals & Drawers */}
      <NewAgentModal />
      <AgentLogsViewer />
    </div>
  );
}

export default MissionControl;
