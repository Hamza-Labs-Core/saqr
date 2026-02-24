/**
 * Tests for ProcessCorrelator — matches session IDs to running agent PIDs.
 *
 * Uses mocked process discovery to avoid real /proc or ps dependencies.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProcessCorrelator,
  type ProcessInfo,
  type ProcessDiscovery,
} from "../sessions/process-correlator.js";

/**
 * Creates a mock process discovery implementation.
 */
function createMockDiscovery(processes: ProcessInfo[] = []): ProcessDiscovery {
  return {
    listAgentProcesses: vi.fn().mockResolvedValue(processes),
    isProcessRunning: vi.fn().mockImplementation(async (pid: number) => {
      return processes.some((p) => p.pid === pid);
    }),
  };
}

function makeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 1234,
    command: "claude",
    args: [],
    agentType: "claude-code",
    startTime: new Date(),
    ...overrides,
  };
}

describe("ProcessCorrelator", () => {
  let correlator: ProcessCorrelator;
  let mockDiscovery: ProcessDiscovery;

  beforeEach(() => {
    mockDiscovery = createMockDiscovery();
    correlator = new ProcessCorrelator(mockDiscovery);
  });

  describe("findProcessForSession", () => {
    it("should return null when no processes are running", async () => {
      const result = await correlator.findProcessForSession("sess-001");
      expect(result).toBeNull();
    });

    it("should find a process that matches the session ID in args", async () => {
      const proc = makeProcess({
        pid: 5678,
        command: "claude",
        args: ["--session-id", "sess-001", "--resume"],
        agentType: "claude-code",
      });
      mockDiscovery = createMockDiscovery([proc]);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.findProcessForSession("sess-001");
      expect(result).not.toBeNull();
      expect(result!.pid).toBe(5678);
    });

    it("should return null when session ID does not match any process", async () => {
      const proc = makeProcess({
        pid: 5678,
        args: ["--session-id", "sess-002"],
      });
      mockDiscovery = createMockDiscovery([proc]);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.findProcessForSession("sess-001");
      expect(result).toBeNull();
    });

    it("should match process by session ID in environment or cwd context", async () => {
      const proc = makeProcess({
        pid: 9999,
        command: "claude",
        args: [],
        agentType: "claude-code",
        sessionId: "sess-abc",
      });
      mockDiscovery = createMockDiscovery([proc]);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.findProcessForSession("sess-abc");
      expect(result).not.toBeNull();
      expect(result!.pid).toBe(9999);
    });
  });

  describe("isProcessRunning", () => {
    it("should return true for a running process", async () => {
      const proc = makeProcess({ pid: 1234 });
      mockDiscovery = createMockDiscovery([proc]);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.isProcessRunning(1234);
      expect(result).toBe(true);
    });

    it("should return false for a non-running process", async () => {
      mockDiscovery = createMockDiscovery([]);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.isProcessRunning(9999);
      expect(result).toBe(false);
    });
  });

  describe("listAgentProcesses", () => {
    it("should return all discovered agent processes", async () => {
      const procs = [
        makeProcess({ pid: 100, agentType: "claude-code" }),
        makeProcess({ pid: 200, agentType: "opencode" }),
        makeProcess({ pid: 300, agentType: "codex" }),
      ];
      mockDiscovery = createMockDiscovery(procs);
      correlator = new ProcessCorrelator(mockDiscovery);

      const result = await correlator.listAgentProcesses();
      expect(result).toHaveLength(3);
      expect(result.map((p) => p.agentType)).toEqual([
        "claude-code",
        "opencode",
        "codex",
      ]);
    });

    it("should return empty array when no agent processes", async () => {
      const result = await correlator.listAgentProcesses();
      expect(result).toEqual([]);
    });
  });

  describe("registerSessionProcess", () => {
    it("should manually associate a PID with a session ID", () => {
      correlator.registerSessionProcess("sess-manual", 4567);
      const mapping = correlator.getSessionProcess("sess-manual");
      expect(mapping).toBe(4567);
    });

    it("should overwrite previous mapping for the same session", () => {
      correlator.registerSessionProcess("sess-x", 100);
      correlator.registerSessionProcess("sess-x", 200);
      expect(correlator.getSessionProcess("sess-x")).toBe(200);
    });

    it("should return undefined for unregistered sessions", () => {
      expect(correlator.getSessionProcess("unknown")).toBeUndefined();
    });
  });

  describe("unregisterSessionProcess", () => {
    it("should remove a session-to-PID mapping", () => {
      correlator.registerSessionProcess("sess-del", 5555);
      correlator.unregisterSessionProcess("sess-del");
      expect(correlator.getSessionProcess("sess-del")).toBeUndefined();
    });

    it("should not throw when unregistering a non-existent session", () => {
      expect(() => correlator.unregisterSessionProcess("nope")).not.toThrow();
    });
  });
});
