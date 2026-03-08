# Implementation Plan: Story 14 -- Codeguard Registry

**Date**: 2026-02-24
**Story**: 14-codeguard-registry
**Status**: Implemented (retroactive plan)
**Actual Effort**: ~8-10 days
**Prerequisites**: Story 11 (Sync Server architecture), Story 12 (Security & Encryption -- JWT auth), Story 13 (GDPR Compliance -- consent system)
**GDPR Articles Referenced**: Art. 7 (consent for telemetry opt-in)
**Test Results**: 86 tests passing across 3 packages (40 sync-server + 31 admin-server + 15 daemon)

### Relationship to Other Stories

This story builds on several prior stories and sets the stage for Story 15 (Admin Server):

- **Story 11** (Sync Server): Provides the Cloudflare Worker infrastructure. This plan adds `REGISTRY_KV` namespace binding for codeguard data storage and three new public/authed endpoints.
- **Story 12** (Security & Encryption): Provides JWT auth. Telemetry ingestion reuses the JWT verification middleware for authenticated pushes.
- **Story 13** (GDPR Compliance): Provides the consent management system. This plan adds the `rule_telemetry` consent category (Art. 7, opt-in, default false).
- **Story 15** (Admin Server): Consumes the `REGISTRY_KV` data written by this story. Story 15 adds the admin CRUD for curated rules and popular list moderation. While Story 15 is a separate story, the admin-server package was implemented concurrently and shares KV namespaces with sync-server.

### Architecture Overview

The Codeguard Registry replaces static local JSON-based rule discovery with a server-backed system consisting of two complementary lists:

1. **Curated List** -- Admin-managed recommended rules stored in `REGISTRY_KV` at key `codeguard:curated`. Read publicly via sync-server, written by admin-server (Story 15).
2. **Popular List** -- Telemetry-driven rankings stored at key `codeguard:popular`. Built from anonymous aggregate rule usage stats. Updated by sync-server telemetry ingestion, moderated by admin-server.

**Privacy architecture**: Telemetry contains only rule IDs, scope (global/project), and cumulative block counts. No file paths, content, project names, or user-identifiable data beyond the auth token (needed for dedup). Per-user snapshots stored only for delta computation.

---

## Task Dependency Graph

```
Task 1: Consent Category — rule_telemetry
  |
  +---> Task 2: Telemetry Data Types & Payload Validation
  |       |
  |       +---> Task 3: Telemetry Ingestion Handler (sync-server)
  |               |
  |               +---> Task 4: Delta Computation & Popular Aggregation
  |               |
  |               +---> Task 5: Rate Limiting (30 min per user)
  |
  +---> Task 6: Public Read Endpoints (sync-server)
  |       |
  |       +---> Task 7: Curated Rules Handler
  |       |
  |       +---> Task 8: Popular Rules Handler
  |
  +---> Task 9: Daemon RuleRegistry — Server-Backed Discovery
  |       |
  |       +---> Task 10: Server Fetch with 1h Cache TTL
  |       |
  |       +---> Task 11: Local File Fallback
  |       |
  |       +---> Task 12: toLocalRule() Metadata Stripping
  |
  +---> Task 13: ViolationTracker — getSnapshot() for Telemetry
  |
  +---> Task 14: Daemon TelemetrySender — Periodic Push
  |       |
  |       +---> Task 15: Consent-Gated Enable/Disable
  |       |
  |       +---> Task 16: Deduplication — Last Snapshot Comparison
  |
  +---> Task 17: Admin Server — Curated CRUD (Story 15 overlap)
  |       |
  |       +---> Task 18: Admin Authentication (JWT + KV role check)
  |       |
  |       +---> Task 19: Curated Rules Add/Update/Delete
  |       |
  |       +---> Task 20: Popular Rules Hide/Unhide Moderation
  |       |
  |       +---> Task 21: User Management (List/Promote/Demote)
  |
  +---> Task 22: KV Storage Layout & Shared Namespace
  |
  +---> Task 23: Test Suite (86 tests)
```

---

## Tasks

### Task 1: Consent Category -- `rule_telemetry`

**Description**

Add a new `rule_telemetry` consent category to the existing GDPR consent system (Art. 7). This is opt-in only (default false). The consent manager in the sync-server's Durable Object tracks this alongside existing categories (`data_sync`, `analytics`, `crash_reports`).

**Prerequisites/Inputs**

- Story 13 consent management system (ConsentManager class, consent table in DO SQLite)
- ConsentCategory union type, ConsentPreferences interface

**Implementation Details**

File modified: `packages/sync-server/src/middleware/consent-manager.ts`

Changes made:
1. Extended `ConsentCategory` union type to include `'rule_telemetry'`
2. Added `rule_telemetry: boolean` to `ConsentPreferences` interface
3. Set `rule_telemetry: false` in `DEFAULT_CONSENT`
4. Added `rule_telemetry INTEGER DEFAULT 0` column to the consent table DDL
5. Added `rule_telemetry` to the UPSERT query (INSERT and ON CONFLICT clauses)
6. Added `'rule_telemetry'` to the `validCategories` array for validation
7. Mock test storage maps `params[4]` to `rule_telemetry` in positional INSERT

