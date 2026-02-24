/**
 * SDK AgentStreamEvent Normalization.
 *
 * Converts SDK streaming events into TimelineItem[] for rendering.
 * This function is pure -- no side effects, deterministic output.
 *
 * @module normalization/normalizeSDKEvent
 */

import type {
  TimelineItem,
  AssistantMessage,
  ThinkingBlock,
  ErrorItem,
  ToolCall,
} from "../types/timeline.js";

// ---------------------------------------------------------------------------
// SDK Event Types (minimal type definitions for what we need)
// ---------------------------------------------------------------------------

/**
 * Minimal type definitions for SDK AgentStreamEvent variants.
 * These cover the streaming protocol messages from the Claude SDK.
 */
export type SDKStreamEvent =
  | SDKMessageStart
  | SDKContentBlockStart
  | SDKContentBlockDelta
  | SDKContentBlockStop
  | SDKMessageDelta
  | SDKMessageStop
  | SDKError;

interface SDKMessageStart {
  type: "message_start";
  timestamp?: string;
  message: {
    id: string;
    model: string;
    role: string;
  };
}

interface SDKContentBlockStart {
  type: "content_block_start";
  timestamp?: string;
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
}

interface SDKContentBlockDelta {
  type: "content_block_delta";
  timestamp?: string;
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "input_json_delta"; partial_json: string };
}

interface SDKContentBlockStop {
  type: "content_block_stop";
  timestamp?: string;
  index: number;
}

interface SDKMessageDelta {
  type: "message_delta";
  timestamp?: string;
  delta: {
    stop_reason: string;
  };
  usage?: {
    output_tokens: number;
  };
}

interface SDKMessageStop {
  type: "message_stop";
  timestamp?: string;
}

