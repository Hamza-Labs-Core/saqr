/**
 * Integration tests verifying cross-package type compatibility and event flow.
 *
 * These tests exercise the boundaries between @saqr/shared types and the
 * daemon's EventBus, SearchIndex, EventStore, and UsageProjection, ensuring
 * that the shared event envelope format flows correctly through all daemon
 * subsystems.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// -- @saqr/shared imports --
import {
  UNIFIED_EVENT_TYPES,
  isUnifiedEventType,
  createUnifiedEvent,
} from "@saqr/shared";
import type {
  UnifiedEventType,
  UnifiedEvent,
} from "@saqr/shared";

// -- daemon imports --
import { EventBus } from "../event-bus/event-bus.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";
import { SearchIndex } from "../store/search-index.js";
import { EventStore } from "../store/event-store.js";
import { UsageProjection, estimateCost } from "../store/usage-projection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Zero-pad a sequence number to 6 digits for event file naming.
 */
function padSequence(seq: number): string {
  return String(seq).padStart(6, "0");
}

/**
 * Build a daemon-compatible EventEnvelope from a shared UnifiedEvent.
 *
 * The daemon's EventBus uses its own EventEnvelope interface which is
 * structurally compatible with (but not nominally the same as) the shared
 * UnifiedEvent. This helper demonstrates that compatibility.
 */
function unifiedToDaemonEnvelope(event: UnifiedEvent): EventEnvelope {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    project_id: event.project_id,
    session_id: event.session_id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    agent_provider: event.agent_provider,
    agent_native_event: event.agent_native_event,
    agent_metadata: event.agent_metadata as Record<string, unknown>,
    data: event.data,
  };
}

/**
 * Create a shared UnifiedEvent for a given event type with sensible defaults.
 */
function makeSharedEvent(
  eventType: UnifiedEventType,
  overrides: Partial<{
    project_id: string;
    session_id: string;
    sequence: number;
    data: Record<string, unknown>;
    agent_provider: "claude-code" | "opencode" | "codex" | "custom";
    agent_native_event: string;
    agent_metadata: { agent_version?: string; model?: string; agent_pid?: number; cwd?: string };
  }> = {},
): UnifiedEvent {
  return createUnifiedEvent({
    event_type: eventType,
    project_id: overrides.project_id ?? "test-proj-abc123",
    session_id: overrides.session_id ?? "sess-int-001",
    sequence: overrides.sequence ?? 1,
    agent_provider: overrides.agent_provider ?? "claude-code",
    agent_native_event: overrides.agent_native_event ?? eventType,
    agent_metadata: overrides.agent_metadata ?? { model: "claude-opus-4-6" },
    data: overrides.data ?? {},
  });
}

/**
 * Create a daemon EventEnvelope from a shared event type with defaults.
 */
function makeDaemonEnvelope(
  eventType: UnifiedEventType,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  const shared = makeSharedEvent(eventType);
  return { ...unifiedToDaemonEnvelope(shared), ...overrides };
}

/**
 * Write an EventEnvelope to disk in the EventStore file layout.
 */
