/**
 * OpenCode hook integration.
 *
 * OpenCode uses a plugin-based event system with an HTTP API.
 * Plugins are installed in .opencode/plugins/ and the `opencode serve`
 * command exposes an HTTP API for receiving events.
 *
 * OpenCode event mapping to unified events (Story 03):
 *
 *   session.created      -> SessionStarted
 *   message.updated (user) -> UserPromptReceived
 *   tool.execute.before   -> ToolCallRequested
 *   tool.execute.after    -> ToolCallCompleted
 *   tool.execute.after (err) -> ToolCallFailed
 *   session.idle          -> TurnCompleted
 *   session.compacted     -> CompactionTriggered
 *   session.deleted       -> SessionEnded
 *   permission.asked      -> PermissionRequested
 *   permission.replied    -> PermissionResponded
 *
 * Note: OpenCode does not support AgentSpawned or AgentCompleted.
 */

import { readFile, writeFile, mkdir, access, stat, rm } from "node:fs/promises";
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
 * Direct mapping from OpenCode native events to unified event types.
 * tool.execute.after is special: disambiguated by the error field in the payload.
 * message.updated is special: only user-role messages map to UserPromptReceived.
 */
const OPENCODE_EVENT_MAP: Record<string, string> = {
  "session.created": "SessionStarted",
  "session.deleted": "SessionEnded",
  "session.idle": "TurnCompleted",
  "session.compacted": "CompactionTriggered",
  "tool.execute.before": "ToolCallRequested",
  "permission.asked": "PermissionRequested",
  "permission.replied": "PermissionResponded",
};

/**
 * The 9 OpenCode events we subscribe to via the plugin manifest.
 */
export const OPENCODE_SUBSCRIBED_EVENTS = [
  "session.created",
  "session.deleted",
  "session.idle",
  "session.compacted",
  "message.updated",
  "tool.execute.before",
  "tool.execute.after",
  "permission.asked",
  "permission.replied",
] as const;

/**
 * Plugin manifest for the agentctx OpenCode plugin.
 */
function createPluginManifest(): Record<string, unknown> {
  return {
    name: "agentctx",
    version: "1.0.0",
    description: "AgentContext event capture for OpenCode sessions",
    author: "AgentContext",
    events: [...OPENCODE_SUBSCRIBED_EVENTS],
    entrypoint: "index.ts",
  };
}

/**
 * OpenCode hook integration.
 *
 * Manages the lifecycle of OpenCode plugin-based hooks and normalizes
 * OpenCode events into unified event envelopes.
 */
export class OpenCodeIntegration implements HookIntegration {
  readonly providerId = "opencode" as const;
  readonly name = "OpenCode";

  private captureCallback: ((event: EventEnvelope) => void) | null = null;
  private pluginDir: string;
  private sessionSequences = new Map<string, number>();

