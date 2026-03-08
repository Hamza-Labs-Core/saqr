import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { HostProfile, ConnectionState } from "../src/types/daemon";
import { StatusDot } from "./StatusDot";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface DaemonCardProps {
  host: HostProfile;
  connectionState: ConnectionState;
  onPress: () => void;
}

const OS_LABELS: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

export function DaemonCard({
  host,
  connectionState,
  onPress,
}: DaemonCardProps) {
  const { theme } = useThemeContext();

  return (
    <Pressable
      style={[styles.card, { backgroundColor: theme.surface }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${host.name}, ${connectionState}`}
    >
      <View style={styles.row}>
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <StatusDot status={connectionState} />
            <Text style={[styles.name, { color: theme.foreground }]}>
              {host.name}
            </Text>
          </View>
          <Text style={[styles.hostname, { color: theme.foregroundMuted }]}>
            {host.hostname} &middot; {OS_LABELS[host.os] ?? host.os}
          </Text>
          {host.lanAddress && (
            <Text style={[styles.address, { color: theme.foregroundMuted }]}>
              {host.lanAddress}
            </Text>
          )}
        </View>
        <Text style={{ color: theme.foregroundMuted, fontSize: 18 }}>{">"}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: LAYOUT.cardRadius,
    padding: 16,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  info: {
    flex: 1,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  name: {
    fontSize: 16,
    fontWeight: "600",
  },
  hostname: {
    fontSize: 13,
    marginLeft: 18,
  },
  address: {
    fontSize: 12,
    marginLeft: 18,
    marginTop: 2,
  },
});
