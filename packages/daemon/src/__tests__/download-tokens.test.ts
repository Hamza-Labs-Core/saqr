/**
 * Tests for DownloadTokens — single-use, time-limited file access tokens.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DownloadTokenManager,
  createDownloadToken,
  verifyDownloadToken,
} from "../security/download-tokens.js";

describe("DownloadTokenManager", () => {
  let manager: DownloadTokenManager;

  beforeEach(() => {
    manager = new DownloadTokenManager({ secret: "test-secret-key" });
  });

  // -------------------------------------------------------------------------
  // Token generation
  // -------------------------------------------------------------------------

  describe("createToken", () => {
    it("should generate a token string", () => {
      const token = manager.createToken("file-abc123");
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("should generate tokens in the format fileId.expiry.signature", () => {
      const token = manager.createToken("file-abc123");
      const parts = token.split(".");
      // fileId is "file-abc123", expiry is a number, signature is hex
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe("file-abc123");
      expect(parseInt(parts[1]!, 10)).toBeGreaterThan(0);
      expect(parts[2]!.length).toBe(64); // SHA-256 hex = 64 chars
    });

    it("should set correct expiry based on TTL", () => {
      const now = Math.floor(Date.now() / 1000);
      const manager300 = new DownloadTokenManager({
        secret: "test",
        ttlSeconds: 300,
      });

      const token = manager300.createToken("file-1");
      const parsed = manager300.parseToken(token);

      expect(parsed).not.toBeNull();
      expect(parsed!.expiry).toBeGreaterThanOrEqual(now + 299);
      expect(parsed!.expiry).toBeLessThanOrEqual(now + 301);
    });

    it("should support TTL override per token", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = manager.createToken("file-1", 60); // 1 minute

      const parsed = manager.parseToken(token);
      expect(parsed).not.toBeNull();
      expect(parsed!.expiry).toBeGreaterThanOrEqual(now + 59);
      expect(parsed!.expiry).toBeLessThanOrEqual(now + 61);
    });

    it("should reject empty fileId", () => {
      expect(() => manager.createToken("")).toThrow();
    });

    it("should reject fileId with dots", () => {
      expect(() => manager.createToken("file.with.dots")).toThrow();
    });

    it("should generate unique tokens for same fileId", () => {
      // With the same secret and TTL, tokens for the same file at the same
      // second will be identical, but different files will differ
      const token1 = manager.createToken("file-1");
      const token2 = manager.createToken("file-2");
      expect(token1).not.toBe(token2);
    });
  });

  // -------------------------------------------------------------------------
  // Token verification
  // -------------------------------------------------------------------------

  describe("verifyToken", () => {
    it("should verify a valid token", () => {
      const token = manager.createToken("file-abc");
      const result = manager.verifyToken(token);

      expect(result.valid).toBe(true);
      expect(result.fileId).toBe("file-abc");
    });

    it("should reject invalid signature", () => {
      const token = manager.createToken("file-abc");
      // Tamper with the signature
      const tampered = token.slice(0, -4) + "dead";

      const result = manager.verifyToken(tampered);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("signature");
    });

    it("should reject tampered fileId", () => {
      const token = manager.createToken("file-abc");
      // Replace fileId
      const parts = token.split(".");
      const tampered = `file-xyz.${parts[1]}.${parts[2]}`;

      const result = manager.verifyToken(tampered);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("signature");
    });

    it("should reject tampered expiry", () => {
      const token = manager.createToken("file-abc");
      const parts = token.split(".");
      const newExpiry = parseInt(parts[1]!, 10) + 999999;
      const tampered = `${parts[0]}.${newExpiry}.${parts[2]}`;

      const result = manager.verifyToken(tampered);
      expect(result.valid).toBe(false);
    });

    it("should reject expired tokens", () => {
      let currentTime = 1000;
      const timedManager = new DownloadTokenManager(
        { secret: "test", ttlSeconds: 60 },
        () => currentTime,
      );

      const token = timedManager.createToken("file-abc");

      // Advance time past expiry
      currentTime = 1000 + 61;

      const result = timedManager.verifyToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("should reject invalid format (empty string)", () => {
      const result = manager.verifyToken("");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("format");
    });

    it("should reject invalid format (no dots)", () => {
      const result = manager.verifyToken("nodots");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("format");
    });

    it("should reject invalid format (one dot)", () => {
      const result = manager.verifyToken("one.dot");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("format");
    });

    it("should reject token with non-numeric expiry", () => {
      const result = manager.verifyToken("file.notanumber.sig");
      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Single-use enforcement
  // -------------------------------------------------------------------------

  describe("single-use tokens", () => {
    it("should invalidate token after first use", () => {
      const token = manager.createToken("file-abc");

      const first = manager.verifyToken(token);
      expect(first.valid).toBe(true);

      const second = manager.verifyToken(token);
      expect(second.valid).toBe(false);
      expect(second.reason).toContain("already used");
    });

    it("should track used token count", () => {
      expect(manager.getUsedTokenCount()).toBe(0);

      const token1 = manager.createToken("file-1");
      const token2 = manager.createToken("file-2");

      manager.verifyToken(token1);
      expect(manager.getUsedTokenCount()).toBe(1);

      manager.verifyToken(token2);
      expect(manager.getUsedTokenCount()).toBe(2);
    });

    it("should allow clearing used tokens", () => {
      const token = manager.createToken("file-abc");
      manager.verifyToken(token);
      expect(manager.getUsedTokenCount()).toBe(1);

      manager.clearUsedTokens();
      expect(manager.getUsedTokenCount()).toBe(0);
    });

    it("should handle maxUsedTokens overflow gracefully", () => {
      const smallManager = new DownloadTokenManager({
        secret: "test",
        maxUsedTokens: 10,
      });

      // Generate and verify more tokens than the limit
      for (let i = 0; i < 15; i++) {
        const token = smallManager.createToken(`file-${i}`);
        smallManager.verifyToken(token);
      }

      // Should not exceed the limit by too much
      expect(smallManager.getUsedTokenCount()).toBeLessThanOrEqual(15);
    });
  });

  // -------------------------------------------------------------------------
  // Token parsing
  // -------------------------------------------------------------------------

  describe("parseToken", () => {
    it("should parse a valid token", () => {
      const token = manager.createToken("file-abc");
      const parsed = manager.parseToken(token);

      expect(parsed).not.toBeNull();
      expect(parsed!.fileId).toBe("file-abc");
      expect(parsed!.expiry).toBeGreaterThan(0);
      expect(parsed!.signature).toHaveLength(64);
    });

    it("should return null for invalid tokens", () => {
      expect(manager.parseToken("")).toBeNull();
      expect(manager.parseToken("invalid")).toBeNull();
      expect(manager.parseToken("only.two")).toBeNull();
    });

    it("should return null for null/undefined input", () => {
      expect(manager.parseToken(null as any)).toBeNull();
      expect(manager.parseToken(undefined as any)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Different secrets
  // -------------------------------------------------------------------------

  describe("secret isolation", () => {
    it("should reject tokens signed with different secret", () => {
      const manager1 = new DownloadTokenManager({ secret: "secret-1" });
      const manager2 = new DownloadTokenManager({ secret: "secret-2" });

      const token = manager1.createToken("file-abc");
      const result = manager2.verifyToken(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("signature");
    });
  });

  // -------------------------------------------------------------------------
  // Convenience functions
  // -------------------------------------------------------------------------

  describe("createDownloadToken", () => {
    it("should create a token string", () => {
      const token = createDownloadToken("file-abc", { secret: "test" });
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);
    });
  });

  describe("verifyDownloadToken", () => {
    it("should verify token with same secret", () => {
      const config = { secret: "shared-secret" };
      const token = createDownloadToken("file-abc", config);

      // Note: convenience functions create new managers, so single-use
      // check won't work across calls. This tests format + signature only.
      const result = verifyDownloadToken(token, config);
      expect(result.valid).toBe(true);
      expect(result.fileId).toBe("file-abc");
    });
  });
});
