/**
 * Hook for connecting to a daemon session and receiving TimelineItem events.
 *
 * Wraps WebSocket connection with reconnection logic and TimelineItem
 * accumulation. This is the mobile equivalent of @saqr/terminal-ui's
 * useSession + useTimeline hooks, adapted for React Native.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import type { TimelineItem } from "@saqr/terminal-ui";

export type MobileConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface UseTerminalStreamOptions {
  /** WebSocket URL for the daemon session. */
  wsUrl: string | null;
  /** Session ID to subscribe to. */
  sessionId: string;
  /** Bearer token for authentication. */
  token?: string;
  /** Auto-reconnect on disconnect. Default: true. */
  autoReconnect?: boolean;
  /** Reconnect interval in ms. Default: 3000. */
  reconnectInterval?: number;
}

interface UseTerminalStreamResult {
  items: TimelineItem[];
  connectionState: MobileConnectionState;
  sessionInfo: SessionInfo | null;
  sendInput: (text: string) => void;
  sendPermissionResponse: (permissionId: string, resolution: "allowed" | "denied") => void;
  clearItems: () => void;
}

interface SessionInfo {
  sessionId: string;
  projectId: string;
  agentProvider: string;
  model: string;
  status: string;
  startedAt: string;
}

export function useTerminalStream(options: UseTerminalStreamOptions): UseTerminalStreamResult {
  const { wsUrl, sessionId, token, autoReconnect = true, reconnectInterval = 3000 } = options;

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [connectionState, setConnectionState] = useState<MobileConnectionState>("disconnected");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!wsUrl || !sessionId) return;

    function connect() {
      setConnectionState("connecting");

      const url = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState("connected");
        attemptRef.current = 0;
      };

      ws.onclose = () => {
        setConnectionState("disconnected");
        wsRef.current = null;

        if (autoReconnect && attemptRef.current < 10) {
          attemptRef.current++;
          reconnectRef.current = setTimeout(connect, reconnectInterval);
        }
      };

      ws.onerror = () => {
        setConnectionState("error");
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "session_info") {
            setSessionInfo(msg.session as SessionInfo);
          } else if (msg.type === "timeline_event" && msg.event) {
            const timelineItem = eventToTimelineItem(msg.event);
            if (timelineItem) {
              setItems(prev => mergeItem(prev, timelineItem));
            }
          }
        } catch {
          /* ignore parse errors */
        }
      };
    }

    connect();

    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [wsUrl, sessionId, token, autoReconnect, reconnectInterval]);

  const sendInput = useCallback((text: string) => {
    wsRef.current?.send(JSON.stringify({ type: "input", text }));
  }, []);

  const sendPermissionResponse = useCallback((permissionId: string, resolution: "allowed" | "denied") => {
    wsRef.current?.send(JSON.stringify({
      type: "permission_response",
      permissionId,
      resolution,
    }));
  }, []);

  const clearItems = useCallback(() => setItems([]), []);

  return { items, connectionState, sessionInfo, sendInput, sendPermissionResponse, clearItems };
}

/**
 * Convert a daemon event to a TimelineItem.
 * The daemon sends events with generic data fields; we map them to
 * the strongly-typed TimelineItem union.
 */
function eventToTimelineItem(event: Record<string, unknown>): TimelineItem | null {
  const base = {
    id: String(event.eventId ?? event.id ?? crypto.randomUUID()),
    timestamp: String(event.timestamp ?? new Date().toISOString()),
    sequence: Number(event.sequence ?? 0),
    source: "sdk_stream" as const,
    read: false,
  };

  const data = (event.data ?? event) as Record<string, unknown>;
  const eventType = String(event.eventType ?? data.type ?? "");

  switch (eventType) {
    case "user_message":
      return { ...base, type: "user_message", text: String(data.text ?? ""), hasAttachments: false, attachments: [] };

    case "assistant_message":
      return {
        ...base,
        type: "assistant_message",
        text: String(data.text ?? ""),
        streamingState: (data.streamingState as "streaming" | "completed" | "interrupted") ?? "completed",
        hasMarkdown: Boolean(data.hasMarkdown),
        model: String(data.model ?? ""),
        outputTokens: data.outputTokens != null ? Number(data.outputTokens) : null,
      };

    case "thinking_block":
      return {
        ...base,
        type: "thinking_block",
        text: String(data.text ?? ""),
        streamingState: (data.streamingState as "streaming" | "completed") ?? "completed",
        durationMs: data.durationMs != null ? Number(data.durationMs) : null,
      };

    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        toolName: String(data.toolName ?? ""),
        toolUseId: String(data.toolUseId ?? ""),
        status: (data.status as "pending" | "running" | "completed" | "failed") ?? "pending",
        durationMs: data.durationMs != null ? Number(data.durationMs) : null,
        error: data.error != null ? String(data.error) : null,
        input: (data.input ?? {}) as Record<string, unknown>,
        output: (data.output ?? null) as Record<string, unknown> | null,
      } as TimelineItem;

    case "permission_request":
      return {
        ...base,
        type: "permission_request",
        toolName: String(data.toolName ?? ""),
        description: String(data.description ?? ""),
        filePath: data.filePath != null ? String(data.filePath) : null,
        toolInput: (data.toolInput ?? {}) as Record<string, unknown>,
        resolution: (data.resolution as "pending" | "allowed" | "denied") ?? "pending",
        resolvedAt: data.resolvedAt != null ? String(data.resolvedAt) : null,
      };

    case "error":
      return {
        ...base,
        type: "error",
        message: String(data.message ?? ""),
        stackTrace: data.stackTrace != null ? String(data.stackTrace) : null,
        isRecoverable: Boolean(data.isRecoverable ?? true),
        errorSource: (data.errorSource as "agent" | "tool" | "system" | "network") ?? "system",
      };

    case "system_notification":
      return {
        ...base,
        type: "system_notification",
        category: (data.category as "session_start" | "session_end") ?? "session_start",
        message: String(data.message ?? ""),
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      };

    case "compact_notification":
      return {
        ...base,
        type: "compact_notification",
        tokensBefore: Number(data.tokensBefore ?? 0),
        tokensAfter: Number(data.tokensAfter ?? 0),
        trigger: (data.trigger as "auto" | "manual") ?? "auto",
      };

    case "usage_update":
      return {
        ...base,
        type: "usage_update",
        model: String(data.model ?? ""),
        inputTokens: Number(data.inputTokens ?? 0),
        outputTokens: Number(data.outputTokens ?? 0),
        cacheReadTokens: Number(data.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(data.cacheWriteTokens ?? 0),
        sessionCostUsd: Number(data.sessionCostUsd ?? 0),
        contextWindowUsage: Number(data.contextWindowUsage ?? 0),
        contextWindowMax: Number(data.contextWindowMax ?? 0),
      };

    default:
      return null;
  }
}

/**
 * Merge a new item into the timeline, deduplicating by id
 * and maintaining sequence order.
 */
function mergeItem(existing: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = existing.findIndex(e => e.id === item.id);
  if (idx >= 0) {
    const updated = [...existing];
    updated[idx] = item;
    return updated;
  }
  return [...existing, item].sort((a, b) => a.sequence - b.sequence);
}
