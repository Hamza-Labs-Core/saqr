# Story 19: GDPR Compliance

## Overview

GDPR Compliance ensures the AgentContext platform meets all requirements of the EU General Data Protection Regulation (Regulation (EU) 2016/679). This story covers the full spectrum of data protection obligations: data minimization, right to erasure, data portability, consent management, data processing agreements, EU data residency, breach notification procedures, privacy policy documentation, and cookie-free design.

The platform's zero-knowledge encryption architecture (F10) is the foundation of GDPR compliance. Because the sync server never sees plaintext user data -- only encrypted blobs and anonymous metadata -- many GDPR obligations are satisfied by design. This story formalizes those protections, fills gaps, and provides the documentation, APIs, and processes required for full compliance.

**Guiding principle**: Privacy by design, not privacy by afterthought. Every component -- daemon, sync server, mobile app, desktop app -- must be auditable against a concrete GDPR checklist. The zero-knowledge architecture means the server is a data processor that never accesses personal data, but we must still prove it.

**Key GDPR Articles Referenced**:
- Art. 5: Principles of processing (lawfulness, minimization, accuracy, storage limitation, integrity)
- Art. 6: Lawfulness of processing
- Art. 7: Conditions for consent
- Art. 12-14: Transparent information and communication
- Art. 15: Right of access
- Art. 17: Right to erasure
- Art. 20: Right to data portability
- Art. 25: Data protection by design and by default
- Art. 28: Processor obligations
- Art. 30: Records of processing activities
- Art. 32: Security of processing
- Art. 33: Notification of breach to supervisory authority
- Art. 34: Communication of breach to data subject
- Art. 44-49: Transfers to third countries

---

## Scope

### In Scope

- Data minimization audit and enforcement (server-side metadata schema)
- Right to erasure API endpoint and crypto-shredding implementation
- Data portability export API and archive format
- Consent management system (opt-in, withdrawal, version tracking)
- Data Processing Agreement with Cloudflare
- EU data residency enforcement via Durable Object and R2 location hints
- Breach notification plan and templates
- Privacy policy document and versioning
- Cookie-free authentication and tracking design
- Data Processing Agreement template for team/enterprise customers
- GDPR compliance checklist per component
- Automated compliance testing

### Out of Scope (Non-Goals)

- Implementing the encryption system itself (F10, covered in its own story)
- Implementing the sync server itself (F9, covered in its own story)
- ePrivacy Regulation compliance (separate from GDPR, future work)
- CCPA/CPRA compliance (California, separate story)
- UK GDPR post-Brexit divergences (handled as delta from EU GDPR)
- HIPAA or SOC 2 compliance
- Legal review of final documents (requires external counsel)
- Appointing a Data Protection Officer (organizational decision)

---

## Requirements

### 1. Data Minimization (F11.1)

The sync server must store only the minimum data necessary for its function. Because of zero-knowledge encryption, the server never sees the content of user events. This section formalizes exactly what the server does and does not see.

**GDPR Reference**: Art. 5(1)(c) -- "adequate, relevant and limited to what is necessary."

#### Server-Side Data Inventory

The sync server handles two categories of data: cleartext metadata (stored in Durable Object SQLite) and encrypted blobs (stored in R2). The server **never** has access to the encryption key.

##### What the Server Sees (Cleartext Metadata)

| Field | Type | Purpose | Contains PII? |
|-------|------|---------|---------------|
| `machine_id` | string | Device identification for sync routing | No (derived hash, e.g., `macbook-a3f7b2`) |
| `project_id` | string | Project grouping for sync | No (derived hash, e.g., `myapp-c9d1e4`) |
| `session_id_hash` | string | Session correlation (truncated SHA-256) | No (irreversible hash) |
| `sequence` | integer | Event ordering | No |
| `event_type` | string | Event classification (e.g., `ToolCallCompleted`) | No |
| `timestamp` | ISO 8601 | Event ordering and retention enforcement | No (when event happened, not who) |
| `input_tokens` | integer | Usage metering and billing | No |
| `output_tokens` | integer | Usage metering and billing | No |
| `cache_read_tokens` | integer | Usage metering | No |
| `model` | string | Usage analytics (e.g., `claude-opus-4-6`) | No |
| `r2_key` | string | Pointer to encrypted blob in R2 | No (path, not content) |

##### What the Server Sees (Account Data in KV)

| Field | Type | Purpose | Contains PII? |
|-------|------|---------|---------------|
| `email` | string | Account identifier and login | **Yes** |
| `userId` | UUID | Internal identifier | Pseudonymous |
| `tier` | string | Billing tier | No |
| `createdAt` | ISO 8601 | Account age | No |
| `region_preference` | string | EU residency preference | No |
| `consent_version` | string | Consent tracking | No |
| `consent_timestamp` | ISO 8601 | When consent was given | No |

##### What the Server Never Sees (Encrypted in R2 Blobs)

| Data | Why It Is Protected |
|------|-------------------|
| Session IDs (full) | Only `session_id_hash` (truncated SHA-256) is in cleartext |
| User prompts | Encrypted inside event blob |
| Agent responses | Encrypted inside event blob |
| Tool inputs (file paths, commands) | Encrypted inside event blob |
| Tool outputs (file contents, command output) | Encrypted inside event blob |
| File contents | Encrypted inside event blob |
| Project names (full) | Only `project_id` hash is in cleartext |
| Machine names (full) | Only `machine_id` hash is in cleartext |
| Decision rationale | Encrypted inside event blob |
| Any user-generated content | Encrypted inside event blob |

#### Metadata Schema Enforcement

The sync server Worker must validate that incoming push requests contain **only** the allowed cleartext metadata fields. Any unexpected fields must be stripped before storage.

```typescript
// Worker: validate cleartext metadata on push
const ALLOWED_METADATA_FIELDS = new Set([
  'machine_id',
  'project_id',
  'session_id_hash',
  'sequence',
  'event_type',
  'timestamp',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'model',
  'r2_key',
]);

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of ALLOWED_METADATA_FIELDS) {
    if (key in meta) {
      sanitized[key] = meta[key];
    }
  }
  return sanitized;
}
```

#### PII Leak Prevention

The daemon's sync client must ensure that no PII leaks into cleartext metadata before pushing to the server.

```typescript
// Daemon sync client: construct metadata from event
function buildCleartextMetadata(event: EventEnvelope): SyncMetadata {
  return {
    machine_id: deriveMachineId(),          // hash, not hostname
    project_id: event.project_id,           // already a hash
    session_id_hash: sha256(event.session_id).substring(0, 16),
    sequence: event.sequence,
    event_type: event.event_type,
    timestamp: event.timestamp,
    input_tokens: extractTokenCount(event, 'input'),
    output_tokens: extractTokenCount(event, 'output'),
    cache_read_tokens: extractTokenCount(event, 'cache_read'),
    model: extractModel(event),
    r2_key: buildR2Key(event),
  };
  // Note: NO prompt, response, file paths, file contents, or session_id
}
```

#### Acceptance Criteria

- [ ] A formal data inventory document lists every field the server stores, with PII classification
- [ ] The Worker validates and strips unexpected fields from incoming metadata
- [ ] The daemon's sync client never includes plaintext PII in cleartext metadata
- [ ] `session_id` is always hashed (truncated SHA-256) before leaving the client
- [ ] `machine_id` and `project_id` are derived hashes, not human-readable names
- [ ] Automated tests verify that no PII appears in cleartext metadata for all 10 event types
- [ ] The data inventory is versioned and updated when the metadata schema changes

---

### 2. Right to Erasure (F11.2)

