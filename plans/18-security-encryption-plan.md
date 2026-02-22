# Implementation Plan: Story 18 -- Security & Encryption

**Date**: 2026-02-22
**Story**: 18-security-encryption
**Status**: Planning
**Estimated Total Effort**: ~12-15 days (96-120 hours)
**Prerequisites**: libsodium-wrappers (npm), react-native-keychain (mobile), tauri-plugin-keyring (desktop), zxcvbn (npm). Story 00 (installation) and Story 03 (storage layer) must be implemented. Daemon HTTP server (F4) must exist for Tasks 10-12.
**Design References**: `docs/PRODUCT-SPEC.md` (F10), `docs/PLATFORM-EVALUATION.md` (Section 4), `stories/18-security-encryption.md`

### Relationship to Other Stories

This is the **security foundation story**. It produces the cryptographic primitives, key management infrastructure, and server-side access controls that all sync-capable features depend on:

- **Story 00** (Installation): `gc-install` must be extended to verify libsodium availability and initialize encryption config
- **Story 03** (Storage Layer): Event files and projection files transition from plaintext to encrypted envelopes after this story
- **Story F5** (Encrypted Cloud Sync): Depends on Tasks 1-3 (master key, KDF, encryption) and Task 9 (E2EE relay) for client-side encryption before push
- **Story F6** (Mobile App): Depends on Tasks 4-5 (iOS Keychain, Android Keystore) and Task 7 (QR key transfer)
- **Story F7** (Desktop App): Depends on Task 6 (desktop keychain) for macOS/Windows/Linux key storage
- **Story F4** (Local Dashboard): Depends on Tasks 10-12 (path sandboxing, host allowlisting, download tokens) for HTTP server security

### Amendment Impacts on This Plan

- Encryption is **optional** in local-only mode (no account). When enabled, all event files and projections are encrypted with the master key. The daemon detects whether encryption is active by checking for a key in the OS keychain.
- Existing plaintext events are **not** retroactively encrypted. Only new events written after encryption setup are encrypted. A future migration story may handle re-encryption.
- The `capture-event` pipeline gains an encryption step between JSON assembly and atomic write (Task 3 integration).

---

## Task Dependency Graph

```
Task 1: Master Key Generation (libsodium primitives)
  |
  +---> Task 2: Passphrase Derivation (Argon2id KDF)
  |       |
  |       +---> Task 8: Key Backup Prompt & Recovery Flow (needs 1, 2, 3)
  |
  +---> Task 3: XChaCha20-Poly1305 Encryption Module (needs 1)
  |       |
  |       +---> Task 9: E2EE Relay Channel (needs 1, 3)
  |       |
  |       +---> Task 8: Key Backup Prompt & Recovery Flow (needs 1, 2, 3)
  |
  +---> Task 4: iOS Keychain Storage (needs 1)
  |
  +---> Task 5: Android Keystore Storage (needs 1)
  |
  +---> Task 6: Desktop Keychain Storage (needs 1)
  |
  +---> Task 7: QR Key Transfer Protocol (needs 1, 3)
  |
  Task 10: Path Sandboxing (independent)
  |
  Task 11: Host Allowlisting & CORS (independent)
  |
  Task 12: Download Tokens (needs 10)
  |
  Task 13: Integration Tests (needs all)
```

Tasks 4, 5, 6 can proceed in parallel once Task 1 is done.
Tasks 10, 11 are independent of the cryptographic tasks and can proceed in parallel from the start.
Task 12 depends on Task 10 (sandbox validation before token generation).
Task 13 is the final validation task.

---

## Tasks

### Task 1: Master Key Generation

**Description**

Implement the master key generation module using libsodium. This produces a 256-bit (32-byte) cryptographically random key that serves as the root secret for all encryption. The key is generated exactly once per user account and stored via the platform keychain (Tasks 4-6). This task also provides serialization/deserialization helpers and memory zeroing utilities.

**Prerequisites/Inputs**

- `libsodium-wrappers` npm package (>= 0.7.13) installed
- No prior key exists in the platform keychain (checked by caller)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/master-key.ts` | Create | Master key generation, serialization, memory management |
| `src/crypto/index.ts` | Create | Public API barrel export for crypto module |
| `tests/crypto/master-key.test.ts` | Create | Unit tests for key generation |

Core data structure:

```typescript
// src/crypto/master-key.ts
interface MasterKey {
  raw: Uint8Array;        // 32 bytes, never logged
  createdAt: string;      // ISO 8601
  version: number;        // Always 1 for initial generation
}
```

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `generateMasterKey` | `() => Promise<MasterKey>` | Generate 32-byte key via `sodium.randombytes_buf(crypto_secretbox_KEYBYTES)`. Calls `await sodium.ready` first. |
| `serializeMasterKey` | `(key: MasterKey) => string` | Encode `key.raw` as base64url (no padding) via `sodium.to_base64(key.raw, base64_variants.URLSAFE_NO_PADDING)` |
| `deserializeMasterKey` | `(encoded: string) => Uint8Array` | Decode base64url string back to 32-byte Uint8Array via `sodium.from_base64()` |
| `zeroKey` | `(key: MasterKey) => void` | Call `sodium.memzero(key.raw)` to wipe key bytes from memory |
| `isKeyPresent` | `(keychain: KeychainProvider, userId: string) => Promise<boolean>` | Check if a key already exists in the keychain without retrieving it |

Key lifecycle rules enforced by this module:
1. `generateMasterKey()` checks `isKeyPresent()` first and throws `KeyAlreadyExistsError` if a key is found
2. The `raw` field is never included in `JSON.stringify()` output (use a custom toJSON that omits it)
3. `zeroKey()` is called in a `finally` block or via a disposable pattern after every encryption operation

**Acceptance Criteria**

- [ ] Master key is exactly 32 bytes (256 bits) generated via `sodium.randombytes_buf`
- [ ] Key is generated using OS CSPRNG (no `Math.random()`, no custom RNG)
- [ ] Key is serialized as base64url with no padding
- [ ] `serializeMasterKey(deserializeMasterKey(serialize(key)))` roundtrips correctly
- [ ] `generateMasterKey()` throws if a key already exists in the keychain
- [ ] `zeroKey()` calls `sodium.memzero()` and sets `raw` to a zero-filled buffer
- [ ] `MasterKey.toJSON()` never includes the `raw` field
- [ ] Key version field is set to 1

**Edge Cases**

- E-1: Key already exists at first launch -- `generateMasterKey()` checks keychain first and skips generation
- libsodium WASM not loaded -- `await sodium.ready` must be called before any operation; throw `CryptoNotReadyError` if called before init

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 2: Passphrase Derivation (Argon2id)

**Description**

Implement passphrase-based key derivation using Argon2id via libsodium's `crypto_pwhash`. The derived key is used to encrypt the master key for backup/recovery purposes. This module handles salt generation, parameter management, and fallback for low-memory devices.

**Prerequisites/Inputs**

- Task 1 complete (master key types)
- `libsodium-wrappers` available
- User-provided passphrase string (UTF-8, NFC-normalized)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/passphrase-kdf.ts` | Create | Argon2id key derivation with parameter management |
| `tests/crypto/passphrase-kdf.test.ts` | Create | KDF unit tests |

Argon2id parameters (primary):

| Parameter | Value | Constant |
|---|---|---|
| Memory (m) | 67,108,864 bytes (64 MB) | `MEM_LIMIT_PRIMARY` |
| Iterations (t) | 3 | `OPS_LIMIT_PRIMARY` |
| Parallelism (p) | 1 | Fixed by libsodium |
| Output length | 32 bytes | `crypto_secretbox_KEYBYTES` |
| Salt length | 16 bytes | `crypto_pwhash_SALTBYTES` |
| Algorithm | Argon2id v1.3 | `crypto_pwhash_ALG_ARGON2ID13` |

Fallback parameters (low-memory devices):

| Parameter | Value | Constant |
|---|---|---|
| Memory (m) | 33,554,432 bytes (32 MB) | `MEM_LIMIT_FALLBACK` |
| Iterations (t) | 6 | `OPS_LIMIT_FALLBACK` |

Data structures:

```typescript
// src/crypto/passphrase-kdf.ts
interface DerivedKeyResult {
  key: Uint8Array;        // 32-byte derived key
  salt: Uint8Array;       // 16-byte salt
  algorithm: string;      // "argon2id"
  params: {
    memLimitBytes: number;
    opsLimit: number;
    parallelism: number;
  };
}

interface KdfParams {
  algorithm: string;
  m: number;              // Memory in bytes
  t: number;              // Iterations
  p: number;              // Parallelism
  salt: string;           // base64url-encoded salt
}
```

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `deriveKeyFromPassphrase` | `(passphrase: string, existingSalt?: Uint8Array) => Promise<DerivedKeyResult>` | Derive 32-byte key. Generate salt if not provided. Apply NFC normalization to passphrase. Try primary params first, fall back on ENOMEM. |
| `normalizePassphrase` | `(passphrase: string) => string` | Apply Unicode NFC normalization via `String.prototype.normalize('NFC')` |
| `serializeKdfParams` | `(result: DerivedKeyResult) => KdfParams` | Serialize salt and params for storage alongside encrypted backup |
| `deserializeKdfParams` | `(params: KdfParams) => { salt: Uint8Array; memLimitBytes: number; opsLimit: number }` | Parse stored params for re-derivation |

