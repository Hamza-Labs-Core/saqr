/**
 * EncryptionKeyManager - Key lifecycle management and QR transfer protocol.
 *
 * Manages key metadata (KeyInfo), key ID generation, transfer payload
 * encoding/decoding, and the in-memory KeyCache with auto-clear.
 *
 * Note: Actual secure storage (Keychain/Keystore) operations are
 * platform-specific and will be wired in the React Native layer.
 * This module handles the pure data/logic layer.
 *
 * @module services/encryption-key-manager
 */

import { createHash } from "node:crypto";
import type { KeyInfo, KeyTransferPayload, QRLanInfo } from "../types/crypto.js";
import type { QRScanError } from "../types/errors.js";
import {
  KEY_TRANSFER_URL_SCHEME,
  KEY_TRANSFER_MAX_AGE_MS,
} from "../types/crypto.js";

/** Result of decoding a transfer URL. */
export type DecodeResult =
  | { success: true; payload: KeyTransferPayload }
  | { success: false; error: QRScanError };

/**
 * Manages encryption key metadata and QR transfer protocol.
 */
export class EncryptionKeyManager {
  private keyInfo: KeyInfo | null = null;

  /**
   * Generate a key ID (first 8 hex chars of SHA-256) from raw key bytes.
   */
  static generateKeyId(keyBytes: Uint8Array): string {
    const hash = createHash("sha256").update(keyBytes).digest("hex");
    return hash.slice(0, 8);
  }

  /**
   * Check if a key is stored.
   */
  hasKey(): boolean {
    return this.keyInfo !== null;
  }

  /**
   * Get the current key info (metadata only, not the actual key).
   */
  getKeyInfo(): KeyInfo | null {
    return this.keyInfo ? { ...this.keyInfo } : null;
  }

  /**
   * Store key metadata.
   */
  storeKeyInfo(info: KeyInfo): void {
    this.keyInfo = { ...info };
  }

  /**
   * Delete key metadata.
   */
  deleteKeyInfo(): void {
    this.keyInfo = null;
  }

  /**
   * Update the lastUsedAt timestamp.
   */
  updateLastUsed(timestamp: string): void {
    if (this.keyInfo) {
      this.keyInfo.lastUsedAt = timestamp;
    }
  }

  /**
   * Update the biometric setting.
   */
  updateBiometric(enabled: boolean): void {
    if (this.keyInfo) {
      this.keyInfo.biometricEnabled = enabled;
    }
  }

  /**
   * Create a key transfer payload for QR display.
   */
  static createTransferPayload(
    ephemeralPublicKey: string,
    lan?: QRLanInfo
  ): KeyTransferPayload {
    const expiresAt = new Date(
      Date.now() + KEY_TRANSFER_MAX_AGE_MS
    ).toISOString();
    const nonce = Buffer.from(
      crypto.getRandomValues(new Uint8Array(24))
    ).toString("base64");

    return {
      version: 1,
      type: "key_transfer",
      ephemeralPublicKey,
      lan,
      expiresAt,
      nonce,
    };
  }

  /**
   * Encode a transfer payload into a URL string.
   */
  static encodeTransferUrl(payload: KeyTransferPayload): string {
    const json = JSON.stringify(payload);
    const encoded = Buffer.from(json).toString("base64url");
    return `${KEY_TRANSFER_URL_SCHEME}?data=${encoded}`;
  }

  /**
   * Decode a transfer URL back to a payload.
   */
  static decodeTransferUrl(url: string): DecodeResult {
    if (!url.startsWith(KEY_TRANSFER_URL_SCHEME)) {
      return {
        success: false,
        error: {
          type: "INVALID_FORMAT",
          message: "Invalid URL scheme for key transfer",
        },
      };
    }

    const dataMatch = url.match(/[?&]data=([^&]+)/);
    if (!dataMatch) {
      return {
        success: false,
        error: {
          type: "INVALID_FORMAT",
          message: "Missing data parameter",
        },
      };
    }

    let decoded: string;
    try {
      decoded = Buffer.from(dataMatch[1], "base64url").toString("utf-8");
    } catch {
      return {
        success: false,
        error: {
          type: "PARSE_ERROR",
          message: "Could not decode data",
        },
      };
    }

    let payload: KeyTransferPayload;
    try {
      payload = JSON.parse(decoded) as KeyTransferPayload;
    } catch {
      return {
        success: false,
        error: {
          type: "PARSE_ERROR",
          message: "Invalid JSON",
        },
      };
    }

    // Check expiry
    const expiresAt = new Date(payload.expiresAt).getTime();
    if (Date.now() > expiresAt) {
      return {
        success: false,
        error: {
          type: "EXPIRED",
          message: "Key transfer QR code has expired",
        },
      };
    }

    return { success: true, payload };
  }

  /**
   * Compare two key IDs for verification.
   */
  static verifyKeyIds(id1: string, id2: string): boolean {
    return id1 === id2;
  }
}

/**
 * In-memory key cache with auto-clear after 5 minutes.
 *
 * Stores the raw encryption key bytes in memory for a limited time,
 * avoiding repeated biometric prompts.
 */
export class KeyCache {
  private key: Uint8Array | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CACHE_DURATION_MS = 5 * 60 * 1000;

  /**
   * Check if a key is cached.
   */
  hasKey(): boolean {
    return this.key !== null;
  }

  /**
   * Get the cached key, resetting the auto-clear timer.
   * Returns null if no key is cached.
   */
  getKey(): Uint8Array | null {
    if (this.key) {
      this.resetTimer();
      return this.key;
    }
    return null;
  }

  /**
   * Set the key in the cache, starting the auto-clear timer.
   */
  setKey(key: Uint8Array): void {
    this.clear();
    this.key = new Uint8Array(key);
    this.resetTimer();
  }

  /**
   * Clear the cached key, zeroing memory and canceling the timer.
   */
  clear(): void {
    if (this.key) {
      this.key.fill(0);
      this.key = null;
    }
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  private resetTimer(): void {
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer);
    }
    this.clearTimer = setTimeout(() => {
      if (this.key) {
        this.key.fill(0);
        this.key = null;
      }
      this.clearTimer = null;
    }, KeyCache.CACHE_DURATION_MS);
  }
}
