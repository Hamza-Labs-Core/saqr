import { useCallback, useRef } from "react";
import { NotificationManager } from "../src/services/notification-manager.js";
import type { AgentStreamEvent } from "../src/types/agent.js";
import type { AgentNotification } from "../src/types/notification.js";
import { useSettingsStore } from "../stores/settings-store.js";

/**
 * Hook for dispatching notifications from agent stream events.
 *
 * Uses the NotificationManager from the data layer to map events to
 * notifications and check whether they should be shown based on
 * user settings.
 */
export function useNotifications() {
  const managerRef = useRef(new NotificationManager());
  const notificationSettings = useSettingsStore((s) => s.notifications);

  const manager = managerRef.current;

  const processEvent = useCallback(
    (
      event: AgentStreamEvent,
      context: {
        hostId: string;
        hostName: string;
        projectName: string;
        sessionId: string;
      },
    ): AgentNotification | null => {
      // Update manager settings from store
      manager.updateSettings(notificationSettings);

      const notification = manager.mapEventToNotification(event, context);
      if (!notification) return null;

      if (!manager.shouldNotify(notification.type)) return null;

      manager.enqueue(notification);
      return notification;
    },
    [manager, notificationSettings],
  );

  const getUnreadCount = useCallback(() => {
    return manager.getUnreadCount();
  }, [manager]);

  const getBadgeCount = useCallback(() => {
    return manager.getBadgeCount();
  }, [manager]);

  const markRead = useCallback(
    (id: string) => {
      manager.markRead(id);
    },
    [manager],
  );

  const markAllRead = useCallback(() => {
    manager.markAllRead();
  }, [manager]);

  const clearAll = useCallback(() => {
    manager.clearQueue();
  }, [manager]);

  return {
    processEvent,
    getUnreadCount,
    getBadgeCount,
    markRead,
    markAllRead,
    clearAll,
  };
}
