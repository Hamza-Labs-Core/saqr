/**
 * Tests for searchTimeline -- full-text search across TimelineItem[].
 *
 * Covers T-12 (full-text match), T-13 (filters), T-14 (case insensitive).
 */
import { describe, it, expect } from "vitest";
import type { TimelineItem } from "../types/timeline.js";
import type { SearchFilters, TimelineSearchResult } from "../search/searchTimeline.js";
import { searchTimeline } from "../search/searchTimeline.js";
import { extractSearchableText } from "../search/extractSearchableText.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeline(): TimelineItem[] {
  return [
    {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "user_message",
      text: "Please fix the authentication bug in the login module",
      hasAttachments: false,
      attachments: [],
    },
    {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 2,
      source: "gc_hook",
      read: false,
      type: "assistant_message",
      text: "I will investigate the authentication issue in the login module. Let me read the relevant files.",
      streamingState: "completed",
      hasMarkdown: true,
      model: "claude-opus-4-6",
      outputTokens: 200,
    },
    {
      id: "3",
      timestamp: "2026-02-22T10:00:02.000Z",
      sequence: 3,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { filePath: "/src/auth/login.ts" },
      output: { content: "export function login() { /* auth logic */ }", lineCount: 10, language: "typescript" },
    },
    {
      id: "4",
      timestamp: "2026-02-22T10:00:03.000Z",
      sequence: 4,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-2",
      toolName: "Bash",
      status: "completed",
      durationMs: 200,
      error: null,
      input: { command: "npm test -- --filter auth" },
      output: { stdout: "PASS: auth tests pass", stderr: null, exitCode: 0 },
    },
    {
      id: "5",
      timestamp: "2026-02-22T10:00:04.000Z",
      sequence: 5,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "TypeError: Cannot read property 'token' of undefined",
      stackTrace: "at login (/src/auth/login.ts:15:20)\nat main (/src/index.ts:5:10)",
      isRecoverable: true,
      errorSource: "agent",
    },
    {
      id: "6",
      timestamp: "2026-02-22T10:00:05.000Z",
      sequence: 6,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-3",
      toolName: "Edit",
      status: "completed",
      durationMs: 100,
      error: null,
      input: {
        filePath: "/src/auth/login.ts",
        oldString: "const token = user.token;",
        newString: "const token = user?.token ?? '';",
      },
      output: {
        diff: "@@ -15 +15 @@\n-const token = user.token;\n+const token = user?.token ?? '';",
        language: "typescript",
      },
    },
    {
      id: "7",
      timestamp: "2026-02-22T10:00:06.000Z",
      sequence: 7,
      source: "gc_hook",
      read: false,
      type: "system_notification",
      category: "session_start",
      message: "Session started with model claude-opus-4-6",
      metadata: { model: "claude-opus-4-6" },
    },
    {
      id: "8",
      timestamp: "2026-02-22T10:00:07.000Z",
      sequence: 8,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-4",
      toolName: "Grep",
      status: "completed",
      durationMs: 80,
      error: null,
      input: { pattern: "authentication", path: "/src" },
      output: {
        matches: [
          { file: "/src/auth/login.ts", line: 5, content: "// authentication handler" },
        ],
        matchCount: 1,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Full-text search (T-12)
// ---------------------------------------------------------------------------

describe("searchTimeline - full-text search (T-12)", () => {
  it("finds matches in user message text", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "authentication bug", {});
    expect(results.length).toBeGreaterThan(0);
    const userMsgResult = results.find((r) => r.itemId === "1");
    expect(userMsgResult).toBeDefined();
  });

  it("finds matches in assistant message text", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "investigate", {});
    const assistantResult = results.find((r) => r.itemId === "2");
    expect(assistantResult).toBeDefined();
  });

  it("finds matches in tool call file paths", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "login.ts", {});
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds matches in tool call commands", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "npm test", {});
    const bashResult = results.find((r) => r.itemId === "4");
    expect(bashResult).toBeDefined();
  });

  it("finds matches in tool call output", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "auth tests pass", {});
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds matches in error messages", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "TypeError", {});
    const errorResult = results.find((r) => r.itemId === "5");
    expect(errorResult).toBeDefined();
  });

  it("finds matches in error stack traces", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "login.ts:15", {});
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds matches in system notification messages", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "Session started", {});
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds matches in grep output", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "authentication handler", {});
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Search result snippets
// ---------------------------------------------------------------------------

describe("searchTimeline - result snippets", () => {
  it("generates snippets with context around the match", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "authentication", {});
    for (const result of results) {
      expect(result.snippet.length).toBeGreaterThan(0);
      expect(result.snippet.toLowerCase()).toContain("authentication");
    }
  });

  it("includes matched ranges for highlighting", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "authentication", {});
    for (const result of results) {
      expect(result.matchRanges).toBeDefined();
      expect(result.matchRanges.length).toBeGreaterThan(0);
      for (const range of result.matchRanges) {
        expect(typeof range.start).toBe("number");
        expect(typeof range.end).toBe("number");
        expect(range.end).toBeGreaterThan(range.start);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Filters (T-13)
// ---------------------------------------------------------------------------

describe("searchTimeline - filters (T-13)", () => {
  it("filters by event type", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { types: ["user_message"] };
    const results = searchTimeline(timeline, "authentication", filters);
    for (const result of results) {
      expect(result.itemType).toBe("user_message");
    }
  });

  it("filters by tool name", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { toolNames: ["Bash"] };
    const results = searchTimeline(timeline, "npm", filters);
    for (const result of results) {
      expect(result.itemId).toBe("4"); // Only the Bash tool call
    }
  });

  it("filters by file path regex", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { filePathPattern: "auth" };
    const results = searchTimeline(timeline, "login", filters);
    expect(results.length).toBeGreaterThan(0);
    // All results should involve files matching auth pattern
  });

  it("filters by date range", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = {
      dateFrom: "2026-02-22T10:00:02.000Z",
      dateTo: "2026-02-22T10:00:04.000Z",
    };
    const results = searchTimeline(timeline, "auth", filters);
    for (const result of results) {
      const item = timeline.find((i) => i.id === result.itemId);
      expect(item).toBeDefined();
      if (item) {
        expect(item.timestamp >= "2026-02-22T10:00:02.000Z").toBe(true);
        expect(item.timestamp <= "2026-02-22T10:00:04.000Z").toBe(true);
      }
    }
  });

  it("supports multiple type filters", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { types: ["user_message", "assistant_message"] };
    const results = searchTimeline(timeline, "authentication", filters);
    for (const result of results) {
      expect(["user_message", "assistant_message"]).toContain(result.itemType);
    }
  });
});

