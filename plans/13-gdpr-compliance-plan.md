# Implementation Plan: Story 13 -- GDPR Compliance

**Date**: 2026-02-22
**Story**: 19-gdpr-compliance
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Story 11 (Sync Server) must be architecturally stable. Story 12 (Security & Encryption) must define the XChaCha20-Poly1305 encryption primitives and key management interfaces. Story 07 (Encrypted Cloud Sync) must define the cleartext metadata vs encrypted blob split.
**GDPR Articles Referenced**: Art. 5, 6, 7, 12-14, 15, 17, 20, 25, 28, 30, 32, 33, 34, 44-49

### Relationship to Other Stories

This is a **cross-cutting compliance story** that formalizes, audits, and extends the privacy guarantees provided by other stories. It does not build the encryption or sync systems -- those are prerequisites -- but it adds the GDPR-specific enforcement layer, documentation, APIs, and tests.

- **Story 07** (Encrypted Cloud Sync): Defines the cleartext metadata vs encrypted blob split. This plan enforces metadata minimization on that split and adds the `sanitizeMetadata()` server-side validation.
- **Story 11** (Sync Server): Provides the Worker + DO + R2 infrastructure. This plan adds the `DELETE /api/account` endpoint, `POST /api/account/export` endpoint, consent middleware, EU routing, and privacy headers.
- **Story 12** (Security & Encryption): Provides XChaCha20-Poly1305 encryption, key management, and Argon2id KDF. This plan relies on these primitives for crypto-shredding guarantees and client-side export decryption.
- **Story 08** (Mobile App): Must integrate consent UI, data export, account deletion, and cookie-free design.
- **Story 09** (Desktop App): Must integrate consent UI and cookie-free design.
- **Story 06** (Local Dashboard): Must integrate privacy headers and cookie-free design.

### Platform Evaluation References

From `/home/meywd/GlobalContext/docs/PLATFORM-EVALUATION.md`:

- **Section 5.1**: Encrypted data is still personal data under GDPR (pseudonymized, not anonymized). Storage alone counts as "processing." However, zero-knowledge architecture reduces practical obligations.
- **Section 5.2**: Crypto-shredding satisfies Art. 17 when encryption is strong and key is truly destroyed. DO `deleteAll()` wipes SQLite, R2 objects deleted by prefix, KV entries deleted.
- **Section 5.3**: EU data residency via `jurisdiction("eu")` on DO namespace and R2 bucket jurisdiction. Caveat: logs/billing metadata may be processed outside EU.
- **Section 5.4**: Client-side encryption inherently satisfies data portability (Art. 20). Server exports encrypted blobs; client decrypts.
- **Architecture decision**: DO-only with optional R2 for exports/overflow. This affects deletion flow (primary data in DO SQLite, not R2).

---

## Task Dependency Graph

```
Task 1: Data Inventory & PII Classification
  |
  +---> Task 2: Metadata Sanitization (server-side)
  |       |
  |       +---> Task 3: PII Leak Prevention (client-side)
  |
  +---> Task 4: Right to Erasure API & Crypto-Shredding
  |       |
  |       +---> Task 5: Deletion Audit Log
  |
  +---> Task 6: Data Portability Export API
  |       |
  |       +---> Task 7: Client-Side Export Decryption & Import
  |
  +---> Task 8: Consent Management System
  |       |
  |       +---> Task 9: Consent Middleware & Version Tracking
  |
  +---> Task 10: EU Data Residency Enforcement
  |
  +---> Task 11: Privacy Headers & Cookie-Free Enforcement
  |
  +---> Task 12: Privacy Policy Document & Versioning
  |
  +---> Task 13: Breach Notification Plan & Templates
  |
  +---> Task 14: DPA Template for Team/Enterprise
  |
  +---> Task 15: Automated GDPR Compliance Test Suite
  |       (needs Tasks 2-11 implemented)
  |
  +---> Task 16: Component Compliance Checklists & Audit Schedule
          (needs all tasks)
```

---

## Tasks

### Task 1: Data Inventory & PII Classification

**Description**

Create a formal, versioned data inventory document that catalogs every field the sync server stores, classifies each field by PII status, and maps it to the GDPR lawful basis for processing. This document is the foundation for all subsequent GDPR tasks: metadata sanitization references it, the privacy policy incorporates it, and the DPA template annexes it.

**Prerequisites/Inputs**

- Story 07 sync metadata schema (cleartext metadata fields)
- Story 11 KV account record schema
- Story 12 encrypted blob schema
- Platform Evaluation Section 5.1 (encrypted data = pseudonymized personal data)

**Implementation Details**

File to create: `docs/gdpr/DATA-INVENTORY.md`

The document must contain three tables matching the story spec:

1. **Server-Side Cleartext Metadata (DO SQLite)** -- 11 fields:

```markdown
| Field | Type | Purpose | Contains PII? | Lawful Basis |
|-------|------|---------|---------------|--------------|
| machine_id | string | Device identification for sync routing | No (derived hash) | Legitimate interest (Art. 6(1)(f)) |
| project_id | string | Project grouping for sync | No (derived hash) | Legitimate interest |
| session_id_hash | string | Session correlation | No (truncated SHA-256, irreversible) | Legitimate interest |
| sequence | integer | Event ordering | No | Legitimate interest |
| event_type | string | Event classification | No | Legitimate interest |
| timestamp | ISO 8601 | Event ordering and retention | No | Legitimate interest |
| input_tokens | integer | Usage metering and billing | No | Contract (Art. 6(1)(b)) |
| output_tokens | integer | Usage metering and billing | No | Contract |
| cache_read_tokens | integer | Usage metering | No | Contract |
| model | string | Usage analytics | No | Legitimate interest |
| r2_key | string | Pointer to encrypted blob | No | Legitimate interest |
```

2. **Account Data (KV)** -- 7 fields, with `email` flagged as PII and `userId` as pseudonymous.

3. **Encrypted Data (R2/DO blobs)** -- list of all data types encrypted inside blobs (session IDs, prompts, responses, tool I/O, file contents, project names, machine names, decision rationale).

The document must also include:
- A version number and changelog section
- A "Data Flow Diagram" section (ASCII art showing encryption boundaries)
- A "Retention Schedule" section per tier (Free: 30 days, Pro: 1 year, Team: unlimited)

**Acceptance Criteria**

- [ ] `docs/gdpr/DATA-INVENTORY.md` exists with all three tables
- [ ] Every field the server stores is listed with PII classification
- [ ] Lawful basis (Art. 6) is specified for each field
- [ ] Data flow diagram shows encryption boundaries between client and server
- [ ] Retention schedule per tier is documented
- [ ] Document is versioned with a changelog section
- [ ] Document explicitly states that encrypted data is pseudonymized (not anonymized) under GDPR

**Edge Cases**

- New metadata fields added in future stories must trigger a data inventory update. The document must note this requirement.
- If the platform evaluation's DO-only architecture is adopted (no R2 for primary storage), the `r2_key` field references overflow/export blobs only. Document this distinction.

**Estimated Effort**: S (Small) -- 2-3 hours. Documentation task with specific schema references.

---

### Task 2: Metadata Sanitization (Server-Side)

**Description**

Implement server-side validation in the Cloudflare Worker that strips any unexpected fields from incoming sync push metadata before passing it to the Durable Object for storage. This is the last line of defense against PII leaking into cleartext metadata. Even if the client-side code has a bug, the server must never store fields outside the allowed set.

**Prerequisites/Inputs**

- Task 1 (Data Inventory defines the allowed field set)
- Story 11 Worker API layer (push endpoint)

**Implementation Details**

File to create/modify: `src/worker/middleware/sanitize-metadata.ts` (new file within the sync server Worker)

```typescript
// Allowed cleartext metadata fields -- derived from Data Inventory (Task 1)
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

// Type validators for each field
const FIELD_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  machine_id: (v) => typeof v === 'string' && v.length <= 64,
  project_id: (v) => typeof v === 'string' && v.length <= 64,
  session_id_hash: (v) => typeof v === 'string' && v.length === 16,
  sequence: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  event_type: (v) => typeof v === 'string' && VALID_EVENT_TYPES.has(v as string),
  timestamp: (v) => typeof v === 'string' && !isNaN(Date.parse(v as string)),
  input_tokens: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  output_tokens: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  cache_read_tokens: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  model: (v) => typeof v === 'string' && v.length <= 64,
  r2_key: (v) => typeof v === 'string' && v.length <= 256,
};

const VALID_EVENT_TYPES = new Set([
  'SessionStarted', 'UserPromptReceived', 'ToolCallRequested',
  'ToolCallCompleted', 'ToolCallFailed', 'AgentSpawned',
  'AgentCompleted', 'TurnCompleted', 'CompactionTriggered', 'SessionEnded',
]);

export function sanitizeMetadata(
  meta: Record<string, unknown>
): { sanitized: Record<string, unknown>; stripped: string[] } {
  const sanitized: Record<string, unknown> = {};
  const stripped: string[] = [];

  // Copy only allowed fields
  for (const key of ALLOWED_METADATA_FIELDS) {
    if (key in meta) {
      const validator = FIELD_VALIDATORS[key];
      if (validator && validator(meta[key])) {
        sanitized[key] = meta[key];
      } else {
        stripped.push(`${key}(invalid)`);
      }
    }
  }

  // Track stripped fields for logging (field names only, not values)
  for (const key of Object.keys(meta)) {
    if (!ALLOWED_METADATA_FIELDS.has(key)) {
      stripped.push(key);
    }
  }

  return { sanitized, stripped };
}
```

Integration point: The Worker's `POST /api/sync/push` handler must call `sanitizeMetadata()` before forwarding to the DO. If any fields are stripped, log the field names (never values) for monitoring.

**Acceptance Criteria**

- [ ] `sanitizeMetadata()` function exists and is called on every push request
- [ ] Only the 11 allowed fields pass through; all others are stripped
- [ ] Each allowed field is type-validated (string length, integer range, valid event type, valid timestamp)
- [ ] `session_id_hash` must be exactly 16 characters (truncated SHA-256)
- [ ] Stripped field names are logged for monitoring (values are never logged)
- [ ] Invalid field values for allowed fields are also stripped (e.g., `sequence: "not-a-number"`)
- [ ] Automated tests verify sanitization for all 10 event types with extra fields injected

