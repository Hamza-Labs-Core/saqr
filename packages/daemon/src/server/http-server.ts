/**
 * HttpServer — HTTP/WebSocket/SSE server for external clients.
 *
 * The HttpServer exposes the daemon's capabilities to external clients
 * (dashboard, CLI, mobile app, desktop app, web remote) via:
 *
 * - **HTTP REST API**: Query sessions, agents, health
 * - **WebSocket**: Real-time bidirectional communication (terminal streaming, permissions)
 * - **SSE (Server-Sent Events)**: Lightweight real-time event streaming
 *
 * REST Endpoints:
 *   GET  /api/health                    - Daemon health check
 *   GET  /api/sessions                  - List sessions
 *   GET  /api/sessions/:id              - Get session details
 *   GET  /api/sessions/:id/timeline     - Get full timeline (TimelineItem[])
 *   POST /api/sessions/:id/input        - Send input to session (REST alt to WS)
 *   POST /api/sessions/:id/permission/:pid - Approve/deny permission
 *   GET  /api/agents                    - List running agents
 *   POST /api/agents/:id/prompt         - Send prompt to agent
 *
 * WebSocket Endpoints:
 *   WS /ws/session/:id                  - Live terminal stream
 *
 * The server binds to localhost by default for security. External access
 * is provided via the sync layer or an explicit tunnel.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DaemonConfig } from "../config.js";
import type { EventBus, EventEnvelope, Unsubscribe } from "../event-bus/event-bus.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { EventStore } from "../store/event-store.js";

/**
 * Dependencies injected into the HttpServer.
 */
export interface HttpServerDeps {
  config: DaemonConfig;
  eventBus: EventBus;
  agentManager: AgentManager;
  sessionManager: SessionManager;
  eventStore: EventStore;
}

/**
 * Allowed origins for CORS. Default: localhost only (daemon is local).
 */
const ALLOWED_ORIGINS = new Set([
  "http://localhost:7399",    // Tauri dev server
  "http://localhost:5173",    // Vite dev server
  "http://localhost:3000",    // React dev server
  "http://127.0.0.1:7399",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "tauri://localhost",        // Tauri production
]);

// ---------------------------------------------------------------------------
// Minimal WebSocket frame implementation (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Accepts a WebSocket upgrade request and returns a WebSocket connection.
 * Implements RFC 6455 handshake + text frame encode/decode.
 */
function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (!key) return null;

  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const MAGIC = "258EAFA5-E914-47DA-95CA-5AB4CF64AD98";
  // codeguard:allow weak-hash — SHA-1 is mandated by RFC 6455 for WebSocket handshakes, not used for password hashing
  const accept = createHash("sha1").update(key + MAGIC).digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n",
  );

  return new WsConnection(socket);
}

type WsMessageHandler = (data: string) => void;
type WsCloseHandler = () => void;

class WsConnection {
  private socket: Duplex;
  private messageHandlers: WsMessageHandler[] = [];
  private closeHandlers: WsCloseHandler[] = [];
  private closed = false;
  private buffer = Buffer.alloc(0);

  constructor(socket: Duplex) {
    this.socket = socket;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processFrames();
    });

    socket.on("close", () => {
      this.closed = true;
      for (const handler of this.closeHandlers) handler();
    });

    socket.on("error", () => {
      this.closed = true;
      for (const handler of this.closeHandlers) handler();
    });
  }

  onMessage(handler: WsMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: WsCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  send(data: string): void {
    if (this.closed) return;
    const payload = Buffer.from(data, "utf-8");
    const frame = encodeFrame(payload, 0x01); // text frame
    try {
      this.socket.write(frame);
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const closeFrame = encodeFrame(Buffer.alloc(0), 0x08);
      this.socket.write(closeFrame);
      this.socket.end();
    } catch {
      // socket may already be closed
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private processFrames(): void {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this.buffer.length < totalLen) return;

      let payload: Buffer;
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = this.buffer[offset + 4 + i] ^ mask[i % 4];
        }
      } else {
        payload = this.buffer.subarray(offset, offset + payloadLen);
      }

      this.buffer = this.buffer.subarray(totalLen);

      // Handle opcodes
      if (opcode === 0x01) {
        // Text frame
        const text = payload.toString("utf-8");
        for (const handler of this.messageHandlers) handler(text);
      } else if (opcode === 0x08) {
        // Close frame
        this.close();
      } else if (opcode === 0x09) {
        // Ping -> Pong
        const pong = encodeFrame(payload, 0x0a);
        try { this.socket.write(pong); } catch { /* ignore */ }
      }
      // Ignore other opcodes (binary, pong, continuation)
    }
  }
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// HttpServer
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";

