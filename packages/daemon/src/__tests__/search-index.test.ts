/**
 * Tests for the SearchIndex — full-text search across events.
 *
 * Covers: T-20 through T-23 from Story 04 testing plan.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SearchIndex } from "../store/search-index.js";

function padSequence(seq: number): string {
  return String(seq).padStart(6, "0");
}

describe("SearchIndex", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  describe("indexEvent + search", () => {
    // T-20: Tokenize prompt text and find by keyword
    it("should index a user prompt and find it by keyword", async () => {
      index.indexEvent(
        "evt-001",
        "proj-a",
        "sess-001",
        1,
        "UserPromptReceived",
        "2026-02-21T10:00:00.000Z",
        { prompt: "Fix the authentication bug in handler.ts" },
      );

      const results = await index.search({ text: "authentication" });
      expect(results).toHaveLength(1);
      expect(results[0].eventId).toBe("evt-001");
      expect(results[0].matchField).toBe("prompt");
    });

    it("should find events by tool name", async () => {
      index.indexEvent(
        "evt-002",
        "proj-a",
        "sess-001",
        2,
        "ToolCallCompleted",
        "2026-02-21T10:01:00.000Z",
        {
          tool_name: "Edit",
          tool_input: { file_path: "/home/user/project/src/auth.ts" },
          tool_response: "File edited successfully",
        },
      );

      const results = await index.search({ text: "Edit" });
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe("ToolCallCompleted");
    });

    // T-21: File path search matches partial paths
    it("should find events by partial file path", async () => {
      index.indexEvent(
        "evt-003",
        "proj-a",
        "sess-001",
        3,
        "ToolCallCompleted",
        "2026-02-21T10:02:00.000Z",
        {
          tool_name: "Read",
          tool_input: { file_path: "/home/user/project/src/auth.ts" },
          tool_response: "file contents...",
        },
      );

      const results = await index.search({ text: "auth.ts" });
      expect(results).toHaveLength(1);
      expect(results[0].eventId).toBe("evt-003");
    });

    // T-22: Case-insensitive search returns correct results
    it("should perform case-insensitive search by default", async () => {
      index.indexEvent(
        "evt-004",
        "proj-a",
        "sess-001",
        4,
        "UserPromptReceived",
        "2026-02-21T10:03:00.000Z",
        { prompt: "Fix the PostgreSQL connection timeout" },
      );

      const results = await index.search({ text: "postgresql" });
      expect(results).toHaveLength(1);

      const results2 = await index.search({ text: "POSTGRESQL" });
      expect(results2).toHaveLength(1);
    });

    // T-23: Special characters in query do not crash
    it("should handle special characters in query without crashing", async () => {
      index.indexEvent(
        "evt-005",
        "proj-a",
        "sess-001",
        5,
        "UserPromptReceived",
        "2026-02-21T10:04:00.000Z",
        { prompt: 'Fix console.log("error") in main.ts' },
      );

      // These should not throw
      await expect(index.search({ text: 'console.log("error")' })).resolves.toBeDefined();
      await expect(index.search({ text: "[A-Z]+" })).resolves.toBeDefined();
      await expect(index.search({ text: "path/to/file.ts" })).resolves.toBeDefined();
      await expect(index.search({ text: "" })).resolves.toBeDefined();
    });

    it("should return empty results for no matches", async () => {
      index.indexEvent(
        "evt-006",
        "proj-a",
        "sess-001",
        6,
        "UserPromptReceived",
        "2026-02-21T10:05:00.000Z",
        { prompt: "Hello world" },
      );

      const results = await index.search({ text: "nonexistentkeyword" });
      expect(results).toHaveLength(0);
    });

    it("should filter by project ID", async () => {
      index.indexEvent("evt-a", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "Fix the bug" });
      index.indexEvent("evt-b", "proj-b", "sess-002", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "Fix the bug" });

      const results = await index.search({ text: "bug", projectId: "proj-a" });
      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe("proj-a");
    });

    it("should filter by session ID", async () => {
      index.indexEvent("evt-a", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "Fix the bug" });
      index.indexEvent("evt-b", "proj-a", "sess-002", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "Fix the bug" });

      const results = await index.search({ text: "bug", sessionId: "sess-001" });
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("sess-001");
    });

    it("should filter by event types", async () => {
      index.indexEvent("evt-a", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "Fix the bug" });
      index.indexEvent("evt-b", "proj-a", "sess-001", 2, "ToolCallCompleted",
        "2026-02-21T10:01:00.000Z", {
          tool_name: "Bash",
          tool_input: { command: "fix the bug" },
          tool_response: "done",
        });

      const results = await index.search({
        text: "bug",
        eventTypes: ["UserPromptReceived"],
      });
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe("UserPromptReceived");
    });

    it("should support pagination with limit and offset", async () => {
      for (let i = 1; i <= 10; i++) {
        index.indexEvent(`evt-${i}`, "proj-a", "sess-001", i, "UserPromptReceived",
          `2026-02-21T10:0${String(i).padStart(2, "0")}:00.000Z`,
          { prompt: `Fix bug number ${i}` });
      }

      const page1 = await index.search({ text: "bug", limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);

      const page2 = await index.search({ text: "bug", limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);

      // Verify different results
      const ids1 = page1.map((r) => r.eventId);
      const ids2 = page2.map((r) => r.eventId);
      expect(ids1).not.toEqual(ids2);
    });

    it("should provide a relevance score", async () => {
      // Event with multiple matches should score higher
      index.indexEvent("evt-many", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z",
        { prompt: "Fix the auth bug in auth handler auth module" });

      index.indexEvent("evt-few", "proj-a", "sess-001", 2, "UserPromptReceived",
        "2026-02-21T10:01:00.000Z",
        { prompt: "Update the readme file" });

      const results = await index.search({ text: "auth" });
      expect(results.length).toBeGreaterThan(0);
      // The event with more matches should come first
      expect(results[0].eventId).toBe("evt-many");
    });

    it("should generate snippets with context around the match", async () => {
      index.indexEvent("evt-snippet", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z",
        { prompt: "We need to fix the authentication timeout issue in the production server" });

      const results = await index.search({ text: "authentication" });
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toContain("authentication");
      expect(results[0].snippet.length).toBeLessThanOrEqual(120);
    });
  });

  describe("rebuild", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-search-rebuild-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("should rebuild index from event files on disk", async () => {
      // Create test event files
      const sessionDir = path.join(tmpDir, "proj-a", "sess-001");
      await mkdir(sessionDir, { recursive: true });

      await writeFile(
        path.join(sessionDir, "000001.json"),
        JSON.stringify({
          event_id: "evt-rebuild-1",
          event_type: "UserPromptReceived",
          project_id: "proj-a",
          session_id: "sess-001",
          sequence: 1,
          timestamp: "2026-02-21T10:00:00.000Z",
          data: { prompt: "Fix database migration" },
        }),
      );

      await writeFile(
        path.join(sessionDir, "000002.json"),
        JSON.stringify({
          event_id: "evt-rebuild-2",
          event_type: "ToolCallCompleted",
          project_id: "proj-a",
          session_id: "sess-001",
          sequence: 2,
          timestamp: "2026-02-21T10:01:00.000Z",
          data: {
            tool_name: "Bash",
            tool_input: { command: "npx prisma migrate" },
            tool_response: "Migration completed",
          },
        }),
      );

      await index.rebuild(tmpDir);

      const results = await index.search({ text: "migration" });
      expect(results.length).toBeGreaterThan(0);

      const stats = index.getStats();
      expect(stats.documentCount).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all indexed data", () => {
      index.indexEvent("evt-1", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "hello world" });

      index.clear();

      const stats = index.getStats();
      expect(stats.documentCount).toBe(0);
      expect(stats.termCount).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should track document count", () => {
      index.indexEvent("evt-1", "proj-a", "sess-001", 1, "UserPromptReceived",
        "2026-02-21T10:00:00.000Z", { prompt: "hello world" });
      index.indexEvent("evt-2", "proj-a", "sess-001", 2, "UserPromptReceived",
        "2026-02-21T10:01:00.000Z", { prompt: "goodbye world" });

      const stats = index.getStats();
      expect(stats.documentCount).toBe(2);
      expect(stats.termCount).toBeGreaterThan(0);
    });

    it("should estimate memory usage", () => {
      for (let i = 0; i < 100; i++) {
        index.indexEvent(`evt-${i}`, "proj-a", "sess-001", i, "UserPromptReceived",
          "2026-02-21T10:00:00.000Z",
          { prompt: `Fix bug number ${i} in the authentication module` });
      }

      const stats = index.getStats();
      expect(stats.memoryUsedBytes).toBeGreaterThan(0);
    });
  });
});