**Edge Cases**

- A malicious client sends a metadata object with 1000 fields: only 11 pass through, 989 are stripped.
- A client sends `session_id` (not `session_id_hash`): stripped, logged as a potential PII leak.
- A client sends `prompt` or `response` in cleartext metadata: stripped, logged as a critical PII leak.
- Empty metadata object: returns empty sanitized object (the DO handles missing required fields).

**Estimated Effort**: M (Medium) -- 3-4 hours. Includes function, type validators, and unit tests.

---

### Task 3: PII Leak Prevention (Client-Side)

**Description**

Implement the daemon's sync client metadata builder that constructs cleartext metadata from event envelopes, ensuring no PII ever enters the cleartext channel. This is the first line of defense. The server sanitizer (Task 2) is the second.

**Prerequisites/Inputs**

- Task 1 (Data Inventory defines which fields are cleartext)
- Story 07 sync client (push flow)
- Story 01 event envelope schema

**Implementation Details**

File to create/modify: `src/daemon/sync/build-metadata.ts` (or equivalent in the daemon's sync client module)

```typescript
import { createHash } from 'crypto';

interface EventEnvelope {
  session_id: string;
  event_type: string;
  timestamp: string;
  sequence: number;
  project_id: string;  // already a derived hash (basename-hash6)
  data: Record<string, unknown>;  // contains PII -- NEVER include in metadata
}

interface SyncMetadata {
  machine_id: string;
  project_id: string;
  session_id_hash: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  model: string;
  r2_key: string;
}

function deriveMachineId(): string {
  // Returns a hash-based machine identifier, e.g., "macbook-a3f7b2"
  // Implementation from Story 07 -- hostname hashed, not raw
  const hostname = os.hostname();
  const hash = createHash('sha256').update(hostname).digest('hex').substring(0, 6);
  const basename = hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${basename}-${hash}`;
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
}

function extractTokenCount(event: EventEnvelope, field: string): number {
  const usage = event.data?.usage as Record<string, number> | undefined;
  return usage?.[`${field}_tokens`] ?? 0;
}

function extractModel(event: EventEnvelope): string {
  return (event.data?.model as string) ?? 'unknown';
}

