import { describe, it, expect } from "vitest";
import {
  UNIFIED_EVENT_TYPES,
  isUnifiedEventType,
  createUnifiedEvent,
  EVENT_MAPPING_TABLE,
  NATIVE_TO_UNIFIED,
  getNativeEventName,
  getUnifiedEventType,
} from "../events/index.js";
import type {
  UnifiedEventType,
  TypedEvent,
  UnifiedEvent,
  EventPayloadMap,
  SessionStartedPayload,
  ToolCallCompletedPayload,
  PermissionRespondedPayload,
} from "../events/index.js";

describe("events/types", () => {
  describe("UNIFIED_EVENT_TYPES", () => {
    it("should contain exactly 12 event types", () => {
      expect(UNIFIED_EVENT_TYPES).toHaveLength(12);
    });

    it("should contain all expected event types", () => {
      const expected: UnifiedEventType[] = [
        "SessionStarted",
        "UserPromptReceived",
        "ToolCallRequested",
        "ToolCallCompleted",
        "ToolCallFailed",
        "AgentSpawned",
        "AgentCompleted",
        "TurnCompleted",
        "CompactionTriggered",
        "SessionEnded",
        "PermissionRequested",
        "PermissionResponded",
      ];
      expect(UNIFIED_EVENT_TYPES).toEqual(expected);
    });

    it("should be readonly", () => {
      // TypeScript enforces this at compile time, but we verify the array is frozen-like
      expect(() => {
        (UNIFIED_EVENT_TYPES as unknown as string[]).push("Fake");
      }).toThrow();
    });
  });

  describe("isUnifiedEventType", () => {
    it("should return true for valid event types", () => {
      for (const eventType of UNIFIED_EVENT_TYPES) {
        expect(isUnifiedEventType(eventType)).toBe(true);
      }
    });

    it("should return false for invalid event types", () => {
      expect(isUnifiedEventType("InvalidEvent")).toBe(false);
      expect(isUnifiedEventType("")).toBe(false);
      expect(isUnifiedEventType("session_started")).toBe(false);
      expect(isUnifiedEventType("SESSIONSTARTED")).toBe(false);
    });
  });

  describe("TypedEvent discriminated union", () => {
    it("should narrow to SessionStartedPayload via type guard", () => {
      const event: TypedEvent = {
        type: "SessionStarted",
        payload: {
          session_id: "test-session",
          cwd: "/home/user/project",
          model: "claude-opus-4-6",
        },
      };

      if (event.type === "SessionStarted") {
        // TypeScript narrows to SessionStartedPayload
        const payload: SessionStartedPayload = event.payload;
        expect(payload.session_id).toBe("test-session");
        expect(payload.cwd).toBe("/home/user/project");
      }
    });

    it("should narrow to ToolCallCompletedPayload via type guard", () => {
      const event: TypedEvent = {
        type: "ToolCallCompleted",
        payload: {
          session_id: "test-session",
          tool_name: "Write",
          tool_input: { file_path: "/src/main.ts" },
          tool_response: "File written successfully",
          tool_use_id: "tu_123",
        },
      };

      if (event.type === "ToolCallCompleted") {
        const payload: ToolCallCompletedPayload = event.payload;
        expect(payload.tool_name).toBe("Write");
        expect(payload.tool_response).toBe("File written successfully");
      }
    });

    it("should narrow to PermissionRespondedPayload via type guard", () => {
      const event: TypedEvent = {
        type: "PermissionResponded",
        payload: {
          session_id: "test-session",
          permission_id: "perm_456",
          granted: true,
          reason: "User approved",
        },
      };

      if (event.type === "PermissionResponded") {
        const payload: PermissionRespondedPayload = event.payload;
        expect(payload.granted).toBe(true);
        expect(payload.permission_id).toBe("perm_456");
      }
    });

    it("should support switch-based exhaustive narrowing", () => {
      const events: TypedEvent[] = [
        { type: "SessionStarted", payload: { session_id: "s1" } },
        { type: "UserPromptReceived", payload: { session_id: "s1", prompt: "hello" } },
        { type: "ToolCallRequested", payload: { session_id: "s1", tool_name: "Read", tool_input: {} } },
        { type: "ToolCallCompleted", payload: { session_id: "s1", tool_name: "Read", tool_input: {}, tool_response: "ok" } },
        { type: "ToolCallFailed", payload: { session_id: "s1", tool_name: "Read", tool_input: {}, error: "fail" } },
        { type: "AgentSpawned", payload: { session_id: "s1", subagent_id: "sub1" } },
        { type: "AgentCompleted", payload: { session_id: "s1", subagent_id: "sub1" } },
        { type: "TurnCompleted", payload: { session_id: "s1" } },
        { type: "CompactionTriggered", payload: { session_id: "s1" } },
        { type: "SessionEnded", payload: { session_id: "s1" } },
        { type: "PermissionRequested", payload: { session_id: "s1", permission_id: "p1", tool_name: "Write", tool_input: {} } },
        { type: "PermissionResponded", payload: { session_id: "s1", permission_id: "p1", granted: false } },
      ];

      // All 12 event types should be representable
      expect(events).toHaveLength(12);

      const types = events.map((e) => e.type);
      expect(new Set(types).size).toBe(12);
    });
  });

  describe("EventPayloadMap", () => {
    it("should map event types to their correct payload types (compile-time check)", () => {
      // This test primarily validates TypeScript compilation.
      // If it compiles, the mapping is correct.
      type Check = EventPayloadMap["ToolCallCompleted"]["tool_name"];
      const _check: Check = "Write";
      expect(_check).toBe("Write");
    });
  });
});

