/**
 * Unified Event Type System for the Saqr Agent Management Platform.
 *
 * Defines the 12 unified event types that normalize across all supported
 * coding agents (Claude Code, OpenCode, Codex, and custom integrations).
 * Every event captured by any integration is mapped to one of these types
 * before being written to the event store.
 *
 * Uses discriminated unions keyed on the `type` field so consumers can
 * narrow to a specific event variant with a simple type guard.
 *
 * @module events/types
 */

// ---------------------------------------------------------------------------
// Unified Event Type Discriminator
// ---------------------------------------------------------------------------

/**
 * The 12 unified event types that all agent integrations normalize to.
 *
 * These types represent the complete lifecycle of an agent session,
 * from session start through tool usage, sub-agent management,
 * and session end.
 */
export type UnifiedEventType =
  | "SessionStarted"
  | "UserPromptReceived"
  | "ToolCallRequested"
  | "ToolCallCompleted"
  | "ToolCallFailed"
  | "AgentSpawned"
  | "AgentCompleted"
  | "TurnCompleted"
  | "CompactionTriggered"
  | "SessionEnded"
  | "PermissionRequested"
  | "PermissionResponded";

/**
 * Array of all unified event type strings, useful for runtime validation.
 */
export const UNIFIED_EVENT_TYPES: readonly UnifiedEventType[] = Object.freeze([
  "SessionStarted",
  "UserPromptReceived",
  "ToolCallRequested",
  "ToolCallCompleted",
  "ToolCallFailed",
  "AgentSpawned",
  "AgentCompleted",
  "TurnCompleted",
  "CompactionTriggered",
  "SessionEnded",
  "PermissionRequested",
  "PermissionResponded",
]);

// ---------------------------------------------------------------------------
// Event Payload Interfaces
// ---------------------------------------------------------------------------

/**
 * Payload for a `SessionStarted` event.
 * Emitted when an agent session begins.
 */
export interface SessionStartedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The working directory the agent was started in. */
  cwd?: string;
  /** The model being used for the session. */
  model?: string;
  /** Additional agent-specific session start data. */
  [key: string]: unknown;
}

/**
 * Payload for a `UserPromptReceived` event.
 * Emitted when the user submits a prompt to the agent.
 */
export interface UserPromptReceivedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The user's prompt text. */
  prompt: string;
  /** Whether this is a follow-up prompt in the same turn. */
  is_followup?: boolean;
  /** Additional agent-specific prompt data. */
  [key: string]: unknown;
}

/**
 * Payload for a `ToolCallRequested` event.
 * Emitted when the agent intends to invoke a tool.
 */
export interface ToolCallRequestedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The name of the tool being called. */
  tool_name: string;
  /** The input parameters for the tool call. */
  tool_input: Record<string, unknown>;
  /** Unique identifier for this tool use, for correlation with result. */
  tool_use_id?: string;
  /** Additional agent-specific tool request data. */
  [key: string]: unknown;
}

/**
 * Payload for a `ToolCallCompleted` event.
 * Emitted when a tool call finishes successfully.
 */
export interface ToolCallCompletedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The name of the tool that was called. */
  tool_name: string;
  /** The input parameters that were passed to the tool. */
  tool_input: Record<string, unknown>;
  /** The response from the tool. */
  tool_response: unknown;
  /** Unique identifier for this tool use, for correlation. */
  tool_use_id?: string;
  /** Additional agent-specific tool completion data. */
  [key: string]: unknown;
}

/**
 * Payload for a `ToolCallFailed` event.
 * Emitted when a tool call fails or is interrupted.
 */
export interface ToolCallFailedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The name of the tool that failed. */
  tool_name: string;
  /** The input parameters that were passed to the tool. */
  tool_input: Record<string, unknown>;
  /** Error message describing the failure. */
  error: string;
  /** Error code if available. */
  error_code?: string;
  /** Unique identifier for this tool use, for correlation. */
  tool_use_id?: string;
  /** Additional agent-specific tool failure data. */
  [key: string]: unknown;
}