export function buildCleartextMetadata(event: EventEnvelope): SyncMetadata {
  return {
    machine_id: deriveMachineId(),
    project_id: event.project_id,                    // already a hash
    session_id_hash: hashSessionId(event.session_id), // 16-char truncated SHA-256
    sequence: event.sequence,
    event_type: event.event_type,
    timestamp: event.timestamp,
    input_tokens: extractTokenCount(event, 'input'),
    output_tokens: extractTokenCount(event, 'output'),
    cache_read_tokens: extractTokenCount(event, 'cache_read'),
    model: extractModel(event),
    r2_key: `users/${userId}/events/${deriveMachineId()}/${event.project_id}/${hashSessionId(event.session_id)}/${String(event.sequence).padStart(6, '0')}.enc`,
  };
  // NEVER include: prompt, response, tool_input, tool_output, file_path,
  //                file_content, session_id (unhashed), hostname (raw)
}
```

A static analysis rule (or test) must verify that `buildCleartextMetadata()` does not access `event.data` except through the approved extractor functions (`extractTokenCount`, `extractModel`).

**Acceptance Criteria**

- [ ] `buildCleartextMetadata()` returns only the 11 allowed fields
- [ ] `session_id` is always hashed to a 16-character truncated SHA-256
- [ ] `machine_id` is a derived hash, never the raw hostname
- [ ] `project_id` is passed through unchanged (already a hash from Story 03)
- [ ] The function never reads `event.data.prompt`, `event.data.response`, `event.data.tool_input`, or `event.data.tool_output`
- [ ] Automated tests verify metadata output for all 10 event types, confirming no PII is present
- [ ] A test injects PII into the event envelope and verifies it does not appear in the metadata

**Edge Cases**

- Event with no usage data: token counts default to 0, model defaults to "unknown".
- Event with no `session_id`: function should throw or return an error (session_id is required for hashing).
- Event with Unicode characters in session_id: SHA-256 handles UTF-8 natively; hash is still 16 hex chars.

**Estimated Effort**: M (Medium) -- 3-4 hours. Includes function, tests for all 10 event types.

---

### Task 4: Right to Erasure API & Crypto-Shredding

**Description**

Implement the `DELETE /api/account` endpoint in the Cloudflare Worker that orchestrates the full account deletion flow: JWT revocation, account status update, DO storage wipe, R2 blob deletion, KV record cleanup, and deletion audit logging. This is the most critical GDPR task -- it must be correct, idempotent, and complete within 72 hours.

**Prerequisites/Inputs**

- Story 11 (Worker API layer, DO class, KV namespace, R2 bucket bindings)
- Story 12 (crypto-shredding relies on encryption key being client-only)
- Platform Evaluation Section 5.2 (crypto-shredding flow)
- Task 1 (Data Inventory -- what to delete)

**Implementation Details**

Files to create/modify:

1. `src/worker/routes/account-delete.ts` -- endpoint handler
2. `src/worker/do/deletion.ts` -- DO deletion logic with retry
3. `src/worker/lib/deletion-audit.ts` -- audit record creation

**Endpoint Handler** (`account-delete.ts`):

```typescript
export async function handleAccountDelete(
  request: Request,
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  const deletionId = crypto.randomUUID();

  // 1. Mark account as pending_deletion in KV (immediate)
  await env.KV.put(`users:${userEmail}`, JSON.stringify({
    status: 'pending_deletion',
    deletion_id: deletionId,
    requested_at: new Date().toISOString(),
  }));

  // 2. Revoke all JWTs by adding userId to revocation list
  await env.KV.put(`revoked:${userId}`, 'true', {
    expirationTtl: 86400 * 30, // 30 days (longer than any JWT lifetime)
  });

  // 3. Send deletion command to user's Durable Object
  const doId = env.USER_SYNC.idFromName(userId);
  const doStub = env.USER_SYNC.get(doId);
  await doStub.fetch(new Request('https://internal/delete', {
    method: 'POST',
    body: JSON.stringify({ deletion_id: deletionId, user_id: userId }),
  }));

  // 4. Schedule KV cleanup (email, sessions)
  // Done after DO confirms deletion or via alarm
  await cleanupKVRecords(env, userId, userEmail, deletionId);

  // 5. Create deletion audit record
  await createDeletionAuditRecord(env, {
    deletion_id: deletionId,
    requested_at: new Date().toISOString(),
    user_email_hash: hashEmail(userEmail),
  });

  return new Response(JSON.stringify({
    status: 'deletion_initiated',
    deletion_id: deletionId,
    estimated_completion: estimateCompletionTime(),
    what_will_be_deleted: [
      'account_record',
      'all_encrypted_event_blobs',
      'all_metadata_records',
      'all_machine_registrations',
      'all_sync_cursors',
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function hashEmail(email: string): string {
  // Truncated SHA-256 -- irreversible, for dedup only
  return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16);
}

function estimateCompletionTime(): string {
  const estimate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  return estimate.toISOString();
}
```

**DO Deletion Logic** (`deletion.ts`):

```typescript
// Inside the Durable Object class
async deleteAllUserData(deletionId: string, userId: string): Promise<void> {
  // 1. Delete all R2 objects under user prefix (paginated)
  const prefix = `users/${userId}/`;
  let cursor: string | undefined;
  let totalDeleted = 0;

  do {
    const listed = await this.env.R2.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await this.env.R2.delete(listed.objects.map(o => o.key));
      totalDeleted += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 2. Also check EU R2 bucket if applicable
  if (this.env.R2_EU) {
    cursor = undefined;
    do {
      const listed = await this.env.R2_EU.list({ prefix, cursor, limit: 1000 });
      if (listed.objects.length > 0) {
        await this.env.R2_EU.delete(listed.objects.map(o => o.key));
        totalDeleted += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  // 3. Drop all SQLite tables
  this.ctx.storage.sql.exec('DROP TABLE IF EXISTS machines');
  this.ctx.storage.sql.exec('DROP TABLE IF EXISTS events_meta');
  this.ctx.storage.sql.exec('DROP TABLE IF EXISTS sync_cursors');

  // 4. Delete all DO storage
  await this.ctx.storage.deleteAll();

  // 5. Log completion (to deletion audit, not to DO storage which is now gone)
  // Completion is signaled back to the Worker via response
}

// Alarm-based retry for partial R2 deletion failures
async alarm(): Promise<void> {
  const pending = await this.ctx.storage.get<DeletionState>('pending_deletion');
  if (pending) {
    try {
      await this.deleteAllUserData(pending.deletion_id, pending.user_id);
    } catch (e) {
      // Retry: schedule another alarm (max 72 hours from original request)
      const elapsed = Date.now() - new Date(pending.requested_at).getTime();
      if (elapsed < 72 * 60 * 60 * 1000) {
        this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000); // retry in 1 hour
      } else {
        // Escalate: 72-hour limit exceeded
        // Log to operations alert channel
      }
    }
  }
}
```

**KV Cleanup** function:

```typescript
async function cleanupKVRecords(
  env: Env, userId: string, userEmail: string, deletionId: string
): Promise<void> {
  // Delete user account record
  await env.KV.delete(`users:${userEmail}`);

  // Delete all session tokens for this user
  // (KV list by prefix is not available, so we rely on JWT revocation + TTL expiry)
  // The revocation entry ensures rejected auth; tokens expire naturally.

  // Note: email is NOT stored in the audit record -- only the hash
}
```

**Acceptance Criteria**

- [ ] `DELETE /api/account` endpoint exists and requires valid JWT
- [ ] Account is immediately marked as `pending_deletion` in KV
- [ ] All JWTs for the user are revoked (revocation list in KV)
- [ ] All R2 objects under the user's prefix are deleted (both default and EU buckets)
- [ ] All DO SQLite tables are dropped and DO storage is cleared via `deleteAll()`
- [ ] All KV records for the user are deleted (account record, sessions expire via TTL)
- [ ] A deletion audit record is created without storing PII (email is hashed to 16 chars)
- [ ] Full erasure completes within 72 hours (alarm-based retry for partial failures)
- [ ] Re-registration with the same email creates a completely fresh account (new userId)
- [ ] The deletion flow is idempotent (calling DELETE twice returns success, second call is a no-op)
- [ ] Deletion works even if the user has no sync data (fresh account with no events)
- [ ] In-flight push requests during deletion receive 401 (JWT revoked)

**Edge Cases**

- **E-1**: User has active sync sessions during deletion. JWT revocation causes 401 on subsequent pushes. The DO should check account status before processing writes.
- **E-2**: R2 deletion of 100K+ objects times out. Alarm-based retry paginates through remaining objects. Deletion is not marked complete until all objects are confirmed gone.
- **E-5 variant**: User with 10GB+ in DO SQLite. `deleteAll()` handles this atomically within the DO.
- Second DELETE request after JWT revocation returns 401 (token revoked). This is correct behavior -- the first request already initiated deletion.

**Estimated Effort**: XL (Extra Large) -- 10-14 hours. Most complex task: multi-system coordination, retry logic, idempotency, extensive edge cases.

---

### Task 5: Deletion Audit Log

**Description**

Create the deletion audit subsystem that records account deletions without storing any PII. The audit log proves compliance with Art. 17 ("without undue delay") by recording timestamps and object counts. It uses a separate KV namespace (`deletion_log`) to ensure audit records survive account deletion.

**Prerequisites/Inputs**

- Task 4 (deletion flow produces the audit data)
- Story 11 KV namespace bindings

**Implementation Details**

File to create: `src/worker/lib/deletion-audit.ts`

```typescript
interface DeletionAuditRecord {
  deletion_id: string;           // UUID for this deletion request
  requested_at: string;          // ISO 8601 timestamp
  completed_at: string | null;   // null until fully complete
  r2_objects_deleted: number;    // count of encrypted blobs deleted
  do_storage_cleared: boolean;   // true when DO deleteAll() succeeds
  kv_records_deleted: number;    // count of KV keys deleted
  user_email_hash: string;       // sha256(email)[:16] -- irreversible, for dedup
}

export async function createDeletionAuditRecord(
  env: Env,
  data: Partial<DeletionAuditRecord>
): Promise<void> {
  const record: DeletionAuditRecord = {
    deletion_id: data.deletion_id!,
    requested_at: data.requested_at!,
    completed_at: null,
    r2_objects_deleted: 0,
    do_storage_cleared: false,
    kv_records_deleted: 0,
    user_email_hash: data.user_email_hash!,
  };

  await env.DELETION_LOG.put(
    `deletion:${record.deletion_id}`,
    JSON.stringify(record),
    { expirationTtl: 365 * 24 * 60 * 60 } // retain audit for 1 year
  );
}

export async function completeDeletionAuditRecord(
  env: Env,
  deletionId: string,
  stats: { r2_objects_deleted: number; do_storage_cleared: boolean; kv_records_deleted: number }
): Promise<void> {
  const existing = await env.DELETION_LOG.get(`deletion:${deletionId}`);
  if (!existing) return;

  const record: DeletionAuditRecord = JSON.parse(existing);
  record.completed_at = new Date().toISOString();
  record.r2_objects_deleted = stats.r2_objects_deleted;
  record.do_storage_cleared = stats.do_storage_cleared;
  record.kv_records_deleted = stats.kv_records_deleted;

  await env.DELETION_LOG.put(
    `deletion:${deletionId}`,
    JSON.stringify(record),
    { expirationTtl: 365 * 24 * 60 * 60 }
  );
}

export async function isDeletionAlreadyRequested(
  env: Env,
  emailHash: string
): Promise<boolean> {
  // List recent deletions and check for email hash match
  // Used to handle duplicate deletion requests gracefully
  const list = await env.DELETION_LOG.list({ prefix: 'deletion:' });
  for (const key of list.keys) {
    const record = await env.DELETION_LOG.get(key.name);
    if (record) {
      const parsed: DeletionAuditRecord = JSON.parse(record);
      if (parsed.user_email_hash === emailHash) return true;
    }
  }
  return false;
}
```

**KV Namespace**: A dedicated `DELETION_LOG` KV namespace binding in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DELETION_LOG"
id = "<deletion-log-namespace-id>"
```

**Acceptance Criteria**

- [ ] Deletion audit records are stored in a separate `DELETION_LOG` KV namespace
- [ ] Audit records contain no PII (email is stored as truncated SHA-256 hash only)
- [ ] `deletion_id`, `requested_at`, and `completed_at` timestamps are recorded
- [ ] Object counts (R2, DO, KV) are recorded for compliance reporting
- [ ] Audit records have a 1-year TTL (sufficient for regulatory audit periods)
- [ ] Duplicate deletion requests for the same email hash are detectable
- [ ] `completeDeletionAuditRecord()` is called only when all deletions are confirmed

**Edge Cases**

- KV write fails during audit record creation: the deletion proceeds anyway (audit failure should not block erasure). Log the failure for manual follow-up.
- Very large number of audit records: KV list pagination handles this. Consider a secondary index by date for compliance reporting.

**Estimated Effort**: S (Small) -- 2-3 hours. Straightforward KV operations with defined schema.

---

### Task 6: Data Portability Export API

**Description**

Implement the `POST /api/account/export` endpoint that generates a ZIP archive of the user's encrypted data and cleartext metadata. The export is asynchronous: the endpoint returns a job ID, and the client polls for completion. The download URL uses a single-use token that expires after 24 hours.

**Prerequisites/Inputs**

- Story 11 (Worker API, DO, R2 bindings)
- Task 1 (Data Inventory defines what to export)
- Platform Evaluation Section 5.4 (client-side decryption for portability)

**Implementation Details**

Files to create:

1. `src/worker/routes/account-export.ts` -- endpoint handler (initiate + poll + download)
2. `src/worker/do/export.ts` -- DO export generation logic

**Endpoint: Initiate Export** (`POST /api/account/export`):

```typescript
export async function handleExportRequest(
  request: Request,
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  const body = await request.json() as ExportRequest;
  const exportId = `exp-${crypto.randomUUID()}`;

  // Validate request
  const format = body.format || 'json';
  const dateRange = body.date_range || null;

  // Store export job in DO
  const doId = env.USER_SYNC.idFromName(userId);
  const doStub = env.USER_SYNC.get(doId);
  const result = await doStub.fetch(new Request('https://internal/export/start', {
    method: 'POST',
    body: JSON.stringify({
      export_id: exportId,
      user_id: userId,
      email: userEmail,
      format,
      date_range: dateRange,
      include_metadata: body.include_metadata ?? true,
    }),
  }));

  const estimatedSize = await result.json() as { estimated_size_bytes: number };

  return new Response(JSON.stringify({
    export_id: exportId,
    status: 'processing',
    estimated_size_bytes: estimatedSize.estimated_size_bytes,
    poll_url: `/api/account/export/${exportId}`,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}
```

**Endpoint: Poll Status** (`GET /api/account/export/:exportId`):

```typescript
// Returns { status: "processing" | "ready" | "failed", ... }
// When ready, includes download_url and single-use download_token
```

**Endpoint: Download** (`GET /api/account/export/:exportId/download?token=<single-use-token>`):

```typescript
// Validates single-use token, streams ZIP from R2 staging area, invalidates token
```

**DO Export Logic** (`export.ts`):

The DO generates the export archive by:

1. Querying SQLite for all events_meta within the date range
2. Fetching corresponding encrypted blobs from R2 (or DO storage)
3. Building the ZIP structure per the story spec:
   - `manifest.json` -- archive metadata
   - `metadata/account.json` -- cleartext account info
   - `metadata/machines.json` -- machine registry
   - `metadata/events_meta.json` -- all cleartext metadata
   - `events/{machine-id}/{project-id}/{session-id-hash}/NNNNNN.enc` -- encrypted blobs
   - `README.txt` -- decryption instructions
4. Writing the completed ZIP to R2 staging area
5. Generating a single-use download token (stored in KV with 24h TTL)
6. Computing SHA-256 checksum of the archive

**ZIP Archive Structure** (from story spec):

```
agentcontext-export-YYYY-MM-DD.zip
+-- manifest.json
+-- metadata/
|   +-- account.json
|   +-- machines.json
|   +-- events_meta.json
+-- events/
|   +-- {machine-id}/
|       +-- {project-id}/
|           +-- {session-id-hash}/
|               +-- 000001.enc
|               +-- 000002.enc
+-- README.txt
```

**manifest.json**:

```json
{
  "export_version": "1.0.0",
  "format": "agentcontext-export",
  "created_at": "2026-02-22T14:30:00Z",
  "encryption": {
    "algorithm": "XChaCha20-Poly1305",
    "key_derivation": "user_master_key",
    "note": "Decrypt each .enc file using your master key. Nonce is prepended to each ciphertext."
  },
  "event_count": 4523,
  "machine_count": 2,
  "project_count": 7,
  "date_range": { "from": "...", "to": "..." },
  "checksum_sha256": "..."
}
```

For large exports (>1GB), the archive is split into numbered parts, each with its own download URL and checksum. The manifest in part 1 lists all parts.

**Acceptance Criteria**

- [ ] `POST /api/account/export` endpoint exists and requires valid JWT
- [ ] Export is processed asynchronously with a poll URL for status
- [ ] The export archive is a ZIP containing encrypted blobs and cleartext metadata
- [ ] `manifest.json` describes the archive format, encryption, and contents
- [ ] The download URL uses a single-use token that expires after 24 hours
- [ ] Export respects date range filters (from/to)
- [ ] Export includes a `README.txt` with decryption instructions
- [ ] Export checksum (SHA-256) is provided for integrity verification
- [ ] Large exports (>1GB) are split into multiple parts
- [ ] Export generation has a 24-hour timeout; incomplete exports fail with notification
- [ ] Completed exports are auto-deleted from R2 staging after 48 hours

**Edge Cases**

- **E-5**: 10GB+ account export. Stream R2 objects incrementally into ZIP parts. Each part capped at 1GB. The manifest in part 1 lists all parts with checksums.
- Empty account (no events): produces a valid ZIP with manifest and empty events directory.
- Export requested while deletion is pending: return 409 Conflict.
- Multiple concurrent export requests: only one active export at a time per user (return 429 if already processing).

**Estimated Effort**: XL (Extra Large) -- 12-16 hours. Async job processing, ZIP generation, streaming, multi-part splits, download token management.

---

### Task 7: Client-Side Export Decryption & Import

**Description**

Implement the CLI commands for decrypting an exported archive and importing decrypted events into a local event store. These commands run entirely on the client -- no server interaction required.

**Prerequisites/Inputs**

- Task 6 (export archive format)
- Story 12 (XChaCha20-Poly1305 decryption, master key from OS keychain)
- Story 05 (local event store structure for import)

**Implementation Details**

Files to create:

1. `src/cli/commands/export-decrypt.ts` -- decrypt command
2. `src/cli/commands/import.ts` -- import command

**Decrypt Command** (`agentctx export decrypt`):

```bash
agentctx export decrypt --input agentcontext-export-2026-02-22.zip --output ./decrypted/
```

Logic:
1. Read master key from OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service)
2. Extract ZIP archive to temp directory
3. Read `manifest.json` to verify format version and encryption algorithm
4. Iterate over all `.enc` files in `events/` directory tree
5. For each `.enc` file:
   a. Read raw bytes
   b. Extract 24-byte nonce from the beginning of the ciphertext
   c. Decrypt remainder with XChaCha20-Poly1305 using master key and extracted nonce
   d. Parse decrypted bytes as JSON
   e. Write JSON to output directory, preserving the directory structure but with `.json` extension
6. Copy `metadata/` directory to output as-is (already cleartext)
7. Print summary: events decrypted, failures, output path

```typescript
import sodium from 'libsodium-wrappers';

async function decryptFile(
  encryptedData: Uint8Array,
  masterKey: Uint8Array
): Promise<string> {
  await sodium.ready;

  const NONCE_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; // 24
  const nonce = encryptedData.slice(0, NONCE_LENGTH);
  const ciphertext = encryptedData.slice(NONCE_LENGTH);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, // nsec (unused)
    ciphertext,
    null, // ad (additional data, none)
    nonce,
    masterKey
  );

  return new TextDecoder().decode(plaintext);
}
```

**Import Command** (`agentctx import`):

```bash
agentctx import --input ./decrypted/ --target ~/.claude-context/events/
```

Logic:
1. Read decrypted event JSON files from the input directory
2. For each event file:
   a. Parse JSON to validate event envelope schema
   b. Derive `project_id` and `session_id` from the event data
   c. Create the target directory: `$target/events/{project-id}/{session-id}/`
   d. Write the event file with the correct sequence-based filename
3. Rebuild projections for imported events (delegate to Story 04 projection engine)
4. Print summary: events imported, projects created, sessions created

**Acceptance Criteria**

- [ ] `agentctx export decrypt` command decrypts all `.enc` files using the master key from OS keychain
- [ ] Decrypted events are valid JSON matching the event envelope schema
- [ ] Directory structure is preserved in the decrypted output
- [ ] `manifest.json` is validated before decryption (format version, encryption algorithm)
- [ ] SHA-256 checksum of the archive is verified before extraction
- [ ] `agentctx import` writes decrypted events to the local event store
- [ ] Import creates proper `{project-id}/{session-id}/` directory structure
- [ ] Import rebuilds projections for imported events
- [ ] Both commands provide clear progress output and error messages
- [ ] Decryption failures for individual files are reported but do not abort the entire process

**Edge Cases**

- Wrong master key: decryption fails with authentication error (Poly1305 tag mismatch). Report clearly: "Decryption failed. Are you using the correct master key?"
- Multi-part export: user must provide all parts. Verify all parts are present before starting decryption.
- Corrupted `.enc` file: skip with warning, continue with remaining files.
- Import into a store that already has some of the same events: skip duplicates (based on project-id + session-id + sequence).

**Estimated Effort**: L (Large) -- 6-8 hours. Two commands, cryptographic operations, file I/O, error handling.

---

### Task 8: Consent Management System

**Description**

Implement the consent recording and withdrawal system. Local-only mode requires no consent. Enabling sync requires explicit opt-in with versioned consent text displayed in full. Consent records are stored in KV alongside the user account, with full audit trail (old records preserved, never overwritten).

**Prerequisites/Inputs**

- Story 11 (KV account records, Worker API)
- Task 1 (Data Inventory -- what the consent covers)

**Implementation Details**

Files to create:

1. `src/worker/routes/consent.ts` -- consent grant/withdraw endpoints
2. `src/worker/lib/consent.ts` -- consent record management
3. `docs/gdpr/CONSENT-TEXT-v1.0.0.md` -- versioned consent text

**Consent Record Schema** (stored in KV under `consent:{userId}`):

```typescript
interface ConsentStore {
  user_id: string;
  consents: ConsentRecord[];
}

interface ConsentRecord {
  consent_id: string;          // UUID
  version: string;             // semver, e.g., "1.0.0"
  scope: 'sync_processing';   // currently only one scope
  granted_at: string;          // ISO 8601
  ip_country: string;          // 2-letter country code from CF headers
  client_version: string;      // agentctx CLI/app version
  consent_text_hash: string;   // sha256(consent_text)[:32]
  withdrawn_at: string | null; // ISO 8601 if withdrawn, null if active
}
```

**Consent Grant Endpoint** (`POST /api/consent`):

```typescript
export async function handleConsentGrant(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const body = await request.json() as {
    version: string;
    scope: string;
    consent_text_hash: string;
  };

  // Validate consent version matches current
  if (body.version !== env.CONSENT_VERSION) {
    return new Response(JSON.stringify({
      error: 'consent_version_mismatch',
      current_version: env.CONSENT_VERSION,
    }), { status: 400 });
  }

  // Validate consent text hash matches expected
  const expectedHash = await computeConsentTextHash(env.CONSENT_VERSION);
  if (body.consent_text_hash !== expectedHash) {
    return new Response(JSON.stringify({
      error: 'consent_text_hash_mismatch',
    }), { status: 400 });
  }

  // Create consent record
  const record: ConsentRecord = {
    consent_id: `con-${crypto.randomUUID()}`,
    version: body.version,
    scope: body.scope as 'sync_processing',
    granted_at: new Date().toISOString(),
    ip_country: request.cf?.country as string || 'unknown',
    client_version: request.headers.get('X-Client-Version') || 'unknown',
    consent_text_hash: body.consent_text_hash,
    withdrawn_at: null,
  };

  // Append to consent store (preserve history)
  const store = await getConsentStore(env, userId);
  store.consents.push(record);
  await env.KV.put(`consent:${userId}`, JSON.stringify(store));

  return new Response(JSON.stringify({
    consent_id: record.consent_id,
    status: 'granted',
  }), { status: 201 });
}
```

**Consent Withdrawal Endpoint** (`POST /api/consent/withdraw`):

```typescript
export async function handleConsentWithdraw(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const body = await request.json() as {
    consent_id: string;
    delete_data: boolean;
  };

  const store = await getConsentStore(env, userId);
  const consent = store.consents.find(c => c.consent_id === body.consent_id);

  if (!consent) {
    return new Response(JSON.stringify({ error: 'consent_not_found' }), { status: 404 });
  }

  if (consent.withdrawn_at) {
    return new Response(JSON.stringify({ error: 'already_withdrawn' }), { status: 409 });
  }

  // Mark as withdrawn (preserve the record for audit)
  consent.withdrawn_at = new Date().toISOString();
  await env.KV.put(`consent:${userId}`, JSON.stringify(store));

  // If user wants data deleted, trigger the deletion flow (Task 4)
  if (body.delete_data) {
    // Delegate to DELETE /api/account handler
    // (or a subset: delete sync data but keep account)
  }

  return new Response(JSON.stringify({
    status: 'withdrawn',
    consent_id: body.consent_id,
    data_deletion: body.delete_data ? 'initiated' : 'not_requested',
  }), { status: 200 });
}
```

**Consent Text Document** (`docs/gdpr/CONSENT-TEXT-v1.0.0.md`):

The full consent text from the story spec, stored as a versioned markdown file in the repository. The SHA-256 hash of this text is computed at build time and used for verification.

**Acceptance Criteria**

- [ ] Local-only mode is the default; no consent required for local-only use
- [ ] Enabling sync requires explicit opt-in via `POST /api/consent`
- [ ] No pre-checked checkboxes or bundled consent (enforced by requiring explicit API call)
- [ ] Consent record includes version, timestamp, scope, country, client version, and text hash
- [ ] Consent text hash is verified against the expected hash for the version
- [ ] Consent can be withdrawn via `POST /api/consent/withdraw`
- [ ] Withdrawal optionally triggers data deletion (delegates to Task 4)
- [ ] Old consent records are preserved for audit trail (never overwritten, only appended)
- [ ] Consent text is stored as versioned markdown in the repository
- [ ] Consent text is in plain, non-legal language

**Edge Cases**

- User tries to grant consent with an outdated version: return 400 with current version.
- User tries to withdraw consent that was already withdrawn: return 409 Conflict.
- User withdraws consent but does not request data deletion: sync stops, data remains (can re-enable later).
- Consent text hash mismatch (client shows different text than server expects): reject with clear error.

**Estimated Effort**: L (Large) -- 6-8 hours. Two endpoints, schema design, audit trail logic, consent text management.

---

### Task 9: Consent Middleware & Version Tracking

**Description**

Implement the Worker middleware that checks consent status on every sync-related request. If the user has not consented to the current version, sync endpoints return 403 with a `consent_required` or `consent_version_outdated` error. This middleware sits between JWT auth and the DO routing layer.

**Prerequisites/Inputs**

- Task 8 (consent records in KV)
- Story 11 (Worker middleware chain)

**Implementation Details**

File to create: `src/worker/middleware/consent-check.ts`

```typescript
export async function requireCurrentConsent(
  request: Request,
  env: Env,
  userId: string
): Promise<void> {
  const currentVersion = env.CONSENT_VERSION; // Set in wrangler.toml or KV

  const store = await getConsentStore(env, userId);
  const activeConsent = store.consents.find(
    c => c.scope === 'sync_processing' && !c.withdrawn_at
  );

  if (!activeConsent) {
    throw new ConsentRequiredError(currentVersion, 'no_consent');
  }

  if (activeConsent.version !== currentVersion) {
    throw new ConsentRequiredError(currentVersion, 'version_outdated', activeConsent.version);
  }
}

class ConsentRequiredError extends Error {
  constructor(
    public required_version: string,
    public reason: 'no_consent' | 'version_outdated',
    public current_version?: string
  ) {
    super(`Consent required: ${reason}`);
  }

  toResponse(): Response {
    return new Response(JSON.stringify({
      error: this.reason === 'no_consent' ? 'consent_required' : 'consent_version_outdated',
      required_version: this.required_version,
      current_version: this.current_version || null,
      message: this.reason === 'no_consent'
        ? 'Sync requires explicit consent. Please review and accept the data processing terms.'
        : `Your consent is for version ${this.current_version}, but version ${this.required_version} is required. Please review the updated terms.`,
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

**Middleware Integration** in the Worker fetch handler:

```typescript
// Applied to sync-related endpoints only
const CONSENT_REQUIRED_PATHS = [
  '/api/sync/push',
  '/api/sync/pull',
  '/api/sync/stream',
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ... JWT auth ...

    const url = new URL(request.url);
    if (CONSENT_REQUIRED_PATHS.some(p => url.pathname.startsWith(p))) {
      try {
        await requireCurrentConsent(request, env, userId);
      } catch (e) {
        if (e instanceof ConsentRequiredError) {
          return e.toResponse();
        }
        throw e;
      }
    }

    // ... route to DO ...
  }
};
```

**Version Tracking**: When the consent text changes:

1. Increment `CONSENT_VERSION` in `wrangler.toml` (or a KV config key)
2. All users with the old version are automatically caught by the middleware
3. Their sync is paused (403 response) until they re-consent
4. The daemon queues events locally and logs: "Sync paused: updated consent required"

**Daemon-side handling** of consent rejection:

```typescript
// In the daemon's sync client
async function pushEvent(event: EncryptedEvent): Promise<void> {
  const response = await fetch(syncUrl, { ... });

  if (response.status === 403) {
    const body = await response.json();
    if (body.error === 'consent_required' || body.error === 'consent_version_outdated') {
      // Queue event locally instead of dropping
      await queueForLaterSync(event);
      logWarning(`Sync paused: ${body.message}`);
      // Do NOT retry immediately -- wait for user to re-consent
      return;
    }
  }
  // ... handle other responses ...
}
```

**Acceptance Criteria**

- [ ] Consent middleware is applied to all sync endpoints (push, pull, stream)
- [ ] Users without consent receive 403 `consent_required`
- [ ] Users with outdated consent version receive 403 `consent_version_outdated`
- [ ] The response includes the required consent version for the client to display
- [ ] Non-sync endpoints (account, export, auth) are not blocked by consent middleware
- [ ] The daemon queues events locally when consent is missing/outdated (does not drop them)
- [ ] The daemon logs a clear warning message when sync is paused
- [ ] After re-consent, queued events are pushed to the server
- [ ] Consent version is configurable via `wrangler.toml` or KV

**Edge Cases**

- **E-4**: Consent version changes during a long session. Daemon receives 403, queues locally, warns user. Events accumulate up to a configurable max (default 10,000). Beyond max, oldest events are dropped from sync queue (retained in local store).
- Consent check KV read fails: fail open (allow sync) or fail closed (block sync)? **Decision: fail closed** -- if we cannot verify consent, we must not process data.
- Rapid consent version bumps (multiple updates in quick succession): middleware always checks against `env.CONSENT_VERSION`, so only the latest version matters.

**Estimated Effort**: M (Medium) -- 4-5 hours. Middleware function, daemon-side queue logic, integration into Worker pipeline.

---

### Task 10: EU Data Residency Enforcement

**Description**

Implement EU data residency by routing EU users' Durable Objects and R2 storage to EU-jurisdictional infrastructure. This includes region detection at registration, DO location hints, a dedicated EU R2 bucket, user region preference storage, and a periodic audit job to verify compliance.

**Prerequisites/Inputs**

- Story 11 (DO class, R2 buckets, KV)
- Platform Evaluation Section 5.3 (jurisdiction hints, caveats)
- Task 8 (consent -- region change from EU to non-EU requires re-consent)

**Implementation Details**

Files to create/modify:

1. `src/worker/lib/region.ts` -- region detection and routing
2. `src/worker/scheduled/eu-residency-audit.ts` -- periodic audit
3. `wrangler.toml` -- EU R2 bucket binding

**wrangler.toml additions**:

```toml
[[r2_buckets]]
binding = "R2_DEFAULT"
bucket_name = "agentcontext-events"

[[r2_buckets]]
binding = "R2_EU"
bucket_name = "agentcontext-events-eu"
jurisdiction = "eu"
```

**Region Detection** (`region.ts`):

```typescript
const EU_EEA_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA
  'IS', 'LI', 'NO',
]);

export function detectRegion(request: Request): 'eu' | 'default' {
  const country = (request.cf?.country as string) || 'US';
  return EU_EEA_COUNTRIES.has(country) ? 'eu' : 'default';
}

export function getUserDO(
  env: Env,
  userId: string,
  region: 'eu' | 'default'
): DurableObjectStub {
  const id = env.USER_SYNC.idFromName(userId);

  if (region === 'eu') {
    return env.USER_SYNC.get(id, { locationHint: 'eeur' });
  }

  return env.USER_SYNC.get(id);
}

export function getR2Bucket(env: Env, region: 'eu' | 'default'): R2Bucket {
  if (region === 'eu') {
    return env.R2_EU;
  }
  return env.R2_DEFAULT;
}
```

**Registration Flow** (region suggestion):

```typescript
// POST /api/auth/register
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await request.json();
  const suggestedRegion = detectRegion(request);

  // Store user with region preference
  const user = {
    userId: crypto.randomUUID(),
    email: body.email,
    tier: 'free',
    region: body.region || suggestedRegion, // User can override
    region_set_at: new Date().toISOString(),
    // ...
  };

  // Validate: Free tier cannot select EU (per tier structure)
  if (user.region === 'eu' && user.tier === 'free') {
    return new Response(JSON.stringify({
      error: 'eu_residency_requires_pro',
      message: 'EU data residency is available on Pro and Team tiers.',
    }), { status: 403 });
  }

  await env.KV.put(`users:${body.email}`, JSON.stringify(user));
  return new Response(JSON.stringify({
    ...user,
    suggested_region: suggestedRegion,
  }), { status: 201 });
}
```

**Region Change** (EU to non-EU requires re-consent):

```typescript
// PATCH /api/account/region
export async function handleRegionChange(request: Request, env: Env, userId: string): Promise<Response> {
  const body = await request.json() as { region: 'eu' | 'default' };
  const user = await getUser(env, userId);

  if (user.region === 'eu' && body.region === 'default') {
    // Changing from EU to non-EU: require re-consent
    return new Response(JSON.stringify({
      error: 'reconsent_required',
      message: 'Changing from EU to default region means your data may be transferred outside the EU. Please review and accept the updated terms.',
      action: 'POST /api/consent with updated scope',
    }), { status: 403 });
  }

  // For default -> EU: simple upgrade, no consent change needed
  user.region = body.region;
  user.region_set_at = new Date().toISOString();
  await env.KV.put(`users:${user.email}`, JSON.stringify(user));

  // Note: existing DO location cannot be changed (CF limitation)
  // New events will be stored in the correct bucket going forward
  // A full migration (E-3) requires creating a new DO and copying data

  return new Response(JSON.stringify({ status: 'region_updated', region: body.region }));
}
```

**Periodic Audit** (`eu-residency-audit.ts`):

```typescript
// Cloudflare Cron Trigger: runs weekly
export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const euUsers = await listEUUsers(env); // KV list + filter
  const violations: string[] = [];

  for (const user of euUsers) {
    // Verify R2 bucket assignment
    // (Check if any objects for this user exist in the default bucket)
    const defaultBucketCheck = await env.R2_DEFAULT.list({
      prefix: `users/${user.userId}/`,
      limit: 1,
    });
    if (defaultBucketCheck.objects.length > 0) {
      violations.push(`User ${user.userId}: objects found in default R2 bucket`);
    }
  }

  // Log audit results (no PII in logs)
  console.log(JSON.stringify({
    audit: 'eu_residency',
    checked: euUsers.length,
    violations: violations.length,
    timestamp: new Date().toISOString(),
  }));

  // If violations found, alert operations team
  if (violations.length > 0) {
    // Send alert (e.g., via webhook to Slack/PagerDuty)
  }
}
```

**Acceptance Criteria**

- [ ] EU users can select EU as their data region during registration
- [ ] Region is auto-detected from `request.cf.country` and suggested (not forced)
- [ ] Durable Objects for EU users are created with `locationHint: 'eeur'`
- [ ] EU users' encrypted blobs are stored in a dedicated EU R2 bucket with `jurisdiction: "eu"`
- [ ] KV records store the user's region preference with timestamp
- [ ] Changing region from EU to non-EU requires re-consent (returns 403)
- [ ] Free tier cannot select EU residency (returns 403 with upgrade message)
- [ ] Pro and Team tiers can select EU residency
- [ ] A weekly cron audit job checks that no EU user data is in the default R2 bucket
- [ ] Privacy policy discloses the "best effort" nature of DO location hints

**Edge Cases**

- **E-3**: EU user moves to non-EU. Requires re-consent, data migration from EU bucket to default. DO cannot be relocated (CF limitation) -- a new DO must be created. This is a complex migration documented but not fully automated in v1.0.
- Detection returns wrong country (VPN): user can manually override the suggested region.
- Cloudflare `locationHint` not honored: documented as "best effort" in privacy policy. For strict sovereignty, self-hosted deployment is recommended.

**Estimated Effort**: L (Large) -- 8-10 hours. Region routing, R2 bucket management, audit cron, region change with re-consent.

---

### Task 11: Privacy Headers & Cookie-Free Enforcement

**Description**

Add privacy-protecting HTTP headers to all Worker responses and enforce the cookie-free design by ensuring no `Set-Cookie` headers are ever sent. This eliminates cookie consent requirements entirely and signals privacy intent to browsers and intermediaries.

**Prerequisites/Inputs**

- Story 11 (Worker response pipeline)
- Story 06 (Dashboard -- must not set cookies)

**Implementation Details**

File to create: `src/worker/middleware/privacy-headers.ts`

```typescript
const PRIVACY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-XSS-Protection': '0', // Disabled (CSP is the modern approach)
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';",
};

