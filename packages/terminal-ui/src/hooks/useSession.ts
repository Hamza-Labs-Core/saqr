/**
 * useSession — WebSocket connection hook for live terminal streaming.
 *
 * Manages the WebSocket lifecycle: connect, reconnect, event accumulation.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import type { ConnectionState, SessionInfo, WsMessage, WsTimelineEvent } from "../types.js";

export interface UseSessionOptions {
  /** Base URL of the daemon HTTP server (e.g., "ws://localhost:3100") */
  daemonUrl: string;

  /** Session ID to connect to */
  sessionId: string;

  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;

  /** Reconnect delay in ms (default: 2000) */
  reconnectDelay?: number;

  /** Maximum reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
}

export interface UseSessionResult {
  /** Current connection state */
  connectionState: ConnectionState;

  /** Session info from the daemon (received on connect) */
  sessionInfo: SessionInfo | null;

  /** Accumulated timeline events */
  events: WsTimelineEvent["event"][];

  /** Send input text to the session */
  sendInput: (text: string) => void;

  /** Send a permission response */
  sendPermissionResponse: (permissionId: string, action: "allow" | "deny") => void;

  /** Manually reconnect */
  reconnect: () => void;

  /** Disconnect */
  disconnect: () => void;

  /** Error message if connection failed */
  error: string | null;
}

export function useSession(options: UseSessionOptions): UseSessionResult {
  const {
    daemonUrl,
    sessionId,
    autoReconnect = true,
    reconnectDelay = 2000,
    maxReconnectAttempts = 10,
  } = options;

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<WsTimelineEvent["event"][]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionState("connecting");
    setError(null);

    const wsUrl = `${daemonUrl}/ws/session/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState("connected");
      reconnectCountRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        switch (msg.type) {
          case "session_info":
            setSessionInfo(msg.session);
            break;

          case "timeline_event":
            setEvents((prev) => [...prev, msg.event]);
            break;

          case "error":
            setError(msg.message);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnectionState("disconnected");
      wsRef.current = null;

      if (autoReconnect && reconnectCountRef.current < maxReconnectAttempts) {
        reconnectCountRef.current++;
        reconnectTimerRef.current = setTimeout(connect, reconnectDelay);
      }
    };

    ws.onerror = () => {
      setConnectionState("error");
      setError("WebSocket connection failed");
    };
  }, [daemonUrl, sessionId, autoReconnect, reconnectDelay, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectCountRef.current = maxReconnectAttempts; // prevent auto-reconnect
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionState("disconnected");
  }, [maxReconnectAttempts]);

  const sendInput = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", text }));
    }
  }, []);

  const sendPermissionResponse = useCallback((permissionId: string, action: "allow" | "deny") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "permission_response", permissionId, action }));
    }
  }, []);

  const reconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    disconnect();
    connect();
  }, [connect, disconnect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    connectionState,
    sessionInfo,
    events,
    sendInput,
    sendPermissionResponse,
    reconnect,
    disconnect,
    error,
  };
}
