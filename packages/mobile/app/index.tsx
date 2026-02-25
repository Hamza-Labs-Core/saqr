import React from "react";
import {
  View,
  FlatList,
  Pressable,
  Text,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDaemonStore } from "../stores/daemon-store";
import { DaemonCard } from "../components/DaemonCard";
import { EmptyState } from "../components/EmptyState";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

export default function HomeScreen() {
  const router = useRouter();
  const { theme } = useThemeContext();
  const daemons = useDaemonStore((s) => s.daemons);
  const connectionStates = useDaemonStore((s) => s.connectionStates);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.foreground }]}>Saqr</Text>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.headerButton, { backgroundColor: theme.surface }]}
            onPress={() => router.push("/settings")}
            accessibilityLabel="Settings"
          >
            <Text style={{ color: theme.foregroundMuted, fontSize: 18 }}>
              {"⚙"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.addButton, { backgroundColor: theme.primary }]}
            onPress={() => router.push("/pair-scan")}
            accessibilityLabel="Add daemon"
          >
            <Text style={{ color: theme.primaryForeground, fontSize: 20, fontWeight: "bold" }}>
              +
            </Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={daemons}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <DaemonCard
            host={item}
            connectionState={connectionStates[item.id] ?? "disconnected"}
            onPress={() => router.push(`/h/${item.id}` as any)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            title="No Daemons Connected"
            message="Pair with a development machine to get started. Tap + to scan a QR code."
            actionLabel="Pair Daemon"
            onAction={() => router.push("/pair-scan")}
          />
        }
      />
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
    fontSize: 28,
    fontWeight: "bold",
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    paddingHorizontal: LAYOUT.screenPaddingH,
    paddingBottom: 32,
  },
});
