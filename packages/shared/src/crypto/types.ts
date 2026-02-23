/**
 * Cryptographic Types for the Saqr Agent Management Platform.
 *
 * Defines the types used by the client-side encryption layer.
 * Saqr uses XChaCha20-Poly1305 (via libsodium) for authenticated
 * encryption and Argon2id for key derivation from user passphrases.
 *
 * The encryption design follows zero-knowledge principles:
 * - The master key is generated locally and never leaves the device.
 * - The sync server only stores encrypted blobs; it cannot decrypt anything.
 * - Cross-device key transfer uses ephemeral E2EE channels (QR code pairing).
 * - Account deletion triggers crypto-shredding (key destruction).
 *
 * @module crypto/types
 */

// ---------------------------------------------------------------------------
// Key Types
// ---------------------------------------------------------------------------

/**
 * A user's master encryption key, generated locally on first setup.
 *
 * The master key is stored in the OS keychain (macOS Keychain,
 * Windows DPAPI, Linux Secret Service) and is used to derive
 * per-purpose keys for event encryption, metadata signing, etc.
 */
export interface MasterKey {
  /** The raw key bytes, base64-encoded. 32 bytes (256-bit). */
  keyBytes: string;

  /**
   * Unique identifier for this key.
   * Used in {@link EncryptedBlob.key_id} to identify which key was used.
   */
  keyId: string;

  /** ISO 8601 UTC timestamp when this key was generated. */
  createdAt: string;

  /**
   * Key version number. Incremented on key rotation.
   * The daemon keeps old keys for decrypting historical data.
   */
  version: number;
}

/**
 * A derived key produced from the master key for a specific purpose.
 *
 * Key derivation uses HKDF (HMAC-based Key Derivation Function)
 * with a purpose-specific context string to produce independent
 * sub-keys from the master key.
 */
export interface DerivedKey {
  /** The raw derived key bytes, base64-encoded. */
  keyBytes: string;

  /** The purpose this key was derived for. */
  purpose: KeyPurpose;

  /** The master key ID this was derived from. */
  masterKeyId: string;
}

/**
 * Purposes for which derived keys can be created.
 *
 * - `"event-encryption"` - Encrypting event data blobs for sync.
 * - `"metadata-signing"` - Signing cleartext metadata for integrity.
 * - `"session-key"` - Per-session encryption for ephemeral channels.
 */
export type KeyPurpose =
  | "event-encryption"
  | "metadata-signing"
  | "session-key";

/**
 * Array of all valid key purposes.
 */
export const KEY_PURPOSES: readonly KeyPurpose[] = [
  "event-encryption",
  "metadata-signing",
  "session-key",
] as const;

// ---------------------------------------------------------------------------
// Encryption Results
// ---------------------------------------------------------------------------

/**
 * Result of encrypting a plaintext payload.
 *
 * Contains everything needed to decrypt the data later:
 * ciphertext, nonce, and key identifier. The algorithm is always
 * XChaCha20-Poly1305 (AEAD with 192-bit nonce).
 */
export interface EncryptionResult {
  /** Base64-encoded ciphertext. */
  ciphertext: string;

  /**
   * Base64-encoded nonce (192-bit / 24 bytes for XChaCha20).
   * Must be unique per encryption operation; typically random.
   */
  nonce: string;

  /**
   * Identifier of the key used for encryption.
   * Allows the decryptor to select the correct key.
   */
  keyId: string;

  /**
   * Encryption algorithm identifier.
   * Currently always `"xchacha20-poly1305"`.
   */
  algorithm: "xchacha20-poly1305";

  /** Length of the original plaintext in bytes, for validation. */
  plaintextLength: number;
}

// ---------------------------------------------------------------------------
// Key Derivation Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for deriving a master key from a user passphrase using Argon2id.
 *
 * Argon2id is a memory-hard key derivation function that resists both
 * GPU-based brute force attacks and side-channel attacks. It is used
 * for cross-device key recovery: the user enters their passphrase on
 * a new device to regenerate the master key.
 */
export interface KeyDerivationParams {
  /**
   * Argon2id memory cost in KiB.
   * Higher values increase resistance to GPU attacks.
   * @default 65536 (64 MiB)
   */
  memoryCost: number;

  /**
   * Argon2id time cost (number of iterations).
   * Higher values increase computation time.
   * @default 3
   */
  timeCost: number;

  /**
   * Argon2id parallelism (number of threads).
   * Should match or be less than available CPU cores.
   * @default 4
   */
  parallelism: number;

  /**
   * Base64-encoded salt (16 bytes / 128 bits).
   * Must be unique per user; typically random, stored alongside the encrypted data.
   */
  salt: string;

  /**
   * Desired output key length in bytes.
   * @default 32 (256-bit key)
   */
  keyLength: number;
}

/**
 * Default key derivation parameters following OWASP recommendations.
 */
export const DEFAULT_KEY_DERIVATION_PARAMS: Omit<KeyDerivationParams, "salt"> = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  keyLength: 32,
};
