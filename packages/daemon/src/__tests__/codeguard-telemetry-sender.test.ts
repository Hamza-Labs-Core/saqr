/**
 * Tests for Codeguard TelemetrySender — Periodic rule usage telemetry.
 *
 * Covers:
 * - buildPayload creates correct structure from rules + stats
 * - buildPayload maps layer "global" to scope "global" and "project" to "project"
 * - buildPayload handles rules with no violations (blocks: 0)
 * - sendNow sends POST with correct payload (mock global fetch)
 * - sendNow skips send if payload unchanged from last snapshot
 * - sendNow includes auth token in Authorization header
 * - sendNow returns error on failed request
 * - setEnabled(false) prevents sending
 * - start/stop manage interval timer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TelemetrySender,
  type TelemetryConfig,
} from "../codeguard/telemetry-sender.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuleManager(
  rules: Array<{ id: string; layer: string }> = [],
) {
  return {
    listRules: vi.fn().mockResolvedValue(rules),
  };
}

function makeViolationTracker(
  statsMap: Map<string, { total: number }> = new Map(),
) {
  return {
    getStats: vi.fn().mockReturnValue(statsMap),
  };
}

function defaultConfig(overrides?: Partial<TelemetryConfig>): TelemetryConfig {
  return {
    serverUrl: "https://sync.saqr.dev",
    authToken: "test-jwt-token",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelemetrySender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // buildPayload
  // -----------------------------------------------------------------------

  describe("buildPayload", () => {
    it("should create correct structure from rules and stats", () => {
      const sender = new TelemetrySender(defaultConfig());
      const rules = [
        { id: "eval-usage", layer: "global" },
        { id: "no-any-type", layer: "project" },
      ];
      const stats = new Map<string, { total: number }>([
        ["eval-usage", { total: 12 }],
        ["no-any-type", { total: 5 }],
      ]);

      const payload = sender.buildPayload(rules, stats);

      expect(payload.rules).toHaveLength(2);
      expect(payload.rules[0]).toEqual({
        id: "eval-usage",
        scope: "global",
        blocks: 12,
      });
      expect(payload.rules[1]).toEqual({
        id: "no-any-type",
        scope: "project",
        blocks: 5,
      });
      expect(payload.sent_at).toBeDefined();
      expect(typeof payload.sent_at).toBe("string");
    });

    it("should map layer 'global' to scope 'global' and 'project' to scope 'project'", () => {
      const sender = new TelemetrySender(defaultConfig());
      const rules = [
        { id: "rule-a", layer: "global" },
        { id: "rule-b", layer: "project" },
      ];
      const stats = new Map<string, { total: number }>();

      const payload = sender.buildPayload(rules, stats);

      expect(payload.rules[0].scope).toBe("global");
      expect(payload.rules[1].scope).toBe("project");
    });

    it("should handle rules with no violations (blocks: 0)", () => {
      const sender = new TelemetrySender(defaultConfig());
      const rules = [
        { id: "rule-no-violations", layer: "global" },
        { id: "rule-with-violations", layer: "project" },
      ];
      const stats = new Map<string, { total: number }>([
        ["rule-with-violations", { total: 7 }],
      ]);

      const payload = sender.buildPayload(rules, stats);

      expect(payload.rules[0].blocks).toBe(0);
      expect(payload.rules[1].blocks).toBe(7);
    });
  });

  // -----------------------------------------------------------------------
  // sendNow
  // -----------------------------------------------------------------------

  describe("sendNow", () => {
    it("should send POST with correct payload", async () => {
      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);

      const rules = [{ id: "eval-usage", layer: "global" }];
      const stats = new Map<string, { total: number }>([
        ["eval-usage", { total: 3 }],
      ]);
      const rm = makeRuleManager(rules);
      const vt = makeViolationTracker(stats);

      const result = await sender.sendNow(rm, vt);

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://sync.saqr.dev/api/codeguard/telemetry");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body);
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0]).toEqual({
        id: "eval-usage",
        scope: "global",
        blocks: 3,
      });
      expect(body.sent_at).toBeDefined();
    });

    it("should skip send if payload unchanged from last snapshot", async () => {
      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);

      const rules = [{ id: "eval-usage", layer: "global" }];
      const stats = new Map<string, { total: number }>([
        ["eval-usage", { total: 3 }],
      ]);
      const rm = makeRuleManager(rules);
      const vt = makeViolationTracker(stats);

      // First send -- should actually POST
      await sender.sendNow(rm, vt);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second send with same data -- should skip
      const result = await sender.sendNow(rm, vt);
      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no additional call
    });

    it("should include auth token in Authorization header", async () => {
      const sender = new TelemetrySender(defaultConfig({ authToken: "my-jwt-123" }));
      sender.setEnabled(true);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      await sender.sendNow(rm, vt);

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers["Authorization"]).toBe("Bearer my-jwt-123");
    });

    it("should return error on failed request", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      const result = await sender.sendNow(rm, vt);

      expect(result.success).toBe(false);
      expect(result.error).toBe("HTTP 500: Internal Server Error");
      expect(sender.getLastSnapshot()).toBeNull();
    });

    it("should return error when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network failure"));

      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      const result = await sender.sendNow(rm, vt);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network failure");
    });
  });

  // -----------------------------------------------------------------------
  // setEnabled
  // -----------------------------------------------------------------------

  describe("setEnabled", () => {
    it("should prevent sending when disabled", async () => {
      const sender = new TelemetrySender(defaultConfig());
      // Not calling setEnabled(true) — disabled by default

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      const result = await sender.sendNow(rm, vt);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Telemetry is disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should prevent sending after being disabled", async () => {
      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);
      sender.setEnabled(false);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      const result = await sender.sendNow(rm, vt);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Telemetry is disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  describe("start / stop", () => {
    it("should manage interval timer and send periodically", async () => {
      const sender = new TelemetrySender(
        defaultConfig({ intervalMs: 5000 }),
      );
      sender.setEnabled(true);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(
        new Map([["r1", { total: 1 }]]),
      );

      sender.start(rm, vt);

      // No immediate call
      expect(fetchMock).not.toHaveBeenCalled();

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance past another interval — but payload is same, so skipped
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // deduplicated

      // Stop should prevent further sends
      sender.stop();

      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no more calls
    });

    it("should stop previous timer when start is called again", () => {
      const sender = new TelemetrySender(
        defaultConfig({ intervalMs: 5000 }),
      );
      sender.setEnabled(true);

      const rm = makeRuleManager([]);
      const vt = makeViolationTracker(new Map());

      sender.start(rm, vt);
      sender.start(rm, vt); // should not throw or create duplicate timers
      sender.stop();
    });
  });

  // -----------------------------------------------------------------------
  // setAuthToken
  // -----------------------------------------------------------------------

  describe("setAuthToken", () => {
    it("should update the auth token used in requests", async () => {
      const sender = new TelemetrySender(defaultConfig({ authToken: undefined }));
      sender.setEnabled(true);
      sender.setAuthToken("new-token-456");

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map());

      await sender.sendNow(rm, vt);

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers["Authorization"]).toBe("Bearer new-token-456");
    });
  });

  // -----------------------------------------------------------------------
  // getLastSnapshot
  // -----------------------------------------------------------------------

  describe("getLastSnapshot", () => {
    it("should return null before any successful send", () => {
      const sender = new TelemetrySender(defaultConfig());
      expect(sender.getLastSnapshot()).toBeNull();
    });

    it("should return last snapshot after successful send", async () => {
      const sender = new TelemetrySender(defaultConfig());
      sender.setEnabled(true);

      const rm = makeRuleManager([{ id: "r1", layer: "global" }]);
      const vt = makeViolationTracker(new Map([["r1", { total: 10 }]]));

      await sender.sendNow(rm, vt);

      const snapshot = sender.getLastSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.rules).toHaveLength(1);
      expect(snapshot!.rules[0]).toEqual({
        id: "r1",
        scope: "global",
        blocks: 10,
      });
    });
  });
});