Users have the right to request deletion of all their personal data. Because the platform uses zero-knowledge encryption, erasure is achieved through a combination of record deletion and crypto-shredding (destroying the server-side ability to ever associate data with the user).

**GDPR Reference**: Art. 17 -- "The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay."

#### Deletion API Endpoint

```
DELETE /api/account
Authorization: Bearer <jwt>
```

Response:
```json
{
  "status": "deletion_initiated",
  "deletion_id": "del-uuid-v4",
  "estimated_completion": "2026-02-24T00:00:00Z",
  "what_will_be_deleted": [
    "account_record",
    "all_encrypted_event_blobs",
    "all_metadata_records",
    "all_machine_registrations",
    "all_sync_cursors"
  ]
}
```

#### Deletion Flow

```
User requests account deletion (DELETE /api/account)
  │
  ├─ 1. Worker verifies JWT, confirms user identity
  │
  ├─ 2. Worker marks account as "pending_deletion" in KV
  │     - Immediately revokes all JWTs (add to blocklist)
  │     - Returns deletion_id and estimated completion time
  │
  ├─ 3. Worker sends deletion command to user's Durable Object
  │
  ├─ 4. Durable Object executes crypto-shredding:
  │     a. List all R2 keys under /users/{user-id}/
  │     b. Delete all R2 objects (encrypted blobs) via R2.delete()
  │     c. DROP all SQLite tables (machines, events_meta, sync_cursors)
  │     d. Delete the Durable Object's storage (this.ctx.storage.deleteAll())
  │
  ├─ 5. Worker cleans up KV:
  │     a. Delete users:{email} key
  │     b. Delete all sessions:{token} keys for this user
  │     c. Create deletion audit record (see below)
  │
  └─ 6. Worker sends deletion confirmation email (if email is still available)
       - Then deletes the email from the audit record after sending
```

#### Crypto-Shredding

Even after R2 blob deletion, the data is cryptographically unrecoverable because:

1. The master encryption key exists **only** on user devices (OS keychain)
2. The server never had the key
3. R2 blob deletion removes the ciphertext
4. DO storage deletion removes all metadata
5. KV deletion removes the account record

Even if R2 deletion has eventual consistency delays, the data without the key is meaningless random bytes.

#### Deletion Audit Record

The system must log that a deletion occurred without storing any user data. This audit record is stored in a separate KV namespace (`deletion_log`):

```json
{
  "deletion_id": "del-uuid-v4",
  "requested_at": "2026-02-21T14:30:00Z",
  "completed_at": "2026-02-21T14:31:22Z",
  "r2_objects_deleted": 1547,
  "do_storage_cleared": true,
  "kv_records_deleted": 3,
  "user_email_hash": "sha256(email)[:16]"
}
```

Note: The `user_email_hash` is a truncated, irreversible hash. It exists solely to handle duplicate deletion requests ("has this email already been deleted?") without storing the actual email.

#### Timeline Guarantees

| Phase | Target | Hard Limit |
|-------|--------|------------|
| JWT revocation | Immediate | < 1 minute |
| Account marked pending_deletion | Immediate | < 1 minute |
| R2 blob deletion initiated | < 1 hour | 24 hours |
| R2 blob deletion completed | < 24 hours | 72 hours |
| DO storage cleared | < 1 hour | 24 hours |
| KV records deleted | < 1 hour | 24 hours |
| Full erasure confirmed | < 24 hours | **72 hours** (GDPR Art. 17 "without undue delay") |

#### Re-registration After Deletion

A deleted user may re-register with the same email. The system must handle this:

- The `user_email_hash` in the deletion log does NOT prevent re-registration
- A new `userId` is generated (no link to previous account)
- No previous data is recoverable (crypto-shredded)

#### Acceptance Criteria

- [ ] `DELETE /api/account` endpoint exists and requires valid JWT
- [ ] Account is immediately marked as pending_deletion and all JWTs are revoked
- [ ] All R2 objects under the user's prefix are deleted
- [ ] All DO SQLite tables are dropped and DO storage is cleared
- [ ] All KV records for the user are deleted
- [ ] A deletion audit record is created without storing PII (email is hashed)
- [ ] Full erasure completes within 72 hours
- [ ] Re-registration with the same email creates a completely fresh account
- [ ] The deletion flow is idempotent (calling DELETE twice does not error)
- [ ] Deletion works even if the user has no sync data (fresh account)

---

### 3. Data Portability (F11.3)

Users have the right to receive their personal data in a structured, commonly used, machine-readable format and to transmit it to another controller.

**GDPR Reference**: Art. 20 -- "The data subject shall have the right to receive the personal data concerning him or her... in a structured, commonly used and machine-readable format."

#### Export API Endpoint

```
POST /api/account/export
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "format": "json",
  "include_metadata": true,
  "date_range": {
    "from": "2026-01-01T00:00:00Z",
    "to": "2026-02-21T23:59:59Z"
  }
}
```

Response (immediate):
```json
{
  "export_id": "exp-uuid-v4",
  "status": "processing",
  "estimated_size_bytes": 15728640,
  "poll_url": "/api/account/export/exp-uuid-v4",
  "expires_at": "2026-02-22T14:30:00Z"
}
```

Response (when ready, via poll URL):
```json
{
  "export_id": "exp-uuid-v4",
  "status": "ready",
  "download_url": "/api/account/export/exp-uuid-v4/download",
  "download_token": "single-use-token",
  "size_bytes": 15728640,
  "event_count": 4523,
  "expires_at": "2026-02-22T14:30:00Z",
  "checksum_sha256": "a3f7b2c9d1e4..."
}
```

#### Export Archive Format

The export produces a ZIP archive containing encrypted blobs and cleartext metadata. The user decrypts on their device using their master key.

```
agentcontext-export-2026-02-21.zip
├── manifest.json
├── metadata/
│   ├── account.json          # Account info (email, tier, created_at)
│   ├── machines.json         # Machine registry
│   └── events_meta.json      # Cleartext metadata for all events
├── events/
│   ├── {machine-id}/
│   │   ├── {project-id}/
│   │   │   ├── {session-id-hash}/
│   │   │   │   ├── 000001.enc
│   │   │   │   ├── 000002.enc
│   │   │   │   └── ...
│   │   │   └── ...
│   │   └── ...
│   └── ...
└── README.txt                # Instructions for decrypting the export
```

#### manifest.json

```json
{
  "export_version": "1.0.0",
  "format": "agentcontext-export",
  "created_at": "2026-02-21T14:30:00Z",
  "encryption": {
    "algorithm": "XChaCha20-Poly1305",
    "key_derivation": "user_master_key",
    "note": "Decrypt each .enc file using your master key. Nonce is prepended to each ciphertext."
  },
  "event_count": 4523,
  "machine_count": 2,
  "project_count": 7,
  "date_range": {
    "from": "2026-01-01T00:00:00Z",
    "to": "2026-02-21T23:59:59Z"
  },
  "checksum_sha256": "a3f7b2c9d1e4..."
}
```

#### Client-Side Decryption

The daemon or CLI provides a command to decrypt an exported archive:

```bash
agentctx export decrypt --input agentcontext-export-2026-02-21.zip --output ./decrypted/
```

This command:
1. Reads the user's master key from the OS keychain
2. Iterates over all `.enc` files in the archive
3. Decrypts each file using XChaCha20-Poly1305 (nonce is prepended to ciphertext)
4. Writes the decrypted JSON events to the output directory
5. Produces a summary of decrypted events

#### Import to Self-Hosted Instance

Decrypted exports can be imported into a self-hosted AgentContext instance:

```bash
agentctx import --input ./decrypted/ --target ~/.claude-context/events/
```

