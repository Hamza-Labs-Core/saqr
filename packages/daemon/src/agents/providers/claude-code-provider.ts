/**
 * Claude Code agent provider.
 *
 * Implements the AgentProvider interface for Claude Code.
 * Uses the @anthropic-ai/claude-code SDK to create and manage sessions.
 *
 * NOTE: This is currently a stub implementation. The actual SDK integration
 * will be implemented when the Claude Code SDK is available as a dependency.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  ProviderInfo,
  ProviderCapabilities,
  ModelInfo,
  CreateSessionOptions,
  ManagedSession,
} from "../agent-manager.js";

/** Claude Code provider capabilities. */
const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  resume: true,
  interruption: true,
  permissions: true,
  modelSelection: true,
  worktree: true,
};

/**
 * Claude Code agent provider.
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly providerId = "claude-code";

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.providerId,
      name: "Claude Code",
      version: "0.1.0",
      installed: false, // TODO: detect from binary
      capabilities: CLAUDE_CODE_CAPABILITIES,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", providerId: this.providerId },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", providerId: this.providerId },
      { id: "claude-haiku-3-5", name: "Claude Haiku 3.5", providerId: this.providerId },
    ];
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: false, message: "Not implemented" };
  }

  async createSession(options: CreateSessionOptions): Promise<ManagedSession> {
    return {
      sessionId: randomUUID(),
      providerId: this.providerId,
      state: "initializing",
      createdAt: new Date(),
      workingDirectory: options.workingDirectory,
      model: options.model ?? "claude-sonnet-4-5",
    };
  }

  async resumeSession(sessionId: string): Promise<ManagedSession> {
    throw new Error(`Not implemented: resume session ${sessionId}`);
  }
}
