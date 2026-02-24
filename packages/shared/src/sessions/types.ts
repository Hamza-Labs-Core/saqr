/**
 * Session Types for the Saqr Agent Management Platform.
 *
 * Defines how the platform observes and manages agent sessions,
 * including session modes, state tracking, and metadata.
 *
 * @module sessions/types
 */

import type { AgentLifecycleState, AgentProvider } from "../agents/types.js";

// ---------------------------------------------------------------------------
// Session Modes
// ---------------------------------------------------------------------------

/**
 * The mode in which the platform interacts with an agent session.
 *
 * - `"observed"` - Passively captures events via hooks without controlling the agent.
 *   The agent was started independently (e.g., by the user running `claude` directly),
 *   and Saqr only records its activity.
 *
 * - `"managed"` - The platform spawned and controls the agent session. Full lifecycle
 *   management including sending prompts, handling permissions, and terminating.
 *
 * - `"resumed"` - A previously managed or observed session that was re-attached after
 *   the daemon restarted or the user explicitly resumed it. Context recovery may have
 *   been applied.
 */
export type SessionMode = "observed" | "managed" | "resumed";

/**
 * Array of all valid session modes.
 */
export const SESSION_MODES: readonly SessionMode[] = [
  "observed",
  "managed",
  "resumed",
] as const;

/**
 * Type guard that checks if a string is a valid {@link SessionMode}.
 *
 * @param value - The string to check.
 * @returns `true` if the value is a recognized session mode.
 */
export function isSessionMode(value: string): value is SessionMode {
  return (SESSION_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

/**
 * Complete runtime state for a tracked agent session.
 *
 * This is the live, in-memory representation maintained by the daemon.
 * It combines agent lifecycle state with session metadata and metrics.
 */
export interface SessionState {
  /** The unique session identifier. */
  sessionId: string;

  /** The agent provider running this session. */
  provider: AgentProvider;

  /** How the platform is interacting with this session. */
  mode: SessionMode;

  /** The current lifecycle state of the agent. */
  lifecycleState: AgentLifecycleState;

  /**
   * Project identifier ({basename}-{hash6}) this session belongs to.
   * Multiple sessions can belong to the same project.
   */
  projectId: string;

  /** The working directory of the agent. */
  cwd: string;

  /** The model being used in this session. */
  model?: string;

  /** ISO 8601 UTC timestamp when the session started. */
  startedAt: string;

  /** ISO 8601 UTC timestamp when the session ended, if it has ended. */
  endedAt?: string;

  /** The last event sequence number received for this session. */
  lastSequence: number;

  /** The last user prompt submitted in this session. */
  lastPrompt?: string;

  /** ISO 8601 UTC timestamp of the last event received. */
  lastEventAt?: string;

  /** PID of the agent process, if known. */
  agentPid?: number;

  /** Identifier of the parent session, if this is a sub-agent session. */
  parentSessionId?: string;

  /** Cumulative input tokens consumed in this session. */
  totalInputTokens: number;

  /** Cumulative output tokens produced in this session. */
  totalOutputTokens: number;

  /** Number of tool calls made in this session. */
  toolCallCount: number;

  /** Number of errors encountered in this session. */
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Session Metadata (Persisted)
// ---------------------------------------------------------------------------

/**
 * Persisted session metadata stored alongside events in the event store.
 *
 * This is the `session.json` file written to:
 * `~/.agentctx/events/{project-id}/{session-id}/session.json`
 *
 * It provides a quick summary of a session without needing to replay all events.
 */
export interface SessionMetadata {
  /** The unique session identifier. */
  sessionId: string;

  /** The agent provider that ran this session. */
  provider: AgentProvider;

  /** How the platform interacted with this session. */
  mode: SessionMode;

  /** The project identifier this session belongs to. */
  projectId: string;

  /** The working directory where the agent operated. */
  cwd: string;

  /** The model used in this session. */
  model?: string;

  /** ISO 8601 UTC timestamp when the session started. */
  startedAt: string;

  /** ISO 8601 UTC timestamp when the session ended. */
  endedAt?: string;

  /** Total number of events captured in this session. */
  eventCount: number;

  /** The last user prompt submitted. */
  lastPrompt?: string;

  /** Agent version string, e.g., "claude-code/1.0.38". */
  agentVersion?: string;

  /** Cumulative input tokens consumed. */
  totalInputTokens: number;

  /** Cumulative output tokens produced. */
  totalOutputTokens: number;

  /** Number of tool calls made. */
  toolCallCount: number;

  /** Whether the session ended normally or with an error. */
  exitStatus?: "normal" | "error" | "timeout" | "interrupted";

  /**
   * Parent session ID for sub-agent sessions.
   * Used for session chaining and context recovery.
   */
  parentSessionId?: string;

  /**
   * Machine identifier, for distinguishing sessions across machines in sync.
   */
  machineId?: string;
}