async function writeEventToDisk(
  eventsDir: string,
  projectId: string,
  sessionId: string,
  event: EventEnvelope,
): Promise<void> {
  const sessionDir = path.join(eventsDir, projectId, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const filename = `${padSequence(event.sequence)}.json`;
  await writeFile(path.join(sessionDir, filename), JSON.stringify(event));
}

// ===========================================================================
// 1. Shared Types -> Daemon EventBus
// ===========================================================================

describe("Integration: Shared Types -> Daemon EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("should accept events created with shared createUnifiedEvent", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(null, (event) => received.push(event));

    const sharedEvent = makeSharedEvent("SessionStarted", {
      data: { session_id: "sess-int-001", cwd: "/home/user/project", model: "claude-opus-4-6" },
    });
    const envelope = unifiedToDaemonEnvelope(sharedEvent);
    bus.publish(envelope);

    expect(received).toHaveLength(1);
    expect(received[0].event_id).toBe(sharedEvent.event_id);
    expect(received[0].event_type).toBe("SessionStarted");
    expect(received[0].data.cwd).toBe("/home/user/project");
  });

  it("should publish all 12 shared event types and subscribers receive them", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe(null, (event) => received.push(event));

    for (let i = 0; i < UNIFIED_EVENT_TYPES.length; i++) {
      const eventType = UNIFIED_EVENT_TYPES[i];
      const sharedEvent = makeSharedEvent(eventType, { sequence: i + 1 });
      bus.publish(unifiedToDaemonEnvelope(sharedEvent));
    }

    expect(received).toHaveLength(12);
    const receivedTypes = received.map((e) => e.event_type);
    for (const expectedType of UNIFIED_EVENT_TYPES) {
      expect(receivedTypes).toContain(expectedType);
    }
  });

  it("should filter by shared event type constants", () => {
    const toolEvents: EventEnvelope[] = [];
    bus.subscribe(
      { eventTypes: ["ToolCallRequested", "ToolCallCompleted", "ToolCallFailed"] },
      (event) => toolEvents.push(event),
    );

    // Publish a mix of event types
    const typesToPublish: UnifiedEventType[] = [
      "SessionStarted",
      "UserPromptReceived",
      "ToolCallRequested",
      "ToolCallCompleted",
      "ToolCallFailed",
      "TurnCompleted",
      "SessionEnded",
    ];

    for (let i = 0; i < typesToPublish.length; i++) {
      const event = makeSharedEvent(typesToPublish[i], { sequence: i + 1 });
      bus.publish(unifiedToDaemonEnvelope(event));
    }

    expect(toolEvents).toHaveLength(3);
    expect(toolEvents.map((e) => e.event_type).sort()).toEqual([
      "ToolCallCompleted",
      "ToolCallFailed",
      "ToolCallRequested",
    ]);
  });

  it("should filter by project using shared event project_id", () => {
    const projectAEvents: EventEnvelope[] = [];
    bus.subscribeProject("proj-alpha-aaa111", (event) => projectAEvents.push(event));

    const eventA = makeSharedEvent("UserPromptReceived", {
      project_id: "proj-alpha-aaa111",
      data: { session_id: "s1", prompt: "hello" },
    });
    const eventB = makeSharedEvent("UserPromptReceived", {
      project_id: "proj-beta-bbb222",
      sequence: 2,
      data: { session_id: "s2", prompt: "world" },
    });

    bus.publish(unifiedToDaemonEnvelope(eventA));
    bus.publish(unifiedToDaemonEnvelope(eventB));

    expect(projectAEvents).toHaveLength(1);
    expect(projectAEvents[0].project_id).toBe("proj-alpha-aaa111");
  });

  it("should filter by session using shared event session_id", () => {
    const sessionEvents: EventEnvelope[] = [];
    bus.subscribeSession("sess-target", (event) => sessionEvents.push(event));

    const eventTarget = makeSharedEvent("ToolCallCompleted", {
      session_id: "sess-target",
      data: { session_id: "sess-target", tool_name: "Read", tool_input: {}, tool_response: "ok" },
    });
    const eventOther = makeSharedEvent("ToolCallCompleted", {
      session_id: "sess-other",
      sequence: 2,
      data: { session_id: "sess-other", tool_name: "Edit", tool_input: {}, tool_response: "ok" },
    });

    bus.publish(unifiedToDaemonEnvelope(eventTarget));
    bus.publish(unifiedToDaemonEnvelope(eventOther));

    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].session_id).toBe("sess-target");
  });

  it("should validate that shared UNIFIED_EVENT_TYPES has exactly 12 types", () => {
    expect(UNIFIED_EVENT_TYPES).toHaveLength(12);
    for (const t of UNIFIED_EVENT_TYPES) {
      expect(isUnifiedEventType(t)).toBe(true);
    }
  });

  it("should preserve agent_provider from shared event through the bus", () => {
    const received: EventEnvelope[] = [];
    bus.subscribe({ agentProvider: "opencode" }, (event) => received.push(event));

    const sharedEvent = makeSharedEvent("SessionStarted", {
      agent_provider: "opencode",
      data: { session_id: "s1" },
    });
    bus.publish(unifiedToDaemonEnvelope(sharedEvent));

    const sharedEventCC = makeSharedEvent("SessionStarted", {
      agent_provider: "claude-code",
      sequence: 2,
      data: { session_id: "s2" },
    });
    bus.publish(unifiedToDaemonEnvelope(sharedEventCC));

    expect(received).toHaveLength(1);
    expect(received[0].agent_provider).toBe("opencode");
  });
});

// ===========================================================================
// 2. Shared Types -> Daemon SearchIndex
// ===========================================================================

