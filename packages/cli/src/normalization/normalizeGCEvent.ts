/**
 * GC Event Normalization.
 *
 * Converts UnifiedEvent (from the GC hook JSONL event store) into
 * TimelineItem[] for rendering. This function is pure -- no side effects,
 * deterministic output for the same input.
 *
 * @module normalization/normalizeGCEvent
 */

import type { UnifiedEvent } from "@saqr/shared";
import type {
  TimelineItem,
  TimelineItemBase,
  UserMessage,
  AssistantMessage,
  ThinkingBlock,
  ToolCall,
  ToolCallRead,
  ToolCallEdit,
  ToolCallWrite,
  ToolCallBash,
  ToolCallGlob,
  ToolCallGrep,
  ToolCallWebFetch,
  ToolCallTask,
  PermissionRequest,
  SystemNotification,
  CompactNotification,
  ErrorItem,
  SystemNotificationCategory,
} from "../types/timeline.js";

/**
 * Converts a raw GC event into one or more TimelineItems.
 *
 * May return multiple items (e.g., a TurnCompleted can produce an
 * AssistantMessage plus a UsageUpdate).
 *
 * @param event - The unified event from the GC event store.
 * @param existingItems - Map of existing timeline items (for correlation).
 * @returns Array of new/updated TimelineItem instances.
 */
