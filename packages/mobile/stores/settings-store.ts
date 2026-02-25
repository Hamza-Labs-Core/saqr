import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { zustandStorage } from "../lib/storage.js";
import type { NotificationSettings } from "../src/types/notification.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../src/types/notification.js";

export type ThemePreference = "light" | "dark" | "auto";

interface SettingsState {
  theme: ThemePreference;
  notifications: NotificationSettings;
  hapticFeedback: boolean;

  setTheme: (theme: ThemePreference) => void;
  setNotifications: (settings: Partial<NotificationSettings>) => void;
  setHapticFeedback: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "auto" as ThemePreference,
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      hapticFeedback: true,

      setTheme: (theme: ThemePreference) => set({ theme }),

      setNotifications: (settings: Partial<NotificationSettings>) =>
        set((state) => ({
          notifications: { ...state.notifications, ...settings },
        })),

      setHapticFeedback: (enabled: boolean) =>
        set({ hapticFeedback: enabled }),
    }),
    {
      name: "saqr-settings",
      storage: createJSONStorage(() => zustandStorage),
    },
  ),
);