Low-memory fallback logic:

```typescript
try {
  key = sodium.crypto_pwhash(32, passphrase, salt, OPS_LIMIT_PRIMARY, MEM_LIMIT_PRIMARY, ALG);
} catch (err) {
  if (isOutOfMemoryError(err)) {
    key = sodium.crypto_pwhash(32, passphrase, salt, OPS_LIMIT_FALLBACK, MEM_LIMIT_FALLBACK, ALG);
    // Record that fallback params were used
  } else {
    throw err;
  }
}
```

**Acceptance Criteria**

- [ ] Argon2id is used with primary parameters: m=64MB, t=3, p=1
- [ ] Salt is 16 bytes generated via `sodium.randombytes_buf`
- [ ] Derived key is exactly 32 bytes
- [ ] Same passphrase + same salt produces the same derived key (deterministic)
- [ ] Different salt produces a different derived key
- [ ] Existing salt can be provided for re-derivation (recovery scenario)
- [ ] Salt and algorithm params are serializable for storage alongside encrypted backup
- [ ] Unicode passphrase is NFC-normalized before derivation
- [ ] Passphrase memory is zeroed after derivation (best-effort in JS via overwrite)
- [ ] ENOMEM triggers fallback to m=32MB, t=6, p=1 with warning
- [ ] Derivation completes in under 5 seconds on target platforms

**Edge Cases**

- E-2: Argon2id runs out of memory on low-end device -- fallback params used, second failure produces actionable error
- Empty passphrase -- rejected before derivation (minimum length enforced by Task 8)
- Extremely long passphrase (>1024 chars) -- rejected before derivation (maximum length enforced by Task 8)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 3: XChaCha20-Poly1305 Encryption Module

**Description**

Implement the core encryption/decryption module using XChaCha20-Poly1305 AEAD. This module produces self-describing encrypted envelopes with a 4-byte header, 24-byte random nonce, and ciphertext with appended 16-byte Poly1305 authentication tag. All data at rest (events, projections, backups) and in transit (sync payloads) passes through this module.

**Prerequisites/Inputs**

- Task 1 complete (master key available)
- `libsodium-wrappers` available
- Plaintext data as `Uint8Array`
- Associated data (context binding) for AEAD

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/encryption.ts` | Create | XChaCha20-Poly1305 encrypt/decrypt with envelope format |
| `src/crypto/envelope.ts` | Create | Envelope parsing, header constants, format validation |
| `tests/crypto/encryption.test.ts` | Create | Encryption roundtrip, tampering detection, performance tests |

Envelope binary format (4 + 24 + N + 16 bytes):

```
Offset  Length  Field
0       1       Version (0x01)
1       1       Algorithm (0x01 = XChaCha20-Poly1305)
2       2       Reserved (0x0000)
4       24      Nonce (random, from randombytes_buf)
28      N+16    Ciphertext + Poly1305 tag (libsodium appends tag)
```

Constants:

```typescript
// src/crypto/envelope.ts
const ENVELOPE_VERSION = 0x01;
const ALG_XCHACHA20_POLY1305 = 0x01;
const HEADER_SIZE = 4;
const NONCE_SIZE = 24; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const TAG_SIZE = 16;   // crypto_aead_xchacha20poly1305_ietf_ABYTES
```

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `encrypt` | `(plaintext: Uint8Array, key: Uint8Array, associatedData?: Uint8Array) => Uint8Array` | Generate random 24-byte nonce, encrypt with AEAD, return envelope bytes |
| `decrypt` | `(envelope: Uint8Array, key: Uint8Array, associatedData?: Uint8Array) => Uint8Array` | Parse header, extract nonce, decrypt+verify, throw on tag mismatch |
| `encryptString` | `(plaintext: string, key: Uint8Array, associatedData?: Uint8Array) => Uint8Array` | UTF-8 encode string, then `encrypt()` |
| `decryptString` | `(envelope: Uint8Array, key: Uint8Array, associatedData?: Uint8Array) => string` | `decrypt()` then UTF-8 decode |
| `parseEnvelopeHeader` | `(envelope: Uint8Array) => { version: number; algorithm: number }` | Extract and validate header without decrypting |
| `buildAssociatedData` | `(dataType: string, context: Record<string, string>) => Uint8Array` | Build AD from data type and context fields |

Associated data binding (prevents ciphertext swapping):

| Data Type | Associated Data Format | Example |
|---|---|---|
| Event file | `"event:" + event_id` | `"event:550e8400-e29b-41d4-a716-446655440000"` |
| Projection blob | `"projection:" + project_id + ":" + projection_type` | `"projection:myapp-c9d1e4:context-snapshot"` |
| Sync payload | `"sync:" + session_nonce + ":" + sequence_number` | `"sync:abc123:42"` |
| Master key backup | `"backup:" + user_id + ":" + backup_version` | `"backup:user123:1"` |

Error types:

| Error | Thrown When |
|---|---|
| `UnsupportedEnvelopeVersionError` | `envelope[0] !== 0x01` |
| `UnsupportedAlgorithmError` | `envelope[1] !== 0x01` |
| `DecryptionFailedError` | Poly1305 tag verification fails (wrong key, tampered data, wrong AD) |
| `EnvelopeTooShortError` | Envelope shorter than `HEADER_SIZE + NONCE_SIZE + TAG_SIZE` (44 bytes minimum) |

**Acceptance Criteria**

- [ ] XChaCha20-Poly1305 is used for all encryption (no fallback ciphers)
- [ ] Nonce is 24 bytes, randomly generated per encryption operation
- [ ] Ciphertext includes the 16-byte Poly1305 authentication tag
- [ ] Envelope includes version byte (0x01) and algorithm byte (0x01)
- [ ] `encrypt(plaintext, key)` followed by `decrypt(envelope, key)` roundtrips for payloads of 0, 1, 1000, and 1,000,000 bytes
- [ ] `decrypt()` with wrong key throws `DecryptionFailedError`
- [ ] `decrypt()` with tampered ciphertext (flipped bit) throws `DecryptionFailedError`
- [ ] `decrypt()` with mismatched associated data throws `DecryptionFailedError`
- [ ] `encrypt()` produces different ciphertext for the same plaintext (random nonce ensures this)
- [ ] Encryption throughput exceeds 10,000 events/second for 1 KB payloads on desktop (benchmark test)
- [ ] Encrypted envelopes are self-describing (version + algorithm in header)
- [ ] Envelope too short (<44 bytes) is rejected with `EnvelopeTooShortError`

**Edge Cases**

- Zero-length plaintext: valid (produces 44-byte envelope: 4 header + 24 nonce + 16 tag)
- Maximum plaintext: limited by available memory; libsodium handles arbitrary sizes
- Envelope from future version (0x02): rejected with `UnsupportedEnvelopeVersionError` to allow forward-compatible upgrades

**Estimated Effort**: M (Medium) -- 6-8 hours

---

### Task 4: iOS Keychain Storage

**Description**

Implement the iOS Keychain integration for storing and retrieving the master key. The key is protected by biometric authentication (Face ID / Touch ID) with device passcode fallback. Uses `react-native-keychain` for the React Native bridge. The key is scoped to `ThisDeviceOnly` (no iCloud Keychain sync) and invalidated if biometric enrollment changes.

**Prerequisites/Inputs**

- Task 1 complete (master key serialization format)
- `react-native-keychain` (>= 8.0) installed
- iOS device or simulator

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/keychain/ios-keychain.ts` | Create | iOS Keychain storage implementation |
| `src/crypto/keychain/types.ts` | Create | `KeychainProvider` interface definition |
| `tests/crypto/keychain/ios-keychain.test.ts` | Create | Tests (mocked for non-iOS, real on device) |

Interface (shared by all platform implementations):

```typescript
// src/crypto/keychain/types.ts
interface KeychainProvider {
  store(userId: string, masterKeyBase64: string): Promise<void>;
  retrieve(userId: string): Promise<string | null>;
  delete(userId: string): Promise<void>;
  exists(userId: string): Promise<boolean>;
  getBackendInfo(): Promise<{
    platform: 'ios' | 'android' | 'macos' | 'windows' | 'linux';
    backend: string;
    hardwareBacked: boolean;
  }>;
}
```

iOS-specific configuration:

| Attribute | Value |
|---|---|
| Service name | `"com.agentcontext.masterkey"` |
| Accessible | `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` |
| Access control | `BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` |
| Security level | `SECURE_ENCLAVE` |
| Storage type | `AES_GCM_NO_AUTH` |
| Synchronizable | `false` (implicit via `ThisDeviceOnly`) |

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `storeMasterKeyIOS` | `(userId: string, masterKeyBase64: string) => Promise<void>` | Store via `Keychain.setGenericPassword` with biometric ACL |
| `retrieveMasterKeyIOS` | `(userId: string) => Promise<string \| null>` | Retrieve with biometric prompt; return null on user cancellation |
| `deleteMasterKeyIOS` | `(userId: string) => Promise<void>` | Remove keychain entry |
| `existsMasterKeyIOS` | `(userId: string) => Promise<boolean>` | Check existence without triggering biometric prompt |

