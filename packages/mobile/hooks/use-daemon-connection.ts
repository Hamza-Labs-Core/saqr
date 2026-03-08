import { useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon-store.js";
import type { ConnectionState } from "../src/types/daemon.js";

/**
 * Hook for managing the WebSocket connection to a specific daemon.
 * Subscribes to connection state changes and exposes connect/disconnect actions.
 */
export function useDaemonConnection(hostId: string) {
  const connectionManager = useDaemonStore((s) => s._connectionManager);
  const updateConnectionState = useDaemonStore((s) => s.updateConnectionState);
  const connectionStates = useDaemonStore((s) => s.connectionStates);

  const connectionState: ConnectionState =
    connectionStates[hostId] ?? "disconnected";

  useEffect(() => {
    const unsubscribe = connectionManager.onConnectionStateChange(
      (changedHostId, state) => {
        if (changedHostId === hostId) {
          updateConnectionState(hostId, state);
        }
      },
    );
    return unsubscribe;
  }, [hostId, connectionManager, updateConnectionState]);

  const connect = useCallback(async () => {
    await connectionManager.connect(hostId);
  }, [hostId, connectionManager]);

  const disconnect = useCallback(async () => {
    await connectionManager.disconnect(hostId);
  }, [hostId, connectionManager]);

  return {
    connectionState,
    isConnected: connectionState === "connected",
    isConnecting: connectionState === "connecting",
    connect,
    disconnect,
  };
}
