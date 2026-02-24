/**
 * SearchIndex — full-text search index across all sessions.
 *
 * The SearchIndex provides full-text search capabilities across event data,
 * tool calls, prompts, and agent responses. It maintains an in-memory
 * inverted index that is rebuilt from the event store on daemon startup
 * and incrementally updated as new events arrive.
 *
 * Search targets:
 * - User prompts (UserPromptReceived events)
 * - Tool names and inputs (ToolCallRequested/Completed events)
 * - Agent responses (TurnCompleted events)
 * - Decision rationales (from projection data)
 * - File paths (from FilesTouched projections)
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Common English stop words to skip during indexing
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "because", "but", "and", "or", "if", "while",
  "about", "up", "it", "its", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their", "what", "which", "who", "whom",
]);

/**
 * Location of a term in the index.
 */
interface IndexLocation {
  eventId: string;
  projectId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  field: string;
  timestamp: string;
  /** The full text from the field that contains the match */
  fieldText: string;
}

/**
 * A search result entry.
 */
export interface SearchResult {
  /** The event that matched */
  eventId: string;

  /** Project containing the match */
  projectId: string;

  /** Session containing the match */
  sessionId: string;

  /** Event sequence number */
  sequence: number;

  /** Event type */
  eventType: string;

  /** The field that matched */
  matchField: string;

  /** Text snippet showing the match with context */
  snippet: string;

  /** Relevance score (higher = more relevant) */
  score: number;

  /** Event timestamp */
  timestamp: string;
}

/**
 * Search query options.
 */
export interface SearchQuery {
  /** The search text */
  text: string;

  /** Optional: restrict search to a specific project */
  projectId?: string;

  /** Optional: restrict search to a specific session */
  sessionId?: string;

  /** Optional: restrict search to specific event types */
  eventTypes?: string[];

  /** Maximum number of results. Default: 20 */
  limit?: number;

  /** Offset for pagination. Default: 0 */
  offset?: number;
}

/**
 * Index statistics.
 */
export interface IndexStats {
  /** Total number of indexed documents (events) */
  documentCount: number;

  /** Total number of unique terms in the index */
  termCount: number;

  /** Approximate memory used by the index */
  memoryUsedBytes: number;

  /** Last time the index was rebuilt from scratch */
  lastFullRebuild: Date | null;

  /** Last time the index was incrementally updated */
  lastUpdate: Date | null;
}

// Regex for tokenization: split on whitespace and punctuation
const TOKEN_SPLIT_RE = /[\s\t\n\r,.;:!?(){}[\]"'/\\|<>@#$%^&*+=~`]+/;

/**
 * Tokenize a text string into normalized terms.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens = text.toLowerCase().split(TOKEN_SPLIT_RE);
  return tokens.filter(
    (t) => t.length >= 2 && t.length <= 100 && !STOP_WORDS.has(t),
  );
}

/**
 * Generate a snippet around a match term in the source text.
 */
function generateSnippet(text: string, term: string, maxLen = 100): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) {
    return text.slice(0, maxLen);
  }

  const contextPad = Math.floor((maxLen - term.length) / 2);
  const start = Math.max(0, idx - contextPad);
  const end = Math.min(text.length, idx + term.length + contextPad);

  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

/**
 * Full-text search index for event data.
 *
 * Maintains an in-memory inverted index for fast text search
 * across all events in the store.
 */
export class SearchIndex {
  private lastFullRebuild: Date | null = null;
  private lastUpdate: Date | null = null;
  private documentCount = 0;

  /** Inverted index: normalized term -> list of locations */
  private invertedIndex = new Map<string, IndexLocation[]>();

