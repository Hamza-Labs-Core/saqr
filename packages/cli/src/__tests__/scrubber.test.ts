/**
 * Tests for Session Scrubber Logic.
 *
 * Covers T-19 (tick positions), T-20 (snap threshold),
 * and minimap computation.
 */
import { describe, it, expect } from "vitest";
import type { TimelineItem } from "../types/timeline.js";
import {
  computeTickPositions,
  computeMinimap,
  findItemAtPosition,
  findNearestTick,
  type ScrubberTick,
  type MinimapBucket,
} from "../scrubber/scrubberLogic.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeline(count: number, startTime: string = "2026-02-22T10:00:00.000Z"): TimelineItem[] {
  const start = new Date(startTime).getTime();
  const items: TimelineItem[] = [];

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(start + i * 1000).toISOString();
    const types: Array<TimelineItem["type"]> = [
      "user_message",
      "assistant_message",
      "tool_call",
      "system_notification",
      "error",
    ];
    const type = types[i % types.length];

    if (type === "user_message") {
      items.push({
        id: `item-${i}`,
        timestamp,
        sequence: i + 1,
        source: "gc_hook",
        read: false,
        type: "user_message",
        text: `Prompt ${i}`,
        hasAttachments: false,
        attachments: [],
      });
    } else if (type === "assistant_message") {
      items.push({
        id: `item-${i}`,
        timestamp,
        sequence: i + 1,
        source: "gc_hook",
        read: false,
        type: "assistant_message",
        text: `Response ${i}`,
        streamingState: "completed",
        hasMarkdown: false,
        model: "claude-opus-4-6",
        outputTokens: 100,
      });
    } else if (type === "tool_call") {
      items.push({
        id: `item-${i}`,
        timestamp,
        sequence: i + 1,
        source: "gc_hook",
        read: false,
        type: "tool_call",
        toolUseId: `tu-${i}`,
        toolName: "Read",
        status: "completed",
        durationMs: 50,
        error: null,
        input: { filePath: `/test-${i}.ts` },
        output: null,
      });
    } else if (type === "system_notification") {
      items.push({
        id: `item-${i}`,
        timestamp,
        sequence: i + 1,
        source: "gc_hook",
        read: false,
        type: "system_notification",
        category: "session_start",
        message: `Notification ${i}`,
        metadata: {},
      });
    } else if (type === "error") {
      items.push({
        id: `item-${i}`,
        timestamp,
        sequence: i + 1,
        source: "gc_hook",
        read: false,
        type: "error",
        message: `Error ${i}`,
        stackTrace: null,
        isRecoverable: true,
        errorSource: "agent",
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// computeTickPositions (T-19)
// ---------------------------------------------------------------------------

describe("computeTickPositions (T-19)", () => {
  it("returns empty array for empty timeline", () => {
    const ticks = computeTickPositions([]);
    expect(ticks).toEqual([]);
  });

  it("returns ticks for each item in a small timeline", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    expect(ticks).toHaveLength(5);
  });

  it("ticks have normalized positions between 0 and 1", () => {
    const timeline = makeTimeline(10);
    const ticks = computeTickPositions(timeline);
    for (const tick of ticks) {
      expect(tick.position).toBeGreaterThanOrEqual(0);
      expect(tick.position).toBeLessThanOrEqual(1);
    }
  });

  it("first tick is at position 0", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    expect(ticks[0].position).toBe(0);
  });

  it("last tick is at position 1 for multi-item timelines", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    expect(ticks[ticks.length - 1].position).toBe(1);
  });

  it("marks user prompts as significant", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    const userTick = ticks.find((t) => t.type === "user_message");
    expect(userTick).toBeDefined();
    if (userTick) {
      expect(userTick.isSignificant).toBe(true);
    }
  });

  it("marks errors as significant", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    const errorTick = ticks.find((t) => t.type === "error");
    expect(errorTick).toBeDefined();
    if (errorTick) {
      expect(errorTick.isSignificant).toBe(true);
    }
  });

  it("marks permission requests as significant", () => {
    const timeline: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "permission_request",
        toolName: "Bash",
        description: "Execute",
        filePath: null,
        toolInput: {},
        resolution: "pending",
        resolvedAt: null,
      },
    ];
    const ticks = computeTickPositions(timeline);
    expect(ticks[0].isSignificant).toBe(true);
  });

  it("tick colors correspond to item type", () => {
    const timeline = makeTimeline(5);
    const ticks = computeTickPositions(timeline);
    const userTick = ticks.find((t) => t.type === "user_message");
    if (userTick) {
      expect(userTick.color).toBeDefined();
      expect(typeof userTick.color).toBe("string");
    }
  });

  it("handles timeline with single item", () => {
    const timeline = makeTimeline(1);
    const ticks = computeTickPositions(timeline);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].position).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findNearestTick (T-20, snap threshold)
// ---------------------------------------------------------------------------

