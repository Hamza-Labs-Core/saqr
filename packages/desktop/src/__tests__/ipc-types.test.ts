/**
 * Tests for IPC Command Types.
 *
 * Validates that all Rust<->Frontend IPC command type definitions
 * have correct request/response type pairs and conform to the
 * Tauri command naming convention.
 */
import { describe, it, expect } from "vitest";
import type {
  IpcCommand,
  IpcCommandMap,
  DaemonStatus,
  NotificationSettings,
  WindowInfo,
  WindowState,
  KeyStoreRequest,
  KeyStoreResponse,
  UpdateInfo,
  UpdateProgress,
  TrayState,
  TrayMenuState,
  AgentInfo,
  AppConfig,
  DeepLinkAction,
} from "../ipc-types.js";
import {
  IPC_COMMANDS,
  TRAY_STATES,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_APP_CONFIG,
  NOTIFICATION_CATEGORIES,
} from "../ipc-types.js";

describe("IPC Command Types", () => {
  describe("IPC_COMMANDS registry", () => {
    it("should define all daemon commands", () => {
      expect(IPC_COMMANDS).toContain("get_daemon_status");
      expect(IPC_COMMANDS).toContain("start_daemon");
      expect(IPC_COMMANDS).toContain("stop_daemon");
    });

    it("should define all keystore commands", () => {
      expect(IPC_COMMANDS).toContain("store_key");
      expect(IPC_COMMANDS).toContain("retrieve_key");
      expect(IPC_COMMANDS).toContain("delete_key");
      expect(IPC_COMMANDS).toContain("has_key");
    });

    it("should define all notification commands", () => {
      expect(IPC_COMMANDS).toContain("send_notification");
      expect(IPC_COMMANDS).toContain("get_notification_settings");
      expect(IPC_COMMANDS).toContain("set_notification_settings");
    });

    it("should define all window commands", () => {
      expect(IPC_COMMANDS).toContain("open_agent_window");
      expect(IPC_COMMANDS).toContain("get_window_list");
      expect(IPC_COMMANDS).toContain("close_window");
      expect(IPC_COMMANDS).toContain("get_window_state");
    });

    it("should define tray commands", () => {
      expect(IPC_COMMANDS).toContain("update_tray_state");
    });

    it("should have no duplicate commands", () => {
      const unique = new Set(IPC_COMMANDS);
      expect(unique.size).toBe(IPC_COMMANDS.length);
    });
  });

  describe("DaemonStatus", () => {
    it("should represent a running daemon", () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12345,
        uptime_secs: 3600,
        active_agents: 3,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };
      expect(status.running).toBe(true);
      expect(status.pid).toBe(12345);
      expect(status.active_agents).toBe(3);
    });

    it("should represent a stopped daemon with null fields", () => {
      const status: DaemonStatus = {
        running: false,
        pid: null,
        uptime_secs: null,
        active_agents: 0,
        version: null,
        http_port: 7399,
        ws_port: 7400,
      };
      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.version).toBeNull();
    });
  });

  describe("NotificationSettings", () => {
    it("should have all categories enabled by default", () => {
      const settings = DEFAULT_NOTIFICATION_SETTINGS;
      expect(settings.enabled).toBe(true);
      expect(settings.permission_requests).toBe(true);
      expect(settings.agent_complete).toBe(true);
      expect(settings.agent_error).toBe(true);
      expect(settings.updates).toBe(true);
      expect(settings.daemon_status).toBe(true);
      expect(settings.sound).toBe(true);
    });

    it("should define all notification categories", () => {
      expect(NOTIFICATION_CATEGORIES).toContain("permission_requests");
      expect(NOTIFICATION_CATEGORIES).toContain("agent_complete");
      expect(NOTIFICATION_CATEGORIES).toContain("agent_error");
      expect(NOTIFICATION_CATEGORIES).toContain("updates");
      expect(NOTIFICATION_CATEGORIES).toContain("daemon_status");
    });
  });

  describe("WindowInfo", () => {
    it("should represent a window with all required fields", () => {
      const info: WindowInfo = {
        label: "main",
        title: "AgentContext",
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        is_focused: true,
        is_visible: true,
      };
      expect(info.label).toBe("main");
      expect(info.is_focused).toBe(true);
    });
  });

  describe("WindowState", () => {
    it("should represent window position and size", () => {
      const state: WindowState = {
        x: 100,
        y: 200,
        width: 1200,
        height: 800,
        maximized: false,
      };
      expect(state.x).toBe(100);
      expect(state.maximized).toBe(false);
    });
  });

  describe("TrayState", () => {
    it("should enumerate all tray states", () => {
      expect(TRAY_STATES).toContain("idle");
      expect(TRAY_STATES).toContain("running");
      expect(TRAY_STATES).toContain("attention");
      expect(TRAY_STATES).toContain("error");
      expect(TRAY_STATES).toContain("updating");
      expect(TRAY_STATES.length).toBe(5);
    });
  });

  describe("AgentInfo", () => {
    it("should represent an agent from the daemon", () => {
      const agent: AgentInfo = {
        id: "abc123",
        name: "feature-auth",
        model: "claude-4",
        status: "running",
        project: "/home/user/myproject",
      };
      expect(agent.id).toBe("abc123");
      expect(agent.status).toBe("running");
    });
  });

  describe("UpdateInfo", () => {
    it("should represent available update information", () => {
      const info: UpdateInfo = {
        version: "1.1.0",
        notes: "Bug fixes and improvements",
        date: "2026-03-15T12:00:00Z",
      };
      expect(info.version).toBe("1.1.0");
    });

    it("should allow optional fields to be null", () => {
      const info: UpdateInfo = {
        version: "1.1.0",
        notes: null,
        date: null,
      };
      expect(info.notes).toBeNull();
    });
  });

  describe("UpdateProgress", () => {
    it("should represent download progress", () => {
      const progress: UpdateProgress = {
        downloaded: 5000000,
        total: 10000000,
        percent: 50.0,
      };
      expect(progress.percent).toBe(50.0);
    });

    it("should allow unknown total", () => {
      const progress: UpdateProgress = {
        downloaded: 5000000,
        total: null,
        percent: -1.0,
      };
      expect(progress.total).toBeNull();
      expect(progress.percent).toBe(-1.0);
    });
  });

  describe("AppConfig", () => {
    it("should have sensible defaults", () => {
      const config = DEFAULT_APP_CONFIG;
      expect(config.daemon_port).toBe(7399);
      expect(config.theme).toBe("system");
      expect(config.auto_start).toBe(false);
      expect(config.minimize_to_tray).toBe(true);
      expect(config.check_updates).toBe(true);
      expect(config.update_check_interval_hours).toBe(6);
    });
  });

  describe("IpcCommandMap", () => {
    it("should type check daemon commands", () => {
      // This is a compile-time test -- if it compiles, the types are correct
      const map: IpcCommandMap = {
        get_daemon_status: { request: undefined, response: {} as DaemonStatus },
        start_daemon: { request: undefined, response: {} as DaemonStatus },
        stop_daemon: { request: undefined, response: undefined },
        store_key: { request: { keyId: "k", keyBase64: "abc" }, response: undefined },
        retrieve_key: { request: { keyId: "k" }, response: "abc" },
        delete_key: { request: { keyId: "k" }, response: undefined },
        has_key: { request: { keyId: "k" }, response: true },
        send_notification: {
          request: { category: "agent_complete", title: "t", body: "b" },
          response: undefined,
        },
        get_notification_settings: {
          request: undefined,
          response: {} as NotificationSettings,
        },
        set_notification_settings: {
          request: {} as NotificationSettings,
          response: undefined,
        },
        open_agent_window: {
          request: { agentId: "abc", agentName: "test" },
          response: {} as WindowInfo,
        },
        get_window_list: { request: undefined, response: [] as WindowInfo[] },
        close_window: { request: { label: "main" }, response: undefined },
        get_window_state: {
          request: { label: "main" },
          response: {} as WindowState | null,
        },
        update_tray_state: { request: undefined, response: undefined },
      };
      expect(map).toBeDefined();
    });
  });
});
