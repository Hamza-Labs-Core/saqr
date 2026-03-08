/**
 * Tests for HttpServer — REST API, WebSocket, SSE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpServer, type HttpServerDeps } from "./http-server.js";
import { EventBus } from "../event-bus/event-bus.js";
import { getDefaultConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockSessionManager() {
  const sessions = new Map<string, any>();
  return {
    registerSession: vi.fn((s: any) => sessions.set(s.sessionId, s)),
    getSession: vi.fn((id: string) => sessions.get(id)),
    updateSession: vi.fn(),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    getActiveSessions: vi.fn(() => Array.from(sessions.values()).filter((s: any) => s.status === "active")),
    completeSession: vi.fn(),
  };
}

function createMockAgentManager() {
  return {
    listProviders: vi.fn(async () => [
      {
        id: "claude-code",
        name: "Claude Code",
        version: "1.0.0",
        installed: true,
        capabilities: {
          streaming: true,
          resume: true,
          interruption: true,
          permissions: true,
          modelSelection: true,
          worktree: true,
        },
      },
    ]),
    registerProvider: vi.fn(),
    getProvider: vi.fn(),
  };
}

function createMockEventStore() {
  return {
    queryEvents: vi.fn(async () => [
      {
        event_id: "evt-1",
        event_type: "user_prompt_received",
        project_id: "proj-1",
        session_id: "sess-1",
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        agent_provider: "claude-code",
        agent_native_event: "user_prompt",
        agent_metadata: {},
        data: { text: "Hello" },
      },
    ]),
    getSessionDir: vi.fn(),
    loadEvent: vi.fn(),
  };
}

function createTestDeps(portOverride?: number): HttpServerDeps {
  const config = getDefaultConfig();
  config.server.port = portOverride ?? 0; // port 0 = auto-assign
  config.server.host = "127.0.0.1";

  return {
    config,
    eventBus: new EventBus(),
    agentManager: createMockAgentManager() as any,
    sessionManager: createMockSessionManager() as any,
    eventStore: createMockEventStore() as any,
  };
}

async function fetchFromServer(server: HttpServer, path: string, init?: RequestInit): Promise<Response> {
  const port = server.getPort();
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpServer", () => {
  let server: HttpServer;
  let deps: HttpServerDeps;

  beforeEach(async () => {
    deps = createTestDeps();
    server = new HttpServer(deps);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("lifecycle", () => {
    it("starts and reports running", () => {
      expect(server.isRunning()).toBe(true);
      expect(server.getPort()).toBeGreaterThan(0);
    });

    it("stops cleanly", async () => {
      await server.stop();
      expect(server.isRunning()).toBe(false);
      expect(server.getPort()).toBe(null);
    });

    it("throws on double start", async () => {
      await expect(server.start()).rejects.toThrow("already running");
    });

    it("reports zero active connections initially", () => {
      expect(server.getActiveConnections()).toBe(0);
    });
  });

  describe("GET /api/health", () => {
    it("returns health status", async () => {
      const res = await fetchFromServer(server, "/api/health");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.1.0");
      expect(typeof body.uptime).toBe("number");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns empty session list", async () => {
      const res = await fetchFromServer(server, "/api/sessions");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.sessions).toEqual([]);
    });

    it("returns registered sessions", async () => {
      const sm = deps.sessionManager as any;
      sm.registerSession({
        sessionId: "sess-1",
        projectId: "proj-1",
        agentProvider: "claude-code",
        model: "claude-4",
        workingDirectory: "/tmp",
        startedAt: new Date("2026-01-01"),
        endedAt: null,
        status: "active",
        eventCount: 5,
        chainedFrom: null,
      });

      const res = await fetchFromServer(server, "/api/sessions");
      const body = await res.json() as any;
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("sess-1");
      expect(body.sessions[0].status).toBe("active");
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns 404 for unknown session", async () => {
      const res = await fetchFromServer(server, "/api/sessions/unknown");
      expect(res.status).toBe(404);
    });

    it("returns session details", async () => {
      const sm = deps.sessionManager as any;
      sm.registerSession({
        sessionId: "sess-2",
        projectId: "proj-1",
        agentProvider: "claude-code",
        model: "claude-4",
        workingDirectory: "/home/user/project",
        startedAt: new Date("2026-01-01"),
        endedAt: null,
        status: "active",
        eventCount: 10,
        chainedFrom: null,
      });

      const res = await fetchFromServer(server, "/api/sessions/sess-2");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.sessionId).toBe("sess-2");
      expect(body.workingDirectory).toBe("/home/user/project");
    });
  });

  describe("GET /api/sessions/:id/timeline", () => {
    it("returns timeline events", async () => {
      const sm = deps.sessionManager as any;
      sm.registerSession({
        sessionId: "sess-1",
        projectId: "proj-1",
        agentProvider: "claude-code",
        model: "claude-4",
        workingDirectory: "/tmp",
        startedAt: new Date(),
        endedAt: null,
        status: "active",
        eventCount: 1,
        chainedFrom: null,
      });

      const res = await fetchFromServer(server, "/api/sessions/sess-1/timeline");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.timeline).toHaveLength(1);
      expect(body.timeline[0].eventId).toBe("evt-1");
    });
  });

  describe("POST /api/sessions/:id/input", () => {
    it("sends input to a session", async () => {
      const sm = deps.sessionManager as any;
      sm.registerSession({
        sessionId: "sess-1",
        projectId: "proj-1",
        agentProvider: "claude-code",
        model: "claude-4",
        workingDirectory: "/tmp",
        startedAt: new Date(),
        endedAt: null,
        status: "active",
        eventCount: 0,
        chainedFrom: null,
      });

      const publishSpy = vi.spyOn(deps.eventBus, "publish");

      const res = await fetchFromServer(server, "/api/sessions/sess-1/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world" }),
      });

      expect(res.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledOnce();
      expect(publishSpy.mock.calls[0][0].data.text).toBe("hello world");
    });

    it("rejects missing text field", async () => {
      const sm = deps.sessionManager as any;
      sm.registerSession({
        sessionId: "sess-1",
        projectId: "proj-1",
        agentProvider: "claude-code",
        model: "claude-4",
        workingDirectory: "/tmp",
        startedAt: new Date(),
        endedAt: null,
        status: "active",
        eventCount: 0,
        chainedFrom: null,
      });

      const res = await fetchFromServer(server, "/api/sessions/sess-1/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/agents", () => {
    it("returns agent providers", async () => {
      const res = await fetchFromServer(server, "/api/agents");
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe("claude-code");
    });
  });

  describe("POST /api/agents/:id/prompt", () => {
    it("sends prompt to an agent", async () => {
      const publishSpy = vi.spyOn(deps.eventBus, "publish");

      const res = await fetchFromServer(server, "/api/agents/agent-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "fix the bug" }),
      });

      expect(res.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledOnce();
    });

    it("rejects missing prompt", async () => {
      const res = await fetchFromServer(server, "/api/agents/agent-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetchFromServer(server, "/api/unknown");
      expect(res.status).toBe(404);
    });
  });

  describe("CORS", () => {
    it("handles OPTIONS preflight", async () => {
      const res = await fetchFromServer(server, "/api/health", { method: "OPTIONS" });
      expect(res.status).toBe(204);
    });
  });
});
