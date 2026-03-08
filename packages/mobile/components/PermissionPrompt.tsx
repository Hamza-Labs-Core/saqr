import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PermissionRequest } from "../src/types/agent";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface PermissionPromptProps {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({
  request,
  onApprove,
  onDeny,
}: PermissionPromptProps) {
  const { theme } = useThemeContext();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.surface,
          borderColor: theme.warning,
        },
      ]}
    >
      <Text style={[styles.title, { color: theme.foreground }]}>
        Permission Required
      </Text>
      <Text style={[styles.toolName, { color: theme.primary }]}>
        {request.toolName}
      </Text>
      <Text style={[styles.description, { color: theme.foregroundMuted }]}>
        {request.description}
      </Text>
      {request.filePath && (
        <Text style={[styles.detail, { color: theme.foregroundMuted }]}>
          File: {request.filePath}
        </Text>
      )}
      {request.command && (
        <Text style={[styles.detail, { color: theme.foregroundMuted }]}>
          Command: {request.command}
        </Text>
      )}
      <View style={styles.actions}>
        <Pressable
          style={[styles.button, styles.denyButton, { borderColor: theme.border }]}
          onPress={onDeny}
        >
          <Text style={{ color: theme.destructive, fontWeight: "600" }}>
            Deny
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.approveButton, { backgroundColor: theme.success }]}
          onPress={onApprove}
        >
          <Text style={{ color: "#fff", fontWeight: "600" }}>Allow</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: LAYOUT.screenPaddingH,
    marginVertical: 6,
    borderRadius: LAYOUT.cardRadius,
    borderWidth: 1,
    padding: 16,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  toolName: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 4,
  },
  description: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  detail: {
    fontSize: 12,
    fontFamily: "monospace",
    marginBottom: 2,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: LAYOUT.buttonRadius,
    minWidth: 80,
    alignItems: "center",
  },
  denyButton: {
    borderWidth: 1,
  },
  approveButton: {},
});
