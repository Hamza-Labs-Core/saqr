/**
 * Tests for type re-exports and type guards.
 */
import { describe, it, expect } from "vitest";
import {
  isUserMessage,
  isAssistantMessage,
  isThinkingBlock,
  isToolCall,
  isPermissionRequest,
  isErrorItem,
  isSystemNotification,
  isCompactNotification,
  isUsageUpdate,
  DARK_THEME,
  LIGHT_THEME,
} from "../types.js";
import type { TimelineItem } from "../types.js";

function makeBase(type: string): any {
  return {
    id: "test-1",
    timestamp: "2026-01-01T00:00:00Z",
    sequence: 1,
    source: "sdk_stream",
    read: false,
    type,
  };
}

describe("Type Guards", () => {
  it("isUserMessage", () => {
    const item = { ...makeBase("user_message"), text: "hello", hasAttachments: false, attachments: [] };
    expect(isUserMessage(item as TimelineItem)).toBe(true);
    expect(isAssistantMessage(item as TimelineItem)).toBe(false);
  });

  it("isAssistantMessage", () => {
    const item = {
      ...makeBase("assistant_message"),
      text: "hi",
      streamingState: "completed",
      hasMarkdown: false,
      model: "claude-4",
      outputTokens: 100,
    };
    expect(isAssistantMessage(item as TimelineItem)).toBe(true);
  });

  it("isThinkingBlock", () => {
    const item = {
      ...makeBase("thinking_block"),
      text: "reasoning...",
      streamingState: "completed",
      durationMs: 500,
    };
    expect(isThinkingBlock(item as TimelineItem)).toBe(true);
  });

  it("isToolCall", () => {
    const item = {
      ...makeBase("tool_call"),
      toolName: "Read",
      toolUseId: "tu-1",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { filePath: "/tmp/test.ts" },
      output: { content: "hello", lineCount: 1, language: "typescript" },
    };
    expect(isToolCall(item as TimelineItem)).toBe(true);
  });

  it("isPermissionRequest", () => {
    const item = {
      ...makeBase("permission_request"),
      toolName: "Bash",
      description: "Run command",
      filePath: null,
      toolInput: {},
      resolution: "pending",
      resolvedAt: null,
    };
    expect(isPermissionRequest(item as TimelineItem)).toBe(true);
  });

  it("isErrorItem", () => {
    const item = {
      ...makeBase("error"),
      message: "Something broke",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    };
    expect(isErrorItem(item as TimelineItem)).toBe(true);
  });

  it("isSystemNotification", () => {
    const item = {
      ...makeBase("system_notification"),
      category: "session_start",
      message: "Session started",
      metadata: {},
    };
    expect(isSystemNotification(item as TimelineItem)).toBe(true);
  });

  it("isCompactNotification", () => {
    const item = {
      ...makeBase("compact_notification"),
      tokensBefore: 100000,
      tokensAfter: 50000,
      trigger: "auto",
    };
    expect(isCompactNotification(item as TimelineItem)).toBe(true);
  });

  it("isUsageUpdate", () => {
    const item = {
      ...makeBase("usage_update"),
      model: "claude-4",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionCostUsd: 0.05,
      contextWindowUsage: 10000,
      contextWindowMax: 200000,
    };
    expect(isUsageUpdate(item as TimelineItem)).toBe(true);
  });
});

describe("Theme Constants", () => {
  it("exports DARK_THEME", () => {
    expect(DARK_THEME.mode).toBe("dark");
    expect(DARK_THEME.colors.background).toBe("#0D1117");
  });

  it("exports LIGHT_THEME", () => {
    expect(LIGHT_THEME.mode).toBe("light");
    expect(LIGHT_THEME.colors.background).not.toBe("#0D1117");
  });
});