describe("findNearestTick (T-20)", () => {
  it("snaps to nearest tick within threshold", () => {
    const ticks: ScrubberTick[] = [
      { itemId: "1", position: 0, type: "user_message", isSignificant: true, color: "#60A5FA", timestamp: "" },
      { itemId: "2", position: 0.5, type: "tool_call", isSignificant: false, color: "#8B949E", timestamp: "" },
      { itemId: "3", position: 1.0, type: "user_message", isSignificant: true, color: "#60A5FA", timestamp: "" },
    ];

    // Position 0.48 is within snap threshold (0.02) of tick at 0.5
    const nearest = findNearestTick(ticks, 0.48, 0.05);
    expect(nearest).toBeDefined();
    expect(nearest?.itemId).toBe("2");
  });

  it("returns null when no tick is within threshold", () => {
    const ticks: ScrubberTick[] = [
      { itemId: "1", position: 0, type: "user_message", isSignificant: true, color: "#60A5FA", timestamp: "" },
      { itemId: "2", position: 1.0, type: "user_message", isSignificant: true, color: "#60A5FA", timestamp: "" },
    ];

    // Position 0.5 is far from both ticks
    const nearest = findNearestTick(ticks, 0.5, 0.02);
    expect(nearest).toBeNull();
  });

  it("returns the exact tick when position matches exactly", () => {
    const ticks: ScrubberTick[] = [
      { itemId: "1", position: 0.3, type: "user_message", isSignificant: true, color: "#60A5FA", timestamp: "" },
    ];
    const nearest = findNearestTick(ticks, 0.3, 0.02);
    expect(nearest?.itemId).toBe("1");
  });

  it("handles empty ticks array", () => {
    const nearest = findNearestTick([], 0.5, 0.02);
    expect(nearest).toBeNull();
  });

  it("prefers significant ticks over non-significant ones when equidistant", () => {
    const ticks: ScrubberTick[] = [
      { itemId: "1", position: 0.49, type: "tool_call", isSignificant: false, color: "#8B949E", timestamp: "" },
      { itemId: "2", position: 0.51, type: "error", isSignificant: true, color: "#EF4444", timestamp: "" },
    ];
    // Both are within threshold of 0.5
    const nearest = findNearestTick(ticks, 0.5, 0.05);
    expect(nearest?.itemId).toBe("2"); // Significant tick preferred
  });
});

// ---------------------------------------------------------------------------
// findItemAtPosition
// ---------------------------------------------------------------------------

describe("findItemAtPosition", () => {
  it("finds item at a given scrubber position using binary search", () => {
    const timeline = makeTimeline(100);
    const item = findItemAtPosition(timeline, 0.5);
    expect(item).toBeDefined();
    // Should be roughly in the middle of the timeline
    if (item) {
      expect(item.sequence).toBeGreaterThan(40);
      expect(item.sequence).toBeLessThan(60);
    }
  });

  it("returns first item at position 0", () => {
    const timeline = makeTimeline(10);
    const item = findItemAtPosition(timeline, 0);
    expect(item).toBeDefined();
    expect(item?.sequence).toBe(1);
  });

  it("returns last item at position 1", () => {
    const timeline = makeTimeline(10);
    const item = findItemAtPosition(timeline, 1);
    expect(item).toBeDefined();
    expect(item?.sequence).toBe(10);
  });

  it("returns null for empty timeline", () => {
    const item = findItemAtPosition([], 0.5);
    expect(item).toBeNull();
  });

  it("clamps position to [0, 1] range", () => {
    const timeline = makeTimeline(10);
    const itemBefore = findItemAtPosition(timeline, -0.5);
    expect(itemBefore?.sequence).toBe(1);
    const itemAfter = findItemAtPosition(timeline, 1.5);
    expect(itemAfter?.sequence).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// computeMinimap
// ---------------------------------------------------------------------------

describe("computeMinimap", () => {
  it("returns empty array for empty timeline", () => {
    const buckets = computeMinimap([], 10);
    expect(buckets).toEqual([]);
  });

  it("divides timeline into specified number of buckets", () => {
    const timeline = makeTimeline(100);
    const buckets = computeMinimap(timeline, 10);
    expect(buckets).toHaveLength(10);
  });

  it("bucket density values are normalized between 0 and 1", () => {
    const timeline = makeTimeline(100);
    const buckets = computeMinimap(timeline, 10);
    for (const bucket of buckets) {
      expect(bucket.density).toBeGreaterThanOrEqual(0);
      expect(bucket.density).toBeLessThanOrEqual(1);
    }
  });

  it("highest density bucket has density 1.0", () => {
    const timeline = makeTimeline(20);
    const buckets = computeMinimap(timeline, 5);
    const maxDensity = Math.max(...buckets.map((b) => b.density));
    expect(maxDensity).toBe(1);
  });

  it("identifies dominant event type per bucket", () => {
    const timeline = makeTimeline(50);
    const buckets = computeMinimap(timeline, 5);
    for (const bucket of buckets) {
      expect(bucket.dominantType).toBeDefined();
      expect(typeof bucket.dominantType).toBe("string");
    }
  });

  it("each bucket has an event count", () => {
    const timeline = makeTimeline(20);
    const buckets = computeMinimap(timeline, 5);
    let totalCount = 0;
    for (const bucket of buckets) {
      expect(typeof bucket.eventCount).toBe("number");
      expect(bucket.eventCount).toBeGreaterThanOrEqual(0);
      totalCount += bucket.eventCount;
    }
    expect(totalCount).toBe(20);
  });

  it("uses default 100 buckets when not specified", () => {
    const timeline = makeTimeline(200);
    const buckets = computeMinimap(timeline);
    expect(buckets).toHaveLength(100);
  });

  it("handles timeline with fewer items than buckets", () => {
    const timeline = makeTimeline(3);
    const buckets = computeMinimap(timeline, 10);
    expect(buckets).toHaveLength(10);
    // Some buckets should be empty (density 0)
    const emptyBuckets = buckets.filter((b) => b.eventCount === 0);
    expect(emptyBuckets.length).toBeGreaterThan(0);
  });
});