export function addPrivacyHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  // Add privacy headers
  for (const [key, value] of Object.entries(PRIVACY_HEADERS)) {
    headers.set(key, value);
  }

  // CRITICAL: Remove any Set-Cookie headers (defense in depth)
  headers.delete('Set-Cookie');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
```

**Integration** in the Worker's main fetch handler (outermost middleware):

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handleRequest(request, env);
    return addPrivacyHeaders(response);
  }
};
```

**Dashboard enforcement** (for the local dashboard served by the daemon):

The daemon's HTTP server must also set these headers on all responses. Add to the dashboard's response builder in Story 06.

```typescript
// Daemon HTTP server response builder
function buildDashboardResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'interest-cohort=()',
      // No Set-Cookie
    },
  });
}
```

**No Third-Party Scripts Enforcement**:

Create a CI check that scans all HTML/JS files in the web portal and dashboard for external resource references:

```bash
# CI script: verify no external resources loaded
# Check for external script/link/img tags
grep -rn 'src="https\?://' src/web/ src/dashboard/ || true
grep -rn 'href="https\?://' src/web/ src/dashboard/ --include='*.html' || true
# Check for Google Fonts, CDN jQuery, analytics, etc.
grep -rn 'googleapis\|cdnjs\|unpkg\|jsdelivr\|google-analytics\|gtag\|fbevents\|hotjar' src/ || true
```

