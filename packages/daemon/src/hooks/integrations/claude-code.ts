/**
 * Claude Code hook integration.
 *
 * Claude Code uses a settings.json-based hook system where hooks are
 * registered as shell commands that fire at specific lifecycle points.
 * The 10 hook types map to unified events as defined in Story 03:
 *
 *   SessionStart      -> SessionStarted
 *   UserPromptSubmit  -> UserPromptReceived
 *   PreToolUse        -> ToolCallRequested
 *   PostToolUse       -> ToolCallCompleted
 *   PostToolUseFailure -> ToolCallFailed
 *   SubagentStart     -> AgentSpawned
 *   SubagentStop      -> AgentCompleted
 *   Stop              -> TurnCompleted
 *   PreCompact        -> CompactionTriggered
 *   SessionEnd        -> SessionEnded
 *
 * Hook installation modifies ~/.claude/settings.json to register
 * the agentctx-hook script as the handler for each hook type.
 */

import { readFile, writeFile, mkdir, access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  HookIntegration,
  InstallOptions,
  InstallResult,
  HealthCheckResult,
  HealthCheck,
} from "../hook-manager.js";
import type { EventEnvelope } from "../../event-bus/event-bus.js";

const execFileAsync = promisify(execFile);

/**
 * The 10 Claude Code hook definitions mapping native hook names to
 * unified event types, with async/sync classification and matchers.
 */
export interface ClaudeCodeHookDef {
  /** Claude Code native hook name (the key in settings.json hooks) */
  nativeEvent: string;
  /** The unified event type this maps to */
  unifiedEvent: string;
  /** Whether this hook runs asynchronously */
  async: boolean;
  /** Timeout in milliseconds */
  timeout: number;
  /** Tool matcher (empty string = no matcher, ".*" = all tools) */
  matcher?: string;
}

export const CLAUDE_CODE_HOOKS: readonly ClaudeCodeHookDef[] = Object.freeze([
  { nativeEvent: "SessionStart", unifiedEvent: "SessionStarted", async: false, timeout: 5000 },
  { nativeEvent: "UserPromptSubmit", unifiedEvent: "UserPromptReceived", async: false, timeout: 5000 },
  { nativeEvent: "PreToolUse", unifiedEvent: "ToolCallRequested", async: true, timeout: 5000, matcher: ".*" },
  { nativeEvent: "PostToolUse", unifiedEvent: "ToolCallCompleted", async: true, timeout: 5000, matcher: ".*" },
  { nativeEvent: "PostToolUseFailure", unifiedEvent: "ToolCallFailed", async: true, timeout: 5000, matcher: ".*" },
  { nativeEvent: "SubagentStart", unifiedEvent: "AgentSpawned", async: true, timeout: 5000, matcher: ".*" },
  { nativeEvent: "SubagentStop", unifiedEvent: "AgentCompleted", async: true, timeout: 5000, matcher: ".*" },
  { nativeEvent: "Stop", unifiedEvent: "TurnCompleted", async: true, timeout: 5000 },
  { nativeEvent: "PreCompact", unifiedEvent: "CompactionTriggered", async: false, timeout: 5000 },
  { nativeEvent: "SessionEnd", unifiedEvent: "SessionEnded", async: true, timeout: 5000 },
]);

/**
 * Codeguard PreToolUse hook definition.
 * This is a separate matcher group for Edit|Write that runs the codeguard
 * anti-pattern scanner before agentctx-hook's general ToolCallRequested.
 */
export const CODEGUARD_HOOK_DEF = Object.freeze({
  nativeEvent: "PreToolUse",
  matcher: "Edit|Write",
  command: "agentctx-codeguard",
  timeout: 10000,
});

/**
 * Reverse mapping: native hook name -> unified event type.
 */
const NATIVE_TO_UNIFIED = new Map<string, string>(
  CLAUDE_CODE_HOOKS.map((h) => [h.nativeEvent, h.unifiedEvent]),
);

/**
 * Claude Code hook integration.
 *
 * Manages the lifecycle of Claude Code hooks via settings.json and
 * normalizes Claude Code native events into unified event envelopes.
 */
