# Story 15: Admin Server — Saqr Platform Administration

## Overview

The Admin Server is a separate Cloudflare Worker that provides Saqr's internal administration interface. It manages users, accounts, codeguard curated rules, and popular list moderation. It shares the `AUTH_KV` namespace with sync-server for user verification and `REGISTRY_KV` for codeguard data.

Admin users are regular Saqr users with `role: "admin"` set in their `KVUserRecord`. There is no separate admin registration — Saqr team members are promoted to admin by updating their KV record directly (or via another admin).

The admin server is a separate deployment from sync-server. It has its own domain (e.g., `admin.saqr.dev`), its own CORS allowlist, and its own JWT audience (`saqr-admin`). It shares the same `JWT_SECRET` so it can verify tokens issued by sync-server's login, but admin endpoints additionally check the `role` field.

---

## Scope

### In Scope

- Admin server Cloudflare Worker package (`packages/admin-server`)
- Admin authentication middleware (JWT verify + role check)
- Codeguard curated rules CRUD (add, update, delete, reorder)
- Codeguard popular list moderation (hide/unhide problematic rules)
- User listing and role management (promote/demote admin)
- Health check endpoint
- CORS, security headers, rate limiting (reuse sync-server patterns)
- Comprehensive tests with mock KV
- Wrangler configuration with shared KV bindings

### Out of Scope

- Admin UI/dashboard (API only — future story)
- Payment/billing management
- Telemetry ingestion (that's sync-server, Story 14)
- Public read endpoints for curated/popular (that's sync-server, Story 14)
- Audit logging (future enhancement)

---

## Requirements

### 1. Package Structure

```
packages/admin-server/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.toml
└── src/
    ├── index.ts              (exports)
    ├── worker.ts             (entry point, routing)
    ├── types.ts              (AdminEnv, AdminAuthContext)
    ├── helpers.ts            (response/CORS/security — from sync-server)
    ├── auth/
    │   ├── jwt.ts            (verify — from sync-server)
    │   └── admin-auth.ts     (authenticate + role check)
    ├── codeguard/
    │   ├── curated-handlers.ts
    │   └── popular-handlers.ts
    ├── users/
    │   └── user-handlers.ts  (list users, promote/demote)
    └── __tests__/
        ├── helpers/
        │   └── mock-env.ts
        ├── admin-auth.test.ts
        ├── curated-handlers.test.ts
        ├── popular-handlers.test.ts
        └── user-handlers.test.ts
```

### 2. Environment Bindings

```typescript
interface AdminEnv {
  AUTH_KV: KVNamespace;       // Shared — user records, login verification
  REGISTRY_KV: KVNamespace;   // Shared — codeguard curated/popular data
  JWT_SECRET: string;          // Shared — same secret as sync-server
  JWT_ISSUER: string;          // "saqr"
  JWT_AUDIENCE: string;        // "saqr-admin"
  ALLOWED_ORIGINS: string;     // Admin-specific CORS origins
}
```

### 3. Admin Authentication

- Verify JWT (same `JWT_SECRET` as sync-server)
- Look up user in `AUTH_KV` by userId from token
- Check `role === "admin"` on the KV record
- Return 401 for missing/invalid token, 403 for non-admin users

**User record change**: Add `role?: "user" | "admin"` to `KVUserRecord` in sync-server types. Default `"user"`. Registration always sets `"user"`. Promotion is admin-only.

### 4. API Endpoints

#### Health
- `GET /api/health` — no auth

#### Codeguard Curated (admin only)
- `GET /api/admin/codeguard/curated` — list all curated rules
- `POST /api/admin/codeguard/curated` — add a rule (validates patterns, id uniqueness)
- `PUT /api/admin/codeguard/curated/:id` — update a rule
- `DELETE /api/admin/codeguard/curated/:id` — remove from curated list

#### Codeguard Popular (admin only)
- `GET /api/admin/codeguard/popular` — list all popular rules (including hidden)
- `POST /api/admin/codeguard/popular/:id/hide` — hide a problematic rule from public list
- `POST /api/admin/codeguard/popular/:id/unhide` — restore a hidden rule

#### User Management (admin only)
- `GET /api/admin/users` — list users (paginated, from KV — list keys with `user:` prefix)
- `GET /api/admin/users/:id` — get user details
- `POST /api/admin/users/:id/promote` — set role to admin
- `POST /api/admin/users/:id/demote` — set role back to user

### 5. Curated Rules Storage

KV key: `codeguard:curated`

```json
{
  "version": 1,
  "updated": "2026-02-23T00:00:00Z",
  "updated_by": "usr_abc123",
  "rules": [
    {
      "id": "eval-usage",
      "description": "...",
      "severity": "block",
      "enabled": true,
      "file_patterns": ["*.ts", "*.js"],
      "patterns": ["\\beval\\s*\\("],
      "exclude_patterns": ["codeguard:allow eval-usage"],
      "suggestion": "Use JSON.parse()",
      "order": 1,
      "added_at": "2026-02-23T00:00:00Z",
      "added_by": "usr_abc123"
    }
  ]
}
```

### 6. Popular Rules Moderation

Admin sees full popular list including hidden entries. `hide` sets `hidden: true` on the entry in `codeguard:popular`. The public read endpoint in sync-server filters these out.

### 7. Shared Infrastructure (copied from sync-server)

These files are copied from sync-server (not imported — separate deployment):
- `helpers.ts` — `jsonResponse`, `errorResponse`, `withCorsHeaders`, `withSecurityHeaders`
- `auth/jwt.ts` — `verifyToken`, `JWTError`

### 8. Security

- All admin endpoints require JWT + admin role
- CORS restricted to admin domain only
- Security headers on all responses
- Rate limiting (generous — admin operations are low-frequency)
- Input validation on all rule mutations (regex validity, id format, required fields)

---

## Sync-Server Changes Required

These are prerequisites for this story (or implemented alongside):

1. **`KVUserRecord`**: Add `role?: "user" | "admin"` field
2. **`handleRegister`**: Set `role: "user"` on new accounts
3. **`handleLogin`**: Include `role` in JWT claims (so admin-server can check it)
4. **`Env`**: Add `REGISTRY_KV: KVNamespace` binding
5. **`wrangler.toml`**: Add `REGISTRY_KV` namespace binding

---

## Test Plan

### Admin Auth (~6 tests)
- Valid admin JWT → 200
- Valid non-admin JWT → 403
- Missing JWT → 401
- Expired JWT → 401
- Invalid JWT → 401
- Admin with revoked role → 403

### Curated CRUD (~12 tests)
- List empty → empty array
- Add rule → appears in list
- Add duplicate id → 409
- Add invalid regex → 400
- Update existing → changes persisted
- Update nonexistent → 404
- Delete existing → removed
- Delete nonexistent → 404
- Non-admin → 403 for all mutations
- Validation: missing required fields → 400

### Popular Moderation (~8 tests)
- List popular → returns all (including hidden) for admin
- Hide rule → hidden flag set
- Hide nonexistent → 404
- Unhide rule → hidden flag cleared
- Non-admin → 403

### User Management (~6 tests)
- List users → returns paginated list
- Promote user → role set to admin
- Demote user → role set to user
- Promote nonexistent → 404
- Non-admin → 403
