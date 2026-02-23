/**
 * Tests for the daemon event intake API.
 *
 * Covers: POST event, validate envelope, publish to event bus,
 * backward compatibility, multi-agent event tagging.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus, type EventEnvelope } from "../event-bus/event-bus.js";
import { ClaudeCodeIntegration } from "../hooks/integrations/claude-code.js";
import { OpenCodeIntegration } from "../hooks/integrations/opencode.js";
import { CodexIntegration } from "../hooks/integrations/codex.js";
import { HookManager } from "../hooks/hook-manager.js";

/**
 * Simulates the daemon event intake processing pipeline.
 * In the real daemon, this is an HTTP POST /api/events handler.
 * Here we test the core logic without the HTTP layer.
 */
function processEventIntake(
  eventBus: EventBus,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): { status: number; body: Record<string, unknown> } {
  const agentProvider = headers["x-agent-provider"] ?? (body.agent_provider as string);
  const eventType = headers["x-event-type"] ?? (body.event_type as string);

  if (!agentProvider || !eventType) {
    return { status: 400, body: { error: "Missing agent_provider or event_type" } };
  }

  // Validate event type
  const validTypes = new Set([
    "SessionStarted", "UserPromptReceived", "ToolCallRequested",
    "ToolCallCompleted", "ToolCallFailed", "AgentSpawned",
    "AgentCompleted", "TurnCompleted", "CompactionTriggered",
    "SessionEnded", "PermissionRequested", "PermissionResponded",
  ]);

  if (!validTypes.has(eventType)) {
    return { status: 400, body: { error: `Invalid event_type: ${eventType}` } };
  }

  const data = (body.data ?? body) as Record<string, unknown>;
  const sessionId = String(data.session_id ?? body.session_id ?? "unknown");

  const envelope: EventEnvelope = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    project_id: String(body.project_id ?? data.project_id ?? "unknown"),
    session_id: sessionId,
    sequence: typeof body.sequence === "number" ? body.sequence : 0,
    timestamp: new Date().toISOString(),
    agent_provider: agentProvider,
    agent_native_event: String(body.agent_native_event ?? eventType),
    agent_metadata: (body.agent_metadata as Record<string, unknown>) ?? {},
    data,
  };

  eventBus.publish(envelope);

  return { status: 202, body: { event_id: envelope.event_id } };
}

describe("Event Intake API", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  // -------------------------------------------------------------------
  // POST event, validate, publish
  // -------------------------------------------------------------------

  it("accepts a valid event and publishes to EventBus", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    const result = processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "ToolCallCompleted",
        agent_native_event: "PostToolUse",
        data: {
          session_id: "s1",
          tool_name: "Write",
          tool_input: { file_path: "/src/main.ts" },
          tool_response: "File written",
        },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "ToolCallCompleted",
      },
    );

    expect(result.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("ToolCallCompleted");
    expect(received[0].agent_provider).toBe("claude-code");
  });

  it("rejects events without agent_provider", () => {
    const result = processEventIntake(
      eventBus,
      { event_type: "SessionStarted", data: { session_id: "s1" } },
      { "x-event-type": "SessionStarted" },
    );

    expect(result.status).toBe(400);
  });

  it("rejects events without event_type", () => {
    const result = processEventIntake(
      eventBus,
      { agent_provider: "claude-code", data: { session_id: "s1" } },
      { "x-agent-provider": "claude-code" },
    );

    expect(result.status).toBe(400);
  });

  it("rejects events with invalid event_type", () => {
    const result = processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "InvalidType",
        data: { session_id: "s1" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "InvalidType",
      },
    );

    expect(result.status).toBe(400);
  });

  it("extracts session_id from body data", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "SessionStarted",
        data: { session_id: "my-session-123" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "SessionStarted",
      },
    );

    expect(received[0].session_id).toBe("my-session-123");
  });

  it("defaults session_id to 'unknown' when missing", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "SessionStarted",
        data: { model: "gpt-4o" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "SessionStarted",
      },
    );

    expect(received[0].session_id).toBe("unknown");
  });

  it("preserves agent_native_event from body", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "ToolCallCompleted",
        agent_native_event: "PostToolUse",
        data: { session_id: "s1" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "ToolCallCompleted",
      },
    );

    expect(received[0].agent_native_event).toBe("PostToolUse");
  });

  // -------------------------------------------------------------------
  // Backward Compatibility
  // -------------------------------------------------------------------

  it("events without agent_metadata get empty object", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "SessionStarted",
        data: { session_id: "s1" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "SessionStarted",
      },
    );

    expect(received[0].agent_metadata).toEqual({});
  });

  it("event envelope includes all 10 required fields", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "SessionStarted",
        data: { session_id: "s1" },
      },
      {
        "x-agent-provider": "claude-code",
        "x-event-type": "SessionStarted",
      },
    );

    const event = received[0];
    expect(event).toHaveProperty("event_id");
    expect(event).toHaveProperty("event_type");
    expect(event).toHaveProperty("project_id");
    expect(event).toHaveProperty("session_id");
    expect(event).toHaveProperty("sequence");
    expect(event).toHaveProperty("timestamp");
    expect(event).toHaveProperty("agent_provider");
    expect(event).toHaveProperty("agent_native_event");
    expect(event).toHaveProperty("agent_metadata");
    expect(event).toHaveProperty("data");
  });

  // -------------------------------------------------------------------
  // Multi-Agent Event Tagging
  // -------------------------------------------------------------------

  it("events from different agents have correct agent_provider", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "SessionStarted",
        data: { session_id: "s1" },
      },
      { "x-agent-provider": "claude-code", "x-event-type": "SessionStarted" },
    );

    processEventIntake(
      eventBus,
      {
        agent_provider: "opencode",
        event_type: "SessionStarted",
        data: { session_id: "s2" },
      },
      { "x-agent-provider": "opencode", "x-event-type": "SessionStarted" },
    );

    processEventIntake(
      eventBus,
      {
        agent_provider: "codex",
        event_type: "SessionStarted",
        data: { session_id: "s3" },
      },
      { "x-agent-provider": "codex", "x-event-type": "SessionStarted" },
    );

    expect(received).toHaveLength(3);
    expect(received[0].agent_provider).toBe("claude-code");
    expect(received[1].agent_provider).toBe("opencode");
    expect(received[2].agent_provider).toBe("codex");
  });

  it("multiple agents on same project produce distinct events", () => {
    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    processEventIntake(
      eventBus,
      {
        agent_provider: "claude-code",
        event_type: "ToolCallCompleted",
        project_id: "shared-project-abc123",
        data: { session_id: "cc-session", tool_name: "Write" },
      },
      { "x-agent-provider": "claude-code", "x-event-type": "ToolCallCompleted" },
    );

    processEventIntake(
      eventBus,
      {
        agent_provider: "opencode",
        event_type: "ToolCallCompleted",
        project_id: "shared-project-abc123",
        data: { session_id: "oc-session", tool_name: "file_edit" },
      },
      { "x-agent-provider": "opencode", "x-event-type": "ToolCallCompleted" },
    );

    expect(received).toHaveLength(2);
    expect(received[0].project_id).toBe("shared-project-abc123");
    expect(received[1].project_id).toBe("shared-project-abc123");
    expect(received[0].agent_provider).toBe("claude-code");
    expect(received[1].agent_provider).toBe("opencode");
    expect(received[0].session_id).toBe("cc-session");
    expect(received[1].session_id).toBe("oc-session");
  });
});

