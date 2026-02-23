/**
 * Key Storage Bridge.
 *
 * TypeScript interface for platform key storage that calls the
 * Rust backend via IPC. Handles encoding/decoding, validation,
 * and error wrapping.
 *
 * @module key-storage-bridge
 */

import type { InvokeFunction } from "./ipc-bridge.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum key size in bytes (2048 bytes as per platform limits). */
export const KEY_SIZE_LIMIT = 2048;

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

/** Error from key storage operations. */
export class KeyStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStorageError";
  }
}

// ---------------------------------------------------------------------------
// Base64 Encoding/Decoding
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key Storage Bridge
// ---------------------------------------------------------------------------

/**
 * Bridge for platform key storage operations.
 * All operations go through Tauri's invoke() to the Rust backend.
 */
export class KeyStorageBridge {
  private invoke: InvokeFunction;

  constructor(invoke: InvokeFunction) {
    this.invoke = invoke;
  }

  /**
   * Store a key in the platform credential manager.
   *
   * @param keyId - Unique identifier for the key.
   * @param keyBytes - Raw key bytes to store.
   * @throws KeyStorageError if validation fails or IPC errors.
   */
  async storeKey(keyId: string, keyBytes: Uint8Array): Promise<void> {
    this.validateKeyId(keyId);

    if (keyBytes.length === 0) {
      throw new KeyStorageError("Key bytes must not be empty");
    }

    if (keyBytes.length > KEY_SIZE_LIMIT) {
      throw new KeyStorageError(
        `Key size ${keyBytes.length} exceeds maximum of ${KEY_SIZE_LIMIT} bytes`
      );
    }

    const keyBase64 = uint8ArrayToBase64(keyBytes);

    try {
      await this.invoke("store_key", { keyId, keyBase64 });
    } catch (error: unknown) {
      throw new KeyStorageError(
        `Failed to store key: ${sanitizeErrorMessage(error)}`
      );
    }
  }

  /**
   * Retrieve a key from the platform credential manager.
   *
   * @param keyId - Unique identifier for the key.
   * @returns The raw key bytes.
   * @throws KeyStorageError if key not found or IPC errors.
   */
  async retrieveKey(keyId: string): Promise<Uint8Array> {
    this.validateKeyId(keyId);

    try {
      const base64 = (await this.invoke("retrieve_key", {
        keyId,
      })) as string;
      return base64ToUint8Array(base64);
    } catch (error: unknown) {
      throw new KeyStorageError(
        `Failed to retrieve key: ${sanitizeErrorMessage(error)}`
      );
    }
  }

  /**
   * Delete a key from the platform credential manager.
   * Idempotent: does not throw if the key doesn't exist.
   *
   * @param keyId - Unique identifier for the key.
   */
  async deleteKey(keyId: string): Promise<void> {
    this.validateKeyId(keyId);

    try {
      await this.invoke("delete_key", { keyId });
    } catch (error: unknown) {
      throw new KeyStorageError(
        `Failed to delete key: ${sanitizeErrorMessage(error)}`
      );
    }
  }

  /**
   * Check if a key exists without retrieving it.
   *
   * @param keyId - Unique identifier for the key.
   * @returns true if the key exists.
   */
  async hasKey(keyId: string): Promise<boolean> {
    this.validateKeyId(keyId);

    try {
      return (await this.invoke("has_key", { keyId })) as boolean;
    } catch (error: unknown) {
      throw new KeyStorageError(
        `Failed to check key: ${sanitizeErrorMessage(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validateKeyId(keyId: string): void {
    if (!keyId || keyId.trim().length === 0) {
      throw new KeyStorageError("Key ID must not be empty");
    }
  }
}

// ---------------------------------------------------------------------------
// Error Sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitizes error messages to ensure key material is never leaked.
 * Removes anything that looks like base64-encoded data.
 */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential base64 data (sequences of 4+ base64 chars)
  return message.replace(/[A-Za-z0-9+/]{8,}={0,2}/g, "[REDACTED]");
}
