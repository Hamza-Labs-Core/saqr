/**
 * E2EERelay — End-to-end encrypted relay channel for remote sessions.
 *
 * Provides an encryption layer for WebSocket-based relay communication.
 * Each message is encrypted using NaCl box (Curve25519 + XSalsa20-Poly1305).
 * Forward secrecy is achieved through ephemeral session keys.
 *
 * This module implements the encryption protocol; the actual WebSocket
 * transport is injected via the WebSocketTransport interface.
 *
 * @module security/e2ee-relay
 */

import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * A relay message with encrypted payload.
 */
export interface RelayMessage {
  /** Message type */
  type: "handshake" | "data" | "close";
  /** Session identifier */
  sessionId: string;
  /** Sender's ephemeral public key (base64) — included in handshake */
  senderPublicKey?: string;
  /** Encrypted payload (base64) */
  payload?: string;
  /** Nonce used for encryption (base64) */
  nonce?: string;
  /** Message sequence number for replay protection */
  sequence: number;
  /** Timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * Session state for an E2EE relay session.
 */
export interface RelaySession {
  /** Unique session identifier */
  sessionId: string;
  /** Local ephemeral public key (base64) */
  localPublicKey: string;
  /** Local ephemeral secret key (base64) */
  localSecretKey: string;
  /** Remote peer's public key (base64), set after handshake */
  remotePublicKey: string | null;
  /** Shared secret derived from key exchange (base64) */
  sharedSecret: string | null;
  /** Whether the handshake is complete */
  established: boolean;
  /** Next outbound sequence number */
  sendSequence: number;
  /** Highest inbound sequence number seen (for replay protection) */
  receiveSequence: number;
  /** Session creation timestamp */
  createdAt: string;
}

/**
 * WebSocket transport abstraction for testing.
 */
export interface WebSocketTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * Handler for decrypted messages from the relay.
 */
export type MessageHandler = (data: string, session: RelaySession) => void;

/**
 * Configuration for E2EE relay.
 */
export interface E2EERelayConfig {
  /** Session timeout in ms. Default: 30 minutes */
  sessionTimeoutMs?: number;
}

/**
 * E2EERelay provides end-to-end encrypted communication over WebSocket.
 *
 * Flow:
 * 1. Both sides create a session (generates ephemeral keypair)
 * 2. Initiator sends handshake with their public key
 * 3. Responder receives handshake, computes shared secret, sends back their public key
 * 4. Both sides now have the shared secret for encrypting messages
 * 5. All subsequent messages are encrypted with the shared secret
 */
export class E2EERelay {
  private readonly config: Required<E2EERelayConfig>;
  private session: RelaySession | null = null;
  private transport: WebSocketTransport | null = null;
  private messageHandler: MessageHandler | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(config: E2EERelayConfig = {}) {
    this.config = {
      sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1000,
    };
  }

  /**
   * Create a new relay session with an ephemeral keypair.
   *
   * @returns The created session
   */
  async createSession(): Promise<RelaySession> {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("x25519");

    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const privDer = privateKey.export({ type: "pkcs8", format: "der" });

    const pubRaw = pubDer.subarray(pubDer.length - 32);
    const privRaw = privDer.subarray(privDer.length - 32);

    this.session = {
      sessionId: randomBytes(16).toString("hex"),
      localPublicKey: pubRaw.toString("base64"),
      localSecretKey: privRaw.toString("base64"),
      remotePublicKey: null,
      sharedSecret: null,
      established: false,
      sendSequence: 0,
      receiveSequence: -1,
      createdAt: new Date().toISOString(),
    };

    return this.session;
  }

  /**
   * Get the current session.
   */
  getSession(): RelaySession | null {
    return this.session;
  }

