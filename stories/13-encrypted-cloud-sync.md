# Story 13: Encrypted Cloud Sync

## Overview

Encrypted Cloud Sync is the bridge between GlobalContext's local-only event store and a multi-device, cross-machine experience. It implements zero-knowledge encrypted sync to Cloudflare edge infrastructure, ensuring that sensitive session data (prompts, responses, file paths, tool inputs/outputs) never leaves the user's machine in cleartext. The sync server stores only opaque encrypted blobs and cleartext metadata (timestamps, token counts, event types).

This story covers the full client-side sync pipeline: encryption with XChaCha20-Poly1305 via libsodium, key generation and derivation, metadata separation, push/pull sync protocols, conflict resolution, selective sync, offline-first queue management, and sync status tracking. The server-side Cloudflare Worker implementation is out of scope -- this story specifies the client contract and API surface.

**Guiding principle**: Encryption happens before any data leaves the machine. The sync server is untrusted. If the server is compromised, attackers get timestamps and token counts -- never prompts, responses, or file contents. The user's master key never leaves their device.

**Operational modes**: GlobalContext operates in two modes. In local-only mode (no account), sync is entirely disabled and all features work without network. In synced mode (free or paid account), the client encrypts and pushes events to Cloudflare, and pulls/decrypts events from other machines. This story implements the synced mode client.

---

## Scope

### In Scope

- Client-side encryption module (XChaCha20-Poly1305 via libsodium)
- Master key generation and secure storage
- Key derivation from passphrase (Argon2id) for cross-device recovery
- Metadata/payload separation (cleartext vs encrypted fields)
- Push sync daemon (encrypt and upload events after capture)
- Pull sync client (download and decrypt events from other machines)
- Conflict resolution strategy (append-only, last-writer-wins for metadata)
- Selective sync configuration (per-project enable/disable)
- Sync status tracking and indicator states
- Offline-first queue management
- Sync configuration in `config.json`
- `gc-sync` CLI commands (setup, push, pull, status)

### Out of Scope (Non-Goals)

- Cloudflare Worker implementation (server-side)
- Durable Object storage logic
- R2 bucket management
- JWT authentication implementation (server-side token issuance)
- Account creation / signup flow
- Billing / tier enforcement (server-side)
- Mobile app or desktop app sync UI
- WebSocket real-time notification relay
- Key escrow or organizational key management
- Hardware security module (HSM) integration
- Post-quantum cryptography upgrade path

---

## Requirements

### 1. Client-Side Encryption (F5.1)

All sensitive data is encrypted on the client before transmission. The encryption algorithm is XChaCha20-Poly1305, an authenticated encryption with associated data (AEAD) cipher provided by libsodium.

#### Why XChaCha20-Poly1305

- **Extended nonce (24 bytes)**: Safe to use random nonces without collision risk, even at high event volumes. Birthday bound for 24-byte nonces is 2^96 -- effectively infinite.
- **Authenticated**: Poly1305 MAC prevents tampering. Any modification to the ciphertext is detected on decryption.
- **Fast**: XChaCha20 is a stream cipher, well-suited for variable-length event payloads.
- **libsodium standard**: `crypto_aead_xchacha20poly1305_ietf_encrypt` is the recommended AEAD in libsodium.

#### Library Choice

Use `libsodium-wrappers-sumo` (the "sumo" variant includes Argon2id, which the slim variant omits). This is a WASM build of libsodium for Node.js -- no native compilation required.

```javascript
// No npm -- vendor the library or use a CDN-fetched copy
// For GlobalContext's no-npm philosophy, the libsodium WASM is bundled
// in lib/vendor/libsodium-wrappers-sumo.js

const _sodium = require('../lib/vendor/libsodium-wrappers-sumo');
```

#### Initialization

libsodium WASM must be initialized before use:

```javascript
let sodium;

async function initSodium() {
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}
```

This initialization is called once at process startup. All encryption/decryption operations require `sodium` to be initialized first.

#### Encryption Function

```javascript
/**
 * Encrypt a plaintext payload using XChaCha20-Poly1305.
 *
 * @param {Uint8Array|string} plaintext - The data to encrypt
 * @param {Uint8Array} key - 256-bit (32-byte) master key
 * @param {string|null} associatedData - Optional cleartext metadata bound to ciphertext
 * @returns {{ ciphertext: Uint8Array, nonce: Uint8Array }}
 */
function encrypt(plaintext, key, associatedData = null) {
  // Generate a random 24-byte nonce
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES  // 24
  );

  // Convert string plaintext to Uint8Array if needed
  const plaintextBytes = typeof plaintext === 'string'
    ? sodium.from_string(plaintext)
    : plaintext;

  // Convert associated data if provided
  const ad = associatedData
    ? sodium.from_string(associatedData)
    : null;

  // Encrypt with AEAD
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintextBytes,
    ad,       // additional data (authenticated but not encrypted)
    null,     // nsec (unused, must be null)
    nonce,
    key
  );

  return { ciphertext, nonce };
}
```

#### Decryption Function

```javascript
/**
 * Decrypt a ciphertext payload using XChaCha20-Poly1305.
 *
 * @param {Uint8Array} ciphertext - The encrypted data (includes Poly1305 tag)
 * @param {Uint8Array} nonce - The 24-byte nonce used during encryption
 * @param {Uint8Array} key - 256-bit (32-byte) master key
 * @param {string|null} associatedData - Must match what was used during encryption
 * @returns {Uint8Array} The decrypted plaintext
 * @throws {Error} If authentication fails (tampered ciphertext or wrong key)
 */
function decrypt(ciphertext, nonce, key, associatedData = null) {
  const ad = associatedData
    ? sodium.from_string(associatedData)
    : null;

  // Throws if authentication fails
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,     // nsec (unused, must be null)
    ciphertext,
    ad,
    nonce,
    key
  );

  return plaintext;
}
```

#### Nonce Generation

Nonces are 24 bytes (192 bits), generated using `sodium.randombytes_buf()`. Each encryption operation generates a fresh random nonce. The nonce is stored alongside the ciphertext and is not secret -- it is transmitted in cleartext as part of the sync payload.

**Nonce reuse is catastrophic**: Using the same nonce with the same key for two different plaintexts breaks the security of the cipher entirely. Random 24-byte nonces make this effectively impossible (probability of collision after 2^48 events is negligible).

#### Ciphertext Overhead

XChaCha20-Poly1305 adds exactly 16 bytes of overhead (the Poly1305 authentication tag). A 1KB plaintext produces a 1040-byte ciphertext.

```
ciphertext_length = plaintext_length + crypto_aead_xchacha20poly1305_ietf_ABYTES  // +16
```

#### Acceptance Criteria

- [ ] All sensitive fields are encrypted using XChaCha20-Poly1305 before leaving the machine
- [ ] `libsodium-wrappers-sumo` WASM is bundled in `lib/vendor/` (no npm install required)
- [ ] `sodium.ready` is awaited before any crypto operations
- [ ] `encrypt()` generates a fresh random 24-byte nonce per call
- [ ] `decrypt()` correctly recovers plaintext given valid ciphertext, nonce, and key
- [ ] `decrypt()` throws on tampered ciphertext (authentication failure)
- [ ] `decrypt()` throws on wrong key
- [ ] Associated data, when provided, is bound to the ciphertext (changing AD causes decryption failure)
- [ ] String inputs are correctly converted to `Uint8Array` before encryption
- [ ] Encryption and decryption are inverses: `decrypt(encrypt(m, k).ciphertext, encrypt(m, k).nonce, k) === m`

---

### 2. Key Generation (F5.2)

Each user generates a 256-bit master key locally on first sync setup. This key encrypts all event payloads. It never leaves the user's machine in cleartext.

#### First-Time Setup Flow

```
gc-sync setup
  1. Check if master key already exists → if yes, skip key generation
  2. Generate 256-bit random key via libsodium
  3. Store key at ~/.claude-context/sync/master.key (mode 0600)
  4. Derive key_id from key (first 8 bytes of SHA-256 hash, hex-encoded)
  5. Optionally prompt for passphrase to derive recovery key (see F5.3)
  6. Print key_id and instructions for cross-device recovery
```

#### Key Generation

```javascript
/**
 * Generate a new 256-bit master encryption key.
 *
 * @returns {{ key: Uint8Array, keyId: string }}
 */
function generateMasterKey() {
  // 32 bytes = 256 bits of cryptographic randomness
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();

  // key_id: first 8 bytes of SHA-256 hash of the key, hex-encoded
  // Used for key identification without exposing the key itself
  const hash = sodium.crypto_generichash(32, key);  // BLAKE2b-256
  const keyId = sodium.to_hex(hash.slice(0, 8));     // 16 hex chars

  return { key, keyId };
}
```

#### Key Storage

The master key is stored in a dedicated sync configuration directory:

```
~/.claude-context/
  sync/
    master.key        # Raw 32-byte key, base64-encoded, mode 0600
    key.json          # Key metadata (key_id, created_at, algorithm)
    sync.json         # Sync configuration (server URL, machine ID, etc.)
    queue/            # Pending push queue
    cursors/          # Per-machine pull cursors
```

