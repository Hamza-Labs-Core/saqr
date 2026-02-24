/**
 * Tests for the HookManager — manages hook integrations with coding agents.
 *
 * Covers: register/unregister integrations, install hooks, doctor checks,
 * start/stop lifecycle, event routing to EventBus.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookManager, type HookIntegration, type AgentProvider } from "../hooks/hook-manager.js";
import { EventBus, type EventEnvelope } from "../event-bus/event-bus.js";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: crypto.randomUUID(),
    event_type: "ToolCallCompleted",
    project_id: "my-project-a3f7b2",
    session_id: "session-001",
    sequence: 1,
    timestamp: new Date().toISOString(),
    agent_provider: "claude-code",
    agent_native_event: "PostToolUse",
    agent_metadata: {},
    data: { tool_name: "Write" },
    ...overrides,
  };
}

/**
 * Create a mock HookIntegration for testing.
 */
function createMockIntegration(
  providerId: AgentProvider = "claude-code",
  name = "Mock Integration",
): HookIntegration & {
  mockCaptureCallback: ((event: EventEnvelope) => void) | null;
  emitEvent: (event: EventEnvelope) => void;
} {
  let mockCaptureCallback: ((event: EventEnvelope) => void) | null = null;

  return {
    providerId,
    name,
    get mockCaptureCallback() {
      return mockCaptureCallback;
    },
    emitEvent(event: EventEnvelope) {
      if (mockCaptureCallback) {
        mockCaptureCallback(event);
      }
    },
    install: vi.fn().mockResolvedValue({
      success: true,
      message: "Installed",
      modifiedFiles: ["/mock/settings.json"],
    }),
    uninstall: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      checks: [
        { name: "Test check", passed: true, detail: "All good" },
      ],
    }),
    reload: vi.fn().mockResolvedValue(undefined),
    isAgentInstalled: vi.fn().mockResolvedValue(true),
    startCapture: vi.fn().mockImplementation(async (callback) => {
      mockCaptureCallback = callback;
    }),
    stopCapture: vi.fn().mockImplementation(async () => {
      mockCaptureCallback = null;
    }),
  };
}