describe("events/envelope", () => {
  describe("createUnifiedEvent", () => {
    it("should create an event with auto-generated event_id and timestamp", () => {
      const event = createUnifiedEvent({
        event_type: "ToolCallCompleted",
        project_id: "my-project-a3f7b2",
        session_id: "abc123-def456",
        sequence: 42,
        agent_provider: "claude-code",
        agent_native_event: "PostToolUse",
        agent_metadata: {
          agent_version: "claude-code/1.0.38",
          model: "claude-opus-4-6",
          agent_pid: 12345,
          cwd: "/home/user/my-project",
        },
        data: {
          tool_name: "Write",
          tool_input: { file_path: "/src/main.ts" },
        },
      });

      // Auto-generated fields
      expect(event.event_id).toBeDefined();
      expect(event.event_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);

      // Provided fields
      expect(event.event_type).toBe("ToolCallCompleted");
      expect(event.project_id).toBe("my-project-a3f7b2");
      expect(event.session_id).toBe("abc123-def456");
      expect(event.sequence).toBe(42);
      expect(event.agent_provider).toBe("claude-code");
      expect(event.agent_native_event).toBe("PostToolUse");
      expect(event.agent_metadata.agent_version).toBe("claude-code/1.0.38");
      expect(event.agent_metadata.model).toBe("claude-opus-4-6");
      expect(event.data.tool_name).toBe("Write");
    });

    it("should preserve the original 7-field GC envelope structure", () => {
      const event = createUnifiedEvent({
        event_type: "SessionStarted",
        project_id: "proj-123456",
        session_id: "sess-1",
        sequence: 1,
        agent_provider: "opencode",
        agent_native_event: "session.created",
        agent_metadata: {},
        data: { session_id: "sess-1" },
      });

      // Original 7 GC fields
      expect(event).toHaveProperty("event_id");
      expect(event).toHaveProperty("event_type");
      expect(event).toHaveProperty("project_id");
      expect(event).toHaveProperty("session_id");
      expect(event).toHaveProperty("sequence");
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("data");

      // Additional 3 multi-agent fields
      expect(event).toHaveProperty("agent_provider");
      expect(event).toHaveProperty("agent_native_event");
      expect(event).toHaveProperty("agent_metadata");

      // Should have exactly 10 top-level fields
      expect(Object.keys(event)).toHaveLength(10);
    });

    it("should produce unique event_ids for each call", () => {
      const event1 = createUnifiedEvent({
        event_type: "SessionStarted",
        project_id: "p1",
        session_id: "s1",
        sequence: 1,
        agent_provider: "claude-code",
        agent_native_event: "SessionStart",
        agent_metadata: {},
        data: {},
      });
      const event2 = createUnifiedEvent({
        event_type: "SessionStarted",
        project_id: "p1",
        session_id: "s1",
        sequence: 2,
        agent_provider: "claude-code",
        agent_native_event: "SessionStart",
        agent_metadata: {},
        data: {},
      });

      expect(event1.event_id).not.toBe(event2.event_id);
    });
  });

  describe("UnifiedEvent interface", () => {
    it("should accept a fully-formed event object (compile-time type check)", () => {
      const event: UnifiedEvent = {
        event_id: "550e8400-e29b-41d4-a716-446655440000",
        event_type: "ToolCallCompleted",
        project_id: "my-project-a3f7b2",
        session_id: "abc123-def456",
        sequence: 42,
        timestamp: "2026-02-21T14:30:00.123Z",
        agent_provider: "claude-code",
        agent_native_event: "PostToolUse",
        agent_metadata: {
          agent_version: "claude-code/1.0.38",
          model: "claude-opus-4-6",
          agent_pid: 12345,
          cwd: "/home/user/my-project",
        },
        data: {
          session_id: "abc123-def456",
          tool_name: "Write",
          tool_input: { file_path: "/src/main.ts", content: "..." },
          tool_response: "File written successfully",
          tool_use_id: "tu_abc123",
        },
      };

      expect(event.event_type).toBe("ToolCallCompleted");
      expect(event.agent_provider).toBe("claude-code");
    });
  });
});

