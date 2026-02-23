/**
 * Daemon Client: HTTP client for connecting to the local daemon.
 *
 * Communicates with the AgentContext daemon over HTTP.
 * Used by the desktop app to check daemon health, list agents,
 * and respond to permission requests.
 *
 * @module daemon-client
 */

import type { DaemonStatus, AgentInfo } from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/** Error thrown when the daemon is unreachable or returns an error. */
export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionError";
  }
}

/** Error thrown when a request to the daemon times out. */
export class DaemonTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Fetch Type
// ---------------------------------------------------------------------------

/** Fetch function signature for dependency injection. */
type FetchFunction = (
  url: string,
  init?: RequestInit
) => Promise<{ ok: boolean; status?: number; statusText?: string; json: () => Promise<unknown> }>;

// ---------------------------------------------------------------------------
// Client Options
// ---------------------------------------------------------------------------

export interface DaemonClientOptions {
  baseUrl?: string;
  envBaseUrl?: string;
  timeoutMs?: number;
  fetch: FetchFunction;
}

// ---------------------------------------------------------------------------
// Daemon Client
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:7399";
const DEFAULT_TIMEOUT_MS = 3000;

export class DaemonClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly fetchFn: FetchFunction;

  constructor(options: DaemonClientOptions) {
    this.baseUrl =
      options.envBaseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch;
  }

  /**
   * Check daemon health. GET /api/health with timeout.
   */
  async healthCheck(): Promise<DaemonStatus> {
    return this.get<DaemonStatus>("/api/health");
  }

  /**
   * Get list of running agents. GET /api/agents.
   */
  async getAgents(): Promise<AgentInfo[]> {
    return this.get<AgentInfo[]>("/api/agents");
  }

  /**
   * Respond to a permission request. POST /api/permissions/{requestId}.
   */
  async respondToPermission(
    requestId: string,
    approved: boolean
  ): Promise<void> {
    await this.post(`/api/permissions/${requestId}`, { approved });
  }

  /**
   * Restart an agent. POST /api/agents/{agentId}/restart.
   */
  async restartAgent(agentId: string): Promise<void> {
    await this.post(`/api/agents/${agentId}/restart`, {});
  }

  // ---------------------------------------------------------------------------
  // Private HTTP helpers
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new DaemonConnectionError(
          `Daemon returned ${response.status}: ${response.statusText}`
        );
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new DaemonTimeoutError(
          `Request to ${path} timed out after ${this.timeoutMs}ms`
        );
      }
      if (error instanceof DaemonConnectionError) {
        throw error;
      }
      if (error instanceof DaemonTimeoutError) {
        throw error;
      }
      throw new DaemonConnectionError(
        `Failed to reach daemon at ${this.baseUrl}${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new DaemonConnectionError(
          `Daemon returned ${response.status}: ${response.statusText}`
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new DaemonTimeoutError(
          `Request to ${path} timed out after ${this.timeoutMs}ms`
        );
      }
      if (error instanceof DaemonConnectionError) {
        throw error;
      }
      if (error instanceof DaemonTimeoutError) {
        throw error;
      }
      throw new DaemonConnectionError(
        `Failed to reach daemon at ${this.baseUrl}${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
