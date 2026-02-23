/**
 * TimelineItem Type System for CLI Session Rendering.
 *
 * Defines the complete discriminated union type system that converts
 * all event sources into a unified renderable format. Each item variant
 * maps to a dedicated rendering component.
 *
 * @module types/timeline
 */

// ---------------------------------------------------------------------------
// TimelineItemBase
// ---------------------------------------------------------------------------

/**
 * Source of a timeline item, indicating which event pipeline produced it.
 */
export type TimelineItemSource = "gc_hook" | "sdk_stream" | "pty";

/**
 * Base fields shared by all timeline items.
 * Every item in the session timeline extends this interface.
 */
export interface TimelineItemBase {
  /** Unique identifier for this item (event_id from GC, or generated UUID). */
  id: string;
  /** ISO 8601 UTC timestamp of when this item occurred. */
  timestamp: string;
  /** Monotonically increasing sequence number within the session. */
  sequence: number;
  /** Source of this item for rendering hints. */
  source: TimelineItemSource;
  /** Whether this item has been read/seen by the user. */
  read: boolean;
}

/**
 * Parameters for creating a TimelineItemBase with sensible defaults.
 */
export interface CreateTimelineItemBaseParams {
  id?: string;
  timestamp?: string;
  sequence?: number;
  source: TimelineItemSource;
  read?: boolean;
}

/**
 * Creates a TimelineItemBase with auto-generated id and timestamp if not provided.
 */
export function createTimelineItemBase(params: CreateTimelineItemBaseParams): TimelineItemBase {
  return {
    id: params.id ?? crypto.randomUUID(),
    timestamp: params.timestamp ?? new Date().toISOString(),
    sequence: params.sequence ?? 0,
    source: params.source,
    read: params.read ?? false,
  };
}

// ---------------------------------------------------------------------------
// Message Types
// ---------------------------------------------------------------------------

/**
 * User's prompt message.
 * Displayed as a right-aligned chat bubble.
 */
export interface UserMessage extends TimelineItemBase {
  type: "user_message";
  /** The full text of the user's prompt. */
  text: string;
  /** Whether the prompt included file attachments. */
  hasAttachments: boolean;
  /** Attached file paths, if any. */
  attachments: string[];
}

/**
 * Claude's response message.
 * Supports both streaming (partial) and completed states.
 */
export interface AssistantMessage extends TimelineItemBase {
  type: "assistant_message";
  /** The response text (partial during streaming, complete when done). */
  text: string;
  /** Current streaming state. */
  streamingState: "streaming" | "completed" | "interrupted";
  /** Whether the response contains markdown that needs rendering. */
  hasMarkdown: boolean;
  /** Model that generated this response. */
  model: string;
  /** Token count for this response (available after completion). */
  outputTokens: number | null;
}

/**
 * Claude's thinking/reasoning block.
 * Shown as a collapsible card with subtle animation during streaming.
 */
export interface ThinkingBlock extends TimelineItemBase {
  type: "thinking_block";
  /** The thinking text (may be partial during streaming). */
  text: string;
  /** Current streaming state. */
  streamingState: "streaming" | "completed";
  /** Duration of thinking in milliseconds (available after completion). */
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Tool Call Types (sub-discriminated union)
// ---------------------------------------------------------------------------

/**
 * Tool call base interface. All tool calls share these fields.
 */
export interface ToolCallBase extends TimelineItemBase {
  type: "tool_call";
  /** Unique tool_use_id for correlating request/response. */
  toolUseId: string;
  /** Execution status. */
  status: "pending" | "running" | "completed" | "failed";
  /** Duration in milliseconds (available after completion). */
  durationMs: number | null;
  /** Error message if status is 'failed'. */
  error: string | null;
}

export interface ToolCallRead extends ToolCallBase {
  toolName: "Read";
  input: {
    filePath: string;
    offset?: number;
    limit?: number;
  };
  output: {
    content: string | null;
    lineCount: number | null;
    language: string | null;
  } | null;
}

export interface ToolCallEdit extends ToolCallBase {
  toolName: "Edit";
  input: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  };
  output: {
    diff: string | null;
    language: string | null;
  } | null;
}

export interface ToolCallWrite extends ToolCallBase {
  toolName: "Write";
  input: {
    filePath: string;
    content: string;
  };
  output: {
    bytesWritten: number | null;
    language: string | null;
  } | null;
}

export interface ToolCallBash extends ToolCallBase {
  toolName: "Bash";
  input: {
    command: string;
    timeout?: number;
    description?: string;
  };
  output: {
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
  } | null;
}