export class ClaudeCodeIntegration implements HookIntegration {
  readonly providerId = "claude-code" as const;
  readonly name = "Claude Code";

  private captureCallback: ((event: EventEnvelope) => void) | null = null;

  /** Override for the settings.json path (for testing) */
  private settingsPath: string;
  /** Override for the hook binary path (for testing) */
  private hookBinPath: string;
  /** Sequence counter per session */
  private sessionSequences = new Map<string, number>();

  /** Override for the codeguard binary path (for testing) */
  private codeguardBinPath: string;

  constructor(options?: { settingsPath?: string; hookBinPath?: string; codeguardBinPath?: string }) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    this.settingsPath = options?.settingsPath ?? join(home, ".claude", "settings.json");
    this.hookBinPath = options?.hookBinPath ?? join(home, ".agentctx", "bin", "agentctx-hook");
    this.codeguardBinPath = options?.codeguardBinPath ?? join(home, ".agentctx", "bin", "agentctx-codeguard");
  }

  /**
   * Install Claude Code hooks by modifying ~/.claude/settings.json.
   *
   * Creates a backup of the existing file before modification.
   * Preserves any user-defined hooks that are not agentctx/gc hooks.
   */
  async install(options?: InstallOptions): Promise<InstallResult> {
    const settingsPath = options?.baseDir
      ? join(options.baseDir, ".claude", "settings.json")
      : this.settingsPath;

    const modifiedFiles: string[] = [];

    try {
      // Ensure parent directory exists
      await mkdir(dirname(settingsPath), { recursive: true });

      // Read existing settings or create empty object
      let settings: Record<string, unknown> = {};
      try {
        const content = await readFile(settingsPath, "utf-8");
        settings = JSON.parse(content);
      } catch {
        // File doesn't exist or invalid JSON, start fresh
      }

      // Create backup if file exists
      try {
        await access(settingsPath, fsConstants.F_OK);
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
        const backupPath = `${settingsPath}.bak.${ts}`;
        const content = await readFile(settingsPath, "utf-8");
        await writeFile(backupPath, content, "utf-8");
        modifiedFiles.push(backupPath);
      } catch {
        // No existing file to back up
      }

      // Build hook configuration
      const hooks: Record<string, unknown[]> = (settings.hooks as Record<string, unknown[]>) ?? {};

      // --- Codeguard hook: Edit|Write anti-pattern scanner ---
      {
        const codeguardEntry = {
          matcher: CODEGUARD_HOOK_DEF.matcher,
          hooks: [
            {
              type: "command",
              command: this.codeguardBinPath,
              timeout: CODEGUARD_HOOK_DEF.timeout,
            },
          ],
        };

        const existingPreToolUse = (hooks.PreToolUse ?? []) as Record<string, unknown>[];

        // Remove old codeguard entries and old inline jq/grep checks
        const filtered = existingPreToolUse.filter((h) => {
          const innerHooks = (h.hooks ?? []) as Record<string, unknown>[];
          const hasCodeguard = innerHooks.some((ih) =>
            String(ih.command ?? "").includes("agentctx-codeguard"),
          );
          const hasOldInlineCheck = innerHooks.some((ih) =>
            String(ih.command ?? "").includes("jq") && String(ih.command ?? "").includes("grep"),
          );
          return !hasCodeguard && !hasOldInlineCheck;
        });

        // Prepend codeguard (runs before other PreToolUse hooks)
        hooks.PreToolUse = [codeguardEntry, ...filtered];
      }

      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const hookEntry: Record<string, unknown> = {
          type: "command",
          command: `${this.hookBinPath} claude-code ${hookDef.unifiedEvent}`,
          async: hookDef.async,
          timeout: hookDef.timeout,
        };

        if (hookDef.matcher !== undefined) {
          hookEntry.matcher = hookDef.matcher;
        }

        // Get existing hooks for this event, filtering out old gc-hook and agentctx-hook entries
        const existingHooks = (hooks[hookDef.nativeEvent] ?? []) as Record<string, unknown>[];
        const userHooks = existingHooks.filter((h) => {
          const cmd = String(h.command ?? "");
          return !cmd.includes("gc-hook") && !cmd.includes("agentctx-hook");
        });

        // If not force, check if agentctx-hook already present and skip
        if (!options?.force) {
          const hasAgentCtx = existingHooks.some((h) =>
            String(h.command ?? "").includes("agentctx-hook"),
          );
          if (hasAgentCtx) {
            // Update existing entry in-place
            hooks[hookDef.nativeEvent] = [hookEntry, ...userHooks];
            continue;
          }
        }

        hooks[hookDef.nativeEvent] = [hookEntry, ...userHooks];
      }

      settings.hooks = hooks;

      // Write updated settings.json
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      modifiedFiles.push(settingsPath);

      // Validate the written file
      const written = await readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(written);
      const writtenHooks = parsed.hooks ?? {};
      let hookCount = 0;
      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries = writtenHooks[hookDef.nativeEvent] ?? [];
        if (entries.some((h: Record<string, unknown>) =>
          String(h.command ?? "").includes("agentctx-hook"),
        )) {
          hookCount++;
        }
      }

      return {
        success: hookCount === 10,
        message: `Claude Code hooks installed (${hookCount}/10 events)`,
        modifiedFiles,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install Claude Code hooks: ${err instanceof Error ? err.message : String(err)}`,
        modifiedFiles,
      };
    }
  }

  /**
   * Uninstall Claude Code hooks by removing agentctx-hook and codeguard entries from settings.json.
   * Preserves user-defined hooks.
   */
  async uninstall(): Promise<void> {
    try {
      const content = await readFile(this.settingsPath, "utf-8");
      const settings = JSON.parse(content);
      const hooks: Record<string, unknown[]> = settings.hooks ?? {};

      // Remove codeguard matcher groups from PreToolUse
      if (hooks.PreToolUse) {
        hooks.PreToolUse = (hooks.PreToolUse as Record<string, unknown>[]).filter((h) => {
          const innerHooks = (h.hooks ?? []) as Record<string, unknown>[];
          return !innerHooks.some((ih) =>
            String(ih.command ?? "").includes("agentctx-codeguard"),
          );
        });
      }

      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries = (hooks[hookDef.nativeEvent] ?? []) as Record<string, unknown>[];
        const filtered = entries.filter(
          (h) => !String(h.command ?? "").includes("agentctx-hook"),
        );
        if (filtered.length > 0) {
          hooks[hookDef.nativeEvent] = filtered;
        } else {
          delete hooks[hookDef.nativeEvent];
        }
      }

      settings.hooks = hooks;
      await writeFile(this.settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch {
      // If file doesn't exist or can't be parsed, nothing to uninstall
    }
  }

  /**
   * Check Claude Code hook health.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = [];

    // Check 1: Claude Code binary installed
    const agentInstalled = await this.isAgentInstalled();
    checks.push({
      name: "Claude Code binary",
      passed: agentInstalled,
      detail: agentInstalled ? "claude binary found in PATH" : "claude binary not found in PATH",
    });

    // Check 2: settings.json exists and is valid JSON
    let settingsValid = false;
    let settingsObj: Record<string, unknown> = {};
    try {
      const content = await readFile(this.settingsPath, "utf-8");
      settingsObj = JSON.parse(content);
      settingsValid = true;
    } catch {
      // invalid
    }
    checks.push({
      name: "settings.json",
      passed: settingsValid,
      detail: settingsValid
        ? `Valid JSON at ${this.settingsPath}`
        : `Missing or invalid at ${this.settingsPath}`,
    });

    // Check 3: All 10 hooks registered
    let hookCount = 0;
    if (settingsValid) {
      const hooks = (settingsObj.hooks ?? {}) as Record<string, unknown[]>;
      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries = (hooks[hookDef.nativeEvent] ?? []) as Record<string, unknown>[];
        if (
          entries.some((h) => String(h.command ?? "").includes("agentctx-hook"))
        ) {
          hookCount++;
        }
      }
    }
    checks.push({
      name: "Hook registration",
      passed: hookCount === 10,
      detail: `${hookCount}/10 hooks registered`,
    });

    // Check 4: agentctx-hook is executable
    let hookExecutable = false;
    try {
      await access(this.hookBinPath, fsConstants.X_OK);
      hookExecutable = true;
    } catch {
      // not executable
    }
    checks.push({
      name: "Hook wrapper executable",
      passed: hookExecutable,
      detail: hookExecutable
        ? `${this.hookBinPath} is executable`
        : `${this.hookBinPath} is not executable or missing`,
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Hot-reload Claude Code hook configuration.
   * Re-reads settings.json and verifies hooks are still present.
   */
  async reload(): Promise<void> {
    // Re-read and validate settings.json
    try {
      const content = await readFile(this.settingsPath, "utf-8");
      const settings = JSON.parse(content);
      const hooks = settings.hooks ?? {};
      let hookCount = 0;
      for (const hookDef of CLAUDE_CODE_HOOKS) {
        const entries = (hooks[hookDef.nativeEvent] ?? []) as Record<string, unknown>[];
        if (
          entries.some((h: Record<string, unknown>) =>
            String(h.command ?? "").includes("agentctx-hook"),
          )
        ) {
          hookCount++;
        }
      }
      if (hookCount < 10) {
        // Warn: hooks were modified externally
      }
    } catch {
      // settings.json unreadable
    }
  }

  /**
   * Check if Claude Code is installed on this system.
   */
  async isAgentInstalled(): Promise<boolean> {
    try {
      await execFileAsync("which", ["claude"]);
      return true;
    } catch {
      // Check for ~/.claude directory as fallback
      try {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
        const s = await stat(join(home, ".claude"));
        return s.isDirectory();
      } catch {
        return false;
      }
    }
  }

  /**
   * Start capturing events from Claude Code.
   * Registers the callback for event delivery.
   */
  async startCapture(
    callback: (event: EventEnvelope) => void,
  ): Promise<void> {
    this.captureCallback = callback;
  }

  /**
   * Stop capturing events from Claude Code.
   */
  async stopCapture(): Promise<void> {
    this.captureCallback = null;
  }

  /**
   * Get the next sequence number for a session.
   */
  private nextSequence(sessionId: string): number {
    const current = this.sessionSequences.get(sessionId) ?? 0;
    const next = current + 1;
    this.sessionSequences.set(sessionId, next);
    return next;
  }

  /**
   * Normalize a Claude Code native event into a unified event envelope.
   *
   * @param nativeEventType - The Claude Code hook type (e.g., "PostToolUse")
   * @param payload - The raw payload from the hook
   * @returns Normalized event envelope
   */
  normalizeEvent(
    nativeEventType: string,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    const unifiedType = NATIVE_TO_UNIFIED.get(nativeEventType);
    if (!unifiedType) {
      throw new Error(`Unknown Claude Code native event: ${nativeEventType}`);
    }

    const sessionId = String(payload.session_id ?? "unknown");
    const projectId = String(payload.project_id ?? "unknown");

    return {
      event_id: crypto.randomUUID(),
      event_type: unifiedType,
      project_id: projectId,
      session_id: sessionId,
      sequence: this.nextSequence(sessionId),
      timestamp: new Date().toISOString(),
      agent_provider: "claude-code",
      agent_native_event: nativeEventType,
      agent_metadata: {
        agent_version: payload.agent_version as string | undefined,
        model: payload.model as string | undefined,
        agent_pid: payload.agent_pid as number | undefined,
        cwd: payload.cwd as string | undefined,
      },
      data: payload,
    };
  }

  /**
   * Handle an incoming event from the Claude Code hooks pipeline.
   * This is called by the daemon event intake when it receives
   * an event tagged with agent_provider "claude-code".
   */
  handleIncomingEvent(
    nativeEventType: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.captureCallback) {
      const envelope = this.normalizeEvent(nativeEventType, payload);
      this.captureCallback(envelope);
    }
  }
}
