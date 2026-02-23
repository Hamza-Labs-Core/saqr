/**
 * Tests for the Custom hook protocol integration.
 *
 * Covers: manifest validation, event validation, reserved provider names,
 * unknown event types, exponential backoff, JSONL parsing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CustomIntegration, type CustomHookManifest } from "../hooks/integrations/custom.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

describe("CustomIntegration", () => {
  let integration: CustomIntegration;

  beforeEach(() => {
    integration = new CustomIntegration();
  });

  // -------------------------------------------------------------------
  // Manifest Validation
  // -------------------------------------------------------------------

  describe("validateManifest", () => {
    it("accepts a valid manifest", () => {
      const manifest: CustomHookManifest = {
        name: "cursor",
        description: "Cursor IDE integration",
        version: "1.0.0",
        author: "Community",
        agent_provider: "cursor",
        executable: "./cursor-hook",
        event_mapping: {
          "cursor.session.start": "SessionStarted",
          "cursor.tool.begin": "ToolCallRequested",
          "cursor.tool.end": "ToolCallCompleted",
          "cursor.session.end": "SessionEnded",
        },
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors).toHaveLength(0);
    });

    it("rejects manifest without name", () => {
      const manifest = {
        agent_provider: "cursor",
        executable: "./hook",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("name"))).toBe(true);
    });

    it("rejects manifest without agent_provider", () => {
      const manifest = {
        name: "cursor",
        executable: "./hook",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("agent_provider"))).toBe(true);
    });

    it("rejects manifest without executable", () => {
      const manifest = {
        name: "cursor",
        agent_provider: "cursor",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("executable"))).toBe(true);
    });

    it("rejects manifest without event_mapping", () => {
      const manifest = {
        name: "cursor",
        agent_provider: "cursor",
        executable: "./hook",
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("event_mapping"))).toBe(true);
    });

    it("rejects reserved provider name 'claude-code'", () => {
      const manifest = {
        name: "fake-claude",
        agent_provider: "claude-code",
        executable: "./hook",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("reserved"))).toBe(true);
    });

    it("rejects reserved provider name 'opencode'", () => {
      const manifest = {
        name: "fake-opencode",
        agent_provider: "opencode",
        executable: "./hook",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("reserved"))).toBe(true);
    });

    it("rejects reserved provider name 'codex'", () => {
      const manifest = {
        name: "fake-codex",
        agent_provider: "codex",
        executable: "./hook",
        event_mapping: {},
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("reserved"))).toBe(true);
    });

    it("rejects unknown unified event types in mapping", () => {
      const manifest = {
        name: "cursor",
        agent_provider: "cursor",
        executable: "./hook",
        event_mapping: {
          "cursor.event": "UnknownEventType",
        },
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors.some((e) => e.includes("Unknown unified event type"))).toBe(true);
    });

    it("accepts all 12 valid unified event types in mapping", () => {
      const validTypes = [
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

      const mapping: Record<string, string> = {};
      for (const type of validTypes) {
        mapping[`native.${type}`] = type;
      }

      const manifest = {
        name: "full",
        agent_provider: "full-agent",
        executable: "./hook",
        event_mapping: mapping,
      };

      const errors = CustomIntegration.validateManifest(manifest);
      expect(errors).toHaveLength(0);
    });

    it("rejects non-object manifest", () => {
      const errors = CustomIntegration.validateManifest("not an object");
      expect(errors.some((e) => e.includes("JSON object"))).toBe(true);
    });

    it("rejects null manifest", () => {
      const errors = CustomIntegration.validateManifest(null);
      expect(errors.some((e) => e.includes("JSON object"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Event Validation
  // -------------------------------------------------------------------

  describe("validateEvent", () => {
    it("accepts a valid JSONL event", () => {
      const line = JSON.stringify({
        event_type: "ToolCallCompleted",
        agent_native_event: "cursor.tool.end",
        data: {
          session_id: "s1",
          tool_name: "file_edit",
        },
      });

      const event = CustomIntegration.validateEvent(line);

      expect(event).not.toBeNull();
      expect(event!.event_type).toBe("ToolCallCompleted");
      expect(event!.agent_native_event).toBe("cursor.tool.end");
    });

    it("rejects malformed JSON", () => {
      const event = CustomIntegration.validateEvent("not json{{{");
      expect(event).toBeNull();
    });

    it("rejects events with invalid event_type", () => {
      const line = JSON.stringify({
        event_type: "InvalidEventType",
        data: { session_id: "s1" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event).toBeNull();
    });

    it("rejects events without data field", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event).toBeNull();
    });

    it("rejects events exceeding 10MB", () => {
      const largeData = "x".repeat(11 * 1024 * 1024);
      // This will be > 10MB
      const event = CustomIntegration.validateEvent(largeData);
      expect(event).toBeNull();
    });

    it("defaults session_id to 'unknown' when missing", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
        data: { model: "gpt-4o" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event!.session_id).toBe("unknown");
    });

    it("extracts session_id from data field", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
        data: { session_id: "my-session" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event!.session_id).toBe("my-session");
    });

    it("generates a UUID event_id", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
        data: { session_id: "s1" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event!.event_id).toBeDefined();
      expect(event!.event_id.length).toBeGreaterThan(0);
    });

    it("defaults agent_provider to 'custom'", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
        data: { session_id: "s1" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event!.agent_provider).toBe("custom");
    });

    it("uses provided agent_provider when present", () => {
      const line = JSON.stringify({
        event_type: "SessionStarted",
        agent_provider: "cursor",
        data: { session_id: "s1" },
      });

      const event = CustomIntegration.validateEvent(line);
      expect(event!.agent_provider).toBe("cursor");
    });
  });

  // -------------------------------------------------------------------
  // Exponential Backoff
  // -------------------------------------------------------------------

  describe("calculateBackoff", () => {
    it("starts at 1 second for attempt 0", () => {
      expect(CustomIntegration.calculateBackoff(0)).toBe(1000);
    });

    it("doubles each attempt", () => {
      expect(CustomIntegration.calculateBackoff(0)).toBe(1000);
      expect(CustomIntegration.calculateBackoff(1)).toBe(2000);
      expect(CustomIntegration.calculateBackoff(2)).toBe(4000);
      expect(CustomIntegration.calculateBackoff(3)).toBe(8000);
      expect(CustomIntegration.calculateBackoff(4)).toBe(16000);
    });

    it("caps at 60 seconds", () => {
      expect(CustomIntegration.calculateBackoff(10)).toBe(60000);
      expect(CustomIntegration.calculateBackoff(20)).toBe(60000);
      expect(CustomIntegration.calculateBackoff(100)).toBe(60000);
    });

    it("reaches cap at attempt 6 (64000 -> capped to 60000)", () => {
      expect(CustomIntegration.calculateBackoff(5)).toBe(32000);
      expect(CustomIntegration.calculateBackoff(6)).toBe(60000); // 64000 capped
    });
  });

  // -------------------------------------------------------------------
  // isAgentInstalled
  // -------------------------------------------------------------------

  describe("isAgentInstalled", () => {
    it("returns false when no config is set", async () => {
      expect(await integration.isAgentInstalled()).toBe(false);
    });

    it("returns true when config is set", async () => {
      integration.setConfig({ command: "/usr/bin/test-hook" });
      expect(await integration.isAgentInstalled()).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // setConfig
  // -------------------------------------------------------------------

  describe("setConfig", () => {
    it("updates the hook configuration", () => {
      integration.setConfig({ command: "/usr/bin/cursor-hook", name: "cursor" });
      // isAgentInstalled should now return true
    });
  });

  // -------------------------------------------------------------------
  // Capture Lifecycle
  // -------------------------------------------------------------------

  describe("startCapture / stopCapture", () => {
    it("registers and clears capture callback", async () => {
      let capturedEvent: EventEnvelope | null = null;
      await integration.startCapture((e) => {
        capturedEvent = e;
      });

      await integration.stopCapture();

      // After stop, nothing should be captured
      expect(capturedEvent).toBeNull();
    });
  });
});
