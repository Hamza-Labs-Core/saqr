/**
 * Push notification setup and category registration.
 *
 * In the real app, this module uses expo-notifications to register
 * notification categories, request permissions, and schedule
 * local notifications for agent events.
 */

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "../src/types/notification.js";

/** Register notification categories matching the data layer definitions. */
export function getNotificationCategories(): NotificationCategory[] {
  return NOTIFICATION_CATEGORIES;
}

/**
 * Build a notification request payload for expo-notifications.
 *
 * This returns a plain object that can be passed to
 * `Notifications.scheduleNotificationAsync` in the real app.
 */
export function buildNotificationContent(params: {
  title: string;
  body: string;
  data?: Record<string, string>;
  categoryId?: string;
}): {
  content: {
    title: string;
    body: string;
    data: Record<string, string>;
    categoryIdentifier?: string;
    sound: boolean;
  };
  trigger: null;
} {
  return {
    content: {
      title: params.title,
      body: params.body,
      data: params.data ?? {},
      categoryIdentifier: params.categoryId,
      sound: true,
    },
    trigger: null,
  };
}
