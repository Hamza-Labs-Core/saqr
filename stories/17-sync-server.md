# Story 17: Sync Server (Cloudflare Edge)

## Overview

The Sync Server is the **cloud infrastructure layer** of the AgentContext platform, providing zero-knowledge encrypted sync across machines via Cloudflare's edge network. It consists of a Cloudflare Worker API layer that routes authenticated requests to per-user Durable Objects, which maintain SQLite metadata stores and WebSocket hubs for real-time sync notifications. Encrypted event blobs are stored in R2 with per-user key prefix isolation.

The server never sees plaintext user data. All event content arrives pre-encrypted by the client (F10: Security & Encryption). The server stores opaque encrypted blobs and manages only cleartext metadata: machine registry, sync cursors, usage counters, and account state. This zero-knowledge architecture means a server breach exposes nothing of value -- encrypted blobs without keys are noise.

**Guiding principle**: The server is a dumb pipe with access control. It authenticates users, enforces tier limits, routes encrypted blobs, and tracks sync positions. All intelligence (encryption, decryption, event interpretation) lives on the client.

---

## Scope

### In Scope

- Cloudflare Worker API layer (JWT auth, rate limiting, routing)
- Per-user Durable Object with SQLite metadata store
- R2 encrypted blob storage with per-user key prefix isolation
- Machine registry and device limit enforcement
- Per-machine sync cursor tracking
- WebSocket real-time notifications for connected clients
- Usage aggregation (cleartext metadata only: token counts, event counts)
- Account management (registration, authentication, tier management)
- Crypto-shredding (account deletion = permanent data loss)
- EU data residency via Cloudflare jurisdiction hints
- Tier enforcement (storage quotas, sync frequency, device limits)
- Web portal for account management (no data viewing)
- Wrangler configuration and deployment

### Out of Scope (Non-Goals)

- Client-side encryption/decryption logic (F10: Security & Encryption)
- Mobile app UI (F13: CLI Session Rendering)
- Desktop app (Tauri)
- E2EE relay for live session streaming (Paseo's existing relay)
- Payment processing integration (Stripe/Paddle -- separate story)
- Email delivery infrastructure (delegated to transactional email service)
- CDN configuration for static assets
- Load testing and capacity planning (separate operational story)
- GDPR compliance documentation (F11, though technical mechanisms are here)

---

## Requirements

### 1. Worker API Layer (F9.1)

The Worker is the entry point for all client requests. It handles authentication, rate limiting, and routes requests to the appropriate per-user Durable Object.

#### Wrangler Configuration

```toml
# wrangler.toml
name = "agentctx-sync"
main = "src/worker.ts"
compatibility_date = "2026-02-01"
compatibility_flags = ["nodejs_compat"]

[placement]
mode = "smart"

[[r2_buckets]]
binding = "EVENTS_BUCKET"
bucket_name = "agentctx-events"

[[r2_buckets]]
binding = "EVENTS_BUCKET_EU"
bucket_name = "agentctx-events-eu"
jurisdiction = "eu"

[durable_objects]
bindings = [
  { name = "USER_DO", class_name = "UserDurableObject" },
  { name = "USER_DO_EU", class_name = "UserDurableObject", script_name = "agentctx-sync-eu" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserDurableObject"]

[vars]
JWT_ISSUER = "agentctx"
JWT_AUDIENCE = "agentctx-sync"
FREE_TIER_STORAGE_BYTES = "52428800"        # 50 MB
PRO_TIER_STORAGE_BYTES = "1073741824"       # 1 GB
TEAM_TIER_STORAGE_BYTES = "10737418240"     # 10 GB
FREE_TIER_MACHINES = "2"
PRO_TIER_MACHINES = "5"
TEAM_TIER_MACHINES = "0"                    # 0 = unlimited
FREE_TIER_SYNC_RATE = "10"                  # per hour
FREE_TIER_RETENTION_DAYS = "30"
PRO_TIER_RETENTION_DAYS = "365"
TEAM_TIER_RETENTION_DAYS = "0"              # 0 = unlimited

[[kv_namespaces]]
binding = "AUTH_KV"
id = "auth-kv-id"

[env.production]
routes = [
  { pattern = "sync.agentctx.dev/*", zone_name = "agentctx.dev" }
]

[env.staging]
routes = [
  { pattern = "sync-staging.agentctx.dev/*", zone_name = "agentctx.dev" }
]
```

#### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Create new account |
| POST | `/api/auth/login` | None | Authenticate, receive JWT |
| POST | `/api/auth/refresh` | Refresh token | Refresh access token |
| POST | `/api/auth/verify-email` | None | Verify email address |
| POST | `/api/sync/push` | JWT | Push encrypted events |
| POST | `/api/sync/pull` | JWT | Pull encrypted events since cursor |
| GET | `/api/sync/stream` | JWT | WebSocket upgrade for real-time sync |
| GET | `/api/account` | JWT | Get account details |
| PATCH | `/api/account` | JWT | Update account settings |
| DELETE | `/api/account` | JWT | Delete account (crypto-shred) |
| GET | `/api/account/usage` | JWT | Get usage statistics |
| GET | `/api/machines` | JWT | List registered machines |
| POST | `/api/machines` | JWT | Register a new machine |
| DELETE | `/api/machines/:id` | JWT | Remove a machine |
| GET | `/api/health` | None | Health check |

#### Middleware Chain

Every authenticated request passes through a middleware chain before reaching the Durable Object:

```typescript
// src/middleware.ts

export interface Env {
  USER_DO: DurableObjectNamespace;
  USER_DO_EU: DurableObjectNamespace;
  EVENTS_BUCKET: R2Bucket;
  EVENTS_BUCKET_EU: R2Bucket;
  AUTH_KV: KVNamespace;
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
}

export interface AuthContext {
  userId: string;
  email: string;
  tier: "free" | "pro" | "team";
  jurisdiction: "default" | "eu";
  machineId?: string;
}

type Middleware = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authCtx: AuthContext | null
) => Promise<Response | null>;

// Chain: JWT verify -> rate limit -> tier check -> route to DO
export const middlewareChain: Middleware[] = [
  jwtVerifyMiddleware,
  rateLimitMiddleware,
  tierCheckMiddleware,
];

async function jwtVerifyMiddleware(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  _authCtx: AuthContext | null
): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "missing_token", message: "Authorization header required" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    // Attach auth context to request — consumed by downstream middleware
    // Return null to continue chain
    return null;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "invalid_token", message: "Token expired or invalid" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function rateLimitMiddleware(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  authCtx: AuthContext | null
): Promise<Response | null> {
  if (!authCtx) return null;

  if (authCtx.tier === "free") {
    const key = `ratelimit:${authCtx.userId}:${currentHourKey()}`;
    const count = parseInt((await env.AUTH_KV.get(key)) || "0");
    const limit = parseInt(env.FREE_TIER_SYNC_RATE as unknown as string);

    if (count >= limit) {
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: "Free tier sync limit reached (10/hour). Upgrade to Pro for unlimited sync.",
          retry_after: secondsUntilNextHour(),
          upgrade_url: "https://agentctx.dev/pricing",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(secondsUntilNextHour()),
          },
        }
      );
    }
  }

  return null; // Continue chain
}

async function tierCheckMiddleware(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  authCtx: AuthContext | null
): Promise<Response | null> {
  if (!authCtx) return null;

  const url = new URL(request.url);

  // WebSocket streaming is Pro+ only
  if (url.pathname === "/api/sync/stream" && authCtx.tier === "free") {
    return new Response(
      JSON.stringify({
        error: "tier_restricted",
        message: "Real-time sync requires Pro or Team tier. Free tier uses polling only.",
        upgrade_url: "https://agentctx.dev/pricing",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  return null; // Continue chain
}
```

#### Worker Entry Point

```typescript
// src/worker.ts

import { Env, AuthContext, middlewareChain } from "./middleware";
import { UserDurableObject } from "./durable-object";

export { UserDurableObject };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check -- no auth required
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Public auth endpoints -- no middleware chain
    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      return handleRegister(request, env);
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/verify-email" && request.method === "POST") {
      return handleVerifyEmail(request, env);
    }
    if (url.pathname === "/api/auth/refresh" && request.method === "POST") {
      return handleRefresh(request, env);
    }

    // All other endpoints require authentication -- run middleware chain
    let authCtx: AuthContext | null = null;
    for (const mw of middlewareChain) {
      const response = await mw(request, env, ctx, authCtx);
      if (response) return response; // Middleware rejected the request
      if (!authCtx) {
        // First middleware (JWT verify) populates authCtx
        authCtx = await extractAuthContext(request, env);
      }
    }

    if (!authCtx) {
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Route to per-user Durable Object
    const doNamespace =
      authCtx.jurisdiction === "eu" ? env.USER_DO_EU : env.USER_DO;
    const doId = doNamespace.idFromName(authCtx.userId);
    const doStub = doNamespace.get(doId);

    // Forward request to DO with auth context in header
    const doRequest = new Request(request.url, request);
    doRequest.headers.set("X-Auth-Context", JSON.stringify(authCtx));

    return doStub.fetch(doRequest);
  },
};
```

#### Request/Response Formats

**POST /api/auth/register**

Request:
```json
{
  "email": "user@example.com",
  "password": "min-12-chars-required",
  "jurisdiction": "default"
}
```

Response (201):
```json
{
  "user_id": "usr_a1b2c3d4e5f6",
  "email": "user@example.com",
  "tier": "free",
  "jurisdiction": "default",
  "email_verified": false,
  "message": "Verification email sent. Check your inbox."
}
```

**POST /api/auth/login**

Request:
```json
{
  "email": "user@example.com",
  "password": "min-12-chars-required"
}
```

Response (200):
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "rt_a1b2c3d4e5f6...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": {
    "user_id": "usr_a1b2c3d4e5f6",
    "email": "user@example.com",
    "tier": "free",
    "jurisdiction": "default",
    "machines_count": 1,
    "storage_used_bytes": 12345678
  }
}
```

**POST /api/sync/push**

Request:
```json
{
  "machine_id": "mach_x1y2z3",
  "events": [
    {
      "project_id": "my-project-a3f7b2",
      "session_id": "abc123-def456",
      "sequence": 42,
      "timestamp": "2026-02-14T10:30:00.000Z",
      "event_type": "ToolCallCompleted",
      "encrypted_blob_sha256": "a1b2c3d4...",
      "encrypted_size_bytes": 4096,
      "metadata": {
        "token_count_input": 1500,
        "token_count_output": 800,
        "model": "claude-opus-4-6",
        "tool_name": "Bash"
      }
    }
  ],
  "blobs": {
    "a1b2c3d4...": "<base64-encoded encrypted blob>"
  }
}
```

Response (200):
```json
{
  "accepted": 1,
  "rejected": 0,
  "cursor": "cur_2026-02-14T10:30:00.000Z_42",
  "storage_used_bytes": 12349774,
  "storage_quota_bytes": 52428800
}
```

**POST /api/sync/pull**

Request:
```json
{
  "machine_id": "mach_x1y2z3",
  "cursor": "cur_2026-02-14T09:00:00.000Z_10",
  "limit": 100,
  "project_id": "my-project-a3f7b2"
}
```

Response (200):
```json
{
  "events": [
    {
      "project_id": "my-project-a3f7b2",
      "session_id": "abc123-def456",
      "sequence": 11,
      "timestamp": "2026-02-14T09:05:00.000Z",
      "event_type": "UserPromptReceived",
      "source_machine_id": "mach_a1b2c3",
      "encrypted_blob_url": "/api/sync/blob/a1b2c3d4...",
      "encrypted_size_bytes": 2048,
      "metadata": {
        "token_count_input": 500,
        "token_count_output": 0,
        "model": "claude-opus-4-6"
      }
    }
  ],
  "cursor": "cur_2026-02-14T10:30:00.000Z_42",
  "has_more": false,
  "total_pending": 0
}
```

**DELETE /api/account**

Request:
```json
{
  "confirmation": "DELETE MY ACCOUNT",
  "password": "current-password"
}
```

Response (200):
```json
{
  "deleted": true,
  "user_id": "usr_a1b2c3d4e5f6",
  "deletion_id": "del_x1y2z3w4",
  "message": "Account deleted. All encrypted data has been permanently destroyed.",
  "crypto_shredded": true
}
```

#### Acceptance Criteria

- [ ] Worker routes all API endpoints correctly
- [ ] JWT middleware rejects requests with missing or invalid tokens
- [ ] Rate limiting is enforced per-user per-hour for free tier sync endpoints
- [ ] Tier check blocks free tier users from WebSocket streaming
- [ ] Public endpoints (register, login, verify-email, health) bypass auth middleware
- [ ] Requests are routed to the correct Durable Object namespace based on jurisdiction
- [ ] Auth context is forwarded to Durable Object via request header
- [ ] All error responses follow consistent JSON format with `error` and `message` fields
- [ ] CORS headers are set for web portal access
- [ ] Request body size is limited to 10 MB per push request

---

### 2. Per-User Durable Object (F9.2)

Each user gets a single Durable Object instance that manages their metadata, sync state, and WebSocket connections. The DO uses SQLite (Durable Object storage) for structured metadata and coordinates with R2 for encrypted blob storage.

#### SQLite Schema

```sql
-- Table: machines
-- Tracks all registered machines for this user
CREATE TABLE machines (
  machine_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  os             TEXT NOT NULL,       -- 'linux', 'macos', 'windows'
  arch           TEXT NOT NULL,       -- 'x64', 'arm64'
  hostname       TEXT NOT NULL,
  registered_at  TEXT NOT NULL,       -- ISO 8601
  last_sync_at   TEXT,                -- ISO 8601, NULL if never synced
  last_seen_at   TEXT,                -- ISO 8601, updated on any request
  agent_version  TEXT,                -- e.g., '1.2.0'
  is_active      INTEGER DEFAULT 1   -- soft delete: 0 = deactivated
);

