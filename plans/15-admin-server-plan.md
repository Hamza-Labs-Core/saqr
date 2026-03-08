# Implementation Plan: Story 15 -- Admin Server

**Date**: 2026-02-24
**Story**: 15-admin-server
**Status**: Implemented (retroactive plan)
**Estimated Total Effort**: ~5-7 days (40-56 hours)
**Actual Test Count**: 31 tests passing across 4 test suites
**Prerequisites**: Story 11 (Sync Server) must be deployed with AUTH_KV. Story 14 (Codeguard Registry) must define REGISTRY_KV schema and the `codeguard:curated` / `codeguard:popular` KV key formats.

### Relationship to Other Stories

This is a **platform administration story** that provides the internal management API for the Saqr platform. It does not serve public-facing data -- that is sync-server's responsibility (Story 14). Instead, it provides admin-only CRUD endpoints for managing codeguard curated rules, moderating the popular rules list, and managing user roles.

- **Story 11** (Sync Server): Provides the Cloudflare Workers + KV infrastructure, JWT auth, user registration/login. Admin-server shares `AUTH_KV` and `JWT_SECRET` with sync-server. The `KVUserRecord` type was extended with `role?: "user" | "admin"` for this story.
- **Story 12** (Security & Encryption): Provides the HS256 JWT implementation (Web Crypto API). Admin-server copies the `jwt.ts` module from sync-server for independent deployment.
- **Story 14** (Codeguard Registry): Defines the `codeguard:curated` and `codeguard:popular` KV key schemas in `REGISTRY_KV`. Sync-server hosts the public read endpoints; admin-server hosts the write/moderation endpoints.
- **Story 13** (GDPR Compliance): Admin-server follows the same security header and CORS patterns established for sync-server.

### Architecture Decisions

- **Separate Worker deployment**: Admin-server is its own Cloudflare Worker (`saqr-admin`), not a route within sync-server. This provides independent scaling, separate CORS origins (`https://admin.saqr.dev`), and a distinct JWT audience (`saqr-admin`).
- **Shared KV, not shared code**: `AUTH_KV` and `REGISTRY_KV` are the same KV namespaces bound to both workers. Helper code (`helpers.ts`, `auth/jwt.ts`) is copied, not imported, because each Worker is independently bundled.
- **Authoritative role check**: Admin auth does NOT trust the `role` claim in the JWT alone. It always re-reads the `KVUserRecord` from AUTH_KV to get the authoritative role, preventing stale JWT tokens from granting admin access after demotion.
- **Body size limits**: All mutation requests (POST/PUT/PATCH) are capped at 1 MB, enforced via both Content-Length header and streaming body check.

---

## Task Dependency Graph

```
Task 1: Package Scaffolding & Configuration
  |
  +---> Task 2: Type Definitions (AdminEnv, KVUserRecord, CuratedRule, etc.)
  |       |
  |       +---> Task 3: Shared Helpers (responses, CORS, security headers, validation)
  |       |       |
  |       |       +---> Task 4: JWT Module (verify/sign — copied from sync-server)
  |       |       |       |
  |       |       |       +---> Task 5: Admin Authentication Middleware
  |       |       |               |
  |       |       |               +---> Task 6: Worker Entry Point & Router
  |       |       |                       |
  |       |       +---> Task 7: Curated Rules CRUD Handlers
  |       |       |       (needs Task 3 helpers, Task 6 router)
  |       |       |
  |       |       +---> Task 8: Popular Rules Moderation Handlers
  |       |       |       (needs Task 3 helpers, Task 6 router)
  |       |       |
  |       |       +---> Task 9: User Management Handlers
  |       |               (needs Task 3 helpers, Task 6 router)
  |       |
  |       +---> Task 10: Test Infrastructure (MockKV, mock env, token helpers)
  |               |
  |               +---> Task 11: Admin Auth Tests (6 tests)
  |               +---> Task 12: Curated Handlers Tests (12 tests)
  |               +---> Task 13: Popular Handlers Tests (6 tests)
  |               +---> Task 14: User Handlers Tests (7 tests)
  |
  +---> Task 15: Sync-Server Integration (KVUserRecord.role field)
```

---

## Tasks

### Task 1: Package Scaffolding & Configuration

**Description**

Create the `packages/admin-server` package with Cloudflare Worker project structure, including `package.json`, `tsconfig.json`, `vitest.config.ts`, and `wrangler.toml`. This establishes the admin server as a standalone deployable Worker with shared KV bindings.

**Prerequisites/Inputs**

- Monorepo pnpm workspace configuration
- Sync-server `wrangler.toml` as reference for KV binding format

**Implementation Details**

Files created:
- `packages/admin-server/package.json`
- `packages/admin-server/tsconfig.json`
- `packages/admin-server/vitest.config.ts`
- `packages/admin-server/wrangler.toml`
- `packages/admin-server/src/index.ts`

`package.json` configuration:
- Name: `@saqr/admin-server`, version `0.1.0`
- Type: `module`, main: `dist/index.js`
- Dependencies: `@saqr/shared` (workspace)
- DevDependencies: `typescript ^5.7.0`, `vitest ^3.0.0`, `@types/node ^22.0.0`, `@cloudflare/workers-types ^4.0.0`, `wrangler ^4.0.0`
- Scripts: `build`, `test`, `test:unit`, `typecheck`, `clean`, `dev`, `deploy`

