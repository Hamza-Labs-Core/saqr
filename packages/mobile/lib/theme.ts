import { createContext, useContext, type ReactNode } from "react";
import { useColorScheme } from "react-native";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  foreground: string;
  foregroundMuted: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  success: string;
  warning: string;
  border: string;
  borderMuted: string;
  // Agent status colors
  statusRunning: string;
  statusIdle: string;
  statusError: string;
  statusWaiting: string;
  statusCompleted: string;
  statusDisconnected: string;
}

export const darkTheme: ThemeColors = {
  background: "#000000",
  surface: "#1a1a1a",
  surfaceElevated: "#2a2a2a",
  foreground: "#ffffff",
  foregroundMuted: "#8e8e93",
  primary: "#0a84ff",
  primaryForeground: "#ffffff",
  destructive: "#ff453a",
  success: "#30d158",
  warning: "#ffd60a",
  border: "#38383a",
  borderMuted: "#2c2c2e",
  statusRunning: "#30d158",
  statusIdle: "#8e8e93",
  statusError: "#ff453a",
  statusWaiting: "#ffd60a",
  statusCompleted: "#0a84ff",
  statusDisconnected: "#48484a",
};

export const lightTheme: ThemeColors = {
  background: "#ffffff",
  surface: "#f2f2f7",
  surfaceElevated: "#ffffff",
  foreground: "#000000",
  foregroundMuted: "#8e8e93",
  primary: "#007aff",
  primaryForeground: "#ffffff",
  destructive: "#ff3b30",
  success: "#34c759",
  warning: "#ffcc00",
  border: "#c6c6c8",
  borderMuted: "#e5e5ea",
  statusRunning: "#34c759",
  statusIdle: "#8e8e93",
  statusError: "#ff3b30",
  statusWaiting: "#ffcc00",
  statusCompleted: "#007aff",
  statusDisconnected: "#c7c7cc",
};

export interface ThemeContextValue {
  theme: ThemeColors;
  isDark: boolean;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: darkTheme,
  isDark: true,
});

export function useThemeContext(): ThemeContextValue {
  return useContext(ThemeContext);
}

export { type ReactNode };
