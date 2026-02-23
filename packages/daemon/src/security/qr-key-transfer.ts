/**
 * QRKeyTransfer — Cross-device key exchange via QR code pairing.
 *
 * Protocol:
 * 1. Initiator generates an ephemeral Curve25519 keypair
 * 2. QR code contains: ephemeral public key + connection info (host, port, session ID)
 * 3. Scanner reads QR, generates its own ephemeral keypair
 * 4. Scanner computes shared secret via X25519 key agreement
 * 5. Scanner encrypts the master key with the shared secret (XChaCha20-Poly1305)
 * 6. Scanner sends encrypted key + its ephemeral public key to initiator
 * 7. Initiator computes the same shared secret and decrypts the master key
 *
 * This module implements the protocol logic; actual QR image generation
 * is handled by the UI layer.
 *
 * @module security/qr-key-transfer
 */

import { randomBytes, createHash } from "node:crypto";

/**
 * Curve25519 keypair for ephemeral key exchange.
 */
export interface EphemeralKeypair {
  /** 32-byte public key, base64-encoded */
  publicKey: string;
  /** 32-byte secret key, base64-encoded */
  secretKey: string;
}

/**
 * QR payload that gets encoded into the QR code.
 */
export interface QRPayload {
  /** Protocol version */
  version: number;
  /** Ephemeral public key (base64) */
  publicKey: string;
  /** Session identifier for the key transfer */
  sessionId: string;
  /** Connection info for the scanner to connect back */
  connectionInfo: ConnectionInfo;
  /** Timestamp when the QR was generated (ISO 8601) */
  createdAt: string;
  /** Expiry time in seconds from creation */
  expiresIn: number;
}

/**
 * Connection info embedded in the QR payload.
 */
export interface ConnectionInfo {
  /** Host to connect to */
  host: string;
  /** Port to connect to */
  port: number;
  /** Protocol: "ws" | "wss" */
  protocol: "ws" | "wss";
}

/**
 * Encrypted key transfer message sent from scanner to initiator.
 */
export interface KeyTransferMessage {
  /** Scanner's ephemeral public key (base64) */
  senderPublicKey: string;
  /** Encrypted master key data (base64) */
  encryptedKey: string;
  /** Nonce used for encryption (base64) */
  nonce: string;
  /** Session ID for correlation */
  sessionId: string;
}

/**
 * Result of completing a key transfer.
 */
export interface KeyTransferResult {
  /** The decrypted master key bytes (base64) */
  masterKeyBytes: string;
  /** Whether the transfer was successful */
  success: boolean;
}

/**
 * Configuration for QR key transfer.
 */
export interface QRKeyTransferConfig {
  /** QR payload expiry in seconds. Default: 300 (5 min) */
  expirySeconds?: number;
  /** Connection info for the QR payload */
  connectionInfo?: ConnectionInfo;
}

/**
 * QRKeyTransfer implements the cross-device key exchange protocol.
 *
 * The cryptographic operations (X25519, XChaCha20-Poly1305) are
 * abstracted through a CryptoProvider interface to allow testing
 * without libsodium dependencies.
 */
export class QRKeyTransfer {
  private readonly config: Required<QRKeyTransferConfig>;
  private readonly cryptoProvider: CryptoProvider;
  private keypair: EphemeralKeypair | null = null;
  private sessionId: string | null = null;

  constructor(
    config: QRKeyTransferConfig = {},
    cryptoProvider?: CryptoProvider,
  ) {
    this.config = {
      expirySeconds: config.expirySeconds ?? 300,
      connectionInfo: config.connectionInfo ?? {
        host: "127.0.0.1",
        port: 3100,
        protocol: "ws",
      },
    };
    this.cryptoProvider = cryptoProvider ?? new DefaultCryptoProvider();
  }

