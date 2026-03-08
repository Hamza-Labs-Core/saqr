import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface EmptyStateProps {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  const { theme } = useThemeContext();

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: theme.foreground }]}>{title}</Text>
      <Text style={[styles.message, { color: theme.foregroundMuted }]}>
        {message}
      </Text>
      {actionLabel && onAction && (
        <Pressable
          style={[styles.button, { backgroundColor: theme.primary }]}
          onPress={onAction}
        >
          <Text style={{ color: theme.primaryForeground, fontWeight: "600" }}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 64,
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  message: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: LAYOUT.buttonRadius,
  },
});
