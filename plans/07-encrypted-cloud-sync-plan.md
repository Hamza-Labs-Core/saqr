# Implementation Plan: Story 07 -- Encrypted Cloud Sync

**Date**: 2026-02-22
**Story**: 13-encrypted-cloud-sync
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (60-80 hours)
**Prerequisites**: Stories 00-05 implemented (installation, event capture, hook integration, storage layer, projection engine, context recovery). Node.js 18+ with built-in `fetch`. The `libsodium-wrappers-sumo` WASM bundle must be vendored (no npm).
**Key References**: `docs/PRODUCT-SPEC.md` (F5.1-F5.10), `docs/PLATFORM-EVALUATION.md` (Section 4: Security Architecture), `stories/13-encrypted-cloud-sync.md`.

### Relationship to Other Stories

This is the **cloud sync story**. It adds an encrypted sync layer on top of the existing local event store. It does not modify any existing local-only behavior -- sync is purely additive. All local features continue to work identically when sync is disabled.

- **Story 01** (Event Capture): `capture-event` is extended to append to the push queue when sync is enabled. The event write path itself is unchanged.
- **Story 02** (Hook Integration): Hooks remain unchanged. The sync layer operates downstream of hook-captured events.
- **Story 03** (Storage Layer): The `~/.claude-context/` directory gains new subdirectories (`sync/`, `synced/`). `config.json` is extended with a `sync` configuration block.
- **Story 04** (Projection Engine): Projections may eventually include synced events (deferred -- this story focuses on sync transport, not projection integration).
- **Story 05** (Context Recovery): `gc-query` may eventually search synced events (deferred).
- **Story 00** (Installation): `gc-install` and `gc-doctor` will need minor updates to handle the sync directory and `gc-sync` binary. These updates are captured in Task 12.

### Amendment Impacts on This Plan

- **Platform Evaluation** recommends DO-only architecture (skip R2 for primary storage). The client-side sync protocol targets `POST /api/sync/push` and `GET /api/sync/pull` -- server implementation is out of scope.
- **Encryption choice**: XChaCha20-Poly1305 via `libsodium-wrappers-sumo` WASM (192-bit nonce, no collision risk).
- **KDF choice**: Argon2id with MODERATE parameters (opslimit=3, memlimit=64MB) via libsodium's `crypto_pwhash`.

---

## Task Dependency Graph

```
Task 1: Vendor libsodium WASM
  |
  +---> Task 2: Crypto Module (encrypt/decrypt)
  |       |
  |       +---> Task 3: Key Generation & Storage
  |       |       |
  |       |       +---> Task 4: Key Derivation & Recovery (needs 2, 3)
  |       |       |
  |       |       +---> Task 5: Metadata Separation (needs 2)
  |       |               |
  |       |               +---> Task 6: Push Sync (needs 3, 5)
  |       |               |       |
  |       |               |       +---> Task 8: Offline Queue Management (needs 6)
  |       |               |
  |       |               +---> Task 7: Pull Sync (needs 3, 5)
  |       |                       |
  |       |                       +---> Task 9: Conflict Resolution & Ordering (needs 7)
  |       |
  |       +---> Task 10: Selective Sync (needs 6)
  |
  +---> Task 11: gc-sync CLI & Status (needs 3, 4, 6, 7, 8, 10)
  |
  +---> Task 12: Integration with Existing Scripts (needs 6, 11)
  |
  +---> Task 13: Test Suite (needs all)
```

---

## Tasks

### Task 1: Vendor libsodium WASM

**Description**

Download and bundle the `libsodium-wrappers-sumo` WASM build into the project's vendor directory. This is the "sumo" variant that includes Argon2id (the slim variant omits it). GlobalContext has a no-npm philosophy, so the library is vendored as a self-contained module file.

The vendored file must be loadable via `require()` from Node.js without any package manager or build step.

**Prerequisites/Inputs**

- Internet access (one-time download).
- Node.js 18+ installed (for verification).
- The `libsodium-wrappers-sumo` npm package at a known version (pin to `0.7.15` or latest stable).

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `src/lib/vendor/libsodium-wrappers-sumo.js` | Vendored WASM bundle (self-contained CJS module) |
| `src/lib/vendor/README.md` | Version, source URL, SHA256 hash, license (ISC) |
| `scripts/vendor-libsodium.sh` | Script to re-vendor (download + verify + place) |

Vendoring process:

```bash
#!/usr/bin/env bash
# scripts/vendor-libsodium.sh
# Downloads libsodium-wrappers-sumo and extracts the CJS bundle

set -euo pipefail

VERSION="0.7.15"
TARBALL_URL="https://registry.npmjs.org/libsodium-wrappers-sumo/-/libsodium-wrappers-sumo-${VERSION}.tgz"
VENDOR_DIR="src/lib/vendor"
TMPDIR=$(mktemp -d)

mkdir -p "$VENDOR_DIR"

# Download and extract
curl -sL "$TARBALL_URL" | tar -xz -C "$TMPDIR"

# The CJS entry point is package/dist/modules-sumo/libsodium-wrappers.js
# It bundles the WASM inline (base64-encoded)
cp "$TMPDIR/package/dist/modules-sumo/libsodium-wrappers.js" \
   "$VENDOR_DIR/libsodium-wrappers-sumo.js"

# Also copy the libsodium-sumo WASM if it's a separate file
if [ -f "$TMPDIR/package/dist/modules-sumo/libsodium-sumo.wasm" ]; then
  cp "$TMPDIR/package/dist/modules-sumo/libsodium-sumo.wasm" \
     "$VENDOR_DIR/libsodium-sumo.wasm"
fi

# Record provenance
cat > "$VENDOR_DIR/README.md" << EOF
# Vendored: libsodium-wrappers-sumo

- Version: ${VERSION}
- Source: ${TARBALL_URL}
- License: ISC
- SHA256: $(sha256sum "$VENDOR_DIR/libsodium-wrappers-sumo.js" | awk '{print $1}')
- Vendored: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Includes Argon2id (sumo variant). Required for XChaCha20-Poly1305 encryption
and passphrase-based key derivation.
EOF

rm -rf "$TMPDIR"
echo "Vendored libsodium-wrappers-sumo v${VERSION} to ${VENDOR_DIR}/"
```

Verification after vendoring:

```javascript
// Quick smoke test
const _sodium = require('./src/lib/vendor/libsodium-wrappers-sumo');
(async () => {
  await _sodium.ready;
  const key = _sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  console.log('Key length:', key.length); // Should print 32
  console.log('Argon2id available:', typeof _sodium.crypto_pwhash === 'function');
})();
```

**Acceptance Criteria**

- [ ] `src/lib/vendor/libsodium-wrappers-sumo.js` exists and is a valid CJS module
- [ ] `require('./src/lib/vendor/libsodium-wrappers-sumo')` succeeds in Node.js 18+
- [ ] `sodium.ready` resolves successfully (WASM initialization)
- [ ] `sodium.crypto_aead_xchacha20poly1305_ietf_keygen()` returns a 32-byte Uint8Array
- [ ] `sodium.crypto_pwhash` is available (confirms sumo variant, not slim)
- [ ] `src/lib/vendor/README.md` documents version, source URL, and SHA256 hash
- [ ] `scripts/vendor-libsodium.sh` can re-vendor from scratch (reproducible)
- [ ] No npm install required -- the vendor directory is self-contained

**Edge Cases**

- If the npm registry is unreachable, the vendor script fails with a clear network error.
- If the WASM file structure changes between libsodium versions, the vendor script must be updated (the README records the exact version).
- The vendored file size is approximately 200-400KB (WASM inlined as base64). This is acceptable for a vendored dependency.

**Estimated Effort**: S (Small) -- 1-2 hours

---

### Task 2: Crypto Module (encrypt/decrypt)

**Description**

Create the core encryption module that wraps libsodium's XChaCha20-Poly1305 AEAD cipher. This module provides `initSodium()`, `encrypt()`, and `decrypt()` functions used by all other sync components. It is the single point of contact with libsodium for AEAD operations.

**Prerequisites/Inputs**

- Task 1 complete (vendored libsodium).
- The module receives keys as `Uint8Array` (32 bytes) and plaintext as `string` or `Uint8Array`.

**Implementation Details**

File to create: `src/sync/crypto.mjs`

```javascript
/**
 * GlobalContext Sync -- Crypto Module
 *
 * Wraps libsodium XChaCha20-Poly1305 for event encryption/decryption.
 * All sensitive data is encrypted before leaving the machine.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const _sodium = require('../lib/vendor/libsodium-wrappers-sumo');

let sodium = null;

/**
 * Initialize the libsodium WASM runtime.
 * Must be called once before any crypto operations.
 * Subsequent calls are no-ops (idempotent).
 *
 * @returns {Promise<object>} The initialized sodium instance
 */
export async function initSodium() {
  if (sodium) return sodium;
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}

/**
 * Get the initialized sodium instance.
 * Throws if initSodium() has not been called.
 *
 * @returns {object} The sodium instance
 */
export function getSodium() {
  if (!sodium) throw new Error('Sodium not initialized. Call initSodium() first.');
  return sodium;
}

// Constants
export const NONCE_BYTES = 24;  // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
export const KEY_BYTES = 32;    // crypto_aead_xchacha20poly1305_ietf_KEYBYTES
export const TAG_BYTES = 16;    // crypto_aead_xchacha20poly1305_ietf_ABYTES

/**
 * Encrypt a plaintext payload using XChaCha20-Poly1305.
 *
 * Generates a fresh random 24-byte nonce per call.
 * The nonce is returned alongside the ciphertext and is not secret.
 *
 * @param {Uint8Array|string} plaintext - The data to encrypt
 * @param {Uint8Array} key - 256-bit (32-byte) master key
 * @param {string|null} associatedData - Optional cleartext bound to ciphertext (AEAD)
 * @returns {{ ciphertext: Uint8Array, nonce: Uint8Array }}
 * @throws {Error} If sodium is not initialized or key is invalid
 */
export function encrypt(plaintext, key, associatedData = null) {
  const s = getSodium();

  if (!key || key.length !== KEY_BYTES) {
    throw new Error(`Invalid key: expected ${KEY_BYTES} bytes, got ${key ? key.length : 0}`);
  }

  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

  const plaintextBytes = typeof plaintext === 'string'
    ? s.from_string(plaintext)
    : plaintext;

  const ad = associatedData
    ? s.from_string(associatedData)
    : null;

  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintextBytes,
    ad,
    null, // nsec (unused, must be null)
    nonce,
    key
  );

  return { ciphertext, nonce };
}

/**
 * Decrypt a ciphertext payload using XChaCha20-Poly1305.
 *
 * @param {Uint8Array} ciphertext - The encrypted data (includes Poly1305 tag)
 * @param {Uint8Array} nonce - The 24-byte nonce used during encryption
 * @param {Uint8Array} key - 256-bit (32-byte) master key
 * @param {string|null} associatedData - Must match what was used during encryption
 * @returns {Uint8Array} The decrypted plaintext
 * @throws {Error} If authentication fails (tampered ciphertext, wrong key, wrong nonce)
 */
export function decrypt(ciphertext, nonce, key, associatedData = null) {
  const s = getSodium();

  if (!key || key.length !== KEY_BYTES) {
    throw new Error(`Invalid key: expected ${KEY_BYTES} bytes, got ${key ? key.length : 0}`);
  }

  if (!nonce || nonce.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce: expected ${NONCE_BYTES} bytes, got ${nonce ? nonce.length : 0}`);
  }

  const ad = associatedData
    ? s.from_string(associatedData)
    : null;

  const plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, // nsec (unused, must be null)
    ciphertext,
    ad,
    nonce,
    key
  );

  return plaintext;
}

/**
 * Encrypt a string and return base64-encoded ciphertext and nonce.
 * Convenience wrapper for the sync push payload format.
 *
 * @param {string} plaintextStr - JSON string to encrypt
 * @param {Uint8Array} key - Master key
 * @param {string|null} associatedData - Optional associated data
 * @returns {{ encrypted: string, nonce: string }} Base64-encoded strings
 */
export function encryptToBase64(plaintextStr, key, associatedData = null) {
  const s = getSodium();
  const { ciphertext, nonce } = encrypt(plaintextStr, key, associatedData);
  return {
    encrypted: s.to_base64(ciphertext),
    nonce: s.to_base64(nonce)
  };
}

