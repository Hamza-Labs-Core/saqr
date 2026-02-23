/**
 * Dashboard Server — single-file HTTP server for the AgentContext daemon.
 *
 * Zero npm dependencies at runtime (only Node.js built-ins).
 * Routes:
 *   GET /          - HTML dashboard UI
 *   GET /api/projects  - List projects
 *   GET /api/sessions  - List sessions for a project
 *   GET /api/events    - Paginated events with filters
 *   GET /api/usage     - Usage analytics
 *   GET /api/agents    - Agent status
 *   GET /api/health    - Health check
 *   GET /sse           - SSE stream
 */

import http from "node:http";
import path from "node:path";
import os from "node:os";

import { listProjects, listSessions, readEvents, isValidPathId } from "./api/events.js";
import { getAllUsage, getProjectUsage } from "./api/usage.js";
import { listAgents, sendPrompt, approvePermission } from "./api/agents.js";
import type { DaemonConnection } from "./api/agents.js";
import { createSSEManager } from "./api/sse.js";
import { generateDashboardHTML } from "./ui.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  port: number;
  eventsDir: string;
  daemonHost: string;
  daemonPort: number;
}

export function getDefaultConfig(): DashboardConfig {
  const basePath = process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), ".claude-context");
  return {
    port: parseInt(process.env.DASHBOARD_PORT || "4000", 10),
    eventsDir: path.join(basePath, "events"),
    daemonHost: "127.0.0.1",
    daemonPort: parseInt(process.env.DAEMON_PORT || "4100", 10),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function send404(res: http.ServerResponse): void {
  sendJson(res, { error: "not found" }, 404);
}

function sendError(res: http.ServerResponse, message: string, status = 500): void {
  sendJson(res, { error: message }, status);
}

/** Maximum request body size (1 MB). */
export const MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024;

/**
 * Read the full request body with a size limit.
 * Rejects with a 413-style error if the body exceeds MAX_REQUEST_BODY_SIZE.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let destroyed = false;

    req.on("data", (chunk: Buffer | string) => {
      if (destroyed) return;
      const chunkStr = typeof chunk === "string" ? chunk : chunk.toString();
      size += Buffer.byteLength(chunkStr);
      if (size > MAX_REQUEST_BODY_SIZE) {
        destroyed = true;
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        // Resume to drain remaining data so the socket stays usable for the response
        req.resume();
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      body += chunkStr;
    });

    req.on("end", () => {
      if (!destroyed) resolve(body);
    });

    req.on("error", (err) => {
      if (!destroyed) reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createDashboardServer(config: DashboardConfig): http.Server {
  const { eventsDir, daemonHost, daemonPort } = config;
  const daemonConn: DaemonConnection = { host: daemonHost, port: daemonPort };

  const sseManager = createSSEManager(eventsDir);
  sseManager.startPolling();

  // Pre-generate HTML once
  const dashboardHTML = generateDashboardHTML();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      // --- CORS preflight ---
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // --- API routes ---

      if (pathname === "/api/health") {
        return sendJson(res, {
          status: "ok",
          uptime: process.uptime(),
          sseClients: sseManager.clientCount(),
        });
      }

      if (pathname === "/api/projects") {
        const projects = await listProjects(eventsDir);
        return sendJson(res, projects);
      }

      if (pathname === "/api/sessions") {
        const projectId = url.searchParams.get("project");
        if (!projectId) return sendError(res, "project param required", 400);
        if (!isValidPathId(projectId)) return sendError(res, "invalid project ID", 400);
        const sessions = await listSessions(eventsDir, projectId);
        return sendJson(res, sessions);
      }

      if (pathname === "/api/events") {
        const projectId = url.searchParams.get("project");
        const sessionId = url.searchParams.get("session");
        if (!projectId || !sessionId) {
          return sendError(res, "project and session params required", 400);
        }
        if (!isValidPathId(projectId)) return sendError(res, "invalid project ID", 400);
        if (!isValidPathId(sessionId)) return sendError(res, "invalid session ID", 400);
        const from = parseInt(url.searchParams.get("from") || "0", 10);
        const limit = url.searchParams.get("limit")
          ? parseInt(url.searchParams.get("limit")!, 10)
          : undefined;
        const eventTypesRaw = url.searchParams.get("types");
        const eventTypes = eventTypesRaw ? eventTypesRaw.split(",") : undefined;
        const afterTimestamp = url.searchParams.get("after") || undefined;

        const events = await readEvents(eventsDir, {
          projectId,
          sessionId,
          fromSequence: from,
          eventTypes,
          afterTimestamp,
          limit,
        });
        return sendJson(res, events);
      }

      if (pathname === "/api/usage") {
        const projectId = url.searchParams.get("project");
        if (projectId) {
          if (!isValidPathId(projectId)) return sendError(res, "invalid project ID", 400);
          const usage = await getProjectUsage(eventsDir, projectId);
          if (!usage) return sendError(res, "project not found or no transcript data", 404);
          return sendJson(res, usage);
        }
        const allUsage = await getAllUsage(eventsDir);
        return sendJson(res, allUsage);
      }

      if (pathname === "/api/agents") {
        if (req.method === "GET") {
          const agents = await listAgents(daemonConn);
          return sendJson(res, agents);
        }
      }

      // POST /api/agents/:id/prompt
      const promptMatch = pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
      if (promptMatch && req.method === "POST") {
        try {
          const body = await readBody(req);
          const { prompt } = JSON.parse(body);
          const result = await sendPrompt(daemonConn, promptMatch[1], prompt);
          return sendJson(res, result, result.success ? 200 : 500);
        } catch (err) {
          if ((err as any)?.statusCode === 413) {
            return sendError(res, "Request body too large", 413);
          }
          return sendError(res, "Invalid JSON body", 400);
        }
      }

      // POST /api/agents/:id/permissions/:pid/approve
      const permMatch = pathname.match(
        /^\/api\/agents\/([^/]+)\/permissions\/([^/]+)\/approve$/,
      );
      if (permMatch && req.method === "POST") {
        const result = await approvePermission(daemonConn, permMatch[1], permMatch[2]);
        return sendJson(res, result, result.success ? 200 : 500);
      }

      // --- SSE stream ---
      if (pathname === "/sse") {
        const projectId = url.searchParams.get("project");
        const sessionId = url.searchParams.get("session");
        if (!projectId || !sessionId) {
          return sendError(res, "project and session params required", 400);
        }
        if (!isValidPathId(projectId)) return sendError(res, "invalid project ID", 400);
        if (!isValidPathId(sessionId)) return sendError(res, "invalid session ID", 400);
        const from = parseInt(url.searchParams.get("from") || "0", 10);
        sseManager.addClient(req, res, projectId, sessionId, from);
        return;
      }

      // --- HTML dashboard ---
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(dashboardHTML);
        return;
      }

      send404(res);
    } catch (err) {
      console.error("Request error:", err);
      sendError(res, "internal error", 500);
    }
  });

  // Cleanup on close
  server.on("close", () => {
    sseManager.stopPolling();
  });

  return server;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function startDashboard(overrides?: Partial<DashboardConfig>): http.Server {
  const config = { ...getDefaultConfig(), ...overrides };
  const server = createDashboardServer(config);

  server.listen(config.port, () => {
    console.log(`Saqr Dashboard running at http://localhost:${config.port}`);
    console.log(`Events directory: ${config.eventsDir}`);
  });

  return server;
}

// Run if this is the main module
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/server.js") || process.argv[1].endsWith("/server.ts"));

if (isMain) {
  // Parse CLI args
  let port: number | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  startDashboard(port ? { port } : undefined);
}
