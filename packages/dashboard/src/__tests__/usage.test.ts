/**
 * Tests for Usage Analytics API.
 *
 * Verifies:
 * - JSONL transcript line parsing
 * - Token aggregation per session
 * - Daily aggregation
 * - Cost calculation with model pricing
 * - Token formatting
 * - Claude directory name conversion
 */

import { describe, it, expect } from "vitest";
import {
  parseTranscriptLines,
  calcCost,
  getModelTier,
  formatTokens,
  formatCost,
  toClaudeDir,
  MODEL_PRICING,
} from "../api/usage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantLine(overrides: {
  sessionId?: string;
  model?: string;
  timestamp?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: overrides.sessionId || "sess-001",
    timestamp: overrides.timestamp || "2025-01-15T10:00:00.000Z",
    message: {
      model: overrides.model || "claude-sonnet-4-20250514",
      usage: {
        input_tokens: overrides.input_tokens ?? 1000,
        output_tokens: overrides.output_tokens ?? 500,
        cache_read_input_tokens: overrides.cache_read_input_tokens ?? 200,
        cache_creation_input_tokens: overrides.cache_creation_input_tokens ?? 100,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseTranscriptLines", () => {
  it("parses a single assistant line", () => {
    const lines = [makeAssistantLine()];
    const { sessions, daily } = parseTranscriptLines(lines);

    expect(sessions.size).toBe(1);
    const sess = sessions.get("sess-001")!;
    expect(sess.api_calls).toBe(1);
    expect(sess.input_tokens).toBe(1000);
    expect(sess.output_tokens).toBe(500);
    expect(sess.cache_read_tokens).toBe(200);
    expect(sess.cache_create_tokens).toBe(100);
    expect(sess.model).toBe("claude-sonnet-4-20250514");

    expect(daily.size).toBe(1);
    const day = daily.get("2025-01-15")!;
    expect(day.api_calls).toBe(1);
    expect(day.input_tokens).toBe(1000);
  });

  it("aggregates multiple lines for same session", () => {
    const lines = [
      makeAssistantLine({ input_tokens: 1000, output_tokens: 500 }),
      makeAssistantLine({ input_tokens: 2000, output_tokens: 1000, timestamp: "2025-01-15T10:05:00.000Z" }),
    ];
    const { sessions } = parseTranscriptLines(lines);
    const sess = sessions.get("sess-001")!;
    expect(sess.api_calls).toBe(2);
    expect(sess.input_tokens).toBe(3000);
    expect(sess.output_tokens).toBe(1500);
  });

  it("separates different sessions", () => {
    const lines = [
      makeAssistantLine({ sessionId: "sess-001", input_tokens: 1000 }),
      makeAssistantLine({ sessionId: "sess-002", input_tokens: 2000 }),
    ];
    const { sessions } = parseTranscriptLines(lines);
    expect(sessions.size).toBe(2);
    expect(sessions.get("sess-001")!.input_tokens).toBe(1000);
    expect(sessions.get("sess-002")!.input_tokens).toBe(2000);
  });

  it("aggregates daily data across sessions", () => {
    const lines = [
      makeAssistantLine({ sessionId: "s1", timestamp: "2025-01-15T10:00:00.000Z", input_tokens: 1000 }),
      makeAssistantLine({ sessionId: "s2", timestamp: "2025-01-15T14:00:00.000Z", input_tokens: 2000 }),
      makeAssistantLine({ sessionId: "s1", timestamp: "2025-01-16T09:00:00.000Z", input_tokens: 3000 }),
    ];
    const { daily } = parseTranscriptLines(lines);
    expect(daily.size).toBe(2);
    expect(daily.get("2025-01-15")!.input_tokens).toBe(3000);
    expect(daily.get("2025-01-16")!.input_tokens).toBe(3000);
  });

  it("ignores non-assistant lines", () => {
    const lines = [
      JSON.stringify({ type: "human", content: "Hello" }),
      makeAssistantLine(),
      JSON.stringify({ type: "system", content: "init" }),
    ];
    const { sessions } = parseTranscriptLines(lines);
    expect(sessions.size).toBe(1);
  });

  it("ignores malformed JSON", () => {
    const lines = [
      "not json at all",
      makeAssistantLine(),
      '{"type":"assistant"', // truncated
    ];
    const { sessions } = parseTranscriptLines(lines);
    expect(sessions.size).toBe(1);
  });

  it("handles lines without usage data", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-20250514" } }),
      makeAssistantLine(),
    ];
    const { sessions } = parseTranscriptLines(lines);
    expect(sessions.size).toBe(1);
  });

  it("tracks started_at and last_api_call_at", () => {
    const lines = [
      makeAssistantLine({ timestamp: "2025-01-15T10:00:00.000Z" }),
      makeAssistantLine({ timestamp: "2025-01-15T08:00:00.000Z" }),
      makeAssistantLine({ timestamp: "2025-01-15T12:00:00.000Z" }),
    ];
    const { sessions } = parseTranscriptLines(lines);
    const sess = sessions.get("sess-001")!;
    expect(sess.started_at).toBe("2025-01-15T08:00:00.000Z");
    expect(sess.last_api_call_at).toBe("2025-01-15T12:00:00.000Z");
  });

  it("returns empty maps for empty input", () => {
    const { sessions, daily } = parseTranscriptLines([]);
    expect(sessions.size).toBe(0);
    expect(daily.size).toBe(0);
  });
});