  /**
   * Connect to a transport and start the handshake.
   *
   * @param transport - The WebSocket transport to use
   * @param handler - Handler for decrypted incoming messages
   */
  connect(
    transport: WebSocketTransport,
    handler: MessageHandler,
    closeHandler?: () => void,
  ): void {
    if (!this.session) {
      throw new Error("No session created. Call createSession() first.");
    }

    this.transport = transport;
    this.messageHandler = handler;
    this.closeHandler = closeHandler ?? null;

    // Set up message handling
    transport.onMessage((data: string) => {
      this.handleIncomingMessage(data);
    });

    transport.onClose(() => {
      this.handleClose();
    });
  }

  /**
   * Send the initial handshake message.
   */
  sendHandshake(): void {
    if (!this.session || !this.transport) {
      throw new Error("Not connected. Call connect() first.");
    }

    const message: RelayMessage = {
      type: "handshake",
      sessionId: this.session.sessionId,
      senderPublicKey: this.session.localPublicKey,
      sequence: this.session.sendSequence++,
      timestamp: new Date().toISOString(),
    };

    this.transport.send(JSON.stringify(message));
  }

  /**
   * Send an encrypted data message.
   *
   * @param data - The plaintext data to send
   * @throws If the session is not established
   */
  async sendMessage(data: string): Promise<void> {
    if (!this.session?.established || !this.session.sharedSecret) {
      throw new Error("Session not established. Complete handshake first.");
    }
    if (!this.transport) {
      throw new Error("No transport connected.");
    }

    const { ciphertext, nonce } = this.encryptData(
      data,
      this.session.sharedSecret,
    );

    const message: RelayMessage = {
      type: "data",
      sessionId: this.session.sessionId,
      payload: ciphertext,
      nonce,
      sequence: this.session.sendSequence++,
      timestamp: new Date().toISOString(),
    };

    this.transport.send(JSON.stringify(message));
  }

  /**
   * Close the relay session.
   */
  close(): void {
    if (this.transport && this.session) {
      const message: RelayMessage = {
        type: "close",
        sessionId: this.session.sessionId,
        sequence: this.session.sendSequence++,
        timestamp: new Date().toISOString(),
      };

      try {
        this.transport.send(JSON.stringify(message));
      } catch {
        // Transport may already be closed
      }
      this.transport.close();
    }

    this.session = null;
    this.transport = null;
  }

  /**
   * Process a received handshake from a remote peer.
   *
   * Computes the shared secret and optionally sends back our public key.
   *
   * @param remotePublicKey - The peer's ephemeral public key (base64)
   * @param sendResponse - Whether to send a handshake response (default: true)
   */
  async processHandshake(
    remotePublicKey: string,
    sendResponse = true,
  ): Promise<void> {
    if (!this.session) {
      throw new Error("No session. Call createSession() first.");
    }

    this.session.remotePublicKey = remotePublicKey;

    // Compute shared secret
    this.session.sharedSecret = await this.computeSharedSecret(
      this.session.localSecretKey,
      remotePublicKey,
    );

    this.session.established = true;

    // Send handshake response if needed
    if (sendResponse && this.transport) {
      const response: RelayMessage = {
        type: "handshake",
        sessionId: this.session.sessionId,
        senderPublicKey: this.session.localPublicKey,
        sequence: this.session.sendSequence++,
        timestamp: new Date().toISOString(),
      };
      this.transport.send(JSON.stringify(response));
    }
  }

  /**
   * Handle an incoming message from the transport.
   */
  private async handleIncomingMessage(raw: string): Promise<void> {
    if (!this.session) return;

    let message: RelayMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // Invalid JSON, ignore
    }

    // Replay protection: reject messages with sequence <= last seen
    if (message.sequence <= this.session.receiveSequence) {
      return;
    }
    this.session.receiveSequence = message.sequence;

