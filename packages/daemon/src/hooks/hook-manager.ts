/**
 * HookManager — manages hook integrations with coding agents.
 *
 * The HookManager is responsible for:
 * - Registering and managing hook integrations (Claude Code, OpenCode, Codex, custom)
 * - Installing/uninstalling hooks for each agent
 * - Health-checking hook installations
 * - Hot-reloading hook configurations without restarting agents
 * - Normalizing agent-native events into unified event envelopes
 *
 * Each integration implements the HookIntegration interface and handles
 * the agent-specific mechanics of capturing events.
 */

import type { EventBus, EventEnvelope } from "../event-bus/event-bus.js";

/**
 * Agent provider identifier.
 */
export type AgentProvider = "claude-code" | "opencode" | "codex" | "custom";

/**
 * Hook integration interface — implemented by each agent-specific integration.
 */
export interface HookIntegration {
  /** Unique identifier for this integration */
  readonly providerId: AgentProvider;

  /** Human-readable name */
  readonly name: string;

  /**
   * Install hooks for this agent on the current system.
   *
   * @param options - Installation options (paths, config overrides)
   * @returns Installation result with details
   */
  install(options?: InstallOptions): Promise<InstallResult>;

  /**
   * Uninstall hooks for this agent.
   */
  uninstall(): Promise<void>;

  /**
   * Check if hooks are correctly installed and healthy.
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Hot-reload hook configuration without restarting the agent.
   */
  reload(): Promise<void>;

  /**
   * Whether this agent is installed on the current system.
   */
  isAgentInstalled(): Promise<boolean>;

  /**
   * Start listening for events from this agent.
   *
   * @param callback - Called with each normalized event envelope
   */
  startCapture(callback: (event: EventEnvelope) => void): Promise<void>;

  /**
   * Stop capturing events from this agent.
   */
  stopCapture(): Promise<void>;
}

/**
 * Options for hook installation.
 */
export interface InstallOptions {
  /** Force reinstall even if hooks are already installed */
  force?: boolean;

  /** Base directory override */
  baseDir?: string;

  /** UDP port for daemon event notifications */
  eventPort?: number;
}

/**
 * Result of a hook installation.
 */
export interface InstallResult {
  /** Whether installation succeeded */
  success: boolean;

  /** Human-readable status message */
  message: string;

  /** Files that were created or modified */
  modifiedFiles: string[];
}

/**
 * Result of a health check.
 */
export interface HealthCheckResult {
  /** Overall health status */
  healthy: boolean;

  /** Individual check results */
  checks: HealthCheck[];
}

/**
 * A single health check item.
 */
export interface HealthCheck {
  /** Name of the check */
  name: string;

  /** Whether this check passed */
  passed: boolean;

  /** Human-readable detail */
  detail: string;
}

/**
 * Manages all hook integrations for the daemon.
 *
 * The HookManager owns the lifecycle of all registered integrations
 * and routes their events into the daemon's EventBus.
 */
export class HookManager {
  private readonly eventBus: EventBus;
  private readonly integrations = new Map<AgentProvider, HookIntegration>();
  private capturing = false;

  /**
   * Creates a new HookManager.
   *
   * @param eventBus - The daemon's internal event bus for publishing captured events
   */
  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a hook integration.
   *
   * @param integration - The hook integration to register
   * @throws If an integration with the same providerId is already registered
   *
   * TODO: Validate integration implements all required methods
   * TODO: Log registration
   */
  registerIntegration(integration: HookIntegration): void {
    if (this.integrations.has(integration.providerId)) {
      throw new Error(
        `Hook integration "${integration.providerId}" is already registered`,
      );
    }
    this.integrations.set(integration.providerId, integration);
  }

