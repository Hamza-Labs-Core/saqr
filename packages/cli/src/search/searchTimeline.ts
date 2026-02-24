/**
 * Search within a session timeline.
 *
 * Full-text search across all TimelineItem[] with filters for event type,
 * tool name, file path, date range, case sensitivity, and regex mode.
 *
 * @module search/searchTimeline
 */

import type { TimelineItem, TimelineItemType } from "../types/timeline.js";
import { extractSearchableText } from "./extractSearchableText.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Search filter options.
 */
export interface SearchFilters {
  /** Filter by timeline item types. */
  types?: TimelineItemType[];
  /** Filter by tool names (for tool_call items). */
  toolNames?: string[];
  /** Filter by file path pattern (substring match or regex). */
  filePathPattern?: string;
  /** Filter items from this timestamp onward (inclusive). */
  dateFrom?: string;
  /** Filter items up to this timestamp (inclusive). */
  dateTo?: string;
  /** Case-sensitive search (default: false). */
  caseSensitive?: boolean;
  /** Use regex pattern matching (default: false). */
  useRegex?: boolean;
  /** Maximum number of results to return. */
  limit?: number;
}

/**
 * A match range within a snippet for highlighting.
 */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * A single search result.
 */
export interface TimelineSearchResult {
  /** ID of the matched timeline item. */
  itemId: string;
  /** Type of the matched timeline item. */
  itemType: TimelineItemType;
  /** Text snippet with context around the match. */
  snippet: string;
  /** Match ranges within the snippet for highlighting. */
  matchRanges: MatchRange[];
  /** Timestamp of the matched item (for sorting). */
  timestamp: string;
  /** Sequence number of the matched item. */
  sequence: number;
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Searches across a timeline for items matching the query and filters.
 *
 * @param timeline - The timeline items to search through.
 * @param query - The search query string.
 * @param filters - Optional filters to narrow results.
 * @returns Array of search results sorted by timestamp.
 */
export function searchTimeline(
  timeline: ReadonlyArray<TimelineItem>,
  query: string,
  filters: SearchFilters,
): TimelineSearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  if (timeline.length === 0) return [];

  // Build the match function
  const matchFn = buildMatchFunction(trimmedQuery, filters);
  if (!matchFn) return []; // Invalid regex

  const limit = filters.limit ?? Infinity;
  const results: TimelineSearchResult[] = [];

  for (const item of timeline) {
    // Apply type filter
    if (filters.types && !filters.types.includes(item.type)) {
      continue;
    }

    // Apply tool name filter
    if (filters.toolNames) {
      if (item.type !== "tool_call") continue;
      if (!filters.toolNames.includes(item.toolName)) continue;
    }

    // Apply file path filter
    if (filters.filePathPattern) {
      if (!matchesFilePath(item, filters.filePathPattern)) continue;
    }

    // Apply date range filter
    if (filters.dateFrom && item.timestamp < filters.dateFrom) continue;
    if (filters.dateTo && item.timestamp > filters.dateTo) continue;

    // Extract searchable text and match
    const searchText = extractSearchableText(item);
    const matchResult = matchFn(searchText);

    if (matchResult) {
      const { snippet, matchRanges } = generateSnippet(
        searchText,
        matchResult.index,
        matchResult.matchLength,
        50,
      );

      results.push({
        itemId: item.id,
        itemType: item.type,
        snippet,
        matchRanges,
        timestamp: item.timestamp,
        sequence: item.sequence,
      });

      if (results.length >= limit) break;
    }
  }

  // Sort by timestamp ascending
  results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return results;
}

// ---------------------------------------------------------------------------
// Match function builder
// ---------------------------------------------------------------------------

interface MatchResult {
  index: number;
  matchLength: number;
}

type MatchFunction = (text: string) => MatchResult | null;

function buildMatchFunction(
  query: string,
  filters: SearchFilters,
): MatchFunction | null {
  const caseSensitive = filters.caseSensitive ?? false;
  const useRegex = filters.useRegex ?? false;

  if (useRegex) {
    try {
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);
      return (text: string) => {
        regex.lastIndex = 0;
        const match = regex.exec(text);
        if (!match) return null;
        return { index: match.index, matchLength: match[0].length };
      };
    } catch {
      // Invalid regex
      return null;
    }
  }

  // Literal search
  if (caseSensitive) {
    return (text: string) => {
      const idx = text.indexOf(query);
      if (idx < 0) return null;
      return { index: idx, matchLength: query.length };
    };
  }

  const lowerQuery = query.toLowerCase();
  return (text: string) => {
    const idx = text.toLowerCase().indexOf(lowerQuery);
    if (idx < 0) return null;
    return { index: idx, matchLength: query.length };
  };
}

// ---------------------------------------------------------------------------
// File path matching
// ---------------------------------------------------------------------------

function matchesFilePath(item: TimelineItem, pattern: string): boolean {
  if (item.type === "tool_call") {
    const filePath = getToolCallFilePath(item);
    if (filePath) {
      return filePath.toLowerCase().includes(pattern.toLowerCase());
    }
  }
  if (item.type === "permission_request" && item.filePath) {
    return item.filePath.toLowerCase().includes(pattern.toLowerCase());
  }
  if (item.type === "error" && item.stackTrace) {
    return item.stackTrace.toLowerCase().includes(pattern.toLowerCase());
  }
  return false;
}

function getToolCallFilePath(item: TimelineItem & { type: "tool_call" }): string | null {
  switch (item.toolName) {
    case "Read":
      return item.input.filePath;
    case "Edit":
      return item.input.filePath;
    case "Write":
      return item.input.filePath;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Snippet generation
// ---------------------------------------------------------------------------

function generateSnippet(
  text: string,
  matchIndex: number,
  matchLength: number,
  contextChars: number,
): { snippet: string; matchRanges: MatchRange[] } {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLength + contextChars);

  let snippet = text.slice(start, end);
  let adjustedStart = matchIndex - start;

  // Add ellipsis indicators
  if (start > 0) {
    snippet = "..." + snippet;
    adjustedStart += 3;
  }
  if (end < text.length) {
    snippet = snippet + "...";
  }

  // Replace newlines with spaces for single-line display
  const newlineAdjusted = snippet.replace(/\n/g, " ");
  // Recalculate match position after newline replacement
  const preMatch = snippet.slice(0, adjustedStart).replace(/\n/g, " ");
  const adjustedIndex = preMatch.length;

  return {
    snippet: newlineAdjusted,
    matchRanges: [
      {
        start: adjustedIndex,
        end: adjustedIndex + matchLength,
      },
    ],
  };
}