This command:
1. Reads decrypted event JSON files from the input directory
2. Maps them to the local event store format (event envelope)
3. Writes them to the target event store directory
4. Rebuilds projections for the imported events

#### Acceptance Criteria

- [ ] `POST /api/account/export` endpoint exists and requires valid JWT
- [ ] Export is processed asynchronously with a poll URL for status
- [ ] The export archive is a ZIP containing encrypted blobs and cleartext metadata
- [ ] `manifest.json` describes the archive format, encryption, and contents
- [ ] The download URL uses a single-use token that expires after 24 hours
- [ ] Client-side decryption command works with the user's master key
- [ ] Decrypted events are valid JSON matching the event envelope schema
- [ ] Import command can load decrypted events into a local event store
- [ ] Export respects date range filters
- [ ] Export includes a `README.txt` with decryption instructions
- [ ] Export checksum (SHA-256) is provided for integrity verification

---

### 4. Consent Management (F11.4)

The platform must obtain explicit, informed, freely given consent before processing personal data. Local-only mode is the default; sync requires explicit opt-in.

**GDPR Reference**: Art. 6(1)(a) -- "the data subject has given consent"; Art. 7 -- "Conditions for consent."

#### Consent Model

```
Local-only mode (DEFAULT):
  - No account required
  - No data leaves the machine
  - No consent needed (no data processing by a third party)

Sync mode (OPT-IN):
  - Requires explicit consent
  - Consent must be recorded with timestamp and version
  - User must be told exactly what data is processed and where
  - Consent can be withdrawn at any time
```

#### Consent Record Schema

Stored in KV alongside the user account:

```json
{
  "user_id": "uuid",
  "consents": [
    {
      "consent_id": "con-uuid-v4",
      "version": "1.0.0",
      "scope": "sync_processing",
      "granted_at": "2026-02-21T14:30:00Z",
      "ip_country": "DE",
      "client_version": "1.0.0",
      "consent_text_hash": "sha256(consent_text)[:32]",
      "withdrawn_at": null
    }
  ]
}
```

#### Consent Text (Displayed at Registration)

The consent text must be clear, specific, and in plain language (GDPR Art. 7(2)):

```
DATA PROCESSING CONSENT

By enabling sync, you agree to the following:

WHAT WE PROCESS:
- Anonymous metadata about your coding sessions (event types, timestamps,
  token counts, model used). This metadata contains NO code, prompts,
  or personal information.
- Encrypted copies of your session events. These are encrypted on your
  device before upload. We cannot read, access, or decrypt this data.

WHERE YOUR DATA IS STORED:
- Cloudflare's edge network (Workers, Durable Objects, R2 storage)
- If you select EU residency: data is pinned to EU data centers

WHO CAN ACCESS YOUR DATA:
- Only you, using your encryption key
- Our server infrastructure processes encrypted blobs but cannot
  decrypt them
- Cloudflare (as sub-processor) hosts the infrastructure

YOUR RIGHTS:
- Withdraw consent and stop syncing at any time
- Delete all your data at any time (account deletion)
- Export all your data at any time (data portability)
- Request information about what data we hold (right of access)

This consent is version {version}. You will be notified if the
processing terms change, and re-consent will be required.
```

#### Consent Recording Flow

```
User clicks "Enable Sync" in dashboard or CLI
  │
  ├─ 1. Display consent text (full, not behind a link)
  │
  ├─ 2. User explicitly confirms ("I agree" button or --consent flag)
  │     - No pre-checked boxes
  │     - No bundled consent (sync consent is separate from ToS)
  │
  ├─ 3. Client sends consent record to server:
  │     POST /api/consent
  │     {
  │       "version": "1.0.0",
  │       "scope": "sync_processing",
  │       "consent_text_hash": "sha256(displayed_text)[:32]"
  │     }
  │
  ├─ 4. Server stores consent record with timestamp
  │
  └─ 5. Sync is enabled
```

#### Consent Withdrawal Flow

```
User clicks "Disable Sync" or runs `agentctx sync disable`
  │
  ├─ 1. Confirm intent: "This will stop syncing. Your existing
  │     cloud data can be deleted or kept."
  │
  ├─ 2. Options:
  │     a. Stop syncing, keep cloud data (can re-enable later)
  │     b. Stop syncing, delete cloud data (exercises right to erasure)
  │
  ├─ 3. Client sends withdrawal to server:
  │     POST /api/consent/withdraw
  │     {
  │       "consent_id": "con-uuid-v4",
  │       "delete_data": true|false
  │     }
  │
  ├─ 4. Server records withdrawal timestamp on consent record
  │
  ├─ 5. If delete_data: trigger the deletion flow (Section 2)
  │
  └─ 6. Local daemon stops sync operations
```

#### Consent Version Tracking

When the consent text changes (e.g., new sub-processor, changed data scope):

1. The consent version is incremented (e.g., `1.0.0` -> `1.1.0`)
2. All existing users with the old version are flagged for re-consent
3. On next login/sync, the user is shown the updated consent text
4. Sync is paused until re-consent is obtained
5. The old consent record is preserved (not overwritten) for audit trail

```typescript
// Worker middleware: check consent version
async function requireCurrentConsent(request: Request, env: Env): Promise<void> {
  const user = await getUser(request, env);
  const currentVersion = env.CONSENT_VERSION; // e.g., "1.1.0"
  const userConsent = user.consents.find(
    c => c.scope === 'sync_processing' && !c.withdrawn_at
  );

  if (!userConsent || userConsent.version !== currentVersion) {
    throw new ConsentRequiredError(currentVersion);
    // Client shows new consent text and requires re-consent
  }
}
```

#### Acceptance Criteria

- [ ] Local-only mode is the default; no consent required for local-only use
- [ ] Enabling sync requires explicit opt-in with consent text displayed in full
- [ ] No pre-checked checkboxes or bundled consent
- [ ] Consent record includes version, timestamp, scope, and text hash
- [ ] Consent can be withdrawn at any time, with option to delete cloud data
- [ ] Consent withdrawal immediately stops sync operations
- [ ] Consent version tracking flags users for re-consent when terms change
- [ ] Sync is paused for users who have not consented to the current version
- [ ] Old consent records are preserved for audit trail (not overwritten)
- [ ] Consent text is in plain, non-legal language

---

### 5. DPA with Cloudflare (F11.5)

Cloudflare acts as a sub-processor. A Data Processing Agreement must be in place.

**GDPR Reference**: Art. 28 -- "Processing by a processor shall be governed by a contract."

#### Cloudflare DPA Coverage

Cloudflare provides a standard DPA that covers:

- Workers (compute)
- Durable Objects (stateful compute + storage)
- R2 (object storage)
- KV (key-value storage)
- CDN and network services

The Cloudflare DPA is available at `https://www.cloudflare.com/cloudflare-customer-dpa/` and covers:

| Requirement | Coverage |
|-------------|----------|
| Art. 28(3)(a) -- Process only on documented instructions | Covered |
| Art. 28(3)(b) -- Confidentiality obligations | Covered |
| Art. 28(3)(c) -- Security measures (Art. 32) | Covered |
| Art. 28(3)(d) -- Sub-processor controls | Covered |
| Art. 28(3)(e) -- Assist with data subject rights | Covered |
| Art. 28(3)(f) -- Assist with security obligations | Covered |
| Art. 28(3)(g) -- Delete/return data on termination | Covered |
| Art. 28(3)(h) -- Audit rights | Covered (via SOC 2 reports) |

#### Sub-Processor List

| Sub-Processor | Service | Data Accessed |
|---------------|---------|---------------|
| Cloudflare, Inc. | Workers, DO, R2, KV | Encrypted blobs, anonymous metadata, account email |
| (None other) | -- | -- |

