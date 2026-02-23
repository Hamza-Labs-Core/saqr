/**
 * OpenCode agent provider.
 *
 * Implements the AgentProvider interface for OpenCode.
 * Uses HTTP API to communicate with `opencode serve`.
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

/** OpenCode provider capabilities. */
const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  resume: true,
  interruption: true,
  permissions: true,
  modelSelection: true,
  worktree: true,
};

/**
 * OpenCode agent provider.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly providerId = "opencode";

  private apiBaseUrl: string;

  constructor(apiBaseUrl = "http://127.0.0.1:3200") {
    this.apiBaseUrl = apiBaseUrl;
  }

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.providerId,
      name: "OpenCode",
      version: "0.1.0",
      installed: false,
      capabilities: OPENCODE_CAPABILITIES,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
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
      model: options.model ?? "gpt-4.1",
    };
  }

  async resumeSession(sessionId: string): Promise<ManagedSession> {
    throw new Error(`Not implemented: resume session ${sessionId}`);
  }
}
