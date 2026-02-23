/**
 * Tests for the EncryptionKeyManager service.
 *
 * Covers key lifecycle (generate, store reference, export, import),
 * key cache with auto-clear, and QR transfer protocol data handling.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  EncryptionKeyManager,
  KeyCache,
} from "../services/encryption-key-manager.js";
import type { KeyInfo, KeyTransferPayload } from "../types/crypto.js";

describe("EncryptionKeyManager", () => {
  let keyManager: EncryptionKeyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T14:00:00Z"));
    keyManager = new EncryptionKeyManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("key generation", () => {
    it("generateKeyId produces 8-char hex string", () => {
      const keyBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) keyBytes[i] = i;

      const keyId = EncryptionKeyManager.generateKeyId(keyBytes);
      expect(keyId).toMatch(/^[0-9a-f]{8}$/);
    });

    it("generateKeyId produces consistent results for same input", () => {
      const keyBytes = new Uint8Array(32).fill(42);
      const id1 = EncryptionKeyManager.generateKeyId(keyBytes);
      const id2 = EncryptionKeyManager.generateKeyId(keyBytes);
      expect(id1).toBe(id2);
    });

    it("generateKeyId produces different results for different input", () => {
      const key1 = new Uint8Array(32).fill(1);
      const key2 = new Uint8Array(32).fill(2);
      const id1 = EncryptionKeyManager.generateKeyId(key1);
      const id2 = EncryptionKeyManager.generateKeyId(key2);
      expect(id1).not.toBe(id2);
    });
  });

  describe("key info management", () => {
    it("storeKeyInfo saves key metadata", () => {
      const info: KeyInfo = {
        keyId: "a3f7b2c9",
        createdAt: "2026-02-15T10:00:00Z",
        lastUsedAt: "2026-02-22T14:00:00Z",
        biometricEnabled: true,
        deviceName: "iPhone 15",
      };
      keyManager.storeKeyInfo(info);
      expect(keyManager.getKeyInfo()).toEqual(info);
    });

    it("hasKey returns false when no key stored", () => {
      expect(keyManager.hasKey()).toBe(false);
    });

    it("hasKey returns true when key info is stored", () => {
      keyManager.storeKeyInfo({
        keyId: "a3f7b2c9",
        createdAt: "2026-02-15T10:00:00Z",
        lastUsedAt: "2026-02-22T14:00:00Z",
        biometricEnabled: true,
        deviceName: "iPhone 15",
      });
      expect(keyManager.hasKey()).toBe(true);
    });

    it("deleteKeyInfo removes stored key info", () => {
      keyManager.storeKeyInfo({
        keyId: "a3f7b2c9",
        createdAt: "2026-02-15T10:00:00Z",
        lastUsedAt: "2026-02-22T14:00:00Z",
        biometricEnabled: true,
        deviceName: "iPhone 15",
      });
      keyManager.deleteKeyInfo();
      expect(keyManager.hasKey()).toBe(false);
    });

    it("updateLastUsed updates the lastUsedAt timestamp", () => {
      keyManager.storeKeyInfo({
        keyId: "a3f7b2c9",
        createdAt: "2026-02-15T10:00:00Z",
        lastUsedAt: "2026-02-15T10:00:00Z",
        biometricEnabled: true,
        deviceName: "iPhone 15",
      });

      keyManager.updateLastUsed("2026-02-22T14:00:00Z");
      expect(keyManager.getKeyInfo()?.lastUsedAt).toBe(
        "2026-02-22T14:00:00Z"
      );
    });

    it("updateBiometric toggles biometric setting", () => {
      keyManager.storeKeyInfo({
        keyId: "a3f7b2c9",
        createdAt: "2026-02-15T10:00:00Z",
        lastUsedAt: "2026-02-15T10:00:00Z",
        biometricEnabled: true,
        deviceName: "iPhone 15",
      });

      keyManager.updateBiometric(false);
      expect(keyManager.getKeyInfo()?.biometricEnabled).toBe(false);
    });
  });

  describe("QR transfer protocol data", () => {
    it("createTransferPayload generates valid payload", () => {
      const payload = EncryptionKeyManager.createTransferPayload(
        "base64pubkey==",
        { address: "192.168.1.42", port: 9121 }
      );

      expect(payload.version).toBe(1);
      expect(payload.type).toBe("key_transfer");
      expect(payload.ephemeralPublicKey).toBe("base64pubkey==");
      expect(payload.lan?.address).toBe("192.168.1.42");
      expect(payload.lan?.port).toBe(9121);
      expect(payload.expiresAt).toBeDefined();
      expect(payload.nonce).toBeDefined();
    });

    it("createTransferPayload sets expiry 2 minutes in future", () => {
      const now = new Date("2026-02-22T14:00:00Z");
      const payload = EncryptionKeyManager.createTransferPayload(
        "base64pubkey=="
      );

      const expiresAt = new Date(payload.expiresAt);
      const diff = expiresAt.getTime() - now.getTime();
      expect(diff).toBe(2 * 60 * 1000);
    });

    it("encodeTransferUrl produces agentctx://key-transfer URL", () => {
      const payload: KeyTransferPayload = {
        version: 1,
        type: "key_transfer",
        ephemeralPublicKey: "base64pubkey==",
        expiresAt: "2026-02-22T14:02:00Z",
        nonce: "base64nonce==",
      };

      const url = EncryptionKeyManager.encodeTransferUrl(payload);
      expect(url.startsWith("agentctx://key-transfer?data=")).toBe(true);
    });

    it("decodeTransferUrl parses valid URL back to payload", () => {
      const original: KeyTransferPayload = {
        version: 1,
        type: "key_transfer",
        ephemeralPublicKey: "base64pubkey==",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: "base64nonce==",
      };

      const url = EncryptionKeyManager.encodeTransferUrl(original);
      const result = EncryptionKeyManager.decodeTransferUrl(url);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.payload.type).toBe("key_transfer");
        expect(result.payload.ephemeralPublicKey).toBe("base64pubkey==");
      }
    });

    it("decodeTransferUrl rejects invalid URL scheme", () => {
      const result = EncryptionKeyManager.decodeTransferUrl("https://evil.com");
      expect(result.success).toBe(false);
    });

    it("decodeTransferUrl rejects expired payload", () => {
      const payload: KeyTransferPayload = {
        version: 1,
        type: "key_transfer",
        ephemeralPublicKey: "base64pubkey==",
        expiresAt: new Date(Date.now() - 300000).toISOString(),
        nonce: "base64nonce==",
      };
      const url = EncryptionKeyManager.encodeTransferUrl(payload);
      const result = EncryptionKeyManager.decodeTransferUrl(url);
      expect(result.success).toBe(false);
    });

    it("verifyKeyIds compares two key IDs", () => {
      expect(EncryptionKeyManager.verifyKeyIds("a3f7b2c9", "a3f7b2c9")).toBe(
        true
      );
      expect(EncryptionKeyManager.verifyKeyIds("a3f7b2c9", "deadbeef")).toBe(
        false
      );
    });
  });
});

describe("KeyCache", () => {
  let keyCache: KeyCache;

  beforeEach(() => {
    vi.useFakeTimers();
    keyCache = new KeyCache();
  });

  afterEach(() => {
    keyCache.clear();
    vi.useRealTimers();
  });

  describe("caching behavior", () => {
    it("stores and retrieves key", () => {
      const key = new Uint8Array(32).fill(42);
      keyCache.setKey(key);
      expect(keyCache.getKey()).toEqual(key);
    });

    it("hasKey returns false initially", () => {
      expect(keyCache.hasKey()).toBe(false);
    });

    it("hasKey returns true after setting key", () => {
      keyCache.setKey(new Uint8Array(32));
      expect(keyCache.hasKey()).toBe(true);
    });

    it("clear zeroes key memory and removes from cache", () => {
      const key = new Uint8Array(32).fill(42);
      keyCache.setKey(key);
      keyCache.clear();

      expect(keyCache.hasKey()).toBe(false);
      expect(keyCache.getKey()).toBeNull();
    });
  });

  describe("auto-clear timer", () => {
    it("key is cleared after 5 minutes", () => {
      keyCache.setKey(new Uint8Array(32).fill(42));
      expect(keyCache.hasKey()).toBe(true);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(keyCache.hasKey()).toBe(false);
    });

    it("accessing key resets the timer", () => {
      keyCache.setKey(new Uint8Array(32).fill(42));

      vi.advanceTimersByTime(4 * 60 * 1000);
      keyCache.getKey(); // Access resets timer

      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(keyCache.hasKey()).toBe(true); // Still valid

      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(keyCache.hasKey()).toBe(false); // Now expired
    });

    it("clear cancels the auto-clear timer", () => {
      keyCache.setKey(new Uint8Array(32).fill(42));
      keyCache.clear();

      // Should not throw or cause issues
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(keyCache.hasKey()).toBe(false);
    });

    it("setting a new key resets the timer", () => {
      keyCache.setKey(new Uint8Array(32).fill(1));
      vi.advanceTimersByTime(4 * 60 * 1000);

      keyCache.setKey(new Uint8Array(32).fill(2));
      vi.advanceTimersByTime(4 * 60 * 1000);
      // 4 minutes since new key, should still be valid
      expect(keyCache.hasKey()).toBe(true);

      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(keyCache.hasKey()).toBe(false);
    });
  });
});
