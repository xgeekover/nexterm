import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { DEFAULT_AGENTS } from '../lib/constants.js';

export function computeTelemetry(agents = []) {
  let totalTokens = 0;
  let totalCost = 0;
  let activeCount = 0;
  let waitingCount = 0;
  let idleCount = 0;

  const list = agents || [];
  for (const a of list) {
    totalTokens += a.tokens || 0;
    totalCost += a.cost || 0;
    if (a.status === 'active') activeCount++;
    else if (a.status === 'waiting') waitingCount++;
    else if (a.status === 'idle') idleCount++;
  }

  return {
    totalTokens,
    totalCost,
    activeCount,
    waitingCount,
    idleCount,
    totalAgents: list.length,
  };
}

export const useAgentStore = create((set, get) => ({
  agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)),
  telemetry: computeTelemetry(DEFAULT_AGENTS),
  selectedAgentId: 'agent-architect-01',
  agentLogs: new Map(DEFAULT_AGENTS.map((a) => [a.id, a.logs ? [...a.logs] : []])),
  isNewAgentModalOpen: false,
  isLogsDrawerOpen: false,
  isInitialized: false,

  initAgents: async () => {
    if (get().isInitialized) return;

    try {
      const list = await invoke('agent_list');
      if (list && list.length > 0) {
        const logsMap = new Map();
        for (const a of list) {
          logsMap.set(a.id, a.logs ? [...a.logs] : []);
        }
        set({
          agents: list,
          telemetry: computeTelemetry(list),
          agentLogs: logsMap,
          isInitialized: true,
        });
      }

      // Listen for agent updates
      listen('agent-updated', (updated) => {
        if (!updated || !updated.id) return;
        set((state) => {
          const idx = state.agents.findIndex((a) => a.id === updated.id);
          let nextAgents;
          if (idx >= 0) {
            nextAgents = [...state.agents];
            nextAgents[idx] = { ...nextAgents[idx], ...updated };
          } else {
            nextAgents = [...state.agents, updated];
          }
          return {
            agents: nextAgents,
            telemetry: computeTelemetry(nextAgents),
          };
        });
      });

      // Listen for streamed agent logs
      listen('agent-log', (logEntry) => {
        if (!logEntry || !logEntry.agent_id) return;
        get().appendLog(logEntry.agent_id, logEntry);
      });
    } catch (err) {
      console.error('[AgentStore] Failed to initialize agents:', err);
    }
  },

  createAgent: async ({ name, role, model, systemPrompt, dependency }) => {
    if (!name || !name.trim()) throw new Error('Agent name is required');
    if (!model) throw new Error('Agent model is required');

    try {
      const newAgent = await invoke('agent_create', { input: {
        name: name.trim(),
        role: role || 'Assistant',
        model,
        systemPrompt: systemPrompt || '',
        dependency: dependency || null,
      }
      });

      const list = await invoke('agent_list');
      set((state) => {
        const nextLogs = new Map(state.agentLogs);
        nextLogs.set(newAgent.id, []);
        return {
          agents: list,
          telemetry: computeTelemetry(list),
          agentLogs: nextLogs,
          selectedAgentId: newAgent.id,
          isNewAgentModalOpen: false,
        };
      });

      return newAgent;
    } catch (err) {
      console.error('[AgentStore] Failed to create agent:', err);
      throw err;
    }
  },

  updateAgentStatus: async (agentId, status) => {
    try {
      const updated = await invoke('agent_update_status', {
        agent_id: agentId,
        status,
      });

      const list = await invoke('agent_list');
      set({
        agents: list,
        telemetry: computeTelemetry(list),
      });
      return updated;
    } catch (err) {
      console.error(`[AgentStore] Failed to update agent ${agentId} status:`, err);
      throw err;
    }
  },

  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId });
  },

  loadLogs: async (agentId) => {
    try {
      const logs = await invoke('agent_get_logs', { agent_id: agentId });
      set((state) => {
        const nextLogs = new Map(state.agentLogs);
        nextLogs.set(agentId, logs || []);
        return { agentLogs: nextLogs };
      });
      return logs;
    } catch (err) {
      console.error(`[AgentStore] Failed to load logs for ${agentId}:`, err);
      return [];
    }
  },

  appendLog: (agentId, logEntry) => {
    set((state) => {
      const nextLogs = new Map(state.agentLogs);
      const current = nextLogs.get(agentId) || [];
      const updatedList = [...current, logEntry];
      // Keep up to 500 logs in ring buffer
      if (updatedList.length > 500) updatedList.shift();
      nextLogs.set(agentId, updatedList);
      return { agentLogs: nextLogs };
    });
  },

  setNewAgentModalOpen: (open) => set({ isNewAgentModalOpen: open }),
  setLogsDrawerOpen: (open) => set({ isLogsDrawerOpen: open }),

  getSelectedAgent: () => {
    const { agents, selectedAgentId } = get();
    return agents.find((a) => a.id === selectedAgentId) || agents[0] || null;
  },

  getTelemetry: () => get().telemetry,
}));

export default useAgentStore;