describe("Multi-Agent Event Flow Integration", () => {
  let eventBus: EventBus;
  let hookManager: HookManager;

  beforeEach(() => {
    eventBus = new EventBus();
    hookManager = new HookManager(eventBus);
  });

  it("routes Claude Code events through HookManager to EventBus", async () => {
    const ccIntegration = new ClaudeCodeIntegration();
    hookManager.registerIntegration(ccIntegration);

    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    await hookManager.startAll();

    // Simulate an incoming Claude Code event
    ccIntegration.handleIncomingEvent("PostToolUse", {
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: "/src/main.ts" },
    });

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("ToolCallCompleted");
    expect(received[0].agent_provider).toBe("claude-code");

    await hookManager.stopAll();
  });

  it("routes OpenCode events through HookManager to EventBus", async () => {
    const ocIntegration = new OpenCodeIntegration();
    hookManager.registerIntegration(ocIntegration);

    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    await hookManager.startAll();

    ocIntegration.handleIncomingEvent("session.created", {
      session_id: "oc-s1",
      model: "gpt-4o",
    });

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("SessionStarted");
    expect(received[0].agent_provider).toBe("opencode");

    await hookManager.stopAll();
  });

  it("routes Codex events through HookManager to EventBus", async () => {
    const cdxIntegration = new CodexIntegration();
    hookManager.registerIntegration(cdxIntegration);

    const received: EventEnvelope[] = [];
    eventBus.subscribe(null, (e) => received.push(e));

    await hookManager.startAll();

    cdxIntegration.handleIncomingEvent("tool_use", {
      session_id: "cdx-s1",
      type: "tool_use",
      name: "bash",
      input: {},
    });

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("ToolCallRequested");
    expect(received[0].agent_provider).toBe("codex");

    await hookManager.stopAll();
  });

  it("filters events by agent_provider on EventBus", async () => {
    const ccIntegration = new ClaudeCodeIntegration();
    const ocIntegration = new OpenCodeIntegration();
    hookManager.registerIntegration(ccIntegration);
    hookManager.registerIntegration(ocIntegration);

    const ccEvents: EventEnvelope[] = [];
    const ocEvents: EventEnvelope[] = [];
    eventBus.subscribe({ agentProvider: "claude-code" }, (e) => ccEvents.push(e));
    eventBus.subscribe({ agentProvider: "opencode" }, (e) => ocEvents.push(e));

    await hookManager.startAll();

    ccIntegration.handleIncomingEvent("SessionStart", { session_id: "cc-1" });
    ocIntegration.handleIncomingEvent("session.created", { session_id: "oc-1" });

    expect(ccEvents).toHaveLength(1);
    expect(ocEvents).toHaveLength(1);
    expect(ccEvents[0].agent_provider).toBe("claude-code");
    expect(ocEvents[0].agent_provider).toBe("opencode");

    await hookManager.stopAll();
  });
});