`tsconfig.json` configuration:
- Target: ES2022, module: ES2022, moduleResolution: bundler
- Types: `@cloudflare/workers-types`
- Strict mode enabled, composite, declaration, sourceMap
- Excludes test files from compilation

`wrangler.toml` configuration:
- Worker name: `saqr-admin`
- Smart placement enabled
- Two KV namespace bindings: `AUTH_KV`, `REGISTRY_KV` (IDs TBD for deployment)
- Vars: `JWT_ISSUER=saqr`, `JWT_AUDIENCE=saqr-admin`, `ALLOWED_ORIGINS=https://admin.saqr.dev`
- Preview environment: `saqr-admin-preview`

`vitest.config.ts` configuration:
- Globals enabled, node environment
- Path alias: `@saqr/shared` resolves to `../shared/src/index.ts`
- Includes `src/**/*.test.ts` and `src/__tests__/**/*.test.ts`

`src/index.ts` -- re-exports the default Worker from `./worker.js`.

**Acceptance Criteria**

- [x] `packages/admin-server/package.json` exists with correct name, type, scripts, and dependencies
- [x] `packages/admin-server/tsconfig.json` targets ES2022 with Cloudflare Workers types
- [x] `packages/admin-server/vitest.config.ts` configures vitest with shared alias
- [x] `packages/admin-server/wrangler.toml` has AUTH_KV + REGISTRY_KV bindings and admin-specific vars
- [x] `packages/admin-server/src/index.ts` re-exports the Worker default export
- [x] `pnpm install` resolves workspace dependencies

**Estimated Effort**: XS (Extra Small) -- 1-2 hours

---

### Task 2: Type Definitions

**Description**

Define all TypeScript types for the admin server: environment bindings (`AdminEnv`), authentication context (`AdminAuthContext`), KV record types (`KVUserRecord`), JWT payload shape, curated rule types, and popular rule types. These types must match sync-server's KV record schema while extending it with the `role` field.

**Prerequisites/Inputs**

- Sync-server `KVUserRecord` schema (Story 11)
- Story 14 codeguard registry KV schemas (`codeguard:curated`, `codeguard:popular`)

**Implementation Details**

File: `packages/admin-server/src/types.ts`

Types defined:

1. **`AdminEnv`** -- Cloudflare Worker environment bindings:
   - `AUTH_KV: KVNamespace` -- shared with sync-server
   - `REGISTRY_KV: KVNamespace` -- shared with sync-server
   - `JWT_SECRET: string` -- shared secret
   - `JWT_ISSUER: string` -- "saqr"
   - `JWT_AUDIENCE: string` -- "saqr-admin"
   - `ALLOWED_ORIGINS: string` -- admin CORS origins

2. **`UserRole`** -- `'user' | 'admin'` literal union type

3. **`AdminAuthContext`** -- `{ userId, email, role }` returned after successful admin auth

4. **`KVUserRecord`** -- matches sync-server + role extension:
   - `userId, passwordHash, email, tier, createdAt, role?`

5. **`JWTPayload`** -- HS256 JWT claims: `sub, email, tier, role?, iat, exp, nbf?, iss, aud`

6. **`CuratedRule`** -- single curated rule:
   - `id, description, severity, enabled, file_patterns, patterns, exclude_patterns, suggestion, order, added_at, added_by`

7. **`CuratedRulesData`** -- versioned collection: `{ version, updated, updated_by, rules[] }`

8. **`PopularRuleEntry`** -- single popular rule with metadata:
   - `rule: { id, description, severity, enabled, file_patterns, patterns, exclude_patterns, suggestion }`
   - `total_installs, total_blocks, hidden, first_seen, last_updated`

9. **`PopularRulesData`** -- collection: `{ updated, rules[] }`

**Acceptance Criteria**

- [x] `AdminEnv` interface matches Cloudflare KV binding types
- [x] `KVUserRecord` includes optional `role?: UserRole` matching sync-server's extended schema
- [x] `CuratedRule` type covers all fields from the Story 15 spec (id, patterns, severity, order, etc.)
- [x] `PopularRuleEntry` nests the rule object and includes moderation fields (hidden, total_installs)
- [x] All interfaces are exported for use by handlers and tests
- [x] `JWTPayload` includes `nbf?` for not-before validation

**Estimated Effort**: XS (Extra Small) -- 1 hour

---

### Task 3: Shared Helpers (Responses, CORS, Security Headers, Validation)

**Description**

Implement utility functions copied from sync-server with admin-specific adjustments. These provide JSON/error response builders, CORS header management with per-origin allowlisting, security headers (HSTS, nosniff, frame deny, no-store), body size checking, and input validation helpers for rule IDs and regex patterns.

**Prerequisites/Inputs**

- Sync-server `helpers.ts` (pattern reference)
- Task 2 types (`AdminEnv`)

**Implementation Details**

File: `packages/admin-server/src/helpers.ts`

Functions implemented:

1. **`jsonResponse(status, body, extraHeaders?)`** -- Creates a JSON Response with Content-Type header
2. **`errorResponse(status, error, message, extra?)`** -- Creates a structured error response `{ error, message }`
3. **`checkBodySize(request, maxBytes)`** -- Two-phase body size check:
   - Phase 1: Check `Content-Length` header if present
   - Phase 2: If no Content-Length, clone request and stream-read the body counting bytes
   - Returns error Response (413) if over limit, or `null` if OK
