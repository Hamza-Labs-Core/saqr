# Story 18: Security & Encryption

## Overview

Security & Encryption (F10) provides end-to-end encryption with a zero-knowledge server architecture for the AgentContext platform. No plaintext user data ever leaves the user's device. The server acts as a blind relay and encrypted blob store -- it cannot decrypt, inspect, or analyze any user content.

This story covers the full cryptographic stack: master key generation, passphrase-based key derivation, symmetric encryption of all event and projection data, platform-specific secure key storage (iOS Keychain, Android Keystore, desktop keychains), cross-device key transfer via QR code with ephemeral key exchange, encrypted backup and recovery, E2EE relay integration, and server-side access controls (path sandboxing, host allowlisting, download tokens).

**Guiding principle**: The client is the only trusted party. The server is adversarial by design -- it never holds key material, never sees plaintext, and cannot comply with requests to decrypt user data because it is technically unable to do so.

---

## Scope

### In Scope

- Master key generation (256-bit, libsodium)
- Passphrase-based key derivation (Argon2id)
- XChaCha20-Poly1305 authenticated encryption for all data at rest and in transit
- iOS Keychain integration with biometric gating
- Android Keystore integration with TEE/StrongBox backing
- Desktop keychain integration (macOS Keychain, Windows DPAPI, Linux Secret Service)
- QR-based cross-device key transfer with ephemeral Curve25519 exchange
- Key backup prompt and recovery flow
- E2EE relay channel (Paseo NaCl-based WebSocket)
- Path sandboxing for daemon file access
- Host allowlisting and DNS rebinding protection
- Single-use download tokens

### Out of Scope (Non-Goals)

- Key rotation (future story -- requires re-encryption of all data)
- Multi-user sharing / team key management
- Hardware security key (FIDO2/WebAuthn) integration
- Custom cipher suite selection (XChaCha20-Poly1305 is the only supported cipher)
- Certificate pinning for relay connections
- Encrypted search over ciphertext (future feature)
- Server-side key escrow or recovery (explicitly prohibited by design)
- Audit logging of cryptographic operations (separate story)

---

## Requirements

### 1. Master Key Generation (F10.1)

The master key is the root secret from which all encryption derives. It is generated exactly once per user account, stored in the platform keychain, and never transmitted in plaintext.

#### Specification

- **Algorithm**: 256-bit (32-byte) random key via libsodium `randombytes_buf`
- **Entropy source**: OS-provided CSPRNG (via libsodium, which uses `/dev/urandom` on Linux, `SecRandomCopyBytes` on macOS/iOS, `BCryptGenRandom` on Windows)
- **Format**: Raw 32-byte buffer; serialized as base64url (RFC 4648 section 5) for storage and display
- **Generation trigger**: First app launch when no existing key is found in the platform keychain
- **Uniqueness**: One master key per user identity. All devices share the same master key.

#### Implementation

```typescript
import sodium from 'libsodium-wrappers';

interface MasterKey {
  raw: Uint8Array;        // 32 bytes, never logged or serialized directly
  createdAt: string;      // ISO 8601 timestamp
  version: number;        // Key version, always 1 for initial generation
}

async function generateMasterKey(): Promise<MasterKey> {
  await sodium.ready;

  const raw = sodium.randombytes_buf(
    sodium.crypto_secretbox_KEYBYTES  // 32 bytes
  );

  return {
    raw,
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

function serializeMasterKey(key: MasterKey): string {
  // base64url encoding (no padding) for safe storage/display
  return sodium.to_base64(key.raw, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function deserializeMasterKey(encoded: string): Uint8Array {
  return sodium.from_base64(encoded, sodium.base64_variants.URLSAFE_NO_PADDING);
}
```

#### Key Lifecycle Rules

1. The master key is generated exactly once. If a key already exists in the keychain, generation is skipped.
2. The raw key bytes must never be logged, printed to console, or included in error messages.
3. The key must be zeroed from memory after use (via `sodium.memzero()`) when the application is backgrounded or the encryption context is no longer needed.
4. The key is never stored in plaintext on the filesystem. It lives exclusively in the platform keychain (Sections 4-6) or in encrypted backup form (Section 8).

#### Acceptance Criteria

- [ ] Master key is exactly 32 bytes (256 bits) generated via libsodium `randombytes_buf`
- [ ] Key is generated using OS-provided CSPRNG (no custom RNG, no `Math.random()`)
- [ ] Key is serialized as base64url (no padding) for storage and display
- [ ] Key generation occurs only on first launch when no existing key is found
- [ ] Raw key bytes are never logged, serialized to disk in plaintext, or included in error reports
- [ ] Key memory is zeroed via `sodium.memzero()` when no longer needed
- [ ] Key version field is set to 1 for initial generation
- [ ] Generation function returns a structured `MasterKey` object with metadata

---

### 2. Passphrase Derivation (F10.2)

Users create a recovery passphrase during initial setup. This passphrase is used to derive a key that encrypts the master key for backup purposes. The derivation must be computationally expensive to resist offline brute-force attacks.

#### Algorithm: Argon2id

Argon2id is a memory-hard key derivation function that combines the side-channel resistance of Argon2i with the brute-force resistance of Argon2d. It won the Password Hashing Competition in 2015 and is recommended by OWASP.

#### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Memory (`m`) | 64 MB (65536 KiB) | Forces 64 MB allocation per derivation attempt, making GPU attacks impractical |
| Iterations (`t`) | 3 | Three passes over memory; balances security with mobile device performance |
| Parallelism (`p`) | 1 | Single-threaded; prevents advantage from multi-core attackers without penalizing mobile |
| Output length | 32 bytes | Matches XChaCha20-Poly1305 key size |
| Salt length | 16 bytes | Random, generated via `randombytes_buf` |

#### Performance Targets

| Platform | Expected Derivation Time |
|----------|-------------------------|
| Desktop (modern x86_64) | 0.5 - 1.0 seconds |
| Mobile (iPhone 13+, Pixel 6+) | 1.0 - 3.0 seconds |
| Low-end mobile | 2.0 - 5.0 seconds |

#### Implementation

```typescript
import sodium from 'libsodium-wrappers';

interface DerivedKeyResult {
  key: Uint8Array;      // 32-byte derived key
  salt: Uint8Array;     // 16-byte salt (must be stored alongside encrypted backup)
  algorithm: string;    // "argon2id" -- for future algorithm migration
  params: {
    memLimitBytes: number;
    opsLimit: number;
    parallelism: number;
  };
}

async function deriveKeyFromPassphrase(
  passphrase: string,
  existingSalt?: Uint8Array
): Promise<DerivedKeyResult> {
  await sodium.ready;

  const salt = existingSalt ?? sodium.randombytes_buf(
    sodium.crypto_pwhash_SALTBYTES  // 16 bytes
  );

  const MEM_LIMIT = 67108864;  // 64 MB in bytes
  const OPS_LIMIT = 3;         // 3 iterations

  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,  // 32 bytes output
    passphrase,
    salt,
    OPS_LIMIT,
    MEM_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  return {
    key,
    salt,
    algorithm: 'argon2id',
    params: {
      memLimitBytes: MEM_LIMIT,
      opsLimit: OPS_LIMIT,
      parallelism: 1,
    },
  };
}
```

#### Salt Storage

The salt is stored alongside the encrypted master key backup. It is not secret -- it prevents precomputation attacks (rainbow tables). The salt must be unique per user and regenerated if the passphrase changes.

```json
{
  "version": 1,
  "algorithm": "argon2id",
  "params": { "m": 67108864, "t": 3, "p": 1 },
  "salt": "<base64url-encoded 16-byte salt>",
  "encryptedMasterKey": "<base64url-encoded ciphertext>",
  "nonce": "<base64url-encoded 24-byte nonce>"
}
```

#### Acceptance Criteria

- [ ] Argon2id is used with parameters: m=64MB, t=3, p=1
- [ ] Salt is 16 bytes generated via `randombytes_buf`
- [ ] Derived key is exactly 32 bytes
- [ ] Derivation completes in under 5 seconds on all target platforms
- [ ] An existing salt can be provided for re-derivation (key recovery scenario)
- [ ] Salt is stored alongside the encrypted backup, not discarded
- [ ] Algorithm and parameters are stored in the backup metadata for future migration
- [ ] Passphrase is not stored anywhere after derivation (only the derived key is retained temporarily)
- [ ] Memory used by the passphrase is zeroed after derivation via `sodium.memzero()`

