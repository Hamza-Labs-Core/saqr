/**
 * Custom hook protocol integration.
 *
 * The custom hook protocol allows community-contributed integrations
 * for future agents that are not natively supported. Custom hooks
 * communicate via a generic stdin/stdout JSON protocol.
 *
 * Protocol:
 * - The daemon spawns a custom hook process
 * - The process reads configuration from stdin (JSON)
 * - The process writes event envelopes to stdout (one JSON per line)
 * - The process writes errors/diagnostics to stderr
 * - The daemon monitors the process lifecycle
 *
 * Custom hooks must produce events that conform to the unified event
 * envelope format. No normalization is performed -- the custom hook
 * is responsible for producing correctly-formatted events.
 */

import { access, readFile, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import type {
  HookIntegration,
  InstallOptions,
  InstallResult,
  HealthCheckResult,
  HealthCheck,
} from "../hook-manager.js";
import type { EventEnvelope } from "../../event-bus/event-bus.js";

/**
 * Unified event types for validation.
 */
const VALID_EVENT_TYPES = new Set([
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
]);

/**
 * Reserved provider names that custom hooks cannot use.
 */
const RESERVED_PROVIDERS = new Set(["claude-code", "opencode", "codex"]);

/**
 * Configuration for a custom hook process.
 */
export interface CustomHookConfig {
  /** Path to the custom hook executable */
  command: string;

  /** Arguments to pass to the executable */
  args?: string[];

  /** Environment variables for the process */
  env?: Record<string, string>;

  /** Working directory for the process */
  cwd?: string;

  /** Human-readable name for this custom hook */
  name?: string;
}

/**
 * Custom hook manifest as discovered from hooks.d directories.
 */
export interface CustomHookManifest {
  /** Unique name for the hook */
  name: string;
  /** Description */
  description?: string;
  /** Version string */
  version?: string;
  /** Author */
  author?: string;
  /** The agent_provider string for events from this hook */
  agent_provider: string;
  /** Path to the executable (relative to manifest dir) */
  executable: string;
  /** Mapping from native event names to unified event types */
  event_mapping: Record<string, string>;
  /** Additional configuration */
  config?: Record<string, unknown>;
}

/**
 * Custom hook protocol integration.
 *
 * Manages custom hook processes that communicate via stdin/stdout JSON.
 */
export class CustomIntegration implements HookIntegration {
  readonly providerId = "custom" as const;
  readonly name = "Custom";

  private hookConfig: CustomHookConfig | null = null;
  private captureCallback: ((event: EventEnvelope) => void) | null = null;
  private hooksDir: string;
  private restartAttempts = 0;
  private maxRestartAttempts = 10;
  private sessionSequences = new Map<string, number>();

  /**
   * Creates a new CustomIntegration.
   *
   * @param config - Configuration for the custom hook process (optional at construction)
   */
  constructor(config?: CustomHookConfig, options?: { hooksDir?: string }) {
    this.hookConfig = config ?? null;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    this.hooksDir = options?.hooksDir ?? join(home, ".agentctx", "hooks.d");
  }

  /**
   * Install a custom hook.
   *
   * Validates that the custom hook executable exists and is runnable.
   */
  async install(options?: InstallOptions): Promise<InstallResult> {
    if (!this.hookConfig) {
      return {
        success: false,
        message: "No custom hook configuration provided",
        modifiedFiles: [],
      };
    }

    try {
      // Validate hook executable exists
      await access(this.hookConfig.command, fsConstants.X_OK);

      return {
        success: true,
        message: `Custom hook "${this.hookConfig.name ?? "unnamed"}" installed`,
        modifiedFiles: [],
      };
    } catch {
      return {
        success: false,
        message: `Custom hook executable not found or not executable: ${this.hookConfig.command}`,
        modifiedFiles: [],
      };
    }
  }

  /**
   * Uninstall the custom hook.
   */
  async uninstall(): Promise<void> {
    this.hookConfig = null;
  }

  /**
   * Check custom hook health.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = [];

    // Check 1: Configuration provided
    checks.push({
      name: "Configuration",
      passed: this.hookConfig !== null,
      detail: this.hookConfig
        ? `Hook "${this.hookConfig.name ?? "unnamed"}" configured`
        : "No custom hook configured",
    });

    // Check 2: Executable exists and is executable
    let executableOk = false;
    if (this.hookConfig) {
      try {
        await access(this.hookConfig.command, fsConstants.X_OK);
        executableOk = true;
      } catch {
        // Not executable
      }
    }
    checks.push({
      name: "Executable",
      passed: executableOk,
      detail: executableOk
        ? `${this.hookConfig?.command} is executable`
        : `${this.hookConfig?.command ?? "N/A"} not found or not executable`,
    });

    return {
      healthy: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Hot-reload custom hook configuration.
   */
  async reload(): Promise<void> {
    // Re-read hooks.d directory for manifest changes
  }

  /**
   * Custom hooks are always considered "installed" if a config is provided.
   */
  async isAgentInstalled(): Promise<boolean> {
    return this.hookConfig !== null;
  }

  /**
   * Start capturing events from the custom hook.
   */
  async startCapture(
    callback: (event: EventEnvelope) => void,
  ): Promise<void> {
    this.captureCallback = callback;
  }

  /**
   * Stop capturing events from the custom hook.
   */
  async stopCapture(): Promise<void> {
    this.captureCallback = null;
  }

  /**
   * Set or update the custom hook configuration.
   */
  setConfig(config: CustomHookConfig): void {
    this.hookConfig = config;
  }

  /**
   * Validate a custom hook manifest.
   *
   * @returns Array of validation error messages (empty if valid)
   */
  static validateManifest(manifest: unknown): string[] {
    const errors: string[] = [];

    if (!manifest || typeof manifest !== "object") {
      return ["Manifest must be a JSON object"];
    }

    const m = manifest as Record<string, unknown>;

    if (typeof m.name !== "string" || m.name.length === 0) {
      errors.push("Manifest must have a non-empty 'name' field");
    }

    if (typeof m.agent_provider !== "string" || m.agent_provider.length === 0) {
      errors.push("Manifest must have a non-empty 'agent_provider' field");
    } else if (RESERVED_PROVIDERS.has(m.agent_provider as string)) {
      errors.push(`Provider name "${m.agent_provider}" is reserved. Use a custom name.`);
    }

    if (typeof m.executable !== "string" || m.executable.length === 0) {
      errors.push("Manifest must have a non-empty 'executable' field");
    }

    if (!m.event_mapping || typeof m.event_mapping !== "object") {
      errors.push("Manifest must have an 'event_mapping' object");
    } else {
      const mapping = m.event_mapping as Record<string, unknown>;
      for (const [native, unified] of Object.entries(mapping)) {
        if (typeof unified !== "string") {
          errors.push(`Event mapping value for "${native}" must be a string`);
        } else if (!VALID_EVENT_TYPES.has(unified)) {
          errors.push(`Unknown unified event type "${unified}" in mapping for "${native}"`);
        }
      }
    }

    return errors;
  }

  /**
   * Validate a JSONL event line from a custom hook's stdout.
   *
   * @returns The parsed event or null if invalid
   */
  static validateEvent(line: string): EventEnvelope | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null; // Malformed JSON
    }

    // Validate required fields
    if (typeof parsed.event_type !== "string" || !VALID_EVENT_TYPES.has(parsed.event_type)) {
      return null;
    }

    if (!parsed.data || typeof parsed.data !== "object") {
      return null;
    }

    // Check size limit (10MB)
    if (line.length > 10 * 1024 * 1024) {
      return null;
    }

    const data = parsed.data as Record<string, unknown>;
    const sessionId = String(data.session_id ?? parsed.session_id ?? "unknown");

    return {
      event_id: crypto.randomUUID(),
      event_type: parsed.event_type as string,
      project_id: String(parsed.project_id ?? "unknown"),
      session_id: sessionId,
      sequence: typeof parsed.sequence === "number" ? parsed.sequence : 0,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
      agent_provider: String(parsed.agent_provider ?? "custom"),
      agent_native_event: String(parsed.agent_native_event ?? parsed.event_type),
      agent_metadata: (parsed.agent_metadata as Record<string, unknown>) ?? {},
      data,
    };
  }

  /**
   * Calculate exponential backoff delay for restart attempts.
   *
   * @param attempt - The attempt number (0-based)
   * @returns Delay in milliseconds (capped at 60000ms)
   */
  static calculateBackoff(attempt: number): number {
    const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
    return delay;
  }
}