4. **`parseAllowedOrigins(env)`** -- Parses comma-separated `ALLOWED_ORIGINS` env var into a `Set<string>`
5. **`isOriginAllowed(origin, allowedOrigins)`** -- Checks if request origin is in the allowed set
6. **`withCorsHeaders(response, origin, env)`** -- Attaches CORS headers:
   - `Access-Control-Allow-Origin` (only if origin is allowed)
   - `Access-Control-Allow-Credentials: true`
   - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
   - `Access-Control-Allow-Headers: Content-Type, Authorization`
   - `Access-Control-Max-Age: 86400`
7. **`handleCorsPreFlight(request, env)`** -- Returns 204 with CORS headers for OPTIONS requests
8. **`withSecurityHeaders(response)`** -- Attaches security headers:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
   - `Cache-Control: no-store`
9. **`isValidRuleId(id)`** -- Validates kebab-case rule IDs: `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`, length 1-64
10. **`isValidRegex(pattern)`** -- Validates regex by attempting `new RegExp(pattern)`, catching errors

**Acceptance Criteria**

- [x] `jsonResponse` returns proper Content-Type and JSON-serialized body
- [x] `errorResponse` returns structured `{ error, message }` format
- [x] `checkBodySize` handles both Content-Length and chunked/streaming bodies
- [x] CORS only reflects origins in the `ALLOWED_ORIGINS` allowlist
- [x] Security headers include HSTS, nosniff, DENY frame, no-store cache
- [x] `isValidRuleId` rejects non-kebab-case, empty, and oversized IDs
- [x] `isValidRegex` catches `SyntaxError` for invalid regex patterns

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 4: JWT Module (Verify & Sign)

**Description**

Implement HS256 JWT verification and signing using the Web Crypto API with no external dependencies. This module is copied from sync-server to maintain deployment independence. It supports signing (primarily for tests) and verification with issuer, audience, expiry, and not-before validation.

**Prerequisites/Inputs**

- Sync-server `auth/jwt.ts` (source to copy)
- Task 2 types (`JWTPayload`)

**Implementation Details**

File: `packages/admin-server/src/auth/jwt.ts`

Components:

1. **Encoding helpers**: `base64UrlEncode` and `base64UrlDecode` for URL-safe Base64 encoding/decoding
2. **Key import**: `importKey(secret)` -- imports HMAC-SHA256 key via `crypto.subtle.importKey`
3. **`signToken(payload, secret, expiresInSeconds?)`** -- Creates HS256 JWT:
   - Sets `iat` and `exp` if not provided (default 3600s)
   - Constructs `header.payload.signature` format
   - Used primarily in tests
4. **`JWTError`** class -- Custom error with `code` property for categorization:
   - Codes: `malformed`, `unsupported_alg`, `invalid_signature`, `expired`, `not_yet_valid`, `invalid_issuer`, `invalid_audience`
5. **`verifyToken(token, secret, options?)`** -- Full JWT verification:
   - Validates 3-part structure
   - Validates `alg: HS256` header
   - Verifies HMAC signature via `crypto.subtle.verify`
   - Checks `exp` (expiry)
   - Checks `nbf` (not-before)
   - Checks `iss` (issuer) if provided
   - Checks `aud` (audience) if provided

**Acceptance Criteria**

- [x] Uses Web Crypto API only -- no `jose`, `jsonwebtoken`, or other external dependencies
- [x] `verifyToken` validates signature, expiry, nbf, issuer, and audience
- [x] `JWTError` provides structured error codes for each failure mode
- [x] `signToken` produces valid JWTs for test helpers
- [x] Base64URL encoding/decoding handles padding correctly

**Estimated Effort**: S (Small) -- 2 hours (mostly copy + adapt from sync-server)

---

### Task 5: Admin Authentication Middleware

**Description**

Implement the `authenticateAdmin` function that serves as the authentication and authorization gate for all admin endpoints. It performs a three-step verification: (1) extract and verify the JWT, (2) look up the user record in AUTH_KV, (3) check that the user has `role: "admin"`. This is the critical security boundary -- it always checks KV for the authoritative role, not the JWT claim.

**Prerequisites/Inputs**

- Task 4 JWT module (`verifyToken`, `JWTError`)
- Task 3 helpers (`errorResponse`)
- Task 2 types (`AdminEnv`, `AdminAuthContext`, `KVUserRecord`)

**Implementation Details**

File: `packages/admin-server/src/auth/admin-auth.ts`

Function: `authenticateAdmin(request, env) -> Promise<{ authCtx } | { error }>`

Flow:
1. Extract `Authorization: Bearer <token>` header
   - Missing header -> 401 `missing_token`
   - Empty token -> 401 `missing_token`
2. Verify JWT via `verifyToken(token, env.JWT_SECRET, { issuer, audience })`
   - `JWTError` -> 401 `invalid_token` with error message
   - Other errors -> 401 `invalid_token` with generic message
3. Look up user email via `AUTH_KV.get('userid:{sub}')`
   - Not found -> 401 `user_not_found`
4. Look up user record via `AUTH_KV.get('user:{email}')`
   - Not found -> 401 `user_not_found`
   - JSON parse failure -> 500 `internal_error`
5. Check `userRecord.role === 'admin'`
   - Not admin -> 403 `forbidden` ("Admin role required")
6. Return `{ authCtx: { userId, email, role: 'admin' } }`

Key security property: The role is checked against the **live KV record**, not the JWT payload. If an admin's role is revoked in KV, their existing JWT tokens are immediately ineffective.