##### master.key Format

The file contains the base64-encoded 32-byte key and nothing else:

```
Rk9PQkFSQkFaLi4uLi4uLi4uLi4uLi4uLi4uLi4uLg==
```

File permissions: `0600` (owner read/write only). The parent directory `sync/` has permissions `0700`.

##### key.json Format

```json
{
  "key_id": "a1b2c3d4e5f6a7b8",
  "algorithm": "xchacha20-poly1305",
  "kdf": "none",
  "created_at": "2026-02-21T10:00:00.000Z",
  "machine_id": "macbook-pro-f3a2b1"
}
```

#### Machine ID

Each machine gets a unique identifier, derived similarly to project IDs:

```javascript
const os = require('os');
const hostname = os.hostname();
const hash = sodium.crypto_generichash(32, sodium.from_string(hostname + os.userInfo().username));
const machineId = `${hostname.toLowerCase().replace(/[^a-z0-9-]/g, '')}-${sodium.to_hex(hash.slice(0, 3))}`;
// e.g., "macbook-pro-f3a2b1"
```

#### Key Rotation

Key rotation is supported but not required for v1. When a key is rotated:

1. A new key is generated with a new `key_id`.
2. The old key is preserved in `sync/old-keys/` for decrypting historical events.
3. New events are encrypted with the new key.
4. The `key_id` field in sync payloads identifies which key was used.

#### Acceptance Criteria

- [ ] `gc-sync setup` generates a 256-bit master key on first run
- [ ] The key is stored at `~/.claude-context/sync/master.key` with permissions `0600`
- [ ] The `sync/` directory is created with permissions `0700`
- [ ] `key.json` contains the key_id, algorithm, creation timestamp, and machine_id
- [ ] `key_id` is derived from the key using BLAKE2b and is 16 hex characters
- [ ] Running `gc-sync setup` a second time does not overwrite an existing key
- [ ] The master key is generated using `crypto_aead_xchacha20poly1305_ietf_keygen()` (not a weaker RNG)
- [ ] Machine ID is deterministic for the same hostname+username combination

---

### 3. Key Derivation (F5.3)

For cross-device recovery, the user can derive the master key from a passphrase using Argon2id. This allows transferring the encryption capability to a new machine without physically copying the key file.

#### Argon2id Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `opslimit` | 3 (`crypto_pwhash_OPSLIMIT_MODERATE`) | Moderate iteration count -- balances security and UX |
| `memlimit` | 67108864 (64 MB) (`crypto_pwhash_MEMLIMIT_MODERATE`) | Requires 64MB RAM per derivation -- resists GPU attacks |
| `algorithm` | `crypto_pwhash_ALG_ARGON2ID13` | Argon2id v1.3 -- recommended by OWASP and libsodium |
| `keyLength` | 32 bytes (256 bits) | Matches XChaCha20-Poly1305 key size |

These parameters are chosen per OWASP's 2024 password hashing recommendations. The `MODERATE` preset balances security (resistant to GPU/ASIC cracking) with usability (derivation completes in ~1-3 seconds on modern hardware).

#### Salt Generation and Storage

A 16-byte random salt is generated during first-time passphrase setup and stored alongside the key metadata. The salt is not secret -- it can be synced to the server in cleartext.

```javascript
const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);  // 16 bytes
```

The salt is stored in `key.json`:

```json
{
  "key_id": "a1b2c3d4e5f6a7b8",
  "algorithm": "xchacha20-poly1305",
  "kdf": "argon2id",
  "kdf_salt": "base64-encoded-16-byte-salt",
  "kdf_ops": 3,
  "kdf_mem": 67108864,
  "created_at": "2026-02-21T10:00:00.000Z",
  "machine_id": "macbook-pro-f3a2b1"
}
```

#### Key Derivation Function

```javascript
/**
 * Derive a 256-bit encryption key from a passphrase using Argon2id.
 *
 * @param {string} passphrase - The user's passphrase
 * @param {Uint8Array} salt - 16-byte random salt
 * @returns {Uint8Array} 32-byte derived key
 */
function deriveKeyFromPassphrase(passphrase, salt) {
  const key = sodium.crypto_pwhash(
    32,                                           // key length
    passphrase,                                   // password
    salt,                                         // salt
    3,                                            // opslimit (MODERATE)
    67108864,                                     // memlimit (64MB)
    sodium.crypto_pwhash_ALG_ARGON2ID13           // algorithm
  );

  return key;
}
```

#### Passphrase Setup Flow

```
gc-sync setup --with-passphrase
  1. Generate master key (same as F5.2)
  2. Prompt user for passphrase (read from stdin, no echo)
  3. Prompt for passphrase confirmation
  4. Generate random 16-byte salt
  5. Derive verification key from passphrase + salt
  6. Verify derived key matches master key? No --
     Instead: encrypt the master key WITH the derived passphrase key
  7. Store encrypted master key as recovery blob:
     ~/.claude-context/sync/recovery.enc
  8. Store salt and KDF parameters in key.json
  9. Print recovery instructions
```

#### Recovery Blob

The recovery blob is the master key encrypted with the passphrase-derived key:

```javascript
/**
 * Create a recovery blob: master key encrypted with passphrase-derived key.
 *
 * @param {Uint8Array} masterKey - The master key to protect
 * @param {string} passphrase - The user's passphrase
 * @returns {{ blob: Uint8Array, nonce: Uint8Array, salt: Uint8Array }}
 */
function createRecoveryBlob(masterKey, passphrase) {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const derivedKey = deriveKeyFromPassphrase(passphrase, salt);
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );

  const blob = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    masterKey,
    null,    // no associated data
    null,    // nsec
    nonce,
    derivedKey
  );

  // Zero out the derived key from memory
  sodium.memzero(derivedKey);

  return { blob, nonce, salt };
}
```

##### recovery.enc Format

```json
{
  "version": 1,
  "kdf": "argon2id",
  "kdf_ops": 3,
  "kdf_mem": 67108864,
  "salt": "base64-encoded-16-byte-salt",
  "nonce": "base64-encoded-24-byte-nonce",
  "encrypted_key": "base64-encoded-encrypted-master-key"
}
```

This file can be stored on the sync server (it is useless without the passphrase). This enables cross-device recovery: a new device downloads the recovery blob from the server, the user enters their passphrase, and the master key is recovered.

#### Cross-Device Recovery Flow

```
gc-sync recover
  1. Download recovery.enc from sync server (or read from file)
  2. Prompt user for passphrase
  3. Read salt and KDF parameters from recovery blob
  4. Derive key from passphrase + salt
  5. Decrypt the recovery blob to recover master key
  6. Verify key_id matches expected key_id from server
  7. Store recovered master key at ~/.claude-context/sync/master.key
  8. Print success message
```

```javascript
/**
 * Recover master key from recovery blob using passphrase.
 *
 * @param {object} recoveryData - Parsed recovery.enc contents
 * @param {string} passphrase - The user's passphrase
 * @returns {Uint8Array} The recovered master key
 * @throws {Error} If passphrase is wrong (decryption fails)
 */
function recoverMasterKey(recoveryData, passphrase) {
  const salt = sodium.from_base64(recoveryData.salt);
  const nonce = sodium.from_base64(recoveryData.nonce);
  const encryptedKey = sodium.from_base64(recoveryData.encrypted_key);

  const derivedKey = deriveKeyFromPassphrase(passphrase, salt);

  // Throws if passphrase is wrong
  const masterKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,          // nsec
    encryptedKey,
    null,          // no associated data
    nonce,
    derivedKey
  );

  sodium.memzero(derivedKey);

  return masterKey;
}
```

#### Acceptance Criteria

- [ ] Argon2id derivation uses parameters: opslimit=3, memlimit=64MB, ALG_ARGON2ID13
- [ ] A random 16-byte salt is generated per passphrase setup
- [ ] Salt and KDF parameters are stored in `key.json`
- [ ] The recovery blob (`recovery.enc`) contains the master key encrypted with the passphrase-derived key
- [ ] Recovery blob format is self-describing (includes KDF parameters)
- [ ] `gc-sync recover` successfully recovers the master key with the correct passphrase
- [ ] `gc-sync recover` fails with a clear error on wrong passphrase
- [ ] The passphrase-derived key is zeroed from memory after use (`sodium.memzero`)
- [ ] Key derivation completes in under 5 seconds on modern hardware
- [ ] The recovery blob can be safely stored on the sync server (useless without passphrase)

---

### 4. Metadata Separation (F5.4)

Before encryption, each event is split into cleartext metadata (for server-side aggregation, search, and filtering) and sensitive payload (encrypted). The server can perform queries on metadata without ever accessing the sensitive content.

#### Field Classification

