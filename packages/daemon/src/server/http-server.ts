/**
 * HttpServer — HTTP/WebSocket/SSE server for external clients.
 *
 * The HttpServer exposes the daemon's capabilities to external clients
 * (dashboard, CLI, mobile app) via:
 *
 * - **HTTP REST API**: Query sessions, projections, agent status
 * - **WebSocket**: Real-time bidirectional communication (agent streaming, permissions)
 * - **SSE (Server-Sent Events)**: Lightweight real-time event streaming
 *
 * The server binds to localhost by default for security. External access
 * is provided via the sync layer (Story F5) or an explicit tunnel.
 *
 * API surface (planned):
 *   GET  /api/health              - Daemon health check
 *   GET  /api/sessions            - List sessions
 *   GET  /api/sessions/:id        - Get session details
 *   GET  /api/sessions/:id/events - Get session events
 *   GET  /api/projects            - List projects
 *   GET  /api/projections/:type   - Get projection data
 *   POST /api/agents/spawn        - Spawn a new agent
 *   POST /api/agents/:id/prompt   - Send prompt to agent
 *   POST /api/agents/:id/interrupt - Interrupt an agent
 *   WS   /ws/events               - Real-time event stream
 *   GET  /api/events/stream       - SSE event stream
 */

import type { DaemonConfig } from "../config.js";
import type { EventBus } from "../event-bus/event-bus.js";
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
 * HTTP/WebSocket/SSE server for the daemon.
 *
 * Provides REST APIs, WebSocket connections, and SSE streams
 * for external clients to interact with the daemon.
 */
export class HttpServer {
  private readonly deps: HttpServerDeps;
  private running = false;

  /**
   * Creates a new HttpServer.
   *
   * @param deps - Injected dependencies (config, managers, stores)
   */
  constructor(deps: HttpServerDeps) {
    this.deps = deps;
  }

  /**
   * Start the HTTP server and begin accepting connections.
   *
   * @throws If the server is already running
   * @throws If the configured port is already in use
   *
   * TODO: Create Node.js HTTP server (or use a framework like Hono/Fastify)
   * TODO: Register REST API routes
   * TODO: Set up WebSocket upgrade handler
   * TODO: Set up SSE endpoint
   * TODO: Bind to configured host:port
   * TODO: Subscribe to EventBus for real-time streaming
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("HttpServer is already running");
    }

    // TODO: Create and start HTTP server
    // TODO: Register routes
    // TODO: Set up WebSocket handler
    this.running = true;
  }

  /**
   * Gracefully stop the HTTP server.
   *
   * Drains in-flight requests, closes WebSocket connections,
   * and unbinds from the port.
   *
   * TODO: Stop accepting new connections
   * TODO: Close all WebSocket connections
   * TODO: Wait for in-flight HTTP requests to complete (with timeout)
   * TODO: Close the server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // TODO: Graceful shutdown
    this.running = false;
  }

  /**
   * Whether the server is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the actual port the server is listening on.
   *
   * Useful when port 0 is configured for auto-assignment.
   *
   * @returns The bound port number, or null if not running
   *
   * TODO: Return actual bound port from the server handle
   */
  getPort(): number | null {
    if (!this.running) {
      return null;
    }
    // TODO: Return actual port
    return this.deps.config.server.port;
  }

  /**
   * Get the number of active WebSocket connections.
   *
   * TODO: Track and return active WebSocket count
   */
  getActiveConnections(): number {
    // TODO: Track connections
    return 0;
  }
}
