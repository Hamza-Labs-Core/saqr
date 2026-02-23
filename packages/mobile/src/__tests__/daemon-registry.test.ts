/**
 * Tests for the DaemonRegistry service.
 *
 * Covers CRUD operations for HostProfiles, persistence model,
 * QR pairing payload parsing, and duplicate detection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DaemonRegistry } from "../services/daemon-registry.js";
import type { HostProfile } from "../types/daemon.js";
import type { PairingPayload } from "../types/crypto.js";

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

describe("DaemonRegistry", () => {
  let registry: DaemonRegistry;

  beforeEach(() => {
    registry = new DaemonRegistry();
  });

  describe("CRUD operations", () => {
    it("starts empty", () => {
      expect(registry.getAll()).toEqual([]);
      expect(registry.count()).toBe(0);
    });

    it("addHost adds a host", () => {
      const host = createHost({ id: "host-1" });
      registry.addHost(host);
      expect(registry.count()).toBe(1);
      expect(registry.getById("host-1")).toEqual(host);
    });

    it("addHost with duplicate machineId updates existing", () => {
      const host1 = createHost({
        id: "host-1",
        machineId: "machine-a",
        name: "Old",
      });
      const host2 = createHost({
        id: "host-2",
        machineId: "machine-a",
        name: "New",
      });
      registry.addHost(host1);
      registry.addHost(host2);
      expect(registry.count()).toBe(1);
      expect(registry.getByMachineId("machine-a")?.name).toBe("New");
    });

    it("removeHost removes a host by id", () => {
      const host = createHost({ id: "host-1" });
      registry.addHost(host);
      registry.removeHost("host-1");
      expect(registry.count()).toBe(0);
      expect(registry.getById("host-1")).toBeUndefined();
    });

    it("removeHost on nonexistent host is a no-op", () => {
      registry.removeHost("nonexistent");
      expect(registry.count()).toBe(0);
    });

    it("updateHost updates specific fields", () => {
      const host = createHost({ id: "host-1", name: "Old Name" });
      registry.addHost(host);
      registry.updateHost("host-1", { name: "New Name" });
      expect(registry.getById("host-1")?.name).toBe("New Name");
    });

    it("updateHost preserves unchanged fields", () => {
      const host = createHost({
        id: "host-1",
        name: "MacBook",
        hostname: "macbook",
      });
      registry.addHost(host);
      registry.updateHost("host-1", { name: "Updated MacBook" });
      expect(registry.getById("host-1")?.hostname).toBe("macbook");
    });

    it("updateHost on nonexistent host is a no-op", () => {
      registry.updateHost("nonexistent", { name: "test" });
      expect(registry.count()).toBe(0);
    });

    it("getAll returns all hosts", () => {
      registry.addHost(createHost({ id: "host-1" }));
      registry.addHost(createHost({ id: "host-2", machineId: "different" }));
      expect(registry.getAll()).toHaveLength(2);
    });

    it("getAll returns a copy (not mutable reference)", () => {
      const host = createHost({ id: "host-1" });
      registry.addHost(host);
      const all = registry.getAll();
      all.pop();
      expect(registry.count()).toBe(1);
    });
  });

  describe("lookup methods", () => {
    it("getById returns the host or undefined", () => {
      const host = createHost({ id: "host-1" });
      registry.addHost(host);
      expect(registry.getById("host-1")).toBeDefined();
      expect(registry.getById("nonexistent")).toBeUndefined();
    });

    it("getByMachineId returns host matching machineId", () => {
      const host = createHost({ id: "host-1", machineId: "machine-x" });
      registry.addHost(host);
      expect(registry.getByMachineId("machine-x")?.id).toBe("host-1");
      expect(registry.getByMachineId("nonexistent")).toBeUndefined();
    });

    it("getByHostname returns host matching hostname", () => {
      const host = createHost({ id: "host-1", hostname: "my-macbook" });
      registry.addHost(host);
      expect(registry.getByHostname("my-macbook")?.id).toBe("host-1");
      expect(registry.getByHostname("nonexistent")).toBeUndefined();
    });
  });

  describe("serialization", () => {
    it("toJSON serializes all hosts", () => {
      registry.addHost(createHost({ id: "host-1", machineId: "m1" }));
      registry.addHost(createHost({ id: "host-2", machineId: "m2" }));
      const json = registry.toJSON();
      const parsed = JSON.parse(json) as HostProfile[];
      expect(parsed).toHaveLength(2);
    });

    it("fromJSON deserializes hosts", () => {
      const host = createHost({ id: "host-1" });
      const json = JSON.stringify([host]);
      const restored = DaemonRegistry.fromJSON(json);
      expect(restored.count()).toBe(1);
      expect(restored.getById("host-1")).toBeDefined();
    });

    it("fromJSON with empty string returns empty registry", () => {
      const restored = DaemonRegistry.fromJSON("");
      expect(restored.count()).toBe(0);
    });

    it("fromJSON with null returns empty registry", () => {
      const restored = DaemonRegistry.fromJSON(null);
      expect(restored.count()).toBe(0);
    });

    it("fromJSON with invalid JSON returns empty registry", () => {
      const restored = DaemonRegistry.fromJSON("not-json");
      expect(restored.count()).toBe(0);
    });
  });

  describe("QR pairing payload extraction", () => {
    it("parseQRPayloadUrl parses valid agentctx://pair URL", () => {
      const payload: PairingPayload = {
        version: 1,
        hostname: "work-macbook",
        os: "macos",
        daemonVersion: "1.0.0",
        machineId: "a3f7b2c9d1e4",
        lan: { address: "192.168.1.42", port: 9120 },
        relay: { serverId: "server-abc" },
        ephemeralPublicKey: "base64key==",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: "base64nonce==",
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const url = `agentctx://pair?data=${encoded}`;

      const result = DaemonRegistry.parseQRPayloadUrl(url);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.hostname).toBe("work-macbook");
        expect(result.payload.os).toBe("macos");
        expect(result.payload.machineId).toBe("a3f7b2c9d1e4");
      }
    });

    it("rejects invalid URL scheme", () => {
      const result = DaemonRegistry.parseQRPayloadUrl("https://example.com");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("INVALID_FORMAT");
      }
    });

    it("rejects URL without data parameter", () => {
      const result = DaemonRegistry.parseQRPayloadUrl("agentctx://pair");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("INVALID_FORMAT");
      }
    });

    it("rejects invalid base64 data", () => {
      const result = DaemonRegistry.parseQRPayloadUrl(
        "agentctx://pair?data=!!invalid!!"
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("PARSE_ERROR");
      }
    });

    it("rejects expired QR code", () => {
      const payload: PairingPayload = {
        version: 1,
        hostname: "work-macbook",
        os: "macos",
        daemonVersion: "1.0.0",
        machineId: "a3f7b2c9d1e4",
        ephemeralPublicKey: "base64key==",
        expiresAt: new Date(Date.now() - 600000).toISOString(),
        nonce: "base64nonce==",
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const url = `agentctx://pair?data=${encoded}`;

      const result = DaemonRegistry.parseQRPayloadUrl(url);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("EXPIRED");
      }
    });

    it("rejects payload with missing required fields", () => {
      const payload = {
        version: 1,
        hostname: "work-macbook",
        // missing os, machineId, ephemeralPublicKey, expiresAt
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const url = `agentctx://pair?data=${encoded}`;

      const result = DaemonRegistry.parseQRPayloadUrl(url);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("PARSE_ERROR");
      }
    });

    it("rejects payload with wrong version", () => {
      const payload = {
        version: 99,
        hostname: "work-macbook",
        os: "macos",
        daemonVersion: "1.0.0",
        machineId: "a3f7b2c9d1e4",
        ephemeralPublicKey: "base64key==",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: "base64nonce==",
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const url = `agentctx://pair?data=${encoded}`;

      const result = DaemonRegistry.parseQRPayloadUrl(url);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("INVALID_FORMAT");
      }
    });

    it("creates HostProfile from valid pairing payload", () => {
      const payload: PairingPayload = {
        version: 1,
        hostname: "work-macbook",
        os: "macos",
        daemonVersion: "1.0.0",
        machineId: "a3f7b2c9d1e4",
        lan: { address: "192.168.1.42", port: 9120 },
        relay: { serverId: "server-abc" },
        ephemeralPublicKey: "base64key==",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: "base64nonce==",
      };

      const host = DaemonRegistry.createHostFromPayload(
        payload,
        "daemon-pub-key"
      );
      expect(host.hostname).toBe("work-macbook");
      expect(host.name).toBe("work-macbook");
      expect(host.os).toBe("macos");
      expect(host.machineId).toBe("a3f7b2c9d1e4");
      expect(host.connectionType).toBe("lan");
      expect(host.lanAddress).toBe("192.168.1.42:9120");
      expect(host.relayServerId).toBe("server-abc");
      expect(host.publicKey).toBe("daemon-pub-key");
      expect(host.connectionState).toBe("disconnected");
      expect(host.id).toBeDefined();
      expect(host.pairedAt).toBeDefined();
    });

    it("creates relay-only HostProfile when no LAN info", () => {
      const payload: PairingPayload = {
        version: 1,
        hostname: "remote-vm",
        os: "linux",
        daemonVersion: "1.0.0",
        machineId: "b4e8c3d2f1a5",
        relay: { serverId: "server-xyz" },
        ephemeralPublicKey: "base64key==",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: "base64nonce==",
      };

      const host = DaemonRegistry.createHostFromPayload(
        payload,
        "daemon-pub-key"
      );
      expect(host.connectionType).toBe("relay");
      expect(host.lanAddress).toBeUndefined();
    });
  });

  describe("capacity limits", () => {
    it("supports up to 10 hosts", () => {
      for (let i = 0; i < 10; i++) {
        registry.addHost(
          createHost({ id: `host-${i}`, machineId: `machine-${i}` })
        );
      }
      expect(registry.count()).toBe(10);
    });
  });
});