The platform uses **no other third-party services** for data processing. No analytics providers, no error tracking services, no CDN for user data beyond Cloudflare.

#### Documentation Requirements

The following documents must be maintained:

1. **Sub-processor list** (public, versioned) -- Updated whenever a new sub-processor is added
2. **Cloudflare DPA reference** -- Link to the signed DPA
3. **Record of Processing Activities (ROPA)** (Art. 30) -- Internal document listing all processing activities
4. **Data flow diagram** -- Shows what data moves where, in what form (encrypted vs. cleartext)

#### Acceptance Criteria

- [ ] Cloudflare DPA is signed and on file
- [ ] Sub-processor list is published and contains only Cloudflare
- [ ] Record of Processing Activities (ROPA) document exists
- [ ] Data flow diagram showing encryption boundaries is maintained
- [ ] No additional sub-processors are used without updating the list and notifying users
- [ ] DPA reference is included in the privacy policy

---

### 6. EU Data Residency (F11.6)

EU users must have the option to ensure their data remains within the European Union.

**GDPR Reference**: Art. 44-49 -- "Any transfer of personal data... to a third country... shall take place only if the conditions laid down in this Chapter are complied with."

#### Durable Object Location Hints

Cloudflare Durable Objects support `locationHint` to suggest where the object should be created:

```typescript
// Worker: create DO with EU location hint
function getUserDO(env: Env, userId: string, region: string): DurableObjectStub {
  const id = env.USER_DO.idFromName(userId);

  if (region === 'eu') {
    return env.USER_DO.get(id, { locationHint: 'eeur' });
  }

  return env.USER_DO.get(id);
}
```

Cloudflare location hints for EU:
- `eeur` -- Eastern Europe
- `weur` -- Western Europe

The platform uses `eeur` as the default EU hint (closest to major EU data centers).

#### R2 Bucket Configuration

R2 supports location hints at the bucket level. For EU users, a dedicated EU bucket is used:

```typescript
// wrangler.toml
[[r2_buckets]]
binding = "R2_DEFAULT"
bucket_name = "agentcontext-events"

[[r2_buckets]]
binding = "R2_EU"
bucket_name = "agentcontext-events-eu"
jurisdiction = "eu"
```

```typescript
// Worker: route to correct R2 bucket
function getR2Bucket(env: Env, region: string): R2Bucket {
  if (region === 'eu') {
    return env.R2_EU;
  }
  return env.R2_DEFAULT;
}
```

#### User Region Preference

Region preference is set at account creation and stored in KV:

```json
{
  "userId": "uuid",
  "email": "user@example.com",
  "tier": "pro",
  "region": "eu",
  "region_set_at": "2026-02-21T14:30:00Z"
}
```

Region can be updated, but changing from EU to non-EU requires re-consent (data may leave EU jurisdiction).

#### Region Detection at Registration

```typescript
// Worker: suggest region based on request origin
async function detectRegion(request: Request): Promise<string> {
  const country = request.cf?.country || 'US';
  const euCountries = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
    'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
    'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    // EEA
    'IS', 'LI', 'NO',
  ]);

  if (euCountries.has(country)) {
    return 'eu';
  }
  return 'default';
}
```

The detected region is **suggested** to the user, not automatically applied. The user confirms or overrides during registration.

#### Data Residency Verification

A periodic audit job verifies that EU-flagged data is actually in EU infrastructure:

```typescript
// Scheduled Worker: verify EU data residency
async function verifyEUResidency(env: Env): Promise<AuditResult> {
  const euUsers = await listEUUsers(env);
  const violations: string[] = [];

  for (const user of euUsers) {
    // Check R2 bucket
    const bucket = getR2Bucket(env, user.region);
    if (bucket !== env.R2_EU) {
      violations.push(`User ${user.userId}: R2 bucket mismatch`);
    }

    // Check DO location (via DO metadata if available)
    // Note: Cloudflare does not guarantee locationHint is honored,
    // but it is "best effort." Document this limitation.
  }

  return { checked: euUsers.length, violations };
}
```

**Important limitation**: Cloudflare `locationHint` is advisory, not guaranteed. The privacy policy must disclose that EU residency is "best effort" using Cloudflare's location hints. For strict data sovereignty requirements, self-hosted deployment is recommended.

#### Acceptance Criteria

- [ ] EU users can select EU as their data region during registration
- [ ] Region is auto-detected from request origin and suggested (not forced)
- [ ] Durable Objects for EU users are created with `locationHint: 'eeur'`
- [ ] EU users' encrypted blobs are stored in a dedicated EU R2 bucket with `jurisdiction: "eu"`
- [ ] KV records store the user's region preference
- [ ] Changing region from EU to non-EU requires re-consent
- [ ] Privacy policy discloses the "best effort" nature of Cloudflare location hints
- [ ] A periodic audit job checks EU data residency compliance
- [ ] Pro and Team tiers offer EU residency; Free tier does not (per tier structure)

---

### 7. Breach Notification (F11.7)

In the event of a data breach, the platform must follow GDPR notification requirements. However, because all user data is encrypted with keys the server never possesses, most breaches qualify for the exemption under Art. 34(3)(a).

**GDPR Reference**: Art. 33 -- "72-hour notification to supervisory authority"; Art. 34 -- "Communication to data subject"; Art. 34(3)(a) -- Exemption when "appropriate technical and organisational protection measures" (encryption) render data unintelligible.

#### Breach Classification

| Breach Type | Data Exposed | Risk Level | Notification Required? |
|------------|-------------|------------|----------------------|
| R2 bucket breach | Encrypted blobs | **Low** -- data is unintelligible without master key | Supervisory authority: **Yes** (Art. 33). Data subjects: **No** (Art. 34(3)(a) exemption) |
| DO SQLite breach | Anonymous metadata (no PII except hashed session IDs) | **Low** -- no PII in metadata | Supervisory authority: **Yes**. Data subjects: Likely **No** |
| KV breach | Account emails, user IDs | **Medium** -- email is PII | Supervisory authority: **Yes**. Data subjects: **Yes** (email is personal data) |
| Worker code breach | No user data (stateless) | **Low** | Case-by-case assessment |
| Full infrastructure breach | All of the above | **Medium** -- email exposed, but event data remains encrypted | Supervisory authority: **Yes**. Data subjects: **Yes** (for email exposure) |

#### Incident Response Plan

```
PHASE 1: DETECTION AND CONTAINMENT (0-4 hours)
  1. Detect breach (monitoring, alerts, or report)
  2. Assemble incident response team
  3. Contain the breach (revoke credentials, isolate systems)
  4. Preserve evidence (logs, access records)

PHASE 2: ASSESSMENT (4-24 hours)
  5. Determine scope: what data was accessed?
  6. Classify: encrypted blobs only? metadata? account emails?
  7. Determine affected user count
  8. Assess risk level per classification table above

PHASE 3: NOTIFICATION (24-72 hours)
  9. If risk threshold met:
     a. Notify supervisory authority within 72 hours (Art. 33)
     b. Notify affected data subjects "without undue delay" (Art. 34)
  10. If encrypted-data-only breach:
     a. Notify supervisory authority within 72 hours
     b. Document Art. 34(3)(a) exemption rationale
     c. Do NOT notify data subjects (data is unintelligible)

PHASE 4: REMEDIATION (72+ hours)
  11. Fix the vulnerability
  12. Review and update security measures
  13. Update incident log
  14. Conduct post-incident review
```

#### Notification Templates

##### Supervisory Authority Notification (Art. 33)