---

### 3. XChaCha20-Poly1305 Encryption (F10.3)

All data at rest (events, projections, backups) and in transit (sync payloads) is encrypted with XChaCha20-Poly1305. This is an AEAD (Authenticated Encryption with Associated Data) cipher that provides both confidentiality and integrity.

#### Why XChaCha20-Poly1305

| Property | Value |
|----------|-------|
| Key size | 256 bits (32 bytes) |
| Nonce size | 192 bits (24 bytes) -- safe for random generation (collision probability negligible at 2^96) |
| Tag size | 128 bits (16 bytes) -- appended to ciphertext |
| Performance | ~1 GB/s on modern x86_64 (no AES-NI required) |
| Side-channel resistance | Constant-time implementation in libsodium |
| Nonce reuse safety | 192-bit nonce makes random generation safe (unlike AES-GCM's 96-bit nonce) |

#### Encryption Envelope Format

Every encrypted blob uses a self-describing envelope:

```
+--------+-------+----------------------------+-----+
| Header | Nonce |        Ciphertext          | Tag |
| 4 bytes| 24 b  |    variable length         | 16b |
+--------+-------+----------------------------+-----+
```

Header (4 bytes):
- Byte 0: Version (`0x01`)
- Byte 1: Algorithm (`0x01` = XChaCha20-Poly1305)
- Bytes 2-3: Reserved (set to `0x00`)

#### Implementation

```typescript
import sodium from 'libsodium-wrappers';

const ENVELOPE_VERSION = 0x01;
const ALG_XCHACHA20_POLY1305 = 0x01;
const HEADER_SIZE = 4;

interface EncryptedPayload {
  header: Uint8Array;    // 4 bytes
  nonce: Uint8Array;     // 24 bytes
  ciphertext: Uint8Array; // plaintext.length + 16 bytes (tag appended)
}

function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): Uint8Array {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES  // 24 bytes
  );

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData ?? null,
    null,  // nsec (unused, must be null)
    nonce,
    key
  );

  // Construct envelope: header + nonce + ciphertext (includes tag)
  const header = new Uint8Array([ENVELOPE_VERSION, ALG_XCHACHA20_POLY1305, 0x00, 0x00]);
  const envelope = new Uint8Array(HEADER_SIZE + nonce.length + ciphertext.length);
  envelope.set(header, 0);
  envelope.set(nonce, HEADER_SIZE);
  envelope.set(ciphertext, HEADER_SIZE + nonce.length);

  return envelope;
}

function decrypt(
  envelope: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array
): Uint8Array {
  // Parse header
  const version = envelope[0];
  const algorithm = envelope[1];

  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }
  if (algorithm !== ALG_XCHACHA20_POLY1305) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const nonceStart = HEADER_SIZE;
  const nonceEnd = nonceStart + sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = envelope.slice(nonceStart, nonceEnd);
  const ciphertext = envelope.slice(nonceEnd);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,  // nsec (unused)
    ciphertext,
    associatedData ?? null,
    nonce,
    key
  );

  if (!plaintext) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  return plaintext;
}
```

#### Associated Data Usage

The AEAD associated data (AD) field binds ciphertext to its context, preventing ciphertext from being moved between records:

| Data Type | Associated Data |
|-----------|----------------|
| Event file | `event_id` (UUID) |
| Projection blob | `project_id + ":" + projection_type` |
| Sync payload | `session_nonce + ":" + sequence_number` |
| Master key backup | `user_id + ":" + backup_version` |

This prevents an attacker who controls the server from swapping encrypted blobs between users or between different records of the same user.

#### Performance Benchmarks

Target throughput on representative hardware:

| Platform | Events/second (1 KB each) | Events/second (10 KB each) | Events/second (100 KB each) |
|----------|---------------------------|----------------------------|-----------------------------|
| Desktop (x86_64, 4 GHz) | > 50,000 | > 30,000 | > 5,000 |
| Desktop (Apple M1+) | > 60,000 | > 40,000 | > 8,000 |
| Mobile (iPhone 13+) | > 10,000 | > 5,000 | > 1,000 |
| Mobile (Pixel 6+) | > 8,000 | > 4,000 | > 800 |

These throughputs mean encryption adds negligible latency to event capture and sync operations. A typical event (~2 KB) encrypts in under 1 microsecond on desktop.

#### Acceptance Criteria

- [ ] XChaCha20-Poly1305 is used for all encryption (no other ciphers)
- [ ] Nonce is 24 bytes, randomly generated via `randombytes_buf` for each encryption operation
- [ ] Nonce is never reused with the same key (random generation with 192-bit nonce makes reuse negligible)
- [ ] Ciphertext includes the 16-byte Poly1305 authentication tag
- [ ] Envelope includes a version byte and algorithm byte for future migration
- [ ] Decryption verifies the authentication tag and throws on mismatch
- [ ] Associated data is bound to context (event_id, project_id, etc.) to prevent ciphertext swapping
- [ ] Encryption throughput exceeds 10,000 events/second for 1 KB payloads on desktop
- [ ] Encrypted envelopes are self-describing (can be decrypted without external metadata beyond the key)

---

### 4. iOS Keychain Storage (F10.4)

On iOS, the master key is stored in the Secure Enclave-backed Keychain with biometric gating. The key cannot be extracted even from a jailbroken device (when backed by Secure Enclave).

#### Keychain Configuration

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| `kSecClass` | `kSecClassGenericPassword` | Generic password item for arbitrary data |
| `kSecAttrService` | `"com.agentcontext.masterkey"` | Identifies our keychain entry |
| `kSecAttrAccount` | `<user_id>` | Scopes to the specific user |
| `kSecAttrAccessible` | `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` | Key is only available when the device has a passcode set; not included in backups; deleted on passcode removal |
| `kSecAttrSynchronizable` | `false` | Never sync via iCloud Keychain (we handle sync ourselves) |

#### Biometric ACL (Access Control List)

```swift
let access = SecAccessControlCreateWithFlags(
  nil,
  kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
  [.biometryCurrentSet, .or, .devicePasscode],
  nil
)
```

Flags:
- `.biometryCurrentSet`: Requires the biometric profile that was enrolled when the key was stored. If the user adds or removes a fingerprint/face, the key becomes inaccessible (forces re-transfer).
- `.or .devicePasscode`: Falls back to device passcode if biometrics fail 3 times (standard iOS behavior).

#### React Native Bridge

Using `react-native-keychain` (or equivalent):

```typescript
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'com.agentcontext.masterkey';

async function storeMasterKeyIOS(
  userId: string,
  masterKeyBase64: string
): Promise<void> {
  await Keychain.setGenericPassword(userId, masterKeyBase64, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
    securityLevel: Keychain.SECURITY_LEVEL.SECURE_ENCLAVE,
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  });
}

async function retrieveMasterKeyIOS(
  userId: string
): Promise<string | null> {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
      authenticationPrompt: {
        title: 'Unlock AgentContext',
        subtitle: 'Authenticate to access your encryption key',
        cancel: 'Cancel',
      },
    });

    if (credentials && credentials.username === userId) {
      return credentials.password;  // base64url-encoded master key
    }

    return null;
  } catch (error) {
    if (error.message?.includes('User canceled')) {
      return null;  // User dismissed biometric prompt
    }
    throw error;
  }
}

async function deleteMasterKeyIOS(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
}
```

#### Error Handling for Missing Biometrics

| Scenario | Behavior |
|----------|----------|
| No passcode set on device | `storeMasterKeyIOS` fails. Prompt user to set a device passcode before proceeding. |
| No biometrics enrolled | Falls back to device passcode authentication (via `.or .devicePasscode` flag). |
| Biometrics changed after key stored | Key becomes inaccessible (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` + `.biometryCurrentSet`). User must re-transfer key from another device or recover via passphrase. |
| Biometric prompt dismissed | `retrieveMasterKeyIOS` returns `null`. App should show a manual "unlock" button. |
| Biometric lockout (too many failures) | iOS falls back to device passcode automatically. |

#### Acceptance Criteria

- [ ] Master key is stored in iOS Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
- [ ] Biometric ACL uses `.biometryCurrentSet` to tie the key to the current biometric enrollment
- [ ] Device passcode fallback is configured (`.or .devicePasscode`)
- [ ] Keychain entry is not included in iCloud Keychain sync (`kSecAttrSynchronizable = false`)
- [ ] Keychain entry is deleted when the device passcode is removed (OS behavior with `ThisDeviceOnly`)
- [ ] React Native bridge correctly stores and retrieves the key
- [ ] Biometric prompt displays a clear, branded authentication message
- [ ] Missing biometrics fall back to device passcode without error
- [ ] Changed biometrics after key storage correctly invalidate access (forces re-transfer)
- [ ] User cancellation of biometric prompt is handled gracefully (no crash, returns null)

---

### 5. Android Keystore (F10.5)

On Android, the master key is stored in the Android Keystore with TEE (Trusted Execution Environment) or StrongBox backing. The key material never leaves the secure hardware.

#### Keystore Configuration

```kotlin
val keyGenParameterSpec = KeyGenParameterSpec.Builder(
    "com.agentcontext.masterkey.wrapping",
    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256)
    .setUserAuthenticationRequired(true)
    .setUserAuthenticationParameters(
        0,  // timeout: 0 = every use requires authentication
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
    )
    .setIsStrongBoxBacked(true)  // prefer StrongBox, fall back to TEE
    .setInvalidatedByBiometricEnrollment(true)  // re-enrollment invalidates
    .build()
```

#### Storage Strategy

Android Keystore does not store arbitrary blobs directly. Instead, we generate a wrapping key in the Keystore and use it to encrypt the master key:

```
1. Generate AES-256-GCM wrapping key in Android Keystore (TEE/StrongBox-backed)
2. Encrypt master key with wrapping key → ciphertext
3. Store ciphertext in app-private SharedPreferences (or EncryptedSharedPreferences)
4. On retrieval: authenticate → Keystore decrypts wrapping key → decrypt master key ciphertext
```

#### React Native Bridge

```typescript
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'com.agentcontext.masterkey';

async function storeMasterKeyAndroid(
  userId: string,
  masterKeyBase64: string
): Promise<void> {
  await Keychain.setGenericPassword(userId, masterKeyBase64, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
    securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
    storage: Keychain.STORAGE_TYPE.AES_GCM,
  });
}

async function retrieveMasterKeyAndroid(
  userId: string
): Promise<string | null> {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
      authenticationPrompt: {
        title: 'Unlock AgentContext',
        description: 'Authenticate to access your encryption key',
        cancel: 'Cancel',
      },
    });

    if (credentials && credentials.username === userId) {
      return credentials.password;
    }

    return null;
  } catch (error) {
    if (error.message?.includes('canceled') || error.message?.includes('cancelled')) {
      return null;
    }
    throw error;
  }
}
```

#### Android API Level Requirements

| API Level | Feature | Handling |
|-----------|---------|----------|
| 23 (6.0) | Android Keystore TEE | Minimum supported API level |
| 28 (9.0) | StrongBox Keymaster | Preferred if available; detected at runtime |
| 30 (11.0) | `AUTH_BIOMETRIC_STRONG` constant | Required; apps targeting < 30 use `setUserAuthenticationValidityDurationSeconds` |
| 33 (13.0) | Credential Manager | Optional; not required for our use case |

#### Runtime Detection

```kotlin
fun isStrongBoxAvailable(context: Context): Boolean {
    return context.packageManager.hasSystemFeature(
        PackageManager.FEATURE_STRONGBOX_KEYSTORE
    )
}

