import type { MasterKey, EncryptionResult } from '@saqr/shared';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Use CJS require because the ESM variant of libsodium-wrappers-sumo
// has a broken import path for libsodium-sumo.mjs under pnpm's strict layout.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers-sumo') as typeof import('libsodium-wrappers-sumo');

/**
 * EncryptionManager handles all client-side cryptographic operations.
 *
 * Uses XChaCha20-Poly1305 via libsodium for event encryption.
 * Uses Argon2id for key derivation from passphrase.
 */
export class EncryptionManager {
  private _masterKey: Uint8Array | null = null;
  private _keyId: string | null = null;
  private _initialized = false;

  /** Initialize libsodium WASM runtime */
  async init(): Promise<void> {
    await sodium.ready;
    this._initialized = true;
  }

  /** Check if sodium is initialized, throw if not */
  private ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error('EncryptionManager not initialized. Call init() first.');
    }
  }

  /** Set the master key for encrypt/decrypt operations */
  setMasterKey(keyBytes: Uint8Array): void {
    this.ensureInitialized();
    if (keyBytes.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
      throw new Error(
        `Invalid key length: expected ${sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES}, got ${keyBytes.length}`
      );
    }
    this._masterKey = keyBytes;
    this._keyId = this.computeKeyId(keyBytes);
  }

  /** Get the current key ID */
  getKeyId(): string {
    if (!this._keyId) {
      throw new Error('No master key set. Call setMasterKey() or generateMasterKey() first.');
    }
    return this._keyId;
  }

  /** Compute key ID: first 8 bytes of BLAKE2b-256 hash, hex-encoded (16 hex chars) */
  private computeKeyId(key: Uint8Array): string {
    const hash = sodium.crypto_generichash(32, key, null);
    return sodium.to_hex(hash.slice(0, 8));
  }

  /** Generate a new 256-bit master key */
  async generateMasterKey(): Promise<MasterKey> {
    this.ensureInitialized();
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const keyId = this.computeKeyId(key);

    this._masterKey = key;
    this._keyId = keyId;

    return {
      keyBytes: sodium.to_base64(key),
      keyId,
      createdAt: new Date().toISOString(),
      version: 1,
    };
  }

  /** Derive a key from passphrase using Argon2id */
  async deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    this.ensureInitialized();
    if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
      throw new Error(
        `Invalid salt length: expected ${sodium.crypto_pwhash_SALTBYTES}, got ${salt.length}`
      );
    }

    const key = sodium.crypto_pwhash(
      32, // key length
      passphrase,
      salt,
      3, // opslimit (MODERATE)
      67108864, // memlimit (64MB)
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    return key;
  }

  /** Generate a random salt for key derivation */
  generateSalt(): Uint8Array {
    this.ensureInitialized();
    return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  }

  /** Encrypt a payload with XChaCha20-Poly1305 */
  async encrypt(plaintext: Uint8Array, key?: Uint8Array): Promise<EncryptionResult> {
    this.ensureInitialized();
    const encKey = key ?? this._masterKey;
    if (!encKey) {
      throw new Error('No encryption key available. Call setMasterKey() or generateMasterKey() first.');
    }

    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    );

    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null, // no additional data
      null, // nsec (unused)
      nonce,
      encKey
    );

    const keyId = key ? this.computeKeyId(key) : this._keyId!;

    return {
      ciphertext: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce),
      keyId,
      algorithm: 'xchacha20-poly1305',
      plaintextLength: plaintext.length,
    };
  }

  /** Decrypt a payload with XChaCha20-Poly1305 */
  async decrypt(ciphertext: Uint8Array, nonce: Uint8Array, key?: Uint8Array): Promise<Uint8Array> {
    this.ensureInitialized();
    const decKey = key ?? this._masterKey;
    if (!decKey) {
      throw new Error('No decryption key available. Call setMasterKey() or generateMasterKey() first.');
    }

    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // nsec (unused)
      ciphertext,
      null, // no additional data
      nonce,
      decKey
    );

    return plaintext;
  }

  /** Encrypt a string payload (convenience) */
  async encryptString(text: string, key?: Uint8Array): Promise<EncryptionResult> {
    this.ensureInitialized();
    const plaintext = sodium.from_string(text);
    return this.encrypt(plaintext, key);
  }

  /** Decrypt to a string (convenience) */
  async decryptToString(ciphertext: Uint8Array, nonce: Uint8Array, key?: Uint8Array): Promise<string> {
    const plaintext = await this.decrypt(ciphertext, nonce, key);
    return sodium.to_string(plaintext);
  }

  /** Get the raw master key bytes (for storage/export) */
  getMasterKeyBytes(): Uint8Array {
    if (!this._masterKey) {
      throw new Error('No master key set.');
    }
    return this._masterKey;
  }

  /** Convert base64 string to Uint8Array */
  fromBase64(base64: string): Uint8Array {
    this.ensureInitialized();
    return sodium.from_base64(base64);
  }

  /** Convert Uint8Array to base64 string */
  toBase64(data: Uint8Array): string {
    this.ensureInitialized();
    return sodium.to_base64(data);
  }

  /** Convert string to Uint8Array */
  fromString(text: string): Uint8Array {
    this.ensureInitialized();
    return sodium.from_string(text);
  }

  /** Convert Uint8Array to string */
  toString(data: Uint8Array): string {
    this.ensureInitialized();
    return sodium.to_string(data);
  }
}
