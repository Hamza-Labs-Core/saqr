import React from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../stores/daemon-store";
import { useThemeContext } from "../../../lib/theme";

export default function ServerLayout() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = serverId ? getDaemon(serverId) : undefined;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.primary,
        headerTitleStyle: { color: theme.foreground },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: daemon?.name ?? "Server" }}
      />
      <Stack.Screen name="agents" options={{ title: "Agents" }} />
      <Stack.Screen name="settings" options={{ title: "Server Settings" }} />
      <Stack.Screen name="agent/[agentId]" options={{ title: "Agent" }} />
    </Stack>
  );
}