describe("Integration: Shared Types -> Daemon SearchIndex", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  it("should index a UserPromptReceived event and find by keyword", async () => {
    const event = makeSharedEvent("UserPromptReceived", {
      data: { session_id: "s1", prompt: "Refactor the database connection pooling logic" },
    });

    index.indexEvent(
      event.event_id,
      event.project_id,
      event.session_id,
      event.sequence,
      event.event_type,
      event.timestamp,
      event.data,
    );

    const results = await index.search({ text: "database connection" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].eventType).toBe("UserPromptReceived");
    expect(results[0].matchField).toBe("prompt");
  });

  it("should index ToolCallCompleted with tool_name and tool_response", async () => {
    const event = makeSharedEvent("ToolCallCompleted", {
      data: {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: "All 42 tests passed successfully",
      },
    });

    index.indexEvent(
      event.event_id,
      event.project_id,
      event.session_id,
      event.sequence,
      event.event_type,
      event.timestamp,
      event.data,
    );

    const byToolName = await index.search({ text: "Bash" });
    expect(byToolName.length).toBeGreaterThanOrEqual(1);
    expect(byToolName[0].eventType).toBe("ToolCallCompleted");

    const byResponse = await index.search({ text: "passed successfully" });
    expect(byResponse.length).toBeGreaterThanOrEqual(1);
  });

  it("should index ToolCallRequested with file_path components", async () => {
    const event = makeSharedEvent("ToolCallRequested", {
      data: {
        session_id: "s1",
        tool_name: "Read",
        tool_input: { file_path: "/home/user/project/src/auth/handler.ts" },
      },
    });

    index.indexEvent(
      event.event_id,
      event.project_id,
      event.session_id,
      event.sequence,
      event.event_type,
      event.timestamp,
      event.data,
    );

    const results = await index.search({ text: "handler.ts" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].eventType).toBe("ToolCallRequested");
  });

  it("should index ToolCallFailed with error message", async () => {
    const event = makeSharedEvent("ToolCallFailed", {
      data: {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "cargo build" },
        error: "compilation failed: missing lifetime specifier",
      },
    });

    index.indexEvent(
      event.event_id,
      event.project_id,
      event.session_id,
      event.sequence,
      event.event_type,
      event.timestamp,
      event.data,
    );

    const results = await index.search({ text: "compilation lifetime" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].eventType).toBe("ToolCallFailed");
  });

  it("should index SessionStarted with cwd and model", async () => {
    const event = makeSharedEvent("SessionStarted", {
      data: {
        session_id: "s1",
        cwd: "/home/developer/saqr-monorepo",
        model: "claude-opus-4-6",
      },
    });

    index.indexEvent(
      event.event_id,
      event.project_id,
      event.session_id,
      event.sequence,
      event.event_type,
      event.timestamp,
      event.data,
    );

    const results = await index.search({ text: "saqr-monorepo" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].eventType).toBe("SessionStarted");
    expect(results[0].matchField).toBe("cwd");
  });

  it("should index and search all 12 event types", async () => {
    // Build searchable data for each event type so that at least
    // the types with extractSearchableFields coverage can be found.
    const dataByType: Record<string, Record<string, unknown>> = {
      SessionStarted: { session_id: "s1", cwd: "/workspace/alphaproject", model: "opus" },
      UserPromptReceived: { session_id: "s1", prompt: "Implement betafeature pagination" },
      ToolCallRequested: { session_id: "s1", tool_name: "gammatool", tool_input: {} },
      ToolCallCompleted: { session_id: "s1", tool_name: "deltatool", tool_input: {}, tool_response: "deltaresult" },
      ToolCallFailed: { session_id: "s1", tool_name: "epsilontool", tool_input: {}, error: "epsilonerror" },
      AgentSpawned: { session_id: "s1", subagent_id: "sub1", task: "zetawork" },
      AgentCompleted: { session_id: "s1", subagent_id: "sub1", result: "etaresult" },
      TurnCompleted: { session_id: "s1", input_tokens: 100 },
      CompactionTriggered: { session_id: "s1", summary: "thetasummary" },
      SessionEnded: { session_id: "s1", reason: "iotacomplete" },
      PermissionRequested: { session_id: "s1", permission_id: "p1", tool_name: "kappatool", tool_input: {} },
      PermissionResponded: { session_id: "s1", permission_id: "p1", granted: true },
    };

    for (let i = 0; i < UNIFIED_EVENT_TYPES.length; i++) {
      const eventType = UNIFIED_EVENT_TYPES[i];
      const event = makeSharedEvent(eventType, {
        sequence: i + 1,
        data: dataByType[eventType] ?? {},
      });
      index.indexEvent(
        event.event_id,
        event.project_id,
        event.session_id,
        event.sequence,
        event.event_type,
        event.timestamp,
        event.data,
      );
    }

    const stats = index.getStats();
    expect(stats.documentCount).toBe(12);

    // Verify we can search for events that have indexable fields
    const promptHit = await index.search({ text: "betafeature" });
    expect(promptHit.length).toBeGreaterThanOrEqual(1);
    expect(promptHit[0].eventType).toBe("UserPromptReceived");

    const toolHit = await index.search({ text: "gammatool" });
    expect(toolHit.length).toBeGreaterThanOrEqual(1);
    expect(toolHit[0].eventType).toBe("ToolCallRequested");

    const errorHit = await index.search({ text: "epsilonerror" });
    expect(errorHit.length).toBeGreaterThanOrEqual(1);
    expect(errorHit[0].eventType).toBe("ToolCallFailed");
  });

  it("should filter search results by shared event type constants", async () => {
    // Index two different event types with overlapping text
    const promptEvent = makeSharedEvent("UserPromptReceived", {
      sequence: 1,
      data: { session_id: "s1", prompt: "Fix the serverauth module" },
    });
    const toolEvent = makeSharedEvent("ToolCallCompleted", {
      sequence: 2,
      data: {
        session_id: "s1",
        tool_name: "serverauth",
        tool_input: {},
        tool_response: "done",
      },
    });

    index.indexEvent(
      promptEvent.event_id, promptEvent.project_id, promptEvent.session_id,
      promptEvent.sequence, promptEvent.event_type, promptEvent.timestamp, promptEvent.data,
    );
    index.indexEvent(
      toolEvent.event_id, toolEvent.project_id, toolEvent.session_id,
      toolEvent.sequence, toolEvent.event_type, toolEvent.timestamp, toolEvent.data,
    );

    // Without type filter, should find both
    const all = await index.search({ text: "serverauth" });
    expect(all.length).toBe(2);

    // With type filter, should find only the prompt event
    const promptOnly = await index.search({
      text: "serverauth",
      eventTypes: ["UserPromptReceived"],
    });
    expect(promptOnly.length).toBe(1);
    expect(promptOnly[0].eventType).toBe("UserPromptReceived");

    // With type filter for ToolCallCompleted only
    const toolOnly = await index.search({
      text: "serverauth",
      eventTypes: ["ToolCallCompleted"],
    });
    expect(toolOnly.length).toBe(1);
    expect(toolOnly[0].eventType).toBe("ToolCallCompleted");
  });
});