  /**
   * Generate the QR payload for the initiator device.
   *
   * Creates an ephemeral keypair and packages the public key
   * with connection info into a QR-encodable payload.
   *
   * @returns The QR payload to encode into a QR code
   */
  async generateQRPayload(): Promise<QRPayload> {
    this.keypair = await this.cryptoProvider.generateKeypair();
    this.sessionId = randomBytes(16).toString("hex");

    return {
      version: 1,
      publicKey: this.keypair.publicKey,
      sessionId: this.sessionId,
      connectionInfo: this.config.connectionInfo,
      createdAt: new Date().toISOString(),
      expiresIn: this.config.expirySeconds,
    };
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Complete the key transfer on the initiator side.
   *
   * Receives the encrypted key from the scanner, computes the
   * shared secret, and decrypts the master key.
   *
   * @param message - The key transfer message from the scanner
   * @returns The decrypted master key
   * @throws If no keypair has been generated or session IDs don't match
   */
  async completeKeyTransfer(
    message: KeyTransferMessage,
  ): Promise<KeyTransferResult> {
    if (!this.keypair) {
      throw new Error(
        "No keypair generated. Call generateQRPayload() first.",
      );
    }

    if (message.sessionId !== this.sessionId) {
      throw new Error(
        `Session ID mismatch: expected "${this.sessionId}", got "${message.sessionId}"`,
      );
    }

    // Compute shared secret via X25519
    const sharedSecret = await this.cryptoProvider.computeSharedSecret(
      this.keypair.secretKey,
      message.senderPublicKey,
    );

    // Decrypt the master key
    const masterKeyBytes = await this.cryptoProvider.decrypt(
      message.encryptedKey,
      message.nonce,
      sharedSecret,
    );

    // Clear the ephemeral keypair
    this.keypair = null;

    return {
      masterKeyBytes,
      success: true,
    };
  }

  /**
   * Prepare a key transfer message on the scanner side.
   *
   * The scanner reads the QR payload, generates its own keypair,
   * computes the shared secret, and encrypts the master key.
   *
   * @param qrPayload - The QR payload from the initiator
   * @param masterKeyBytes - The master key to transfer (base64)
   * @returns The key transfer message to send to the initiator
   */
  async prepareKeyTransfer(
    qrPayload: QRPayload,
    masterKeyBytes: string,
  ): Promise<KeyTransferMessage> {
    // Check expiry
    const created = new Date(qrPayload.createdAt).getTime();
    const now = Date.now();
    const expiresAt = created + qrPayload.expiresIn * 1000;

    if (now > expiresAt) {
      throw new Error("QR payload has expired");
    }

    // Generate scanner's ephemeral keypair
    const scannerKeypair = await this.cryptoProvider.generateKeypair();

    // Compute shared secret
    const sharedSecret = await this.cryptoProvider.computeSharedSecret(
      scannerKeypair.secretKey,
      qrPayload.publicKey,
    );

    // Encrypt the master key
    const { ciphertext, nonce } = await this.cryptoProvider.encrypt(
      masterKeyBytes,
      sharedSecret,
    );

    return {
      senderPublicKey: scannerKeypair.publicKey,
      encryptedKey: ciphertext,
      nonce,
      sessionId: qrPayload.sessionId,
    };
  }
}

/**
 * Abstraction for cryptographic operations.
 * Allows testing without libsodium.
 */
export interface CryptoProvider {
  /** Generate an ephemeral Curve25519 keypair */
  generateKeypair(): Promise<EphemeralKeypair>;

  /** Compute X25519 shared secret */
  computeSharedSecret(
    secretKey: string,
    publicKey: string,
  ): Promise<string>;

  /** Encrypt data with XChaCha20-Poly1305 */
  encrypt(
    plaintext: string,
    key: string,
  ): Promise<{ ciphertext: string; nonce: string }>;

  /** Decrypt data with XChaCha20-Poly1305 */
  decrypt(
    ciphertext: string,
    nonce: string,
    key: string,
  ): Promise<string>;
}

/**
 * Default crypto provider using Node.js crypto.
 *
 * Uses X25519 for key agreement and AES-256-GCM as a
 * stand-in for XChaCha20-Poly1305 (which requires libsodium).
 * In production, this would use libsodium via the sync-client's
 * EncryptionManager.
 */
export class DefaultCryptoProvider implements CryptoProvider {
  async generateKeypair(): Promise<EphemeralKeypair> {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("x25519");

    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const privDer = privateKey.export({ type: "pkcs8", format: "der" });

    // Extract raw key bytes from DER encoding
    // X25519 public key is the last 32 bytes of SPKI DER
    const pubRaw = pubDer.subarray(pubDer.length - 32);
    // X25519 private key is the last 32 bytes of PKCS8 DER
    const privRaw = privDer.subarray(privDer.length - 32);

    return {
      publicKey: pubRaw.toString("base64"),
      secretKey: privRaw.toString("base64"),
    };
  }