export interface ToolCallGlob extends ToolCallBase {
  toolName: "Glob";
  input: {
    pattern: string;
    path?: string;
  };
  output: {
    matches: string[];
    matchCount: number;
  } | null;
}

export interface ToolCallGrep extends ToolCallBase {
  toolName: "Grep";
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    outputMode?: string;
  };
  output: {
    matches: Array<{ file: string; line: number; content: string }>;
    matchCount: number;
  } | null;
}

export interface ToolCallWebFetch extends ToolCallBase {
  toolName: "WebFetch";
  input: {
    url: string;
    prompt: string;
  };
  output: {
    summary: string | null;
    statusCode: number | null;
  } | null;
}

export interface ToolCallTask extends ToolCallBase {
  toolName: "Task";
  input: {
    prompt: string;
    description?: string;
  };
  output: {
    result: string | null;
    /** Nested timeline items from the subagent. */
    nestedTimeline: TimelineItem[];
  } | null;
}

/**
 * Discriminated union of all tool call types.
 */
export type ToolCall =
  | ToolCallRead
  | ToolCallEdit
  | ToolCallWrite
  | ToolCallBash
  | ToolCallGlob
  | ToolCallGrep
  | ToolCallWebFetch
  | ToolCallTask;

// ---------------------------------------------------------------------------
// Other Timeline Item Types
// ---------------------------------------------------------------------------

/**
 * Permission request from the agent.
 */
export interface PermissionRequest extends TimelineItemBase {
  type: "permission_request";
  toolName: string;
  description: string;
  filePath: string | null;
  toolInput: Record<string, unknown>;
  resolution: "pending" | "allowed" | "denied" | "always_allowed" | "timed_out";
  resolvedAt: string | null;
}

/**
 * Permission that was automatically allowed.
 */
export interface PermissionResolved extends TimelineItemBase {
  type: "permission_resolved";
  toolName: string;
  filePath: string | null;
  rule: string;
}

/**
 * Error from the agent or system.
 */
export interface ErrorItem extends TimelineItemBase {
  type: "error";
  message: string;
  stackTrace: string | null;
  isRecoverable: boolean;
  errorSource: "agent" | "tool" | "system" | "network";
}

/**
 * System notification category.
 */
export type SystemNotificationCategory =
  | "session_start"
  | "session_end"
  | "model_change"
  | "context_clear"
  | "agent_spawned"
  | "agent_completed";

/**
 * System notification (e.g., session started, model changed).
 */
export interface SystemNotification extends TimelineItemBase {
  type: "system_notification";
  category: SystemNotificationCategory;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * Compact notification -- context window was compacted.
 */
export interface CompactNotification extends TimelineItemBase {
  type: "compact_notification";
  tokensBefore: number;
  tokensAfter: number;
  trigger: "auto" | "manual";
}

/**
 * Usage update -- cost, tokens, context window status.
 */
export interface UsageUpdate extends TimelineItemBase {
  type: "usage_update";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCostUsd: number;
  contextWindowUsage: number;
  contextWindowMax: number;
}

// ---------------------------------------------------------------------------
// Discriminated Union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all timeline item types.
 */
export type TimelineItem =
  | UserMessage
  | AssistantMessage
  | ThinkingBlock
  | ToolCall
  | PermissionRequest
  | PermissionResolved
  | ErrorItem
  | SystemNotification
  | CompactNotification
  | UsageUpdate;

/**
 * All possible type discriminator values.
 */
export type TimelineItemType = TimelineItem["type"];

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

export function isUserMessage(item: TimelineItem): item is UserMessage {
  return item.type === "user_message";
}

export function isAssistantMessage(item: TimelineItem): item is AssistantMessage {
  return item.type === "assistant_message";
}

export function isThinkingBlock(item: TimelineItem): item is ThinkingBlock {
  return item.type === "thinking_block";
}

export function isToolCall(item: TimelineItem): item is ToolCall {
  return item.type === "tool_call";
}

export function isPermissionRequest(item: TimelineItem): item is PermissionRequest {
  return item.type === "permission_request";
}

export function isPermissionResolved(item: TimelineItem): item is PermissionResolved {
  return item.type === "permission_resolved";
}

export function isErrorItem(item: TimelineItem): item is ErrorItem {
  return item.type === "error";
}

export function isSystemNotification(item: TimelineItem): item is SystemNotification {
  return item.type === "system_notification";
}

export function isCompactNotification(item: TimelineItem): item is CompactNotification {
  return item.type === "compact_notification";
}

export function isUsageUpdate(item: TimelineItem): item is UsageUpdate {
  return item.type === "usage_update";
}
