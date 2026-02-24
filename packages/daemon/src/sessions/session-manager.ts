/**
 * SessionManager — tracks active and historical agent sessions.
 *
 * The SessionManager is the central registry for all sessions known to the daemon.
 * It tracks both daemon-managed sessions (spawned via AgentManager) and externally
 * observed sessions (detected via hooks from independently-running agents).
 *
 * Responsibilities:
 * - Track active sessions across all agents
 * - Maintain session metadata (agent, model, project, timestamps)
 * - Support session chaining across agent types (e.g., Claude Code -> OpenCode)
 * - Persist session state for daemon restart recovery
 * - Provide session query and listing APIs
 */

import type { EventBus } from "../event-bus/event-bus.js";

/**
 * Session metadata stored by the SessionManager.
 */
export interface SessionInfo {
  /** Unique session identifier */
  sessionId: string;

  /** Project identifier this session belongs to */
  projectId: string;

  /** Agent provider: "claude-code" | "opencode" | "codex" | "custom" */
  agentProvider: string;

  /** Model in use for this session */
  model: string;

  /** Working directory for the session */
  workingDirectory: string;

  /** When the session started */
  startedAt: Date;

  /** When the session ended (null if still active) */
  endedAt: Date | null;

  /** Current session status */
  status: "active" | "idle" | "completed" | "error";

  /** Number of events captured in this session */
  eventCount: number;

  /** If this session continues from another, the parent session ID */
  chainedFrom: string | null;
}

/**
 * Filter criteria for querying sessions.
 */
export interface SessionFilter {
  /** Filter by project ID */
  projectId?: string;

  /** Filter by agent provider */
  agentProvider?: string;

  /** Filter by status */
  status?: SessionInfo["status"];

  /** Filter sessions started after this date */
  startedAfter?: Date;

  /** Filter sessions started before this date */
  startedBefore?: Date;

  /** Maximum number of results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Manages active and historical agent sessions.
 */
export class SessionManager {
  private readonly eventBus: EventBus;
  private readonly sessions = new Map<string, SessionInfo>();

  /**
   * Creates a new SessionManager.
   *
   * @param eventBus - The daemon's internal event bus
   */
  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a new session.
   *
   * @param session - Session metadata to register
   * @throws If a session with the same ID already exists
   *
   * TODO: Persist session to disk for restart recovery
   * TODO: Emit session registration event
   */
  registerSession(session: SessionInfo): void {
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`Session "${session.sessionId}" already exists`);
    }
    this.sessions.set(session.sessionId, session);
  }

  /**
   * Update an existing session's metadata.
   *
   * @param sessionId - The session to update
   * @param updates - Partial session info to merge
   * @throws If the session does not exist
   *
   * TODO: Persist updated session state
   */
  updateSession(
    sessionId: string,
    updates: Partial<Omit<SessionInfo, "sessionId">>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    Object.assign(session, updates);
  }

  /**
   * Get a session by ID.
   *
   * @param sessionId - The session identifier
   * @returns Session info, or undefined if not found
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List sessions matching the given filter.
   *
   * @param filter - Filter criteria (all optional, ANDed together)
   * @returns Array of matching sessions
   *
   * TODO: Implement filter logic (projectId, agentProvider, status, date range)
   * TODO: Support pagination via limit/offset
   * TODO: Sort by startedAt descending by default
   */
  listSessions(filter?: SessionFilter): SessionInfo[] {
    // TODO: Apply filters
    // TODO: Apply pagination
    return Array.from(this.sessions.values());
  }

  /**
   * Get all active sessions.
   *
   * @returns Array of sessions with status "active"
   */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "active",
    );
  }

  /**
   * Mark a session as completed.
   *
   * @param sessionId - The session to complete
   *
   * TODO: Set endedAt timestamp
   * TODO: Update status to "completed"
   * TODO: Persist final state
   */
  completeSession(sessionId: string): void {
    this.updateSession(sessionId, {
      status: "completed",
      endedAt: new Date(),
    });
  }

  /**
   * Chain a new session from an existing one.
   *
   * Used when switching agents mid-workflow (e.g., Claude Code -> OpenCode).
   *
   * @param parentSessionId - The session being continued from
   * @param childSession - The new session metadata
   *
   * TODO: Link sessions via chainedFrom field
   * TODO: Copy relevant context from parent to child
   */
  chainSession(parentSessionId: string, childSession: SessionInfo): void {
    childSession.chainedFrom = parentSessionId;
    this.registerSession(childSession);
  }

  /**
   * Load persisted session state from disk.
   *
   * Called during daemon startup to recover session state.
   *
   * @param baseDir - Base directory for session persistence files
   *
   * TODO: Scan session persistence files
   * TODO: Load and register each persisted session
   * TODO: Mark stale sessions as "error" if daemon crashed
   */
  async loadPersistedState(baseDir: string): Promise<void> {
    // TODO: Implement persistence recovery
  }

  /**
   * Persist all in-memory session state to disk.
   *
   * Called during daemon shutdown.
   *
   * TODO: Write each session to its persistence file
   */
  async persistState(): Promise<void> {
    // TODO: Implement state persistence
  }

  /**
   * Returns the total number of tracked sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