Error handling matrix:

| Scenario | Behavior |
|---|---|
| No passcode set on device | `store()` throws `DeviceNotSecureError` with message to set passcode |
| No biometrics enrolled | Falls back to device passcode (`.or .devicePasscode`) |
| Biometrics changed after store | `retrieve()` fails; return null, caller prompts for re-transfer or recovery |
| User dismisses biometric prompt | `retrieve()` returns null (not an error) |
| Biometric lockout (too many failures) | iOS falls back to passcode automatically |

**Acceptance Criteria**

- [ ] Master key stored in iOS Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
- [ ] Biometric ACL uses `.biometryCurrentSet` (tied to current enrollment)
- [ ] Device passcode fallback configured
- [ ] Not synced via iCloud Keychain
- [ ] Biometric prompt displays branded message: "Unlock AgentContext"
- [ ] User cancellation returns null (no crash, no error thrown)
- [ ] Changed biometrics after storage invalidate access (forces re-transfer/recovery)
- [ ] `exists()` does not trigger biometric prompt
- [ ] `getBackendInfo()` returns `{ platform: 'ios', backend: 'keychain', hardwareBacked: true }`
- [ ] Missing passcode throws `DeviceNotSecureError` with actionable message

**Edge Cases**

- E-5: Biometrics changed after key storage -- `retrieve()` returns null, caller offers three recovery paths (passcode fallback, QR re-transfer, passphrase recovery)
- App reinstall with keychain entry persisting (E-1) -- `exists()` returns true, generation is skipped

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 5: Android Keystore Storage

**Description**

Implement Android Keystore integration for master key storage. Uses a TEE/StrongBox-backed wrapping key to encrypt the master key, with biometric authentication required for every access. Falls back gracefully through StrongBox -> TEE -> software-backed Keystore.

**Prerequisites/Inputs**

- Task 1 complete (master key serialization format)
- `react-native-keychain` (>= 8.0) installed
- Android device or emulator (API 23+)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/keychain/android-keystore.ts` | Create | Android Keystore storage implementation |
| `tests/crypto/keychain/android-keystore.test.ts` | Create | Tests (mocked for non-Android) |

Android-specific configuration:

| Attribute | Value |
|---|---|
| Service name | `"com.agentcontext.masterkey"` |
| Security level | `SECURE_HARDWARE` (prefers StrongBox, falls back to TEE) |
| Access control | `BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` |
| Storage type | `AES_GCM` |
| Auth timeout | 0 (every access requires authentication) |
| Invalidate on enrollment change | true |

Storage strategy (wrapping key approach):

```
1. React Native Keychain generates AES-256-GCM wrapping key in Android Keystore (TEE/StrongBox)
2. Master key (base64url string) is encrypted by wrapping key
3. Ciphertext stored in app-private storage (EncryptedSharedPreferences)
4. On retrieval: biometric auth -> Keystore unwraps -> master key returned
```

StrongBox detection and fallback:

```typescript
async function detectKeystoreCapability(): Promise<'strongbox' | 'tee' | 'software'> {
  // react-native-keychain reports this via getSecurityLevel()
  const level = await Keychain.getSecurityLevel();
  if (level === Keychain.SECURITY_LEVEL.SECURE_HARDWARE) {
    // Further distinguish StrongBox vs TEE via native module
    return hasStrongBox ? 'strongbox' : 'tee';
  }
  return 'software';
}
```

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `storeMasterKeyAndroid` | `(userId: string, masterKeyBase64: string) => Promise<void>` | Store via `Keychain.setGenericPassword` with TEE/StrongBox |
| `retrieveMasterKeyAndroid` | `(userId: string) => Promise<string \| null>` | Retrieve with biometric prompt; return null on cancel |
| `deleteMasterKeyAndroid` | `(userId: string) => Promise<void>` | Remove keystore entry |
| `existsMasterKeyAndroid` | `(userId: string) => Promise<boolean>` | Check existence without biometric |
| `detectKeystoreCapability` | `() => Promise<'strongbox' \| 'tee' \| 'software'>` | Detect hardware backing level |

Local config stored in `AsyncStorage` for diagnostics:

```json
{
  "keystoreType": "strongbox",
  "keystoreInitializedAt": "2026-02-22T10:00:00Z",
  "androidApiLevel": 33
}
```

**Acceptance Criteria**

- [ ] Master key stored using Android Keystore with TEE or StrongBox backing
- [ ] StrongBox preferred, automatic fallback to TEE, then software
- [ ] Biometric authentication required for every key access (timeout=0)
- [ ] Device credential (PIN/pattern/password) accepted as fallback
- [ ] Key invalidated when biometric enrollment changes
- [ ] Minimum supported Android API level is 23 (Android 6.0)
- [ ] StrongBox availability detected at runtime (not assumed)
- [ ] Devices without TEE display security warning but still function
- [ ] `keystoreType` recorded in local config for diagnostics
- [ ] User cancellation of biometric prompt returns null (no crash)
- [ ] `getBackendInfo()` returns correct `hardwareBacked` based on detection

**Edge Cases**

- E-5: Biometrics changed -- key invalidated, user prompted for recovery
- StrongBox throws `StrongBoxUnavailableException` -- catch and retry without StrongBox flag
- Very old device (API 23-27) -- limited `setUserAuthenticationParameters`, use `setUserAuthenticationValidityDurationSeconds(0)` instead

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 6: Desktop Keychain Storage

**Description**

Implement desktop keychain integration across macOS (Keychain Services), Windows (DPAPI), and Linux (Secret Service API). Uses Tauri plugin for the Rust backend with a TypeScript frontend interface. Includes a file-based encrypted fallback for headless Linux systems without GNOME Keyring or KWallet.

**Prerequisites/Inputs**

- Task 1 complete (master key serialization format)
- Tauri 2 desktop app framework
- Platform-specific Rust crates: `security-framework` (macOS), `windows` (Windows DPAPI), `keyring` (Linux)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src-tauri/src/keychain.rs` | Create | Rust backend for all three desktop platforms |
| `src-tauri/src/keychain_fallback.rs` | Create | File-based encrypted fallback for headless Linux |
| `src/crypto/keychain/desktop-keychain.ts` | Create | TypeScript frontend invoking Tauri commands |
| `tests/crypto/keychain/desktop-keychain.test.ts` | Create | Desktop keychain tests |

Tauri commands (Rust):

| Command | Description |
|---|---|
| `store_master_key(account: &str, key_data: &str)` | Store key in platform keychain |
| `retrieve_master_key(account: &str) -> Option<String>` | Retrieve key; returns None if not found |
| `delete_master_key(account: &str)` | Delete key from keychain |
| `get_keychain_info() -> KeychainInfo` | Return platform, backend type, hardware-backed status |

Platform backends:

**macOS (Keychain Services)**:
- Crate: `security-framework` (>= 2.0)
- Service name: `"com.agentcontext.masterkey"`
- Functions: `set_generic_password`, `get_generic_password`, `delete_generic_password`
- Properties: encrypted at rest with user login keychain password, locked on logout

**Windows (DPAPI)**:
- Crate: `windows` (Win32 Security Cryptography)
- Functions: `CryptProtectData` / `CryptUnprotectData`
- Storage path: `%APPDATA%\AgentContext\masterkey.dpapi`
- Scope: current user only (not `CRYPTPROTECT_LOCAL_MACHINE`)
- Properties: key derived from Windows login credentials

**Linux (Secret Service API)**:
- Crate: `keyring` (>= 2.0)
- Service name: `"com.agentcontext.masterkey"`
- Backends: GNOME Keyring, KWallet (auto-detected by `keyring` crate)
- Properties: encrypted with user login password

**Linux fallback (headless)**:
- Trigger: `keyring` crate throws "no backend available"
- Strategy: derive encryption key from `sha256(machine_id + ":" + uid)` where `machine_id` is read from `/etc/machine-id`
- Storage: `~/.config/agentcontext/masterkey.enc` (encrypted with derived key via XChaCha20-Poly1305)
- Warning displayed to user: "No desktop keychain found. Using file-based encryption."

TypeScript frontend:

```typescript
// src/crypto/keychain/desktop-keychain.ts
import { invoke } from '@tauri-apps/api/core';

class DesktopKeychainProvider implements KeychainProvider {
  async store(userId: string, masterKeyBase64: string): Promise<void> {
    await invoke('store_master_key', { account: userId, keyData: masterKeyBase64 });
  }
  async retrieve(userId: string): Promise<string | null> {
    try {
      return await invoke('retrieve_master_key', { account: userId });
    } catch {
      return null;
    }
  }
  async delete(userId: string): Promise<void> {
    await invoke('delete_master_key', { account: userId });
  }
  async exists(userId: string): Promise<boolean> {
    return (await this.retrieve(userId)) !== null;
  }
  async getBackendInfo(): Promise<KeychainBackendInfo> {
    return await invoke('get_keychain_info');
  }
}
```

**Acceptance Criteria**

