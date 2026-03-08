/**
 * TerminalStream — Terminal-faithful rendering of TimelineItem events.
 *
 * Replaces AgentStream with a rendering that matches Claude Code's terminal
 * output "cm by cm". Uses React Native primitives (View/Text/ScrollView)
 * but follows the same type-guard dispatch pattern as @saqr/terminal-ui.
 */
import React, { useRef, useEffect } from "react";
import { ScrollView, View, Text, StyleSheet, Pressable } from "react-native";
import type {
  TimelineItem,
  UserMessageType as UserMessage,
  AssistantMessageType as AssistantMessage,
  ThinkingBlockType as ThinkingBlock,
  ToolCallType as ToolCall,
  PermissionRequestType as PermissionRequest,
  ErrorItem,
  SystemNotificationType as SystemNotification,
  CompactNotificationType as CompactNotification,
  UsageUpdateType as UsageUpdate,
} from "@saqr/terminal-ui";
import {
  isUserMessage,
  isAssistantMessage,
  isThinkingBlock,
  isToolCall,
  isPermissionRequest,
  isErrorItem,
  isSystemNotification,
  isCompactNotification,
  isUsageUpdate,
} from "@saqr/terminal-ui";
import { useThemeContext } from "../lib/theme";

interface TerminalStreamProps {
  items: TimelineItem[];
  onPermissionResponse?: (permissionId: string, resolution: "allowed" | "denied") => void;
}

export function TerminalStream({ items, onPermissionResponse }: TerminalStreamProps) {
  const scrollRef = useRef<ScrollView>(null);
  const { theme } = useThemeContext();

  useEffect(() => {
    if (items.length > 0) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [items.length]);

  if (items.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={{ color: theme.foregroundMuted }}>
          Waiting for session events...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.container, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
    >
      {items.map(item => (
        <TimelineItemView
          key={item.id}
          item={item}
          onPermissionResponse={onPermissionResponse}
        />
      ))}
    </ScrollView>
  );
}

function TimelineItemView({
  item,
  onPermissionResponse,
}: {
  item: TimelineItem;
  onPermissionResponse?: (id: string, res: "allowed" | "denied") => void;
}) {
  if (isUserMessage(item)) return <UserMessageView item={item} />;
  if (isAssistantMessage(item)) return <AssistantMessageView item={item} />;
  if (isThinkingBlock(item)) return <ThinkingBlockView item={item} />;
  if (isToolCall(item)) return <ToolCallView item={item} />;
  if (isPermissionRequest(item)) return <PermissionRequestView item={item} onResponse={onPermissionResponse} />;
  if (isErrorItem(item)) return <ErrorItemView item={item} />;
  if (isSystemNotification(item)) return <SystemNotificationView item={item} />;
  if (isCompactNotification(item)) return <CompactNotificationView item={item} />;
  if (isUsageUpdate(item)) return <UsageUpdateView item={item} />;
  return null;
}

function UserMessageView({ item }: { item: UserMessage }) {
  const { theme } = useThemeContext();
  return (
    <View style={[styles.userBubble, { backgroundColor: theme.primary + "22" }]}>
      <Text style={[styles.label, { color: theme.primary }]}>You</Text>
      <Text style={[styles.bodyText, { color: theme.foreground }]}>{item.text}</Text>
    </View>
  );
}

function AssistantMessageView({ item }: { item: AssistantMessage }) {
  const { theme } = useThemeContext();
  return (
    <View style={styles.itemBlock}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: theme.primary }]}>Claude</Text>
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>{item.model}</Text>
      </View>
      <Text style={[styles.bodyText, { color: theme.foreground }]}>
        {item.text}
        {item.streamingState === "streaming" && (
          <Text style={{ color: theme.primary }}> ▍</Text>
        )}
      </Text>
    </View>
  );
}

function ThinkingBlockView({ item }: { item: ThinkingBlock }) {
  const { theme } = useThemeContext();
  const [expanded, setExpanded] = React.useState(false);

  return (
    <Pressable
      onPress={() => setExpanded(e => !e)}
      style={[styles.thinkingBlock, { backgroundColor: theme.surface, borderColor: theme.borderMuted }]}
    >
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: theme.foregroundMuted }]}>
          {expanded ? "▾" : "▸"} Thinking
        </Text>
        {item.durationMs != null && (
          <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
            {(item.durationMs / 1000).toFixed(1)}s
          </Text>
        )}
      </View>
      {expanded && (
        <Text style={[styles.thinkingText, { color: theme.foregroundMuted }]}>
          {item.text}
        </Text>
      )}
    </Pressable>
  );
}

function ToolCallView({ item }: { item: ToolCall }) {
  const { theme } = useThemeContext();

  const toolColor = getToolColor(item.toolName, theme);
  const statusIcon = item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : "⋯";

  return (
    <View style={[styles.toolBlock, { borderLeftColor: toolColor }]}>
      <View style={styles.labelRow}>
        <Text style={[styles.toolName, { color: toolColor }]}>
          {statusIcon} {item.toolName}
        </Text>
        {item.durationMs != null && (
          <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
            {item.durationMs}ms
          </Text>
        )}
      </View>
      <ToolInputSummary item={item} />
      {item.error && (
        <Text style={[styles.errorText, { color: theme.destructive }]}>
          {item.error}
        </Text>
      )}
    </View>
  );
}

