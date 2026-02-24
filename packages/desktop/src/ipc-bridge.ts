/**
 * IPC Bridge: Typed wrappers around Tauri's invoke() API.
 *
 * Provides type-safe functions for all IPC commands between
 * the TypeScript frontend and the Rust backend.
 *
 * @module ipc-bridge
 */

import type {
  DaemonStatus,
  NotificationSettings,
  WindowInfo,
  WindowState,
} from "./ipc-types.js";

// ---------------------------------------------------------------------------
// Invoke Function Type
// ---------------------------------------------------------------------------

/**
 * Signature matching Tauri's invoke() function.
 * Accepts a command name and optional arguments, returns a Promise.
 */
export type InvokeFunction = (
  cmd: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// IPC Bridge Interface
// ---------------------------------------------------------------------------

/** Typed bridge for all IPC commands. */
export interface IpcBridge {
  // Daemon
  getDaemonStatus(): Promise<DaemonStatus>;
  startDaemon(): Promise<DaemonStatus>;
  stopDaemon(): Promise<void>;

  // Key Storage
  storeKey(keyId: string, keyBase64: string): Promise<void>;
  retrieveKey(keyId: string): Promise<string>;
  deleteKey(keyId: string): Promise<void>;
  hasKey(keyId: string): Promise<boolean>;

  // Notifications
  getNotificationSettings(): Promise<NotificationSettings>;
  setNotificationSettings(settings: NotificationSettings): Promise<void>;
  sendNotification(
    category: string,
    title: string,
    body: string
  ): Promise<void>;

  // Windows
  openAgentWindow(agentId: string, agentName: string): Promise<WindowInfo>;
  getWindowList(): Promise<WindowInfo[]>;
  closeWindow(label: string): Promise<void>;
  getWindowState(label: string): Promise<WindowState | null>;

  // Tray
  updateTrayState(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Bridge Factory
// ---------------------------------------------------------------------------

/**
 * Creates a typed IPC bridge from an invoke function.
 *
 * In production, pass `invoke` from `@tauri-apps/api/core`.
 * In tests, pass a mock function.
 */
export function createIpcBridge(invoke: InvokeFunction): IpcBridge {
  return {
    // Daemon
    async getDaemonStatus(): Promise<DaemonStatus> {
      return invoke("get_daemon_status") as Promise<DaemonStatus>;
    },

    async startDaemon(): Promise<DaemonStatus> {
      return invoke("start_daemon") as Promise<DaemonStatus>;
    },

    async stopDaemon(): Promise<void> {
      await invoke("stop_daemon");
    },

    // Key Storage
    async storeKey(keyId: string, keyBase64: string): Promise<void> {
      await invoke("store_key", { keyId, keyBase64 });
    },

    async retrieveKey(keyId: string): Promise<string> {
      return invoke("retrieve_key", { keyId }) as Promise<string>;
    },

    async deleteKey(keyId: string): Promise<void> {
      await invoke("delete_key", { keyId });
    },

    async hasKey(keyId: string): Promise<boolean> {
      return invoke("has_key", { keyId }) as Promise<boolean>;
    },

    // Notifications
    async getNotificationSettings(): Promise<NotificationSettings> {
      return invoke(
        "get_notification_settings"
      ) as Promise<NotificationSettings>;
    },

    async setNotificationSettings(
      settings: NotificationSettings
    ): Promise<void> {
      await invoke("set_notification_settings", { settings });
    },

    async sendNotification(
      category: string,
      title: string,
      body: string
    ): Promise<void> {
      await invoke("send_notification", { category, title, body });
    },

    // Windows
    async openAgentWindow(
      agentId: string,
      agentName: string
    ): Promise<WindowInfo> {
      return invoke("open_agent_window", {
        agentId,
        agentName,
      }) as Promise<WindowInfo>;
    },

    async getWindowList(): Promise<WindowInfo[]> {
      return invoke("get_window_list") as Promise<WindowInfo[]>;
    },

    async closeWindow(label: string): Promise<void> {
      await invoke("close_window", { label });
    },

    async getWindowState(label: string): Promise<WindowState | null> {
      return invoke("get_window_state", { label }) as Promise<WindowState | null>;
    },

    // Tray
    async updateTrayState(): Promise<void> {
      await invoke("update_tray_state");
    },
  };
}