- [ ] macOS: key stored in Keychain Services under `com.agentcontext.masterkey`
- [ ] Windows: key stored via DPAPI, scoped to current user, at `%APPDATA%\AgentContext\masterkey.dpapi`
- [ ] Linux: key stored via Secret Service API (GNOME Keyring or KWallet)
- [ ] Linux fallback: file-based encrypted storage when no Secret Service available
- [ ] Linux fallback warning displayed to user
- [ ] Tauri plugin provides unified Rust backend for all three platforms
- [ ] TypeScript frontend uses `invoke()` to call Tauri commands
- [ ] `KeychainProvider` interface abstraction works across all platforms
- [ ] Backend info (platform, backend type, hardware-backed) is queryable
- [ ] All implementations handle "key not found" gracefully (return null, not error)
- [ ] Windows DPAPI file stored at correct path

**Edge Cases**

- E-6: Windows password reset (admin reset, not user change) causes DPAPI loss -- `retrieve()` returns null, user prompted for passphrase recovery, key re-protected with new DPAPI context
- E-11: No Secret Service on headless Linux -- fallback to file-based encryption with warning
- macOS Keychain locked (user logged out) -- `retrieve()` returns null, app waits for unlock

**Estimated Effort**: L (Large) -- 8-12 hours (three platform backends + fallback + Tauri integration)

---

### Task 7: QR Key Transfer Protocol

**Description**

Implement the cross-device key transfer protocol using QR codes with ephemeral Curve25519 key exchange. Device A (has master key) generates a QR code containing an ephemeral public key and relay connection info. Device B (new device) scans the QR, establishes an ECDH shared secret, and receives the encrypted master key over the relay channel. Forward secrecy is guaranteed by ephemeral keys.

**Prerequisites/Inputs**

- Task 1 complete (master key types and serialization)
- Task 3 complete (encryption primitives for XSalsa20-Poly1305 transfer encryption)
- WebSocket relay server accessible at `wss://relay.agentcontext.dev`
- QR code rendering library (e.g., `react-native-qrcode-svg` for mobile, `qrcode` npm for web)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/key-transfer/protocol.ts` | Create | Core protocol state machine (sender + receiver) |
| `src/crypto/key-transfer/qr-payload.ts` | Create | QR payload encoding/decoding/validation |
| `src/crypto/key-transfer/ephemeral-keys.ts` | Create | Curve25519 keypair generation and ECDH |
| `src/crypto/key-transfer/relay-client.ts` | Create | WebSocket relay room management |
| `tests/crypto/key-transfer/protocol.test.ts` | Create | Full protocol simulation tests |
| `tests/crypto/key-transfer/qr-payload.test.ts` | Create | QR payload format tests |

QR payload JSON structure:

```typescript
// src/crypto/key-transfer/qr-payload.ts
interface QrPayload {
  v: 1;                    // Protocol version
  p: string;               // base64url-encoded 32-byte Curve25519 public key
  r: string;               // Relay room ID (UUID v4)
  u: string;               // Relay WebSocket URL
  t: number;               // Unix timestamp (seconds) for expiry checking
  h: string;               // First 8 bytes of HMAC-SHA256(payload_without_h, pubkey) as hex
}
```

Maximum QR payload size: ~300 bytes (well within QR capacity at error correction level M).

Ephemeral key exchange functions:

| Function | Signature | Description |
|---|---|---|
| `generateEphemeralKeyPair` | `() => { publicKey: Uint8Array, secretKey: Uint8Array }` | `sodium.crypto_box_keypair()` |
| `deriveSharedKey` | `(mySecret: Uint8Array, theirPublic: Uint8Array) => Uint8Array` | `crypto_scalarmult` then `crypto_generichash` (BLAKE2b) to derive 32-byte symmetric key |
| `encryptForTransfer` | `(masterKey: Uint8Array, sharedKey: Uint8Array) => Uint8Array` | XSalsa20-Poly1305 via `crypto_secretbox_easy`, prepend 24-byte nonce |
| `decryptFromTransfer` | `(payload: Uint8Array, sharedKey: Uint8Array) => Uint8Array` | Split nonce, decrypt via `crypto_secretbox_open_easy` |

Protocol state machine (sender -- Device A):

```
IDLE -> GENERATING_KEYPAIR -> AWAITING_SCAN -> RECEIVED_PEER_KEY ->
  COMPUTING_SHARED -> SENDING_KEY -> AWAITING_ACK -> COMPLETE | TIMEOUT | ERROR
```

Protocol state machine (receiver -- Device B):

```
IDLE -> SCANNING -> PARSED_QR -> CONNECTING_RELAY -> SENDING_PUBKEY ->
  AWAITING_KEY -> DECRYPTING -> STORING -> SENDING_ACK -> COMPLETE | TIMEOUT | ERROR