  /**
   * Unregister a hook integration.
   *
   * @param providerId - The provider ID to unregister
   * @throws If the provider is not registered
   * @throws If currently capturing (must stop first)
   */
  unregisterIntegration(providerId: AgentProvider): void {
    if (!this.integrations.has(providerId)) {
      throw new Error(
        `Hook integration "${providerId}" is not registered`,
      );
    }
    if (this.capturing) {
      throw new Error(
        `Cannot unregister "${providerId}" while capturing. Stop capture first.`,
      );
    }
    this.integrations.delete(providerId);
  }

  /**
   * Get a registered integration by provider ID.
   *
   * @param providerId - The agent provider identifier
   * @returns The integration, or undefined if not registered
   */
  getIntegration(providerId: AgentProvider): HookIntegration | undefined {
    return this.integrations.get(providerId);
  }

  /**
   * List all registered integrations.
   *
   * @returns Array of registered integration provider IDs
   */
  listIntegrations(): AgentProvider[] {
    return Array.from(this.integrations.keys());
  }

  /**
   * Install hooks for a specific agent.
   *
   * @param providerId - Which agent to install hooks for
   * @param options - Installation options
   * @returns Installation result
   * @throws If the provider is not registered
   *
   * TODO: Implement delegation to integration.install()
   */
  async install(
    providerId: AgentProvider,
    options?: InstallOptions,
  ): Promise<InstallResult> {
    const integration = this.getIntegrationOrThrow(providerId);
    return integration.install(options);
  }

  /**
   * Run health checks for all registered integrations.
   *
   * @returns Map of provider ID to health check result
   *
   * TODO: Run checks in parallel
   * TODO: Include daemon-level checks (ports, permissions)
   */
  async doctor(): Promise<Map<AgentProvider, HealthCheckResult>> {
    const results = new Map<AgentProvider, HealthCheckResult>();

    for (const [providerId, integration] of this.integrations) {
      // TODO: Run health check and store result
      const result = await integration.healthCheck();
      results.set(providerId, result);
    }

    return results;
  }

  /**
   * Start capturing events from all registered integrations.
   *
   * Events from each integration are published to the EventBus.
   * Errors from individual integrations are caught and logged
   * so that one failing integration does not prevent others from starting.
   */
  async startAll(): Promise<void> {
    if (this.capturing) {
      throw new Error("Already capturing events");
    }

    const errors: Array<{ providerId: AgentProvider; error: unknown }> = [];

    for (const [providerId, integration] of this.integrations) {
      try {
        await integration.startCapture((event: EventEnvelope) => {
          this.eventBus.publish(event);
        });
      } catch (err) {
        errors.push({ providerId, error: err });
      }
    }

    this.capturing = true;

    if (errors.length > 0 && errors.length === this.integrations.size) {
      this.capturing = false;
      throw new Error(
        `All integrations failed to start: ${errors.map((e) => e.providerId).join(", ")}`,
      );
    }
  }

  /**
   * Stop capturing events from all integrations.
   *
   * Stops each integration individually. Errors are caught
   * so that one failing integration does not prevent others from stopping.
   */
  async stopAll(): Promise<void> {
    if (!this.capturing) {
      return;
    }

    for (const [, integration] of this.integrations) {
      try {
        await integration.stopCapture();
      } catch {
        // Log but continue stopping other integrations
      }
    }

    this.capturing = false;
  }

  /**
   * Hot-reload hook configuration for a specific agent.
   *
   * @param providerId - Which agent's hooks to reload
   *
   * TODO: Delegate to integration.reload()
   */
  async reload(providerId: AgentProvider): Promise<void> {
    const integration = this.getIntegrationOrThrow(providerId);
    await integration.reload();
  }

  /**
   * Whether the manager is currently capturing events.
   */
  isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Get a registered integration or throw if not found.
   */
  private getIntegrationOrThrow(providerId: AgentProvider): HookIntegration {
    const integration = this.integrations.get(providerId);
    if (!integration) {
      throw new Error(
        `Hook integration "${providerId}" is not registered`,
      );
    }
    return integration;
  }
}
