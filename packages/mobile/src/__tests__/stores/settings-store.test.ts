/**
 * Tests for the settings Zustand store.
 *
 * Verifies theme, notification, and haptic feedback settings
 * through the persisted Zustand store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { clearStorage } from "../../../lib/storage.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../types/notification.js";

describe("settings-store", () => {
  beforeEach(() => {
    clearStorage();
    // Reset store to defaults
    const store = useSettingsStore.getState();
    store.setTheme("auto");
    store.setHapticFeedback(true);
    store.setNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS });
  });

  it("starts with default values", () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe("auto");
    expect(state.hapticFeedback).toBe(true);
    expect(state.notifications.enabled).toBe(true);
  });

  it("setTheme updates theme preference", () => {
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");

    useSettingsStore.getState().setTheme("light");
    expect(useSettingsStore.getState().theme).toBe("light");

    useSettingsStore.getState().setTheme("auto");
    expect(useSettingsStore.getState().theme).toBe("auto");
  });

  it("setHapticFeedback toggles haptic feedback", () => {
    useSettingsStore.getState().setHapticFeedback(false);
    expect(useSettingsStore.getState().hapticFeedback).toBe(false);

    useSettingsStore.getState().setHapticFeedback(true);
    expect(useSettingsStore.getState().hapticFeedback).toBe(true);
  });

  it("setNotifications merges partial updates", () => {
    useSettingsStore.getState().setNotifications({ enabled: false });
    expect(useSettingsStore.getState().notifications.enabled).toBe(false);

    // perType should still have defaults
    expect(
      useSettingsStore.getState().notifications.perType.permission_request,
    ).toBe(true);
  });

  it("setNotifications updates perType settings", () => {
    useSettingsStore.getState().setNotifications({
      perType: {
        ...DEFAULT_NOTIFICATION_SETTINGS.perType,
        agent_completed: false,
      },
    });

    const state = useSettingsStore.getState();
    expect(state.notifications.perType.agent_completed).toBe(false);
    expect(state.notifications.perType.permission_request).toBe(true);
  });
});
