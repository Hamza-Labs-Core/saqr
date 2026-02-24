/**
 * Tests for the Daemon Client.
 *
 * The DaemonClient connects to the locally running daemon via HTTP/WS.
 * Tests use mock fetch to simulate daemon responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DaemonClient,
  DaemonConnectionError,
  DaemonTimeoutError,
} from "../daemon-client.js";
import type { DaemonStatus, AgentInfo } from "../ipc-types.js";

describe("DaemonClient", () => {
  let client: DaemonClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new DaemonClient({
      baseUrl: "http://localhost:7399",
      timeoutMs: 3000,
      fetch: mockFetch,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use default base URL if not provided", () => {
      const defaultClient = new DaemonClient({ fetch: mockFetch });
      expect(defaultClient.baseUrl).toBe("http://localhost:7399");
    });

    it("should use custom base URL", () => {
      const customClient = new DaemonClient({
        baseUrl: "http://localhost:9999",
        fetch: mockFetch,
      });
      expect(customClient.baseUrl).toBe("http://localhost:9999");
    });

    it("should use default timeout of 3000ms", () => {
      const defaultClient = new DaemonClient({ fetch: mockFetch });
      expect(defaultClient.timeoutMs).toBe(3000);
    });

    it("should accept custom timeout", () => {
      const customClient = new DaemonClient({
        timeoutMs: 5000,
        fetch: mockFetch,
      });
      expect(customClient.timeoutMs).toBe(5000);
    });

    it("should use AGENTCTX_DAEMON_URL env var when available", () => {
      const envClient = new DaemonClient({
        envBaseUrl: "http://localhost:8888",
        fetch: mockFetch,
      });
      expect(envClient.baseUrl).toBe("http://localhost:8888");
    });
  });

  describe("healthCheck", () => {
    it("should return daemon status when daemon is running", async () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12345,
        uptime_secs: 3600,
        active_agents: 2,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(status),
      });

      const result = await client.healthCheck();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:7399/api/health",
        expect.objectContaining({
          method: "GET",
          signal: expect.any(AbortSignal),
        })
      );
      expect(result).toEqual(status);
    });

    it("should throw DaemonConnectionError when daemon is unreachable", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));

      await expect(client.healthCheck()).rejects.toThrow(DaemonConnectionError);
    });

    it("should throw DaemonConnectionError on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(client.healthCheck()).rejects.toThrow(DaemonConnectionError);
    });

    it("should throw DaemonTimeoutError when request times out", async () => {
      mockFetch.mockImplementation(() => {
        return new Promise((_, reject) => {
          const error = new DOMException("The operation was aborted", "AbortError");
          reject(error);
        });
      });

      await expect(client.healthCheck()).rejects.toThrow(DaemonTimeoutError);
    });
  });

  describe("getAgents", () => {
    it("should return list of agents", async () => {
      const agents: AgentInfo[] = [
        {
          id: "abc123",
          name: "feature-auth",
          model: "claude-4",
          status: "running",
          project: "/home/user/project",
        },
        {
          id: "def456",
          name: "test-suite",
          model: "claude-4",
          status: "idle",
          project: "/home/user/project2",
        },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(agents),
      });

      const result = await client.getAgents();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:7399/api/agents",
        expect.objectContaining({ method: "GET" })
      );
      expect(result).toEqual(agents);
      expect(result).toHaveLength(2);
    });

    it("should return empty array when no agents running", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await client.getAgents();
      expect(result).toEqual([]);
    });

    it("should throw when daemon is unreachable", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));

      await expect(client.getAgents()).rejects.toThrow(DaemonConnectionError);
    });
  });

  describe("respondToPermission", () => {
    it("should post approval to daemon", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await client.respondToPermission("req-123", true);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:7399/api/permissions/req-123",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ approved: true }),
        })
      );
    });

    it("should post denial to daemon", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await client.respondToPermission("req-456", false);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:7399/api/permissions/req-456",
        expect.objectContaining({
          body: JSON.stringify({ approved: false }),
        })
      );
    });

    it("should throw on failed permission response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(
        client.respondToPermission("req-invalid", true)
      ).rejects.toThrow(DaemonConnectionError);
    });
  });

  describe("restartAgent", () => {
    it("should post restart to daemon", async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await client.restartAgent("agent-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:7399/api/agents/agent-123/restart",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should throw when agent not found", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(client.restartAgent("nonexistent")).rejects.toThrow(
        DaemonConnectionError
      );
    });
  });
});
