/**
 * Tests for Notification Manager.
 *
 * Event-to-notification mapping, notification queue,
 * user preferences filtering, body truncation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  NotificationManager,
  mapEventToNotification,
  truncateBody,
  type NotificationRequest,
  type NotificationCategory,
} from "../notification-manager.js";
import type { NotificationSettings } from "../ipc-types.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../ipc-types.js";

describe("NotificationManager", () => {
  let manager: NotificationManager;

  beforeEach(() => {
    manager = new NotificationManager();
  });

  describe("settings", () => {
    it("should start with default settings (all enabled)", () => {
      const settings = manager.getSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.permission_requests).toBe(true);
      expect(settings.agent_complete).toBe(true);
      expect(settings.agent_error).toBe(true);
      expect(settings.updates).toBe(true);
      expect(settings.daemon_status).toBe(true);
      expect(settings.sound).toBe(true);
    });

    it("should update settings", () => {
      const newSettings: NotificationSettings = {
        enabled: true,
        permission_requests: false,
        agent_complete: true,
        agent_error: true,
        updates: false,
        daemon_status: true,
        sound: false,
      };

      manager.updateSettings(newSettings);

      expect(manager.getSettings()).toEqual(newSettings);
    });
  });

  describe("shouldSendNotification", () => {
    it("should return true for enabled categories", () => {
      expect(manager.shouldSendNotification("permission_requests")).toBe(true);
      expect(manager.shouldSendNotification("agent_complete")).toBe(true);
      expect(manager.shouldSendNotification("agent_error")).toBe(true);
      expect(manager.shouldSendNotification("updates")).toBe(true);
      expect(manager.shouldSendNotification("daemon_status")).toBe(true);
    });

    it("should return false when notifications are globally disabled", () => {
      manager.updateSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false });

      expect(manager.shouldSendNotification("permission_requests")).toBe(false);
      expect(manager.shouldSendNotification("agent_complete")).toBe(false);
    });

    it("should return false for disabled categories", () => {
      manager.updateSettings({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        permission_requests: false,
        updates: false,
      });

      expect(manager.shouldSendNotification("permission_requests")).toBe(false);
      expect(manager.shouldSendNotification("updates")).toBe(false);
      expect(manager.shouldSendNotification("agent_complete")).toBe(true);
    });
  });

  describe("enqueue and dequeue", () => {
    it("should enqueue notifications", () => {
      const notification: NotificationRequest = {
        category: "agent_complete",
        title: "Agent finished",
        body: "Task complete",
        actions: [{ id: "open:abc", label: "Open" }],
      };

      manager.enqueue(notification);

      expect(manager.pendingCount).toBe(1);
    });

    it("should dequeue notifications in FIFO order", () => {
      const n1: NotificationRequest = {
        category: "agent_complete",
        title: "First",
        body: "First notification",
        actions: [],
      };
      const n2: NotificationRequest = {
        category: "agent_error",
        title: "Second",
        body: "Second notification",
        actions: [],
      };

      manager.enqueue(n1);
      manager.enqueue(n2);

      expect(manager.dequeue()?.title).toBe("First");
      expect(manager.dequeue()?.title).toBe("Second");
    });

    it("should return null when queue is empty", () => {
      expect(manager.dequeue()).toBeNull();
    });

    it("should not enqueue when category is disabled", () => {
      manager.updateSettings({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        agent_complete: false,
      });

      const notification: NotificationRequest = {
        category: "agent_complete",
        title: "Agent finished",
        body: "Task complete",
        actions: [],
      };

      const enqueued = manager.enqueue(notification);

      expect(enqueued).toBe(false);
      expect(manager.pendingCount).toBe(0);
    });

    it("should not enqueue when globally disabled", () => {
      manager.updateSettings({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        enabled: false,
      });

      const notification: NotificationRequest = {
        category: "agent_error",
        title: "Error",
        body: "Agent error",
        actions: [],
      };

      const enqueued = manager.enqueue(notification);

      expect(enqueued).toBe(false);
    });
  });

  describe("clearQueue", () => {
    it("should clear all pending notifications", () => {
      manager.enqueue({
        category: "agent_complete",
        title: "A",
        body: "A",
        actions: [],
      });
      manager.enqueue({
        category: "agent_error",
        title: "B",
        body: "B",
        actions: [],
      });

      manager.clearQueue();

      expect(manager.pendingCount).toBe(0);
    });
  });
});

describe("mapEventToNotification", () => {
  it("should map permission_requested to a notification with approve/deny actions", () => {
    const notification = mapEventToNotification({
      type: "permission_requested",
      agentName: "feature-auth",
      toolName: "write_file",
      toolInputSummary: "/src/index.ts",
      requestId: "req-123",
    });

    expect(notification.category).toBe("permission_requests");
    expect(notification.title).toBe("feature-auth needs permission");
    expect(notification.body).toBe("write_file: /src/index.ts");
    expect(notification.actions).toHaveLength(2);
    expect(notification.actions[0].id).toBe("approve:req-123");
    expect(notification.actions[0].label).toBe("Approve");
    expect(notification.actions[1].id).toBe("deny:req-123");
    expect(notification.actions[1].label).toBe("Deny");
  });

  it("should map agent_complete to a notification with open action", () => {
    const notification = mapEventToNotification({
      type: "agent_complete",
      agentName: "feature-auth",
      summary: "Implemented authentication module with JWT tokens",
      agentId: "abc123",
    });

    expect(notification.category).toBe("agent_complete");
    expect(notification.title).toBe("feature-auth finished");
    expect(notification.body).toBe("Implemented authentication module with JWT tokens");
    expect(notification.actions).toHaveLength(1);
    expect(notification.actions[0].id).toBe("open:abc123");
    expect(notification.actions[0].label).toBe("Open");
  });

  it("should map agent_error to a notification with open and retry actions", () => {
    const notification = mapEventToNotification({
      type: "agent_error",
      agentName: "test-suite",
      errorMessage: "TypeScript compilation failed",
      agentId: "def456",
    });

    expect(notification.category).toBe("agent_error");
    expect(notification.title).toBe("test-suite encountered an error");
    expect(notification.body).toBe("TypeScript compilation failed");
    expect(notification.actions).toHaveLength(2);
    expect(notification.actions[0].id).toBe("open:def456");
    expect(notification.actions[1].id).toBe("retry:def456");
  });

  it("should map update_available to a notification", () => {
    const notification = mapEventToNotification({
      type: "update_available",
      version: "1.1.0",
      notes: "Bug fixes and improvements",
    });

    expect(notification.category).toBe("updates");
    expect(notification.title).toBe("Update Available: v1.1.0");
    expect(notification.body).toBe("Bug fixes and improvements");
    expect(notification.actions).toHaveLength(2);
    expect(notification.actions[0].id).toBe("update");
    expect(notification.actions[0].label).toBe("Update");
    expect(notification.actions[1].id).toBe("later");
    expect(notification.actions[1].label).toBe("Later");
  });

  it("should map daemon_stopped to a notification", () => {
    const notification = mapEventToNotification({
      type: "daemon_stopped",
    });

    expect(notification.category).toBe("daemon_status");
    expect(notification.title).toBe("Daemon Disconnected");
    expect(notification.body).toBe(
      "The AgentContext daemon has stopped unexpectedly."
    );
    expect(notification.actions).toHaveLength(2);
    expect(notification.actions[0].id).toBe("restart-daemon");
    expect(notification.actions[0].label).toBe("Restart");
    expect(notification.actions[1].id).toBe("ignore");
    expect(notification.actions[1].label).toBe("Ignore");
  });

  it("should truncate long body text to 200 characters", () => {
    const longSummary = "A".repeat(300);
    const notification = mapEventToNotification({
      type: "agent_complete",
      agentName: "test",
      summary: longSummary,
      agentId: "abc",
    });

    expect(notification.body.length).toBeLessThanOrEqual(200);
    expect(notification.body.endsWith("...")).toBe(true);
  });
});

describe("truncateBody", () => {
  it("should return text as-is when under 200 characters", () => {
    expect(truncateBody("Hello world")).toBe("Hello world");
  });

  it("should return text as-is when exactly 200 characters", () => {
    const text = "A".repeat(200);
    expect(truncateBody(text)).toBe(text);
  });

  it("should truncate to 197 chars + ellipsis when over 200", () => {
    const text = "A".repeat(300);
    const result = truncateBody(text);
    expect(result.length).toBe(200);
    expect(result).toBe("A".repeat(197) + "...");
  });

  it("should handle empty string", () => {
    expect(truncateBody("")).toBe("");
  });
});
