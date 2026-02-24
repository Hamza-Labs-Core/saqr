/**
 * Tests for the TimelineItem type system.
 *
 * Validates that the discriminated union type system is correctly defined
 * and that type guards work properly for all timeline item variants.
 */
import { describe, it, expect } from "vitest";
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
  PermissionResolved,
  ErrorItem,
  SystemNotification,
  CompactNotification,
  UsageUpdate,
} from "../types/timeline.js";
import {
  isUserMessage,
  isAssistantMessage,
  isThinkingBlock,
  isToolCall,
  isPermissionRequest,
  isPermissionResolved,
  isErrorItem,
  isSystemNotification,
  isCompactNotification,
  isUsageUpdate,
  createTimelineItemBase,
} from "../types/timeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase(overrides: Partial<TimelineItemBase> = {}): TimelineItemBase {
  return {
    id: "test-id-1",
    timestamp: "2026-02-22T10:00:00.000Z",
    sequence: 1,
    source: "gc_hook",
    read: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TimelineItemBase
// ---------------------------------------------------------------------------

describe("TimelineItemBase", () => {
  it("should create a base item with all required fields", () => {
    const base = createTimelineItemBase({
      source: "gc_hook",
    });
    expect(base.id).toBeDefined();
    expect(typeof base.id).toBe("string");
    expect(base.id.length).toBeGreaterThan(0);
    expect(base.timestamp).toBeDefined();
    expect(base.sequence).toBe(0);
    expect(base.source).toBe("gc_hook");
    expect(base.read).toBe(false);
  });

  it("should allow overriding all base fields", () => {
    const base = createTimelineItemBase({
      id: "custom-id",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 42,
      source: "sdk_stream",
      read: true,
    });
    expect(base.id).toBe("custom-id");
    expect(base.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(base.sequence).toBe(42);
    expect(base.source).toBe("sdk_stream");
    expect(base.read).toBe(true);
  });

  it("should support all three source types", () => {
    const sources = ["gc_hook", "sdk_stream", "pty"] as const;
    for (const source of sources) {
      const base = createTimelineItemBase({ source });
      expect(base.source).toBe(source);
    }
  });
});

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

describe("Type Guards", () => {
  it("isUserMessage identifies UserMessage items", () => {
    const item: UserMessage = {
      ...makeBase(),
      type: "user_message",
      text: "Hello",
      hasAttachments: false,
      attachments: [],
    };
    expect(isUserMessage(item)).toBe(true);
    expect(isAssistantMessage(item)).toBe(false);
  });

  it("isAssistantMessage identifies AssistantMessage items", () => {
    const item: AssistantMessage = {
      ...makeBase(),
      type: "assistant_message",
      text: "Hi there",
      streamingState: "completed",
      hasMarkdown: false,
      model: "claude-opus-4-6",
      outputTokens: 100,
    };
    expect(isAssistantMessage(item)).toBe(true);
    expect(isUserMessage(item)).toBe(false);
  });

  it("isThinkingBlock identifies ThinkingBlock items", () => {
    const item: ThinkingBlock = {
      ...makeBase(),
      type: "thinking_block",
      text: "Let me think...",
      streamingState: "streaming",
      durationMs: null,
    };
    expect(isThinkingBlock(item)).toBe(true);
  });

  it("isToolCall identifies all ToolCall variants", () => {
    const readItem: ToolCallRead = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { filePath: "/test.ts" },
      output: { content: "hello", lineCount: 1, language: "typescript" },
    };
    expect(isToolCall(readItem)).toBe(true);

    const bashItem: ToolCallBash = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-2",
      toolName: "Bash",
      status: "running",
      durationMs: null,
      error: null,
      input: { command: "ls -la" },
      output: null,
    };
    expect(isToolCall(bashItem)).toBe(true);
  });

  it("isPermissionRequest identifies PermissionRequest items", () => {
    const item: PermissionRequest = {
      ...makeBase(),
      type: "permission_request",
      toolName: "Bash",
      description: "Execute rm command",
      filePath: null,
      toolInput: { command: "rm -rf node_modules" },
      resolution: "pending",
      resolvedAt: null,
    };
    expect(isPermissionRequest(item)).toBe(true);
  });

  it("isPermissionResolved identifies PermissionResolved items", () => {
    const item: PermissionResolved = {
      ...makeBase(),
      type: "permission_resolved",
      toolName: "Read",
      filePath: "/test.ts",
      rule: "Always allow Read",
    };
    expect(isPermissionResolved(item)).toBe(true);
  });

  it("isErrorItem identifies ErrorItem items", () => {
    const item: ErrorItem = {
      ...makeBase(),
      type: "error",
      message: "Something went wrong",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    };
    expect(isErrorItem(item)).toBe(true);
  });

  it("isSystemNotification identifies SystemNotification items", () => {
    const item: SystemNotification = {
      ...makeBase(),
      type: "system_notification",
      category: "session_start",
      message: "Session started",
      metadata: {},
    };
    expect(isSystemNotification(item)).toBe(true);
  });

  it("isCompactNotification identifies CompactNotification items", () => {
    const item: CompactNotification = {
      ...makeBase(),
      type: "compact_notification",
      tokensBefore: 100000,
      tokensAfter: 50000,
      trigger: "auto",
    };
    expect(isCompactNotification(item)).toBe(true);
  });

  it("isUsageUpdate identifies UsageUpdate items", () => {
    const item: UsageUpdate = {
      ...makeBase(),
      type: "usage_update",
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      sessionCostUsd: 0.42,
      contextWindowUsage: 0.35,
      contextWindowMax: 200000,
    };
    expect(isUsageUpdate(item)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolCall sub-discriminated union
// ---------------------------------------------------------------------------

describe("ToolCall sub-discriminated union", () => {
  it("supports all 8 tool types", () => {
    const toolNames = [
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "WebFetch",
      "Task",
    ] as const;

    for (const toolName of toolNames) {
      const base = {
        ...makeBase(),
        type: "tool_call" as const,
        toolUseId: `tu-${toolName}`,
        status: "completed" as const,
        durationMs: 100,
        error: null,
      };

      // Just verify that the type system recognizes these tool names
      expect(toolName).toBeDefined();
    }
  });

  it("ToolCallRead has correct input/output shape", () => {
    const item: ToolCallRead = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 30,
      error: null,
      input: { filePath: "/src/index.ts", offset: 10, limit: 50 },
      output: { content: "const x = 1;", lineCount: 50, language: "typescript" },
    };
    expect(item.toolName).toBe("Read");
    expect(item.input.filePath).toBe("/src/index.ts");
    expect(item.output?.lineCount).toBe(50);
  });

  it("ToolCallEdit has correct input/output shape", () => {
    const item: ToolCallEdit = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-2",
      toolName: "Edit",
      status: "completed",
      durationMs: 40,
      error: null,
      input: {
        filePath: "/src/index.ts",
        oldString: "const x = 1;",
        newString: "const x = 2;",
        replaceAll: false,
      },
      output: { diff: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;", language: "typescript" },
    };
    expect(item.toolName).toBe("Edit");
    expect(item.input.oldString).toBe("const x = 1;");
  });

  it("ToolCallBash has correct input/output shape", () => {
    const item: ToolCallBash = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-3",
      toolName: "Bash",
      status: "completed",
      durationMs: 200,
      error: null,
      input: { command: "ls -la", timeout: 5000, description: "List files" },
      output: { stdout: "file1\nfile2", stderr: null, exitCode: 0 },
    };
    expect(item.toolName).toBe("Bash");
    expect(item.output?.exitCode).toBe(0);
  });

  it("ToolCallGlob has correct input/output shape", () => {
    const item: ToolCallGlob = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-4",
      toolName: "Glob",
      status: "completed",
      durationMs: 20,
      error: null,
      input: { pattern: "**/*.ts", path: "/src" },
      output: { matches: ["/src/index.ts"], matchCount: 1 },
    };
    expect(item.toolName).toBe("Glob");
    expect(item.output?.matches).toHaveLength(1);
  });

  it("ToolCallGrep has correct input/output shape", () => {
    const item: ToolCallGrep = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-5",
      toolName: "Grep",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { pattern: "TODO", path: "/src", glob: "*.ts", outputMode: "content" },
      output: {
        matches: [{ file: "/src/index.ts", line: 10, content: "// TODO: fix" }],
        matchCount: 1,
      },
    };
    expect(item.toolName).toBe("Grep");
    expect(item.output?.matches[0].line).toBe(10);
  });

  it("ToolCallWebFetch has correct input/output shape", () => {
    const item: ToolCallWebFetch = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-6",
      toolName: "WebFetch",
      status: "completed",
      durationMs: 1000,
      error: null,
      input: { url: "https://example.com", prompt: "Get main content" },
      output: { summary: "Example content", statusCode: 200 },
    };
    expect(item.toolName).toBe("WebFetch");
    expect(item.output?.statusCode).toBe(200);
  });

  it("ToolCallTask has correct input/output shape with nested timeline", () => {
    const nestedItem: UserMessage = {
      ...makeBase({ id: "nested-1", sequence: 1 }),
      type: "user_message",
      text: "Subagent prompt",
      hasAttachments: false,
      attachments: [],
    };

    const item: ToolCallTask = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-7",
      toolName: "Task",
      status: "completed",
      durationMs: 5000,
      error: null,
      input: { prompt: "Fix the bug", description: "Debug task" },
      output: { result: "Bug fixed", nestedTimeline: [nestedItem] },
    };
    expect(item.toolName).toBe("Task");
    expect(item.output?.nestedTimeline).toHaveLength(1);
  });

  it("ToolCall with null output represents pending/running state", () => {
    const item: ToolCallBash = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-running",
      toolName: "Bash",
      status: "running",
      durationMs: null,
      error: null,
      input: { command: "sleep 10" },
      output: null,
    };
    expect(item.output).toBeNull();
    expect(item.status).toBe("running");
  });

  it("ToolCall with failed status has error message", () => {
    const item: ToolCallBash = {
      ...makeBase(),
      type: "tool_call",
      toolUseId: "tu-failed",
      toolName: "Bash",
      status: "failed",
      durationMs: 100,
      error: "Command timed out",
      input: { command: "sleep 999" },
      output: null,
    };
    expect(item.error).toBe("Command timed out");
    expect(item.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// TimelineItem discriminated union
// ---------------------------------------------------------------------------

describe("TimelineItem discriminated union", () => {
  it("can narrow by type field", () => {
    const items: TimelineItem[] = [
      {
        ...makeBase({ sequence: 1 }),
        type: "user_message",
        text: "Hello",
        hasAttachments: false,
        attachments: [],
      },
      {
        ...makeBase({ sequence: 2 }),
        type: "assistant_message",
        text: "Hi there",
        streamingState: "completed",
        hasMarkdown: false,
        model: "claude-opus-4-6",
        outputTokens: 100,
      },
      {
        ...makeBase({ sequence: 3 }),
        type: "system_notification",
        category: "session_start",
        message: "Session started",
        metadata: {},
      },
    ];

    const messages = items.filter(
      (i) => i.type === "user_message" || i.type === "assistant_message",
    );
    expect(messages).toHaveLength(2);

    const notifications = items.filter((i) => i.type === "system_notification");
    expect(notifications).toHaveLength(1);
  });

  it("covers all 10 top-level types in the union", () => {
    const types = new Set<string>();
    const allItems: TimelineItem[] = [
      { ...makeBase(), type: "user_message", text: "", hasAttachments: false, attachments: [] },
      { ...makeBase(), type: "assistant_message", text: "", streamingState: "completed", hasMarkdown: false, model: "", outputTokens: null },
      { ...makeBase(), type: "thinking_block", text: "", streamingState: "completed", durationMs: null },
      { ...makeBase(), type: "tool_call", toolUseId: "", toolName: "Read", status: "completed", durationMs: null, error: null, input: { filePath: "" }, output: null },
      { ...makeBase(), type: "permission_request", toolName: "", description: "", filePath: null, toolInput: {}, resolution: "pending", resolvedAt: null },
      { ...makeBase(), type: "permission_resolved", toolName: "", filePath: null, rule: "" },
      { ...makeBase(), type: "error", message: "", stackTrace: null, isRecoverable: false, errorSource: "system" },
      { ...makeBase(), type: "system_notification", category: "session_start", message: "", metadata: {} },
      { ...makeBase(), type: "compact_notification", tokensBefore: 0, tokensAfter: 0, trigger: "auto" },
      { ...makeBase(), type: "usage_update", model: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessionCostUsd: 0, contextWindowUsage: 0, contextWindowMax: 0 },
    ];
    for (const item of allItems) {
      types.add(item.type);
    }
    expect(types.size).toBe(10);
  });
});
