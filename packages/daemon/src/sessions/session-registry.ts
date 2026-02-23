/**
 * SessionRegistry — central registry of all known sessions with state machine.
 *
 * Tracks sessions through their lifecycle:
 *   detected -> observed -> (managed | resumed) -> closed
 *
 * - detected:  Session directory found on filesystem
 * - observed:  Daemon is monitoring events in read-only mode
 * - managed:   Daemon owns the PTY (spawned by daemon)
 * - resumed:   Daemon took over an existing session's process
 * - closed:    Session has ended (terminal state)
 *
 * Special: transition to 'closed' is allowed from any non-closed state.
 *
 * Emits events to the EventBus on registration and state changes.
 */

import type { EventBus, EventEnvelope } from "../event-bus/event-bus.js";

/**
 * Session attach states (lifecycle).
 */
export type SessionAttachState =
  | "detected"
  | "observed"
  | "managed"
  | "resumed"
  | "closed";

/**
 * Metadata for a session tracked in the attach registry.
 */
export interface AttachSessionInfo {
  /** Unique session identifier */
  sessionId: string;

  /** Project identifier */
  projectId: string;

  /** Agent provider: "claude-code" | "opencode" | "codex" */
  agentProvider: string;

  /** When the session was first detected */
  detectedAt: Date;

  /** Current lifecycle state */
  state: SessionAttachState;

  /** PID of the agent process (if known) */
  pid: number | undefined;
}

/**
 * Valid state transitions for session attach lifecycle.
 * Key = from state, value = allowed target states.
 *
 * 'closed' is always reachable from any non-closed state (handled separately).
 */
const VALID_TRANSITIONS: Record<SessionAttachState, SessionAttachState[]> = {
  detected: ["observed", "closed"],
  observed: ["managed", "resumed", "closed"],
  managed: ["closed"],
  resumed: ["closed"],
  closed: [], // terminal
};

/**
 * Central registry of all known sessions with state machine enforcement.
 */
export class SessionRegistry {
  private readonly eventBus: EventBus;
  private readonly sessions = new Map<string, AttachSessionInfo>();

  /**
   * Creates a new SessionRegistry.
   *
   * @param eventBus - The daemon's event bus for publishing lifecycle events.
   */
  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a new session in the registry.
   *
   * The session starts in the 'detected' state.
   *
   * @param info - Session metadata. `state` should be 'detected'.
   * @throws If a session with the same ID is already registered.
   */
  register(info: AttachSessionInfo): void {
    if (this.sessions.has(info.sessionId)) {
      throw new Error(
        `Session "${info.sessionId}" is already registered`,
      );
    }
    this.sessions.set(info.sessionId, { ...info });

    // Emit registration event
    this.emitEvent("SessionDetected", info.sessionId, info.projectId, {
      agentProvider: info.agentProvider,
      pid: info.pid,
    });
  }

  /**
   * Get a session by ID.
   *
   * @param sessionId - The session identifier.
   * @returns Session info, or undefined if not found.
   */
  getSession(sessionId: string): AttachSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions, optionally filtered by state.
   *
   * @param state - If provided, only return sessions in this state.
   * @returns Array of matching sessions.
   */
  listSessions(state?: SessionAttachState): AttachSessionInfo[] {
    const all = Array.from(this.sessions.values());
    if (state !== undefined) {
      return all.filter((s) => s.state === state);
    }
    return all;
  }

  /**
   * Transition a session to a new state.
   *
   * Enforces the state machine: only valid transitions are allowed.
   * Emits a SessionStateChanged event on the EventBus.
   *
   * @param sessionId - The session to transition.
   * @param toState - The target state.
   * @throws If the session is not found.
   * @throws If the transition is not valid.
   */
  updateState(sessionId: string, toState: SessionAttachState): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const fromState = session.state;

    if (fromState === "closed") {
      throw new Error(
        `Invalid state transition: "${fromState}" -> "${toState}" (closed is terminal)`,
      );
    }

    // 'closed' is always reachable from any non-closed state
    if (toState !== "closed" && !VALID_TRANSITIONS[fromState].includes(toState)) {
      throw new Error(
        `Invalid state transition: "${fromState}" -> "${toState}"`,
      );
    }

    session.state = toState;

    this.emitEvent(
      "SessionStateChanged",
      sessionId,
      session.projectId,
      {
        fromState,
        toState,
        agentProvider: session.agentProvider,
      },
    );
  }

  /**
   * Remove a session from the registry.
   *
   * Does not throw if the session does not exist.
   *
   * @param sessionId - The session to remove.
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Emit an event to the EventBus.
   */
  private emitEvent(
    eventType: string,
    sessionId: string,
    projectId: string,
    data: Record<string, unknown>,
  ): void {
    const envelope: EventEnvelope = {
      event_id: crypto.randomUUID(),
      event_type: eventType,
      project_id: projectId,
      session_id: sessionId,
      sequence: 0, // internal events don't need sequence
      timestamp: new Date().toISOString(),
      agent_provider: (data.agentProvider as string) || "daemon",
      agent_native_event: eventType,
      agent_metadata: {},
      data,
    };
    this.eventBus.publish(envelope);
  }
}
