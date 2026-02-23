/**
 * Tests for BadgeManager -- notification badge logic.
 *
 * Covers T-15 (increment/decrement), T-16 (overflow display).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { TimelineItem } from "../types/timeline.js";
import {
  BadgeManager,
  BadgeType,
  type BadgeCounts,
  type SessionBadgeState,
} from "../badges/BadgeManager.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let manager: BadgeManager;

beforeEach(() => {
  manager = new BadgeManager();
});

// ---------------------------------------------------------------------------
// Basic badge operations (T-15)
// ---------------------------------------------------------------------------

describe("BadgeManager - basic operations (T-15)", () => {
  it("starts with zero counts for a new session", () => {
    const state = manager.getSessionBadges("sess-1");
    expect(state.permissions).toBe(0);
    expect(state.errors).toBe(0);
    expect(state.prompts).toBe(0);
    expect(state.activity).toBe(0);
    expect(state.total).toBe(0);
  });

  it("increments badge count on new permission event", () => {
    const item: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "permission_request",
      toolName: "Bash",
      description: "Execute command",
      filePath: null,
      toolInput: {},
      resolution: "pending",
      resolvedAt: null,
    };
    manager.onNewItem("sess-1", item);
    const state = manager.getSessionBadges("sess-1");
    expect(state.permissions).toBe(1);
    expect(state.total).toBe(1);
  });

  it("increments error badge on error events", () => {
    const item: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Something went wrong",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    };
    manager.onNewItem("sess-1", item);
    const state = manager.getSessionBadges("sess-1");
    expect(state.errors).toBe(1);
  });

  it("increments prompt badge on user message events", () => {
    const item: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "user_message",
      text: "Hello",
      hasAttachments: false,
      attachments: [],
    };
    manager.onNewItem("sess-1", item);
    const state = manager.getSessionBadges("sess-1");
    expect(state.prompts).toBe(1);
  });

  it("increments activity badge on tool call events", () => {
    const item: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { filePath: "/test.ts" },
      output: null,
    };
    manager.onNewItem("sess-1", item);
    const state = manager.getSessionBadges("sess-1");
    expect(state.activity).toBe(1);
  });

  it("tracks multiple sessions independently", () => {
    const errorItem: TimelineItem = {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    };
    const permItem: TimelineItem = {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "permission_request",
      toolName: "Bash",
      description: "Execute",
      filePath: null,
      toolInput: {},
      resolution: "pending",
      resolvedAt: null,
    };

    manager.onNewItem("sess-1", errorItem);
    manager.onNewItem("sess-2", permItem);

    expect(manager.getSessionBadges("sess-1").errors).toBe(1);
    expect(manager.getSessionBadges("sess-1").permissions).toBe(0);
    expect(manager.getSessionBadges("sess-2").permissions).toBe(1);
    expect(manager.getSessionBadges("sess-2").errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clearing badges
// ---------------------------------------------------------------------------

describe("BadgeManager - clearing badges", () => {
  it("clears all badges for a session when viewed", () => {
    const items: TimelineItem[] = [
      {
        id: "1",
        timestamp: "2026-02-22T10:00:00.000Z",
        sequence: 1,
        source: "gc_hook",
        read: false,
        type: "error",
        message: "Error 1",
        stackTrace: null,
        isRecoverable: true,
        errorSource: "agent",
      },
      {
        id: "2",
        timestamp: "2026-02-22T10:00:01.000Z",
        sequence: 2,
        source: "gc_hook",
        read: false,
        type: "permission_request",
        toolName: "Bash",
        description: "Execute",
        filePath: null,
        toolInput: {},
        resolution: "pending",
        resolvedAt: null,
      },
    ];

    for (const item of items) {
      manager.onNewItem("sess-1", item);
    }
    expect(manager.getSessionBadges("sess-1").total).toBe(2);

    manager.markSessionViewed("sess-1");
    const state = manager.getSessionBadges("sess-1");
    expect(state.total).toBe(0);
    expect(state.permissions).toBe(0);
    expect(state.errors).toBe(0);
  });

  it("does not affect other sessions when clearing", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });
    manager.onNewItem("sess-2", {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });

    manager.markSessionViewed("sess-1");
    expect(manager.getSessionBadges("sess-1").total).toBe(0);
    expect(manager.getSessionBadges("sess-2").total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Badge priority and color
// ---------------------------------------------------------------------------

describe("BadgeManager - priority and color", () => {
  it("returns highest priority badge type", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });
    manager.onNewItem("sess-1", {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 2,
      source: "gc_hook",
      read: false,
      type: "user_message",
      text: "Hello",
      hasAttachments: false,
      attachments: [],
    });

    const state = manager.getSessionBadges("sess-1");
    expect(state.highestPriority).toBe(BadgeType.Error);
  });

  it("permissions have highest priority over errors", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });
    manager.onNewItem("sess-1", {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 2,
      source: "gc_hook",
      read: false,
      type: "permission_request",
      toolName: "Bash",
      description: "Execute",
      filePath: null,
      toolInput: {},
      resolution: "pending",
      resolvedAt: null,
    });

    const state = manager.getSessionBadges("sess-1");
    expect(state.highestPriority).toBe(BadgeType.Permission);
  });
});

// ---------------------------------------------------------------------------
// Overflow display (T-16)
// ---------------------------------------------------------------------------

describe("BadgeManager - overflow display (T-16)", () => {
  it("formats counts > 99 as '99+'", () => {
    const formatted = manager.formatCount(150);
    expect(formatted).toBe("99+");
  });

  it("formats counts <= 99 as exact number", () => {
    expect(manager.formatCount(0)).toBe("0");
    expect(manager.formatCount(1)).toBe("1");
    expect(manager.formatCount(50)).toBe("50");
    expect(manager.formatCount(99)).toBe("99");
  });

  it("handles large counts", () => {
    expect(manager.formatCount(1000)).toBe("99+");
    expect(manager.formatCount(99999)).toBe("99+");
  });
});

// ---------------------------------------------------------------------------
// Aggregate app badge
// ---------------------------------------------------------------------------

describe("BadgeManager - aggregate app badge", () => {
  it("aggregates permissions + errors across all sessions for app badge", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "permission_request",
      toolName: "Bash",
      description: "Execute",
      filePath: null,
      toolInput: {},
      resolution: "pending",
      resolvedAt: null,
    });
    manager.onNewItem("sess-2", {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });

    const appBadge = manager.getAppBadgeCount();
    expect(appBadge).toBe(2); // 1 permission + 1 error
  });

  it("returns 0 when all sessions are cleared", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });
    manager.markSessionViewed("sess-1");
    expect(manager.getAppBadgeCount()).toBe(0);
  });

  it("does not count prompts or activity in app badge", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: false,
      type: "user_message",
      text: "Hello",
      hasAttachments: false,
      attachments: [],
    });
    manager.onNewItem("sess-1", {
      id: "2",
      timestamp: "2026-02-22T10:00:01.000Z",
      sequence: 2,
      source: "gc_hook",
      read: false,
      type: "tool_call",
      toolUseId: "tu-1",
      toolName: "Read",
      status: "completed",
      durationMs: 50,
      error: null,
      input: { filePath: "/test.ts" },
      output: null,
    });
    expect(manager.getAppBadgeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Items that do not generate badges
// ---------------------------------------------------------------------------

describe("BadgeManager - items that skip badging", () => {
  it("does not badge already-read items", () => {
    manager.onNewItem("sess-1", {
      id: "1",
      timestamp: "2026-02-22T10:00:00.000Z",
      sequence: 1,
      source: "gc_hook",
      read: true, // Already read
      type: "error",
      message: "Error",
      stackTrace: null,
      isRecoverable: true,
      errorSource: "agent",
    });
    expect(manager.getSessionBadges("sess-1").total).toBe(0);
  });

  it("does not badge usage updates", () => {
    manager.onNewItem("sess-1", {
      id: "1",
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
    });
    expect(manager.getSessionBadges("sess-1").total).toBe(0);
  });
});
