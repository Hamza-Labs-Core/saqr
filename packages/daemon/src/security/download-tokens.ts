/**
 * DownloadTokens — Single-use, time-limited file access tokens.
 *
 * Generates HMAC-SHA256 signed tokens for secure file downloads.
 * Each token is single-use (invalidated after first use) and
 * expires after a configurable TTL.
 *
 * Token format: `{fileId}.{expiry}.{signature}`
 * - fileId: identifier of the file to download
 * - expiry: Unix timestamp (seconds) when the token expires
 * - signature: HMAC-SHA256(fileId + "." + expiry, secret) hex-encoded
 *
 * @module security/download-tokens
 */

import { createHmac, randomBytes } from "node:crypto";

/**
 * Configuration for the download token manager.
 */
export interface DownloadTokenConfig {
  /** HMAC secret key. Auto-generated if not provided. */
  secret?: string;

  /** Token TTL in seconds. Default: 300 (5 minutes) */
  ttlSeconds?: number;

  /** Maximum number of used tokens to track (prevents memory leak). Default: 10000 */
  maxUsedTokens?: number;
}

/**
 * A parsed download token.
 */
export interface ParsedToken {
  fileId: string;
  expiry: number;
  signature: string;
}

/**
 * Result of token verification.
 */
export interface TokenVerificationResult {
  valid: boolean;
  fileId?: string;
  reason?: string;
}

/**
 * DownloadTokenManager generates and verifies single-use download tokens.
 */
export class DownloadTokenManager {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly maxUsedTokens: number;
  private readonly usedTokens: Set<string>;
  private readonly _nowFn: () => number;

  constructor(config: DownloadTokenConfig = {}, nowFn?: () => number) {
    this.secret = config.secret ?? randomBytes(32).toString("hex");
    this.ttlSeconds = config.ttlSeconds ?? 300;
    this.maxUsedTokens = config.maxUsedTokens ?? 10000;
    this.usedTokens = new Set();
    this._nowFn = nowFn ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Generate a download token for a file.
   *
   * @param fileId - The file identifier
   * @param ttlOverride - Optional TTL override in seconds
   * @returns The signed token string
   */
  createToken(fileId: string, ttlOverride?: number): string {
    if (!fileId || fileId.includes(".")) {
      throw new Error("fileId must not be empty or contain dots");
    }

    const ttl = ttlOverride ?? this.ttlSeconds;
    const expiry = this._nowFn() + ttl;
    const payload = `${fileId}.${expiry}`;
    const signature = this.sign(payload);

    return `${payload}.${signature}`;
  }

  /**
   * Verify a download token.
   *
   * Checks:
   * 1. Token format is valid
   * 2. Signature matches (HMAC-SHA256)
   * 3. Token has not expired
   * 4. Token has not been used before (single-use)
   *
   * If valid, the token is marked as used and cannot be reused.
   *
   * @param token - The token string to verify
   * @returns Verification result with fileId if valid
   */
  verifyToken(token: string): TokenVerificationResult {
    // Parse token
    const parsed = this.parseToken(token);
    if (!parsed) {
      return { valid: false, reason: "Invalid token format" };
    }

    // Verify signature
    const payload = `${parsed.fileId}.${parsed.expiry}`;
    const expectedSig = this.sign(payload);

    if (!this.timingSafeEqual(parsed.signature, expectedSig)) {
      return { valid: false, reason: "Invalid signature" };
    }

    // Check expiry
    const now = this._nowFn();
    if (now > parsed.expiry) {
      return { valid: false, reason: "Token expired" };
    }

    // Check single-use
    if (this.usedTokens.has(token)) {
      return { valid: false, reason: "Token already used" };
    }

    // Mark as used
    this.markUsed(token);

    return { valid: true, fileId: parsed.fileId };
  }

  /**
   * Parse a token string into its components.
   *
   * @param token - The token string
   * @returns Parsed token, or null if format is invalid
   */
  parseToken(token: string): ParsedToken | null {
    if (!token || typeof token !== "string") {
      return null;
    }

    // Token format: fileId.expiry.signature
    // We need to find exactly 3 parts. The signature is always the last
    // 64-char hex string. The expiry is always a numeric string.
    const lastDot = token.lastIndexOf(".");
    if (lastDot < 0) return null;

    const signature = token.substring(lastDot + 1);
    const rest = token.substring(0, lastDot);

    const secondDot = rest.lastIndexOf(".");
    if (secondDot < 0) return null;

    const fileId = rest.substring(0, secondDot);
    const expiryStr = rest.substring(secondDot + 1);

    if (!fileId || !expiryStr || !signature) {
      return null;
    }

    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry)) {
      return null;
    }

    return { fileId, expiry, signature };
  }

  /**
   * Get the number of used tokens being tracked.
   */
  getUsedTokenCount(): number {
    return this.usedTokens.size;
  }

  /**
   * Clear all used token records.
   */
  clearUsedTokens(): void {
    this.usedTokens.clear();
  }

  /**
   * Compute HMAC-SHA256 signature.
   */
  private sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");
  }

  /**
   * Timing-safe string comparison to prevent timing attacks.
   */
  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    try {
      const { timingSafeEqual: tse } = require("node:crypto");
      return tse(bufA, bufB);
    } catch {
      // Fallback (shouldn't happen in Node.js)
      let result = 0;
      for (let i = 0; i < bufA.length; i++) {
        result |= bufA[i]! ^ bufB[i]!;
      }
      return result === 0;
    }
  }

  /**
   * Mark a token as used and manage the used-token set size.
   */
  private markUsed(token: string): void {
    this.usedTokens.add(token);

    // Prevent unbounded growth: if we exceed the limit,
    // clear the oldest half. Since Set is insertion-ordered,
    // we can use the iterator.
    if (this.usedTokens.size > this.maxUsedTokens) {
      const toRemove = Math.floor(this.maxUsedTokens / 2);
      let count = 0;
      for (const t of this.usedTokens) {
        if (count >= toRemove) break;
        this.usedTokens.delete(t);
        count++;
      }
    }
  }
}

/** Shared singleton manager for convenience functions (preserves used-token set). */
let sharedManager: DownloadTokenManager | null = null;
let sharedManagerConfig: string | undefined;

function getSharedManager(config?: DownloadTokenConfig): DownloadTokenManager {
  const configKey = config ? JSON.stringify(config) : undefined;
  if (!sharedManager || sharedManagerConfig !== configKey) {
    sharedManager = new DownloadTokenManager(config);
    sharedManagerConfig = configKey;
  }
  return sharedManager;
}

/**
 * Convenience: create a download token.
 */
export function createDownloadToken(
  fileId: string,
  config?: DownloadTokenConfig,
): string {
  return getSharedManager(config).createToken(fileId);
}

/**
 * Convenience: verify a download token.
 */
export function verifyDownloadToken(
  token: string,
  config?: DownloadTokenConfig,
): TokenVerificationResult {
  return getSharedManager(config).verifyToken(token);
}

/**
 * Reset the shared manager (for testing).
 */
export function resetSharedManager(): void {
  sharedManager = null;
  sharedManagerConfig = undefined;
}
