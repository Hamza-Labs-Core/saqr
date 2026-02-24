import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { KeyManager } from '../key-manager.js';
import { EncryptionManager } from '../encryption.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('KeyManager', () => {
  let encryption: EncryptionManager;
  let keyManager: KeyManager;
  let tmpDir: string;

  beforeAll(async () => {
    encryption = new EncryptionManager();
    await encryption.init();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-keys-test-'));
    // Create a fresh EncryptionManager for each test so key state is clean
    encryption = new EncryptionManager();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generateAndStore()', () => {
    it('should generate a master key and store it to disk', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      const masterKey = await keyManager.generateAndStore('test-machine');

      // Key file should exist
      const keyPath = path.join(tmpDir, 'master.key');
      expect(fs.existsSync(keyPath)).toBe(true);

      // Key metadata should exist
      const metadataPath = path.join(tmpDir, 'key.json');
      expect(fs.existsSync(metadataPath)).toBe(true);

      // Verify key properties
      expect(masterKey.keyBytes).toBeTruthy();
      expect(masterKey.keyId).toMatch(/^[0-9a-f]{16}$/);
      expect(masterKey.version).toBe(1);
    });

    it('should store key metadata with correct fields', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      const masterKey = await keyManager.generateAndStore('my-macbook');

      const metadataPath = path.join(tmpDir, 'key.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

      expect(metadata.keyId).toBe(masterKey.keyId);
      expect(metadata.algorithm).toBe('xchacha20-poly1305');
      expect(metadata.kdf).toBe('none');
      expect(metadata.machineId).toBe('my-macbook');
      expect(metadata.createdAt).toBeTruthy();
    });

    it('should create keys directory if it does not exist', async () => {
      await encryption.init();
      const nestedDir = path.join(tmpDir, 'nested', 'keys');
      keyManager = new KeyManager(encryption, nestedDir);

      await keyManager.generateAndStore('test-machine');

      expect(fs.existsSync(nestedDir)).toBe(true);
    });
  });

  describe('loadKey()', () => {
    it('should load a previously stored key', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      const original = await keyManager.generateAndStore('test-machine');

      // Create a fresh encryption manager to simulate restart
      const freshEncryption = new EncryptionManager();
      await freshEncryption.init();
      const freshKeyManager = new KeyManager(freshEncryption, tmpDir);

      const loaded = await freshKeyManager.loadKey();

      expect(loaded).not.toBeNull();
      expect(loaded!.keyBytes).toBe(original.keyBytes);
      expect(loaded!.keyId).toBe(original.keyId);
    });

    it('should return null when no key exists', async () => {
      await encryption.init();
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-empty-keys-'));
      keyManager = new KeyManager(encryption, emptyDir);

      const result = await keyManager.loadKey();
      expect(result).toBeNull();

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('should set the key on the encryption manager', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      await keyManager.generateAndStore('test-machine');

      const freshEncryption = new EncryptionManager();
      await freshEncryption.init();
      const freshKeyManager = new KeyManager(freshEncryption, tmpDir);

      await freshKeyManager.loadKey();

      // The encryption manager should now be able to encrypt/decrypt
      const result = await freshEncryption.encryptString('test data');
      const ciphertext = freshEncryption.fromBase64(result.ciphertext);
      const nonce = freshEncryption.fromBase64(result.nonce);
      const decrypted = await freshEncryption.decryptToString(ciphertext, nonce);

      expect(decrypted).toBe('test data');
    });
  });

  describe('hasKey()', () => {
    it('should return false when no key exists', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);
      expect(keyManager.hasKey()).toBe(false);
    });

    it('should return true after generating a key', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);
      await keyManager.generateAndStore('test-machine');
      expect(keyManager.hasKey()).toBe(true);
    });
  });

  describe('exportForBackup() / importFromBackup()', () => {
    it('should export and import a key with passphrase', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      const original = await keyManager.generateAndStore('test-machine');
      const passphrase = 'my-strong-passphrase-2024!';

      // Export
      const blob = await keyManager.exportForBackup(passphrase);

      expect(blob.version).toBe(1);
      expect(blob.kdf).toBe('argon2id');
      expect(blob.kdf_ops).toBe(3);
      expect(blob.kdf_mem).toBe(67108864);
      expect(blob.salt).toBeTruthy();
      expect(blob.nonce).toBeTruthy();
      expect(blob.encrypted_key).toBeTruthy();

      // Simulate importing on a new machine
      const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-import-'));
      const importEncryption = new EncryptionManager();
      await importEncryption.init();
      const importKeyManager = new KeyManager(importEncryption, importDir);

      const imported = await importKeyManager.importFromBackup(blob, passphrase);

      expect(imported.keyBytes).toBe(original.keyBytes);
      expect(imported.keyId).toBe(original.keyId);

      fs.rmSync(importDir, { recursive: true, force: true });
    }, 60000); // Argon2id is slow

    it('should fail import with wrong passphrase', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      await keyManager.generateAndStore('test-machine');
      const blob = await keyManager.exportForBackup('correct-passphrase');

      const importEncryption = new EncryptionManager();
      await importEncryption.init();
      const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-bad-import-'));
      const importKeyManager = new KeyManager(importEncryption, importDir);

      await expect(
        importKeyManager.importFromBackup(blob, 'wrong-passphrase')
      ).rejects.toThrow();

      fs.rmSync(importDir, { recursive: true, force: true });
    }, 60000);

    it('should store recovery blob to disk', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      await keyManager.generateAndStore('test-machine');
      await keyManager.exportForBackup('my-passphrase');

      const recoveryPath = path.join(tmpDir, 'recovery.enc');
      expect(fs.existsSync(recoveryPath)).toBe(true);

      const blob = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
      expect(blob.version).toBe(1);
      expect(blob.kdf).toBe('argon2id');
    }, 60000);

    it('should allow loadRecoveryBlob()', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      await keyManager.generateAndStore('test-machine');
      const exported = await keyManager.exportForBackup('passphrase');

      const loaded = keyManager.loadRecoveryBlob();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(exported.version);
      expect(loaded!.salt).toBe(exported.salt);
    }, 60000);

    it('should return null when no recovery blob exists', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);
      expect(keyManager.loadRecoveryBlob()).toBeNull();
    });

    it('should store the imported key to disk', async () => {
      await encryption.init();
      keyManager = new KeyManager(encryption, tmpDir);

      await keyManager.generateAndStore('test-machine');
      const blob = await keyManager.exportForBackup('pass');

      const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-import2-'));
      const importEncryption = new EncryptionManager();
      await importEncryption.init();
      const importKeyManager = new KeyManager(importEncryption, importDir);

      await importKeyManager.importFromBackup(blob, 'pass');

      // Verify the key was stored
      expect(importKeyManager.hasKey()).toBe(true);

      // Verify we can load it
      const freshEncryption = new EncryptionManager();
      await freshEncryption.init();
      const freshKm = new KeyManager(freshEncryption, importDir);
      const loaded = await freshKm.loadKey();
      expect(loaded).not.toBeNull();

      fs.rmSync(importDir, { recursive: true, force: true });
    }, 60000);
  });
});
