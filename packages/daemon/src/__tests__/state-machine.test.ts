/**
 * Tests for the Agent Lifecycle State Machine.
 *
 * Covers:
 *   T-3: State machine enforces valid transitions and rejects invalid ones
 *   T-4: State machine emits StateChangeEvent on every transition
 *   T-5: closed is a terminal state (no transitions allowed from it)
 *   T-6: Error recovery with exponential backoff
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AgentStateMachine,
  DEFAULT_RECOVERY_POLICY,
} from "../agents/state-machine.js";
import type {
  StateChangeEvent,
  AgentError,
  AgentLifecycleState,
} from "../agents/state-machine.js";
import { InvalidStateTransitionError } from "../agents/errors.js";

describe("AgentStateMachine", () => {
  let sm: AgentStateMachine;

  beforeEach(() => {
    sm = new AgentStateMachine("test-session-1");
  });

  // -----------------------------------------------------------------------
  // T-3: Valid and Invalid Transitions
  // -----------------------------------------------------------------------

  describe("valid state transitions", () => {
    it("starts in initializing state", () => {
      expect(sm.state).toBe("initializing");
    });

    it("initializing -> idle (spawn success)", () => {
      sm.transition("idle", "spawn success");
      expect(sm.state).toBe("idle");
    });

    it("initializing -> error (spawn failed)", () => {
      sm.transition("error", "spawn failed", {
        code: "SPAWN_FAILED",
        message: "binary not found",
        recoverable: false,
      });
      expect(sm.state).toBe("error");
    });

    it("initializing -> closed (cancel during init)", () => {
      sm.transition("closed", "cancelled");
      expect(sm.state).toBe("closed");
    });

    it("idle -> running (sendPrompt)", () => {
      sm.transition("idle");
      sm.transition("running", "prompt sent");
      expect(sm.state).toBe("running");
    });

    it("idle -> closed (normal shutdown)", () => {
      sm.transition("idle");
      sm.transition("closed", "shutdown");
      expect(sm.state).toBe("closed");
    });

    it("running -> idle (turn complete)", () => {
      sm.transition("idle");
      sm.transition("running");
      sm.transition("idle", "turn complete");
      expect(sm.state).toBe("idle");
    });

    it("running -> error (unrecoverable error)", () => {
      sm.transition("idle");
      sm.transition("running");
      sm.transition("error", "crash", {
        code: "CRASH",
        message: "agent crashed",
        recoverable: false,
      });
      expect(sm.state).toBe("error");
    });

    it("error -> idle (recovery succeeded)", () => {
      sm.transition("error", "some error", {
        code: "NETWORK_ERROR",
        message: "timeout",
        recoverable: true,
      });
      sm.transition("idle", "recovered");
      expect(sm.state).toBe("idle");
    });

    it("error -> closed (fatal)", () => {
      sm.transition("error", "fatal");
      sm.transition("closed", "unrecoverable");
      expect(sm.state).toBe("closed");
    });

    it("closed can be reached from any non-closed state", () => {
      // From initializing
      let sm1 = new AgentStateMachine("s1");
      sm1.transition("closed");
      expect(sm1.state).toBe("closed");

      // From idle
      let sm2 = new AgentStateMachine("s2");
      sm2.transition("idle");
      sm2.transition("closed");
      expect(sm2.state).toBe("closed");

      // From running
      let sm3 = new AgentStateMachine("s3");
      sm3.transition("idle");
      sm3.transition("running");
      sm3.transition("closed");
      expect(sm3.state).toBe("closed");

      // From error
      let sm4 = new AgentStateMachine("s4");
      sm4.transition("error");
      sm4.transition("closed");
      expect(sm4.state).toBe("closed");
    });
  });

  describe("invalid state transitions", () => {
    it("initializing -> running throws", () => {
      expect(() => sm.transition("running")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("idle -> error throws", () => {
      sm.transition("idle");
      expect(() => sm.transition("error")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("idle -> initializing throws", () => {
      sm.transition("idle");
      expect(() => sm.transition("initializing")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("running -> initializing throws", () => {
      sm.transition("idle");
      sm.transition("running");
      expect(() => sm.transition("initializing")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("error -> running throws", () => {
      sm.transition("error");
      expect(() => sm.transition("running")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("error -> initializing throws", () => {
      sm.transition("error");
      expect(() => sm.transition("initializing")).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // T-4: StateChangeEvent emissions
  // -----------------------------------------------------------------------

  describe("state change events", () => {
    it("emits StateChangeEvent on every valid transition", () => {
      const events: StateChangeEvent[] = [];
      sm.onStateChange((e) => events.push(e));

      sm.transition("idle", "ready");
      sm.transition("running", "prompt");
      sm.transition("idle", "done");
      sm.transition("closed", "shutdown");

      expect(events).toHaveLength(4);
      expect(events[0]).toMatchObject({
        sessionId: "test-session-1",
        previousState: "initializing",
        currentState: "idle",
        reason: "ready",
      });
      expect(events[1]).toMatchObject({
        previousState: "idle",
        currentState: "running",
      });
      expect(events[2]).toMatchObject({
        previousState: "running",
        currentState: "idle",
      });
      expect(events[3]).toMatchObject({
        previousState: "idle",
        currentState: "closed",
      });
    });

    it("includes timestamp on every event", () => {
      const events: StateChangeEvent[] = [];
      sm.onStateChange((e) => events.push(e));
      sm.transition("idle");
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it("includes error info when transitioning to error state", () => {
      const events: StateChangeEvent[] = [];
      sm.onStateChange((e) => events.push(e));

      const err: AgentError = {
        code: "SPAWN_FAILED",
        message: "binary missing",
        recoverable: false,
      };
      sm.transition("error", "spawn error", err);

      expect(events[0].error).toEqual(err);
    });

    it("unsubscribe function removes listener", () => {
      const events: StateChangeEvent[] = [];
      const unsub = sm.onStateChange((e) => events.push(e));

      sm.transition("idle");
      expect(events).toHaveLength(1);

      unsub();
      sm.transition("running");
      // Should still be 1 because we unsubscribed
      expect(events).toHaveLength(1);
    });

    it("listener errors do not propagate to state machine", () => {
      sm.onStateChange(() => {
        throw new Error("listener error");
      });

      // Should not throw
      expect(() => sm.transition("idle")).not.toThrow();
      expect(sm.state).toBe("idle");
    });

    it("does not emit on invalid transition attempts", () => {
      const events: StateChangeEvent[] = [];
      sm.onStateChange((e) => events.push(e));

      try {
        sm.transition("running");
      } catch {
        // Expected
      }

      expect(events).toHaveLength(0);
      expect(sm.state).toBe("initializing");
    });
  });

  // -----------------------------------------------------------------------
  // T-5: closed is terminal
  // -----------------------------------------------------------------------

  describe("closed terminal state", () => {
    it("cannot transition from closed to any state", () => {
      sm.transition("closed");
      const states: AgentLifecycleState[] = [
        "initializing",
        "idle",
        "running",
        "error",
        "closed",
      ];
      for (const s of states) {
        expect(() => sm.transition(s)).toThrow(InvalidStateTransitionError);
      }
    });

    it("closed -> closed throws with terminal state message", () => {
      sm.transition("closed");
      expect(() => sm.transition("closed")).toThrow(/terminal state/);
    });
  });

  // -----------------------------------------------------------------------
  // T-6: Error recovery with exponential backoff
  // -----------------------------------------------------------------------

  describe("error recovery", () => {
    it("recovers from recoverable error", async () => {
      vi.useFakeTimers();

      const quickPolicy = {
        ...DEFAULT_RECOVERY_POLICY,
        backoffMs: 100,
        maxBackoffMs: 1000,
        maxRetries: 3,
      };
      const sm2 = new AgentStateMachine("recovery-session", quickPolicy);
      sm2.transition("error", "rate limited", {
        code: "RATE_LIMITED",
        message: "429",
        recoverable: true,
      });

      const retryFn = vi.fn().mockResolvedValueOnce(undefined);
      const recoveryPromise = sm2.attemptRecovery(
        { code: "RATE_LIMITED", message: "429", recoverable: true },
        retryFn,
      );

      // Advance past the backoff delay
      await vi.advanceTimersByTimeAsync(200);

      const result = await recoveryPromise;
      expect(result).toBe(true);
      expect(sm2.state).toBe("idle");
      expect(retryFn).toHaveBeenCalledOnce();

      vi.useRealTimers();
      sm2.destroy();
    });

    it("returns false for non-recoverable error", async () => {
      sm.transition("error");
      const result = await sm.attemptRecovery(
        { code: "FATAL", message: "fatal", recoverable: false },
        async () => {},
      );
      expect(result).toBe(false);
    });

    it("returns false for error code not in recoverable list", async () => {
      sm.transition("error");
      const result = await sm.attemptRecovery(
        { code: "UNKNOWN_CODE", message: "unknown", recoverable: true },
        async () => {},
      );
      expect(result).toBe(false);
    });

    it("retries with exponential backoff on recovery failure", async () => {
      vi.useFakeTimers();

      const quickPolicy = {
        ...DEFAULT_RECOVERY_POLICY,
        backoffMs: 50,
        maxBackoffMs: 500,
        maxRetries: 2,
      };
      const sm2 = new AgentStateMachine("backoff-session", quickPolicy);
      sm2.transition("error", "network error");

      const retryFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("still failing"))
        .mockResolvedValueOnce(undefined);

      const recoveryPromise = sm2.attemptRecovery(
        { code: "NETWORK_ERROR", message: "timeout", recoverable: true },
        retryFn,
      );

      // First retry after 50ms
      await vi.advanceTimersByTimeAsync(60);
      // Second retry after 100ms (doubled)
      await vi.advanceTimersByTimeAsync(110);

      const result = await recoveryPromise;
      expect(result).toBe(true);
      expect(retryFn).toHaveBeenCalledTimes(2);
      expect(sm2.state).toBe("idle");

      vi.useRealTimers();
      sm2.destroy();
    });

    it("returns false when max retries exhausted", async () => {
      vi.useFakeTimers();

      const quickPolicy = {
        ...DEFAULT_RECOVERY_POLICY,
        backoffMs: 10,
        maxBackoffMs: 100,
        maxRetries: 1,
      };
      const sm2 = new AgentStateMachine("exhaust-session", quickPolicy);
      sm2.transition("error");

      const retryFn = vi.fn().mockRejectedValue(new Error("fail"));
      const recoveryPromise = sm2.attemptRecovery(
        { code: "NETWORK_ERROR", message: "down", recoverable: true },
        retryFn,
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await recoveryPromise;
      expect(result).toBe(false);
      expect(retryFn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      sm2.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // destroy()
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("clears all listeners", () => {
      const events: StateChangeEvent[] = [];
      sm.onStateChange((e) => events.push(e));
      sm.destroy();
      sm.transition("idle");
      expect(events).toHaveLength(0);
    });
  });
});