/**
 * Decrypt base64-encoded ciphertext and nonce, return plaintext string.
 * Convenience wrapper for the sync pull payload format.
 *
 * @param {string} encryptedBase64 - Base64-encoded ciphertext
 * @param {string} nonceBase64 - Base64-encoded nonce
 * @param {Uint8Array} key - Master key
 * @param {string|null} associatedData - Optional associated data
 * @returns {string} Decrypted plaintext string
 */
export function decryptFromBase64(encryptedBase64, nonceBase64, key, associatedData = null) {
  const s = getSodium();
  const ciphertext = s.from_base64(encryptedBase64);
  const nonce = s.from_base64(nonceBase64);
  const plaintext = decrypt(ciphertext, nonce, key, associatedData);
  return s.to_string(plaintext);
}
```

**Acceptance Criteria**

- [ ] `initSodium()` resolves and subsequent calls are no-ops
- [ ] `encrypt()` generates a fresh random 24-byte nonce per call
- [ ] `encrypt()` rejects keys that are not exactly 32 bytes
- [ ] `decrypt()` correctly recovers plaintext given valid ciphertext, nonce, and key
- [ ] `decrypt()` throws on tampered ciphertext (authentication failure)
- [ ] `decrypt()` throws on wrong key
- [ ] `decrypt()` throws on wrong nonce
- [ ] Associated data, when provided, is bound to the ciphertext (changing AD causes decryption failure)
- [ ] String inputs are correctly converted to `Uint8Array` before encryption
- [ ] Round-trip: `decrypt(encrypt(m, k).ciphertext, encrypt(m, k).nonce, k) === m`
- [ ] `encryptToBase64` / `decryptFromBase64` convenience wrappers work correctly
- [ ] Two calls to `encrypt()` with the same plaintext and key produce different ciphertext (random nonce)

**Edge Cases**

- Empty string encryption: should produce valid ciphertext (16-byte tag only, plus nonce overhead).
- Very large payloads (10MB): should encrypt without running out of memory (streaming is not needed -- events are bounded).
- Calling `encrypt()` before `initSodium()`: throws a clear error.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 3: Key Generation & Storage

**Description**

Implement the master key lifecycle: generation, storage, loading, and machine ID derivation. The master key is a 256-bit random key generated via libsodium's `crypto_aead_xchacha20poly1305_ietf_keygen()`. It is stored at `~/.claude-context/sync/master.key` (base64-encoded, mode 0600) with metadata in `key.json`.

**Prerequisites/Inputs**

- Task 2 complete (crypto module initialized).
- `~/.claude-context/` directory exists (from Story 03).

**Implementation Details**

File to create: `src/sync/keys.mjs`

```javascript
/**
 * GlobalContext Sync -- Key Generation & Storage
 *
 * Manages the master encryption key lifecycle:
 * - Generate new 256-bit key
 * - Derive key_id (BLAKE2b hash, first 8 bytes, hex)
 * - Store/load master.key and key.json
 * - Derive machine_id from hostname + username
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { hostname, userInfo } from 'os';
import { initSodium, getSodium, KEY_BYTES } from './crypto.mjs';

/**
 * Ensure the sync directory exists with correct permissions.
 *
 * @param {string} basedir - The base directory (~/.claude-context)
 * @returns {string} Path to the sync directory
 */
export function ensureSyncDir(basedir) {
  const syncDir = join(basedir, 'sync');
  if (!existsSync(syncDir)) {
    mkdirSync(syncDir, { recursive: true, mode: 0o700 });
  }

  // Ensure subdirectories
  for (const sub of ['queue', 'cursors', 'old-keys']) {
    const subDir = join(syncDir, sub);
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true, mode: 0o700 });
    }
  }

  return syncDir;
}

/**
 * Generate a new 256-bit master encryption key.
 *
 * @returns {{ key: Uint8Array, keyId: string }}
 */
export function generateMasterKey() {
  const sodium = getSodium();
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();

  // key_id: first 8 bytes of BLAKE2b-256 hash of the key, hex-encoded
  const hash = sodium.crypto_generichash(32, key);
  const keyId = sodium.to_hex(hash.slice(0, 8)); // 16 hex chars

  return { key, keyId };
}

/**
 * Derive a deterministic machine ID from hostname + username.
 *
 * @returns {string} Machine ID, e.g., "macbook-pro-f3a2b1"
 */
export function deriveMachineId() {
  const sodium = getSodium();
  const host = hostname();
  const user = userInfo().username;
  const hash = sodium.crypto_generichash(32, sodium.from_string(host + user));
  const sanitizedHost = host.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  const hashSuffix = sodium.to_hex(hash.slice(0, 3)); // 6 hex chars
  return `${sanitizedHost}-${hashSuffix}`;
}

/**
 * Save the master key to disk.
 *
 * @param {string} basedir - The base directory (~/.claude-context)
 * @param {Uint8Array} key - The 32-byte master key
 * @param {string} keyId - The key_id (16 hex chars)
 */
export function saveMasterKey(basedir, key, keyId) {
  const sodium = getSodium();
  const syncDir = ensureSyncDir(basedir);

  // Save raw key as base64
  const keyPath = join(syncDir, 'master.key');
  writeFileSync(keyPath, sodium.to_base64(key), { mode: 0o600 });
  chmodSync(keyPath, 0o600); // Ensure permissions even if umask interfered

  // Save key metadata
  const machineId = deriveMachineId();
  const keyMeta = {
    key_id: keyId,
    algorithm: 'xchacha20-poly1305',
    kdf: 'none',
    created_at: new Date().toISOString(),
    machine_id: machineId
  };
  const keyJsonPath = join(syncDir, 'key.json');
  writeFileSync(keyJsonPath, JSON.stringify(keyMeta, null, 2), { mode: 0o600 });
  chmodSync(keyJsonPath, 0o600);

  return { keyPath, keyJsonPath, machineId };
}

/**
 * Load the master key from disk.
 *
 * @param {string} basedir - The base directory (~/.claude-context)
 * @returns {{ key: Uint8Array, keyId: string, machineId: string } | null}
 *          null if no key exists
 */
export function loadMasterKey(basedir) {
  const sodium = getSodium();
  const keyPath = join(basedir, 'sync', 'master.key');
  const keyJsonPath = join(basedir, 'sync', 'key.json');

  if (!existsSync(keyPath) || !existsSync(keyJsonPath)) {
    return null;
  }

  const keyBase64 = readFileSync(keyPath, 'utf8').trim();
  const key = sodium.from_base64(keyBase64);

  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid master key: expected ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const keyMeta = JSON.parse(readFileSync(keyJsonPath, 'utf8'));

  return {
    key,
    keyId: keyMeta.key_id,
    machineId: keyMeta.machine_id
  };
}

/**
 * Check if a master key already exists.
 *
 * @param {string} basedir - The base directory
 * @returns {boolean}
 */
export function masterKeyExists(basedir) {
  return existsSync(join(basedir, 'sync', 'master.key'));
}
```

Additional file: `src/sync/config.mjs`

```javascript
/**
 * GlobalContext Sync -- Configuration Management
 *
 * Reads/writes sync.json and manages sync configuration
 * within the main config.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Load sync configuration from sync.json.
 *
 * @param {string} basedir - The base directory
 * @returns {object} Sync configuration, or defaults if file missing
 */
export function loadSyncConfig(basedir) {
  const syncJsonPath = join(basedir, 'sync', 'sync.json');

  const defaults = {
    server_url: 'https://sync.agentcontext.dev',
    machine_id: null,
    key_id: null,
    user_id: null,
    token: null,
    token_expires_at: null,
    push_interval_ms: 5000,
    pull_interval_ms: 30000,
    batch_size: 50,
    max_retries: 10,
    created_at: null
  };

  if (!existsSync(syncJsonPath)) {
    return defaults;
  }

  const stored = JSON.parse(readFileSync(syncJsonPath, 'utf8'));
  return { ...defaults, ...stored };
}

/**
 * Save sync configuration to sync.json.
 *
 * @param {string} basedir - The base directory
 * @param {object} config - Configuration to save
 */