function ToolInputSummary({ item }: { item: ToolCall }) {
  const { theme } = useThemeContext();
  let summary = "";

  switch (item.toolName) {
    case "Read":
      summary = item.input.filePath;
      break;
    case "Edit":
      summary = item.input.filePath;
      break;
    case "Write":
      summary = item.input.filePath;
      break;
    case "Bash":
      summary = item.input.command;
      break;
    case "Glob":
      summary = item.input.pattern;
      break;
    case "Grep":
      summary = item.input.pattern;
      break;
    case "WebFetch":
      summary = item.input.url;
      break;
    case "Task":
      summary = item.input.description ?? item.input.prompt.slice(0, 80);
      break;
    default:
      summary = JSON.stringify((item as { input: unknown }).input).slice(0, 100);
  }

  return (
    <Text style={[styles.toolSummary, { color: theme.foregroundMuted }]} numberOfLines={2}>
      {summary}
    </Text>
  );
}

function PermissionRequestView({
  item,
  onResponse,
}: {
  item: PermissionRequest;
  onResponse?: (id: string, res: "allowed" | "denied") => void;
}) {
  const { theme } = useThemeContext();
  const isPending = item.resolution === "pending";

  return (
    <View style={[styles.permissionBlock, { backgroundColor: theme.warning + "11", borderColor: theme.warning }]}>
      <Text style={[styles.label, { color: theme.warning }]}>Permission Required</Text>
      <Text style={[styles.bodyText, { color: theme.foreground }]}>
        {item.toolName}: {item.description}
      </Text>
      {item.filePath && (
        <Text style={[styles.meta, { color: theme.foregroundMuted }]}>{item.filePath}</Text>
      )}
      {isPending && onResponse && (
        <View style={styles.permissionButtons}>
          <Pressable
            style={[styles.permBtn, { backgroundColor: theme.success + "33" }]}
            onPress={() => onResponse(item.id, "allowed")}
          >
            <Text style={{ color: theme.success, fontWeight: "600" }}>Allow</Text>
          </Pressable>
          <Pressable
            style={[styles.permBtn, { backgroundColor: theme.destructive + "33" }]}
            onPress={() => onResponse(item.id, "denied")}
          >
            <Text style={{ color: theme.destructive, fontWeight: "600" }}>Deny</Text>
          </Pressable>
        </View>
      )}
      {!isPending && (
        <Text style={[styles.meta, { color: item.resolution === "allowed" ? theme.success : theme.destructive }]}>
          {item.resolution}
        </Text>
      )}
    </View>
  );
}

function ErrorItemView({ item }: { item: ErrorItem }) {
  const { theme } = useThemeContext();
  return (
    <View style={[styles.errorBlock, { backgroundColor: theme.destructive + "11", borderColor: theme.destructive }]}>
      <Text style={[styles.label, { color: theme.destructive }]}>
        Error {item.isRecoverable ? "(recoverable)" : ""}
      </Text>
      <Text style={[styles.bodyText, { color: theme.foreground }]}>{item.message}</Text>
    </View>
  );
}

function SystemNotificationView({ item }: { item: SystemNotification }) {
  const { theme } = useThemeContext();
  return (
    <View style={styles.systemNotification}>
      <Text style={[styles.systemText, { color: theme.foregroundMuted }]}>
        ── {item.message} ──
      </Text>
    </View>
  );
}

function CompactNotificationView({ item }: { item: CompactNotification }) {
  const { theme } = useThemeContext();
  const reduction = item.tokensBefore > 0
    ? Math.round((1 - item.tokensAfter / item.tokensBefore) * 100)
    : 0;

  return (
    <View style={styles.systemNotification}>
      <Text style={[styles.systemText, { color: theme.foregroundMuted }]}>
        ── Context compacted ({reduction}% reduction) ──
      </Text>
    </View>
  );
}

function UsageUpdateView({ item }: { item: UsageUpdate }) {
  const { theme } = useThemeContext();
  const contextPct = item.contextWindowMax > 0
    ? Math.round((item.contextWindowUsage / item.contextWindowMax) * 100)
    : 0;

  return (
    <View style={[styles.usageBlock, { borderColor: theme.borderMuted }]}>
      <Text style={[styles.meta, { color: theme.foregroundMuted }]}>
        {item.model} · {item.outputTokens} tokens · ${item.sessionCostUsd.toFixed(4)} · context {contextPct}%
      </Text>
    </View>
  );
}

function getToolColor(toolName: string, theme: { primary: string; success: string; warning: string; foregroundMuted: string }): string {
  const map: Record<string, string> = {
    Read: "#60A5FA",
    Edit: "#34D399",
    Write: "#A78BFA",
    Bash: "#A78BFA",
    Glob: "#F59E0B",
    Grep: "#F59E0B",
    WebFetch: "#F472B6",
    Task: "#38BDF8",
  };
  return map[toolName] ?? theme.foregroundMuted;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 12,
    gap: 8,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  itemBlock: {
    paddingVertical: 6,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    padding: 10,
    borderRadius: 10,
    marginVertical: 2,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
  },
  meta: {
    fontSize: 11,
  },
  bodyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  thinkingBlock: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    marginVertical: 2,
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
  toolBlock: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingVertical: 4,
    marginVertical: 2,
  },
  toolName: {
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  toolSummary: {
    fontSize: 12,
    fontFamily: "monospace",
    marginTop: 2,
  },
  errorText: {
    fontSize: 12,
    marginTop: 4,
  },
  permissionBlock: {
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    marginVertical: 4,
  },
  permissionButtons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  permBtn: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  errorBlock: {
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    marginVertical: 4,
  },
  systemNotification: {
    alignItems: "center",
    paddingVertical: 4,
  },
  systemText: {
    fontSize: 11,
    fontStyle: "italic",
  },
  usageBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    alignItems: "center",
  },
});
