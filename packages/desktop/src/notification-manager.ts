/**
 * Notification Manager.
 *
 * Event-to-notification mapping, notification queue management,
 * user preferences filtering, and body text truncation.
 *
 * @module notification-manager
 */

import type {
  NotificationSettings,
  NotificationCategory,
} from "./ipc-types.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_LENGTH = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action button on a notification. */
export interface NotificationAction {
  id: string;
  label: string;
}

/** A notification request to be sent. */
export interface NotificationRequest {
  category: NotificationCategory;
  title: string;
  body: string;
  actions: NotificationAction[];
}

/**
 * Events that can be mapped to notifications.
 * Discriminated union on the `type` field.
 */
export type NotificationEvent =
  | {
      type: "permission_requested";
      agentName: string;
      toolName: string;
      toolInputSummary: string;
      requestId: string;
    }
  | {
      type: "agent_complete";
      agentName: string;
      summary: string;
      agentId: string;
    }
  | {
      type: "agent_error";
      agentName: string;
      errorMessage: string;
      agentId: string;
    }
  | {
      type: "update_available";
      version: string;
      notes: string;
    }
  | {
      type: "daemon_stopped";
    };

// ---------------------------------------------------------------------------
// Notification Manager
// ---------------------------------------------------------------------------

/**
 * Manages notification settings, queuing, and category-based filtering.
 */
export class NotificationManager {
  private settings: NotificationSettings;
  private queue: NotificationRequest[] = [];

  constructor() {
    this.settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  }

  /** Get current notification settings. */
  getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  /** Update notification settings. */
  updateSettings(settings: NotificationSettings): void {
    this.settings = { ...settings };
  }

  /** Check if a notification should be sent for the given category. */
  shouldSendNotification(category: NotificationCategory): boolean {
    if (!this.settings.enabled) return false;
    return this.settings[category];
  }

  /**
   * Enqueue a notification for sending.
   * Returns false if the category is disabled (notification not queued).
   */
  enqueue(notification: NotificationRequest): boolean {
    if (!this.shouldSendNotification(notification.category)) {
      return false;
    }
    this.queue.push(notification);
    return true;
  }

  /** Dequeue the next notification. Returns null if queue is empty. */
  dequeue(): NotificationRequest | null {
    return this.queue.shift() ?? null;
  }

  /** Number of pending notifications. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Clear all pending notifications. */
  clearQueue(): void {
    this.queue = [];
  }
}

// ---------------------------------------------------------------------------
// Event-to-Notification Mapping
// ---------------------------------------------------------------------------

/**
 * Maps an application event to a notification request.
 */
export function mapEventToNotification(
  event: NotificationEvent
): NotificationRequest {
  switch (event.type) {
    case "permission_requested":
      return {
        category: "permission_requests",
        title: `${event.agentName} needs permission`,
        body: truncateBody(`${event.toolName}: ${event.toolInputSummary}`),
        actions: [
          { id: `approve:${event.requestId}`, label: "Approve" },
          { id: `deny:${event.requestId}`, label: "Deny" },
        ],
      };

    case "agent_complete":
      return {
        category: "agent_complete",
        title: `${event.agentName} finished`,
        body: truncateBody(event.summary),
        actions: [{ id: `open:${event.agentId}`, label: "Open" }],
      };

    case "agent_error":
      return {
        category: "agent_error",
        title: `${event.agentName} encountered an error`,
        body: truncateBody(event.errorMessage),
        actions: [
          { id: `open:${event.agentId}`, label: "Open" },
          { id: `retry:${event.agentId}`, label: "Retry" },
        ],
      };

    case "update_available":
      return {
        category: "updates",
        title: `Update Available: v${event.version}`,
        body: truncateBody(event.notes),
        actions: [
          { id: "update", label: "Update" },
          { id: "later", label: "Later" },
        ],
      };

    case "daemon_stopped":
      return {
        category: "daemon_status",
        title: "Daemon Disconnected",
        body: "The AgentContext daemon has stopped unexpectedly.",
        actions: [
          { id: "restart-daemon", label: "Restart" },
          { id: "ignore", label: "Ignore" },
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// Body Truncation
// ---------------------------------------------------------------------------

/**
 * Truncates body text to 200 characters with ellipsis if needed.
 */
export function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_LENGTH) return text;
  return text.slice(0, MAX_BODY_LENGTH - 3) + "...";
}
