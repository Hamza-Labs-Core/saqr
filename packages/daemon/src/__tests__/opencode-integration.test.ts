/**
 * Tests for the OpenCode hook integration.
 *
 * Covers: install plugin, validate manifest, uninstall,
 * event normalization (message.updated filtering, tool.execute.after splitting),
 * health checks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OpenCodeIntegration,
  OPENCODE_SUBSCRIBED_EVENTS,
} from "../hooks/integrations/opencode.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

describe("OpenCodeIntegration", () => {
  let tempDir: string;
  let pluginDir: string;
  let integration: OpenCodeIntegration;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "saqr-test-oc-"));
    pluginDir = join(tempDir, ".opencode", "plugins", "agentctx");
    integration = new OpenCodeIntegration({ pluginDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------

  describe("install", () => {
    it("creates plugin directory with all required files", async () => {
      const result = await integration.install();

      expect(result.success).toBe(true);
      expect(result.message).toContain("event subscriptions");

      // Verify files exist
      await expect(access(join(pluginDir, "plugin.json"), fsConstants.F_OK)).resolves.not.toThrow();
      await expect(access(join(pluginDir, "index.ts"), fsConstants.F_OK)).resolves.not.toThrow();
      await expect(access(join(pluginDir, "event-handler.ts"), fsConstants.F_OK)).resolves.not.toThrow();
    });

    it("writes valid plugin manifest JSON", async () => {
      await integration.install();

      const content = await readFile(join(pluginDir, "plugin.json"), "utf-8");
      const manifest = JSON.parse(content);

      expect(manifest.name).toBe("agentctx");
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.description).toContain("AgentContext");
      expect(manifest.author).toBe("AgentContext");
      expect(manifest.entrypoint).toBe("index.ts");
    });

    it("manifest declares all 9 subscribed events", async () => {
      await integration.install();

      const content = await readFile(join(pluginDir, "plugin.json"), "utf-8");
      const manifest = JSON.parse(content);

      expect(manifest.events).toHaveLength(9);
      for (const event of OPENCODE_SUBSCRIBED_EVENTS) {
        expect(manifest.events).toContain(event);
      }
    });

    it("returns already installed message when plugin exists", async () => {
      await integration.install();
      const result = await integration.install();

      expect(result.success).toBe(true);
      expect(result.message).toContain("already installed");
    });

    it("overwrites existing plugin with --force", async () => {
      await integration.install();
      const result = await integration.install({ force: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain("event subscriptions");
    });
  });

  // -------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------

  describe("uninstall", () => {
    it("removes the plugin directory", async () => {
      await integration.install();
      await integration.uninstall();

      await expect(
        access(pluginDir, fsConstants.F_OK),
      ).rejects.toThrow();
    });

    it("handles missing plugin directory gracefully", async () => {
      await expect(integration.uninstall()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------

  describe("healthCheck", () => {
    it("returns healthy when plugin is installed", async () => {
      await integration.install();
      const result = await integration.healthCheck();

      const dirCheck = result.checks.find((c) => c.name === "Plugin directory");
      expect(dirCheck?.passed).toBe(true);

      const manifestCheck = result.checks.find((c) => c.name === "Plugin manifest");
      expect(manifestCheck?.passed).toBe(true);

      const eventCheck = result.checks.find((c) => c.name === "Event subscriptions");
      expect(eventCheck?.passed).toBe(true);
      expect(eventCheck?.detail).toContain("9/9");

      const filesCheck = result.checks.find((c) => c.name === "Plugin files");
      expect(filesCheck?.passed).toBe(true);
    });

    it("reports failing when plugin not installed", async () => {
      const result = await integration.healthCheck();

      const dirCheck = result.checks.find((c) => c.name === "Plugin directory");
      expect(dirCheck?.passed).toBe(false);
    });

    it("has at least 4 specific checks", async () => {
      const result = await integration.healthCheck();
      expect(result.checks.length).toBeGreaterThanOrEqual(4);
    });
  });

  // -------------------------------------------------------------------
  // Event Normalization
  // -------------------------------------------------------------------

  describe("normalizeEvent", () => {
    it("maps session.created to SessionStarted", () => {
      const event = integration.normalizeEvent("session.created", {
        session_id: "s1",
        model: "gpt-4o",
        cwd: "/home/user",
      });

      expect(event).not.toBeNull();
      expect(event!.event_type).toBe("SessionStarted");
      expect(event!.agent_provider).toBe("opencode");
      expect(event!.agent_native_event).toBe("session.created");
    });

    it("maps session.deleted to SessionEnded", () => {
      const event = integration.normalizeEvent("session.deleted", {
        session_id: "s1",
        reason: "cleanup",
      });

      expect(event!.event_type).toBe("SessionEnded");
    });

    it("maps session.idle to TurnCompleted", () => {
      const event = integration.normalizeEvent("session.idle", {
        session_id: "s1",
      });

      expect(event!.event_type).toBe("TurnCompleted");
    });

    it("maps session.compacted to CompactionTriggered", () => {
      const event = integration.normalizeEvent("session.compacted", {
        session_id: "s1",
        before_tokens: 100000,
        after_tokens: 20000,
      });

      expect(event!.event_type).toBe("CompactionTriggered");
    });

    it("maps tool.execute.before to ToolCallRequested", () => {
      const event = integration.normalizeEvent("tool.execute.before", {
        session_id: "s1",
        tool_name: "file_edit",
        tool_input: { path: "/src/main.ts" },
      });

      expect(event!.event_type).toBe("ToolCallRequested");
    });

    it("maps tool.execute.after without error to ToolCallCompleted", () => {
      const event = integration.normalizeEvent("tool.execute.after", {
        session_id: "s1",
        tool_name: "file_edit",
        tool_output: "success",
      });

      expect(event!.event_type).toBe("ToolCallCompleted");
    });

    it("maps tool.execute.after with error to ToolCallFailed", () => {
      const event = integration.normalizeEvent("tool.execute.after", {
        session_id: "s1",
        tool_name: "file_edit",
        error: "Permission denied",
      });

      expect(event!.event_type).toBe("ToolCallFailed");
    });

    it("maps message.updated with role=user to UserPromptReceived", () => {
      const event = integration.normalizeEvent("message.updated", {
        session_id: "s1",
        role: "user",
        content: "Fix the bug",
        message_id: "msg-1",
      });

      expect(event).not.toBeNull();
      expect(event!.event_type).toBe("UserPromptReceived");
    });

    it("filters message.updated with role != user (returns null)", () => {
      const event = integration.normalizeEvent("message.updated", {
        session_id: "s1",
        role: "assistant",
        content: "I'll fix it",
      });

      expect(event).toBeNull();
    });

    it("filters message.updated with role=system (returns null)", () => {
      const event = integration.normalizeEvent("message.updated", {
        session_id: "s1",
        role: "system",
        content: "System message",
      });

      expect(event).toBeNull();
    });

    it("maps permission.asked to PermissionRequested", () => {
      const event = integration.normalizeEvent("permission.asked", {
        session_id: "s1",
        tool_name: "bash",
        description: "Run a shell command",
        permission_id: "perm-1",
      });

      expect(event!.event_type).toBe("PermissionRequested");
    });

    it("maps permission.replied to PermissionResponded", () => {
      const event = integration.normalizeEvent("permission.replied", {
        session_id: "s1",
        permission_id: "perm-1",
        granted: true,
      });

      expect(event!.event_type).toBe("PermissionResponded");
    });

    it("returns null for unknown event types", () => {
      const event = integration.normalizeEvent("unknown.event", {
        session_id: "s1",
      });

      expect(event).toBeNull();
    });

    it("includes agent_provider as 'opencode'", () => {
      const event = integration.normalizeEvent("session.created", {
        session_id: "s1",
      });

      expect(event!.agent_provider).toBe("opencode");
    });

    it("preserves full payload in data field", () => {
      const payload = {
        session_id: "s1",
        model: "gpt-4o",
        cwd: "/home/user",
        extra_field: "extra",
      };
      const event = integration.normalizeEvent("session.created", payload);

      expect(event!.data).toEqual(payload);
    });

    it("generates unique event IDs", () => {
      const e1 = integration.normalizeEvent("session.created", { session_id: "s1" });
      const e2 = integration.normalizeEvent("session.created", { session_id: "s1" });

      expect(e1!.event_id).not.toBe(e2!.event_id);
    });

    it("increments sequence per session", () => {
      const e1 = integration.normalizeEvent("session.created", { session_id: "s1" });
      const e2 = integration.normalizeEvent("tool.execute.before", { session_id: "s1" });

      expect(e1!.sequence).toBe(1);
      expect(e2!.sequence).toBe(2);
    });

    it("event envelope includes all 10 required fields", () => {
      const event = integration.normalizeEvent("session.created", { session_id: "s1" });

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
  });

  // -------------------------------------------------------------------
  // Capture Lifecycle
  // -------------------------------------------------------------------

  describe("startCapture / stopCapture", () => {
    it("registers and clears capture callback", async () => {
      const events: EventEnvelope[] = [];
      await integration.startCapture((e) => events.push(e));

      integration.handleIncomingEvent("session.created", { session_id: "s1" });
      expect(events).toHaveLength(1);

      await integration.stopCapture();

      integration.handleIncomingEvent("session.created", { session_id: "s1" });
      expect(events).toHaveLength(1); // No new event after stop
    });

    it("filters non-user messages during capture", async () => {
      const events: EventEnvelope[] = [];
      await integration.startCapture((e) => events.push(e));

      integration.handleIncomingEvent("message.updated", {
        session_id: "s1",
        role: "assistant",
        content: "response",
      });
      expect(events).toHaveLength(0);

      integration.handleIncomingEvent("message.updated", {
        session_id: "s1",
        role: "user",
        content: "prompt",
      });
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // OPENCODE_SUBSCRIBED_EVENTS constant
  // -------------------------------------------------------------------

  describe("OPENCODE_SUBSCRIBED_EVENTS", () => {
    it("defines exactly 9 events", () => {
      expect(OPENCODE_SUBSCRIBED_EVENTS).toHaveLength(9);
    });

    it("includes all expected OpenCode event names", () => {
      const expected = [
        "session.created",
        "session.deleted",
        "session.idle",
        "session.compacted",
        "message.updated",
        "tool.execute.before",
        "tool.execute.after",
        "permission.asked",
        "permission.replied",
      ];
      for (const e of expected) {
        expect(OPENCODE_SUBSCRIBED_EVENTS).toContain(e);
      }
    });
  });
});
