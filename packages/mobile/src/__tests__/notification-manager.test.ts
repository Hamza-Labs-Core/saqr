/**
 * Tests for the NotificationManager service.
 *
 * Covers event-to-notification mapping, badge computation,
 * notification queue, quiet hours, and settings.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { NotificationManager } from "../services/notification-manager.js";
import type { AgentNotification, NotificationSettings } from "../types/notification.js";
import type { AgentStreamEvent } from "../types/agent.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../types/notification.js";

describe("NotificationManager", () => {
  let manager: NotificationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T14:00:00Z"));
    manager = new NotificationManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("event-to-notification mapping", () => {
    it("maps permission_requested event to notification", () => {
      const event: AgentStreamEvent = {
        type: "permission_requested",
        agentId: "agent-1",
        data: {
          toolName: "Bash",
          description: 'Run: npm install',
          toolUseId: "tool-1",
        },
        timestamp: "2026-02-22T14:00:00Z",
      };

      const notif = manager.mapEventToNotification(event, {
        hostId: "host-1",
        hostName: "Work MacBook",
        projectName: "my-project",
        sessionId: "sess-1",
      });

      expect(notif).toBeDefined();
      expect(notif?.type).toBe("permission_request");
      expect(notif?.priority).toBe("time-sensitive");
      expect(notif?.title).toContain("Work MacBook");
      expect(notif?.body).toContain("npm install");
    });

    it("maps agent_completed event to notification", () => {
      const event: AgentStreamEvent = {
        type: "agent_completed",
        agentId: "agent-1",
        data: { result: "Task completed successfully" },
        timestamp: "2026-02-22T14:00:00Z",
      };

      const notif = manager.mapEventToNotification(event, {
        hostId: "host-1",
        hostName: "Work MacBook",
        projectName: "my-project",
        sessionId: "sess-1",
      });

      expect(notif).toBeDefined();
      expect(notif?.type).toBe("agent_completed");
      expect(notif?.priority).toBe("active");
    });

    it("maps agent_error event to notification", () => {
      const event: AgentStreamEvent = {
        type: "agent_error",
        agentId: "agent-1",
        data: { error: "Process crashed" },
        timestamp: "2026-02-22T14:00:00Z",
      };

      const notif = manager.mapEventToNotification(event, {
        hostId: "host-1",
        hostName: "Work MacBook",
        projectName: "my-project",
        sessionId: "sess-1",
      });

      expect(notif?.type).toBe("agent_error");
      expect(notif?.priority).toBe("active");
    });

    it("maps session_ended event to notification", () => {
      const event: AgentStreamEvent = {
        type: "session_ended",
        agentId: "agent-1",
        data: { reason: "completed" },
        timestamp: "2026-02-22T14:00:00Z",
      };

      const notif = manager.mapEventToNotification(event, {
        hostId: "host-1",
        hostName: "Work MacBook",
        projectName: "my-project",
        sessionId: "sess-1",
      });

      expect(notif?.type).toBe("session_ended");
      expect(notif?.priority).toBe("passive");
    });

    it("returns null for unmapped event types", () => {
      const event: AgentStreamEvent = {
        type: "tool_call_started",
        agentId: "agent-1",
        data: {},
        timestamp: "2026-02-22T14:00:00Z",
      };

      const notif = manager.mapEventToNotification(event, {
        hostId: "host-1",
        hostName: "Work MacBook",
        projectName: "my-project",
        sessionId: "sess-1",
      });

      expect(notif).toBeNull();
    });
  });

  describe("notification queue", () => {
    it("enqueue adds notification", () => {
      const notif: AgentNotification = {
        id: "n1",
        type: "permission_request",
        hostId: "host-1",
        hostName: "Work MacBook",
        agentId: "agent-1",
        projectName: "my-project",
        sessionId: "sess-1",
        title: "Permission Required",
        body: "Test",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      };

      manager.enqueue(notif);
      expect(manager.getQueue()).toHaveLength(1);
    });

    it("dequeue returns and removes first notification", () => {
      const n1: AgentNotification = {
        id: "n1",
        type: "permission_request",
        hostId: "host-1",
        hostName: "MacBook",
        agentId: "a1",
        projectName: "proj",
        sessionId: "s1",
        title: "T1",
        body: "B1",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      };
      const n2: AgentNotification = {
        ...n1,
        id: "n2",
        createdAt: "2026-02-22T14:01:00Z",
      };

      manager.enqueue(n1);
      manager.enqueue(n2);
      const dequeued = manager.dequeue();
      expect(dequeued?.id).toBe("n1");
      expect(manager.getQueue()).toHaveLength(1);
    });

    it("dequeue from empty queue returns undefined", () => {
      expect(manager.dequeue()).toBeUndefined();
    });

    it("markRead sets notification as read", () => {
      const notif: AgentNotification = {
        id: "n1",
        type: "permission_request",
        hostId: "host-1",
        hostName: "MacBook",
        agentId: "a1",
        projectName: "proj",
        sessionId: "s1",
        title: "T1",
        body: "B1",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      };

      manager.enqueue(notif);
      manager.markRead("n1");
      expect(manager.getQueue()[0].read).toBe(true);
    });

    it("markAllRead marks all notifications as read", () => {
      for (let i = 0; i < 3; i++) {
        manager.enqueue({
          id: `n${i}`,
          type: "permission_request",
          hostId: "host-1",
          hostName: "MacBook",
          agentId: "a1",
          projectName: "proj",
          sessionId: "s1",
          title: `T${i}`,
          body: `B${i}`,
          data: {},
          createdAt: "2026-02-22T14:00:00Z",
          read: false,
          priority: "time-sensitive",
        });
      }

      manager.markAllRead();
      expect(manager.getQueue().every((n) => n.read)).toBe(true);
    });

    it("clearQueue removes all notifications", () => {
      manager.enqueue({
        id: "n1",
        type: "permission_request",
        hostId: "host-1",
        hostName: "MacBook",
        agentId: "a1",
        projectName: "proj",
        sessionId: "s1",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      });

      manager.clearQueue();
      expect(manager.getQueue()).toHaveLength(0);
    });
  });

  describe("badge computation", () => {
    it("getUnreadCount returns count of unread notifications", () => {
      manager.enqueue({
        id: "n1",
        type: "permission_request",
        hostId: "h",
        hostName: "M",
        agentId: "a",
        projectName: "p",
        sessionId: "s",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      });
      manager.enqueue({
        id: "n2",
        type: "agent_completed",
        hostId: "h",
        hostName: "M",
        agentId: "a",
        projectName: "p",
        sessionId: "s",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: true,
        priority: "active",
      });

      expect(manager.getUnreadCount()).toBe(1);
    });

    it("getUnreadCount returns 0 for empty queue", () => {
      expect(manager.getUnreadCount()).toBe(0);
    });

    it("getBadgeCount returns count of actionable unread notifications", () => {
      manager.enqueue({
        id: "n1",
        type: "permission_request",
        hostId: "h",
        hostName: "M",
        agentId: "a",
        projectName: "p",
        sessionId: "s",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      });
      manager.enqueue({
        id: "n2",
        type: "long_running_update",
        hostId: "h",
        hostName: "M",
        agentId: "a",
        projectName: "p",
        sessionId: "s",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "passive",
      });

      // Only time-sensitive and active count for badge
      expect(manager.getBadgeCount()).toBe(1);
    });
  });

  describe("notification settings", () => {
    it("uses default settings initially", () => {
      expect(manager.getSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    });

    it("updateSettings merges with current settings", () => {
      manager.updateSettings({
        perType: {
          ...DEFAULT_NOTIFICATION_SETTINGS.perType,
          session_ended: true,
        },
      });
      expect(manager.getSettings().perType.session_ended).toBe(true);
      expect(manager.getSettings().perType.permission_request).toBe(true);
    });

    it("shouldNotify returns false when master toggle is off", () => {
      manager.updateSettings({ enabled: false });
      expect(manager.shouldNotify("permission_request")).toBe(false);
    });

    it("shouldNotify respects per-type toggles", () => {
      expect(manager.shouldNotify("permission_request")).toBe(true);
      expect(manager.shouldNotify("session_ended")).toBe(false);
    });

    it("shouldNotify returns false during quiet hours", () => {
      manager.updateSettings({
        quietHours: { enabled: true, startTime: "13:00", endTime: "15:00" },
      });
      // Current time is 14:00 UTC, within quiet hours
      expect(manager.shouldNotify("permission_request")).toBe(false);
    });

    it("shouldNotify returns true outside quiet hours", () => {
      manager.updateSettings({
        quietHours: { enabled: true, startTime: "20:00", endTime: "06:00" },
      });
      // Current time is 14:00 UTC, outside quiet hours
      expect(manager.shouldNotify("permission_request")).toBe(true);
    });

    it("quiet hours spanning midnight works correctly", () => {
      manager.updateSettings({
        quietHours: { enabled: true, startTime: "22:00", endTime: "08:00" },
      });
      // Current time is 14:00 UTC, outside 22:00-08:00
      expect(manager.shouldNotify("permission_request")).toBe(true);

      // Now set time to 23:00
      vi.setSystemTime(new Date("2026-02-22T23:00:00Z"));
      expect(manager.shouldNotify("permission_request")).toBe(false);

      // Set time to 03:00 (still in quiet hours)
      vi.setSystemTime(new Date("2026-02-23T03:00:00Z"));
      expect(manager.shouldNotify("permission_request")).toBe(false);
    });
  });

  describe("deep link generation", () => {
    it("generates deep link data for permission request", () => {
      const notif: AgentNotification = {
        id: "n1",
        type: "permission_request",
        hostId: "host-1",
        hostName: "MacBook",
        agentId: "agent-1",
        projectName: "proj",
        sessionId: "sess-1",
        title: "T",
        body: "B",
        data: { toolUseId: "tool-1" },
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "time-sensitive",
      };

      const link = manager.getDeepLink(notif);
      expect(link.screen).toBe("AgentDetail");
      expect(link.params.hostId).toBe("host-1");
      expect(link.params.agentId).toBe("agent-1");
    });

    it("generates deep link data for session ended", () => {
      const notif: AgentNotification = {
        id: "n1",
        type: "session_ended",
        hostId: "host-1",
        hostName: "MacBook",
        agentId: "agent-1",
        projectName: "proj",
        sessionId: "sess-1",
        title: "T",
        body: "B",
        data: {},
        createdAt: "2026-02-22T14:00:00Z",
        read: false,
        priority: "passive",
      };

      const link = manager.getDeepLink(notif);
      expect(link.screen).toBe("SessionDetail");
      expect(link.params.sessionId).toBe("sess-1");
    });
  });
});
