/**
 * Tests for normalize utility re-exports.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeGCEvent,
  normalizeSDKEvent,
  mergeIntoTimeline,
} from "../utils/normalize.js";

describe("normalize re-exports", () => {
  it("exports normalizeGCEvent function", () => {
    expect(typeof normalizeGCEvent).toBe("function");
  });

  it("exports normalizeSDKEvent function", () => {
    expect(typeof normalizeSDKEvent).toBe("function");
  });

  it("exports mergeIntoTimeline function", () => {
    expect(typeof mergeIntoTimeline).toBe("function");
  });
});

describe("mergeIntoTimeline", () => {
  it("merges new items into empty timeline", () => {
    const result = mergeIntoTimeline([], [
      {
        id: "msg-1",
        timestamp: "2025-01-01T00:00:00Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Hello",
        hasAttachments: false,
        attachments: [],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-1");
  });

  it("sorts items by sequence", () => {
    const result = mergeIntoTimeline([], [
      {
        id: "msg-2",
        timestamp: "2025-01-01T00:00:01Z",
        sequence: 2,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "Second",
        hasAttachments: false,
        attachments: [],
      },
      {
        id: "msg-1",
        timestamp: "2025-01-01T00:00:00Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: "First",
        hasAttachments: false,
        attachments: [],
      },
    ]);
    expect(result[0].id).toBe("msg-1");
    expect(result[1].id).toBe("msg-2");
  });

  it("correlates tool call requested + completed via toolUseId", () => {
    const requested = {
      id: "tc-1",
      timestamp: "2025-01-01T00:00:00Z",
      sequence: 1,
      source: "gc_hook" as const,
      read: false,
      type: "tool_call" as const,
      toolUseId: "tu-1",
      toolName: "Read" as const,
      status: "running" as const,
      durationMs: null,
      error: null,
      input: { filePath: "/tmp/foo.ts" },
      output: null,
    };

    const completed = {
      ...requested,
      id: "tc-1-done",
      sequence: 2,
      status: "completed" as const,
      output: { content: "file content", lineCount: 10, language: "typescript" },
    };

    const result = mergeIntoTimeline([requested], [completed]);
    // Should merge into one item, not two
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool_call");
    if (result[0].type === "tool_call") {
      expect(result[0].status).toBe("completed");
    }
  });

  it("does not mutate original timeline", () => {
    const original = [
      {
        id: "msg-1",
        timestamp: "2025-01-01T00:00:00Z",
        sequence: 1,
        source: "gc_hook" as const,
        read: false,
        type: "user_message" as const,
        text: "Hello",
        hasAttachments: false,
        attachments: [] as string[],
      },
    ];
    const frozen = Object.freeze([...original]);
    mergeIntoTimeline(frozen, [
      {
        id: "msg-2",
        timestamp: "2025-01-01T00:00:01Z",
        sequence: 2,
        source: "gc_hook" as const,
        read: false,
        type: "user_message" as const,
        text: "World",
        hasAttachments: false,
        attachments: [] as string[],
      },
    ]);
    expect(frozen).toHaveLength(1);
  });
});

describe("normalizeGCEvent", () => {
  it("normalizes a UserPromptReceived event", () => {
    const items = normalizeGCEvent(
      {
        event_id: "e1",
        event_type: "UserPromptReceived",
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        sequence: 1,
        agent_provider: "anthropic",
        data: { prompt: "Hello Claude" },
      },
      new Map(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("user_message");
    if (items[0].type === "user_message") {
      expect(items[0].text).toBe("Hello Claude");
    }
  });

  it("normalizes a SessionStarted event", () => {
    const items = normalizeGCEvent(
      {
        event_id: "e0",
        event_type: "SessionStarted",
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "s1",
        sequence: 0,
        agent_provider: "anthropic",
        data: { model: "claude-3.5-sonnet", cwd: "/home/user" },
      },
      new Map(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("system_notification");
  });

  it("normalizes a TurnCompleted event", () => {
    const items = normalizeGCEvent(
      {
        event_id: "e2",
        event_type: "TurnCompleted",
        timestamp: "2025-01-01T00:00:01Z",
        session_id: "s1",
        sequence: 2,
        agent_provider: "anthropic",
        data: { response: "Hello! How can I help?", model: "claude-3.5-sonnet", output_tokens: 100 },
      },
      new Map(),
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].type).toBe("assistant_message");
  });
});