| Field | Classification | Rationale |
|-------|---------------|-----------|
| `event_id` | Cleartext | Unique identifier, no sensitive info |
| `event_type` | Cleartext | Needed for server-side filtering and aggregation |
| `project_id` | Cleartext | Needed for per-project sync filtering |
| `session_id` | Cleartext | Needed for session grouping |
| `sequence` | Cleartext | Needed for ordering and cursor-based pagination |
| `timestamp` | Cleartext | Needed for time-range queries and retention enforcement |
| `machine_id` | Cleartext | Needed for multi-machine sync routing |
| `key_id` | Cleartext | Needed to identify which encryption key was used |
| `data.session_id` | Encrypted | Redundant but inside raw payload |
| `data.prompt` | **Encrypted** | User's actual input -- highly sensitive |
| `data.tool_name` | Cleartext | Needed for tool usage analytics |
| `data.tool_input` | **Encrypted** | Contains file paths, commands, code -- sensitive |
| `data.tool_response` | **Encrypted** | Contains file contents, command output -- sensitive |
| `data.tool_use_id` | Cleartext | Correlation ID, not sensitive |
| `data.error` | **Encrypted** | May contain file paths or code snippets |
| `data.source` | Cleartext | Session start reason (startup/resume/compact) |
| `data.model` | Cleartext | Model name, needed for usage analytics |
| `data.stop_hook_active` | Cleartext | Boolean flag, not sensitive |
| `data.trigger` | Cleartext | Compaction trigger type (manual/auto) |
| `data.reason` | Cleartext | Session end reason (user_exit/timeout/error) |
| `data.agent_id` | Cleartext | Agent correlation ID |
| `data.agent_type` | Cleartext | Agent type classification |
| `data.transcript_path` | **Encrypted** | Contains filesystem path -- sensitive |
| `data.is_interrupt` | Cleartext | Boolean flag, not sensitive |

#### Split Function

```javascript
/**
 * Split an event into cleartext metadata and sensitive payload.
 *
 * @param {object} event - A full GlobalContext event envelope
 * @returns {{ metadata: object, sensitive: object }}
 */
function splitEvent(event) {
  const data = event.data || {};

  // Fields that are always cleartext
  const metadata = {
    event_id: event.event_id,
    event_type: event.event_type,
    project_id: event.project_id,
    session_id: event.session_id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    // Cleartext data fields (safe for server-side queries)
    tool_name: data.tool_name || null,
    tool_use_id: data.tool_use_id || null,
    source: data.source || null,
    model: data.model || null,
    stop_hook_active: data.stop_hook_active !== undefined ? data.stop_hook_active : null,
    trigger: data.trigger || null,
    reason: data.reason || null,
    agent_id: data.agent_id || null,
    agent_type: data.agent_type || null,
    is_interrupt: data.is_interrupt !== undefined ? data.is_interrupt : null
  };

  // Fields that must be encrypted
  const sensitive = {
    prompt: data.prompt || null,
    tool_input: data.tool_input || null,
    tool_response: data.tool_response || null,
    error: data.error || null,
    transcript_path: data.transcript_path || null,
    // Include the full raw data for complete reconstruction on decrypt
    _raw_data: data
  };

  // Remove null fields from metadata to reduce payload size
  Object.keys(metadata).forEach(k => {
    if (metadata[k] === null) delete metadata[k];
  });

  return { metadata, sensitive };
}
```

#### Reassembly Function

On the pull side, after decryption, the event is reassembled:

```javascript
/**
 * Reassemble a full event from cleartext metadata and decrypted sensitive payload.
 *
 * @param {object} metadata - Cleartext metadata from server
 * @param {object} sensitive - Decrypted sensitive payload
 * @returns {object} Full event envelope
 */
function reassembleEvent(metadata, sensitive) {
  return {
    event_id: metadata.event_id,
    event_type: metadata.event_type,
    project_id: metadata.project_id,
    session_id: metadata.session_id,
    sequence: metadata.sequence,
    timestamp: metadata.timestamp,
    data: sensitive._raw_data
  };
}
```

#### Acceptance Criteria

- [ ] `splitEvent()` correctly classifies all fields from all 10 event types
- [ ] Prompts, tool inputs, tool responses, errors, and transcript paths are always in the sensitive bucket
- [ ] Event type, project ID, session ID, sequence, timestamp, tool name, and model are always cleartext
- [ ] Null/undefined cleartext fields are omitted from metadata to reduce payload size
- [ ] `sensitive._raw_data` contains the complete original `data` object for full reconstruction
- [ ] `reassembleEvent()` produces an event identical to the original (minus the split)
- [ ] The split is deterministic: same input always produces the same output
- [ ] Unknown fields in `data` are captured in `_raw_data` (forward compatibility)

---

### 5. Push Sync (F5.5)

After events are captured locally, the push sync process encrypts the sensitive payload and uploads it to the sync server. Push operates as a background process, triggered after each event capture or on a periodic schedule.

#### Push Architecture

```
capture-event (Story 01)
  │
  ├─ Write event to local store (as today)
  ├─ Append event path to push queue file
  │
  ▼
gc-sync push (background)
  │
  ├─ Read pending events from queue
  ├─ For each event:
  │   ├─ Read event JSON from local store
  │   ├─ Split into metadata + sensitive (F5.4)
  │   ├─ Encrypt sensitive payload (F5.1)
  │   ├─ POST to sync server
  │   ├─ On success: remove from queue
  │   ├─ On failure: increment retry counter, apply backoff
  │
  ▼
Sync Server (Cloudflare Worker)
```

#### Push Queue

The push queue is a simple append-only file that tracks which events need to be synced:

```
~/.claude-context/sync/queue/pending.jsonl
```

Each line is a JSON object:

```jsonl
{"path":"events/my-project-a3f7b2/abc123/000001.json","added_at":"2026-02-21T10:00:00.000Z","retries":0}
{"path":"events/my-project-a3f7b2/abc123/000002.json","added_at":"2026-02-21T10:00:01.000Z","retries":0}
```

The queue file is managed with `flock` to prevent concurrent corruption (same pattern as event capture).

#### Queue Entry Format

```json
{
  "path": "events/{project-id}/{session-id}/{sequence}.json",
  "added_at": "ISO-8601 timestamp",
  "retries": 0,
  "last_attempt": null,
  "last_error": null
}
```

#### Appending to Queue (from capture-event)

After a successful event write, `capture-event` appends to the push queue if sync is enabled:

```bash
# In capture-event, after writing the event file:
SYNC_ENABLED=$(jq -r '.sync.enabled // false' "$BASE_DIR/config.json" 2>/dev/null)
if [ "$SYNC_ENABLED" = "true" ]; then
  QUEUE_FILE="$BASE_DIR/sync/queue/pending.jsonl"
  EVENT_REL_PATH="events/$project_id/$safe_session_id/${padded}.json"
  (
    flock -w 2 201 || exit 0
    printf '{"path":"%s","added_at":"%s","retries":0}\n' \
      "$EVENT_REL_PATH" "$timestamp" >> "$QUEUE_FILE"
  ) 201>"$QUEUE_FILE.lock"
fi
```

#### Push Batch Processing

Events are pushed in batches to reduce HTTP overhead:

```javascript
const BATCH_SIZE = 50;        // Max events per push request
const MAX_BATCH_BYTES = 5 * 1024 * 1024;  // 5MB max per batch
const PUSH_INTERVAL_MS = 5000;  // Check queue every 5 seconds

/**
 * Process the push queue, sending events in batches.
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 */
async function processPushQueue(config, masterKey) {
  const queuePath = path.join(config.basedir, 'sync/queue/pending.jsonl');

  if (!fs.existsSync(queuePath)) return;

  const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return;

  const entries = lines.map(l => JSON.parse(l));
  const batches = [];
  let currentBatch = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const eventPath = path.join(config.basedir, entry.path);
    if (!fs.existsSync(eventPath)) continue;  // Event file was deleted

    const eventJson = fs.readFileSync(eventPath, 'utf8');
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

  for (const batch of batches) {
    await pushBatch(batch, config, masterKey);
  }
}
```

#### API Endpoint: POST /api/sync/push

##### Request Format

```http
POST /api/sync/push
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "machine_id": "macbook-pro-f3a2b1",
  "key_id": "a1b2c3d4e5f6a7b8",
  "events": [
    {
      "metadata": {
        "event_id": "550e8400-e29b-41d4-a716-446655440000",
        "event_type": "ToolCallCompleted",
        "project_id": "my-project-a3f7b2",
        "session_id": "abc123",
        "sequence": 42,
        "timestamp": "2026-02-21T10:30:00.000Z",
        "tool_name": "Bash",
        "tool_use_id": "tu_12345"
      },
      "encrypted": "base64-encoded-ciphertext",
      "nonce": "base64-encoded-24-byte-nonce"
    }
  ]
}
```

##### Response Format

Success (all events accepted):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "accepted": 50,
  "rejected": 0,
  "cursor": "2026-02-21T10:30:00.000Z:42",
  "errors": []
}
```

Partial success (some events rejected):

```http
HTTP/1.1 207 Multi-Status
Content-Type: application/json

