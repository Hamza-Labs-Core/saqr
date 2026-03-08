import { create } from "zustand";
import { AgentDataAggregator } from "../src/services/agent-data-aggregator.js";
import type {
  AgentSummary,
  AgentListFilter,
  AgentSortField,
  SortDirection,
} from "../src/types/agent.js";

interface AgentState {
  agents: AgentSummary[];
  filter: AgentListFilter;
  sortBy: AgentSortField;
  sortDirection: SortDirection;

  setAgentsForHost: (hostId: string, agents: AgentSummary[]) => void;
  updateAgent: (
    hostId: string,
    agentId: string,
    updates: Partial<AgentSummary>,
  ) => void;
  markHostDisconnected: (hostId: string) => void;
  removeHost: (hostId: string) => void;
  setFilter: (filter: Partial<AgentListFilter>) => void;
  setSortBy: (field: AgentSortField) => void;
  toggleSortDirection: () => void;

  getFilteredAgents: () => AgentSummary[];
  getAttentionCount: () => number;

  _aggregator: AgentDataAggregator;
}

export const useAgentStore = create<AgentState>()((set, get) => {
  const aggregator = new AgentDataAggregator();

  return {
    agents: [],
    filter: { machineId: null, provider: null, status: null },
    sortBy: "lastActivity" as AgentSortField,
    sortDirection: "desc" as SortDirection,
    _aggregator: aggregator,

    setAgentsForHost: (hostId: string, agents: AgentSummary[]) => {
      aggregator.setAgentsForHost(hostId, agents);
      set({ agents: aggregator.getMergedAgents() });
    },

    updateAgent: (
      hostId: string,
      agentId: string,
      updates: Partial<AgentSummary>,
    ) => {
      aggregator.updateAgent(hostId, agentId, updates);
      set({ agents: aggregator.getMergedAgents() });
    },

    markHostDisconnected: (hostId: string) => {
      aggregator.markHostDisconnected(hostId);
      set({ agents: aggregator.getMergedAgents() });
    },

    removeHost: (hostId: string) => {
      aggregator.removeHost(hostId);
      set({ agents: aggregator.getMergedAgents() });
    },

    setFilter: (filter: Partial<AgentListFilter>) =>
      set((state) => ({ filter: { ...state.filter, ...filter } })),

    setSortBy: (field: AgentSortField) => set({ sortBy: field }),

    toggleSortDirection: () =>
      set((state) => ({
        sortDirection: state.sortDirection === "asc" ? "desc" : "asc",
      })),

    getFilteredAgents: () => {
      const { filter, sortBy, sortDirection } = get();
      const filtered = aggregator.getFiltered(filter);
      const sorted = aggregator.getSorted(sortBy, sortDirection);
      return sorted.filter((a) =>
        filtered.some((f) => f.id === a.id && f.hostId === a.hostId),
      );
    },

    getAttentionCount: () => aggregator.getAttentionCount(),
  };
});
