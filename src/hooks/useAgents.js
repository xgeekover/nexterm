import { useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore.js';

export function useAgents() {
  const store = useAgentStore();

  useEffect(() => {
    store.initAgents();
  }, []);

  return {
    agents: store.agents,
    selectedAgent: store.getSelectedAgent(),
    selectedAgentId: store.selectedAgentId,
    agentLogs: store.agentLogs,
    isNewAgentModalOpen: store.isNewAgentModalOpen,
    isLogsDrawerOpen: store.isLogsDrawerOpen,
    telemetry: store.telemetry,
    createAgent: store.createAgent,
    updateAgentStatus: store.updateAgentStatus,
    selectAgent: store.selectAgent,
    loadLogs: store.loadLogs,
    setNewAgentModalOpen: store.setNewAgentModalOpen,
    setLogsDrawerOpen: store.setLogsDrawerOpen,
  };
}

export default useAgents;
