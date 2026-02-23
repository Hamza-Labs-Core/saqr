/**
 * Hooks module — manages hook integrations with coding agents.
 *
 * @module hooks
 */

export { HookManager } from "./hook-manager.js";
export type {
  AgentProvider,
  HookIntegration,
  InstallOptions,
  InstallResult,
  HealthCheckResult,
  HealthCheck,
} from "./hook-manager.js";

export { ClaudeCodeIntegration, CLAUDE_CODE_HOOKS } from "./integrations/claude-code.js";
export type { ClaudeCodeHookDef } from "./integrations/claude-code.js";
export { OpenCodeIntegration, OPENCODE_SUBSCRIBED_EVENTS } from "./integrations/opencode.js";
export { CodexIntegration, CODEX_MESSAGE_MAP } from "./integrations/codex.js";
export { CustomIntegration } from "./integrations/custom.js";
export type { CustomHookConfig, CustomHookManifest } from "./integrations/custom.js";