```

Timeout configuration:

| Condition | Timeout | Action |
|---|---|---|
| QR displayed, not scanned | 5 minutes | Destroy ephemeral keys, close relay room |
| ECDH handshake in progress | 30 seconds | Abort, destroy keys |
| Relay disconnects mid-transfer | 10 seconds | Reconnect once; if fail, abort |
| User cancels on either device | Immediate | Destroy keys, close room |

QR payload validation:

```typescript
function validateQrPayload(payload: QrPayload): boolean {
  if (payload.v !== 1) return false;
  if (!payload.p || !payload.r || !payload.u) return false;
  const publicKey = sodium.from_base64(payload.p, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (publicKey.length !== 32) return false;
  // Check expiry: payload.t + 300 (5 min) > now
  if (payload.t + 300 < Math.floor(Date.now() / 1000)) return false;
  // Verify HMAC integrity
  return verifyPayloadHmac(payload);
}
```

**Acceptance Criteria**

- [ ] QR code contains ephemeral Curve25519 public key, relay room ID, relay URL, and timestamp
- [ ] QR code does NOT contain the master key or any derived secret
- [ ] Ephemeral keypairs generated via `sodium.crypto_box_keypair()`
- [ ] Shared key derived via Curve25519 ECDH followed by BLAKE2b hashing
- [ ] Master key encrypted with XSalsa20-Poly1305 using the shared key
- [ ] Both devices destroy ephemeral keys after transfer (success or failure)
- [ ] QR code expires after 5 minutes if not scanned
- [ ] ECDH handshake times out after 30 seconds
- [ ] User can cancel on either device at any time
- [ ] Successful transfer confirmed with encrypted ACK message
- [ ] Relay room closed after transfer completes
- [ ] QR payload includes HMAC for integrity verification
- [ ] Expired QR code scan shows "Transfer expired" message

**Edge Cases**

- E-3: QR code scanned after expiry -- relay room closed, Device B shows error message
- E-4: Relay disconnects mid-transfer -- reconnect once within 10 seconds, abort on failure
- E-10: Multiple concurrent transfers -- each QR creates separate relay room and ephemeral keys; no conflict

**Estimated Effort**: L (Large) -- 10-14 hours (protocol state machine, relay integration, QR encoding, timeouts)

---

### Task 8: Key Backup Prompt & Recovery Flow

**Description**

Implement the mandatory key backup flow that runs during initial key generation. The user creates a recovery passphrase, the master key is encrypted with a passphrase-derived key, and the user verifies the passphrase by re-entering it and confirming decryption succeeds. This includes passphrase strength validation using `zxcvbn`, the unrecoverability warning, and the encrypted backup file format.

**Prerequisites/Inputs**

- Task 1 complete (master key generation)
- Task 2 complete (Argon2id passphrase derivation)
- Task 3 complete (XChaCha20-Poly1305 encryption)
- `zxcvbn` (>= 4.4) installed for passphrase strength estimation

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/backup/passphrase-validator.ts` | Create | Passphrase strength validation with zxcvbn |
| `src/crypto/backup/backup-manager.ts` | Create | Create, verify, and restore encrypted backups |
| `src/crypto/backup/common-passwords.ts` | Create | Top 10,000 common passwords list (or load from bundled file) |
| `tests/crypto/backup/passphrase-validator.test.ts` | Create | Passphrase validation tests |
| `tests/crypto/backup/backup-manager.test.ts` | Create | Backup create/verify/restore tests |

Passphrase validation rules:

| Rule | Threshold | Implementation |
|---|---|---|
| Minimum length | 12 characters | `passphrase.length >= 12` |
| Maximum length | 1024 characters | `passphrase.length <= 1024` |
| Strength score | zxcvbn >= 3 | `zxcvbn(passphrase).score >= 3` |
| Common password check | Top 10,000 rejected | Set lookup before zxcvbn (fast rejection) |
| Unicode | Allowed, NFC normalized | `passphrase.normalize('NFC')` |

Passphrase validator interface:

```typescript
// src/crypto/backup/passphrase-validator.ts
interface PassphraseValidation {
  isValid: boolean;
  score: number;           // 0-4 (zxcvbn scale)
  crackTimeDisplay: string;
  feedback: string[];      // Improvement suggestions
  failReasons: string[];   // Why it was rejected (empty if valid)
}

function validatePassphrase(passphrase: string): PassphraseValidation;
```

Encrypted backup file format:

```json
// ~/.claude-context/backup/master-key.meta.json (NOT encrypted - public params)
{
  "version": 1,
  "algorithm": "argon2id",
  "params": { "m": 67108864, "t": 3, "p": 1 },
  "salt": "<base64url-encoded 16-byte salt>",
  "createdAt": "2026-02-22T10:00:00Z",
  "keyVersion": 1
}
```

```
// ~/.claude-context/backup/master-key.enc (binary encrypted envelope from Task 3)
[4-byte header][24-byte nonce][ciphertext+tag]
```

Associated data for backup encryption: `"backup:" + userId + ":" + backupVersion`

Backup flow functions:

| Function | Signature | Description |
|---|---|---|
| `validatePassphrase` | `(passphrase: string) => PassphraseValidation` | Validate against all rules |
| `createBackup` | `(masterKey: MasterKey, passphrase: string, userId: string) => Promise<EncryptedBackup>` | Derive key from passphrase, encrypt master key, return backup + metadata |
| `verifyBackup` | `(passphrase: string, backup: EncryptedBackup) => Promise<boolean>` | Re-derive key from passphrase, attempt decrypt, return success/failure |
| `restoreFromBackup` | `(passphrase: string, backup: EncryptedBackup) => Promise<MasterKey>` | Full restore: derive key, decrypt, return master key |
| `saveBackupToFile` | `(backup: EncryptedBackup, basePath: string) => Promise<void>` | Write `master-key.enc` and `master-key.meta.json` to `basePath/backup/` |
| `loadBackupFromFile` | `(basePath: string) => Promise<EncryptedBackup>` | Read and parse backup files |

Backup flow orchestration (called during initial setup):

```
1. generateMasterKey()
2. Store in keychain (Tasks 4-6)
3. Display unrecoverability warning text
4. Prompt: "Create a recovery passphrase"
5. validatePassphrase(passphrase) -- loop until valid
6. Prompt: "Confirm your passphrase" -- must match
7. createBackup(masterKey, passphrase, userId)
8. saveBackupToFile(backup, GC_BASE)
9. Recovery test: prompt passphrase AGAIN
10. verifyBackup(passphrase, backup)
11. If verify succeeds: backup confirmed, proceed
12. If verify fails: restart from step 4
```

Unrecoverability warning text (constant string):

```
WARNING: This passphrase is the ONLY way to recover your data if you lose
all your devices. AgentContext cannot reset your passphrase or decrypt your
data. If you lose both your passphrase and all devices, your data is
permanently and irrecoverably encrypted.

We recommend:
- Writing the passphrase on paper and storing it securely
- Saving it in a password manager (1Password, Bitwarden, etc.)
- Do NOT store it in an unencrypted file on your computer
```

**Acceptance Criteria**

- [ ] User prompted to create recovery passphrase during first key generation
- [ ] Passphrase must be at least 12 characters
- [ ] Passphrase must score 3+ on zxcvbn scale
- [ ] Top 10,000 common passwords rejected
- [ ] User confirms passphrase by re-entering
- [ ] Recovery test: user enters passphrase a third time, system verifies decryption succeeds
- [ ] If recovery test fails, user must restart passphrase setup
- [ ] Unrecoverability warning displayed prominently
- [ ] Unicode passphrases supported (NFC normalization applied)
- [ ] Passphrase zeroed from memory after derivation (overwrite string contents)
- [ ] Encrypted backup stored at `~/.claude-context/backup/master-key.enc`
- [ ] Metadata (salt, algorithm, params) stored at `~/.claude-context/backup/master-key.meta.json`
- [ ] `restoreFromBackup()` successfully recovers the master key with correct passphrase
- [ ] `restoreFromBackup()` with wrong passphrase throws `DecryptionFailedError`

**Edge Cases**

- E-12: Common passphrase rejected -- "password123456" returns `isValid: false` with feedback
- Low-memory device during backup creation -- Argon2id fallback params from Task 2 are used
- User enters different passphrase on confirmation -- "Passphrases do not match" error, re-prompt

**Estimated Effort**: L (Large) -- 8-10 hours (validation, backup format, recovery flow, zxcvbn integration)

---

### Task 9: E2EE Relay Channel

**Description**

Implement the end-to-end encrypted relay channel for syncing data between devices. The relay server is a blind pipe -- it forwards encrypted blobs without any ability to decrypt. Each sync session derives a unique symmetric key from the master key and a session-specific identifier. Messages include sequence numbers for ordering and gap detection.

**Prerequisites/Inputs**

- Task 1 complete (master key)
- Task 3 complete (XChaCha20-Poly1305 encryption)
- WebSocket relay server at `wss://relay.agentcontext.dev`

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/crypto/relay/session-key.ts` | Create | Session key derivation from master key |
| `src/crypto/relay/relay-channel.ts` | Create | Encrypted WebSocket channel with message framing |
| `src/crypto/relay/message-envelope.ts` | Create | Relay message envelope format |
| `tests/crypto/relay/session-key.test.ts` | Create | Session key derivation tests |
| `tests/crypto/relay/relay-channel.test.ts` | Create | Channel encrypt/decrypt tests |

Session key derivation:

```typescript
// src/crypto/relay/session-key.ts
function deriveRelaySessionKey(
  masterKey: Uint8Array,
  sessionId: string,
  purpose: 'send' | 'receive'
): Uint8Array {
  const context = new TextEncoder().encode(
    `agentcontext-relay-${purpose}-${sessionId}`
  );
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,  // 32 bytes output
    context,
    masterKey  // key parameter for keyed BLAKE2b
  );
}
```

Key properties:
- Same master key + same session ID + same purpose = same session key (deterministic)
- Different session IDs produce different keys (replay protection across sessions)
- Separate send/receive keys prevent reflection attacks

Relay message envelope:

```typescript
// src/crypto/relay/message-envelope.ts
interface RelayMessage {
  seq: number;            // Monotonically increasing per session
  type: 'event' | 'projection' | 'ack' | 'control';
  payload: Uint8Array;    // Already-encrypted event/projection data
  timestamp: number;      // Unix epoch milliseconds
}
```

The full message is JSON-serialized, then encrypted with the session key, producing an opaque blob for the relay:

```
Client A:
  1. Build RelayMessage { seq, type, payload, timestamp }
  2. JSON.stringify(message)
  3. encrypt(messageBytes, sessionKey)  // XChaCha20-Poly1305 from Task 3
  4. WebSocket.send(encryptedBlob)

Relay:
  5. Forward encryptedBlob to room peers (zero knowledge)

Client B:
  6. WebSocket.onmessage(encryptedBlob)
  7. decrypt(encryptedBlob, sessionKey)
  8. JSON.parse(decryptedBytes) -> RelayMessage
  9. Validate seq (must be > last seen seq)
  10. Process payload
```

Functions to implement:

| Function | Signature | Description |
|---|---|---|
| `deriveRelaySessionKey` | `(masterKey: Uint8Array, sessionId: string, purpose: 'send' \| 'receive') => Uint8Array` | BLAKE2b keyed hash derivation |
| `encryptRelayMessage` | `(message: RelayMessage, sessionKey: Uint8Array) => Uint8Array` | Serialize + encrypt |
| `decryptRelayMessage` | `(encrypted: Uint8Array, sessionKey: Uint8Array) => RelayMessage` | Decrypt + deserialize + validate |
| `createRelayChannel` | `(wsUrl: string, roomId: string, sessionKey: Uint8Array) => RelayChannel` | Create encrypted WebSocket channel |

`RelayChannel` class:

```typescript
class RelayChannel {
  private ws: WebSocket;
  private sendSeq: number = 0;
  private recvSeq: number = 0;
  private sessionKey: Uint8Array;

  send(type: string, payload: Uint8Array): void;
  onMessage(handler: (msg: RelayMessage) => void): void;
  close(): void;
  reconnect(): Promise<void>;  // Reconnect with same session key
}
```

**Acceptance Criteria**

- [ ] Relay session keys derived from master key using BLAKE2b keyed hash
- [ ] Each sync session uses a unique session key (master key + session ID)
- [ ] Separate send/receive keys prevent reflection attacks
- [ ] All data sent to relay encrypted with XChaCha20-Poly1305
- [ ] Relay server never has access to plaintext or key material
- [ ] Messages include sequence numbers for ordering and gap detection
- [ ] Out-of-order messages detected (seq <= lastRecvSeq)
- [ ] Replayed messages from previous sessions fail decryption (different session key)
- [ ] WebSocket connection uses TLS (`wss://`)
- [ ] Connection drops detected; reconnect with same session key
- [ ] `deriveRelaySessionKey(mk, sid, 'send')` on Device A equals `deriveRelaySessionKey(mk, sid, 'receive')` on Device B (and vice versa) -- NOT true; each device uses its own send/receive keys, so protocol must handle key direction

**Edge Cases**

- Relay disconnects mid-sync -- reconnect once within 10 seconds, resume from last acknowledged sequence
- Sequence gap detected -- request retransmission of missing messages (control message)
- Session key mismatch (devices have different master keys) -- decryption fails on first message, abort with clear error

**Estimated Effort**: L (Large) -- 8-12 hours (key derivation, message framing, WebSocket management, reconnection logic)

---

### Task 10: Path Sandboxing

**Description**