```typescript
export type ConsentCategory = 'data_sync' | 'analytics' | 'crash_reports' | 'rule_telemetry';

export interface ConsentPreferences {
  data_sync: boolean;
  analytics: boolean;
  crash_reports: boolean;
  rule_telemetry: boolean;
}

export const DEFAULT_CONSENT: ConsentPreferences = {
  data_sync: false,
  analytics: false,
  crash_reports: false,
  rule_telemetry: false,
};
```

**Acceptance Criteria**

- [x] `rule_telemetry` is a valid consent category
- [x] Default value is `false` (opt-in required)
- [x] Consent can be set and retrieved via existing consent API
- [x] Consent table schema includes `rule_telemetry` column
- [x] Test mock correctly handles positional parameter mapping

**Files**

- `packages/sync-server/src/middleware/consent-manager.ts`
- `packages/sync-server/src/__tests__/consent-manager.test.ts` (mock updated)

**Estimated Effort**: S (Small)

---

### Task 2: Telemetry Data Types & Payload Validation

**Description**

Define the telemetry data shapes for client payloads, per-user snapshots, and popular aggregation entries. Implement strict validation on the ingestion endpoint: each rule must have a string `id`, a valid `scope` (`"global"` or `"project"`), and a non-negative numeric `blocks` count.

**Prerequisites/Inputs**

- Story 14 requirements (Section 1: Telemetry Data Shape)

**Implementation Details**

File created: `packages/sync-server/src/codeguard/telemetry-handlers.ts`

Types defined:

```typescript
interface TelemetryRule {
  id: string;
  scope: 'global' | 'project';
  blocks: number;
}

interface TelemetryPayload {
  rules: TelemetryRule[];
}

interface UserSnapshot {
  rules: TelemetryRule[];
  updated_at: string;
}

interface PopularRuleEntry {
  rule: { id, description, severity, enabled, file_patterns, patterns, exclude_patterns, suggestion };
  total_installs: number;
  total_blocks: number;
  hidden: boolean;
  first_seen: string;
  last_updated: string;
}

interface PopularRulesData {
  updated: string;
  rules: PopularRuleEntry[];
}
```

Validation logic (lines 87-101 of `telemetry-handlers.ts`):
- Body must parse as JSON (400 `invalid_body` on failure)
- `body.rules` must be an array (400 `validation_error`)
- Each rule must have `id: string` (400 `validation_error`)
- Each rule must have `scope: "global" | "project"` (400 `validation_error`)
- Each rule must have `blocks: number >= 0` (400 `validation_error`)

**Acceptance Criteria**

- [x] Valid payload with rules array returns 200
- [x] Invalid JSON returns 400 `invalid_body`
- [x] Missing `rules` array returns 400 `validation_error`
- [x] Rule with no `id` returns 400 `validation_error`
- [x] Rule with invalid `scope` returns 400 `validation_error`
- [x] Rule with negative `blocks` returns 400 `validation_error`

**Files**

- `packages/sync-server/src/codeguard/telemetry-handlers.ts` (types + validation, lines 20-101)

**Estimated Effort**: S (Small)

---

### Task 3: Telemetry Ingestion Handler (sync-server)

**Description**

Implement `POST /api/codeguard/telemetry` on the sync-server. This endpoint requires JWT authentication and `rule_telemetry` consent. It accepts rule usage stats, computes deltas against the user's previous snapshot, updates the popular aggregation, stores the new snapshot, and enforces a 30-minute rate limit per user.

**Prerequisites/Inputs**

- Task 1 (consent category)
- Task 2 (data types)
- JWT auth middleware from Story 12
- REGISTRY_KV namespace binding

**Implementation Details**

File: `packages/sync-server/src/codeguard/telemetry-handlers.ts`

The handler function `handleTelemetryPush(request, env, authCtx)` performs these steps in order:

1. **Parse & validate body** (Task 2)
2. **Check rate limit** -- KV key `codeguard:telemetry:rate:{userId}` with 30-minute TTL
3. **Load previous snapshot** -- KV key `codeguard:telemetry:{userId}`
4. **Compute deltas** -- Compare current vs previous:
   - New rule (in current, not in prev): `installDelta: +1`, `blockDelta: current.blocks`
   - Existing rule with more blocks: `installDelta: 0`, `blockDelta: current.blocks - prev.blocks`
   - Removed rule (in prev, not in current): `installDelta: -1`, `blockDelta: 0`
5. **Update popular aggregation** -- If deltas exist, read `codeguard:popular`, apply deltas, write back
6. **Store new snapshot** -- Write current rules to `codeguard:telemetry:{userId}`
7. **Set rate limit** -- Write timestamp to rate limit key with `expirationTtl: 1800`

Returns: `{ accepted: number, deltas_applied: number }`

**Acceptance Criteria**

- [x] First-time push creates popular entries with `total_installs: 1`
- [x] Re-send with same rule only increments block delta (not install count)
- [x] Rule removal decrements `total_installs` on the popular entry
- [x] Rate limit returns 429 with `retry_after_seconds` within 30-minute window
- [x] Snapshot is persisted for next delta computation
- [x] Popular data is atomically updated

**Files**

- `packages/sync-server/src/codeguard/telemetry-handlers.ts` (lines 73-217)
- `packages/sync-server/src/__tests__/codeguard-telemetry.test.ts` (15 tests)

