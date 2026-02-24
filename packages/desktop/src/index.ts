/**
 * @saqr/desktop - Tauri 2 Desktop App TypeScript IPC Layer
 *
 * Provides typed IPC bridge, daemon client, window state management,
 * tray state computation, notification management, key storage bridge,
 * auto-update logic, app configuration, deep link handling, and
 * platform detection.
 *
 * @module desktop
 */

// IPC Types
export type {
  IpcCommand,
  IpcCommandMap,
  DaemonStatus,
  AgentInfo,
  NotificationSettings,
  NotificationCategory,
  WindowInfo,
  WindowState,
  KeyStoreRequest,
  KeyStoreResponse,
  TrayState,
  TrayMenuState,
  UpdateInfo,
  UpdateProgress,
  AppConfig,
  DeepLinkAction,
} from "./ipc-types.js";
export {
  IPC_COMMANDS,
  TRAY_STATES,
  NOTIFICATION_CATEGORIES,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_APP_CONFIG,
} from "./ipc-types.js";

// IPC Bridge
export type { IpcBridge, InvokeFunction } from "./ipc-bridge.js";
export { createIpcBridge } from "./ipc-bridge.js";

// Daemon Client
export {
  DaemonClient,
  DaemonConnectionError,
  DaemonTimeoutError,
} from "./daemon-client.js";
export type { DaemonClientOptions } from "./daemon-client.js";

// Window State
export { WindowStateManager, validateWindowPosition } from "./window-state.js";
export type { MonitorInfo } from "./window-state.js";

// Tray State
export {
  TrayStateManager,
  computeTrayState,
  formatTooltip,
  buildTrayMenuItems,
} from "./tray-state.js";
export type { TrayMenuItem } from "./tray-state.js";

// Notification Manager
export {
  NotificationManager,
  mapEventToNotification,
  truncateBody,
} from "./notification-manager.js";
export type {
  NotificationRequest,
  NotificationAction,
  NotificationEvent,
} from "./notification-manager.js";

// Key Storage Bridge
export { KeyStorageBridge, KeyStorageError, KEY_SIZE_LIMIT } from "./key-storage-bridge.js";

// Auto-Update
export {
  AutoUpdateManager,
  compareVersions,
  parseUpdateResponse,
  CHECK_INTERVAL_MS,
  INITIAL_DELAY_MS,
} from "./auto-update.js";
export type { UpdateCheckResult } from "./auto-update.js";

// App Configuration
export {
  AppConfigManager,
  migrateConfig,
  validateConfig,
  CONFIG_VERSION,
} from "./app-config.js";

// Deep Link
export { parseDeepLink, DEEP_LINK_SCHEME } from "./deep-link.js";
export type { DeepLinkRoute } from "./deep-link.js";

// Platform Detection
export { isTauri, getPlatformInfo } from "./platform.js";
export type { PlatformInfo } from "./platform.js";
