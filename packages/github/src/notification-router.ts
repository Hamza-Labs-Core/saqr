/**
 * NotificationRouter - Webhook-to-client notification routing.
 *
 * Routes PR review comments, CI failures, and other GitHub events
 * to connected clients with priority levels.
 *
 * @module notification-router
 */

import * as crypto from "node:crypto";
import type {
  Notification,
  NotificationPriority,
} from "./types.js";
import type {
  PRReviewNotification,
  CIFailureInfo,
} from "./webhook-handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Handler function for incoming notifications.
 */
export type NotificationHandler = (notification: Notification) => void | Promise<void>;

/**
 * Filter criteria for subscribing to notifications.
 */
export interface NotificationFilter {
  /** Only receive notifications of these types. */
  types?: string[];
  /** Only receive notifications at or above this priority. */
  minPriority?: NotificationPriority;
  /** Only receive notifications for this repository. */
  repository?: string;
  /** Only receive notifications for this PR. */
  prNumber?: number;
}

/**
 * A subscription to notifications.
 */
interface Subscription {
  id: string;
  handler: NotificationHandler;
  filter: NotificationFilter;
}

// ---------------------------------------------------------------------------
// Priority Ordering
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function meetsMinPriority(
  actual: NotificationPriority,
  min: NotificationPriority,
): boolean {
  return PRIORITY_ORDER[actual] >= PRIORITY_ORDER[min];
}

// ---------------------------------------------------------------------------
// NotificationRouter
// ---------------------------------------------------------------------------

/**
 * Routes GitHub event notifications to subscribed clients.
 *
 * Supports filtering by notification type, priority level, repository,
 * and PR number. Clients subscribe with a handler function and receive
 * matching notifications in real-time.
 */
export class NotificationRouter {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly history: Notification[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory: number = 100) {
    this.maxHistory = maxHistory;
  }

  /**
   * Subscribe to notifications with an optional filter.
   *
   * @param handler - Callback invoked for matching notifications.
   * @param filter - Optional filter criteria.
   * @returns Subscription ID for later unsubscription.
   */
  subscribe(
    handler: NotificationHandler,
    filter: NotificationFilter = {},
  ): string {
    const id = crypto.randomUUID();
    this.subscriptions.set(id, { id, handler, filter });
    return id;
  }

  /**
   * Unsubscribe from notifications.
   *
   * @param subscriptionId - The subscription ID from subscribe().
   * @returns `true` if the subscription was found and removed.
   */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /**
   * Route a notification to matching subscribers.
   *
   * @param notification - The notification to route.
   * @returns Number of subscribers that received the notification.
   */
  async route(notification: Notification): Promise<number> {
    // Add to history
    this.history.push(notification);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    let delivered = 0;

    for (const sub of this.subscriptions.values()) {
      if (this.matchesFilter(notification, sub.filter)) {
        try {
          await sub.handler(notification);
          delivered++;
        } catch {
          // Don't let a failing handler stop other deliveries
        }
      }
    }

    return delivered;
  }

  /**
   * Create and route a notification from a PR review.
   *
   * @param review - The PR review notification data.
   * @param repository - The repository full name (owner/repo).
   * @returns The created notification.
   */
  async routePRReview(
    review: PRReviewNotification,
    repository: string,
  ): Promise<Notification> {
    const priority = this.reviewPriority(review.reviewState);
    const notification: Notification = {
      id: crypto.randomUUID(),
      type: "pr_review",
      priority,
      title: `PR #${review.prNumber} review: ${review.reviewState}`,
      body: `${review.reviewerLogin} ${review.reviewState} on "${review.prTitle}"${
        review.reviewBody ? `: ${review.reviewBody}` : ""
      }`,
      repository,
      prNumber: review.prNumber,
      url: review.reviewUrl,
      timestamp: new Date(),
      metadata: {
        reviewerLogin: review.reviewerLogin,
        reviewState: review.reviewState,
      },
    };

    await this.route(notification);
    return notification;
  }

  /**
   * Create and route a notification from a CI failure.
   *
   * @param failure - The CI failure info.
   * @param repository - The repository full name.
   * @returns The created notification.
   */
  async routeCIFailure(
    failure: CIFailureInfo,
    repository: string,
  ): Promise<Notification> {
    const notification: Notification = {
      id: crypto.randomUUID(),
      type: "ci_failure",
      priority: "critical",
      title: `CI failed: ${failure.checkName}`,
      body: failure.summary ?? `Check "${failure.checkName}" ${failure.conclusion}`,
      repository,
      url: failure.htmlUrl,
      timestamp: new Date(),
      metadata: {
        checkRunId: failure.checkRunId,
        headSha: failure.headSha,
        conclusion: failure.conclusion,
      },
    };

    await this.route(notification);
    return notification;
  }

  /**
   * Get notification history.
   *
   * @param filter - Optional filter criteria.
   * @returns Matching notifications from history.
   */
  getHistory(filter?: NotificationFilter): Notification[] {
    if (!filter) return [...this.history];
    return this.history.filter((n) => this.matchesFilter(n, filter));
  }

  /**
   * Get the number of active subscriptions.
   */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Clear all subscriptions.
   */
  clearSubscriptions(): void {
    this.subscriptions.clear();
  }

  /**
   * Clear notification history.
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private matchesFilter(
    notification: Notification,
    filter: NotificationFilter,
  ): boolean {
    if (filter.types && !filter.types.includes(notification.type)) {
      return false;
    }

    if (
      filter.minPriority &&
      !meetsMinPriority(notification.priority, filter.minPriority)
    ) {
      return false;
    }

    if (filter.repository && notification.repository !== filter.repository) {
      return false;
    }

    if (
      filter.prNumber !== undefined &&
      notification.prNumber !== filter.prNumber
    ) {
      return false;
    }

    return true;
  }

  private reviewPriority(
    state: string,
  ): NotificationPriority {
    switch (state) {
      case "changes_requested":
        return "warning";
      case "approved":
        return "info";
      case "dismissed":
        return "info";
      case "commented":
      default:
        return "info";
    }
  }
}

export type { Notification, NotificationPriority };
