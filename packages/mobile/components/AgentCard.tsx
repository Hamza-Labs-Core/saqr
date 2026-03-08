import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { AgentSummary } from "../src/types/agent";
import { StatusDot } from "./StatusDot";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface AgentCardProps {
  agent: AgentSummary;
  onPress: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
};

export function AgentCard({ agent, onPress }: AgentCardProps) {
  const { theme } = useThemeContext();

  return (
    <Pressable
      style={[styles.card, { backgroundColor: theme.surface }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${agent.projectName} agent, ${agent.status}`}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <StatusDot status={agent.status} />
          <Text style={[styles.projectName, { color: theme.foreground }]}>
            {agent.projectName}
          </Text>
        </View>
        <View style={[styles.providerBadge, { backgroundColor: theme.surfaceElevated }]}>
          <Text style={[styles.providerText, { color: theme.foregroundMuted }]}>
            {PROVIDER_LABELS[agent.provider] ?? agent.provider}
          </Text>
        </View>
      </View>

      {agent.currentActivity && (
        <Text
          style={[styles.activity, { color: theme.foregroundMuted }]}
          numberOfLines={1}
        >
          {agent.currentActivity}
        </Text>
      )}

      <View style={styles.footer}>
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
          {agent.model}
        </Text>
        {agent.pendingPermissions > 0 && (
          <View style={[styles.badge, { backgroundColor: theme.warning }]}>
            <Text style={styles.badgeText}>
              {agent.pendingPermissions}
            </Text>
          </View>
        )}
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
    fontSize: 16,
    fontWeight: "600",
  },
  providerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  providerText: {
    fontSize: 11,
    fontWeight: "500",
  },
  activity: {
    fontSize: 13,
    marginLeft: 18,
    marginBottom: 8,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginLeft: 18,
  },
  meta: {
    fontSize: 12,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 20,
    alignItems: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#000",
  },
});
