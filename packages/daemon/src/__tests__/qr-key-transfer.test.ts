/**
 * Tests for QRKeyTransfer — cross-device key exchange protocol.
 *
 * Tests use a mock CryptoProvider to avoid libsodium dependency,
 * and integration tests use the DefaultCryptoProvider with real Node.js crypto.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  QRKeyTransfer,
  DefaultCryptoProvider,
  generateQRPayload,
  completeKeyTransfer,
} from "../security/qr-key-transfer.js";
import type {
  CryptoProvider,
  EphemeralKeypair,
  QRPayload,
} from "../security/qr-key-transfer.js";

// ---------------------------------------------------------------------------
// Mock CryptoProvider for unit tests
// ---------------------------------------------------------------------------

class MockCryptoProvider implements CryptoProvider {
  private callCount = 0;

  async generateKeypair(): Promise<EphemeralKeypair> {
    this.callCount++;
    return {
      publicKey: Buffer.from(`public-key-${this.callCount}`).toString("base64"),
      secretKey: Buffer.from(`secret-key-${this.callCount}`).toString("base64"),
    };
  }

  async computeSharedSecret(
    secretKey: string,
    publicKey: string,
  ): Promise<string> {
    // Deterministic shared secret based on both keys
    const combined = `${secretKey}:${publicKey}`;
    return Buffer.from(combined).toString("base64");
  }

  async encrypt(
    plaintext: string,
    key: string,
  ): Promise<{ ciphertext: string; nonce: string }> {
    // Simple "encryption" for testing: base64 encode with key prefix
    const nonce = Buffer.from("test-nonce-12345").toString("base64");
    const ciphertext = Buffer.from(
      `encrypted:${plaintext}:${key}`,
    ).toString("base64");
    return { ciphertext, nonce };
  }

  async decrypt(
    ciphertext: string,
    _nonce: string,
    key: string,
  ): Promise<string> {
    // Reverse the mock encryption
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    const parts = decoded.split(":");
    if (parts[0] !== "encrypted") {
      throw new Error("Decryption failed");
    }
    // Verify the key matches
    if (parts[2] !== key) {
      throw new Error("Wrong key");
    }
    return parts[1]!;
  }
}

// ---------------------------------------------------------------------------
// QRKeyTransfer Tests (with mock crypto)
// ---------------------------------------------------------------------------

describe("QRKeyTransfer", () => {
  let crypto: MockCryptoProvider;

  beforeEach(() => {
    crypto = new MockCryptoProvider();
  });

  describe("generateQRPayload", () => {
    it("should generate a QR payload with public key", async () => {
      const transfer = new QRKeyTransfer({}, crypto);
      const payload = await transfer.generateQRPayload();

      expect(payload.version).toBe(1);
      expect(payload.publicKey).toBeTruthy();
      expect(payload.sessionId).toBeTruthy();
      expect(payload.sessionId.length).toBe(32); // hex encoded 16 bytes
      expect(payload.createdAt).toBeTruthy();
      expect(payload.expiresIn).toBeGreaterThan(0);
    });

    it("should include connection info", async () => {
      const transfer = new QRKeyTransfer(
        {
          connectionInfo: {
            host: "192.168.1.100",
            port: 8080,
            protocol: "ws",
          },
        },
        crypto,
      );

      const payload = await transfer.generateQRPayload();

      expect(payload.connectionInfo.host).toBe("192.168.1.100");
      expect(payload.connectionInfo.port).toBe(8080);
      expect(payload.connectionInfo.protocol).toBe("ws");
    });

    it("should use default connection info", async () => {
      const transfer = new QRKeyTransfer({}, crypto);
      const payload = await transfer.generateQRPayload();

      expect(payload.connectionInfo.host).toBe("127.0.0.1");
      expect(payload.connectionInfo.port).toBe(3100);
      expect(payload.connectionInfo.protocol).toBe("ws");
    });

    it("should set custom expiry", async () => {
      const transfer = new QRKeyTransfer(
        { expirySeconds: 120 },
        crypto,
      );
      const payload = await transfer.generateQRPayload();

      expect(payload.expiresIn).toBe(120);
    });

    it("should store session ID", async () => {
      const transfer = new QRKeyTransfer({}, crypto);

      expect(transfer.getSessionId()).toBeNull();

      const payload = await transfer.generateQRPayload();
      expect(transfer.getSessionId()).toBe(payload.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // Full key transfer flow (mock crypto)
  // -------------------------------------------------------------------------

  describe("key transfer flow (mock)", () => {
    it("should complete a full key transfer", async () => {
      const initiator = new QRKeyTransfer({}, crypto);
      const scanner = new QRKeyTransfer({}, crypto);

      // Step 1: Initiator generates QR payload
      const qrPayload = await initiator.generateQRPayload();

      // Step 2: Scanner prepares key transfer message
      const masterKey = Buffer.from("master-key-data").toString("base64");
      const message = await scanner.prepareKeyTransfer(qrPayload, masterKey);

      expect(message.senderPublicKey).toBeTruthy();
      expect(message.encryptedKey).toBeTruthy();
      expect(message.nonce).toBeTruthy();
      expect(message.sessionId).toBe(qrPayload.sessionId);
    });

    it("should reject expired QR payloads", async () => {
      const scanner = new QRKeyTransfer({}, crypto);

      const expiredPayload: QRPayload = {
        version: 1,
        publicKey: Buffer.from("pub").toString("base64"),
        sessionId: "test-session",
        connectionInfo: { host: "127.0.0.1", port: 3100, protocol: "ws" },
        createdAt: new Date(Date.now() - 600000).toISOString(), // 10 min ago
        expiresIn: 300, // 5 min TTL
      };

      const masterKey = Buffer.from("key").toString("base64");

      await expect(
        scanner.prepareKeyTransfer(expiredPayload, masterKey),
      ).rejects.toThrow("expired");
    });

    it("should reject session ID mismatch on complete", async () => {
      const transfer = new QRKeyTransfer({}, crypto);
      await transfer.generateQRPayload();

      const wrongMessage = {
        senderPublicKey: "pub",
        encryptedKey: "enc",
        nonce: "nonce",
        sessionId: "wrong-session-id",
      };

      await expect(
        transfer.completeKeyTransfer(wrongMessage),
      ).rejects.toThrow("Session ID mismatch");
    });

    it("should throw if completeKeyTransfer called without QR generation", async () => {
      const transfer = new QRKeyTransfer({}, crypto);

      await expect(
        transfer.completeKeyTransfer({
          senderPublicKey: "pub",
          encryptedKey: "enc",
          nonce: "nonce",
          sessionId: "test",
        }),
      ).rejects.toThrow("No keypair generated");
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests with real Node.js crypto
// ---------------------------------------------------------------------------

describe("QRKeyTransfer (integration with DefaultCryptoProvider)", () => {
  it("should complete end-to-end key transfer with real crypto", async () => {
    const cryptoProvider = new DefaultCryptoProvider();

    // Initiator side
    const initiator = new QRKeyTransfer({}, cryptoProvider);
    const qrPayload = await initiator.generateQRPayload();

    // Scanner side
    const scanner = new QRKeyTransfer({}, cryptoProvider);
    const masterKeyBytes = Buffer.from("this-is-a-32-byte-master-key!!").toString("base64");
    const message = await scanner.prepareKeyTransfer(qrPayload, masterKeyBytes);

    // Back to initiator - complete the transfer
    const result = await initiator.completeKeyTransfer(message);

    expect(result.success).toBe(true);
    expect(result.masterKeyBytes).toBe(masterKeyBytes);
  });

  it("should generate different keypairs each time", async () => {
    const cryptoProvider = new DefaultCryptoProvider();

    const kp1 = await cryptoProvider.generateKeypair();
    const kp2 = await cryptoProvider.generateKeypair();

    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });

  it("should compute consistent shared secrets", async () => {
    const cryptoProvider = new DefaultCryptoProvider();

    const alice = await cryptoProvider.generateKeypair();
    const bob = await cryptoProvider.generateKeypair();

    const secret1 = await cryptoProvider.computeSharedSecret(
      alice.secretKey,
      bob.publicKey,
    );
    const secret2 = await cryptoProvider.computeSharedSecret(
      bob.secretKey,
      alice.publicKey,
    );

    // X25519 key agreement should produce the same shared secret
    expect(secret1).toBe(secret2);
  });

  it("should encrypt and decrypt with shared secret", async () => {
    const cryptoProvider = new DefaultCryptoProvider();

    const alice = await cryptoProvider.generateKeypair();
    const bob = await cryptoProvider.generateKeypair();

    const sharedSecret = await cryptoProvider.computeSharedSecret(
      alice.secretKey,
      bob.publicKey,
    );

    const plaintext = Buffer.from("hello world").toString("base64");
    const { ciphertext, nonce } = await cryptoProvider.encrypt(
      plaintext,
      sharedSecret,
    );

    const decrypted = await cryptoProvider.decrypt(
      ciphertext,
      nonce,
      sharedSecret,
    );

    expect(decrypted).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Convenience function tests
// ---------------------------------------------------------------------------

describe("convenience functions", () => {
  it("generateQRPayload should return transfer and payload", async () => {
    const crypto = new MockCryptoProvider();
    const { transfer, payload } = await generateQRPayload({}, crypto);

    expect(transfer).toBeInstanceOf(QRKeyTransfer);
    expect(payload.version).toBe(1);
    expect(payload.publicKey).toBeTruthy();
  });

  it("completeKeyTransfer should prepare a key transfer message", async () => {
    const crypto = new MockCryptoProvider();
    const { payload } = await generateQRPayload({}, crypto);

    const masterKey = Buffer.from("master-key").toString("base64");
    const message = await completeKeyTransfer(payload, masterKey, crypto);

    expect(message.sessionId).toBe(payload.sessionId);
    expect(message.encryptedKey).toBeTruthy();
    expect(message.nonce).toBeTruthy();
  });
});
