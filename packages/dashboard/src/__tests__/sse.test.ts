/**
 * Tests for the SSE (Server-Sent Events) stream manager.
 *
 * Verifies:
 * - Client connection and setup
 * - SSE headers
 * - Broadcast to matching clients
 * - Client removal and cleanup
 * - Heartbeat mechanism
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSSEManager } from "../api/sse.js";
import type { SSEManager } from "../api/sse.js";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock HTTP request/response
// ---------------------------------------------------------------------------

class MockSocket {
  noDelay = false;
  setNoDelay(val: boolean) {
    this.noDelay = val;
  }
}

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  headersFlushed = false;
  ended = false;
  socket = new MockSocket();

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
  }

  flushHeaders() {
    this.headersFlushed = true;
  }

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }

  end() {
    this.ended = true;
  }

  getWritten(): string {
    return this.chunks.join("");
  }
}

class MockRequest extends EventEmitter {
  // Simulates an http.IncomingMessage
}

function createMockPair() {
  return {
    req: new MockRequest() as any,
    res: new MockResponse() as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    // Use a non-existent dir since we only test client management, not polling
    manager = createSSEManager("/tmp/nonexistent-events-dir-test", 60000, 60000);
  });

  afterEach(() => {
    manager.stopPolling();
  });

  describe("addClient", () => {
    it("sets correct SSE headers", () => {
      const { req, res } = createMockPair();
      manager.addClient(req, res, "proj-1", "sess-1", 0);

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("text/event-stream");
      expect(res.headers["Cache-Control"]).toBe("no-cache");
      expect(res.headers["Connection"]).toBe("keep-alive");
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    });

    it("sends initial keepalive comment", () => {
      const { req, res } = createMockPair();
      manager.addClient(req, res, "proj-1", "sess-1", 0);

      const written = res.getWritten();
      expect(written).toContain(":ok\n\n");
    });

    it("flushes headers", () => {
      const { req, res } = createMockPair();
      manager.addClient(req, res, "proj-1", "sess-1", 0);

      expect(res.headersFlushed).toBe(true);
    });

    it("sets socket noDelay", () => {
      const { req, res } = createMockPair();
      manager.addClient(req, res, "proj-1", "sess-1", 0);

      expect(res.socket.noDelay).toBe(true);
    });

    it("increments client count", () => {
      expect(manager.clientCount()).toBe(0);

      const { req: req1, res: res1 } = createMockPair();
      manager.addClient(req1, res1, "proj-1", "sess-1", 0);
      expect(manager.clientCount()).toBe(1);

      const { req: req2, res: res2 } = createMockPair();
      manager.addClient(req2, res2, "proj-2", "sess-2", 0);
      expect(manager.clientCount()).toBe(2);
    });

    it("returns a client object", () => {
      const { req, res } = createMockPair();
      const client = manager.addClient(req, res, "proj-1", "sess-1", 5);

      expect(client.projectId).toBe("proj-1");
      expect(client.sessionId).toBe("sess-1");
      expect(client.lastSeq).toBe(5);
      expect(client.alive).toBe(true);
    });
  });

  describe("removeClient", () => {
    it("removes client and decrements count", () => {
      const { req, res } = createMockPair();
      const client = manager.addClient(req, res, "proj-1", "sess-1", 0);
      expect(manager.clientCount()).toBe(1);

      manager.removeClient(client);
      expect(manager.clientCount()).toBe(0);
      expect(client.alive).toBe(false);
    });

    it("handles removing already-removed client", () => {
      const { req, res } = createMockPair();
      const client = manager.addClient(req, res, "proj-1", "sess-1", 0);
      manager.removeClient(client);
      manager.removeClient(client); // double remove should not throw
      expect(manager.clientCount()).toBe(0);
    });
  });

  describe("client disconnect", () => {
    it("marks client as dead on request close", () => {
      const { req, res } = createMockPair();
      const client = manager.addClient(req, res, "proj-1", "sess-1", 0);
      expect(client.alive).toBe(true);

      req.emit("close");
      expect(client.alive).toBe(false);
      expect(manager.clientCount()).toBe(0);
    });
  });

  describe("broadcast", () => {
    it("sends data to matching clients", () => {
      const { req: req1, res: res1 } = createMockPair();
      manager.addClient(req1, res1, "proj-1", "sess-1", 0);

      const { req: req2, res: res2 } = createMockPair();
      manager.addClient(req2, res2, "proj-1", "sess-1", 0);

      manager.broadcast("proj-1", "sess-1", '{"event":"test"}');

      expect(res1.getWritten()).toContain('data: {"event":"test"}\n\n');
      expect(res2.getWritten()).toContain('data: {"event":"test"}\n\n');
    });

    it("does not send data to non-matching clients", () => {
      const { req: req1, res: res1 } = createMockPair();
      manager.addClient(req1, res1, "proj-1", "sess-1", 0);

      const { req: req2, res: res2 } = createMockPair();
      manager.addClient(req2, res2, "proj-2", "sess-2", 0);

      manager.broadcast("proj-1", "sess-1", '{"event":"test"}');

      expect(res1.getWritten()).toContain('data: {"event":"test"}\n\n');
      // res2 should only have the initial :ok keepalive
      expect(res2.chunks.filter((c: string) => c.includes("event"))).toHaveLength(0);
    });

    it("skips dead clients", () => {
      const { req, res } = createMockPair();
      const client = manager.addClient(req, res, "proj-1", "sess-1", 0);
      client.alive = false;

      manager.broadcast("proj-1", "sess-1", '{"event":"test"}');

      // Should only have the initial :ok
      expect(res.chunks).toHaveLength(1);
    });
  });

  describe("startPolling / stopPolling", () => {
    it("can start and stop without error", () => {
      manager.startPolling();
      manager.stopPolling();
    });

    it("can be called multiple times safely", () => {
      manager.startPolling();
      manager.startPolling(); // double start
      manager.stopPolling();
      manager.stopPolling(); // double stop
    });
  });

  describe("clientCount", () => {
    it("only counts alive clients", () => {
      const { req: req1, res: res1 } = createMockPair();
      const { req: req2, res: res2 } = createMockPair();

      const c1 = manager.addClient(req1, res1, "proj-1", "sess-1", 0);
      manager.addClient(req2, res2, "proj-1", "sess-1", 0);

      expect(manager.clientCount()).toBe(2);

      c1.alive = false;
      expect(manager.clientCount()).toBe(1);
    });
  });
});
