import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentStreamEvent } from "../src/types/agent.js";

/**
 * Hook for subscribing to real-time agent events via WebSocket.
 *
 * Connects to the daemon's WebSocket endpoint and accumulates events
 * for the specified agent. Provides actions for sending prompts and
 * approving/denying permission requests.
 */
export function useAgentStream(wsUrl: string | null, agentId: string) {
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!wsUrl || !agentId) return;

    const ws = new WebSocket(`${wsUrl}/ws?agentId=${agentId}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onerror = () => setIsConnected(false);
    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(
          event.data as string,
        ) as AgentStreamEvent;
        if (parsed.agentId === agentId) {
          setEvents((prev) => [...prev, parsed]);
        }
      } catch {
        /* ignore parse errors */
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl, agentId]);

  const sendPrompt = useCallback(
    (prompt: string) => {
      wsRef.current?.send(
        JSON.stringify({
          type: "send_prompt",
          agentId,
          data: { prompt },
        }),
      );
    },
    [agentId],
  );

  const approvePermission = useCallback(
    (toolUseId: string) => {
      wsRef.current?.send(
        JSON.stringify({
          type: "approve_permission",
          agentId,
          data: { toolUseId },
        }),
      );
    },
    [agentId],
  );

  const denyPermission = useCallback(
    (toolUseId: string) => {
      wsRef.current?.send(
        JSON.stringify({
          type: "deny_permission",
          agentId,
          data: { toolUseId },
        }),
      );
    },
    [agentId],
  );

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return {
    events,
    isConnected,
    sendPrompt,
    approvePermission,
    denyPermission,
    clearEvents,
  };
}
