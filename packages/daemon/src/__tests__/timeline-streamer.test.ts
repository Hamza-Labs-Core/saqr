/**
 * Tests for TimelineStreamer — streams session events to connected clients.
 *
 * Covers: client management, event conversion, backpressure, multiple clients.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TimelineStreamer,
  type TimelineItem,
  type TimelineClient,
} from "../sessions/timeline-streamer.js";
import { EventBus } from "../event-bus/event-bus.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: crypto.randomUUID(),
    event_type: "ToolCallCompleted",
    project_id: "proj-abc",
    session_id: "sess-001",
    sequence: 1,
    timestamp: new Date().toISOString(),
    agent_provider: "claude-code",
    agent_native_event: "PostToolUse",
    agent_metadata: {},
    data: { tool: "Write", path: "/foo/bar.ts" },
    ...overrides,
  };
}

describe("TimelineStreamer", () => {
  let streamer: TimelineStreamer;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    streamer = new TimelineStreamer(eventBus);
  });

  describe("client management", () => {
    it("should add a client for a session", () => {
      const items: TimelineItem[] = [];
      const clientId = streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => true,
      });
      expect(clientId).toBeDefined();
      expect(typeof clientId).toBe("string");
    });

    it("should remove a client", () => {
      const items: TimelineItem[] = [];
      const clientId = streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => true,
      });

      streamer.removeClient("sess-001", clientId);

      // Publish an event — the removed client should not receive it
      eventBus.publish(makeEvent({ session_id: "sess-001" }));
      expect(items).toHaveLength(0);
    });

    it("should return client count for a session", () => {
      const client: TimelineClient = {
        send: () => {},
        isReady: () => true,
      };
      streamer.addClient("sess-001", client);
      streamer.addClient("sess-001", client);

      expect(streamer.clientCount("sess-001")).toBe(2);
    });

    it("should return 0 for sessions with no clients", () => {
      expect(streamer.clientCount("no-such-session")).toBe(0);
    });
  });

  describe("event streaming", () => {
    it("should stream matching events to session clients", () => {
      const items: TimelineItem[] = [];
      streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => true,
      });

      eventBus.publish(makeEvent({ session_id: "sess-001", sequence: 1 }));

      expect(items).toHaveLength(1);
      expect(items[0].eventType).toBe("ToolCallCompleted");
      expect(items[0].sessionId).toBe("sess-001");
    });

    it("should not stream events from other sessions", () => {
      const items: TimelineItem[] = [];
      streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => true,
      });

      eventBus.publish(makeEvent({ session_id: "sess-002" }));
      expect(items).toHaveLength(0);
    });

    it("should stream to multiple clients for the same session", () => {
      const items1: TimelineItem[] = [];
      const items2: TimelineItem[] = [];

      streamer.addClient("sess-001", {
        send: (item) => items1.push(item),
        isReady: () => true,
      });
      streamer.addClient("sess-001", {
        send: (item) => items2.push(item),
        isReady: () => true,
      });

      eventBus.publish(makeEvent({ session_id: "sess-001" }));

      expect(items1).toHaveLength(1);
      expect(items2).toHaveLength(1);
    });

    it("should support multiple sessions independently", () => {
      const items1: TimelineItem[] = [];
      const items2: TimelineItem[] = [];

      streamer.addClient("sess-001", {
        send: (item) => items1.push(item),
        isReady: () => true,
      });
      streamer.addClient("sess-002", {
        send: (item) => items2.push(item),
        isReady: () => true,
      });

      eventBus.publish(makeEvent({ session_id: "sess-001" }));
      eventBus.publish(makeEvent({ session_id: "sess-002" }));

      expect(items1).toHaveLength(1);
      expect(items2).toHaveLength(1);
      expect(items1[0].sessionId).toBe("sess-001");
      expect(items2[0].sessionId).toBe("sess-002");
    });
  });

  describe("timeline item conversion", () => {
    it("should convert event envelope to timeline item", () => {
      const items: TimelineItem[] = [];
      streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => true,
      });

      const event = makeEvent({
        session_id: "sess-001",
        event_type: "SessionStarted",
        sequence: 1,
        data: { model: "claude-4-opus" },
      });
      eventBus.publish(event);

      expect(items[0]).toMatchObject({
        eventId: event.event_id,
        eventType: "SessionStarted",
        sessionId: "sess-001",
        sequence: 1,
        timestamp: event.timestamp,
        data: { model: "claude-4-opus" },
      });
    });
  });

  describe("backpressure handling", () => {
    it("should skip sending to clients that are not ready", () => {
      const items: TimelineItem[] = [];
      streamer.addClient("sess-001", {
        send: (item) => items.push(item),
        isReady: () => false, // client is not ready (buffer full, slow consumer)
      });

      eventBus.publish(makeEvent({ session_id: "sess-001" }));
      expect(items).toHaveLength(0);
    });

    it("should continue sending to ready clients when some are not ready", () => {
      const readyItems: TimelineItem[] = [];
      const notReadyItems: TimelineItem[] = [];

      streamer.addClient("sess-001", {
        send: (item) => readyItems.push(item),
        isReady: () => true,
      });
      streamer.addClient("sess-001", {
        send: (item) => notReadyItems.push(item),
        isReady: () => false,
      });

      eventBus.publish(makeEvent({ session_id: "sess-001" }));

      expect(readyItems).toHaveLength(1);
      expect(notReadyItems).toHaveLength(0);
    });

    it("should track dropped events count", () => {
      streamer.addClient("sess-001", {
        send: () => {},
        isReady: () => false,
      });

      eventBus.publish(makeEvent({ session_id: "sess-001" }));
      eventBus.publish(makeEvent({ session_id: "sess-001", sequence: 2 }));

      expect(streamer.droppedCount("sess-001")).toBe(2);
    });
  });

  describe("cleanup", () => {
    it("should clean up EventBus subscriptions when all clients removed", () => {
      const initialCount = eventBus.subscriberCount;

      const c1 = streamer.addClient("sess-001", {
        send: () => {},
        isReady: () => true,
      });
      const c2 = streamer.addClient("sess-001", {
        send: () => {},
        isReady: () => true,
      });

      // Adding clients should have added a subscription
      expect(eventBus.subscriberCount).toBeGreaterThan(initialCount);

      streamer.removeClient("sess-001", c1);
      streamer.removeClient("sess-001", c2);

      // All clients removed — subscription should be cleaned up
      expect(eventBus.subscriberCount).toBe(initialCount);
    });

    it("should clean up all sessions on destroy", () => {
      streamer.addClient("sess-001", { send: () => {}, isReady: () => true });
      streamer.addClient("sess-002", { send: () => {}, isReady: () => true });

      streamer.destroy();

      expect(streamer.clientCount("sess-001")).toBe(0);
      expect(streamer.clientCount("sess-002")).toBe(0);
    });
  });
});
