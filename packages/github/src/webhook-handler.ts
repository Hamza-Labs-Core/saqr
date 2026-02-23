/**
 * WebhookHandler - GitHub webhook processing.
 *
 * Verifies webhook signatures, routes events by type, extracts
 * PR review notifications, and detects CI failures.
 *
 * @module webhook-handler
 */

import * as crypto from "node:crypto";
import type {
  PushEventPayload,
  PullRequestEventPayload,
  IssuesEventPayload,
  CheckRunEventPayload,
  PullRequestReviewEventPayload,
  PullRequestReviewCommentEventPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 *
 * @param payload - The raw request body as a string or Buffer.
 * @param signature - The X-Hub-Signature-256 header value (sha256=...).
 * @param secret - The webhook secret configured in the GitHub App.
 * @returns `true` if the signature is valid.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    // Buffers of different lengths will throw
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event Handler Types
// ---------------------------------------------------------------------------

/**
 * Supported webhook event types.
 */
export type WebhookEventType =
  | "push"
  | "pull_request"
  | "issues"
  | "check_run"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issue_comment"
  | "create"
  | "delete"
  | "installation";

/**
 * Handler function for a webhook event.
 */
export type WebhookEventHandler<T = unknown> = (
  event: T,
  action: string,
) => void | Promise<void>;

/**
 * Information extracted from a PR review webhook.
 */
export interface PRReviewNotification {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  reviewerLogin: string;
  reviewState: "approved" | "changes_requested" | "commented" | "dismissed";
  reviewBody: string | null;
  reviewUrl: string;
}

/**
 * Information extracted from a CI failure.
 */
export interface CIFailureInfo {
  checkRunId: number;
  checkName: string;
  headSha: string;
  conclusion: string;
  htmlUrl: string;
  title: string | null;
  summary: string | null;
}

// ---------------------------------------------------------------------------
// WebhookHandler
// ---------------------------------------------------------------------------

/**
 * Handles incoming GitHub webhooks.
 *
 * Supports signature verification, event type routing, and
 * extraction of high-value information like review notifications
 * and CI failures.
 */
export class WebhookHandler {
  private readonly secret: string;
  private readonly handlers = new Map<
    string,
    Array<WebhookEventHandler<unknown>>
  >();

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * Register a handler for a specific event type.
   *
   * @param eventType - The GitHub event type (e.g., "push", "pull_request").
   * @param handler - The handler function.
   */
  on<T = unknown>(
    eventType: WebhookEventType | string,
    handler: WebhookEventHandler<T>,
  ): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler as WebhookEventHandler<unknown>);
    this.handlers.set(eventType, existing);
  }

  /**
   * Remove a handler for a specific event type.
   *
   * @param eventType - The GitHub event type.
   * @param handler - The handler function to remove.
   */
  off<T = unknown>(
    eventType: WebhookEventType | string,
    handler: WebhookEventHandler<T>,
  ): void {
    const existing = this.handlers.get(eventType) ?? [];
    const index = existing.indexOf(handler as WebhookEventHandler<unknown>);
    if (index !== -1) {
      existing.splice(index, 1);
    }
    if (existing.length === 0) {
      this.handlers.delete(eventType);
    } else {
      this.handlers.set(eventType, existing);
    }
  }

  /**
   * Process an incoming webhook.
   *
   * @param eventType - The X-GitHub-Event header value.
   * @param payload - The raw request body (string or Buffer).
   * @param signature - The X-Hub-Signature-256 header value.
   * @returns `true` if the webhook was processed successfully.
   * @throws If the signature is invalid.
   */
  async handle(
    eventType: string,
    payload: string | Buffer,
    signature: string,
  ): Promise<boolean> {
    // Verify signature
    if (!verifyWebhookSignature(payload, signature, this.secret)) {
      throw new Error("Invalid webhook signature");
    }

    const body =
      typeof payload === "string" ? JSON.parse(payload) : JSON.parse(payload.toString());
    const action = body.action ?? "";

    // Invoke registered handlers for this event type
    const handlers = this.handlers.get(eventType) ?? [];

    // Also invoke wildcard handlers
    const wildcardHandlers = this.handlers.get("*") ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    if (allHandlers.length === 0) {
      return false;
    }

    for (const handler of allHandlers) {
      await handler(body, action);
    }

    return true;
  }

  /**
   * Process a webhook without signature verification (for trusted sources).
   *
   * @param eventType - The event type.
   * @param body - The parsed event body.
   * @returns `true` if handlers were invoked.
   */
  async handleTrusted(
    eventType: string,
    body: unknown,
  ): Promise<boolean> {
    const action = (body as Record<string, unknown>).action as string ?? "";

    const handlers = this.handlers.get(eventType) ?? [];
    const wildcardHandlers = this.handlers.get("*") ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    if (allHandlers.length === 0) return false;

    for (const handler of allHandlers) {
      await handler(body, action);
    }

    return true;
  }

  /**
   * Extract PR review notification from a pull_request_review event.
   *
   * @param payload - The webhook payload.
   * @returns The extracted notification, or null if not applicable.
   */
  static extractPRReviewNotification(
    payload: PullRequestReviewEventPayload,
  ): PRReviewNotification | null {
    if (!payload.review || !payload.pull_request) return null;

    return {
      prNumber: payload.pull_request.number,
      prTitle: payload.pull_request.title,
      prUrl: payload.pull_request.html_url,
      reviewerLogin: payload.review.user.login,
      reviewState: payload.review.state,
      reviewBody: payload.review.body,
      reviewUrl: payload.review.html_url,
    };
  }

  /**
   * Detect CI failure from a check_run event.
   *
   * @param payload - The webhook payload.
   * @returns CI failure info if this is a failure, otherwise null.
   */
  static detectCIFailure(
    payload: CheckRunEventPayload,
  ): CIFailureInfo | null {
    const checkRun = payload.check_run;
    if (!checkRun) return null;

    if (
      checkRun.status !== "completed" ||
      (checkRun.conclusion !== "failure" &&
        checkRun.conclusion !== "timed_out" &&
        checkRun.conclusion !== "cancelled")
    ) {
      return null;
    }

    return {
      checkRunId: checkRun.id,
      checkName: checkRun.name,
      headSha: checkRun.head_sha,
      conclusion: checkRun.conclusion,
      htmlUrl: checkRun.html_url,
      title: checkRun.output?.title ?? null,
      summary: checkRun.output?.summary ?? null,
    };
  }

  /**
   * Get the number of registered handlers.
   */
  get handlerCount(): number {
    let count = 0;
    for (const handlers of this.handlers.values()) {
      count += handlers.length;
    }
    return count;
  }

  /**
   * Get the event types that have registered handlers.
   */
  get registeredEvents(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// Re-export types used by tests
export type {
  PushEventPayload,
  PullRequestEventPayload,
  IssuesEventPayload,
  CheckRunEventPayload,
  PullRequestReviewEventPayload,
  PullRequestReviewCommentEventPayload,
};