**Estimated Effort**: M (Medium) -- 4-6 hours. Core business logic with delta computation.

---

### Task 4: Delta Computation & Popular Aggregation

**Description**

The delta computation algorithm prevents double-counting by comparing the current telemetry payload against the user's last stored snapshot. Deltas are applied to the global popular list atomically.

**Prerequisites/Inputs**

- Task 3 (handler structure)

**Implementation Details**

Delta logic (lines 134-156 of `telemetry-handlers.ts`):

```typescript
// New or updated rules
for (const [id, current] of currentMap) {
  const prev = prevMap.get(id);
  if (!prev) {
    // New rule: full install + all blocks
    deltas.push({ id, installDelta: 1, blockDelta: current.blocks });
  } else {
    // Existing rule: only block delta (installs unchanged)
    const blockDelta = Math.max(0, current.blocks - prev.blocks);
    if (blockDelta > 0) {
      deltas.push({ id, installDelta: 0, blockDelta });
    }
  }
}

// Removed rules (in prev but not in current)
for (const [id] of prevMap) {
  if (!currentMap.has(id)) {
    deltas.push({ id, installDelta: -1, blockDelta: 0 });
  }
}
```

Popular aggregation (lines 159-198):
- Loads `codeguard:popular` from KV (or initializes empty)
- Builds a Map of existing popular entries by rule ID
- For each delta: updates `total_installs` and `total_blocks` with `Math.max(0, ...)` floor
- New rules not in popular list get a minimal entry (just ID, empty metadata)
- Writes updated popular data back to KV

**Acceptance Criteria**

- [x] New rule adds `installDelta: +1` and full block count
- [x] Existing rule with more blocks adds only the block delta
- [x] Existing rule with same blocks produces no delta
- [x] Removed rule decrements install count (clamped to 0)
- [x] Block counts never go negative (`Math.max(0, ...)`)
- [x] Install counts never go negative (`Math.max(0, ...)`)

**Files**

- `packages/sync-server/src/codeguard/telemetry-handlers.ts` (lines 134-198)

**Estimated Effort**: M (Medium) -- included in Task 3

---

### Task 5: Rate Limiting (30 min per user)

**Description**

Enforce a 30-minute cooldown between telemetry pushes per user. Uses KV with TTL-based expiration.

**Implementation Details**

File: `packages/sync-server/src/codeguard/telemetry-handlers.ts` (lines 62, 103-114, 209-211)

```typescript
const RATE_LIMIT_SECONDS = 30 * 60; // 30 minutes

// Check
const rateLimitKey = `codeguard:telemetry:rate:${authCtx.userId}`;
const lastPush = await env.REGISTRY_KV.get(rateLimitKey);
if (lastPush) {
  const elapsed = Date.now() - new Date(lastPush).getTime();
  if (elapsed < RATE_LIMIT_SECONDS * 1000) {
    const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - elapsed) / 1000);
    return errorResponse(429, 'rate_limited', 'Telemetry push rate limited', {
      retry_after_seconds: retryAfter,
    });
  }
}

// Set (after successful processing)
await env.REGISTRY_KV.put(rateLimitKey, new Date().toISOString(), {
  expirationTtl: RATE_LIMIT_SECONDS,
});
```

**Acceptance Criteria**

- [x] First push succeeds
- [x] Immediate second push returns 429 with `retry_after_seconds`
- [x] Rate limit key auto-expires via KV `expirationTtl`

**Files**

- `packages/sync-server/src/codeguard/telemetry-handlers.ts`

**Estimated Effort**: S (Small)

---

### Task 6: Public Read Endpoints (sync-server)

**Description**

Two public (no auth required) read endpoints serve the curated and popular lists to all clients.

**Prerequisites/Inputs**

- REGISTRY_KV namespace binding on sync-server
- Data written by admin-server (curated) and telemetry ingestion (popular)

**Implementation Details**

File created: `packages/sync-server/src/codeguard/public-handlers.ts`

Two handler functions:
- `handleGetCurated(env)` -- reads `codeguard:curated` from KV
- `handleGetPopular(env, url)` -- reads `codeguard:popular` from KV

**Files**

- `packages/sync-server/src/codeguard/public-handlers.ts` (128 lines)
- `packages/sync-server/src/__tests__/codeguard-public.test.ts` (10 tests)

**Estimated Effort**: S (Small)

---

### Task 7: Curated Rules Handler

**Description**

`GET /api/codeguard/curated` serves the admin-curated recommended rules list. No auth required. Filters out disabled rules and sorts by `order` field for display.

**Implementation Details**

File: `packages/sync-server/src/codeguard/public-handlers.ts` (lines 62-79)

```typescript
export async function handleGetCurated(env: Env): Promise<Response> {
  const raw = await env.REGISTRY_KV.get('codeguard:curated');
  if (!raw) {
    return jsonResponse(200, { version: 0, updated: null, rules: [] });
  }
  const data = JSON.parse(raw) as CuratedRulesData;
  const rules = data.rules
    .filter(r => r.enabled)
    .sort((a, b) => a.order - b.order);
  return jsonResponse(200, { version: data.version, updated: data.updated, rules });
}
```