export function normalizeGCEvent(
  event: UnifiedEvent,
  existingItems: ReadonlyMap<string, TimelineItem>,
): TimelineItem[] {
  const base = makeBase(event);
  const data = event.data;

  switch (event.event_type) {
    case "SessionStarted":
      return [makeSystemNotification(base, "session_start", "Session started", {
        model: getStringField(data, "model"),
        cwd: getStringField(data, "cwd"),
      })];

    case "UserPromptReceived":
      return [makeUserMessage(base, data)];

    case "ToolCallRequested":
      return [makeToolCallFromRequested(base, data)];

    case "ToolCallCompleted":
      return [makeToolCallFromCompleted(base, data)];

    case "ToolCallFailed":
      return [makeToolCallFromFailed(base, data)];

    case "AgentSpawned":
      return [makeSystemNotification(base, "agent_spawned", `Sub-agent spawned: ${getStringField(data, "task") || getStringField(data, "subagent_id")}`, {
        subagent_id: getStringField(data, "subagent_id"),
        task: getStringField(data, "task"),
      })];

    case "AgentCompleted":
      return [makeSystemNotification(base, "agent_completed", `Sub-agent completed: ${getStringField(data, "subagent_id")}`, {
        subagent_id: getStringField(data, "subagent_id"),
        result: getStringField(data, "result"),
        success: data.success,
      })];

    case "TurnCompleted":
      return makeTurnCompletedItems(base, data);

    case "CompactionTriggered":
      return [makeCompactNotification(base, data)];

    case "SessionEnded":
      return [makeSystemNotification(base, "session_end", `Session ended${getStringField(data, "reason") ? `: ${getStringField(data, "reason")}` : ""}`, {
        reason: getStringField(data, "reason"),
      })];

    case "PermissionRequested":
      return [makePermissionRequest(base, data)];

    case "PermissionResponded":
      // PermissionResponded updates an existing permission_request but
      // we represent it as a system notification here
      return [makeSystemNotification(base, "session_start", `Permission ${data.granted ? "granted" : "denied"} for ${getStringField(data, "tool_name") || "unknown"}`, {
        permission_id: getStringField(data, "permission_id"),
        granted: data.granted,
      })];

    default:
      // Unknown event type: produce a SystemNotification fallback
      return [makeSystemNotification(base, "session_start", `Unknown event: ${event.event_type}`, {
        rawEvent: event,
      })];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase(event: UnifiedEvent): TimelineItemBase {
  return {
    id: event.event_id,
    timestamp: event.timestamp,
    sequence: event.sequence,
    source: "gc_hook",
    read: false,
  };
}

function getStringField(data: Record<string, unknown>, key: string): string {
  const val = data[key];
  return typeof val === "string" ? val : "";
}

function getNumberField(data: Record<string, unknown>, key: string): number {
  const val = data[key];
  return typeof val === "number" ? val : 0;
}

function makeSystemNotification(
  base: TimelineItemBase,
  category: SystemNotificationCategory,
  message: string,
  metadata: Record<string, unknown>,
): SystemNotification {
  return {
    ...base,
    type: "system_notification",
    category,
    message,
    metadata,
  };
}

function makeUserMessage(base: TimelineItemBase, data: Record<string, unknown>): UserMessage {
  const prompt = getStringField(data, "prompt");
  const attachments = Array.isArray(data.attachments)
    ? (data.attachments as string[]).filter((a) => typeof a === "string")
    : [];
  return {
    ...base,
    type: "user_message",
    text: prompt,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

function makeToolCallFromRequested(base: TimelineItemBase, data: Record<string, unknown>): ToolCall {
  const toolName = getStringField(data, "tool_name");
  const toolInput = (data.tool_input as Record<string, unknown>) ?? {};
  const toolUseId = getStringField(data, "tool_use_id") || `gen-${base.id}`;

  return buildToolCall(base, toolName, toolUseId, "running", toolInput, null, null, null);
}

function makeToolCallFromCompleted(base: TimelineItemBase, data: Record<string, unknown>): ToolCall {
  const toolName = getStringField(data, "tool_name");
  const toolInput = (data.tool_input as Record<string, unknown>) ?? {};
  const toolUseId = getStringField(data, "tool_use_id") || `gen-${base.id}`;
  const toolResponse = data.tool_response;

  return buildToolCall(base, toolName, toolUseId, "completed", toolInput, toolResponse, null, null);
}

function makeToolCallFromFailed(base: TimelineItemBase, data: Record<string, unknown>): ToolCall {
  const toolName = getStringField(data, "tool_name");
  const toolInput = (data.tool_input as Record<string, unknown>) ?? {};
  const toolUseId = getStringField(data, "tool_use_id") || `gen-${base.id}`;
  const errorMsg = getStringField(data, "error");

  return buildToolCall(base, toolName, toolUseId, "failed", toolInput, null, errorMsg, null);
}

function buildToolCall(
  base: TimelineItemBase,
  toolName: string,
  toolUseId: string,
  status: "pending" | "running" | "completed" | "failed",
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  error: string | null,
  durationMs: number | null,
): ToolCall {
  const commonBase = {
    ...base,
    type: "tool_call" as const,
    toolUseId,
    status,
    durationMs,
    error,
  };

  switch (toolName) {
    case "Read":
      return {
        ...commonBase,
        toolName: "Read",
        input: {
          filePath: typeof toolInput.file_path === "string" ? toolInput.file_path : "",
          offset: typeof toolInput.offset === "number" ? toolInput.offset : undefined,
          limit: typeof toolInput.limit === "number" ? toolInput.limit : undefined,
        },
        output: status === "completed" ? {
          content: typeof toolResponse === "string" ? toolResponse : null,
          lineCount: null,
          language: null,
        } : null,
      };

    case "Edit":
      return {
        ...commonBase,
        toolName: "Edit",
        input: {
          filePath: typeof toolInput.file_path === "string" ? toolInput.file_path : "",
          oldString: typeof toolInput.old_string === "string" ? toolInput.old_string : "",
          newString: typeof toolInput.new_string === "string" ? toolInput.new_string : "",
          replaceAll: typeof toolInput.replace_all === "boolean" ? toolInput.replace_all : undefined,
        },
        output: status === "completed" ? {
          diff: typeof toolResponse === "string" ? toolResponse : null,
          language: null,
        } : null,
      };

    case "Write":
      return {
        ...commonBase,
        toolName: "Write",
        input: {
          filePath: typeof toolInput.file_path === "string" ? toolInput.file_path : "",
          content: typeof toolInput.content === "string" ? toolInput.content : "",
        },
        output: status === "completed" ? {
          bytesWritten: null,
          language: null,
        } : null,
      };

    case "Bash":
      return {
        ...commonBase,
        toolName: "Bash",
        input: {
          command: typeof toolInput.command === "string" ? toolInput.command : "",
          timeout: typeof toolInput.timeout === "number" ? toolInput.timeout : undefined,
          description: typeof toolInput.description === "string" ? toolInput.description : undefined,
        },
        output: status === "completed" ? parseBashOutput(toolResponse) : null,
      };

    case "Glob":
      return {
        ...commonBase,
        toolName: "Glob",
        input: {
          pattern: typeof toolInput.pattern === "string" ? toolInput.pattern : "",
          path: typeof toolInput.path === "string" ? toolInput.path : undefined,
        },
        output: status === "completed" ? parseGlobOutput(toolResponse) : null,
      };

    case "Grep":
      return {
        ...commonBase,
        toolName: "Grep",
        input: {
          pattern: typeof toolInput.pattern === "string" ? toolInput.pattern : "",
          path: typeof toolInput.path === "string" ? toolInput.path : undefined,
          glob: typeof toolInput.glob === "string" ? toolInput.glob : undefined,
          outputMode: typeof toolInput.output_mode === "string" ? toolInput.output_mode : undefined,
        },
        output: status === "completed" ? parseGrepOutput(toolResponse) : null,
      };

    case "WebFetch":
      return {
        ...commonBase,
        toolName: "WebFetch",
        input: {
          url: typeof toolInput.url === "string" ? toolInput.url : "",
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
        },
        output: status === "completed" ? {
          summary: typeof toolResponse === "string" ? toolResponse : null,
          statusCode: null,
        } : null,
      };

    case "Task":
      return {
        ...commonBase,
        toolName: "Task",
        input: {
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
          description: typeof toolInput.description === "string" ? toolInput.description : undefined,
        },
        output: status === "completed" ? {
          result: typeof toolResponse === "string" ? toolResponse : null,
          nestedTimeline: [],
        } : null,
      };

    default:
      // Unknown tool: map to Read as a generic fallback
      return {
        ...commonBase,
        toolName: "Read",
        input: {
          filePath: typeof toolInput.file_path === "string" ? toolInput.file_path : toolName,
        },
        output: status === "completed" ? {
          content: typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse),
          lineCount: null,
          language: null,
        } : null,
      };
  }
}

function parseBashOutput(response: unknown): {
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
} {
  if (typeof response === "string") {
    return { stdout: response, stderr: null, exitCode: null };
  }
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : null,
      stderr: typeof r.stderr === "string" ? r.stderr : null,
      exitCode: typeof r.exit_code === "number" ? r.exit_code : null,
    };
  }
  return { stdout: null, stderr: null, exitCode: null };
}

function parseGlobOutput(response: unknown): {
  matches: string[];
  matchCount: number;
} {
  if (Array.isArray(response)) {
    const matches = response.filter((r): r is string => typeof r === "string");
    return { matches, matchCount: matches.length };
  }
  return { matches: [], matchCount: 0 };
}

function parseGrepOutput(response: unknown): {
  matches: Array<{ file: string; line: number; content: string }>;
  matchCount: number;
} {
  if (Array.isArray(response)) {
    const matches = response
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map((r) => ({
        file: typeof r.file === "string" ? r.file : "",
        line: typeof r.line === "number" ? r.line : 0,
        content: typeof r.content === "string" ? r.content : "",
      }));
    return { matches, matchCount: matches.length };
  }
  return { matches: [], matchCount: 0 };
}

function makeTurnCompletedItems(base: TimelineItemBase, data: Record<string, unknown>): TimelineItem[] {
  const items: TimelineItem[] = [];
  const responseText = getStringField(data, "response");
  const model = getStringField(data, "model") || "unknown";
  const outputTokens = typeof data.output_tokens === "number" ? data.output_tokens : null;

  const assistantMessage: AssistantMessage = {
    ...base,
    type: "assistant_message",
    text: responseText,
    streamingState: "completed",
    hasMarkdown: containsMarkdown(responseText),
    model,
    outputTokens,
  };
  items.push(assistantMessage);

  return items;
}

function makeCompactNotification(base: TimelineItemBase, data: Record<string, unknown>): CompactNotification {
  return {
    ...base,
    type: "compact_notification",
    tokensBefore: getNumberField(data, "tokens_before"),
    tokensAfter: getNumberField(data, "tokens_after"),
    trigger: data.trigger === "manual" ? "manual" : "auto",
  };
}

function makePermissionRequest(base: TimelineItemBase, data: Record<string, unknown>): PermissionRequest {
  const toolInput = (data.tool_input as Record<string, unknown>) ?? {};
  return {
    ...base,
    type: "permission_request",
    toolName: getStringField(data, "tool_name"),
    description: getStringField(data, "description"),
    filePath: typeof toolInput.file_path === "string" ? toolInput.file_path : null,
    toolInput,
    resolution: "pending",
    resolvedAt: null,
  };
}

/**
 * Simple heuristic to detect if text contains markdown.
 */
function containsMarkdown(text: string): boolean {
  if (!text) return false;
  return /^#{1,6}\s|^\*\*|^- |^\d+\.\s|```|`[^`]+`|\[.+\]\(.+\)/m.test(text);
}
