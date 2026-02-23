/**
 * Tests for the SessionHistoryManager service.
 *
 * Covers cross-machine session merging, search, pagination, caching,
 * and filter handling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SessionHistoryManager } from "../services/session-history-manager.js";
import type { SessionSummary, SessionFilter } from "../types/session.js";

function createSession(
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    hostId: "host-1",
    hostName: "Work MacBook",
    projectId: "proj-1",
    projectName: "my-project",
    startedAt: "2026-02-22T10:00:00Z",
    duration: 3600,
    eventCount: 100,
    promptCount: 5,
    toolCallCount: 20,
    tokenUsage: {
      inputTokens: 50000,
      outputTokens: 25000,
      cacheReadTokens: 100000,
      estimatedCost: 1.23,
    },
    lastPromptPreview: "Fix the bug in the authentication flow...",
    status: "completed",
    isDecrypted: true,
    ...overrides,
  };
}

describe("SessionHistoryManager", () => {
  let manager: SessionHistoryManager;

  beforeEach(() => {
    manager = new SessionHistoryManager();
  });

  describe("adding sessions from multiple daemons", () => {
    it("merges sessions from two hosts", () => {
      const sessions1 = [
        createSession({ sessionId: "s1", hostId: "host-1" }),
      ];
      const sessions2 = [
        createSession({ sessionId: "s2", hostId: "host-2" }),
      ];

      manager.setSessionsForHost("host-1", sessions1);
      manager.setSessionsForHost("host-2", sessions2);

      expect(manager.getAllSessions()).toHaveLength(2);
    });

    it("replaces sessions for a host on re-set", () => {
      manager.setSessionsForHost("host-1", [
        createSession({ sessionId: "s1", hostId: "host-1" }),
        createSession({ sessionId: "s2", hostId: "host-1" }),
      ]);
      manager.setSessionsForHost("host-1", [
        createSession({ sessionId: "s3", hostId: "host-1" }),
      ]);

      expect(manager.getAllSessions()).toHaveLength(1);
      expect(manager.getAllSessions()[0].sessionId).toBe("s3");
    });

    it("handles empty session lists", () => {
      manager.setSessionsForHost("host-1", []);
      expect(manager.getAllSessions()).toHaveLength(0);
    });

    it("removeHost clears sessions for that host", () => {
      manager.setSessionsForHost("host-1", [
        createSession({ sessionId: "s1", hostId: "host-1" }),
      ]);
      manager.setSessionsForHost("host-2", [
        createSession({ sessionId: "s2", hostId: "host-2" }),
      ]);

      manager.removeHost("host-1");
      expect(manager.getAllSessions()).toHaveLength(1);
    });
  });

  describe("sorting", () => {
    it("default sort is by startedAt descending", () => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          startedAt: "2026-02-20T10:00:00Z",
        }),
        createSession({
          sessionId: "s2",
          hostId: "host-1",
          startedAt: "2026-02-22T10:00:00Z",
        }),
        createSession({
          sessionId: "s3",
          hostId: "host-1",
          startedAt: "2026-02-21T10:00:00Z",
        }),
      ]);

      const sorted = manager.getSorted("date", "desc");
      expect(sorted[0].sessionId).toBe("s2");
      expect(sorted[1].sessionId).toBe("s3");
      expect(sorted[2].sessionId).toBe("s1");
    });

    it("sorts by duration", () => {
      manager.setSessionsForHost("host-1", [
        createSession({ sessionId: "s1", hostId: "host-1", duration: 100 }),
        createSession({ sessionId: "s2", hostId: "host-1", duration: 500 }),
        createSession({ sessionId: "s3", hostId: "host-1", duration: 200 }),
      ]);

      const sorted = manager.getSorted("duration", "desc");
      expect(sorted[0].sessionId).toBe("s2");
      expect(sorted[1].sessionId).toBe("s3");
      expect(sorted[2].sessionId).toBe("s1");
    });

    it("sorts by tokens (total)", () => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            estimatedCost: 0.01,
          },
        }),
        createSession({
          sessionId: "s2",
          hostId: "host-1",
          tokenUsage: {
            inputTokens: 10000,
            outputTokens: 5000,
            cacheReadTokens: 0,
            estimatedCost: 1.0,
          },
        }),
      ]);

      const sorted = manager.getSorted("tokens", "desc");
      expect(sorted[0].sessionId).toBe("s2");
    });

    it("sorts by project name", () => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          projectName: "zebra",
        }),
        createSession({
          sessionId: "s2",
          hostId: "host-1",
          projectName: "alpha",
        }),
      ]);

      const sorted = manager.getSorted("project", "asc");
      expect(sorted[0].projectName).toBe("alpha");
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          projectId: "proj-1",
          projectName: "frontend",
          status: "completed",
          startedAt: "2026-02-22T10:00:00Z",
        }),
        createSession({
          sessionId: "s2",
          hostId: "host-1",
          projectId: "proj-2",
          projectName: "backend",
          status: "active",
          startedAt: "2026-02-20T10:00:00Z",
        }),
      ]);
      manager.setSessionsForHost("host-2", [
        createSession({
          sessionId: "s3",
          hostId: "host-2",
          projectId: "proj-1",
          projectName: "frontend",
          status: "error",
          startedAt: "2026-02-21T10:00:00Z",
        }),
      ]);
    });

    it("filters by machineId", () => {
      const filter: SessionFilter = { machineId: "host-1" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.hostId === "host-1")).toBe(true);
    });

    it("filters by projectId", () => {
      const filter: SessionFilter = { projectId: "proj-1" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(2);
    });

    it("filters by status", () => {
      const filter: SessionFilter = { status: "completed" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe("s1");
    });

    it("filters by date range", () => {
      const filter: SessionFilter = {
        dateFrom: "2026-02-21T00:00:00Z",
        dateTo: "2026-02-23T00:00:00Z",
      };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(2); // s1 (22nd) and s3 (21st)
    });

    it("filters by search query in project name", () => {
      const filter: SessionFilter = { searchQuery: "frontend" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(2);
    });

    it("filters by search query in last prompt preview", () => {
      manager.setSessionsForHost("host-3", [
        createSession({
          sessionId: "s4",
          hostId: "host-3",
          lastPromptPreview: "Add dark mode support",
        }),
      ]);
      const filter: SessionFilter = { searchQuery: "dark mode" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe("s4");
    });

    it("search query is case-insensitive", () => {
      const filter: SessionFilter = { searchQuery: "FRONTEND" };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(2);
    });

    it("combines multiple filters", () => {
      const filter: SessionFilter = {
        machineId: "host-1",
        status: "completed",
      };
      const filtered = manager.getFiltered(filter);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe("s1");
    });

    it("empty filter returns all sessions", () => {
      const filtered = manager.getFiltered({});
      expect(filtered).toHaveLength(3);
    });
  });

  describe("pagination", () => {
    beforeEach(() => {
      const sessions = [];
      for (let i = 0; i < 50; i++) {
        sessions.push(
          createSession({
            sessionId: `s${i}`,
            hostId: "host-1",
            startedAt: new Date(
              2026,
              1,
              22,
              10,
              0,
              0,
              0
            ).toISOString(),
          })
        );
      }
      manager.setSessionsForHost("host-1", sessions);
    });

    it("getPage returns correct page size", () => {
      const page = manager.getPage(0, 20);
      expect(page.sessions).toHaveLength(20);
      expect(page.hasMore).toBe(true);
      expect(page.totalCount).toBe(50);
    });

    it("getPage second page", () => {
      const page = manager.getPage(1, 20);
      expect(page.sessions).toHaveLength(20);
      expect(page.hasMore).toBe(true);
    });

    it("getPage last page has remaining items", () => {
      const page = manager.getPage(2, 20);
      expect(page.sessions).toHaveLength(10);
      expect(page.hasMore).toBe(false);
    });

    it("getPage beyond last page returns empty", () => {
      const page = manager.getPage(10, 20);
      expect(page.sessions).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });

    it("getPage with filter applied", () => {
      manager.setSessionsForHost("host-2", [
        createSession({ sessionId: "s-other", hostId: "host-2" }),
      ]);
      const page = manager.getPage(0, 20, { machineId: "host-2" });
      expect(page.sessions).toHaveLength(1);
      expect(page.totalCount).toBe(1);
    });
  });

  describe("session cache", () => {
    it("cacheSession stores session for later retrieval", () => {
      const session = createSession({ sessionId: "s1", hostId: "host-1" });
      manager.cacheSession(session);
      expect(manager.getCachedSession("s1")).toEqual(session);
    });

    it("getCachedSession returns undefined for unknown session", () => {
      expect(manager.getCachedSession("nonexistent")).toBeUndefined();
    });

    it("clearCache removes all cached sessions", () => {
      manager.cacheSession(
        createSession({ sessionId: "s1", hostId: "host-1" })
      );
      manager.clearCache();
      expect(manager.getCachedSession("s1")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("interleaves sessions from multiple daemons by date", () => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          startedAt: "2026-02-22T10:00:00Z",
        }),
        createSession({
          sessionId: "s3",
          hostId: "host-1",
          startedAt: "2026-02-20T10:00:00Z",
        }),
      ]);
      manager.setSessionsForHost("host-2", [
        createSession({
          sessionId: "s2",
          hostId: "host-2",
          startedAt: "2026-02-21T10:00:00Z",
        }),
      ]);

      const sorted = manager.getSorted("date", "desc");
      expect(sorted[0].sessionId).toBe("s1");
      expect(sorted[1].sessionId).toBe("s2");
      expect(sorted[2].sessionId).toBe("s3");
    });

    it("handles whitespace-only search query as empty", () => {
      manager.setSessionsForHost("host-1", [
        createSession({ sessionId: "s1", hostId: "host-1" }),
      ]);
      const filtered = manager.getFiltered({ searchQuery: "   " });
      expect(filtered).toHaveLength(1);
    });

    it("date range where from > to is swapped", () => {
      manager.setSessionsForHost("host-1", [
        createSession({
          sessionId: "s1",
          hostId: "host-1",
          startedAt: "2026-02-22T10:00:00Z",
        }),
      ]);
      const filtered = manager.getFiltered({
        dateFrom: "2026-02-23T00:00:00Z",
        dateTo: "2026-02-21T00:00:00Z",
      });
      // Should swap and include the session
      expect(filtered).toHaveLength(1);
    });
  });
});