Types mirrored from admin-server:
- `CuratedRulesData`: `{ version, updated, updated_by, rules[] }`
- Each rule has: `id, description, severity, enabled, file_patterns, patterns, exclude_patterns, suggestion, order`

**Acceptance Criteria**

- [x] Returns empty array when KV has no curated data
- [x] Returns rules sorted by `order` ascending
- [x] Filters out disabled rules (`enabled: false`)
- [x] Returns version and updated timestamp

**Files**

- `packages/sync-server/src/codeguard/public-handlers.ts` (lines 15-79)

**Estimated Effort**: S (Small)

---

### Task 8: Popular Rules Handler

**Description**

`GET /api/codeguard/popular` serves the telemetry-driven popular rules list. No auth required. Excludes hidden entries (admin-only). Supports `?category=` filter and `?limit=` parameter. Sorted by `total_installs` descending.

**Implementation Details**

File: `packages/sync-server/src/codeguard/public-handlers.ts` (lines 85-127)

```typescript
export async function handleGetPopular(env: Env, url: URL): Promise<Response> {
  const raw = await env.REGISTRY_KV.get('codeguard:popular');
  if (!raw) {
    return jsonResponse(200, { updated: null, rules: [] });
  }
  const data = JSON.parse(raw) as PopularRulesData;

  let rules = data.rules.filter(r => !r.hidden);

  // Optional category filter
  const category = url.searchParams.get('category');
  if (category) {
    rules = rules.filter(r => (r.rule as Record<string, unknown>).category === category);
  }

  // Sort by total_installs descending
  rules.sort((a, b) => b.total_installs - a.total_installs);

  // Optional limit
  const limitStr = url.searchParams.get('limit');
  if (limitStr) {
    const limit = parseInt(limitStr);
    if (limit > 0) rules = rules.slice(0, limit);
  }

  // Strip hidden field from response
  return jsonResponse(200, {
    updated: data.updated,
    rules: rules.map(r => ({
      rule: r.rule, total_installs: r.total_installs, total_blocks: r.total_blocks,
      first_seen: r.first_seen, last_updated: r.last_updated,
    })),
  });
}
```

**Acceptance Criteria**

- [x] Returns empty array when KV has no popular data
- [x] Returns non-hidden rules sorted by installs descending
- [x] Excludes hidden rules from public response
- [x] Supports `?category=` filter
- [x] Supports `?limit=` parameter
- [x] Strips `hidden` field from public response

**Files**

- `packages/sync-server/src/codeguard/public-handlers.ts` (lines 85-127)

**Estimated Effort**: S (Small)

---

### Task 9: Daemon RuleRegistry -- Server-Backed Discovery

**Description**

The daemon-side `RuleRegistry` class provides rule discovery with two modes: server-backed (when `serverUrl` is configured) and local-file fallback. The server mode fetches from the sync-server public endpoints with 1-hour cache TTL.

**Prerequisites/Inputs**

- Tasks 7-8 (public endpoints serving data)
- Existing `RuleManager` and `CodeguardRule` types in daemon

**Implementation Details**

File: `packages/daemon/src/codeguard/rule-registry.ts` (239 lines)

The `RuleRegistry` class provides:

1. **Constructor**: Takes `registryPath` (local JSON) and optional `{ serverUrl }` for server-backed mode
2. **`curated(options?)`**: Fetches from `${serverUrl}/api/codeguard/registry/curated` with 1h cache, falls back to local file (filtered by `curated: true`)
3. **`popular(options?)`**: Fetches from `${serverUrl}/api/codeguard/registry/popular` with 1h cache, falls back to local file (all rules sorted by installs)
4. **`search(term, options?)`**: Local-only full-text search across id, description, category, tags
5. **`categories()`**: Returns unique sorted category list from local registry
6. **`get(id)`**: Single rule lookup by id
7. **`toLocalRule(registryRule)`**: Strips registry metadata (`category`, `tags`, `curated`, `installs`) for install

Types:
```typescript
export interface RegistryRule extends CodeguardRule {
  category: string;
  tags: string[];
  curated: boolean;
  installs: number;
}

export interface RegistryFile {
  version: number;
  updated: string;
  rules: RegistryRule[];
}
```

Server cache structure:
```typescript
private serverCache: {
  curated?: { data: RegistryRule[]; fetchedAt: number };
  popular?: { data: RegistryRule[]; fetchedAt: number };
} = {};
private cacheTtlMs = 3_600_000; // 1 hour
```

**Acceptance Criteria**

- [x] Loads registry from local JSON file
- [x] Caches loaded data (same reference on repeated calls)
- [x] `clearCache()` forces reload on next access
- [x] `curated()` returns only `curated: true` rules sorted by installs
- [x] `popular()` returns all rules sorted by installs
- [x] Category and limit filters work
- [x] Search matches id, description, tags, and category (case-insensitive)
- [x] `get(id)` returns single rule or undefined
- [x] `toLocalRule()` strips `category`, `tags`, `curated`, `installs`
- [x] `count()` returns total number of rules
- [x] Server fetch with 1h cache TTL (when serverUrl configured)
- [x] Fallback to local file on server error

**Files**

