/**
 * Crypto Types for the Saqr Mobile App.
 *
 * Defines key info, storage options, and QR transfer/pairing payloads.
 *
 * @module types/crypto
 */

/** Metadata about a stored encryption key (non-sensitive). */
export interface KeyInfo {
  /** First 8 hex chars of SHA-256 of master key. */
  keyId: string;
  /** ISO 8601 timestamp when the key was created. */
  createdAt: string;
  /** ISO 8601 timestamp when the key was last used. */
  lastUsedAt: string;
  /** Whether biometric authentication is required. */
  biometricEnabled: boolean;
  /** Name of the device that generated or received this key. */
  deviceName: string;
}

/** Options for storing a key in secure storage. */
export interface KeyStorageOptions {
  /** Whether biometric authentication is required. */
  biometricRequired: boolean;
  /** Label shown in the biometric prompt. */
  biometricLabel: string;
  /** When the key is accessible. */
  accessLevel: "whenUnlocked" | "afterFirstUnlock";
}

/** Default key storage options. */
export const DEFAULT_KEY_STORAGE_OPTIONS: KeyStorageOptions = {
  biometricRequired: true,
  biometricLabel: "Unlock AgentContext encryption key",
  accessLevel: "whenUnlocked",
};

/** LAN connection info in a QR payload. */
export interface QRLanInfo {
  /** IP address. */
  address: string;
  /** Port number. */
  port: number;
}

/** Relay connection info in a QR payload. */
export interface QRRelayInfo {
  /** Relay server session ID. */
  serverId: string;
}

/** Decoded QR pairing payload from a daemon. */
export interface PairingPayload {
  /** Payload format version. */
  version: number;
  /** Machine hostname. */
  hostname: string;
  /** Operating system. */
  os: "linux" | "macos" | "windows";
  /** Daemon software version. */
  daemonVersion: string;
  /** Unique machine identifier. */
  machineId: string;
  /** LAN connection info. */
  lan?: QRLanInfo;
  /** Relay connection info. */
  relay?: QRRelayInfo;
  /** Ephemeral Curve25519 public key (base64). */
  ephemeralPublicKey: string;
  /** ISO 8601 expiration timestamp. */
  expiresAt: string;
  /** Random nonce (base64). */
  nonce: string;
}

/** QR key transfer payload. */
export interface KeyTransferPayload {
  /** Payload format version. */
  version: number;
  /** Payload type discriminator. */
  type: "key_transfer";
  /** Ephemeral Curve25519 public key (base64). */
  ephemeralPublicKey: string;
  /** LAN connection info. */
  lan?: QRLanInfo;
  /** Relay connection info. */
  relay?: QRRelayInfo;
  /** ISO 8601 expiration timestamp. */
  expiresAt: string;
  /** Random nonce (base64). */
  nonce: string;
}

/** URL scheme prefix for pairing. */
export const PAIRING_URL_SCHEME = "agentctx://pair";

/** URL scheme prefix for key transfer. */
export const KEY_TRANSFER_URL_SCHEME = "agentctx://key-transfer";

/** Maximum age for a QR code before it expires (5 minutes). */
export const QR_MAX_AGE_MS = 5 * 60 * 1000;

/** Maximum age for key transfer QR (2 minutes). */
export const KEY_TRANSFER_MAX_AGE_MS = 2 * 60 * 1000;
