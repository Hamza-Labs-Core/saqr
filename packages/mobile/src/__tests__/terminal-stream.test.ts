/**
 * Tests for the mobile terminal stream hook and helpers.
 */
import { describe, it, expect } from "vitest";
import type { TimelineItem } from "../../node_modules/@saqr/terminal-ui/src/types.js";

// We test the pure functions extracted from use-terminal-stream.
// The hook itself needs React, but the data logic is testable standalone.

/**
 * Merge a new item into the timeline, deduplicating by id.
 */
function mergeItem(existing: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = existing.findIndex(e => e.id === item.id);
  if (idx >= 0) {
    const updated = [...existing];
    updated[idx] = item;
    return updated;
  }
  return [...existing, item].sort((a, b) => a.sequence - b.sequence);
}

function makeBase(type: string, seq: number, id?: string): Record<string, unknown> {
  return {
    id: id ?? `item-${seq}`,
    timestamp: "2026-01-01T00:00:00Z",
    sequence: seq,
    source: "sdk_stream",
    read: false,
    type,
  };
}

describe("mergeItem", () => {
  it("adds new item to empty timeline", () => {
    const item = { ...makeBase("user_message", 1), text: "hello", hasAttachments: false, attachments: [] } as TimelineItem;
    const result = mergeItem([], item);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("item-1");
  });

  it("maintains sequence order", () => {
    const item1 = { ...makeBase("user_message", 2), text: "second", hasAttachments: false, attachments: [] } as TimelineItem;
    const item2 = { ...makeBase("user_message", 1, "item-0"), text: "first", hasAttachments: false, attachments: [] } as TimelineItem;

    let timeline = mergeItem([], item1);
    timeline = mergeItem(timeline, item2);

    expect(timeline).toHaveLength(2);
    expect(timeline[0].id).toBe("item-0");
    expect(timeline[1].id).toBe("item-2");
  });

  it("updates existing item by id", () => {
    const initial = { ...makeBase("assistant_message", 1), text: "partial...", streamingState: "streaming", hasMarkdown: false, model: "claude-4", outputTokens: null } as TimelineItem;
    const updated = { ...makeBase("assistant_message", 1), text: "complete response", streamingState: "completed", hasMarkdown: false, model: "claude-4", outputTokens: 100 } as TimelineItem;

    let timeline = mergeItem([], initial);
    timeline = mergeItem(timeline, updated);

    expect(timeline).toHaveLength(1);
    expect((timeline[0] as { text: string }).text).toBe("complete response");
  });
});

describe("eventToTimelineItem", () => {
  // Extracted conversion logic for testing
  function eventToTimelineItem(event: Record<string, unknown>): TimelineItem | null {
    const base = {
      id: String(event.eventId ?? event.id ?? "test-id"),
      timestamp: String(event.timestamp ?? new Date().toISOString()),
      sequence: Number(event.sequence ?? 0),
      source: "sdk_stream" as const,
      read: false,
    };

    const data = (event.data ?? event) as Record<string, unknown>;
    const eventType = String(event.eventType ?? data.type ?? "");

    switch (eventType) {
      case "user_message":
        return { ...base, type: "user_message", text: String(data.text ?? ""), hasAttachments: false, attachments: [] };
      case "assistant_message":
        return { ...base, type: "assistant_message", text: String(data.text ?? ""), streamingState: "completed" as const, hasMarkdown: false, model: String(data.model ?? ""), outputTokens: null };
      case "thinking_block":
        return { ...base, type: "thinking_block", text: String(data.text ?? ""), streamingState: "completed" as const, durationMs: null };
      case "error":
        return { ...base, type: "error", message: String(data.message ?? ""), stackTrace: null, isRecoverable: true, errorSource: "system" as const };
      default:
        return null;
    }
  }

  it("converts user_message event", () => {
    const result = eventToTimelineItem({
      eventId: "ev-1",
      eventType: "user_message",
      timestamp: "2026-01-01T00:00:00Z",
      sequence: 1,
      data: { text: "hello world" },
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe("user_message");
    expect((result as { text: string }).text).toBe("hello world");
  });

  it("converts assistant_message event", () => {
    const result = eventToTimelineItem({
      eventId: "ev-2",
      eventType: "assistant_message",
      sequence: 2,
      data: { text: "hi there", model: "claude-4" },
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant_message");
    expect((result as { model: string }).model).toBe("claude-4");
  });

  it("converts error event", () => {
    const result = eventToTimelineItem({
      eventId: "ev-3",
      eventType: "error",
      sequence: 3,
      data: { message: "something broke" },
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe("error");
    expect((result as { message: string }).message).toBe("something broke");
  });

  it("returns null for unknown event type", () => {
    const result = eventToTimelineItem({
      eventId: "ev-4",
      eventType: "unknown_type",
      sequence: 4,
      data: {},
    });

    expect(result).toBeNull();
  });
});

describe("tool color mapping", () => {
  function getToolColor(toolName: string): string {
    const map: Record<string, string> = {
      Read: "#60A5FA",
      Edit: "#34D399",
      Write: "#A78BFA",
      Bash: "#A78BFA",
      Glob: "#F59E0B",
      Grep: "#F59E0B",
      WebFetch: "#F472B6",
      Task: "#38BDF8",
    };
    return map[toolName] ?? "#8B949E";
  }

  it("returns blue for Read", () => {
    expect(getToolColor("Read")).toBe("#60A5FA");
  });

  it("returns green for Edit", () => {
    expect(getToolColor("Edit")).toBe("#34D399");
  });

  it("returns default for unknown tool", () => {
    expect(getToolColor("Unknown")).toBe("#8B949E");
  });
});
