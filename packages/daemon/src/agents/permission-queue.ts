/**
 * Permission queue for agent process orchestration.
 *
 * When an agent requests permission to perform a potentially destructive
 * action, the request is queued here. Connected clients can approve or deny.
 * Requests auto-deny after a configurable timeout.
 */

import { randomUUID } from "node:crypto";
import {
  PermissionTimeoutError,
  PermissionAlreadyResolved,
} from "./errors.js";

/**
 * Risk level for a permission request.
 */
export type PermissionRisk = "low" | "medium" | "high";

/**
 * Decision made on a permission request.
 */
export type PermissionDecision = "allow" | "deny" | "always_allow";

/**
 * Status of a permission request.
 */
export type PermissionStatus =
  | "pending"
  | "allowed"
  | "denied"
  | "always_allowed"
  | "timed_out";

/**
 * A permission request from an agent.
 */
export interface PermissionRequest {
  permissionId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  risk: PermissionRisk;
  requestedAt: Date;
  timeoutAt: Date;
  status: PermissionStatus;
  resolvedBy?: string;
}

/**
 * Event emitted for permission lifecycle changes.
 */
export interface PermissionEvent {
  type: "requested" | "responded" | "timed_out";
  request: PermissionRequest;
  decision?: PermissionDecision;
  respondedBy?: string;
}

/**
 * Callback for permission request notifications.
 */
export type PermissionRequestCallback = (event: PermissionEvent) => void;

/**
 * Input for enqueuing a new permission request.
 */
export interface EnqueuePermissionInput {
  sessionId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  description: string;
  risk?: PermissionRisk;
}

export interface PermissionQueueOptions {
  /** Timeout in milliseconds before auto-deny (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Action on timeout: "deny" or "allow" (default: "deny") */
  timeoutAction?: "deny" | "allow";
}

/**
 * Manages a queue of permission requests with timeout support.
 */
export class PermissionQueue {
  private readonly requests = new Map<string, PermissionRequest>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resolvers = new Map<
    string,
    {
      resolve: (decision: PermissionDecision) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly listeners = new Set<PermissionRequestCallback>();
  private readonly timeoutMs: number;
  private readonly timeoutAction: "deny" | "allow";

  constructor(options: PermissionQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.timeoutAction = options.timeoutAction ?? "deny";
  }

  /**
   * Enqueue a new permission request.
   *
   * Returns a promise that resolves when the permission is decided
   * (approved, denied, or timed out).
   */
  enqueue(input: EnqueuePermissionInput): Promise<PermissionDecision> {
    const permissionId = randomUUID();
    const now = new Date();
    const request: PermissionRequest = {
      permissionId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput ?? {},
      description: input.description,
      risk: input.risk ?? "medium",
      requestedAt: now,
      timeoutAt: new Date(now.getTime() + this.timeoutMs),
      status: "pending",
    };

    this.requests.set(permissionId, request);

    // Set timeout timer
    const timer = setTimeout(() => {
      this._handleTimeout(permissionId);
    }, this.timeoutMs);
    this.timers.set(permissionId, timer);

    // Emit "requested" event
    this._emit({
      type: "requested",
      request: { ...request },
    });

    // Return a promise that resolves when the permission is decided
    return new Promise<PermissionDecision>((resolve, reject) => {
      this.resolvers.set(permissionId, { resolve, reject });
    });
  }

  /**
   * Respond to a pending permission request.
   *
   * @throws PermissionAlreadyResolved if the request is no longer pending
   */
  respond(
    permissionId: string,
    decision: PermissionDecision,
    respondedBy = "unknown",
  ): void {
    const request = this.requests.get(permissionId);
    if (!request) {
      throw new Error(`Permission "${permissionId}" not found`);
    }
    if (request.status !== "pending") {
      throw new PermissionAlreadyResolved(
        permissionId,
        request.resolvedBy ?? "unknown",
      );
    }

    // Update request
    request.status =
      decision === "allow"
        ? "allowed"
        : decision === "always_allow"
          ? "always_allowed"
          : "denied";
    request.resolvedBy = respondedBy;

    // Cancel timeout
    const timer = this.timers.get(permissionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(permissionId);
    }

    // Emit "responded" event
    this._emit({
      type: "responded",
      request: { ...request },
      decision,
      respondedBy,
    });

    // Resolve the enqueue promise
    const resolver = this.resolvers.get(permissionId);
    if (resolver) {
      resolver.resolve(decision);
      this.resolvers.delete(permissionId);
    }
  }

  /**
   * Get all pending permission requests.
   */
  getPending(): PermissionRequest[] {
    return Array.from(this.requests.values()).filter(
      (r) => r.status === "pending",
    );
  }

  /**
   * Get all permission requests for a specific session.
   */
  getForSession(sessionId: string): PermissionRequest[] {
    return Array.from(this.requests.values()).filter(
      (r) => r.sessionId === sessionId,
    );
  }

  /**
   * Subscribe to permission events.
   * Returns an unsubscribe function.
   */
  onRequest(callback: PermissionRequestCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Clear all pending requests and timers.
   */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Resolve all pending resolvers with "deny" to avoid unhandled rejections
    for (const [, resolver] of this.resolvers) {
      resolver.resolve("deny");
    }
    this.resolvers.clear();

    this.requests.clear();
    this.listeners.clear();
  }

  private _handleTimeout(permissionId: string): void {
    const request = this.requests.get(permissionId);
    if (!request || request.status !== "pending") return;

    request.status = "timed_out";
    request.resolvedBy = "timeout";
    this.timers.delete(permissionId);

    // Emit "timed_out" event
    this._emit({
      type: "timed_out",
      request: { ...request },
    });

    // Safety: always deny on timeout regardless of timeoutAction config.
    // Auto-allowing unattended permission requests is dangerous.
    const resolver = this.resolvers.get(permissionId);
    if (resolver) {
      resolver.resolve("deny");
      this.resolvers.delete(permissionId);
    }
  }

  private _emit(event: PermissionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors
      }
    }
  }
}