{
  "accepted": 48,
  "rejected": 2,
  "cursor": "2026-02-21T10:30:00.000Z:40",
  "errors": [
    {
      "event_id": "550e8400-e29b-41d4-a716-446655440000",
      "error": "duplicate_event",
      "message": "Event already exists"
    },
    {
      "event_id": "660e9500-f30c-52e5-b827-557766551111",
      "error": "payload_too_large",
      "message": "Encrypted payload exceeds 10MB limit"
    }
  ]
}
```

#### Retry with Exponential Backoff

```javascript
const BASE_DELAY_MS = 1000;    // 1 second
const MAX_DELAY_MS = 300000;   // 5 minutes
const MAX_RETRIES = 10;
const JITTER_FACTOR = 0.5;    // +/- 50% jitter

/**
 * Calculate retry delay with exponential backoff and jitter.
 *
 * @param {number} retryCount - Number of previous retries (0-based)
 * @returns {number} Delay in milliseconds
 */
function calculateRetryDelay(retryCount) {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
  const clampedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);

  // Add jitter: random value between delay * (1 - jitter) and delay * (1 + jitter)
  const jitterMin = clampedDelay * (1 - JITTER_FACTOR);
  const jitterMax = clampedDelay * (1 + JITTER_FACTOR);
  const jitteredDelay = jitterMin + Math.random() * (jitterMax - jitterMin);

  return Math.round(jitteredDelay);
}

// Retry sequence (approximate, before jitter):
// Retry 0: 1s
// Retry 1: 2s
// Retry 2: 4s
// Retry 3: 8s
// Retry 4: 16s
// Retry 5: 32s
// Retry 6: 64s
// Retry 7: 128s
// Retry 8: 256s
// Retry 9: 300s (capped)
```

#### Push Batch Function

```javascript
/**
 * Push a batch of events to the sync server.
 *
 * @param {Array} batch - Array of { entry, eventJson } objects
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 * @returns {boolean} true if all events in batch were accepted
 */
async function pushBatch(batch, config, masterKey) {
  const events = batch.map(({ entry, eventJson }) => {
    const event = JSON.parse(eventJson);
    const { metadata, sensitive } = splitEvent(event);

    const sensitiveStr = JSON.stringify(sensitive);
    const { ciphertext, nonce } = encrypt(sensitiveStr, masterKey);

    return {
      metadata,
      encrypted: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce)
    };
  });

  const body = JSON.stringify({
    machine_id: config.machineId,
    key_id: config.keyId,
    events
  });

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
    // Remove accepted events from queue
    const rejectedIds = new Set(result.errors.map(e => e.event_id));
    await removeFromQueue(config, batch, rejectedIds);
    return result.rejected === 0;
  }

  if (response.status === 429) {
    // Rate limited -- do not retry immediately, wait for Retry-After
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
    await sleep(retryAfter * 1000);
    return false;
  }

  // Server error -- retry later
  return false;
}
```

#### Queue Cleanup

After successful push, events are removed from the queue by rewriting the queue file without the accepted entries:

```javascript
/**
 * Remove accepted events from the push queue.
 *
 * @param {object} config - Sync configuration
 * @param {Array} batch - The batch that was pushed
 * @param {Set<string>} rejectedIds - Event IDs that were rejected
 */
async function removeFromQueue(config, batch, rejectedIds) {
  const queuePath = path.join(config.basedir, 'sync/queue/pending.jsonl');
  const lockPath = queuePath + '.lock';

  // Acquire flock for queue file modification
  const fd = fs.openSync(lockPath, 'w');
  // Use flock via child_process (Node.js has no native flock)
  // Or use a simple rename-based atomic swap

  const acceptedPaths = new Set(
    batch
      .filter(({ entry }) => !rejectedIds.has(JSON.parse(entry.eventJson || '{}').event_id))
      .map(({ entry }) => entry.path)
  );

  const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean);
  const remaining = lines.filter(line => {
    const entry = JSON.parse(line);
    return !acceptedPaths.has(entry.path);
  });

  fs.writeFileSync(queuePath + '.tmp', remaining.join('\n') + (remaining.length ? '\n' : ''));
  fs.renameSync(queuePath + '.tmp', queuePath);
  fs.closeSync(fd);
}
```

#### Acceptance Criteria

- [ ] Events are added to the push queue after capture when sync is enabled
- [ ] Queue file uses JSONL format (one JSON object per line)
- [ ] Queue writes are protected by flock to prevent concurrent corruption
- [ ] Events are pushed in batches (up to 50 events or 5MB per batch)
- [ ] Each pushed event contains cleartext metadata, base64-encoded ciphertext, and base64-encoded nonce
- [ ] Failed pushes are retried with exponential backoff (1s base, 5min cap, 50% jitter)
- [ ] After 10 retries, the event is moved to a dead-letter queue for manual inspection
- [ ] Rate-limited responses (HTTP 429) are handled by waiting for `Retry-After`
- [ ] Duplicate events (server returns `duplicate_event`) are removed from the queue (not retried)
- [ ] Successfully pushed events are atomically removed from the queue
- [ ] The push process does not block event capture (runs asynchronously)

---

### 6. Pull Sync (F5.6)

Clients pull encrypted events from other machines, decrypt them locally, and merge them into the local event store (or a separate synced-events directory).

#### Pull Architecture

```
gc-sync pull
  │
  ├─ Read last pull cursor for each machine
  ├─ GET /api/sync/pull?machine_id=X&after_cursor=Y
  │
  ▼
Sync Server
  │
  ├─ Query events matching cursor
  ├─ Return metadata + encrypted blobs
  │
  ▼
gc-sync pull (continued)
  │
  ├─ For each event:
  │   ├─ Decrypt sensitive payload with master key
  │   ├─ Reassemble full event
  │   ├─ Write to synced events directory
  ├─ Update pull cursor
  │
  ▼
~/.claude-context/synced/
  └── {machine-id}/
      └── {project-id}/
          └── {session-id}/
              └── {sequence}.json
```

#### Synced Events Directory

Pulled events are stored separately from local events to maintain a clean separation:

```
~/.claude-context/
  events/          # Local events (this machine only)
  synced/          # Events from other machines
    macbook-pro-f3a2b1/
      my-project-a3f7b2/
        abc123/
          000001.json
          000002.json
    linux-vm-d4e5f6/
      my-project-a3f7b2/
        abc123/
          000001.json
```

#### Cursor-Based Pagination

Each machine maintains a cursor that tracks the last pulled event from every other machine. Cursors are stored locally:

```
~/.claude-context/sync/cursors/
  macbook-pro-f3a2b1.json    # Cursor for pulling from machine A
  linux-vm-d4e5f6.json       # Cursor for pulling from machine B
```

##### Cursor Format

```json
{
  "machine_id": "macbook-pro-f3a2b1",
  "last_timestamp": "2026-02-21T10:30:00.000Z",
  "last_sequence": 42,
  "last_event_id": "550e8400-e29b-41d4-a716-446655440000",
  "updated_at": "2026-02-21T11:00:00.000Z"
}
```

The cursor is a composite of timestamp + sequence, which provides total ordering even across sessions. The server uses this to return only events newer than the cursor.

#### API Endpoint: GET /api/sync/pull

##### Request Format

```http
GET /api/sync/pull?after=2026-02-21T10:30:00.000Z:42&limit=100&machine_id=macbook-pro-f3a2b1
Authorization: Bearer <jwt-token>
```

Query parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `after` | string | No | Cursor string (`timestamp:sequence`). Omit for first pull. |
| `limit` | integer | No | Max events to return (default 100, max 1000) |
| `machine_id` | string | No | Filter to events from a specific machine. Omit for all machines. |
| `project_id` | string | No | Filter to events from a specific project |

##### Response Format

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "events": [
    {
      "metadata": {
        "event_id": "550e8400-e29b-41d4-a716-446655440000",
        "event_type": "ToolCallCompleted",
        "project_id": "my-project-a3f7b2",
        "session_id": "abc123",
        "sequence": 42,
        "timestamp": "2026-02-21T10:30:00.000Z",
        "machine_id": "macbook-pro-f3a2b1",
        "tool_name": "Bash",
        "tool_use_id": "tu_12345"
      },
      "encrypted": "base64-encoded-ciphertext",
      "nonce": "base64-encoded-24-byte-nonce",
      "key_id": "a1b2c3d4e5f6a7b8"
    }
  ],
  "cursor": "2026-02-21T10:30:00.000Z:42",
  "has_more": true,
  "total_remaining": 350
}
```

#### Pull Processing Function

