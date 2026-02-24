import { describe, it, expect } from "vitest";
import {
  KEY_PURPOSES,
  DEFAULT_KEY_DERIVATION_PARAMS,
} from "../crypto/index.js";
import type {
  MasterKey,
  DerivedKey,
  KeyPurpose,
  EncryptionResult,
  KeyDerivationParams,
} from "../crypto/index.js";

describe("crypto/types", () => {
  describe("KEY_PURPOSES", () => {
    it("should contain all key purposes", () => {
      expect(KEY_PURPOSES).toEqual([
        "event-encryption",
        "metadata-signing",
        "session-key",
      ]);
    });

    it("should have exactly 3 purposes", () => {
      expect(KEY_PURPOSES).toHaveLength(3);
    });
  });

  describe("DEFAULT_KEY_DERIVATION_PARAMS", () => {
    it("should have secure default values following OWASP recommendations", () => {
      expect(DEFAULT_KEY_DERIVATION_PARAMS.memoryCost).toBe(65536);
      expect(DEFAULT_KEY_DERIVATION_PARAMS.timeCost).toBe(3);
      expect(DEFAULT_KEY_DERIVATION_PARAMS.parallelism).toBe(4);
      expect(DEFAULT_KEY_DERIVATION_PARAMS.keyLength).toBe(32);
    });

    it("should not include salt (salt must be per-user)", () => {
      expect("salt" in DEFAULT_KEY_DERIVATION_PARAMS).toBe(false);
    });
  });

  describe("MasterKey interface", () => {
    it("should accept a valid MasterKey (compile-time check)", () => {
      const key: MasterKey = {
        keyBytes: "base64encodedkey==",
        keyId: "key-001",
        createdAt: "2026-02-22T10:00:00.000Z",
        version: 1,
      };

      expect(key.keyId).toBe("key-001");
      expect(key.version).toBe(1);
    });
  });

  describe("DerivedKey interface", () => {
    it("should accept a valid DerivedKey (compile-time check)", () => {
      const key: DerivedKey = {
        keyBytes: "base64derivedkey==",
        purpose: "event-encryption",
        masterKeyId: "key-001",
      };

      expect(key.purpose).toBe("event-encryption");
      expect(key.masterKeyId).toBe("key-001");
    });

    it("should accept all key purposes", () => {
      for (const purpose of KEY_PURPOSES) {
        const key: DerivedKey = {
          keyBytes: "key==",
          purpose,
          masterKeyId: "mk-1",
        };
        expect(key.purpose).toBe(purpose);
      }
    });
  });

  describe("EncryptionResult interface", () => {
    it("should accept a valid EncryptionResult (compile-time check)", () => {
      const result: EncryptionResult = {
        ciphertext: "encrypted-data==",
        nonce: "random-nonce==",
        keyId: "key-001",
        algorithm: "xchacha20-poly1305",
        plaintextLength: 1024,
      };

      expect(result.algorithm).toBe("xchacha20-poly1305");
      expect(result.plaintextLength).toBe(1024);
    });
  });

  describe("KeyDerivationParams interface", () => {
    it("should accept full params including salt (compile-time check)", () => {
      const params: KeyDerivationParams = {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
        salt: "random-salt-base64==",
        keyLength: 32,
      };

      expect(params.salt).toBe("random-salt-base64==");
      expect(params.memoryCost).toBe(65536);
    });

    it("should allow custom params different from defaults", () => {
      const params: KeyDerivationParams = {
        memoryCost: 131072,
        timeCost: 5,
        parallelism: 8,
        salt: "custom-salt==",
        keyLength: 64,
      };

      expect(params.memoryCost).toBe(131072);
      expect(params.keyLength).toBe(64);
    });
  });
});