Implement filesystem sandboxing for the daemon HTTP server. All file access is restricted to the AgentContext data directory (`~/.claude-context/`). The sandbox prevents path traversal attacks (`..\`, symlinks, null bytes, URL encoding) using an allowlist approach -- only paths resolving within the sandbox root are accessible.

**Prerequisites/Inputs**

- Daemon HTTP server exists (Story F4)
- Sandbox root path: `process.env.CLAUDE_CONTEXT_PATH || path.join(os.homedir(), '.claude-context')`

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/server/security/path-sandbox.ts` | Create | `PathSandbox` class with path resolution and validation |
| `src/server/security/errors.ts` | Create | `PathTraversalError` custom error class |
| `tests/server/security/path-sandbox.test.ts` | Create | Extensive path traversal attack tests |

`PathSandbox` class:

```typescript
// src/server/security/path-sandbox.ts
class PathSandbox {
  private readonly root: string;  // Absolute, resolved, realpath'd

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
  }

  resolve(requestedPath: string): string {
    // 1. Reject null bytes
    if (requestedPath.includes('\0')) {
      throw new PathTraversalError('Null byte in path');
    }

    // 2. Join with sandbox root
    const joined = path.join(this.root, requestedPath);

    // 3. Resolve to absolute (handles .., ., etc.)
    const resolved = path.resolve(joined);

    // 4. Check resolved path starts with sandbox root
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new PathTraversalError(
        `Path traversal blocked: "${requestedPath}" resolves outside sandbox`
      );
    }

    // 5. If file exists, resolve symlinks and re-check
    try {
      const real = fs.realpathSync(resolved);
      if (real !== this.root && !real.startsWith(this.root + path.sep)) {
        throw new PathTraversalError(
          `Symlink traversal blocked: "${requestedPath}" -> "${real}" outside sandbox`
        );
      }
      return real;
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      // File doesn't exist yet (write operation) -- return resolved path
      return resolved;
    }
  }

  getRoot(): string {
    return this.root;
  }
}
```

Attack vectors blocked:

| Attack | Input | Blocked By |
|---|---|---|
| `..` traversal | `../../etc/passwd` | `path.resolve` + `startsWith` check |
| URL-encoded traversal | `%2e%2e%2f` | HTTP framework decodes before reaching sandbox |
| Double-encoded | `%252e%252e%252f` | Double-decode detection at HTTP layer |
| Null byte injection | `file.json%00.png` | Explicit null byte check |
| Symlink escape | `events/link -> /etc/` | `realpathSync` re-check after initial resolve |
| Backslash (Windows) | `..\..\etc` | `path.resolve` normalizes on all platforms |

**Acceptance Criteria**

- [ ] All file serving restricted to sandbox root directory
- [ ] `../../etc/passwd` blocked with `PathTraversalError`
- [ ] URL-encoded path traversal blocked
- [ ] Null byte injection blocked
- [ ] Symlinks pointing outside sandbox blocked
- [ ] Symlinks within sandbox that stay within sandbox allowed
- [ ] `fs.realpathSync` used to resolve symlinks before bounds check
- [ ] Allowlist approach: only paths within sandbox root accessible
- [ ] `PathTraversalError` thrown for all violations (specific error, not generic)
- [ ] Sandbox root itself is accessible (`resolve("")` and `resolve(".")` return root)
- [ ] Non-existent paths within sandbox allowed (for write operations)

**Edge Cases**

- E-7: Symlink `~/.claude-context/events/link -> /etc/shadow` -- `realpathSync` resolves to `/etc/shadow`, `startsWith` check fails, `PathTraversalError` thrown
- Sandbox root is a symlink itself -- constructor resolves it via `realpathSync`
- Race condition (TOCTOU): file is replaced with symlink between resolve and open -- mitigated by `O_NOFOLLOW` flag on actual file open (documented as a defense-in-depth recommendation)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 11: Host Allowlisting & CORS

**Description**

Implement HTTP server middleware for host header validation (DNS rebinding protection) and CORS configuration. Every request to the daemon HTTP server must have a `Host` header matching an allowlist. CORS headers are set only for allowed origins. Security headers (nosniff, DENY, CSP, no-referrer, no-store) are added to every response.

**Prerequisites/Inputs**

- Daemon HTTP server exists (Story F4)
- Node.js `http` module (no Express dependency assumed)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/server/security/host-allowlist.ts` | Create | Host header validation middleware |
| `src/server/security/cors.ts` | Create | CORS middleware with origin allowlist |
| `src/server/security/security-headers.ts` | Create | Security response headers middleware |
| `src/server/security/middleware.ts` | Create | Composed security middleware stack |
| `tests/server/security/host-allowlist.test.ts` | Create | Host validation tests |
| `tests/server/security/cors.test.ts` | Create | CORS tests |

Allowed hosts (default):

```typescript
const DEFAULT_ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
// Configurable via config: config.security.allowedHosts: string[]
```

Allowed origins (default):

```typescript
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:4567',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4567',
  'tauri://localhost',
  'https://tauri.localhost',
]);
// Configurable via config: config.security.allowedOrigins: string[]
```

Middleware functions:

| Function | Signature | Description |
|---|---|---|
| `validateHost` | `(req: IncomingMessage) => boolean` | Strip port from Host header, check against allowlist |
| `hostCheckMiddleware` | `(req, res, next) => void` | 403 on invalid Host |
| `corsMiddleware` | `(req, res, next) => void` | Set CORS headers for allowed origins, handle preflight OPTIONS |
| `securityHeadersMiddleware` | `(req, res, next) => void` | Set X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy, Cache-Control |
| `createSecurityMiddleware` | `(config?: SecurityConfig) => (req, res, next) => void` | Compose all three middlewares into a single middleware |

Security headers set on every response:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `default-src 'self'` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store` |

CORS behavior:

- If `Origin` header is present and in allowed origins: set `Access-Control-Allow-Origin` to that origin
- Set `Vary: Origin` when CORS headers are applied
- Handle OPTIONS preflight: return 204 with CORS headers
- `Access-Control-Allow-Methods`: `GET, POST, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type, Authorization, X-Download-Token`
- `Access-Control-Max-Age`: `86400` (24 hours)

**Acceptance Criteria**

- [ ] Host header validated against allowlist for every request
- [ ] Missing Host header rejected with 403
- [ ] Host not in allowlist rejected with 403 (DNS rebinding protection)
- [ ] CORS headers set only for allowed origins
- [ ] OPTIONS preflight handled with 204 and correct CORS headers
- [ ] `Vary: Origin` set when CORS headers applied
- [ ] X-Content-Type-Options: nosniff on all responses
- [ ] X-Frame-Options: DENY on all responses
- [ ] Content-Security-Policy: default-src 'self' on all responses
- [ ] Referrer-Policy: no-referrer on all responses
- [ ] Cache-Control: no-store on all responses
- [ ] Configuration allows extending allowed hosts list (for LAN access)
- [ ] Configuration allows extending allowed origins list
- [ ] Tauri app origin (`tauri://localhost`) in default allowed origins

**Edge Cases**

- E-8: DNS rebinding attack -- `Host: evil.com` rejected by `validateHost()`
- Host header with port: `localhost:4567` -- strip port, check `localhost` against allowlist
- Multiple `Host` headers (HTTP smuggling attempt) -- use first `Host` header value (Node.js behavior)
- IPv6 Host: `[::1]:4567` -- strip port, check `[::1]` against allowlist

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 12: Download Tokens

**Description**

Implement single-use, time-limited download tokens for file downloads from the daemon. Tokens are 256-bit random values, scoped to a specific file path, valid for 5 minutes, and consumed on first use. Token storage is in-memory only (no persistence to disk). Includes periodic cleanup of expired tokens.

**Prerequisites/Inputs**

- Task 10 complete (path sandbox for validating file paths before token generation)
- Daemon HTTP server exists (Story F4)
- Node.js `crypto` module for token generation

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/server/security/download-tokens.ts` | Create | `DownloadTokenManager` class |
| `src/server/security/token-errors.ts` | Create | `TokenError` custom error class |
| `src/server/routes/download.ts` | Create | HTTP endpoints for token generation and download |
| `tests/server/security/download-tokens.test.ts` | Create | Token lifecycle tests |

`DownloadTokenManager` class:

```typescript
// src/server/security/download-tokens.ts
interface DownloadToken {
  token: string;          // 64 hex characters (32 bytes)
  filePath: string;       // Absolute path (validated against sandbox)
  createdAt: number;      // Unix epoch ms
  expiresAt: number;      // Unix epoch ms (createdAt + 5 min)
  used: boolean;
}

class DownloadTokenManager {
  private tokens: Map<string, DownloadToken>;
  private readonly TTL_MS = 5 * 60 * 1000;  // 5 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor();
  generate(filePath: string): string;
  consume(token: string, requestedPath: string): string;  // Returns authorized path or throws
  destroy(): void;  // Clear interval and all tokens
  private cleanup(): void;  // Remove expired tokens (runs every 60s)
}
```

Token generation:

```typescript
generate(filePath: string): string {
  const token = crypto.randomBytes(32).toString('hex');  // 64 hex chars
  const now = Date.now();
  this.tokens.set(token, {
    token,
    filePath,
    createdAt: now,
    expiresAt: now + this.TTL_MS,
    used: false,
  });
  return token;
}
```

Token consumption (validates and consumes in one atomic operation):

```typescript
consume(token: string, requestedPath: string): string {
  const record = this.tokens.get(token);
  if (!record) throw new TokenError('Invalid token');
  if (record.used) { this.tokens.delete(token); throw new TokenError('Token already used'); }
  if (Date.now() > record.expiresAt) { this.tokens.delete(token); throw new TokenError('Token expired'); }
  if (record.filePath !== requestedPath) throw new TokenError('Token not valid for requested path');
  record.used = true;
  this.tokens.delete(token);  // Remove immediately after consumption
  return record.filePath;
}
```

HTTP endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/download-token` | Request body: `{ filePath: string }`. Validates path against sandbox. Returns `{ token, expiresIn, downloadUrl }`. |
| `GET` | `/api/download?token=<token>&path=<path>` | Consume token. If valid, stream file. If invalid/expired/used, return 403. |