fun createKeySpec(useStrongBox: Boolean): KeyGenParameterSpec {
    val builder = KeyGenParameterSpec.Builder(/* ... */)
    if (useStrongBox) {
        builder.setIsStrongBoxBacked(true)
    }
    return builder.build()
}
```

#### Fallback for Devices Without TEE

Some very old or low-end devices may not have TEE support. In this case:

1. **Detect**: If `KeyGenParameterSpec.Builder` throws `StrongBoxUnavailableException` or TEE initialization fails, fall back to software-backed Keystore.
2. **Warn**: Display a security warning to the user: "Your device does not support hardware-backed key storage. Your encryption key is protected by software encryption only."
3. **Proceed**: Allow the user to continue -- software-backed storage is still significantly better than plaintext storage.
4. **Record**: Store a `keystoreType` field in the local configuration (`"strongbox"`, `"tee"`, or `"software"`) for diagnostics.

#### Acceptance Criteria

- [ ] Master key is stored using Android Keystore with TEE or StrongBox backing
- [ ] StrongBox is preferred, with automatic fallback to TEE, then software
- [ ] Biometric authentication is required for every key access (`timeout = 0`)
- [ ] Device credential (PIN/pattern/password) is accepted as a fallback
- [ ] Key is invalidated when biometric enrollment changes (`setInvalidatedByBiometricEnrollment(true)`)
- [ ] Minimum supported Android API level is 23 (Android 6.0)
- [ ] StrongBox availability is detected at runtime (not assumed)
- [ ] Devices without TEE display a security warning but still function
- [ ] `keystoreType` is recorded in local config for diagnostics
- [ ] React Native bridge handles authentication cancellation gracefully

---

### 6. Desktop Keychain (F10.6)

On desktop platforms, the master key is stored in the OS-provided credential store. This provides protection at rest (encrypted by OS/user credentials) without requiring custom encryption.

#### Platform-Specific Backends

##### macOS: Keychain Services

```rust
// Tauri plugin (Rust backend)
use security_framework::passwords::{set_generic_password, get_generic_password, delete_generic_password};

const SERVICE: &str = "com.agentcontext.masterkey";

fn store_key_macos(account: &str, key_bytes: &[u8]) -> Result<(), Error> {
    set_generic_password(SERVICE, account, key_bytes)?;
    Ok(())
}

fn retrieve_key_macos(account: &str) -> Result<Vec<u8>, Error> {
    let key = get_generic_password(SERVICE, account)?;
    Ok(key)
}

fn delete_key_macos(account: &str) -> Result<(), Error> {
    delete_generic_password(SERVICE, account)?;
    Ok(())
}
```

macOS Keychain properties:
- Encrypted at rest with the user's login keychain password
- Locked when the user logs out or the screen locks (configurable)
- Access controlled per-application (the app must be signed or the user grants permission)

##### Windows: DPAPI (Data Protection API)

```rust
// Tauri plugin (Rust backend)
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE,
    CRYPT_INTEGER_BLOB,
};

fn store_key_windows(key_bytes: &[u8], path: &Path) -> Result<(), Error> {
    let encrypted = dpapi_encrypt(key_bytes)?;
    std::fs::write(path, &encrypted)?;
    Ok(())
}

fn retrieve_key_windows(path: &Path) -> Result<Vec<u8>, Error> {
    let encrypted = std::fs::read(path)?;
    let decrypted = dpapi_decrypt(&encrypted)?;
    Ok(decrypted)
}

fn dpapi_encrypt(data: &[u8]) -> Result<Vec<u8>, Error> {
    let mut input_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output_blob = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &mut input_blob,
            None,       // description
            None,       // optional entropy (we don't use additional entropy)
            None,       // reserved
            None,       // prompt struct
            0,          // flags: user-scoped (not CRYPTPROTECT_LOCAL_MACHINE)
            &mut output_blob,
        )?;
    }

    let result = unsafe {
        std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec()
    };

    Ok(result)
}
```

Windows DPAPI properties:
- Key is derived from the user's Windows login credentials
- Encrypted data is tied to the current user account (not machine-wide)
- If the user resets their Windows password (not changes -- resets via admin), DPAPI-protected data is lost
- No biometric gating (Windows Hello integration would require separate work)

Storage path: `%APPDATA%\AgentContext\masterkey.dpapi`

##### Linux: Secret Service API (GNOME Keyring / KWallet)

```rust
// Tauri plugin (Rust backend)
use keyring::Entry;

const SERVICE: &str = "com.agentcontext.masterkey";

fn store_key_linux(account: &str, key_bytes: &[u8]) -> Result<(), Error> {
    let entry = Entry::new(SERVICE, account)?;
    // Secret Service stores strings, so we base64-encode the key
    let encoded = base64_encode(key_bytes);
    entry.set_password(&encoded)?;
    Ok(())
}

fn retrieve_key_linux(account: &str) -> Result<Vec<u8>, Error> {
    let entry = Entry::new(SERVICE, account)?;
    let encoded = entry.get_password()?;
    let key_bytes = base64_decode(&encoded)?;
    Ok(key_bytes)
}