  constructor(options?: { pluginDir?: string }) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    this.pluginDir = options?.pluginDir ?? join(home, ".opencode", "plugins", "agentctx");
  }

  /**
   * Install OpenCode hooks by creating a plugin in .opencode/plugins/.
   */
  async install(options?: InstallOptions): Promise<InstallResult> {
    const pluginDir = options?.baseDir
      ? join(options.baseDir, ".opencode", "plugins", "agentctx")
      : this.pluginDir;

    const modifiedFiles: string[] = [];

    try {
      // Check if plugin already exists
      let exists = false;
      try {
        await access(join(pluginDir, "plugin.json"), fsConstants.F_OK);
        exists = true;
      } catch {
        // Does not exist
      }

      if (exists && !options?.force) {
        return {
          success: true,
          message: "OpenCode plugin already installed. Use --force to overwrite.",
          modifiedFiles: [],
        };
      }

      // Create plugin directory
      await mkdir(pluginDir, { recursive: true });

      // Write plugin manifest
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(manifestPath, JSON.stringify(createPluginManifest(), null, 2) + "\n", "utf-8");
      modifiedFiles.push(manifestPath);

      // Write index.ts (plugin entry point stub)
      const indexPath = join(pluginDir, "index.ts");
      const indexContent = `// AgentContext OpenCode Plugin — entry point
// This plugin captures OpenCode events and forwards them to the AgentContext daemon.
// Events are sent via HTTP POST to the daemon's Unix socket.

export default {
  name: "agentctx",
  version: "1.0.0",
};
`;
      await writeFile(indexPath, indexContent, "utf-8");
      modifiedFiles.push(indexPath);

      // Write event-handler.ts
      const handlerPath = join(pluginDir, "event-handler.ts");
      const handlerContent = `// AgentContext OpenCode event handler
// Normalizes OpenCode native events into unified event types.

export const EVENT_MAP: Record<string, string> = {
  "session.created": "SessionStarted",
  "session.deleted": "SessionEnded",
  "session.idle": "TurnCompleted",
  "session.compacted": "CompactionTriggered",
  "tool.execute.before": "ToolCallRequested",
  "permission.asked": "PermissionRequested",
  "permission.replied": "PermissionResponded",
};
`;
      await writeFile(handlerPath, handlerContent, "utf-8");
      modifiedFiles.push(handlerPath);

      return {
        success: true,
        message: `OpenCode plugin installed (${OPENCODE_SUBSCRIBED_EVENTS.length} event subscriptions)`,
        modifiedFiles,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install OpenCode plugin: ${err instanceof Error ? err.message : String(err)}`,
        modifiedFiles,
      };
    }
  }

  /**
   * Uninstall OpenCode hooks by removing the plugin directory.
   */
  async uninstall(): Promise<void> {
    try {
      await rm(this.pluginDir, { recursive: true, force: true });
    } catch {
      // Nothing to uninstall
    }
  }

  /**
   * Check OpenCode hook health.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = [];

    // Check 1: OpenCode binary installed
    const agentInstalled = await this.isAgentInstalled();
    checks.push({
      name: "OpenCode binary",
      passed: agentInstalled,
      detail: agentInstalled ? "opencode binary found" : "opencode binary not found",
    });

    // Check 2: Plugin directory exists
    let pluginExists = false;
    try {
      const s = await stat(this.pluginDir);
      pluginExists = s.isDirectory();
    } catch {
      // Does not exist
    }
    checks.push({
      name: "Plugin directory",
      passed: pluginExists,
      detail: pluginExists ? `${this.pluginDir} exists` : `${this.pluginDir} not found`,
    });

    // Check 3: Plugin manifest is valid JSON
    let manifestValid = false;
    let manifest: Record<string, unknown> = {};
    if (pluginExists) {
      try {
        const content = await readFile(join(this.pluginDir, "plugin.json"), "utf-8");
        manifest = JSON.parse(content);
        manifestValid = true;
      } catch {
        // Invalid
      }
    }
    checks.push({
      name: "Plugin manifest",
      passed: manifestValid,
      detail: manifestValid ? "plugin.json is valid JSON" : "plugin.json missing or invalid",
    });

    // Check 4: All event subscriptions present
    let eventCount = 0;
    if (manifestValid && Array.isArray(manifest.events)) {
      eventCount = manifest.events.length;
    }
    checks.push({
      name: "Event subscriptions",
      passed: eventCount === OPENCODE_SUBSCRIBED_EVENTS.length,
      detail: `${eventCount}/${OPENCODE_SUBSCRIBED_EVENTS.length} event subscriptions`,
    });

    // Check 5: Plugin files present
    let filesPresent = false;
    if (pluginExists) {
      try {
        await access(join(this.pluginDir, "index.ts"), fsConstants.F_OK);
        await access(join(this.pluginDir, "event-handler.ts"), fsConstants.F_OK);
        filesPresent = true;
      } catch {
        // Missing files
      }
    }
    checks.push({
      name: "Plugin files",
      passed: filesPresent,
      detail: filesPresent ? "All plugin files present" : "Missing plugin files (index.ts, event-handler.ts)",
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Hot-reload OpenCode hook configuration.
   */
  async reload(): Promise<void> {
    // Re-read and validate plugin manifest
    try {
      const content = await readFile(join(this.pluginDir, "plugin.json"), "utf-8");
      JSON.parse(content);
    } catch {
      // plugin.json unreadable
    }
  }

  /**
   * Check if OpenCode is installed on this system.
   */
  async isAgentInstalled(): Promise<boolean> {
    try {
      await execFileAsync("which", ["opencode"]);
      return true;
    } catch {
      // Check for ~/.opencode directory as fallback
      try {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
        const s = await stat(join(home, ".opencode"));
        return s.isDirectory();
      } catch {
        return false;
      }
    }
  }

  /**
   * Start capturing events from OpenCode.
   */
  async startCapture(
    callback: (event: EventEnvelope) => void,
  ): Promise<void> {
    this.captureCallback = callback;
  }

  /**
   * Stop capturing events from OpenCode.
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
   * Normalize an OpenCode native event into a unified event envelope.
   *
   * Special cases:
   * - message.updated: only role=user maps to UserPromptReceived, others return null
   * - tool.execute.after: splits into ToolCallCompleted or ToolCallFailed based on error field
   */
  normalizeEvent(
    nativeEventType: string,
    payload: Record<string, unknown>,
  ): EventEnvelope | null {
    const sessionId = String(payload.session_id ?? "unknown");
    const projectId = String(payload.project_id ?? "unknown");

    let unifiedType: string | undefined;

    // Special handling: message.updated -> only user role
    if (nativeEventType === "message.updated") {
      if (payload.role !== "user") return null;
      unifiedType = "UserPromptReceived";
    }
    // Special handling: tool.execute.after -> completed or failed
    else if (nativeEventType === "tool.execute.after") {
      unifiedType = payload.error ? "ToolCallFailed" : "ToolCallCompleted";
    }
    // Direct mapping
    else {
      unifiedType = OPENCODE_EVENT_MAP[nativeEventType];
    }

    if (!unifiedType) return null;

    return {
      event_id: crypto.randomUUID(),
      event_type: unifiedType,
      project_id: projectId,
      session_id: sessionId,
      sequence: this.nextSequence(sessionId),
      timestamp: new Date().toISOString(),
      agent_provider: "opencode",
      agent_native_event: nativeEventType,
      agent_metadata: {
        model: payload.model as string | undefined,
        cwd: payload.cwd as string | undefined,
      },
      data: payload,
    };
  }

  /**
   * Handle an incoming event from the OpenCode plugin.
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