- `packages/daemon/src/codeguard/rule-registry.ts` (239 lines)
- `packages/daemon/src/__tests__/codeguard-rule-registry.test.ts` (15 tests)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 10: ViolationTracker -- getSnapshot() for Telemetry

**Description**

Add a `getSnapshot()` method to the `ViolationTracker` class that returns a telemetry-ready array of rule IDs and their cumulative block counts. This is the data source for the `TelemetrySender` payload.

**Prerequisites/Inputs**

- Existing ViolationTracker with per-rule stats tracking

**Implementation Details**

File: `packages/daemon/src/codeguard/violation-tracker.ts` (lines 148-154)

```typescript
getSnapshot(): Array<{ id: string; blocks: number }> {
  const result: Array<{ id: string; blocks: number }> = [];
  for (const [id, stats] of this.stats) {
    result.push({ id, blocks: stats.total });
  }
  return result;
}
```

This method iterates the internal `stats` Map (populated by `recordViolation`) and extracts only rule IDs and total counts -- no file paths, timestamps, or other PII.

**Acceptance Criteria**

- [x] Returns array of `{ id, blocks }` for each tracked rule
- [x] Block count matches the `total` from per-rule stats
- [x] No file paths or PII in the snapshot output

**Files**

- `packages/daemon/src/codeguard/violation-tracker.ts` (lines 148-154)

**Estimated Effort**: S (Small)

---

### Task 11: Daemon TelemetrySender -- Periodic Push

**Description**

The `TelemetrySender` class periodically sends rule usage stats to the sync-server. It respects user consent (enable/disable toggle), deduplicates payloads by comparing with the last successfully sent snapshot, and uses `setInterval` for periodic execution.

**Prerequisites/Inputs**

- Task 10 (ViolationTracker.getSnapshot)
- Task 3 (telemetry ingestion endpoint)

**Implementation Details**

File: `packages/daemon/src/codeguard/telemetry-sender.ts` (203 lines)

Key design decisions:

1. **Consent-gated**: `setEnabled(enabled)` controls whether `sendNow()` actually sends. Disabled by default.
2. **Deduplication**: `snapshotsEqual(a, b)` compares rules arrays element-by-element (ignoring `sent_at`). Identical payloads are not resent.
3. **Periodic timer**: `start(ruleManager, violationTracker)` sets up `setInterval` at configurable interval (default 1 hour). `stop()` clears the interval.
4. **Auth token management**: `setAuthToken(token)` updates the JWT used in the Authorization header.
5. **Payload building**: `buildPayload(rules, stats)` maps `layer` to `scope` and joins with violation counts.
6. **Error handling**: Network errors and non-OK responses are caught and returned as `{ success: false, error: string }`.

```typescript
export interface TelemetryConfig {
  serverUrl: string;
  intervalMs?: number;    // default: 3_600_000 (1 hour)
  authToken?: string;
}

export interface TelemetrySnapshot {
  rules: Array<{ id: string; scope: "global" | "project"; blocks: number }>;
  sent_at: string;
}
```

Duck-typed dependency interfaces for decoupling:
```typescript
export interface TelemetryRuleManager {
  listRules(projectDir?: string): Promise<Array<{ id: string; layer: string }>>;
}
export interface TelemetryViolationTracker {
  getStats(): Map<string, { total: number }>;
}
```

**Acceptance Criteria**

- [x] `buildPayload` creates correct structure from rules + stats
- [x] `buildPayload` maps layer `"global"` to scope `"global"` and `"project"` to `"project"`
- [x] `buildPayload` handles rules with no violations (`blocks: 0`)
- [x] `sendNow` sends POST with correct payload and auth header
- [x] `sendNow` skips send if payload unchanged from last snapshot
- [x] `sendNow` includes auth token in Authorization header
- [x] `sendNow` returns error on failed request or network error
- [x] `setEnabled(false)` prevents sending (returns error message)
- [x] Disabled by default (no explicit `setEnabled(true)` means no sends)
- [x] `start`/`stop` manage interval timer correctly
- [x] `start` called twice does not create duplicate timers
- [x] `setAuthToken` updates token used in subsequent requests
- [x] `getLastSnapshot` returns null before any send, snapshot after successful send

**Files**

- `packages/daemon/src/codeguard/telemetry-sender.ts` (203 lines)
- `packages/daemon/src/__tests__/codeguard-telemetry-sender.test.ts` (15 tests)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 12: Admin Server -- Worker Entry Point & Authentication

**Description**

The admin-server is a separate Cloudflare Worker that manages codeguard curated rules, popular list moderation, and user roles. It shares `AUTH_KV` and `REGISTRY_KV` with sync-server. All `/api/admin/*` routes require admin authentication.

**Note**: While the admin-server was formally scoped as Story 15, it was implemented concurrently with Story 14 because the curated rules CRUD and popular moderation are integral to the registry system.

**Prerequisites/Inputs**

- Task 1 (REGISTRY_KV shared namespace)
- Sync-server JWT implementation (reused/copied for admin-server)

**Implementation Details**

**Environment Bindings** (`packages/admin-server/src/types.ts`):

