/**
 * useTimeline — accumulates and manages a TimelineItem[] array.
 *
 * Handles merging of streaming events, deduplication, and sorting.
 */
import { useState, useCallback } from "react";
import type { TimelineItem } from "../types.js";

export interface UseTimelineResult {
  /** Current timeline items, sorted by sequence */
  items: TimelineItem[];

  /** Add or merge a single item */
  addItem: (item: TimelineItem) => void;

  /** Add multiple items (e.g., initial replay) */
  addItems: (items: TimelineItem[]) => void;

  /** Clear all items */
  clear: () => void;

  /** Number of items */
  count: number;
}

/**
 * Merge a new item into the timeline array.
 *
 * If an item with the same ID exists:
 * - For streaming items (AssistantMessage, ThinkingBlock), update in place
 * - For tool calls, update status and output
 * Otherwise, insert at the correct position (sorted by sequence).
 */
function mergeIntoTimeline(items: TimelineItem[], newItem: TimelineItem): TimelineItem[] {
  const existingIndex = items.findIndex((i) => i.id === newItem.id);

  if (existingIndex !== -1) {
    // Update existing item
    const updated = [...items];
    updated[existingIndex] = newItem;
    return updated;
  }

  // Insert at correct position (sorted by sequence)
  const inserted = [...items, newItem];
  inserted.sort((a, b) => a.sequence - b.sequence);
  return inserted;
}

export function useTimeline(): UseTimelineResult {
  const [items, setItems] = useState<TimelineItem[]>([]);

  const addItem = useCallback((item: TimelineItem) => {
    setItems((prev) => mergeIntoTimeline(prev, item));
  }, []);

  const addItems = useCallback((newItems: TimelineItem[]) => {
    setItems((prev) => {
      let result = prev;
      for (const item of newItems) {
        result = mergeIntoTimeline(result, item);
      }
      return result;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  return {
    items,
    addItem,
    addItems,
    clear,
    count: items.length,
  };
}