// ===========================================================================
// 3. Shared Types -> Daemon EventStore
// ===========================================================================

describe("Integration: Shared Types -> Daemon EventStore", () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-integ-eventstore-"));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write shared-format events to disk and query them back", async () => {
    const projectId = "integ-proj-abc123";
    const sessionId = "integ-sess-001";

    const events: UnifiedEvent[] = [
      makeSharedEvent("SessionStarted", {
        project_id: projectId,
        session_id: sessionId,
        sequence: 1,
        data: { session_id: sessionId, cwd: "/workspace", model: "claude-opus-4-6" },
      }),
      makeSharedEvent("UserPromptReceived", {
        project_id: projectId,
        session_id: sessionId,
        sequence: 2,
        data: { session_id: sessionId, prompt: "Add logging to the API" },
      }),
      makeSharedEvent("ToolCallCompleted", {
        project_id: projectId,
        session_id: sessionId,
        sequence: 3,
        data: { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: "api.ts" }, tool_response: "done" },
      }),
      makeSharedEvent("TurnCompleted", {
        project_id: projectId,
        session_id: sessionId,
        sequence: 4,
        data: { session_id: sessionId, input_tokens: 5000, output_tokens: 2000 },
      }),
      makeSharedEvent("SessionEnded", {
        project_id: projectId,
        session_id: sessionId,
        sequence: 5,
        data: { session_id: sessionId, reason: "user_exit" },
      }),
    ];

    // Write events to disk in daemon's EventEnvelope format
    for (const event of events) {
      const envelope = unifiedToDaemonEnvelope(event);
      await writeEventToDisk(tmpDir, projectId, sessionId, envelope);
    }

    // Query them back
    const results = await store.queryEvents({ projectId, sessionId });
    expect(results).toHaveLength(5);
    expect(results.map((e) => e.event_type)).toEqual([
      "SessionStarted",
      "UserPromptReceived",
      "ToolCallCompleted",
      "TurnCompleted",
      "SessionEnded",
    ]);

    // Verify shared fields are preserved
    expect(results[0].agent_provider).toBe("claude-code");
    expect(results[0].data.cwd).toBe("/workspace");
    expect(results[1].data.prompt).toBe("Add logging to the API");
    expect(results[2].data.tool_name).toBe("Edit");
  });

  it("should filter by event_type using shared type constants", async () => {
    const projectId = "integ-proj-abc123";
    const sessionId = "integ-sess-002";

    const typesToWrite: UnifiedEventType[] = [
      "SessionStarted",
      "UserPromptReceived",
      "ToolCallRequested",
      "ToolCallCompleted",
      "ToolCallFailed",
      "TurnCompleted",
      "SessionEnded",
    ];

    for (let i = 0; i < typesToWrite.length; i++) {
      const event = makeSharedEvent(typesToWrite[i], {
        project_id: projectId,
        session_id: sessionId,
        sequence: i + 1,
        data: { session_id: sessionId },
      });
      await writeEventToDisk(tmpDir, projectId, sessionId, unifiedToDaemonEnvelope(event));
    }

    // Filter for tool-related events
    const toolEvents = await store.queryEvents({
      projectId,
      sessionId,
      eventTypes: ["ToolCallRequested", "ToolCallCompleted", "ToolCallFailed"],
    });
    expect(toolEvents).toHaveLength(3);
    for (const e of toolEvents) {
      expect(["ToolCallRequested", "ToolCallCompleted", "ToolCallFailed"]).toContain(e.event_type);
    }

    // Filter for session lifecycle events
    const lifecycleEvents = await store.queryEvents({
      projectId,
      sessionId,
      eventTypes: ["SessionStarted", "SessionEnded"],
    });
    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents[0].event_type).toBe("SessionStarted");
    expect(lifecycleEvents[1].event_type).toBe("SessionEnded");
  });

  it("should preserve shared event_id across write and read", async () => {
    const projectId = "integ-proj-abc123";
    const sessionId = "integ-sess-003";

    const sharedEvent = makeSharedEvent("AgentSpawned", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 1,
      data: { session_id: sessionId, subagent_id: "sub-123", task: "refactor auth" },
    });
    const originalId = sharedEvent.event_id;

    await writeEventToDisk(tmpDir, projectId, sessionId, unifiedToDaemonEnvelope(sharedEvent));

    const retrieved = await store.getEvent(projectId, sessionId, 1);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.event_id).toBe(originalId);
    expect(retrieved!.event_type).toBe("AgentSpawned");
    expect(retrieved!.data.subagent_id).toBe("sub-123");
  });

  it("should write all 12 shared event types and read them back", async () => {
    const projectId = "integ-proj-all12";
    const sessionId = "integ-sess-all";

    for (let i = 0; i < UNIFIED_EVENT_TYPES.length; i++) {
      const eventType = UNIFIED_EVENT_TYPES[i];
      const event = makeSharedEvent(eventType, {
        project_id: projectId,
        session_id: sessionId,
        sequence: i + 1,
        data: { session_id: sessionId },
      });
      await writeEventToDisk(tmpDir, projectId, sessionId, unifiedToDaemonEnvelope(event));
    }

    const allResults = await store.queryEvents({ projectId, sessionId });
    expect(allResults).toHaveLength(12);

    const readTypes = allResults.map((e) => e.event_type);
    for (const expectedType of UNIFIED_EVENT_TYPES) {
      expect(readTypes).toContain(expectedType);
    }
  });

  it("should support afterSequence with shared-format events", async () => {
    const projectId = "integ-proj-abc123";
    const sessionId = "integ-sess-004";

    for (let i = 0; i < 5; i++) {
      const event = makeSharedEvent(UNIFIED_EVENT_TYPES[i], {
        project_id: projectId,
        session_id: sessionId,
        sequence: i + 1,
        data: { session_id: sessionId },
      });
      await writeEventToDisk(tmpDir, projectId, sessionId, unifiedToDaemonEnvelope(event));
    }

    const after3 = await store.queryEvents({
      projectId,
      sessionId,
      afterSequence: 3,
    });
    expect(after3).toHaveLength(2);
    expect(after3[0].sequence).toBe(4);
    expect(after3[1].sequence).toBe(5);
  });

  it("should filter by agent_provider from shared events on disk", async () => {
    const projectId = "integ-proj-multi";
    const sessionCC = "sess-cc";
    const sessionOC = "sess-oc";

    const eventCC = makeSharedEvent("SessionStarted", {
      project_id: projectId,
      session_id: sessionCC,
      agent_provider: "claude-code",
      data: { session_id: sessionCC },
    });
    const eventOC = makeSharedEvent("SessionStarted", {
      project_id: projectId,
      session_id: sessionOC,
      agent_provider: "opencode",
      data: { session_id: sessionOC },
    });

    await writeEventToDisk(tmpDir, projectId, sessionCC, unifiedToDaemonEnvelope(eventCC));
    await writeEventToDisk(tmpDir, projectId, sessionOC, unifiedToDaemonEnvelope(eventOC));

    const ccOnly = await store.queryEvents({
      projectId,
      agentProvider: "claude-code",
    });
    expect(ccOnly).toHaveLength(1);
    expect(ccOnly[0].agent_provider).toBe("claude-code");
  });
});

