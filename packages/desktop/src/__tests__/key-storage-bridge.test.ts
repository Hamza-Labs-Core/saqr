/**
 * Tests for Key Storage Bridge.
 *
 * TypeScript interface for platform key storage that calls the
 * Rust backend via IPC. Tests focus on the TypeScript layer:
 * validation, encoding, error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  KeyStorageBridge,
  KeyStorageError,
  KEY_SIZE_LIMIT,
} from "../key-storage-bridge.js";

type MockInvoke = ReturnType<typeof vi.fn>;

describe("KeyStorageBridge", () => {
  let mockInvoke: MockInvoke;
  let bridge: KeyStorageBridge;

  beforeEach(() => {
    mockInvoke = vi.fn();
    bridge = new KeyStorageBridge(mockInvoke);
  });

  describe("storeKey", () => {
    it("should encode bytes as base64 and invoke store_key", async () => {
      mockInvoke.mockResolvedValue(undefined);
      const keyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      await bridge.storeKey("test-key", keyBytes);

      expect(mockInvoke).toHaveBeenCalledWith("store_key", {
        keyId: "test-key",
        keyBase64: expect.any(String),
      });
    });

    it("should round-trip 32-byte key correctly", async () => {
      let storedBase64 = "";
      mockInvoke.mockImplementation(
        (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "store_key" && args) {
            storedBase64 = args["keyBase64"] as string;
            return Promise.resolve(undefined);
          }
          if (cmd === "retrieve_key") {
            return Promise.resolve(storedBase64);
          }
          return Promise.resolve(undefined);
        }
      );

      const original = new Uint8Array(32);
      for (let i = 0; i < 32; i++) original[i] = i;

      await bridge.storeKey("round-trip-key", original);
      const retrieved = await bridge.retrieveKey("round-trip-key");

      expect(retrieved).toEqual(original);
    });

    it("should round-trip 64-byte key correctly", async () => {
      let storedBase64 = "";
      mockInvoke.mockImplementation(
        (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "store_key" && args) {
            storedBase64 = args["keyBase64"] as string;
            return Promise.resolve(undefined);
          }
          if (cmd === "retrieve_key") {
            return Promise.resolve(storedBase64);
          }
          return Promise.resolve(undefined);
        }
      );

      const original = new Uint8Array(64);
      for (let i = 0; i < 64; i++) original[i] = i % 256;

      await bridge.storeKey("big-key", original);
      const retrieved = await bridge.retrieveKey("big-key");

      expect(retrieved).toEqual(original);
    });

    it("should reject keys larger than size limit", async () => {
      const oversized = new Uint8Array(KEY_SIZE_LIMIT + 1);

      await expect(bridge.storeKey("big", oversized)).rejects.toThrow(
        KeyStorageError
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should reject empty key ID", async () => {
      const key = new Uint8Array(32);

      await expect(bridge.storeKey("", key)).rejects.toThrow(KeyStorageError);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should reject empty key bytes", async () => {
      const key = new Uint8Array(0);

      await expect(bridge.storeKey("test", key)).rejects.toThrow(
        KeyStorageError
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should propagate IPC errors as KeyStorageError", async () => {
      mockInvoke.mockRejectedValue("Backend error: keychain locked");

      const key = new Uint8Array(32);
      await expect(bridge.storeKey("test", key)).rejects.toThrow(
        KeyStorageError
      );
    });
  });

  describe("retrieveKey", () => {
    it("should invoke retrieve_key and decode base64", async () => {
      // Base64 for bytes [1,2,3,4]
      mockInvoke.mockResolvedValue("AQIDBA==");

      const result = await bridge.retrieveKey("test-key");

      expect(mockInvoke).toHaveBeenCalledWith("retrieve_key", {
        keyId: "test-key",
      });
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("should throw KeyStorageError for key not found", async () => {
      mockInvoke.mockRejectedValue("Key not found: missing-key");

      await expect(bridge.retrieveKey("missing-key")).rejects.toThrow(
        KeyStorageError
      );
    });

    it("should reject empty key ID", async () => {
      await expect(bridge.retrieveKey("")).rejects.toThrow(KeyStorageError);
    });
  });

  describe("deleteKey", () => {
    it("should invoke delete_key", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await bridge.deleteKey("test-key");

      expect(mockInvoke).toHaveBeenCalledWith("delete_key", {
        keyId: "test-key",
      });
    });

    it("should not throw when deleting non-existent key (idempotent)", async () => {
      mockInvoke.mockResolvedValue(undefined);

      await expect(bridge.deleteKey("nonexistent")).resolves.not.toThrow();
    });

    it("should reject empty key ID", async () => {
      await expect(bridge.deleteKey("")).rejects.toThrow(KeyStorageError);
    });
  });

  describe("hasKey", () => {
    it("should return true when key exists", async () => {
      mockInvoke.mockResolvedValue(true);

      const result = await bridge.hasKey("existing-key");

      expect(mockInvoke).toHaveBeenCalledWith("has_key", {
        keyId: "existing-key",
      });
      expect(result).toBe(true);
    });

    it("should return false when key does not exist", async () => {
      mockInvoke.mockResolvedValue(false);

      const result = await bridge.hasKey("nonexistent");

      expect(result).toBe(false);
    });

    it("should reject empty key ID", async () => {
      await expect(bridge.hasKey("")).rejects.toThrow(KeyStorageError);
    });
  });

  describe("error messages", () => {
    it("should never include base64 key material in error messages", async () => {
      // Simulate an error that includes base64 key material
      const fakeBase64 = "dGVzdGtleWRhdGFiYXNlNjQ=";
      mockInvoke.mockRejectedValue(
        `Store error: failed to store ${fakeBase64} in keychain`
      );

      try {
        const key = new Uint8Array([1, 2, 3]);
        await bridge.storeKey("test", key);
      } catch (e) {
        expect(e).toBeInstanceOf(KeyStorageError);
        const error = e as KeyStorageError;
        // The actual base64 content should be redacted
        expect(error.message).not.toContain(fakeBase64);
        expect(error.message).toContain("[REDACTED]");
      }
    });
  });
});
