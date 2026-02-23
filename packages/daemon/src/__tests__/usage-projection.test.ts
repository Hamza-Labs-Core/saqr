/**
 * Tests for the UsageProjection — token usage tracking per project, model, day.
 *
 * Covers: T-12 through T-16 from Story 04 testing plan.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  UsageProjection,
  estimateCost,
  MODEL_PRICING,
} from "../store/usage-projection.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: crypto.randomUUID(),
    event_type: "TurnCompleted",
    project_id: "proj-a-abc123",
    session_id: "sess-001",
    sequence: 1,
    timestamp: "2026-02-21T10:00:00.000Z",
    agent_provider: "claude-code",
    agent_native_event: "TurnCompleted",
    agent_metadata: { model: "claude-opus-4-6" },
    data: {},
    ...overrides,
  };
}

describe("UsageProjection", () => {
  let projection: UsageProjection;

  beforeEach(() => {
    projection = new UsageProjection();
  });

  // T-12: Per-turn token breakdown is correct
  describe("per-session usage", () => {
    it("should track token usage from TurnCompleted events", () => {
      projection.processEvent(
        makeEvent({
          sequence: 1,
          event_type: "TurnCompleted",
          data: {
            usage: {
              input_tokens: 3200,
              output_tokens: 850,
              cache_read_input_tokens: 1200,
              cache_creation_input_tokens: 400,
            },
          },
        }),
      );

      projection.processEvent(
        makeEvent({
          sequence: 2,
          event_type: "TurnCompleted",
          timestamp: "2026-02-21T10:05:00.000Z",
          data: {
            usage: {
              input_tokens: 2000,
              output_tokens: 600,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 200,
            },
          },
        }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result).not.toBeNull();
      expect(result!.totals.input_tokens).toBe(5200);
      expect(result!.totals.output_tokens).toBe(1450);
      expect(result!.totals.cache_read_tokens).toBe(2000);
      expect(result!.totals.cache_write_tokens).toBe(600);
      expect(result!.totals.total_tokens).toBe(9250);
      expect(result!.totals.turns).toBe(2);
    });

    it("should track tool call counts", () => {
      projection.processEvent(
        makeEvent({ sequence: 1, event_type: "ToolCallCompleted", data: { tool_name: "Read" } }),
      );
      projection.processEvent(
        makeEvent({ sequence: 2, event_type: "ToolCallCompleted", data: { tool_name: "Edit" } }),
      );
      projection.processEvent(
        makeEvent({ sequence: 3, event_type: "ToolCallCompleted", data: { tool_name: "Read" } }),
      );
      projection.processEvent(
        makeEvent({ sequence: 4, event_type: "ToolCallFailed", data: { tool_name: "Bash", error: "timeout" } }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result).not.toBeNull();
      expect(result!.totals.tool_calls).toBe(3);
      expect(result!.totals.tool_errors).toBe(1);
      expect(result!.by_tool.Read).toEqual({ calls: 2, errors: 0 });
      expect(result!.by_tool.Edit).toEqual({ calls: 1, errors: 0 });
      expect(result!.by_tool.Bash).toEqual({ calls: 0, errors: 1 });
    });

    it("should handle TurnCompleted with no usage data", () => {
      projection.processEvent(
        makeEvent({ sequence: 1, event_type: "TurnCompleted", data: {} }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result).not.toBeNull();
      expect(result!.totals.input_tokens).toBe(0);
      expect(result!.totals.output_tokens).toBe(0);
      expect(result!.totals.turns).toBe(1);
    });

    it("should include prompt preview from UserPromptReceived", () => {
      projection.processEvent(
        makeEvent({
          sequence: 1,
          event_type: "UserPromptReceived",
          data: { prompt: "Fix the authentication bug in handler.ts" },
        }),
      );

      projection.processEvent(
        makeEvent({
          sequence: 2,
          event_type: "TurnCompleted",
          data: {
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result!.turns).toHaveLength(1);
      expect(result!.turns[0].prompt_preview).toContain("Fix the authentication");
    });

    it("should track model from session events", () => {
      projection.processEvent(
        makeEvent({
          sequence: 1,
          event_type: "SessionStarted",
          agent_metadata: { model: "claude-opus-4-6" },
          data: { model: "claude-opus-4-6" },
        }),
      );

      projection.processEvent(
        makeEvent({
          sequence: 2,
          event_type: "TurnCompleted",
          data: { usage: { input_tokens: 100, output_tokens: 50 } },
        }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result!.model).toBe("claude-opus-4-6");
    });
  });

  // T-13: Cost estimation matches expected values for known models
  describe("cost estimation", () => {
    it("should estimate cost correctly for claude-opus-4-6", () => {
      const cost = estimateCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 1_000_000,
        },
        "claude-opus-4-6",
      );

      // Expected: 15 + 75 + 1.5 + 18.75 = 110.25
      expect(cost).toBeCloseTo(110.25, 2);
    });

    it("should estimate cost correctly for claude-sonnet-4-20250514", () => {
      const cost = estimateCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 1_000_000,
        },
        "claude-sonnet-4-20250514",
      );

      // Expected: 3 + 15 + 0.3 + 3.75 = 22.05
      expect(cost).toBeCloseTo(22.05, 2);
    });

    // T-14: Unknown model falls back to default pricing
    it("should fall back to default pricing for unknown models", () => {
      const costKnown = estimateCost(
        { input_tokens: 100000, output_tokens: 50000, cache_read_tokens: 0, cache_write_tokens: 0 },
        "claude-sonnet-4-20250514",
      );
      const costUnknown = estimateCost(
        { input_tokens: 100000, output_tokens: 50000, cache_read_tokens: 0, cache_write_tokens: 0 },
        "unknown-model-xyz",
      );

      // Unknown model should use sonnet pricing as default
      expect(costUnknown).toBeCloseTo(costKnown, 2);
    });

    it("should include cost in session usage totals", () => {
      projection.processEvent(
        makeEvent({
          sequence: 1,
          event_type: "SessionStarted",
          data: { model: "claude-opus-4-6" },
        }),
      );

      projection.processEvent(
        makeEvent({
          sequence: 2,
          event_type: "TurnCompleted",
          data: {
            usage: {
              input_tokens: 10000,
              output_tokens: 5000,
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 1000,
            },
          },
        }),
      );

      const result = projection.getSessionUsage("proj-a-abc123", "sess-001");
      expect(result!.totals.estimated_cost_usd).toBeGreaterThan(0);
    });
  });

  // T-15: Cross-session usage-daily aggregates across 5 sessions correctly
  describe("cross-session aggregation", () => {
    it("should aggregate usage across multiple sessions per day", () => {
      // Session 1 - day 1
      projection.processEvent(
        makeEvent({
          session_id: "sess-001",
          sequence: 1,
          event_type: "SessionStarted",
          timestamp: "2026-02-20T09:00:00.000Z",
          data: { model: "claude-opus-4-6" },
          agent_metadata: { model: "claude-opus-4-6" },
        }),
      );
      projection.processEvent(
        makeEvent({
          session_id: "sess-001",
          sequence: 2,
          event_type: "TurnCompleted",
          timestamp: "2026-02-20T09:05:00.000Z",
          data: { usage: { input_tokens: 1000, output_tokens: 500 } },
        }),
      );

      // Session 2 - day 1
      projection.processEvent(
        makeEvent({
          session_id: "sess-002",
          sequence: 1,
          event_type: "SessionStarted",
          timestamp: "2026-02-20T14:00:00.000Z",
          data: { model: "claude-sonnet-4-20250514" },
          agent_provider: "opencode",
          agent_metadata: { model: "claude-sonnet-4-20250514" },
        }),
      );
      projection.processEvent(
        makeEvent({
          session_id: "sess-002",
          sequence: 2,
          event_type: "TurnCompleted",
          timestamp: "2026-02-20T14:05:00.000Z",
          data: { usage: { input_tokens: 2000, output_tokens: 800 } },
        }),
      );

      // Session 3 - day 2
      projection.processEvent(
        makeEvent({
          session_id: "sess-003",
          sequence: 1,
          event_type: "SessionStarted",
          timestamp: "2026-02-21T10:00:00.000Z",
          data: { model: "claude-opus-4-6" },
          agent_metadata: { model: "claude-opus-4-6" },
        }),
      );
      projection.processEvent(
        makeEvent({
          session_id: "sess-003",
          sequence: 2,
          event_type: "TurnCompleted",
          timestamp: "2026-02-21T10:05:00.000Z",
          data: { usage: { input_tokens: 3000, output_tokens: 1000 } },
        }),
      );

      const daily = projection.getDailyUsage("proj-a-abc123");
      expect(daily.days).toHaveLength(2);

      const day1 = daily.days.find((d) => d.date === "2026-02-20");
      expect(day1).toBeDefined();
      expect(day1!.sessions).toBe(2);
      expect(day1!.input_tokens).toBe(3000);
      expect(day1!.output_tokens).toBe(1300);

      const day2 = daily.days.find((d) => d.date === "2026-02-21");
      expect(day2).toBeDefined();
      expect(day2!.sessions).toBe(1);
      expect(day2!.input_tokens).toBe(3000);
    });

    it("should aggregate usage by model", () => {
      projection.processEvent(
        makeEvent({
          session_id: "sess-001",
          sequence: 1,
          event_type: "SessionStarted",
          data: { model: "claude-opus-4-6" },
          agent_metadata: { model: "claude-opus-4-6" },
        }),
      );
      projection.processEvent(
        makeEvent({
          session_id: "sess-001",
          sequence: 2,
          event_type: "TurnCompleted",
          data: { usage: { input_tokens: 1000, output_tokens: 500 } },
        }),
      );

      projection.processEvent(
        makeEvent({
          session_id: "sess-002",
          sequence: 1,
          event_type: "SessionStarted",
          data: { model: "claude-sonnet-4-20250514" },
          agent_metadata: { model: "claude-sonnet-4-20250514" },
        }),
      );
      projection.processEvent(
        makeEvent({
          session_id: "sess-002",
          sequence: 2,
          event_type: "TurnCompleted",
          data: { usage: { input_tokens: 2000, output_tokens: 800 } },
        }),
      );

      const byModel = projection.getUsageByModel("proj-a-abc123");
      expect(Object.keys(byModel.models)).toHaveLength(2);
      expect(byModel.models["claude-opus-4-6"].sessions).toBe(1);
      expect(byModel.models["claude-opus-4-6"].input_tokens).toBe(1000);
      expect(byModel.models["claude-sonnet-4-20250514"].sessions).toBe(1);
      expect(byModel.models["claude-sonnet-4-20250514"].input_tokens).toBe(2000);
    });

    it("should calculate totals across all days and sessions", () => {
      for (let i = 1; i <= 5; i++) {
        const sessId = `sess-00${i}`;
        projection.processEvent(
          makeEvent({
            session_id: sessId,
            sequence: 1,
            event_type: "SessionStarted",
            timestamp: `2026-02-2${i}T10:00:00.000Z`,
            data: { model: "claude-opus-4-6" },
            agent_metadata: { model: "claude-opus-4-6" },
          }),
        );
        projection.processEvent(
          makeEvent({
            session_id: sessId,
            sequence: 2,
            event_type: "TurnCompleted",
            timestamp: `2026-02-2${i}T10:05:00.000Z`,
            data: { usage: { input_tokens: 1000, output_tokens: 500 } },
          }),
        );
      }

      const daily = projection.getDailyUsage("proj-a-abc123");
      expect(daily.totals.total_sessions).toBe(5);
      expect(daily.totals.total_tokens).toBe(7500); // (1000+500)*5
      expect(daily.totals.days_active).toBe(5);
    });
  });

  describe("edge cases", () => {
    it("should return empty usage for unknown project", () => {
      const daily = projection.getDailyUsage("nonexistent");
      expect(daily.days).toHaveLength(0);
      expect(daily.totals.total_sessions).toBe(0);
    });

    it("should return null session usage for unknown session", () => {
      const usage = projection.getSessionUsage("proj-a-abc123", "nonexistent");
      expect(usage).toBeNull();
    });

    it("should ignore non-relevant event types", () => {
      projection.processEvent(
        makeEvent({
          sequence: 1,
          event_type: "PermissionRequested",
          data: { tool_name: "Bash" },
        }),
      );

      const usage = projection.getSessionUsage("proj-a-abc123", "sess-001");
      // Should still have a session entry but no usage data
      expect(usage).toBeNull();
    });
  });
});
