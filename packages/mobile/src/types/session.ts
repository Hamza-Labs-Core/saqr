/**
 * Session Types for the Saqr Mobile App.
 *
 * Defines session list models, filters, search results, and pagination.
 *
 * @module types/session
 */

import type { TokenUsage } from "./agent.js";

/** Summary view model for a session in the history list. */
export interface SessionSummary {
  /** Unique session identifier. */
  sessionId: string;
  /** ID of the daemon that ran this session. */
  hostId: string;
  /** Human-readable daemon name. */
  hostName: string;
  /** Project identifier. */
  projectId: string;
  /** Project display name. */
  projectName: string;
  /** ISO 8601 timestamp when the session started. */
  startedAt: string;
  /** ISO 8601 timestamp when the session ended (undefined if active). */
  endedAt?: string;
  /** Duration in seconds. */
  duration: number;
  /** Total number of events captured. */
  eventCount: number;
  /** Number of user prompts submitted. */
  promptCount: number;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Token usage summary. */
  tokenUsage: TokenUsage;
  /** First 150 chars of the last user prompt. */
  lastPromptPreview: string;
  /** Session status. */
  status: "active" | "completed" | "error";
  /** Whether encrypted data has been decrypted. */
  isDecrypted: boolean;
}

/** Filter criteria for session list queries. */
export interface SessionFilter {
  /** Filter by machine ID. */
  machineId?: string;
  /** Filter by project ID. */
  projectId?: string;
  /** Filter by start date (ISO 8601). */
  dateFrom?: string;
  /** Filter by end date (ISO 8601). */
  dateTo?: string;
  /** Full-text search query. */
  searchQuery?: string;
  /** Filter by session status. */
  status?: "active" | "completed" | "error";
  /** Sort field. */
  sortBy?: "date" | "duration" | "tokens" | "project";
  /** Sort direction. */
  sortDirection?: "asc" | "desc";
  /** Page size limit. */
  limit?: number;
  /** Pagination cursor. */
  cursor?: string;
}

/** A search result with matching snippets. */
export interface SessionSearchResult {
  /** The matched session. */
  session: SessionSummary;
  /** Highlighted matching snippets. */
  matches: SearchMatch[];
}

/** A single search match within a session event. */
export interface SearchMatch {
  /** Type of the event containing the match. */
  eventType: string;
  /** Field containing the match (e.g., "prompt", "tool_input"). */
  fieldName: string;
  /** Text snippet with match boundaries. */
  snippet: string;
  /** Sequence number of the matched event. */
  eventSequence: number;
}

/** A page of session events with pagination cursor. */
export interface SessionEventsPage {
  /** Events in this page. */
  events: SessionEvent[];
  /** Cursor for the next page, null if no more pages. */
  nextCursor: string | null;
  /** Total number of events in the session. */
  totalCount: number;
}

/** A single session event. */
export interface SessionEvent {
  /** Event sequence number. */
  sequence: number;
  /** Event type. */
  type: string;
  /** Event payload. */
  data: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  timestamp: string;
}