**Acceptance Criteria**

- [x] Returns 401 for missing Authorization header
- [x] Returns 401 for empty Bearer token
- [x] Returns 401 for expired JWT
- [x] Returns 401 for invalid/malformed JWT
- [x] Returns 401 for user not found in KV
- [x] Returns 403 for non-admin users (role check against KV, not JWT)
- [x] Returns 403 when admin role is revoked in KV after token was issued
- [x] Returns `AdminAuthContext` with userId, email, and role for valid admin JWT

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 6: Worker Entry Point & Router

**Description**

Implement the main Cloudflare Worker `fetch` handler that routes requests to the appropriate handler functions. The router handles CORS preflight, health checks (unauthenticated), body size enforcement for mutations, admin authentication, and URL-pattern-based routing to all 12 API endpoints.

**Prerequisites/Inputs**

- Task 5 admin auth (`authenticateAdmin`)
- Task 3 helpers (all response/CORS/security functions)
- Tasks 7-9 handler functions (curated, popular, user)

**Implementation Details**

File: `packages/admin-server/src/worker.ts`

The Worker default export implements `fetch(request, env, ctx)`:

1. **CORS Preflight**: `OPTIONS` -> `handleCorsPreFlight`
2. **Response wrapper**: `respond(response)` applies `withSecurityHeaders(withCorsHeaders(response))`
3. **Health check**: `GET /api/health` -> 200 `{ status, service, timestamp }` (no auth)
4. **404 guard**: Non `/api/admin/*` paths -> 404
5. **Body size check**: POST/PUT/PATCH methods -> `checkBodySize(request, 1MB)`
6. **Admin auth**: `authenticateAdmin(request, env)` -> 401/403 or `authCtx`
7. **Route dispatch**:

| Method | Path Pattern | Handler | Regex |
|--------|-------------|---------|-------|
| GET | `/api/admin/codeguard/curated` | `handleListCurated` | exact |
| POST | `/api/admin/codeguard/curated` | `handleAddCurated` | exact |
| PUT | `/api/admin/codeguard/curated/:id` | `handleUpdateCurated` | `/^\/api\/admin\/codeguard\/curated\/([a-z0-9-]+)$/` |
| DELETE | `/api/admin/codeguard/curated/:id` | `handleDeleteCurated` | same regex |
| GET | `/api/admin/codeguard/popular` | `handleListPopular` | exact |
| POST | `/api/admin/codeguard/popular/:id/hide` | `handleHidePopular` | `/^\/api\/admin\/codeguard\/popular\/([a-z0-9-]+)\/(hide\|unhide)$/` |
| POST | `/api/admin/codeguard/popular/:id/unhide` | `handleUnhidePopular` | same regex |
| GET | `/api/admin/users` | `handleListUsers` | exact |
| POST | `/api/admin/users/:id/promote` | `handlePromoteUser` | `/^\/api\/admin\/users\/([a-z0-9_]+)\/(promote\|demote)$/` |
| POST | `/api/admin/users/:id/demote` | `handleDemoteUser` | same regex |
| GET | `/api/admin/users/:id` | `handleGetUser` | `/^\/api\/admin\/users\/([a-z0-9_]+)$/` |

8. **Method not allowed**: Valid path but wrong method -> 405
9. **Fallthrough**: Unmatched paths -> 404

Route matching order: Action routes (`promote/demote`, `hide/unhide`) are matched before detail routes (`/users/:id`) to avoid conflicts.

**Acceptance Criteria**

- [x] Health check returns 200 without authentication
- [x] All `/api/admin/*` routes require admin auth
- [x] Body size is enforced for POST/PUT/PATCH at 1 MB
- [x] CORS headers and security headers applied to all responses
- [x] All 12 documented API endpoints are routed correctly
- [x] Unmatched paths return 404, wrong methods return 405
- [x] Route regex patterns correctly extract `:id` parameter
- [x] Action routes matched before detail routes to prevent ambiguity

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 7: Curated Rules CRUD Handlers

**Description**

Implement full CRUD operations for codeguard curated rules stored in `REGISTRY_KV` under the `codeguard:curated` key. The curated list is a versioned, ordered collection of security rules that Saqr recommends to all users. Each mutation increments the version number and records the admin who made the change.

**Prerequisites/Inputs**

- Task 2 types (`CuratedRule`, `CuratedRulesData`, `AdminAuthContext`)
- Task 3 helpers (`jsonResponse`, `errorResponse`, `isValidRuleId`, `isValidRegex`)

**Implementation Details**

File: `packages/admin-server/src/codeguard/curated-handlers.ts`

KV key: `codeguard:curated`

Internal helpers:
- `loadCurated(env)` -- Reads and parses from REGISTRY_KV, returns default `{ version: 1, rules: [] }` if empty
- `saveCurated(env, data)` -- JSON-serializes and writes to REGISTRY_KV

Validation function `validateRule(body)`:
- `id` -- required, string, kebab-case (1-64 chars)
- `description` -- required, non-empty string
- `severity` -- required, must be `"block"` or `"warn"`
- `file_patterns` -- required, non-empty array
- `patterns` -- required, non-empty array, each must be valid regex
- `exclude_patterns` -- optional, must be array of strings if provided
- `suggestion` -- required, non-empty string

Handlers:

1. **`handleListCurated(env)`** -- GET
   - Returns `{ version, updated, rules }` from KV