// ===========================================================================
// 4. EventBus -> SearchIndex Pipeline
// ===========================================================================

describe("Integration: EventBus -> SearchIndex Pipeline", () => {
  let bus: EventBus;
  let index: SearchIndex;

  beforeEach(() => {
    bus = new EventBus();
    index = new SearchIndex();
  });

  it("should wire EventBus subscriber to feed SearchIndex and search results", async () => {
    // Wire the pipeline: EventBus -> subscriber -> SearchIndex.indexEvent
    bus.subscribe(null, (event) => {
      index.indexEvent(
        event.event_id,
        event.project_id,
        event.session_id,
        event.sequence,
        event.event_type,
        event.timestamp,
        event.data,
      );
    });

    // Publish a prompt event through the bus
    const promptEvent = makeSharedEvent("UserPromptReceived", {
      sequence: 1,
      data: { session_id: "s1", prompt: "Implement graphql resolver for user queries" },
    });
    bus.publish(unifiedToDaemonEnvelope(promptEvent));

    // Search should find it
    const results = await index.search({ text: "graphql resolver" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].eventId).toBe(promptEvent.event_id);
    expect(results[0].eventType).toBe("UserPromptReceived");
  });

  it("should handle a full session lifecycle through the pipeline", async () => {
    // Wire the pipeline
    bus.subscribe(null, (event) => {
      index.indexEvent(
        event.event_id,
        event.project_id,
        event.session_id,
        event.sequence,
        event.event_type,
        event.timestamp,
        event.data,
      );
    });

    const projectId = "pipeline-proj";
    const sessionId = "pipeline-sess";

    // Simulate a full session
    const sessionEvents: Array<{ type: UnifiedEventType; data: Record<string, unknown> }> = [
      { type: "SessionStarted", data: { session_id: sessionId, cwd: "/workspace/myapp", model: "claude-opus-4-6" } },
      { type: "UserPromptReceived", data: { session_id: sessionId, prompt: "Add validation middleware" } },
      { type: "ToolCallRequested", data: { session_id: sessionId, tool_name: "Read", tool_input: { file_path: "/workspace/myapp/middleware.ts" } } },
      { type: "ToolCallCompleted", data: { session_id: sessionId, tool_name: "Read", tool_input: { file_path: "/workspace/myapp/middleware.ts" }, tool_response: "export function validate() {}" } },
      { type: "ToolCallRequested", data: { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: "/workspace/myapp/middleware.ts" } } },
      { type: "ToolCallCompleted", data: { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: "/workspace/myapp/middleware.ts" }, tool_response: "edited" } },
      { type: "TurnCompleted", data: { session_id: sessionId, input_tokens: 8000, output_tokens: 3000 } },
      { type: "SessionEnded", data: { session_id: sessionId, reason: "completed" } },
    ];

    for (let i = 0; i < sessionEvents.length; i++) {
      const se = sessionEvents[i];
      const event = makeSharedEvent(se.type, {
        project_id: projectId,
        session_id: sessionId,
        sequence: i + 1,
        data: se.data,
      });
      bus.publish(unifiedToDaemonEnvelope(event));
    }

    // Verify index has all events
    const stats = index.getStats();
    expect(stats.documentCount).toBe(8);

    // Search for prompt text
    const promptResults = await index.search({ text: "validation middleware" });
    expect(promptResults.length).toBeGreaterThanOrEqual(1);

    // Search for tool name
    const toolResults = await index.search({ text: "Edit" });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // Search for file path
    const fileResults = await index.search({ text: "middleware.ts" });
    expect(fileResults.length).toBeGreaterThanOrEqual(1);

    // Filter search by event type
    const readOnlyTool = await index.search({
      text: "Read",
      eventTypes: ["ToolCallRequested"],
    });
    expect(readOnlyTool.length).toBeGreaterThanOrEqual(1);
    expect(readOnlyTool[0].eventType).toBe("ToolCallRequested");
  });

  it("should support multiple filtered subscribers feeding the same SearchIndex", async () => {
    // One subscriber for prompts, one for tool events
    bus.subscribe({ eventTypes: ["UserPromptReceived"] }, (event) => {
      index.indexEvent(
        event.event_id, event.project_id, event.session_id,
        event.sequence, event.event_type, event.timestamp, event.data,
      );
    });

    bus.subscribe(
      { eventTypes: ["ToolCallCompleted", "ToolCallFailed"] },
      (event) => {
        index.indexEvent(
          event.event_id, event.project_id, event.session_id,
          event.sequence, event.event_type, event.timestamp, event.data,
        );
      },
    );

    // Publish events -- SessionStarted should NOT be indexed
    bus.publish(unifiedToDaemonEnvelope(makeSharedEvent("SessionStarted", {
      sequence: 1,
      data: { session_id: "s1", cwd: "/workspace/skipme" },
    })));

    bus.publish(unifiedToDaemonEnvelope(makeSharedEvent("UserPromptReceived", {
      sequence: 2,
      data: { session_id: "s1", prompt: "Deploy kubernetes manifests" },
    })));

    bus.publish(unifiedToDaemonEnvelope(makeSharedEvent("ToolCallCompleted", {
      sequence: 3,
      data: { session_id: "s1", tool_name: "Bash", tool_input: { command: "kubectl apply" }, tool_response: "deployed" },
    })));

    // The SessionStarted was published but no subscriber was wired for it
    expect(index.getStats().documentCount).toBe(2);

    // Both indexed events should be searchable
    const promptHit = await index.search({ text: "kubernetes" });
    expect(promptHit.length).toBeGreaterThanOrEqual(1);

    const toolHit = await index.search({ text: "kubectl" });
    expect(toolHit.length).toBeGreaterThanOrEqual(1);
  });

  it("should incrementally index events as they are published", async () => {
    bus.subscribe(null, (event) => {
      index.indexEvent(
        event.event_id, event.project_id, event.session_id,
        event.sequence, event.event_type, event.timestamp, event.data,
      );
    });

    // Verify empty index
    expect(index.getStats().documentCount).toBe(0);

    // Publish first event
    bus.publish(unifiedToDaemonEnvelope(makeSharedEvent("UserPromptReceived", {
      sequence: 1,
      data: { session_id: "s1", prompt: "First incremental query" },
    })));
    expect(index.getStats().documentCount).toBe(1);

    // Publish second event
    bus.publish(unifiedToDaemonEnvelope(makeSharedEvent("UserPromptReceived", {
      sequence: 2,
      data: { session_id: "s1", prompt: "Second incremental query" },
    })));
    expect(index.getStats().documentCount).toBe(2);

    // Search should find both
    const results = await index.search({ text: "incremental" });
    expect(results).toHaveLength(2);
  });
});

