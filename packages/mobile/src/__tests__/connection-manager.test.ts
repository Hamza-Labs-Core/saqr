/**
 * Tests for the ConnectionManager service.
 *
 * Covers connection lifecycle, reconnection with exponential backoff,
 * heartbeat management, and multi-daemon concurrent connections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionManager } from "../services/connection-manager.js";
import type { HostProfile } from "../types/daemon.js";

function createHost(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    id: `host-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test MacBook",
    hostname: "test-macbook",
    connectionType: "lan",
    lanAddress: "192.168.1.42:9120",
    publicKey: "base64key==",
    pairedAt: "2026-02-15T10:00:00Z",
    lastSeen: "2026-02-22T14:30:00Z",
    connectionState: "disconnected",
    daemonVersion: "1.0.0",
    os: "macos",
    machineId: "a3f7b2c9d1e4",
    ...overrides,
  };
}

describe("ConnectionManager", () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = ConnectionManager.create();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe("singleton and lifecycle", () => {
    it("create() returns a new instance", () => {
      const m1 = ConnectionManager.create();
      const m2 = ConnectionManager.create();
      expect(m1).not.toBe(m2);
      m1.destroy();
      m2.destroy();
    });

    it("destroy() clears all connections and timers", () => {
      const host = createHost();
      manager.registerHost(host);
      manager.destroy();
      expect(manager.getConnectionState(host.id)).toBe("disconnected");
    });
  });

  describe("connection state", () => {
    it("initial state is disconnected for unregistered host", () => {
      expect(manager.getConnectionState("nonexistent")).toBe("disconnected");
    });

    it("registerHost sets initial state to disconnected", () => {
      const host = createHost();
      manager.registerHost(host);
      expect(manager.getConnectionState(host.id)).toBe("disconnected");
    });

    it("connect transitions state to connecting then connected", async () => {
      const host = createHost();
      manager.registerHost(host);

      const states: string[] = [];
      manager.onConnectionStateChange((hostId, state) => {
        if (hostId === host.id) states.push(state);
      });

      await manager.connect(host.id);
      expect(states).toContain("connecting");
      expect(manager.getConnectionState(host.id)).toBe("connected");
    });

    it("disconnect transitions state to disconnected", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);

      await manager.disconnect(host.id);
      expect(manager.getConnectionState(host.id)).toBe("disconnected");
    });

    it("disconnect on unregistered host is a no-op", async () => {
      await expect(
        manager.disconnect("nonexistent")
      ).resolves.toBeUndefined();
    });
  });

  describe("multi-daemon connections", () => {
    it("connectAll connects all registered hosts", async () => {
      const host1 = createHost({ id: "host-1", name: "MacBook" });
      const host2 = createHost({ id: "host-2", name: "Linux VM" });
      manager.registerHost(host1);
      manager.registerHost(host2);

      await manager.connectAll();
      expect(manager.getConnectionState("host-1")).toBe("connected");
      expect(manager.getConnectionState("host-2")).toBe("connected");
    });

    it("disconnectAll disconnects all hosts", async () => {
      const host1 = createHost({ id: "host-1" });
      const host2 = createHost({ id: "host-2" });
      manager.registerHost(host1);
      manager.registerHost(host2);
      await manager.connectAll();

      await manager.disconnectAll();
      expect(manager.getConnectionState("host-1")).toBe("disconnected");
      expect(manager.getConnectionState("host-2")).toBe("disconnected");
    });

    it("getConnectedHosts returns only connected hosts", async () => {
      const host1 = createHost({ id: "host-1" });
      const host2 = createHost({ id: "host-2" });
      manager.registerHost(host1);
      manager.registerHost(host2);
      await manager.connect("host-1");

      const connected = manager.getConnectedHostIds();
      expect(connected).toContain("host-1");
      expect(connected).not.toContain("host-2");
    });

    it("getAllHosts returns all registered hosts", () => {
      const host1 = createHost({ id: "host-1" });
      const host2 = createHost({ id: "host-2" });
      manager.registerHost(host1);
      manager.registerHost(host2);

      const all = manager.getAllHostIds();
      expect(all).toHaveLength(2);
    });
  });

  describe("reconnection with exponential backoff", () => {
    it("calculates backoff delays correctly", () => {
      expect(ConnectionManager.calculateBackoff(0)).toBe(1000);
      expect(ConnectionManager.calculateBackoff(1)).toBe(2000);
      expect(ConnectionManager.calculateBackoff(2)).toBe(4000);
      expect(ConnectionManager.calculateBackoff(3)).toBe(8000);
      expect(ConnectionManager.calculateBackoff(4)).toBe(16000);
      expect(ConnectionManager.calculateBackoff(5)).toBe(32000);
      expect(ConnectionManager.calculateBackoff(6)).toBe(60000);
      expect(ConnectionManager.calculateBackoff(7)).toBe(60000);
    });

    it("backoff is capped at 60 seconds", () => {
      expect(ConnectionManager.calculateBackoff(100)).toBe(60000);
    });

    it("scheduleReconnect sets up a delayed reconnection", async () => {
      const host = createHost();
      manager.registerHost(host);

      manager.scheduleReconnect(host.id, 0);
      expect(manager.hasReconnectScheduled(host.id)).toBe(true);

      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();
      expect(manager.getConnectionState(host.id)).toBe("connected");
    });

    it("clearReconnect cancels pending reconnection", () => {
      const host = createHost();
      manager.registerHost(host);

      manager.scheduleReconnect(host.id, 0);
      manager.clearReconnect(host.id);
      expect(manager.hasReconnectScheduled(host.id)).toBe(false);
    });

    it("disconnect clears reconnect timer", async () => {
      const host = createHost();
      manager.registerHost(host);

      manager.scheduleReconnect(host.id, 0);
      await manager.disconnect(host.id);
      expect(manager.hasReconnectScheduled(host.id)).toBe(false);
    });
  });

  describe("event listeners", () => {
    it("onConnectionStateChange fires on state transitions", async () => {
      const host = createHost();
      manager.registerHost(host);

      const events: Array<{ hostId: string; state: string }> = [];
      const unsub = manager.onConnectionStateChange((hostId, state) => {
        events.push({ hostId, state });
      });

      await manager.connect(host.id);
      await manager.disconnect(host.id);

      expect(events.length).toBeGreaterThanOrEqual(2);
      unsub();
    });

    it("unsubscribe stops notifications", async () => {
      const host = createHost();
      manager.registerHost(host);

      const events: string[] = [];
      const unsub = manager.onConnectionStateChange((_hostId, state) => {
        events.push(state);
      });

      await manager.connect(host.id);
      unsub();

      const countAfterUnsub = events.length;
      await manager.disconnect(host.id);
      expect(events.length).toBe(countAfterUnsub);
    });

    it("multiple listeners all receive events", async () => {
      const host = createHost();
      manager.registerHost(host);

      const events1: string[] = [];
      const events2: string[] = [];
      const unsub1 = manager.onConnectionStateChange((_h, s) =>
        events1.push(s)
      );
      const unsub2 = manager.onConnectionStateChange((_h, s) =>
        events2.push(s)
      );

      await manager.connect(host.id);
      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);

      unsub1();
      unsub2();
    });
  });

  describe("heartbeat management", () => {
    it("starts heartbeat on connect with foreground interval", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);

      expect(manager.getHeartbeatInterval(host.id)).toBe(10000);
    });

    it("setAppState background increases heartbeat interval to 30s", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);

      manager.setAppState("background");
      expect(manager.getHeartbeatInterval(host.id)).toBe(30000);
    });

    it("setAppState foreground restores heartbeat interval to 10s", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);

      manager.setAppState("background");
      manager.setAppState("foreground");
      expect(manager.getHeartbeatInterval(host.id)).toBe(10000);
    });
  });

  describe("host removal", () => {
    it("removeHost disconnects and removes the host", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);

      manager.removeHost(host.id);
      expect(manager.getConnectionState(host.id)).toBe("disconnected");
      expect(manager.getAllHostIds()).not.toContain(host.id);
    });

    it("removeHost clears reconnect timer", () => {
      const host = createHost();
      manager.registerHost(host);
      manager.scheduleReconnect(host.id, 0);

      manager.removeHost(host.id);
      expect(manager.hasReconnectScheduled(host.id)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("connecting same host twice does not create duplicates", async () => {
      const host = createHost();
      manager.registerHost(host);
      await manager.connect(host.id);
      await manager.connect(host.id);
      expect(manager.getConnectionState(host.id)).toBe("connected");
    });

    it("registering host with same id updates existing", () => {
      const host1 = createHost({ id: "host-1", name: "Old Name" });
      const host2 = createHost({ id: "host-1", name: "New Name" });
      manager.registerHost(host1);
      manager.registerHost(host2);

      expect(manager.getAllHostIds()).toHaveLength(1);
      expect(manager.getHostProfile("host-1")?.name).toBe("New Name");
    });
  });
});
