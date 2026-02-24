/**
 * Tests for the Event Feed API.
 *
 * Creates a temporary event store on disk and verifies:
 * - Project listing
 * - Session listing with metadata
 * - Event reading with pagination and filtering
 * - Event summary generation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  listProjects,
  listSessions,
  readEvents,
  generateEventSummary,
  projectName,
} from "../api/events.js";
import type { EventEnvelope } from "../api/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "evt-" + Math.random().toString(36).slice(2, 10),
    event_type: "ToolCallRequested",
    project_id: "test-project-abc123",
    session_id: "sess-001",
    sequence: 1,
    timestamp: "2025-01-15T10:30:00.000Z",
    agent_provider: "claude-code",
    agent_native_event: "tool_use",
    agent_metadata: {},
    data: { tool_name: "Read", tool_input: { file_path: "/tmp/test.txt" } },
    ...overrides,
  };
}

function padSeq(n: number): string {
  return String(n).padStart(6, "0");
}

async function writeEvent(
  eventsDir: string,
  projectId: string,
  sessionId: string,
  seq: number,
  event: EventEnvelope,
): Promise<void> {
  const dir = path.join(eventsDir, projectId, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${padSeq(seq)}.json`), JSON.stringify(event));
}

async function writeSessionMeta(
  eventsDir: string,
  projectId: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(eventsDir, projectId, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "session.json"), JSON.stringify(meta));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-dash-events-"));

  // Project 1: 2 sessions, multiple events
  const p1 = "my-project-abc123";
  const s1 = "sess-001";
  const s2 = "sess-002";

  await writeSessionMeta(tmpDir, p1, s1, {
    session_id: s1,
    project_id: p1,
    started_at: "2025-01-15T10:00:00.000Z",
    ended_at: "2025-01-15T11:00:00.000Z",
    event_count: 5,
    model: "claude-sonnet-4-20250514",
    agent_provider: "claude-code",
  });

  for (let i = 1; i <= 5; i++) {
    await writeEvent(tmpDir, p1, s1, i, makeEvent({
      sequence: i,
      event_type: i === 1 ? "SessionStarted" : i === 5 ? "SessionEnded" : "ToolCallRequested",
      timestamp: `2025-01-15T10:${String(i).padStart(2, "0")}:00.000Z`,
      data: i === 1 ? { model: "claude-sonnet-4-20250514", cwd: "/home/user/project" }
        : i === 5 ? {}
          : { tool_name: "Read", tool_input: { file_path: `/tmp/file${i}.txt` } },
    }));
  }

  await writeSessionMeta(tmpDir, p1, s2, {
    session_id: s2,
    project_id: p1,
    started_at: "2025-01-16T09:00:00.000Z",
    event_count: 2,
    agent_provider: "claude-code",
  });

  for (let i = 1; i <= 2; i++) {
    await writeEvent(tmpDir, p1, s2, i, makeEvent({
      sequence: i,
      session_id: s2,
      event_type: "UserPromptReceived",
      timestamp: `2025-01-16T09:${String(i).padStart(2, "0")}:00.000Z`,
      data: { prompt: `Hello prompt ${i}` },
    }));
  }

  // Project 2: 1 session, 1 event
  const p2 = "other-proj-def456";
  const s3 = "sess-003";

  await writeSessionMeta(tmpDir, p2, s3, {
    session_id: s3,
    project_id: p2,
    started_at: "2025-01-17T08:00:00.000Z",
    event_count: 1,
    agent_provider: "opencode",
  });

  await writeEvent(tmpDir, p2, s3, 1, makeEvent({
    sequence: 1,
    project_id: p2,
    session_id: s3,
    event_type: "ToolCallFailed",
    timestamp: "2025-01-17T08:05:00.000Z",
    data: { tool_name: "Bash", error: "command not found" },
  }));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectName", () => {
  it("strips trailing 6-char hash", () => {
    expect(projectName("my-project-abc123")).toBe("my-project");
  });

  it("handles project names without hash suffix", () => {
    expect(projectName("simple")).toBe("simple");
  });

  it("handles empty string", () => {
    expect(projectName("")).toBe("");
  });
});

describe("listProjects", () => {
  it("returns all project directories", async () => {
    const projects = await listProjects(tmpDir);
    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.project_id).sort();
    expect(names).toEqual(["my-project-abc123", "other-proj-def456"]);
  });

  it("includes session count for each project", async () => {
    const projects = await listProjects(tmpDir);
    const p1 = projects.find((p) => p.project_id === "my-project-abc123");
    expect(p1?.session_count).toBe(2);
    const p2 = projects.find((p) => p.project_id === "other-proj-def456");
    expect(p2?.session_count).toBe(1);
  });

  it("includes display name without hash", async () => {
    const projects = await listProjects(tmpDir);
    const p1 = projects.find((p) => p.project_id === "my-project-abc123");
    expect(p1?.name).toBe("my-project");
  });

  it("returns empty array for non-existent directory", async () => {
    const projects = await listProjects("/nonexistent/path");
    expect(projects).toEqual([]);
  });
});

describe("listSessions", () => {
  it("returns sessions for a project sorted by started_at desc", async () => {
    const sessions = await listSessions(tmpDir, "my-project-abc123");
    expect(sessions).toHaveLength(2);
    // Most recent first
    expect(sessions[0].session_id).toBe("sess-002");
    expect(sessions[1].session_id).toBe("sess-001");
  });

  it("includes metadata from session.json", async () => {
    const sessions = await listSessions(tmpDir, "my-project-abc123");
    const s1 = sessions.find((s) => s.session_id === "sess-001");
    expect(s1?.started_at).toBe("2025-01-15T10:00:00.000Z");
    expect(s1?.ended_at).toBe("2025-01-15T11:00:00.000Z");
    expect(s1?.event_count).toBe(5);
  });

  it("returns empty for non-existent project", async () => {
    const sessions = await listSessions(tmpDir, "nonexistent");
    expect(sessions).toEqual([]);
  });
});

describe("readEvents", () => {
  it("reads all events from a session", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
    });
    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(1);
    expect(events[4].sequence).toBe(5);
  });

  it("supports fromSequence pagination", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
      fromSequence: 3,
    });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
  });

  it("supports limit", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
      limit: 2,
    });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  it("supports event type filtering", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
      eventTypes: ["SessionStarted", "SessionEnded"],
    });
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe("SessionStarted");
    expect(events[1].event_type).toBe("SessionEnded");
  });

  it("supports timestamp filtering", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
      afterTimestamp: "2025-01-15T10:03:00.000Z",
    });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
  });

  it("includes event summaries", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "sess-001",
      limit: 1,
    });
    expect(events[0]._summary).toBeDefined();
    expect(events[0]._summary?.text).toContain("Session started");
  });

  it("returns empty for non-existent session", async () => {
    const events = await readEvents(tmpDir, {
      projectId: "my-project-abc123",
      sessionId: "nonexistent",
    });
    expect(events).toEqual([]);
  });
});

describe("generateEventSummary", () => {
  it("generates summary for SessionStarted", () => {
    const event = makeEvent({
      event_type: "SessionStarted",
      data: { model: "claude-sonnet-4-20250514", cwd: "/home/user" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("Session started");
    expect(summary.text).toContain("claude-sonnet-4-20250514");
    expect(summary.html).toContain("claude-sonnet-4-20250514");
  });

  it("generates summary for SessionEnded", () => {
    const event = makeEvent({ event_type: "SessionEnded", data: {} });
    const summary = generateEventSummary(event);
    expect(summary.text).toBe("Session ended");
  });

  it("generates summary for UserPromptReceived", () => {
    const event = makeEvent({
      event_type: "UserPromptReceived",
      data: { prompt: "Hello world" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("Hello world");
  });

  it("generates summary for ToolCallRequested", () => {
    const event = makeEvent({
      event_type: "ToolCallRequested",
      data: { tool_name: "Read" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("Read");
  });

  it("generates summary for ToolCallCompleted", () => {
    const event = makeEvent({
      event_type: "ToolCallCompleted",
      data: { tool_name: "Write" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("Write");
    expect(summary.text).toContain("completed");
  });

  it("generates summary for ToolCallFailed", () => {
    const event = makeEvent({
      event_type: "ToolCallFailed",
      data: { tool_name: "Bash", error: "Permission denied" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("FAILED");
    expect(summary.text).toContain("Permission denied");
  });

  it("generates summary for AgentSpawned", () => {
    const event = makeEvent({
      event_type: "AgentSpawned",
      data: { agent_type: "task", description: "Run tests" },
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("Spawned");
    expect(summary.text).toContain("task");
  });

  it("generates summary for CompactionTriggered", () => {
    const event = makeEvent({
      event_type: "CompactionTriggered",
      sequence: 42,
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("COMPACTION");
    expect(summary.text).toContain("42");
  });

  it("generates summary for unknown event type", () => {
    const event = makeEvent({
      event_type: "CustomEvent",
      sequence: 10,
    });
    const summary = generateEventSummary(event);
    expect(summary.text).toContain("CustomEvent");
  });
});