describe("events/mappings", () => {
  describe("EVENT_MAPPING_TABLE", () => {
    it("should have exactly 12 mapping entries", () => {
      expect(EVENT_MAPPING_TABLE).toHaveLength(12);
    });

    it("should cover all 12 unified event types", () => {
      const mappedTypes = EVENT_MAPPING_TABLE.map((e) => e.unified);
      expect(new Set(mappedTypes).size).toBe(12);
      for (const eventType of UNIFIED_EVENT_TYPES) {
        expect(mappedTypes).toContain(eventType);
      }
    });

    it("should have Claude Code mappings for 10 event types", () => {
      const claudeCodeMappings = EVENT_MAPPING_TABLE.filter(
        (e) => e.claudeCode !== null,
      );
      expect(claudeCodeMappings).toHaveLength(10);
    });

    it("should have null Claude Code mappings for PermissionRequested and PermissionResponded", () => {
      const permReq = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "PermissionRequested",
      );
      const permResp = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "PermissionResponded",
      );
      expect(permReq?.claudeCode).toBeNull();
      expect(permResp?.claudeCode).toBeNull();
    });

    it("should have null OpenCode mappings for AgentSpawned and AgentCompleted", () => {
      const spawned = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "AgentSpawned",
      );
      const completed = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "AgentCompleted",
      );
      expect(spawned?.opencode).toBeNull();
      expect(completed?.opencode).toBeNull();
    });

    it("should have null Codex mappings for AgentSpawned, AgentCompleted, and CompactionTriggered", () => {
      const spawned = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "AgentSpawned",
      );
      const completed = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "AgentCompleted",
      );
      const compaction = EVENT_MAPPING_TABLE.find(
        (e) => e.unified === "CompactionTriggered",
      );
      expect(spawned?.codex).toBeNull();
      expect(completed?.codex).toBeNull();
      expect(compaction?.codex).toBeNull();
    });
  });

  describe("NATIVE_TO_UNIFIED", () => {
    it("should map Claude Code native events to unified types", () => {
      const ccMap = NATIVE_TO_UNIFIED["claude-code"];
      expect(ccMap.get("SessionStart")).toBe("SessionStarted");
      expect(ccMap.get("UserPromptSubmit")).toBe("UserPromptReceived");
      expect(ccMap.get("PreToolUse")).toBe("ToolCallRequested");
      expect(ccMap.get("PostToolUse")).toBe("ToolCallCompleted");
      expect(ccMap.get("PostToolUseFailure")).toBe("ToolCallFailed");
      expect(ccMap.get("SubagentStart")).toBe("AgentSpawned");
      expect(ccMap.get("SubagentStop")).toBe("AgentCompleted");
      expect(ccMap.get("Stop")).toBe("TurnCompleted");
      expect(ccMap.get("PreCompact")).toBe("CompactionTriggered");
      expect(ccMap.get("SessionEnd")).toBe("SessionEnded");
    });

    it("should map OpenCode native events to unified types", () => {
      const ocMap = NATIVE_TO_UNIFIED["opencode"];
      expect(ocMap.get("session.created")).toBe("SessionStarted");
      expect(ocMap.get("message.updated")).toBe("UserPromptReceived");
      expect(ocMap.get("tool.execute.before")).toBe("ToolCallRequested");
      expect(ocMap.get("session.idle")).toBe("TurnCompleted");
      expect(ocMap.get("session.compacted")).toBe("CompactionTriggered");
      expect(ocMap.get("session.deleted")).toBe("SessionEnded");
      expect(ocMap.get("permission.asked")).toBe("PermissionRequested");
      expect(ocMap.get("permission.replied")).toBe("PermissionResponded");
    });

    it("should map Codex native events to unified types", () => {
      const cxMap = NATIVE_TO_UNIFIED["codex"];
      expect(cxMap.get("process_spawn")).toBe("SessionStarted");
      expect(cxMap.get("stdin_message")).toBe("UserPromptReceived");
      expect(cxMap.get("tool_use")).toBe("ToolCallRequested");
      expect(cxMap.get("tool_result")).toBe("ToolCallCompleted");
      expect(cxMap.get("tool_error")).toBe("ToolCallFailed");
      expect(cxMap.get("turn_end")).toBe("TurnCompleted");
      expect(cxMap.get("process_exit")).toBe("SessionEnded");
      expect(cxMap.get("permission")).toBe("PermissionRequested");
      expect(cxMap.get("permission_response")).toBe("PermissionResponded");
    });

    it("should have an empty map for custom provider", () => {
      expect(NATIVE_TO_UNIFIED["custom"].size).toBe(0);
    });
  });

  describe("getNativeEventName", () => {
    it("should return the native event name for a known mapping", () => {
      expect(getNativeEventName("ToolCallCompleted", "claude-code")).toBe("PostToolUse");
      expect(getNativeEventName("SessionStarted", "opencode")).toBe("session.created");
      expect(getNativeEventName("ToolCallFailed", "codex")).toBe("tool_error");
    });

    it("should return null when the provider does not support the event", () => {
      expect(getNativeEventName("AgentSpawned", "opencode")).toBeNull();
      expect(getNativeEventName("AgentSpawned", "codex")).toBeNull();
      expect(getNativeEventName("CompactionTriggered", "codex")).toBeNull();
      expect(getNativeEventName("PermissionRequested", "claude-code")).toBeNull();
    });

    it("should return null for custom provider", () => {
      expect(getNativeEventName("SessionStarted", "custom")).toBeNull();
    });
  });

  describe("getUnifiedEventType", () => {
    it("should return the unified type for a known native event", () => {
      expect(getUnifiedEventType("PostToolUse", "claude-code")).toBe("ToolCallCompleted");
      expect(getUnifiedEventType("session.created", "opencode")).toBe("SessionStarted");
      expect(getUnifiedEventType("tool_error", "codex")).toBe("ToolCallFailed");
    });

    it("should return undefined for an unknown native event", () => {
      expect(getUnifiedEventType("UnknownEvent", "claude-code")).toBeUndefined();
      expect(getUnifiedEventType("fake.event", "opencode")).toBeUndefined();
    });

    it("should return undefined for custom provider", () => {
      expect(getUnifiedEventType("anything", "custom")).toBeUndefined();
    });
  });
});
