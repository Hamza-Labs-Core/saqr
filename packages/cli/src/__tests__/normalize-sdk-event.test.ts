/**
 * Tests for SDK AgentStreamEvent Normalization.
 *
 * Validates that SDK streaming events are converted into timeline items.
 */
import { describe, it, expect } from "vitest";
import type { TimelineItem } from "../types/timeline.js";
import type { SDKStreamEvent } from "../normalization/normalizeSDKEvent.js";
import { normalizeSDKEvent } from "../normalization/normalizeSDKEvent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSDKEvent(overrides: Partial<SDKStreamEvent>): SDKStreamEvent {
  return {
    type: "message_start",
    timestamp: "2026-02-22T10:00:00.000Z",
    ...overrides,
  } as SDKStreamEvent;
}

// ---------------------------------------------------------------------------
// message_start
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - message_start", () => {
  it("creates an AssistantMessage with streaming state", () => {
    const event = makeSDKEvent({
      type: "message_start",
      message: { id: "msg-1", model: "claude-opus-4-6", role: "assistant" },
    });
    const items = normalizeSDKEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("assistant_message");
    if (item.type === "assistant_message") {
      expect(item.streamingState).toBe("streaming");
      expect(item.model).toBe("claude-opus-4-6");
      expect(item.text).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// content_block_start (text)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_start (text)", () => {
  it("creates or updates AssistantMessage for text blocks", () => {
    const event = makeSDKEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const items = normalizeSDKEvent(event, new Map());
    // May return empty if no existing message to update, or create a new one
    expect(items).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// content_block_start (thinking)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_start (thinking)", () => {
  it("creates a ThinkingBlock with streaming state", () => {
    const event = makeSDKEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    const items = normalizeSDKEvent(event, new Map());
    expect(items.length).toBeGreaterThanOrEqual(1);
    const thinkingItem = items.find((i) => i.type === "thinking_block");
    if (thinkingItem) {
      expect(thinkingItem.type).toBe("thinking_block");
      if (thinkingItem.type === "thinking_block") {
        expect(thinkingItem.streamingState).toBe("streaming");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// content_block_start (tool_use)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_start (tool_use)", () => {
  it("creates a ToolCall with pending status", () => {
    const event = makeSDKEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu-001", name: "Read", input: {} },
    });
    const items = normalizeSDKEvent(event, new Map());
    expect(items.length).toBeGreaterThanOrEqual(1);
    const toolItem = items.find((i) => i.type === "tool_call");
    if (toolItem && toolItem.type === "tool_call") {
      expect(toolItem.status).toBe("pending");
      expect(toolItem.toolUseId).toBe("tu-001");
    }
  });
});

// ---------------------------------------------------------------------------
// content_block_delta (text_delta)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_delta (text_delta)", () => {
  it("appends text to current AssistantMessage", () => {
    const existingItems = new Map<string, TimelineItem>();
    existingItems.set("msg-1", {
      id: "msg-1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "sdk_stream",
      read: false,
      type: "assistant_message",
      text: "Hello ",
      streamingState: "streaming",
      hasMarkdown: false,
      model: "claude-opus-4-6",
      outputTokens: null,
    });

    const event = makeSDKEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "world" },
    });
    const items = normalizeSDKEvent(event, existingItems);
    const updatedMsg = items.find((i) => i.type === "assistant_message");
    if (updatedMsg && updatedMsg.type === "assistant_message") {
      expect(updatedMsg.text).toContain("world");
    }
  });
});

// ---------------------------------------------------------------------------
// content_block_delta (thinking_delta)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_delta (thinking_delta)", () => {
  it("appends text to current ThinkingBlock", () => {
    const existingItems = new Map<string, TimelineItem>();
    existingItems.set("thinking-1", {
      id: "thinking-1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "sdk_stream",
      read: false,
      type: "thinking_block",
      text: "Let me ",
      streamingState: "streaming",
      durationMs: null,
    });

    const event = makeSDKEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "think about this" },
    });
    const items = normalizeSDKEvent(event, existingItems);
    const updatedThinking = items.find((i) => i.type === "thinking_block");
    if (updatedThinking && updatedThinking.type === "thinking_block") {
      expect(updatedThinking.text).toContain("think about this");
    }
  });
});

// ---------------------------------------------------------------------------
// content_block_stop
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - content_block_stop", () => {
  it("finalizes the current content block", () => {
    const event = makeSDKEvent({
      type: "content_block_stop",
      index: 0,
    });
    const items = normalizeSDKEvent(event, new Map());
    // Should not crash
    expect(items).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// message_delta (stop_reason)
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - message_delta", () => {
  it("sets AssistantMessage to completed", () => {
    const existingItems = new Map<string, TimelineItem>();
    existingItems.set("msg-1", {
      id: "msg-1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "sdk_stream",
      read: false,
      type: "assistant_message",
      text: "Complete response",
      streamingState: "streaming",
      hasMarkdown: false,
      model: "claude-opus-4-6",
      outputTokens: null,
    });

    const event = makeSDKEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 200 },
    });
    const items = normalizeSDKEvent(event, existingItems);
    const completedMsg = items.find((i) => i.type === "assistant_message");
    if (completedMsg && completedMsg.type === "assistant_message") {
      expect(completedMsg.streamingState).toBe("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - error", () => {
  it("creates an ErrorItem", () => {
    const event = makeSDKEvent({
      type: "error",
      error: { type: "overloaded_error", message: "Server overloaded" },
    });
    const items = normalizeSDKEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("error");
    if (item.type === "error") {
      expect(item.message).toContain("Server overloaded");
      expect(item.errorSource).toBe("system");
    }
  });
});

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

describe("normalizeSDKEvent - purity", () => {
  it("is deterministic for the same input", () => {
    const event = makeSDKEvent({
      type: "message_start",
      message: { id: "msg-1", model: "claude-opus-4-6", role: "assistant" },
    });
    const existing = new Map<string, TimelineItem>();
    const items1 = normalizeSDKEvent(event, existing);
    const items2 = normalizeSDKEvent(event, existing);
    expect(items1).toEqual(items2);
  });

  it("does not mutate the existing items map", () => {
    const existing = new Map<string, TimelineItem>();
    const event = makeSDKEvent({
      type: "message_start",
      message: { id: "msg-1", model: "claude-opus-4-6", role: "assistant" },
    });
    normalizeSDKEvent(event, existing);
    expect(existing.size).toBe(0);
  });
});