/**
 * HTTP/WebSocket/SSE server for the daemon.
 */
export class HttpServer {
  private readonly deps: HttpServerDeps;
  private server: Server | null = null;
  private running = false;
  private readonly wsConnections = new Set<WsConnection>();
  private readonly sseResponses = new Set<ServerResponse>();
  private startTime = 0;

  constructor(deps: HttpServerDeps) {
    this.deps = deps;
  }

  /**
   * Start the HTTP server and begin accepting connections.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("HttpServer is already running");
    }

    this.startTime = Date.now();

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // WebSocket upgrade
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(req, socket, head);
    });

    const { port, host } = this.deps.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.once("error", reject);
    });

    this.running = true;
  }

  /**
   * Gracefully stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    // Close all WebSocket connections
    for (const ws of this.wsConnections) {
      ws.close();
    }
    this.wsConnections.clear();

    // Close all SSE responses
    for (const res of this.sseResponses) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.sseResponses.clear();

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });

    this.server = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getPort(): number | null {
    if (!this.running || !this.server) {
      return null;
    }
    const addr = this.server.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.deps.config.server.port;
  }

  getActiveConnections(): number {
    return this.wsConnections.size + this.sseResponses.size;
  }

  // ---------------------------------------------------------------------------
  // HTTP Request Router
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // CORS headers — reflect origin only if in the allowed list
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health
      if (pathname === "/api/health" && method === "GET") {
        return this.sendJson(res, 200, {
          status: "ok",
          version: VERSION,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
        });
      }

      // Sessions
      if (pathname === "/api/sessions" && method === "GET") {
        return this.handleListSessions(res);
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "GET") {
        return this.handleGetSession(res, sessionMatch[1]);
      }

      const timelineMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/timeline$/);
      if (timelineMatch && method === "GET") {
        return this.handleGetTimeline(res, timelineMatch[1]);
      }

      const inputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (inputMatch && method === "POST") {
        return this.handleSessionInput(req, res, inputMatch[1]);
      }

      const permMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/permission\/([^/]+)$/);
      if (permMatch && method === "POST") {
        return this.handlePermission(req, res, permMatch[1], permMatch[2]);
      }

      // Agents
      if (pathname === "/api/agents" && method === "GET") {
        return this.handleListAgents(res);
      }

      const promptMatch = pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
      if (promptMatch && method === "POST") {
        return this.handleAgentPrompt(req, res, promptMatch[1]);
      }

      // SSE event stream
      if (pathname === "/api/events/stream" && method === "GET") {
        return this.handleSSE(req, res, url);
      }

      // 404
      this.sendJson(res, 404, { error: "not_found", message: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      this.sendJson(res, 500, { error: "internal_error", message });
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Upgrade
  // ---------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const wsSessionMatch = url.pathname.match(/^\/ws\/session\/([^/]+)$/);

    if (!wsSessionMatch) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = wsSessionMatch[1];
    const ws = acceptWebSocket(req, socket);
    if (!ws) {
      socket.destroy();
      return;
    }

    this.wsConnections.add(ws);
    this.handleSessionWebSocket(ws, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session WebSocket — live terminal stream
  // ---------------------------------------------------------------------------

  private handleSessionWebSocket(ws: WsConnection, sessionId: string): void {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `Session "${sessionId}" not found` }));
      ws.close();
      return;
    }

    // Subscribe to session events via EventBus
    const unsubscribe = this.deps.eventBus.subscribe(
      { sessionId },
      (event: EventEnvelope) => {
        if (ws.isClosed) return;
        ws.send(JSON.stringify({
          type: "timeline_event",
          event: {
            eventId: event.event_id,
            eventType: event.event_type,
            sessionId: event.session_id,
            sequence: event.sequence,
            timestamp: event.timestamp,
            agentProvider: event.agent_provider,
            data: event.data,
          },
        }));
      },
    );

    // Send session info on connect
    ws.send(JSON.stringify({
      type: "session_info",
      session: {
        sessionId: session.sessionId,
        projectId: session.projectId,
        agentProvider: session.agentProvider,
        model: session.model,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
      },
    }));

    // Handle incoming messages (input, permission responses)
    ws.onMessage((data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "input" && typeof msg.text === "string") {
          // Forward input to session
          this.deps.eventBus.publish({
            event_id: crypto.randomUUID(),
            event_type: "user_prompt_received",
            project_id: session.projectId,
            session_id: sessionId,
            sequence: 0,
            timestamp: new Date().toISOString(),
            agent_provider: session.agentProvider,
            agent_native_event: "user_input",
            agent_metadata: {},
            data: { text: msg.text },
          });
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.onClose(() => {
      unsubscribe();
      this.wsConnections.delete(ws);
    });
  }

  // ---------------------------------------------------------------------------
  // REST Handlers
  // ---------------------------------------------------------------------------

  private handleListSessions(res: ServerResponse): void {
    const sessions = this.deps.sessionManager.listSessions();
    this.sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        projectId: s.projectId,
        agentProvider: s.agentProvider,
        model: s.model,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        eventCount: s.eventCount,
      })),
    });
  }

  private handleGetSession(res: ServerResponse, sessionId: string): void {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "not_found", message: `Session "${sessionId}" not found` });
    }

    this.sendJson(res, 200, {
      sessionId: session.sessionId,
      projectId: session.projectId,
      agentProvider: session.agentProvider,
      model: session.model,
      workingDirectory: session.workingDirectory,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      eventCount: session.eventCount,
      chainedFrom: session.chainedFrom,
    });
  }

  private async handleGetTimeline(res: ServerResponse, sessionId: string): Promise<void> {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "not_found", message: `Session "${sessionId}" not found` });
    }

    try {
      const events = await this.deps.eventStore.queryEvents({ sessionId });
      const timeline = events.map((e) => ({
        eventId: e.event_id,
        eventType: e.event_type,
        sessionId: e.session_id,
        sequence: e.sequence,
        timestamp: e.timestamp,
        agentProvider: e.agent_provider,
        data: e.data,
      }));

      this.sendJson(res, 200, { timeline });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read timeline";
      this.sendJson(res, 500, { error: "internal_error", message });
    }
  }

  private async handleSessionInput(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "not_found", message: `Session "${sessionId}" not found` });
    }

    const body = await this.readBody(req);
    if (!body || typeof body.text !== "string") {
      return this.sendJson(res, 400, { error: "invalid_body", message: "text field is required" });
    }

    this.deps.eventBus.publish({
      event_id: crypto.randomUUID(),
      event_type: "user_prompt_received",
      project_id: session.projectId,
      session_id: sessionId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      agent_provider: session.agentProvider,
      agent_native_event: "user_input",
      agent_metadata: {},
      data: { text: body.text },
    });

    this.sendJson(res, 200, { status: "sent" });
  }

  private async handlePermission(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    permissionId: string,
  ): Promise<void> {
    const body = await this.readBody(req);
    if (!body || typeof body.action !== "string") {
      return this.sendJson(res, 400, { error: "invalid_body", message: "action field is required" });
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sendJson(res, 404, { error: "not_found", message: `Session "${sessionId}" not found` });
    }

    this.deps.eventBus.publish({
      event_id: crypto.randomUUID(),
      event_type: "permission_responded",
      project_id: session.projectId,
      session_id: sessionId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      agent_provider: session.agentProvider,
      agent_native_event: "permission_response",
      agent_metadata: {},
      data: {
        permissionId,
        action: body.action,
        rule: body.rule ?? null,
      },
    });

    this.sendJson(res, 200, { status: body.action });
  }

  private async handleListAgents(res: ServerResponse): Promise<void> {
    try {
      const providers = await this.deps.agentManager.listProviders();
      this.sendJson(res, 200, { agents: providers });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list agents";
      this.sendJson(res, 500, { error: "internal_error", message });
    }
  }

  private async handleAgentPrompt(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    const body = await this.readBody(req);
    if (!body || typeof body.prompt !== "string") {
      return this.sendJson(res, 400, { error: "invalid_body", message: "prompt field is required" });
    }

    // Publish prompt as an event on the bus
    this.deps.eventBus.publish({
      event_id: crypto.randomUUID(),
      event_type: "user_prompt_received",
      project_id: "default",
      session_id: agentId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      agent_provider: "api",
      agent_native_event: "prompt",
      agent_metadata: {},
      data: { text: body.prompt, agentId },
    });

    this.sendJson(res, 200, { status: "sent", agentId });
  }

  // ---------------------------------------------------------------------------
  // SSE — Server-Sent Events stream
  // ---------------------------------------------------------------------------

  private handleSSE(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    this.sseResponses.add(res);

    const unsubscribe = this.deps.eventBus.subscribe(
      sessionId ? { sessionId } : {},
      (event: EventEnvelope) => {
        const data = JSON.stringify({
          eventId: event.event_id,
          eventType: event.event_type,
          sessionId: event.session_id,
          sequence: event.sequence,
          timestamp: event.timestamp,
          data: event.data,
        });
        try {
          res.write(`data: ${data}\n\n`);
        } catch {
          // Client disconnected
        }
      },
    );

    req.on("close", () => {
      unsubscribe();
      this.sseResponses.delete(res);
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }
}
