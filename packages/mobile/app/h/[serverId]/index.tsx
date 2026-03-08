import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../stores/daemon-store";
import { useDaemonConnection } from "../../../hooks/use-daemon-connection";
import { StatusDot } from "../../../components/StatusDot";
import { useThemeContext } from "../../../lib/theme";
import { LAYOUT } from "../../../lib/constants";

export default function ServerHomeScreen() {
  const router = useRouter();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = serverId ? getDaemon(serverId) : undefined;
  const { connectionState, connect, disconnect, isConnected } =
    useDaemonConnection(serverId ?? "");

  if (!daemon) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.foregroundMuted }}>Daemon not found.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Connection Status */}
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <View style={styles.statusRow}>
          <StatusDot status={connectionState} />
          <Text style={[styles.statusText, { color: theme.foreground }]}>
            {connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}
          </Text>
        </View>
        <Text style={[styles.hostname, { color: theme.foregroundMuted }]}>
          {daemon.hostname} ({daemon.os})
        </Text>
        {daemon.lanAddress && (
          <Text style={[styles.address, { color: theme.foregroundMuted }]}>
            {daemon.lanAddress}
          </Text>
        )}
        <View style={styles.actions}>
          {isConnected ? (
            <Pressable
              style={[styles.button, { backgroundColor: theme.destructive }]}
              onPress={() => void disconnect()}
            >
              <Text style={{ color: "#fff", fontWeight: "600" }}>Disconnect</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={() => void connect()}
            >
              <Text style={{ color: theme.primaryForeground, fontWeight: "600" }}>
                Connect
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Quick Links */}
      <View style={styles.links}>
        <Pressable
          style={[styles.linkCard, { backgroundColor: theme.surface }]}
          onPress={() => router.push(`/h/${serverId}/agents` as any)}
        >
          <Text style={[styles.linkTitle, { color: theme.foreground }]}>
            Agents
          </Text>
          <Text style={[styles.linkSubtitle, { color: theme.foregroundMuted }]}>
            View all agents
          </Text>
        </Pressable>

        <Pressable
          style={[styles.linkCard, { backgroundColor: theme.surface }]}
          onPress={() => router.push(`/h/${serverId}/settings` as any)}
        >
          <Text style={[styles.linkTitle, { color: theme.foreground }]}>
            Settings
          </Text>
          <Text style={[styles.linkSubtitle, { color: theme.foregroundMuted }]}>
            Server configuration
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: LAYOUT.screenPaddingH,
  },
  card: {
    borderRadius: LAYOUT.cardRadius,
    padding: 16,
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  statusText: {
    fontSize: 16,
    fontWeight: "600",
  },
  hostname: {
    fontSize: 14,
    marginBottom: 4,
  },
  address: {
    fontSize: 12,
    marginBottom: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: LAYOUT.buttonRadius,
    alignItems: "center",
  },
  links: {
    flexDirection: "row",
    gap: 12,
  },
  linkCard: {
    flex: 1,
    borderRadius: LAYOUT.cardRadius,
    padding: 16,
  },
  linkTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  linkSubtitle: {
    fontSize: 12,
  },
});