**Acceptance Criteria**

- [ ] All Worker responses include `X-Frame-Options: DENY`
- [ ] All Worker responses include `X-Content-Type-Options: nosniff`
- [ ] All Worker responses include `Referrer-Policy: no-referrer`
- [ ] All Worker responses include `Permissions-Policy: interest-cohort=()`
- [ ] All Worker responses include `Strict-Transport-Security` with at least 1 year max-age
- [ ] No `Set-Cookie` headers appear in any response (verified by automated test)
- [ ] Content-Security-Policy header blocks external scripts and frames
- [ ] Local dashboard also sets privacy headers
- [ ] CI check verifies no external script/font/analytics resources are referenced in source
- [ ] No third-party scripts are loaded by any client application
- [ ] Authentication uses JWT tokens in `Authorization` header, not cookies

**Edge Cases**

- Cloudflare itself might add headers (e.g., `cf-ray`). These are infrastructure headers, not tracking. Document which CF-added headers are expected.
- Future feature adds a third-party dependency (e.g., payment processor JS): must go through privacy review and be documented in privacy policy.
- `localStorage` usage in web portal for functional purposes (theme, sidebar state): allowed only for non-identifying data. Document the allowed keys.

**Estimated Effort**: S (Small) -- 2-3 hours. Header middleware is straightforward; CI check is a simple script.

