/**
 * Codex agent provider.
 *
 * Implements the AgentProvider interface for Codex.
 * Communicates via JSONL protocol over spawned process stdin/stdout.
 *
 * NOTE: This is currently a stub implementation.
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

/** Codex provider capabilities. */
const CODEX_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  resume: false, // Codex does not support session resume
  interruption: true,
  permissions: true,
  modelSelection: true,
  worktree: true,
};

/**
 * Codex agent provider.
 */
export class CodexProvider implements AgentProvider {
  readonly providerId = "codex";

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.providerId,
      name: "Codex",
      version: "0.1.0",
      installed: false,
      capabilities: CODEX_CAPABILITIES,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "o4-mini", name: "O4 Mini", providerId: this.providerId },
      { id: "codex-mini", name: "Codex Mini", providerId: this.providerId },
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
      model: options.model ?? "o4-mini",
    };
  }

  async resumeSession(sessionId: string): Promise<ManagedSession> {
    throw new Error(
      `Codex does not support session resume (session: ${sessionId})`,
    );
  }
}