```typescript
export interface AdminEnv {
  AUTH_KV: KVNamespace;      // Shared — user records, login verification
  REGISTRY_KV: KVNamespace;  // Shared — codeguard curated/popular data
  JWT_SECRET: string;        // Same secret as sync-server
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;      // "saqr-admin" (separate from sync-server)
  ALLOWED_ORIGINS: string;
}
```

**Admin Authentication** (`packages/admin-server/src/auth/admin-auth.ts`):

Three-step verification:
1. Verify JWT (HS256, same secret as sync-server)
2. Look up user in `AUTH_KV` by userId (`userid:{userId}` -> email -> `user:{email}`)
3. Check `role === "admin"` on the KV record (authoritative source, not JWT claim)

This means even if a JWT has `role: "admin"`, the server checks the current KV record -- so demoted users are immediately locked out.

**Worker Router** (`packages/admin-server/src/worker.ts`):

Routes:
```
GET  /api/health                              -> Health check (no auth)
GET  /api/admin/codeguard/curated             -> List curated rules
POST /api/admin/codeguard/curated             -> Add curated rule
PUT  /api/admin/codeguard/curated/:id         -> Update curated rule
DELETE /api/admin/codeguard/curated/:id       -> Delete curated rule
GET  /api/admin/codeguard/popular             -> List popular rules (including hidden)
POST /api/admin/codeguard/popular/:id/hide    -> Hide popular rule
POST /api/admin/codeguard/popular/:id/unhide  -> Unhide popular rule
GET  /api/admin/users                         -> List users
GET  /api/admin/users/:id                     -> Get user details
POST /api/admin/users/:id/promote             -> Promote to admin
POST /api/admin/users/:id/demote              -> Demote to user
```

