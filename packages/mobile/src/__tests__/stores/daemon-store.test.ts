/**
 * Tests for the daemon Zustand store.
 *
 * Verifies that the store correctly wraps DaemonRegistry and
 * ConnectionManager, including add/remove/setActive operations,
 * QR pairing, and state updates.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useDaemonStore } from "../../../stores/daemon-store.js";
import { clearStorage } from "../../../lib/storage.js";
import type { HostProfile } from "../../types/daemon.js";
import { PAIRING_URL_SCHEME } from "../../types/crypto.js";

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
    machineId: `machine-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

function makeQRUrl(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json).toString("base64url");
  return `${PAIRING_URL_SCHEME}?data=${encoded}`;
}

describe("daemon-store", () => {
  beforeEach(() => {
    clearStorage();
    // Reset the store to its initial state
    const store = useDaemonStore.getState();
    // Remove all daemons
    for (const d of store.daemons) {
      store.removeDaemon(d.id);
    }
    store.setActive(null);
  });

  it("starts with empty daemons list", () => {
    const state = useDaemonStore.getState();
    expect(state.daemons).toEqual([]);
    expect(state.activeDaemonId).toBeNull();
  });

  it("addDaemon adds a host and updates state", () => {
    const host = createHost({ id: "h1" });
    useDaemonStore.getState().addDaemon(host);

    const state = useDaemonStore.getState();
    expect(state.daemons).toHaveLength(1);
    expect(state.daemons[0].id).toBe("h1");
  });

  it("removeDaemon removes a host", () => {
    const host = createHost({ id: "h2" });
    useDaemonStore.getState().addDaemon(host);
    expect(useDaemonStore.getState().daemons).toHaveLength(1);

    useDaemonStore.getState().removeDaemon("h2");
    expect(useDaemonStore.getState().daemons).toHaveLength(0);
  });

  it("removeDaemon clears activeDaemonId when removing the active daemon", () => {
    const host = createHost({ id: "h3" });
    useDaemonStore.getState().addDaemon(host);
    useDaemonStore.getState().setActive("h3");
    expect(useDaemonStore.getState().activeDaemonId).toBe("h3");

    useDaemonStore.getState().removeDaemon("h3");
    expect(useDaemonStore.getState().activeDaemonId).toBeNull();
  });

  it("removeDaemon does not clear activeDaemonId when removing a non-active daemon", () => {
    const h1 = createHost({ id: "h4" });
    const h2 = createHost({ id: "h5" });
    const store = useDaemonStore.getState();
    store.addDaemon(h1);
    store.addDaemon(h2);
    store.setActive("h4");

    store.removeDaemon("h5");
    expect(useDaemonStore.getState().activeDaemonId).toBe("h4");
  });

  it("setActive updates the active daemon ID", () => {
    useDaemonStore.getState().setActive("some-id");
    expect(useDaemonStore.getState().activeDaemonId).toBe("some-id");

    useDaemonStore.getState().setActive(null);
    expect(useDaemonStore.getState().activeDaemonId).toBeNull();
  });

  it("updateConnectionState stores per-host connection state", () => {
    useDaemonStore.getState().updateConnectionState("h1", "connected");
    expect(useDaemonStore.getState().connectionStates["h1"]).toBe("connected");

    useDaemonStore.getState().updateConnectionState("h1", "disconnected");
    expect(useDaemonStore.getState().connectionStates["h1"]).toBe("disconnected");
  });

  it("getDaemon returns host by ID from registry", () => {
    const host = createHost({ id: "h6" });
    useDaemonStore.getState().addDaemon(host);

    const found = useDaemonStore.getState().getDaemon("h6");
    expect(found).toBeDefined();
    expect(found!.id).toBe("h6");

    const notFound = useDaemonStore.getState().getDaemon("nonexistent");
    expect(notFound).toBeUndefined();
  });

  it("pairFromQR returns error for invalid URL", () => {
    const result = useDaemonStore.getState().pairFromQR("https://invalid.com");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("pairFromQR succeeds with valid payload and adds daemon", () => {
    const payload = {
      version: 1,
      hostname: "test-host",
      os: "linux",
      daemonVersion: "1.0.0",
      machineId: "pair-machine-1",
      lan: { address: "192.168.1.100", port: 9120 },
      ephemeralPublicKey: "testkey123",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      nonce: "testnonce",
    };
    const url = makeQRUrl(payload);

    const result = useDaemonStore.getState().pairFromQR(url);
    expect(result.success).toBe(true);
    expect(result.hostId).toBeDefined();

    const state = useDaemonStore.getState();
    expect(state.daemons.length).toBeGreaterThanOrEqual(1);
    const added = state.daemons.find((d) => d.id === result.hostId);
    expect(added).toBeDefined();
    expect(added!.hostname).toBe("test-host");
  });

  it("addDaemon with duplicate machineId updates instead of duplicating", () => {
    const host1 = createHost({ id: "hd1", machineId: "dup-machine" });
    const host2 = createHost({
      id: "hd2",
      machineId: "dup-machine",
      name: "Updated Name",
    });

    useDaemonStore.getState().addDaemon(host1);
    expect(useDaemonStore.getState().daemons).toHaveLength(1);

    useDaemonStore.getState().addDaemon(host2);
    // Should still be 1 since machineId is the same
    expect(useDaemonStore.getState().daemons).toHaveLength(1);
  });
});