```
PERSONAL DATA BREACH NOTIFICATION

Date of notification: {date}
Date of breach: {breach_date}
Date of discovery: {discovery_date}

1. NATURE OF BREACH
   {description}

2. CATEGORIES OF DATA SUBJECTS
   Registered users of the AgentContext platform.
   Approximate count: {count}

3. CATEGORIES OF DATA
   - Account email addresses (if KV was breached)
   - Encrypted event data (unintelligible without user-held keys)
   - Anonymous usage metadata (event types, timestamps, token counts)

4. LIKELY CONSEQUENCES
   {If encrypted only}: Data is protected by XChaCha20-Poly1305
   encryption. The encryption keys are held exclusively by users on
   their devices and are not accessible to our servers. The breached
   data is unintelligible to any party without the key.

   {If email exposed}: Email addresses may be used for phishing or
   spam. No passwords, financial data, or session content was exposed.

5. MEASURES TAKEN
   - {containment actions}
   - {remediation actions}
   - {notification to data subjects if applicable}

6. DPO CONTACT
   {dpo_email}
```

##### Data Subject Notification (Art. 34, when required)

```
Subject: Security Notification - AgentContext

We are writing to inform you of a security incident that affected
your AgentContext account.

WHAT HAPPENED:
{brief description}

WHAT DATA WAS AFFECTED:
- Your account email address: {email}
- Your encrypted session data was NOT compromised — it remains
  protected by your personal encryption key, which our servers
  have never had access to.

WHAT WE ARE DOING:
- {remediation actions}

WHAT YOU SHOULD DO:
- Be cautious of phishing emails referencing AgentContext
- Your session data, code, and prompts remain secure
- No action required regarding your encryption key

CONTACT:
{support_email}
{dpo_email}
```

#### Acceptance Criteria

- [ ] Breach classification table documents risk levels for each data category
- [ ] Incident response plan covers detection, assessment, notification, and remediation
- [ ] Notification template for supervisory authority is prepared (Art. 33)
- [ ] Notification template for data subjects is prepared (Art. 34)
- [ ] Art. 34(3)(a) exemption is documented for encrypted-data-only breaches
- [ ] 72-hour timeline is documented with phase breakdowns
- [ ] Incident response plan is reviewed and updated annually
- [ ] All notification templates are versioned and stored in the repository

---

### 8. Privacy Policy (F11.8)

A clear, comprehensive privacy policy documents what data the platform collects, how it is processed, and what rights users have.

**GDPR Reference**: Art. 12 -- "transparent, intelligible and easily accessible form, using clear and plain language"; Art. 13-14 -- Information to be provided.

#### Privacy Policy Structure

```
AGENTCONTEXT PRIVACY POLICY
Last updated: {date}
Version: {version}

1. WHO WE ARE
   - Company name and contact
   - Data Protection Officer contact
   - Supervisory authority

2. WHAT DATA WE COLLECT
   2.1 Local-only mode
       - No data is collected by us
       - All data stays on your machine
   2.2 Sync mode
       - Account email (for login)
       - Encrypted session events (we cannot read these)
       - Anonymous metadata (event types, timestamps, token counts)
       - See Data Inventory table for complete list

3. HOW WE USE YOUR DATA
   3.1 Account management (email)
   3.2 Sync routing (anonymous metadata)
   3.3 Usage metering and billing (token counts)
   3.4 We NEVER use your data for:
       - Training AI models
       - Advertising
       - Profiling
       - Selling to third parties

4. LEGAL BASIS FOR PROCESSING
   - Consent (Art. 6(1)(a)) for sync features
   - Legitimate interest (Art. 6(1)(f)) for security and fraud prevention
   - Contract performance (Art. 6(1)(b)) for paid tier features

5. ZERO-KNOWLEDGE ARCHITECTURE
   5.1 What "zero-knowledge" means
   5.2 What our server CAN see (metadata table)
   5.3 What our server CANNOT see (encrypted data table)
   5.4 Encryption details (XChaCha20-Poly1305, client-side)

6. DATA STORAGE AND RETENTION
   6.1 Where data is stored (Cloudflare infrastructure)
   6.2 EU data residency option
   6.3 Retention periods per tier

7. YOUR RIGHTS
   7.1 Right of access (Art. 15)
   7.2 Right to rectification (Art. 16)
   7.3 Right to erasure (Art. 17)
   7.4 Right to data portability (Art. 20)
   7.5 Right to withdraw consent (Art. 7(3))
   7.6 Right to lodge a complaint (Art. 77)
   7.7 How to exercise your rights

8. SUB-PROCESSORS
   - Cloudflare (link to their DPA)
   - No other sub-processors

9. INTERNATIONAL TRANSFERS
   - Cloudflare's global network
   - EU data residency option
   - Standard Contractual Clauses

10. COOKIES AND TRACKING
    - We use NO cookies
    - We use NO analytics
    - We use NO tracking pixels
    - Authentication is JWT-based

11. CHILDREN
    - Service not directed at children under 16

12. CHANGES TO THIS POLICY
    - Version tracking
    - Notification of material changes
    - Re-consent for sync changes

13. CONTACT
    - DPO email
    - Supervisory authority contact
```

#### Plain Language Requirements

The privacy policy must pass the following readability checks:

- Written in plain English (no legal jargon without explanation)
- Sentences average under 20 words
- Technical terms are explained on first use
- "You/your" language (not "the data subject")
- Key points are in bold or highlighted
- Available in a single, scrollable page (no nested links to sub-pages)

#### Version Tracking

```json
{
  "current_version": "1.0.0",
  "effective_date": "2026-02-21",
  "changelog": [
    {
      "version": "1.0.0",
      "date": "2026-02-21",
      "changes": "Initial privacy policy"
    }
  ]
}
```

Material changes (new data collected, new sub-processor, changed retention) trigger:
1. Version increment
2. Email notification to all registered users
3. Banner in dashboard and apps
4. Re-consent requirement for sync users (if data processing scope changed)

#### Acceptance Criteria

- [ ] Privacy policy follows the structure defined above with all 13 sections
- [ ] Policy is written in plain language (no unexplained legal jargon)
- [ ] Policy clearly separates local-only mode (no data collection) from sync mode
- [ ] Zero-knowledge architecture is explained in terms a non-technical user can understand
- [ ] Data inventory tables from Section 1 are included in the policy
- [ ] All GDPR rights are listed with instructions on how to exercise them
- [ ] Policy is versioned with a changelog
- [ ] Material changes trigger user notification and re-consent where applicable
- [ ] Policy is accessible from the website, dashboard, mobile app, and CLI (`agentctx privacy-policy`)

---

### 9. Cookie-Free Design (F11.9)

The platform uses no cookies, no tracking, and no third-party scripts. Authentication is entirely JWT-based.

**GDPR Reference**: While cookies are primarily covered by the ePrivacy Directive (2002/58/EC), a cookie-free design eliminates an entire category of GDPR compliance complexity.

#### No Tracking Cookies

The platform does not set any cookies. Period. This includes:

- No session cookies
- No authentication cookies
- No analytics cookies (no analytics at all)
- No tracking pixels
- No fingerprinting
- No localStorage-based tracking
- No third-party cookies

#### JWT-Based Authentication

All authentication uses JWT tokens stored in client-side memory (not cookies, not localStorage for web portal):

```typescript
// Web portal: JWT stored in memory only
class AuthStore {
  private token: string | null = null;

  setToken(jwt: string): void {
    this.token = jwt;
    // NOT stored in localStorage, sessionStorage, or cookies
    // Token is lost on page refresh (re-login required)
    // For persistent login: use refresh token in httpOnly secure cookie
    // (only if strictly necessary, and it's a first-party functional cookie)
  }

  getToken(): string | null {
    return this.token;
  }

  clearToken(): void {
    this.token = null;
  }
}
```

