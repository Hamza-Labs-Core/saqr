# Implementation Plan: Story 17 -- Sync Server (Cloudflare Edge)

**Date**: 2026-02-22
**Story**: 17-sync-server
**Status**: Planning
**Estimated Total Effort**: ~14 days (56-70 hours)
**Prerequisites**: Platform evaluation completed (`docs/PLATFORM-EVALUATION.md`). Story 10 (Security & Encryption) design finalized for client-side encryption contract. Cloudflare account with Workers Paid plan ($5/mo base).
**Architecture**: Cloudflare Workers + Durable Objects (DO-only, no WfP). See `docs/PLATFORM-EVALUATION.md` for decision rationale.

### Relationship to Other Stories

This is the **cloud infrastructure story**. It provides the server-side sync layer that client-side stories push to and pull from.

- **Story 10** (Security & Encryption): Defines client-side XChaCha20-Poly1305 encryption. The sync server never decrypts -- it stores opaque blobs. The encryption contract (blob format, SHA-256 integrity, base64 encoding) is consumed by Tasks 3 and 5.
- **Story 18** (Sync Client): The CLI client that pushes/pulls events to/from this server. Depends on all API endpoints defined here.
- **Story 00** (Installation): The local installation story. Independent -- sync server is a separate Cloudflare deployment, not installed locally.
- **Stories 01-05** (Event Capture, Hooks, Storage, Projections, Context Recovery): Local event pipeline. The sync server mirrors these events to the cloud in encrypted form.
- **Story 13** (CLI Session Rendering / Mobile App): Consumes sync API for cross-device access.

### Amendment Impacts on This Plan

- **Platform Evaluation decision**: DO-only architecture (no R2 for primary storage). R2 is used only for overflow blobs exceeding DO's 2MB row limit, exports, and backups. Encrypted blobs are stored inline in DO SQLite as BLOB columns for events under 2MB.
- **XChaCha20-Poly1305**: Selected over AES-256-GCM for 192-bit nonce safety and NaCl/Paseo compatibility.
- **Argon2id**: Via libsodium WASM for password hashing. Same KDF as client-side encryption passphrase derivation.

---

## Task Dependency Graph

```
Task 1: Project Scaffolding (wrangler, tsconfig, deps)
  |
  +---> Task 2: Type Definitions & Helpers
  |       |
  |       +---> Task 3: Worker Entry Point & Middleware Chain
  |       |       |
  |       |       +---> Task 5: Durable Object Core (schema, routing)
  |       |       |       |
  |       |       |       +---> Task 6: Push Handler (event ingestion)
  |       |       |       |       |
  |       |       |       |       +---> Task 7: Pull Handler (cursor-based retrieval)
  |       |       |       |       |
  |       |       |       |       +---> Task 8: WebSocket Notifications
  |       |       |       |
  |       |       |       +---> Task 9: Machine Registry
  |       |       |       |
  |       |       |       +---> Task 10: Usage Aggregation
  |       |       |       |
  |       |       |       +---> Task 11: Account Management (CRUD, settings)
  |       |       |
  |       |       +---> Task 4: Auth Handlers (register, login, refresh, verify)
  |       |               |
  |       |               +---> Task 11 (auth feeds into account management)
  |       |
  |       +---> Task 12: Tier Enforcement & Quota Checks
  |               |
  |               +---> Task 6, 9, 8 (consume tier limits)
  |
  +---> Task 13: Crypto-Shredding (account deletion)
  |       (needs Tasks 5, 6, 9)
  |
  +---> Task 14: EU Data Residency
  |       (needs Tasks 3, 5)
  |
  +---> Task 15: Web Portal (static account management UI)
  |       (needs Tasks 4, 9, 10, 11)
  |
  +---> Task 16: Testing (unit, integration via Miniflare, E2E)
  |       (needs all)
  |
  +---> Task 17: Deployment Configuration (staging, production, CI)
          (needs all)
```

---

## Tasks

### Task 1: Project Scaffolding

**Description**

Initialize the Cloudflare Workers project with wrangler, TypeScript configuration, and all dependencies. This creates the directory structure, package.json, wrangler.toml, and development tooling that all subsequent tasks build on.

**Prerequisites/Inputs**

- Cloudflare account with Workers Paid plan activated
- `wrangler` CLI installed globally (`npm install -g wrangler`)
- Node.js 18+ on the development machine

**Implementation Details**

**Directory structure** (under a new `sync-server/` directory at the project root):

```
/home/meywd/GlobalContext/sync-server/
  package.json
  tsconfig.json
  wrangler.toml
  vitest.config.ts
  src/
    worker.ts           # Worker entry point (Task 3)
    durable-object.ts   # UserDurableObject class (Task 5)
    middleware.ts        # Middleware chain (Task 3)
    auth.ts             # Auth handlers (Task 4)
    types.ts            # Type definitions (Task 2)
    helpers.ts          # Utility functions (Task 2)
    tier-limits.ts      # Tier configuration (Task 12)
    r2-storage.ts       # R2 overflow/export operations (Task 6)
  test/
    unit/               # Vitest unit tests
    integration/        # Miniflare integration tests
  portal/
    index.html          # Web portal (Task 15)
    styles.css
    app.js
```

**`package.json`:**
```json
{
  "name": "agentctx-sync",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "miniflare": "^3.20260101.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0"
  },
  "dependencies": {
    "libsodium-wrappers-sumo": "^0.7.15"
  }
}
```

**`wrangler.toml`:**

As specified in Story 17, Section 1 (Worker API Layer). Key points:
- `name = "agentctx-sync"`
- `main = "src/worker.ts"`
- `compatibility_date = "2026-02-01"` with `nodejs_compat` flag
- Smart placement enabled
- R2 buckets: `EVENTS_BUCKET` (default) and `EVENTS_BUCKET_EU` (eu jurisdiction)
- DO bindings: `USER_DO` and `USER_DO_EU`
- SQLite migration tag `v1` for `UserDurableObject`
- KV namespace: `AUTH_KV`
- Tier limit vars in `[vars]` section
- Staging and production route configurations

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "test"]
}
```

**Shell commands to scaffold:**
```bash
mkdir -p /home/meywd/GlobalContext/sync-server/{src,test/{unit,integration},portal}
cd /home/meywd/GlobalContext/sync-server
npm init -y  # then edit package.json as above
npm install --save-dev @cloudflare/workers-types typescript vitest miniflare @cloudflare/vitest-pool-workers
npm install libsodium-wrappers-sumo
```

**Acceptance Criteria**

- [ ] `sync-server/` directory exists with all subdirectories
- [ ] `npm install` completes without errors
- [ ] `npx tsc --noEmit` passes (once placeholder files exist)
- [ ] `npx wrangler dev` starts the local development server (once worker.ts exists)
- [ ] `wrangler.toml` matches the Story 17 specification exactly
- [ ] All tier limit vars are defined in `[vars]` with correct byte values
- [ ] R2 bucket bindings include EU jurisdiction variant
- [ ] DO migration tag `v1` declares `new_sqlite_classes`

**Edge Cases**

- Node version < 18: `wrangler` will fail with a clear error during `npm install`
- Missing wrangler auth: `wrangler dev` requires `wrangler login` first. The README (not created here) should document this.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 2: Type Definitions & Helpers

**Description**

Define all TypeScript interfaces, type aliases, and utility functions used across the Worker, Durable Object, and middleware. This is the shared foundation that every other module imports.

**Prerequisites/Inputs**

- Task 1 (project scaffolding complete)
- Story 17 "Technical Specifications" section (type definitions)

**Implementation Details**

**File: `sync-server/src/types.ts`**

Contains all request/response interfaces and internal row types exactly as specified in Story 17's "Type Definitions" section:

- `RegisterRequest`, `LoginRequest`, `RegisterMachineRequest`
- `PushRequest`, `PushEvent`, `PullRequest`, `DeleteAccountRequest`, `UpdateAccountRequest`
- `PushResponse`, `PullResponse`, `PullEvent`
- `AccountRow`, `EventMetaRow`, `QuotaCheckResult`
- `UsageSummary`, `ProjectUsage`, `ModelUsage`
- `AuthContext` (userId, email, tier, jurisdiction, machineId)
- `Env` interface (USER_DO, USER_DO_EU, EVENTS_BUCKET, EVENTS_BUCKET_EU, AUTH_KV, JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE, plus all tier limit vars)
- `WebSocketSession` (machineId, connectedAt, subscriptions)
- `TierLimits` interface (machineLimit, storageBytes, retentionDays, syncRatePerHour, webSocketAllowed, euResidencyAllowed)
- `DeletionLogRow` (deletion_id, user_id, status, timestamps)

**File: `sync-server/src/helpers.ts`**

All helper functions from Story 17's "Helper Functions" section:

```typescript
export function generateId(length?: number): string;
export function currentHourKey(): string;
export function secondsUntilNextHour(): number;
export function getQuotaBytes(tier: string): number;
export function getMachineLimit(tier: string): number;
export function getRetentionDays(tier: string): number;
export function formatBytes(bytes: number): string;
export function jsonResponse(status: number, body: object, extraHeaders?: Record<string, string>): Response;
export function base64ToArrayBuffer(base64: string): ArrayBuffer;
export function hexToArrayBuffer(hex: string): ArrayBuffer;
export function errorResponse(status: number, error: string, message: string, extra?: object): Response;
```

Additional helpers not in the story but needed:
```typescript
// Security headers applied to every response
export function withSecurityHeaders(response: Response): Response;
// Adds: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, Cache-Control

// CORS headers for web portal
export function withCorsHeaders(response: Response, origin: string): Response;

// Validate email format (RFC 5322 simplified)
export function isValidEmail(email: string): boolean;

// Validate password requirements (>= 12 chars, <= 1024 chars)
export function isValidPassword(password: string): boolean;
```

**Acceptance Criteria**

- [ ] All TypeScript interfaces compile without errors
- [ ] `generateId()` produces 12-character lowercase alphanumeric strings by default
- [ ] `generateId()` uses `crypto.getRandomValues` for randomness
- [ ] `currentHourKey()` returns format `YYYY-MM-DDThh`
- [ ] `secondsUntilNextHour()` returns a value between 0 and 3600
- [ ] `formatBytes()` outputs human-readable strings (B, KB, MB, GB)
- [ ] `jsonResponse()` sets Content-Type to application/json
- [ ] `withSecurityHeaders()` adds all 4 required security headers
- [ ] `base64ToArrayBuffer()` correctly round-trips with btoa/atob
- [ ] `hexToArrayBuffer()` correctly converts hex strings to ArrayBuffer
- [ ] `isValidEmail()` rejects empty strings, missing @, missing domain
- [ ] `isValidPassword()` rejects strings shorter than 12 characters

**Edge Cases**

- `generateId()` with crypto unavailable: Workers always have `crypto.getRandomValues`; no fallback needed.
- `formatBytes(0)` returns `"0 B"`.
- `base64ToArrayBuffer("")` returns empty ArrayBuffer.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 3: Worker Entry Point & Middleware Chain

**Description**

Implement the Worker's `fetch` handler that serves as the API gateway. It routes unauthenticated endpoints directly to handlers, and authenticated endpoints through the middleware chain (JWT verify, rate limit, tier check) before forwarding to the per-user Durable Object.

**Prerequisites/Inputs**

- Task 2 (types and helpers)
- Story 17, Section 1 (Worker API Layer) -- middleware chain specification
- Platform Evaluation, Section 6 (Auth & Rate Limiting) -- rate limiting binding

**Implementation Details**

**File: `sync-server/src/middleware.ts`**

```typescript
import { Env, AuthContext } from "./types";

