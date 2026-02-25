import React from "react";
import { View, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useAgentStream } from "../../../../hooks/use-agent-stream";
import { useDaemonStore } from "../../../../stores/daemon-store";
import { AgentStream } from "../../../../components/AgentStream";
import { PromptInput } from "../../../../components/PromptInput";
import { PermissionPrompt } from "../../../../components/PermissionPrompt";
import { useThemeContext } from "../../../../lib/theme";

export default function AgentDetailScreen() {
  const { serverId, agentId } = useLocalSearchParams<{
    serverId: string;
    agentId: string;
  }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = serverId ? getDaemon(serverId) : undefined;
  const wsUrl = daemon?.lanAddress ? `ws://${daemon.lanAddress}` : null;

  const { events, isConnected, sendPrompt, approvePermission, denyPermission } =
    useAgentStream(wsUrl, agentId ?? "");

  // Separate permission events from stream events
  const permissionEvents = events.filter(
    (e) => e.type === "permission_request",
  );
  const streamEvents = events.filter(
    (e) => e.type !== "permission_request",
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={88}
    >
      <View style={styles.streamContainer}>
        <AgentStream events={streamEvents} />
      </View>

      {permissionEvents.map((perm) => (
        <PermissionPrompt
          key={String(perm.data["toolUseId"] ?? perm.timestamp)}
          request={{
            toolUseId: String(perm.data["toolUseId"] ?? ""),
            toolName: String(perm.data["toolName"] ?? ""),
            toolInput: (perm.data["toolInput"] as Record<string, unknown>) ?? {},
            description: String(perm.data["description"] ?? ""),
            filePath: perm.data["filePath"] as string | undefined,
            command: perm.data["command"] as string | undefined,
            timestamp: perm.timestamp,
          }}
          onApprove={() =>
            approvePermission(String(perm.data["toolUseId"]))
          }
          onDeny={() =>
            denyPermission(String(perm.data["toolUseId"]))
          }
        />
      ))}

      <PromptInput onSend={sendPrompt} disabled={!isConnected} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  streamContainer: {
    flex: 1,
  },
});
