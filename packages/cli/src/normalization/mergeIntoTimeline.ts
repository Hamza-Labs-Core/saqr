/**
 * Timeline merge logic.
 *
 * Merges new TimelineItems into an existing timeline, handling correlation
 * of ToolCallRequested + ToolCallCompleted via toolUseId.
 *
 * @module normalization/mergeIntoTimeline
 */

import type { TimelineItem, ToolCall } from "../types/timeline.js";

/**
 * Merges new timeline items into the existing timeline.
 *
 * - If a new item has a toolUseId matching an existing tool_call item,
 *   the existing item is updated (merged) with the new data.
 * - Otherwise, the new item is appended.
 * - The result is sorted by sequence number.
 * - Does NOT mutate the original timeline array.
 *
 * @param timeline - The current timeline (not mutated).
 * @param newItems - New items to merge in.
 * @returns A new timeline array with the items merged.
 */
export function mergeIntoTimeline(
  timeline: ReadonlyArray<TimelineItem>,
  newItems: ReadonlyArray<TimelineItem>,
): TimelineItem[] {
  // Build a mutable copy of the timeline
  const result = [...timeline];

  // Build an index of existing tool_call items by toolUseId for fast lookup
  const toolCallIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (item.type === "tool_call") {
      toolCallIndex.set(item.toolUseId, i);
    }
  }

  for (const newItem of newItems) {
    if (newItem.type === "tool_call") {
      const existingIdx = toolCallIndex.get(newItem.toolUseId);
      if (existingIdx !== undefined) {
        // Merge: update the existing tool_call item in-place
        const existing = result[existingIdx] as ToolCall;
        result[existingIdx] = mergeToolCall(existing, newItem);
        continue;
      }
    }

    // No merge needed: append the new item
    result.push(newItem);

    // Update the index if it's a tool_call
    if (newItem.type === "tool_call") {
      toolCallIndex.set(newItem.toolUseId, result.length - 1);
    }
  }

  // Sort by sequence number
  result.sort((a, b) => a.sequence - b.sequence);

  return result;
}

/**
 * Merges a completed/failed tool call into an existing running tool call.
 * The new item's data takes precedence for fields that represent completion.
 */
function mergeToolCall(existing: ToolCall, incoming: ToolCall): ToolCall {
  // The incoming item has higher-priority fields (status, output, error, durationMs)
  // while the existing item preserves its original position (sequence) and input
  return {
    ...existing,
    status: incoming.status,
    durationMs: incoming.durationMs ?? existing.durationMs,
    error: incoming.error ?? existing.error,
    output: incoming.output ?? existing.output,
  } as ToolCall;
}