2. **`handleAddCurated(request, env, authCtx)`** -- POST
   - Parses JSON body, validates all fields
   - Checks for duplicate `id` -> 409 `duplicate_id`
   - Auto-assigns `order` (max existing order + 1) if not provided
   - Sets `enabled: true` by default if not specified
   - Records `added_at` timestamp and `added_by` userId
   - Increments version, updates timestamp and `updated_by`
   - Returns 201 with the new rule

3. **`handleUpdateCurated(request, env, authCtx, ruleId)`** -- PUT
   - Finds rule by id -> 404 if not found
   - Validates `patterns` array (if provided) for regex validity
   - Validates `severity` (if provided) for allowed values
   - Merges provided fields with existing rule (partial update)
   - Increments version, updates timestamp and `updated_by`
   - Returns 200 with the updated rule

4. **`handleDeleteCurated(env, authCtx, ruleId)`** -- DELETE
   - Finds rule by id -> 404 if not found
   - Splices rule from array
   - Increments version, updates timestamp and `updated_by`
   - Returns 200 with `{ deleted: ruleId }`

**Acceptance Criteria**

- [x] List returns empty array when no curated rules exist
- [x] Add creates a new rule with auto-assigned order, timestamps, and admin attribution
- [x] Add returns 409 for duplicate rule ID
- [x] Add returns 400 for invalid regex patterns
- [x] Add returns 400 for missing required fields (description, severity, patterns, etc.)
- [x] Add returns 400 for non-kebab-case rule ID
- [x] Update merges partial fields with existing rule, preserving unchanged fields
- [x] Update returns 404 for nonexistent rule
- [x] Delete removes rule from the list
- [x] Delete returns 404 for nonexistent rule
- [x] Every mutation increments the version number
- [x] Every mutation records `updated_by` admin userId

**Edge Cases**

- Adding a rule with `enabled: false` explicitly should persist that value, not default to `true`
- Updating with an empty `patterns` array returns 400 (non-empty required)
- Updating `severity` to an invalid value returns 400

**Estimated Effort**: M (Medium) -- 4-5 hours

---

### Task 8: Popular Rules Moderation Handlers

**Description**

Implement admin moderation endpoints for the popular rules list. Admins can list all popular rules (including hidden ones), hide problematic rules from the public list, and unhide them. The actual popular rules data is aggregated by sync-server; admin-server only manages the `hidden` flag.

**Prerequisites/Inputs**

- Task 2 types (`PopularRuleEntry`, `PopularRulesData`)
- Task 3 helpers (`jsonResponse`, `errorResponse`)

**Implementation Details**

File: `packages/admin-server/src/codeguard/popular-handlers.ts`

KV key: `codeguard:popular`

Internal helpers:
- `loadPopular(env)` -- Reads and parses from REGISTRY_KV, returns default `{ updated, rules: [] }` if empty
- `savePopular(env, data)` -- JSON-serializes and writes to REGISTRY_KV

Handlers:

1. **`handleListPopular(env)`** -- GET
   - Returns `{ updated, rules, total, hidden_count }`
   - `hidden_count` is computed by filtering `rules.filter(r => r.hidden).length`
   - Admin sees ALL rules, including hidden ones (unlike the public endpoint in sync-server)

2. **`handleHidePopular(env, ruleId)`** -- POST
   - Finds rule entry by `rule.id` -> 404 if not found
   - Sets `entry.hidden = true`
   - Updates `data.updated` timestamp
   - Returns `{ rule_id, hidden: true }`

3. **`handleUnhidePopular(env, ruleId)`** -- POST
   - Finds rule entry by `rule.id` -> 404 if not found
   - Sets `entry.hidden = false`
   - Updates `data.updated` timestamp
   - Returns `{ rule_id, hidden: false }`

Note: Popular rule entries nest the rule object inside `{ rule: { id, ... }, hidden, total_installs, ... }`, so lookup is `rules.find(r => r.rule.id === ruleId)`.

**Acceptance Criteria**

- [x] List returns empty results when no popular rules exist
- [x] List returns all rules including hidden ones with total and hidden_count
- [x] Hide sets the hidden flag on an existing rule
- [x] Hide returns 404 for nonexistent rule
- [x] Unhide clears the hidden flag on a hidden rule
- [x] Unhide returns 404 for nonexistent rule
- [x] Changes persist to REGISTRY_KV (verified by subsequent list)

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 9: User Management Handlers

**Description**

Implement admin user management endpoints: list users (paginated), get user details, promote a user to admin, and demote an admin to regular user. User records are stored in AUTH_KV with a dual-key scheme: `user:{email}` holds the full record, and `userid:{userId}` maps to the email for userId-based lookups.

**Prerequisites/Inputs**

- Task 2 types (`KVUserRecord`, `AdminEnv`)
- Task 3 helpers (`jsonResponse`, `errorResponse`)

**Implementation Details**

File: `packages/admin-server/src/users/user-handlers.ts`

KV key scheme:
- `user:{email}` -> JSON `KVUserRecord`
- `userid:{userId}` -> email string (reverse index)

Handlers:

1. **`handleListUsers(env, url)`** -- GET
   - Reads `limit` from query params (default 50, max 100)
   - Reads `cursor` from query params for pagination
   - Calls `AUTH_KV.list({ prefix: 'user:', limit, cursor })`
   - For each key, reads and parses the `KVUserRecord`
   - Returns `{ users: [{ userId, email, tier, role, createdAt }], total, has_more, cursor }`
   - Skips malformed records (try/catch around JSON.parse)
   - `role` defaults to `'user'` if not set on record

