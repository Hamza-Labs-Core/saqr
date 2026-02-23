/**
 * Tests for the Claude Code hook integration.
 *
 * Covers: install hooks into settings.json, validate hook config,
 * uninstall, health checks, event normalization, idempotent install,
 * migration from GC hooks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClaudeCodeIntegration,
  CLAUDE_CODE_HOOKS,
} from "../hooks/integrations/claude-code.js";
import type { EventEnvelope } from "../event-bus/event-bus.js";

describe("ClaudeCodeIntegration", () => {
  let tempDir: string;
  let settingsPath: string;
  let hookBinPath: string;
  let integration: ClaudeCodeIntegration;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "saqr-test-cc-"));
    settingsPath = join(tempDir, ".claude", "settings.json");
    hookBinPath = join(tempDir, ".agentctx", "bin", "agentctx-hook");
    integration = new ClaudeCodeIntegration({ settingsPath, hookBinPath });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------

  describe("install", () => {
    it("creates settings.json with all 10 hooks", async () => {
      const result = await integration.install();

      expect(result.success).toBe(true);
      expect(result.message).toContain("10/10");

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      const hooks = settings.hooks;

      expect(Object.keys(hooks)).toHaveLength(10);

      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries = hooks[hookDef.nativeEvent];
        expect(entries).toBeDefined();
        expect(entries).toHaveLength(1);
        expect(entries[0].command).toContain("agentctx-hook");
        expect(entries[0].command).toContain("claude-code");
        expect(entries[0].command).toContain(hookDef.unifiedEvent);
        expect(entries[0].type).toBe("command");
        expect(entries[0].async).toBe(hookDef.async);
        expect(entries[0].timeout).toBe(hookDef.timeout);
      }
    });

    it("preserves existing non-hook settings", async () => {
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({ allowedTools: ["Write", "Read"], theme: "dark" }),
      );

      const result = await integration.install();
      expect(result.success).toBe(true);

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      expect(settings.allowedTools).toEqual(["Write", "Read"]);
      expect(settings.theme).toBe("dark");
    });

    it("preserves user-defined hooks (non-gc, non-agentctx)", async () => {
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      const userHook = {
        type: "command",
        command: "/my/custom/hook --arg1",
        async: true,
        timeout: 3000,
      };
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [userHook],
          },
        }),
      );

      const result = await integration.install();
      expect(result.success).toBe(true);

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      // Should have both the agentctx hook and the user hook
      const postToolUse = settings.hooks.PostToolUse;
      expect(postToolUse).toHaveLength(2);
      expect(postToolUse[0].command).toContain("agentctx-hook");
      expect(postToolUse[1].command).toBe("/my/custom/hook --arg1");
    });

    it("replaces existing gc-hook entries during migration", async () => {
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                type: "command",
                command: "~/.gc/bin/gc-hook PostToolUse",
                async: true,
                timeout: 5000,
                matcher: ".*",
              },
            ],
          },
        }),
      );

      const result = await integration.install();
      expect(result.success).toBe(true);

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      const entries = settings.hooks.PostToolUse;
      expect(entries).toHaveLength(1);
      expect(entries[0].command).toContain("agentctx-hook");
      expect(entries[0].command).not.toContain("gc-hook");
    });

    it("is idempotent (running twice produces same result)", async () => {
      await integration.install();
      const first = await readFile(settingsPath, "utf-8");

      await integration.install();
      const second = await readFile(settingsPath, "utf-8");

      // Both should have 10 hooks with identical config
      const settings1 = JSON.parse(first);
      const settings2 = JSON.parse(second);

      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries1 = settings1.hooks[hookDef.nativeEvent];
        const entries2 = settings2.hooks[hookDef.nativeEvent];
        expect(entries1).toHaveLength(1);
        expect(entries2).toHaveLength(1);
        expect(entries1[0].command).toEqual(entries2[0].command);
      }
    });

    it("creates backup of existing settings.json", async () => {
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ existing: true }));

      const result = await integration.install();

      // Should have two files: original backup + modified settings
      expect(result.modifiedFiles.length).toBeGreaterThanOrEqual(2);
      const backupFile = result.modifiedFiles.find((f) => f.includes(".bak."));
      expect(backupFile).toBeDefined();

      const backupContent = await readFile(backupFile!, "utf-8");
      expect(JSON.parse(backupContent)).toEqual({ existing: true });
    });

    it("creates parent directories if they don't exist", async () => {
      // settings.json doesn't exist yet, nor does the .claude directory
      const result = await integration.install();
      expect(result.success).toBe(true);

      const content = await readFile(settingsPath, "utf-8");
      expect(JSON.parse(content).hooks).toBeDefined();
    });

    it("hooks have correct async/sync classification from Story 02", async () => {
      await integration.install();
      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      // Sync hooks: SessionStart, UserPromptSubmit, PreCompact
      expect(settings.hooks.SessionStart[0].async).toBe(false);
      expect(settings.hooks.UserPromptSubmit[0].async).toBe(false);
      expect(settings.hooks.PreCompact[0].async).toBe(false);

      // Async hooks: all others
      expect(settings.hooks.PreToolUse[0].async).toBe(true);
      expect(settings.hooks.PostToolUse[0].async).toBe(true);
      expect(settings.hooks.PostToolUseFailure[0].async).toBe(true);
      expect(settings.hooks.SubagentStart[0].async).toBe(true);
      expect(settings.hooks.SubagentStop[0].async).toBe(true);
      expect(settings.hooks.Stop[0].async).toBe(true);
      expect(settings.hooks.SessionEnd[0].async).toBe(true);
    });

    it("hooks have correct matchers from Story 02", async () => {
      await integration.install();
      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      // Tool-related hooks have ".*" matcher
      expect(settings.hooks.PreToolUse[0].matcher).toBe(".*");
      expect(settings.hooks.PostToolUse[0].matcher).toBe(".*");
      expect(settings.hooks.PostToolUseFailure[0].matcher).toBe(".*");
      expect(settings.hooks.SubagentStart[0].matcher).toBe(".*");
      expect(settings.hooks.SubagentStop[0].matcher).toBe(".*");

      // Non-tool hooks don't have matcher
      expect(settings.hooks.SessionStart[0].matcher).toBeUndefined();
      expect(settings.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
      expect(settings.hooks.Stop[0].matcher).toBeUndefined();
      expect(settings.hooks.PreCompact[0].matcher).toBeUndefined();
      expect(settings.hooks.SessionEnd[0].matcher).toBeUndefined();
    });

    it("all timeouts remain at 5000ms", async () => {
      await integration.install();
      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      for (const hookDef of CLAUDE_CODE_HOOKS) {
        expect(settings.hooks[hookDef.nativeEvent][0].timeout).toBe(5000);
      }
    });
  });

  // -------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------

  describe("uninstall", () => {
    it("removes agentctx-hook entries from settings.json", async () => {
      await integration.install();
      await integration.uninstall();

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      // All hook arrays should be empty (no entries)
      const allHookEntries = Object.values(settings.hooks).flat();
      expect(allHookEntries).toHaveLength(0);
    });

    it("preserves user-defined hooks during uninstall", async () => {
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { type: "command", command: "/my/hook", async: true, timeout: 3000 },
              { type: "command", command: `${hookBinPath} claude-code ToolCallCompleted`, async: true, timeout: 5000, matcher: ".*" },
            ],
          },
        }),
      );

      // Create new integration with this settings path
      const int = new ClaudeCodeIntegration({ settingsPath, hookBinPath });
      await int.uninstall();

      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);

      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse[0].command).toBe("/my/hook");
    });

    it("handles missing settings.json gracefully", async () => {
      await expect(integration.uninstall()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------

  describe("healthCheck", () => {
    it("returns healthy when hooks are installed", async () => {
      // Create hook binary (mock)
      await mkdir(join(tempDir, ".agentctx", "bin"), { recursive: true });
      await writeFile(hookBinPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      await integration.install();
      const result = await integration.healthCheck();

      // The "Claude Code binary" check may fail (no claude in PATH in test),
      // but the settings.json and hook registration checks should pass
      const settingsCheck = result.checks.find((c) => c.name === "settings.json");
      expect(settingsCheck?.passed).toBe(true);

      const hooksCheck = result.checks.find((c) => c.name === "Hook registration");
      expect(hooksCheck?.passed).toBe(true);
      expect(hooksCheck?.detail).toBe("10/10 hooks registered");

      const execCheck = result.checks.find((c) => c.name === "Hook wrapper executable");
      expect(execCheck?.passed).toBe(true);
    });

    it("reports failing checks when hooks are not installed", async () => {
      const result = await integration.healthCheck();

      const settingsCheck = result.checks.find((c) => c.name === "settings.json");
      expect(settingsCheck?.passed).toBe(false);

      const hooksCheck = result.checks.find((c) => c.name === "Hook registration");
      expect(hooksCheck?.passed).toBe(false);
      expect(hooksCheck?.detail).toBe("0/10 hooks registered");
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
    it("maps PostToolUse to ToolCallCompleted", () => {
      const event = integration.normalizeEvent("PostToolUse", {
        session_id: "sess-1",
        project_id: "proj-1",
        tool_name: "Write",
        tool_input: { file_path: "/src/main.ts" },
      });

      expect(event.event_type).toBe("ToolCallCompleted");
      expect(event.agent_provider).toBe("claude-code");
      expect(event.agent_native_event).toBe("PostToolUse");
      expect(event.session_id).toBe("sess-1");
      expect(event.project_id).toBe("proj-1");
    });

    it("maps all 10 Claude Code native events correctly", () => {
      const mappings: Record<string, string> = {
        SessionStart: "SessionStarted",
        UserPromptSubmit: "UserPromptReceived",
        PreToolUse: "ToolCallRequested",
        PostToolUse: "ToolCallCompleted",
        PostToolUseFailure: "ToolCallFailed",
        SubagentStart: "AgentSpawned",
        SubagentStop: "AgentCompleted",
        Stop: "TurnCompleted",
        PreCompact: "CompactionTriggered",
        SessionEnd: "SessionEnded",
      };

      for (const [native, unified] of Object.entries(mappings)) {
        const event = integration.normalizeEvent(native, { session_id: "s1" });
        expect(event.event_type).toBe(unified);
        expect(event.agent_native_event).toBe(native);
      }
    });

    it("throws for unknown native event type", () => {
      expect(() =>
        integration.normalizeEvent("UnknownHook", { session_id: "s1" }),
      ).toThrow("Unknown Claude Code native event");
    });

    it("generates unique event IDs", () => {
      const e1 = integration.normalizeEvent("PostToolUse", { session_id: "s1" });
      const e2 = integration.normalizeEvent("PostToolUse", { session_id: "s1" });

      expect(e1.event_id).not.toBe(e2.event_id);
    });

    it("increments sequence numbers per session", () => {
      const e1 = integration.normalizeEvent("SessionStart", { session_id: "s1" });
      const e2 = integration.normalizeEvent("PostToolUse", { session_id: "s1" });
      const e3 = integration.normalizeEvent("Stop", { session_id: "s1" });

      expect(e1.sequence).toBe(1);
      expect(e2.sequence).toBe(2);
      expect(e3.sequence).toBe(3);
    });

    it("maintains independent sequences for different sessions", () => {
      const e1 = integration.normalizeEvent("SessionStart", { session_id: "s1" });
      const e2 = integration.normalizeEvent("SessionStart", { session_id: "s2" });
      const e3 = integration.normalizeEvent("PostToolUse", { session_id: "s1" });

      expect(e1.sequence).toBe(1);
      expect(e2.sequence).toBe(1);
      expect(e3.sequence).toBe(2);
    });

    it("includes agent_provider as 'claude-code'", () => {
      const event = integration.normalizeEvent("PostToolUse", { session_id: "s1" });
      expect(event.agent_provider).toBe("claude-code");
    });

    it("preserves full payload in data field", () => {
      const payload = {
        session_id: "s1",
        tool_name: "Write",
        tool_input: { file_path: "/x.ts", content: "hello" },
        tool_response: "File written",
        tool_use_id: "tu_123",
      };
      const event = integration.normalizeEvent("PostToolUse", payload);

      expect(event.data).toEqual(payload);
    });

    it("extracts agent metadata from payload", () => {
      const event = integration.normalizeEvent("PostToolUse", {
        session_id: "s1",
        agent_version: "claude-code/1.0.38",
        model: "claude-opus-4-6",
        agent_pid: 12345,
        cwd: "/home/user/project",
      });

      expect(event.agent_metadata).toEqual({
        agent_version: "claude-code/1.0.38",
        model: "claude-opus-4-6",
        agent_pid: 12345,
        cwd: "/home/user/project",
      });
    });

    it("generates ISO 8601 timestamp", () => {
      const event = integration.normalizeEvent("PostToolUse", { session_id: "s1" });
      // ISO 8601 timestamp check
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("event envelope includes all 10 required fields", () => {
      const event = integration.normalizeEvent("PostToolUse", { session_id: "s1" });

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

      integration.handleIncomingEvent("PostToolUse", { session_id: "s1" });
      expect(events).toHaveLength(1);

      await integration.stopCapture();

      integration.handleIncomingEvent("PostToolUse", { session_id: "s1" });
      expect(events).toHaveLength(1); // No new event after stop
    });
  });

  // -------------------------------------------------------------------
  // CLAUDE_CODE_HOOKS constant
  // -------------------------------------------------------------------

  describe("CLAUDE_CODE_HOOKS", () => {
    it("defines exactly 10 hooks", () => {
      expect(CLAUDE_CODE_HOOKS).toHaveLength(10);
    });

    it("every hook has required fields", () => {
      for (const hook of CLAUDE_CODE_HOOKS) {
        expect(typeof hook.nativeEvent).toBe("string");
        expect(typeof hook.unifiedEvent).toBe("string");
        expect(typeof hook.async).toBe("boolean");
        expect(hook.timeout).toBe(5000);
      }
    });
  });
});