For the desktop app and mobile app, the JWT is stored in the OS-level secure storage (Keychain/Keystore), not in cookies.

For the daemon CLI, the JWT is stored in `~/.claude-context/auth.json` with 600 permissions.

#### No Third-Party Scripts

The web portal, dashboard, and all client applications must not load any third-party scripts:

- No Google Analytics, Plausible, Fathom, or any analytics
- No Sentry, Bugsnag, or error tracking services
- No Intercom, Zendesk, or chat widgets
- No Facebook/Twitter/LinkedIn pixels
- No CDN-hosted libraries (all assets are self-hosted or bundled)
- No external fonts (system fonts or bundled fonts only)

#### First-Party Only Storage

If `localStorage` or `sessionStorage` is used (e.g., for UI preferences in the web portal), it must be:

- First-party only (same origin)
- Not used for tracking or analytics
- Clearly documented in the privacy policy
- Limited to functional purposes (theme preference, sidebar state)

```typescript
// Allowed: first-party functional storage
localStorage.setItem('theme', 'dark');
localStorage.setItem('sidebar_collapsed', 'true');

// NOT allowed: anything that could identify or track users
// localStorage.setItem('user_id', userId);        // NO
// localStorage.setItem('last_visit', timestamp);   // NO
// localStorage.setItem('referrer', document.referrer); // NO
```

#### Acceptance Criteria

- [ ] No cookies are set by any component (server, web portal, dashboard)
- [ ] Authentication uses JWT tokens, not session cookies
- [ ] No third-party scripts are loaded in any client application
- [ ] No analytics services are used
- [ ] No tracking pixels or fingerprinting
- [ ] First-party localStorage usage is limited to non-identifying functional purposes
- [ ] External fonts are not loaded (system fonts or bundled only)
- [ ] All static assets are self-hosted or bundled (no external CDNs for JS/CSS)
- [ ] HTTP response headers include relevant privacy headers:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: interest-cohort=()`

---

### 10. Data Processing Agreement Template

For team and enterprise customers who are data controllers, a DPA template must be available.

**GDPR Reference**: Art. 28(3) -- "Processing by a processor shall be governed by a contract... that sets out the subject-matter and duration of the processing..."

#### DPA Template Structure

```
DATA PROCESSING AGREEMENT

Between:
  Data Controller: {customer_name} ("Controller")
  Data Processor:  {company_name} ("Processor")

1. DEFINITIONS
   - Personal Data, Processing, Data Subject, Supervisory Authority
     (per GDPR Art. 4)

2. SCOPE AND PURPOSE
   - Subject matter: Encrypted storage and sync of coding session data
   - Duration: Term of the service agreement
   - Nature of processing: Storage, transmission, deletion of encrypted blobs
   - Type of personal data: See Data Inventory (Annex A)
   - Categories of data subjects: Controller's employees/contractors
     who use AgentContext

3. CONTROLLER OBLIGATIONS
   - Ensure lawful basis for processing
   - Provide instructions to Processor
   - Respond to data subject requests (with Processor assistance)

4. PROCESSOR OBLIGATIONS
   - Process only on Controller's documented instructions
   - Ensure confidentiality (personnel under obligation)
   - Implement Art. 32 security measures (Annex B)
   - Sub-processor controls (Annex C)
   - Assist Controller with data subject rights
   - Assist with DPIA if required
   - Delete or return data on termination
   - Make available audit information

5. SUB-PROCESSORS
   - Current list: Cloudflare, Inc. (Annex C)
   - Prior written consent for new sub-processors
   - 30-day objection period for new sub-processors
   - Sub-processor DPA flow-down requirements

6. INTERNATIONAL TRANSFERS
   - Standard Contractual Clauses (where applicable)
   - Cloudflare's EU data residency option
   - Transfer impact assessment

7. SECURITY MEASURES (Annex B)
   - Zero-knowledge encryption (server never has decryption keys)
   - XChaCha20-Poly1305 AEAD encryption
   - Per-user Durable Object isolation
   - R2 per-user key prefix isolation
   - JWT authentication with token rotation
   - Rate limiting and DDoS protection (Cloudflare)
   - No plaintext personal data stored on server

8. DATA BREACH NOTIFICATION
   - Processor notifies Controller within 48 hours of discovery
   - Notification includes breach details per Art. 33(3)
   - Processor assists Controller with breach obligations

9. DATA SUBJECT RIGHTS
   - Processor assists Controller in responding to requests
   - Technical capabilities: export (Art. 20), deletion (Art. 17)
   - Response timeline: within 15 business days

10. AUDIT RIGHTS
    - Controller may audit Processor's compliance annually
    - Processor provides SOC 2 Type II report as alternative
    - Cloudflare SOC 2 report available for sub-processor audit

11. TERM AND TERMINATION
    - DPA effective for duration of service agreement
    - On termination: delete all Controller data within 30 days
    - Provide export before deletion if requested

12. LIABILITY
    - Per main service agreement
    - Each party liable for its own GDPR violations

ANNEX A: DATA INVENTORY
  (Contents from Section 1 of this story)

ANNEX B: SECURITY MEASURES
  (Detailed technical controls)

ANNEX C: SUB-PROCESSOR LIST
  (Cloudflare details, DPA reference, data processed)

ANNEX D: STANDARD CONTRACTUAL CLAUSES
  (EU Commission approved SCCs, where applicable)
```

#### Acceptance Criteria

- [ ] DPA template covers all Art. 28(3) requirements
- [ ] Template includes annexes for data inventory, security measures, and sub-processors
- [ ] Standard Contractual Clauses are included for international transfers
- [ ] Template is available for download from the website and dashboard
- [ ] Template is versioned and updated when processing activities change
- [ ] Team and enterprise customers can sign the DPA electronically

---

### 11. Technical Implementation

GDPR compliance must be verified across all platform components through automated testing and regular audits.

#### Component Compliance Checklist

##### 11.1 Daemon (Local)

| Check | Requirement | How to Verify |
|-------|-------------|--------------|
| No phone-home | Daemon does not contact any server unless sync is enabled | Network traffic analysis |
| Local data stays local | Events are stored only in `~/.claude-context/` | File system audit |
| No telemetry | No usage data sent without consent | Code review + network analysis |
| Secure file permissions | Event store is 700, event files are 600 | `stat` check in `gc-query doctor` |
| No PII in logs | Daemon logs do not contain prompts or code | Log content audit |
| Consent check before sync | Sync client verifies consent before any upload | Unit test |

##### 11.2 Sync Server (Cloudflare Workers)

| Check | Requirement | How to Verify |
|-------|-------------|--------------|
| Metadata stripping | Only allowed fields pass through to storage | Unit test with extra fields |
| No plaintext PII in DO | Only email in KV, everything else anonymous | Schema audit |
| Deletion completeness | `DELETE /api/account` removes all user data | Integration test |
| Consent enforcement | Sync endpoints reject users without current consent | Middleware test |
| EU routing | EU users' DO and R2 use EU hints | Integration test |
| Rate limiting | Prevents abuse without storing user behavior | Config review |
| JWT expiry | Tokens expire, revocation works | Unit test |
| No logging of payloads | Worker does not log request/response bodies | Code review |

##### 11.3 Mobile App

| Check | Requirement | How to Verify |
|-------|-------------|--------------|
| Key in secure enclave | Master key stored in Keychain/Keystore | Platform API audit |
| No analytics SDK | No third-party analytics | Dependency audit |
| No crash reporting with PII | Crash reports do not include user data | Code review |
| Local decryption only | Encrypted data is decrypted on-device | Code review |
| Consent UI | Sync consent is explicit opt-in | UI test |
| Export function | User can export data from the app | Functional test |
| Deletion function | User can delete account from the app | Functional test |

##### 11.4 Desktop App (Tauri)

| Check | Requirement | How to Verify |
|-------|-------------|--------------|
| Key in OS keychain | Master key in Keychain/DPAPI/Secret Service | Platform API audit |
| No external requests | App does not contact any server except the sync server | Network audit |
| No auto-update telemetry | Update checks do not send user data | Code review |
| WebView sandboxed | Tauri WebView follows security best practices | Config audit |
| Same consent flow as mobile | Consistent consent experience | UI test |

#### Automated Compliance Tests

```typescript
// tests/gdpr/compliance.test.ts