2. **`handleGetUser(env, userId)`** -- GET
   - Looks up email via `AUTH_KV.get('userid:{userId}')` -> 404
   - Reads full record via `AUTH_KV.get('user:{email}')` -> 404
   - Returns `{ userId, email, tier, role, createdAt }` (excludes passwordHash)
   - JSON parse failure -> 500

3. **`handlePromoteUser(env, userId)`** -- POST
   - Looks up email via `AUTH_KV.get('userid:{userId}')` -> 404
   - Reads full record -> 404 or 500
   - Sets `record.role = 'admin'`
   - Writes back to `AUTH_KV.put('user:{email}', ...)`
   - Returns `{ userId, email, role: 'admin' }`

4. **`handleDemoteUser(env, userId)`** -- POST
   - Same flow as promote, but sets `record.role = 'user'`
   - Returns `{ userId, email, role: 'user' }`

**Acceptance Criteria**

- [x] List returns paginated user list with role, tier, and email
- [x] List defaults to 50 users, max 100
- [x] List handles pagination with cursor from KV list API
- [x] List skips malformed user records without crashing
- [x] Get user returns details by userId, excluding passwordHash
- [x] Get user returns 404 for nonexistent userId
- [x] Promote sets role to admin and persists to KV
- [x] Promote returns 404 for nonexistent user
- [x] Demote sets role to user and persists to KV
- [x] Demote returns 404 for nonexistent user

**Edge Cases**

- User records without `role` field should default to `'user'` in list and get responses
- passwordHash is never exposed in any response

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 10: Test Infrastructure

**Description**

Create mock Cloudflare Workers testing infrastructure including a `MockKVNamespace` class, mock environment factory, request builders, JWT token generators, and user seeding helpers. This infrastructure is used by all four test suites.

**Prerequisites/Inputs**

- Task 2 types (all interfaces)
- Task 4 JWT module (`signToken`)

**Implementation Details**

File: `packages/admin-server/src/__tests__/helpers/mock-env.ts`

Components:

1. **`MockKVNamespace`** class -- In-memory KV store:
   - Backed by `Map<string, { value, expiration? }>`
   - `get(key)` -- Returns value or null, respects TTL expiration
   - `put(key, value, options?)` -- Stores with optional `expirationTtl` or `expiration`
   - `delete(key)` -- Removes entry
   - `list(options?)` -- Lists keys by prefix with limit (always returns `list_complete: true` for simplicity)
   - `clear()` -- Test helper to reset store
   - `size` -- Test helper getter

2. **Constants**: `TEST_JWT_SECRET`, `TEST_JWT_ISSUER`, `TEST_JWT_AUDIENCE`

3. **`createMockAdminEnv(overrides?)`** -- Creates `AdminEnv` with fresh `MockKVNamespace` instances

4. **`createRequest(method, path, body?, headers?)`** -- Builds `Request` objects with JSON Content-Type

5. **`createAuthRequest(method, path, token, body?, headers?)`** -- Adds `Authorization: Bearer` header

6. **`createAdminToken(overrides?)`** -- Generates valid admin JWT with defaults:
   - `sub: 'usr_admin123'`, `email: 'admin@saqr.dev'`, `role: 'admin'`

7. **`createUserToken(overrides?)`** -- Generates valid non-admin JWT with defaults:
   - `sub: 'usr_user456'`, `email: 'user@saqr.dev'`, `role: 'user'`

8. **`seedAdminUser(env, userId?, email?)`** -- Creates admin KVUserRecord in AUTH_KV:
   - Sets both `user:{email}` and `userid:{userId}` keys
   - Uses Argon2id-format placeholder password hash

9. **`seedRegularUser(env, userId?, email?)`** -- Creates regular KVUserRecord in AUTH_KV

**Acceptance Criteria**

- [x] `MockKVNamespace` correctly simulates KV `get`, `put`, `delete`, `list` operations
- [x] `MockKVNamespace` respects TTL expiration
- [x] `createMockAdminEnv` returns fresh isolated KV instances per call
- [x] Token generators produce valid HS256 JWTs verifiable by the JWT module
- [x] User seeding helpers create both forward (`user:`) and reverse (`userid:`) KV entries
- [x] All helpers are exported for use across test suites

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 11: Admin Auth Tests

**Description**

Test the `authenticateAdmin` function across all authentication and authorization scenarios: valid admin, non-admin, missing token, expired token, malformed token, and revoked role.

**Prerequisites/Inputs**

- Task 5 (`authenticateAdmin`)
- Task 10 (test infrastructure)

**Implementation Details**

File: `packages/admin-server/src/__tests__/admin-auth.test.ts`

Tests (6 total):

| # | Test | Expected |
|---|------|----------|
| 1 | Valid admin JWT with matching KV record | 200, returns `authCtx` with userId, email, role |
| 2 | Valid JWT but user role is `"user"` in KV | 403 `forbidden` |
| 3 | Missing Authorization header | 401 `missing_token` |
| 4 | Expired JWT (exp in the past) | 401 `invalid_token` with "expired" message |
| 5 | Malformed/invalid JWT string | 401 `invalid_token` |
| 6 | Admin role revoked in KV after token issued | 403 `forbidden` (KV overrides JWT claim) |

