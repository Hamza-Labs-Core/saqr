import React, { useMemo } from "react";
import { Stack } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "react-native";
import { queryClient } from "../lib/query-client";
import { ThemeContext, darkTheme, lightTheme } from "../lib/theme";
import { useSettingsStore } from "../stores/settings-store";

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = useSettingsStore((s) => s.theme);

  // In a real app, useColorScheme from react-native would be used.
  // For now, default to dark when "auto".
  const value = useMemo(() => {
    const isDark = preference === "auto" ? true : preference === "dark";
    return { theme: isDark ? darkTheme : lightTheme, isDark };
  }, [preference]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <StatusBar barStyle="light-content" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" options={{ title: "Saqr" }} />
              <Stack.Screen
                name="pair-scan"
                options={{
                  presentation: "modal",
                  title: "Pair Daemon",
                }}
              />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="h/[serverId]" />
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
