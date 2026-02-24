import { describe, it, expect, beforeAll } from 'vitest';
import { EncryptionManager } from '../encryption.js';

describe('EncryptionManager', () => {
  let manager: EncryptionManager;

  beforeAll(async () => {
    manager = new EncryptionManager();
    await manager.init();
  });

  describe('init()', () => {
    it('should initialize without throwing', async () => {
      const em = new EncryptionManager();
      await expect(em.init()).resolves.toBeUndefined();
    });

    it('should throw if operations are called before init', async () => {
      const em = new EncryptionManager();
      await expect(em.generateMasterKey()).rejects.toThrow('not initialized');
    });
  });

  describe('generateMasterKey()', () => {
    it('should generate a 256-bit (32 byte) key', async () => {
      const masterKey = await manager.generateMasterKey();
      const keyBytes = manager.fromBase64(masterKey.keyBytes);
      expect(keyBytes.length).toBe(32);
    });

    it('should produce a 16-character hex key ID', async () => {
      const masterKey = await manager.generateMasterKey();
      expect(masterKey.keyId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should generate different keys on each call', async () => {
      const key1 = await manager.generateMasterKey();
      const key2 = await manager.generateMasterKey();
      expect(key1.keyBytes).not.toBe(key2.keyBytes);
      expect(key1.keyId).not.toBe(key2.keyId);
    });

    it('should set version to 1', async () => {
      const masterKey = await manager.generateMasterKey();
      expect(masterKey.version).toBe(1);
    });

    it('should include a valid ISO 8601 createdAt timestamp', async () => {
      const masterKey = await manager.generateMasterKey();
      const date = new Date(masterKey.createdAt);
      expect(date.getTime()).not.toBeNaN();
    });
  });

  describe('encrypt() / decrypt() roundtrip', () => {
    beforeAll(async () => {
      await manager.generateMasterKey();
    });

    it('should encrypt and decrypt a Uint8Array roundtrip', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = await manager.encrypt(plaintext);

      const ciphertext = manager.fromBase64(result.ciphertext);
      const nonce = manager.fromBase64(result.nonce);
      const decrypted = await manager.decrypt(ciphertext, nonce);

      expect(decrypted).toEqual(plaintext);
    });

    it('should encrypt and decrypt a string roundtrip', async () => {
      const text = 'Hello, encrypted world! This is sensitive data.';
      const result = await manager.encryptString(text);

      const ciphertext = manager.fromBase64(result.ciphertext);
      const nonce = manager.fromBase64(result.nonce);
      const decrypted = await manager.decryptToString(ciphertext, nonce);

      expect(decrypted).toBe(text);
    });

    it('should encrypt and decrypt a large payload', async () => {
      const largeText = 'x'.repeat(100000);
      const result = await manager.encryptString(largeText);

      const ciphertext = manager.fromBase64(result.ciphertext);
      const nonce = manager.fromBase64(result.nonce);
      const decrypted = await manager.decryptToString(ciphertext, nonce);

      expect(decrypted).toBe(largeText);
    });

    it('should encrypt and decrypt JSON data roundtrip', async () => {
      const data = {
        prompt: 'Write a function that sorts an array',
        tool_input: { command: 'ls -la /secret/path' },
        tool_response: 'total 42\n-rw-r--r-- 1 user group 1234 ...',
      };

      const plaintext = JSON.stringify(data);
      const result = await manager.encryptString(plaintext);

      const ciphertext = manager.fromBase64(result.ciphertext);
      const nonce = manager.fromBase64(result.nonce);
      const decrypted = await manager.decryptToString(ciphertext, nonce);

      expect(JSON.parse(decrypted)).toEqual(data);
    });

    it('should report correct plaintext length', async () => {
      const text = 'Hello, world!';
      const plaintext = manager.fromString(text);
      const result = await manager.encrypt(plaintext);
      expect(result.plaintextLength).toBe(plaintext.length);
    });

    it('should set algorithm to xchacha20-poly1305', async () => {
      const result = await manager.encryptString('test');
      expect(result.algorithm).toBe('xchacha20-poly1305');
    });
  });

  describe('nonce uniqueness', () => {
    it('should generate unique nonces for each encryption', async () => {
      await manager.generateMasterKey();
      const nonces = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const result = await manager.encryptString(`message ${i}`);
        nonces.add(result.nonce);
      }

      expect(nonces.size).toBe(100);
    });

    it('should produce different ciphertext for the same plaintext', async () => {
      await manager.generateMasterKey();
      const text = 'Same plaintext every time';

      const result1 = await manager.encryptString(text);
      const result2 = await manager.encryptString(text);

      expect(result1.ciphertext).not.toBe(result2.ciphertext);
      expect(result1.nonce).not.toBe(result2.nonce);
    });
  });

  describe('wrong key decryption', () => {
    it('should throw when decrypting with the wrong key', async () => {
      // Encrypt with key 1
      const em1 = new EncryptionManager();
      await em1.init();
      await em1.generateMasterKey();
      const result = await em1.encryptString('secret message');

      // Try to decrypt with key 2
      const em2 = new EncryptionManager();
      await em2.init();
      await em2.generateMasterKey();

      const ciphertext = em2.fromBase64(result.ciphertext);
      const nonce = em2.fromBase64(result.nonce);

      await expect(em2.decrypt(ciphertext, nonce)).rejects.toThrow();
    });
  });

  describe('deriveKeyFromPassphrase()', () => {
    it('should derive deterministic keys from the same passphrase and salt', async () => {
      const passphrase = 'my-secure-passphrase-2024!';
      const salt = manager.generateSalt();

      const key1 = await manager.deriveKeyFromPassphrase(passphrase, salt);
      const key2 = await manager.deriveKeyFromPassphrase(passphrase, salt);

      expect(key1).toEqual(key2);
    }, 30000);

    it('should derive different keys for different salts', async () => {
      const passphrase = 'my-secure-passphrase-2024!';
      const salt1 = manager.generateSalt();
      const salt2 = manager.generateSalt();

      const key1 = await manager.deriveKeyFromPassphrase(passphrase, salt1);
      const key2 = await manager.deriveKeyFromPassphrase(passphrase, salt2);

      expect(manager.toBase64(key1)).not.toBe(manager.toBase64(key2));
    }, 30000);

    it('should derive different keys for different passphrases', async () => {
      const salt = manager.generateSalt();

      const key1 = await manager.deriveKeyFromPassphrase('passphrase-one', salt);
      const key2 = await manager.deriveKeyFromPassphrase('passphrase-two', salt);

      expect(manager.toBase64(key1)).not.toBe(manager.toBase64(key2));
    }, 30000);

    it('should produce a 32-byte key', async () => {
      const salt = manager.generateSalt();
      const key = await manager.deriveKeyFromPassphrase('test-passphrase', salt);
      expect(key.length).toBe(32);
    }, 30000);

    it('should throw on invalid salt length', async () => {
      const badSalt = new Uint8Array(8); // Wrong length
      await expect(
        manager.deriveKeyFromPassphrase('passphrase', badSalt)
      ).rejects.toThrow('Invalid salt length');
    });
  });

  describe('encrypt with explicit key', () => {
    it('should encrypt/decrypt with an externally provided key', async () => {
      const em = new EncryptionManager();
      await em.init();

      // Generate a key manually
      const masterKey = await em.generateMasterKey();
      const key = em.fromBase64(masterKey.keyBytes);

      // Encrypt with the explicit key
      const plaintext = em.fromString('data with explicit key');
      const result = await em.encrypt(plaintext, key);

      // Decrypt with the same explicit key
      const ciphertext = em.fromBase64(result.ciphertext);
      const nonce = em.fromBase64(result.nonce);
      const decrypted = await em.decrypt(ciphertext, nonce, key);

      expect(em.toString(decrypted)).toBe('data with explicit key');
    });
  });

  describe('error cases', () => {
    it('should throw when encrypting without a key set', async () => {
      const em = new EncryptionManager();
      await em.init();
      // No key generated or set
      const plaintext = em.fromString('test');
      await expect(em.encrypt(plaintext)).rejects.toThrow('No encryption key');
    });

    it('should throw when setting a key with invalid length', async () => {
      const em = new EncryptionManager();
      await em.init();
      expect(() => em.setMasterKey(new Uint8Array(16))).toThrow('Invalid key length');
    });

    it('should throw when getting key ID without a key', async () => {
      const em = new EncryptionManager();
      await em.init();
      expect(() => em.getKeyId()).toThrow('No master key set');
    });
  });
});
