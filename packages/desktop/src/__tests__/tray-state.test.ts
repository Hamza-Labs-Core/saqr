/**
 * Tests for Tray State Manager.
 *
 * Tray menu state computation: daemon status, agent counts,
 * quick actions, icon state selection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  TrayStateManager,
  computeTrayState,
  formatTooltip,
  buildTrayMenuItems,
  type TrayMenuItem,
} from "../tray-state.js";
import type { DaemonStatus, AgentInfo, TrayState } from "../ipc-types.js";

describe("TrayStateManager", () => {
  let manager: TrayStateManager;

  beforeEach(() => {
    manager = new TrayStateManager();
  });

  describe("initial state", () => {
    it("should start with error state (daemon not connected)", () => {
      expect(manager.currentState).toBe("error");
    });

    it("should have no agents initially", () => {
      expect(manager.agents).toEqual([]);
    });

    it("should not have a pending update", () => {
      expect(manager.hasUpdate).toBe(false);
    });
  });

  describe("updateDaemonStatus", () => {
    it("should set running state when daemon has active agents", () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12345,
        uptime_secs: 3600,
        active_agents: 3,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };

      manager.updateDaemonStatus(status);

      expect(manager.currentState).toBe("running");
    });

    it("should set idle state when daemon running with no agents", () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12345,
        uptime_secs: 3600,
        active_agents: 0,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };

      manager.updateDaemonStatus(status);

      expect(manager.currentState).toBe("idle");
    });

    it("should set error state when daemon is not running", () => {
      const status: DaemonStatus = {
        running: false,
        pid: null,
        uptime_secs: null,
        active_agents: 0,
        version: null,
        http_port: 7399,
        ws_port: 7400,
      };

      manager.updateDaemonStatus(status);

      expect(manager.currentState).toBe("error");
    });
  });

  describe("updateAgents", () => {
    it("should store agent list", () => {
      const agents: AgentInfo[] = [
        { id: "1", name: "feature-auth", model: "claude-4", status: "running", project: "/p" },
        { id: "2", name: "test-suite", model: "claude-4", status: "running", project: "/p" },
      ];

      manager.updateAgents(agents);

      expect(manager.agents).toEqual(agents);
      expect(manager.agents).toHaveLength(2);
    });

    it("should set attention state when any agent needs permission", () => {
      // Must set daemon as running first
      manager.updateDaemonStatus({
        running: true, pid: 1, uptime_secs: 100, active_agents: 2,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      });

      const agents: AgentInfo[] = [
        { id: "1", name: "feature-auth", model: "claude-4", status: "running", project: "/p" },
        { id: "2", name: "waiting", model: "claude-4", status: "waiting_permission", project: "/p" },
      ];

      manager.updateAgents(agents);

      expect(manager.currentState).toBe("attention");
    });
  });

  describe("setUpdateAvailable", () => {
    it("should set updating state when update is available", () => {
      manager.updateDaemonStatus({
        running: true, pid: 1, uptime_secs: 100, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      });

      manager.setUpdateAvailable(true);

      expect(manager.hasUpdate).toBe(true);
      expect(manager.currentState).toBe("updating");
    });

    it("should revert to previous state when update cleared", () => {
      manager.updateDaemonStatus({
        running: true, pid: 1, uptime_secs: 100, active_agents: 2,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      });

      manager.setUpdateAvailable(true);
      expect(manager.currentState).toBe("updating");

      manager.setUpdateAvailable(false);
      expect(manager.currentState).toBe("running");
    });
  });

  describe("setDaemonOffline", () => {
    it("should set error state", () => {
      manager.updateDaemonStatus({
        running: true, pid: 1, uptime_secs: 100, active_agents: 2,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      });

      manager.setDaemonOffline();

      expect(manager.currentState).toBe("error");
    });
  });
});

describe("computeTrayState", () => {
  it("should return error when daemon not running", () => {
    const result = computeTrayState(false, 0, false, false);
    expect(result).toBe("error");
  });

  it("should return updating when update available", () => {
    const result = computeTrayState(true, 0, false, true);
    expect(result).toBe("updating");
  });

  it("should return attention when permission needed", () => {
    const result = computeTrayState(true, 3, true, false);
    expect(result).toBe("attention");
  });

  it("should return running when agents active", () => {
    const result = computeTrayState(true, 3, false, false);
    expect(result).toBe("running");
  });

  it("should return idle when daemon running with no agents", () => {
    const result = computeTrayState(true, 0, false, false);
    expect(result).toBe("idle");
  });

  it("should prioritize error over other states", () => {
    const result = computeTrayState(false, 3, true, true);
    expect(result).toBe("error");
  });

  it("should prioritize attention over updating", () => {
    const result = computeTrayState(true, 3, true, true);
    expect(result).toBe("attention");
  });
});

describe("formatTooltip", () => {
  it("should format idle tooltip", () => {
    const tooltip = formatTooltip("idle", []);
    expect(tooltip).toBe("AgentContext -- No active agents");
  });

  it("should format running tooltip with agent count", () => {
    const agents: AgentInfo[] = [
      { id: "1", name: "a", model: "claude-4", status: "running", project: "/p" },
      { id: "2", name: "b", model: "claude-4", status: "running", project: "/p" },
      { id: "3", name: "c", model: "claude-4", status: "running", project: "/p" },
    ];
    const tooltip = formatTooltip("running", agents);
    expect(tooltip).toBe("AgentContext -- 3 agents running");
  });

  it("should format single agent tooltip", () => {
    const agents: AgentInfo[] = [
      { id: "1", name: "a", model: "claude-4", status: "running", project: "/p" },
    ];
    const tooltip = formatTooltip("running", agents);
    expect(tooltip).toBe("AgentContext -- 1 agent running");
  });

  it("should format attention tooltip", () => {
    const tooltip = formatTooltip("attention", []);
    expect(tooltip).toBe("AgentContext -- Action required");
  });

  it("should format error tooltip", () => {
    const tooltip = formatTooltip("error", []);
    expect(tooltip).toBe("AgentContext -- Daemon disconnected");
  });

  it("should format updating tooltip", () => {
    const tooltip = formatTooltip("updating", []);
    expect(tooltip).toBe("AgentContext -- Updating...");
  });
});

describe("buildTrayMenuItems", () => {
  it("should include header with version", () => {
    const items = buildTrayMenuItems({
      state: "idle",
      agents: [],
      daemonStatus: {
        running: true, pid: 12345, uptime_secs: 3600, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const header = items.find((item) => item.id === "header");
    expect(header).toBeDefined();
    expect(header?.label).toContain("AgentContext v1.0.0");
    expect(header?.enabled).toBe(false);
  });

  it("should include daemon status line", () => {
    const items = buildTrayMenuItems({
      state: "running",
      agents: [],
      daemonStatus: {
        running: true, pid: 12345, uptime_secs: 3600, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const statusItem = items.find((item) => item.id === "daemon-status");
    expect(statusItem).toBeDefined();
    expect(statusItem?.label).toContain("Daemon: Running");
    expect(statusItem?.label).toContain("PID 12345");
  });

  it("should show 'Daemon: Stopped' when daemon not running", () => {
    const items = buildTrayMenuItems({
      state: "error",
      agents: [],
      daemonStatus: {
        running: false, pid: null, uptime_secs: null, active_agents: 0,
        version: null, http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const statusItem = items.find((item) => item.id === "daemon-status");
    expect(statusItem?.label).toContain("Daemon: Stopped");
  });

  it("should include agent count", () => {
    const items = buildTrayMenuItems({
      state: "running",
      agents: [
        { id: "1", name: "a", model: "claude-4", status: "running", project: "/p" },
        { id: "2", name: "b", model: "claude-4", status: "running", project: "/p" },
      ],
      daemonStatus: {
        running: true, pid: 12345, uptime_secs: 3600, active_agents: 2,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const agentCount = items.find((item) => item.id === "agent-count");
    expect(agentCount?.label).toBe("2 agents running");
  });

  it("should include Open Dashboard action", () => {
    const items = buildTrayMenuItems({
      state: "idle",
      agents: [],
      daemonStatus: {
        running: true, pid: 1, uptime_secs: 0, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const openDashboard = items.find((item) => item.id === "open-dashboard");
    expect(openDashboard).toBeDefined();
    expect(openDashboard?.label).toBe("Open Dashboard");
    expect(openDashboard?.enabled).toBe(true);
  });

  it("should include running agents submenu items", () => {
    const agents: AgentInfo[] = [
      { id: "abc", name: "feature-auth", model: "claude-4", status: "running", project: "/p" },
      { id: "def", name: "test-suite", model: "claude-4", status: "running", project: "/p" },
    ];

    const items = buildTrayMenuItems({
      state: "running",
      agents,
      daemonStatus: {
        running: true, pid: 1, uptime_secs: 0, active_agents: 2,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    // Filter for per-agent items (not "agent-count")
    const agentItems = items.filter(
      (item) => item.id.startsWith("agent-") && item.id !== "agent-count"
    );
    expect(agentItems).toHaveLength(2);
    expect(agentItems[0].label).toContain("feature-auth");
    expect(agentItems[0].label).toContain("claude-4");
    expect(agentItems[1].label).toContain("test-suite");
  });

  it("should show 'Start Daemon' when daemon stopped", () => {
    const items = buildTrayMenuItems({
      state: "error",
      agents: [],
      daemonStatus: {
        running: false, pid: null, uptime_secs: null, active_agents: 0,
        version: null, http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const startDaemon = items.find((item) => item.id === "start-daemon");
    expect(startDaemon).toBeDefined();
    const stopDaemon = items.find((item) => item.id === "stop-daemon");
    expect(stopDaemon).toBeUndefined();
  });

  it("should show 'Stop Daemon' when daemon running", () => {
    const items = buildTrayMenuItems({
      state: "idle",
      agents: [],
      daemonStatus: {
        running: true, pid: 1, uptime_secs: 0, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const stopDaemon = items.find((item) => item.id === "stop-daemon");
    expect(stopDaemon).toBeDefined();
    const startDaemon = items.find((item) => item.id === "start-daemon");
    expect(startDaemon).toBeUndefined();
  });

  it("should always include Quit and Quit All", () => {
    const items = buildTrayMenuItems({
      state: "idle",
      agents: [],
      daemonStatus: {
        running: true, pid: 1, uptime_secs: 0, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const quit = items.find((item) => item.id === "quit");
    const quitAll = items.find((item) => item.id === "quit-all");
    expect(quit).toBeDefined();
    expect(quit?.label).toBe("Quit AgentContext");
    expect(quitAll).toBeDefined();
    expect(quitAll?.label).toBe("Quit All");
  });

  it("should include Preferences and Check for Updates", () => {
    const items = buildTrayMenuItems({
      state: "idle",
      agents: [],
      daemonStatus: {
        running: true, pid: 1, uptime_secs: 0, active_agents: 0,
        version: "1.0.0", http_port: 7399, ws_port: 7400,
      },
      version: "1.0.0",
    });

    const prefs = items.find((item) => item.id === "preferences");
    const updates = items.find((item) => item.id === "check-updates");
    expect(prefs).toBeDefined();
    expect(prefs?.label).toBe("Preferences...");
    expect(updates).toBeDefined();
    expect(updates?.label).toBe("Check for Updates...");
  });
});
