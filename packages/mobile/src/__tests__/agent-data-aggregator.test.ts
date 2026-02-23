/**
 * Tests for the AgentDataAggregator service.
 *
 * Covers merging agents from multiple daemons, sorting, filtering,
 * and real-time update handling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentDataAggregator } from "../services/agent-data-aggregator.js";
import type { AgentSummary, AgentListFilter } from "../types/agent.js";

function createAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    hostId: "host-1",
    hostName: "Work MacBook",
    provider: "claude-code",
    model: "claude-opus-4-6",
    status: "running",
    projectName: "my-project",
    projectPath: "/Users/me/my-project",
    currentActivity: "Running Bash command",
    sessionId: "sess-1",
    startedAt: "2026-02-22T10:00:00Z",
    lastActivityAt: "2026-02-22T14:30:00Z",
    tokenUsage: {
      inputTokens: 8200,
      outputTokens: 3100,
      cacheReadTokens: 4000,
      estimatedCost: 0.42,
    },
    pendingPermissions: 0,
    ...overrides,
  };
}

describe("AgentDataAggregator", () => {
  let aggregator: AgentDataAggregator;

  beforeEach(() => {
    aggregator = new AgentDataAggregator();
  });

  describe("merging agents from multiple daemons", () => {
    it("merges agents from two hosts into single list", () => {
      const agents1 = [
        createAgent({ id: "a1", hostId: "host-1", hostName: "MacBook" }),
      ];
      const agents2 = [
        createAgent({ id: "a2", hostId: "host-2", hostName: "Linux VM" }),
      ];

      aggregator.setAgentsForHost("host-1", agents1);
      aggregator.setAgentsForHost("host-2", agents2);

      const merged = aggregator.getMergedAgents();
      expect(merged).toHaveLength(2);
    });

    it("deduplicates by (hostId, agentId) key", () => {
      const agent = createAgent({ id: "a1", hostId: "host-1" });
      aggregator.setAgentsForHost("host-1", [agent]);
      aggregator.setAgentsForHost("host-1", [agent]);

      const merged = aggregator.getMergedAgents();
      expect(merged).toHaveLength(1);
    });

    it("replaces agents for a host on re-set", () => {
      const agent1 = createAgent({
        id: "a1",
        hostId: "host-1",
        status: "running",
      });
      const agent2 = createAgent({
        id: "a1",
        hostId: "host-1",
        status: "idle",
      });

      aggregator.setAgentsForHost("host-1", [agent1]);
      aggregator.setAgentsForHost("host-1", [agent2]);

      const merged = aggregator.getMergedAgents();
      expect(merged).toHaveLength(1);
      expect(merged[0].status).toBe("idle");
    });

    it("handles empty agent lists from hosts", () => {
      aggregator.setAgentsForHost("host-1", []);
      aggregator.setAgentsForHost("host-2", []);
      expect(aggregator.getMergedAgents()).toHaveLength(0);
    });

    it("removeHost clears agents for that host", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1" }),
      ]);
      aggregator.setAgentsForHost("host-2", [
        createAgent({ id: "a2", hostId: "host-2" }),
      ]);

      aggregator.removeHost("host-1");
      expect(aggregator.getMergedAgents()).toHaveLength(1);
      expect(aggregator.getMergedAgents()[0].hostId).toBe("host-2");
    });
  });

  describe("single agent update", () => {
    it("updateAgent updates a specific agent in place", () => {
      const agent = createAgent({ id: "a1", hostId: "host-1", status: "running" });
      aggregator.setAgentsForHost("host-1", [agent]);

      aggregator.updateAgent("host-1", "a1", { status: "idle" });
      const merged = aggregator.getMergedAgents();
      expect(merged[0].status).toBe("idle");
    });

    it("updateAgent preserves other agent fields", () => {
      const agent = createAgent({
        id: "a1",
        hostId: "host-1",
        projectName: "my-project",
        status: "running",
      });
      aggregator.setAgentsForHost("host-1", [agent]);

      aggregator.updateAgent("host-1", "a1", { status: "idle" });
      expect(aggregator.getMergedAgents()[0].projectName).toBe("my-project");
    });

    it("updateAgent on nonexistent agent is a no-op", () => {
      aggregator.updateAgent("host-1", "nonexistent", { status: "idle" });
      expect(aggregator.getMergedAgents()).toHaveLength(0);
    });
  });

  describe("sorting", () => {
    it("sorts by lastActivity descending (default)", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", lastActivityAt: "2026-02-22T10:00:00Z" }),
        createAgent({ id: "a2", hostId: "host-1", lastActivityAt: "2026-02-22T14:00:00Z" }),
        createAgent({ id: "a3", hostId: "host-1", lastActivityAt: "2026-02-22T12:00:00Z" }),
      ]);

      const sorted = aggregator.getSorted("lastActivity", "desc");
      expect(sorted[0].id).toBe("a2");
      expect(sorted[1].id).toBe("a3");
      expect(sorted[2].id).toBe("a1");
    });

    it("sorts by lastActivity ascending", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", lastActivityAt: "2026-02-22T14:00:00Z" }),
        createAgent({ id: "a2", hostId: "host-1", lastActivityAt: "2026-02-22T10:00:00Z" }),
      ]);

      const sorted = aggregator.getSorted("lastActivity", "asc");
      expect(sorted[0].id).toBe("a2");
      expect(sorted[1].id).toBe("a1");
    });

    it("sorts by machine name", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", hostName: "Z Machine" }),
      ]);
      aggregator.setAgentsForHost("host-2", [
        createAgent({ id: "a2", hostId: "host-2", hostName: "A Machine" }),
      ]);

      const sorted = aggregator.getSorted("machine", "asc");
      expect(sorted[0].hostName).toBe("A Machine");
      expect(sorted[1].hostName).toBe("Z Machine");
    });

    it("sorts by status priority", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", status: "idle" }),
        createAgent({ id: "a2", hostId: "host-1", status: "waiting_permission" }),
        createAgent({ id: "a3", hostId: "host-1", status: "running" }),
        createAgent({ id: "a4", hostId: "host-1", status: "error" }),
      ]);

      const sorted = aggregator.getSorted("status", "asc");
      // Priority: waiting_permission, error, running, idle, ...
      expect(sorted[0].status).toBe("waiting_permission");
      expect(sorted[1].status).toBe("error");
      expect(sorted[2].status).toBe("running");
    });

    it("sorts by project name alphabetically", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", projectName: "zebra" }),
        createAgent({ id: "a2", hostId: "host-1", projectName: "alpha" }),
        createAgent({ id: "a3", hostId: "host-1", projectName: "middle" }),
      ]);

      const sorted = aggregator.getSorted("project", "asc");
      expect(sorted[0].projectName).toBe("alpha");
      expect(sorted[1].projectName).toBe("middle");
      expect(sorted[2].projectName).toBe("zebra");
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({
          id: "a1",
          hostId: "host-1",
          provider: "claude-code",
          status: "running",
        }),
        createAgent({
          id: "a2",
          hostId: "host-1",
          provider: "opencode",
          status: "idle",
        }),
      ]);
      aggregator.setAgentsForHost("host-2", [
        createAgent({
          id: "a3",
          hostId: "host-2",
          provider: "claude-code",
          status: "error",
        }),
      ]);
    });

    it("filters by machineId", () => {
      const filter: AgentListFilter = {
        machineId: "host-1",
        provider: null,
        status: null,
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((a) => a.hostId === "host-1")).toBe(true);
    });

    it("filters by provider", () => {
      const filter: AgentListFilter = {
        machineId: null,
        provider: "claude-code",
        status: null,
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((a) => a.provider === "claude-code")).toBe(true);
    });

    it("filters by status", () => {
      const filter: AgentListFilter = {
        machineId: null,
        provider: null,
        status: "running",
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe("running");
    });

    it("combines multiple filters", () => {
      const filter: AgentListFilter = {
        machineId: "host-1",
        provider: "claude-code",
        status: "running",
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("a1");
    });

    it("null filters return all agents", () => {
      const filter: AgentListFilter = {
        machineId: null,
        provider: null,
        status: null,
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(3);
    });

    it("filter with no matches returns empty array", () => {
      const filter: AgentListFilter = {
        machineId: "nonexistent",
        provider: null,
        status: null,
      };
      const filtered = aggregator.getFiltered(filter);
      expect(filtered).toHaveLength(0);
    });
  });

  describe("badge computation", () => {
    it("counts agents needing attention (permissions + errors)", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", pendingPermissions: 2 }),
        createAgent({ id: "a2", hostId: "host-1", status: "error", pendingPermissions: 0 }),
        createAgent({ id: "a3", hostId: "host-1", pendingPermissions: 0, status: "running" }),
      ]);

      expect(aggregator.getAttentionCount()).toBe(2);
    });

    it("returns 0 when no agents need attention", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", status: "running", pendingPermissions: 0 }),
      ]);
      expect(aggregator.getAttentionCount()).toBe(0);
    });

    it("returns 0 for empty agent list", () => {
      expect(aggregator.getAttentionCount()).toBe(0);
    });

    it("getTotalPendingPermissions sums all pending permissions", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", pendingPermissions: 2 }),
        createAgent({ id: "a2", pendingPermissions: 3 }),
      ]);
      expect(aggregator.getTotalPendingPermissions()).toBe(5);
    });
  });

  describe("disconnected host handling", () => {
    it("markHostDisconnected sets all agents to disconnected", () => {
      aggregator.setAgentsForHost("host-1", [
        createAgent({ id: "a1", hostId: "host-1", status: "running" }),
        createAgent({ id: "a2", hostId: "host-1", status: "idle" }),
      ]);

      aggregator.markHostDisconnected("host-1");
      const agents = aggregator.getMergedAgents();
      expect(agents.every((a) => a.status === "disconnected")).toBe(true);
    });

    it("markHostDisconnected on empty host is a no-op", () => {
      aggregator.markHostDisconnected("nonexistent");
      expect(aggregator.getMergedAgents()).toHaveLength(0);
    });
  });
});