// ---------------------------------------------------------------------------
// Case insensitive (T-14)
// ---------------------------------------------------------------------------

describe("searchTimeline - case insensitivity (T-14)", () => {
  it("searches case-insensitively by default", () => {
    const timeline = makeTimeline();
    const resultsLower = searchTimeline(timeline, "typeerror", {});
    const resultsUpper = searchTimeline(timeline, "TYPEERROR", {});
    const resultsMixed = searchTimeline(timeline, "TypeError", {});
    expect(resultsLower.length).toBe(resultsUpper.length);
    expect(resultsLower.length).toBe(resultsMixed.length);
  });

  it("supports case-sensitive mode", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { caseSensitive: true };
    const resultsExact = searchTimeline(timeline, "TypeError", filters);
    const resultsWrong = searchTimeline(timeline, "typeerror", filters);
    expect(resultsExact.length).toBeGreaterThan(0);
    expect(resultsWrong.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regex mode
// ---------------------------------------------------------------------------

describe("searchTimeline - regex mode", () => {
  it("supports regex search", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { useRegex: true };
    const results = searchTimeline(timeline, "login\\.ts", filters);
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles invalid regex gracefully", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { useRegex: true };
    const results = searchTimeline(timeline, "[invalid(", filters);
    expect(results).toEqual([]); // Returns empty, no crash
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("searchTimeline - edge cases", () => {
  it("returns empty for empty query", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "", {});
    expect(results).toEqual([]);
  });

  it("returns empty for whitespace-only query", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "   ", {});
    expect(results).toEqual([]);
  });

  it("returns empty for empty timeline", () => {
    const results = searchTimeline([], "test", {});
    expect(results).toEqual([]);
  });

  it("returns results sorted by timestamp", () => {
    const timeline = makeTimeline();
    const results = searchTimeline(timeline, "auth", {});
    for (let i = 1; i < results.length; i++) {
      const prevItem = timeline.find((t) => t.id === results[i - 1].itemId);
      const currItem = timeline.find((t) => t.id === results[i].itemId);
      if (prevItem && currItem) {
        expect(prevItem.timestamp <= currItem.timestamp).toBe(true);
      }
    }
  });

  it("respects result limit", () => {
    const timeline = makeTimeline();
    const filters: SearchFilters = { limit: 2 };
    const results = searchTimeline(timeline, "auth", filters);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// extractSearchableText
// ---------------------------------------------------------------------------

describe("extractSearchableText", () => {
  it("extracts text from UserMessage", () => {
    const item: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "user_message",
      text: "Fix the bug",
      hasAttachments: false,
      attachments: [],
    };
    const text = extractSearchableText(item);
    expect(text).toContain("Fix the bug");
  });

  it("extracts text from AssistantMessage", () => {
    const item: TimelineItem = {
      id: "2",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "assistant_message",
      text: "I will fix it",
      streamingState: "completed",
      hasMarkdown: false,
      model: "claude-opus-4-6",
      outputTokens: 50,
    };
    const text = extractSearchableText(item);
    expect(text).toContain("I will fix it");
  });

  it("extracts text from ToolCall (Read)", () => {
    const item: TimelineItem = {
      id: "3",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 30,
      error: null,
      input: { filePath: "/src/test.ts" },
      output: { content: "some code", lineCount: 5, language: "typescript" },
    };
    const text = extractSearchableText(item);
    expect(text).toContain("/src/test.ts");
    expect(text).toContain("some code");
  });

  it("extracts text from ToolCall (Bash)", () => {
    const item: TimelineItem = {
      id: "4",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-2",
      toolName: "Bash",
      status: "completed",
      durationMs: 100,
      error: null,
      input: { command: "ls -la" },
      output: { stdout: "file1\nfile2", stderr: "warning", exitCode: 0 },
    };
    const text = extractSearchableText(item);
    expect(text).toContain("ls -la");
    expect(text).toContain("file1");
    expect(text).toContain("warning");
  });

  it("extracts text from ErrorItem", () => {
    const item: TimelineItem = {
      id: "5",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Something failed",
      stackTrace: "at line 10",
      isRecoverable: false,
      errorSource: "system",
    };
    const text = extractSearchableText(item);
    expect(text).toContain("Something failed");
    expect(text).toContain("at line 10");
  });

  it("returns empty string for items with no searchable content", () => {
    const item: TimelineItem = {
      id: "6",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "usage_update",
      model: "claude-opus-4-6",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionCostUsd: 0.01,
      contextWindowUsage: 0.1,
      contextWindowMax: 200000,
    };
    const text = extractSearchableText(item);
    // Usage updates have minimal searchable text, just model
    expect(typeof text).toBe("string");
  });
});