HTTP integration flow:

```
1. Client: POST /api/download-token { filePath: "events/myapp-c9d1e4/sess1/001.json" }
2. Server: sandbox.resolve(filePath) -- validates within sandbox
3. Server: fs.existsSync(resolvedPath) -- verify file exists
4. Server: tokenManager.generate(resolvedPath) -- create token
5. Server: respond { token: "a1b2c3...", expiresIn: 300, downloadUrl: "/api/download?token=a1b2c3..." }
6. Client: GET /api/download?token=a1b2c3...&path=<resolvedPath>
7. Server: tokenManager.consume(token, path) -- validate and consume
8. Server: res.sendFile(authorizedPath)  -- stream file
9. Token is now consumed -- second request with same token returns 403
```

**Acceptance Criteria**

- [ ] Tokens are 32 bytes (64 hex characters) generated via `crypto.randomBytes`
- [ ] Tokens expire after 5 minutes
- [ ] Tokens are single-use (consumed on first successful download)
- [ ] Tokens scoped to specific file path (cannot be reused for different files)
- [ ] Expired tokens rejected with 403 and message "Token expired"
- [ ] Already-used tokens rejected with 403 and message "Token already used"
- [ ] Wrong-path tokens rejected with 403 and message "Token not valid for requested path"
- [ ] Invalid (unknown) tokens rejected with 403 and message "Invalid token"
- [ ] Expired tokens cleaned up from memory every 60 seconds
- [ ] Token generation endpoint validates file path against sandbox (Task 10)
- [ ] Token generation endpoint verifies file exists (404 if not)
- [ ] Token storage is in-memory only (no disk persistence)
- [ ] `TokenError` thrown for all validation failures
- [ ] `destroy()` clears interval and all tokens (for graceful shutdown)

**Edge Cases**

- E-9: Token used twice -- second request returns 403 "Token already used"
- E-13: Large file download with expired token -- token consumed at start of download, expiry irrelevant after streaming begins
- 1000 concurrent token generations -- all tokens unique (crypto.randomBytes guarantees)
- Server restart clears all tokens -- expected behavior (in-memory only); clients must request new tokens

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 13: Integration Tests

**Description**

Create comprehensive integration tests that exercise the full security stack end-to-end. Tests cover cryptographic roundtrips, key lifecycle, passphrase backup/recovery, QR transfer simulation, path sandboxing, host allowlisting, and download token flows. Also includes performance benchmarks for encryption throughput.

**Prerequisites/Inputs**

- All Tasks 1-12 complete
- `libsodium-wrappers`, `zxcvbn` available
- Test framework (Jest or Vitest)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `tests/crypto/integration/key-lifecycle.test.ts` | Create | Full key generate -> store -> retrieve -> encrypt -> decrypt |
| `tests/crypto/integration/backup-recovery.test.ts` | Create | Generate key -> backup with passphrase -> restore from passphrase |
| `tests/crypto/integration/qr-transfer-simulation.test.ts` | Create | Simulate two-device QR transfer protocol |
| `tests/crypto/integration/relay-session.test.ts` | Create | Derive session keys, encrypt on A, decrypt on B |
| `tests/server/integration/security-stack.test.ts` | Create | Path sandbox + host check + CORS + download token combined |
| `tests/crypto/performance/encryption-benchmark.test.ts` | Create | Throughput benchmarks for encrypt/decrypt |
| `tests/crypto/security/no-key-leakage.test.ts` | Create | Verify keys don't appear in logs/errors |

Test case inventory (mapped to story test plan):

**Unit tests (T-1 through T-31):**

| Test ID | Description | Task |
|---|---|---|
| T-1 | `generateMasterKey()` returns 32-byte key | 1 |
| T-2 | `serializeMasterKey()` produces valid base64url | 1 |
| T-3 | Serialize/deserialize roundtrip | 1 |
| T-4 | `deriveKeyFromPassphrase()` produces 32-byte key | 2 |
| T-5 | Same passphrase + salt = same key | 2 |
| T-6 | Different salt = different key | 2 |
| T-7 | Encrypt/decrypt roundtrip for 0, 1, 1000, 1M bytes | 3 |
| T-8 | Decrypt with wrong key throws | 3 |
| T-9 | Decrypt with tampered ciphertext throws | 3 |
| T-10 | Decrypt with mismatched AD throws | 3 |
| T-11 | Encrypt same plaintext produces different ciphertext | 3 |
| T-12 | Envelope header correct version and algorithm | 3 |
| T-13 | `generateEphemeralKeyPair()` returns 32-byte keys | 7 |
| T-14 | ECDH: shared key symmetric for both parties | 7 |
| T-15 | `encryptForTransfer`/`decryptFromTransfer` roundtrip | 7 |
| T-16 | `decryptFromTransfer` with wrong key throws | 7 |
| T-17 | Passphrase < 12 chars rejected | 8 |
| T-18 | "password123456" rejected | 8 |
| T-19 | Strong 20-char passphrase accepted | 8 |
| T-20 | `PathSandbox.resolve()` blocks `../../etc/passwd` | 10 |
| T-21 | `PathSandbox.resolve()` blocks symlinks outside sandbox | 10 |
| T-22 | `PathSandbox.resolve()` allows paths within sandbox | 10 |
| T-23 | `PathSandbox.resolve()` allows sandbox root itself | 10 |
| T-24 | `validateHost()` accepts localhost, 127.0.0.1, [::1] | 11 |
| T-25 | `validateHost()` rejects evil.com | 11 |
| T-26 | `validateHost()` rejects missing Host header | 11 |
| T-27 | Token generate returns 64-char hex string | 12 |
| T-28 | Token consume returns file path on first use | 12 |
| T-29 | Token consume throws on second use | 12 |
| T-30 | Token consume throws after expiry | 12 |
| T-31 | Token consume throws on path mismatch | 12 |

**Integration tests (T-32 through T-40):**

| Test ID | Description | Tasks |
|---|---|---|
| T-32 | Full key lifecycle: generate -> store -> retrieve -> encrypt -> decrypt | 1, 3, 4/5/6 |
| T-33 | Full passphrase backup: generate -> derive -> encrypt -> re-derive -> decrypt | 1, 2, 3, 8 |
| T-34 | QR transfer simulation: A generates QR -> B parses -> ECDH -> transfer -> verify same key | 7 |
| T-35 | Relay session: derive keys on two clients -> encrypt on A -> decrypt on B | 9 |
| T-36 | Path sandbox with real filesystem: create dir, symlink outside, verify rejection | 10 |
| T-37 | Host allowlist with HTTP server: start server, test various Host headers | 11 |
| T-38 | Download token full flow: generate -> download -> reuse rejected | 12 |
| T-39 | 1000 concurrent tokens all unique | 12 |
| T-40 | 10 common passwords all rejected | 8 |

**Performance tests (T-49 through T-53):**

| Test ID | Description | Threshold |
|---|---|---|
| T-49 | Encrypt 10,000 events (1 KB each) | < 1 second on desktop |
| T-50 | Decrypt 10,000 events (1 KB each) | < 1 second on desktop |
| T-51 | Argon2id derivation time | < 5 seconds |
| T-52 | QR code generation + display | < 500ms |
| T-53 | End-to-end key transfer (simulated) | < 10 seconds |

**Security tests (T-54 through T-60):**

| Test ID | Description | Tasks |
|---|---|---|
| T-54 | Master key bytes not in any log output | 1 |
| T-55 | Passphrase not in any log output | 2, 8 |
| T-56 | Memory zeroed after `sodium.memzero()` (best-effort) | 1 |
| T-57 | Encrypted backup not decryptable with wrong passphrase | 8 |
| T-58 | QR code does not contain master key (parse and verify) | 7 |
| T-59 | Replay: resend relay message from old session, verify decryption fails | 9 |
| T-60 | Different ephemeral keys produce different shared secrets | 7 |

**Acceptance Criteria**

- [ ] All 31 unit tests pass (T-1 through T-31)
- [ ] All 9 integration tests pass (T-32 through T-40)
- [ ] All 5 performance benchmarks meet thresholds (T-49 through T-53)
- [ ] All 7 security tests pass (T-54 through T-60)
- [ ] Tests run without network access (QR transfer and relay are simulated locally)
- [ ] Tests do not modify the real `~/.claude-context/` or OS keychain
- [ ] Test isolation: temporary directories used for all filesystem operations

**Edge Cases**

