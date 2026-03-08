import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { SessionSummary } from "../src/types/session";
import { StatusDot } from "./StatusDot";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface SessionListItemProps {
  session: SessionSummary;
  onPress: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionListItem({ session, onPress }: SessionListItemProps) {
  const { theme } = useThemeContext();

  const statusMap: Record<string, string> = {
    active: "running",
    completed: "completed",
    error: "error",
  };

  return (
    <Pressable
      style={[styles.card, { backgroundColor: theme.surface }]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <StatusDot status={(statusMap[session.status] ?? "idle") as any} />
          <Text style={[styles.projectName, { color: theme.foreground }]}>
            {session.projectName}
          </Text>
        </View>
        <Text style={[styles.time, { color: theme.foregroundMuted }]}>
          {formatRelativeTime(session.startedAt)}
        </Text>
      </View>

      {session.lastPromptPreview && (
        <Text
          style={[styles.preview, { color: theme.foregroundMuted }]}
          numberOfLines={2}
        >
          {session.lastPromptPreview}
        </Text>
      )}

      <View style={styles.footer}>
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
          {session.hostName}
        </Text>
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
          {formatDuration(session.duration)}
        </Text>
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
          {session.promptCount} prompts
        </Text>
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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  projectName: {
    fontSize: 15,
    fontWeight: "600",
  },
  time: {
    fontSize: 12,
  },
  preview: {
    fontSize: 13,
    lineHeight: 18,
    marginLeft: 18,
    marginBottom: 8,
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    marginLeft: 18,
  },
  meta: {
    fontSize: 12,
  },
});
