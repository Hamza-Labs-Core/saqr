/**
 * Agent Types for the Saqr Mobile App.
 *
 * Defines agent view models for the unified agent list, including
 * status, token usage, and streaming event types.
 *
 * @module types/agent
 */

/** Lifecycle states for an agent as viewed from the mobile app. */
export type AgentStatus =
  | "initializing"
  | "idle"
  | "running"
  | "waiting_permission"
  | "error"
  | "completed"
  | "disconnected";

/** Token usage summary for an agent. */
export interface TokenUsage {
  /** Total input tokens consumed. */
  inputTokens: number;
  /** Total output tokens produced. */
  outputTokens: number;
  /** Tokens served from cache reads. */
  cacheReadTokens: number;
  /** Estimated cost in USD. */
  estimatedCost: number;
}

/** Summary view model for an agent in the unified list. */
export interface AgentSummary {
  /** Unique agent ID from the daemon. */
  id: string;
  /** ID of the daemon hosting this agent. */
  hostId: string;
  /** Human-readable daemon name. */
  hostName: string;
  /** Which agent provider is running. */
  provider: "claude-code" | "opencode" | "codex";
  /** Model identifier (e.g., "claude-opus-4-6"). */
  model: string;
  /** Current lifecycle status. */
  status: AgentStatus;
  /** Project name (basename of working directory). */
  projectName: string;
  /** Full project path on the remote machine. */
  projectPath: string;
  /** Brief current activity description. */
  currentActivity?: string;
  /** Truncated last user prompt (first 100 chars). */
  lastPrompt?: string;
  /** Session ID for this agent. */
  sessionId: string;
  /** ISO 8601 timestamp when the agent started. */
  startedAt: string;
  /** ISO 8601 timestamp of last activity. */
  lastActivityAt: string;
  /** Token usage summary. */
  tokenUsage: TokenUsage;
  /** Count of pending permission requests. */
  pendingPermissions: number;
}

/** Sort fields for the agent list. */
export type AgentSortField = "lastActivity" | "machine" | "status" | "project";

/** Sort direction. */
export type SortDirection = "asc" | "desc";

/** Filter criteria for the agent list. */
export interface AgentListFilter {
  /** Filter by specific machine, null for all. */
  machineId: string | null;
  /** Filter by provider, null for all. */
  provider: string | null;
  /** Filter by status, null for all. */
  status: AgentStatus | null;
}

/** Streaming event from a daemon about agent activity. */
export interface AgentStreamEvent {
  /** Type of the stream event. */
  type: string;
  /** ID of the agent this event is about. */
  agentId: string;
  /** Event payload data. */
  data: Record<string, unknown>;
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: string;
}

/** A permission request from an agent. */
export interface PermissionRequest {
  /** Unique identifier for this tool use. */
  toolUseId: string;
  /** Name of the tool requesting permission. */
  toolName: string;
  /** Input parameters for the tool. */
  toolInput: Record<string, unknown>;
  /** Human-readable description of the action. */
  description: string;
  /** File path for file operations. */
  filePath?: string;
  /** Command for Bash operations. */
  command?: string;
  /** ISO 8601 timestamp of the request. */
  timestamp: string;
}