Test 6 is the critical security test: it creates an admin token, then modifies the KV record to `role: 'user'`, and verifies the auth check still fails. This validates the authoritative KV role check.

**Acceptance Criteria**

- [x] All 6 auth scenarios covered
- [x] Security-critical test: revoked role in KV detected even with valid JWT
- [x] Error responses contain correct status codes and error codes
- [x] All tests pass

**Estimated Effort**: S (Small) -- 1-2 hours

---

### Task 12: Curated Handlers Tests

**Description**

Test all CRUD operations for curated rules including happy paths, validation errors, conflict detection, and version tracking.

**Prerequisites/Inputs**

- Task 7 (curated handlers)
- Task 10 (test infrastructure)

**Implementation Details**

File: `packages/admin-server/src/__tests__/curated-handlers.test.ts`

Tests (12 total):

| # | Describe | Test | Expected |
|---|----------|------|----------|
| 1 | handleListCurated | Empty list returns empty array | 200, version 1, rules [] |
| 2 | handleListCurated | Returns rules after adding | 200, rules with correct data |
| 3 | handleAddCurated | Add valid rule | 201, rule with all fields, added_by set |
| 4 | handleAddCurated | Duplicate id | 409 `duplicate_id` |
| 5 | handleAddCurated | Invalid regex pattern | 400 `validation_error` |
| 6 | handleAddCurated | Missing required fields | 400 `validation_error` |
| 7 | handleAddCurated | Invalid rule id (non-kebab-case) | 400 `validation_error` |
| 8 | handleUpdateCurated | Update existing rule (partial) | 200, changed fields updated, unchanged preserved |
| 9 | handleUpdateCurated | Update nonexistent rule | 404 `not_found` |
| 10 | handleDeleteCurated | Delete existing rule | 200, `{ deleted: id }`, removed from list |
| 11 | handleDeleteCurated | Delete nonexistent rule | 404 `not_found` |
| 12 | version tracking | Version increments on add, update, delete | Versions 1 -> 2 -> 3 -> 4 -> 5 |

Test 12 exercises the complete mutation lifecycle: list (v1) -> add (v2) -> add (v3) -> update (v4) -> delete (v5).

**Acceptance Criteria**

- [x] All 12 curated handler tests pass
- [x] Validation covers id format, regex validity, required fields, severity values
- [x] Persistence verified by listing after mutations
- [x] Version tracking verified across multiple mutations

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 13: Popular Handlers Tests

**Description**

Test popular rules moderation: listing (including hidden), hiding, unhiding, and 404 handling.

**Prerequisites/Inputs**

- Task 8 (popular handlers)
- Task 10 (test infrastructure)

**Implementation Details**

File: `packages/admin-server/src/__tests__/popular-handlers.test.ts`

Seed data: 3 popular rules pre-loaded into REGISTRY_KV:
- `no-eval` (visible, 1500 installs)
- `no-any-type` (visible, 980 installs)
- `no-todo-comments` (hidden, 50 installs)

Tests (6 total):

| # | Describe | Test | Expected |
|---|----------|------|----------|
| 1 | handleListPopular | Empty KV returns empty list | 200, total 0, hidden_count 0 |
| 2 | handleListPopular | Returns all rules including hidden | 200, total 3, hidden_count 1 |
| 3 | handleHidePopular | Hide a visible rule | 200, hidden true; persisted |
| 4 | handleHidePopular | Hide nonexistent rule | 404 `not_found` |
| 5 | handleUnhidePopular | Unhide a hidden rule | 200, hidden false; persisted |
| 6 | handleUnhidePopular | Unhide nonexistent rule | 404 `not_found` |

Tests 3 and 5 verify persistence by calling list after the mutation and checking the updated counts.

**Acceptance Criteria**

- [x] All 6 popular handler tests pass
- [x] Admin list includes hidden rules (unlike public endpoint)
- [x] Hide/unhide changes persist to KV
- [x] hidden_count accurately reflects the number of hidden entries

**Estimated Effort**: S (Small) -- 1-2 hours

---

### Task 14: User Handlers Tests

**Description**

Test user management: listing with multiple users, getting user details, promoting, demoting, and 404 handling.

**Prerequisites/Inputs**

- Task 9 (user handlers)
- Task 10 (test infrastructure)

**Implementation Details**

File: `packages/admin-server/src/__tests__/user-handlers.test.ts`

Tests (7 total):

| # | Describe | Test | Expected |
|---|----------|------|----------|
| 1 | handleListUsers | List 3 seeded users | 200, total 3, correct emails and roles |
| 2 | handleGetUser | Get user by userId | 200, user details without passwordHash |
| 3 | handleGetUser | Get nonexistent user | 404 `not_found` |
| 4 | handlePromoteUser | Promote regular user to admin | 200, role admin; KV persisted |
| 5 | handlePromoteUser | Promote nonexistent user | 404 `not_found` |
| 6 | handleDemoteUser | Demote admin to regular user | 200, role user; KV persisted |
| 7 | handleDemoteUser | Demote nonexistent user | 404 `not_found` |

Tests 4 and 6 verify KV persistence by reading the raw record back from AUTH_KV.

**Acceptance Criteria**

- [x] All 7 user handler tests pass
- [x] List returns correct roles for admin and regular users
- [x] Get user excludes passwordHash from response
- [x] Promote/demote persist role change to KV
- [x] 404 returned for nonexistent users

