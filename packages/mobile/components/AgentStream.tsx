import React, { useRef, useEffect } from "react";
import { FlatList, View, Text, StyleSheet } from "react-native";
import type { AgentStreamEvent } from "../src/types/agent";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface AgentStreamProps {
  events: AgentStreamEvent[];
}

function StreamEventItem({ event }: { event: AgentStreamEvent }) {
  const { theme } = useThemeContext();

  const typeLabel = event.type.replace(/_/g, " ");
  const content =
    event.data["text"] ??
    event.data["content"] ??
    event.data["message"] ??
    event.data["result"] ??
    "";

  return (
    <View style={[styles.eventItem, { borderBottomColor: theme.borderMuted }]}>
      <View style={styles.eventHeader}>
        <Text style={[styles.eventType, { color: theme.primary }]}>
          {typeLabel}
        </Text>
        <Text style={[styles.eventTime, { color: theme.foregroundMuted }]}>
          {new Date(event.timestamp).toLocaleTimeString()}
        </Text>
      </View>
      {content ? (
        <Text style={[styles.eventContent, { color: theme.foreground }]}>
          {String(content)}
        </Text>
      ) : null}
    </View>
  );
}

export function AgentStream({ events }: AgentStreamProps) {
  const { theme } = useThemeContext();
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (events.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={{ color: theme.foregroundMuted }}>
          Waiting for agent events...
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={events}
      keyExtractor={(_, index) => String(index)}
      renderItem={({ item }) => <StreamEventItem event={item} />}
      contentContainerStyle={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: LAYOUT.screenPaddingH,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  eventItem: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eventHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  eventType: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  eventTime: {
    fontSize: 11,
  },
  eventContent: {
    fontSize: 13,
    lineHeight: 18,
  },
});
