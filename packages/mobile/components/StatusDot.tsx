import React from "react";
import { View, StyleSheet } from "react-native";
import type { ConnectionState } from "../src/types/daemon";
import type { AgentStatus } from "../src/types/agent";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface StatusDotProps {
  status: ConnectionState | AgentStatus;
  size?: number;
}

export function StatusDot({ status, size = LAYOUT.statusDotSize }: StatusDotProps) {
  const { theme } = useThemeContext();

  const colorMap: Record<string, string> = {
    connected: theme.statusRunning,
    connecting: theme.statusWaiting,
    disconnected: theme.statusDisconnected,
    error: theme.statusError,
    running: theme.statusRunning,
    idle: theme.statusIdle,
    initializing: theme.statusWaiting,
    waiting_permission: theme.statusWaiting,
    completed: theme.statusCompleted,
  };

  const color = colorMap[status] ?? theme.statusDisconnected;

  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {},
});