```javascript
/**
 * Pull and decrypt events from the sync server.
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Decryption key
 * @param {object} options - Pull options (machineId, projectId, limit)
 */
async function pullEvents(config, masterKey, options = {}) {
  const { machineId, projectId, limit = 100 } = options;

  // Load cursor
  const cursor = loadCursor(config, machineId);
  const afterParam = cursor
    ? `after=${encodeURIComponent(cursor.last_timestamp + ':' + cursor.last_sequence)}`
    : '';

  const params = new URLSearchParams();
  if (afterParam) params.set('after', cursor.last_timestamp + ':' + cursor.last_sequence);
  if (machineId) params.set('machine_id', machineId);
  if (projectId) params.set('project_id', projectId);
  params.set('limit', String(limit));

  let hasMore = true;

  while (hasMore) {
    const url = `${config.serverUrl}/api/sync/pull?${params.toString()}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.token}` }
    });

    if (!response.ok) {
      throw new Error(`Pull failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    for (const syncEvent of result.events) {
      // Verify key_id matches our master key
      if (syncEvent.key_id !== config.keyId) {
        console.error(`[gc-sync] WARN: Unknown key_id ${syncEvent.key_id}, skipping event`);
        continue;
      }

      // Decrypt
      const ciphertext = sodium.from_base64(syncEvent.encrypted);
      const nonce = sodium.from_base64(syncEvent.nonce);
      const plaintext = decrypt(ciphertext, nonce, masterKey);
      const sensitive = JSON.parse(sodium.to_string(plaintext));

      // Reassemble full event
      const event = reassembleEvent(syncEvent.metadata, sensitive);

      // Write to synced events directory
      const sourceMachine = syncEvent.metadata.machine_id;
      writeSyncedEvent(config, sourceMachine, event);
    }

    // Update cursor
    if (result.events.length > 0) {
      const lastEvent = result.events[result.events.length - 1];
      saveCursor(config, machineId || 'all', {
        machine_id: machineId || 'all',
        last_timestamp: lastEvent.metadata.timestamp,
        last_sequence: lastEvent.metadata.sequence,
        last_event_id: lastEvent.metadata.event_id,
        updated_at: new Date().toISOString()
      });

      // Update params for next page
      params.set('after', lastEvent.metadata.timestamp + ':' + lastEvent.metadata.sequence);
    }

    hasMore = result.has_more;
  }
}
```

#### Writing Synced Events to Disk

```javascript
/**
 * Write a synced event to the local synced events directory.
 *
 * @param {object} config - Sync configuration
 * @param {string} sourceMachine - Machine ID the event came from
 * @param {object} event - The reassembled event envelope
 */
function writeSyncedEvent(config, sourceMachine, event) {
  const dir = path.join(
    config.basedir,
    'synced',
    sourceMachine,
    event.project_id,
    event.session_id
  );

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filename = String(event.sequence).padStart(6, '0') + '.json';
  const filepath = path.join(dir, filename);

  // Do not overwrite existing events (idempotent pull)
  if (fs.existsSync(filepath)) return;

  fs.writeFileSync(filepath, JSON.stringify(event, null, 2), { mode: 0o600 });
}
```

#### Acceptance Criteria

- [ ] `gc-sync pull` fetches events from the sync server using cursor-based pagination
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

---

### 7. Conflict Resolution (F5.7)

The event-sourced, append-only architecture of GlobalContext means that event data itself has no conflicts. Events are immutable facts that happened at a specific time on a specific machine. However, metadata (session.json, projections) can have conflicts when multiple machines sync.

#### Events: No Conflicts

Events are uniquely identified by `(machine_id, project_id, session_id, sequence)`. This 4-tuple is globally unique because:

- `machine_id` is unique per device
- `sequence` is monotonically increasing per session per machine
- Two machines cannot produce the same sequence for the same session (sessions are local to a machine)

Therefore, event sync is a pure append operation. If the same event arrives twice (duplicate push or pull), it is simply ignored.

#### Metadata: Last-Writer-Wins

For metadata that is mutable (e.g., session.json, sync status), a last-writer-wins (LWW) strategy is used:

```javascript
/**
 * Merge metadata from two sources using last-writer-wins.
 *
 * @param {object} local - Local metadata
 * @param {object} remote - Remote metadata
 * @returns {object} Merged metadata
 */
function mergeMetadata(local, remote) {
  const localTime = new Date(local.updated_at || local.timestamp || 0).getTime();
  const remoteTime = new Date(remote.updated_at || remote.timestamp || 0).getTime();

  return remoteTime > localTime ? { ...local, ...remote } : { ...remote, ...local };
}
```

#### Ordering: Lamport Timestamps

To provide a total ordering of events across machines, each event carries a Lamport timestamp in addition to its wall-clock timestamp:

```javascript
/**
 * Lamport timestamp for cross-machine event ordering.
 *
 * Each machine maintains a local counter. On event capture, the counter
 * increments. On event receipt (pull), the counter is set to
 * max(local, received) + 1.
 */
class LamportClock {
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

  /** Serialize for storage. */
  toJSON() {
    return this.value;
  }
}
```

The Lamport timestamp is stored in the event envelope when sync is enabled:

```json
{
  "event_id": "...",
  "event_type": "...",
  "lamport": 1042,
  "...": "..."
}
```

Events are ordered first by Lamport timestamp, then by wall-clock timestamp as a tiebreaker, then by machine_id for deterministic ordering.

#### Deduplication

Events that arrive via both local capture and remote pull are deduplicated by `event_id`:

```javascript
/**
 * Check if an event already exists locally (either in events/ or synced/).
 *
 * @param {object} config - Sync configuration
 * @param {string} eventId - The event_id to check
 * @returns {boolean} True if event already exists
 */
function eventExists(config, eventId) {
  // Check a local index file for O(1) lookup
  const indexPath = path.join(config.basedir, 'sync', 'event-index.json');
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return index[eventId] === true;
  }
  return false;
}
```

#### Acceptance Criteria

- [ ] Events never conflict: append-only, uniquely identified by (machine_id, project_id, session_id, sequence)
- [ ] Duplicate events are detected and ignored (no duplicate writes)
- [ ] Metadata uses last-writer-wins with wall-clock timestamps
- [ ] Lamport timestamps provide total ordering across machines
- [ ] Lamport clock increments on local event capture
- [ ] Lamport clock updates on remote event receipt: `max(local, remote) + 1`
- [ ] Event ordering: Lamport timestamp > wall-clock timestamp > machine_id (deterministic tiebreak)
- [ ] The conflict resolution strategy requires no user intervention

---

### 8. Selective Sync (F5.8)

Users can choose which projects to sync and which to keep local-only. This provides privacy control for sensitive projects (e.g., work on proprietary code that should not leave the machine, even encrypted).

#### Configuration

Selective sync is configured in `config.json`:

```json
{
  "version": "1.0.0",
  "sync": {
    "enabled": true,
    "server_url": "https://sync.agentcontext.dev",
    "selective": {
      "mode": "allowlist",
      "projects": {
        "my-project-a3f7b2": {
          "sync": true,
          "label": "my-project"
        },
        "secret-work-b4c5d6": {
          "sync": false,
          "label": "secret-work"
        }
      },
      "default_sync": true
    }
  }
}
```

#### Sync Modes

| Mode | Behavior |
|------|----------|
| `all` | Sync all projects (default when selective sync is not configured) |
| `allowlist` | Only sync projects explicitly listed with `"sync": true` |
| `blocklist` | Sync all projects except those listed with `"sync": false` |

The `default_sync` field determines behavior for projects not explicitly listed:
- In `allowlist` mode: `default_sync` should be `false` (unlisted projects are not synced)
- In `blocklist` mode: `default_sync` should be `true` (unlisted projects are synced)

#### CLI Commands

```bash
# Enable sync for a project
gc-sync project enable my-project-a3f7b2

# Disable sync for a project
gc-sync project disable secret-work-b4c5d6

# List project sync status
gc-sync project list

# Set sync mode
gc-sync project mode allowlist
gc-sync project mode blocklist
gc-sync project mode all
```

#### Project Sync Check

The push queue appender checks selective sync before queueing an event:

```javascript
/**
 * Check if a project is configured for sync.
 *
 * @param {object} config - Full config object
 * @param {string} projectId - Project ID to check
 * @returns {boolean} True if the project should be synced
 */
function shouldSyncProject(config, projectId) {
  const syncConfig = config.sync || {};
  const selective = syncConfig.selective || {};

  // If selective sync is not configured, sync everything (if sync is enabled)
  if (!selective.mode || selective.mode === 'all') {
    return syncConfig.enabled === true;
  }

  const projectConfig = (selective.projects || {})[projectId];

  if (projectConfig) {
    return projectConfig.sync === true;
  }

  // Project not in the list -- use default
  return selective.default_sync !== false;
}
```

#### Acceptance Criteria

- [ ] `config.json` supports `sync.selective` configuration block
- [ ] Three sync modes: `all`, `allowlist`, `blocklist`
- [ ] Per-project sync enable/disable in the configuration
- [ ] `gc-sync project enable/disable` modifies config.json
- [ ] `gc-sync project list` displays all projects with their sync status
- [ ] `gc-sync project mode` changes the selective sync mode
- [ ] Events for disabled projects are not added to the push queue
- [ ] Pull sync respects selective sync (events for disabled projects are not written locally)
- [ ] Default behavior (no selective sync configured) is to sync all projects

---

### 9. Sync Status Indicator (F5.9)

The sync system exposes status information that can be consumed by the dashboard (F4) or CLI tools.

#### Sync States

| State | Description | Trigger |
|-------|-------------|---------|
| `synced` | All local events have been pushed; pull is up to date | Push queue empty, pull cursors current |
| `syncing` | Push or pull is currently in progress | During active push/pull operation |
| `pending` | Events are queued for push but not yet sent | Push queue has entries, no active push |
| `error` | Last sync attempt failed | After failed push or pull |
| `offline` | No network connectivity to sync server | Connection check failed |
| `disabled` | Sync is not enabled in configuration | `sync.enabled` is false or not set |

#### Status File

The sync daemon writes its status to a JSON file that can be read by the dashboard or CLI:

```
~/.claude-context/sync/status.json
```

```json
{
  "state": "synced",
  "last_push": {
    "timestamp": "2026-02-21T10:30:00.000Z",
    "events_pushed": 5,
    "duration_ms": 230
  },
  "last_pull": {
    "timestamp": "2026-02-21T10:29:00.000Z",
    "events_pulled": 12,
    "duration_ms": 450
  },
  "queue": {
    "pending": 0,
    "failed": 0,
    "dead_letter": 0
  },
  "machines": {
    "macbook-pro-f3a2b1": {
      "last_seen": "2026-02-21T10:30:00.000Z",
      "cursor": "2026-02-21T10:30:00.000Z:42",
      "events_synced": 1250
    },
    "linux-vm-d4e5f6": {
      "last_seen": "2026-02-21T09:15:00.000Z",
      "cursor": "2026-02-21T09:15:00.000Z:88",
      "events_synced": 3421
    }
  },
  "errors": [],
  "updated_at": "2026-02-21T10:30:01.000Z"
}
```

#### Status Update Function

```javascript
/**
 * Update the sync status file.
 *
 * @param {object} config - Sync configuration
 * @param {object} update - Partial status update to merge
 */
