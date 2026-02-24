/**
 * Tests for GC Event Normalization.
 *
 * Validates that all 10+ GC event types are correctly normalized
 * into TimelineItem variants.
 */
import { describe, it, expect } from "vitest";
import type { UnifiedEvent } from "@saqr/shared";
import type { TimelineItem } from "../types/timeline.js";
import { normalizeGCEvent } from "../normalization/normalizeGCEvent.js";
import { mergeIntoTimeline } from "../normalization/mergeIntoTimeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGCEvent(overrides: Partial<UnifiedEvent>): UnifiedEvent {
  return {
    event_id: "evt-1",
    event_type: "SessionStarted",
    project_id: "proj-1",
    session_id: "sess-1",
    sequence: 1,
    timestamp: "2026-02-22T10:00:00.000Z",
    agent_provider: "claude-code",
    agent_native_event: "SessionStart",
    agent_metadata: { model: "claude-opus-4-6" },
    data: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SessionStarted
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - SessionStarted", () => {
  it("converts SessionStarted to SystemNotification with session_start category", () => {
    const event = makeGCEvent({
      event_type: "SessionStarted",
      data: { session_id: "sess-1", model: "claude-opus-4-6", cwd: "/home/user/project" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("system_notification");
    if (item.type === "system_notification") {
      expect(item.category).toBe("session_start");
      expect(item.metadata).toHaveProperty("model");
      expect(item.source).toBe("gc_hook");
    }
  });
});

// ---------------------------------------------------------------------------
// UserPromptReceived
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - UserPromptReceived", () => {
  it("converts to UserMessage", () => {
    const event = makeGCEvent({
      event_type: "UserPromptReceived",
      sequence: 2,
      data: { session_id: "sess-1", prompt: "Hello, Claude!" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("user_message");
    if (item.type === "user_message") {
      expect(item.text).toBe("Hello, Claude!");
      expect(item.hasAttachments).toBe(false);
      expect(item.attachments).toEqual([]);
    }
  });

  it("handles empty prompt", () => {
    const event = makeGCEvent({
      event_type: "UserPromptReceived",
      data: { session_id: "sess-1", prompt: "" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "user_message") {
      expect(items[0].text).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolCallRequested
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - ToolCallRequested", () => {
  it("converts to ToolCall with running status", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      sequence: 3,
      data: {
        session_id: "sess-1",
        tool_name: "Read",
        tool_input: { file_path: "/src/index.ts" },
        tool_use_id: "tu-001",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("tool_call");
    if (item.type === "tool_call") {
      expect(item.status).toBe("running");
      expect(item.toolUseId).toBe("tu-001");
      expect(item.toolName).toBe("Read");
    }
  });

  it("creates ToolCallBash for Bash tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Bash",
        tool_input: { command: "ls -la", timeout: 5000 },
        tool_use_id: "tu-002",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Bash");
      if (items[0].toolName === "Bash") {
        expect(items[0].input.command).toBe("ls -la");
      }
    }
  });

  it("creates ToolCallEdit for Edit tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Edit",
        tool_input: { file_path: "/src/test.ts", old_string: "old", new_string: "new" },
        tool_use_id: "tu-003",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Edit");
    }
  });

  it("creates ToolCallWrite for Write tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Write",
        tool_input: { file_path: "/src/new.ts", content: "const x = 1;" },
        tool_use_id: "tu-004",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Write");
    }
  });

  it("creates ToolCallGlob for Glob tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Glob",
        tool_input: { pattern: "**/*.ts" },
        tool_use_id: "tu-005",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Glob");
    }
  });

  it("creates ToolCallGrep for Grep tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Grep",
        tool_input: { pattern: "TODO" },
        tool_use_id: "tu-006",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Grep");
    }
  });

  it("creates ToolCallWebFetch for WebFetch tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com", prompt: "Get content" },
        tool_use_id: "tu-007",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("WebFetch");
    }
  });

  it("creates ToolCallTask for Task tool", () => {
    const event = makeGCEvent({
      event_type: "ToolCallRequested",
      data: {
        session_id: "sess-1",
        tool_name: "Task",
        tool_input: { prompt: "Fix the bug" },
        tool_use_id: "tu-008",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    if (items[0].type === "tool_call") {
      expect(items[0].toolName).toBe("Task");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolCallCompleted
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - ToolCallCompleted", () => {
  it("converts to ToolCall with completed status", () => {
    const event = makeGCEvent({
      event_type: "ToolCallCompleted",
      sequence: 4,
      data: {
        session_id: "sess-1",
        tool_name: "Read",
        tool_input: { file_path: "/src/index.ts" },
        tool_response: "const x = 1;",
        tool_use_id: "tu-001",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("tool_call");
    if (item.type === "tool_call") {
      expect(item.status).toBe("completed");
      expect(item.toolUseId).toBe("tu-001");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolCallFailed
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - ToolCallFailed", () => {
  it("converts to ToolCall with failed status and error message", () => {
    const event = makeGCEvent({
      event_type: "ToolCallFailed",
      sequence: 5,
      data: {
        session_id: "sess-1",
        tool_name: "Bash",
        tool_input: { command: "bad-command" },
        error: "Command not found",
        tool_use_id: "tu-002",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("tool_call");
    if (item.type === "tool_call") {
      expect(item.status).toBe("failed");
      expect(item.error).toBe("Command not found");
    }
  });
});

// ---------------------------------------------------------------------------
// AgentSpawned / AgentCompleted
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - AgentSpawned", () => {
  it("converts to SystemNotification with agent_spawned category", () => {
    const event = makeGCEvent({
      event_type: "AgentSpawned",
      sequence: 6,
      data: { session_id: "sess-1", subagent_id: "sub-1", task: "Debug the issue" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "system_notification") {
      expect(items[0].category).toBe("agent_spawned");
    }
  });
});

describe("normalizeGCEvent - AgentCompleted", () => {
  it("converts to SystemNotification with agent_completed category", () => {
    const event = makeGCEvent({
      event_type: "AgentCompleted",
      sequence: 7,
      data: { session_id: "sess-1", subagent_id: "sub-1", result: "Done" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "system_notification") {
      expect(items[0].category).toBe("agent_completed");
    }
  });
});

// ---------------------------------------------------------------------------
// TurnCompleted
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - TurnCompleted", () => {
  it("converts to AssistantMessage with completed state", () => {
    const event = makeGCEvent({
      event_type: "TurnCompleted",
      sequence: 8,
      data: {
        session_id: "sess-1",
        response: "Here is my answer.",
        input_tokens: 1000,
        output_tokens: 500,
        model: "claude-opus-4-6",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items.length).toBeGreaterThanOrEqual(1);
    const msgItem = items.find((i) => i.type === "assistant_message");
    expect(msgItem).toBeDefined();
    if (msgItem && msgItem.type === "assistant_message") {
      expect(msgItem.streamingState).toBe("completed");
      expect(msgItem.text).toBe("Here is my answer.");
    }
  });
});

// ---------------------------------------------------------------------------
// CompactionTriggered
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - CompactionTriggered", () => {
  it("converts to CompactNotification", () => {
    const event = makeGCEvent({
      event_type: "CompactionTriggered",
      sequence: 9,
      data: {
        session_id: "sess-1",
        tokens_before: 180000,
        tokens_after: 80000,
        trigger: "auto",
      },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "compact_notification") {
      expect(items[0].tokensBefore).toBe(180000);
      expect(items[0].tokensAfter).toBe(80000);
      expect(items[0].trigger).toBe("auto");
    }
  });
});

// ---------------------------------------------------------------------------
// SessionEnded
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - SessionEnded", () => {
  it("converts to SystemNotification with session_end category", () => {
    const event = makeGCEvent({
      event_type: "SessionEnded",
      sequence: 10,
      data: { session_id: "sess-1", reason: "user_exit" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    if (items[0].type === "system_notification") {
      expect(items[0].category).toBe("session_end");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown event type
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - Unknown event type", () => {
  it("produces a SystemNotification fallback for unknown event types", () => {
    const event = makeGCEvent({
      event_type: "FutureEventType" as UnifiedEvent["event_type"],
      data: { some: "data" },
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.type).toBe("system_notification");
    if (item.type === "system_notification") {
      expect(item.message).toContain("Unknown event");
      expect(item.metadata).toHaveProperty("rawEvent");
    }
  });
});

// ---------------------------------------------------------------------------
// Common properties
// ---------------------------------------------------------------------------

describe("normalizeGCEvent - common properties", () => {
  it("preserves event_id as item id", () => {
    const event = makeGCEvent({
      event_id: "my-event-id",
      event_type: "SessionStarted",
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items[0].id).toBe("my-event-id");
  });

  it("preserves timestamp", () => {
    const event = makeGCEvent({
      timestamp: "2026-02-22T12:34:56.789Z",
      event_type: "SessionStarted",
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items[0].timestamp).toBe("2026-02-22T12:34:56.789Z");
  });

  it("preserves sequence number", () => {
    const event = makeGCEvent({
      sequence: 42,
      event_type: "SessionStarted",
    });
    const items = normalizeGCEvent(event, new Map());
    expect(items[0].sequence).toBe(42);
  });

  it("sets source to gc_hook", () => {
    const event = makeGCEvent({ event_type: "SessionStarted" });
    const items = normalizeGCEvent(event, new Map());
    expect(items[0].source).toBe("gc_hook");
  });

  it("sets read to false by default", () => {
    const event = makeGCEvent({ event_type: "SessionStarted" });
    const items = normalizeGCEvent(event, new Map());
    expect(items[0].read).toBe(false);
  });

  it("is a pure function (no side effects)", () => {
    const event = makeGCEvent({ event_type: "SessionStarted" });
    const existing = new Map<string, TimelineItem>();
    const items1 = normalizeGCEvent(event, existing);
    const items2 = normalizeGCEvent(event, existing);
    expect(items1).toEqual(items2);
    expect(existing.size).toBe(0); // Not mutated
  });
});

// ---------------------------------------------------------------------------
// mergeIntoTimeline
// ---------------------------------------------------------------------------

describe("mergeIntoTimeline", () => {
  it("appends new items to the timeline", () => {
    const timeline: TimelineItem[] = [];
    const newItems: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "system_notification",
        category: "session_start",
        message: "Session started",
        metadata: {},
      },
    ];
    const result = mergeIntoTimeline(timeline, newItems);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("merges ToolCallCompleted with existing ToolCallRequested via toolUseId", () => {
    const timeline: TimelineItem[] = [
      {
        id: "evt-1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "tool_call",
        toolUseId: "tu-001",
        toolName: "Read",
        status: "running",
        durationMs: null,
        error: null,
        input: { filePath: "/src/index.ts" },
        output: null,
      },
    ];
    const completedItem: TimelineItem = {
      id: "evt-2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 2,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-001",
      toolName: "Read",
      status: "completed",
      durationMs: 500,
      error: null,
      input: { filePath: "/src/index.ts" },
      output: { content: "file content", lineCount: 10, language: "typescript" },
    };
    const result = mergeIntoTimeline(timeline, [completedItem]);
    expect(result).toHaveLength(1);
    if (result[0].type === "tool_call") {
      expect(result[0].status).toBe("completed");
      expect(result[0].durationMs).toBe(500);
      expect(result[0].output).not.toBeNull();
    }
  });

  it("sorts by sequence number", () => {
    const timeline: TimelineItem[] = [
      {
        id: "3",
        timestamp: "2026-02-22T10:00:03.000Z",
        sequence: 3,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Third",
        hasAttachments: false,
        attachments: [],
      },
    ];
    const newItems: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:01.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "system_notification",
        category: "session_start",
        message: "Start",
        metadata: {},
      },
      {
        id: "2",
        timestamp: "2026-02-22T10:00:02.000Z",
        sequence: 2,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Second",
        hasAttachments: false,
        attachments: [],
      },
    ];
    const result = mergeIntoTimeline(timeline, newItems);
    expect(result).toHaveLength(3);
    expect(result[0].sequence).toBe(1);
    expect(result[1].sequence).toBe(2);
    expect(result[2].sequence).toBe(3);
  });

  it("handles ToolCallCompleted arriving without prior ToolCallRequested", () => {
    const timeline: TimelineItem[] = [];
    const completedItem: TimelineItem = {
      id: "evt-1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-orphan",
      toolName: "Read",
      status: "completed",
      durationMs: 100,
      error: null,
      input: { filePath: "/test.ts" },
      output: { content: "data", lineCount: 1, language: "typescript" },
    };
    const result = mergeIntoTimeline(timeline, [completedItem]);
    expect(result).toHaveLength(1);
    if (result[0].type === "tool_call") {
      expect(result[0].status).toBe("completed");
    }
  });

  it("preserves non-tool-call items untouched", () => {
    const timeline: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Hello",
        hasAttachments: false,
        attachments: [],
      },
    ];
    const newItems: TimelineItem[] = [
      {
        id: "2",
        timestamp: "2026-02-22T10:00:01.000Z",
        sequence: 2,
        source: "gc_hook",
        read: false,
        type: "assistant_message",
        text: "Hi",
        streamingState: "completed",
        hasMarkdown: false,
        model: "claude-opus-4-6",
        outputTokens: 10,
      },
    ];
    const result = mergeIntoTimeline(timeline, newItems);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("user_message");
    expect(result[1].type).toBe("assistant_message");
  });

  it("does not mutate the original timeline", () => {
    const timeline: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Hello",
        hasAttachments: false,
        attachments: [],
      },
    ];
    const original = [...timeline];
    mergeIntoTimeline(timeline, [
      {
        id: "2",
        timestamp: "2026-02-22T10:00:01.000Z",
        sequence: 2,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "World",
        hasAttachments: false,
        attachments: [],
      },
    ]);
    expect(timeline).toEqual(original);
  });
});
