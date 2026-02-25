import React from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSettingsStore, type ThemePreference } from "../stores/settings-store";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

export default function SettingsScreen() {
  const router = useRouter();
  const { theme } = useThemeContext();
  const settings = useSettingsStore();

  const themeOptions: { label: string; value: ThemePreference }[] = [
    { label: "Auto", value: "auto" },
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: theme.primary, fontSize: 16 }}>Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.foreground }]}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Appearance */}
        <Text style={[styles.sectionHeader, { color: theme.foregroundMuted }]}>
          APPEARANCE
        </Text>
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          {themeOptions.map((option) => (
            <Pressable
              key={option.value}
              style={[
                styles.row,
                { borderBottomColor: theme.borderMuted },
              ]}
              onPress={() => settings.setTheme(option.value)}
            >
              <Text style={{ color: theme.foreground }}>{option.label}</Text>
              {settings.theme === option.value && (
                <Text style={{ color: theme.primary }}>{"✓"}</Text>
              )}
            </Pressable>
          ))}
        </View>

        {/* Notifications */}
        <Text style={[styles.sectionHeader, { color: theme.foregroundMuted }]}>
          NOTIFICATIONS
        </Text>
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
            <Text style={{ color: theme.foreground }}>Enable Notifications</Text>
            <Switch
              value={settings.notifications.enabled}
              onValueChange={(enabled) =>
                settings.setNotifications({ enabled })
              }
              trackColor={{ true: theme.primary, false: theme.borderMuted }}
            />
          </View>
          <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
            <Text style={{ color: theme.foreground }}>Permission Requests</Text>
            <Switch
              value={settings.notifications.perType.permission_request}
              onValueChange={(value) =>
                settings.setNotifications({
                  perType: {
                    ...settings.notifications.perType,
                    permission_request: value,
                  },
                })
              }
              trackColor={{ true: theme.primary, false: theme.borderMuted }}
            />
          </View>
          <View style={[styles.row, { borderBottomColor: theme.borderMuted }]}>
            <Text style={{ color: theme.foreground }}>Agent Completions</Text>
            <Switch
              value={settings.notifications.perType.agent_completed}
              onValueChange={(value) =>
                settings.setNotifications({
                  perType: {
                    ...settings.notifications.perType,
                    agent_completed: value,
                  },
                })
              }
              trackColor={{ true: theme.primary, false: theme.borderMuted }}
            />
          </View>
          <View style={styles.row}>
            <Text style={{ color: theme.foreground }}>Agent Errors</Text>
            <Switch
              value={settings.notifications.perType.agent_error}
              onValueChange={(value) =>
                settings.setNotifications({
                  perType: {
                    ...settings.notifications.perType,
                    agent_error: value,
                  },
                })
              }
              trackColor={{ true: theme.primary, false: theme.borderMuted }}
            />
          </View>
        </View>

        {/* Feedback */}
        <Text style={[styles.sectionHeader, { color: theme.foregroundMuted }]}>
          FEEDBACK
        </Text>
        <View style={[styles.section, { backgroundColor: theme.surface }]}>
          <View style={styles.row}>
            <Text style={{ color: theme.foreground }}>Haptic Feedback</Text>
            <Switch
              value={settings.hapticFeedback}
              onValueChange={settings.setHapticFeedback}
              trackColor={{ true: theme.primary, false: theme.borderMuted }}
            />
          </View>
        </View>

        {/* Version */}
        <Text
          style={[
            styles.versionText,
            { color: theme.foregroundMuted },
          ]}
        >
          Saqr v0.1.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: LAYOUT.screenPaddingH,
    paddingVertical: LAYOUT.screenPaddingV,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
  },
  content: {
    paddingHorizontal: LAYOUT.screenPaddingH,
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
  versionText: {
    textAlign: "center",
    marginTop: 32,
    fontSize: 12,
  },
});