fn delete_key_linux(account: &str) -> Result<(), Error> {
    let entry = Entry::new(SERVICE, account)?;
    entry.delete_credential()?;
    Ok(())
}
```

Linux Secret Service properties:
- GNOME Keyring: Encrypted with user login password, unlocked at login
- KWallet: Similar behavior under KDE
- If neither is available (headless server, minimal install): Fall back to DPAPI-like file-based encryption using a key derived from the user's UID + machine-id

#### Tauri Plugin Integration

The Tauri desktop app uses the `tauri-plugin-keyring` (or equivalent) to abstract across platforms:

```typescript
// Frontend (TypeScript, invokes Tauri commands)
import { invoke } from '@tauri-apps/api/core';

async function storeMasterKeyDesktop(
  userId: string,
  masterKeyBase64: string
): Promise<void> {
  await invoke('store_master_key', {
    account: userId,
    keyData: masterKeyBase64,
  });
}

async function retrieveMasterKeyDesktop(
  userId: string
): Promise<string | null> {
  try {
    return await invoke('retrieve_master_key', {
      account: userId,
    });
  } catch {
    return null;
  }
}

async function deleteMasterKeyDesktop(
  userId: string
): Promise<void> {
  await invoke('delete_master_key', {
    account: userId,
  });
}
```

#### Cross-Platform API Abstraction

A unified interface abstracts the platform differences:

```typescript
interface KeychainProvider {
  store(userId: string, masterKeyBase64: string): Promise<void>;
  retrieve(userId: string): Promise<string | null>;
  delete(userId: string): Promise<void>;
  getBackendInfo(): Promise<{
    platform: 'macos' | 'windows' | 'linux';
    backend: string;  // 'keychain' | 'dpapi' | 'gnome-keyring' | 'kwallet' | 'file-based'
    hardwareBacked: boolean;
  }>;
}

function getKeychainProvider(): KeychainProvider {
  // Platform detection and appropriate implementation selection
  // Implementation selected at build time via Tauri platform targets
}
```

#### Acceptance Criteria

- [ ] macOS: Master key stored in Keychain Services under `com.agentcontext.masterkey`
- [ ] Windows: Master key stored via DPAPI, scoped to the current user
- [ ] Linux: Master key stored via Secret Service API (GNOME Keyring or KWallet)
- [ ] Linux fallback: File-based encrypted storage when no Secret Service is available
- [ ] Tauri plugin provides a unified Rust backend for all three platforms
- [ ] TypeScript frontend uses `invoke()` to call Tauri commands
- [ ] Cross-platform `KeychainProvider` interface abstracts platform differences
- [ ] Backend info (platform, backend type, hardware-backed) is queryable for diagnostics
- [ ] Windows DPAPI encrypted file is stored in `%APPDATA%\AgentContext\`
- [ ] All implementations handle "key not found" gracefully (return null, not error)

---

### 7. QR Key Transfer (F10.7)

When a user adds a new device, the master key is transferred via a QR code that initiates an ephemeral encrypted channel. The QR code itself does not contain the master key -- it contains a public key and connection info for establishing the encrypted channel.

#### Protocol Overview

```
Device A (has master key)                     Device B (new device)
─────────────────────────                     ─────────────────────
1. Generate ephemeral Curve25519 keypair
2. Create relay room (WebSocket)
3. Encode QR: {pubkey_a, room_id, relay_url}
4. Display QR code
                                              5. Scan QR code
                                              6. Generate ephemeral Curve25519 keypair
                                              7. Connect to relay room
                                              8. Send pubkey_b to Device A via relay
9. Receive pubkey_b
10. Compute shared_key = ECDH(privkey_a, pubkey_b)
                                              11. Compute shared_key = ECDH(privkey_b, pubkey_a)
12. Encrypt master_key with shared_key
    (XSalsa20-Poly1305)
13. Send encrypted master_key via relay
                                              14. Receive encrypted master_key
                                              15. Decrypt with shared_key
                                              16. Store master key in Keychain/Keystore
                                              17. Send ACK (encrypted "OK" message)
18. Receive ACK
19. Destroy ephemeral keypair                 20. Destroy ephemeral keypair
21. Close relay room
```

#### QR Payload Format

```json
{
  "v": 1,
  "p": "<base64url-encoded 32-byte Curve25519 public key>",
  "r": "<relay room ID (UUID)>",
  "u": "wss://relay.agentcontext.dev",
  "t": 1708963200,
  "h": "<truncated HMAC of payload for integrity>"
}
```

| Field | Description |
|-------|-------------|
| `v` | Protocol version (currently 1) |
| `p` | Ephemeral Curve25519 public key of Device A |
| `r` | Relay room identifier (UUID v4) |
| `u` | Relay WebSocket URL |
| `t` | Timestamp (Unix epoch) for expiry checking |
| `h` | First 8 bytes of HMAC-SHA256(payload without `h`, pubkey_a) as hex -- integrity check |

The QR code encodes this JSON as a UTF-8 string. Maximum size is approximately 300 bytes, well within QR code capacity.

#### Ephemeral Key Exchange Implementation

```typescript
import sodium from 'libsodium-wrappers';

interface EphemeralKeyPair {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 32 bytes
}

function generateEphemeralKeyPair(): EphemeralKeyPair {
  const keypair = sodium.crypto_box_keypair();
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.privateKey,
  };
}

function deriveSharedKey(
  mySecretKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  // Curve25519 ECDH → 32-byte shared secret
  // Then hash with BLAKE2b to derive a symmetric key
  const sharedSecret = sodium.crypto_scalarmult(mySecretKey, theirPublicKey);

  // Hash the shared secret to derive a proper symmetric key
  // (raw ECDH output should not be used directly as a key)
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,  // 32 bytes
    sharedSecret
  );
}

function encryptForTransfer(
  masterKey: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES); // 24 bytes
  const ciphertext = sodium.crypto_secretbox_easy(masterKey, nonce, sharedKey);

  // Prepend nonce to ciphertext
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

function decryptFromTransfer(
  payload: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = payload.slice(0, nonceLen);
  const ciphertext = payload.slice(nonceLen);

  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedKey);
  if (!plaintext) {
    throw new Error('Key transfer decryption failed: invalid shared key or corrupted data');
  }
  return plaintext;
}
```

#### Timeout and Cancellation

| Condition | Timeout | Behavior |
|-----------|---------|----------|
| QR code displayed, not scanned | 5 minutes | QR code expires. Device A destroys ephemeral keys and closes relay room. User must restart transfer. |
| QR scanned, waiting for key exchange | 30 seconds | If the ECDH handshake does not complete within 30 seconds, both devices abort. |
| Transfer in progress, relay disconnects | 10 seconds | Reconnect once. If reconnect fails, abort and prompt user to restart. |
| User cancels on either device | Immediate | Ephemeral keys are destroyed. Relay room is closed. |

#### Security Properties

1. **Forward secrecy**: Ephemeral keys are used once and destroyed. Compromising long-term keys does not reveal past transfers.
2. **MITM resistance**: The relay server cannot decrypt the transferred key because it does not know either ephemeral private key. However, there is no out-of-band verification (like a safety number). The QR code itself serves as the authenticated channel -- an attacker would need physical proximity to intercept it.
3. **Replay protection**: The relay room ID is a one-time UUID. The room is closed after successful transfer.
4. **No key material in QR**: The QR code contains only a public key and connection info. Photographing the QR code does not compromise the master key.

#### Acceptance Criteria

- [ ] QR code contains ephemeral Curve25519 public key, relay room ID, relay URL, and timestamp
- [ ] QR code does NOT contain the master key or any derived secret
- [ ] Ephemeral keypairs are generated via `sodium.crypto_box_keypair()`
- [ ] Shared key is derived via Curve25519 ECDH followed by BLAKE2b hashing
- [ ] Master key is encrypted with XSalsa20-Poly1305 using the shared key
- [ ] Both devices destroy ephemeral keys after transfer (success or failure)
- [ ] QR code expires after 5 minutes if not scanned
- [ ] ECDH handshake times out after 30 seconds
- [ ] User can cancel on either device at any time
- [ ] Successful transfer is confirmed with an encrypted ACK message
- [ ] Relay room is closed after transfer completes

---

### 8. Key Backup Prompt (F10.8)

During initial key generation, the user is required to create a recovery passphrase and verify that it works. This is the only way to recover the master key if all devices are lost.

#### Backup Flow

```
1. Master key generated (Section 1)
2. Prompt: "Create a recovery passphrase"
   - Display passphrase strength requirements
   - Display warning about unrecoverability
