/**
 * AgentDataAggregator - Merges agents from multiple daemons into a unified view.
 *
 * Provides sorting, filtering, badge computation, and per-agent
 * in-place updates for real-time agent list management.
 *
 * @module services/agent-data-aggregator
 */

import type {
  AgentSummary,
  AgentSortField,
  SortDirection,
  AgentListFilter,
  AgentStatus,
} from "../types/agent.js";

/**
 * Status priority for sorting (higher priority = shown first).
 * waiting_permission and error need attention, so they rank highest.
 */
const STATUS_PRIORITY: Record<AgentStatus, number> = {
  waiting_permission: 0,
  error: 1,
  running: 2,
  initializing: 3,
  idle: 4,
  completed: 5,
  disconnected: 6,
};

/**
 * Aggregates agent data from multiple daemon connections
 * into a single, unified, sortable, filterable view.
 */
export class AgentDataAggregator {
  /** Per-host agent lists. Key is hostId. */
  private agentsByHost: Map<string, AgentSummary[]> = new Map();

  /**
   * Set the complete agent list for a host. Replaces any previous list.
   */
  setAgentsForHost(hostId: string, agents: AgentSummary[]): void {
    this.agentsByHost.set(
      hostId,
      agents.map((a) => ({ ...a }))
    );
  }

  /**
   * Remove all agents for a host.
   */
  removeHost(hostId: string): void {
    this.agentsByHost.delete(hostId);
  }

  /**
   * Update a specific agent's fields in place.
   */
  updateAgent(
    hostId: string,
    agentId: string,
    updates: Partial<AgentSummary>
  ): void {
    const agents = this.agentsByHost.get(hostId);
    if (!agents) return;

    const idx = agents.findIndex((a) => a.id === agentId);
    if (idx < 0) return;

    agents[idx] = { ...agents[idx], ...updates };
  }

  /**
   * Mark all agents from a host as disconnected.
   */
  markHostDisconnected(hostId: string): void {
    const agents = this.agentsByHost.get(hostId);
    if (!agents) return;

    for (let i = 0; i < agents.length; i++) {
      agents[i] = { ...agents[i], status: "disconnected" };
    }
  }

  /**
   * Get all agents merged from all hosts.
   */
  getMergedAgents(): AgentSummary[] {
    const all: AgentSummary[] = [];
    for (const agents of this.agentsByHost.values()) {
      for (const agent of agents) {
        all.push({ ...agent });
      }
    }
    return all;
  }

  /**
   * Get agents sorted by the given field and direction.
   */
  getSorted(sortBy: AgentSortField, direction: SortDirection): AgentSummary[] {
    const agents = this.getMergedAgents();
    const dir = direction === "asc" ? 1 : -1;

    agents.sort((a, b) => {
      switch (sortBy) {
        case "lastActivity":
          return (
            dir *
            (new Date(a.lastActivityAt).getTime() -
              new Date(b.lastActivityAt).getTime())
          );
        case "machine":
          return dir * a.hostName.localeCompare(b.hostName);
        case "status":
          return (
            dir * (STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
          );
        case "project":
          return dir * a.projectName.localeCompare(b.projectName);
        default:
          return 0;
      }
    });

    return agents;
  }

  /**
   * Get agents filtered by the given criteria.
   */
  getFiltered(filter: AgentListFilter): AgentSummary[] {
    let agents = this.getMergedAgents();

    if (filter.machineId !== null) {
      agents = agents.filter((a) => a.hostId === filter.machineId);
    }
    if (filter.provider !== null) {
      agents = agents.filter((a) => a.provider === filter.provider);
    }
    if (filter.status !== null) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    return agents;
  }

  /**
   * Count agents needing attention (pending permissions or error status).
   */
  getAttentionCount(): number {
    let count = 0;
    for (const agents of this.agentsByHost.values()) {
      for (const agent of agents) {
        if (agent.pendingPermissions > 0 || agent.status === "error") {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Sum of all pending permission requests across all agents.
   */
  getTotalPendingPermissions(): number {
    let total = 0;
    for (const agents of this.agentsByHost.values()) {
      for (const agent of agents) {
        total += agent.pendingPermissions;
      }
    }
    return total;
  }
}
