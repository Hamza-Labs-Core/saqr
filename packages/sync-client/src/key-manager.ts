import * as fs from 'node:fs';
import * as path from 'node:path';
import { EncryptionManager } from './encryption.js';
import type { MasterKey } from '@saqr/shared';

/**
 * Recovery blob format stored at ~/.saqr/keys/recovery.enc
 */
export interface RecoveryBlob {
  version: number;
  kdf: 'argon2id';
  kdf_ops: number;
  kdf_mem: number;
  salt: string; // base64
  nonce: string; // base64
  encrypted_key: string; // base64
}

/**
 * Key metadata stored alongside the master key
 */
export interface KeyMetadata {
  keyId: string;
  algorithm: 'xchacha20-poly1305';
  kdf: 'none' | 'argon2id';
  createdAt: string;
  machineId: string;
}

/**
 * KeyManager handles secure generation, storage, export, and import
 * of encryption keys for the sync client.
 *
 * Keys are stored at ~/.saqr/keys/ with restrictive file permissions (0600).
 */
export class KeyManager {
  private encryption: EncryptionManager;
  private keysDir: string;

  /**
   * Create a new KeyManager.
   *
   * @param encryption - An initialized EncryptionManager instance
   * @param keysDir - Directory to store keys (e.g., ~/.saqr/keys/)
   */
  constructor(encryption: EncryptionManager, keysDir: string) {
    this.encryption = encryption;
    this.keysDir = keysDir;
  }

  /**
   * Generate a new master key and store it securely.
   *
   * @param machineId - The machine identifier for key metadata
   * @returns The generated MasterKey
   */
  async generateAndStore(machineId: string): Promise<MasterKey> {
    const masterKey = await this.encryption.generateMasterKey();

    // Ensure keys directory exists with restrictive permissions
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });

    // Store the raw key (base64-encoded)
    const keyPath = path.join(this.keysDir, 'master.key');
    fs.writeFileSync(keyPath, masterKey.keyBytes, { mode: 0o600 });

    // Store key metadata
    const metadata: KeyMetadata = {
      keyId: masterKey.keyId,
      algorithm: 'xchacha20-poly1305',
      kdf: 'none',
      createdAt: masterKey.createdAt,
      machineId,
    };

    const metadataPath = path.join(this.keysDir, 'key.json');
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      { mode: 0o600 }
    );

    return masterKey;
  }

  /**
   * Load the master key from storage.
   *
   * @returns The loaded MasterKey, or null if no key exists
   */
  async loadKey(): Promise<MasterKey | null> {
    const keyPath = path.join(this.keysDir, 'master.key');
    const metadataPath = path.join(this.keysDir, 'key.json');

    if (!fs.existsSync(keyPath)) {
      return null;
    }

    try {
      const keyBase64 = fs.readFileSync(keyPath, 'utf8').trim();
      const keyBytes = this.encryption.fromBase64(keyBase64);

      // Set the key on the encryption manager
      this.encryption.setMasterKey(keyBytes);

      let metadata: KeyMetadata | null = null;
      if (fs.existsSync(metadataPath)) {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      }

      return {
        keyBytes: keyBase64,
        keyId: metadata?.keyId ?? this.encryption.getKeyId(),
        createdAt: metadata?.createdAt ?? new Date().toISOString(),
        version: 1,
      };
    } catch {
      return null;
    }
  }

  /**
   * Export the master key encrypted with a passphrase-derived key for backup.
   *
   * The recovery blob can be stored on the server or transferred to another
   * device. It is useless without the passphrase.
   *
   * @param passphrase - The user's passphrase
   * @returns The recovery blob
   */
  async exportForBackup(passphrase: string): Promise<RecoveryBlob> {
    const masterKeyBytes = this.encryption.getMasterKeyBytes();
    const salt = this.encryption.generateSalt();
    const derivedKey = await this.encryption.deriveKeyFromPassphrase(passphrase, salt);

    // Encrypt the master key with the passphrase-derived key
    const result = await this.encryption.encrypt(masterKeyBytes, derivedKey);

    const blob: RecoveryBlob = {
      version: 1,
      kdf: 'argon2id',
      kdf_ops: 3,
      kdf_mem: 67108864,
      salt: this.encryption.toBase64(salt),
      nonce: result.nonce,
      encrypted_key: result.ciphertext,
    };

    // Store recovery blob to disk
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    const recoveryPath = path.join(this.keysDir, 'recovery.enc');
    fs.writeFileSync(
      recoveryPath,
      JSON.stringify(blob, null, 2),
      { mode: 0o600 }
    );

    return blob;
  }

  /**
   * Import (recover) the master key from a backup using the passphrase.
   *
   * @param encryptedBlob - The recovery blob (or will load from disk if not provided)
   * @param passphrase - The user's passphrase
   * @returns The recovered MasterKey
   * @throws Error if the passphrase is wrong
   */
  async importFromBackup(encryptedBlob: RecoveryBlob, passphrase: string): Promise<MasterKey> {
    const salt = this.encryption.fromBase64(encryptedBlob.salt);
    const derivedKey = await this.encryption.deriveKeyFromPassphrase(passphrase, salt);

    const ciphertext = this.encryption.fromBase64(encryptedBlob.encrypted_key);
    const nonce = this.encryption.fromBase64(encryptedBlob.nonce);

    // This will throw if the passphrase is wrong
    const masterKeyBytes = await this.encryption.decrypt(ciphertext, nonce, derivedKey);

    // Set and store the recovered key
    this.encryption.setMasterKey(masterKeyBytes);
    const keyId = this.encryption.getKeyId();
    const keyBase64 = this.encryption.toBase64(masterKeyBytes);

    // Store the recovered key
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });

    const keyPath = path.join(this.keysDir, 'master.key');
    fs.writeFileSync(keyPath, keyBase64, { mode: 0o600 });

    const metadata: KeyMetadata = {
      keyId,
      algorithm: 'xchacha20-poly1305',
      kdf: 'argon2id',
      createdAt: new Date().toISOString(),
      machineId: 'recovered',
    };

    const metadataPath = path.join(this.keysDir, 'key.json');
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      { mode: 0o600 }
    );

    return {
      keyBytes: keyBase64,
      keyId,
      createdAt: metadata.createdAt,
      version: 1,
    };
  }

  /**
   * Check if a master key exists in storage.
   */
  hasKey(): boolean {
    return fs.existsSync(path.join(this.keysDir, 'master.key'));
  }

  /**
   * Load the recovery blob from disk.
   */
  loadRecoveryBlob(): RecoveryBlob | null {
    const recoveryPath = path.join(this.keysDir, 'recovery.enc');
    if (!fs.existsSync(recoveryPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(recoveryPath, 'utf8');
      return JSON.parse(content) as RecoveryBlob;
    } catch {
      return null;
    }
  }
}
