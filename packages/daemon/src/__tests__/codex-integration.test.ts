/**
 * Tests for the Codex hook integration.
 *
 * Covers: install watcher config, JSONL parsing, event normalization,
 * session lifecycle, health checks, malformed line handling, offset tracking.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexIntegration,
  CODEX_MESSAGE_MAP,
} from "../hooks/integrations/codex.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

describe("CodexIntegration", () => {
  let tempDir: string;
  let sessionDir: string;
  let configDir: string;
  let integration: CodexIntegration;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "saqr-test-cdx-"));
    sessionDir = join(tempDir, ".codex", "sessions");
    configDir = join(tempDir, ".agentctx", "integrations", "codex");
    integration = new CodexIntegration({ sessionDir, configDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------

  describe("install", () => {
    it("creates watcher configuration file", async () => {
      const result = await integration.install();

      expect(result.success).toBe(true);
      expect(result.message).toContain("watcher configured");

      const configPath = join(configDir, "watcher.json");
      await expect(access(configPath, fsConstants.F_OK)).resolves.not.toThrow();

      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);

      expect(config.enabled).toBe(true);
      expect(config.session_dir).toBe(sessionDir);
      expect(config.protocol).toBe("jsonl");
      expect(config.message_types).toEqual(Object.keys(CODEX_MESSAGE_MAP));
    });

    it("creates session directory", async () => {
      await integration.install();
      await expect(access(sessionDir, fsConstants.F_OK)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------

  describe("uninstall", () => {
    it("removes watcher configuration", async () => {
      await integration.install();
      await integration.uninstall();

      await expect(
        access(configDir, fsConstants.F_OK),
      ).rejects.toThrow();
    });

    it("handles missing config gracefully", async () => {
      await expect(integration.uninstall()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------

  describe("healthCheck", () => {
    it("reports healthy when watcher is configured", async () => {
      await integration.install();

      // Create session directory to satisfy check
      await mkdir(sessionDir, { recursive: true });

      const result = await integration.healthCheck();

      const sessionCheck = result.checks.find((c) => c.name === "Session directory");
      expect(sessionCheck?.passed).toBe(true);

      const configCheck = result.checks.find((c) => c.name === "Watcher configuration");
      expect(configCheck?.passed).toBe(true);
    });

    it("reports failing when not installed", async () => {
      const result = await integration.healthCheck();

      const configCheck = result.checks.find((c) => c.name === "Watcher configuration");
      expect(configCheck?.passed).toBe(false);
    });

    it("has at least 3 checks", async () => {
      const result = await integration.healthCheck();
      expect(result.checks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------
  // JSONL Parsing
  // -------------------------------------------------------------------

  describe("parseJsonlLine", () => {
    it("parses tool_use message to ToolCallRequested", () => {
      const line = JSON.stringify({
        type: "tool_use",
        id: "tu-1",
        name: "file_write",
        input: { path: "/src/main.ts" },
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event).not.toBeNull();
      expect(event!.event_type).toBe("ToolCallRequested");
      expect(event!.agent_native_event).toBe("tool_use");
      expect(event!.session_id).toBe("session-1");
    });

    it("parses tool_result message to ToolCallCompleted", () => {
      const line = JSON.stringify({
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "File written successfully",
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.event_type).toBe("ToolCallCompleted");
    });

    it("parses tool_error message to ToolCallFailed", () => {
      const line = JSON.stringify({
        type: "tool_error",
        tool_use_id: "tu-1",
        error: "Permission denied",
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.event_type).toBe("ToolCallFailed");
    });

    it("parses turn_end message to TurnCompleted", () => {
      const line = JSON.stringify({
        type: "turn_end",
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.event_type).toBe("TurnCompleted");
    });

    it("parses permission message to PermissionRequested", () => {
      const line = JSON.stringify({
        type: "permission",
        tool: "bash",
        description: "Run shell command",
        id: "perm-1",
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.event_type).toBe("PermissionRequested");
    });

    it("parses permission_response message to PermissionResponded", () => {
      const line = JSON.stringify({
        type: "permission_response",
        id: "perm-1",
        granted: true,
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.event_type).toBe("PermissionResponded");
    });

    it("detects user prompt from role=user message", () => {
      const line = JSON.stringify({
        role: "user",
        content: "Fix the bug in main.ts",
      });

      const event = integration.parseJsonlLine(line, "session-1");

      expect(event).not.toBeNull();
      expect(event!.event_type).toBe("UserPromptReceived");
      expect(event!.agent_native_event).toBe("stdin_message");
    });

    it("handles malformed JSON lines without crashing", () => {
      const event = integration.parseJsonlLine("not valid json{{{", "session-1");
      expect(event).toBeNull();
    });

    it("handles empty lines without crashing", () => {
      const event = integration.parseJsonlLine("", "session-1");
      expect(event).toBeNull();
    });

    it("returns null for unknown message types", () => {
      const line = JSON.stringify({
        type: "unknown_type",
        data: "something",
      });

      const event = integration.parseJsonlLine(line, "session-1");
      expect(event).toBeNull();
    });

    it("always includes agent_provider as 'codex'", () => {
      const line = JSON.stringify({ type: "tool_use", id: "1", name: "test", input: {} });
      const event = integration.parseJsonlLine(line, "session-1");

      expect(event!.agent_provider).toBe("codex");
    });

    it("preserves full JSONL message in data field", () => {
      const message = {
        type: "tool_use",
        id: "tu-1",
        name: "file_write",
        input: { path: "/src/main.ts" },
        extra: "metadata",
      };
      const event = integration.parseJsonlLine(JSON.stringify(message), "session-1");

      expect(event!.data).toEqual(message);
    });

    it("increments sequence numbers across multiple parses", () => {
      const e1 = integration.parseJsonlLine(
        JSON.stringify({ type: "tool_use", id: "1", name: "t", input: {} }),
        "s1",
      );
      const e2 = integration.parseJsonlLine(
        JSON.stringify({ type: "tool_result", tool_use_id: "1", content: "ok" }),
        "s1",
      );

      expect(e1!.sequence).toBe(1);
      expect(e2!.sequence).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Session Lifecycle Events
  // -------------------------------------------------------------------

  describe("emitSessionStarted", () => {
    it("emits SessionStarted event via capture callback", async () => {
      const events: EventEnvelope[] = [];
      await integration.startCapture((e) => events.push(e));

      integration.emitSessionStarted("new-session-1");

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("SessionStarted");
      expect(events[0].session_id).toBe("new-session-1");
      expect(events[0].agent_provider).toBe("codex");
      expect(events[0].agent_native_event).toBe("process_spawn");
    });
  });

  describe("emitSessionEnded", () => {
    it("emits SessionEnded event via capture callback", async () => {
      const events: EventEnvelope[] = [];
      await integration.startCapture((e) => events.push(e));

      integration.emitSessionEnded("session-1", "process_exit");

      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("SessionEnded");
      expect(events[0].session_id).toBe("session-1");
      expect(events[0].agent_native_event).toBe("process_exit");
      expect(events[0].data.reason).toBe("process_exit");
    });
  });

  // -------------------------------------------------------------------
  // CODEX_MESSAGE_MAP constant
  // -------------------------------------------------------------------

  describe("CODEX_MESSAGE_MAP", () => {
    it("maps all 6 Codex JSONL message types", () => {
      expect(Object.keys(CODEX_MESSAGE_MAP)).toHaveLength(6);
      expect(CODEX_MESSAGE_MAP.tool_use).toBe("ToolCallRequested");
      expect(CODEX_MESSAGE_MAP.tool_result).toBe("ToolCallCompleted");
      expect(CODEX_MESSAGE_MAP.tool_error).toBe("ToolCallFailed");
      expect(CODEX_MESSAGE_MAP.turn_end).toBe("TurnCompleted");
      expect(CODEX_MESSAGE_MAP.permission).toBe("PermissionRequested");
      expect(CODEX_MESSAGE_MAP.permission_response).toBe("PermissionResponded");
    });
  });

  // -------------------------------------------------------------------
  // Capture Lifecycle
  // -------------------------------------------------------------------

  describe("startCapture / stopCapture", () => {
    it("registers and clears capture callback", async () => {
      const events: EventEnvelope[] = [];
      await integration.startCapture((e) => events.push(e));

      integration.handleIncomingEvent("tool_use", {
        session_id: "s1",
        type: "tool_use",
      });
      expect(events).toHaveLength(1);

      await integration.stopCapture();

      integration.handleIncomingEvent("tool_use", {
        session_id: "s1",
        type: "tool_use",
      });
      expect(events).toHaveLength(1); // No new event
    });
  });
});