3. User enters passphrase
4. Validate passphrase strength
5. User confirms passphrase (re-enter)
6. Derive recovery key via Argon2id (Section 2)
7. Encrypt master key with recovery key
8. Store encrypted backup locally
9. Recovery test: prompt user to enter passphrase again
10. Derive key from entered passphrase
11. Attempt to decrypt backup
12. If decryption succeeds: backup confirmed, proceed
13. If decryption fails: something went wrong, restart from step 2
```

#### Passphrase Strength Requirements

| Requirement | Threshold | Rationale |
|-------------|-----------|-----------|
| Minimum length | 12 characters | Baseline entropy for passphrase |
| Maximum length | 1024 characters | Prevent DOS via excessive memory allocation in Argon2id |
| Disallowed | Common passwords (top 10,000 list) | Prevent trivially guessable passphrases |
| Recommended | 4+ words if using a passphrase style | Encourage diceware-style passphrases |
| Unicode | Allowed (UTF-8 normalized via NFC) | Support non-English speakers |

#### Strength Estimation

Use `zxcvbn` (or equivalent) for strength estimation:

```typescript
import zxcvbn from 'zxcvbn';

interface PassphraseValidation {
  isValid: boolean;
  score: number;          // 0-4 (zxcvbn scale)
  crackTimeDisplay: string;
  feedback: string[];     // Suggestions for improvement
}

function validatePassphrase(passphrase: string): PassphraseValidation {
  if (passphrase.length < 12) {
    return {
      isValid: false,
      score: 0,
      crackTimeDisplay: 'instant',
      feedback: ['Passphrase must be at least 12 characters long.'],
    };
  }

  if (passphrase.length > 1024) {
    return {
      isValid: false,
      score: 0,
      crackTimeDisplay: 'n/a',
      feedback: ['Passphrase must be 1024 characters or fewer.'],
    };
  }

  const result = zxcvbn(passphrase);

  return {
    isValid: result.score >= 3,  // Require score 3+ ("good" or "strong")
    score: result.score,
    crackTimeDisplay: result.crack_times_display.offline_slow_hashing_1e4_per_second,
    feedback: [
      ...result.feedback.suggestions,
      ...(result.feedback.warning ? [result.feedback.warning] : []),
    ],
  };
}
```

#### Recovery Test

After the user sets a passphrase, the app immediately asks them to re-enter it and verifies it can decrypt the backup. This prevents the scenario where a user sets a passphrase, forgets it, and later discovers they cannot recover their key.

```typescript
async function verifyRecoveryPassphrase(
  passphrase: string,
  encryptedBackup: EncryptedBackup
): Promise<boolean> {
  try {
    const derived = await deriveKeyFromPassphrase(
      passphrase,
      encryptedBackup.salt
    );
    const decrypted = decrypt(
      encryptedBackup.ciphertext,
      derived.key,
      encryptedBackup.associatedData
    );
    // If we get here, decryption succeeded (tag verified)
    sodium.memzero(derived.key);
    sodium.memzero(decrypted);
    return true;
  } catch {
    return false;
  }
}
```

#### Unrecoverability Warning

The following warning must be displayed prominently before the user proceeds:

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

#### Acceptance Criteria

- [ ] User is prompted to create a recovery passphrase during first key generation
- [ ] Passphrase must be at least 12 characters
- [ ] Passphrase must score 3+ on the zxcvbn scale
- [ ] Top 10,000 common passwords are rejected
- [ ] User must confirm passphrase by re-entering it
- [ ] Recovery test: user enters passphrase a third time, system verifies decryption succeeds
- [ ] If recovery test fails, user must restart the passphrase setup
- [ ] Unrecoverability warning is displayed prominently
- [ ] Unicode passphrases are supported (NFC normalization applied)
- [ ] Passphrase is zeroed from memory after derivation
- [ ] Encrypted backup is stored locally with salt and algorithm metadata

---

### 9. E2EE Relay (F10.9)

Data synced between devices passes through a relay server that cannot read the data. The relay is a blind pipe -- it forwards encrypted blobs without any ability to inspect or modify them.

#### Paseo NaCl-Based Protocol

The AgentContext relay builds on Paseo's existing NaCl-based encrypted WebSocket channel. Each sync session establishes a unique encrypted channel:

```
Client A                    Relay Server                    Client B
────────                    ────────────                    ────────
1. Connect via WebSocket
2. Join room (room_id)
                                                            3. Connect via WebSocket
                                                            4. Join room (room_id)
5. Send encrypted blob ──►  6. Forward blob ──────────────► 7. Receive and decrypt
8. Receive and decrypt ◄──  9. Forward blob ◄────────────── 10. Send encrypted blob
```

#### Relay Session Key Management

Each sync session uses a dedicated symmetric key derived from the master key and a session-specific nonce:

```typescript
function deriveRelaySessionKey(
  masterKey: Uint8Array,
  sessionId: string,
  purpose: 'send' | 'receive'
): Uint8Array {
  const context = new TextEncoder().encode(
    `agentcontext-relay-${purpose}-${sessionId}`
  );

  // Use BLAKE2b keyed hash to derive a session-specific key
  return sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,  // 32 bytes
    context,
    masterKey
  );
}
```

#### Message Envelope

Each message sent over the relay is wrapped in an encrypted envelope:

```typescript
interface RelayMessage {
  seq: number;          // Monotonically increasing sequence per session
  type: string;         // 'event' | 'projection' | 'ack' | 'control'
  payload: Uint8Array;  // Encrypted data
  timestamp: number;    // Unix epoch milliseconds
}

function encryptRelayMessage(
  message: RelayMessage,
  sessionKey: Uint8Array
): Uint8Array {
  const plaintext = new TextEncoder().encode(JSON.stringify({
    seq: message.seq,
    type: message.type,
    payload: sodium.to_base64(message.payload, sodium.base64_variants.URLSAFE_NO_PADDING),
    timestamp: message.timestamp,
  }));

  return encrypt(plaintext, sessionKey);
}
```

#### Relay Server Guarantees

| Property | Guarantee |
|----------|-----------|
| Confidentiality | Relay never sees plaintext. All data is encrypted client-side before transmission. |
| Integrity | Poly1305 authentication tag prevents tampering. The relay cannot modify data without detection. |
| Ordering | Sequence numbers prevent reordering and detect dropped messages. |
| Replay protection | Session keys are unique per sync session. Replaying messages from a previous session fails decryption. |
| No persistence | Relay does not store messages. It is a real-time forwarding service. If the recipient is offline, messages are dropped (store-and-forward is handled at the application layer). |

#### Acceptance Criteria

- [ ] Relay session keys are derived from the master key using BLAKE2b keyed hash
- [ ] Each sync session uses a unique session key (derived from master key + session ID)
- [ ] All data sent to the relay is encrypted with XChaCha20-Poly1305
- [ ] Relay server never has access to plaintext or key material
- [ ] Messages include sequence numbers for ordering and gap detection
- [ ] Replayed messages from previous sessions fail decryption
- [ ] WebSocket connection uses TLS (wss://) for transport-layer encryption
- [ ] Relay does not persist messages (real-time forwarding only)
- [ ] Connection drops are detected and handled (reconnect with the same session key)

---

### 10. Path Sandboxing (F10.10)

The AgentContext daemon serves files (event data, projections) over HTTP to the local dashboard and client applications. File access must be scoped to the agent workspace to prevent unauthorized file system access.

#### Sandbox Root

All file serving is restricted to the AgentContext data directory:

```typescript
const SANDBOX_ROOT = process.env.CLAUDE_CONTEXT_PATH ||
  path.join(os.homedir(), '.claude-context');
```

#### Path Resolution and Validation

```typescript
import path from 'path';
import fs from 'fs';

class PathSandbox {
  private readonly root: string;

  constructor(root: string) {
    // Resolve to absolute path and ensure it exists
    this.root = fs.realpathSync(root);
  }

  /**
   * Resolves a requested path and validates it is within the sandbox.
   * Returns the resolved absolute path or throws.
   */
  resolve(requestedPath: string): string {
    // 1. Join with sandbox root
    const joined = path.join(this.root, requestedPath);

    // 2. Resolve to absolute path (resolves .., ., etc.)
    const resolved = path.resolve(joined);

    // 3. Verify the resolved path starts with the sandbox root
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new PathTraversalError(
        `Path traversal blocked: "${requestedPath}" resolves outside sandbox`
      );
    }

