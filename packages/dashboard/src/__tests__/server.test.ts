/**
 * Tests for the Dashboard HTTP server.
 *
 * Verifies:
 * - HTTP routes and response codes
 * - Content types
 * - Parameter validation
 * - JSON API responses
 * - SSE endpoint setup
 * - Health check
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createDashboardServer, MAX_REQUEST_BODY_SIZE } from "../server.js";
import type { DashboardConfig } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: http.Server;
let port: number;

function padSeq(n: number): string {
  return String(n).padStart(6, "0");
}

async function fetch(urlPath: string, options?: { method?: string; body?: string }): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: options?.method || "GET",
      headers: options?.body ? { "Content-Type": "application/json" } : {},
    };

    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, body });
      });
    });

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (options?.body) req.write(options.body);
    req.end();
  });
}

function json(body: string): unknown {
  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-dash-server-"));

  // Create a project with events
  const projectId = "test-proj-aaa111";
  const sessionId = "sess-test-001";

  const sessionDir = path.join(tmpDir, projectId, sessionId);
  await mkdir(sessionDir, { recursive: true });

  // Write session.json
  await writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      session_id: sessionId,
      project_id: projectId,
      started_at: "2025-01-20T10:00:00.000Z",
      event_count: 3,
      agent_provider: "claude-code",
    }),
  );

  // Write 3 events
  for (let i = 1; i <= 3; i++) {
    await writeFile(
      path.join(sessionDir, `${padSeq(i)}.json`),
      JSON.stringify({
        event_id: `evt-${i}`,
        event_type: i === 1 ? "SessionStarted" : "ToolCallRequested",
        project_id: projectId,
        session_id: sessionId,
        sequence: i,
        timestamp: `2025-01-20T10:${String(i).padStart(2, "0")}:00.000Z`,
        agent_provider: "claude-code",
        agent_native_event: "tool_use",
        agent_metadata: {},
        data: i === 1 ? { model: "claude-sonnet-4-20250514", cwd: "/home/test" } : { tool_name: "Read" },
      }),
    );
  }

  // Start server on random available port
  const config: DashboardConfig = {
    port: 0,
    eventsDir: tmpDir,
    daemonHost: "127.0.0.1",
    daemonPort: 49999, // Unlikely to be running
  };

  server = createDashboardServer(config);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /", () => {
  it("returns HTML dashboard", async () => {
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Saqr");
  });
});

describe("GET /index.html", () => {
  it("returns the same HTML as /", async () => {
    const res = await fetch("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
  });
});

describe("GET /api/health", () => {
  it("returns health status", async () => {
    const res = await fetch("/api/health");
    expect(res.status).toBe(200);
    const data = json(res.body) as any;
    expect(data.status).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(typeof data.sseClients).toBe("number");
  });

  it("returns JSON content type", async () => {
    const res = await fetch("/api/health");
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("GET /api/projects", () => {
  it("returns list of projects", async () => {
    const res = await fetch("/api/projects");
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(1);
    expect(data[0].project_id).toBe("test-proj-aaa111");
    expect(data[0].name).toBe("test-proj");
    expect(data[0].session_count).toBe(1);
  });
});

describe("GET /api/sessions", () => {
  it("returns sessions for a project", async () => {
    const res = await fetch("/api/sessions?project=test-proj-aaa111");
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(1);
    expect(data[0].session_id).toBe("sess-test-001");
  });

  it("returns 400 without project param", async () => {
    const res = await fetch("/api/sessions");
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toBeDefined();
  });

  it("returns empty array for non-existent project", async () => {
    const res = await fetch("/api/sessions?project=nonexistent");
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toEqual([]);
  });
});

describe("GET /api/events", () => {
  it("returns events for a session", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=sess-test-001",
    );
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(3);
    expect(data[0].sequence).toBe(1);
    expect(data[0].event_type).toBe("SessionStarted");
  });

  it("supports from parameter for pagination", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=sess-test-001&from=1",
    );
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(2);
    expect(data[0].sequence).toBe(2);
  });

  it("supports limit parameter", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=sess-test-001&limit=1",
    );
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(1);
  });

  it("supports event type filtering", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=sess-test-001&types=SessionStarted",
    );
    expect(res.status).toBe(200);
    const data = json(res.body) as any[];
    expect(data).toHaveLength(1);
    expect(data[0].event_type).toBe("SessionStarted");
  });

  it("returns 400 without required params", async () => {
    const res = await fetch("/api/events");
    expect(res.status).toBe(400);

    const res2 = await fetch("/api/events?project=test-proj-aaa111");
    expect(res2.status).toBe(400);
  });

  it("includes event summaries in response", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=sess-test-001&limit=1",
    );
    const data = json(res.body) as any[];
    expect(data[0]._summary).toBeDefined();
    expect(data[0]._summary.text).toBeDefined();
    expect(data[0]._summary.html).toBeDefined();
  });
});

describe("GET /api/usage", () => {
  it("returns usage data (may be empty)", async () => {
    const res = await fetch("/api/usage");
    expect(res.status).toBe(200);
    // Will return empty array if no transcript files exist
    const data = json(res.body);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("GET /api/agents", () => {
  it("returns agent list (empty if daemon not running)", async () => {
    const res = await fetch("/api/agents");
    expect(res.status).toBe(200);
    const data = json(res.body);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("GET /sse", () => {
  it("returns 400 without required params", async () => {
    const res = await fetch("/sse");
    expect(res.status).toBe(400);
  });

  it("establishes SSE connection with correct params", async () => {
    // Make an SSE request and immediately abort to test headers
    const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/sse?project=test-proj-aaa111&session=sess-test-001",
        },
        (res) => {
          resolve({ status: res.statusCode || 0, headers: res.headers });
          res.destroy(); // Close immediately
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/event-stream");
    expect(result.headers["cache-control"]).toBe("no-cache");
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch("/unknown/path");
    expect(res.status).toBe(404);
    const data = json(res.body) as any;
    expect(data.error).toBe("not found");
  });
});

describe("CORS", () => {
  it("includes CORS headers in API responses", async () => {
    const res = await fetch("/api/health");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await fetch("/api/health", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

describe("POST body size limit", () => {
  it("returns 413 when request body exceeds 1 MB", async () => {
    // Build a body that is just over the 1 MB limit
    const oversizedBody = "x".repeat(MAX_REQUEST_BODY_SIZE + 1);

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/agents/test-agent/prompt",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 0, body });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
      req.write(oversizedBody);
      req.end();
    });

    expect(res.status).toBe(413);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/too large/i);
  });

  it("accepts request bodies under 1 MB", async () => {
    // A small valid JSON body should not trigger the limit
    const smallBody = JSON.stringify({ prompt: "hello" });
    const res = await fetch("/api/agents/test-agent/prompt", {
      method: "POST",
      body: smallBody,
    });
    // Will likely get 500 since no daemon is running, but NOT 413
    expect(res.status).not.toBe(413);
  });
});

describe("Path traversal protection", () => {
  it("rejects project ID with '..' in /api/sessions", async () => {
    const res = await fetch("/api/sessions?project=../../etc");
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects project ID with '/' in /api/sessions", async () => {
    const res = await fetch("/api/sessions?project=foo/bar");
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects project ID with backslash in /api/sessions", async () => {
    const res = await fetch(
      "/api/sessions?project=" + encodeURIComponent("foo\\bar"),
    );
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects project ID with null byte in /api/sessions", async () => {
    const res = await fetch(
      "/api/sessions?project=" + encodeURIComponent("foo\x00bar"),
    );
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects session ID with '..' in /api/events", async () => {
    const res = await fetch(
      "/api/events?project=test-proj-aaa111&session=../../etc/passwd",
    );
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid session/i);
  });

  it("rejects project ID with '..' in /api/events", async () => {
    const res = await fetch(
      "/api/events?project=../../../etc&session=sess-test-001",
    );
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("allows valid project IDs with dots and hyphens", async () => {
    // Valid format: basename-hash6 (e.g., "my-project.v2-abc123")
    const res = await fetch("/api/sessions?project=my-project.v2-abc123");
    expect(res.status).toBe(200);
  });

  it("rejects overly long project IDs (> 256 chars)", async () => {
    const longId = "a".repeat(257);
    const res = await fetch("/api/sessions?project=" + longId);
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects traversal in /api/usage project param", async () => {
    const res = await fetch("/api/usage?project=../../etc");
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });

  it("rejects traversal in /sse endpoint", async () => {
    const res = await fetch(
      "/sse?project=../../etc&session=sess-test-001",
    );
    expect(res.status).toBe(400);
    const data = json(res.body) as any;
    expect(data.error).toMatch(/invalid project/i);
  });
});