**Estimated Effort**: S (Small) -- 1-2 hours

---

### Task 15: Sync-Server Integration (KVUserRecord.role Field)

**Description**

Ensure sync-server's `KVUserRecord` type includes the optional `role` field and that registration sets `role: "user"` by default. The login handler should include `role` in the JWT claims so admin-server receives it (though admin-server still verifies against KV).

**Prerequisites/Inputs**

- Sync-server codebase (Story 11)
- KVUserRecord type definition

**Implementation Details**

Changes to sync-server (already completed alongside this story):

1. **`KVUserRecord` type**: Added `role?: 'user' | 'admin'` field
2. **`handleRegister`**: Sets `role: 'user'` on new account creation
3. **`handleLogin`**: Includes `role` in JWT payload claims
4. **`wrangler.toml`**: `REGISTRY_KV` binding added (if not already present from Story 14)

**Acceptance Criteria**

- [x] `KVUserRecord` in sync-server includes `role?` field
- [x] New user registration defaults to `role: 'user'`
- [x] JWT issued at login includes `role` claim
- [x] Admin-server `KVUserRecord` type matches sync-server's schema

**Estimated Effort**: XS (Extra Small) -- 1 hour

---

## File Inventory

### Source Files (8 files)

| File | Purpose | Lines |
|------|---------|-------|
| `packages/admin-server/src/index.ts` | Worker re-export entry point | 8 |
| `packages/admin-server/src/worker.ts` | Fetch handler, routing, middleware | 175 |
| `packages/admin-server/src/types.ts` | All TypeScript type definitions | 120 |
| `packages/admin-server/src/helpers.ts` | Response builders, CORS, security, validation | 155 |
| `packages/admin-server/src/auth/jwt.ts` | HS256 JWT sign/verify (Web Crypto API) | 168 |
| `packages/admin-server/src/auth/admin-auth.ts` | Admin authentication + role authorization | 93 |
| `packages/admin-server/src/codeguard/curated-handlers.ts` | Curated rules CRUD (list, add, update, delete) | 221 |
| `packages/admin-server/src/codeguard/popular-handlers.ts` | Popular rules moderation (list, hide, unhide) | 86 |
| `packages/admin-server/src/users/user-handlers.ts` | User management (list, get, promote, demote) | 166 |

### Test Files (5 files, 31 tests)

| File | Tests | Coverage Area |
|------|-------|---------------|
| `packages/admin-server/src/__tests__/helpers/mock-env.ts` | -- | Test infrastructure (MockKV, factories, seeders) |
| `packages/admin-server/src/__tests__/admin-auth.test.ts` | 6 | JWT verification + admin role check |
| `packages/admin-server/src/__tests__/curated-handlers.test.ts` | 12 | Curated rules CRUD + validation + versioning |
| `packages/admin-server/src/__tests__/popular-handlers.test.ts` | 6 | Popular rules hide/unhide moderation |
| `packages/admin-server/src/__tests__/user-handlers.test.ts` | 7 | User list, details, promote, demote |

### Configuration Files (4 files)

| File | Purpose |
|------|---------|
| `packages/admin-server/package.json` | Package manifest, scripts, dependencies |
| `packages/admin-server/tsconfig.json` | TypeScript configuration (ES2022, Cloudflare types) |
| `packages/admin-server/vitest.config.ts` | Test runner configuration with shared alias |
| `packages/admin-server/wrangler.toml` | Cloudflare Worker deployment config, KV bindings |

---

## API Reference

### Unauthenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check: `{ status, service, timestamp }` |

### Codeguard Curated (Admin Only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/codeguard/curated` | List all curated rules |
| POST | `/api/admin/codeguard/curated` | Add a new curated rule |
| PUT | `/api/admin/codeguard/curated/:id` | Update an existing curated rule |
| DELETE | `/api/admin/codeguard/curated/:id` | Delete a curated rule |

### Codeguard Popular (Admin Only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/codeguard/popular` | List all popular rules (including hidden) |
| POST | `/api/admin/codeguard/popular/:id/hide` | Hide a problematic rule from public list |
| POST | `/api/admin/codeguard/popular/:id/unhide` | Restore a hidden rule to public list |

### User Management (Admin Only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List users (paginated, ?limit=50&cursor=...) |
| GET | `/api/admin/users/:id` | Get user details by userId |
| POST | `/api/admin/users/:id/promote` | Promote user to admin |
| POST | `/api/admin/users/:id/demote` | Demote admin to regular user |

---

## Security Properties

1. **All admin endpoints require JWT + admin role** -- enforced in the router before any handler is called
2. **Authoritative role check from KV** -- JWT `role` claim is not trusted; live KV record is always read
3. **CORS restricted** -- only `ALLOWED_ORIGINS` (admin.saqr.dev) can make cross-origin requests
4. **Security headers on all responses** -- HSTS, nosniff, DENY framing, no-store caching
5. **Body size limits** -- 1 MB cap on POST/PUT/PATCH, checked via Content-Length and streaming
6. **Input validation** -- regex patterns validated, rule IDs must be kebab-case, required fields enforced
7. **No PII in responses** -- passwordHash is never included in user management responses

---

## Test Results Summary

```
31 tests passing across 4 test suites:
  - admin-auth.test.ts:        6 tests
  - curated-handlers.test.ts: 12 tests
  - popular-handlers.test.ts:  6 tests
  - user-handlers.test.ts:     7 tests
```
