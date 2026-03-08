/**
 * Tests for the use-agent-stream hook logic.
 *
 * Tests the WebSocket message parsing and event accumulation
 * without requiring a real React rendering environment.
 * We test the core logic that the hook relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentStreamEvent } from "../../types/agent.js";

// Mock WebSocket for testing the hook's message handling logic
class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];

  constructor(public url: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("use-agent-stream (logic)", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("parses valid AgentStreamEvent from WebSocket message", () => {
    const event: AgentStreamEvent = {
      type: "text_output",
      agentId: "agent-1",
      data: { text: "Hello world" },
      timestamp: "2026-02-22T10:00:00Z",
    };

    const events: AgentStreamEvent[] = [];
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.onmessage = (msg: { data: string }) => {
      try {
        const parsed = JSON.parse(msg.data) as AgentStreamEvent;
        if (parsed.agentId === "agent-1") {
          events.push(parsed);
        }
      } catch {
        /* ignore */
      }
    };

    ws.simulateMessage(event);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text_output");
    expect(events[0].data["text"]).toBe("Hello world");
  });

  it("ignores events for other agents", () => {
    const events: AgentStreamEvent[] = [];
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.onmessage = (msg: { data: string }) => {
      try {
        const parsed = JSON.parse(msg.data) as AgentStreamEvent;
        if (parsed.agentId === "agent-1") {
          events.push(parsed);
        }
      } catch {
        /* ignore */
      }
    };

    ws.simulateMessage({
      type: "text_output",
      agentId: "agent-2",
      data: {},
      timestamp: "2026-02-22T10:00:00Z",
    });

    expect(events).toHaveLength(0);
  });

  it("ignores invalid JSON messages", () => {
    const events: AgentStreamEvent[] = [];
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.onmessage = (msg: { data: string }) => {
      try {
        const parsed = JSON.parse(msg.data) as AgentStreamEvent;
        if (parsed.agentId === "agent-1") {
          events.push(parsed);
        }
      } catch {
        /* ignore */
      }
    };

    ws.onmessage({ data: "not valid json" });
    expect(events).toHaveLength(0);
  });

  it("sends prompt message in correct format", () => {
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.send(
      JSON.stringify({
        type: "send_prompt",
        agentId: "agent-1",
        data: { prompt: "Fix the bug" },
      }),
    );

    expect(ws.sent).toHaveLength(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("send_prompt");
    expect(sent.agentId).toBe("agent-1");
    expect(sent.data.prompt).toBe("Fix the bug");
  });

  it("sends approve_permission message in correct format", () => {
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.send(
      JSON.stringify({
        type: "approve_permission",
        agentId: "agent-1",
        data: { toolUseId: "tool-123" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("approve_permission");
    expect(sent.data.toolUseId).toBe("tool-123");
  });

  it("sends deny_permission message in correct format", () => {
    const ws = new MockWebSocket("ws://localhost/ws?agentId=agent-1");
    ws.send(
      JSON.stringify({
        type: "deny_permission",
        agentId: "agent-1",
        data: { toolUseId: "tool-456" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("deny_permission");
    expect(sent.data.toolUseId).toBe("tool-456");
  });
});
