import React from "react";
import { View, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../../stores/daemon-store";
import { useTerminalStream } from "../../../../hooks/use-terminal-stream";
import { TerminalStream } from "../../../../components/TerminalStream";
import { PromptInput } from "../../../../components/PromptInput";
import { VoicePanel } from "../../../../components/VoicePanel";
import { useVoiceInput } from "../../../../hooks/use-voice-input";
import { useThemeContext } from "../../../../lib/theme";

export default function AgentDetailScreen() {
  const { serverId, agentId } = useLocalSearchParams<{
    serverId: string;
    agentId: string;
  }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = serverId ? getDaemon(serverId) : undefined;
  const wsUrl = daemon?.lanAddress
    ? `ws://${daemon.lanAddress}/ws/session/${agentId}`
    : null;

  const {
    items,
    connectionState,
    sessionInfo,
    sendInput,
    sendPermissionResponse,
  } = useTerminalStream({
    wsUrl,
    sessionId: agentId ?? "",
  });

  const voice = useVoiceInput();

  // When voice finalizes, send transcript as input
  React.useEffect(() => {
    if (voice.finalTranscript) {
      sendInput(voice.finalTranscript);
    }
  }, [voice.finalTranscript, sendInput]);

  function handleSend(text: string) {
    sendInput(text);
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={88}
    >
      <View style={styles.streamContainer}>
        <TerminalStream
          items={items}
          onPermissionResponse={sendPermissionResponse}
        />
      </View>

      <VoicePanel
        isRecording={voice.isRecording}
        isProcessing={voice.isProcessing}
        duration={voice.duration}
        partialTranscript={voice.partialTranscript}
        error={voice.error}
        onStop={voice.stopRecording}
        onCancel={voice.cancelRecording}
      />

      <PromptInput
        onSend={handleSend}
        disabled={connectionState !== "connected"}
      />
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