  /**
   * Build or rebuild the full search index from the event store.
   *
   * Called on daemon startup. Scans all events and builds the
   * inverted index from scratch.
   *
   * @param eventsDir - Root directory of the event store
   */
  async rebuild(eventsDir: string): Promise<void> {
    this.clear();

    let projectDirs: string[];
    try {
      projectDirs = await readdir(eventsDir);
    } catch {
      this.lastFullRebuild = new Date();
      return;
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(eventsDir, projDir);
      const pst = await safeStat(projPath);
      if (!pst?.isDirectory()) continue;

      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(projPath);
      } catch {
        continue;
      }

      for (const sessDir of sessionDirs) {
        const sessPath = path.join(projPath, sessDir);
        const sst = await safeStat(sessPath);
        if (!sst?.isDirectory()) continue;

        let files: string[];
        try {
          files = await readdir(sessPath);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!/^\d{6}\.json$/.test(file)) continue;

          try {
            const raw = await readFile(path.join(sessPath, file), "utf-8");
            const event = JSON.parse(raw);
            this.indexEvent(
              event.event_id ?? `${projDir}:${sessDir}:${file}`,
              event.project_id ?? projDir,
              event.session_id ?? sessDir,
              event.sequence ?? parseInt(file.replace(".json", ""), 10),
              event.event_type ?? "unknown",
              event.timestamp ?? "",
              event.data ?? {},
            );
          } catch {
            // Skip corrupt files
          }
        }
      }
    }

    this.lastFullRebuild = new Date();
  }

  /**
   * Incrementally add a new event to the index.
   *
   * Called when a new event is received via the EventBus.
   */
  indexEvent(
    eventId: string,
    projectId: string,
    sessionId: string,
    sequence: number,
    eventType: string,
    timestamp: string,
    data: Record<string, unknown>,
  ): void {
    const fields = this.extractSearchableFields(eventType, data);

    for (const { field, text } of fields) {
      const tokens = tokenize(text);
      for (const token of tokens) {
        let locations = this.invertedIndex.get(token);
        if (!locations) {
          locations = [];
          this.invertedIndex.set(token, locations);
        }
        locations.push({
          eventId,
          projectId,
          sessionId,
          sequence,
          eventType,
          field,
          timestamp,
          fieldText: text,
        });
      }
    }

    this.documentCount++;
    this.lastUpdate = new Date();
  }

  /**
   * Search the index.
   *
   * @param query - Search query with text and optional filters
   * @returns Array of search results sorted by relevance
   */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!query.text || query.text.trim().length === 0) {
      return [];
    }

    const queryTokens = tokenize(query.text);
    if (queryTokens.length === 0) {
      return [];
    }

    // Collect matches: eventId -> { count, locations }
    const matchMap = new Map<
      string,
      { count: number; locations: IndexLocation[] }
    >();

    for (const token of queryTokens) {
      const locations = this.invertedIndex.get(token);
      if (!locations) continue;

      for (const loc of locations) {
        // Apply filters
        if (query.projectId && loc.projectId !== query.projectId) continue;
        if (query.sessionId && loc.sessionId !== query.sessionId) continue;
        if (query.eventTypes && !query.eventTypes.includes(loc.eventType)) continue;

        const existing = matchMap.get(loc.eventId);
        if (existing) {
          existing.count++;
          existing.locations.push(loc);
        } else {
          matchMap.set(loc.eventId, { count: 1, locations: [loc] });
        }
      }
    }

    // Build results sorted by relevance (match count desc, then timestamp desc)
    const results: SearchResult[] = [];

    for (const [eventId, { count, locations }] of matchMap) {
      const loc = locations[0]; // Use first location for primary info
      results.push({
        eventId,
        projectId: loc.projectId,
        sessionId: loc.sessionId,
        sequence: loc.sequence,
        eventType: loc.eventType,
        matchField: loc.field,
        snippet: generateSnippet(loc.fieldText, queryTokens[0]),
        score: count,
        timestamp: loc.timestamp,
      });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.timestamp.localeCompare(a.timestamp);
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    return results.slice(offset, offset + limit);
  }

  /**
   * Get index statistics.
   */
  getStats(): IndexStats {
    // Estimate memory: each term entry ~ 50 bytes + locations * 100 bytes
    let locationCount = 0;
    for (const locs of this.invertedIndex.values()) {
      locationCount += locs.length;
    }
    const estimatedMemory =
      this.invertedIndex.size * 50 + locationCount * 100;

    return {
      documentCount: this.documentCount,
      termCount: this.invertedIndex.size,
      memoryUsedBytes: estimatedMemory,
      lastFullRebuild: this.lastFullRebuild,
      lastUpdate: this.lastUpdate,
    };
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.invertedIndex.clear();
    this.documentCount = 0;
    this.lastFullRebuild = null;
    this.lastUpdate = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract searchable text fields from event data based on event type.
   */
  private extractSearchableFields(
    eventType: string,
    data: Record<string, unknown>,
  ): Array<{ field: string; text: string }> {
    const fields: Array<{ field: string; text: string }> = [];

    switch (eventType) {
      case "UserPromptReceived": {
        const prompt = data.prompt;
        if (typeof prompt === "string") {
          fields.push({ field: "prompt", text: prompt });
        }
        break;
      }

      case "ToolCallRequested":
      case "ToolCallCompleted": {
        const toolName = data.tool_name;
        if (typeof toolName === "string") {
          fields.push({ field: "tool_name", text: toolName });
        }

        const toolInput = data.tool_input as Record<string, unknown> | undefined;
        if (toolInput) {
          if (typeof toolInput.file_path === "string") {
            fields.push({ field: "file_path", text: toolInput.file_path });
            // Also index path components
            const components = toolInput.file_path.split("/").filter(Boolean);
            for (const comp of components) {
              fields.push({ field: "file_path", text: comp });
            }
          }
          if (typeof toolInput.command === "string") {
            fields.push({ field: "command", text: toolInput.command });
          }
          if (typeof toolInput.pattern === "string") {
            fields.push({ field: "pattern", text: toolInput.pattern });
          }
        }

        if (eventType === "ToolCallCompleted") {
          const response = data.tool_response;
          if (typeof response === "string") {
            // Limit indexed response text to prevent bloat
            fields.push({
              field: "tool_response",
              text: response.slice(0, 500),
            });
          }
        }
        break;
      }

      case "ToolCallFailed": {
        const toolName = data.tool_name;
        if (typeof toolName === "string") {
          fields.push({ field: "tool_name", text: toolName });
        }
        const error = data.error;
        if (typeof error === "string") {
          fields.push({ field: "error", text: error });
        }
        break;
      }

      case "SessionStarted": {
        const cwd = data.cwd;
        if (typeof cwd === "string") {
          fields.push({ field: "cwd", text: cwd });
        }
        const model = data.model;
        if (typeof model === "string") {
          fields.push({ field: "model", text: model });
        }
        break;
      }

      default:
        // For unknown event types, try to index any string data values
        break;
    }

    return fields;
  }
}

/**
 * Stat a path, returning null on error.
 */
async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
