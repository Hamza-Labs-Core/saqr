/**
 * Session Scrubber Logic.
 *
 * Computes tick positions, minimap density buckets, and provides
 * time-based navigation (binary search for timestamp lookup).
 *
 * @module scrubber/scrubberLogic
 */

import type { TimelineItem, TimelineItemType } from "../types/timeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tick mark on the scrubber bar.
 */
export interface ScrubberTick {
  /** ID of the timeline item this tick represents. */
  itemId: string;
  /** Normalized position on the bar (0.0 to 1.0). */
  position: number;
  /** Type of the timeline item. */
  type: TimelineItemType;
  /** Whether this is a significant event (user prompt, error, permission). */
  isSignificant: boolean;
  /** Color for this tick mark. */
  color: string;
  /** ISO timestamp of the event. */
  timestamp: string;
}

/**
 * A density bucket for the minimap.
 */
export interface MinimapBucket {
  /** Number of events in this bucket. */
  eventCount: number;
  /** Normalized density (0.0 to 1.0, relative to the densest bucket). */
  density: number;
  /** The dominant event type in this bucket. */
  dominantType: TimelineItemType;
}

// ---------------------------------------------------------------------------
// Tick color mapping
// ---------------------------------------------------------------------------

const TICK_COLORS: Partial<Record<TimelineItemType, string>> = {
  user_message: "#60A5FA",
  error: "#EF4444",
  permission_request: "#FBBF24",
  tool_call: "#8B949E",
  assistant_message: "#8B949E",
  thinking_block: "#8B949E",
  system_notification: "#8B949E",
  compact_notification: "#8B949E",
  permission_resolved: "#8B949E",
  usage_update: "#8B949E",
};

/**
 * Significant event types that get taller tick marks.
 */
const SIGNIFICANT_TYPES = new Set<TimelineItemType>([
  "user_message",
  "error",
  "permission_request",
]);

// ---------------------------------------------------------------------------
// computeTickPositions
// ---------------------------------------------------------------------------

/**
 * Compute tick positions for a timeline.
 *
 * Each item gets a tick at a position proportional to its timestamp
 * within the session duration.
 *
 * @param timeline - The timeline items (assumed sorted by timestamp).
 * @returns Array of ScrubberTick objects.
 */
export function computeTickPositions(
  timeline: ReadonlyArray<TimelineItem>,
): ScrubberTick[] {
  if (timeline.length === 0) return [];

  const startTime = new Date(timeline[0].timestamp).getTime();
  const endTime = new Date(timeline[timeline.length - 1].timestamp).getTime();
  const duration = endTime - startTime;

  return timeline.map((item) => {
    const itemTime = new Date(item.timestamp).getTime();
    const position = duration > 0 ? (itemTime - startTime) / duration : 0;

    return {
      itemId: item.id,
      position,
      type: item.type,
      isSignificant: SIGNIFICANT_TYPES.has(item.type),
      color: TICK_COLORS[item.type] ?? "#8B949E",
      timestamp: item.timestamp,
    };
  });
}

// ---------------------------------------------------------------------------
// findNearestTick
// ---------------------------------------------------------------------------

/**
 * Find the nearest tick to a given position on the scrubber bar.
 *
 * @param ticks - Array of tick marks.
 * @param position - The position to find the nearest tick for (0.0 to 1.0).
 * @param threshold - Maximum distance to consider a snap (default: 0.02).
 * @returns The nearest tick within threshold, or null if none is close enough.
 *          Prefers significant ticks when equidistant.
 */
export function findNearestTick(
  ticks: ReadonlyArray<ScrubberTick>,
  position: number,
  threshold: number = 0.02,
): ScrubberTick | null {
  if (ticks.length === 0) return null;

  let nearest: ScrubberTick | null = null;
  let nearestDist = Infinity;

  for (const tick of ticks) {
    const dist = Math.abs(tick.position - position);
    if (dist > threshold) continue;

    if (dist < nearestDist) {
      nearest = tick;
      nearestDist = dist;
    } else if (dist === nearestDist && nearest) {
      // Prefer significant ticks when equidistant
      if (tick.isSignificant && !nearest.isSignificant) {
        nearest = tick;
      }
    }
  }

  return nearest;
}

