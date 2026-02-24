/**
 * Agent Provider Types for the Saqr Agent Management Platform.
 *
 * Defines the provider abstraction layer that enables Saqr to
 * orchestrate multiple coding agents (Claude Code, OpenCode, Codex)
 * through a unified interface.
 *
 * @module agents/types
 */

import type { TypedEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// Agent Provider Identification
// ---------------------------------------------------------------------------

/**
 * Identifies which agent integration is being used.
 *
 * - `"claude-code"` - Anthropic's Claude Code CLI agent
 * - `"opencode"` - OpenCode AI coding assistant
 * - `"codex"` - OpenAI Codex CLI agent
 * - `"custom"` - Community-contributed agent via the custom hook protocol
 */
export type AgentProvider = "claude-code" | "opencode" | "codex" | "custom";

/**
 * Array of all built-in (non-custom) agent provider identifiers.
 */
export const BUILT_IN_PROVIDERS: readonly AgentProvider[] = [
  "claude-code",
  "opencode",
  "codex",
] as const;

/**
 * Array of all valid agent provider identifiers including custom.
 */
export const ALL_PROVIDERS: readonly AgentProvider[] = [
  "claude-code",
  "opencode",
  "codex",
  "custom",
] as const;

/**
 * Type guard that checks if a string is a valid {@link AgentProvider}.
 *
 * @param value - The string to check.
 * @returns `true` if the value is a recognized agent provider.
 */
export function isAgentProvider(value: string): value is AgentProvider {
  return (ALL_PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Provider Information
// ---------------------------------------------------------------------------

/**
 * Static information about an agent provider integration.
 */
export interface ProviderInfo {
  /** The provider identifier. */
  provider: AgentProvider;

  /** Human-readable display name (e.g., "Claude Code"). */
  displayName: string;

  /** Short description of the provider. */
  description: string;

  /** The hook mechanism used by this provider. */
  hookMechanism: "settings-json" | "plugin" | "jsonl-watcher" | "stdin-stdout";

  /** URL for the provider's documentation or homepage. */
  homepage?: string;
}

/**
 * Describes what capabilities a provider supports.
 * Not all providers support all features (e.g., sub-agents).
 */
export interface ProviderCapabilities {
  /** Whether this provider supports sub-agent spawning. */
  subAgents: boolean;

  /** Whether this provider supports context compaction events. */
  compaction: boolean;

  /** Whether this provider supports permission request/response events. */
  permissions: boolean;

  /** Whether this provider supports session resumption. */
  sessionResume: boolean;

  /** Whether this provider supports streaming output. */
  streaming: boolean;

  /** Whether this provider supports model selection. */
  modelSelection: boolean;
}

/**
 * Built-in provider info for all supported agents.
 */
export const PROVIDER_INFO: Readonly<Record<AgentProvider, ProviderInfo>> = {
  "claude-code": {
    provider: "claude-code",
    displayName: "Claude Code",
    description: "Anthropic's Claude Code CLI agent with 10 hook types via settings.json",
    hookMechanism: "settings-json",
    homepage: "https://docs.anthropic.com/en/docs/claude-code",
  },
  opencode: {
    provider: "opencode",
    displayName: "OpenCode",
    description: "OpenCode AI coding assistant with plugin-based event system",
    hookMechanism: "plugin",
    homepage: "https://opencode.ai",
  },
  codex: {
    provider: "codex",
    displayName: "Codex",
    description: "OpenAI Codex CLI agent with JSONL protocol over session file watchers",
    hookMechanism: "jsonl-watcher",
    homepage: "https://github.com/openai/codex",
  },
  custom: {
    provider: "custom",
    displayName: "Custom",
    description: "Community-contributed agent integration via generic stdin/stdout protocol",
    hookMechanism: "stdin-stdout",
  },
};

/**
 * Built-in capability declarations for all supported agents.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<AgentProvider, ProviderCapabilities>> = {
  "claude-code": {
    subAgents: true,
    compaction: true,
    permissions: false,
    sessionResume: true,
    streaming: true,
    modelSelection: true,
  },
  opencode: {
    subAgents: false,
    compaction: true,
    permissions: true,
    sessionResume: false,
    streaming: true,
    modelSelection: true,
  },
  codex: {
    subAgents: false,
    compaction: false,
    permissions: true,
    sessionResume: false,
    streaming: true,
    modelSelection: true,
  },
  custom: {
    subAgents: false,
    compaction: false,
    permissions: false,
    sessionResume: false,
    streaming: false,
    modelSelection: false,
  },
};

// ---------------------------------------------------------------------------
// Agent Lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for an agent session.
 *
 * State transitions:
 * ```
 * initializing -> idle -> running -> idle
 *                   |         |         |
 *                   +-> closed |         +-> error -> closed
 *                              |
 *                              +-> error -> closed
 * ```
 */
export type AgentLifecycleState =
  | "initializing"
  | "idle"
  | "running"
  | "error"
  | "closed";

/**
 * Array of all valid agent lifecycle states.
 */
export const AGENT_LIFECYCLE_STATES: readonly AgentLifecycleState[] = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;

// ---------------------------------------------------------------------------
// Agent Client Interface
// ---------------------------------------------------------------------------

/**
 * Unified interface for interacting with any agent provider.
 *
 * Each provider implementation adapts its specific CLI/API to this
 * common interface. The daemon uses `AgentClient` to manage agent
 * lifecycle, send prompts, and receive streaming output regardless
 * of the underlying agent technology.
 */
export interface AgentClient {
  /** The provider this client communicates with. */
  readonly provider: AgentProvider;

  /**
   * Start a new agent session.
   *
   * @param options - Session creation options.
   * @returns A new agent session handle.
   */
  createSession(options: CreateSessionOptions): Promise<AgentSession>;

  /**
   * Resume an existing agent session (if the provider supports it).
   *
   * @param sessionId - The session identifier to resume.
   * @returns The resumed agent session handle.
   * @throws If the provider does not support session resumption.
   */
  resumeSession(sessionId: string): Promise<AgentSession>;

  /**
   * List available models for this provider.
   *
   * @returns Array of model identifiers the provider supports.
   */
  listModels(): Promise<string[]>;

  /**
   * Check if the provider's CLI/binary is installed and accessible.
   *
   * @returns `true` if the provider is available on this system.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get the installed version of the provider's CLI/binary.
   *
   * @returns Version string, or `null` if not installed.
   */
  getVersion(): Promise<string | null>;
}

/**
 * Options for creating a new agent session.
 */
export interface CreateSessionOptions {
  /** The model to use for this session. */
  model?: string;
  /** The working directory for the agent. */
  cwd: string;
  /** Initial prompt to send to the agent. */
  initialPrompt?: string;
  /** Environment variables to pass to the agent process. */
  env?: Record<string, string>;
  /** Maximum number of turns before the agent stops. */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Agent Session Interface
// ---------------------------------------------------------------------------

/**
 * Handle for an active agent session.
 *
 * Provides methods to interact with a running agent: send prompts,
 * stream output, handle permissions, and manage the session lifecycle.
 */
export interface AgentSession {
  /** The unique session identifier. */
  readonly sessionId: string;

  /** The provider managing this session. */
  readonly provider: AgentProvider;

  /** The current lifecycle state of the session. */
  readonly state: AgentLifecycleState;

  /**
   * Send a prompt to the agent.
   *
   * @param prompt - The text prompt to send.
   * @returns An async iterable of typed events produced during this turn.
   */
  sendPrompt(prompt: string): AsyncIterable<TypedEvent>;

  /**
   * Respond to a pending permission request.
   *
   * @param permissionId - The permission request identifier.
   * @param granted - Whether to grant the permission.
   */
  respondToPermission(permissionId: string, granted: boolean): Promise<void>;

  /**
   * Interrupt the currently running agent turn.
   * The agent will stop its current work gracefully.
   */
  interrupt(): Promise<void>;

  /**
   * Close and clean up the agent session.
   * After calling this, the session cannot be reused.
   */
  close(): Promise<void>;
}