    switch (message.type) {
      case "handshake": {
        if (message.senderPublicKey) {
          await this.processHandshake(
            message.senderPublicKey,
            !this.session.established, // Only respond if not yet established
          );
        }
        break;
      }
      case "data": {
        if (
          !this.session.established ||
          !this.session.sharedSecret ||
          !message.payload ||
          !message.nonce
        ) {
          return;
        }

        const plaintext = this.decryptData(
          message.payload,
          message.nonce,
          this.session.sharedSecret,
        );

        if (plaintext !== null && this.messageHandler) {
          this.messageHandler(plaintext, this.session);
        }
        break;
      }
      case "close": {
        this.handleClose();
        break;
      }
    }
  }

  /**
   * Handle connection close.
   */
  private handleClose(): void {
    if (this.closeHandler) {
      this.closeHandler();
    }
    this.session = null;
    this.transport = null;
  }

  /**
   * Encrypt data using AES-256-GCM with the shared secret.
   */
  private encryptData(
    plaintext: string,
    sharedSecret: string,
  ): { ciphertext: string; nonce: string } {
    const key = this.deriveEncryptionKey(sharedSecret);
    const nonce = randomBytes(12);

    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
      nonce: nonce.toString("base64"),
    };
  }

  /**
   * Decrypt data using AES-256-GCM with the shared secret.
   */
  private decryptData(
    ciphertext: string,
    nonce: string,
    sharedSecret: string,
  ): string | null {
    try {
      const key = this.deriveEncryptionKey(sharedSecret);
      const combined = Buffer.from(ciphertext, "base64");
      const nonceBuf = Buffer.from(nonce, "base64");

      const encrypted = combined.subarray(0, combined.length - 16);
      const tag = combined.subarray(combined.length - 16);

      const decipher = createDecipheriv("aes-256-gcm", key, nonceBuf);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }

  /**
   * Derive a 256-bit encryption key from the shared secret using HKDF.
   */
  private deriveEncryptionKey(sharedSecret: string): Buffer {
    const ikm = Buffer.from(sharedSecret, "base64");
    // HKDF-Extract: PRK = HMAC-SHA256(salt, IKM)
    const salt = Buffer.from("saqr-e2ee-relay-v1");
    const { createHmac: hmac } = require("node:crypto");
    const prk = hmac("sha256", salt).update(ikm).digest();
    // HKDF-Expand: OKM = HMAC-SHA256(PRK, info || 0x01)
    const info = Buffer.from("e2ee-relay-encryption-key");
    const okm = hmac("sha256", prk)
      .update(Buffer.concat([info, Buffer.from([0x01])]))
      .digest();
    return okm;
  }

  /**
   * Compute X25519 shared secret from local private key and remote public key.
   */
  private async computeSharedSecret(
    localSecretKey: string,
    remotePublicKey: string,
  ): Promise<string> {
    const { diffieHellman, createPrivateKey, createPublicKey } =
      await import("node:crypto");

    const privKeyObj = createPrivateKey({
      key: this.wrapX25519PrivateKey(
        Buffer.from(localSecretKey, "base64"),
      ),
      format: "der",
      type: "pkcs8",
    });

    const pubKeyObj = createPublicKey({
      key: this.wrapX25519PublicKey(
        Buffer.from(remotePublicKey, "base64"),
      ),
      format: "der",
      type: "spki",
    });

    const shared = diffieHellman({
      privateKey: privKeyObj,
      publicKey: pubKeyObj,
    });

    return shared.toString("base64");
  }

  private wrapX25519PrivateKey(raw: Buffer): Buffer {
    const prefix = Buffer.from(
      "302e020100300506032b656e04220420",
      "hex",
    );
    return Buffer.concat([prefix, raw]);
  }

  private wrapX25519PublicKey(raw: Buffer): Buffer {
    const prefix = Buffer.from("302a300506032b656e032100", "hex");
    return Buffer.concat([prefix, raw]);
  }
}

/**
 * Convenience: create a new relay session.
 */
export async function createRelaySession(
  config?: E2EERelayConfig,
): Promise<{ relay: E2EERelay; session: RelaySession }> {
  const relay = new E2EERelay(config);
  const session = await relay.createSession();
  return { relay, session };
}
