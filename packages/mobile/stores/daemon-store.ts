import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { zustandStorage } from "../lib/storage.js";
import { DaemonRegistry } from "../src/services/daemon-registry.js";
import { ConnectionManager } from "../src/services/connection-manager.js";
import type { HostProfile, ConnectionState } from "../src/types/daemon.js";

interface DaemonState {
  // State
  daemons: HostProfile[];
  connectionStates: Record<string, ConnectionState>;
  activeDaemonId: string | null;

  // Actions
  addDaemon: (host: HostProfile) => void;
  removeDaemon: (id: string) => void;
  setActive: (id: string | null) => void;
  updateConnectionState: (id: string, state: ConnectionState) => void;
  pairFromQR: (url: string) => { success: boolean; error?: string; hostId?: string };
  getDaemon: (id: string) => HostProfile | undefined;

  // Internal service refs (not persisted)
  _registry: DaemonRegistry;
  _connectionManager: ConnectionManager;
}

export const useDaemonStore = create<DaemonState>()(
  persist(
    (set, get) => {
      const registry = new DaemonRegistry();
      const connectionManager = ConnectionManager.create();

      return {
        daemons: [],
        connectionStates: {},
        activeDaemonId: null,
        _registry: registry,
        _connectionManager: connectionManager,

        addDaemon: (host: HostProfile) => {
          registry.addHost(host);
          connectionManager.registerHost(host);
          set({ daemons: registry.getAll() });
        },

        removeDaemon: (id: string) => {
          registry.removeHost(id);
          connectionManager.removeHost(id);
          set((state) => ({
            daemons: registry.getAll(),
            activeDaemonId: state.activeDaemonId === id ? null : state.activeDaemonId,
          }));
        },

        setActive: (id: string | null) => set({ activeDaemonId: id }),

        updateConnectionState: (id: string, state: ConnectionState) => {
          set((prev) => ({
            connectionStates: { ...prev.connectionStates, [id]: state },
          }));
        },

        pairFromQR: (url: string) => {
          const result = DaemonRegistry.parseQRPayloadUrl(url);
          if (!result.success) {
            return { success: false, error: result.error.message };
          }
          const host = DaemonRegistry.createHostFromPayload(
            result.payload,
            result.payload.ephemeralPublicKey,
          );
          get().addDaemon(host);
          return { success: true, hostId: host.id };
        },

        getDaemon: (id: string) => registry.getById(id),
      };
    },
    {
      name: "saqr-daemon-registry",
      storage: createJSONStorage(() => zustandStorage),
      partialize: (state) => ({
        daemons: state.daemons,
        activeDaemonId: state.activeDaemonId,
      }),
    },
  ),
);
