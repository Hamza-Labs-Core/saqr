import React, { useState } from "react";
import { View, TextInput, Pressable, Text, StyleSheet } from "react-native";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface PromptInputProps {
  onSend: (prompt: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onVoicePress?: () => void;
}

export function PromptInput({
  onSend,
  disabled = false,
  placeholder = "Send a message...",
  onVoicePress,
}: PromptInputProps) {
  const { theme } = useThemeContext();
  const [text, setText] = useState("");

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
      {onVoicePress && (
        <Pressable
          style={styles.voiceButton}
          onPress={onVoicePress}
          disabled={disabled}
          accessibilityLabel="Voice input"
        >
          <Text style={{ color: disabled ? theme.foregroundMuted : theme.primary, fontSize: 18 }}>
            {"🎤"}
          </Text>
        </Pressable>
      )}
      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: theme.surfaceElevated,
            color: theme.foreground,
            borderColor: theme.borderMuted,
          },
        ]}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={theme.foregroundMuted}
        multiline
        maxLength={10000}
        editable={!disabled}
        onSubmitEditing={handleSend}
        returnKeyType="send"
        blurOnSubmit={false}
      />
      <Pressable
        style={[
          styles.sendButton,
          {
            backgroundColor: text.trim() && !disabled ? theme.primary : theme.borderMuted,
          },
        ]}
        onPress={handleSend}
        disabled={!text.trim() || disabled}
        accessibilityLabel="Send"
      >
        <Text
          style={{
            color: text.trim() && !disabled ? theme.primaryForeground : theme.foregroundMuted,
            fontWeight: "700",
            fontSize: 16,
          }}
        >
          {"↑"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: LAYOUT.inputRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 36,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  voiceButton: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
});
