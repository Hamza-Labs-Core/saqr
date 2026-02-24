/**
 * Tests for PermissionQueue - permission request queuing and resolution.
 *
 * Covers:
 *   - Enqueue a permission request
 *   - Respond to a pending request (allow, deny, always_allow)
 *   - Timeout handling (auto-deny after configurable timeout)
 *   - Multiple pending requests from different sessions
 *   - Concurrent response race (first-wins)
 *   - Event emission for requested, responded, timed_out
 *   - Query pending and session-specific requests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PermissionQueue } from "../agents/permission-queue.js";
import type {
  PermissionEvent,
  PermissionDecision,
} from "../agents/permission-queue.js";
import { PermissionAlreadyResolved } from "../agents/errors.js";

describe("PermissionQueue", () => {
  let queue: PermissionQueue;

  beforeEach(() => {
    queue = new PermissionQueue({ timeoutMs: 5000 });
  });

  afterEach(() => {
    queue.destroy();
  });

  // -----------------------------------------------------------------------
  // Enqueue
  // -----------------------------------------------------------------------

  describe("enqueue", () => {
    it("creates a pending permission request", () => {
      // Don't await - it's a promise that resolves when decided
      queue.enqueue({
        sessionId: "session-1",
        toolName: "Write",
        description: "Write to src/main.ts",
      });

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].sessionId).toBe("session-1");
      expect(pending[0].toolName).toBe("Write");
      expect(pending[0].status).toBe("pending");
    });

    it("assigns unique permissionId to each request", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "write 1",
      });
      queue.enqueue({
        sessionId: "s1",
        toolName: "Bash",
        description: "bash 1",
      });

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
      expect(pending[0].permissionId).not.toBe(pending[1].permissionId);
    });

    it("sets default risk to medium", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });
      expect(queue.getPending()[0].risk).toBe("medium");
    });

    it("accepts custom risk level", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Bash",
        description: "test",
        risk: "high",
      });
      expect(queue.getPending()[0].risk).toBe("high");
    });

    it("sets timeoutAt based on configured timeoutMs", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });
      const req = queue.getPending()[0];
      const expectedTimeout = req.requestedAt.getTime() + 5000;
      expect(req.timeoutAt.getTime()).toBe(expectedTimeout);
    });
  });

  // -----------------------------------------------------------------------
  // Respond
  // -----------------------------------------------------------------------

  describe("respond", () => {
    it("resolves the enqueue promise with the decision (allow)", async () => {
      const promise = queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      const pending = queue.getPending();
      queue.respond(pending[0].permissionId, "allow", "client-1");

      const decision = await promise;
      expect(decision).toBe("allow");
    });

    it("resolves with deny", async () => {
      const promise = queue.enqueue({
        sessionId: "s1",
        toolName: "Bash",
        description: "rm -rf",
      });

      const pending = queue.getPending();
      queue.respond(pending[0].permissionId, "deny", "client-1");

      const decision = await promise;
      expect(decision).toBe("deny");
    });

    it("resolves with always_allow", async () => {
      const promise = queue.enqueue({
        sessionId: "s1",
        toolName: "Read",
        description: "read file",
      });

      const pending = queue.getPending();
      queue.respond(pending[0].permissionId, "always_allow", "client-1");

      const decision = await promise;
      expect(decision).toBe("always_allow");
    });

    it("updates request status to allowed", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      const pending = queue.getPending();
      queue.respond(pending[0].permissionId, "allow", "client-1");

      // No longer pending
      expect(queue.getPending()).toHaveLength(0);
    });

    it("updates request status to always_allowed", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      const permissionId = queue.getPending()[0].permissionId;
      queue.respond(permissionId, "always_allow", "client-1");

      const forSession = queue.getForSession("s1");
      expect(forSession[0].status).toBe("always_allowed");
    });

    it("throws on responding to already-resolved request", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      const permissionId = queue.getPending()[0].permissionId;
      queue.respond(permissionId, "allow", "client-1");

      // Second response should throw
      expect(() =>
        queue.respond(permissionId, "deny", "client-2"),
      ).toThrow(PermissionAlreadyResolved);
    });

    it("throws on responding to nonexistent request", () => {
      expect(() =>
        queue.respond("nonexistent-id", "allow", "client-1"),
      ).toThrow(/not found/);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  describe("timeout", () => {
    it("auto-denies after timeout", async () => {
      vi.useFakeTimers();

      const shortQueue = new PermissionQueue({ timeoutMs: 1000 });
      const promise = shortQueue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      expect(shortQueue.getPending()).toHaveLength(1);

      // Advance past timeout
      vi.advanceTimersByTime(1100);

      const decision = await promise;
      expect(decision).toBe("deny");
      expect(shortQueue.getPending()).toHaveLength(0);

      vi.useRealTimers();
      shortQueue.destroy();
    });

    it("emits timed_out event", async () => {
      vi.useFakeTimers();

      const shortQueue = new PermissionQueue({ timeoutMs: 500 });
      const events: PermissionEvent[] = [];
      shortQueue.onRequest((e) => events.push(e));

      shortQueue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      vi.advanceTimersByTime(600);

      // Allow microtask queue to drain
      await vi.advanceTimersByTimeAsync(0);

      const timedOutEvents = events.filter((e) => e.type === "timed_out");
      expect(timedOutEvents).toHaveLength(1);
      expect(timedOutEvents[0].request.status).toBe("timed_out");

      vi.useRealTimers();
      shortQueue.destroy();
    });

    it("always denies on timeout even when timeoutAction is 'allow'", async () => {
      vi.useFakeTimers();

      const allowQueue = new PermissionQueue({
        timeoutMs: 500,
        timeoutAction: "allow",
      });
      const promise = allowQueue.enqueue({
        sessionId: "s1",
        toolName: "Read",
        description: "safe read",
      });

      vi.advanceTimersByTime(600);

      const decision = await promise;
      // Safety: timeout must always deny regardless of timeoutAction config
      expect(decision).toBe("deny");

      vi.useRealTimers();
      allowQueue.destroy();
    });

    it("sets resolvedBy to 'timeout' on timeout", async () => {
      vi.useFakeTimers();

      const shortQueue = new PermissionQueue({ timeoutMs: 500 });
      const events: PermissionEvent[] = [];
      shortQueue.onRequest((e) => events.push(e));

      shortQueue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      vi.advanceTimersByTime(600);
      await vi.advanceTimersByTimeAsync(0);

      const timedOutEvents = events.filter((e) => e.type === "timed_out");
      expect(timedOutEvents).toHaveLength(1);
      expect(timedOutEvents[0].request.resolvedBy).toBe("timeout");

      // Also verify via getForSession
      const requests = shortQueue.getForSession("s1");
      expect(requests[0].resolvedBy).toBe("timeout");

      vi.useRealTimers();
      shortQueue.destroy();
    });

    it("responding before timeout cancels the timer", async () => {
      vi.useFakeTimers();

      const shortQueue = new PermissionQueue({ timeoutMs: 1000 });
      const events: PermissionEvent[] = [];
      shortQueue.onRequest((e) => events.push(e));

      const promise = shortQueue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      // Respond before timeout
      const permissionId = shortQueue.getPending()[0].permissionId;
      shortQueue.respond(permissionId, "allow", "client-1");

      // Advance past timeout
      vi.advanceTimersByTime(1100);
      await vi.advanceTimersByTimeAsync(0);

      const decision = await promise;
      expect(decision).toBe("allow");

      // No timed_out event should have been emitted
      const timedOutEvents = events.filter((e) => e.type === "timed_out");
      expect(timedOutEvents).toHaveLength(0);

      vi.useRealTimers();
      shortQueue.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple Pending Requests
  // -----------------------------------------------------------------------

  describe("multiple pending requests", () => {
    it("handles multiple pending requests independently", async () => {
      const p1 = queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "write 1",
      });
      const p2 = queue.enqueue({
        sessionId: "s2",
        toolName: "Bash",
        description: "bash 1",
      });

      expect(queue.getPending()).toHaveLength(2);

      const pending = queue.getPending();
      queue.respond(pending[0].permissionId, "allow", "client-1");
      queue.respond(pending[1].permissionId, "deny", "client-1");

      expect(await p1).toBe("allow");
      expect(await p2).toBe("deny");
      expect(queue.getPending()).toHaveLength(0);
    });

    it("getForSession filters by session", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "write 1",
      });
      queue.enqueue({
        sessionId: "s1",
        toolName: "Bash",
        description: "bash 1",
      });
      queue.enqueue({
        sessionId: "s2",
        toolName: "Write",
        description: "write 2",
      });

      expect(queue.getForSession("s1")).toHaveLength(2);
      expect(queue.getForSession("s2")).toHaveLength(1);
      expect(queue.getForSession("s3")).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Event Emission
  // -----------------------------------------------------------------------

  describe("events", () => {
    it("emits requested event on enqueue", () => {
      const events: PermissionEvent[] = [];
      queue.onRequest((e) => events.push(e));

      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("requested");
      expect(events[0].request.toolName).toBe("Write");
    });

    it("emits responded event on respond", () => {
      const events: PermissionEvent[] = [];
      queue.onRequest((e) => events.push(e));

      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });

      const permissionId = queue.getPending()[0].permissionId;
      queue.respond(permissionId, "allow", "client-1");

      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("responded");
      expect(events[1].decision).toBe("allow");
      expect(events[1].respondedBy).toBe("client-1");
    });

    it("unsubscribe stops receiving events", () => {
      const events: PermissionEvent[] = [];
      const unsub = queue.onRequest((e) => events.push(e));

      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });
      expect(events).toHaveLength(1);

      unsub();

      queue.enqueue({
        sessionId: "s1",
        toolName: "Bash",
        description: "test2",
      });
      // Still 1 because we unsubscribed
      expect(events).toHaveLength(1);
    });

    it("listener errors do not break the queue", () => {
      queue.onRequest(() => {
        throw new Error("bad listener");
      });

      expect(() => {
        queue.enqueue({
          sessionId: "s1",
          toolName: "Write",
          description: "test",
        });
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("clears all pending requests and timers", () => {
      queue.enqueue({
        sessionId: "s1",
        toolName: "Write",
        description: "test",
      });
      queue.enqueue({
        sessionId: "s2",
        toolName: "Bash",
        description: "test2",
      });

      expect(queue.getPending()).toHaveLength(2);
      queue.destroy();
      expect(queue.getPending()).toHaveLength(0);
    });
  });
});