    // 4. Resolve symlinks and re-check
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(this.root + path.sep) && real !== this.root) {
        throw new PathTraversalError(
          `Symlink traversal blocked: "${requestedPath}" -> "${real}" is outside sandbox`
        );
      }
      return real;
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      // File does not exist yet (e.g., write operation) -- use the resolved path
      return resolved;
    }
  }
}

class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}
```

#### Path Traversal Prevention

The following attack vectors are blocked:

| Attack | Input | Resolution | Blocked By |
|--------|-------|------------|------------|
| `..` traversal | `../../etc/passwd` | `/etc/passwd` | `startsWith(root)` check |
| URL encoding | `%2e%2e%2f%2e%2e%2fetc/passwd` | Decoded by HTTP framework before reaching sandbox | URL decoding + `startsWith` |
| Null byte injection | `valid.json%00.png` | Truncated at null byte | Node.js path module ignores null bytes; explicit check added |
| Symlink escape | `events/link -> /etc/` | `/etc/passwd` | `realpathSync` re-check |
| Double-encoded | `%252e%252e%252f` | `%2e%2e%2f` then `../../` | Double-decode detection |
| Backslash (Windows) | `..\..\etc\passwd` | Platform-dependent | `path.resolve` normalizes on both platforms |

#### Symlink Following Rules

| Symlink Location | Policy | Rationale |
|------------------|--------|-----------|
| Symlink inside sandbox pointing inside sandbox | Allowed | Normal operation (e.g., `latest` symlink in projections) |
| Symlink inside sandbox pointing outside sandbox | Blocked | Prevents escape via symlink |
| Symlink outside sandbox pointing inside sandbox | N/A | Cannot be reached because the starting path must be inside sandbox |

#### Allowlist vs Denylist

The sandbox uses an **allowlist** approach: only paths within the sandbox root are accessible. There is no denylist of forbidden paths. This is more secure because:

- New attack vectors are blocked by default
- No risk of forgetting to add a path to the denylist
- The principle of least privilege is enforced

#### Acceptance Criteria

- [ ] All file serving is restricted to the sandbox root directory
- [ ] Path traversal via `..` is blocked
- [ ] URL-encoded path traversal is blocked
- [ ] Null byte injection is blocked
- [ ] Symlinks that point outside the sandbox are blocked
- [ ] Symlinks within the sandbox that stay within the sandbox are allowed
- [ ] Path resolution uses `fs.realpathSync` to resolve symlinks before checking bounds
- [ ] Allowlist approach: only paths within the sandbox root are accessible
- [ ] `PathTraversalError` is thrown for all violations (not a generic error)
- [ ] Sandbox root itself is accessible (not just children)

---

### 11. Host Allowlisting (F10.11)

The AgentContext daemon HTTP server must restrict access to authorized origins only. This prevents DNS rebinding attacks where a malicious website could make requests to `localhost` and access the daemon API.

#### DNS Rebinding Attack Vector

```
1. User visits evil.com
2. evil.com's DNS initially resolves to the attacker's server
3. evil.com serves JavaScript that makes fetch() requests to evil.com
4. evil.com's DNS is changed to resolve to 127.0.0.1
5. Browser makes requests to 127.0.0.1 (the daemon) with Origin: evil.com
6. Without host checking, the daemon responds with sensitive data
```

#### Allowed Hosts

```typescript
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '0.0.0.0',   // Only if daemon binds to all interfaces (not recommended)
]);

// Optionally extended by configuration:
// config.allowedHosts: ["192.168.1.100"]  -- for LAN access
```

#### Host Header Validation

```typescript
import { IncomingMessage, ServerResponse } from 'http';

function validateHost(req: IncomingMessage): boolean {
  const host = req.headers.host;

  if (!host) {
    return false;  // Missing Host header is suspicious
  }

  // Strip port number if present
  const hostname = host.split(':')[0].toLowerCase();

  return ALLOWED_HOSTS.has(hostname);
}

function hostCheckMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void {
  if (!validateHost(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Forbidden',
      message: 'Request blocked: invalid Host header',
    }));
    return;
  }
  next();
}
```

#### CORS Configuration

```typescript
function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void {
  const origin = req.headers.origin;

  const ALLOWED_ORIGINS = new Set([
    'http://localhost:3000',     // Dashboard dev server
    'http://localhost:4567',     // Daemon default port
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4567',
    'tauri://localhost',         // Tauri desktop app
    'https://tauri.localhost',   // Tauri alternative origin
  ]);

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Download-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  next();
}
```

#### Additional Protections

| Protection | Implementation |
|------------|---------------|
| `X-Content-Type-Options: nosniff` | Prevent MIME-type sniffing |
| `X-Frame-Options: DENY` | Prevent clickjacking via iframes |
| `Content-Security-Policy: default-src 'self'` | Restrict resource loading |
| `Referrer-Policy: no-referrer` | Do not leak referrer information |

```typescript
function securityHeadersMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}
```

#### Acceptance Criteria

- [ ] Host header is validated against the allowlist for every request
- [ ] Requests without a Host header are rejected with 403
- [ ] Requests with a Host header not in the allowlist are rejected with 403
- [ ] CORS headers are set only for allowed origins
- [ ] Preflight (OPTIONS) requests are handled correctly
- [ ] `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, and `Referrer-Policy` headers are set
- [ ] DNS rebinding attack vector is mitigated by host checking
- [ ] Configuration allows extending the allowed hosts list (for LAN access)
- [ ] Tauri app origin (`tauri://localhost`) is in the allowed origins list
- [ ] `Vary: Origin` header is set when `Access-Control-Allow-Origin` is set

---

### 12. Download Tokens (F10.12)

File downloads (event exports, projection snapshots) use single-use, time-limited tokens to prevent unauthorized access and replay attacks.

#### Token Properties

| Property | Value | Rationale |
|----------|-------|-----------|
| Length | 32 bytes (256 bits), hex-encoded (64 characters) | Unguessable via brute force |
| Lifetime | 5 minutes | Short enough to prevent replay, long enough for slow connections |
| Usage | Single-use | Token is invalidated after first successful download |
| Scope | Bound to a specific file path | Cannot be used to download a different file |
| Storage | In-memory (Map) | No persistence needed; tokens are ephemeral |

#### Token Generation and Validation

```typescript
import crypto from 'crypto';

interface DownloadToken {
  token: string;
  filePath: string;     // The file this token grants access to
  createdAt: number;    // Unix epoch milliseconds
  expiresAt: number;    // Unix epoch milliseconds
  used: boolean;
}

class DownloadTokenManager {
  private tokens: Map<string, DownloadToken> = new Map();
  private readonly TTL_MS = 5 * 60 * 1000;  // 5 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Periodically clean up expired tokens (every 60 seconds)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Generate a new download token for a specific file.
   */
  generate(filePath: string): string {
    const token = crypto.randomBytes(32).toString('hex');
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

  /**
   * Validate and consume a download token.
   * Returns the authorized file path, or throws.
   */
  consume(token: string, requestedPath: string): string {
    const record = this.tokens.get(token);

    if (!record) {
      throw new TokenError('Invalid token');
    }

    if (record.used) {
      this.tokens.delete(token);
      throw new TokenError('Token already used');
    }

    if (Date.now() > record.expiresAt) {
      this.tokens.delete(token);
      throw new TokenError('Token expired');
    }

    if (record.filePath !== requestedPath) {
      throw new TokenError('Token not valid for requested path');
    }

    // Mark as used and return the authorized path
    record.used = true;
    this.tokens.delete(token);  // Remove immediately after use
    return record.filePath;
  }

  /**
   * Remove expired tokens from memory.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [token, record] of this.tokens) {
      if (now > record.expiresAt || record.used) {
        this.tokens.delete(token);
      }
    }
  }

  /**
   * Shutdown: clear interval and all tokens.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.tokens.clear();
  }
}

class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}
```

#### HTTP Integration

```typescript
// Token request endpoint
app.post('/api/download-token', (req, res) => {
  const { filePath } = req.body;

  // Validate path is within sandbox
  const sandbox = new PathSandbox(SANDBOX_ROOT);
  const resolvedPath = sandbox.resolve(filePath);

  // Verify file exists
  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const token = tokenManager.generate(resolvedPath);

  res.json({
    token,
    expiresIn: 300,  // seconds
    downloadUrl: `/api/download?token=${token}`,
  });
});

// Download endpoint
app.get('/api/download', (req, res) => {
  const { token } = req.query;
  const requestedPath = req.query.path;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const authorizedPath = tokenManager.consume(token, requestedPath);
    res.sendFile(authorizedPath);
  } catch (err) {
    if (err instanceof TokenError) {
      return res.status(403).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal error' });
  }
});
```

