/**
 * Security module — encryption, access control, and secure communication.
 *
 * @module security
 */

// Keychain
export type { KeychainStore } from "./keychain-store.js";
export {
  DesktopKeychainStore,
  FileKeychainStore,
  createKeychainStore,
} from "./keychain-store.js";

// Path Sandbox
export { PathSandbox, PathViolationError } from "./path-sandbox.js";
export type { PathSandboxConfig } from "./path-sandbox.js";

// Host Allowlist
export {
  HostAllowlist,
  validateHost,
  corsHeaders,
} from "./host-allowlist.js";
export type { HostAllowlistConfig } from "./host-allowlist.js";

// Download Tokens
export {
  DownloadTokenManager,
  createDownloadToken,
  verifyDownloadToken,
} from "./download-tokens.js";
export type {
  DownloadTokenConfig,
  ParsedToken,
  TokenVerificationResult,
} from "./download-tokens.js";

// QR Key Transfer
export {
  QRKeyTransfer,
  DefaultCryptoProvider,
  generateQRPayload,
  completeKeyTransfer,
} from "./qr-key-transfer.js";
export type {
  QRPayload,
  KeyTransferMessage,
  KeyTransferResult,
  EphemeralKeypair,
  CryptoProvider,
  QRKeyTransferConfig,
  ConnectionInfo,
} from "./qr-key-transfer.js";

// E2EE Relay
export {
  E2EERelay,
  createRelaySession,
} from "./e2ee-relay.js";
export type {
  RelayMessage,
  RelaySession,
  WebSocketTransport,
  E2EERelayConfig,
} from "./e2ee-relay.js";

// Middleware
export {
  SecurityMiddleware,
  securityMiddleware,
} from "./middleware.js";
export type {
  SecurityConfig,
  RateLimitConfig,
  SecurityRequest,
  SecurityResponse,
  AuditLogEntry,
} from "./middleware.js";