CREATE INDEX idx_machines_active ON machines(is_active);
CREATE INDEX idx_machines_last_sync ON machines(last_sync_at);

-- Table: events_meta
-- Cleartext metadata for each synced event (encrypted blob is in R2)
CREATE TABLE events_meta (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id             TEXT NOT NULL,
  project_id             TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,
  event_type             TEXT NOT NULL,
  timestamp              TEXT NOT NULL,           -- ISO 8601
  encrypted_blob_key     TEXT NOT NULL,           -- R2 key for the encrypted blob
  encrypted_blob_sha256  TEXT NOT NULL,           -- integrity check
  encrypted_size_bytes   INTEGER NOT NULL,
  token_count_input      INTEGER DEFAULT 0,
  token_count_output     INTEGER DEFAULT 0,
  model                  TEXT,
  tool_name              TEXT,
  synced_at              TEXT NOT NULL,           -- ISO 8601, when server received it
  UNIQUE(machine_id, project_id, session_id, sequence)
);

CREATE INDEX idx_events_meta_project ON events_meta(project_id, session_id, sequence);
CREATE INDEX idx_events_meta_timestamp ON events_meta(timestamp);
CREATE INDEX idx_events_meta_machine ON events_meta(machine_id, synced_at);
CREATE INDEX idx_events_meta_type ON events_meta(event_type);
CREATE INDEX idx_events_meta_synced ON events_meta(synced_at);

-- Table: sync_cursors
-- Per-machine sync position: what has each machine already pulled?
CREATE TABLE sync_cursors (
  machine_id       TEXT NOT NULL,
  source_machine_id TEXT NOT NULL,    -- which machine's events has this cursor consumed?
  last_synced_id   INTEGER NOT NULL,  -- events_meta.id of last consumed event
  last_synced_at   TEXT NOT NULL,     -- ISO 8601
  PRIMARY KEY (machine_id, source_machine_id)
);

CREATE INDEX idx_sync_cursors_machine ON sync_cursors(machine_id);

-- Table: usage_daily
-- Aggregated usage counters per day
CREATE TABLE usage_daily (
  date               TEXT NOT NULL,       -- YYYY-MM-DD
  project_id         TEXT NOT NULL,
  model              TEXT NOT NULL,
  event_count        INTEGER DEFAULT 0,
  token_count_input  INTEGER DEFAULT 0,
  token_count_output INTEGER DEFAULT 0,
  blob_bytes         INTEGER DEFAULT 0,
  PRIMARY KEY (date, project_id, model)
);

CREATE INDEX idx_usage_daily_date ON usage_daily(date);