---

### Task 12: Privacy Policy Document & Versioning

**Description**

Write the full privacy policy following the 13-section structure defined in the story spec. The policy must be in plain language, versioned, and accessible from the website, dashboard, mobile app, and CLI. Material changes trigger user notification and re-consent.

**Prerequisites/Inputs**

- Task 1 (Data Inventory -- tables incorporated into policy)
- Task 8 (Consent management -- policy references consent flow)
- Task 10 (EU residency -- policy discloses "best effort" nature)
- All other tasks inform policy content

**Implementation Details**

Files to create:

1. `docs/gdpr/PRIVACY-POLICY.md` -- the full privacy policy (13 sections)
2. `docs/gdpr/PRIVACY-POLICY-VERSION.json` -- version tracking metadata

**Privacy Policy** (`PRIVACY-POLICY.md`):

Structure follows the story spec exactly (13 sections):

1. **WHO WE ARE** -- Company identity, DPO contact, supervisory authority
2. **WHAT DATA WE COLLECT** -- Two sub-sections: local-only mode (nothing) and sync mode (with Data Inventory tables from Task 1)
3. **HOW WE USE YOUR DATA** -- Account management, sync routing, billing. Explicit "NEVER" list: no AI training, no advertising, no profiling, no selling.
4. **LEGAL BASIS FOR PROCESSING** -- Consent (sync), legitimate interest (security), contract (billing)
5. **ZERO-KNOWLEDGE ARCHITECTURE** -- Plain-language explanation of what the server can and cannot see, with both metadata tables
6. **DATA STORAGE AND RETENTION** -- Cloudflare infrastructure, EU residency option, retention per tier
7. **YOUR RIGHTS** -- All GDPR rights (Art. 15-20, 7(3), 77) with specific instructions for exercising each
8. **SUB-PROCESSORS** -- Cloudflare only, link to their DPA
9. **INTERNATIONAL TRANSFERS** -- Cloudflare global network, EU option, SCCs
10. **COOKIES AND TRACKING** -- Explicit "NONE" for all categories
11. **CHILDREN** -- Not directed at under 16
12. **CHANGES TO THIS POLICY** -- Version tracking, notification, re-consent
13. **CONTACT** -- DPO email, supervisory authority

**Plain Language Requirements** (from story spec):
- Sentences average under 20 words
- "You/your" language, not "the data subject"
- Technical terms explained on first use
- Key points in bold
- Single scrollable page

**Version Tracking** (`PRIVACY-POLICY-VERSION.json`):

```json
{
  "current_version": "1.0.0",
  "effective_date": "2026-02-22",
  "changelog": [
    {
      "version": "1.0.0",
      "date": "2026-02-22",
      "changes": "Initial privacy policy"
    }
  ]
}
```

**CLI Access**: `agentctx privacy-policy` command that prints or opens the policy.

**Dashboard/App Access**: Link in footer and settings page.

**Acceptance Criteria**

- [ ] Privacy policy exists with all 13 sections as defined in the story spec
- [ ] Policy is written in plain language (no unexplained legal jargon)
- [ ] Policy clearly separates local-only mode (no data collection) from sync mode
- [ ] Zero-knowledge architecture is explained in terms a non-technical user can understand
- [ ] Data inventory tables from Task 1 are included in the policy
- [ ] All GDPR rights are listed with instructions on how to exercise them
- [ ] Policy is versioned with a changelog (JSON metadata file)
- [ ] Material changes trigger user notification and re-consent where applicable
- [ ] Policy is accessible via CLI (`agentctx privacy-policy`), dashboard, and app
- [ ] Policy explicitly states no cookies, no analytics, no tracking, no third-party scripts

**Edge Cases**

- Privacy policy needs to be updated for a non-material change (typo fix): increment patch version, no re-consent required.
- Material change (new sub-processor): increment minor version, send email to all registered users, flag for re-consent.
- Policy requested in a language other than English: out of scope for v1.0 (English only). Document as a future requirement.

**Estimated Effort**: L (Large) -- 6-8 hours. Substantial writing task requiring precision in both technical accuracy and plain language.

---

### Task 13: Breach Notification Plan & Templates

**Description**

Create the incident response plan, breach classification table, and notification templates required by GDPR Art. 33 and Art. 34. The zero-knowledge architecture means most breaches qualify for the Art. 34(3)(a) exemption (encrypted data is unintelligible), but the supervisory authority must still be notified within 72 hours.

**Prerequisites/Inputs**

- Task 1 (Data Inventory -- classifies what data is at risk in each breach type)
- Story 12 (encryption guarantees underpin the Art. 34(3)(a) exemption argument)

**Implementation Details**

Files to create:

1. `docs/gdpr/BREACH-NOTIFICATION-PLAN.md` -- incident response plan (4 phases)
2. `docs/gdpr/BREACH-CLASSIFICATION.md` -- risk level per breach type
3. `docs/gdpr/templates/supervisory-authority-notification.md` -- Art. 33 template
4. `docs/gdpr/templates/data-subject-notification.md` -- Art. 34 template

**Breach Classification Table** (from story spec):

| Breach Type | Data Exposed | Risk Level | Art. 33 Notification | Art. 34 Notification |
|-------------|-------------|------------|---------------------|---------------------|
| R2/DO blob breach | Encrypted blobs | Low | Yes | No (Art. 34(3)(a) exemption) |
| DO SQLite breach | Anonymous metadata | Low | Yes | Likely No |
| KV breach | Emails, user IDs | Medium | Yes | Yes (email is PII) |
| Worker code breach | No user data | Low | Case-by-case | Case-by-case |
| Full infra breach | All of above | Medium | Yes | Yes (email exposure) |

**Incident Response Plan** (4 phases from story spec):

- Phase 1: Detection & Containment (0-4 hours)
- Phase 2: Assessment (4-24 hours)
- Phase 3: Notification (24-72 hours)
- Phase 4: Remediation (72+ hours)

Each phase has numbered steps with responsible parties and timelines.

**Supervisory Authority Template**: Fill-in-the-blank template covering all Art. 33(3) requirements (nature, categories, consequences, measures).

**Data Subject Template**: Email template for when notification is required (KV/email breach scenario).

**Acceptance Criteria**

- [ ] Breach classification table documents risk levels for each data category
- [ ] Incident response plan covers all 4 phases (detection, assessment, notification, remediation)
- [ ] Supervisory authority notification template covers all Art. 33(3) requirements
- [ ] Data subject notification template is clear and actionable
- [ ] Art. 34(3)(a) exemption is documented with reasoning (zero-knowledge encryption)
- [ ] 72-hour timeline is documented with phase breakdowns and responsible parties
- [ ] All templates are versioned and stored in `docs/gdpr/templates/`
- [ ] Annual review cadence is documented
- [ ] Incident response plan includes escalation contacts and communication channels

**Edge Cases**

- Breach detected on a Friday evening: the 72-hour clock starts at discovery, not next business day. The plan must account for weekend/holiday response.
- Breach of only encrypted data (R2): document the Art. 34(3)(a) exemption clearly so legal counsel can quickly determine no user notification is needed.
- Law enforcement request (E-7): the plan should reference that the server can only produce encrypted blobs + anonymous metadata + email.

**Estimated Effort**: M (Medium) -- 4-6 hours. Documentation task with specific GDPR requirements.

---

### Task 14: DPA Template for Team/Enterprise

**Description**

Create a Data Processing Agreement template that team and enterprise customers can sign. The DPA covers all Art. 28(3) requirements and includes annexes for data inventory, security measures, and sub-processor list.

**Prerequisites/Inputs**

- Task 1 (Data Inventory -- Annex A)
- Task 10 (EU residency -- international transfers section)
- Task 13 (breach notification -- DPA breach notification clause)
- Story 12 (security measures -- Annex B)

