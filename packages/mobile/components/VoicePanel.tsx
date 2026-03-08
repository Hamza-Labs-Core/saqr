import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface VoicePanelProps {
  isRecording: boolean;
  isProcessing: boolean;
  duration: number;
  partialTranscript: string;
  error: string | null;
  onStop: () => void;
  onCancel: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function VoicePanel({
  isRecording,
  isProcessing,
  duration,
  partialTranscript,
  error,
  onStop,
  onCancel,
}: VoicePanelProps) {
  const { theme } = useThemeContext();

  return (
    <View style={[styles.container, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
      {error ? (
        <View style={styles.content}>
          <Text style={[styles.errorText, { color: theme.destructive }]}>
            {error}
          </Text>
          <Pressable
            style={[styles.button, { backgroundColor: theme.surfaceElevated }]}
            onPress={onCancel}
          >
            <Text style={{ color: theme.foreground }}>Dismiss</Text>
          </Pressable>
        </View>
      ) : isProcessing ? (
        <View style={styles.content}>
          <Text style={[styles.processingText, { color: theme.foregroundMuted }]}>
            Processing...
          </Text>
        </View>
      ) : isRecording ? (
        <View style={styles.content}>
          <View style={styles.recordingRow}>
            <View style={[styles.recordingDot, { backgroundColor: theme.destructive }]} />
            <Text style={[styles.durationText, { color: theme.foreground }]}>
              {formatDuration(duration)}
            </Text>
          </View>
          {partialTranscript ? (
            <Text
              style={[styles.transcript, { color: theme.foregroundMuted }]}
              numberOfLines={3}
            >
              {partialTranscript}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              style={[styles.button, { backgroundColor: theme.surfaceElevated }]}
              onPress={onCancel}
            >
              <Text style={{ color: theme.destructive }}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.button, { backgroundColor: theme.primary }]}
              onPress={onStop}
            >
              <Text style={{ color: theme.primaryForeground, fontWeight: "600" }}>
                Done
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: LAYOUT.screenPaddingH,
    paddingVertical: 12,
  },
  content: {
    gap: 10,
  },
  recordingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  durationText: {
    fontSize: 20,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  transcript: {
    fontSize: 14,
    lineHeight: 20,
  },
  processingText: {
    fontSize: 14,
    textAlign: "center",
  },
  errorText: {
    fontSize: 14,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: LAYOUT.buttonRadius,
    alignItems: "center",
  },
});