Security features:
- Body size limit: 1 MB for mutations (POST/PUT/PATCH)
- CORS with configurable allowed origins
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Cache-Control: no-store`

**Acceptance Criteria**

- [x] Valid admin JWT returns authCtx with userId, email, role
- [x] Non-admin JWT returns 403 `forbidden`
- [x] Missing Authorization header returns 401
- [x] Expired JWT returns 401
- [x] Malformed JWT returns 401
- [x] Revoked admin role (KV updated after JWT issued) returns 403
- [x] Health endpoint requires no auth
- [x] All `/api/admin/*` routes require admin auth

**Files**

- `packages/admin-server/src/types.ts` (120 lines)
- `packages/admin-server/src/auth/admin-auth.ts` (93 lines)
- `packages/admin-server/src/auth/jwt.ts` (167 lines -- HS256 sign/verify)
- `packages/admin-server/src/worker.ts` (174 lines)
- `packages/admin-server/src/helpers.ts` (155 lines)
- `packages/admin-server/src/__tests__/admin-auth.test.ts` (6 tests)
- `packages/admin-server/src/__tests__/helpers/mock-env.ts` (235 lines)

**Estimated Effort**: L (Large) -- 8-12 hours

---

### Task 13: Admin Curated Rules CRUD

**Description**

Full CRUD for the curated rules list. Rules are stored in `REGISTRY_KV` at key `codeguard:curated` as a versioned document. Each mutation increments the version number.

**Implementation Details**

File: `packages/admin-server/src/codeguard/curated-handlers.ts` (221 lines)

**KV Data Structure**:
```typescript
interface CuratedRulesData {
  version: number;      // Incremented on each mutation
  updated: string;      // ISO 8601 timestamp
  updated_by: string;   // userId of the admin who made the change
  rules: CuratedRule[];
}

interface CuratedRule {
  id: string;            // kebab-case, 1-64 chars
  description: string;
  severity: 'block' | 'warn';
  enabled: boolean;
  file_patterns: string[];
  patterns: string[];    // validated as valid regex
  exclude_patterns: string[];
  suggestion: string;
  order: number;         // display ordering
  added_at: string;
  added_by: string;      // admin userId
}
```

**Handlers**:

1. **`handleListCurated(env)`** -- GET: Returns all rules with version info
2. **`handleAddCurated(request, env, authCtx)`** -- POST: Validates body (kebab-case id, valid regex patterns, required fields), checks for duplicate id (409), auto-assigns order, sets `added_at`/`added_by`, increments version
3. **`handleUpdateCurated(request, env, authCtx, ruleId)`** -- PUT: Partial update, validates patterns if provided, returns 404 for nonexistent rules, increments version
4. **`handleDeleteCurated(env, authCtx, ruleId)`** -- DELETE: Removes rule by id, returns 404 if not found, increments version

**Validation** (`validateRule` function):
- `id`: kebab-case regex `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`, 1-64 chars
- `description`: non-empty string
- `severity`: `"block"` or `"warn"`
- `file_patterns`: non-empty array
- `patterns`: non-empty array, each validated as valid regex via `new RegExp()`
- `exclude_patterns`: optional array of strings
- `suggestion`: non-empty string

**Acceptance Criteria**

- [x] List returns empty array when no rules exist
- [x] Add creates rule with 201, sets `added_by`, `added_at`
- [x] Add rejects duplicate id with 409
- [x] Add rejects invalid regex with 400
- [x] Add rejects missing required fields with 400
- [x] Add rejects non-kebab-case id with 400
- [x] Update modifies existing rule, preserves unchanged fields
- [x] Update returns 404 for nonexistent rule
- [x] Delete removes rule and returns 200
- [x] Delete returns 404 for nonexistent rule
- [x] Version increments on each mutation (add, update, delete)

**Files**

- `packages/admin-server/src/codeguard/curated-handlers.ts` (221 lines)
- `packages/admin-server/src/__tests__/curated-handlers.test.ts` (14 tests)

**Estimated Effort**: M (Medium) -- 4-6 hours

---

### Task 14: Admin Popular Rules Moderation

**Description**

Admins can hide and unhide entries in the popular list. Hidden entries are excluded from the public endpoint but remain visible to admins. The popular list is read from the same `codeguard:popular` KV key written by the telemetry ingestion.

**Implementation Details**

File: `packages/admin-server/src/codeguard/popular-handlers.ts` (86 lines)

**Handlers**:

1. **`handleListPopular(env)`** -- GET: Returns ALL rules (including hidden) with `total` and `hidden_count` summary
2. **`handleHidePopular(env, ruleId)`** -- POST: Sets `hidden: true` on the matching rule entry
3. **`handleUnhidePopular(env, ruleId)`** -- POST: Sets `hidden: false` on the matching rule entry

All three handlers update the `updated` timestamp on mutation.

**Acceptance Criteria**

- [x] List returns empty when no popular data in KV
- [x] List returns ALL rules including hidden (admin view)
- [x] List includes `total` and `hidden_count` counts
- [x] Hide sets `hidden: true` and persists to KV
- [x] Unhide sets `hidden: false` and persists to KV
- [x] Hide/unhide return 404 for nonexistent rule
- [x] Hidden rules are excluded by the public endpoint (sync-server side)

**Files**

- `packages/admin-server/src/codeguard/popular-handlers.ts` (86 lines)
- `packages/admin-server/src/__tests__/popular-handlers.test.ts` (6 tests)

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 15: Admin User Management

**Description**

Admins can list users, view user details, and promote/demote users between `user` and `admin` roles. User records are stored in `AUTH_KV` (shared with sync-server).

**Implementation Details**

File: `packages/admin-server/src/users/user-handlers.ts` (166 lines)

**KV Layout** (shared with sync-server):
- `user:{email}` -> `KVUserRecord` (includes optional `role` field)
- `userid:{userId}` -> email (lookup key)

**Handlers**:

1. **`handleListUsers(env, url)`** -- GET: Paginated via KV `list()` with `?limit=` and `?cursor=`, returns user summary (userId, email, tier, role, createdAt)
2. **`handleGetUser(env, userId)`** -- GET: Looks up by userId via `userid:{id}` -> email -> `user:{email}`
3. **`handlePromoteUser(env, userId)`** -- POST: Sets `role: "admin"` on KV record
4. **`handleDemoteUser(env, userId)`** -- POST: Sets `role: "user"` on KV record

**Acceptance Criteria**

- [x] List returns seeded users with correct roles
- [x] Get returns user details by userId
- [x] Get returns 404 for nonexistent user
- [x] Promote sets role to `"admin"` and persists in KV
- [x] Promote returns 404 for nonexistent user
- [x] Demote sets role to `"user"` and persists in KV
- [x] Demote returns 404 for nonexistent user

**Files**

- `packages/admin-server/src/users/user-handlers.ts` (166 lines)
- `packages/admin-server/src/__tests__/user-handlers.test.ts` (5 tests)

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 16: Module Exports & Index

**Description**

Update the daemon codeguard module index to export the new `TelemetrySender` class and types alongside existing exports.

**Implementation Details**

File: `packages/daemon/src/codeguard/index.ts` (36 lines)

Added exports:
```typescript
export {
  TelemetrySender,
  type TelemetryConfig,
  type TelemetrySnapshot,
} from "./telemetry-sender.js";
```

Existing exports preserved:
- `RuleManager`, `CodeguardRule`, `CodeguardRulesFile`, `RuleSeverity`, `RuleLayer`, `MergedRule`
- `ViolationTracker`, `ViolationRecord`, `RuleStats`
- `RuleRegistry`, `RegistryRule`, `RegistryFile`, `BrowseOptions`

**Files**

- `packages/daemon/src/codeguard/index.ts`

**Estimated Effort**: XS (Trivial)

---

## KV Storage Layout (REGISTRY_KV)

| Key Pattern | Written By | Read By | Content | TTL |
|---|---|---|---|---|
| `codeguard:curated` | admin-server (CRUD) | sync-server (public read), daemon (fetch) | `CuratedRulesData` with versioned rule array | None |
| `codeguard:popular` | sync-server (telemetry aggregation) | sync-server (public read), admin-server (moderation), daemon (fetch) | `PopularRulesData` with aggregate counts + hidden flags | None |
| `codeguard:telemetry:{userId}` | sync-server (telemetry ingestion) | sync-server (delta computation) | `UserSnapshot` with per-user rule list + timestamp | None |
| `codeguard:telemetry:rate:{userId}` | sync-server (rate limiter) | sync-server (rate check) | ISO 8601 timestamp of last push | 30 min (expirationTtl) |

---

## Privacy Checklist

- [x] Telemetry contains only rule IDs, scope, block counts -- no PII
- [x] No file paths, project names, or content in telemetry payload
- [x] Per-user snapshots stored only for delta dedup, keyed by userId
- [x] Consent is explicit opt-in (Art. 7), default false
- [x] `TelemetrySender.setEnabled(false)` immediately stops sending
- [x] Popular list aggregation is anonymous (no user attribution in public response)
- [x] `ViolationTracker.getSnapshot()` extracts only rule IDs and counts

---

## Test Summary

### sync-server (40 tests related to codeguard)

| Test File | Tests | Coverage |
|---|---|---|
| `codeguard-public.test.ts` | 7 | Curated: empty KV, sorted by order, disabled filtered. Popular: empty KV, sorted by installs, hidden excluded, category filter, limit |
| `codeguard-telemetry.test.ts` | 11 | Validation: valid payload, invalid JSON, missing rules, missing id, invalid scope. Delta: first send, block delta only, rule removal. Rate limit: 30 min window |
| `consent-manager.test.ts` | 22 | Includes `rule_telemetry` category in consent CRUD (positional param[4]) |

### admin-server (31 tests)

| Test File | Tests | Coverage |
|---|---|---|
| `curated-handlers.test.ts` | 14 | List (empty, after add). Add (valid, duplicate 409, invalid regex, missing fields, invalid id). Update (existing, nonexistent). Delete (existing, nonexistent). Version tracking |
| `popular-handlers.test.ts` | 6 | List (empty, all including hidden). Hide (existing, nonexistent). Unhide (existing, nonexistent) |
| `admin-auth.test.ts` | 6 | Valid admin JWT, non-admin 403, missing header 401, expired 401, malformed 401, revoked role 403 |
| `user-handlers.test.ts` | 5 | List users, get details, get nonexistent 404, promote, demote |

### daemon (15 tests related to codeguard registry/telemetry)

| Test File | Tests | Coverage |
|---|---|---|
| `codeguard-rule-registry.test.ts` | 15 | Load (file, cache, clearCache). Curated (filter, sort, category). Popular (sort, limit, category). Search (id, tag, description, category, no match, case-insensitive). Categories. Get. toLocalRule. Count |
| `codeguard-telemetry-sender.test.ts` | 15 | buildPayload (structure, scope mapping, zero blocks). sendNow (POST, dedup, auth header, error, network error). setEnabled (disabled default, disable after enable). start/stop (timer, no duplicates). setAuthToken. getLastSnapshot |

**Total: 86 tests passing**

---

## File Inventory

### New Files Created

| File | Package | Lines | Purpose |
|---|---|---|---|
| `src/codeguard/telemetry-handlers.ts` | sync-server | 217 | Telemetry ingestion, delta computation, popular aggregation |
| `src/codeguard/public-handlers.ts` | sync-server | 128 | Public read endpoints for curated and popular lists |
| `src/__tests__/codeguard-telemetry.test.ts` | sync-server | 295 | Telemetry handler tests |
| `src/__tests__/codeguard-public.test.ts` | sync-server | 229 | Public handler tests |
| `src/codeguard/rule-registry.ts` | daemon | 239 | Server-backed rule discovery with local fallback |
| `src/codeguard/telemetry-sender.ts` | daemon | 203 | Periodic telemetry push with dedup |
| `src/__tests__/codeguard-rule-registry.test.ts` | daemon | 289 | Registry tests |
| `src/__tests__/codeguard-telemetry-sender.test.ts` | daemon | 377 | Telemetry sender tests |
| `src/index.ts` | admin-server | -- | Package entry point |
| `src/types.ts` | admin-server | 120 | AdminEnv, AuthContext, CuratedRule, PopularRuleEntry types |
| `src/helpers.ts` | admin-server | 155 | JSON/error responses, CORS, security headers, validation |
| `src/worker.ts` | admin-server | 174 | Worker entry point and router |
| `src/auth/admin-auth.ts` | admin-server | 93 | JWT verification + admin role check from KV |
| `src/auth/jwt.ts` | admin-server | 167 | HS256 JWT sign/verify (Web Crypto API) |
| `src/codeguard/curated-handlers.ts` | admin-server | 221 | Curated rules CRUD |
| `src/codeguard/popular-handlers.ts` | admin-server | 86 | Popular rules hide/unhide moderation |
| `src/users/user-handlers.ts` | admin-server | 166 | User list, details, promote, demote |
| `src/__tests__/curated-handlers.test.ts` | admin-server | 251 | Curated CRUD tests |
| `src/__tests__/popular-handlers.test.ts` | admin-server | 181 | Popular moderation tests |
| `src/__tests__/admin-auth.test.ts` | admin-server | 142 | Admin auth tests |
| `src/__tests__/user-handlers.test.ts` | admin-server | 144 | User management tests |
| `src/__tests__/helpers/mock-env.ts` | admin-server | 235 | Mock KV, env, requests, tokens, user seeding |

### Modified Files

| File | Package | Changes |
|---|---|---|
| `src/middleware/consent-manager.ts` | sync-server | Added `rule_telemetry` to ConsentCategory, ConsentPreferences, DEFAULT_CONSENT, DDL, UPSERT, validCategories |
| `src/codeguard/violation-tracker.ts` | daemon | Added `getSnapshot()` method (lines 148-154) |
| `src/codeguard/index.ts` | daemon | Added TelemetrySender exports |