describe("getModelTier", () => {
  it("returns haiku for haiku models", () => {
    expect(getModelTier("claude-3-5-haiku-20241022")).toBe("haiku");
  });

  it("returns sonnet for sonnet models", () => {
    expect(getModelTier("claude-sonnet-4-20250514")).toBe("sonnet");
  });

  it("returns opus for opus models", () => {
    expect(getModelTier("claude-opus-4-20250514")).toBe("opus");
  });

  it("defaults to opus for unknown models", () => {
    expect(getModelTier("unknown-model")).toBe("opus");
  });

  it("defaults to opus for empty string", () => {
    expect(getModelTier("")).toBe("opus");
  });
});

describe("calcCost", () => {
  it("calculates cost with sonnet pricing", () => {
    const cost = calcCost(1_000_000, 1_000_000, 0, 0, "claude-sonnet-4-20250514");
    // 1M input * $3/1M + 1M output * $15/1M = $18
    expect(cost).toBeCloseTo(18, 2);
  });

  it("calculates cost with opus pricing", () => {
    const cost = calcCost(1_000_000, 1_000_000, 0, 0, "claude-opus-4-20250514");
    // 1M input * $15/1M + 1M output * $75/1M = $90
    expect(cost).toBeCloseTo(90, 2);
  });

  it("calculates cost with haiku pricing", () => {
    const cost = calcCost(1_000_000, 1_000_000, 0, 0, "claude-3-5-haiku-20241022");
    // 1M input * $0.8/1M + 1M output * $4/1M = $4.8
    expect(cost).toBeCloseTo(4.8, 2);
  });

  it("includes cache token costs", () => {
    const cost = calcCost(0, 0, 1_000_000, 1_000_000, "claude-sonnet-4-20250514");
    // 1M cache_read * $0.3/1M + 1M cache_create * $3.75/1M = $4.05
    expect(cost).toBeCloseTo(4.05, 2);
  });

  it("returns 0 for zero tokens", () => {
    const cost = calcCost(0, 0, 0, 0, "claude-sonnet-4-20250514");
    expect(cost).toBe(0);
  });
});

describe("formatTokens", () => {
  it("formats 0", () => {
    expect(formatTokens(0)).toBe("0");
  });

  it("formats small numbers as-is", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1500)).toBe("1.5K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("formats exactly 1K", () => {
    expect(formatTokens(1000)).toBe("1.0K");
  });

  it("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});

describe("formatCost", () => {
  it("formats small costs with 2 decimals", () => {
    expect(formatCost(1.23)).toBe("$1.23");
  });

  it("formats medium costs with 1 decimal", () => {
    expect(formatCost(15.67)).toBe("$15.7");
  });

  it("formats large costs with no decimals", () => {
    expect(formatCost(123.45)).toBe("$123");
  });

  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("toClaudeDir", () => {
  it("converts absolute path to Claude dir name", () => {
    expect(toClaudeDir("/home/user/my-project")).toBe("-home-user-my-project");
  });

  it("handles root path", () => {
    expect(toClaudeDir("/")).toBe("-");
  });

  it("handles nested paths", () => {
    expect(toClaudeDir("/a/b/c/d")).toBe("-a-b-c-d");
  });
});

describe("MODEL_PRICING", () => {
  it("has pricing for opus", () => {
    expect(MODEL_PRICING.opus).toBeDefined();
    expect(MODEL_PRICING.opus.input).toBe(15);
    expect(MODEL_PRICING.opus.output).toBe(75);
  });

  it("has pricing for sonnet", () => {
    expect(MODEL_PRICING.sonnet).toBeDefined();
    expect(MODEL_PRICING.sonnet.input).toBe(3);
    expect(MODEL_PRICING.sonnet.output).toBe(15);
  });

  it("has pricing for haiku", () => {
    expect(MODEL_PRICING.haiku).toBeDefined();
    expect(MODEL_PRICING.haiku.input).toBe(0.8);
    expect(MODEL_PRICING.haiku.output).toBe(4);
  });
});