describe('GDPR Compliance', () => {

  describe('F11.1 Data Minimization', () => {
    test('metadata contains no PII fields', async () => {
      const event = createTestEvent('ToolCallCompleted', {
        session_id: 'secret-session-123',
        prompt: 'Write sensitive code',
        tool_response: 'Here is your secret API key...',
      });

      const metadata = buildCleartextMetadata(event);

      // Verify no PII leaks
      expect(metadata).not.toHaveProperty('prompt');
      expect(metadata).not.toHaveProperty('tool_response');
      expect(metadata).not.toHaveProperty('session_id');
      expect(metadata.session_id_hash).not.toBe('secret-session-123');
      expect(metadata.session_id_hash).toHaveLength(16);
    });

    test('extra metadata fields are stripped by server', async () => {
      const response = await pushEvent({
        ...validMetadata,
        secret_field: 'should be stripped',
        prompt: 'should be stripped',
      });

      const stored = await getStoredMetadata(response.event_id);
      expect(stored).not.toHaveProperty('secret_field');
      expect(stored).not.toHaveProperty('prompt');
    });
  });

  describe('F11.2 Right to Erasure', () => {
    test('account deletion removes all data within 72 hours', async () => {
      // Setup: create account with sync data
      const { userId, jwt } = await createTestAccount();
      await pushTestEvents(jwt, 100);

      // Act: delete account
      const deleteResponse = await fetch('/api/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(deleteResponse.status).toBe(200);

      // Verify: all data removed
      // (in integration test, check R2, DO, and KV)
      await waitForDeletion(userId, { timeout: 72 * 60 * 60 * 1000 });

      const r2Objects = await listR2Objects(`users/${userId}/`);
      expect(r2Objects).toHaveLength(0);

      const doData = await queryDO(userId);
      expect(doData).toBeNull();

      const kvRecord = await env.KV.get(`users:${testEmail}`);
      expect(kvRecord).toBeNull();
    });

    test('deletion is idempotent', async () => {
      const { jwt } = await createTestAccount();

      await fetch('/api/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });

      // Second deletion should not error
      // (JWT is revoked, so this tests the revocation path)
      const secondResponse = await fetch('/api/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(secondResponse.status).toBe(401); // JWT revoked
    });
  });

  describe('F11.4 Consent Management', () => {
    test('sync endpoints reject users without consent', async () => {
      const { jwt } = await createAccountWithoutConsent();

      const pushResponse = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(testSyncPayload),
      });

      expect(pushResponse.status).toBe(403);
      const body = await pushResponse.json();
      expect(body.error).toBe('consent_required');
    });

    test('outdated consent version blocks sync', async () => {
      const { jwt } = await createAccountWithConsent('1.0.0');

      // Simulate consent version bump
      env.CONSENT_VERSION = '1.1.0';

      const pushResponse = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(testSyncPayload),
      });

      expect(pushResponse.status).toBe(403);
      const body = await pushResponse.json();
      expect(body.error).toBe('consent_version_outdated');
      expect(body.required_version).toBe('1.1.0');
    });
  });

  describe('F11.9 Cookie-Free', () => {
    test('no Set-Cookie headers in any response', async () => {
      const endpoints = [
        '/api/auth/login',
        '/api/auth/register',
        '/api/sync/push',
        '/api/account',
        '/api/account/export',
      ];

      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, { method: 'GET' });
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }
    });

    test('privacy headers are present', async () => {
      const response = await fetch('/api/health');

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Permissions-Policy')).toContain(
        'interest-cohort=()'
      );
    });
  });
});
```

#### Regular Audit Schedule

| Audit | Frequency | Responsible | Output |
|-------|-----------|-------------|--------|
| Metadata schema review | Every release | Engineering | Updated data inventory |
| Dependency audit (no analytics SDKs) | Monthly | Engineering | Clean dependency list |
| Privacy policy review | Quarterly | Legal + Engineering | Updated policy version |
| Consent text review | When processing changes | Legal | Updated consent version |
| Deletion completeness test | Monthly (automated) | CI/CD | Pass/fail report |
| EU residency verification | Weekly (automated) | CI/CD | Compliance report |
| Sub-processor list review | Quarterly | Legal | Updated list |
| Incident response drill | Annually | Engineering + Legal | Drill report |
| Full GDPR compliance audit | Annually | External auditor | Audit report |

#### Acceptance Criteria

- [ ] Component compliance checklist exists for daemon, sync server, mobile app, and desktop app
- [ ] Automated compliance tests cover data minimization, erasure, consent, and cookie-free design
- [ ] Automated tests run in CI/CD on every pull request
- [ ] Audit schedule is documented and followed
- [ ] Dependency audit confirms no analytics or tracking SDKs
- [ ] All compliance test failures block the release pipeline

---

## Edge Cases

### E-1: User Requests Erasure but Has Active Sync Sessions

**Scenario**: A user calls `DELETE /api/account` while their daemon is actively pushing sync events.

**Expected behavior**:
1. The account is immediately marked `pending_deletion` in KV
2. All JWTs are revoked, so subsequent push requests from the daemon receive `401 Unauthorized`
3. The daemon detects the revoked JWT and disables sync locally
4. The deletion flow proceeds as normal
5. Any in-flight push requests that arrive between JWT revocation and daemon awareness are rejected

**Risk**: A push request could arrive at the DO between the deletion initiation and the DO storage wipe. The DO should check the account status before processing any write.

---

### E-2: Partial Deletion Failure (R2 Delete Timeout)

**Scenario**: The R2 bucket has thousands of objects for a user. The batch delete operation times out or partially fails.

**Expected behavior**:
1. The DO tracks deletion progress in its SQLite store before clearing it
2. If R2 deletion is incomplete, the DO schedules a retry via Cloudflare Alarm
3. The alarm re-lists and re-deletes remaining objects
4. The deletion audit record is not marked "completed" until all R2 objects are confirmed deleted
5. Maximum retry window: 72 hours. If still incomplete, escalate to operations team

```typescript
// DO: deletion with retry
async function deleteAllR2Objects(userId: string): Promise<void> {
  const prefix = `users/${userId}/`;
  let cursor: string | undefined;

  do {
    const listed = await this.env.R2.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await this.env.R2.delete(listed.objects.map(o => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
```

---

### E-3: EU User Moves to Non-EU Country

**Scenario**: A user registered with EU residency preference moves to the US and wants to change their region.

**Expected behavior**:
1. User requests region change via settings
2. System displays consent update: "Your data may be transferred outside the EU"
3. User must explicitly re-consent to the new data processing terms
4. Data migration: existing R2 objects are copied from EU bucket to default bucket
5. DO location cannot be changed (Cloudflare limitation) -- a new DO is created and data is migrated
6. Old EU-located data is deleted after migration confirmation

---

### E-4: Consent Version Mismatch During Long Session

**Scenario**: A user is in the middle of a long coding session. The platform publishes a new consent version. The daemon attempts to sync.

**Expected behavior**:
1. The sync push receives `403 consent_version_outdated` from the server
2. The daemon queues the events locally (does not drop them)
3. The daemon logs a warning: "Sync paused: updated consent required"
4. On the next dashboard or CLI interaction, the user is prompted to review and accept the new consent
5. Once re-consent is given, the daemon resumes sync and pushes queued events

**Risk**: Events could queue indefinitely if the user never re-consents. The daemon should have a configurable max queue size (default: 10,000 events). Beyond that, oldest events are dropped from the sync queue (they remain in the local event store).

---

### E-5: Export of Very Large Account (10GB+)

**Scenario**: A Team tier user with 10GB of encrypted blobs requests a data export.

**Expected behavior**:
1. The export endpoint accepts the request and returns `processing` status
2. The Worker streams R2 objects into a ZIP archive incrementally
3. For very large exports (>1GB), the archive is split into multiple parts:
   - `agentcontext-export-2026-02-21-part001.zip`
   - `agentcontext-export-2026-02-21-part002.zip`
4. Each part has its own download URL and checksum
5. The manifest.json in part 1 lists all parts
6. Export generation has a 24-hour timeout. If not completed, it fails and the user is notified
7. Completed exports are available for 48 hours before being auto-deleted from the staging area

---

### E-6: GDPR Request from Non-User

**Scenario**: Someone claims to be a data subject and requests erasure, but their email is not in the system.

**Expected behavior**:
1. The request is processed through the standard channel (support email or API)
2. The system searches KV for the email
3. If not found, respond: "We have no data associated with this email address"
4. Log the request (without the email) for compliance records
5. Response within 30 days (GDPR Art. 12(3))

---

### E-7: Law Enforcement Request for User Data

**Scenario**: A law enforcement agency requests access to a user's session data.

**Expected behavior**:
1. The request is reviewed by legal counsel
2. Even if compelled, the server can only produce:
   - Account email
   - Anonymous metadata (event types, timestamps, token counts)
   - Encrypted blobs (unintelligible without the user's master key)
3. The server **cannot** produce decrypted event data because it has never possessed the key
4. This is documented in the privacy policy and communicated to the requesting agency
5. The user is notified of the request unless legally prohibited (gag order)

---

### E-8: Sub-Processor Change (New Service Added)

**Scenario**: The platform needs to add a new service provider (e.g., a payment processor for billing).

**Expected behavior**:
1. Update the sub-processor list with 30 days notice
2. Notify all registered users via email
3. Update the DPA template annexes
4. If the new sub-processor accesses personal data, increment the consent version
5. Users who object have the right to terminate their account (and receive data export)
6. Document the new sub-processor's DPA and security measures

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | `buildCleartextMetadata()` produces only allowed fields for all 10 event types |
| T-2 | `sanitizeMetadata()` strips unexpected fields from incoming push requests |
| T-3 | `session_id` is always hashed in cleartext metadata, never plaintext |
| T-4 | `DELETE /api/account` returns correct response format |
| T-5 | JWT revocation takes effect within 60 seconds of account deletion |
| T-6 | Export endpoint accepts date range filters and produces correct manifest |
| T-7 | Consent record is stored with version, timestamp, and text hash |
| T-8 | Consent withdrawal marks the record with `withdrawn_at` timestamp |
| T-9 | Sync endpoints return 403 when consent is missing or outdated |
| T-10 | Region detection correctly identifies EU/EEA countries |
| T-11 | No `Set-Cookie` header in any API response |
| T-12 | Privacy headers present in all API responses |

### Integration Tests

| Test | Description |
|------|-------------|
| T-13 | Full deletion flow: create account, push events, delete, verify all data gone |
| T-14 | Full export flow: create account, push events, export, download, verify archive |
| T-15 | Consent flow: register without consent, attempt sync (blocked), consent, sync (allowed) |
| T-16 | Consent withdrawal: consent, push events, withdraw, sync blocked, re-consent, sync resumes |
| T-17 | EU residency: register with EU flag, verify DO locationHint and R2 bucket |
| T-18 | Deletion idempotency: delete account twice, no errors on second call |
| T-19 | Export with empty account (no events), verify empty but valid archive |
| T-20 | Metadata stripping end-to-end: push event with extra fields, verify server stored only allowed fields |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Review privacy policy for plain language and completeness |
| M-2 | Verify DPA template covers all Art. 28(3) requirements (legal review) |
| M-3 | Verify breach notification templates are complete and accurate |
| M-4 | Run `agentctx export decrypt` on a real export archive and verify decrypted events |
| M-5 | Review consent text for GDPR Art. 7 compliance (clear, specific, informed) |
| M-6 | Verify no third-party scripts in web portal source (view page source) |
| M-7 | Verify no cookies set during full user journey (browser dev tools) |
| M-8 | Review Cloudflare DPA and confirm it is signed and current |

### Compliance Audit Tests (Automated, Monthly)

| Test | Description |
|------|-------------|
| A-1 | List all npm/cargo dependencies, verify none are analytics/tracking SDKs |
| A-2 | Scan all HTTP responses for `Set-Cookie` headers |
| A-3 | Verify deletion completes for test accounts within 72-hour window |
| A-4 | Verify EU R2 bucket contains only EU-flagged users' data |
| A-5 | Verify KV contains no plaintext PII beyond email |
| A-6 | Verify DO SQLite tables contain no plaintext PII |
| A-7 | Verify consent version in KV matches deployed consent version |

---

## Definition of Done

- [ ] Data inventory document lists every field the server stores, with PII classification (Section 1)
- [ ] Server-side metadata validation strips unexpected fields from incoming push requests
- [ ] Automated tests verify no PII leaks into cleartext metadata for all 10 event types
- [ ] `DELETE /api/account` endpoint fully implements the deletion flow with crypto-shredding
- [ ] Deletion completes within 72 hours, with audit logging (no PII in audit records)
- [ ] `POST /api/account/export` endpoint produces a valid ZIP archive of encrypted data
- [ ] Client-side `agentctx export decrypt` command decrypts exported archives
- [ ] Import command loads decrypted events into a local event store
- [ ] Consent management records opt-in with version, timestamp, and text hash
- [ ] Consent withdrawal stops sync and optionally triggers data deletion
- [ ] Consent version tracking pauses sync for users who have not re-consented
- [ ] Cloudflare DPA is signed and referenced in the privacy policy
- [ ] Sub-processor list is published and contains only Cloudflare
- [ ] EU users' DO uses `locationHint: 'eeur'` and R2 uses `jurisdiction: "eu"` bucket
- [ ] Periodic audit job verifies EU data residency compliance
- [ ] Breach notification plan, templates, and timeline are documented
- [ ] Privacy policy is written in plain language with all 13 required sections
- [ ] Privacy policy is versioned with changelog and accessible from all clients
- [ ] No cookies set by any component (verified by automated test)
- [ ] No third-party scripts loaded by any client application
- [ ] JWT-based auth with no session cookies
- [ ] Privacy headers (`X-Frame-Options`, `Referrer-Policy`, etc.) set on all responses
- [ ] DPA template available for team/enterprise customers with all Art. 28(3) requirements
- [ ] Component compliance checklists exist for daemon, sync server, mobile app, and desktop app
- [ ] Automated GDPR compliance tests run in CI/CD and block release on failure
- [ ] Audit schedule is documented and integrated into operations calendar
- [ ] All 20 integration test cases pass
- [ ] All 7 monthly compliance audit tests pass
- [ ] Legal review of privacy policy, DPA template, and breach notification plan is scheduled