#### Acceptance Criteria

- [ ] Tokens are 32 bytes (64 hex characters) generated via `crypto.randomBytes`
- [ ] Tokens expire after 5 minutes
- [ ] Tokens are single-use (consumed on first successful download)
- [ ] Tokens are scoped to a specific file path (cannot be used for other files)
- [ ] Expired tokens are rejected with a clear error message
- [ ] Already-used tokens are rejected with a clear error message
- [ ] Tokens for non-matching file paths are rejected
- [ ] Expired tokens are cleaned up from memory periodically (every 60 seconds)
- [ ] Token generation endpoint validates the file path against the sandbox
- [ ] Token storage is in-memory only (no persistence to disk)
- [ ] `TokenError` is thrown for all token validation failures (not a generic error)
- [ ] The `destroy()` method cleans up the interval and all tokens

---

## Edge Cases

### E-1: Master Key Already Exists at First Launch

**Scenario**: The user reinstalls the app but the keychain still holds a master key from a previous installation.

**Expected behavior**: Key generation is skipped. The existing key is loaded from the keychain. The user is not prompted for a passphrase unless they explicitly request to re-export a backup.

---

### E-2: Argon2id Runs Out of Memory on Low-End Device

**Scenario**: A device with less than 128 MB of free RAM attempts passphrase derivation with `m=64MB`.

**Expected behavior**: libsodium's `crypto_pwhash` returns an error (ENOMEM). The app catches the error and retries with reduced memory parameters: `m=32MB, t=6, p=1` (double the iterations to compensate for halved memory). If this also fails, the app reports that the device does not have enough memory for secure key derivation and suggests using another device.

---

### E-3: QR Code Scanned After Expiry

**Scenario**: Device A displays a QR code. Five minutes pass. Device B scans the expired QR code.

**Expected behavior**: The relay room has been closed by Device A. Device B cannot connect to the room. The scanning UI shows "Transfer expired. Ask the other device to generate a new QR code."

---

### E-4: Relay Disconnects Mid-Transfer

**Scenario**: The WebSocket connection to the relay drops after Device A sends the encrypted master key but before Device B receives it.

**Expected behavior**: Device B detects the disconnection and attempts to reconnect once (within 10 seconds). If reconnection fails, both devices abort the transfer. The ephemeral keys are destroyed. The user must restart the QR transfer process. The master key on Device A is unaffected.

---

### E-5: Biometrics Changed After Key Storage (iOS/Android)

**Scenario**: A user stores the master key with Face ID, then enrolls a new face (e.g., after significant appearance change). The previous Face ID profile is invalidated by `.biometryCurrentSet`.

**Expected behavior**: Key retrieval fails because the biometric profile has changed. The user is prompted with two recovery options:
1. Enter device passcode (fallback authentication)
2. Re-transfer the key from another device via QR
3. Recover from passphrase backup

After successful recovery, the key is re-stored with the new biometric profile.

---

### E-6: Windows Password Reset (Not Change) Causes DPAPI Loss

**Scenario**: An administrator resets the user's Windows password (not the user changing it themselves). DPAPI-protected data becomes inaccessible.

**Expected behavior**: Master key retrieval fails on next app launch. The user is prompted to recover via passphrase. After recovery, the key is re-protected with the new DPAPI context.

---

### E-7: Symlink Points to File Outside Sandbox

**Scenario**: An attacker (or misconfigured system) creates a symlink inside `~/.claude-context/events/` that points to `/etc/shadow`.

**Expected behavior**: The `PathSandbox.resolve()` method calls `realpathSync`, which resolves the symlink to `/etc/shadow`. The `startsWith(root)` check fails. `PathTraversalError` is thrown. The request is rejected with 403.

---

### E-8: DNS Rebinding Attack on Daemon

**Scenario**: A user visits `evil.com`, which changes its DNS to resolve to `127.0.0.1`. JavaScript on `evil.com` makes fetch requests to the daemon.

**Expected behavior**: The browser sends the request with `Host: evil.com`. The `validateHost()` middleware rejects the request because `evil.com` is not in `ALLOWED_HOSTS`. The response is 403.

---

### E-9: Download Token Used Twice

**Scenario**: A user generates a download token, uses it to download a file, then tries to use the same token again (e.g., by clicking the download link a second time).

**Expected behavior**: The second request is rejected with 403 and message "Token already used". The token was deleted from memory after the first use.

---

### E-10: Multiple Concurrent Key Transfers

**Scenario**: The user tries to transfer the master key to two new devices simultaneously by generating two QR codes.

**Expected behavior**: Each QR code creates its own relay room with its own ephemeral keypair. Both transfers proceed independently. Each new device receives the same master key. There is no conflict because the relay rooms and ephemeral keys are separate.

---

### E-11: No Secret Service Available on Linux

**Scenario**: A headless Linux server with no desktop environment. Neither GNOME Keyring nor KWallet is running.

**Expected behavior**: The `keyring` library throws an error indicating no backend is available. The app falls back to file-based encrypted storage: the master key is encrypted using a key derived from the machine-id (`/etc/machine-id`) and user UID. A warning is displayed: "No desktop keychain found. Using file-based encryption. Hardware-backed protection is not available."

---

### E-12: Common Passphrase Rejected

**Scenario**: The user tries to set "password123456" as their recovery passphrase.

**Expected behavior**: The passphrase validation rejects it. zxcvbn scores it as 0 or 1 (very weak). The UI shows: "This passphrase is too common and easily guessable. Please choose a stronger passphrase." The user cannot proceed until they enter a passphrase that scores 3 or higher.

---

### E-13: Large File Download With Expired Token

**Scenario**: A user starts downloading a 500 MB export file. The download takes longer than 5 minutes. The token expires during the download.

**Expected behavior**: The token is consumed (marked as used and deleted) at the start of the download, not continuously checked during streaming. Once the download starts, the token's expiry is irrelevant. The download completes successfully.

---

## Technical Specification Summary

### Cryptographic Algorithms

| Purpose | Algorithm | Library |
|---------|-----------|---------|
| Symmetric encryption (data at rest) | XChaCha20-Poly1305 | libsodium |
| Key derivation (passphrase) | Argon2id | libsodium |
| Key exchange (QR transfer) | Curve25519 ECDH | libsodium |
| Encryption during key transfer | XSalsa20-Poly1305 | libsodium |
| Key derivation (session keys) | BLAKE2b keyed hash | libsodium |
| Random number generation | OS CSPRNG via libsodium | libsodium |
| Token generation | `crypto.randomBytes` | Node.js crypto |

### Key Material Inventory

| Key | Size | Storage | Lifetime | Scope |
|-----|------|---------|----------|-------|
| Master key | 256 bits | OS keychain | Permanent (until rotation) | Per user |
| Recovery-derived key | 256 bits | Memory only | Duration of recovery operation | Per derivation |
| Relay session key | 256 bits | Memory only | Duration of sync session | Per session |
| QR ephemeral keypair | 256 bits each (pub+priv) | Memory only | Duration of transfer (~30s) | Per transfer |
| ECDH shared key | 256 bits | Memory only | Duration of transfer (~30s) | Per transfer |
| Download token | 256 bits | In-memory Map | 5 minutes | Per download |

### Data Flow: Encrypt Event

```
1. Event captured by capture-event (plaintext)
2. Read master key from OS keychain (requires biometric on mobile)
3. Generate random 24-byte nonce
4. Encrypt event JSON with XChaCha20-Poly1305(master_key, nonce, event_json)
5. Prepend 4-byte header + nonce to ciphertext
6. Write encrypted envelope to disk
7. Zero master key from memory
```

### Data Flow: Sync Event to Another Device

```
1. Read encrypted event from disk
2. Decrypt with master key (get plaintext)
3. Derive relay session key from master key + session ID
4. Re-encrypt plaintext with relay session key
5. Send over WebSocket relay (wss://)
6. Recipient decrypts with their relay session key (derived from same master key)
7. Recipient encrypts with their master key (same key, but re-encrypted with fresh nonce)
8. Recipient writes to their local disk
```

### Dependencies

