/**
 * Tests for the agent Zustand store.
 *
 * Verifies agent aggregation, filtering, sorting, and attention count
 * through the Zustand store wrapper around AgentDataAggregator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAgentStore } from "../../../stores/agent-store.js";
import type { AgentSummary } from "../../types/agent.js";

function createAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    hostId: "host-1",
    hostName: "Test Host",
    provider: "claude-code",
    model: "claude-opus-4-6",
    status: "running",
    projectName: "test-project",
    projectPath: "/home/user/test-project",
    sessionId: "session-1",
    startedAt: "2026-02-22T10:00:00Z",
    lastActivityAt: "2026-02-22T14:00:00Z",
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      estimatedCost: 0.5,
    },
    pendingPermissions: 0,
    ...overrides,
  };
}

describe("agent-store", () => {
  beforeEach(() => {
    // Reset agent store
    const store = useAgentStore.getState();
    store._aggregator.removeHost("host-1");
    store._aggregator.removeHost("host-2");
    store.setFilter({ machineId: null, provider: null, status: null });
  });

  it("starts with empty agents list", () => {
    // After reset, agents from previous tests may linger in Zustand
    // but the aggregator is cleared
    const store = useAgentStore.getState();
    store.setAgentsForHost("host-1", []);
    expect(useAgentStore.getState().agents).toEqual([]);
  });

  it("setAgentsForHost adds agents and updates state", () => {
    const agents = [
      createAgent({ id: "a1", hostId: "host-1" }),
      createAgent({ id: "a2", hostId: "host-1" }),
    ];
    useAgentStore.getState().setAgentsForHost("host-1", agents);

    const state = useAgentStore.getState();
    expect(state.agents).toHaveLength(2);
  });

  it("setAgentsForHost replaces previous agents for the same host", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1" }),
    ]);
    expect(useAgentStore.getState().agents).toHaveLength(1);

    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a2", hostId: "host-1" }),
      createAgent({ id: "a3", hostId: "host-1" }),
    ]);
    expect(useAgentStore.getState().agents).toHaveLength(2);
  });

  it("merges agents from multiple hosts", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1" }),
    ]);
    useAgentStore.getState().setAgentsForHost("host-2", [
      createAgent({ id: "a2", hostId: "host-2" }),
    ]);

    expect(useAgentStore.getState().agents).toHaveLength(2);
  });

  it("updateAgent modifies a specific agent", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1", status: "running" }),
    ]);

    useAgentStore.getState().updateAgent("host-1", "a1", { status: "completed" });
    const updated = useAgentStore.getState().agents.find((a) => a.id === "a1");
    expect(updated?.status).toBe("completed");
  });

  it("markHostDisconnected sets all host agents to disconnected", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1", status: "running" }),
      createAgent({ id: "a2", hostId: "host-1", status: "idle" }),
    ]);

    useAgentStore.getState().markHostDisconnected("host-1");

    const agents = useAgentStore.getState().agents;
    expect(agents.every((a) => a.status === "disconnected")).toBe(true);
  });

  it("getFilteredAgents filters by status", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1", status: "running" }),
      createAgent({ id: "a2", hostId: "host-1", status: "idle" }),
      createAgent({ id: "a3", hostId: "host-1", status: "running" }),
    ]);

    useAgentStore.getState().setFilter({ status: "running" });
    const filtered = useAgentStore.getState().getFilteredAgents();
    expect(filtered).toHaveLength(2);
    expect(filtered.every((a) => a.status === "running")).toBe(true);
  });

  it("getAttentionCount counts agents needing attention", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1", status: "error" }),
      createAgent({ id: "a2", hostId: "host-1", pendingPermissions: 2 }),
      createAgent({ id: "a3", hostId: "host-1", status: "running" }),
    ]);

    expect(useAgentStore.getState().getAttentionCount()).toBe(2);
  });

  it("removeHost removes all agents for a host", () => {
    useAgentStore.getState().setAgentsForHost("host-1", [
      createAgent({ id: "a1", hostId: "host-1" }),
    ]);
    useAgentStore.getState().setAgentsForHost("host-2", [
      createAgent({ id: "a2", hostId: "host-2" }),
    ]);
    expect(useAgentStore.getState().agents).toHaveLength(2);

    useAgentStore.getState().removeHost("host-1");
    expect(useAgentStore.getState().agents).toHaveLength(1);
    expect(useAgentStore.getState().agents[0].hostId).toBe("host-2");
  });
});
