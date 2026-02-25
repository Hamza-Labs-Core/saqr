/**
 * Tests for the theme resolution logic.
 *
 * Verifies that theme selection respects user preference
 * and falls back correctly when system preference is unavailable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { darkTheme, lightTheme } from "../../../lib/theme.js";
import { clearStorage } from "../../../lib/storage.js";

// Test the theme resolution logic directly (without React hooks)
function resolveTheme(
  preference: "light" | "dark" | "auto",
  systemScheme: "light" | "dark" | null,
) {
  const isDark =
    preference === "auto"
      ? systemScheme !== "light"
      : preference === "dark";
  return { theme: isDark ? darkTheme : lightTheme, isDark };
}

describe("use-theme (logic)", () => {
  beforeEach(() => {
    clearStorage();
    useSettingsStore.getState().setTheme("auto");
  });

  it("returns dark theme when preference is 'dark'", () => {
    const result = resolveTheme("dark", null);
    expect(result.isDark).toBe(true);
    expect(result.theme).toEqual(darkTheme);
  });

  it("returns light theme when preference is 'light'", () => {
    const result = resolveTheme("light", null);
    expect(result.isDark).toBe(false);
    expect(result.theme).toEqual(lightTheme);
  });

  it("returns dark theme when preference is 'auto' and system is dark", () => {
    const result = resolveTheme("auto", "dark");
    expect(result.isDark).toBe(true);
    expect(result.theme).toEqual(darkTheme);
  });

  it("returns light theme when preference is 'auto' and system is light", () => {
    const result = resolveTheme("auto", "light");
    expect(result.isDark).toBe(false);
    expect(result.theme).toEqual(lightTheme);
  });

  it("defaults to dark when preference is 'auto' and system is null", () => {
    const result = resolveTheme("auto", null);
    expect(result.isDark).toBe(true);
    expect(result.theme).toEqual(darkTheme);
  });

  it("store preference integrates with resolve", () => {
    useSettingsStore.getState().setTheme("light");
    const pref = useSettingsStore.getState().theme;
    const result = resolveTheme(pref, null);
    expect(result.isDark).toBe(false);
  });
});