function updateSyncStatus(config, update) {
  const statusPath = path.join(config.basedir, 'sync', 'status.json');

  let status = {};
  if (fs.existsSync(statusPath)) {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  }

  // Merge update into existing status
  const merged = {
    ...status,
    ...update,
    machines: { ...status.machines, ...(update.machines || {}) },
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(statusPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
```

#### CLI Status Command

```bash
gc-sync status
```

Output:

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

#### Acceptance Criteria

- [ ] Sync status is written to `~/.claude-context/sync/status.json`
- [ ] Six states are tracked: synced, syncing, pending, error, offline, disabled
- [ ] Status includes last push/pull timestamps, event counts, and durations
- [ ] Queue depth (pending, failed, dead-letter) is tracked
- [ ] Per-machine sync status is tracked (last seen, cursor position, events synced)
- [ ] `gc-sync status` displays human-readable sync status
- [ ] Status file is updated atomically (write to temp, rename)
- [ ] Errors include timestamps and messages for debugging

---

### 10. Offline-First (F5.10)

GlobalContext operates fully without network connectivity. Sync is an optional enhancement, never a requirement. All local features (event capture, projections, queries, dashboard) work identically whether sync is enabled or not.

#### Offline Behavior

| Component | Online Behavior | Offline Behavior |
|-----------|----------------|-----------------|
| Event capture | Captures locally + queues for push | Captures locally only |
| Push queue | Processes and sends to server | Accumulates entries, no network calls |
| Pull sync | Fetches and decrypts remote events | Skipped entirely |
| Projections | Include local + synced events | Include local events only |
| gc-query | Searches local + synced events | Searches local events only |
| Dashboard | Shows sync status (synced) | Shows sync status (offline) |

#### Online Detection

The sync daemon periodically checks connectivity to the sync server:

```javascript
const CONNECTIVITY_CHECK_INTERVAL_MS = 30000;  // 30 seconds
const CONNECTIVITY_TIMEOUT_MS = 5000;           // 5 second timeout

/**
 * Check if the sync server is reachable.
 *
 * @param {string} serverUrl - The sync server URL
 * @returns {Promise<boolean>} True if server is reachable
 */
async function checkConnectivity(serverUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);

    const response = await fetch(`${serverUrl}/api/health`, {
      method: 'HEAD',
      signal: controller.signal
    });

    clearTimeout(timeout);
    return response.ok;
  } catch (err) {
    return false;
  }
}
```

#### Queue Management During Offline

When offline, the push queue continues to accumulate events. No push attempts are made until connectivity is restored. This prevents wasting CPU on retries that will fail.

```javascript
/**
 * Main sync loop. Runs continuously in the background.
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 */
async function syncLoop(config, masterKey) {
  let isOnline = false;
  let consecutiveFailures = 0;

  while (true) {
    // Check connectivity
    isOnline = await checkConnectivity(config.serverUrl);
    updateSyncStatus(config, {
      state: isOnline ? (getQueueDepth(config) > 0 ? 'pending' : 'synced') : 'offline'
    });

    if (isOnline) {
      consecutiveFailures = 0;

      try {
        // Push pending events
        updateSyncStatus(config, { state: 'syncing' });
        await processPushQueue(config, masterKey);

        // Pull new events from other machines
        await pullEvents(config, masterKey);

        updateSyncStatus(config, {
          state: getQueueDepth(config) > 0 ? 'pending' : 'synced'
        });
      } catch (err) {
        consecutiveFailures += 1;
        updateSyncStatus(config, {
          state: 'error',
          errors: [{ message: err.message, timestamp: new Date().toISOString() }]
        });
      }
    }

    // Adaptive sleep: longer when offline or errors, shorter when active
    const sleepMs = isOnline
      ? (consecutiveFailures > 0 ? calculateRetryDelay(consecutiveFailures) : PUSH_INTERVAL_MS)
      : CONNECTIVITY_CHECK_INTERVAL_MS;

    await sleep(sleepMs);
  }
}
```

#### Catch-Up After Coming Online

When the device transitions from offline to online, the sync loop processes the entire pending queue. Large queues are processed in batches to avoid overwhelming the server:

```javascript
const CATCHUP_BATCH_DELAY_MS = 1000;  // 1 second between catch-up batches

/**
 * Process backlog after coming online.
 *
 * @param {object} config - Sync configuration
 * @param {Uint8Array} masterKey - Encryption key
 */
async function processCatchUp(config, masterKey) {
  const queueDepth = getQueueDepth(config);

  if (queueDepth > BATCH_SIZE) {
    console.error(`[gc-sync] Catching up: ${queueDepth} events pending`);
  }

  while (getQueueDepth(config) > 0) {
    await processPushQueue(config, masterKey);
    if (getQueueDepth(config) > 0) {
      await sleep(CATCHUP_BATCH_DELAY_MS);
    }
  }
}
```

#### Queue Size Limits

To prevent unbounded queue growth during extended offline periods:

| Metric | Limit | Action When Exceeded |
|--------|-------|---------------------|
| Queue file size | 50MB | Oldest entries dropped with warning |
| Queue entry count | 100,000 | Oldest entries dropped with warning |
| Single event size | 10MB | Event not queued, logged as oversized |

```javascript
const MAX_QUEUE_ENTRIES = 100000;
const MAX_QUEUE_FILE_SIZE = 50 * 1024 * 1024;  // 50MB
const MAX_EVENT_SIZE = 10 * 1024 * 1024;         // 10MB

/**
 * Check if queue limits are exceeded and trim if necessary.
 *
 * @param {object} config - Sync configuration
 */
function enforceQueueLimits(config) {
  const queuePath = path.join(config.basedir, 'sync/queue/pending.jsonl');
  if (!fs.existsSync(queuePath)) return;

  const stats = fs.statSync(queuePath);

  if (stats.size > MAX_QUEUE_FILE_SIZE) {
    const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n');
    const trimCount = Math.floor(lines.length * 0.2);  // Drop oldest 20%
    const remaining = lines.slice(trimCount);

    console.error(`[gc-sync] WARN: Queue exceeded ${MAX_QUEUE_FILE_SIZE / 1024 / 1024}MB. ` +
      `Dropped ${trimCount} oldest entries.`);

    fs.writeFileSync(queuePath + '.tmp', remaining.join('\n') + '\n');
    fs.renameSync(queuePath + '.tmp', queuePath);
  }
}
```

#### Acceptance Criteria

- [ ] All local features work identically with sync enabled or disabled
- [ ] Event capture is never blocked by sync (async queue append only)
- [ ] When offline, push queue accumulates without making network calls
- [ ] When offline, pull sync is skipped entirely
- [ ] Online detection uses a health check endpoint with 5-second timeout
- [ ] Connectivity is checked every 30 seconds
- [ ] Coming online triggers catch-up processing of the pending queue
- [ ] Catch-up batches are rate-limited (1 second between batches)
- [ ] Queue has size limits (50MB / 100,000 entries) with oldest-first eviction
- [ ] Single events exceeding 10MB are not queued
- [ ] The sync loop runs with adaptive sleep (shorter when active, longer when offline)
- [ ] Sync state transitions are logged for debugging

---

## Sync Configuration (sync.json)

The sync module's configuration is stored alongside the master key:

```json
{
  "server_url": "https://sync.agentcontext.dev",
  "machine_id": "macbook-pro-f3a2b1",
  "key_id": "a1b2c3d4e5f6a7b8",
  "user_id": "user_abc123",
  "token": null,
  "token_expires_at": null,
  "push_interval_ms": 5000,
  "pull_interval_ms": 30000,
  "batch_size": 50,
  "max_retries": 10,
  "created_at": "2026-02-21T10:00:00.000Z"
}
```

Note: The JWT `token` is obtained through an authentication flow (out of scope for this story). The token is refreshed by the auth module and stored here for the sync client to use.

---

## gc-sync CLI

The `gc-sync` command provides the user-facing interface for sync management:

```
gc-sync <command> [options]

Commands:
  setup                 Initialize sync (generate key, configure server)
  setup --with-passphrase  Initialize sync with passphrase recovery
  recover               Recover master key from passphrase
  push                  Manually trigger a push cycle
  pull                  Manually trigger a pull cycle
  status                Show current sync status
  project list          List projects with sync status
  project enable <id>   Enable sync for a project
  project disable <id>  Disable sync for a project
  project mode <mode>   Set selective sync mode (all|allowlist|blocklist)
  reset                 Reset sync state (cursors, queue) without deleting keys
  export-key            Export master key (base64) for manual transfer
  import-key <base64>   Import master key from another machine
```

---

## Directory Structure (Complete)

```
~/.claude-context/
  events/                          # Local events (unchanged from Story 01)
  synced/                          # Events pulled from other machines
    {machine-id}/
      {project-id}/
        {session-id}/
          000001.json
  sync/
    master.key                     # Base64-encoded 256-bit master key (mode 0600)
    key.json                       # Key metadata (key_id, algorithm, machine_id)
    recovery.enc                   # Encrypted master key for passphrase recovery
    sync.json                      # Sync configuration (server URL, machine ID, token)
    status.json                    # Current sync status (for dashboard/CLI)
    lamport.json                   # Lamport clock state
    event-index.json               # Event ID dedup index (for pulled events)
    queue/
      pending.jsonl                # Events waiting to be pushed
      pending.jsonl.lock           # flock for queue writes
      dead-letter.jsonl            # Events that exceeded max retries
    cursors/
      {machine-id}.json            # Pull cursor per remote machine
    old-keys/                      # Rotated keys (for decrypting historical events)
  projections/                     # Unchanged from Story 04
  bin/                             # Unchanged
  config.json                      # Extended with sync config
```

---

## Edge Cases

### E-1: Master Key Lost Without Recovery Passphrase

**Scenario**: The user's disk fails. They did not set up passphrase recovery (`gc-sync setup` without `--with-passphrase`). The recovery blob does not exist.

**Expected behavior**: All encrypted data on the sync server is permanently inaccessible. This is by design (zero-knowledge). The user must start fresh with a new key. The server-side data is effectively crypto-shredded.

**Mitigation**: `gc-sync setup` strongly recommends (but does not require) setting up passphrase recovery. The first-run output warns about this.

---

### E-2: Wrong Passphrase During Recovery

**Scenario**: The user enters an incorrect passphrase when running `gc-sync recover`.

**Expected behavior**: `crypto_aead_xchacha20poly1305_ietf_decrypt` throws because the authentication tag does not match. The error is caught and the user is prompted to try again. After 5 consecutive failures, the tool exits with a cooldown message (to slow down brute-force attempts on the local machine).

---

### E-3: Network Disconnect Mid-Push

**Scenario**: The network drops while a batch push is in progress. Some events in the batch were received by the server, others were not.

**Expected behavior**: The HTTP request fails (timeout or connection reset). Since the server did not respond with success, the entire batch is retained in the queue for retry. Events that the server already received will be rejected as duplicates on the next push attempt and removed from the queue.

---

### E-4: Push Queue Grows Very Large During Extended Offline

**Scenario**: The user works offline for a week, generating thousands of events. When they come back online, the push queue has 50,000 entries.

**Expected behavior**: The catch-up process sends events in batches of 50 with 1-second delays between batches. Total catch-up time: ~50,000/50 * 1s = ~1,000 seconds (~17 minutes). The sync status shows "syncing" with a progress indicator. Queue limits (100,000 entries, 50MB) are checked and enforced.

---

### E-5: Two Machines Push Same Session ID

**Scenario**: Machine A and Machine B both capture events for the same project with sessions that happen to share the same session ID (extremely unlikely with UUID session IDs, but theoretically possible).

**Expected behavior**: Events are differentiated by `machine_id`. Machine A's events go to `synced/machine-a/{project-id}/{session-id}/` and Machine B's events go to `synced/machine-b/{project-id}/{session-id}/`. No collision occurs.

---

### E-6: Key Rotation While Events Are Queued

**Scenario**: The user rotates their master key while there are events in the push queue that were captured before the rotation.

**Expected behavior**: Queued events have not been encrypted yet (they are stored as paths to local event files). Encryption happens at push time, so all queued events will be encrypted with the new key. The `key_id` in the push payload reflects the new key. No issue.

---

### E-7: Large Tool Response (>10MB)

**Scenario**: A `ToolCallCompleted` event has a `tool_response` containing a 15MB file read. The encrypted payload would exceed the 10MB event limit.

**Expected behavior**: The event is captured locally (local storage has no size limit). When the push queue appender measures the event size and finds it exceeds `MAX_EVENT_SIZE`, the event is not queued. A warning is logged:

```
[gc-sync] WARN: Event 000042.json (15.2MB) exceeds sync limit (10MB). Skipping sync.
```

The event remains in the local store but is not synced.

---

### E-8: Server Returns Unknown Error Codes

**Scenario**: The sync server returns an unexpected HTTP status (e.g., 502 Bad Gateway from Cloudflare, or a 500 Internal Server Error).

**Expected behavior**: Any non-2xx, non-429 response is treated as a transient error. The batch is not removed from the queue. The retry counter increments and exponential backoff applies. After `MAX_RETRIES` (10) consecutive failures for the same batch, events are moved to the dead-letter queue.

---

### E-9: Clock Skew Between Machines

**Scenario**: Machine A's clock is 5 minutes ahead of Machine B. Events from Machine A have timestamps in Machine B's future.

**Expected behavior**: Lamport timestamps provide logical ordering independent of wall clocks. For display purposes, wall-clock timestamps are used but with a note that they are per-machine. The pull cursor uses the server-assigned cursor position (not the client's timestamp), so clock skew does not cause missed events.

---

### E-10: Selective Sync Changed After Events Queued

**Scenario**: The user disables sync for project X, but there are already events for project X in the push queue.

**Expected behavior**: The next push cycle checks `shouldSyncProject()` for each queued event. Events for project X are removed from the queue without pushing. A log message is emitted:

```
[gc-sync] Skipping 15 events for project secret-work-b4c5d6 (sync disabled)
```

---

### E-11: Recovery Blob on Server, Master Key Exists Locally

**Scenario**: The user runs `gc-sync recover` on a machine that already has a master key.

**Expected behavior**: `gc-sync recover` detects the existing key and aborts:

```
[gc-sync] ERROR: Master key already exists at ~/.claude-context/sync/master.key
[gc-sync]   If you want to replace it, first run: gc-sync reset --keys
[gc-sync]   WARNING: This will make locally encrypted data unreadable.
```

---

### E-12: Concurrent Push and Pull

**Scenario**: The push loop and pull loop run simultaneously, both reading/writing sync state files.

**Expected behavior**: Push and pull operate on different data paths (push writes to the server, pull reads from the server). The shared state files (`status.json`, `lamport.json`) use atomic write (write to temp file, rename) to prevent corruption. Queue operations use flock. No race conditions.

---

## Technical Specification Summary

### Constants

```javascript
// Encryption
const NONCE_BYTES = 24;   // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const KEY_BYTES = 32;      // crypto_aead_xchacha20poly1305_ietf_KEYBYTES
const TAG_BYTES = 16;      // crypto_aead_xchacha20poly1305_ietf_ABYTES

// KDF (Argon2id)
const KDF_OPS = 3;         // crypto_pwhash_OPSLIMIT_MODERATE
const KDF_MEM = 67108864;  // crypto_pwhash_MEMLIMIT_MODERATE (64MB)
const SALT_BYTES = 16;     // crypto_pwhash_SALTBYTES

// Sync
const BATCH_SIZE = 50;
const MAX_BATCH_BYTES = 5 * 1024 * 1024;       // 5MB
const MAX_EVENT_SIZE = 10 * 1024 * 1024;         // 10MB
const MAX_QUEUE_ENTRIES = 100000;
const MAX_QUEUE_FILE_SIZE = 50 * 1024 * 1024;   // 50MB
const PUSH_INTERVAL_MS = 5000;                    // 5 seconds
const PULL_INTERVAL_MS = 30000;                   // 30 seconds
const CONNECTIVITY_CHECK_INTERVAL_MS = 30000;    // 30 seconds
const CONNECTIVITY_TIMEOUT_MS = 5000;            // 5 seconds

// Retry
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300000;   // 5 minutes
const MAX_RETRIES = 10;
const JITTER_FACTOR = 0.5;

// Catch-up
const CATCHUP_BATCH_DELAY_MS = 1000;
```

### File Permissions

| Path | Permissions | Notes |
|------|-------------|-------|
| `~/.claude-context/sync/` | 0700 | Sync directory (user-only) |
| `~/.claude-context/sync/master.key` | 0600 | Master encryption key |
| `~/.claude-context/sync/key.json` | 0600 | Key metadata |
| `~/.claude-context/sync/recovery.enc` | 0600 | Recovery blob |
| `~/.claude-context/sync/sync.json` | 0600 | Sync configuration (contains token) |
| `~/.claude-context/sync/status.json` | 0600 | Sync status |
| `~/.claude-context/sync/queue/` | 0700 | Push queue directory |
| `~/.claude-context/sync/queue/pending.jsonl` | 0600 | Pending push queue |
| `~/.claude-context/sync/cursors/` | 0700 | Pull cursors directory |
| `~/.claude-context/synced/` | 0700 | Synced events from other machines |
| `~/.claude-context/synced/**/*.json` | 0600 | Individual synced event files |

### Dependencies

| Dependency | Purpose | Bundled? |
|------------|---------|----------|
| `libsodium-wrappers-sumo` | XChaCha20-Poly1305 encryption, Argon2id KDF, random bytes | Yes (WASM in lib/vendor/) |
| Node.js >= 18 | Fetch API (built-in), crypto operations, filesystem | Required (Story 00) |
| `jq` | Config.json modification from bash scripts | Required (Story 00) |
| `flock` | Queue file locking | Required (Story 00) |

### Exit Codes

| Command | Exit Code | Meaning |
|---------|-----------|---------|
| `gc-sync setup` | 0 | Setup completed successfully |
| `gc-sync setup` | 1 | Setup failed (libsodium not available, permission error) |
| `gc-sync recover` | 0 | Key recovered successfully |
| `gc-sync recover` | 1 | Recovery failed (wrong passphrase, missing blob) |
| `gc-sync push` | 0 | Push completed (or no events to push) |
| `gc-sync push` | 1 | Push failed (network error, auth error) |
| `gc-sync pull` | 0 | Pull completed (or no events to pull) |
| `gc-sync pull` | 1 | Pull failed |
| `gc-sync status` | 0 | Status displayed |
| `gc-sync project *` | 0 | Project config updated |
| `gc-sync project *` | 1 | Project config update failed |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `encrypt()` + `decrypt()` round-trip: plaintext recovered exactly |
| T-2 | `encrypt()` produces different ciphertext each time (random nonce) |
| T-3 | `decrypt()` with wrong key throws authentication error |
| T-4 | `decrypt()` with tampered ciphertext throws authentication error |
| T-5 | `decrypt()` with wrong nonce throws authentication error |
| T-6 | `decrypt()` with mismatched associated data throws authentication error |
| T-7 | `generateMasterKey()` produces 32-byte key and 16-char hex key_id |
| T-8 | `generateMasterKey()` produces different keys on each call |
| T-9 | `deriveKeyFromPassphrase()` is deterministic: same passphrase + salt = same key |
| T-10 | `deriveKeyFromPassphrase()` with different salt produces different key |
| T-11 | `createRecoveryBlob()` + `recoverMasterKey()` round-trip: master key recovered |
| T-12 | `recoverMasterKey()` with wrong passphrase throws |
| T-13 | `splitEvent()` correctly classifies all fields for each of the 10 event types |
| T-14 | `splitEvent()` puts prompts, tool_input, tool_response in sensitive bucket |
| T-15 | `splitEvent()` puts event_type, timestamp, tool_name in metadata bucket |
| T-16 | `reassembleEvent()` produces event identical to original |
| T-17 | `splitEvent()` + `reassembleEvent()` round-trip for all 10 event types |
| T-18 | `shouldSyncProject()` returns true for allowlisted project |
| T-19 | `shouldSyncProject()` returns false for blocklisted project |
| T-20 | `shouldSyncProject()` respects `default_sync` for unlisted projects |
| T-21 | `calculateRetryDelay()` produces increasing delays with backoff |
| T-22 | `calculateRetryDelay()` caps at MAX_DELAY_MS |
| T-23 | `calculateRetryDelay()` includes jitter (not exactly exponential) |
| T-24 | `LamportClock.tick()` increments monotonically |
| T-25 | `LamportClock.receive()` jumps to max(local, remote) + 1 |
| T-26 | `mergeMetadata()` selects the entry with the later timestamp |

### Integration Tests

| Test | Description |
|------|-------------|
| T-27 | `gc-sync setup` creates sync/ directory, master.key, key.json |
| T-28 | `gc-sync setup` is idempotent (second run does not overwrite key) |
| T-29 | `gc-sync setup --with-passphrase` creates recovery.enc |
| T-30 | Full round-trip: capture event -> queue -> encrypt -> push (mock server) -> verify payload |
| T-31 | Pull events from mock server -> decrypt -> write to synced/ directory |
| T-32 | Cursor is updated after successful pull |
| T-33 | Duplicate events (same event_id) are not written twice |
| T-34 | Push queue is cleaned up after successful push |
| T-35 | Failed push retries with exponential backoff |
| T-36 | Events exceeding MAX_EVENT_SIZE are not queued |
| T-37 | Selective sync: disabled project events are not queued |
| T-38 | Selective sync: mode change from allowlist to blocklist works correctly |
| T-39 | Offline mode: queue accumulates, no network calls |
| T-40 | Coming online: catch-up processes entire queue |
| T-41 | `gc-sync status` displays correct state for each scenario |
| T-42 | Queue limits are enforced (oldest entries dropped when exceeded) |
| T-43 | Dead-letter queue receives events after MAX_RETRIES |
| T-44 | Key export and import: `gc-sync export-key` output can be imported on another machine |
| T-45 | `gc-sync recover` works with correct passphrase, fails with wrong passphrase |

### Security Tests

| Test | Description |
|------|-------------|
| T-46 | master.key file has permissions 0600 |
| T-47 | sync/ directory has permissions 0700 |
| T-48 | Ciphertext contains no plaintext substrings (no partial encryption) |
| T-49 | Nonces are never reused (encrypt 1000 events, verify all nonces unique) |
| T-50 | Derived key is zeroed from memory after use (check memzero call) |
| T-51 | Push payload contains no sensitive fields in cleartext (grep for known prompts) |
| T-52 | Recovery blob is useless without passphrase (attempt decrypt with random key) |

### Performance Tests

| Test | Description |
|------|-------------|
| T-53 | Encrypt + base64-encode a 1KB event in under 5ms |
| T-54 | Encrypt + base64-encode a 1MB event in under 50ms |
| T-55 | Decrypt + parse a 1KB event in under 5ms |
| T-56 | Decrypt + parse a 1MB event in under 50ms |
| T-57 | Argon2id key derivation completes in under 5 seconds |
| T-58 | Push queue append does not add more than 1ms to capture-event latency |
| T-59 | Processing a queue of 1000 events completes in under 60 seconds (with mock server) |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Run `gc-sync setup`, verify files are created with correct permissions |
| M-2 | Capture events, verify they appear in push queue when sync is enabled |
| M-3 | Run `gc-sync status` and verify output matches actual state |
| M-4 | Disable network, capture events, re-enable network, verify catch-up sync |
| M-5 | Run `gc-sync project disable <id>`, capture events for that project, verify they are not queued |
| M-6 | Run `gc-sync setup --with-passphrase`, then `gc-sync recover` on a clean machine, verify key recovery |

---

## Definition of Done

- [ ] libsodium WASM is bundled in `lib/vendor/` and initializes successfully
- [ ] `encrypt()` and `decrypt()` functions pass all round-trip and failure-mode tests
- [ ] Master key is generated using `crypto_aead_xchacha20poly1305_ietf_keygen()` and stored at `~/.claude-context/sync/master.key` (mode 0600)
- [ ] Argon2id key derivation uses parameters: opslimit=3, memlimit=64MB, ALG_ARGON2ID13
- [ ] Recovery blob enables cross-device key recovery from passphrase
- [ ] `splitEvent()` correctly separates cleartext metadata from sensitive payload for all 10 event types
- [ ] Push sync encrypts sensitive payload and POSTs batches to `/api/sync/push`
- [ ] Push queue uses JSONL format with flock-based concurrency control
- [ ] Retry uses exponential backoff with jitter (1s base, 5min cap, 10 max retries)
- [ ] Pull sync fetches events using cursor-based pagination and decrypts them locally
- [ ] Pulled events are stored in `~/.claude-context/synced/{machine-id}/...` without overwriting
- [ ] Conflict resolution: events are append-only (no conflicts); metadata uses last-writer-wins
- [ ] Lamport timestamps provide total ordering across machines
- [ ] Selective sync supports allowlist, blocklist, and all modes
- [ ] Sync status is tracked in `status.json` with six states (synced, syncing, pending, error, offline, disabled)
- [ ] Offline-first: all local features work without network; queue accumulates for later push
- [ ] Queue limits are enforced (50MB / 100,000 entries / 10MB per event)
- [ ] `gc-sync` CLI provides setup, recover, push, pull, status, and project management commands
- [ ] All 59 test cases from the testing plan pass
- [ ] File permissions are correct (0600 for keys and config, 0700 for directories)
- [ ] No sensitive data (prompts, responses, file paths) appears in cleartext in any network payload
- [ ] The sync module does not degrade capture-event performance (< 1ms overhead for queue append)
