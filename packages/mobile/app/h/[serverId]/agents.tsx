import React, { useEffect } from "react";
import { View, FlatList, Text, StyleSheet } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useDaemonStore } from "../../../stores/daemon-store";
import { useAgentStore } from "../../../stores/agent-store";
import { useAgents } from "../../../hooks/use-agents";
import { AgentCard } from "../../../components/AgentCard";
import { EmptyState } from "../../../components/EmptyState";
import { useThemeContext } from "../../../lib/theme";
import { LAYOUT } from "../../../lib/constants";

export default function AgentsScreen() {
  const router = useRouter();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const { theme } = useThemeContext();
  const getDaemon = useDaemonStore((s) => s.getDaemon);
  const daemon = serverId ? getDaemon(serverId) : undefined;
  const baseUrl = daemon?.lanAddress ? `http://${daemon.lanAddress}` : "";

  const { data: agents, isLoading, refetch } = useAgents(serverId ?? "", baseUrl);
  const setAgentsForHost = useAgentStore((s) => s.setAgentsForHost);
  const storedAgents = useAgentStore((s) => s.agents);

  // Sync fetched agents into store
  useEffect(() => {
    if (agents && serverId) {
      setAgentsForHost(serverId, agents);
    }
  }, [agents, serverId, setAgentsForHost]);

  const displayAgents = serverId
    ? storedAgents.filter((a) => a.hostId === serverId)
    : [];

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {isLoading && displayAgents.length === 0 ? (
        <View style={styles.loading}>
          <Text style={{ color: theme.foregroundMuted }}>Loading agents...</Text>
        </View>
      ) : (
        <FlatList
          data={displayAgents}
          keyExtractor={(item) => `${item.hostId}-${item.id}`}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <AgentCard
              agent={item}
              onPress={() =>
                router.push(`/h/${serverId}/agent/${item.id}` as any)
              }
            />
          )}
          ListEmptyComponent={
            <EmptyState
              title="No Agents"
              message="No agents are currently running on this daemon."
            />
          }
          onRefresh={() => void refetch()}
          refreshing={isLoading}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    paddingHorizontal: LAYOUT.screenPaddingH,
    paddingBottom: 32,
  },
});
