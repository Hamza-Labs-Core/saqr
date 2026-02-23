/**
 * Agents module -- agent process orchestration and provider registry.
 *
 * @module agents
 */

export { AgentManager } from "./agent-manager.js";
export type {
  AgentProvider,
  ProviderInfo,
  ProviderCapabilities,
  ModelInfo,
  CreateSessionOptions,
  AgentState,
  ManagedSession,
  AgentManagerConfig,
} from "./agent-manager.js";

export { AgentStateMachine, DEFAULT_RECOVERY_POLICY } from "./state-machine.js";
export type {
  AgentLifecycleState,
  AgentError,
  StateChangeEvent,
  RecoveryPolicy,
} from "./state-machine.js";

export { WorktreeManager } from "./worktree-manager.js";
export type { WorktreeInfo, WorktreeCreateOptions, WorktreeRemoveOptions } from "./worktree-manager.js";

export { PermissionQueue } from "./permission-queue.js";
export type {
  PermissionRequest,
  PermissionEvent,
  PermissionRisk,
  PermissionDecision,
  PermissionStatus,
  PermissionQueueOptions,
  EnqueuePermissionInput,
  PermissionRequestCallback,
} from "./permission-queue.js";

export { SessionStore } from "./session-store.js";
export type { PersistedSessionState, SessionStoreOptions } from "./session-store.js";

export {
  AgentOrchestrationError,
  InvalidStateTransitionError,
  ProviderNotInstalledError,
  ProviderNotRegisteredError,
  MaxAgentsReachedError,
  AgentNotFoundError,
  PermissionTimeoutError,
  SpawnFailedError,
  WorktreeFailedError,
  PermissionAlreadyResolved,
} from "./errors.js";

export { ClaudeCodeProvider } from "./providers/claude-code-provider.js";
export { OpenCodeProvider } from "./providers/opencode-provider.js";
export { CodexProvider } from "./providers/codex-provider.js";
