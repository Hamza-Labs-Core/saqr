/**
 * AgentManager -- manages agent processes and provider registry.
 *
 * The AgentManager is the control plane for agent process orchestration
 * (Story 05). It provides a unified interface to spawn, manage, stream,
 * interrupt, and persist multiple coding agent processes running in parallel.
 *
 * Responsibilities:
 * - Provider registry: register and query agent providers
 * - Session creation: spawn new agent sessions via providers
 * - Session management: track, list, and control active sessions
 * - Lifecycle state tracking with event emission
 * - Graceful startup and shutdown of all managed agents
 */

import { randomUUID } from "node:crypto";
import type { EventBus } from "../event-bus/event-bus.js";
import {
  AgentStateMachine,
  type AgentLifecycleState,
  type StateChangeEvent,
} from "./state-machine.js";
import {
  ProviderNotRegisteredError,
  AgentNotFoundError,
  MaxAgentsReachedError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Provider Interfaces
// ---------------------------------------------------------------------------

/**
 * Agent provider capabilities.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  resume: boolean;
  interruption: boolean;
  permissions: boolean;
  modelSelection: boolean;
  worktree: boolean;
}

/**
 * Information about a registered provider.
 */
export interface ProviderInfo {
  id: string;
  name: string;
  version: string;
  installed: boolean;
  capabilities: ProviderCapabilities;
}

/**
 * Model information from a provider.
 */
export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
}

/**
 * Options for creating a new agent session.
 */
export interface CreateSessionOptions {
  providerId: string;
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  environment?: Record<string, string>;
  maxTurns?: number;
}

/**
 * Agent lifecycle states.
 */
export type AgentState =
  | "initializing"
  | "idle"
  | "running"
  | "waiting_permission"
  | "interrupted"
  | "completed"
  | "error";

/**
 * Represents an active agent session managed by the daemon.
 */
export interface ManagedSession {
  sessionId: string;
  providerId: string;
  state: AgentLifecycleState;
  createdAt: Date;
  workingDirectory: string;
  model: string;
}

/**
 * Agent provider interface -- implemented by each provider (or mock).
 */
export interface AgentProvider {
  readonly providerId: string;
  getInfo(): Promise<ProviderInfo>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
  createSession(options: CreateSessionOptions): Promise<ManagedSession>;
  resumeSession(sessionId: string): Promise<ManagedSession>;
}

/**
 * Configuration for the AgentManager.
 */
export interface AgentManagerConfig {
  maxConcurrentAgents?: number;
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

/**
 * Manages agent processes and the provider registry.
 */
export class AgentManager {
  private readonly eventBus: EventBus;
  private readonly providers = new Map<string, AgentProvider>();
  private readonly activeSessions = new Map<string, ManagedSession>();
  private readonly stateMachines = new Map<string, AgentStateMachine>();
  private readonly stateChangeListeners = new Set<
    (event: StateChangeEvent) => void
  >();
  private readonly maxConcurrentAgents: number;

  constructor(eventBus: EventBus, config: AgentManagerConfig = {}) {
    this.eventBus = eventBus;
    this.maxConcurrentAgents = config.maxConcurrentAgents ?? 5;
  }

  // -----------------------------------------------------------------------
  // Provider Registry
  // -----------------------------------------------------------------------

  /**
   * Register an agent provider.
   *
   * @throws if a provider with the same ID is already registered.
   */
  registerProvider(provider: AgentProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(
        `Agent provider "${provider.providerId}" is already registered`,
      );
    }
    this.providers.set(provider.providerId, provider);
  }

  /**
   * Get a registered provider by ID.
   */
  getProvider(providerId: string): AgentProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * List all registered providers with their info.
   */
  async listProviders(): Promise<ProviderInfo[]> {
    const infos: ProviderInfo[] = [];
    for (const provider of this.providers.values()) {
      const info = await provider.getInfo();
      infos.push(info);
    }
    return infos;
  }

  // -----------------------------------------------------------------------
  // Session Management
  // -----------------------------------------------------------------------

  /**
   * Create a new agent session.
   *
   * @throws ProviderNotRegisteredError if the provider is unknown
   * @throws MaxAgentsReachedError if the concurrent limit is hit
   */
  async createSession(options: CreateSessionOptions): Promise<ManagedSession> {
    const provider = this.providers.get(options.providerId);
    if (!provider) {
      throw new ProviderNotRegisteredError(options.providerId);
    }

    if (this.activeSessions.size >= this.maxConcurrentAgents) {
      throw new MaxAgentsReachedError(this.maxConcurrentAgents);
    }

    const session = await provider.createSession(options);

    // Create a state machine for tracking lifecycle
    const sm = new AgentStateMachine(session.sessionId);

    // Wire state change events BEFORE transitioning so listeners catch all events
    sm.onStateChange((event) => {
      // Update the session state
      const s = this.activeSessions.get(event.sessionId);
      if (s) {
        s.state = event.currentState;
      }
      // Notify all listeners
      for (const listener of this.stateChangeListeners) {
        try {
          listener(event);
        } catch {
          // Swallow listener errors
        }
      }
      // Publish to EventBus
      this.eventBus.publish({
        event_id: randomUUID(),
        event_type: "AgentStateChanged",
        project_id: "",
        session_id: event.sessionId,
        sequence: 0,
        timestamp: event.timestamp.toISOString(),
        agent_provider: session.providerId,
        agent_native_event: "state_change",
        agent_metadata: {
          previousState: event.previousState,
          currentState: event.currentState,
          reason: event.reason,
        },
        data: {},
      });
    });

    // Store session and state machine before transitioning
    this.activeSessions.set(session.sessionId, session);
    this.stateMachines.set(session.sessionId, sm);

    // Transition from initializing to idle (session was created successfully)
    // Done after wiring listeners so all subscribers receive the event
    sm.transition("idle", "Session created successfully");

    return session;
  }

  /**
   * Get an active session by ID.
   */
  getSession(sessionId: string): ManagedSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * List all active sessions.
   */
  listSessions(): ManagedSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get the state machine for a session (for testing / advanced usage).
   */
  getStateMachine(sessionId: string): AgentStateMachine | undefined {
    return this.stateMachines.get(sessionId);
  }

  /**
   * Interrupt an active session's current operation without killing it.
   *
   * @throws AgentNotFoundError if the session is not active
   */
  async interruptSession(
    sessionId: string,
    _graceful = true,
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new AgentNotFoundError(sessionId);
    }

    const sm = this.stateMachines.get(sessionId);
    if (sm && sm.state === "running") {
      sm.transition("idle", "Session interrupted");
    }
  }

  /**
   * Terminate an active session.
   *
   * @throws AgentNotFoundError if the session is not active
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new AgentNotFoundError(sessionId);
    }

    const sm = this.stateMachines.get(sessionId);
    if (sm) {
      sm.transition("closed", "Session terminated");
      sm.destroy();
    }

    this.activeSessions.delete(sessionId);
    this.stateMachines.delete(sessionId);
  }

  /**
   * Shut down all active sessions gracefully.
   */
  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.activeSessions.keys());
    for (const id of sessionIds) {
      try {
        await this.terminateSession(id);
      } catch {
        // Best-effort shutdown
      }
    }
    this.activeSessions.clear();
    this.stateMachines.clear();
  }

  /**
   * Subscribe to state change events across all agents.
   * Returns an unsubscribe function.
   */
  onStateChange(callback: (event: StateChangeEvent) => void): () => void {
    this.stateChangeListeners.add(callback);
    return () => {
      this.stateChangeListeners.delete(callback);
    };
  }
}