- Platform-specific keychain tests (T-41 through T-48 from the story) are deferred to CI/CD pipelines that run on actual iOS/Android/macOS/Windows/Linux targets

**Estimated Effort**: XL (Extra Large) -- 12-16 hours (52+ test cases, performance benchmarks, security verification)

---

## File Summary

All file paths are relative to the project root.

| File | Action | Task(s) |
|---|---|---|
| `src/crypto/master-key.ts` | Create | 1 |
| `src/crypto/index.ts` | Create | 1 |
| `src/crypto/passphrase-kdf.ts` | Create | 2 |
| `src/crypto/encryption.ts` | Create | 3 |
| `src/crypto/envelope.ts` | Create | 3 |
| `src/crypto/keychain/types.ts` | Create | 4 |
| `src/crypto/keychain/ios-keychain.ts` | Create | 4 |
| `src/crypto/keychain/android-keystore.ts` | Create | 5 |
| `src-tauri/src/keychain.rs` | Create | 6 |
| `src-tauri/src/keychain_fallback.rs` | Create | 6 |
| `src/crypto/keychain/desktop-keychain.ts` | Create | 6 |
| `src/crypto/key-transfer/protocol.ts` | Create | 7 |
| `src/crypto/key-transfer/qr-payload.ts` | Create | 7 |
| `src/crypto/key-transfer/ephemeral-keys.ts` | Create | 7 |
| `src/crypto/key-transfer/relay-client.ts` | Create | 7 |
| `src/crypto/backup/passphrase-validator.ts` | Create | 8 |
| `src/crypto/backup/backup-manager.ts` | Create | 8 |
| `src/crypto/backup/common-passwords.ts` | Create | 8 |
| `src/crypto/relay/session-key.ts` | Create | 9 |
| `src/crypto/relay/relay-channel.ts` | Create | 9 |
| `src/crypto/relay/message-envelope.ts` | Create | 9 |
| `src/server/security/path-sandbox.ts` | Create | 10 |
| `src/server/security/errors.ts` | Create | 10 |
| `src/server/security/host-allowlist.ts` | Create | 11 |
| `src/server/security/cors.ts` | Create | 11 |
| `src/server/security/security-headers.ts` | Create | 11 |
| `src/server/security/middleware.ts` | Create | 11 |
| `src/server/security/download-tokens.ts` | Create | 12 |
| `src/server/security/token-errors.ts` | Create | 12 |
| `src/server/routes/download.ts` | Create | 12 |
| `tests/crypto/master-key.test.ts` | Create | 1 |
| `tests/crypto/passphrase-kdf.test.ts` | Create | 2 |
| `tests/crypto/encryption.test.ts` | Create | 3 |
| `tests/crypto/keychain/ios-keychain.test.ts` | Create | 4 |
| `tests/crypto/keychain/android-keystore.test.ts` | Create | 5 |
| `tests/crypto/keychain/desktop-keychain.test.ts` | Create | 6 |
| `tests/crypto/key-transfer/protocol.test.ts` | Create | 7 |
| `tests/crypto/key-transfer/qr-payload.test.ts` | Create | 7 |
| `tests/crypto/backup/passphrase-validator.test.ts` | Create | 8 |
| `tests/crypto/backup/backup-manager.test.ts` | Create | 8 |
| `tests/crypto/relay/session-key.test.ts` | Create | 9 |
| `tests/crypto/relay/relay-channel.test.ts` | Create | 9 |
| `tests/server/security/path-sandbox.test.ts` | Create | 10 |
| `tests/server/security/host-allowlist.test.ts` | Create | 11 |
| `tests/server/security/cors.test.ts` | Create | 11 |
| `tests/server/security/download-tokens.test.ts` | Create | 12 |
| `tests/crypto/integration/key-lifecycle.test.ts` | Create | 13 |
| `tests/crypto/integration/backup-recovery.test.ts` | Create | 13 |
| `tests/crypto/integration/qr-transfer-simulation.test.ts` | Create | 13 |
| `tests/crypto/integration/relay-session.test.ts` | Create | 13 |
| `tests/server/integration/security-stack.test.ts` | Create | 13 |
| `tests/crypto/performance/encryption-benchmark.test.ts` | Create | 13 |
| `tests/crypto/security/no-key-leakage.test.ts` | Create | 13 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone | Parallelism |
|-------|-------|-----------|-------------|
| **Phase 1: Crypto Core** | Task 1 (Master Key), Task 2 (KDF), Task 3 (Encryption) | Core crypto primitives available | Tasks 2 and 3 can start once Task 1 types are defined |
| **Phase 2: Key Storage** | Task 4 (iOS), Task 5 (Android), Task 6 (Desktop) | Keys can be securely stored on all platforms | All three tasks run in parallel |
| **Phase 3: Key Management** | Task 7 (QR Transfer), Task 8 (Backup/Recovery) | Cross-device key transfer and backup working | Tasks 7 and 8 can run in parallel |
| **Phase 4: Server Security** | Task 10 (Path Sandbox), Task 11 (Host Allowlist), Task 12 (Download Tokens) | Daemon HTTP server hardened | Tasks 10 and 11 in parallel; Task 12 after Task 10 |
| **Phase 5: E2EE Relay** | Task 9 (Relay Channel) | Encrypted sync channel working | After Phase 1 |
| **Phase 6: Validation** | Task 13 (Integration Tests) | All 52+ test cases passing | After all other tasks |

Phase 4 (server security) can start in parallel with Phase 2 and Phase 3 since it has no dependencies on the crypto key storage tasks.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| libsodium WASM bundle size (~200KB) increases app size | Medium | Low | Acceptable tradeoff for cross-platform crypto; already within Worker 10MB limit |
| Argon2id OOM on low-end mobile devices | Medium | Medium | Fallback params (32MB, t=6) with warning; second failure produces actionable error |
| react-native-keychain API differences across RN versions | Medium | Medium | Pin to specific version; integration tests on CI with actual devices |
| DPAPI data loss on Windows password reset (admin reset) | Low | High | Passphrase backup is the recovery path; document in onboarding |
| QR code too large for camera to scan | Low | Low | Payload is ~300 bytes, well within QR capacity; use error correction level M |
| Relay server unavailable during key transfer | Medium | Medium | QR transfer requires relay; document manual passphrase recovery as alternative |
| Key material appears in error stack traces | Medium | High | Custom error classes never include key bytes; global `unhandledRejection` handler scrubs output |
| Race condition in download token consumption | Low | Medium | `consume()` is synchronous (single-threaded Node.js); Map operations are atomic in V8 |
| Timing side-channel in token comparison | Low | Low | Use `crypto.timingSafeEqual` for token comparison instead of `===` |
| Missing Secret Service on Linux CI | Medium | Low | Mock keyring for tests; file-based fallback handles production headless environments |

---

## Notes for Implementation

1. **libsodium initialization is async** -- `await sodium.ready` must be called once at application startup before any crypto operation. Wrap in a singleton initializer.
2. **Memory zeroing in JavaScript is best-effort** -- `sodium.memzero()` overwrites the Uint8Array, but the garbage collector may have already copied the data. This is a known limitation of the JS runtime. Document it.
3. **Keychain access is platform-specific at build time** -- use dependency injection or factory pattern (`getKeychainProvider()`) to select the correct implementation. Never import platform-specific modules unconditionally.
4. **QR transfer is the happy path; passphrase recovery is the fallback** -- if the relay server is down, users must use passphrase recovery. This is an acceptable degradation.
5. **Token comparison must be constant-time** -- use `crypto.timingSafeEqual()` when comparing token strings to prevent timing attacks. Convert strings to Buffers first.
6. **Associated data prevents ciphertext swapping** -- always bind encryption to context. An event encrypted for `event_id=A` cannot be silently moved to `event_id=B` because the AD will not match on decryption.
7. **No custom RNG anywhere** -- all randomness comes from `sodium.randombytes_buf()` (which uses the OS CSPRNG) or `crypto.randomBytes()` (Node.js, also OS CSPRNG). Never use `Math.random()`.
8. **The server is adversarial by design** -- all code assumes the relay server and sync server are compromised. Zero trust: encrypt before send, verify after receive.

---

## Effort Estimates

| Task | Complexity | Estimate |
|---|---|---|
| Task 1: Master Key Generation | M | 4-6 hours |
| Task 2: Passphrase Derivation (Argon2id) | M | 4-6 hours |
| Task 3: XChaCha20-Poly1305 Encryption | M | 6-8 hours |
| Task 4: iOS Keychain Storage | M | 4-6 hours |
| Task 5: Android Keystore Storage | M | 4-6 hours |
| Task 6: Desktop Keychain Storage | L | 8-12 hours |
| Task 7: QR Key Transfer Protocol | L | 10-14 hours |
| Task 8: Key Backup Prompt & Recovery | L | 8-10 hours |
| Task 9: E2EE Relay Channel | L | 8-12 hours |
| Task 10: Path Sandboxing | M | 4-6 hours |
| Task 11: Host Allowlisting & CORS | M | 4-6 hours |
| Task 12: Download Tokens | M | 4-6 hours |
| Task 13: Integration Tests | XL | 12-16 hours |
| **Total** | | **~76-114 hours (~10-15 working days)** |
