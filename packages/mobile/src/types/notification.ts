/**
 * Notification Types for the Saqr Mobile App.
 *
 * Defines notification payloads, types, categories, and user settings.
 *
 * @module types/notification
 */

/** Types of notifications the app can send. */
export type NotificationType =
  | "permission_request"
  | "agent_completed"
  | "agent_error"
  | "session_ended"
  | "long_running_update";

/** Notification priority levels. */
export type NotificationPriority = "time-sensitive" | "active" | "passive";

/** A notification about agent activity. */
export interface AgentNotification {
  /** Unique notification identifier. */
  id: string;
  /** Type of notification. */
  type: NotificationType;
  /** ID of the daemon this notification relates to. */
  hostId: string;
  /** Human-readable daemon name. */
  hostName: string;
  /** ID of the agent this notification relates to. */
  agentId: string;
  /** Project name for context. */
  projectName: string;
  /** Session ID for deep linking. */
  sessionId: string;
  /** Notification title. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Additional deep link parameters. */
  data: Record<string, string>;
  /** ISO 8601 timestamp when the notification was created. */
  createdAt: string;
  /** Whether the notification has been read/dismissed. */
  read: boolean;
  /** Priority level. */
  priority: NotificationPriority;
}

/** Per-type notification toggle settings. */
export interface NotificationTypeSettings {
  /** Whether permission request notifications are enabled. */
  permission_request: boolean;
  /** Whether agent completion notifications are enabled. */
  agent_completed: boolean;
  /** Whether agent error notifications are enabled. */
  agent_error: boolean;
  /** Whether session ended notifications are enabled. */
  session_ended: boolean;
  /** Whether long-running update notifications are enabled. */
  long_running_update: boolean;
}

/** Quiet hours configuration. */
export interface QuietHours {
  /** Whether quiet hours are active. */
  enabled: boolean;
  /** Start time in "HH:MM" format. */
  startTime: string;
  /** End time in "HH:MM" format. */
  endTime: string;
}

/** User's notification settings. */
export interface NotificationSettings {
  /** Master toggle for all notifications. */
  enabled: boolean;
  /** Per-type toggles. */
  perType: NotificationTypeSettings;
  /** Quiet hours configuration. */
  quietHours: QuietHours;
}

/** Default notification settings. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  perType: {
    permission_request: true,
    agent_completed: true,
    agent_error: true,
    session_ended: false,
    long_running_update: false,
  },
  quietHours: {
    enabled: false,
    startTime: "22:00",
    endTime: "08:00",
  },
};

/** Notification category for iOS/Android channels. */
export interface NotificationCategory {
  /** Category identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Priority level. */
  priority: NotificationPriority;
  /** Applicable notification types. */
  types: NotificationType[];
}

/** All notification categories. */
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  {
    id: "agent_permissions",
    name: "Permission Requests",
    priority: "time-sensitive",
    types: ["permission_request"],
  },
  {
    id: "agent_completions",
    name: "Agent Completions",
    priority: "active",
    types: ["agent_completed"],
  },
  {
    id: "agent_errors",
    name: "Agent Errors",
    priority: "active",
    types: ["agent_error"],
  },
  {
    id: "agent_updates",
    name: "Agent Updates",
    priority: "passive",
    types: ["session_ended", "long_running_update"],
  },
];
