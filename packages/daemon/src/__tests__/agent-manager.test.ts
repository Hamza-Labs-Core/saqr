/**
 * Tests for AgentManager - core agent process orchestration.
 *
 * Uses mock providers to test:
 *   - Provider registration (register, list, duplicate rejection)
 *   - Session creation with provider delegation
 *   - Session listing and retrieval
 *   - Session termination and interrupt
 *   - State change events across all agents
 *   - Max concurrent agents enforcement
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentManager } from "../agents/agent-manager.js";
import type {
  AgentProvider,
  ProviderInfo,
  ModelInfo,
  CreateSessionOptions,
  ManagedSession,
} from "../agents/agent-manager.js";
import {
  ProviderNotRegisteredError,
  AgentNotFoundError,
  MaxAgentsReachedError,
} from "../agents/errors.js";
import { EventBus } from "../event-bus/event-bus.js";
import type { StateChangeEvent } from "../agents/state-machine.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

function createMockProvider(
  id = "mock-provider",
  overrides: Partial<AgentProvider> = {},
): AgentProvider {
  return {
    providerId: id,
    getInfo: vi.fn().mockResolvedValue({
      id,
      name: `Mock ${id}`,
      version: "1.0.0",
      installed: true,
      capabilities: {
        streaming: true,
        resume: false,
        interruption: true,
        permissions: false,
        modelSelection: true,
        worktree: true,
      },
    } satisfies ProviderInfo),
    listModels: vi.fn().mockResolvedValue([
      { id: "mock-model-1", name: "Mock Model 1", providerId: id },
    ] satisfies ModelInfo[]),
    healthCheck: vi
      .fn()
      .mockResolvedValue({ healthy: true, message: "OK" }),
    createSession: vi.fn().mockImplementation(
      (options: CreateSessionOptions): Promise<ManagedSession> => {
        return Promise.resolve({
          sessionId: randomUUID(),
          providerId: id,
          state: "initializing" as const,
          createdAt: new Date(),
          workingDirectory: options.workingDirectory,
          model: options.model ?? "mock-model-1",
        });
      },
    ),
    resumeSession: vi
      .fn()
      .mockRejectedValue(new Error("resume not supported")),
    ...overrides,
  };
}

describe("AgentManager", () => {
  let eventBus: EventBus;
  let manager: AgentManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new AgentManager(eventBus);
  });

  // -----------------------------------------------------------------------
  // Provider Registry
  // -----------------------------------------------------------------------

  describe("provider registration", () => {
    it("registers a provider and retrieves it by ID", () => {
      const provider = createMockProvider("claude-code");
      manager.registerProvider(provider);
      expect(manager.getProvider("claude-code")).toBe(provider);
    });

    it("throws on duplicate provider registration", () => {
      const p1 = createMockProvider("claude-code");
      const p2 = createMockProvider("claude-code");
      manager.registerProvider(p1);
      expect(() => manager.registerProvider(p2)).toThrow(
        /already registered/,
      );
    });

    it("returns undefined for unregistered provider", () => {
      expect(manager.getProvider("nonexistent")).toBeUndefined();
    });

    it("lists all registered providers with info", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      manager.registerProvider(createMockProvider("opencode"));
      manager.registerProvider(createMockProvider("codex"));

      const providers = await manager.listProviders();
      expect(providers).toHaveLength(3);
      expect(providers.map((p) => p.id)).toEqual(
        expect.arrayContaining(["claude-code", "opencode", "codex"]),
      );
    });

    it("returns empty array when no providers registered", async () => {
      const providers = await manager.listProviders();
      expect(providers).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Session Creation
  // -----------------------------------------------------------------------

  describe("session creation", () => {
    it("creates a session via registered provider", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      const session = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/test",
      });
      expect(session.sessionId).toBeTruthy();
      expect(session.providerId).toBe("claude-code");
      expect(session.state).toBe("idle"); // Transitioned from initializing
      expect(session.workingDirectory).toBe("/tmp/test");
    });

    it("throws ProviderNotRegisteredError for unknown provider", async () => {
      await expect(
        manager.createSession({
          providerId: "nonexistent",
          workingDirectory: "/tmp",
        }),
      ).rejects.toThrow(ProviderNotRegisteredError);
    });

    it("passes options to provider.createSession", async () => {
      const provider = createMockProvider("claude-code");
      manager.registerProvider(provider);

      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/project",
        model: "claude-opus-4-6",
        systemPrompt: "Be helpful",
        maxTurns: 10,
      });

      expect(provider.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "claude-code",
          workingDirectory: "/project",
          model: "claude-opus-4-6",
          systemPrompt: "Be helpful",
          maxTurns: 10,
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Session Listing & Retrieval
  // -----------------------------------------------------------------------

  describe("session management", () => {
    it("retrieves a created session by ID", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      const session = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });
      const retrieved = manager.getSession(session.sessionId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe(session.sessionId);
    });

    it("returns undefined for nonexistent session ID", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });

    it("lists all active sessions", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/1",
      });
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/2",
      });
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/3",
      });

      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("lists empty when no sessions exist", () => {
      expect(manager.listSessions()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Session Termination
  // -----------------------------------------------------------------------

  describe("session termination", () => {
    it("terminates a session and removes it from active list", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      const session = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });

      await manager.terminateSession(session.sessionId);
      expect(manager.getSession(session.sessionId)).toBeUndefined();
      expect(manager.listSessions()).toHaveLength(0);
    });

    it("throws AgentNotFoundError when terminating nonexistent session", async () => {
      await expect(
        manager.terminateSession("nonexistent"),
      ).rejects.toThrow(AgentNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // Session Interrupt
  // -----------------------------------------------------------------------

  describe("session interrupt", () => {
    it("interrupts a running session", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      const session = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });

      // Set to running first
      const sm = manager.getStateMachine(session.sessionId);
      expect(sm).toBeDefined();
      sm!.transition("running", "processing prompt");

      await manager.interruptSession(session.sessionId);
      expect(sm!.state).toBe("idle");
    });

    it("throws AgentNotFoundError when interrupting nonexistent session", async () => {
      await expect(
        manager.interruptSession("nonexistent"),
      ).rejects.toThrow(AgentNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // State Change Events
  // -----------------------------------------------------------------------

  describe("state change events", () => {
    it("emits state change events via onStateChange callback", async () => {
      const events: StateChangeEvent[] = [];
      manager.onStateChange((e) => events.push(e));

      manager.registerProvider(createMockProvider("claude-code"));
      const session = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });

      // The createSession transitions initializing -> idle
      expect(events).toHaveLength(1);
      expect(events[0].currentState).toBe("idle");
      expect(events[0].sessionId).toBe(session.sessionId);
    });

    it("emits to EventBus on state change", async () => {
      const busEvents: Array<Record<string, unknown>> = [];
      eventBus.subscribe(null, (event) => busEvents.push(event as unknown as Record<string, unknown>));

      manager.registerProvider(createMockProvider("claude-code"));
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });

      // Should have published AgentStateChanged event
      expect(busEvents.length).toBeGreaterThanOrEqual(1);
      expect(busEvents[0].event_type).toBe("AgentStateChanged");
    });

    it("unsubscribe stops receiving events", async () => {
      const events: StateChangeEvent[] = [];
      const unsub = manager.onStateChange((e) => events.push(e));

      manager.registerProvider(createMockProvider("claude-code"));
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });
      expect(events).toHaveLength(1);

      unsub();
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/2",
      });
      // Still 1 because we unsubscribed
      expect(events).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Max Concurrent Agents
  // -----------------------------------------------------------------------

  describe("max concurrent agents", () => {
    it("enforces maxConcurrentAgents limit", async () => {
      const limitedManager = new AgentManager(eventBus, {
        maxConcurrentAgents: 2,
      });
      limitedManager.registerProvider(createMockProvider("claude-code"));

      await limitedManager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/1",
      });
      await limitedManager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/2",
      });

      await expect(
        limitedManager.createSession({
          providerId: "claude-code",
          workingDirectory: "/tmp/3",
        }),
      ).rejects.toThrow(MaxAgentsReachedError);
    });

    it("allows creation after terminating a session", async () => {
      const limitedManager = new AgentManager(eventBus, {
        maxConcurrentAgents: 1,
      });
      limitedManager.registerProvider(createMockProvider("claude-code"));

      const s1 = await limitedManager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/1",
      });

      await limitedManager.terminateSession(s1.sessionId);

      // Should succeed now
      const s2 = await limitedManager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/2",
      });
      expect(s2.sessionId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // shutdownAll
  // -----------------------------------------------------------------------

  describe("shutdownAll", () => {
    it("terminates all active sessions", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/1",
      });
      await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp/2",
      });

      expect(manager.listSessions()).toHaveLength(2);
      await manager.shutdownAll();
      expect(manager.listSessions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple providers
  // -----------------------------------------------------------------------

  describe("multiple providers", () => {
    it("creates sessions with different providers", async () => {
      manager.registerProvider(createMockProvider("claude-code"));
      manager.registerProvider(createMockProvider("opencode"));

      const s1 = await manager.createSession({
        providerId: "claude-code",
        workingDirectory: "/tmp",
      });
      const s2 = await manager.createSession({
        providerId: "opencode",
        workingDirectory: "/tmp",
      });

      expect(s1.providerId).toBe("claude-code");
      expect(s2.providerId).toBe("opencode");
      expect(manager.listSessions()).toHaveLength(2);
    });
  });
});