type Middleware = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authCtx: AuthContext | null
) => Promise<Response | null>;

export const middlewareChain: Middleware[] = [
  jwtVerifyMiddleware,
  rateLimitMiddleware,
  tierCheckMiddleware,
];

// JWT verification using HMAC-SHA256 via WebCrypto
async function jwtVerifyMiddleware(...): Promise<Response | null>;

// Rate limit check for free tier users via AUTH_KV counter
async function rateLimitMiddleware(...): Promise<Response | null>;

// Tier-based feature gating (WebSocket for Pro+, EU for Pro+)
async function tierCheckMiddleware(...): Promise<Response | null>;

// JWT helper functions
export async function verifyJWT(
  token: string, secret: string, options: { issuer: string; audience: string }
): Promise<JWTPayload>;

export async function signJWT(
  payload: Record<string, unknown>, secret: string, expiresIn: number
): Promise<string>;

// Extract AuthContext from verified JWT payload
export async function extractAuthContext(request: Request, env: Env): Promise<AuthContext>;
```

JWT implementation using WebCrypto (no external JWT library):
- Algorithm: HMAC-SHA256 (HS256)
- Header: `{"alg":"HS256","typ":"JWT"}`
- Payload claims: `sub`, `email`, `tier`, `jurisdiction`, `iat`, `exp`, `iss`, `aud`
- Verification: check signature, check expiry, check issuer, check audience
- Key import: `crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])`

Rate limiting implementation:
- Free tier: 10 sync operations per hour (push + pull combined)
- Counter stored in AUTH_KV with key `ratelimit:{userId}:{hourKey}` and 2-hour TTL
- Returns `429` with `Retry-After` header when limit exceeded
- Pro/Team: no rate limit (middleware returns null immediately)

**File: `sync-server/src/worker.ts`**

```typescript
import { Env, AuthContext } from "./types";
import { middlewareChain, extractAuthContext } from "./middleware";
import { handleRegister, handleLogin, handleRefresh, handleVerifyEmail } from "./auth";
import { UserDurableObject } from "./durable-object";

export { UserDurableObject };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check -- no auth
    if (url.pathname === "/api/health") { ... }

    // CORS preflight
    if (request.method === "OPTIONS") { ... }

    // Public auth endpoints -- bypass middleware
    if (url.pathname.startsWith("/api/auth/")) { ... }

    // Static portal files
    if (!url.pathname.startsWith("/api/")) { ... }

    // Authenticated endpoints -- run middleware chain
    let authCtx: AuthContext | null = null;
    for (const mw of middlewareChain) {
      const response = await mw(request, env, ctx, authCtx);
      if (response) return withSecurityHeaders(response);
      if (!authCtx) authCtx = await extractAuthContext(request, env);
    }

    // Route to per-user DO
    const doNamespace = authCtx.jurisdiction === "eu" ? env.USER_DO_EU : env.USER_DO;
    const doId = doNamespace.idFromName(authCtx.userId);
    const doStub = doNamespace.get(doId);

    const doRequest = new Request(request.url, request);
    doRequest.headers.set("X-Auth-Context", JSON.stringify(authCtx));

    return withSecurityHeaders(await doStub.fetch(doRequest));
  },
};
```

Request body size limit: 10 MB. Check `Content-Length` header before reading body. Return 413 if exceeded.

**Acceptance Criteria**

- [ ] Worker routes all 15 API endpoints correctly per the endpoint table
- [ ] Health endpoint returns `{"status":"ok","timestamp":"..."}` without auth
- [ ] JWT middleware rejects missing `Authorization` header with 401
- [ ] JWT middleware rejects `Bearer <invalid>` with 401 and "Token expired or invalid"
- [ ] JWT middleware passes valid tokens and populates `authCtx`
- [ ] Rate limit middleware returns 429 with `Retry-After` for free tier over 10/hour
- [ ] Rate limit middleware passes Pro/Team users without checking
- [ ] Tier check middleware blocks free tier from `/api/sync/stream` with 403
- [ ] Public endpoints (register, login, verify-email, refresh, health) bypass middleware
- [ ] Requests are routed to correct DO namespace based on jurisdiction
- [ ] `X-Auth-Context` header is set on forwarded DO requests
- [ ] All responses include security headers
- [ ] CORS preflight returns 204 with appropriate headers
- [ ] Request body > 10 MB returns 413

**Edge Cases**

- Malformed JWT (not 3 dot-separated parts): caught in `verifyJWT`, returns 401.
- Expired JWT: `exp` claim checked against `Date.now() / 1000`, returns 401.
- JWT with wrong issuer/audience: returns 401.
- Rate limit KV read failure: fail-open (allow the request, log the error).
- Empty `Authorization` header value: returns 401.

**Estimated Effort**: L (Large) -- ~6 hours

---

### Task 4: Auth Handlers (Register, Login, Refresh, Verify Email)

**Description**

Implement the four public authentication endpoints that handle user registration, login, token refresh, and email verification. These endpoints run at the Worker level (not inside the DO) for registration/login discovery, but delegate to the user's DO for password verification and token issuance.

**Prerequisites/Inputs**

- Task 2 (types and helpers)
- Task 3 (worker entry point calls these handlers)
- Story 17, Section 8 (Account Management) -- registration/auth flows
- Platform Evaluation, Section 4.3 (Argon2id via libsodium)
- `libsodium-wrappers-sumo` npm package for Argon2id

**Implementation Details**

**File: `sync-server/src/auth.ts`**

```typescript
import _sodium from "libsodium-wrappers-sumo";

// Ensure libsodium is initialized before use
let sodiumReady: Promise<void> | null = null;
async function getSodium() {
  if (!sodiumReady) sodiumReady = _sodium.ready;
  await sodiumReady;
  return _sodium;
}

export async function handleRegister(request: Request, env: Env): Promise<Response>;
export async function handleLogin(request: Request, env: Env): Promise<Response>;
export async function handleRefresh(request: Request, env: Env): Promise<Response>;
export async function handleVerifyEmail(request: Request, env: Env): Promise<Response>;

// Password hashing with Argon2id via libsodium
async function hashPassword(password: string): Promise<string>;
async function verifyPassword(password: string, hash: string): Promise<boolean>;
```

**Registration flow** (`POST /api/auth/register`):

1. Parse and validate request body: `email` (valid format), `password` (>= 12 chars), `jurisdiction` (optional, "default" | "eu")
2. Check email uniqueness via `AUTH_KV.get(`email:${email}`)` -- if exists, return 409
3. Generate `user_id` = `usr_` + `generateId(12)`
4. Determine jurisdiction: if `"eu"` requested and tier is free, downgrade to `"default"` with note
5. Hash password with Argon2id: `sodium.crypto_pwhash_str(password, OPS_LIMIT_MODERATE, MEMLIMIT_MODERATE)`
   - **Note**: Argon2id in Workers is constrained by 128MB memory limit. Use `crypto_pwhash_OPSLIMIT_MODERATE` (3) and `crypto_pwhash_MEMLIMIT_MODERATE` (268435456 = 256MB). Since Workers have 128MB, fall back to `MEMLIMIT_INTERACTIVE` (67108864 = 64MB) with `OPSLIMIT_INTERACTIVE` (2).
   - If libsodium WASM exceeds memory, fall back to PBKDF2 with 600K iterations via WebCrypto.
6. Route to correct DO namespace based on jurisdiction
7. Forward to DO's internal `initAccount` method to create the account row
8. Store `email:{email}` -> `{userId, jurisdiction}` in AUTH_KV
9. Generate email verification token, store in AUTH_KV with 24-hour TTL: `verify:{token}` -> `{userId}`
10. Return 201 with user_id, email, tier, jurisdiction, email_verified: false

**Login flow** (`POST /api/auth/login`):

1. Parse and validate request body: `email`, `password`
2. Look up user via `AUTH_KV.get(`email:${email}`)` -- if not found, return 401 with generic "Invalid credentials"
3. Route to user's DO (correct jurisdiction from KV metadata)
4. DO verifies password hash with `sodium.crypto_pwhash_str_verify(storedHash, password)`
5. If verification fails: return 401 with generic "Invalid credentials" (no user enumeration)
6. Generate access token (JWT, 1 hour expiry) and refresh token (opaque, 30 day expiry)
7. Store refresh token hash in AUTH_KV: `refresh:{hash}` -> `{userId, exp}` with 30-day TTL
8. Return 200 with access_token, refresh_token, token_type, expires_in, user object

**Refresh flow** (`POST /api/auth/refresh`):

1. Extract refresh token from request body or `Authorization` header
2. Hash the refresh token, look up in AUTH_KV: `refresh:{hash}`
3. If not found or expired: return 401
4. Delete old refresh token entry from KV (rotation)
5. Issue new access token + new refresh token
6. Store new refresh token hash in KV
7. Return new token pair

**Email verification flow** (`POST /api/auth/verify-email`):

1. Extract verification token from request body
2. Look up in AUTH_KV: `verify:{token}`
3. If not found or expired: return 400
4. Route to user's DO, set `email_verified = 1` in account table
5. Delete verification token from KV
6. Return 200 with success message

**Password hashing strategy (Workers memory constraint)**:

The Workers 128MB isolate limit means we cannot use Argon2id's recommended 64MB memory parameter safely (libsodium WASM itself uses ~10-20MB). Strategy:
- Primary: Argon2id with `MEMLIMIT_INTERACTIVE` (64MB), `OPSLIMIT_INTERACTIVE` (2). This fits within 128MB.
- If that fails (OOM): catch the error, fall back to PBKDF2-SHA256 with 600,000 iterations via `crypto.subtle.deriveBits`.
- Store the algorithm used in the hash string (Argon2id encodes this natively; for PBKDF2 fallback, prefix with `$pbkdf2$`).

**Acceptance Criteria**

- [ ] Registration creates a user with `usr_` prefixed 12-char ID
- [ ] Registration stores email-to-userId mapping in AUTH_KV
- [ ] Duplicate email registration returns 409
- [ ] Registration validates email format (rejects invalid)
- [ ] Registration validates password length >= 12 characters
- [ ] Password is hashed with Argon2id before storage (never stored in plaintext)
- [ ] Login returns JWT access token (1 hour expiry) + refresh token (30 day expiry)
- [ ] Login with wrong password returns 401 with generic "Invalid credentials" (no user enumeration)
- [ ] Login with non-existent email returns 401 with same generic message
- [ ] Refresh token rotation: old token invalidated, new token issued
- [ ] Expired refresh token returns 401
- [ ] Email verification token is single-use with 24-hour TTL
- [ ] Email verification updates `email_verified` in account table
- [ ] Free tier user requesting EU jurisdiction gets `"default"` with explanatory note
- [ ] JWT contains correct claims: sub, email, tier, jurisdiction, iat, exp, iss, aud

**Edge Cases**

- E-11 (Duplicate email race condition): AUTH_KV put is not truly atomic. Use KV `put` with metadata check. If two registrations race, the second DO creation detects the account already exists and returns 409. The orphaned KV entry has a TTL and expires.
- Argon2id OOM in Worker: caught, falls back to PBKDF2. Both algorithms can verify hashes from either method.
- libsodium WASM initialization: `_sodium.ready` is cached after first call. Subsequent calls return immediately.
- Empty password: validated before hashing (returns 400).
- Very long password (> 1024 chars): rejected with 400.

**Estimated Effort**: XL (Extra Large) -- ~8 hours

---

### Task 5: Durable Object Core (Schema, Routing, Lifecycle)

**Description**

Implement the `UserDurableObject` class with SQLite schema initialization, request routing within the DO, and the alarm-based lifecycle for retention cleanup and heartbeat. This is the core DO skeleton that all handler methods attach to.

**Prerequisites/Inputs**

- Task 1 (project scaffolding)
- Task 2 (types)
- Task 3 (worker routes requests to DO)
- Story 17, Section 2 (Per-User Durable Object) -- schema, routing, alarm

**Implementation Details**

**File: `sync-server/src/durable-object.ts`**

```typescript
import { DurableObject } from "cloudflare:workers";
import { Env, AuthContext, WebSocketSession } from "./types";