  async computeSharedSecret(
    secretKey: string,
    publicKey: string,
  ): Promise<string> {
    const { diffieHellman, createPrivateKey, createPublicKey } =
      await import("node:crypto");

    const privKeyObj = createPrivateKey({
      key: this.wrapX25519PrivateKey(Buffer.from(secretKey, "base64")),
      format: "der",
      type: "pkcs8",
    });

    const pubKeyObj = createPublicKey({
      key: this.wrapX25519PublicKey(Buffer.from(publicKey, "base64")),
      format: "der",
      type: "spki",
    });

    const shared = diffieHellman({
      privateKey: privKeyObj,
      publicKey: pubKeyObj,
    });

    return shared.toString("base64");
  }

  async encrypt(
    plaintext: string,
    key: string,
  ): Promise<{ ciphertext: string; nonce: string }> {
    const { createCipheriv } = await import("node:crypto");

    // Use first 32 bytes of key for AES-256-GCM
    const keyBuf = Buffer.from(key, "base64");
    const keyHash = createHash("sha256").update(keyBuf).digest();

    const nonce = randomBytes(12); // GCM nonce
    const cipher = createCipheriv("aes-256-gcm", keyHash, nonce);

    const plaintextBuf = Buffer.from(plaintext, "base64");
    const encrypted = Buffer.concat([
      cipher.update(plaintextBuf),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Combine ciphertext + auth tag
    const combined = Buffer.concat([encrypted, tag]);

    return {
      ciphertext: combined.toString("base64"),
      nonce: nonce.toString("base64"),
    };
  }

  async decrypt(
    ciphertext: string,
    nonce: string,
    key: string,
  ): Promise<string> {
    const { createDecipheriv } = await import("node:crypto");

    const keyBuf = Buffer.from(key, "base64");
    const keyHash = createHash("sha256").update(keyBuf).digest();

    const combined = Buffer.from(ciphertext, "base64");
    const nonceBuf = Buffer.from(nonce, "base64");

    // Split ciphertext and auth tag (last 16 bytes)
    const encrypted = combined.subarray(0, combined.length - 16);
    const tag = combined.subarray(combined.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", keyHash, nonceBuf);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString("base64");
  }

  /**
   * Wrap raw 32-byte X25519 private key into PKCS8 DER format.
   */
  private wrapX25519PrivateKey(raw: Buffer): Buffer {
    // PKCS8 wrapper for X25519 private key
    const prefix = Buffer.from(
      "302e020100300506032b656e04220420",
      "hex",
    );
    return Buffer.concat([prefix, raw]);
  }

  /**
   * Wrap raw 32-byte X25519 public key into SPKI DER format.
   */
  private wrapX25519PublicKey(raw: Buffer): Buffer {
    // SPKI wrapper for X25519 public key
    const prefix = Buffer.from("302a300506032b656e032100", "hex");
    return Buffer.concat([prefix, raw]);
  }
}

/**
 * Convenience: generate a QR payload for key transfer.
 */
export async function generateQRPayload(
  config?: QRKeyTransferConfig,
  cryptoProvider?: CryptoProvider,
): Promise<{ transfer: QRKeyTransfer; payload: QRPayload }> {
  const transfer = new QRKeyTransfer(config, cryptoProvider);
  const payload = await transfer.generateQRPayload();
  return { transfer, payload };
}

/**
 * Convenience: complete a key transfer (scanner side).
 */
export async function completeKeyTransfer(
  qrPayload: QRPayload,
  masterKeyBytes: string,
  cryptoProvider?: CryptoProvider,
): Promise<KeyTransferMessage> {
  const transfer = new QRKeyTransfer({}, cryptoProvider);
  return transfer.prepareKeyTransfer(qrPayload, masterKeyBytes);
}
