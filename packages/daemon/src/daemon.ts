/**
 * Core Daemon class — the main entry point for the AgentContext daemon.
 *
 * The Daemon owns and coordinates all subsystems:
 * - EventBus: internal pub/sub for routing events between components
 * - HookManager: manages hook integrations with coding agents
 * - AgentManager: spawns and manages agent processes
 * - SessionManager: tracks active and historical sessions
 * - HttpServer: HTTP/WS/SSE server for external clients
 * - EventStore: read-side access to the event file store
 *
 * Lifecycle:
 *   const daemon = new Daemon(config);
 *   await daemon.start();  // binds ports, starts watchers, registers providers
 *   // ... daemon is running ...
 *   await daemon.stop();   // graceful shutdown
 */

import * as path from "node:path";
import type { DaemonConfig } from "./config.js";
import { EventBus } from "./event-bus/event-bus.js";
import type { HookManager } from "./hooks/hook-manager.js";
import { AgentManager } from "./agents/agent-manager.js";
import { SessionManager } from "./sessions/session-manager.js";
import { HttpServer } from "./server/http-server.js";
import { EventStore } from "./store/event-store.js";
import { initLogger, getLogger } from "./logger.js";

/**
 * The AgentContext daemon — core of the Saqr platform.
 *
 * Orchestrates multi-agent hook capture, event storage, projections,
 * agent process management, and real-time streaming to clients.
 */
export class Daemon {
  private readonly config: DaemonConfig;

  /** Internal pub/sub event bus for daemon components */
  private eventBus: EventBus | null = null;

  /** Manages hook integrations (Claude Code, OpenCode, Codex, custom) */
  private hookManager: HookManager | null = null;

  /** Manages agent processes and provider registry */
  private agentManager: AgentManager | null = null;

  /** Tracks active and historical sessions */
  private sessionManager: SessionManager | null = null;

  /** HTTP/WS/SSE server for external clients */
  private httpServer: HttpServer | null = null;

  /** Event store read-side for accessing event files */
  private eventStore: EventStore | null = null;

  /** Whether the daemon is currently running */
  private running = false;

  /**
   * Creates a new Daemon instance.
   *
   * @param config - Fully resolved daemon configuration
   */
  constructor(config: DaemonConfig) {
    this.config = config;
  }

  /**
   * Starts the daemon and all subsystems.
   *
   * Initialization order:
   * 1. EventBus (no dependencies)
   * 2. EventStore (needs config.eventStore)
   * 3. SessionManager (needs EventBus, EventStore)
   * 4. HookManager (needs EventBus, config.hooks)
   * 5. AgentManager (needs EventBus, SessionManager)
   * 6. HttpServer (needs all managers for API routing)
   *
   * @throws If the daemon is already running
   * @throws If any subsystem fails to initialize
   *
   * TODO: Initialize EventBus
   * TODO: Initialize EventStore and start filesystem watcher
   * TODO: Initialize SessionManager
   * TODO: Initialize HookManager and register integrations
   * TODO: Initialize AgentManager and register providers
   * TODO: Initialize HttpServer and bind to configured port
   * TODO: Start UDP listener for event notifications
   * TODO: Set up graceful shutdown handlers (SIGINT, SIGTERM)
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    // 0. Logger (must be first)
    const log = initLogger({
      level: this.config.logLevel,
      logDir: path.join(this.config.baseDir, "logs"),
    });
    log.info("daemon", `Starting daemon (port=${this.config.server.port}, logLevel=${this.config.logLevel})`);

    // 1. EventBus (no dependencies)
    this.eventBus = new EventBus();

    // 2. EventStore (needs config.eventStore)
    this.eventStore = new EventStore(this.config.eventStore.eventsDir);

    // 3. SessionManager (needs EventBus)
    this.sessionManager = new SessionManager(this.eventBus);

    // 4. AgentManager (needs EventBus)
    this.agentManager = new AgentManager(this.eventBus);

    // 5. HookManager — skip for now (not needed for minimal daemon)

    // 6. HttpServer (needs all managers for API routing)
    this.httpServer = new HttpServer({
      config: this.config,
      eventBus: this.eventBus,
      agentManager: this.agentManager,
      sessionManager: this.sessionManager,
      eventStore: this.eventStore,
    });
    await this.httpServer.start();

    this.running = true;
    log.info("daemon", `Daemon started successfully on port ${this.config.server.port}`);
  }

  /**
   * Gracefully stops the daemon and all subsystems.
   *
   * Shutdown order (reverse of startup):
   * 1. HttpServer (stop accepting new connections, drain existing)
   * 2. AgentManager (interrupt running agents gracefully)
   * 3. HookManager (unregister hooks)
   * 4. SessionManager (persist session state)
   * 5. EventStore (flush caches)
   * 6. EventBus (drain pending events)
   *
   * @throws If the daemon is not running
   *
   * TODO: Implement graceful shutdown with timeout
   * TODO: Persist any in-memory state before exiting
   * TODO: Close all open file handles and sockets
   */
  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error("Daemon is not running");
    }

    const log = getLogger();
    log.info("daemon", "Shutting down...");

    // Shutdown in reverse dependency order
    if (this.httpServer) {
      await this.httpServer.stop();
    }

    // AgentManager, HookManager, SessionManager, EventStore —
    // no async teardown needed yet (in-memory only)

    log.info("daemon", "Daemon stopped");
    log.close();

    this.running = false;
    this.httpServer = null;
    this.agentManager = null;
    this.hookManager = null;
    this.sessionManager = null;
    this.eventStore = null;
    this.eventBus = null;
  }

  /**
   * Returns whether the daemon is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the daemon configuration.
   */
  getConfig(): DaemonConfig {
    return this.config;
  }

  /**
   * Returns the internal event bus, if the daemon is running.
   *
   * @throws If the daemon is not running
   */
  getEventBus(): EventBus {
    if (!this.eventBus) {
      throw new Error("Daemon is not running — EventBus not available");
    }
    return this.eventBus;
  }

  /**
   * Returns the hook manager, if the daemon is running.
   *
   * @throws If the daemon is not running
   */
  getHookManager(): HookManager {
    if (!this.hookManager) {
      throw new Error("Daemon is not running — HookManager not available");
    }
    return this.hookManager;
  }

  /**
   * Returns the agent manager, if the daemon is running.
   *
   * @throws If the daemon is not running
   */
  getAgentManager(): AgentManager {
    if (!this.agentManager) {
      throw new Error("Daemon is not running — AgentManager not available");
    }
    return this.agentManager;
  }

  /**
   * Returns the session manager, if the daemon is running.
   *
   * @throws If the daemon is not running
   */
  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error("Daemon is not running — SessionManager not available");
    }
    return this.sessionManager;
  }
}
