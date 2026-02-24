/**
 * NotificationManager - Event-to-notification mapping, badge computation,
 * notification queue, and settings management.
 *
 * @module services/notification-manager
 */

import type {
  AgentNotification,
  NotificationType,
  NotificationSettings,
  NotificationPriority,
} from "../types/notification.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../types/notification.js";
import type { AgentStreamEvent } from "../types/agent.js";

/** Context for mapping events to notifications. */
export interface EventContext {
  hostId: string;
  hostName: string;
  projectName: string;
  sessionId: string;
}

/** Deep link for navigating to the relevant screen. */
export interface DeepLink {
  screen: string;
  params: Record<string, string>;
}

/** Map of event types to notification types. */
const EVENT_TO_NOTIFICATION: Record<string, NotificationType> = {
  permission_requested: "permission_request",
  agent_completed: "agent_completed",
  agent_error: "agent_error",
  session_ended: "session_ended",
  long_running_update: "long_running_update",
};

/** Map of notification types to priorities. */
const NOTIFICATION_PRIORITY: Record<NotificationType, NotificationPriority> = {
  permission_request: "time-sensitive",
  agent_completed: "active",
  agent_error: "active",
  session_ended: "passive",
  long_running_update: "passive",
};

/**
 * Manages notifications for agent events.
 */
export class NotificationManager {
  private queue: AgentNotification[] = [];
  private settings: NotificationSettings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    perType: { ...DEFAULT_NOTIFICATION_SETTINGS.perType },
    quietHours: { ...DEFAULT_NOTIFICATION_SETTINGS.quietHours },
  };

  /**
   * Map an agent stream event to a notification.
   * Returns null if the event type doesn't map to a notification.
   */
  mapEventToNotification(
    event: AgentStreamEvent,
    context: EventContext
  ): AgentNotification | null {
    const notifType = EVENT_TO_NOTIFICATION[event.type];
    if (!notifType) return null;

    const priority = NOTIFICATION_PRIORITY[notifType];
    const { title, body } = this.buildNotificationContent(
      notifType,
      event,
      context
    );

    const data: Record<string, string> = {
      hostId: context.hostId,
      agentId: event.agentId,
      sessionId: context.sessionId,
    };

    if (event.data["toolUseId"]) {
      data["toolUseId"] = String(event.data["toolUseId"]);
    }

    return {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: notifType,
      hostId: context.hostId,
      hostName: context.hostName,
      agentId: event.agentId,
      projectName: context.projectName,
      sessionId: context.sessionId,
      title,
      body,
      data,
      createdAt: event.timestamp,
      read: false,
      priority,
    };
  }

  /**
   * Add a notification to the queue.
   */
  enqueue(notification: AgentNotification): void {
    this.queue.push({ ...notification });
  }

  /**
   * Remove and return the first notification from the queue.
   */
  dequeue(): AgentNotification | undefined {
    return this.queue.shift();
  }

  /**
   * Get the full notification queue.
   */
  getQueue(): AgentNotification[] {
    return this.queue.map((n) => ({ ...n }));
  }

  /**
   * Mark a notification as read.
   */
  markRead(id: string): void {
    const notif = this.queue.find((n) => n.id === id);
    if (notif) notif.read = true;
  }

  /**
   * Mark all notifications as read.
   */
  markAllRead(): void {
    for (const notif of this.queue) {
      notif.read = true;
    }
  }

  /**
   * Clear the entire notification queue.
   */
  clearQueue(): void {
    this.queue = [];
  }

  /**
   * Get count of unread notifications.
   */
  getUnreadCount(): number {
    return this.queue.filter((n) => !n.read).length;
  }

  /**
   * Get badge count (only time-sensitive and active unread notifications).
   */
  getBadgeCount(): number {
    return this.queue.filter(
      (n) =>
        !n.read &&
        (n.priority === "time-sensitive" || n.priority === "active")
    ).length;
  }

  /**
   * Get current notification settings.
   */
  getSettings(): NotificationSettings {
    return {
      ...this.settings,
      perType: { ...this.settings.perType },
      quietHours: { ...this.settings.quietHours },
    };
  }

  /**
   * Update notification settings.
   */
  updateSettings(updates: Partial<NotificationSettings>): void {
    if (updates.enabled !== undefined) {
      this.settings.enabled = updates.enabled;
    }
    if (updates.perType) {
      this.settings.perType = {
        ...this.settings.perType,
        ...updates.perType,
      };
    }
    if (updates.quietHours) {
      this.settings.quietHours = {
        ...this.settings.quietHours,
        ...updates.quietHours,
      };
    }
  }

  /**
   * Check if a notification of the given type should be sent.
   */
  shouldNotify(type: NotificationType): boolean {
    if (!this.settings.enabled) return false;
    if (!this.settings.perType[type]) return false;
    if (this.settings.quietHours.enabled && this.isInQuietHours()) {
      return false;
    }
    return true;
  }

  /**
   * Get the deep link destination for a notification.
   */
  getDeepLink(notification: AgentNotification): DeepLink {
    switch (notification.type) {
      case "permission_request":
      case "agent_completed":
      case "agent_error":
        return {
          screen: "AgentDetail",
          params: {
            hostId: notification.hostId,
            agentId: notification.agentId,
          },
        };
      case "session_ended":
      case "long_running_update":
        return {
          screen: "SessionDetail",
          params: {
            hostId: notification.hostId,
            sessionId: notification.sessionId,
          },
        };
    }
  }

  private isInQuietHours(): boolean {
    const { startTime, endTime } = this.settings.quietHours;
    const now = new Date();
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    const [startH, startM] = startTime.split(":").map(Number);
    const [endH, endM] = endTime.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same day range (e.g., 13:00 - 15:00)
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Spans midnight (e.g., 22:00 - 08:00)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  private buildNotificationContent(
    type: NotificationType,
    event: AgentStreamEvent,
    context: EventContext
  ): { title: string; body: string } {
    switch (type) {
      case "permission_request":
        return {
          title: `Permission Required - ${context.hostName}`,
          body: `${context.projectName}: ${String(event.data["description"] || event.data["toolName"] || "Action requires approval")}`,
        };
      case "agent_completed":
        return {
          title: `Agent Completed - ${context.hostName}`,
          body: `${context.projectName}: ${String(event.data["result"] || "Task finished successfully")}`,
        };
      case "agent_error":
        return {
          title: `Agent Error - ${context.hostName}`,
          body: `${context.projectName}: ${String(event.data["error"] || "An error occurred")}`,
        };
      case "session_ended":
        return {
          title: `Session Ended - ${context.hostName}`,
          body: `${context.projectName}: Session ${String(event.data["reason"] || "ended")}`,
        };
      case "long_running_update":
        return {
          title: `Progress Update - ${context.hostName}`,
          body: `${context.projectName}: ${String(event.data["status"] || "Agent is still running")}`,
        };
    }
  }
}