export class UserDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    // CREATE TABLE IF NOT EXISTS for all 6 tables:
    // machines, events_meta, sync_cursors, usage_daily, account, deletion_log
    // Plus all indexes (CREATE INDEX IF NOT EXISTS)
    // Exactly as specified in Story 17, Section 2
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authCtx: AuthContext = JSON.parse(
      request.headers.get("X-Auth-Context") || "{}"
    );

    // Internal init endpoint (called by auth.ts during registration)
    if (url.pathname === "/_internal/init-account" && request.method === "POST") {
      return this.handleInitAccount(request);
    }

    // Internal password verify (called by auth.ts during login)
    if (url.pathname === "/_internal/verify-password" && request.method === "POST") {
      return this.handleVerifyPassword(request);
    }

    // WebSocket upgrade
    if (url.pathname === "/api/sync/stream") {
      return this.handleWebSocketUpgrade(request, authCtx);
    }

    // Route to handlers (push, pull, machines, account, usage, blob)
    // ... (each handler implemented in subsequent tasks)

    return jsonResponse(404, { error: "not_found", message: "Endpoint not found" });
  }

  // WebSocket Hibernation API handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void>;
  async webSocketError(ws: WebSocket, error: unknown): Promise<void>;

  // Alarm handler for periodic cleanup and heartbeat
  async alarm(): Promise<void>;

  // Internal: notify all connected WebSocket clients
  private notifyClients(message: object): void;
}
```

**SQLite schema** -- 6 tables with indexes, exactly as specified in Story 17 Section 2:

1. `machines` -- registered devices (machine_id PK, name, os, arch, hostname, timestamps, is_active)
2. `events_meta` -- cleartext event metadata (auto-increment id, machine_id, project_id, session_id, sequence, event_type, timestamp, encrypted_blob_key, sha256, size, tokens, model, tool, synced_at; UNIQUE on machine+project+session+sequence)
3. `sync_cursors` -- per-machine pull position (machine_id + source_machine_id PK, last_synced_id, last_synced_at)
4. `usage_daily` -- aggregated counters (date + project_id + model PK, event_count, token counts, blob_bytes)
5. `account` -- single row per user (user_id PK, email, password_hash, tier, jurisdiction, email_verified, storage_used_bytes, timestamps, deleted_at)
6. `deletion_log` -- audit trail (deletion_id PK, user_id, status, step timestamps)

**Alarm lifecycle**:
- If WebSocket connections exist: alarm fires every 30 seconds for heartbeat
- If no connections: alarm fires every 1 hour for retention cleanup
- Retention cleanup: delete events_meta rows where `timestamp < cutoff` based on tier's `retentionDays`. For each deleted row, also delete corresponding R2 blob (best-effort).
- Recalculate `account.storage_used_bytes` after cleanup.
- Send heartbeat JSON to all connected WebSockets. Remove any that throw on send.

**Internal endpoints** (prefixed with `/_internal/`, only callable from the Worker, not exposed externally):
- `/_internal/init-account`: Creates the initial account row during registration
- `/_internal/verify-password`: Verifies password hash during login, returns success/failure + account data
- `/_internal/set-email-verified`: Updates email_verified flag

These internal endpoints are not in the public API table. The Worker never exposes paths starting with `/_internal/` to external clients. The middleware chain in `worker.ts` rejects any external request to `/_internal/*`.

**Acceptance Criteria**

- [ ] DO creates all 6 SQLite tables on first instantiation
- [ ] Schema is idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`)
- [ ] All indexes from Story 17 are created
- [ ] `fetch()` routes to correct handler based on URL path and HTTP method
- [ ] `X-Auth-Context` header is parsed correctly
- [ ] Internal endpoints are accessible from Worker but not from external clients
- [ ] Alarm handler runs retention cleanup based on tier-specific retention days
- [ ] Alarm handler sends heartbeat to connected WebSocket clients
- [ ] Alarm re-schedules itself: 30s if connections exist, 1h if no connections
- [ ] WebSocket hibernation handlers (`webSocketMessage`, `webSocketClose`, `webSocketError`) are implemented
- [ ] `notifyClients` sends JSON to all connected sockets and cleans up failed ones
- [ ] Unknown routes return 404 with consistent error format

**Edge Cases**

- E-8 (WebSocket during DO eviction): WebSocket Hibernation API preserves connections across DO eviction. On wake, `this.ctx.getWebSockets()` restores the socket list. The in-memory `sessions` map must be rebuilt from `ws.deserializeAttachment()`.
- Schema migration: `initSchema()` uses `IF NOT EXISTS` so it's safe to call on every instantiation. Future schema changes will add new migration tags in `wrangler.toml`.
- Alarm already set: `setAlarm` overwrites any existing alarm. Only one alarm per DO is supported.

**Estimated Effort**: L (Large) -- ~6 hours

---

### Task 6: Push Handler (Event Ingestion)

**Description**

Implement the `handlePush` method on the Durable Object. This accepts encrypted event blobs from clients, stores them (in DO SQLite for blobs < 2MB, R2 for overflow), inserts cleartext metadata, updates usage aggregation, and notifies connected WebSocket clients.

**Prerequisites/Inputs**

- Task 5 (DO core with schema and routing)
- Task 12 (tier enforcement for storage quota check)
- Story 17, Section 2 (push handler code), Section 3 (R2 blob storage)
- Platform Evaluation, Section 2.2 (DO 2MB row limit)

**Implementation Details**

**In `sync-server/src/durable-object.ts`, method `handlePush`:**

```typescript
private async handlePush(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as PushRequest;
  const now = new Date().toISOString();

  // 1. Verify machine belongs to user
  const machine = this.sql.exec(
    "SELECT machine_id FROM machines WHERE machine_id = ? AND is_active = 1",
    body.machine_id
  ).one();
  if (!machine) return errorResponse(403, "unknown_machine", "Machine not registered");

  // 2. Check storage quota
  const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow;
  const quotaBytes = getQuotaBytes(account.tier);
  const incomingBytes = body.events.reduce((sum, e) => sum + e.encrypted_size_bytes, 0);

  if (quotaBytes > 0 && account.storage_used_bytes + incomingBytes > quotaBytes) {
    return errorResponse(413, "storage_exceeded", "Storage quota exceeded", {
      storage_used_bytes: account.storage_used_bytes,
      storage_quota_bytes: quotaBytes,
      upgrade_url: "https://agentctx.dev/pricing",
    });
  }

  // 3. Process each event
  const bucket = authCtx.jurisdiction === "eu" ? this.env.EVENTS_BUCKET_EU : this.env.EVENTS_BUCKET;
  let accepted = 0, rejected = 0;

  for (const event of body.events) {
    try {
      const blobData = body.blobs[event.encrypted_blob_sha256];
      if (!blobData) { rejected++; continue; }

      const blobBytes = base64ToArrayBuffer(blobData);

      // Store blob: DO SQLite for < 2MB, R2 for >= 2MB
      let blobKey: string;
      if (blobBytes.byteLength < 2 * 1024 * 1024) {
        // Store inline in DO SQLite (as a separate blobs table row)
        blobKey = `do://${event.encrypted_blob_sha256}`;
        this.sql.exec(
          "INSERT OR IGNORE INTO event_blobs (sha256, data, size) VALUES (?, ?, ?)",
          event.encrypted_blob_sha256,
          new Uint8Array(blobBytes),
          blobBytes.byteLength
        );
      } else {
        // Overflow to R2
        blobKey = `users/${authCtx.userId}/events/${body.machine_id}/${event.project_id}/${event.session_id}/${String(event.sequence).padStart(6, "0")}.enc`;
        await bucket.put(blobKey, blobBytes, {
          sha256: hexToArrayBuffer(event.encrypted_blob_sha256),
          customMetadata: {
            machine_id: body.machine_id,
            project_id: event.project_id,
            session_id: event.session_id,
            sequence: String(event.sequence),
            event_type: event.event_type,
          },
        });
      }

      // 4. Insert event metadata
      this.sql.exec(
        `INSERT OR IGNORE INTO events_meta
          (machine_id, project_id, session_id, sequence, event_type, timestamp,
           encrypted_blob_key, encrypted_blob_sha256, encrypted_size_bytes,
           token_count_input, token_count_output, model, tool_name, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        body.machine_id, event.project_id, event.session_id, event.sequence,
        event.event_type, event.timestamp, blobKey, event.encrypted_blob_sha256,
        event.encrypted_size_bytes,
        event.metadata?.token_count_input || 0,
        event.metadata?.token_count_output || 0,
        event.metadata?.model || null,
        event.metadata?.tool_name || null,
        now
      );

      // 5. Update usage aggregation (upsert)
      const dateStr = event.timestamp.slice(0, 10);
      this.sql.exec(
        `INSERT INTO usage_daily (date, project_id, model, event_count, token_count_input, token_count_output, blob_bytes)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(date, project_id, model) DO UPDATE SET
           event_count = event_count + 1,
           token_count_input = token_count_input + excluded.token_count_input,
           token_count_output = token_count_output + excluded.token_count_output,
           blob_bytes = blob_bytes + excluded.blob_bytes`,
        dateStr, event.project_id, event.metadata?.model || "unknown",
        event.metadata?.token_count_input || 0,
        event.metadata?.token_count_output || 0,
        event.encrypted_size_bytes
      );

      accepted++;
    } catch (err) {
      rejected++;
    }
  }

  // 6. Update storage counter
  this.sql.exec(
    `UPDATE account SET storage_used_bytes = (
      SELECT COALESCE(SUM(encrypted_size_bytes), 0) FROM events_meta
    ), updated_at = ?`, now
  );

  // 7. Update machine timestamps
  this.sql.exec(
    "UPDATE machines SET last_sync_at = ?, last_seen_at = ? WHERE machine_id = ?",
    now, now, body.machine_id
  );

  // 8. Increment rate limit for free tier
  if (authCtx.tier === "free") {
    const key = `ratelimit:${authCtx.userId}:${currentHourKey()}`;
    const count = parseInt((await this.env.AUTH_KV.get(key)) || "0");
    await this.env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 7200 });
  }

  // 9. Notify WebSocket clients
  this.notifyClients({
    type: "new_events",
    source_machine_id: body.machine_id,
    count: accepted,
    timestamp: now,
  });

  // 10. Build cursor and return
  const updatedAccount = this.sql.exec("SELECT storage_used_bytes FROM account LIMIT 1").one() as any;
  const lastEvent = this.sql.exec(
    "SELECT synced_at, sequence FROM events_meta WHERE machine_id = ? ORDER BY id DESC LIMIT 1",
    body.machine_id
  ).one() as any;
  const cursor = lastEvent ? `cur_${lastEvent.synced_at}_${lastEvent.sequence}` : null;

  return jsonResponse(200, {
    accepted, rejected, cursor,
    storage_used_bytes: updatedAccount.storage_used_bytes,
    storage_quota_bytes: quotaBytes,
  });
}
```

**Additional schema for DO-inline blob storage** (added to `initSchema`):

```sql
CREATE TABLE IF NOT EXISTS event_blobs (
  sha256  TEXT PRIMARY KEY,
  data    BLOB NOT NULL,
  size    INTEGER NOT NULL
);
```

This table stores encrypted blobs inline in DO SQLite when they are under 2MB. This is the DO-only architecture from the Platform Evaluation -- avoiding R2 Class A write costs for the common case.

**File: `sync-server/src/r2-storage.ts`**

```typescript
// R2 operations for overflow blobs (>= 2MB) and exports
export async function putOverflowBlob(
  bucket: R2Bucket, userId: string, machineId: string,
  projectId: string, sessionId: string, sequence: number,
  encryptedData: ArrayBuffer, sha256Hash: ArrayBuffer
): Promise<R2Object>;

export async function getBlob(
  bucket: R2Bucket, userId: string, blobKey: string
): Promise<R2ObjectBody | null>;

export async function deleteR2Prefix(
  bucket: R2Bucket, prefix: string
): Promise<number>;
```

**Acceptance Criteria**

- [ ] Push accepts encrypted events and stores blobs (inline for < 2MB, R2 for >= 2MB)
- [ ] `events_meta` rows are inserted with all required fields
- [ ] `INSERT OR IGNORE` prevents duplicate events (idempotent push)
- [ ] Storage quota is checked before accepting events
- [ ] Push beyond quota returns 413 with usage details and upgrade URL
- [ ] Usage aggregation is updated atomically with event insertion
- [ ] Machine `last_sync_at` and `last_seen_at` are updated
- [ ] Rate limit counter is incremented for free tier users
- [ ] WebSocket clients are notified of new events
- [ ] Push response includes `accepted`, `rejected`, `cursor`, `storage_used_bytes`, `storage_quota_bytes`
- [ ] SHA-256 integrity is validated on R2 uploads
- [ ] R2 key format matches: `users/{userId}/events/{machineId}/{projectId}/{sessionId}/{sequence}.enc`
- [ ] Blob data missing for a given SHA-256 hash increments `rejected` counter

**Edge Cases**

- E-1 (R2 outage): R2 put failure caught in try/catch, event rejected. Inline DO storage unaffected.
- E-2 (Concurrent push same machine): `INSERT OR IGNORE` + UNIQUE constraint handles dedup. Second push returns `accepted: 0`.
- E-3 (Machine ID spoofing): Machine lookup in `machines` table rejects unknown machine_ids.
- E-7 (Free tier approaches limit): Entire push rejected if `storage_used_bytes + incomingBytes > quotaBytes`. No partial acceptance.
- E-12 (Blob integrity failure): R2's `sha256` option validates on server side. Mismatch causes put to fail, event is rejected.
- Blob deduplication: `event_blobs` uses sha256 as PK. If two events reference the same blob (same content), it's stored once.

**Estimated Effort**: XL (Extra Large) -- ~8 hours

---

### Task 7: Pull Handler (Cursor-Based Retrieval)

**Description**

Implement the `handlePull` method on the Durable Object. This returns events from other machines that the requesting machine has not yet seen, using cursor-based pagination.

**Prerequisites/Inputs**

- Task 5 (DO core)
- Task 6 (push handler -- events must exist to pull)
- Story 17, Sections 2 and 5 (pull handler, sync cursors)

**Implementation Details**

**In `sync-server/src/durable-object.ts`, method `handlePull`:**

```typescript
private async handlePull(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as PullRequest;
  const now = new Date().toISOString();

  // 1. Resolve cursor position
  let fromId = 0;
  if (body.cursor) {
    const cursorRow = this.sql.exec(
      `SELECT last_synced_id FROM sync_cursors
       WHERE machine_id = ? AND source_machine_id = 'all'`,
      body.machine_id
    ).one() as any;
    if (cursorRow) fromId = cursorRow.last_synced_id;
  }

  // 2. Query events from other machines
  const limit = Math.min(body.limit || 100, 500);
  let query = "SELECT * FROM events_meta WHERE machine_id != ? AND id > ?";
  const params: any[] = [body.machine_id, fromId];

  if (body.project_id) {
    query += " AND project_id = ?";
    params.push(body.project_id);
  }

  query += " ORDER BY id ASC LIMIT ?";
  params.push(limit + 1); // +1 for has_more detection

  const rows = this.sql.exec(query, ...params).toArray() as EventMetaRow[];
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);

  // 3. Build response
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

  // 4. Advance cursor (only if events were returned)
  if (events.length > 0) {
    const lastId = (events[events.length - 1] as any).id;
    this.sql.exec(
      `INSERT INTO sync_cursors (machine_id, source_machine_id, last_synced_id, last_synced_at)
       VALUES (?, 'all', ?, ?)
       ON CONFLICT(machine_id, source_machine_id) DO UPDATE SET
         last_synced_id = excluded.last_synced_id,
         last_synced_at = excluded.last_synced_at`,
      body.machine_id, lastId, now
    );
  }

  // 5. Update machine last_seen_at
  this.sql.exec(
    "UPDATE machines SET last_seen_at = ? WHERE machine_id = ?",
    now, body.machine_id
  );

  // 6. Count total pending
  const pendingFromId = events.length > 0 ? (events[events.length - 1] as any).id : fromId;
  const pendingRow = this.sql.exec(
    "SELECT COUNT(*) as cnt FROM events_meta WHERE machine_id != ? AND id > ?",
    body.machine_id, pendingFromId
  ).one() as any;

  // 7. Build cursor string
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

// Blob retrieval endpoint
private async handleGetBlob(blobHash: string, authCtx: AuthContext): Promise<Response> {
  // First check DO-inline storage
  const inlineBlob = this.sql.exec(
    "SELECT data FROM event_blobs WHERE sha256 = ?", blobHash
  ).one() as any;

  if (inlineBlob) {
    return new Response(inlineBlob.data, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  // Fall back to R2
  const blobMeta = this.sql.exec(
    "SELECT encrypted_blob_key FROM events_meta WHERE encrypted_blob_sha256 = ? LIMIT 1",
    blobHash
  ).one() as any;

  if (!blobMeta) {
    return errorResponse(404, "blob_not_found", "Encrypted blob not found");
  }

  const blobKey = blobMeta.encrypted_blob_key;
  if (!blobKey.startsWith(`users/${authCtx.userId}/`)) {
    return errorResponse(403, "access_denied", "Blob does not belong to this user");
  }

  const bucket = authCtx.jurisdiction === "eu" ? this.env.EVENTS_BUCKET_EU : this.env.EVENTS_BUCKET;
  const r2Object = await bucket.get(blobKey);
  if (!r2Object) {
    return errorResponse(404, "blob_not_found", "Encrypted blob not found in storage");
  }

  return new Response(r2Object.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}
```

**Acceptance Criteria**

- [ ] Pull returns events from other machines only (excludes requesting machine's own events)
- [ ] Pull with no cursor returns all events from other machines
- [ ] Pull with cursor returns only events with `id > last_synced_id`
- [ ] Pagination limit defaults to 100, max 500
- [ ] `has_more` is true when more events exist beyond the page
- [ ] `total_pending` reflects remaining events after the returned page
- [ ] Cursor advances forward-only after successful pull
- [ ] Pulling 0 events does not modify cursor
- [ ] Project filter (`project_id` parameter) narrows results
- [ ] Blob retrieval checks DO inline storage first, then R2
- [ ] Blob retrieval validates key belongs to requesting user (path traversal prevention)
- [ ] Response includes `encrypted_blob_url` for lazy blob fetching

**Edge Cases**

- Cursor points to deleted event (retention cleanup): `WHERE id > cursor_id` naturally skips gaps. No error.
- E-9 (Clock skew): Sync ordering uses `events_meta.id` (auto-increment), not timestamps. Clock skew is irrelevant for sync correctness.
- Empty pull (no events from other machines): returns `events: [], cursor: null, has_more: false, total_pending: 0`.
- Machine not registered: The pull should still work (machine_id is used for filtering, not auth). But `last_seen_at` update will be a no-op if machine doesn't exist.

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 8: WebSocket Notifications

**Description**

Implement real-time WebSocket notifications using the Durable Object's WebSocket Hibernation API. Connected clients receive push notifications for new events, machine updates, tier changes, and heartbeats.

**Prerequisites/Inputs**

- Task 5 (DO core with WebSocket handlers)
- Task 6 (push handler triggers notifications)
- Story 17, Section 6 (WebSocket Notifications) -- message protocol
- Platform Evaluation, Section 2.1 (WebSocket Hibernation)

**Implementation Details**

**WebSocket upgrade handler:**

```typescript
private handleWebSocketUpgrade(request: Request, authCtx: AuthContext): Response {
  // Verify tier allows WebSocket
  if (authCtx.tier === "free") {
    return errorResponse(403, "tier_restricted",
      "Real-time sync requires Pro or Team tier.");
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Accept with hibernation API
  this.ctx.acceptWebSocket(server);

  // Store session metadata in WebSocket attachment (survives hibernation)
  server.serializeAttachment({
    machineId: authCtx.machineId || "unknown",
    connectedAt: new Date().toISOString(),
    lastPingAt: new Date().toISOString(),
    subscriptions: [] as string[],
  });

  // Set alarm for heartbeat if not already set
  this.ctx.storage.setAlarm(Date.now() + 30_000);

  return new Response(null, { status: 101, webSocket: client });
}
```

**Message handlers (Hibernation API):**

```typescript
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

  switch (data.type) {
    case "ping":
      ws.serializeAttachment({
        ...ws.deserializeAttachment(),
        lastPingAt: new Date().toISOString(),
      });
      ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
      break;

    case "subscribe":
      const attachment = ws.deserializeAttachment();
      attachment.subscriptions = data.project_ids || [];
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "subscribed", timestamp: new Date().toISOString() }));
      break;

    case "unsubscribe":
      const att = ws.deserializeAttachment();
      att.subscriptions = att.subscriptions.filter(
        (id: string) => !data.project_ids?.includes(id)
      );
      ws.serializeAttachment(att);
      ws.send(JSON.stringify({ type: "unsubscribed", timestamp: new Date().toISOString() }));
      break;

    default:
      ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
  }
}

async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
  // Hibernation API handles cleanup; no manual session map needed
}

async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
  ws.close(1011, "WebSocket error");
}
```

**Alarm handler (heartbeat + idle timeout):**

```typescript
async alarm(): Promise<void> {
  const webSockets = this.ctx.getWebSockets();
  const now = new Date();
  const nowISO = now.toISOString();

  // Check for idle connections (no ping in 120s)
  for (const ws of webSockets) {
    try {
      const attachment = ws.deserializeAttachment() as WebSocketSession;
      const lastPing = new Date(attachment.lastPingAt).getTime();
      if (now.getTime() - lastPing > 120_000) {
        ws.close(1000, "Idle timeout");
        continue;
      }
      // Send heartbeat
      ws.send(JSON.stringify({ type: "heartbeat", timestamp: nowISO }));
    } catch {
      try { ws.close(1011, "Error"); } catch { /* already closed */ }
    }
  }

  // Run retention cleanup (see Task 5 alarm logic)
  await this.runRetentionCleanup();

  // Reschedule alarm
  const activeConnections = this.ctx.getWebSockets().length;
  if (activeConnections > 0) {
    this.ctx.storage.setAlarm(Date.now() + 30_000); // 30s heartbeat
  } else {
    this.ctx.storage.setAlarm(Date.now() + 3600_000); // 1h cleanup check
  }
}
```

**Notification helper:**

```typescript
private notifyClients(message: object, excludeMachineId?: string): void {
  const payload = JSON.stringify(message);
  for (const ws of this.ctx.getWebSockets()) {
    try {
      const attachment = ws.deserializeAttachment() as WebSocketSession;
      // Skip the machine that triggered the notification
      if (excludeMachineId && attachment.machineId === excludeMachineId) continue;
      ws.send(payload);
    } catch {
      try { ws.close(1011, "Send failed"); } catch { /* already closed */ }
    }
  }
}
```

**Key design note**: Using `this.ctx.getWebSockets()` instead of an in-memory `Map<WebSocket, session>`. The Hibernation API preserves WebSocket state across DO evictions. Attachments (`serializeAttachment` / `deserializeAttachment`) store per-connection metadata that survives hibernation.

**Acceptance Criteria**

- [ ] WebSocket upgrade succeeds for Pro/Team users (101 response)
- [ ] WebSocket upgrade rejected for Free tier users (403 response)
- [ ] Server sends `heartbeat` every 30 seconds when connections exist
- [ ] Server closes connections idle for > 120 seconds (no ping received)
- [ ] `new_events` notification sent to all connected clients except the pushing machine
- [ ] `ping` from client triggers `pong` response
- [ ] `subscribe` stores project_id filter in WebSocket attachment
- [ ] `unsubscribe` removes project_ids from attachment
- [ ] Invalid message format returns `error` type response
- [ ] WebSocket hibernation preserves connections across DO eviction
- [ ] Alarm reschedules appropriately: 30s with connections, 1h without
- [ ] Disconnected/failed WebSockets are closed and cleaned up

**Edge Cases**

- E-8 (WebSocket during DO eviction): `this.ctx.getWebSockets()` returns all active sockets after wake. Attachments are preserved.
- Client sends binary WebSocket message: decoded from ArrayBuffer to string, then parsed as JSON.
- Client sends invalid JSON: caught in try/catch, error response sent.
- All clients disconnect simultaneously: next alarm finds 0 connections, switches to 1h schedule.

**Estimated Effort**: L (Large) -- ~5 hours

---

### Task 9: Machine Registry

**Description**

Implement machine registration, listing, and deactivation endpoints in the Durable Object. Machine count is enforced per tier.

**Prerequisites/Inputs**

- Task 5 (DO core with schema)
- Task 12 (tier limits for machine count)
- Story 17, Section 4 (Machine Registry)

**Implementation Details**

**In `sync-server/src/durable-object.ts`:**

```typescript
// POST /api/machines -- register a new machine
private async handleRegisterMachine(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as RegisterMachineRequest;

  // Check machine limit
  const activeCount = this.sql.exec(
    "SELECT COUNT(*) as cnt FROM machines WHERE is_active = 1"
  ).one() as any;
  const machineLimit = getMachineLimit(authCtx.tier);

  if (machineLimit > 0 && activeCount.cnt >= machineLimit) {
    return errorResponse(403, "machine_limit_reached",
      `Your ${authCtx.tier} tier allows ${machineLimit} machines. You have ${activeCount.cnt}.`,
      { current_count: activeCount.cnt, limit: machineLimit, upgrade_url: "https://agentctx.dev/pricing" });
  }

  const machineId = `mach_${generateId()}`;
  const now = new Date().toISOString();

  this.sql.exec(
    `INSERT INTO machines (machine_id, name, os, arch, hostname, registered_at, last_seen_at, agent_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    machineId, body.name, body.os, body.arch, body.hostname, now, now, body.agent_version || null
  );

  // Notify connected clients
  this.notifyClients({ type: "machine_update", machine_id: machineId, action: "registered", timestamp: now });

  return jsonResponse(201, { machine_id: machineId, name: body.name, os: body.os, registered_at: now });
}

// GET /api/machines -- list all active machines
private handleListMachines(authCtx: AuthContext): Response {
  const machines = this.sql.exec(
    "SELECT * FROM machines WHERE is_active = 1 ORDER BY registered_at ASC"
  ).toArray();
  return jsonResponse(200, { machines });
}

// DELETE /api/machines/:id -- soft-delete a machine
private handleDeleteMachine(machineId: string, authCtx: AuthContext): Response {
  const now = new Date().toISOString();
  const existing = this.sql.exec(
    "SELECT machine_id FROM machines WHERE machine_id = ? AND is_active = 1", machineId
  ).one();

  if (!existing) return errorResponse(404, "machine_not_found", "Machine not found or already deactivated");

  this.sql.exec("UPDATE machines SET is_active = 0, last_seen_at = ? WHERE machine_id = ?", now, machineId);

  this.notifyClients({ type: "machine_update", machine_id: machineId, action: "deactivated", timestamp: now });

  return jsonResponse(200, { deleted: true, machine_id: machineId });
}
```

**Input validation for `RegisterMachineRequest`:**
- `name`: non-empty string, max 100 characters
- `os`: must be one of `"linux"`, `"macos"`, `"windows"`
- `arch`: must be one of `"x64"`, `"arm64"`
- `hostname`: non-empty string, max 255 characters
- `agent_version`: optional string, max 20 characters

**Acceptance Criteria**

- [ ] Machine registration generates `mach_` prefixed unique ID
- [ ] Machine limit is enforced based on user's tier (2 free, 5 pro, unlimited team)
- [ ] Deactivated machines (`is_active = 0`) do not count toward the limit
- [ ] Listing returns only active machines
- [ ] Delete (deactivation) sets `is_active = 0`, does not delete data
- [ ] Machine metadata includes os, arch, hostname, timestamps
- [ ] `last_sync_at` is updated by push/pull handlers
- [ ] `last_seen_at` is updated on every request from that machine
- [ ] WebSocket clients notified on machine register/deactivate
- [ ] Input validation rejects invalid os/arch values with 400

**Edge Cases**

- Register machine at exact limit: allowed. Register machine at limit + 1: rejected with 403.
- Deactivate machine then register new one: works (deactivated doesn't count).
- Delete non-existent machine_id: returns 404.
- Reactivation: not supported in this story. Deactivated machines stay deactivated. User must register a new machine.

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 10: Usage Aggregation

**Description**

Implement the usage statistics endpoint that returns per-day, per-project, and per-model usage breakdowns. Usage data is collected during push (Task 6) and queried here.

**Prerequisites/Inputs**

- Task 5 (DO core with `usage_daily` table)
- Task 6 (push handler writes usage data)
- Story 17, Section 7 (Usage Aggregation)

**Implementation Details**

**In `sync-server/src/durable-object.ts`:**

```typescript
// GET /api/account/usage?start=YYYY-MM-DD&end=YYYY-MM-DD
private handleGetUsage(request: Request, authCtx: AuthContext): Response {
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start") || getDefaultStartDate(); // 30 days ago
  const endDate = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  // Validate date format
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return errorResponse(400, "invalid_date", "Date must be YYYY-MM-DD format");
  }

  // By date
  const byDate = this.sql.exec(
    `SELECT date, SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens,
            SUM(blob_bytes) as bytes
     FROM usage_daily WHERE date >= ? AND date <= ?
     GROUP BY date ORDER BY date ASC`,
    startDate, endDate
  ).toArray();

  // By project
  const byProject = this.sql.exec(
    `SELECT project_id, SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens,
            SUM(blob_bytes) as bytes
     FROM usage_daily WHERE date >= ? AND date <= ?
     GROUP BY project_id ORDER BY events DESC`,
    startDate, endDate
  ).toArray();

  // By model
  const byModel = this.sql.exec(
    `SELECT model, SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens
     FROM usage_daily WHERE date >= ? AND date <= ?
     GROUP BY model ORDER BY events DESC`,
    startDate, endDate
  ).toArray();

  // Totals
  const totals = this.sql.exec(
    `SELECT SUM(event_count) as events,
            SUM(token_count_input) as input_tokens,
            SUM(token_count_output) as output_tokens,
            SUM(blob_bytes) as storage_bytes
     FROM usage_daily WHERE date >= ? AND date <= ?`,
    startDate, endDate
  ).one() as any;

  const account = this.sql.exec("SELECT storage_used_bytes FROM account LIMIT 1").one() as any;

  return jsonResponse(200, {
    period: { start: startDate, end: endDate },
    totals: {
      events: totals?.events || 0,
      input_tokens: totals?.input_tokens || 0,
      output_tokens: totals?.output_tokens || 0,
      storage_bytes: account?.storage_used_bytes || 0,
    },
    by_date: byDate,
    by_project: byProject,
    by_model: byModel,
  });
}
```

**Helper:**
```typescript
function getDefaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
```

**Acceptance Criteria**

- [ ] Usage endpoint returns data for specified date range
- [ ] Default date range is last 30 days if not specified
- [ ] `by_date` array is sorted chronologically
- [ ] `by_project` array is sorted by event count (descending)
- [ ] `by_model` array is sorted by event count (descending)
- [ ] Totals correctly sum all metrics within the date range
- [ ] `storage_bytes` in totals reflects current account storage (not just the date range)
- [ ] Invalid date format returns 400 with clear message
- [ ] Empty date range (no events) returns zero counts, not null

**Edge Cases**

- Date range with no data: returns empty arrays and zero totals.
- Start date after end date: returns empty results (not an error -- SQL `WHERE date >= start AND date <= end` handles this).
- Very large date range (years of data): SQLite aggregation is efficient with the `idx_usage_daily_date` index.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 11: Account Management (CRUD & Settings)

**Description**

Implement account retrieval, update, and settings endpoints in the Durable Object. This covers `GET /api/account`, `PATCH /api/account` (password change), and the internal account initialization used during registration.

**Prerequisites/Inputs**

- Task 4 (auth handlers create accounts)
- Task 5 (DO core with account table)
- Story 17, Section 8 (Account Management)

**Implementation Details**

**In `sync-server/src/durable-object.ts`:**

```typescript
// /_internal/init-account -- called during registration
private async handleInitAccount(request: Request): Promise<Response> {
  const body = await request.json() as {
    user_id: string; email: string; password_hash: string;
    tier: string; jurisdiction: string;
  };
  const now = new Date().toISOString();

  // Check if account already exists (race condition guard)
  const existing = this.sql.exec("SELECT user_id FROM account LIMIT 1").one();
  if (existing) return errorResponse(409, "account_exists", "Account already exists in this DO");

  this.sql.exec(
    `INSERT INTO account (user_id, email, password_hash, tier, jurisdiction, email_verified, storage_used_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    body.user_id, body.email, body.password_hash, body.tier, body.jurisdiction, now, now
  );

  return jsonResponse(201, { created: true });
}

// /_internal/verify-password -- called during login
private async handleVerifyPassword(request: Request): Promise<Response> {
  const body = await request.json() as { password: string };
  const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow | null;

  if (!account || account.deleted_at) {
    return errorResponse(401, "invalid_credentials", "Invalid credentials");
  }

  const passwordValid = await verifyPassword(body.password, account.password_hash);
  if (!passwordValid) {
    return errorResponse(401, "invalid_credentials", "Invalid credentials");
  }

  return jsonResponse(200, {
    user_id: account.user_id,
    email: account.email,
    tier: account.tier,
    jurisdiction: account.jurisdiction,
    email_verified: account.email_verified,
    storage_used_bytes: account.storage_used_bytes,
  });
}

// GET /api/account
private handleGetAccount(authCtx: AuthContext): Response {
  const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow;
  const machineCount = this.sql.exec(
    "SELECT COUNT(*) as cnt FROM machines WHERE is_active = 1"
  ).one() as any;

  return jsonResponse(200, {
    user_id: account.user_id,
    email: account.email,
    tier: account.tier,
    jurisdiction: account.jurisdiction,
    email_verified: !!account.email_verified,
    storage_used_bytes: account.storage_used_bytes,
    machines_count: machineCount.cnt,
    created_at: account.created_at,
  });
}

// PATCH /api/account
private async handleUpdateAccount(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as UpdateAccountRequest;
  const now = new Date().toISOString();

  if (body.new_password) {
    // Verify current password first
    if (!body.password) {
      return errorResponse(400, "missing_password", "Current password required to set new password");
    }

    const account = this.sql.exec("SELECT password_hash FROM account LIMIT 1").one() as AccountRow;
    const valid = await verifyPassword(body.password, account.password_hash);
    if (!valid) return errorResponse(401, "invalid_credentials", "Current password is incorrect");

    if (!isValidPassword(body.new_password)) {
      return errorResponse(400, "invalid_password", "Password must be 12-1024 characters");
    }

    const newHash = await hashPassword(body.new_password);
    this.sql.exec("UPDATE account SET password_hash = ?, updated_at = ? WHERE 1", newHash, now);
  }

  return jsonResponse(200, { updated: true });
}

// /_internal/set-email-verified
private handleSetEmailVerified(request: Request): Response {
  const now = new Date().toISOString();
  this.sql.exec("UPDATE account SET email_verified = 1, updated_at = ? WHERE 1", now);
  return jsonResponse(200, { verified: true });
}
```

**Acceptance Criteria**

- [ ] `GET /api/account` returns user profile with email, tier, jurisdiction, storage, machine count
- [ ] `PATCH /api/account` requires current password to change password
- [ ] Password change validates new password (>= 12 chars)
- [ ] Password change hashes new password before storage
- [ ] Internal `init-account` creates account row with all required fields
- [ ] Internal `init-account` rejects if account already exists (409)
- [ ] Internal `verify-password` returns account data on success, 401 on failure
- [ ] Deleted accounts (`deleted_at` set) cannot authenticate
- [ ] `set-email-verified` updates the flag correctly

**Edge Cases**

- Account row missing (should never happen after init): return 500 with clear error.
- Password change with same password: allowed (no history check).
- PATCH with empty body: returns 200 with `updated: true` (no-op).

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 12: Tier Enforcement & Quota Checks

**Description**

Implement the centralized tier limits configuration and quota-checking functions used by push, machine registration, WebSocket, and rate limiting.

**Prerequisites/Inputs**

- Task 2 (TierLimits type definition)
- Story 17, Section 11 (Tier Enforcement)
- Platform Evaluation, Section 7 (Service Tiers)

**Implementation Details**

**File: `sync-server/src/tier-limits.ts`**

```typescript
import { TierLimits, QuotaCheckResult } from "./types";
import { formatBytes } from "./helpers";

export const TIER_LIMITS: Record<string, TierLimits> = {
  free: {
    machineLimit: 2,
    storageBytes: 50 * 1024 * 1024,          // 50 MB
    retentionDays: 30,
    syncRatePerHour: 10,
    webSocketAllowed: false,
    euResidencyAllowed: false,
  },
  pro: {
    machineLimit: 5,
    storageBytes: 1024 * 1024 * 1024,        // 1 GB
    retentionDays: 365,
    syncRatePerHour: 0,                       // unlimited
    webSocketAllowed: true,
    euResidencyAllowed: true,
  },
  team: {
    machineLimit: 0,                          // unlimited
    storageBytes: 10 * 1024 * 1024 * 1024,   // 10 GB
    retentionDays: 0,                         // unlimited
    syncRatePerHour: 0,                       // unlimited
    webSocketAllowed: true,
    euResidencyAllowed: true,
  },
};

export function getTierLimits(tier: string): TierLimits {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

export function checkStorageQuota(
  tier: string,
  currentBytes: number,
  incomingBytes: number
): QuotaCheckResult {
  const limits = getTierLimits(tier);
  if (limits.storageBytes > 0 && currentBytes + incomingBytes > limits.storageBytes) {
    return {
      allowed: false,
      reason: "storage_exceeded",
      message: `Storage quota exceeded (${formatBytes(currentBytes)} / ${formatBytes(limits.storageBytes)})`,
      upgrade_url: "https://agentctx.dev/pricing",
    };
  }
  return { allowed: true };
}

export function checkMachineLimit(
  tier: string,
  currentCount: number
): QuotaCheckResult {
  const limits = getTierLimits(tier);
  if (limits.machineLimit > 0 && currentCount >= limits.machineLimit) {
    return {
      allowed: false,
      reason: "machine_limit_reached",
      message: `Machine limit reached (${currentCount} / ${limits.machineLimit})`,
      upgrade_url: "https://agentctx.dev/pricing",
    };
  }
  return { allowed: true };
}

// Tier change handler (called when payment processor updates tier)
export function handleTierChange(
  oldTier: string,
  newTier: string,
  currentMachineCount: number,
  currentStorageBytes: number
): { warnings: string[] } {
  const warnings: string[] = [];
  const newLimits = getTierLimits(newTier);

  if (newLimits.machineLimit > 0 && currentMachineCount > newLimits.machineLimit) {
    warnings.push(
      `You have ${currentMachineCount} machines but ${newTier} tier allows ${newLimits.machineLimit}. ` +
      `Existing machines are not removed, but you cannot register new ones until under the limit.`
    );
  }

  if (newLimits.storageBytes > 0 && currentStorageBytes > newLimits.storageBytes) {
    warnings.push(
      `Your storage (${formatBytes(currentStorageBytes)}) exceeds ${newTier} tier limit (${formatBytes(newLimits.storageBytes)}). ` +
      `Existing data is preserved, but new pushes will be rejected until storage is reduced.`
    );
  }

  return { warnings };
}
```

**Acceptance Criteria**

- [ ] `TIER_LIMITS` object defines correct values for free, pro, and team tiers
- [ ] `checkStorageQuota` returns `allowed: false` when storage would exceed quota
- [ ] `checkStorageQuota` returns `allowed: true` when under quota
- [ ] `checkStorageQuota` treats `storageBytes: 0` as unlimited
- [ ] `checkMachineLimit` returns `allowed: false` at or above limit
- [ ] `checkMachineLimit` treats `machineLimit: 0` as unlimited
- [ ] Quota check error responses include current usage, limit, and upgrade URL
- [ ] Unknown tier falls back to free tier limits
- [ ] Tier change handler produces warnings for over-limit situations
- [ ] Downgrade does not delete existing data

**Edge Cases**

- E-4 (JWT tier stale after downgrade): The DO verifies tier from `account` table, not JWT. Tier limits are enforced at the DO level.
- E-7 (Free tier approaches limit): `checkStorageQuota` rejects entire push if total would exceed.
- Tier change from pro to free while at 4 machines: warning issued, no machines deactivated.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 13: Crypto-Shredding (Account Deletion)

**Description**

Implement the `DELETE /api/account` endpoint that performs full account deletion with audit trail. This is a multi-step process: verify identity, clear DO state, delete R2 blobs, purge KV entries, and log every step.

**Prerequisites/Inputs**

- Task 5 (DO core with deletion_log table)
- Task 6 (events and blobs to delete)
- Task 9 (machines to clear)
- Story 17, Section 9 (Crypto-Shredding)

**Implementation Details**

**In `sync-server/src/durable-object.ts`:**

```typescript
private async handleDeleteAccount(request: Request, authCtx: AuthContext): Promise<Response> {
  const body = await request.json() as DeleteAccountRequest;

  // 1. Verify confirmation string
  if (body.confirmation !== "DELETE MY ACCOUNT") {
    return errorResponse(400, "invalid_confirmation",
      'Confirmation string must be exactly "DELETE MY ACCOUNT"');
  }

  // 2. Verify password
  const account = this.sql.exec("SELECT * FROM account LIMIT 1").one() as AccountRow;
  const valid = await verifyPassword(body.password, account.password_hash);
  if (!valid) return errorResponse(401, "invalid_credentials", "Invalid password");

  // 3. Create deletion log entry
  const deletionId = `del_${generateId()}`;
  const now = new Date().toISOString();
  this.sql.exec(
    `INSERT INTO deletion_log (deletion_id, user_id, initiated_at, status)
     VALUES (?, ?, ?, 'initiated')`,
    deletionId, authCtx.userId, now
  );

  // 4. Close all WebSocket connections
  for (const ws of this.ctx.getWebSockets()) {
    try { ws.close(1000, "Account deleted"); } catch { /* ignore */ }
  }

  // 5. Clear DO state (keep deletion_log and anonymized account)
  this.sql.exec("DELETE FROM events_meta");
  this.sql.exec("DELETE FROM event_blobs");
  this.sql.exec("DELETE FROM sync_cursors");
  this.sql.exec("DELETE FROM usage_daily");
  this.sql.exec("DELETE FROM machines");
  this.sql.exec(
    "UPDATE account SET email = '[deleted]', password_hash = '[deleted]', deleted_at = ?, updated_at = ?",
    now, now
  );
  this.sql.exec(
    "UPDATE deletion_log SET do_cleared_at = ?, status = 'do_cleared' WHERE deletion_id = ?",
    now, deletionId
  );

  // 6. Delete R2 objects (may take time, batched)
  try {
    const bucket = authCtx.jurisdiction === "eu"
      ? this.env.EVENTS_BUCKET_EU
      : this.env.EVENTS_BUCKET;
    const prefix = `users/${authCtx.userId}/`;

    this.sql.exec(
      "UPDATE deletion_log SET status = 'r2_deleting' WHERE deletion_id = ?", deletionId
    );

    const deletedCount = await this.deleteR2PrefixBatched(bucket, prefix, deletionId);

    this.sql.exec(
      "UPDATE deletion_log SET r2_deleted_at = ?, status = 'r2_deleted' WHERE deletion_id = ?",
      new Date().toISOString(), deletionId
    );
  } catch (err) {
    // R2 deletion failed -- schedule retry via alarm
    this.sql.exec(
      "UPDATE deletion_log SET status = 'failed' WHERE deletion_id = ?", deletionId
    );
    this.ctx.storage.setAlarm(Date.now() + 1000); // retry in 1s
  }

  // 7. Purge KV entries
  try {
    await this.env.AUTH_KV.delete(`email:${account.email}`);
    // Rate limit keys expire naturally (2h TTL)
    // Refresh tokens expire naturally (30d TTL)
    this.sql.exec(
      "UPDATE deletion_log SET kv_purged_at = ?, status = 'kv_purged' WHERE deletion_id = ?",
      new Date().toISOString(), deletionId
    );
  } catch { /* best-effort */ }

  // 8. Mark complete
  this.sql.exec(
    "UPDATE deletion_log SET completed_at = ?, status = 'completed' WHERE deletion_id = ?",
    new Date().toISOString(), deletionId
  );

  return jsonResponse(200, {
    deleted: true,
    user_id: authCtx.userId,
    deletion_id: deletionId,
    message: "Account deleted. All encrypted data has been permanently destroyed.",
    crypto_shredded: true,
  });
}

// Batched R2 deletion (handles timeout)
private async deleteR2PrefixBatched(
  bucket: R2Bucket, prefix: string, deletionId: string
): Promise<number> {
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

**Alarm retry for failed R2 deletion:**
```typescript
// In alarm handler, check for incomplete deletions
async alarm(): Promise<void> {
  // Check for failed/incomplete deletions
  const pendingDeletion = this.sql.exec(
    "SELECT * FROM deletion_log WHERE status IN ('failed', 'r2_deleting') LIMIT 1"
  ).one() as DeletionLogRow | null;

  if (pendingDeletion) {
    const account = this.sql.exec("SELECT jurisdiction FROM account LIMIT 1").one() as any;
    const bucket = account?.jurisdiction === "eu"
      ? this.env.EVENTS_BUCKET_EU
      : this.env.EVENTS_BUCKET;

    try {
      await this.deleteR2PrefixBatched(bucket, `users/${pendingDeletion.user_id}/`, pendingDeletion.deletion_id);
      this.sql.exec(
        "UPDATE deletion_log SET r2_deleted_at = ?, status = 'completed', completed_at = ? WHERE deletion_id = ?",
        new Date().toISOString(), new Date().toISOString(), pendingDeletion.deletion_id
      );
    } catch {
      // Retry in 60 seconds
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // ... rest of alarm handler (heartbeat, retention cleanup)
}
```

**Acceptance Criteria**

- [ ] Account deletion requires password re-authentication
- [ ] Account deletion requires exact confirmation string "DELETE MY ACCOUNT"
- [ ] All `events_meta` rows are deleted
- [ ] All `event_blobs` rows are deleted
- [ ] All `sync_cursors` rows are deleted
- [ ] All `usage_daily` rows are deleted
- [ ] All `machines` rows are deleted
- [ ] Account email is anonymized to `[deleted]`
- [ ] Account `deleted_at` is set
- [ ] R2 objects under `users/{userId}/` are deleted in batches of 1000
- [ ] KV email mapping is deleted
- [ ] `deletion_log` records every step with timestamps
- [ ] Status progression: initiated -> do_cleared -> r2_deleting -> r2_deleted -> kv_purged -> completed
- [ ] Partial R2 failure triggers alarm-based retry
- [ ] WebSocket connections are closed before deletion
- [ ] Response includes `deletion_id` for reference
- [ ] Deleted account cannot log in (password_hash replaced with `[deleted]`)

**Edge Cases**

- E-5 (Deletion during active sync): DO processes requests serially. Deletion waits for in-flight requests.
- E-6 (R2 deletion timeout): Batched deletion with alarm retry. Account is immediately inaccessible after step 5.
- Wrong confirmation string: returns 400 immediately (no data touched).
- Wrong password: returns 401 immediately (no data touched).

**Estimated Effort**: L (Large) -- ~5 hours

---

### Task 14: EU Data Residency

**Description**

Implement EU-jurisdiction routing for users who select `jurisdiction: "eu"` at registration. This routes their DO and R2 storage to EU-specific bindings.

**Prerequisites/Inputs**

- Task 3 (worker routes to correct DO namespace)
- Task 4 (registration stores jurisdiction)
- Task 5 (DO core)
- Story 17, Section 10 (EU Data Residency)
- Platform Evaluation, Section 5.3 (DO jurisdiction hints)

**Implementation Details**

**Routing logic (already in worker.ts from Task 3):**

The Worker selects the DO namespace based on `authCtx.jurisdiction`:
```typescript
const doNamespace = authCtx.jurisdiction === "eu" ? env.USER_DO_EU : env.USER_DO;
```

**Registration jurisdiction handling (in auth.ts from Task 4):**
```typescript
// During registration
let jurisdiction = body.jurisdiction || "default";
if (jurisdiction === "eu" && tier === "free") {
  jurisdiction = "default"; // Free tier cannot select EU
  // Add note to response
}
```

**KV metadata for login routing:**
```typescript
// During registration, store jurisdiction in KV for login routing
await env.AUTH_KV.put(`email:${email}`, JSON.stringify({
  userId,
  jurisdiction,
}));

// During login, read jurisdiction to route to correct DO
const meta = await env.AUTH_KV.get(`email:${email}`, "json") as { userId: string; jurisdiction: string };
const doNamespace = meta.jurisdiction === "eu" ? env.USER_DO_EU : env.USER_DO;
```

**Wrangler configuration for EU Worker:**

The `USER_DO_EU` binding in `wrangler.toml` points to `script_name = "agentctx-sync-eu"`. This requires a separate deployment of the same Worker code to an EU-restricted environment:

```toml
# wrangler.eu.toml (EU-specific deployment)
name = "agentctx-sync-eu"
main = "src/worker.ts"
compatibility_date = "2026-02-01"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [
  { name = "USER_DO", class_name = "UserDurableObject" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserDurableObject"]

# EU jurisdiction hint is set at the account level in Cloudflare dashboard
# or via the jurisdiction() API on DO namespace
```

**R2 bucket selection in DO handlers:**
```typescript
// In every handler that accesses R2
const bucket = authCtx.jurisdiction === "eu"
  ? this.env.EVENTS_BUCKET_EU
  : this.env.EVENTS_BUCKET;
```

**Acceptance Criteria**

- [ ] EU jurisdiction selectable at registration for Pro/Team users
- [ ] Free tier users requesting EU get `"default"` with explanatory note
- [ ] EU users' DOs are routed to `USER_DO_EU` namespace
- [ ] EU users' R2 operations use `EVENTS_BUCKET_EU`
- [ ] Jurisdiction stored in account table, JWT claims, and AUTH_KV
- [ ] Login correctly routes to EU DO based on KV metadata
- [ ] Jurisdiction cannot be changed after registration (immutable)
- [ ] `wrangler.eu.toml` exists for EU Worker deployment
- [ ] EU R2 bucket has `jurisdiction = "eu"` in wrangler.toml

**Edge Cases**

- E-10 (EU infrastructure unavailable): Registration to EU namespace fails, return 503 with clear message. No partial creation.
- JWT contains `jurisdiction` claim so Worker can route without KV lookup for authenticated requests.
- User upgrades from free to pro but was registered with `"default"`: cannot change to EU. Must re-register (by design -- DO migration between jurisdictions is not supported by Cloudflare).

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 15: Web Portal (Static Account Management UI)

**Description**

Build a minimal static web portal for account management. No JavaScript framework -- vanilla HTML/CSS/JS only. The portal communicates with the same Worker API endpoints. It explicitly cannot display any event data (zero-knowledge).

**Prerequisites/Inputs**

- Tasks 4, 9, 10, 11 (API endpoints the portal consumes)
- Story 17, Section 12 (Web Portal)

**Implementation Details**

**Files under `sync-server/portal/`:**

```
portal/
  index.html          # Login/register page (root route)
  dashboard.html      # Usage overview, machine list, storage meter
  machines.html       # Machine management
  account.html        # Account settings, password change
  delete.html         # Account deletion with confirmation
  styles.css          # Shared styles (responsive, minimal)
  app.js              # Shared JavaScript (auth, API calls, routing)
```

**`portal/app.js` -- core functions:**

```javascript
// Auth state
const API_BASE = "/api";
let accessToken = null;

// API helper
async function apiCall(method, path, body = null) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

// Login
async function login(email, password) { ... }

// Register
async function register(email, password, jurisdiction) { ... }

// Load dashboard data
async function loadDashboard() {
  const [accountRes, usageRes, machinesRes] = await Promise.all([
    apiCall("GET", "/account"),
    apiCall("GET", "/account/usage"),
    apiCall("GET", "/machines"),
  ]);
  // Render usage charts (simple bar chart with CSS)
  // Render machine list
  // Render storage meter
}
```

**Portal serving from Worker:**

The Worker serves static portal files for non-API routes:
```typescript
// In worker.ts
if (!url.pathname.startsWith("/api/")) {
  // Serve static portal files
  // Files are bundled as static assets or served from __STATIC_CONTENT binding
  return servePortalFile(url.pathname, env);
}
```

Portal files can be either:
1. Bundled into the Worker as string constants (simplest, no extra binding)
2. Served via Cloudflare Pages (separate deployment)
3. Served via Workers Sites / static asset binding

For simplicity, option 1 is used initially. The portal HTML/CSS/JS is small enough to embed.

**Zero-knowledge notice** (displayed prominently on dashboard):
```html
<div class="zk-notice">
  <strong>Your data is end-to-end encrypted.</strong>
  The server cannot read your events, sessions, or code.
  Only your devices with the encryption key can decrypt your data.
  To view session history, use the AgentContext desktop or mobile app.
</div>
```

**JWT storage**: stored in `localStorage` (not HttpOnly cookie, since the portal makes API calls from JavaScript). Refresh token stored separately. Auto-refresh on 401 response.

**Note on the Story 17 spec**: The story specifies HttpOnly cookie for JWT storage. However, since the portal makes client-side `fetch()` calls to the API, HttpOnly cookies are actually the correct approach (automatically sent with requests). The portal should use:
- Login response sets `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict; Path=/api`
- API calls use `credentials: "same-origin"` to include cookies
- Refresh is handled server-side via cookie

**Acceptance Criteria**

- [ ] Portal accessible at Worker's base URL (non-`/api/` paths)
- [ ] Login form authenticates via `/api/auth/login`
- [ ] Registration form creates account via `/api/auth/register`
- [ ] Dashboard shows usage charts (token counts, event counts, storage over time)
- [ ] Dashboard shows machine list with sync status
- [ ] Dashboard shows storage meter (used / quota)
- [ ] Machine page allows registering and deactivating machines
- [ ] Account page allows password change
- [ ] Delete page requires confirmation text and password
- [ ] Zero-knowledge notice is prominently displayed
- [ ] Responsive design works on mobile browsers
- [ ] No JavaScript framework used (vanilla HTML/CSS/JS)
- [ ] JWT stored in HttpOnly Secure SameSite=Strict cookie

**Edge Cases**

- JWT expired: auto-refresh via refresh token. If refresh fails, redirect to login.
- API error: display error message inline (no alert dialogs).
- Portal accessed without login: redirect to login page.

**Estimated Effort**: L (Large) -- ~8 hours

---

### Task 16: Testing (Unit, Integration, E2E)

**Description**

Implement the complete test suite specified in Story 17's Testing Plan. Unit tests use Vitest directly. Integration tests use Miniflare to simulate the Workers runtime. E2E tests perform full lifecycle sequences.

**Prerequisites/Inputs**

- All previous tasks (the test suite covers everything)
- Story 17, Testing Plan (T-1 through T-45)
- `vitest` + `miniflare` + `@cloudflare/vitest-pool-workers`

**Implementation Details**

**Vitest configuration (`sync-server/vitest.config.ts`):**
```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["AUTH_KV"],
          r2Buckets: ["EVENTS_BUCKET", "EVENTS_BUCKET_EU"],
          durableObjects: {
            USER_DO: "UserDurableObject",
          },
        },
      },
    },
  },
});
```

**Test file structure:**
```
test/
  unit/
    helpers.test.ts         # T-11 through T-15
    tier-limits.test.ts     # T-7 through T-10
    jwt.test.ts             # T-1 through T-3
    password.test.ts        # T-4
    rate-limit.test.ts      # T-5, T-6
  integration/
    auth.test.ts            # T-16 through T-19, T-39
    machines.test.ts        # T-20, T-21
    push.test.ts            # T-22 through T-24
    pull.test.ts            # T-25 through T-27
    websocket.test.ts       # T-28 through T-31
    deletion.test.ts        # T-32, T-33
    eu-residency.test.ts    # T-34, T-35
    usage.test.ts           # T-36
    retention.test.ts       # T-37, T-38
    health.test.ts          # T-40
  e2e/
    full-sync.test.ts       # T-41
    free-tier.test.ts       # T-42
    pro-tier.test.ts        # T-43
    deletion-e2e.test.ts    # T-44
    upgrade-path.test.ts    # T-45
```

**Unit test examples:**

```typescript
// test/unit/helpers.test.ts
import { describe, it, expect } from "vitest";
import { generateId, formatBytes, base64ToArrayBuffer, hexToArrayBuffer, currentHourKey } from "../../src/helpers";

describe("generateId", () => {
  it("produces 12-char lowercase alphanumeric by default", () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z0-9]{12}$/);
  });
  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => expect(formatBytes(500)).toBe("500 B"));
  it("formats KB", () => expect(formatBytes(2048)).toBe("2.0 KB"));
  it("formats MB", () => expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB"));
  it("formats GB", () => expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB"));
  it("formats 0", () => expect(formatBytes(0)).toBe("0 B"));
});
```

**Integration test example (Miniflare):**

```typescript
// test/integration/push.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

describe("Push endpoint", () => {
  let accessToken: string;
  let machineId: string;

  beforeAll(async () => {
    // Register user, login, register machine
    await SELF.fetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "test@example.com", password: "password123456" }),
    });
    const loginRes = await SELF.fetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "test@example.com", password: "password123456" }),
    });
    const loginData = await loginRes.json();
    accessToken = loginData.access_token;

    const machineRes = await SELF.fetch("/api/machines", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: "Test", os: "linux", arch: "x64", hostname: "test-host" }),
    });
    const machineData = await machineRes.json();
    machineId = machineData.machine_id;
  });

  it("T-22: stores events and returns acceptance count", async () => {
    const blobContent = btoa("encrypted-content");
    const res = await SELF.fetch("/api/sync/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        machine_id: machineId,
        events: [{
          project_id: "proj-abc123",
          session_id: "sess-001",
          sequence: 1,
          timestamp: new Date().toISOString(),
          event_type: "UserPromptReceived",
          encrypted_blob_sha256: "abcdef1234567890",
          encrypted_size_bytes: 100,
          metadata: { token_count_input: 500, model: "claude-opus-4-6" },
        }],
        blobs: { "abcdef1234567890": blobContent },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accepted).toBe(1);
    expect(data.rejected).toBe(0);
  });

  it("T-24: duplicate push is idempotent", async () => {
    // Push same event again (same machine/project/session/sequence)
    // Should return accepted: 0 (INSERT OR IGNORE)
  });
});
```

**Test counts by category:**
- Unit tests: T-1 through T-15 (15 tests)
- Integration tests: T-16 through T-40 (25 tests)
- E2E tests: T-41 through T-45 (5 tests)
- Load tests: T-46 through T-49 (4 tests, separate story)

**Acceptance Criteria**

- [ ] All 15 unit tests pass
- [ ] All 25 integration tests pass via Miniflare
- [ ] All 5 E2E tests pass
- [ ] Test coverage > 80% on src/ files
- [ ] Tests run in CI (see Task 17)
- [ ] Miniflare correctly simulates DO SQLite, KV, and R2
- [ ] No tests depend on external services (all mocked/simulated)

**Edge Cases**

- Miniflare version mismatch: pin exact version in package.json.
- libsodium WASM in test environment: may need special Vitest config for WASM loading.
- Concurrent test isolation: each test creates its own user/DO to avoid state leakage.

**Estimated Effort**: XL (Extra Large) -- ~10 hours

---

### Task 17: Deployment Configuration (Staging, Production, CI)

**Description**

Set up the deployment pipeline for staging and production environments, including CI configuration, secret management, and environment-specific wrangler configuration.

**Prerequisites/Inputs**

- All previous tasks (the full Worker must be deployable)
- Cloudflare account with Workers Paid plan
- DNS configured for `sync.agentctx.dev` and `sync-staging.agentctx.dev`

**Implementation Details**

**Wrangler environment configuration** (already partially in wrangler.toml from Task 1):

```toml
[env.staging]
name = "agentctx-sync-staging"
routes = [
  { pattern = "sync-staging.agentctx.dev/*", zone_name = "agentctx.dev" }
]

[env.staging.vars]
JWT_ISSUER = "agentctx-staging"

[env.production]
name = "agentctx-sync"
routes = [
  { pattern = "sync.agentctx.dev/*", zone_name = "agentctx.dev" }
]
```

**Secrets (set via `wrangler secret put`):**
```bash
# Staging
wrangler secret put JWT_SECRET --env staging
# Enter: <staging-secret>

# Production
wrangler secret put JWT_SECRET --env production
# Enter: <production-secret>
```

**Deployment commands:**
```bash
# Staging
cd /home/meywd/GlobalContext/sync-server
npm run deploy:staging    # wrangler deploy --env staging

# Production
npm run deploy:production # wrangler deploy --env production

# EU Worker (separate deployment)
wrangler deploy --config wrangler.eu.toml --env staging
wrangler deploy --config wrangler.eu.toml --env production
```

**CI configuration (GitHub Actions):**

File: `sync-server/.github/workflows/deploy.yml` (or in repo root `.github/workflows/sync-server.yml`):

```yaml
name: Sync Server CI/CD
on:
  push:
    branches: [main]
    paths: ["sync-server/**"]
  pull_request:
    paths: ["sync-server/**"]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd sync-server && npm ci
      - run: cd sync-server && npm run typecheck
      - run: cd sync-server && npm test

  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd sync-server && npm ci
      - run: cd sync-server && npx wrangler deploy --env staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}

  deploy-production:
    needs: deploy-staging
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production  # Requires manual approval
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd sync-server && npm ci
      - run: cd sync-server && npx wrangler deploy --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

**R2 bucket creation (one-time):**
```bash
wrangler r2 bucket create agentctx-events
wrangler r2 bucket create agentctx-events-eu --jurisdiction eu
```

**KV namespace creation (one-time):**
```bash
wrangler kv:namespace create AUTH_KV
wrangler kv:namespace create AUTH_KV --preview  # for dev
# Update wrangler.toml with returned IDs
```

**Health check verification after deploy:**
```bash
curl https://sync-staging.agentctx.dev/api/health
# Expected: {"status":"ok","timestamp":"2026-02-22T..."}
```

**Acceptance Criteria**

- [ ] `npm run deploy:staging` deploys to staging environment
- [ ] `npm run deploy:production` deploys to production environment
- [ ] EU Worker deploys separately with `wrangler.eu.toml`
- [ ] JWT_SECRET is stored as a Cloudflare secret (not in wrangler.toml)
- [ ] CI runs typecheck and tests on every PR
- [ ] CI deploys to staging on merge to main
- [ ] CI deploys to production after staging (with manual approval)
- [ ] Health endpoint returns 200 on staging after deploy
- [ ] Health endpoint returns 200 on production after deploy
- [ ] R2 buckets exist (default + EU)
- [ ] KV namespace exists with correct ID in wrangler.toml

**Edge Cases**

- Deploy fails: wrangler provides error output. CI step fails, no production impact.
- Secret rotation: `wrangler secret put JWT_SECRET` updates the secret. Existing JWTs signed with old secret will fail verification -- acceptable for security rotation (1-hour token lifetime means all tokens refresh within an hour).
- EU Worker out of sync with main Worker: Both should be deployed from the same commit. CI deploys both in sequence.

**Estimated Effort**: M (Medium) -- ~4 hours

---

## Summary

| Task | Description | Estimated Effort | Dependencies |
|------|-------------|-----------------|--------------|
| 1 | Project Scaffolding | S (2h) | None |
| 2 | Type Definitions & Helpers | S (2h) | 1 |
| 3 | Worker Entry Point & Middleware | L (6h) | 2 |
| 4 | Auth Handlers | XL (8h) | 2, 3 |
| 5 | Durable Object Core | L (6h) | 1, 2, 3 |
| 6 | Push Handler | XL (8h) | 5, 12 |
| 7 | Pull Handler | M (4h) | 5, 6 |
| 8 | WebSocket Notifications | L (5h) | 5, 6 |
| 9 | Machine Registry | M (3h) | 5, 12 |
| 10 | Usage Aggregation | S (2h) | 5, 6 |
| 11 | Account Management | M (4h) | 4, 5 |
| 12 | Tier Enforcement | S (2h) | 2 |
| 13 | Crypto-Shredding | L (5h) | 5, 6, 9 |
| 14 | EU Data Residency | M (3h) | 3, 5 |
| 15 | Web Portal | L (8h) | 4, 9, 10, 11 |
| 16 | Testing | XL (10h) | All |
| 17 | Deployment Configuration | M (4h) | All |
| **Total** | | **~82 hours (~14 days)** | |