// ---------------------------------------------------------------------------
// findItemAtPosition
// ---------------------------------------------------------------------------

/**
 * Find the timeline item closest to a given scrubber position.
 * Uses binary search on timestamps for efficiency.
 *
 * @param timeline - The timeline items (assumed sorted by timestamp).
 * @param position - The normalized position (0.0 to 1.0).
 * @returns The closest timeline item, or null for empty timelines.
 */
export function findItemAtPosition(
  timeline: ReadonlyArray<TimelineItem>,
  position: number,
): TimelineItem | null {
  if (timeline.length === 0) return null;

  // Clamp position
  const clamped = Math.max(0, Math.min(1, position));

  if (timeline.length === 1) return timeline[0];

  const startTime = new Date(timeline[0].timestamp).getTime();
  const endTime = new Date(timeline[timeline.length - 1].timestamp).getTime();
  const duration = endTime - startTime;

  if (duration === 0) {
    // All items at the same time; return the one at the proportional index
    const idx = Math.round(clamped * (timeline.length - 1));
    return timeline[idx];
  }

  const targetTime = startTime + clamped * duration;

  // Binary search for the item closest to targetTime
  let lo = 0;
  let hi = timeline.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midTime = new Date(timeline[mid].timestamp).getTime();

    if (midTime < targetTime) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first item >= targetTime
  // Check if lo or lo-1 is closer
  if (lo === 0) return timeline[0];

  const timeLo = new Date(timeline[lo].timestamp).getTime();
  const timePrev = new Date(timeline[lo - 1].timestamp).getTime();

  if (Math.abs(timeLo - targetTime) <= Math.abs(timePrev - targetTime)) {
    return timeline[lo];
  }
  return timeline[lo - 1];
}

// ---------------------------------------------------------------------------
// computeMinimap
// ---------------------------------------------------------------------------

/**
 * Compute a minimap (event density histogram) for the scrubber.
 *
 * Divides the session duration into equal time buckets and counts
 * events per bucket. Density values are normalized 0.0 to 1.0
 * relative to the densest bucket.
 *
 * @param timeline - The timeline items (assumed sorted by timestamp).
 * @param bucketCount - Number of buckets (default: 100).
 * @returns Array of MinimapBucket objects.
 */
export function computeMinimap(
  timeline: ReadonlyArray<TimelineItem>,
  bucketCount: number = 100,
): MinimapBucket[] {
  if (timeline.length === 0) return [];

  const startTime = new Date(timeline[0].timestamp).getTime();
  const endTime = new Date(timeline[timeline.length - 1].timestamp).getTime();
  const duration = endTime - startTime;

  // Initialize buckets
  const buckets: Array<{
    eventCount: number;
    typeCounts: Map<TimelineItemType, number>;
  }> = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ eventCount: 0, typeCounts: new Map() });
  }

  // Fill buckets
  for (const item of timeline) {
    const itemTime = new Date(item.timestamp).getTime();
    let bucketIdx: number;

    if (duration === 0) {
      // All items at same time, put in first bucket
      bucketIdx = 0;
    } else {
      bucketIdx = Math.min(
        Math.floor(((itemTime - startTime) / duration) * bucketCount),
        bucketCount - 1,
      );
    }

    buckets[bucketIdx].eventCount++;
    const current = buckets[bucketIdx].typeCounts.get(item.type) ?? 0;
    buckets[bucketIdx].typeCounts.set(item.type, current + 1);
  }

  // Find max density for normalization
  const maxCount = Math.max(...buckets.map((b) => b.eventCount), 1);

  // Build result
  return buckets.map((bucket) => {
    // Find dominant type
    let dominantType: TimelineItemType = "system_notification";
    let dominantCount = 0;
    for (const [type, count] of bucket.typeCounts) {
      if (count > dominantCount) {
        dominantType = type;
        dominantCount = count;
      }
    }

    return {
      eventCount: bucket.eventCount,
      density: bucket.eventCount / maxCount,
      dominantType,
    };
  });
}