export function saveSyncConfig(basedir, config) {
  const syncJsonPath = join(basedir, 'sync', 'sync.json');
  writeFileSync(syncJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Check if sync is enabled in the main config.json.
 *
 * @param {string} basedir - The base directory
 * @returns {boolean}
 */
export function isSyncEnabled(basedir) {
  const configPath = join(basedir, 'config.json');
  if (!existsSync(configPath)) return false;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config.sync?.enabled === true;
  } catch {
    return false;
  }
}
```

Directory structure created by this task:

```
~/.claude-context/
  sync/
    master.key          # Base64-encoded 32-byte key (mode 0600)
    key.json            # Key metadata (mode 0600)
    sync.json           # Sync configuration (mode 0600)
    queue/              # Push queue (mode 0700)
    cursors/            # Pull cursors (mode 0700)
    old-keys/           # Rotated keys (mode 0700)
```

**Acceptance Criteria**

- [ ] `generateMasterKey()` produces a 32-byte key and a 16-character hex key_id
- [ ] `generateMasterKey()` produces different keys on each call
- [ ] `key_id` is derived from BLAKE2b-256 hash of the key (first 8 bytes, hex-encoded)
- [ ] `saveMasterKey()` writes `master.key` with permissions 0600
- [ ] `saveMasterKey()` writes `key.json` with correct metadata fields
- [ ] `loadMasterKey()` correctly reads back the key and metadata
- [ ] `loadMasterKey()` returns null if no key exists (not an error)
- [ ] `masterKeyExists()` returns true after key is saved, false before
- [ ] `deriveMachineId()` is deterministic for the same hostname+username
- [ ] `deriveMachineId()` sanitizes hostname (lowercase, alphanumeric + hyphens only)
- [ ] `ensureSyncDir()` creates `sync/`, `sync/queue/`, `sync/cursors/`, `sync/old-keys/` with mode 0700
- [ ] Running key generation a second time does not overwrite an existing key (enforced by caller in gc-sync setup)

**Edge Cases**

- Hostname contains special characters (e.g., `user@host.local`): sanitized to `userhostlocal-<hash>`.
- Master key file exists but is corrupt (not valid base64): `loadMasterKey()` throws with a descriptive error.
- Disk is read-only: `saveMasterKey()` throws; caller handles gracefully.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 4: Key Derivation & Recovery

**Description**

Implement passphrase-based key derivation using Argon2id and the recovery blob system for cross-device key transfer. A user can optionally derive a recovery key from a passphrase, which is used to encrypt the master key. The encrypted master key (recovery blob) can be safely stored on the sync server or transferred between machines.

**Prerequisites/Inputs**

- Task 2 complete (crypto module with encrypt/decrypt).
- Task 3 complete (key generation and storage).
- libsodium sumo variant (for `crypto_pwhash` / Argon2id support).

**Implementation Details**

File to create: `src/sync/recovery.mjs`

```javascript
/**
 * GlobalContext Sync -- Key Derivation & Recovery
 *
 * Argon2id key derivation from passphrase for cross-device recovery.
 * Creates and reads recovery blobs (master key encrypted with passphrase-derived key).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getSodium } from './crypto.mjs';
import { encrypt, decrypt } from './crypto.mjs';

// KDF Constants (Argon2id MODERATE)
export const KDF_OPS = 3;                 // crypto_pwhash_OPSLIMIT_MODERATE
export const KDF_MEM = 67108864;          // crypto_pwhash_MEMLIMIT_MODERATE (64MB)
export const KDF_SALT_BYTES = 16;         // crypto_pwhash_SALTBYTES
export const KDF_KEY_BYTES = 32;          // Output key length

/**
 * Derive a 256-bit encryption key from a passphrase using Argon2id.
 *
 * @param {string} passphrase - The user's passphrase
 * @param {Uint8Array} salt - 16-byte random salt
 * @returns {Uint8Array} 32-byte derived key
 */
export function deriveKeyFromPassphrase(passphrase, salt) {
  const sodium = getSodium();

  if (!salt || salt.length !== KDF_SALT_BYTES) {
    throw new Error(`Invalid salt: expected ${KDF_SALT_BYTES} bytes, got ${salt ? salt.length : 0}`);
  }

  const key = sodium.crypto_pwhash(
    KDF_KEY_BYTES,
    passphrase,
    salt,
    KDF_OPS,
    KDF_MEM,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  return key;
}

/**
 * Create a recovery blob: master key encrypted with passphrase-derived key.
 *
 * @param {Uint8Array} masterKey - The master key to protect
 * @param {string} passphrase - The user's passphrase
 * @returns {{ blob: object }} The recovery blob data (ready to serialize)
 */
export function createRecoveryBlob(masterKey, passphrase) {
  const sodium = getSodium();

  const salt = sodium.randombytes_buf(KDF_SALT_BYTES);
  const derivedKey = deriveKeyFromPassphrase(passphrase, salt);

  const { ciphertext, nonce } = encrypt(masterKey, derivedKey);

  // Zero out the derived key from memory
  sodium.memzero(derivedKey);

  return {
    version: 1,
    kdf: 'argon2id',
    kdf_ops: KDF_OPS,
    kdf_mem: KDF_MEM,
    salt: sodium.to_base64(salt),
    nonce: sodium.to_base64(nonce),
    encrypted_key: sodium.to_base64(ciphertext)
  };
}

/**
 * Recover master key from recovery blob using passphrase.
 *
 * @param {object} recoveryData - Parsed recovery.enc contents
 * @param {string} passphrase - The user's passphrase
 * @returns {Uint8Array} The recovered master key
 * @throws {Error} If passphrase is wrong (decryption authentication failure)
 */
export function recoverMasterKey(recoveryData, passphrase) {
  const sodium = getSodium();

  const salt = sodium.from_base64(recoveryData.salt);
  const nonce = sodium.from_base64(recoveryData.nonce);
  const encryptedKey = sodium.from_base64(recoveryData.encrypted_key);

  // Use stored KDF parameters (self-describing blob)
  const ops = recoveryData.kdf_ops || KDF_OPS;
  const mem = recoveryData.kdf_mem || KDF_MEM;

  const derivedKey = sodium.crypto_pwhash(
    KDF_KEY_BYTES,
    passphrase,
    salt,
    ops,
    mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  // Throws if passphrase is wrong (authentication tag mismatch)
  const masterKey = decrypt(encryptedKey, nonce, derivedKey);

  // Zero out the derived key from memory
  sodium.memzero(derivedKey);

  return masterKey;
}

/**
 * Save recovery blob to disk.
 *
 * @param {string} basedir - The base directory
 * @param {object} blob - Recovery blob data from createRecoveryBlob()
 */
export function saveRecoveryBlob(basedir, blob) {
  const recoveryPath = join(basedir, 'sync', 'recovery.enc');
  writeFileSync(recoveryPath, JSON.stringify(blob, null, 2), { mode: 0o600 });
}

/**
 * Load recovery blob from disk.
 *
 * @param {string} basedir - The base directory
 * @returns {object|null} Recovery blob data, or null if not found
 */
export function loadRecoveryBlob(basedir) {
  const recoveryPath = join(basedir, 'sync', 'recovery.enc');
  if (!existsSync(recoveryPath)) return null;
  return JSON.parse(readFileSync(recoveryPath, 'utf8'));
}

/**
 * Update key.json with KDF parameters after passphrase setup.
 *
 * @param {string} basedir - The base directory
 * @param {Uint8Array} salt - The salt used for derivation
 */
export function updateKeyJsonWithKdf(basedir, salt) {
  const sodium = getSodium();
  const keyJsonPath = join(basedir, 'sync', 'key.json');
  const keyMeta = JSON.parse(readFileSync(keyJsonPath, 'utf8'));

  keyMeta.kdf = 'argon2id';
  keyMeta.kdf_salt = sodium.to_base64(salt);
  keyMeta.kdf_ops = KDF_OPS;
  keyMeta.kdf_mem = KDF_MEM;

  writeFileSync(keyJsonPath, JSON.stringify(keyMeta, null, 2), { mode: 0o600 });
}
```

**Acceptance Criteria**

- [ ] Argon2id derivation uses parameters: opslimit=3, memlimit=64MB, ALG_ARGON2ID13
- [ ] A random 16-byte salt is generated per passphrase setup
- [ ] `deriveKeyFromPassphrase()` is deterministic: same passphrase + salt produces same key
- [ ] `deriveKeyFromPassphrase()` with different salt produces a different key
- [ ] `createRecoveryBlob()` + `recoverMasterKey()` round-trip recovers the master key
- [ ] `recoverMasterKey()` throws a clear error on wrong passphrase (authentication failure)
- [ ] Recovery blob format is self-describing (includes KDF parameters: version, kdf, ops, mem)
- [ ] The passphrase-derived key is zeroed from memory after use (`sodium.memzero`)
- [ ] Key derivation completes in under 5 seconds on modern hardware
- [ ] `recovery.enc` is written with mode 0600
- [ ] The recovery blob can be safely stored on the sync server (useless without passphrase)

**Edge Cases**

- Empty passphrase: Argon2id accepts it (produces a valid key), but the CLI should warn the user (Task 11 handles this).
- Very long passphrase (>1MB): libsodium handles this correctly.
- Recovery blob has been modified (tampered `encrypted_key`): `recoverMasterKey()` throws authentication error.
- KDF parameters in recovery blob differ from current constants: uses the blob's parameters (forward compatibility).

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 5: Metadata Separation

**Description**

Implement the event splitting logic that separates each GlobalContext event into cleartext metadata (safe for server-side queries) and sensitive payload (encrypted before transmission). This is the core privacy boundary of the sync system.

**Prerequisites/Inputs**

- Task 2 complete (crypto module for encrypting the sensitive bucket).
- Knowledge of all 10 event types from Story 01 (SessionStarted, UserPromptReceived, ToolCallRequested, ToolCallCompleted, ToolCallFailed, AgentSpawned, AgentCompleted, TurnCompleted, CompactionTriggered, SessionEnded).

**Implementation Details**

File to create: `src/sync/metadata.mjs`

```javascript
/**
 * GlobalContext Sync -- Metadata Separation
 *
 * Splits events into cleartext metadata (for server-side queries)
 * and sensitive payload (encrypted before transmission).
 *
 * Classification: see stories/13-encrypted-cloud-sync.md Section 4.
 */

// Fields that are always extracted as cleartext metadata from event.data
const CLEARTEXT_DATA_FIELDS = new Set([
  'tool_name',
  'tool_use_id',
  'source',
  'model',
  'stop_hook_active',
  'trigger',
  'reason',
  'agent_id',
  'agent_type',
  'is_interrupt'
]);

// Fields in event.data that are always sensitive (encrypted)
const SENSITIVE_DATA_FIELDS = new Set([
  'prompt',
  'tool_input',
  'tool_response',
  'error',
  'transcript_path'
]);

/**
 * Split an event into cleartext metadata and sensitive payload.
 *
 * @param {object} event - A full GlobalContext event envelope
 * @returns {{ metadata: object, sensitive: object }}
 */
export function splitEvent(event) {
  const data = event.data || {};

  // Build cleartext metadata from envelope fields
  const metadata = {
    event_id: event.event_id,
    event_type: event.event_type,
    project_id: event.project_id,
    session_id: event.session_id,
    sequence: event.sequence,
    timestamp: event.timestamp
  };

  // Include Lamport timestamp if present
  if (event.lamport !== undefined) {
    metadata.lamport = event.lamport;
  }

  // Extract cleartext data fields
  for (const field of CLEARTEXT_DATA_FIELDS) {
    if (data[field] !== undefined && data[field] !== null) {
      metadata[field] = data[field];
    }
  }

  // Build sensitive payload with full raw data for reconstruction
  const sensitive = {
    _raw_data: data
  };

  // Explicitly list sensitive fields for validation/debugging
  for (const field of SENSITIVE_DATA_FIELDS) {
    if (data[field] !== undefined && data[field] !== null) {
      sensitive[field] = data[field];
    }
  }

  return { metadata, sensitive };
}

/**
 * Reassemble a full event from cleartext metadata and decrypted sensitive payload.
 *
 * @param {object} metadata - Cleartext metadata from server
 * @param {object} sensitive - Decrypted sensitive payload
 * @returns {object} Full event envelope
 */
export function reassembleEvent(metadata, sensitive) {
  const event = {
    event_id: metadata.event_id,
    event_type: metadata.event_type,
    project_id: metadata.project_id,
    session_id: metadata.session_id,
    sequence: metadata.sequence,
    timestamp: metadata.timestamp,
    data: sensitive._raw_data
  };

  // Restore Lamport timestamp if present
  if (metadata.lamport !== undefined) {
    event.lamport = metadata.lamport;
  }

  return event;
}

/**
 * Validate that no sensitive fields leak into metadata.
 * Used in tests and as a safety check before push.
 *
 * @param {object} metadata - Metadata to validate
 * @returns {{ valid: boolean, leakedFields: string[] }}
 */
export function validateMetadataNoLeaks(metadata) {
  const leakedFields = [];

  for (const field of SENSITIVE_DATA_FIELDS) {
    if (metadata[field] !== undefined) {
      leakedFields.push(field);
    }
  }

  // Also check for common sensitive substrings in values
  // (This is a defense-in-depth check, not a primary security mechanism)
  return {
    valid: leakedFields.length === 0,
    leakedFields
  };
}

// Export field sets for testing
export { CLEARTEXT_DATA_FIELDS, SENSITIVE_DATA_FIELDS };
```

**Acceptance Criteria**

- [ ] `splitEvent()` correctly classifies all fields from all 10 event types
- [ ] Prompts, tool inputs, tool responses, errors, and transcript paths are always in the sensitive bucket
- [ ] Event type, project ID, session ID, sequence, timestamp, tool name, and model are always cleartext
- [ ] Null/undefined cleartext fields are omitted from metadata to reduce payload size
- [ ] `sensitive._raw_data` contains the complete original `data` object for full reconstruction
- [ ] `reassembleEvent()` produces an event identical to the original input
- [ ] The split is deterministic: same input always produces the same output
- [ ] Unknown fields in `data` are captured in `_raw_data` (forward compatibility)
- [ ] `validateMetadataNoLeaks()` detects if a sensitive field was accidentally placed in metadata

**Edge Cases**

- Event with no `data` field: produces empty `_raw_data`, no sensitive fields extracted.
- Event with extra unknown fields in `data`: captured in `_raw_data` for forward compatibility.
- Boolean cleartext field is `false` (not null): correctly included in metadata.
- Large `tool_response` (megabytes): goes entirely into the sensitive bucket.

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 6: Push Sync

**Description**

Implement the push pipeline: reading events from the push queue, splitting metadata/sensitive, encrypting the sensitive payload, and posting batches to the sync server. Includes queue management (append, cleanup, dead-letter), retry with exponential backoff, and integration with `capture-event` for queue appending.

**Prerequisites/Inputs**

- Task 3 complete (key loading for encryption).
- Task 5 complete (metadata separation).
- Task 2 complete (encryption).
- `capture-event` from Story 01 (modified to append to push queue).

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `src/sync/push.mjs` | Push queue processing, batching, HTTP push |
| `src/sync/queue.mjs` | Queue read/write/cleanup, dead-letter management |
| `src/sync/retry.mjs` | Exponential backoff with jitter calculation |

**`src/sync/retry.mjs`** -- Retry delay calculation:

```javascript
// Constants
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 300000;   // 5 minutes
export const MAX_RETRIES = 10;
export const JITTER_FACTOR = 0.5;

/**
 * Calculate retry delay with exponential backoff and jitter.
 *
 * @param {number} retryCount - Number of previous retries (0-based)
 * @returns {number} Delay in milliseconds
 */
export function calculateRetryDelay(retryCount) {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
  const clampedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
  const jitterMin = clampedDelay * (1 - JITTER_FACTOR);
  const jitterMax = clampedDelay * (1 + JITTER_FACTOR);
  return Math.round(jitterMin + Math.random() * (jitterMax - jitterMin));
}
```

**`src/sync/queue.mjs`** -- Queue management:

```javascript
/**
 * GlobalContext Sync -- Push Queue Management
 *
 * JSONL-based queue at ~/.claude-context/sync/queue/pending.jsonl
 * Protected by flock for concurrent access from capture-event.
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export const MAX_QUEUE_ENTRIES = 100000;
export const MAX_QUEUE_FILE_SIZE = 50 * 1024 * 1024;  // 50MB
export const MAX_EVENT_SIZE = 10 * 1024 * 1024;        // 10MB

/**
 * Read all pending queue entries.
 *
 * @param {string} basedir
 * @returns {Array<object>} Queue entries
 */
export function readQueue(basedir) {
  const queuePath = join(basedir, 'sync', 'queue', 'pending.jsonl');
  if (!existsSync(queuePath)) return [];

  const content = readFileSync(queuePath, 'utf8').trim();
  if (!content) return [];

  return content.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

/**
 * Write queue entries back (atomic: write tmp then rename).
 *
 * @param {string} basedir
 * @param {Array<object>} entries
 */
export function writeQueue(basedir, entries) {
  const queuePath = join(basedir, 'sync', 'queue', 'pending.jsonl');
  const tmpPath = queuePath + '.tmp';

  const content = entries.length > 0
    ? entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    : '';

  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, queuePath);
}

/**
 * Remove specific entries from the queue by their path field.
 *
 * @param {string} basedir
 * @param {Set<string>} pathsToRemove - Set of event paths to remove
 */
export function removeFromQueue(basedir, pathsToRemove) {
  const entries = readQueue(basedir);
  const remaining = entries.filter(e => !pathsToRemove.has(e.path));
  writeQueue(basedir, remaining);
}

/**
 * Move entries to the dead-letter queue.
 *
 * @param {string} basedir
 * @param {Array<object>} entries - Entries that exceeded max retries
 */
export function moveToDeadLetter(basedir, entries) {
  const dlPath = join(basedir, 'sync', 'queue', 'dead-letter.jsonl');
  const lines = entries.map(e => JSON.stringify({
    ...e,
    dead_lettered_at: new Date().toISOString()
  })).join('\n') + '\n';

  // Append to dead-letter file
  const existing = existsSync(dlPath)
    ? readFileSync(dlPath, 'utf8')
    : '';
  writeFileSync(dlPath, existing + lines, { mode: 0o600 });
}

/**
 * Get the number of pending entries in the queue.
 *
 * @param {string} basedir
 * @returns {number}
 */
export function getQueueDepth(basedir) {
  return readQueue(basedir).length;
}

/**
 * Enforce queue size limits. Drops oldest entries if limits are exceeded.
 *
 * @param {string} basedir
 * @returns {{ dropped: number }} Number of entries dropped
 */
export function enforceQueueLimits(basedir) {
  const queuePath = join(basedir, 'sync', 'queue', 'pending.jsonl');
  if (!existsSync(queuePath)) return { dropped: 0 };

  const entries = readQueue(basedir);

  let dropped = 0;

  // Check entry count
  if (entries.length > MAX_QUEUE_ENTRIES) {
    const trimCount = Math.floor(entries.length * 0.2);
    entries.splice(0, trimCount);
    dropped += trimCount;
  }

  // Check file size
  const stats = statSync(queuePath);
  if (stats.size > MAX_QUEUE_FILE_SIZE) {
    const trimCount = Math.floor(entries.length * 0.2);
    entries.splice(0, trimCount);
    dropped += trimCount;
  }

  if (dropped > 0) {
    writeQueue(basedir, entries);
    console.error(`[gc-sync] WARN: Queue exceeded limits. Dropped ${dropped} oldest entries.`);
  }

  return { dropped };
}
```

**`src/sync/push.mjs`** -- Push batch processing:

```javascript
/**
 * GlobalContext Sync -- Push Sync
 *
 * Reads pending events, encrypts sensitive payloads, and pushes
 * batches to the sync server.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { encryptToBase64 } from './crypto.mjs';
import { splitEvent } from './metadata.mjs';
import { readQueue, removeFromQueue, moveToDeadLetter, enforceQueueLimits } from './queue.mjs';
import { calculateRetryDelay, MAX_RETRIES } from './retry.mjs';
import { shouldSyncProject } from './selective.mjs';
import { updateSyncStatus } from './status.mjs';

export const BATCH_SIZE = 50;
export const MAX_BATCH_BYTES = 5 * 1024 * 1024;  // 5MB

/**
 * Process the push queue, sending events in batches.
 *
 * @param {object} config - { basedir, serverUrl, token, machineId, keyId }
 * @param {Uint8Array} masterKey - Encryption key
 * @param {object} fullConfig - Full config.json contents (for selective sync)
 * @returns {{ pushed: number, failed: number, skipped: number }}
 */
export async function processPushQueue(config, masterKey, fullConfig) {
  enforceQueueLimits(config.basedir);

  const entries = readQueue(config.basedir);
  if (entries.length === 0) return { pushed: 0, failed: 0, skipped: 0 };

  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  // Filter out entries for disabled projects
  const syncableEntries = [];
  const skipPaths = new Set();

  for (const entry of entries) {
    // Extract project_id from path: events/{project-id}/{session-id}/{seq}.json
    const parts = entry.path.split('/');
    const projectId = parts.length >= 2 ? parts[1] : null;

    if (projectId && !shouldSyncProject(fullConfig, projectId)) {
      skipPaths.add(entry.path);
      skipped++;
      continue;
    }
    syncableEntries.push(entry);
  }

  // Remove skipped entries from queue
  if (skipPaths.size > 0) {
    removeFromQueue(config.basedir, skipPaths);
    console.error(`[gc-sync] Skipping ${skipped} events for disabled projects`);
  }

  // Batch the syncable entries
  const batches = [];
  let currentBatch = [];
  let currentBytes = 0;

  for (const entry of syncableEntries) {
    const eventPath = join(config.basedir, entry.path);
    if (!existsSync(eventPath)) {
      // Event file was deleted locally, remove from queue
      skipPaths.add(entry.path);
      continue;
    }

    const eventJson = readFileSync(eventPath, 'utf8');
    const eventSize = Buffer.byteLength(eventJson, 'utf8');

    if (currentBatch.length >= BATCH_SIZE || currentBytes + eventSize > MAX_BATCH_BYTES) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push({ entry, eventJson });
    currentBytes += eventSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Push each batch
  for (const batch of batches) {
    const result = await pushBatch(batch, config, masterKey);
    if (result.success) {
      pushed += result.accepted;
      failed += result.rejected;
    } else {
      // Increment retry counters for failed batch
      for (const { entry } of batch) {
        entry.retries = (entry.retries || 0) + 1;
        entry.last_attempt = new Date().toISOString();
        entry.last_error = result.error;

        if (entry.retries >= MAX_RETRIES) {
          moveToDeadLetter(config.basedir, [entry]);
          removeFromQueue(config.basedir, new Set([entry.path]));
          console.error(`[gc-sync] Event ${entry.path} moved to dead-letter after ${MAX_RETRIES} retries`);
        }
      }
      failed += batch.length;
    }
  }

  return { pushed, failed, skipped };
}

/**
 * Push a single batch of events to the sync server.
 *
 * @param {Array} batch - Array of { entry, eventJson }
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 * @returns {{ success: boolean, accepted: number, rejected: number, error: string|null }}
 */
async function pushBatch(batch, config, masterKey) {
  const events = batch.map(({ eventJson }) => {
    const event = JSON.parse(eventJson);
    const { metadata, sensitive } = splitEvent(event);
    const sensitiveStr = JSON.stringify(sensitive);
    const { encrypted, nonce } = encryptToBase64(sensitiveStr, masterKey);

    return { metadata, encrypted, nonce };
  });

  const body = JSON.stringify({
    machine_id: config.machineId,
    key_id: config.keyId,
    events
  });

  try {
    const response = await fetch(`${config.serverUrl}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body
    });

    if (response.ok || response.status === 207) {
      const result = await response.json();
      const rejectedIds = new Set((result.errors || []).map(e => e.event_id));

      // Remove accepted events from queue
      const acceptedPaths = new Set();
      for (const { entry, eventJson } of batch) {
        const event = JSON.parse(eventJson);
        if (!rejectedIds.has(event.event_id)) {
          acceptedPaths.add(entry.path);
        }
      }
      removeFromQueue(config.basedir, acceptedPaths);

      // Also remove duplicate_event rejections (they are already on the server)
      const dupPaths = new Set();
      for (const err of (result.errors || [])) {
        if (err.error === 'duplicate_event') {
          const matching = batch.find(({ eventJson }) => {
            const ev = JSON.parse(eventJson);
            return ev.event_id === err.event_id;
          });
          if (matching) dupPaths.add(matching.entry.path);
        }
      }
      if (dupPaths.size > 0) removeFromQueue(config.basedir, dupPaths);

      return {
        success: true,
        accepted: result.accepted || 0,
        rejected: result.rejected || 0,
        error: null
      };
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
      return {
        success: false,
        accepted: 0,
        rejected: batch.length,
        error: `rate_limited:${retryAfter}`
      };
    }

    return {
      success: false,
      accepted: 0,
      rejected: batch.length,
      error: `http_${response.status}`
    };

  } catch (err) {
    return {
      success: false,
      accepted: 0,
      rejected: batch.length,
      error: err.message
    };
  }
}
```

**Modification to `capture-event`**: After writing the event file, append to the push queue if sync is enabled. This is a bash-side change to the existing `src/capture-event` script:

```bash
# Appended after the event file write in capture-event:
# Queue for sync push (if sync is enabled)
SYNC_ENABLED=$(jq -r '.sync.enabled // false' "$BASE_DIR/config.json" 2>/dev/null)
if [ "$SYNC_ENABLED" = "true" ]; then
  QUEUE_FILE="$BASE_DIR/sync/queue/pending.jsonl"
  if [ -d "$(dirname "$QUEUE_FILE")" ]; then
    EVENT_REL_PATH="events/$project_id/$safe_session_id/${padded}.json"
    EVENT_SIZE=$(stat -c%s "$EVENT_FILE" 2>/dev/null || stat -f%z "$EVENT_FILE" 2>/dev/null || echo 0)
    if [ "$EVENT_SIZE" -le 10485760 ]; then  # 10MB limit
      (
        flock -w 2 201 || exit 0
        printf '{"path":"%s","added_at":"%s","retries":0}\n' \
          "$EVENT_REL_PATH" "$timestamp" >> "$QUEUE_FILE"
      ) 201>"$QUEUE_FILE.lock"
    else
      echo "[gc-sync] WARN: Event ${padded}.json (${EVENT_SIZE} bytes) exceeds sync limit (10MB). Skipping sync." >&2
    fi
  fi
fi
```

**Acceptance Criteria**

- [ ] Events are added to the push queue after capture when sync is enabled
- [ ] Queue file uses JSONL format (one JSON object per line)
- [ ] Queue writes are protected by flock to prevent concurrent corruption
- [ ] Events are pushed in batches (up to 50 events or 5MB per batch)
- [ ] Each pushed event contains cleartext metadata, base64-encoded ciphertext, and base64-encoded nonce
- [ ] Failed pushes are retried with exponential backoff (1s base, 5min cap, 50% jitter)
- [ ] After 10 retries, the event is moved to a dead-letter queue
- [ ] Rate-limited responses (HTTP 429) are handled by waiting for `Retry-After`
- [ ] Duplicate events (server returns `duplicate_event`) are removed from the queue (not retried)
- [ ] Successfully pushed events are atomically removed from the queue (write temp, rename)
- [ ] Queue limits enforced: 50MB file size, 100,000 entries, 10MB per event
- [ ] Events for disabled projects (selective sync) are removed from queue without pushing
- [ ] The push process does not block event capture (queue append is async via flock)

**Edge Cases**

- Event file deleted locally before push: entry removed from queue silently.
- Network disconnect mid-push: entire batch retained for retry; server-side duplicates handled on next push.
- Queue file is empty (no pending events): `processPushQueue()` returns immediately.
- Push queue grows very large during extended offline: `enforceQueueLimits()` trims oldest 20%.
- Key rotation while events are queued: events are encrypted at push time with current key, not at queue time.

**Estimated Effort**: L (Large) -- 6-8 hours

---

### Task 7: Pull Sync

**Description**

Implement the pull pipeline: fetching encrypted events from the sync server, decrypting them locally, reassembling full events, and writing them to the `synced/` directory. Includes cursor management for delta sync.

**Prerequisites/Inputs**

- Task 3 complete (key loading for decryption).
- Task 5 complete (event reassembly).
- Task 2 complete (decryption).

**Implementation Details**

File to create: `src/sync/pull.mjs`

```javascript
/**
 * GlobalContext Sync -- Pull Sync
 *
 * Fetches encrypted events from the sync server, decrypts locally,
 * and writes to ~/.claude-context/synced/{machine-id}/...
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { decryptFromBase64, getSodium } from './crypto.mjs';
import { reassembleEvent } from './metadata.mjs';
import { shouldSyncProject } from './selective.mjs';

/**
 * Load pull cursor for a given machine.
 *
 * @param {string} basedir
 * @param {string} machineId - Remote machine ID (or 'all')
 * @returns {object|null} Cursor data, or null for first pull
 */
export function loadCursor(basedir, machineId) {
  const cursorPath = join(basedir, 'sync', 'cursors', `${machineId || 'all'}.json`);
  if (!existsSync(cursorPath)) return null;
  return JSON.parse(readFileSync(cursorPath, 'utf8'));
}

/**
 * Save pull cursor for a given machine.
 *
 * @param {string} basedir
 * @param {string} machineId
 * @param {object} cursor - Cursor data
 */
export function saveCursor(basedir, machineId, cursor) {
  const cursorDir = join(basedir, 'sync', 'cursors');
  if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true, mode: 0o700 });

  const cursorPath = join(cursorDir, `${machineId || 'all'}.json`);
  const tmpPath = cursorPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), { mode: 0o600 });
  const { renameSync } = await import('fs');
  renameSync(tmpPath, cursorPath);
}

/**
 * Write a synced event to the local synced events directory.
 * Idempotent: does not overwrite existing events.
 *
 * @param {string} basedir
 * @param {string} sourceMachine - Machine ID the event came from
 * @param {object} event - The reassembled event envelope
 * @returns {boolean} true if written, false if already existed
 */
export function writeSyncedEvent(basedir, sourceMachine, event) {
  const dir = join(
    basedir,
    'synced',
    sourceMachine,
    event.project_id,
    event.session_id
  );

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filename = String(event.sequence).padStart(6, '0') + '.json';
  const filepath = join(dir, filename);

  // Idempotent: do not overwrite existing events
  if (existsSync(filepath)) return false;

  writeFileSync(filepath, JSON.stringify(event, null, 2), { mode: 0o600 });
  return true;
}

/**
 * Pull and decrypt events from the sync server.
 *
 * @param {object} config - { basedir, serverUrl, token, keyId, machineId }
 * @param {Uint8Array} masterKey - Decryption key
 * @param {object} fullConfig - Full config.json (for selective sync)
 * @param {object} options - { remoteMachineId, projectId, limit }
 * @returns {{ pulled: number, skipped: number, errors: number }}
 */
export async function pullEvents(config, masterKey, fullConfig, options = {}) {
  const { remoteMachineId, projectId, limit = 100 } = options;
  let totalPulled = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  const cursorKey = remoteMachineId || 'all';
  const cursor = loadCursor(config.basedir, cursorKey);

  const params = new URLSearchParams();
  if (cursor) {
    params.set('after', `${cursor.last_timestamp}:${cursor.last_sequence}`);
  }
  if (remoteMachineId) params.set('machine_id', remoteMachineId);
  if (projectId) params.set('project_id', projectId);
  params.set('limit', String(limit));

  let hasMore = true;

  while (hasMore) {
    const url = `${config.serverUrl}/api/sync/pull?${params.toString()}`;

    let response;
    try {
      response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${config.token}` }
      });
    } catch (err) {
      throw new Error(`Pull failed: network error: ${err.message}`);
    }

    if (!response.ok) {
      throw new Error(`Pull failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    for (const syncEvent of result.events) {
      // Check key_id
      if (syncEvent.key_id !== config.keyId) {
        console.error(`[gc-sync] WARN: Unknown key_id ${syncEvent.key_id}, skipping event`);
        totalSkipped++;
        continue;
      }

      // Check selective sync
      const eventProjectId = syncEvent.metadata.project_id;
      if (eventProjectId && !shouldSyncProject(fullConfig, eventProjectId)) {
        totalSkipped++;
        continue;
      }

      try {
        // Decrypt sensitive payload
        const sensitiveStr = decryptFromBase64(
          syncEvent.encrypted,
          syncEvent.nonce,
          masterKey
        );
        const sensitive = JSON.parse(sensitiveStr);

        // Reassemble full event
        const event = reassembleEvent(syncEvent.metadata, sensitive);

        // Write to synced directory
        const sourceMachine = syncEvent.metadata.machine_id;
        writeSyncedEvent(config.basedir, sourceMachine, event);
        totalPulled++;
      } catch (err) {
        console.error(`[gc-sync] ERROR decrypting event ${syncEvent.metadata.event_id}: ${err.message}`);
        totalErrors++;
      }
    }

    // Update cursor after processing page
    if (result.events.length > 0) {
      const lastEvent = result.events[result.events.length - 1];
      saveCursor(config.basedir, cursorKey, {
        machine_id: cursorKey,
        last_timestamp: lastEvent.metadata.timestamp,
        last_sequence: lastEvent.metadata.sequence,
        last_event_id: lastEvent.metadata.event_id,
        updated_at: new Date().toISOString()
      });

      params.set('after', `${lastEvent.metadata.timestamp}:${lastEvent.metadata.sequence}`);
    }

    hasMore = result.has_more === true;
  }

  return { pulled: totalPulled, skipped: totalSkipped, errors: totalErrors };
}
```

Synced events directory structure:

```
~/.claude-context/
  synced/
    {machine-id}/
      {project-id}/
        {session-id}/
          000001.json    # Full event envelope, decrypted
          000002.json
```

**Acceptance Criteria**

- [ ] `pullEvents()` fetches events from the sync server using cursor-based pagination
- [ ] Cursors are stored per-machine in `~/.claude-context/sync/cursors/`
- [ ] Delta sync: only events after the last cursor position are fetched
- [ ] First pull (no cursor) fetches all available events
- [ ] Encrypted payloads are decrypted locally using the master key
- [ ] Decrypted events are written to `~/.claude-context/synced/{machine-id}/...`
- [ ] Existing synced events are not overwritten (idempotent pull)
- [ ] Events with unknown `key_id` are skipped with a warning
- [ ] Pagination continues until `has_more` is false
- [ ] Pull supports filtering by machine_id and project_id
- [ ] Cursors are updated only after events are successfully written to disk
- [ ] Events for disabled projects (selective sync) are skipped during pull

**Edge Cases**

- Server returns empty event list (`has_more: false`): pull completes immediately, cursor unchanged.
- Decrypt fails for a single event (corrupt blob): event skipped with error log, pull continues.
- Cursor file missing (first pull): fetches all available events from server.
- Same event pulled twice (idempotent): `writeSyncedEvent()` detects existing file and skips.
- Clock skew between machines: cursor uses server-assigned position, not client timestamps.

**Estimated Effort**: L (Large) -- 5-6 hours

---

### Task 8: Offline Queue Management & Sync Loop

**Description**

Implement the background sync loop that continuously processes push and pull operations, handles offline detection, and manages the transition between online and offline states. This is the daemon-like component that runs in the background during active sessions.

**Prerequisites/Inputs**

- Task 6 complete (push sync).
- Task 7 complete (pull sync).

**Implementation Details**

File to create: `src/sync/loop.mjs`

```javascript
/**
 * GlobalContext Sync -- Background Sync Loop
 *
 * Runs continuously, checking connectivity, processing push queue,
 * and pulling new events. Handles offline-first behavior and catch-up.
 */

import { processPushQueue } from './push.mjs';
import { pullEvents } from './pull.mjs';
import { updateSyncStatus } from './status.mjs';
import { getQueueDepth } from './queue.mjs';
import { calculateRetryDelay } from './retry.mjs';

export const PUSH_INTERVAL_MS = 5000;
export const PULL_INTERVAL_MS = 30000;
export const CONNECTIVITY_CHECK_INTERVAL_MS = 30000;
export const CONNECTIVITY_TIMEOUT_MS = 5000;
export const CATCHUP_BATCH_DELAY_MS = 1000;

/**
 * Check if the sync server is reachable.
 *
 * @param {string} serverUrl
 * @returns {Promise<boolean>}
 */
export async function checkConnectivity(serverUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);
    const response = await fetch(`${serverUrl}/api/health`, {
      method: 'HEAD',
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Run a single sync cycle (push + pull).
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 * @param {object} fullConfig - Full config.json
 * @returns {{ pushResult: object, pullResult: object }}
 */
export async function runSyncCycle(config, masterKey, fullConfig) {
  const startTime = Date.now();

  updateSyncStatus(config.basedir, { state: 'syncing' });

  // Push
  const pushStart = Date.now();
  const pushResult = await processPushQueue(config, masterKey, fullConfig);
  const pushDuration = Date.now() - pushStart;

  if (pushResult.pushed > 0) {
    updateSyncStatus(config.basedir, {
      last_push: {
        timestamp: new Date().toISOString(),
        events_pushed: pushResult.pushed,
        duration_ms: pushDuration
      }
    });
  }

  // Pull
  const pullStart = Date.now();
  const pullResult = await pullEvents(config, masterKey, fullConfig);
  const pullDuration = Date.now() - pullStart;

  if (pullResult.pulled > 0) {
    updateSyncStatus(config.basedir, {
      last_pull: {
        timestamp: new Date().toISOString(),
        events_pulled: pullResult.pulled,
        duration_ms: pullDuration
      }
    });
  }

  // Update final state
  const queueDepth = getQueueDepth(config.basedir);
  updateSyncStatus(config.basedir, {
    state: queueDepth > 0 ? 'pending' : 'synced',
    queue: {
      pending: queueDepth,
      failed: pushResult.failed,
      dead_letter: 0 // TODO: count dead-letter entries
    }
  });

  return { pushResult, pullResult };
}

/**
 * Main sync loop. Runs continuously in the background.
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 * @param {object} fullConfig - Full config.json
 * @param {object} options - { signal: AbortSignal } for graceful shutdown
 */
export async function syncLoop(config, masterKey, fullConfig, options = {}) {
  const { signal } = options;
  let isOnline = false;
  let consecutiveFailures = 0;
  let lastPullTime = 0;

  while (!signal?.aborted) {
    // Check connectivity
    isOnline = await checkConnectivity(config.serverUrl);

    if (!isOnline) {
      updateSyncStatus(config.basedir, { state: 'offline' });
      await sleep(CONNECTIVITY_CHECK_INTERVAL_MS, signal);
      continue;
    }

    try {
      consecutiveFailures = 0;

      // Push pending events
      const pushResult = await processPushQueue(config, masterKey, fullConfig);

      // Pull periodically (less frequent than push)
      const now = Date.now();
      if (now - lastPullTime >= PULL_INTERVAL_MS) {
        await pullEvents(config, masterKey, fullConfig);
        lastPullTime = now;
      }

      const queueDepth = getQueueDepth(config.basedir);
      updateSyncStatus(config.basedir, {
        state: queueDepth > 0 ? 'pending' : 'synced'
      });

    } catch (err) {
      consecutiveFailures++;
      updateSyncStatus(config.basedir, {
        state: 'error',
        errors: [{ message: err.message, timestamp: new Date().toISOString() }]
      });
    }

    // Adaptive sleep
    const sleepMs = consecutiveFailures > 0
      ? calculateRetryDelay(consecutiveFailures)
      : PUSH_INTERVAL_MS;

    await sleep(sleepMs, signal);
  }
}

/**
 * Process backlog after coming online.
 *
 * @param {object} config
 * @param {Uint8Array} masterKey
 * @param {object} fullConfig
 */
export async function processCatchUp(config, masterKey, fullConfig) {
  const queueDepth = getQueueDepth(config.basedir);

  if (queueDepth > 50) {
    console.error(`[gc-sync] Catching up: ${queueDepth} events pending`);
  }

  while (getQueueDepth(config.basedir) > 0) {
    await processPushQueue(config, masterKey, fullConfig);
    if (getQueueDepth(config.basedir) > 0) {
      await sleep(CATCHUP_BATCH_DELAY_MS);
    }
  }
}

/**
 * Sleep for a duration, interruptible by AbortSignal.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
```

**Acceptance Criteria**

- [ ] All local features work identically with sync enabled or disabled
- [ ] Event capture is never blocked by sync (async queue append only)
- [ ] When offline, push queue accumulates without making network calls
- [ ] When offline, pull sync is skipped entirely
- [ ] Online detection uses a health check endpoint with 5-second timeout
- [ ] Connectivity is checked every 30 seconds when offline
- [ ] Coming online triggers catch-up processing of the pending queue
- [ ] Catch-up batches are rate-limited (1 second between batches)
- [ ] The sync loop runs with adaptive sleep (shorter when active, longer on errors)
- [ ] Sync state transitions are logged for debugging
- [ ] The loop is interruptible via AbortSignal for graceful shutdown

**Edge Cases**

- Server goes down mid-sync: error caught, status set to `error`, retry with backoff.
- Laptop lid closed during sync: loop pauses at sleep, resumes on wake.
- AbortSignal fires during push: current batch completes, loop exits.
- Zero events in queue: sync cycle completes instantly, sleeps for push interval.

**Estimated Effort**: M (Medium) -- 4-5 hours

---

### Task 9: Conflict Resolution & Ordering

**Description**

Implement the Lamport clock for cross-machine event ordering, the last-writer-wins merge strategy for metadata, and the event deduplication index.

**Prerequisites/Inputs**

- Task 7 complete (pull sync writes events that may conflict).
- Understanding of event ordering requirements.

**Implementation Details**

File to create: `src/sync/ordering.mjs`

```javascript
/**
 * GlobalContext Sync -- Conflict Resolution & Ordering
 *
 * Lamport timestamps for total ordering across machines.
 * Last-writer-wins for mutable metadata.
 * Event deduplication index.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Lamport timestamp for cross-machine event ordering.
 */
export class LamportClock {
  /**
   * @param {number} initialValue
   */
  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  /** Called when a local event is captured. */
  tick() {
    this.value += 1;
    return this.value;
  }

  /** Called when a remote event is received. */
  receive(remoteValue) {
    this.value = Math.max(this.value, remoteValue) + 1;
    return this.value;
  }

  toJSON() { return this.value; }

  static fromJSON(value) { return new LamportClock(value || 0); }
}

/**
 * Load the Lamport clock from disk.
 *
 * @param {string} basedir
 * @returns {LamportClock}
 */
export function loadLamportClock(basedir) {
  const clockPath = join(basedir, 'sync', 'lamport.json');
  if (!existsSync(clockPath)) return new LamportClock(0);

  const data = JSON.parse(readFileSync(clockPath, 'utf8'));
  return LamportClock.fromJSON(data.value);
}

/**
 * Save the Lamport clock to disk (atomic write).
 *
 * @param {string} basedir
 * @param {LamportClock} clock
 */
export function saveLamportClock(basedir, clock) {
  const clockPath = join(basedir, 'sync', 'lamport.json');
  const tmpPath = clockPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify({ value: clock.toJSON() }), { mode: 0o600 });
  const fs = require('fs');
  fs.renameSync(tmpPath, clockPath);
}

/**
 * Merge metadata from two sources using last-writer-wins.
 *
 * @param {object} local - Local metadata (must have updated_at or timestamp)
 * @param {object} remote - Remote metadata
 * @returns {object} Merged metadata
 */
export function mergeMetadata(local, remote) {
  const localTime = new Date(local.updated_at || local.timestamp || 0).getTime();
  const remoteTime = new Date(remote.updated_at || remote.timestamp || 0).getTime();

  return remoteTime > localTime
    ? { ...local, ...remote }
    : { ...remote, ...local };
}

/**
 * Compare two events for ordering.
 * Order by: Lamport timestamp > wall-clock timestamp > machine_id
 *
 * @param {object} a - Event with lamport, timestamp, machine_id
 * @param {object} b - Event with lamport, timestamp, machine_id
 * @returns {number} Negative if a < b, positive if a > b, 0 if equal
 */
export function compareEvents(a, b) {
  // 1. Lamport timestamp
  const lamportA = a.lamport || 0;
  const lamportB = b.lamport || 0;
  if (lamportA !== lamportB) return lamportA - lamportB;

  // 2. Wall-clock timestamp
  const timeA = new Date(a.timestamp || 0).getTime();
  const timeB = new Date(b.timestamp || 0).getTime();
  if (timeA !== timeB) return timeA - timeB;

  // 3. Machine ID (deterministic tiebreak)
  const machineA = a.machine_id || '';
  const machineB = b.machine_id || '';
  return machineA.localeCompare(machineB);
}

/**
 * Event deduplication index.
 * Tracks which event_ids have been seen (local + synced).
 */

/**
 * Check if an event already exists in the dedup index.
 *
 * @param {string} basedir
 * @param {string} eventId
 * @returns {boolean}
 */
export function eventExists(basedir, eventId) {
  const indexPath = join(basedir, 'sync', 'event-index.json');
  if (!existsSync(indexPath)) return false;

  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  return index[eventId] === true;
}

/**
 * Add an event ID to the dedup index.
 *
 * @param {string} basedir
 * @param {string} eventId
 */
export function addToEventIndex(basedir, eventId) {
  const indexPath = join(basedir, 'sync', 'event-index.json');

  let index = {};
  if (existsSync(indexPath)) {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  }

  index[eventId] = true;

  const tmpPath = indexPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(index), { mode: 0o600 });
  const fs = require('fs');
  fs.renameSync(tmpPath, indexPath);
}
```

**Acceptance Criteria**

- [ ] `LamportClock.tick()` increments monotonically
- [ ] `LamportClock.receive()` jumps to `max(local, remote) + 1`
- [ ] Lamport clock is persisted to `sync/lamport.json`
- [ ] `mergeMetadata()` selects the entry with the later timestamp (last-writer-wins)
- [ ] `compareEvents()` orders by Lamport > wall-clock > machine_id
- [ ] `eventExists()` returns true for indexed events, false otherwise
- [ ] `addToEventIndex()` adds event IDs atomically
- [ ] Events never conflict: append-only, uniquely identified by (machine_id, project_id, session_id, sequence)
- [ ] Duplicate events are detected and ignored

**Edge Cases**

- Lamport clock file missing: starts at 0.
- Event index grows very large (100K+ entries): JSON parsing may be slow. Acceptable for v1; future optimization: use a Bloom filter or SQLite.
- Clock file corrupt: `loadLamportClock()` starts at 0 (safe -- Lamport values only need to be monotonically increasing per machine).

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 10: Selective Sync

**Description**

Implement per-project sync enable/disable with three modes (all, allowlist, blocklist). The selective sync configuration lives in `config.json` and is checked both at queue-append time (push) and at pull time.

**Prerequisites/Inputs**

- Task 6 complete (push references `shouldSyncProject()`).
- `config.json` exists (from Story 03).

**Implementation Details**

File to create: `src/sync/selective.mjs`

```javascript
/**
 * GlobalContext Sync -- Selective Sync
 *
 * Per-project sync enable/disable with three modes:
 * - all: sync all projects
 * - allowlist: only sync explicitly listed projects
 * - blocklist: sync all except explicitly blocked projects
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Check if a project is configured for sync.
 *
 * @param {object} config - Full config.json object (or object with sync property)
 * @param {string} projectId - Project ID to check
 * @returns {boolean} True if the project should be synced
 */
export function shouldSyncProject(config, projectId) {
  const syncConfig = config?.sync || {};

  // If sync is not enabled at all, nothing syncs
  if (syncConfig.enabled !== true) return false;

  const selective = syncConfig.selective || {};

  // If selective sync is not configured, sync everything
  if (!selective.mode || selective.mode === 'all') {
    return true;
  }

  const projectConfig = (selective.projects || {})[projectId];

  if (projectConfig) {
    return projectConfig.sync === true;
  }

  // Project not in the list -- use default
  if (selective.mode === 'allowlist') {
    // In allowlist mode, unlisted projects are NOT synced
    return selective.default_sync === true;
  }

  if (selective.mode === 'blocklist') {
    // In blocklist mode, unlisted projects ARE synced
    return selective.default_sync !== false;
  }

  return true;
}

/**
 * Enable or disable sync for a specific project.
 *
 * @param {string} basedir - Base directory
 * @param {string} projectId - Project ID
 * @param {boolean} enabled - true to enable sync, false to disable
 * @param {string} [label] - Human-readable project label
 */
export function setProjectSync(basedir, projectId, enabled, label = null) {
  const configPath = join(basedir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  if (!config.sync) config.sync = {};
  if (!config.sync.selective) config.sync.selective = { mode: 'all', projects: {} };
  if (!config.sync.selective.projects) config.sync.selective.projects = {};

  config.sync.selective.projects[projectId] = {
    sync: enabled,
    label: label || projectId.split('-').slice(0, -1).join('-') || projectId
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Set the selective sync mode.
 *
 * @param {string} basedir
 * @param {string} mode - 'all', 'allowlist', or 'blocklist'
 */
export function setSyncMode(basedir, mode) {
  if (!['all', 'allowlist', 'blocklist'].includes(mode)) {
    throw new Error(`Invalid sync mode: ${mode}. Must be: all, allowlist, or blocklist`);
  }

  const configPath = join(basedir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  if (!config.sync) config.sync = {};
  if (!config.sync.selective) config.sync.selective = {};

  config.sync.selective.mode = mode;

  // Set sensible defaults
  if (mode === 'allowlist') {
    config.sync.selective.default_sync = false;
  } else if (mode === 'blocklist') {
    config.sync.selective.default_sync = true;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * List all projects with their sync status.
 *
 * @param {string} basedir
 * @returns {Array<{ projectId: string, sync: boolean, label: string }>}
 */
export function listProjectSyncStatus(basedir) {
  const configPath = join(basedir, 'config.json');
  if (!existsSync(configPath)) return [];

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const selective = config?.sync?.selective || {};
  const projects = selective.projects || {};

  // Also scan the events directory for known projects
  const eventsDir = join(basedir, 'events');
  const knownProjects = new Set(Object.keys(projects));

  if (existsSync(eventsDir)) {
    const { readdirSync } = require('fs');
    for (const dir of readdirSync(eventsDir)) {
      knownProjects.add(dir);
    }
  }

  return Array.from(knownProjects).sort().map(projectId => {
    const projectConfig = projects[projectId];
    const syncEnabled = shouldSyncProject(config, projectId);

    return {
      projectId,
      sync: syncEnabled,
      label: projectConfig?.label || projectId,
      explicit: !!projectConfig
    };
  });
}
```

**Acceptance Criteria**

- [ ] `config.json` supports `sync.selective` configuration block
- [ ] Three sync modes: `all`, `allowlist`, `blocklist`
- [ ] Per-project sync enable/disable via `setProjectSync()`
- [ ] `shouldSyncProject()` returns true for allowlisted projects
- [ ] `shouldSyncProject()` returns false for blocklisted projects
- [ ] `shouldSyncProject()` respects `default_sync` for unlisted projects
- [ ] `setSyncMode()` changes the mode and sets appropriate defaults
- [ ] `listProjectSyncStatus()` shows all known projects with their sync status
- [ ] Default behavior (no selective sync configured) is to sync all projects
- [ ] Events for disabled projects are not added to the push queue (enforced by Task 6)

**Edge Cases**

- No `sync` section in `config.json`: all projects are treated as not synced (sync is disabled).
- No `selective` section in `sync`: all projects are synced (mode defaults to `all`).
- Project not in the projects list: uses `default_sync` based on mode.
- Config file corrupt: `shouldSyncProject()` returns false (fail-safe: don't sync on error).

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 11: gc-sync CLI & Status

**Description**

Create the `gc-sync` CLI command that provides the user-facing interface for all sync operations: setup, recover, push, pull, status, project management, key export/import, and reset.

**Prerequisites/Inputs**

- Tasks 3, 4, 6, 7, 8, 10 complete (all sync modules).
- Node.js 18+ for the CLI (ESM module).

**Implementation Details**

Files to create:

| File | Purpose |
|------|---------|
| `src/bin/gc-sync` | Main CLI entry point (bash wrapper) |
| `src/sync/cli.mjs` | CLI command dispatcher (Node.js) |
| `src/sync/status.mjs` | Sync status tracking |

**`src/sync/status.mjs`** -- Status management:

```javascript
/**
 * GlobalContext Sync -- Status Tracking
 *
 * Writes sync status to ~/.claude-context/sync/status.json
 * for consumption by the dashboard, CLI, and other tools.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

/**
 * Update the sync status file atomically.
 *
 * @param {string} basedir
 * @param {object} update - Partial status update to merge
 */
export function updateSyncStatus(basedir, update) {
  const statusPath = join(basedir, 'sync', 'status.json');
  const tmpPath = statusPath + '.tmp';

  let status = {};
  if (existsSync(statusPath)) {
    try {
      status = JSON.parse(readFileSync(statusPath, 'utf8'));
    } catch {
      status = {};
    }
  }

  const merged = {
    ...status,
    ...update,
    machines: { ...status.machines, ...(update.machines || {}) },
    updated_at: new Date().toISOString()
  };

  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmpPath, statusPath);
}

/**
 * Read the current sync status.
 *
 * @param {string} basedir
 * @returns {object} Status data
 */
export function readSyncStatus(basedir) {
  const statusPath = join(basedir, 'sync', 'status.json');
  if (!existsSync(statusPath)) {
    return { state: 'disabled', updated_at: null };
  }
  return JSON.parse(readFileSync(statusPath, 'utf8'));
}
```

**`src/bin/gc-sync`** -- Bash wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Resolve base directory
BASE_DIR="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"

# Resolve the Node.js CLI module
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When installed: $GC_BASE/bin/gc-sync -> $GC_BASE/sync/cli.mjs
# When developing: src/bin/gc-sync -> src/sync/cli.mjs

CLI_MODULE=""
if [ -f "$BASE_DIR/sync/cli.mjs" ]; then
  CLI_MODULE="$BASE_DIR/sync/cli.mjs"
elif [ -f "$SCRIPT_DIR/../sync/cli.mjs" ]; then
  CLI_MODULE="$SCRIPT_DIR/../sync/cli.mjs"
else
  echo "[gc-sync] ERROR: Cannot find sync CLI module." >&2
  exit 1
fi

exec node --experimental-modules "$CLI_MODULE" "$@"
```

**`src/sync/cli.mjs`** -- Command dispatcher (excerpt of key commands):

```javascript
#!/usr/bin/env node

/**
 * gc-sync CLI -- Command dispatcher
 *
 * Commands: setup, recover, push, pull, status,
 *           project (list|enable|disable|mode),
 *           export-key, import-key, reset
 */

import { initSodium, getSodium } from './crypto.mjs';
import { generateMasterKey, saveMasterKey, loadMasterKey,
         masterKeyExists, deriveMachineId, ensureSyncDir } from './keys.mjs';
import { createRecoveryBlob, recoverMasterKey,
         saveRecoveryBlob, loadRecoveryBlob } from './recovery.mjs';
import { readSyncStatus, updateSyncStatus } from './status.mjs';
import { loadSyncConfig, saveSyncConfig, isSyncEnabled } from './config.mjs';
import { processPushQueue } from './push.mjs';
import { pullEvents } from './pull.mjs';
import { setProjectSync, setSyncMode, listProjectSyncStatus } from './selective.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const basedir = process.env.CLAUDE_CONTEXT_PATH || join(process.env.HOME, '.claude-context');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'setup':     return await cmdSetup(args);
    case 'recover':   return await cmdRecover(args);
    case 'push':      return await cmdPush(args);
    case 'pull':      return await cmdPull(args);
    case 'status':    return await cmdStatus(args);
    case 'project':   return await cmdProject(args);
    case 'export-key': return await cmdExportKey(args);
    case 'import-key': return await cmdImportKey(args);
    case 'reset':     return await cmdReset(args);
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

// ... (each cmd* function implements the command per the story spec)
// Key function signatures:

// cmdSetup: initSodium -> check masterKeyExists -> generateMasterKey -> saveMasterKey
//           -> optionally prompt passphrase -> createRecoveryBlob -> saveSyncConfig

// cmdRecover: initSodium -> loadRecoveryBlob -> prompt passphrase -> recoverMasterKey
//             -> saveMasterKey

// cmdPush: initSodium -> loadMasterKey -> loadConfig -> processPushQueue

// cmdPull: initSodium -> loadMasterKey -> loadConfig -> pullEvents

// cmdStatus: readSyncStatus -> format and print

// cmdProject: list|enable|disable|mode -> delegate to selective.mjs functions

// cmdExportKey: loadMasterKey -> print base64 key to stdout

// cmdImportKey: read base64 from arg -> saveMasterKey

// cmdReset: clear cursors, queue, status (preserves keys unless --keys flag)
```

**`gc-sync status` output format:**

```
[gc-sync] Sync Status: synced
[gc-sync]
[gc-sync]   Last push: 2 minutes ago (5 events)
[gc-sync]   Last pull: 3 minutes ago (12 events)
[gc-sync]   Queue:     0 pending, 0 failed
[gc-sync]
[gc-sync]   Machines:
[gc-sync]     macbook-pro-f3a2b1  synced   1,250 events  (last seen: 2 min ago)
[gc-sync]     linux-vm-d4e5f6     synced   3,421 events  (last seen: 75 min ago)
```

**Exit codes:**

| Command | Exit 0 | Exit 1 |
|---------|--------|--------|
| `setup` | Setup completed | Failed (already exists w/o --force, permission error) |
| `recover` | Key recovered | Wrong passphrase, missing blob |
| `push` | Push completed (or empty queue) | Network error, auth error |
| `pull` | Pull completed (or no events) | Network error |
| `status` | Status displayed | - |
| `project *` | Config updated | Invalid args |
| `export-key` | Key printed | No key exists |
| `import-key` | Key imported | Invalid base64 |
| `reset` | Reset completed | - |

**Acceptance Criteria**

- [ ] `gc-sync setup` generates a master key on first run
- [ ] `gc-sync setup` is idempotent (second run does not overwrite key)
- [ ] `gc-sync setup --with-passphrase` creates recovery.enc
- [ ] `gc-sync recover` recovers key with correct passphrase
- [ ] `gc-sync recover` fails with clear error on wrong passphrase
- [ ] `gc-sync recover` refuses to overwrite existing master key
- [ ] `gc-sync push` manually triggers a push cycle
- [ ] `gc-sync pull` manually triggers a pull cycle
- [ ] `gc-sync status` displays human-readable sync status with all 6 states
- [ ] `gc-sync project list` shows all projects with sync status
- [ ] `gc-sync project enable/disable <id>` modifies config.json
- [ ] `gc-sync project mode <mode>` changes the selective sync mode
- [ ] `gc-sync export-key` prints base64 master key to stdout
- [ ] `gc-sync import-key <base64>` imports and saves the key
- [ ] `gc-sync reset` clears cursors, queue, and status without deleting keys
- [ ] Status file is updated atomically (write to temp, rename)
- [ ] All commands exit with appropriate codes

**Edge Cases**

- `gc-sync setup` when `sync/` directory does not exist: creates it with mode 0700.
- `gc-sync recover` when master key already exists: refuses with clear error and `--keys` reset instruction.
- `gc-sync push` when no token configured: prints "Not authenticated. Run gc-sync setup first."
- `gc-sync status` when sync is disabled: shows "disabled" state.
- Wrong passphrase during recovery (5 attempts): exits with cooldown message.

**Estimated Effort**: L (Large) -- 6-8 hours

---

### Task 12: Integration with Existing Scripts

**Description**

Modify existing GlobalContext scripts to integrate the sync system. This includes extending `capture-event` to append to the push queue, updating `gc-install` to deploy sync modules, and updating `gc-doctor` to check sync health.

**Prerequisites/Inputs**

- Task 6 complete (capture-event modification for queue append).
- Task 11 complete (gc-sync CLI).
- Existing scripts from Stories 00-05.

**Implementation Details**

Files to modify:

| File | Modification |
|------|-------------|
| `src/capture-event` | Add push queue append block after event write |
| `src/bin/gc-install` | Deploy `sync/` modules and `gc-sync` binary |
| `src/bin/gc-doctor` | Add sync health checks |
| `src/lib/deploy.sh` | Include sync module files in deployment list |
| `config.json` schema | Add `sync` configuration block |

**`capture-event` modification** (append after event file write):

```bash
# --- Sync Queue Append (Story 07) ---
# Only runs if sync is enabled in config.json
# Does NOT block event capture (flock with 2s timeout, exit 0 on failure)
_GC_SYNC_ENABLED=$(jq -r '.sync.enabled // false' "$BASE_DIR/config.json" 2>/dev/null)
if [ "$_GC_SYNC_ENABLED" = "true" ]; then
  _GC_QUEUE_FILE="$BASE_DIR/sync/queue/pending.jsonl"
  if [ -d "$(dirname "$_GC_QUEUE_FILE")" ]; then
    _GC_EVENT_REL_PATH="events/$project_id/$safe_session_id/${padded}.json"
    _GC_EVENT_SIZE=$(stat -c%s "$EVENT_FILE" 2>/dev/null || stat -f%z "$EVENT_FILE" 2>/dev/null || echo 0)
    if [ "$_GC_EVENT_SIZE" -le 10485760 ]; then
      (
        flock -w 2 201 || exit 0
        printf '{"path":"%s","added_at":"%s","retries":0}\n' \
          "$_GC_EVENT_REL_PATH" "$timestamp" >> "$_GC_QUEUE_FILE"
      ) 201>"$_GC_QUEUE_FILE.lock"
    else
      echo "[gc-sync] WARN: Event ${padded}.json exceeds 10MB sync limit. Skipping." >&2
    fi
  fi
fi
```

**`gc-doctor` sync checks** (added to existing health checks):

```bash
# Sync Health Checks (optional -- only if sync is configured)
if [ -f "$GC_BASE/sync/master.key" ]; then
  check_sync_dir_permissions()   # sync/ is 0700
  check_master_key_permissions() # master.key is 0600
  check_sync_config_valid()      # sync.json parses as JSON
  check_queue_health()           # pending.jsonl is valid JSONL
fi
```

**`config.json` sync block** (added when sync is enabled):

```json
{
  "version": "1.0.0",
  "sync": {
    "enabled": false,
    "server_url": "https://sync.agentcontext.dev",
    "selective": {
      "mode": "all",
      "projects": {},
      "default_sync": true
    }
  }
}
```

**`gc-install` deployment additions**:

```bash
# Deploy sync modules
if [ -d "$SRC_DIR/sync" ]; then
  mkdir -p "$TARGET_DIR/sync"
  cp "$SRC_DIR/sync/"*.mjs "$TARGET_DIR/sync/"
  chmod 644 "$TARGET_DIR/sync/"*.mjs
fi

# Deploy gc-sync CLI
if [ -f "$SRC_DIR/bin/gc-sync" ]; then
  cp "$SRC_DIR/bin/gc-sync" "$TARGET_DIR/bin/gc-sync"
  chmod 755 "$TARGET_DIR/bin/gc-sync"
fi

# Deploy vendored libsodium
if [ -d "$SRC_DIR/lib/vendor" ]; then
  mkdir -p "$TARGET_DIR/lib/vendor"
  cp "$SRC_DIR/lib/vendor/"* "$TARGET_DIR/lib/vendor/"
  chmod 644 "$TARGET_DIR/lib/vendor/"*
fi
```

**Acceptance Criteria**

- [ ] `capture-event` appends to push queue when `sync.enabled` is true in config.json
- [ ] `capture-event` does NOT block if sync queue is unavailable (flock timeout, exit 0)
- [ ] Events exceeding 10MB are not queued (warning logged)
- [ ] `gc-install` deploys sync modules, gc-sync binary, and vendored libsodium
- [ ] `gc-doctor` reports sync health when sync is configured
- [ ] `config.json` includes the sync block with sensible defaults (enabled: false)
- [ ] Queue append adds less than 1ms to capture-event latency
- [ ] Sync modules are deployed with correct permissions (644 for .mjs, 755 for gc-sync)

**Edge Cases**

- `config.json` has no `sync` section: capture-event treats sync as disabled (no queue append).
- `sync/queue/` directory does not exist: capture-event skips queue append silently.
- `flock` not available: capture-event falls back to direct append (risk of concurrent corruption is minimal at single-user scale).
- `stat` command differs between Linux and macOS: use platform-specific syntax with fallback.

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 13: Test Suite

**Description**

Create a comprehensive test suite covering all sync modules: encryption round-trips, key generation, key derivation, metadata separation, push/pull with mock server, selective sync, offline behavior, and security properties.

**Prerequisites/Inputs**

- All tasks (1-12) complete.
- Node.js 18+ with built-in `fetch` and test runner.

**Implementation Details**

Files to create:

| File | Purpose | Tests |
|------|---------|-------|
| `tests/sync/test-crypto.mjs` | Encryption unit tests | T-1 through T-6 |
| `tests/sync/test-keys.mjs` | Key generation unit tests | T-7, T-8 |
| `tests/sync/test-recovery.mjs` | Key derivation and recovery tests | T-9 through T-12 |
| `tests/sync/test-metadata.mjs` | Metadata separation tests | T-13 through T-17 |
| `tests/sync/test-selective.mjs` | Selective sync tests | T-18 through T-20 |
| `tests/sync/test-retry.mjs` | Retry backoff tests | T-21 through T-23 |
| `tests/sync/test-ordering.mjs` | Lamport clock and merge tests | T-24 through T-26 |
| `tests/sync/test-integration.mjs` | Full round-trip integration tests | T-27 through T-45 |
| `tests/sync/test-security.mjs` | Security property tests | T-46 through T-52 |
| `tests/sync/test-performance.mjs` | Performance benchmarks | T-53 through T-59 |
| `tests/sync/run-all.sh` | Runner script for all sync tests |

Test framework: Node.js built-in `node:test` module (no npm dependencies).

**Sample test structure (`tests/sync/test-crypto.mjs`):**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initSodium, encrypt, decrypt, encryptToBase64, decryptFromBase64 } from '../../src/sync/crypto.mjs';

describe('Crypto Module', async () => {
  // Initialize sodium once for all tests
  await initSodium();

  const sodium = (await import('../../src/sync/crypto.mjs')).getSodium();
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();

  it('T-1: encrypt/decrypt round-trip recovers plaintext', () => {
    const plaintext = 'Hello, GlobalContext!';
    const { ciphertext, nonce } = encrypt(plaintext, key);
    const recovered = decrypt(ciphertext, nonce, key);
    assert.equal(sodium.to_string(recovered), plaintext);
  });

  it('T-2: encrypt produces different ciphertext each time (random nonce)', () => {
    const plaintext = 'same message';
    const r1 = encrypt(plaintext, key);
    const r2 = encrypt(plaintext, key);
    assert.notDeepEqual(r1.nonce, r2.nonce);
    assert.notDeepEqual(r1.ciphertext, r2.ciphertext);
  });

  it('T-3: decrypt with wrong key throws', () => {
    const plaintext = 'secret data';
    const { ciphertext, nonce } = encrypt(plaintext, key);
    const wrongKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    assert.throws(() => decrypt(ciphertext, nonce, wrongKey));
  });

  it('T-4: decrypt with tampered ciphertext throws', () => {
    const { ciphertext, nonce } = encrypt('data', key);
    ciphertext[0] ^= 0xff; // Flip a bit
    assert.throws(() => decrypt(ciphertext, nonce, key));
  });

  it('T-5: decrypt with wrong nonce throws', () => {
    const { ciphertext } = encrypt('data', key);
    const wrongNonce = sodium.randombytes_buf(24);
    assert.throws(() => decrypt(ciphertext, wrongNonce, key));
  });

  it('T-6: associated data mismatch causes decryption failure', () => {
    const { ciphertext, nonce } = encrypt('data', key, 'metadata-v1');
    assert.throws(() => decrypt(ciphertext, nonce, key, 'metadata-v2'));
  });
});
```

**Test count summary by category:**

| Category | Tests | File |
|----------|-------|------|
| Encryption (T-1 to T-6) | 6 | test-crypto.mjs |
| Key Generation (T-7 to T-8) | 2 | test-keys.mjs |
| Key Derivation (T-9 to T-12) | 4 | test-recovery.mjs |
| Metadata (T-13 to T-17) | 5 | test-metadata.mjs |
| Selective Sync (T-18 to T-20) | 3 | test-selective.mjs |
| Retry (T-21 to T-23) | 3 | test-retry.mjs |
| Ordering (T-24 to T-26) | 3 | test-ordering.mjs |
| Integration (T-27 to T-45) | 19 | test-integration.mjs |
| Security (T-46 to T-52) | 7 | test-security.mjs |
| Performance (T-53 to T-59) | 7 | test-performance.mjs |
| **Total** | **59** | |

**Acceptance Criteria**

- [ ] All 59 test cases from the story's testing plan pass
- [ ] Tests run without npm install (use node:test built-in runner)
- [ ] Integration tests use mock HTTP server (no real network calls)
- [ ] Integration tests use isolated temp directories (no real `~/.claude-context/` access)
- [ ] Security tests verify file permissions, no plaintext leaks, nonce uniqueness
- [ ] Performance tests verify encryption/decryption latency targets
- [ ] `tests/sync/run-all.sh` exits 0 when all tests pass, 1 on any failure

**Edge Cases**

- Tests must handle WASM initialization (async `sodium.ready`).
- Performance tests may vary on CI vs local hardware -- use generous thresholds.
- Mock server must handle all API endpoints (push, pull, health).

**Estimated Effort**: XL (Extra Large) -- 8-12 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|------|--------|---------|
| `scripts/vendor-libsodium.sh` | Create | 1 |
| `src/lib/vendor/libsodium-wrappers-sumo.js` | Create (vendored) | 1 |
| `src/lib/vendor/README.md` | Create | 1 |
| `src/sync/crypto.mjs` | Create | 2 |
| `src/sync/keys.mjs` | Create | 3 |
| `src/sync/config.mjs` | Create | 3 |
| `src/sync/recovery.mjs` | Create | 4 |
| `src/sync/metadata.mjs` | Create | 5 |
| `src/sync/push.mjs` | Create | 6 |
| `src/sync/queue.mjs` | Create | 6 |
| `src/sync/retry.mjs` | Create | 6 |
| `src/sync/pull.mjs` | Create | 7 |
| `src/sync/loop.mjs` | Create | 8 |
| `src/sync/ordering.mjs` | Create | 9 |
| `src/sync/selective.mjs` | Create | 10 |
| `src/sync/cli.mjs` | Create | 11 |
| `src/sync/status.mjs` | Create | 11 |
| `src/bin/gc-sync` | Create | 11 |
| `src/capture-event` | Modify | 12 |
| `src/bin/gc-install` | Modify | 12 |
| `src/bin/gc-doctor` | Modify | 12 |
| `src/lib/deploy.sh` | Modify | 12 |
| `tests/sync/test-crypto.mjs` | Create | 13 |
| `tests/sync/test-keys.mjs` | Create | 13 |
| `tests/sync/test-recovery.mjs` | Create | 13 |
| `tests/sync/test-metadata.mjs` | Create | 13 |
| `tests/sync/test-selective.mjs` | Create | 13 |
| `tests/sync/test-retry.mjs` | Create | 13 |
| `tests/sync/test-ordering.mjs` | Create | 13 |
| `tests/sync/test-integration.mjs` | Create | 13 |
| `tests/sync/test-security.mjs` | Create | 13 |
| `tests/sync/test-performance.mjs` | Create | 13 |
| `tests/sync/run-all.sh` | Create | 13 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Crypto Foundation** | Task 1 (Vendor libsodium), Task 2 (Crypto Module) | Can encrypt/decrypt data |
| **Phase 2: Key Management** | Task 3 (Key Generation), Task 4 (Key Derivation) | Can generate, store, and recover keys |
| **Phase 3: Event Processing** | Task 5 (Metadata Separation), Task 9 (Ordering) | Can split events and order across machines |
| **Phase 4: Sync Transport** | Task 6 (Push), Task 7 (Pull) | Can push/pull encrypted events |
| **Phase 5: Resilience** | Task 8 (Offline/Loop), Task 10 (Selective Sync) | Handles offline, selective projects |
| **Phase 6: User Interface** | Task 11 (CLI), Task 12 (Integration) | User can interact via gc-sync CLI |
| **Phase 7: Validation** | Task 13 (Test Suite) | All 59 test cases pass |

Tasks within each phase can be partially parallelized:
- Phase 1: Task 1 must complete before Task 2.
- Phase 2: Tasks 3 and 4 are sequential (4 depends on 3).
- Phase 3: Tasks 5 and 9 can be developed in parallel.
- Phase 4: Tasks 6 and 7 can be developed in parallel after Phase 3.
- Phase 5: Tasks 8 and 10 can be developed in parallel after Phase 4.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| libsodium WASM fails to load on some Node.js versions | Low | High (encryption broken) | Pin to known-good Node.js 18+ and libsodium version. Test on CI with multiple Node versions. |
| Vendored libsodium size is too large (>1MB) | Low | Low (distribution size) | The sumo WASM is ~400KB. Acceptable for a vendored dependency. |
| Queue file corruption during crash | Medium | Medium (events stuck) | Atomic writes (tmp + rename). Queue entries are derivable from local event files (re-queue possible). |
| Memory exhaustion during Argon2id (64MB) | Low | Medium (key derivation fails) | 64MB is the MODERATE preset. On constrained systems, fall back to INTERACTIVE (16MB) with a warning. |
| Sync server unavailable at push time | High | Low (queue accumulates) | Offline-first design. Queue is durable. Catch-up on reconnect. |
| Push queue grows unbounded during long offline | Medium | Medium (disk usage) | Enforced limits: 50MB / 100K entries. Oldest-first eviction with warning. |
| Clock skew causes event ordering issues | Medium | Low (cosmetic) | Lamport timestamps provide logical ordering independent of wall clocks. |
| Master key lost without recovery passphrase | Low | Critical (data loss) | `gc-sync setup` strongly recommends passphrase recovery. First-run output warns about unrecoverability. |
| config.json merge conflicts with other stories | Medium | Low (config overwritten) | Sync config is in its own `sync` block. Other stories use different top-level keys. |
| Node.js `fetch` not available (Node <18) | Low | High (HTTP sync broken) | Prerequisites checker (Story 00) verifies Node 18+. |
| Concurrent push and pull race on status.json | Medium | Low (stale status) | Atomic write (tmp + rename). Status is advisory, not authoritative. |

---

## Notes for Implementation

1. **Zero-knowledge is the guiding principle** -- the sync server is untrusted. If the server is compromised, attackers get timestamps and token counts, never prompts, responses, or file contents.
2. **No npm** -- all dependencies are vendored. The `libsodium-wrappers-sumo` WASM is the only external dependency and is bundled in `lib/vendor/`.
3. **ESM modules (.mjs)** -- all sync code uses ES modules for consistency with the projection engine (Story 04). The bash wrapper `gc-sync` calls `node --experimental-modules` to ensure compatibility.
4. **Atomic writes everywhere** -- queue files, cursor files, status files, and key files all use the write-temp-then-rename pattern to prevent corruption on crash.
5. **flock for queue** -- the push queue is the shared mutation point between `capture-event` (bash) and `gc-sync push` (Node.js). Both use flock-based locking.
6. **Encryption happens at push time, not capture time** -- events are stored locally in cleartext. Encryption only happens when the push processor reads the event from the queue. This means key rotation does not require re-encrypting queued events.
7. **Pull events are stored separately** -- `synced/` is distinct from `events/` to maintain a clean separation between local and remote data. Projections and queries may be extended later to include synced events.
8. **Platform evaluation says skip R2** -- the client API targets `POST /api/sync/push` and `GET /api/sync/pull`. The server stores events in DO SQLite (not R2) per the platform evaluation recommendation.
9. **The recovery blob is the only piece of key material that can safely leave the machine** -- it is encrypted with the passphrase-derived key and is useless without the passphrase.
10. **Selective sync is a privacy control, not a performance optimization** -- users can choose to keep sensitive projects local-only, even with sync enabled.

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|------------|----------|
| Task 1: Vendor libsodium WASM | S | 1-2 hours |
| Task 2: Crypto Module | M | 3-4 hours |
| Task 3: Key Generation & Storage | M | 3-4 hours |
| Task 4: Key Derivation & Recovery | M | 3-4 hours |
| Task 5: Metadata Separation | S | 2-3 hours |
| Task 6: Push Sync | L | 6-8 hours |
| Task 7: Pull Sync | L | 5-6 hours |
| Task 8: Offline Queue & Sync Loop | M | 4-5 hours |
| Task 9: Conflict Resolution & Ordering | M | 3-4 hours |
| Task 10: Selective Sync | S | 2-3 hours |
| Task 11: gc-sync CLI & Status | L | 6-8 hours |
| Task 12: Integration with Existing Scripts | M | 3-4 hours |
| Task 13: Test Suite | XL | 8-12 hours |
| **Total** | | **~49-67 hours (~12-16 working days)** |