// ===========================================================================
// 5. Shared Types -> Daemon UsageProjection
// ===========================================================================

describe("Integration: Shared Types -> Daemon UsageProjection", () => {
  let projection: UsageProjection;

  beforeEach(() => {
    projection = new UsageProjection();
  });

  it("should process a full session lifecycle from shared event types", () => {
    const projectId = "usage-proj-abc123";
    const sessionId = "usage-sess-001";

    // SessionStarted
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 1,
      timestamp: "2026-02-23T09:00:00.000Z",
      agent_metadata: { model: "claude-opus-4-6" },
      data: { model: "claude-opus-4-6", session_id: sessionId, cwd: "/workspace" },
    }));

    // UserPromptReceived
    projection.processEvent(makeDaemonEnvelope("UserPromptReceived", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 2,
      timestamp: "2026-02-23T09:00:01.000Z",
      data: { session_id: sessionId, prompt: "Add rate limiting to the API endpoints" },
    }));

    // ToolCallCompleted x2
    projection.processEvent(makeDaemonEnvelope("ToolCallCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 3,
      timestamp: "2026-02-23T09:00:02.000Z",
      data: { session_id: sessionId, tool_name: "Read", tool_input: { file_path: "api.ts" }, tool_response: "..." },
    }));

    projection.processEvent(makeDaemonEnvelope("ToolCallCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 4,
      timestamp: "2026-02-23T09:00:03.000Z",
      data: { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: "api.ts" }, tool_response: "..." },
    }));

    // TurnCompleted with usage data
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 5,
      timestamp: "2026-02-23T09:00:05.000Z",
      data: {
        session_id: sessionId,
        usage: {
          input_tokens: 12000,
          output_tokens: 4500,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 1500,
        },
      },
    }));

    const usage = projection.getSessionUsage(projectId, sessionId);
    expect(usage).not.toBeNull();
    expect(usage!.model).toBe("claude-opus-4-6");
    expect(usage!.agent_provider).toBe("claude-code");
    expect(usage!.totals.input_tokens).toBe(12000);
    expect(usage!.totals.output_tokens).toBe(4500);
    expect(usage!.totals.cache_read_tokens).toBe(3000);
    expect(usage!.totals.cache_write_tokens).toBe(1500);
    expect(usage!.totals.turns).toBe(1);
    expect(usage!.totals.tool_calls).toBe(2);
    expect(usage!.totals.tool_errors).toBe(0);
    expect(usage!.totals.estimated_cost_usd).toBeGreaterThan(0);
    expect(usage!.turns[0].prompt_preview).toContain("Add rate limiting");
    expect(usage!.by_tool.Read).toEqual({ calls: 1, errors: 0 });
    expect(usage!.by_tool.Edit).toEqual({ calls: 1, errors: 0 });
  });

  it("should track ToolCallFailed from shared event types", () => {
    const projectId = "usage-proj-abc123";
    const sessionId = "usage-sess-002";

    projection.processEvent(makeDaemonEnvelope("ToolCallFailed", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 1,
      data: {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
        error: "compilation error",
      },
    }));

    const usage = projection.getSessionUsage(projectId, sessionId);
    expect(usage).not.toBeNull();
    expect(usage!.totals.tool_errors).toBe(1);
    expect(usage!.by_tool.Bash).toEqual({ calls: 0, errors: 1 });
  });

  it("should estimate cost using shared model names", () => {
    // Verify cost estimation works with models named in the shared types
    const opusCost = estimateCost(
      { input_tokens: 100000, output_tokens: 50000, cache_read_tokens: 20000, cache_write_tokens: 10000 },
      "claude-opus-4-6",
    );
    expect(opusCost).toBeGreaterThan(0);

    // Opus should be more expensive than Sonnet
    const sonnetCost = estimateCost(
      { input_tokens: 100000, output_tokens: 50000, cache_read_tokens: 20000, cache_write_tokens: 10000 },
      "claude-sonnet-4-20250514",
    );
    expect(sonnetCost).toBeGreaterThan(0);
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  it("should build daily usage projection from shared-format events", () => {
    const projectId = "usage-proj-daily";

    // Day 1, Session 1
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: "day1-sess1",
      sequence: 1,
      timestamp: "2026-02-22T09:00:00.000Z",
      agent_metadata: { model: "claude-opus-4-6" },
      data: { model: "claude-opus-4-6", session_id: "day1-sess1" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: "day1-sess1",
      sequence: 2,
      timestamp: "2026-02-22T09:05:00.000Z",
      data: { usage: { input_tokens: 5000, output_tokens: 2000 } },
    }));

    // Day 1, Session 2
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: "day1-sess2",
      sequence: 1,
      timestamp: "2026-02-22T14:00:00.000Z",
      agent_metadata: { model: "claude-sonnet-4-20250514" },
      agent_provider: "opencode",
      data: { model: "claude-sonnet-4-20250514", session_id: "day1-sess2" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: "day1-sess2",
      sequence: 2,
      timestamp: "2026-02-22T14:05:00.000Z",
      data: { usage: { input_tokens: 3000, output_tokens: 1000 } },
    }));

    // Day 2, Session 3
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: "day2-sess1",
      sequence: 1,
      timestamp: "2026-02-23T10:00:00.000Z",
      agent_metadata: { model: "claude-opus-4-6" },
      data: { model: "claude-opus-4-6", session_id: "day2-sess1" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: "day2-sess1",
      sequence: 2,
      timestamp: "2026-02-23T10:05:00.000Z",
      data: { usage: { input_tokens: 8000, output_tokens: 3000 } },
    }));

    const daily = projection.getDailyUsage(projectId);
    expect(daily.days).toHaveLength(2);

    const day1 = daily.days.find((d) => d.date === "2026-02-22");
    expect(day1).toBeDefined();
    expect(day1!.sessions).toBe(2);
    expect(day1!.input_tokens).toBe(8000);
    expect(day1!.output_tokens).toBe(3000);

    const day2 = daily.days.find((d) => d.date === "2026-02-23");
    expect(day2).toBeDefined();
    expect(day2!.sessions).toBe(1);
    expect(day2!.input_tokens).toBe(8000);
    expect(day2!.output_tokens).toBe(3000);

    expect(daily.totals.total_sessions).toBe(3);
    expect(daily.totals.days_active).toBe(2);
    expect(daily.totals.estimated_total_cost_usd).toBeGreaterThan(0);
  });

  it("should build usage-by-model projection from shared events", () => {
    const projectId = "usage-proj-bymodel";

    // Opus session
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: "opus-sess",
      sequence: 1,
      timestamp: "2026-02-23T09:00:00.000Z",
      agent_metadata: { model: "claude-opus-4-6" },
      data: { model: "claude-opus-4-6", session_id: "opus-sess" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: "opus-sess",
      sequence: 2,
      timestamp: "2026-02-23T09:05:00.000Z",
      data: { usage: { input_tokens: 10000, output_tokens: 5000 } },
    }));

    // Sonnet session
    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: "sonnet-sess",
      sequence: 1,
      timestamp: "2026-02-23T10:00:00.000Z",
      agent_metadata: { model: "claude-sonnet-4-20250514" },
      data: { model: "claude-sonnet-4-20250514", session_id: "sonnet-sess" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: "sonnet-sess",
      sequence: 2,
      timestamp: "2026-02-23T10:05:00.000Z",
      data: { usage: { input_tokens: 20000, output_tokens: 8000 } },
    }));

    const byModel = projection.getUsageByModel(projectId);
    expect(Object.keys(byModel.models)).toHaveLength(2);

    const opus = byModel.models["claude-opus-4-6"];
    expect(opus).toBeDefined();
    expect(opus.sessions).toBe(1);
    expect(opus.input_tokens).toBe(10000);
    expect(opus.output_tokens).toBe(5000);
    expect(opus.estimated_cost_usd).toBeGreaterThan(0);

    const sonnet = byModel.models["claude-sonnet-4-20250514"];
    expect(sonnet).toBeDefined();
    expect(sonnet.sessions).toBe(1);
    expect(sonnet.input_tokens).toBe(20000);
    expect(sonnet.output_tokens).toBe(8000);

    // Opus should cost more per token
    expect(opus.estimated_cost_usd / (opus.input_tokens + opus.output_tokens))
      .toBeGreaterThan(sonnet.estimated_cost_usd / (sonnet.input_tokens + sonnet.output_tokens));
  });

  it("should handle multiple turns with cumulative token tracking", () => {
    const projectId = "usage-proj-multi";
    const sessionId = "usage-sess-multi";

    projection.processEvent(makeDaemonEnvelope("SessionStarted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 1,
      timestamp: "2026-02-23T09:00:00.000Z",
      data: { model: "claude-opus-4-6", session_id: sessionId },
    }));

    // Turn 1
    projection.processEvent(makeDaemonEnvelope("UserPromptReceived", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 2,
      data: { session_id: sessionId, prompt: "First turn prompt" },
    }));
    projection.processEvent(makeDaemonEnvelope("ToolCallCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 3,
      data: { session_id: sessionId, tool_name: "Read", tool_input: {}, tool_response: "content" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 4,
      timestamp: "2026-02-23T09:01:00.000Z",
      data: { usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 } },
    }));

    // Turn 2
    projection.processEvent(makeDaemonEnvelope("UserPromptReceived", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 5,
      data: { session_id: sessionId, prompt: "Second turn prompt" },
    }));
    projection.processEvent(makeDaemonEnvelope("ToolCallCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 6,
      data: { session_id: sessionId, tool_name: "Edit", tool_input: {}, tool_response: "edited" },
    }));
    projection.processEvent(makeDaemonEnvelope("ToolCallCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 7,
      data: { session_id: sessionId, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "ok" },
    }));
    projection.processEvent(makeDaemonEnvelope("TurnCompleted", {
      project_id: projectId,
      session_id: sessionId,
      sequence: 8,
      timestamp: "2026-02-23T09:02:00.000Z",
      data: { usage: { input_tokens: 8000, output_tokens: 3000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 800 } },
    }));

    const usage = projection.getSessionUsage(projectId, sessionId);
    expect(usage).not.toBeNull();

    // Cumulative totals
    expect(usage!.totals.input_tokens).toBe(13000);
    expect(usage!.totals.output_tokens).toBe(5000);
    expect(usage!.totals.cache_read_tokens).toBe(3000);
    expect(usage!.totals.cache_write_tokens).toBe(1300);
    expect(usage!.totals.turns).toBe(2);
    expect(usage!.totals.tool_calls).toBe(3);

    // Per-turn data
    expect(usage!.turns).toHaveLength(2);
    expect(usage!.turns[0].prompt_preview).toContain("First turn");
    expect(usage!.turns[0].tool_calls).toBe(1);
    expect(usage!.turns[1].prompt_preview).toContain("Second turn");
    expect(usage!.turns[1].tool_calls).toBe(2);

    // Per-tool breakdown
    expect(usage!.by_tool.Read).toEqual({ calls: 1, errors: 0 });
    expect(usage!.by_tool.Edit).toEqual({ calls: 1, errors: 0 });
    expect(usage!.by_tool.Bash).toEqual({ calls: 1, errors: 0 });

    // Cost should reflect opus pricing
    expect(usage!.totals.estimated_cost_usd).toBeGreaterThan(0);
  });
});
