/**
 * Tests for the EventStore — read-side access to the event file store.
 *
 * Uses real temp directories with actual JSON files to test filesystem reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStore } from "../store/event-store.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

function makeEventFile(
  overrides: Partial<EventEnvelope> & { sequence: number },
): EventEnvelope {
  const { sequence, ...rest } = overrides;
  return {
    event_id: crypto.randomUUID(),
    event_type: "ToolCallCompleted",
    project_id: "test-proj-abc123",
    session_id: "sess-001",
    sequence,
    timestamp: new Date().toISOString(),
    agent_provider: "claude-code",
    agent_native_event: "PostToolUse",
    agent_metadata: {},
    data: {},
    ...rest,
  };
}

function padSequence(seq: number): string {
  return String(seq).padStart(6, "0");
}

async function writeEvent(
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

async function writeSessionJson(
  eventsDir: string,
  projectId: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const sessionDir = path.join(eventsDir, projectId, sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      session_id: sessionId,
      project_id: projectId,
      started_at: "2026-02-21T10:00:00.000Z",
      event_count: 0,
      agent_provider: "claude-code",
      ...meta,
    }),
  );
}

describe("EventStore", () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "saqr-event-store-"));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("isAccessible", () => {
    it("should return true when the events directory exists", async () => {
      expect(await store.isAccessible()).toBe(true);
    });

    it("should return false for a non-existent directory", async () => {
      const badStore = new EventStore("/tmp/nonexistent-saqr-test-xyz");
      expect(await badStore.isAccessible()).toBe(false);
    });
  });

  describe("listProjects", () => {
    it("should return empty array when no projects exist", async () => {
      const projects = await store.listProjects();
      expect(projects).toEqual([]);
    });

    it("should list project directories", async () => {
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-001", {
        event_count: 5,
        last_event_at: "2026-02-21T10:30:00.000Z",
        agent_provider: "claude-code",
      });
      await writeSessionJson(tmpDir, "proj-b-def456", "sess-002", {
        event_count: 3,
        last_event_at: "2026-02-21T11:00:00.000Z",
        agent_provider: "opencode",
      });

      const projects = await store.listProjects();
      expect(projects).toHaveLength(2);

      const ids = projects.map((p) => p.projectId).sort();
      expect(ids).toEqual(["proj-a-abc123", "proj-b-def456"]);
    });

    it("should aggregate session count per project", async () => {
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-001", {
        event_count: 5,
        agent_provider: "claude-code",
      });
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-002", {
        event_count: 3,
        agent_provider: "opencode",
      });

      const projects = await store.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].sessionCount).toBe(2);
      expect(projects[0].totalEvents).toBe(8);
      expect(projects[0].agentProviders.sort()).toEqual(["claude-code", "opencode"]);
    });
  });

  describe("listSessions", () => {
    it("should return empty array when no sessions exist", async () => {
      await mkdir(path.join(tmpDir, "proj-a-abc123"), { recursive: true });
      const sessions = await store.listSessions("proj-a-abc123");
      expect(sessions).toEqual([]);
    });

    it("should list sessions with metadata from session.json", async () => {
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-001", {
        event_count: 10,
        agent_provider: "claude-code",
        started_at: "2026-02-21T10:00:00.000Z",
        ended_at: "2026-02-21T11:00:00.000Z",
      });
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-002", {
        event_count: 5,
        agent_provider: "opencode",
        started_at: "2026-02-21T12:00:00.000Z",
        ended_at: null,
      });

      const sessions = await store.listSessions("proj-a-abc123");
      expect(sessions).toHaveLength(2);

      const s1 = sessions.find((s) => s.sessionId === "sess-001");
      expect(s1).toBeDefined();
      expect(s1!.agentProvider).toBe("claude-code");
      expect(s1!.eventCount).toBe(10);

      const s2 = sessions.find((s) => s.sessionId === "sess-002");
      expect(s2).toBeDefined();
      expect(s2!.agentProvider).toBe("opencode");
    });

    it("should return empty for non-existent project", async () => {
      const sessions = await store.listSessions("nonexistent");
      expect(sessions).toEqual([]);
    });
  });

  describe("getEvent", () => {
    it("should read a single event by project/session/sequence", async () => {
      const event = makeEventFile({
        sequence: 1,
        project_id: "proj-a-abc123",
        session_id: "sess-001",
        event_type: "SessionStarted",
      });
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001", event);

      const result = await store.getEvent("proj-a-abc123", "sess-001", 1);
      expect(result).not.toBeNull();
      expect(result!.event_id).toBe(event.event_id);
      expect(result!.event_type).toBe("SessionStarted");
    });

    it("should return null for non-existent event", async () => {
      const result = await store.getEvent("proj-a-abc123", "sess-001", 999);
      expect(result).toBeNull();
    });
  });

  describe("queryEvents", () => {
    it("should return all events for a session", async () => {
      for (let i = 1; i <= 5; i++) {
        const event = makeEventFile({
          sequence: i,
          project_id: "proj-a-abc123",
          session_id: "sess-001",
        });
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001", event);
      }

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
      });

      expect(results).toHaveLength(5);
      // Should be in ascending order
      expect(results.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    });

    it("should filter by event type", async () => {
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 1, event_type: "SessionStarted" }));
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 2, event_type: "ToolCallCompleted" }));
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 3, event_type: "TurnCompleted" }));

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
        eventTypes: ["ToolCallCompleted", "TurnCompleted"],
      });

      expect(results).toHaveLength(2);
      expect(results.map((e) => e.event_type).sort()).toEqual([
        "ToolCallCompleted",
        "TurnCompleted",
      ]);
    });

    it("should filter by afterSequence", async () => {
      for (let i = 1; i <= 5; i++) {
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
          makeEventFile({ sequence: i }));
      }

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
        afterSequence: 3,
      });

      expect(results).toHaveLength(2);
      expect(results.map((e) => e.sequence)).toEqual([4, 5]);
    });

    it("should respect limit", async () => {
      for (let i = 1; i <= 10; i++) {
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
          makeEventFile({ sequence: i }));
      }

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
        limit: 3,
      });

      expect(results).toHaveLength(3);
      expect(results.map((e) => e.sequence)).toEqual([1, 2, 3]);
    });

    it("should support descending order", async () => {
      for (let i = 1; i <= 5; i++) {
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
          makeEventFile({ sequence: i }));
      }

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
        order: "desc",
      });

      expect(results.map((e) => e.sequence)).toEqual([5, 4, 3, 2, 1]);
    });

    it("should query across sessions in a project", async () => {
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 1, session_id: "sess-001" }));
      await writeEvent(tmpDir, "proj-a-abc123", "sess-002",
        makeEventFile({ sequence: 1, session_id: "sess-002" }));

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
      });

      expect(results).toHaveLength(2);
    });

    it("should return empty array for non-existent project", async () => {
      const results = await store.queryEvents({
        projectId: "nonexistent",
      });
      expect(results).toEqual([]);
    });

    it("should handle corrupt JSON files gracefully", async () => {
      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 1 }));

      // Write a corrupt file
      const sessionDir = path.join(tmpDir, "proj-a-abc123", "sess-001");
      await writeFile(path.join(sessionDir, "000002.json"), "{ invalid json");

      await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
        makeEventFile({ sequence: 3 }));

      const results = await store.queryEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
      });

      // Should skip corrupt file and return the valid events
      expect(results).toHaveLength(2);
    });
  });

  describe("countEvents", () => {
    it("should count events matching a query", async () => {
      for (let i = 1; i <= 5; i++) {
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
          makeEventFile({ sequence: i }));
      }

      const count = await store.countEvents({
        projectId: "proj-a-abc123",
        sessionId: "sess-001",
      });
      expect(count).toBe(5);
    });

    it("should return 0 for no matches", async () => {
      const count = await store.countEvents({
        projectId: "nonexistent",
      });
      expect(count).toBe(0);
    });
  });

  describe("getLatestSequence", () => {
    it("should return the highest sequence number", async () => {
      for (let i = 1; i <= 5; i++) {
        await writeEvent(tmpDir, "proj-a-abc123", "sess-001",
          makeEventFile({ sequence: i }));
      }

      const latest = await store.getLatestSequence("proj-a-abc123", "sess-001");
      expect(latest).toBe(5);
    });

    it("should return 0 for empty session", async () => {
      const latest = await store.getLatestSequence("proj-a-abc123", "sess-001");
      expect(latest).toBe(0);
    });
  });

  describe("getSessionMetadata", () => {
    it("should read session.json metadata", async () => {
      await writeSessionJson(tmpDir, "proj-a-abc123", "sess-001", {
        event_count: 42,
        agent_provider: "claude-code",
        model: "claude-opus-4-6",
        token_usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          cache_write_tokens: 100,
        },
      });

      const meta = await store.getSessionMetadata("proj-a-abc123", "sess-001");
      expect(meta).not.toBeNull();
      expect(meta!.session_id).toBe("sess-001");
      expect(meta!.agent_provider).toBe("claude-code");
      expect(meta!.event_count).toBe(42);
    });

    it("should return null for non-existent session", async () => {
      const meta = await store.getSessionMetadata("proj-a-abc123", "nonexistent");
      expect(meta).toBeNull();
    });
  });
});
