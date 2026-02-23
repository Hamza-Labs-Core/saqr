/**
 * Tests for SessionRegistry — central registry of sessions with state machine.
 *
 * Covers: session registration, state transitions, listing, removal.
 * State machine: detected -> observed -> (managed | resumed) -> closed
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SessionRegistry,
  type AttachSessionInfo,
  type SessionAttachState,
} from "../sessions/session-registry.js";
import { EventBus } from "../event-bus/event-bus.js";

function makeSessionInfo(
  overrides: Partial<AttachSessionInfo> = {},
): AttachSessionInfo {
  return {
    sessionId: "sess-001",
    projectId: "proj-abc",
    agentProvider: "claude-code",
    detectedAt: new Date(),
    state: "detected",
    pid: undefined,
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  let registry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    registry = new SessionRegistry(eventBus);
  });

  describe("register", () => {
    it("should register a new session in detected state", () => {
      const info = makeSessionInfo();
      registry.register(info);
      const session = registry.getSession("sess-001");
      expect(session).toBeDefined();
      expect(session!.state).toBe("detected");
    });

    it("should throw when registering a duplicate session", () => {
      registry.register(makeSessionInfo());
      expect(() => registry.register(makeSessionInfo())).toThrow(
        /already registered/,
      );
    });

    it("should emit event on registration", () => {
      const events: any[] = [];
      eventBus.subscribe(
        { eventTypes: ["SessionDetected"] },
        (e) => events.push(e),
      );

      registry.register(makeSessionInfo());
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("SessionDetected");
    });
  });

  describe("getSession", () => {
    it("should return registered session by ID", () => {
      registry.register(makeSessionInfo({ sessionId: "s1" }));
      expect(registry.getSession("s1")).toBeDefined();
    });

    it("should return undefined for unknown session ID", () => {
      expect(registry.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("should return all registered sessions", () => {
      registry.register(makeSessionInfo({ sessionId: "s1" }));
      registry.register(makeSessionInfo({ sessionId: "s2" }));
      registry.register(makeSessionInfo({ sessionId: "s3" }));
      expect(registry.listSessions()).toHaveLength(3);
    });

    it("should return empty array when no sessions", () => {
      expect(registry.listSessions()).toEqual([]);
    });

    it("should filter sessions by state", () => {
      registry.register(makeSessionInfo({ sessionId: "s1" }));
      registry.register(makeSessionInfo({ sessionId: "s2" }));
      registry.updateState("s1", "observed");

      const observed = registry.listSessions("observed");
      expect(observed).toHaveLength(1);
      expect(observed[0].sessionId).toBe("s1");
    });
  });

  describe("updateState", () => {
    it("should transition detected -> observed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      expect(registry.getSession("sess-001")!.state).toBe("observed");
    });

    it("should transition observed -> managed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      registry.updateState("sess-001", "managed");
      expect(registry.getSession("sess-001")!.state).toBe("managed");
    });

    it("should transition observed -> resumed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      registry.updateState("sess-001", "resumed");
      expect(registry.getSession("sess-001")!.state).toBe("resumed");
    });

    it("should transition managed -> closed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      registry.updateState("sess-001", "managed");
      registry.updateState("sess-001", "closed");
      expect(registry.getSession("sess-001")!.state).toBe("closed");
    });

    it("should transition resumed -> closed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      registry.updateState("sess-001", "resumed");
      registry.updateState("sess-001", "closed");
      expect(registry.getSession("sess-001")!.state).toBe("closed");
    });

    it("should transition detected -> closed (skip observed)", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "closed");
      expect(registry.getSession("sess-001")!.state).toBe("closed");
    });

    it("should throw for invalid transition detected -> managed", () => {
      registry.register(makeSessionInfo());
      expect(() => registry.updateState("sess-001", "managed")).toThrow(
        /Invalid.*transition/,
      );
    });

    it("should throw for invalid transition detected -> resumed", () => {
      registry.register(makeSessionInfo());
      expect(() => registry.updateState("sess-001", "resumed")).toThrow(
        /Invalid.*transition/,
      );
    });

    it("should throw for transition from closed", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "closed");
      expect(() => registry.updateState("sess-001", "observed")).toThrow(
        /Invalid.*transition/,
      );
    });

    it("should throw for unknown session", () => {
      expect(() => registry.updateState("unknown", "observed")).toThrow(
        /not found/,
      );
    });

    it("should emit state change event on transition", () => {
      const events: any[] = [];
      eventBus.subscribe(null, (e) => events.push(e));

      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");

      // Registration emits SessionDetected, state change emits SessionStateChanged
      const stateEvents = events.filter(
        (e) => e.event_type === "SessionStateChanged",
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].data.fromState).toBe("detected");
      expect(stateEvents[0].data.toState).toBe("observed");
    });
  });

  describe("removeSession", () => {
    it("should remove a session from the registry", () => {
      registry.register(makeSessionInfo());
      registry.removeSession("sess-001");
      expect(registry.getSession("sess-001")).toBeUndefined();
    });

    it("should not throw when removing a non-existent session", () => {
      expect(() => registry.removeSession("nope")).not.toThrow();
    });

    it("should reduce session count after removal", () => {
      registry.register(makeSessionInfo({ sessionId: "s1" }));
      registry.register(makeSessionInfo({ sessionId: "s2" }));
      expect(registry.listSessions()).toHaveLength(2);
      registry.removeSession("s1");
      expect(registry.listSessions()).toHaveLength(1);
    });
  });

  describe("full lifecycle", () => {
    it("should support complete detected -> observed -> managed -> closed flow", () => {
      registry.register(makeSessionInfo());
      expect(registry.getSession("sess-001")!.state).toBe("detected");

      registry.updateState("sess-001", "observed");
      expect(registry.getSession("sess-001")!.state).toBe("observed");

      registry.updateState("sess-001", "managed");
      expect(registry.getSession("sess-001")!.state).toBe("managed");

      registry.updateState("sess-001", "closed");
      expect(registry.getSession("sess-001")!.state).toBe("closed");
    });

    it("should support complete detected -> observed -> resumed -> closed flow", () => {
      registry.register(makeSessionInfo());
      registry.updateState("sess-001", "observed");
      registry.updateState("sess-001", "resumed");
      registry.updateState("sess-001", "closed");
      expect(registry.getSession("sess-001")!.state).toBe("closed");
    });
  });
});
