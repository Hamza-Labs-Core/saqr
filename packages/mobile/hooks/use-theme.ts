import { useMemo } from "react";
import { useSettingsStore } from "../stores/settings-store.js";
import { darkTheme, lightTheme, type ThemeColors } from "../lib/theme.js";

/**
 * Hook for resolving the current theme.
 *
 * Respects the user's theme preference (light/dark/auto). When set to
 * "auto", falls back to the system color scheme. In non-RN environments
 * (e.g., vitest), defaults to dark theme for "auto".
 */
export function useTheme(): { theme: ThemeColors; isDark: boolean } {
  const preference = useSettingsStore((s) => s.theme);

  // In environments without RN (vitest), useColorScheme is not available.
  // We detect the system scheme as null and default to dark.
  let systemScheme: "light" | "dark" | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    if (rn && typeof rn.useColorScheme === "function") {
      systemScheme = rn.useColorScheme() as "light" | "dark" | null;
    }
  } catch {
    // react-native not available in test environment
  }

  return useMemo(() => {
    const isDark =
      preference === "auto"
        ? systemScheme !== "light"
        : preference === "dark";
    return { theme: isDark ? darkTheme : lightTheme, isDark };
  }, [systemScheme, preference]);
}
