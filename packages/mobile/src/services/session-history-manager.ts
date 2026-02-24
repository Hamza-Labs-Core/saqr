/**
 * SessionHistoryManager - Cross-machine session history management.
 *
 * Handles session merging from multiple daemons, sorting, filtering,
 * pagination, and local session caching.
 *
 * @module services/session-history-manager
 */

import type { SessionSummary, SessionFilter } from "../types/session.js";

/** A page of sessions with pagination metadata. */
export interface SessionPage {
  sessions: SessionSummary[];
  hasMore: boolean;
  totalCount: number;
}

/**
 * Manages session history across multiple daemons.
 */
export class SessionHistoryManager {
  /** Per-host session lists. Key is hostId. */
  private sessionsByHost: Map<string, SessionSummary[]> = new Map();
  /** Session cache for quick lookup. Key is sessionId. */
  private sessionCache: Map<string, SessionSummary> = new Map();

  /**
   * Set the complete session list for a host. Replaces any previous list.
   */
  setSessionsForHost(hostId: string, sessions: SessionSummary[]): void {
    this.sessionsByHost.set(
      hostId,
      sessions.map((s) => ({ ...s }))
    );
  }

  /**
   * Remove all sessions for a host.
   */
  removeHost(hostId: string): void {
    this.sessionsByHost.delete(hostId);
  }

  /**
   * Get all sessions merged from all hosts.
   */
  getAllSessions(): SessionSummary[] {
    const all: SessionSummary[] = [];
    for (const sessions of this.sessionsByHost.values()) {
      for (const session of sessions) {
        all.push({ ...session });
      }
    }
    return all;
  }

  /**
   * Get sessions sorted by the given field and direction.
   */
  getSorted(
    sortBy: "date" | "duration" | "tokens" | "project",
    direction: "asc" | "desc"
  ): SessionSummary[] {
    const sessions = this.getAllSessions();
    const dir = direction === "asc" ? 1 : -1;

    sessions.sort((a, b) => {
      switch (sortBy) {
        case "date":
          return (
            dir *
            (new Date(a.startedAt).getTime() -
              new Date(b.startedAt).getTime())
          );
        case "duration":
          return dir * (a.duration - b.duration);
        case "tokens":
          return (
            dir *
            (a.tokenUsage.inputTokens +
              a.tokenUsage.outputTokens -
              (b.tokenUsage.inputTokens + b.tokenUsage.outputTokens))
          );
        case "project":
          return dir * a.projectName.localeCompare(b.projectName);
        default:
          return 0;
      }
    });

    return sessions;
  }

  /**
   * Get sessions filtered by the given criteria.
   */
  getFiltered(filter: SessionFilter): SessionSummary[] {
    let sessions = this.getAllSessions();

    if (filter.machineId) {
      sessions = sessions.filter((s) => s.hostId === filter.machineId);
    }

    if (filter.projectId) {
      sessions = sessions.filter((s) => s.projectId === filter.projectId);
    }

    if (filter.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }

    if (filter.dateFrom || filter.dateTo) {
      let from = filter.dateFrom
        ? new Date(filter.dateFrom).getTime()
        : 0;
      let to = filter.dateTo
        ? new Date(filter.dateTo).getTime()
        : Infinity;

      // Swap if from > to
      if (from > to) {
        [from, to] = [to, from];
      }

      sessions = sessions.filter((s) => {
        const startTime = new Date(s.startedAt).getTime();
        return startTime >= from && startTime <= to;
      });
    }

    const query = filter.searchQuery?.trim();
    if (query) {
      const lowerQuery = query.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(lowerQuery) ||
          s.lastPromptPreview.toLowerCase().includes(lowerQuery) ||
          s.hostName.toLowerCase().includes(lowerQuery)
      );
    }

    return sessions;
  }

  /**
   * Get a paginated view of sessions.
   */
  getPage(
    pageIndex: number,
    pageSize: number,
    filter?: SessionFilter
  ): SessionPage {
    const filtered = filter ? this.getFiltered(filter) : this.getAllSessions();

    // Sort by date descending by default
    filtered.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    const totalCount = filtered.length;
    const start = pageIndex * pageSize;
    const sessions = filtered.slice(start, start + pageSize);
    const hasMore = start + pageSize < totalCount;

    return { sessions, hasMore, totalCount };
  }

  /**
   * Cache a session for quick lookup.
   */
  cacheSession(session: SessionSummary): void {
    this.sessionCache.set(session.sessionId, { ...session });
  }

  /**
   * Get a cached session by ID.
   */
  getCachedSession(sessionId: string): SessionSummary | undefined {
    const cached = this.sessionCache.get(sessionId);
    return cached ? { ...cached } : undefined;
  }

  /**
   * Clear all cached sessions.
   */
  clearCache(): void {
    this.sessionCache.clear();
  }
}
