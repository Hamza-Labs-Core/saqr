/**
 * IPC Command Types for Tauri Desktop Application.
 *
 * Complete TypeScript type definitions for all Rust<->Frontend IPC commands.
 * Every IPC command has a typed request/response pair.
 *
 * @module ipc-types
 */

// ---------------------------------------------------------------------------
// IPC Command Registry
// ---------------------------------------------------------------------------

/**
 * All registered IPC command names, matching Rust #[tauri::command] names.
 */
export const IPC_COMMANDS = [
  // Daemon
  "get_daemon_status",
  "start_daemon",
  "stop_daemon",
  // Key Storage
  "store_key",
  "retrieve_key",
  "delete_key",
  "has_key",
  // Notifications
  "send_notification",
  "get_notification_settings",
  "set_notification_settings",
  // Windows
  "open_agent_window",
  "get_window_list",
  "close_window",
  "get_window_state",
  // Tray
  "update_tray_state",
] as const;

/** Union type of all IPC command names. */
export type IpcCommand = (typeof IPC_COMMANDS)[number];

// ---------------------------------------------------------------------------
// Daemon Types
// ---------------------------------------------------------------------------

/** Status of the locally running AgentContext daemon. */
export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime_secs: number | null;
  active_agents: number;
  version: string | null;
  http_port: number;
  ws_port: number;
}

// ---------------------------------------------------------------------------
// Agent Types
// ---------------------------------------------------------------------------

/** Information about a running agent from the daemon API. */
export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  status: string;
  project: string;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

/** User preferences for notification categories. */
export interface NotificationSettings {
  enabled: boolean;
  permission_requests: boolean;
  agent_complete: boolean;
  agent_error: boolean;
  updates: boolean;
  daemon_status: boolean;
  sound: boolean;
}

/** All notification category keys (excluding 'enabled' and 'sound'). */
export const NOTIFICATION_CATEGORIES = [
  "permission_requests",
  "agent_complete",
  "agent_error",
  "updates",
  "daemon_status",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Default notification settings: all categories and sound enabled. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  permission_requests: true,
  agent_complete: true,
  agent_error: true,
  updates: true,
  daemon_status: true,
  sound: true,
};

// ---------------------------------------------------------------------------
// Window Types
// ---------------------------------------------------------------------------

/** Information about an open window. */
export interface WindowInfo {
  label: string;
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
  is_focused: boolean;
  is_visible: boolean;
}

/** Persisted window position/size state. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

// ---------------------------------------------------------------------------
// Key Storage Types
// ---------------------------------------------------------------------------

/** Request to store a key. */
export interface KeyStoreRequest {
  keyId: string;
  keyBase64: string;
}

/** Response from key retrieval (base64 encoded). */
export type KeyStoreResponse = string;

// ---------------------------------------------------------------------------
// Tray Types
// ---------------------------------------------------------------------------

/** All possible tray icon states. */
export const TRAY_STATES = [
  "idle",
  "running",
  "attention",
  "error",
  "updating",
] as const;

export type TrayState = (typeof TRAY_STATES)[number];

/** Computed state for the tray menu. */
export interface TrayMenuState {
  state: TrayState;
  agents: AgentInfo[];
  daemonStatus: DaemonStatus;
  version: string;
}

// ---------------------------------------------------------------------------
// Update Types
// ---------------------------------------------------------------------------

/** Information about an available update. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

/** Download progress for an update. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  percent: number;
}

// ---------------------------------------------------------------------------
// App Configuration Types
// ---------------------------------------------------------------------------

/** Application configuration. */
export interface AppConfig {
  daemon_port: number;
  theme: "light" | "dark" | "system";
  auto_start: boolean;
  minimize_to_tray: boolean;
  check_updates: boolean;
  update_check_interval_hours: number;
}

/** Default application configuration. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  daemon_port: 7399,
  theme: "system",
  auto_start: false,
  minimize_to_tray: true,
  check_updates: true,
  update_check_interval_hours: 6,
};

// ---------------------------------------------------------------------------
// Deep Link Types
// ---------------------------------------------------------------------------

/** Parsed deep link action. */
export interface DeepLinkAction {
  route: string;
  params: Record<string, string>;
  queryParams?: URLSearchParams;
}

// ---------------------------------------------------------------------------
// IPC Command Map (compile-time type safety)
// ---------------------------------------------------------------------------

/**
 * Maps each IPC command to its request and response types.
 * Used for compile-time verification that bridge functions match Rust commands.
 */
export interface IpcCommandMap {
  get_daemon_status: { request: undefined; response: DaemonStatus };
  start_daemon: { request: undefined; response: DaemonStatus };
  stop_daemon: { request: undefined; response: undefined };
  store_key: { request: KeyStoreRequest; response: undefined };
  retrieve_key: { request: { keyId: string }; response: string };
  delete_key: { request: { keyId: string }; response: undefined };
  has_key: { request: { keyId: string }; response: boolean };
  send_notification: {
    request: { category: string; title: string; body: string };
    response: undefined;
  };
  get_notification_settings: { request: undefined; response: NotificationSettings };
  set_notification_settings: { request: NotificationSettings; response: undefined };
  open_agent_window: {
    request: { agentId: string; agentName: string };
    response: WindowInfo;
  };
  get_window_list: { request: undefined; response: WindowInfo[] };
  close_window: { request: { label: string }; response: undefined };
  get_window_state: { request: { label: string }; response: WindowState | null };
  update_tray_state: { request: undefined; response: undefined };
}