/**
 * Payload for an `AgentSpawned` event.
 * Emitted when a sub-agent is created by the main agent.
 */
export interface AgentSpawnedPayload {
  /** The parent agent session identifier. */
  session_id: string;
  /** The sub-agent's session identifier. */
  subagent_id: string;
  /** The task or purpose assigned to the sub-agent. */
  task?: string;
  /** The model the sub-agent is using. */
  model?: string;
  /** Additional agent-specific spawn data. */
  [key: string]: unknown;
}

/**
 * Payload for an `AgentCompleted` event.
 * Emitted when a sub-agent finishes its work.
 */
export interface AgentCompletedPayload {
  /** The parent agent session identifier. */
  session_id: string;
  /** The sub-agent's session identifier. */
  subagent_id: string;
  /** The result or summary produced by the sub-agent. */
  result?: string;
  /** Whether the sub-agent completed successfully. */
  success?: boolean;
  /** Additional agent-specific completion data. */
  [key: string]: unknown;
}

/**
 * Payload for a `TurnCompleted` event.
 * Emitted when the agent finishes its response turn.
 */
export interface TurnCompletedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** Number of input tokens consumed in this turn. */
  input_tokens?: number;
  /** Number of output tokens produced in this turn. */
  output_tokens?: number;
  /** The stop reason for this turn. */
  stop_reason?: string;
  /** Additional agent-specific turn data. */
  [key: string]: unknown;
}

/**
 * Payload for a `CompactionTriggered` event.
 * Emitted when the agent's context is compacted/summarized.
 */
export interface CompactionTriggeredPayload {
  /** The agent session identifier. */
  session_id: string;
  /** Summary of the compacted context. */
  summary?: string;
  /** Number of messages before compaction. */
  messages_before?: number;
  /** Number of messages after compaction. */
  messages_after?: number;
  /** Additional agent-specific compaction data. */
  [key: string]: unknown;
}

/**
 * Payload for a `SessionEnded` event.
 * Emitted when the agent session ends.
 */
export interface SessionEndedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** The reason the session ended (e.g., "user_exit", "error", "timeout"). */
  reason?: string;
  /** Total input tokens consumed during the session. */
  total_input_tokens?: number;
  /** Total output tokens produced during the session. */
  total_output_tokens?: number;
  /** Duration of the session in milliseconds. */
  duration_ms?: number;
  /** Additional agent-specific session end data. */
  [key: string]: unknown;
}

/**
 * Payload for a `PermissionRequested` event.
 * Emitted when the agent requests permission for an action.
 */
export interface PermissionRequestedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** Unique identifier for this permission request, for correlation with response. */
  permission_id: string;
  /** The tool or action that needs permission. */
  tool_name: string;
  /** The input for the tool/action requiring permission. */
  tool_input: Record<string, unknown>;
  /** Human-readable description of what permission is being requested for. */
  description?: string;
  /** Additional agent-specific permission request data. */
  [key: string]: unknown;
}

/**
 * Payload for a `PermissionResponded` event.
 * Emitted when the user responds to a permission request.
 */
