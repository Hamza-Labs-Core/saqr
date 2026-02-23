/**
 * Tests for the internal pub/sub EventBus.
 *
 * Covers: T-1 through T-6 from Story 04 testing plan.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus } from "../event-bus/event-bus.js";
import type { EventEnvelope, EventHandler } from "../event-bus/event-bus.js";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: crypto.randomUUID(),
    event_type: "ToolCallCompleted",
    project_id: "my-project-abc123",
    session_id: "session-001",
    sequence: 1,
    timestamp: new Date().toISOString(),
    agent_provider: "claude-code",
    agent_native_event: "PostToolUse",
    agent_metadata: {},
    data: {},
    ...overrides,
  };
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // T-1: Publish event, verify subscriber receives it
  it("should deliver published events to subscribers", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(null, (event) => received.push(event));

    const event = makeEvent();
    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].event_id).toBe(event.event_id);
  });

  // T-2: Filtered subscription only receives matching events
  it("should only deliver events matching the filter", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(
      { eventTypes: ["SessionStarted"] },
      (event) => received.push(event),
    );

    bus.publish(makeEvent({ event_type: "ToolCallCompleted" }));
    bus.publish(makeEvent({ event_type: "SessionStarted" }));
    bus.publish(makeEvent({ event_type: "TurnCompleted" }));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("SessionStarted");
  });

  // T-3: Session subscription ignores events from other sessions
  it("should filter by session ID correctly", () => {
    const received: EventEnvelope[] = [];
    bus.subscribeSession("session-001", (event) => received.push(event));

    bus.publish(makeEvent({ session_id: "session-001" }));
    bus.publish(makeEvent({ session_id: "session-002" }));
    bus.publish(makeEvent({ session_id: "session-001", sequence: 2 }));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.session_id === "session-001")).toBe(true);
  });

  it("should filter by project ID correctly", () => {
    const received: EventEnvelope[] = [];
    bus.subscribeProject("proj-a", (event) => received.push(event));

    bus.publish(makeEvent({ project_id: "proj-a" }));
    bus.publish(makeEvent({ project_id: "proj-b" }));

    expect(received).toHaveLength(1);
    expect(received[0].project_id).toBe("proj-a");
  });

  it("should support combined filters (AND logic)", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(
      { projectId: "proj-a", eventTypes: ["SessionStarted"] },
      (event) => received.push(event),
    );

    bus.publish(makeEvent({ project_id: "proj-a", event_type: "SessionStarted" }));
    bus.publish(makeEvent({ project_id: "proj-a", event_type: "TurnCompleted" }));
    bus.publish(makeEvent({ project_id: "proj-b", event_type: "SessionStarted" }));

    expect(received).toHaveLength(1);
  });

  it("should support agent provider filter", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(
      { agentProvider: "opencode" },
      (event) => received.push(event),
    );

    bus.publish(makeEvent({ agent_provider: "claude-code" }));
    bus.publish(makeEvent({ agent_provider: "opencode" }));

    expect(received).toHaveLength(1);
    expect(received[0].agent_provider).toBe("opencode");
  });

  it("should deliver events to multiple subscribers", () => {
    const received1: EventEnvelope[] = [];
    const received2: EventEnvelope[] = [];
    bus.subscribe(null, (event) => received1.push(event));
    bus.subscribe(null, (event) => received2.push(event));

    bus.publish(makeEvent());

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("should not deliver events after unsubscribe", () => {
    const received: EventEnvelope[] = [];
    const unsub = bus.subscribe(null, (event) => received.push(event));

    bus.publish(makeEvent());
    expect(received).toHaveLength(1);

    unsub();
    bus.publish(makeEvent({ sequence: 2 }));
    expect(received).toHaveLength(1);
  });

  it("should catch errors from subscribers without affecting others", () => {
    const received: EventEnvelope[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.subscribe(null, () => {
      throw new Error("subscriber boom");
    });
    bus.subscribe(null, (event) => received.push(event));

    bus.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("should track subscriber count correctly", () => {
    expect(bus.subscriberCount).toBe(0);

    const unsub1 = bus.subscribe(null, () => {});
    const unsub2 = bus.subscribe(null, () => {});
    expect(bus.subscriberCount).toBe(2);

    unsub1();
    expect(bus.subscriberCount).toBe(1);

    unsub2();
    expect(bus.subscriberCount).toBe(0);
  });

  it("should clear all subscriptions", () => {
    bus.subscribe(null, () => {});
    bus.subscribe(null, () => {});
    expect(bus.subscriberCount).toBe(2);

    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });

  it("should deliver events in order within a session", () => {
    const received: number[] = [];
    bus.subscribe(null, (event) => received.push(event.sequence));

    for (let i = 1; i <= 10; i++) {
      bus.publish(makeEvent({ sequence: i }));
    }

    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("should accept null filter to receive all events", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(null, (event) => received.push(event));

    bus.publish(makeEvent({ project_id: "proj-a", event_type: "SessionStarted" }));
    bus.publish(makeEvent({ project_id: "proj-b", event_type: "TurnCompleted", sequence: 2 }));

    expect(received).toHaveLength(2);
  });
});
