/**
 * Crypto module: Client-side encryption types for zero-knowledge sync.
 *
 * @module crypto
 */

export type {
  MasterKey,
  DerivedKey,
  KeyPurpose,
  EncryptionResult,
  KeyDerivationParams,
} from "./types.js";

export {
  KEY_PURPOSES,
  DEFAULT_KEY_DERIVATION_PARAMS,
} from "./types.js";
