import React from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  StyleSheet,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../stores/daemon-store";
import { StatusDot } from "../../../components/StatusDot";
import { useThemeContext } from "../../../lib/theme";
import { LAYOUT } from "../../../lib/constants";

export default function ServerSettingsScreen() {
  const router = useRouter();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const removeDaemon = useDaemonStore((s) => s.removeDaemon);
  const connectionStates = useDaemonStore((s) => s.connectionStates);
  const daemon = serverId ? getDaemon(serverId) : undefined;

  if (!daemon) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.foregroundMuted }}>Daemon not found.</Text>
      </View>
    );
  }

  const handleRemove = () => {
    Alert.alert(
      "Remove Daemon",
      `Remove "${daemon.name}" from your paired daemons? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            removeDaemon(daemon.id);
            router.replace("/");
          },
        },
      ],
    );
  };

  const connectionState = connectionStates[daemon.id] ?? "disconnected";

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
    >
      {/* Daemon Info */}
      <View style={[styles.section, { backgroundColor: theme.surface }]}>
        <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>Name</Text>
          <Text style={{ color: theme.foreground }}>{daemon.name}</Text>
        </View>
        <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>Hostname</Text>
          <Text style={{ color: theme.foreground }}>{daemon.hostname}</Text>
        </View>
        <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>OS</Text>
          <Text style={{ color: theme.foreground }}>{daemon.os}</Text>
        </View>
        <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>Connection</Text>
          <Text style={{ color: theme.foreground }}>{daemon.connectionType}</Text>
        </View>
        {daemon.lanAddress && (
          <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
            <Text style={[styles.label, { color: theme.foregroundMuted }]}>Address</Text>
            <Text style={{ color: theme.foreground }}>{daemon.lanAddress}</Text>
          </View>
        )}
        <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>Status</Text>
          <View style={styles.statusRow}>
            <StatusDot status={connectionState} />
            <Text style={{ color: theme.foreground }}>{connectionState}</Text>
          </View>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>Version</Text>
          <Text style={{ color: theme.foreground }}>{daemon.daemonVersion}</Text>
        </View>
      </View>

      {/* Danger Zone */}
      <Text style={[styles.sectionHeader, { color: theme.foregroundMuted }]}>
        DANGER ZONE
      </Text>
      <View style={[styles.section, { backgroundColor: theme.surface }]}>
        <Pressable style={styles.row} onPress={handleRemove}>
          <Text style={{ color: theme.destructive, fontWeight: "600" }}>
            Remove Daemon
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: LAYOUT.screenPaddingH,
    paddingBottom: 32,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  section: {
    borderRadius: LAYOUT.cardRadius,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: LAYOUT.minTouchTarget,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: 14,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});