describe("HookManager", () => {
  let eventBus: EventBus;
  let manager: HookManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new HookManager(eventBus);
  });

  // -------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------

  describe("registerIntegration", () => {
    it("registers an integration successfully", () => {
      const integration = createMockIntegration("claude-code");
      manager.registerIntegration(integration);

      expect(manager.getIntegration("claude-code")).toBe(integration);
    });

    it("throws when registering a duplicate provider", () => {
      const int1 = createMockIntegration("claude-code");
      const int2 = createMockIntegration("claude-code");

      manager.registerIntegration(int1);
      expect(() => manager.registerIntegration(int2)).toThrow(
        'Hook integration "claude-code" is already registered',
      );
    });

    it("registers multiple different integrations", () => {
      manager.registerIntegration(createMockIntegration("claude-code"));
      manager.registerIntegration(createMockIntegration("opencode"));
      manager.registerIntegration(createMockIntegration("codex"));

      expect(manager.listIntegrations()).toEqual(["claude-code", "opencode", "codex"]);
    });
  });

  describe("unregisterIntegration", () => {
    it("removes a registered integration", () => {
      manager.registerIntegration(createMockIntegration("claude-code"));
      manager.unregisterIntegration("claude-code");

      expect(manager.getIntegration("claude-code")).toBeUndefined();
      expect(manager.listIntegrations()).toEqual([]);
    });

    it("throws when unregistering a non-existent provider", () => {
      expect(() => manager.unregisterIntegration("codex")).toThrow(
        'Hook integration "codex" is not registered',
      );
    });

    it("throws when unregistering during capture", async () => {
      const integration = createMockIntegration("claude-code");
      manager.registerIntegration(integration);
      await manager.startAll();

      expect(() => manager.unregisterIntegration("claude-code")).toThrow(
        "Cannot unregister",
      );

      await manager.stopAll();
    });
  });

  describe("getIntegration", () => {
    it("returns undefined for unregistered provider", () => {
      expect(manager.getIntegration("opencode")).toBeUndefined();
    });
  });

  describe("listIntegrations", () => {
    it("returns empty array when no integrations registered", () => {
      expect(manager.listIntegrations()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------

  describe("install", () => {
    it("delegates to the integration's install method", async () => {
      const integration = createMockIntegration("claude-code");
      manager.registerIntegration(integration);

      const result = await manager.install("claude-code", { force: true });

      expect(integration.install).toHaveBeenCalledWith({ force: true });
      expect(result.success).toBe(true);
    });

    it("throws when installing for an unregistered provider", async () => {
      await expect(manager.install("opencode")).rejects.toThrow(
        'Hook integration "opencode" is not registered',
      );
    });
  });

  // -------------------------------------------------------------------
  // Doctor / Health Checks
  // -------------------------------------------------------------------

  describe("doctor", () => {
    it("runs health checks for all registered integrations", async () => {
      const ccIntegration = createMockIntegration("claude-code");
      const ocIntegration = createMockIntegration("opencode");
      manager.registerIntegration(ccIntegration);
      manager.registerIntegration(ocIntegration);

      const results = await manager.doctor();

      expect(results.size).toBe(2);
      expect(results.get("claude-code")?.healthy).toBe(true);
      expect(results.get("opencode")?.healthy).toBe(true);
      expect(ccIntegration.healthCheck).toHaveBeenCalled();
      expect(ocIntegration.healthCheck).toHaveBeenCalled();
    });

    it("returns empty map when no integrations registered", async () => {
      const results = await manager.doctor();
      expect(results.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Start / Stop Lifecycle
  // -------------------------------------------------------------------

  describe("startAll", () => {
    it("starts capture on all registered integrations", async () => {
      const int1 = createMockIntegration("claude-code");
      const int2 = createMockIntegration("opencode");
      manager.registerIntegration(int1);
      manager.registerIntegration(int2);

      await manager.startAll();

      expect(int1.startCapture).toHaveBeenCalled();
      expect(int2.startCapture).toHaveBeenCalled();
      expect(manager.isCapturing()).toBe(true);
    });

    it("throws when already capturing", async () => {
      manager.registerIntegration(createMockIntegration("claude-code"));
      await manager.startAll();

      await expect(manager.startAll()).rejects.toThrow("Already capturing events");

      await manager.stopAll();
    });

    it("routes events from integrations to EventBus", async () => {
      const integration = createMockIntegration("claude-code");
      manager.registerIntegration(integration);

      const received: EventEnvelope[] = [];
      eventBus.subscribe(null, (event) => received.push(event));

      await manager.startAll();

      const event = makeEvent();
      integration.emitEvent(event);

      expect(received).toHaveLength(1);
      expect(received[0].event_id).toBe(event.event_id);

      await manager.stopAll();
    });

    it("continues starting other integrations if one fails", async () => {
      const failingInt = createMockIntegration("claude-code");
      (failingInt.startCapture as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("fail"),
      );
      const workingInt = createMockIntegration("opencode");
      manager.registerIntegration(failingInt);
      manager.registerIntegration(workingInt);

      await manager.startAll();

      expect(workingInt.startCapture).toHaveBeenCalled();
      expect(manager.isCapturing()).toBe(true);

      await manager.stopAll();
    });
  });

  describe("stopAll", () => {
    it("stops capture on all integrations", async () => {
      const int1 = createMockIntegration("claude-code");
      const int2 = createMockIntegration("opencode");
      manager.registerIntegration(int1);
      manager.registerIntegration(int2);

      await manager.startAll();
      await manager.stopAll();

      expect(int1.stopCapture).toHaveBeenCalled();
      expect(int2.stopCapture).toHaveBeenCalled();
      expect(manager.isCapturing()).toBe(false);
    });

    it("is a no-op when not capturing", async () => {
      await expect(manager.stopAll()).resolves.not.toThrow();
    });

    it("continues stopping other integrations if one fails", async () => {
      const failingInt = createMockIntegration("claude-code");
      (failingInt.stopCapture as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("fail"),
      );
      const workingInt = createMockIntegration("opencode");
      manager.registerIntegration(failingInt);
      manager.registerIntegration(workingInt);

      await manager.startAll();
      await manager.stopAll();

      expect(workingInt.stopCapture).toHaveBeenCalled();
      expect(manager.isCapturing()).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------

  describe("reload", () => {
    it("delegates to integration's reload method", async () => {
      const integration = createMockIntegration("claude-code");
      manager.registerIntegration(integration);

      await manager.reload("claude-code");

      expect(integration.reload).toHaveBeenCalled();
    });

    it("throws for unregistered provider", async () => {
      await expect(manager.reload("opencode")).rejects.toThrow(
        'Hook integration "opencode" is not registered',
      );
    });
  });

  // -------------------------------------------------------------------
  // isCapturing
  // -------------------------------------------------------------------

  describe("isCapturing", () => {
    it("returns false initially", () => {
      expect(manager.isCapturing()).toBe(false);
    });

    it("returns true after startAll", async () => {
      manager.registerIntegration(createMockIntegration("claude-code"));
      await manager.startAll();
      expect(manager.isCapturing()).toBe(true);
      await manager.stopAll();
    });
  });
});