-- Table: account
-- User account state (one row per user, stored in the user's own DO)
CREATE TABLE account (
  user_id          TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  password_hash    TEXT NOT NULL,        -- Argon2id hash
  tier             TEXT NOT NULL DEFAULT 'free',
  jurisdiction     TEXT NOT NULL DEFAULT 'default',
  email_verified   INTEGER DEFAULT 0,
  storage_used_bytes INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL,        -- ISO 8601
  updated_at       TEXT NOT NULL,        -- ISO 8601
  deleted_at       TEXT                  -- ISO 8601, NULL if active
);

-- Table: deletion_log
-- Audit trail for account deletions and crypto-shredding
CREATE TABLE deletion_log (
  deletion_id    TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  initiated_at   TEXT NOT NULL,          -- ISO 8601
  do_cleared_at  TEXT,                   -- ISO 8601
  r2_deleted_at  TEXT,                   -- ISO 8601
  kv_purged_at   TEXT,                   -- ISO 8601
  completed_at   TEXT,                   -- ISO 8601
  status         TEXT NOT NULL DEFAULT 'initiated'
    -- 'initiated', 'do_cleared', 'r2_deleting', 'r2_deleted', 'kv_purged', 'completed', 'failed'
);
```

#### Durable Object Implementation

```typescript
// src/durable-object.ts

import { DurableObject } from "cloudflare:workers";

interface Env {
  EVENTS_BUCKET: R2Bucket;
  EVENTS_BUCKET_EU: R2Bucket;
  AUTH_KV: KVNamespace;
}

interface WebSocketSession {
  machineId: string;
  connectedAt: string;
}

export class UserDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private sessions: Map<WebSocket, WebSocketSession> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        machine_id     TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        os             TEXT NOT NULL,
        arch           TEXT NOT NULL,
        hostname       TEXT NOT NULL,
        registered_at  TEXT NOT NULL,
        last_sync_at   TEXT,
        last_seen_at   TEXT,
        agent_version  TEXT,
        is_active      INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS events_meta (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id             TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        session_id             TEXT NOT NULL,
        sequence               INTEGER NOT NULL,
        event_type             TEXT NOT NULL,
        timestamp              TEXT NOT NULL,
        encrypted_blob_key     TEXT NOT NULL,
        encrypted_blob_sha256  TEXT NOT NULL,
        encrypted_size_bytes   INTEGER NOT NULL,
        token_count_input      INTEGER DEFAULT 0,
        token_count_output     INTEGER DEFAULT 0,
        model                  TEXT,
        tool_name              TEXT,
        synced_at              TEXT NOT NULL,
        UNIQUE(machine_id, project_id, session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS sync_cursors (
        machine_id        TEXT NOT NULL,
        source_machine_id TEXT NOT NULL,
        last_synced_id    INTEGER NOT NULL,
        last_synced_at    TEXT NOT NULL,
        PRIMARY KEY (machine_id, source_machine_id)
      );

      CREATE TABLE IF NOT EXISTS usage_daily (
        date               TEXT NOT NULL,
        project_id         TEXT NOT NULL,
        model              TEXT NOT NULL,
        event_count        INTEGER DEFAULT 0,
        token_count_input  INTEGER DEFAULT 0,
        token_count_output INTEGER DEFAULT 0,
        blob_bytes         INTEGER DEFAULT 0,
        PRIMARY KEY (date, project_id, model)
      );

      CREATE TABLE IF NOT EXISTS account (
        user_id          TEXT PRIMARY KEY,
        email            TEXT NOT NULL,
        password_hash    TEXT NOT NULL,
        tier             TEXT NOT NULL DEFAULT 'free',
        jurisdiction     TEXT NOT NULL DEFAULT 'default',
        email_verified   INTEGER DEFAULT 0,
        storage_used_bytes INTEGER DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        deleted_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS deletion_log (
        deletion_id    TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        initiated_at   TEXT NOT NULL,
        do_cleared_at  TEXT,
        r2_deleted_at  TEXT,
        kv_purged_at   TEXT,
        completed_at   TEXT,
        status         TEXT NOT NULL DEFAULT 'initiated'
      );

      -- Create indexes if they don't exist
      CREATE INDEX IF NOT EXISTS idx_machines_active ON machines(is_active);
      CREATE INDEX IF NOT EXISTS idx_events_meta_project ON events_meta(project_id, session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_meta_timestamp ON events_meta(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_meta_machine ON events_meta(machine_id, synced_at);
      CREATE INDEX IF NOT EXISTS idx_events_meta_synced ON events_meta(synced_at);
      CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON usage_daily(date);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authCtx: AuthContext = JSON.parse(
      request.headers.get("X-Auth-Context") || "{}"
    );

    // WebSocket upgrade
    if (url.pathname === "/api/sync/stream") {
      return this.handleWebSocketUpgrade(request, authCtx);
    }

    // Sync endpoints
    if (url.pathname === "/api/sync/push" && request.method === "POST") {
      return this.handlePush(request, authCtx);
    }
    if (url.pathname === "/api/sync/pull" && request.method === "POST") {
      return this.handlePull(request, authCtx);
    }

    // Machine endpoints
    if (url.pathname === "/api/machines" && request.method === "GET") {
      return this.handleListMachines(authCtx);
    }
    if (url.pathname === "/api/machines" && request.method === "POST") {
      return this.handleRegisterMachine(request, authCtx);
    }
    if (url.pathname.startsWith("/api/machines/") && request.method === "DELETE") {
      const machineId = url.pathname.split("/").pop()!;
      return this.handleDeleteMachine(machineId, authCtx);
    }

    // Account endpoints
    if (url.pathname === "/api/account" && request.method === "GET") {
      return this.handleGetAccount(authCtx);
    }
    if (url.pathname === "/api/account" && request.method === "PATCH") {
      return this.handleUpdateAccount(request, authCtx);
    }
    if (url.pathname === "/api/account" && request.method === "DELETE") {
      return this.handleDeleteAccount(request, authCtx);
    }
    if (url.pathname === "/api/account/usage" && request.method === "GET") {
      return this.handleGetUsage(request, authCtx);
    }

    // Blob retrieval
    if (url.pathname.startsWith("/api/sync/blob/") && request.method === "GET") {
      const blobHash = url.pathname.split("/").pop()!;
      return this.handleGetBlob(blobHash, authCtx);
    }

    return new Response(
      JSON.stringify({ error: "not_found", message: "Endpoint not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Push handler ---
  private async handlePush(request: Request, authCtx: AuthContext): Promise<Response> {
    const body = await request.json() as PushRequest;
    const now = new Date().toISOString();

    // Verify machine belongs to user
    const machine = this.sql.exec(
      "SELECT machine_id FROM machines WHERE machine_id = ? AND is_active = 1",
      body.machine_id
    ).one();
    if (!machine) {
      return jsonResponse(403, { error: "unknown_machine", message: "Machine not registered" });
    }

    // Check storage quota
    const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow;
    const quotaBytes = getQuotaBytes(account.tier);
    const incomingBytes = body.events.reduce((sum, e) => sum + e.encrypted_size_bytes, 0);

    if (account.storage_used_bytes + incomingBytes > quotaBytes) {
      return jsonResponse(
        413,
        {
          error: "storage_exceeded",
          message: `Storage quota exceeded. Used: ${account.storage_used_bytes}, Incoming: ${incomingBytes}, Quota: ${quotaBytes}`,
          storage_used_bytes: account.storage_used_bytes,
          storage_quota_bytes: quotaBytes,
          upgrade_url: "https://agentctx.dev/pricing",
        }
      );
    }

    const bucket = authCtx.jurisdiction === "eu"
      ? this.env.EVENTS_BUCKET_EU
      : this.env.EVENTS_BUCKET;

    let accepted = 0;
    let rejected = 0;

    for (const event of body.events) {
      try {
        // Store encrypted blob in R2
        const blobKey = `users/${authCtx.userId}/events/${body.machine_id}/${event.project_id}/${event.session_id}/${event.sequence}.enc`;
        const blobData = body.blobs[event.encrypted_blob_sha256];
        if (!blobData) {
          rejected++;
          continue;
        }

        await bucket.put(blobKey, base64ToArrayBuffer(blobData), {
          sha256: hexToArrayBuffer(event.encrypted_blob_sha256),
          customMetadata: {
            machine_id: body.machine_id,
            project_id: event.project_id,
            session_id: event.session_id,
            sequence: String(event.sequence),
            event_type: event.event_type,
          },
        });

        // Insert event metadata
        this.sql.exec(
          `INSERT OR IGNORE INTO events_meta
            (machine_id, project_id, session_id, sequence, event_type, timestamp,
             encrypted_blob_key, encrypted_blob_sha256, encrypted_size_bytes,
             token_count_input, token_count_output, model, tool_name, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          body.machine_id,
          event.project_id,
          event.session_id,
          event.sequence,
          event.event_type,
          event.timestamp,
          blobKey,
          event.encrypted_blob_sha256,
          event.encrypted_size_bytes,
          event.metadata?.token_count_input || 0,
          event.metadata?.token_count_output || 0,
          event.metadata?.model || null,
          event.metadata?.tool_name || null,
          now
        );

        // Update usage aggregation
        const dateStr = event.timestamp.slice(0, 10);
        this.sql.exec(
          `INSERT INTO usage_daily (date, project_id, model, event_count, token_count_input, token_count_output, blob_bytes)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(date, project_id, model) DO UPDATE SET
             event_count = event_count + 1,
             token_count_input = token_count_input + excluded.token_count_input,
             token_count_output = token_count_output + excluded.token_count_output,
             blob_bytes = blob_bytes + excluded.blob_bytes`,
          dateStr,
          event.project_id,
          event.metadata?.model || "unknown",
          event.metadata?.token_count_input || 0,
          event.metadata?.token_count_output || 0,
          event.encrypted_size_bytes
        );

        accepted++;
      } catch (err) {
        rejected++;
      }
    }

    // Update storage counter
    this.sql.exec(
      `UPDATE account SET storage_used_bytes = (
        SELECT COALESCE(SUM(encrypted_size_bytes), 0) FROM events_meta
      ), updated_at = ?`,
      now
    );

    // Update machine last_sync_at
    this.sql.exec(
      "UPDATE machines SET last_sync_at = ?, last_seen_at = ? WHERE machine_id = ?",
      now, now, body.machine_id
    );

    // Increment rate limit counter for free tier
    if (authCtx.tier === "free") {
      const key = `ratelimit:${authCtx.userId}:${currentHourKey()}`;
      const count = parseInt((await this.env.AUTH_KV.get(key)) || "0");
      await this.env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 7200 });
    }

    // Notify connected WebSocket clients of new events
    this.notifyClients({
      type: "new_events",
      source_machine_id: body.machine_id,
      count: accepted,
      timestamp: now,
    });

    const updatedAccount = this.sql.exec("SELECT storage_used_bytes FROM account LIMIT 1").one() as any;

    // Compute cursor from last inserted event
    const lastEvent = this.sql.exec(
      "SELECT synced_at, sequence FROM events_meta WHERE machine_id = ? ORDER BY id DESC LIMIT 1",
      body.machine_id
    ).one() as any;
    const cursor = lastEvent
      ? `cur_${lastEvent.synced_at}_${lastEvent.sequence}`
      : null;

    return jsonResponse(200, {
      accepted,
      rejected,
      cursor,
      storage_used_bytes: updatedAccount.storage_used_bytes,
      storage_quota_bytes: quotaBytes,
    });
  }

  // --- Pull handler ---
  private async handlePull(request: Request, authCtx: AuthContext): Promise<Response> {
    const body = await request.json() as PullRequest;
    const now = new Date().toISOString();

    // Parse cursor to get the last synced ID for this machine
    let fromId = 0;
    if (body.cursor) {
      // Look up cursor in sync_cursors table
      const cursorRow = this.sql.exec(
        `SELECT last_synced_id FROM sync_cursors
         WHERE machine_id = ? AND source_machine_id = 'all'`,
        body.machine_id
      ).one() as any;
      if (cursorRow) {
        fromId = cursorRow.last_synced_id;
      }
    }

    const limit = Math.min(body.limit || 100, 500);

    // Fetch events from other machines that this machine hasn't seen
    let query = `SELECT * FROM events_meta
      WHERE machine_id != ? AND id > ?`;
    const params: any[] = [body.machine_id, fromId];

    if (body.project_id) {
      query += " AND project_id = ?";
      params.push(body.project_id);
    }

    query += " ORDER BY id ASC LIMIT ?";
    params.push(limit + 1); // +1 to detect has_more

    const rows = this.sql.exec(query, ...params).toArray() as EventMetaRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);

    // Build response events
    const responseEvents = events.map((row) => ({
      project_id: row.project_id,
      session_id: row.session_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      event_type: row.event_type,
      source_machine_id: row.machine_id,
      encrypted_blob_url: `/api/sync/blob/${row.encrypted_blob_sha256}`,
      encrypted_blob_key: row.encrypted_blob_key,
      encrypted_size_bytes: row.encrypted_size_bytes,
      metadata: {
        token_count_input: row.token_count_input,
        token_count_output: row.token_count_output,
        model: row.model,
        tool_name: row.tool_name,
      },
    }));

    // Update sync cursor
    if (events.length > 0) {
      const lastId = events[events.length - 1].id;
      this.sql.exec(
        `INSERT INTO sync_cursors (machine_id, source_machine_id, last_synced_id, last_synced_at)
         VALUES (?, 'all', ?, ?)
         ON CONFLICT(machine_id, source_machine_id) DO UPDATE SET
           last_synced_id = excluded.last_synced_id,
           last_synced_at = excluded.last_synced_at`,
        body.machine_id,
        lastId,
        now
      );
    }

    // Update machine last_seen_at
    this.sql.exec(
      "UPDATE machines SET last_seen_at = ? WHERE machine_id = ?",
      now, body.machine_id
    );

    // Count total pending
    const pendingRow = this.sql.exec(
      "SELECT COUNT(*) as cnt FROM events_meta WHERE machine_id != ? AND id > ?",
      body.machine_id,
      events.length > 0 ? (events[events.length - 1] as any).id : fromId
    ).one() as any;

    // Compute new cursor
    const newCursor = events.length > 0
      ? `cur_${events[events.length - 1].synced_at}_${events[events.length - 1].sequence}`
      : body.cursor || null;

    return jsonResponse(200, {
      events: responseEvents,
      cursor: newCursor,
      has_more: hasMore,
      total_pending: hasMore ? pendingRow.cnt : 0,
    });
  }

  // --- WebSocket upgrade ---
  private handleWebSocketUpgrade(
    request: Request,
    authCtx: AuthContext
  ): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, {
      machineId: authCtx.machineId || "unknown",
      connectedAt: new Date().toISOString(),
    });

    // Set alarm for periodic cleanup if not already set
    this.ctx.storage.setAlarm(Date.now() + 60_000);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        return;
      }

      if (data.type === "subscribe") {
        // Client subscribes to events from specific projects
        const session = this.sessions.get(ws);
        if (session) {
          // Store subscription preferences (future: filter notifications)
        }
        ws.send(JSON.stringify({ type: "subscribed", timestamp: new Date().toISOString() }));
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.sessions.delete(ws);
  }

  // Hibernation: DO can be evicted, WebSocket state is restored on next message
  async alarm(): Promise<void> {
    // Periodic cleanup: remove stale sync cursors, enforce retention
    const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow | null;
    if (!account) return;

    const retentionDays = getRetentionDays(account.tier);
    if (retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

      // Find expired events
      const expired = this.sql.exec(
        "SELECT encrypted_blob_key FROM events_meta WHERE timestamp < ?",
        cutoff
      ).toArray() as { encrypted_blob_key: string }[];

      // Delete from R2
      const bucket = account.jurisdiction === "eu"
        ? this.env.EVENTS_BUCKET_EU
        : this.env.EVENTS_BUCKET;

      for (const row of expired) {
        try {
          await bucket.delete(row.encrypted_blob_key);
        } catch {
          // Best-effort deletion
        }
      }

      // Delete metadata
      this.sql.exec("DELETE FROM events_meta WHERE timestamp < ?", cutoff);

      // Recalculate storage
      this.sql.exec(
        `UPDATE account SET storage_used_bytes = (
          SELECT COALESCE(SUM(encrypted_size_bytes), 0) FROM events_meta
        ), updated_at = ?`,
        new Date().toISOString()
      );
    }

    // Send heartbeat to connected WebSocket clients
    for (const [ws] of this.sessions) {
      try {
        ws.send(JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() }));
      } catch {
        this.sessions.delete(ws);
      }
    }

    // Re-set alarm if there are active connections or pending cleanup
    if (this.sessions.size > 0) {
      this.ctx.storage.setAlarm(Date.now() + 30_000); // 30s heartbeat
    } else {
      this.ctx.storage.setAlarm(Date.now() + 3600_000); // 1h cleanup check
    }
  }

  private notifyClients(message: object): void {
    const payload = JSON.stringify(message);
    for (const [ws, session] of this.sessions) {
      try {
        ws.send(payload);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  // ... (machine, account, and blob handlers follow the same pattern)
}
```

#### WebSocket Hibernation

Durable Objects support WebSocket Hibernation, which allows the DO to be evicted from memory while maintaining WebSocket connections. When a message arrives on a hibernated WebSocket, the DO is re-instantiated and `webSocketMessage` is called.

- Active connections with frequent messages: DO stays in memory, 30-second heartbeat alarm.
- Idle connections: DO hibernates, heartbeat alarm at 1 hour intervals. On wake, send a heartbeat and re-hibernate.
- All connections closed: Alarm at 1 hour for retention cleanup only.

#### Acceptance Criteria

- [ ] Durable Object creates all SQLite tables on first instantiation
- [ ] Schema is idempotent (`CREATE TABLE IF NOT EXISTS`)
- [ ] All indexes are created for query performance
- [ ] WebSocket connections are tracked per machine
- [ ] WebSocket hibernation is used for idle connections
- [ ] Alarm-based periodic cleanup enforces retention policies
- [ ] Heartbeat messages are sent every 30 seconds for active connections
- [ ] Push operations insert event metadata and update usage counters atomically
- [ ] Pull operations respect sync cursors and return only unseen events
- [ ] Storage quota is recalculated after each push
- [ ] Machine `last_seen_at` is updated on every request

---

### 3. R2 Encrypted Blob Storage (F9.3)

R2 stores the encrypted event payloads. The server never decrypts these blobs -- they are opaque byte sequences. R2 provides durable, low-cost object storage with no egress fees.

#### Key Format

```
/users/{user-id}/events/{machine-id}/{project-id}/{session-id}/{sequence}.enc
```

Example:
```
/users/usr_a1b2c3d4e5f6/events/mach_x1y2z3/my-project-a3f7b2/abc123-def456/000042.enc
```

#### Per-User Key Prefix Isolation

All objects for a user are namespaced under `/users/{user-id}/`. This enables:
- Efficient prefix listing for account usage calculation
- Bulk deletion for crypto-shredding (delete all objects with prefix `/users/{user-id}/`)
- Per-user access control (the DO only accesses objects under its own user prefix)

#### Put Operation

```typescript
async function putEncryptedBlob(
  bucket: R2Bucket,
  userId: string,
  machineId: string,
  projectId: string,
  sessionId: string,
  sequence: number,
  encryptedData: ArrayBuffer,
  sha256Hash: ArrayBuffer
): Promise<R2Object> {
  const key = `users/${userId}/events/${machineId}/${projectId}/${sessionId}/${String(sequence).padStart(6, "0")}.enc`;

  return bucket.put(key, encryptedData, {
    sha256: sha256Hash,
    httpMetadata: {
      contentType: "application/octet-stream",
    },
    customMetadata: {
      machine_id: machineId,
      project_id: projectId,
      session_id: sessionId,
      sequence: String(sequence),
      uploaded_at: new Date().toISOString(),
    },
  });
}
```

#### Get Operation

```typescript
async function getEncryptedBlob(
  bucket: R2Bucket,
  userId: string,
  blobKey: string
): Promise<R2ObjectBody | null> {
  // Verify key belongs to this user (prevent path traversal)
  if (!blobKey.startsWith(`users/${userId}/`)) {
    throw new Error("Access denied: key does not belong to user");
  }

  return bucket.get(blobKey);
}
```

#### Lifecycle Rules Per Tier

| Tier | Retention | Enforcement |
|------|-----------|-------------|
| Free | 30 days | Alarm-based cleanup in DO deletes expired R2 objects |
| Pro | 1 year | Alarm-based cleanup in DO deletes expired R2 objects |
| Team | Unlimited | No automatic deletion |

Lifecycle enforcement happens in the Durable Object's alarm handler (Section 2), not via R2 lifecycle rules. This allows tier-specific retention without needing separate R2 buckets per tier.

#### Acceptance Criteria

- [ ] Encrypted blobs are stored with the correct key format
- [ ] SHA-256 integrity check is passed to R2 on upload
- [ ] Custom metadata is attached to each object for auditing
- [ ] Get operations verify the key belongs to the requesting user
- [ ] Path traversal attacks are prevented (key prefix check)
- [ ] Blob deletion is performed during retention cleanup
- [ ] Bulk deletion by prefix is used for crypto-shredding
- [ ] EU bucket is used for EU-jurisdiction users
- [ ] Blob retrieval returns the raw encrypted bytes without transformation

---

### 4. Machine Registry (F9.4)

Each user can register multiple machines (physical devices or VMs) that sync events. Machine count is limited by tier.

#### Machine Registration

```typescript
private async handleRegisterMachine(
  request: Request,
  authCtx: AuthContext
): Promise<Response> {
  const body = await request.json() as RegisterMachineRequest;

  // Check machine limit
  const activeCount = this.sql.exec(
    "SELECT COUNT(*) as cnt FROM machines WHERE is_active = 1"
  ).one() as any;

  const machineLimit = getMachineLimit(authCtx.tier);
  if (machineLimit > 0 && activeCount.cnt >= machineLimit) {
    return jsonResponse(403, {
      error: "machine_limit_reached",
      message: `Your ${authCtx.tier} tier allows ${machineLimit} machines. You have ${activeCount.cnt}.`,
      current_count: activeCount.cnt,
      limit: machineLimit,
      upgrade_url: "https://agentctx.dev/pricing",
    });
  }

  const machineId = `mach_${generateId()}`;
  const now = new Date().toISOString();

  this.sql.exec(
    `INSERT INTO machines (machine_id, name, os, arch, hostname, registered_at, last_seen_at, agent_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    machineId,
    body.name,
    body.os,
    body.arch,
    body.hostname,
    now,
    now,
    body.agent_version || null
  );

  return jsonResponse(201, {
    machine_id: machineId,
    name: body.name,
    os: body.os,
    registered_at: now,
  });
}
```

#### Machine Metadata

| Field | Type | Description |
|-------|------|-------------|
| `machine_id` | string | Server-generated unique ID (`mach_` prefix) |
| `name` | string | User-provided friendly name (e.g., "Work Laptop") |
| `os` | string | Operating system: `linux`, `macos`, `windows` |
| `arch` | string | CPU architecture: `x64`, `arm64` |
| `hostname` | string | Machine hostname for identification |
| `registered_at` | ISO 8601 | When the machine was first registered |
| `last_sync_at` | ISO 8601 | When the machine last pushed or pulled events |
| `last_seen_at` | ISO 8601 | When the machine last made any API request |
| `agent_version` | string | Version of the AgentContext client installed |
| `is_active` | boolean | Whether the machine is active (soft delete) |

#### Machine Limit Enforcement Per Tier

| Tier | Machine Limit |
|------|--------------|
| Free | 2 |
| Pro | 5 |
| Team | Unlimited (0 = no limit) |

Enforcement happens at registration time. Deactivated machines (`is_active = 0`) do not count toward the limit. A user can deactivate a machine and register a new one without upgrading.

#### Acceptance Criteria

- [ ] Machines are assigned a unique server-generated ID with `mach_` prefix
- [ ] Machine limit is enforced at registration time based on the user's tier
- [ ] Deactivated machines do not count toward the limit
- [ ] Machine metadata includes OS, architecture, hostname, and timestamps
- [ ] Listing machines returns only active machines by default
- [ ] Deleting a machine sets `is_active = 0` (soft delete), does not purge sync data
- [ ] `last_sync_at` is updated on every push/pull
- [ ] `last_seen_at` is updated on every authenticated request from that machine

---

### 5. Sync Cursors (F9.5)

Sync cursors track what each machine has already pulled from the server, preventing duplicate downloads and enabling efficient incremental sync.

#### Cursor Format

Cursors are opaque strings from the client's perspective. Internally, they encode the last seen `events_meta.id`:

```
cur_{synced_at}_{sequence}
```

Example: `cur_2026-02-14T10:30:00.000Z_42`

The actual sync position is tracked in the `sync_cursors` SQLite table using the `events_meta.id` auto-increment column, which provides a total ordering across all machines and projects.

#### Update Semantics

1. On pull: After returning events to the client, the cursor is advanced to the `id` of the last returned event.
2. On push: No cursor update. The pushing machine already has these events locally.
3. On reconnect: Client sends its last known cursor. Server resumes from that position.

#### Cursor State Machine

```
Initial state: No cursor exists for this (machine, source) pair
  │
  ├─ First pull: cursor = 0 (return all events from other machines)
  │    └─ After pull: cursor = id of last returned event
  │
  ├─ Subsequent pull: cursor = last_synced_id
  │    └─ After pull: cursor advances to new last event id
  │
  └─ Gap detection: If cursor.last_synced_id refers to a deleted event
       (e.g., retention cleanup deleted old events),
       the cursor is still valid -- SQLite auto-increment IDs never repeat.
       Events with id > cursor.last_synced_id are returned normally.
```

#### Gap Detection

Gaps can occur when:
- Events are deleted by retention cleanup (the IDs between the cursor and the next available event are gone)
- Events are purged during crypto-shredding

Gap detection does not require special handling because `events_meta.id` is an auto-incrementing primary key. A query `WHERE id > cursor_id ORDER BY id ASC` naturally skips over deleted rows and returns the next available events.

The client can detect gaps by observing non-sequential `sequence` numbers within a session, but this is a client-side concern, not a server responsibility.

#### Acceptance Criteria

- [ ] Sync cursors are stored per (machine, source_machine) pair in SQLite
- [ ] Cursors advance forward-only (never go backward)
- [ ] A pull with no cursor returns all events from other machines
- [ ] A pull with a cursor returns only events newer than the cursor position
- [ ] Gaps from deleted events are handled transparently (no errors, no duplicates)
- [ ] Cursor position is based on `events_meta.id`, not timestamps (avoids clock skew issues)
- [ ] Cursor strings are opaque to the client (server interprets them)
- [ ] Pulling 0 new events does not modify the cursor

---

### 6. WebSocket Notifications (F9.6)

Connected clients receive real-time push notifications when new events arrive from other machines. This eliminates the need for polling on Pro and Team tiers.

#### WebSocket Message Protocol

All messages are JSON-encoded. The protocol uses a simple `type` field for routing.

**Server-to-Client Messages:**

```json
// New events available
{
  "type": "new_events",
  "source_machine_id": "mach_a1b2c3",
  "count": 5,
  "timestamp": "2026-02-14T10:30:00.000Z"
}

// Heartbeat (keep connection alive)
{
  "type": "heartbeat",
  "timestamp": "2026-02-14T10:30:30.000Z"
}

// Machine registered/deactivated
{
  "type": "machine_update",
  "machine_id": "mach_x1y2z3",
  "action": "registered" | "deactivated",
  "timestamp": "2026-02-14T10:30:00.000Z"
}

// Tier changed
{
  "type": "tier_changed",
  "old_tier": "free",
  "new_tier": "pro",
  "timestamp": "2026-02-14T10:30:00.000Z"
}

// Error
{
  "type": "error",
  "message": "string",
  "code": "string"
}
```

**Client-to-Server Messages:**

```json
// Ping (keepalive from client)
{
  "type": "ping"
}

// Subscribe to specific project updates
{
  "type": "subscribe",
  "project_ids": ["my-project-a3f7b2", "other-project-c4d5e6"]
}

// Unsubscribe
{
  "type": "unsubscribe",
  "project_ids": ["my-project-a3f7b2"]
}
```

#### Heartbeat / Keepalive

- Server sends `heartbeat` every 30 seconds when DO is active (WebSocket connections present).
- Client should send `ping` at least every 60 seconds.
- Server closes connections that have not sent a `ping` in 120 seconds.
- Cloudflare's infrastructure may close idle WebSocket connections after ~100 seconds without messages, so the 30-second heartbeat ensures the connection stays alive.

#### Reconnection Handling

1. Client detects disconnection (WebSocket `close` or `error` event).
2. Client implements exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max).
3. On reconnect, client sends its last cursor to `/api/sync/pull` to catch up on missed events.
4. Client re-establishes WebSocket to `/api/sync/stream` for future notifications.
5. Server does not buffer messages for disconnected clients -- the cursor-based pull handles catch-up.

#### Free Tier Restriction

Free tier users cannot use WebSocket streaming. They must poll `/api/sync/pull` (limited to 10 requests per hour). The tier check middleware (Section 1) rejects WebSocket upgrade requests from free tier users.

#### Acceptance Criteria

- [ ] WebSocket upgrade works for Pro and Team tier users
- [ ] Free tier users receive 403 on WebSocket upgrade attempt
- [ ] Server sends `heartbeat` every 30 seconds for active connections
- [ ] Server closes connections with no client `ping` in 120 seconds
- [ ] `new_events` notifications are sent to all connected clients except the pushing machine
- [ ] Messages are JSON-encoded with a `type` field
- [ ] WebSocket hibernation is used when connections are idle
- [ ] Disconnected clients are cleaned up from the sessions map
- [ ] Reconnection relies on cursor-based pull (no server-side message buffering)

---

### 7. Usage Aggregation (F9.7)

The server aggregates cleartext metadata (token counts, event counts, storage) for billing, analytics, and the account dashboard. The server never accesses encrypted content.

#### What the Server Can See (Cleartext Metadata)

| Field | Source | Purpose |
|-------|--------|---------|
| `token_count_input` | Client-provided in push metadata | Usage analytics, billing |
| `token_count_output` | Client-provided in push metadata | Usage analytics, billing |
| `model` | Client-provided in push metadata | Per-model usage breakdown |
| `event_type` | Client-provided in push metadata | Event type distribution |
| `tool_name` | Client-provided in push metadata | Tool usage frequency |
| `encrypted_size_bytes` | Measured from blob | Storage billing |
| `timestamp` | Client-provided | Time-series aggregation |
| `project_id` | Client-provided | Per-project breakdown (project name is hashed, not readable) |

#### What the Server Cannot See (Encrypted)

- Event content (prompts, responses, code, file contents)
- Tool inputs and outputs
- Session conversation history
- File paths and names
- Actual project names (only the hashed project_id)

#### Aggregation Queries

```typescript
// Daily usage for a date range
private getUsageByDateRange(startDate: string, endDate: string): UsageSummary {
  const rows = this.sql.exec(
    `SELECT date, SUM(event_count) as events, SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens, SUM(blob_bytes) as bytes
     FROM usage_daily
     WHERE date >= ? AND date <= ?
     GROUP BY date
     ORDER BY date ASC`,
    startDate, endDate
  ).toArray();

  return { daily: rows };
}

// Per-project usage
private getUsageByProject(): ProjectUsage[] {
  return this.sql.exec(
    `SELECT project_id, SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens,
            SUM(blob_bytes) as bytes
     FROM usage_daily
     GROUP BY project_id
     ORDER BY events DESC`
  ).toArray() as ProjectUsage[];
}

// Per-model usage
private getUsageByModel(): ModelUsage[] {
  return this.sql.exec(
    `SELECT model, SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens
     FROM usage_daily
     GROUP BY model
     ORDER BY events DESC`
  ).toArray() as ModelUsage[];
}
```

#### GET /api/account/usage Response

```json
{
  "period": {
    "start": "2026-02-01",
    "end": "2026-02-21"
  },
  "totals": {
    "events": 4523,
    "input_tokens": 2150000,
    "output_tokens": 890000,
    "storage_bytes": 34567890
  },
  "by_date": [
    { "date": "2026-02-01", "events": 150, "input_tokens": 75000, "output_tokens": 30000 },
    { "date": "2026-02-02", "events": 200, "input_tokens": 100000, "output_tokens": 45000 }
  ],
  "by_project": [
    { "project_id": "my-project-a3f7b2", "events": 2000, "input_tokens": 1000000, "output_tokens": 400000 }
  ],
  "by_model": [
    { "model": "claude-opus-4-6", "events": 3000, "input_tokens": 1500000, "output_tokens": 600000 },
    { "model": "claude-sonnet-4-5-20250514", "events": 1523, "input_tokens": 650000, "output_tokens": 290000 }
  ]
}
```

#### Acceptance Criteria

- [ ] Usage data is aggregated per day, per project, and per model
- [ ] Aggregation uses `INSERT ... ON CONFLICT DO UPDATE` for upsert semantics
- [ ] Only cleartext metadata is aggregated (no encrypted content access)
- [ ] Usage API returns data for a specified date range
- [ ] Token counts and event counts are summed correctly
- [ ] Storage bytes are tracked from actual blob sizes
- [ ] Aggregation happens atomically with event insertion during push

---

### 8. Account Management (F9.8)

Handles user registration, authentication, and account settings. The "password" here is the account login password, NOT the encryption passphrase (which is handled entirely client-side by F10).

#### Registration Flow

```
1. Client sends POST /api/auth/register with email + password
2. Server validates:
   - Email format (RFC 5322)
   - Email not already registered (check AUTH_KV)
   - Password meets minimum requirements (>= 12 characters)
3. Server creates:
   - User ID (usr_ prefix + 12-char random)
   - Password hash (Argon2id via WebCrypto or Cloudflare's built-in)
   - Account row in DO SQLite
   - Email → user_id mapping in AUTH_KV
4. Server sends verification email (via transactional email service)
5. Server returns user_id + "check your email" message
```

#### Authentication Flow

```
1. Client sends POST /api/auth/login with email + password
2. Server looks up user_id from email via AUTH_KV
3. Server routes to user's DO
4. DO verifies password hash against stored hash
5. DO generates JWT access token (1 hour expiry) + refresh token (30 day expiry)
6. Refresh token hash stored in KV for revocation checking
7. Response includes both tokens + user profile
```

#### JWT Token Structure

```json
{
  "sub": "usr_a1b2c3d4e5f6",
  "email": "user@example.com",
  "tier": "free",
  "jurisdiction": "default",
  "iat": 1708000000,
  "exp": 1708003600,
  "iss": "agentctx",
  "aud": "agentctx-sync"
}
```

- Access token: 1 hour expiry. Used for all authenticated API calls.
- Refresh token: 30 day expiry. Used only to obtain new access tokens.
- Refresh tokens are rotated on each use (old token invalidated, new token issued).

#### Password Requirements

- Minimum 12 characters
- No maximum length (up to 1024 characters for practical limits)
- No character class requirements (length is the primary security measure)
- Hashed with Argon2id (m=64MB, t=3, p=1) -- same parameters as the encryption passphrase derivation for consistency

#### Email Verification

- Verification link contains a single-use token stored in AUTH_KV with 24-hour TTL.
- Unverified accounts can sync but have reduced rate limits (5/hour instead of 10/hour).
- After 7 days without verification, the account is soft-deleted and the email is released.

#### Acceptance Criteria

- [ ] Registration creates a new user with a unique `usr_` prefixed ID
- [ ] Email uniqueness is enforced via AUTH_KV lookup
- [ ] Passwords are hashed with Argon2id before storage
- [ ] Password minimum length is 12 characters
- [ ] JWT access tokens expire after 1 hour
- [ ] Refresh tokens expire after 30 days and are rotated on use
- [ ] Email verification tokens are single-use with 24-hour TTL
- [ ] Unverified accounts are soft-deleted after 7 days
- [ ] Login returns both access and refresh tokens
- [ ] Invalid credentials return 401 with generic "invalid credentials" message (no user enumeration)

---

### 9. Crypto-Shredding (F9.9)

Account deletion renders all encrypted data permanently unrecoverable by destroying the server-side storage. Even if the user's encryption keys were compromised in the future, the encrypted blobs no longer exist.

#### Deletion Flow

```
DELETE /api/account
  │
  ├─ 1. Verify password (re-authenticate)
  ├─ 2. Verify confirmation string ("DELETE MY ACCOUNT")
  │
  ├─ 3. Create deletion_log entry (status: 'initiated')
  │
  ├─ 4. Clear DO state
  │     ├─ Delete all rows from events_meta
  │     ├─ Delete all rows from sync_cursors
  │     ├─ Delete all rows from usage_daily
  │     ├─ Delete all rows from machines
  │     ├─ Set account.deleted_at, account.email = '[deleted]'
  │     ├─ Update deletion_log (status: 'do_cleared')
  │
  ├─ 5. Delete R2 prefix (async, may take time)
  │     ├─ List all objects with prefix: users/{user-id}/
  │     ├─ Delete in batches of 1000
  │     ├─ Update deletion_log (status: 'r2_deleting' → 'r2_deleted')
  │
  ├─ 6. Purge KV entries
  │     ├─ Delete email → user_id mapping
  │     ├─ Delete all rate limit keys
  │     ├─ Delete refresh token hashes
  │     ├─ Update deletion_log (status: 'kv_purged')
  │
  ├─ 7. Mark deletion complete
  │     └─ Update deletion_log (status: 'completed')
  │
  └─ 8. Return success response
```

#### R2 Bulk Deletion

R2 does not support prefix-based bulk delete natively. The DO must list and delete objects iteratively:

```typescript
private async deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, limit: 1000, cursor });
    if (listed.objects.length === 0) break;

    const keys = listed.objects.map((obj) => obj.key);
    await bucket.delete(keys);
    deletedCount += keys.length;

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deletedCount;
}
```

#### Audit Trail

The `deletion_log` table tracks every step of the deletion process. This table is kept even after account deletion for compliance purposes (the account row is anonymized, not deleted).

- `deletion_id`: Unique identifier for this deletion operation.
- Status progression: `initiated` -> `do_cleared` -> `r2_deleting` -> `r2_deleted` -> `kv_purged` -> `completed`.
- If any step fails, the status is `failed` and a manual investigation is required.
- Timestamps are recorded for each step.

#### Failure Recovery

If the deletion process fails partway through (e.g., R2 deletion times out):
- The deletion_log records where it stopped.
- A scheduled alarm retries the failed step.
- The account is immediately inaccessible (login disabled as soon as step 4 completes).
- R2 cleanup is eventually consistent -- even if R2 deletion is delayed, the data is inaccessible because the DO metadata is gone and the user cannot authenticate.

#### Acceptance Criteria

- [ ] Account deletion requires re-authentication (password) and explicit confirmation string
- [ ] All events_meta rows are deleted from the DO
- [ ] All R2 objects under the user's prefix are deleted
- [ ] All KV entries (email mapping, rate limits, refresh tokens) are purged
- [ ] The deletion_log records every step with timestamps
- [ ] The account email is anonymized (not deleted) for audit trail
- [ ] Partial deletion failures are retried via alarm
- [ ] The user cannot log in after step 4 (DO state cleared)
- [ ] The deletion response includes a deletion_id for reference
- [ ] WebSocket connections are closed on account deletion

---

### 10. EU Data Residency (F9.10)

EU users can opt for data residency within the EU via Cloudflare's jurisdiction hints. This ensures that both the Durable Object (metadata) and R2 bucket (encrypted blobs) are located in EU data centers.

#### Jurisdiction Configuration

Users select their jurisdiction at registration time. It cannot be changed after account creation (migrating a DO to a different jurisdiction is not supported by Cloudflare).

```json
// Registration request
{
  "email": "user@example.eu",
  "password": "secure-password-123",
  "jurisdiction": "eu"
}
```

#### Cloudflare Location Hints

**Durable Object:**
- EU users are routed to `USER_DO_EU`, which is deployed as a separate Worker in the EU jurisdiction.
- The Worker's `wrangler.toml` uses `jurisdiction = "eu"` on the DO binding (configured via separate `agentctx-sync-eu` script_name).

**R2 Bucket:**
- EU users' blobs are stored in `EVENTS_BUCKET_EU`, which is an R2 bucket with `jurisdiction = "eu"`.
- The bucket is configured in `wrangler.toml` with `jurisdiction = "eu"`.

#### User Preference Storage

The `jurisdiction` field is stored in:
1. The `account` table in the user's DO (`account.jurisdiction`).
2. The JWT token (`jurisdiction` claim).
3. The `AUTH_KV` namespace (for routing during login before the DO is accessed).

KV lookup on login:
```typescript
// During login, look up user's jurisdiction to route to correct DO
const userMeta = await env.AUTH_KV.get(`user:${userId}`, "json") as UserMeta;
const doNamespace = userMeta.jurisdiction === "eu" ? env.USER_DO_EU : env.USER_DO;
```

#### Tier Restriction

EU data residency is available only on Pro and Team tiers. Free tier users are assigned `jurisdiction: "default"`. If a free tier user requests `jurisdiction: "eu"`, the registration succeeds but with `jurisdiction: "default"` and a note in the response:

```json
{
  "user_id": "usr_a1b2c3d4e5f6",
  "jurisdiction": "default",
  "note": "EU data residency requires Pro or Team tier. Upgrade at https://agentctx.dev/pricing"
}
```

#### Acceptance Criteria

- [ ] EU jurisdiction is selectable at registration time
- [ ] EU users' DOs are routed to the EU-jurisdiction Worker
- [ ] EU users' blobs are stored in the EU-jurisdiction R2 bucket
- [ ] Jurisdiction is stored in the account table, JWT token, and KV
- [ ] Free tier users cannot select EU jurisdiction (silently falls back to default)
- [ ] Jurisdiction cannot be changed after account creation
- [ ] Login correctly routes to the right DO namespace based on stored jurisdiction

---

### 11. Tier Enforcement (F9.11)

Tier limits are enforced at multiple layers: the Worker middleware (rate limiting, feature gating), the Durable Object (storage quotas, machine limits), and the alarm handler (retention cleanup).

#### Tier Structure

| | Free | Pro ($5/mo) | Team ($15/mo) |
|-|------|-------------|---------------|
| Machines | 2 | 5 | Unlimited |
| Event storage (R2) | 50 MB | 1 GB | 10 GB |
| Retention | 30 days | 1 year | Unlimited |
| Sync frequency | 10/hour | Unlimited | Unlimited |
| WebSocket sync | Polling only | Real-time | Real-time |
| EU residency | No | Yes | Yes |
| Priority support | No | No | Yes |

#### Quota Checking Implementation

```typescript
interface TierLimits {
  machineLimit: number;        // 0 = unlimited
  storageBytes: number;        // 0 = unlimited
  retentionDays: number;       // 0 = unlimited
  syncRatePerHour: number;     // 0 = unlimited
  webSocketAllowed: boolean;
  euResidencyAllowed: boolean;
}

const TIER_LIMITS: Record<string, TierLimits> = {
  free: {
    machineLimit: 2,
    storageBytes: 50 * 1024 * 1024,        // 50 MB
    retentionDays: 30,
    syncRatePerHour: 10,
    webSocketAllowed: false,
    euResidencyAllowed: false,
  },
  pro: {
    machineLimit: 5,
    storageBytes: 1024 * 1024 * 1024,      // 1 GB
    retentionDays: 365,
    syncRatePerHour: 0,                     // unlimited
    webSocketAllowed: true,
    euResidencyAllowed: true,
  },
  team: {
    machineLimit: 0,                        // unlimited
    storageBytes: 10 * 1024 * 1024 * 1024,  // 10 GB
    retentionDays: 0,                        // unlimited
    syncRatePerHour: 0,                     // unlimited
    webSocketAllowed: true,
    euResidencyAllowed: true,
  },
};

function checkQuota(
  tier: string,
  currentUsage: { storageBytes: number; machineCount: number },
  incoming: { bytes: number; newMachine: boolean }
): QuotaCheckResult {
  const limits = TIER_LIMITS[tier];

  if (limits.storageBytes > 0 && currentUsage.storageBytes + incoming.bytes > limits.storageBytes) {
    return {
      allowed: false,
      reason: "storage_exceeded",
      message: `Storage quota exceeded (${formatBytes(currentUsage.storageBytes)} / ${formatBytes(limits.storageBytes)})`,
      upgrade_url: "https://agentctx.dev/pricing",
    };
  }

  if (incoming.newMachine && limits.machineLimit > 0 && currentUsage.machineCount >= limits.machineLimit) {
    return {
      allowed: false,
      reason: "machine_limit_reached",
      message: `Machine limit reached (${currentUsage.machineCount} / ${limits.machineLimit})`,
      upgrade_url: "https://agentctx.dev/pricing",
    };
  }

  return { allowed: true };
}
```

#### Upgrade Prompts

When a limit is hit, error responses include an `upgrade_url` field that the client can use to direct the user to the pricing page. The error messages are descriptive and include current usage vs. limits.

Upgrade prompt responses follow this pattern:
```json
{
  "error": "storage_exceeded",
  "message": "Storage quota exceeded (48.5 MB / 50 MB). Upgrade to Pro for 1 GB storage.",
  "current_usage": 50855936,
  "quota": 52428800,
  "upgrade_url": "https://agentctx.dev/pricing",
  "suggested_tier": "pro"
}
```

#### Tier Change Handling

When a user upgrades or downgrades their tier:
1. The `account.tier` field is updated in the DO.
2. A new JWT is issued with the updated tier.
3. Connected WebSocket clients receive a `tier_changed` notification.
4. If downgrading, existing data is not deleted -- but retention cleanup will apply the new, shorter retention period on the next alarm.
5. If downgrading below the current machine count, no machines are deactivated -- but new machines cannot be registered until under the limit.

#### Acceptance Criteria

- [ ] Storage quotas are checked before accepting push requests
- [ ] Machine limits are checked before registering new machines
- [ ] Rate limits are enforced per-hour for free tier sync operations
- [ ] WebSocket streaming is blocked for free tier users
- [ ] EU residency is blocked for free tier users
- [ ] Retention cleanup applies the correct retention period per tier
- [ ] Upgrade prompts include current usage, limits, and upgrade URL
- [ ] Tier changes take effect immediately for new operations
- [ ] Downgrade does not delete existing data
- [ ] All limit values are configurable via `wrangler.toml` environment variables

---

### 12. Web Portal (F9.12)

The web portal provides account management for users who want to manage their subscription, view machines, and monitor usage. It is deliberately limited -- because the server has zero knowledge of the encrypted content, the portal cannot display event data, session history, or any user content.

#### What the Portal Can Show

| Feature | Data Source | Description |
|---------|-------------|-------------|
| Account settings | `account` table | Email, tier, jurisdiction, created date |
| Machine list | `machines` table | Name, OS, last sync, active status |
| Usage dashboard | `usage_daily` table | Token counts, event counts, storage over time |
| Tier management | `account.tier` | Current tier, upgrade/downgrade buttons |
| Billing info | External payment provider | Subscription status, invoices |
| Security | `account` table | Change password, manage sessions |
| Delete account | Crypto-shredding flow | Permanent deletion button with confirmation |

#### What the Portal Cannot Show (Zero Knowledge)

- Session content or conversation history
- File contents or code
- Prompt text or Claude responses
- Tool call details
- Any decrypted event data

The portal displays a clear explanation:

```
Your data is end-to-end encrypted. The server cannot read your events,
sessions, or code. Only your devices with the encryption key can
decrypt your data.

To view your session history, use the AgentContext desktop or mobile app.
```

#### Portal Technology

The portal is a static site served from Cloudflare Pages or the Worker itself, built with vanilla HTML/CSS/JS (no framework) for simplicity. It communicates with the same Worker API endpoints using JWT authentication stored in an HttpOnly cookie.

#### Portal Routes

| Route | Page | Description |
|-------|------|-------------|
| `/` | Login/Register | Auth forms |
| `/dashboard` | Overview | Usage charts, machine list, storage meter |
| `/machines` | Machine Management | Register, deactivate, view machine details |
| `/account` | Account Settings | Email, password, jurisdiction info |
| `/billing` | Billing | Tier selection, payment info, invoices |
| `/delete` | Delete Account | Crypto-shredding confirmation page |

#### Acceptance Criteria

- [ ] Portal is accessible at the Worker's base URL
- [ ] Login/registration forms use the API auth endpoints
- [ ] Dashboard shows usage charts (token counts, storage) without any encrypted data
- [ ] Machine list shows all registered machines with sync status
- [ ] Account settings allow password change
- [ ] Delete account page requires confirmation and re-authentication
- [ ] Portal explicitly states that data viewing is not possible on the server
- [ ] JWT is stored in an HttpOnly, Secure, SameSite=Strict cookie
- [ ] Portal works on mobile browsers (responsive design)
- [ ] No JavaScript framework -- vanilla HTML/CSS/JS only

---

## Edge Cases

### E-1: Push During Active R2 Outage

**Scenario**: R2 is experiencing a regional outage. The Worker and DO are operational, but R2 put operations fail.

**Expected behavior**: The push handler catches the R2 error, does not insert the events_meta row (atomic: both succeed or both fail), and returns a 503 with a `Retry-After` header. The client retries with exponential backoff. No data loss because the client still has the events locally.

**Mitigation**: Events are never deleted from the client until the server confirms successful storage. The push response must return `accepted` count, and the client only advances its local push cursor for accepted events.

---

### E-2: Concurrent Push from Same Machine

**Scenario**: Two push requests from the same machine arrive at the DO simultaneously (e.g., flaky network caused a retry while the original is still processing).

**Expected behavior**: The `UNIQUE(machine_id, project_id, session_id, sequence)` constraint on `events_meta` prevents duplicate insertions. The second push for the same events returns `accepted: 0, rejected: N` with an appropriate message. This is idempotent -- the client can safely retry pushes.

---

### E-3: Machine ID Spoofing

**Scenario**: A user forges a push request with a `machine_id` belonging to another user.

**Expected behavior**: The DO only has machines registered by that specific user. The `handlePush` method checks that the `machine_id` exists in the user's `machines` table. An unrecognized machine_id is rejected with 403.

---

### E-4: JWT Token Used After Tier Downgrade

**Scenario**: A user downgrades from Pro to Free while holding a JWT that still says `tier: "pro"`. They attempt to use WebSocket streaming.

**Expected behavior**: The JWT tier claim is a snapshot at token issuance time. For critical tier checks (WebSocket, EU residency), the DO verifies the current tier from its SQLite `account` table, not the JWT claim. The middleware layer uses the JWT for fast-path filtering, but the DO is the source of truth.

---

### E-5: Account Deletion During Active Sync

**Scenario**: Machine A is pushing events while the user simultaneously deletes their account from the web portal.

**Expected behavior**: The DO processes requests serially (single-threaded by design). The deletion request waits for any in-flight push to complete. Once deletion starts (step 4), the account is marked deleted and subsequent push requests fail with 401. Any partially written R2 objects from the in-flight push are cleaned up during the R2 prefix deletion (step 5).

---

### E-6: R2 Prefix Deletion Timeout During Crypto-Shredding

**Scenario**: A user with 10 GB of data (hundreds of thousands of R2 objects) deletes their account. The R2 prefix deletion exceeds the Durable Object's execution time limit.

**Expected behavior**: The deletion is broken into batches. After each batch of 1000 deletions, the DO checks remaining time. If approaching the limit, it saves progress (last deleted key) to the deletion_log, sets an alarm for 1 second later, and returns. The alarm handler resumes deletion from where it left off. The response to the user indicates `deletion_in_progress: true`.

---

### E-7: Free Tier User Approaches Storage Limit

**Scenario**: A free tier user has used 45 MB of their 50 MB quota. They push 10 MB of new events.

**Expected behavior**: The push is rejected entirely (not partially). The response includes current usage, quota, and an upgrade prompt. The client can split the push into smaller batches if some events fit within the remaining quota, but the server does not partial-accept a single push request.

---

### E-8: WebSocket Connection During DO Eviction

**Scenario**: All connected clients are idle. The DO is evicted from memory (hibernation). A new event push arrives from another machine.

**Expected behavior**: The push re-instantiates the DO. The DO calls `notifyClients`, which iterates over the WebSocket connections that were preserved through hibernation. The `webSocketMessage` handler is ready for the next client message. Clients that reconnected during the hibernation period receive the notification normally.

---

### E-9: Clock Skew Between Client and Server

**Scenario**: A client's clock is significantly ahead of or behind the server's clock. Events arrive with timestamps in the future or far past.

**Expected behavior**: The server records the client-provided `timestamp` in `events_meta` for the event's logical time, but also records `synced_at` using the server's clock for sync ordering. Sync cursors are based on `events_meta.id` (auto-increment), not timestamps, so clock skew does not affect sync correctness. The usage aggregation uses the client-provided timestamp for daily bucketing, which may cause usage to appear on the "wrong" day -- this is acceptable.

---

### E-10: EU User Registration When EU Infrastructure Is Unavailable

**Scenario**: The EU-specific Durable Object namespace or R2 bucket is temporarily unavailable during registration.

**Expected behavior**: Registration fails with a 503 status and a clear message: "EU infrastructure is temporarily unavailable. Please try again or register with default jurisdiction." The user is not partially created. The email address is not reserved. The user can retry or choose `jurisdiction: "default"`.

---

### E-11: Duplicate Email Registration (Race Condition)

**Scenario**: Two registration requests arrive simultaneously for the same email address. Both check AUTH_KV and find no existing entry. Both attempt to create the account.

**Expected behavior**: AUTH_KV supports atomic operations. The registration flow uses a KV put with `expiration` and checks for existing keys atomically. If both succeed at the KV level, the second DO creation attempt finds the user already exists in the first DO and returns a 409 conflict. The orphaned KV entry from the failed registration is cleaned up by TTL.

---

### E-12: Blob Integrity Check Failure

**Scenario**: A client pushes an event where the `encrypted_blob_sha256` does not match the actual blob data.

**Expected behavior**: R2's `put` operation with the `sha256` option performs integrity validation. If the hash does not match, R2 rejects the put. The push handler catches this error and increments the `rejected` counter for that event. Other events in the same push request are not affected.

---

## Technical Specifications

### Type Definitions

```typescript
// src/types.ts

// --- Request types ---

interface RegisterRequest {
  email: string;
  password: string;
  jurisdiction?: "default" | "eu";
}

interface LoginRequest {
  email: string;
  password: string;
}

interface RegisterMachineRequest {
  name: string;
  os: "linux" | "macos" | "windows";
  arch: "x64" | "arm64";
  hostname: string;
  agent_version?: string;
}

interface PushRequest {
  machine_id: string;
  events: PushEvent[];
  blobs: Record<string, string>; // sha256 -> base64-encoded encrypted blob
}

interface PushEvent {
  project_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  encrypted_blob_sha256: string;
  encrypted_size_bytes: number;
  metadata?: {
    token_count_input?: number;
    token_count_output?: number;
    model?: string;
    tool_name?: string;
  };
}

interface PullRequest {
  machine_id: string;
  cursor?: string;
  limit?: number;
  project_id?: string;
}

interface DeleteAccountRequest {
  confirmation: "DELETE MY ACCOUNT";
  password: string;
}

interface UpdateAccountRequest {
  password?: string;
  new_password?: string;
}

// --- Response types ---

interface PushResponse {
  accepted: number;
  rejected: number;
  cursor: string | null;
  storage_used_bytes: number;
  storage_quota_bytes: number;
}

interface PullResponse {
  events: PullEvent[];
  cursor: string | null;
  has_more: boolean;
  total_pending: number;
}

interface PullEvent {
  project_id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  source_machine_id: string;
  encrypted_blob_url: string;
  encrypted_blob_key: string;
  encrypted_size_bytes: number;
  metadata: {
    token_count_input: number;
    token_count_output: number;
    model: string | null;
    tool_name: string | null;
  };
}

// --- Internal types ---

interface AccountRow {
  user_id: string;
  email: string;
  password_hash: string;
  tier: string;
  jurisdiction: string;
  email_verified: number;
  storage_used_bytes: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface EventMetaRow {
  id: number;
  machine_id: string;
  project_id: string;
  session_id: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  encrypted_blob_key: string;
  encrypted_blob_sha256: string;
  encrypted_size_bytes: number;
  token_count_input: number;
  token_count_output: number;
  model: string | null;
  tool_name: string | null;
  synced_at: string;
}

interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  message?: string;
  upgrade_url?: string;
}

interface UsageSummary {
  daily: Array<{
    date: string;
    events: number;
    input_tokens: number;
    output_tokens: number;
    bytes: number;
  }>;
}

interface ProjectUsage {
  project_id: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
  bytes: number;
}

interface ModelUsage {
  model: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
}
```

### Helper Functions

```typescript
// src/helpers.ts

function generateId(length: number = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

function currentHourKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`;
}

function secondsUntilNextHour(): number {
  const now = new Date();
  return 3600 - now.getUTCMinutes() * 60 - now.getUTCSeconds();
}

function getQuotaBytes(tier: string): number {
  return TIER_LIMITS[tier]?.storageBytes || TIER_LIMITS.free.storageBytes;
}

function getMachineLimit(tier: string): number {
  return TIER_LIMITS[tier]?.machineLimit ?? TIER_LIMITS.free.machineLimit;
}

function getRetentionDays(tier: string): number {
  return TIER_LIMITS[tier]?.retentionDays ?? TIER_LIMITS.free.retentionDays;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}
```

### Infrastructure Cost Per User

| Component | Monthly Cost |
|-----------|-------------|
| DO requests | ~$0.0002 |
| DO storage (SQLite metadata) | ~$0.004 |
| R2 storage (encrypted blobs) | ~$0.002 |
| R2 operations | ~$0.015 |
| Worker requests | included |
| **Total per active user** | **~$0.02/month** |

### Security Headers

All API responses include:
```
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store
```

### Rate Limit Headers

Rate-limited responses include:
```
Retry-After: <seconds until next hour>
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: <unix timestamp of next hour>
```

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | JWT generation and verification with correct claims |
| T-2 | JWT rejection for expired tokens |
| T-3 | JWT rejection for wrong issuer/audience |
| T-4 | Password hashing and verification with Argon2id |
| T-5 | Rate limit counter increments correctly for free tier |
| T-6 | Rate limit resets at hour boundary |
| T-7 | Tier limits object returns correct values for each tier |
| T-8 | Quota check passes when under limit |
| T-9 | Quota check fails with descriptive message when over limit |
| T-10 | Machine limit enforcement for each tier |
| T-11 | generateId produces unique, correctly-formatted IDs |
| T-12 | base64ToArrayBuffer correctly converts base64 to binary |
| T-13 | hexToArrayBuffer correctly converts hex to binary |
| T-14 | formatBytes produces human-readable output |
| T-15 | currentHourKey returns consistent format |

### Integration Tests (Miniflare)

| Test | Description |
|------|-------------|
| T-16 | Register new user → receive user_id and verification message |
| T-17 | Register with existing email → receive 409 conflict |
| T-18 | Login with correct credentials → receive JWT + refresh token |
| T-19 | Login with wrong password → receive 401 |
| T-20 | Register machine → receive machine_id |
| T-21 | Register machine beyond tier limit → receive 403 with upgrade prompt |
| T-22 | Push events → R2 objects created, events_meta rows inserted |
| T-23 | Push events exceeding storage quota → receive 413 with upgrade prompt |
| T-24 | Push duplicate events (same machine/project/session/sequence) → idempotent, accepted: 0 |
| T-25 | Pull events → receive events from other machines only |
| T-26 | Pull with cursor → receive only events after cursor position |
| T-27 | Pull with no cursor → receive all events from other machines |
| T-28 | WebSocket upgrade for Pro user → 101 success |
| T-29 | WebSocket upgrade for Free user → 403 rejection |
| T-30 | Push triggers WebSocket notification to connected clients |
| T-31 | WebSocket heartbeat received within 30 seconds |
| T-32 | Account deletion → all DO data cleared, R2 prefix deleted, KV purged |
| T-33 | Account deletion audit trail → deletion_log records all steps |
| T-34 | EU user registration → routed to EU DO and R2 bucket |
| T-35 | Free user requests EU → falls back to default jurisdiction |
| T-36 | Usage aggregation → correct per-day, per-project, per-model sums |
| T-37 | Retention cleanup → expired events deleted from events_meta and R2 |
| T-38 | Retention cleanup respects tier-specific retention days |
| T-39 | Refresh token rotation → old token invalidated, new token works |
| T-40 | Health endpoint returns 200 without auth |

### End-to-End Tests

| Test | Description |
|------|-------------|
| T-41 | Full sync cycle: push from machine A, pull from machine B, verify blob integrity |
| T-42 | Free tier lifecycle: register, add 2 machines, sync 10 times, hit rate limit, see upgrade prompt |
| T-43 | Pro tier lifecycle: register, add 5 machines, WebSocket stream, verify real-time notifications |
| T-44 | Account deletion E2E: register, push events, delete account, verify R2 empty, verify login fails |
| T-45 | Upgrade path: free user hits limit, upgrade to pro, verify new limits take effect |

### Load Tests

| Test | Description |
|------|-------------|
| T-46 | 100 concurrent pushes from different machines to the same DO |
| T-47 | 1000 events in a single push request (batch size limit) |
| T-48 | 50 concurrent WebSocket connections sending pings |
| T-49 | R2 prefix deletion of 10,000 objects (crypto-shredding at scale) |

---

## Definition of Done

- [ ] Cloudflare Worker deploys and handles all 15 API endpoints
- [ ] JWT authentication works with access and refresh token lifecycle
- [ ] Per-user Durable Object creates SQLite schema on first access
- [ ] Push operation stores encrypted blobs in R2 and metadata in SQLite atomically
- [ ] Pull operation returns only unseen events using cursor-based pagination
- [ ] WebSocket streaming sends real-time notifications for Pro/Team users
- [ ] Free tier users are blocked from WebSocket with clear upgrade prompt
- [ ] Machine registry enforces per-tier device limits
- [ ] Sync cursors track per-machine pull position and handle gaps
- [ ] Usage aggregation produces per-day, per-project, per-model breakdowns
- [ ] Account registration, login, and JWT refresh work end-to-end
- [ ] Crypto-shredding deletes all DO data, R2 objects, and KV entries with audit trail
- [ ] EU data residency routes to EU-jurisdiction DO and R2 for Pro/Team users
- [ ] Tier enforcement checks storage quotas, machine limits, sync rates, and feature access
- [ ] Web portal shows account management, machine list, and usage without any encrypted data
- [ ] Retention cleanup runs on alarm and deletes expired events per tier policy
- [ ] All 12 edge cases are handled as documented
- [ ] All 49 test cases from the testing plan pass
- [ ] Wrangler config is valid and deployable to staging and production
- [ ] Security headers are set on all responses
- [ ] Error responses follow consistent JSON format with actionable messages
- [ ] Rate limit headers are included on 429 responses
- [ ] Infrastructure cost per active user stays under $0.05/month