export interface PermissionRespondedPayload {
  /** The agent session identifier. */
  session_id: string;
  /** Unique identifier for the permission request this responds to. */
  permission_id: string;
  /** Whether permission was granted. */
  granted: boolean;
  /** Optional reason for the decision. */
  reason?: string;
  /** Additional agent-specific permission response data. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Discriminated Union: Typed Events
// ---------------------------------------------------------------------------

/**
 * Base fields shared by all typed event payloads.
 * Used internally for building the discriminated union.
 */
interface BaseTypedEvent<T extends UnifiedEventType, P> {
  /** Discriminator field: one of the 12 unified event types. */
  type: T;
  /** The event payload specific to this event type. */
  payload: P;
}

/** A session-started typed event. */
export type SessionStartedEvent = BaseTypedEvent<"SessionStarted", SessionStartedPayload>;

/** A user-prompt-received typed event. */
export type UserPromptReceivedEvent = BaseTypedEvent<"UserPromptReceived", UserPromptReceivedPayload>;

/** A tool-call-requested typed event. */
export type ToolCallRequestedEvent = BaseTypedEvent<"ToolCallRequested", ToolCallRequestedPayload>;

/** A tool-call-completed typed event. */
export type ToolCallCompletedEvent = BaseTypedEvent<"ToolCallCompleted", ToolCallCompletedPayload>;

/** A tool-call-failed typed event. */
export type ToolCallFailedEvent = BaseTypedEvent<"ToolCallFailed", ToolCallFailedPayload>;

/** An agent-spawned typed event. */
export type AgentSpawnedEvent = BaseTypedEvent<"AgentSpawned", AgentSpawnedPayload>;

/** An agent-completed typed event. */
export type AgentCompletedEvent = BaseTypedEvent<"AgentCompleted", AgentCompletedPayload>;

/** A turn-completed typed event. */
export type TurnCompletedEvent = BaseTypedEvent<"TurnCompleted", TurnCompletedPayload>;

/** A compaction-triggered typed event. */
export type CompactionTriggeredEvent = BaseTypedEvent<"CompactionTriggered", CompactionTriggeredPayload>;

/** A session-ended typed event. */
export type SessionEndedEvent = BaseTypedEvent<"SessionEnded", SessionEndedPayload>;

/** A permission-requested typed event. */
export type PermissionRequestedEvent = BaseTypedEvent<"PermissionRequested", PermissionRequestedPayload>;

/** A permission-responded typed event. */
export type PermissionRespondedEvent = BaseTypedEvent<"PermissionResponded", PermissionRespondedPayload>;

/**
 * Discriminated union of all 12 typed events.
 *
 * Use the `type` field to narrow to a specific event variant:
 *
 * ```typescript
 * function handleEvent(event: TypedEvent) {
 *   switch (event.type) {
 *     case "ToolCallCompleted":
 *       console.log(event.payload.tool_name); // narrowed to ToolCallCompletedPayload
 *       break;
 *     case "SessionStarted":
 *       console.log(event.payload.cwd); // narrowed to SessionStartedPayload
 *       break;
 *   }
 * }
 * ```
 */
export type TypedEvent =
  | SessionStartedEvent
  | UserPromptReceivedEvent
  | ToolCallRequestedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | AgentSpawnedEvent
  | AgentCompletedEvent
  | TurnCompletedEvent
  | CompactionTriggeredEvent
  | SessionEndedEvent
  | PermissionRequestedEvent
  | PermissionRespondedEvent;

/**
 * Maps an event type string to its corresponding payload interface.
 * Useful for generic functions that need to extract payloads by type.
 */
export interface EventPayloadMap {
  SessionStarted: SessionStartedPayload;
  UserPromptReceived: UserPromptReceivedPayload;
  ToolCallRequested: ToolCallRequestedPayload;
  ToolCallCompleted: ToolCallCompletedPayload;
  ToolCallFailed: ToolCallFailedPayload;
  AgentSpawned: AgentSpawnedPayload;
  AgentCompleted: AgentCompletedPayload;
  TurnCompleted: TurnCompletedPayload;
  CompactionTriggered: CompactionTriggeredPayload;
  SessionEnded: SessionEndedPayload;
  PermissionRequested: PermissionRequestedPayload;
  PermissionResponded: PermissionRespondedPayload;
}

// ---------------------------------------------------------------------------
// Utility: Runtime Validation
// ---------------------------------------------------------------------------

/**
 * Type guard that checks if a string is a valid {@link UnifiedEventType}.
 *
 * @param value - The string to check.
 * @returns `true` if the value is one of the 12 unified event types.
 */
export function isUnifiedEventType(value: string): value is UnifiedEventType {
  return (UNIFIED_EVENT_TYPES as readonly string[]).includes(value);
}
