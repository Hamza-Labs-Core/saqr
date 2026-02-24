/**
 * Codex hook integration.
 *
 * Codex uses a JSONL protocol over session file watchers. Events are
 * captured by watching Codex session files for new JSONL entries.
 *
 * Codex event mapping to unified events (Story 03):
 *
 *   Process spawn detected  -> SessionStarted
 *   stdin message parse     -> UserPromptReceived
 *   JSONL tool_use          -> ToolCallRequested
 *   JSONL tool_result       -> ToolCallCompleted
 *   JSONL tool_error        -> ToolCallFailed
 *   JSONL turn_end          -> TurnCompleted
 *   Process exit detected   -> SessionEnded
 *   JSONL permission        -> PermissionRequested
 *   JSONL permission_response -> PermissionResponded
 *
 * Note: Codex does not support AgentSpawned, AgentCompleted,
 * or CompactionTriggered.
 */

import { readFile, writeFile, mkdir, access, stat, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
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
 * Mapping from Codex JSONL message types to unified event types.
 */
export const CODEX_MESSAGE_MAP: Record<string, string> = {
  tool_use: "ToolCallRequested",
  tool_result: "ToolCallCompleted",
  tool_error: "ToolCallFailed",
  turn_end: "TurnCompleted",
  permission: "PermissionRequested",
  permission_response: "PermissionResponded",
};

/**
 * Codex hook integration.
 *
 * Manages the lifecycle of Codex JSONL-based hooks and normalizes
 * Codex events into unified event envelopes.
 */
export class CodexIntegration implements HookIntegration {
  readonly providerId = "codex" as const;
  readonly name = "Codex";

  private captureCallback: ((event: EventEnvelope) => void) | null = null;
  private sessionDir: string;
  private configDir: string;
  private sessionSequences = new Map<string, number>();

  constructor(options?: { sessionDir?: string; configDir?: string }) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    this.sessionDir = options?.sessionDir ?? join(home, ".codex", "sessions");
    this.configDir = options?.configDir ?? join(home, ".agentctx", "integrations", "codex");
  }

  /**
   * Install Codex hooks by setting up a session file watcher configuration.
   */
  async install(options?: InstallOptions): Promise<InstallResult> {
    const configDir = options?.baseDir
      ? join(options.baseDir, ".agentctx", "integrations", "codex")
      : this.configDir;

    const modifiedFiles: string[] = [];

    try {
      // Create config directory
      await mkdir(configDir, { recursive: true });

      // Ensure session directory exists
      const sessionDir = options?.baseDir
        ? join(options.baseDir, ".codex", "sessions")
        : this.sessionDir;
      await mkdir(sessionDir, { recursive: true });

      // Write watcher configuration
      const watcherConfigPath = join(configDir, "watcher.json");
      const watcherConfig = {
        enabled: true,
        session_dir: sessionDir,
        protocol: "jsonl",
        message_types: Object.keys(CODEX_MESSAGE_MAP),
        created_at: new Date().toISOString(),
      };

      await writeFile(
        watcherConfigPath,
        JSON.stringify(watcherConfig, null, 2) + "\n",
        "utf-8",
      );
      modifiedFiles.push(watcherConfigPath);

      return {
        success: true,
        message: "Codex session watcher configured",
        modifiedFiles,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to configure Codex watcher: ${err instanceof Error ? err.message : String(err)}`,
        modifiedFiles,
      };
    }
  }

  /**
   * Uninstall Codex hooks by removing the watcher configuration.
   */
  async uninstall(): Promise<void> {
    try {
      await rm(this.configDir, { recursive: true, force: true });
    } catch {
      // Nothing to uninstall
    }
  }

  /**
   * Check Codex hook health.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = [];

    // Check 1: Codex binary installed
    const agentInstalled = await this.isAgentInstalled();
    checks.push({
      name: "Codex binary",
      passed: agentInstalled,
      detail: agentInstalled ? "codex binary found" : "codex binary not found",
    });

    // Check 2: Session directory exists and is readable
    let sessionDirOk = false;
    try {
      const s = await stat(this.sessionDir);
      sessionDirOk = s.isDirectory();
    } catch {
      // Does not exist
    }
    checks.push({
      name: "Session directory",
      passed: sessionDirOk,
      detail: sessionDirOk ? `${this.sessionDir} accessible` : `${this.sessionDir} not found`,
    });

    // Check 3: Watcher config exists and is valid
    let configValid = false;
    try {
      const configPath = join(this.configDir, "watcher.json");
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      configValid = config.enabled === true;
    } catch {
      // Invalid
    }
    checks.push({
      name: "Watcher configuration",
      passed: configValid,
      detail: configValid ? "Watcher config valid and enabled" : "Watcher config missing or disabled",
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Hot-reload Codex hook configuration.
   */
  async reload(): Promise<void> {
    try {
      const configPath = join(this.configDir, "watcher.json");
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (config.session_dir) {
        this.sessionDir = config.session_dir;
      }
    } catch {
      // Config unreadable
    }
  }

  /**
   * Check if Codex is installed on this system.
   */
  async isAgentInstalled(): Promise<boolean> {
    try {
      await execFileAsync("which", ["codex"]);
      return true;
    } catch {
      // Check for ~/.codex directory as fallback
      try {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
        const s = await stat(join(home, ".codex"));
        return s.isDirectory();
      } catch {
        return false;
      }
    }
  }

  /**
   * Start capturing events from Codex.
   */
  async startCapture(
    callback: (event: EventEnvelope) => void,
  ): Promise<void> {
    this.captureCallback = callback;
  }

  /**
   * Stop capturing events from Codex.
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
   * Parse a single JSONL line from a Codex session file.
   * Returns null for malformed lines or unmappable message types.
   */
  parseJsonlLine(line: string, sessionId: string): EventEnvelope | null {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return null; // Malformed JSON line, skip
    }

    const messageType = String(message.type ?? "");

    // Check for user prompt (stdin message with role=user)
    if (message.role === "user" && typeof message.content === "string") {
      return {
        event_id: crypto.randomUUID(),
        event_type: "UserPromptReceived",
        project_id: String(message.project_id ?? "unknown"),
        session_id: sessionId,
        sequence: this.nextSequence(sessionId),
        timestamp: new Date().toISOString(),
        agent_provider: "codex",
        agent_native_event: "stdin_message",
        agent_metadata: {},
        data: message,
      };
    }

    // Map known JSONL message types
    const unifiedType = CODEX_MESSAGE_MAP[messageType];
    if (!unifiedType) return null;

    return {
      event_id: crypto.randomUUID(),
      event_type: unifiedType,
      project_id: String(message.project_id ?? "unknown"),
      session_id: sessionId,
      sequence: this.nextSequence(sessionId),
      timestamp: new Date().toISOString(),
      agent_provider: "codex",
      agent_native_event: messageType,
      agent_metadata: {},
      data: message,
    };
  }

  /**
   * Normalize a Codex JSONL message into a unified event envelope.
   */
  normalizeEvent(
    nativeEventType: string,
    payload: Record<string, unknown>,
  ): EventEnvelope | null {
    const sessionId = String(payload.session_id ?? "unknown");

    // Check for user prompt
    if (nativeEventType === "stdin_message" || (payload.role === "user" && typeof payload.content === "string")) {
      return {
        event_id: crypto.randomUUID(),
        event_type: "UserPromptReceived",
        project_id: String(payload.project_id ?? "unknown"),
        session_id: sessionId,
        sequence: this.nextSequence(sessionId),
        timestamp: new Date().toISOString(),
        agent_provider: "codex",
        agent_native_event: "stdin_message",
        agent_metadata: {},
        data: payload,
      };
    }

    const unifiedType = CODEX_MESSAGE_MAP[nativeEventType];
    if (!unifiedType) return null;

    return {
      event_id: crypto.randomUUID(),
      event_type: unifiedType,
      project_id: String(payload.project_id ?? "unknown"),
      session_id: sessionId,
      sequence: this.nextSequence(sessionId),
      timestamp: new Date().toISOString(),
      agent_provider: "codex",
      agent_native_event: nativeEventType,
      agent_metadata: {},
      data: payload,
    };
  }

  /**
   * Emit a SessionStarted event for a newly detected session.
   */
  emitSessionStarted(sessionId: string): void {
    if (this.captureCallback) {
      this.captureCallback({
        event_id: crypto.randomUUID(),
        event_type: "SessionStarted",
        project_id: "unknown",
        session_id: sessionId,
        sequence: this.nextSequence(sessionId),
        timestamp: new Date().toISOString(),
        agent_provider: "codex",
        agent_native_event: "process_spawn",
        agent_metadata: {},
        data: { session_id: sessionId, source: "process_spawn" },
      });
    }
  }

  /**
   * Emit a SessionEnded event for a session whose process exited.
   */
  emitSessionEnded(sessionId: string, reason: string = "process_exit"): void {
    if (this.captureCallback) {
      this.captureCallback({
        event_id: crypto.randomUUID(),
        event_type: "SessionEnded",
        project_id: "unknown",
        session_id: sessionId,
        sequence: this.nextSequence(sessionId),
        timestamp: new Date().toISOString(),
        agent_provider: "codex",
        agent_native_event: "process_exit",
        agent_metadata: {},
        data: { session_id: sessionId, reason },
      });
    }
  }

  /**
   * Handle an incoming event from the Codex JSONL pipeline.
   */
  handleIncomingEvent(
    nativeEventType: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.captureCallback) {
      const envelope = this.normalizeEvent(nativeEventType, payload);
      if (envelope) {
        this.captureCallback(envelope);
      }
    }
  }
}