interface SDKError {
  type: "error";
  timestamp?: string;
  error: {
    type: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Sequence derivation
// ---------------------------------------------------------------------------

/**
 * Derive a sequence number from an existing items map.
 * Returns the next available sequence (max + 1).
 * This keeps the normalizer pure -- no module-level mutable state.
 */
function deriveNextSequence(existingItems: ReadonlyMap<string, TimelineItem>): number {
  let maxSeq = 0;
  for (const item of existingItems.values()) {
    if (item.sequence > maxSeq) {
      maxSeq = item.sequence;
    }
  }
  return maxSeq + 1;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Converts an SDK stream event into TimelineItem(s).
 *
 * @param event - The SDK stream event.
 * @param existingItems - Map of existing timeline items (for correlation/update).
 * @returns Array of new or updated TimelineItem instances.
 */
export function normalizeSDKEvent(
  event: SDKStreamEvent,
  existingItems: ReadonlyMap<string, TimelineItem>,
): TimelineItem[] {
  const timestamp = event.timestamp ?? new Date().toISOString();
  const nextSeq = deriveNextSequence(existingItems);

  switch (event.type) {
    case "message_start":
      return handleMessageStart(event, timestamp, nextSeq);

    case "content_block_start":
      return handleContentBlockStart(event, timestamp, nextSeq);

    case "content_block_delta":
      return handleContentBlockDelta(event, timestamp, existingItems, nextSeq);

    case "content_block_stop":
      // Block finalization. Currently a no-op since we update on deltas.
      return [];

    case "message_delta":
      return handleMessageDelta(event, existingItems);

    case "message_stop":
      // Final stop marker. No items to produce.
      return [];

    case "error":
      return handleError(event, timestamp, nextSeq);

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleMessageStart(
  event: SDKMessageStart,
  timestamp: string,
  sequence: number,
): TimelineItem[] {
  const msg: AssistantMessage = {
    id: event.message.id,
    timestamp,
    sequence,
    source: "sdk_stream",
    read: false,
    type: "assistant_message",
    text: "",
    streamingState: "streaming",
    hasMarkdown: false,
    model: event.message.model,
    outputTokens: null,
  };
  return [msg];
}

function handleContentBlockStart(
  event: SDKContentBlockStart,
  timestamp: string,
  sequence: number,
): TimelineItem[] {
  const block = event.content_block;

  if (block.type === "thinking") {
    const thinkingBlock: ThinkingBlock = {
      id: `thinking-${event.index}-${timestamp}`,
      timestamp,
      sequence,
      source: "sdk_stream",
      read: false,
      type: "thinking_block",
      text: block.thinking || "",
      streamingState: "streaming",
      durationMs: null,
    };
    return [thinkingBlock];
  }

  if (block.type === "tool_use") {
    const toolCall: ToolCall = {
      id: block.id,
      timestamp,
      sequence,
      source: "sdk_stream",
      read: false,
      type: "tool_call",
      toolUseId: block.id,
      toolName: "Read",
      status: "pending",
      durationMs: null,
      error: null,
      input: { filePath: "" },
      output: null,
    } as ToolCall;

    return [mapToolCallByName(toolCall, block.name, block.input)];
  }

  // text content blocks don't produce new items; they append to the current message
  return [];
}

function handleContentBlockDelta(
  event: SDKContentBlockDelta,
  timestamp: string,
  existingItems: ReadonlyMap<string, TimelineItem>,
  sequence: number,
): TimelineItem[] {
  const delta = event.delta;

  if (delta.type === "text_delta") {
    const existingMsg = findLatestOfType(existingItems, "assistant_message") as AssistantMessage | undefined;
    if (existingMsg) {
      const updated: AssistantMessage = {
        ...existingMsg,
        text: existingMsg.text + delta.text,
        hasMarkdown: containsMarkdown(existingMsg.text + delta.text),
      };
      return [updated];
    }
    return [{
      id: `msg-delta-${timestamp}`,
      timestamp,
      sequence,
      source: "sdk_stream",
      read: false,
      type: "assistant_message",
      text: delta.text,
      streamingState: "streaming",
      hasMarkdown: false,
      model: "unknown",
      outputTokens: null,
    }];
  }

  if (delta.type === "thinking_delta") {
    const existingThinking = findLatestOfType(existingItems, "thinking_block") as ThinkingBlock | undefined;
    if (existingThinking) {
      const updated: ThinkingBlock = {
        ...existingThinking,
        text: existingThinking.text + delta.thinking,
      };
      return [updated];
    }
    return [{
      id: `thinking-delta-${timestamp}`,
      timestamp,
      sequence,
      source: "sdk_stream",
      read: false,
      type: "thinking_block",
      text: delta.thinking,
      streamingState: "streaming",
      durationMs: null,
    }];
  }

  // input_json_delta is for tool input streaming, skip for now
  return [];
}

function handleMessageDelta(
  event: SDKMessageDelta,
  existingItems: ReadonlyMap<string, TimelineItem>,
): TimelineItem[] {
  const existingMsg = findLatestOfType(existingItems, "assistant_message") as AssistantMessage | undefined;
  if (existingMsg) {
    const updated: AssistantMessage = {
      ...existingMsg,
      streamingState: "completed",
      outputTokens: event.usage?.output_tokens ?? null,
    };
    return [updated];
  }
  return [];
}

function handleError(event: SDKError, timestamp: string, sequence: number): TimelineItem[] {
  const errorItem: ErrorItem = {
    id: `error-${timestamp}`,
    timestamp,
    sequence,
    source: "sdk_stream",
    read: false,
    type: "error",
    message: event.error.message,
    stackTrace: null,
    isRecoverable: event.error.type !== "invalid_request_error",
    errorSource: "system",
  };
  return [errorItem];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function findLatestOfType(
  items: ReadonlyMap<string, TimelineItem>,
  type: string,
): TimelineItem | undefined {
  let latest: TimelineItem | undefined;
  for (const item of items.values()) {
    if (item.type === type) {
      if (!latest || item.sequence > latest.sequence) {
        latest = item;
      }
    }
  }
  return latest;
}

function mapToolCallByName(
  base: ToolCall,
  name: string,
  input: Record<string, unknown>,
): ToolCall {
  const commonFields = {
    id: base.id,
    timestamp: base.timestamp,
    sequence: base.sequence,
    source: base.source as "sdk_stream",
    read: base.read,
    type: "tool_call" as const,
    toolUseId: base.toolUseId,
    status: base.status as "pending",
    durationMs: base.durationMs,
    error: base.error,
  };

  switch (name) {
    case "Read":
      return {
        ...commonFields,
        toolName: "Read",
        input: { filePath: typeof input.file_path === "string" ? input.file_path : "" },
        output: null,
      };
    case "Edit":
      return {
        ...commonFields,
        toolName: "Edit",
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          oldString: typeof input.old_string === "string" ? input.old_string : "",
          newString: typeof input.new_string === "string" ? input.new_string : "",
        },
        output: null,
      };
    case "Write":
      return {
        ...commonFields,
        toolName: "Write",
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          content: typeof input.content === "string" ? input.content : "",
        },
        output: null,
      };
    case "Bash":
      return {
        ...commonFields,
        toolName: "Bash",
        input: { command: typeof input.command === "string" ? input.command : "" },
        output: null,
      };
    case "Glob":
      return {
        ...commonFields,
        toolName: "Glob",
        input: { pattern: typeof input.pattern === "string" ? input.pattern : "" },
        output: null,
      };
    case "Grep":
      return {
        ...commonFields,
        toolName: "Grep",
        input: { pattern: typeof input.pattern === "string" ? input.pattern : "" },
        output: null,
      };
    case "WebFetch":
      return {
        ...commonFields,
        toolName: "WebFetch",
        input: {
          url: typeof input.url === "string" ? input.url : "",
          prompt: typeof input.prompt === "string" ? input.prompt : "",
        },
        output: null,
      };
    case "Task":
      return {
        ...commonFields,
        toolName: "Task",
        input: { prompt: typeof input.prompt === "string" ? input.prompt : "" },
        output: null,
      };
    default:
      return {
        ...commonFields,
        toolName: "Read",
        input: { filePath: name },
        output: null,
      };
  }
}

function containsMarkdown(text: string): boolean {
  if (!text) return false;
  return /^#{1,6}\s|^\*\*|^- |^\d+\.\s|```|`[^`]+`|\[.+\]\(.+\)/m.test(text);
}
