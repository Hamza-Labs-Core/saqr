/**
 * Unified Event Envelope for the Saqr Agent Management Platform.
 *
 * Every event captured by any agent integration is wrapped in this structure
 * before being written to the event store. The envelope is backward-compatible
 * with the original GlobalContext 7-field format (event_id, event_type,
 * project_id, session_id, sequence, timestamp, data) and adds three
 * agent-specific fields: agent_provider, agent_native_event, agent_metadata.
 *
 * @module events/envelope
 */

import type { AgentProvider } from "../agents/types.js";
import type { UnifiedEventType } from "./types.js";

// ---------------------------------------------------------------------------
// Agent Metadata
// ---------------------------------------------------------------------------

/**
 * Agent-specific metadata included in every unified event.
 * Provides context about the agent that produced the event.
 */
export interface AgentMetadata {
  /** Agent name and version, e.g. "claude-code/1.0.38". */
  agent_version?: string;

  /** Model being used, e.g. "claude-opus-4-6". */
  model?: string;

  /** PID of the agent process, for correlation. */
  agent_pid?: number;

  /** Working directory of the agent. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Unified Event Envelope
// ---------------------------------------------------------------------------

/**
 * The unified event envelope wrapping all agent events.
 *
 * This is the canonical format for every event in the Saqr event store.
 * It extends the original GlobalContext 7-field envelope with three
 * additive fields for multi-agent support. Existing projections that
 * only read the original 7 fields continue to work without modification.
 *
 * **Original 7 fields** (from GlobalContext Story 01):
 * - `event_id` - UUID v4, globally unique
 * - `event_type` - one of the 12 unified event types
 * - `project_id` - project identifier ({basename}-{hash6})
 * - `session_id` - session identifier from the agent
 * - `sequence` - per-session monotonically increasing counter
 * - `timestamp` - ISO 8601 UTC with millisecond precision
 * - `data` - complete, unmodified payload from the agent
 *
 * **New fields** (added for multi-agent support):
 * - `agent_provider` - which agent integration produced this event
 * - `agent_native_event` - agent's native event type before normalization
 * - `agent_metadata` - agent-specific metadata (model, version, etc.)
 */
export interface UnifiedEvent {
  /** UUID v4, globally unique identifier for this event. */
  event_id: string;

  /** One of the 12 unified event types. */
  event_type: UnifiedEventType;

  /**
   * Project identifier using the format `{basename}-{hash6}`.
   * Multiple agents working on the same project share the same project_id.
   */
  project_id: string;

  /** Session identifier from the agent. */
  session_id: string;

  /**
   * Per-session monotonically increasing counter (1-based).
   * Each session maintains its own independent sequence.
   */
  sequence: number;

  /** ISO 8601 UTC timestamp with millisecond precision. */
  timestamp: string;

  /**
   * Which agent integration produced this event.
   * Used to differentiate events from different agents in the same project.
   */
  agent_provider: AgentProvider;

  /**
   * The agent's native event type before normalization to a unified type.
   * For example, Claude Code's "PostToolUse" maps to "ToolCallCompleted".
   */
  agent_native_event: string;

  /**
   * Agent-specific metadata: version, model, PID, working directory.
   */
  agent_metadata: AgentMetadata;

  /**
   * The complete, unmodified payload from the agent's native hook.
   * The event store preserves this verbatim; all interpretation
   * happens downstream in projections and the query layer.
   */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory Helpers
// ---------------------------------------------------------------------------

/**
 * Parameters for creating a new unified event envelope.
 * Omits `event_id` and `timestamp` which are generated automatically.
 */
export interface CreateUnifiedEventParams {
  /** One of the 12 unified event types. */
  event_type: UnifiedEventType;
  /** Project identifier ({basename}-{hash6}). */
  project_id: string;
  /** Session identifier from the agent. */
  session_id: string;
  /** Per-session sequence number (1-based). */
  sequence: number;
  /** Which agent produced this event. */
  agent_provider: AgentProvider;
  /** The agent's native event type before normalization. */
  agent_native_event: string;
  /** Agent metadata (model, version, PID, cwd). */
  agent_metadata: AgentMetadata;
  /** The raw payload from the agent's native hook system. */
  data: Record<string, unknown>;
}

/**
 * Creates a new {@link UnifiedEvent} with auto-generated `event_id` and `timestamp`.
 *
 * @param params - The event fields (excluding auto-generated ones).
 * @returns A fully-formed unified event envelope.
 */
export function createUnifiedEvent(params: CreateUnifiedEventParams): UnifiedEvent {
  return {
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...params,
  };
}