**Implementation Details**

File to create: `docs/gdpr/DPA-TEMPLATE.md`

The DPA follows the 12-section structure from the story spec:

1. Definitions (per GDPR Art. 4)
2. Scope and Purpose (encrypted storage and sync)
3. Controller Obligations
4. Processor Obligations (Art. 28(3) a-h)
5. Sub-Processors (Cloudflare only, 30-day objection period)
6. International Transfers (SCCs where applicable)
7. Security Measures (Annex B: zero-knowledge encryption, per-user isolation)
8. Data Breach Notification (48-hour processor-to-controller notification)
9. Data Subject Rights (export + deletion technical capabilities)
10. Audit Rights (annual, SOC 2 Type II as alternative)
11. Term and Termination (30-day data deletion on termination)
12. Liability (per main service agreement)

Plus 4 annexes:
- Annex A: Data Inventory (from Task 1)
- Annex B: Security Measures (from Story 12)
- Annex C: Sub-Processor List (Cloudflare details)
- Annex D: Standard Contractual Clauses (EU Commission approved SCCs)

**Acceptance Criteria**

- [ ] DPA template covers all Art. 28(3) requirements (a through h)
- [ ] Template includes all 4 annexes (data inventory, security, sub-processors, SCCs)
- [ ] Processor-to-controller breach notification is 48 hours (stricter than GDPR's 72)
- [ ] Sub-processor changes require 30-day prior written notice with objection right
- [ ] Data deletion on termination within 30 days (with export option)
- [ ] Audit rights: annual audit or SOC 2 Type II report
- [ ] Template is versioned and stored in `docs/gdpr/`
- [ ] Template is available for download from the dashboard (Team/Enterprise tiers)
- [ ] Template can be signed electronically

**Edge Cases**

- Customer wants to modify the DPA: standard template is non-negotiable for Pro tier. Enterprise customers (future tier) may negotiate custom terms.
- New sub-processor added: 30-day notice to all customers with active DPAs. Document the notification process.
- Customer in a non-EU jurisdiction that still requires a DPA (e.g., UK post-Brexit): template includes UK GDPR compatibility note.

**Estimated Effort**: L (Large) -- 6-8 hours. Detailed legal document template requiring precision in GDPR article references.

---

### Task 15: Automated GDPR Compliance Test Suite

**Description**

Create a comprehensive automated test suite that verifies GDPR compliance across all platform components. Tests cover data minimization, erasure, consent, cookie-free design, and privacy headers. The suite runs in CI/CD on every pull request and blocks releases on failure.

**Prerequisites/Inputs**

- Tasks 2-11 (all technical implementations must exist to test)
- Story 11 (test infrastructure for Worker/DO/R2)

**Implementation Details**

File to create: `tests/gdpr/compliance.test.ts`

The test suite follows the structure from the story spec:

```typescript
describe('GDPR Compliance', () => {

  describe('F11.1 Data Minimization', () => {
    test('metadata contains no PII fields for all 10 event types', async () => {
      for (const eventType of ALL_EVENT_TYPES) {
        const event = createTestEvent(eventType, {
          session_id: 'secret-session-123',
          prompt: 'Write sensitive code',
          tool_response: 'Here is your secret API key...',
        });
        const metadata = buildCleartextMetadata(event);

        expect(metadata).not.toHaveProperty('prompt');
        expect(metadata).not.toHaveProperty('tool_response');
        expect(metadata).not.toHaveProperty('session_id');
        expect(metadata.session_id_hash).not.toBe('secret-session-123');
        expect(metadata.session_id_hash).toHaveLength(16);
      }
    });

    test('extra metadata fields are stripped by server', async () => {
      const { sanitized, stripped } = sanitizeMetadata({
        ...validMetadata,
        secret_field: 'should be stripped',
        prompt: 'should be stripped',
      });
      expect(sanitized).not.toHaveProperty('secret_field');
      expect(sanitized).not.toHaveProperty('prompt');
      expect(stripped).toContain('secret_field');
      expect(stripped).toContain('prompt');
    });

    test('session_id_hash is exactly 16 characters', async () => {
      const hash = hashSessionId('any-session-id');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('F11.2 Right to Erasure', () => {
    test('DELETE /api/account returns correct response', async () => {
      const { jwt } = await createTestAccount();
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('deletion_initiated');
      expect(body.deletion_id).toMatch(/^del-/);
      expect(body.what_will_be_deleted).toContain('all_encrypted_event_blobs');
    });

    test('deletion is idempotent (second call returns 401)', async () => {
      const { jwt } = await createTestAccount();
      await fetch('/api/account', { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      const second = await fetch('/api/account', { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      expect(second.status).toBe(401); // JWT revoked
    });

    test('full deletion removes all data', async () => {
      const { userId, jwt } = await createTestAccount();
      await pushTestEvents(jwt, 50);

      await fetch('/api/account', { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      await waitForDeletion(userId);

      const r2Objects = await listR2Objects(`users/${userId}/`);
      expect(r2Objects).toHaveLength(0);
      const doData = await queryDO(userId);
      expect(doData).toBeNull();
    });
  });

  describe('F11.4 Consent Management', () => {
    test('sync endpoints reject users without consent', async () => {
      const { jwt } = await createAccountWithoutConsent();
      const response = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(testSyncPayload),
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('consent_required');
    });

    test('outdated consent version blocks sync', async () => {
      const { jwt } = await createAccountWithConsent('1.0.0');
      // Bump consent version
      env.CONSENT_VERSION = '1.1.0';
      const response = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(testSyncPayload),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('consent_version_outdated');
    });

    test('consent withdrawal marks record with withdrawn_at', async () => {
      const { jwt, userId } = await createAccountWithConsent('1.0.0');
      const store = await getConsentStore(env, userId);
      const consentId = store.consents[0].consent_id;

      await fetch('/api/consent/withdraw', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ consent_id: consentId, delete_data: false }),
      });

      const updated = await getConsentStore(env, userId);
      expect(updated.consents[0].withdrawn_at).not.toBeNull();
    });
  });

  describe('F11.6 EU Data Residency', () => {
    test('EU country detection works for all EU/EEA countries', () => {
      for (const country of EU_EEA_COUNTRIES) {
        const region = detectRegion(mockRequest(country));
        expect(region).toBe('eu');
      }
    });

    test('non-EU countries return default', () => {
      expect(detectRegion(mockRequest('US'))).toBe('default');
      expect(detectRegion(mockRequest('CN'))).toBe('default');
      expect(detectRegion(mockRequest('JP'))).toBe('default');
    });
  });

  describe('F11.9 Cookie-Free', () => {
    test('no Set-Cookie headers in any response', async () => {
      const endpoints = [
        { method: 'POST', path: '/api/auth/login' },
        { method: 'POST', path: '/api/auth/register' },
        { method: 'POST', path: '/api/sync/push' },
        { method: 'GET', path: '/api/account' },
        { method: 'POST', path: '/api/account/export' },
        { method: 'DELETE', path: '/api/account' },
      ];

      for (const ep of endpoints) {
        const response = await fetch(ep.path, { method: ep.method });
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }
    });

    test('privacy headers are present in all responses', async () => {
      const response = await fetch('/api/health');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Permissions-Policy')).toContain('interest-cohort=()');
    });
  });
});
```

Additional test files:

- `tests/gdpr/metadata-sanitization.test.ts` -- Unit tests for `sanitizeMetadata()` with all 10 event types
- `tests/gdpr/consent-flow.test.ts` -- Integration tests for consent grant/withdraw/version tracking
- `tests/gdpr/deletion-flow.test.ts` -- Integration test for full deletion lifecycle
- `tests/gdpr/export-flow.test.ts` -- Integration test for export + download
- `tests/gdpr/eu-residency.test.ts` -- Tests for region detection, routing, and bucket assignment
- `tests/gdpr/no-third-party.test.ts` -- CI check that scans source for external resource references

**CI Integration**: Add to the CI pipeline (GitHub Actions or equivalent):

```yaml
# .github/workflows/gdpr-compliance.yml
name: GDPR Compliance
on: [pull_request]
jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test -- --testPathPattern='tests/gdpr/'
      - run: bash tests/gdpr/no-third-party-check.sh
```

**Acceptance Criteria**

- [ ] Test suite covers all GDPR compliance areas: minimization, erasure, consent, cookie-free, headers, EU residency
- [ ] Tests for all 10 event types verify no PII leaks into cleartext metadata
- [ ] Integration tests verify full deletion lifecycle (create -> push -> delete -> verify empty)
- [ ] Integration tests verify full export lifecycle (create -> push -> export -> download -> verify)
- [ ] Consent flow tests cover: grant, reject outdated, version bump, withdrawal
- [ ] Cookie-free tests verify no `Set-Cookie` on all endpoints
- [ ] Privacy header tests verify all required headers are present
- [ ] CI/CD pipeline runs GDPR tests on every pull request
- [ ] Test failures block the release pipeline
- [ ] No-third-party check scans source files for external resource references

**Edge Cases**

- Tests must work in the Cloudflare Miniflare test environment (or equivalent local emulator).
- Tests should not depend on real Cloudflare infrastructure (use mocks for R2, KV, DO).
- Test data must be cleaned up after each test run (no persistent test artifacts).

**Estimated Effort**: XL (Extra Large) -- 10-14 hours. Comprehensive test suite across multiple compliance areas, integration with CI/CD.

---

### Task 16: Component Compliance Checklists & Audit Schedule

**Description**

Create per-component compliance checklists (daemon, sync server, mobile app, desktop app) and establish the audit schedule. Each checklist is a table of requirements with verification methods. The audit schedule defines who checks what, how often, and what the output is.

**Prerequisites/Inputs**

- All previous tasks (checklists reference the implementations)
- Story spec Section 11 (component checklists and audit tables)

**Implementation Details**

Files to create:

1. `docs/gdpr/COMPLIANCE-CHECKLISTS.md` -- per-component checklists
2. `docs/gdpr/AUDIT-SCHEDULE.md` -- audit frequency and ownership

**Component Checklists** (from story spec Section 11):

- **Daemon (Local)**: 6 checks (no phone-home, local data stays local, no telemetry, secure permissions, no PII in logs, consent check before sync)
- **Sync Server (Workers)**: 8 checks (metadata stripping, no plaintext PII in DO, deletion completeness, consent enforcement, EU routing, rate limiting, JWT expiry, no payload logging)
- **Mobile App**: 7 checks (key in secure enclave, no analytics SDK, no crash reporting PII, local decryption, consent UI, export function, deletion function)
- **Desktop App (Tauri)**: 5 checks (key in OS keychain, no external requests, no update telemetry, WebView sandboxed, same consent flow)

Each check includes:
- Requirement description
- How to verify (unit test, integration test, code review, network audit, etc.)
- Pass/fail status (to be filled in during audits)

**Audit Schedule** (from story spec):

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

**Acceptance Criteria**

- [ ] Component compliance checklists exist for all 4 components (daemon, server, mobile, desktop)
- [ ] Each checklist item has a verification method
- [ ] Audit schedule is documented with frequency, responsible party, and expected output
- [ ] Automated audits (deletion test, EU verification, dependency audit) are integrated into CI/CD
- [ ] Manual audit cadences are documented with responsible parties
- [ ] Full GDPR compliance audit is scheduled annually with an external auditor
- [ ] All documents are versioned and stored in `docs/gdpr/`

**Edge Cases**

- New component added (e.g., web portal): a compliance checklist must be created before the component ships.
- Audit reveals a violation: document the remediation process and timeline.
- External auditor finds an issue not covered by the checklists: add it to the relevant checklist.

**Estimated Effort**: M (Medium) -- 4-6 hours. Documentation task referencing implementations from all other tasks.

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|------|--------|---------|
| `docs/gdpr/DATA-INVENTORY.md` | Create | 1 |
| `src/worker/middleware/sanitize-metadata.ts` | Create | 2 |
| `src/worker/middleware/privacy-headers.ts` | Create | 11 |
| `src/worker/middleware/consent-check.ts` | Create | 9 |
| `src/daemon/sync/build-metadata.ts` | Create | 3 |
| `src/worker/routes/account-delete.ts` | Create | 4 |
| `src/worker/do/deletion.ts` | Create | 4 |
| `src/worker/lib/deletion-audit.ts` | Create | 5 |
| `src/worker/routes/account-export.ts` | Create | 6 |
| `src/worker/do/export.ts` | Create | 6 |
| `src/cli/commands/export-decrypt.ts` | Create | 7 |
| `src/cli/commands/import.ts` | Create | 7 |
| `src/worker/routes/consent.ts` | Create | 8 |
| `src/worker/lib/consent.ts` | Create | 8 |
| `docs/gdpr/CONSENT-TEXT-v1.0.0.md` | Create | 8 |
| `src/worker/lib/region.ts` | Create | 10 |
| `src/worker/scheduled/eu-residency-audit.ts` | Create | 10 |
| `docs/gdpr/PRIVACY-POLICY.md` | Create | 12 |
| `docs/gdpr/PRIVACY-POLICY-VERSION.json` | Create | 12 |
| `docs/gdpr/BREACH-NOTIFICATION-PLAN.md` | Create | 13 |
| `docs/gdpr/BREACH-CLASSIFICATION.md` | Create | 13 |
| `docs/gdpr/templates/supervisory-authority-notification.md` | Create | 13 |
| `docs/gdpr/templates/data-subject-notification.md` | Create | 13 |
| `docs/gdpr/DPA-TEMPLATE.md` | Create | 14 |
| `tests/gdpr/compliance.test.ts` | Create | 15 |
| `tests/gdpr/metadata-sanitization.test.ts` | Create | 15 |
| `tests/gdpr/consent-flow.test.ts` | Create | 15 |
| `tests/gdpr/deletion-flow.test.ts` | Create | 15 |
| `tests/gdpr/export-flow.test.ts` | Create | 15 |
| `tests/gdpr/eu-residency.test.ts` | Create | 15 |
| `tests/gdpr/no-third-party.test.ts` | Create | 15 |
| `docs/gdpr/COMPLIANCE-CHECKLISTS.md` | Create | 16 |
| `docs/gdpr/AUDIT-SCHEDULE.md` | Create | 16 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone |
|-------|-------|-----------|
| **Phase 1: Foundation** | Task 1 (Data Inventory) | PII classification complete, all other tasks reference it |
| **Phase 2: Server-Side Enforcement** | Task 2 (Metadata Sanitization), Task 11 (Privacy Headers) | Server blocks PII leaks and sets privacy headers |
| **Phase 3: Client-Side Enforcement** | Task 3 (PII Leak Prevention) | Client never sends PII in cleartext |
| **Phase 4: Erasure** | Task 4 (Deletion API), Task 5 (Audit Log) | Users can delete accounts with crypto-shredding |
| **Phase 5: Portability** | Task 6 (Export API), Task 7 (Decrypt & Import) | Users can export and import their data |
| **Phase 6: Consent** | Task 8 (Consent System), Task 9 (Middleware) | Sync requires explicit consent with version tracking |
| **Phase 7: EU Residency** | Task 10 (EU Data Residency) | EU users' data stays in EU infrastructure |
| **Phase 8: Documentation** | Task 12 (Privacy Policy), Task 13 (Breach Plan), Task 14 (DPA Template) | All legal documents prepared |
| **Phase 9: Verification** | Task 15 (Test Suite), Task 16 (Checklists & Audit) | Automated testing and ongoing audit process |

Tasks within the same phase can be parallelized where noted. Phase 1 must complete before all others. Phases 2-3 can run in parallel. Phases 4-7 can be partially parallelized (they share the Worker infrastructure but target different endpoints).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| R2 batch deletion times out for large accounts | Medium | High (incomplete erasure) | Alarm-based retry with 72-hour deadline. Paginated deletion (1000 objects per batch). |
| Cloudflare `locationHint` not honored for EU users | Medium | Medium (data outside EU) | Document as "best effort" in privacy policy. Weekly automated audit detects violations. Self-hosted option for strict requirements. |
| Consent version bump causes mass sync disruption | Low | Medium (many users paused) | Daemon queues locally. Increment versions only for material changes. Clear re-consent UX. |
| ZIP export generation exceeds Worker CPU limits | Medium | Medium (export fails) | Stream ZIP generation. Multi-part splits at 1GB. 24-hour async timeout. |
| Privacy policy requires legal review | High | Low (delays publication) | Draft document now, schedule legal review as a separate task. Mark as "draft" until reviewed. |
| DPA template requires legal counsel | High | Low (delays availability) | Template follows standard Art. 28(3) structure. Mark as "template pending legal review." |
| KV eventual consistency causes stale consent check | Low | Low (momentary sync with outdated consent) | Fail closed: if consent check KV read fails, block sync. Acceptable 60s staleness for non-critical operations. |
| Deletion audit KV write fails | Low | Low (missing audit record) | Deletion proceeds anyway (user rights take priority over audit). Log failure for manual follow-up. |
| Third-party dependency sneaks in via transitive import | Medium | Medium (cookie-free violation) | CI check scans all bundle output for external URLs. Dependency audit runs monthly. |
| GDPR requirements evolve (ePrivacy Regulation, AI Act) | Medium | Medium (compliance gap) | Annual full audit by external counsel. Monitor regulatory developments. |

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|-----------|----------|
| Task 1: Data Inventory & PII Classification | S | 2-3 hours |
| Task 2: Metadata Sanitization (Server-Side) | M | 3-4 hours |
| Task 3: PII Leak Prevention (Client-Side) | M | 3-4 hours |
| Task 4: Right to Erasure API & Crypto-Shredding | XL | 10-14 hours |
| Task 5: Deletion Audit Log | S | 2-3 hours |
| Task 6: Data Portability Export API | XL | 12-16 hours |
| Task 7: Client-Side Export Decryption & Import | L | 6-8 hours |
| Task 8: Consent Management System | L | 6-8 hours |
| Task 9: Consent Middleware & Version Tracking | M | 4-5 hours |
| Task 10: EU Data Residency Enforcement | L | 8-10 hours |
| Task 11: Privacy Headers & Cookie-Free Enforcement | S | 2-3 hours |
| Task 12: Privacy Policy Document & Versioning | L | 6-8 hours |
| Task 13: Breach Notification Plan & Templates | M | 4-6 hours |
| Task 14: DPA Template for Team/Enterprise | L | 6-8 hours |
| Task 15: Automated GDPR Compliance Test Suite | XL | 10-14 hours |
| Task 16: Component Compliance Checklists & Audit Schedule | M | 4-6 hours |
| **Total** | | **~87-120 hours (~12-16 working days)** |

---

## Notes for Implementation

1. **Data Inventory is the single source of truth** -- Every other task references the data inventory (Task 1). When the metadata schema changes in any story, the data inventory must be updated first, and all downstream artifacts (privacy policy, DPA annexes, compliance tests) must be updated in lockstep.

2. **Crypto-shredding is the erasure mechanism** -- The server never holds decryption keys. Deleting the encrypted blobs + DO storage + KV records makes data permanently unrecoverable, even if backups exist. This is the core Art. 17 compliance argument.

3. **Fail closed on consent** -- If the consent check cannot be performed (KV read failure), sync must be blocked. Processing data without verifiable consent is a GDPR violation.

4. **EU residency is "best effort"** -- Cloudflare's `locationHint` and `jurisdiction` are advisory. The privacy policy must disclose this limitation transparently. For strict data sovereignty, self-hosted deployment is the answer.

5. **No cookies means no cookie banner** -- The cookie-free design eliminates an entire category of compliance complexity (ePrivacy Directive). This must be maintained rigorously -- no feature should introduce cookies.

6. **Legal review is out of scope but required** -- This plan produces draft documents (privacy policy, DPA template, breach plan). All must be reviewed by qualified legal counsel before publication. Mark all documents as "DRAFT - PENDING LEGAL REVIEW" until that review occurs.

7. **Privacy by design, not by afterthought** -- Every new feature must pass through the GDPR compliance checklist before shipping. The automated test suite (Task 15) enforces technical compliance; the checklists (Task 16) enforce process compliance.

8. **Encrypted data is pseudonymized, not anonymized** -- Under GDPR, encrypted data where the key exists elsewhere is pseudonymized personal data. It is still "processing." The zero-knowledge architecture reduces practical obligations but does not eliminate them. The data inventory must state this explicitly.
