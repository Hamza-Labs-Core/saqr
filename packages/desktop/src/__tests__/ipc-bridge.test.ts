/**
 * Tests for IPC Bridge.
 *
 * The IPC bridge wraps Tauri's invoke() with typed functions.
 * Tests use a mock invoke function to simulate Tauri IPC responses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createIpcBridge,
  type IpcBridge,
} from "../ipc-bridge.js";
import type {
  DaemonStatus,
  NotificationSettings,
  WindowInfo,
  WindowState,
} from "../ipc-types.js";

// Mock invoke function type
type MockInvoke = ReturnType<typeof vi.fn>;

function createMockInvoke(): MockInvoke {
  return vi.fn();
}

describe("IPC Bridge", () => {
  let mockInvoke: MockInvoke;
  let bridge: IpcBridge;

  beforeEach(() => {
    mockInvoke = createMockInvoke();
    bridge = createIpcBridge(mockInvoke);
  });

  describe("Daemon commands", () => {
    it("getDaemonStatus should invoke get_daemon_status", async () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12345,
        uptime_secs: 3600,
        active_agents: 2,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };
      mockInvoke.mockResolvedValue(status);

      const result = await bridge.getDaemonStatus();

      expect(mockInvoke).toHaveBeenCalledWith("get_daemon_status");
      expect(result).toEqual(status);
    });

    it("startDaemon should invoke start_daemon", async () => {
      const status: DaemonStatus = {
        running: true,
        pid: 12346,
        uptime_secs: 0,
        active_agents: 0,
        version: "1.0.0",
        http_port: 7399,
        ws_port: 7400,
      };
      mockInvoke.mockResolvedValue(status);

      const result = await bridge.startDaemon();

      expect(mockInvoke).toHaveBeenCalledWith("start_daemon");
      expect(result).toEqual(status);
    });

    it("stopDaemon should invoke stop_daemon", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.stopDaemon();

      expect(mockInvoke).toHaveBeenCalledWith("stop_daemon");
    });

    it("should propagate errors from daemon commands", async () => {
      mockInvoke.mockRejectedValue("Failed to reach daemon: connection refused");

      await expect(bridge.getDaemonStatus()).rejects.toBe(
        "Failed to reach daemon: connection refused"
      );
    });
  });

  describe("Key storage commands", () => {
    it("storeKey should invoke store_key with keyId and keyBase64", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.storeKey("my-key", "dGVzdGtleQ==");

      expect(mockInvoke).toHaveBeenCalledWith("store_key", {
        keyId: "my-key",
        keyBase64: "dGVzdGtleQ==",
      });
    });

    it("retrieveKey should invoke retrieve_key and return base64 string", async () => {
      mockInvoke.mockResolvedValue("dGVzdGtleQ==");

      const result = await bridge.retrieveKey("my-key");

      expect(mockInvoke).toHaveBeenCalledWith("retrieve_key", {
        keyId: "my-key",
      });
      expect(result).toBe("dGVzdGtleQ==");
    });

    it("deleteKey should invoke delete_key", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.deleteKey("my-key");

      expect(mockInvoke).toHaveBeenCalledWith("delete_key", {
        keyId: "my-key",
      });
    });

    it("hasKey should invoke has_key and return boolean", async () => {
      mockInvoke.mockResolvedValue(true);

      const result = await bridge.hasKey("my-key");

      expect(mockInvoke).toHaveBeenCalledWith("has_key", {
        keyId: "my-key",
      });
      expect(result).toBe(true);
    });

    it("hasKey should return false for non-existent key", async () => {
      mockInvoke.mockResolvedValue(false);

      const result = await bridge.hasKey("nonexistent");

      expect(result).toBe(false);
    });

    it("should propagate key not found errors", async () => {
      mockInvoke.mockRejectedValue("Key not found: my-key");

      await expect(bridge.retrieveKey("my-key")).rejects.toBe(
        "Key not found: my-key"
      );
    });
  });

  describe("Notification commands", () => {
    it("getNotificationSettings should invoke get_notification_settings", async () => {
      const settings: NotificationSettings = {
        enabled: true,
        permission_requests: true,
        agent_complete: true,
        agent_error: true,
        updates: true,
        daemon_status: true,
        sound: true,
      };
      mockInvoke.mockResolvedValue(settings);

      const result = await bridge.getNotificationSettings();

      expect(mockInvoke).toHaveBeenCalledWith("get_notification_settings");
      expect(result).toEqual(settings);
    });

    it("setNotificationSettings should invoke set_notification_settings with settings", async () => {
      const settings: NotificationSettings = {
        enabled: true,
        permission_requests: false,
        agent_complete: true,
        agent_error: true,
        updates: false,
        daemon_status: true,
        sound: false,
      };
      mockInvoke.mockResolvedValue(undefined);

      await bridge.setNotificationSettings(settings);

      expect(mockInvoke).toHaveBeenCalledWith("set_notification_settings", {
        settings,
      });
    });

    it("sendNotification should invoke send_notification with category, title, body", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.sendNotification("agent_complete", "Task Done", "Agent finished");

      expect(mockInvoke).toHaveBeenCalledWith("send_notification", {
        category: "agent_complete",
        title: "Task Done",
        body: "Agent finished",
      });
    });
  });

  describe("Window commands", () => {
    it("openAgentWindow should invoke open_agent_window", async () => {
      const info: WindowInfo = {
        label: "agent-abc123",
        title: "Agent: feature-auth",
        width: 900,
        height: 700,
        x: 100,
        y: 100,
        is_focused: true,
        is_visible: true,
      };
      mockInvoke.mockResolvedValue(info);

      const result = await bridge.openAgentWindow("abc123", "feature-auth");

      expect(mockInvoke).toHaveBeenCalledWith("open_agent_window", {
        agentId: "abc123",
        agentName: "feature-auth",
      });
      expect(result).toEqual(info);
    });

    it("getWindowList should invoke get_window_list", async () => {
      const windows: WindowInfo[] = [
        {
          label: "main",
          title: "AgentContext",
          width: 1200,
          height: 800,
          x: 0,
          y: 0,
          is_focused: true,
          is_visible: true,
        },
      ];
      mockInvoke.mockResolvedValue(windows);

      const result = await bridge.getWindowList();

      expect(mockInvoke).toHaveBeenCalledWith("get_window_list");
      expect(result).toEqual(windows);
    });

    it("closeWindow should invoke close_window", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.closeWindow("agent-abc123");

      expect(mockInvoke).toHaveBeenCalledWith("close_window", {
        label: "agent-abc123",
      });
    });

    it("getWindowState should invoke get_window_state", async () => {
      const state: WindowState = {
        x: 100,
        y: 200,
        width: 900,
        height: 700,
        maximized: false,
      };
      mockInvoke.mockResolvedValue(state);

      const result = await bridge.getWindowState("main");

      expect(mockInvoke).toHaveBeenCalledWith("get_window_state", {
        label: "main",
      });
      expect(result).toEqual(state);
    });

    it("getWindowState should return null for unknown window", async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await bridge.getWindowState("unknown");

      expect(result).toBeNull();
    });
  });

  describe("Tray commands", () => {
    it("updateTrayState should invoke update_tray_state", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.updateTrayState();

      expect(mockInvoke).toHaveBeenCalledWith("update_tray_state");
    });
  });
});