| Dependency | Version | Purpose | Platform |
|------------|---------|---------|----------|
| `libsodium-wrappers` | >= 0.7.13 | All cryptographic operations | All |
| `react-native-keychain` | >= 8.0 | iOS Keychain + Android Keystore | Mobile |
| `tauri-plugin-keyring` | >= 2.0 | Desktop keychain access | Desktop (Tauri) |
| `zxcvbn` | >= 4.4 | Passphrase strength estimation | All |
| `security-framework` (Rust) | >= 2.0 | macOS Keychain (Tauri backend) | macOS |
| `keyring` (Rust) | >= 2.0 | Linux Secret Service (Tauri backend) | Linux |

### File Paths

| Path | Purpose | Encrypted |
|------|---------|-----------|
| `~/.claude-context/events/{project-id}/{session-id}/*.json` | Event files | Yes (after this story) |
| `~/.claude-context/projections/{project-id}/` | Projection snapshots | Yes (after this story) |
| `~/.claude-context/backup/master-key.enc` | Passphrase-encrypted master key backup | Yes (ciphertext) |
| `~/.claude-context/backup/master-key.meta.json` | Backup metadata (salt, algorithm, params) | No (public parameters) |
| `%APPDATA%\AgentContext\masterkey.dpapi` | DPAPI-encrypted master key (Windows) | Yes (DPAPI) |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `generateMasterKey()` returns a 32-byte key |
| T-2 | `serializeMasterKey()` produces valid base64url (no padding, URL-safe characters only) |
| T-3 | `deserializeMasterKey(serializeMasterKey(key))` roundtrips correctly |
| T-4 | `deriveKeyFromPassphrase()` produces a 32-byte key |
| T-5 | `deriveKeyFromPassphrase()` with same passphrase and salt produces the same key (deterministic) |
| T-6 | `deriveKeyFromPassphrase()` with different salt produces a different key |
| T-7 | `encrypt()` followed by `decrypt()` roundtrips for payloads of 0, 1, 1000, and 1,000,000 bytes |
| T-8 | `decrypt()` with wrong key throws authentication error |
| T-9 | `decrypt()` with tampered ciphertext throws authentication error |
| T-10 | `decrypt()` with mismatched associated data throws authentication error |
| T-11 | `encrypt()` produces different ciphertext for the same plaintext (random nonce) |
| T-12 | Envelope header has correct version and algorithm bytes |
| T-13 | `generateEphemeralKeyPair()` returns 32-byte public and private keys |
| T-14 | ECDH: `deriveSharedKey(a.secret, b.public) === deriveSharedKey(b.secret, a.public)` |
| T-15 | `encryptForTransfer()` followed by `decryptFromTransfer()` roundtrips correctly |
| T-16 | `decryptFromTransfer()` with wrong shared key throws |
| T-17 | `validatePassphrase()` rejects strings shorter than 12 characters |
| T-18 | `validatePassphrase()` rejects "password123456" (common password) |
| T-19 | `validatePassphrase()` accepts a strong 20-character passphrase |
| T-20 | `PathSandbox.resolve()` blocks `../../etc/passwd` |
| T-21 | `PathSandbox.resolve()` blocks symlinks pointing outside sandbox |
| T-22 | `PathSandbox.resolve()` allows paths within the sandbox |
| T-23 | `PathSandbox.resolve()` allows the sandbox root itself |
| T-24 | `validateHost()` accepts `localhost`, `127.0.0.1`, `[::1]` |
| T-25 | `validateHost()` rejects `evil.com`, `attacker.local` |
| T-26 | `validateHost()` rejects requests with no Host header |
| T-27 | `DownloadTokenManager.generate()` returns a 64-character hex string |
| T-28 | `DownloadTokenManager.consume()` returns the file path on first use |
| T-29 | `DownloadTokenManager.consume()` throws on second use (same token) |
| T-30 | `DownloadTokenManager.consume()` throws after token expires |
| T-31 | `DownloadTokenManager.consume()` throws when token file path does not match request |

### Integration Tests

| Test | Description |
|------|-------------|
| T-32 | Full key lifecycle: generate -> store in keychain -> retrieve -> encrypt data -> decrypt data |
| T-33 | Full passphrase backup: generate key -> derive from passphrase -> encrypt key -> re-derive from passphrase -> decrypt key |
| T-34 | QR transfer simulation: Device A generates QR -> Device B parses QR -> ECDH -> transfer -> verify both devices have same key |
| T-35 | Relay session: derive session key on two clients -> encrypt on A -> decrypt on B |
| T-36 | Path sandbox with real filesystem: create sandbox dir, create symlink outside, verify rejection |
| T-37 | Host allowlisting with HTTP server: start server, send requests with various Host headers, verify accept/reject |
| T-38 | Download token full flow: generate token -> use token to download -> attempt reuse -> verify rejection |
| T-39 | Concurrent download token generation: generate 1000 tokens, verify all are unique |
| T-40 | Passphrase strength rejection: attempt to set 10 common passwords, verify all are rejected |

### Platform Tests

| Test | Platform | Description |
|------|----------|-------------|
| T-41 | iOS (simulator) | Store and retrieve key from Keychain with biometric bypass |
| T-42 | iOS (device) | Store and retrieve key with Face ID / Touch ID |
| T-43 | Android (emulator) | Store and retrieve key from Keystore |
| T-44 | Android (device) | Store and retrieve key with biometric authentication |
| T-45 | macOS | Store and retrieve key from Keychain Services |
| T-46 | Windows | Store and retrieve key via DPAPI |
| T-47 | Linux (GNOME) | Store and retrieve key via GNOME Keyring |
| T-48 | Linux (headless) | Verify file-based fallback works |

### Performance Tests

| Test | Description |
|------|-------------|
| T-49 | Encrypt 10,000 events (1 KB each) in under 1 second on desktop |
| T-50 | Decrypt 10,000 events (1 KB each) in under 1 second on desktop |
| T-51 | Argon2id derivation completes in under 5 seconds on target mobile device |
| T-52 | QR code generation + display takes under 500ms |
| T-53 | End-to-end key transfer (QR scan to key stored) completes in under 10 seconds on LAN |

### Security Tests

| Test | Description |
|------|-------------|
| T-54 | Master key bytes do not appear in any log output |
| T-55 | Passphrase does not appear in any log output |
| T-56 | Memory dump after `sodium.memzero()` does not contain key material (best-effort, JS limitation) |
| T-57 | Encrypted backup file cannot be decrypted with wrong passphrase |
| T-58 | QR code does not contain the master key (parse and verify) |
| T-59 | Replay: resend a relay message from a previous session, verify decryption fails |
| T-60 | ECDH: verify different ephemeral keys produce different shared secrets |

---

## Definition of Done

- [ ] Master key generation produces 32 bytes from OS CSPRNG via libsodium
- [ ] Argon2id derivation uses parameters m=64MB, t=3, p=1 with 16-byte random salt
- [ ] XChaCha20-Poly1305 encryption is used for all data at rest and in transit
- [ ] Encryption envelope is self-describing (version + algorithm header)
- [ ] Associated data is bound to event/projection context to prevent ciphertext swapping
- [ ] iOS Keychain stores the key with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` and biometric ACL
- [ ] Android Keystore uses TEE/StrongBox with biometric authentication and fallback chain
- [ ] Desktop keychain integration works on macOS (Keychain), Windows (DPAPI), and Linux (Secret Service)
- [ ] QR key transfer uses ephemeral Curve25519 ECDH with forward secrecy
- [ ] QR code contains only public key and connection info (no master key)
- [ ] Ephemeral keys are destroyed after transfer
- [ ] Key backup prompt forces passphrase creation with strength validation (zxcvbn score >= 3)
- [ ] Recovery test verifies the passphrase decrypts the backup before proceeding
- [ ] Unrecoverability warning is displayed during passphrase setup
- [ ] E2EE relay uses session-specific keys derived from the master key
- [ ] Path sandboxing blocks all traversal attacks (`..\`, symlinks, null bytes, URL encoding)
- [ ] Host allowlisting rejects requests with invalid Host headers (DNS rebinding protection)
- [ ] CORS is configured for allowed origins only
- [ ] Security headers (nosniff, DENY, CSP, no-referrer) are set on all responses
- [ ] Download tokens are single-use, time-limited (5 min), and scoped to specific files
- [ ] All 60 test cases from the testing plan pass
- [ ] Encryption throughput exceeds 10,000 events/second (1 KB each) on desktop
- [ ] Key material is never logged, never stored in plaintext, and zeroed from memory after use
- [ ] No cryptographic operation uses `Math.random()`, custom RNG, or non-constant-time comparisons
