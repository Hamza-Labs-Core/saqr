# Implementation Plan: Story 20 -- Auth System Hardening

**Date**: 2026-02-25
**Story**: 20-auth-system
**Status**: Planning
**Estimated Total Effort**: ~10 days (40-50 hours)
**Prerequisites**: Story 11 (Sync Server) fully implemented. Resend account with API key. DNS SPF/DKIM records configured for `saqr.dev`.
**Architecture**: All changes in `packages/sync-server` (Cloudflare Worker). No new packages. Email via Resend HTTP API (no SDK).

### Relationship to Other Stories

This story **hardens** the existing auth system from Story 11. It does not change the sync protocol, Durable Object, or codeguard features.

- **Story 11** (Sync Server): Provides the baseline auth (register, login, JWT). This story rewrites both handlers, adds 6 new endpoints, and replaces single-JWT auth with access+refresh token pairs.
- **Story 15** (Admin Server): Admin auth (role-based JWT) remains unchanged. Admin endpoints continue to verify the access token the same way. The shorter 15-min access token lifetime is transparent to admin-server since it already validates via JWT_SECRET.
- **Story 19** (Web App): Will consume the new auth endpoints (verify-email, forgot-password, refresh, sessions). This story defines the API contract.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Access token lifetime | 15 minutes | Short enough to limit damage from stolen tokens; long enough to avoid constant refreshes |
| Refresh token lifetime | 30 days | Matches typical "remember me" expectation |
| Refresh token storage | SHA-256 hash in KV (`refresh:{hash}`) | Never store raw tokens server-side; hash allows lookup without exposing token |
| Email verification tokens | HMAC-SHA256 signed, 24h TTL | Stateless verification possible; KV entry tracks single-use |
| Password reset tokens | HMAC-SHA256 signed, 1h TTL | Same HMAC approach; shorter TTL for security-sensitive operation |
| Unverified account cleanup | KV TTL (7 days) on `unverified:{userId}` key | Automatic cleanup without cron; KV handles expiration natively |
| Password strength | Min 10 chars + common password blocklist + email check | No zxcvbn dependency (too heavy for Worker bundle); blocklist covers top 10k passwords |
| Email service | Resend HTTP API (no SDK) | Keeps Worker bundle small; single fetch() call per email |
| Token family revocation | Family ID links all refresh tokens from one login | Detects token theft via reuse detection; revokes entire family atomically |

---

## Task Dependency Graph

```
Task 1: Type Extensions (Env, KVUserRecord, new request/response types)
  |
  +---> Task 2: Password Validator (strength checks, common password blocklist)
  |       |
  |       +---> Task 8: Auth Handler Rewrite (register, login — consumes validator)
  |
  +---> Task 3: Email Service (Resend integration, templates)
  |       |
  |       +---> Task 4: Email Verification Flow (register sends email, verify-email endpoint)
  |       |       |
  |       |       +---> Task 8 (register handler sends verification email)
  |       |
  |       +---> Task 5: Password Reset Flow (forgot-password, reset-password endpoints)
  |       |       |
  |       |       +---> Task 9: Security Alert Emails (password change, new device login)
  |       |
  |       +---> Task 10: Account Lockout (sends lockout notification email)
  |
  +---> Task 6: Refresh Token Rotation (issue, rotate, revoke, family detection)
  |       |
  |       +---> Task 7: Session Management (list, revoke, revoke-all)
  |       |
  |       +---> Task 8 (login issues refresh token pair)
  |
  +---> Task 11: Auth Rate Limiting (per-endpoint, per-IP/email limits)
  |       |
  |       +---> Task 12: Worker Route Updates (wire all new endpoints)
  |
  +---> Task 13: Integration Tests (62+ tests covering all flows)
          (needs all tasks)
```

---

## Tasks

### Task 1: Type Extensions

**Description**

Extend the existing type definitions to support all new auth features: refresh tokens, email verification, password reset, session management, account lockout, and the Resend email service. Also add the `RESEND_API_KEY` binding to the `Env` interface.

**Prerequisites/Inputs**

- Existing types at `/home/meywd/Saqr/packages/sync-server/src/types.ts`
- Story 20 requirements document

**Implementation Details**

**File: `packages/sync-server/src/types.ts`**

Add to the `Env` interface:
```typescript
// Auth hardening bindings
RESEND_API_KEY: string;
RESEND_FROM_EMAIL: string; // e.g. "noreply@saqr.dev"
APP_URL: string;           // e.g. "https://app.saqr.dev" — used in email links
```

Extend `KVUserRecord` with new fields:
```typescript
export interface KVUserRecord {
  userId: string;
  passwordHash: string;
  email: string;
  tier: Tier;
  createdAt: string;
  role?: 'user' | 'admin';
  // New fields for Story 20
  verified: boolean;
  name?: string;
  lockedUntil?: string;      // ISO timestamp — null/absent means not locked
  failedAttempts?: number;    // Reset on successful login
  lastLoginAt?: string;
  passwordChangedAt?: string; // Used to invalidate old tokens
}
```

New request/response types:
```typescript
export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;  // Added field
}

export interface VerifyEmailRequest {
  token: string;
}

export interface ResendVerificationRequest {
  email: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  refreshToken: string;
}

// KV stored types for refresh tokens
export interface KVRefreshTokenRecord {
  userId: string;
  family: string;      // Token family ID (from original login)
  issuedAt: string;    // ISO timestamp
  expiresAt: string;   // ISO timestamp
  device?: string;     // Parsed User-Agent
  ipHash?: string;     // SHA-256 of IP for privacy
  sessionId: string;   // Links to session
}

// KV stored types for sessions
export interface KVSessionRecord {
  sessionId: string;
  userId: string;
  family: string;
  device: string;
  ipHash: string;
  createdAt: string;
  lastActiveAt: string;
}

// KV stored types for email verification
export interface KVVerificationRecord {
  userId: string;
  email: string;
  createdAt: string;
}

// KV stored types for password reset
export interface KVResetRecord {
  userId: string;
  email: string;
  createdAt: string;
}

// Auth token response (updated for refresh tokens)
export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: {
    user_id: string;
    email: string;
    tier: Tier;
    name?: string;
    verified: boolean;
  };
}

// Session info for GET /api/auth/sessions
export interface SessionInfo {
  id: string;
  device: string;
  ip_hash: string;
  last_active: string;
  created_at: string;
  current: boolean;
}
```

**Acceptance Criteria**

- [ ] `Env` interface includes `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `APP_URL`
- [ ] `KVUserRecord` has `verified`, `lockedUntil`, `failedAttempts`, `lastLoginAt`, `passwordChangedAt` fields
- [ ] `RegisterRequest` includes optional `name` field
- [ ] All new request/response interfaces defined for verify-email, forgot-password, reset-password, refresh, logout, sessions
- [ ] `KVRefreshTokenRecord`, `KVSessionRecord`, `KVVerificationRecord`, `KVResetRecord` defined
- [ ] `AuthTokenResponse` includes `refresh_token` and `verified` field on user
- [ ] `tsc --noEmit` passes with no errors

**Estimated Effort**: S (Small) -- ~1 hour

---

### Task 2: Password Validator

**Description**

Implement server-side password strength validation. The validator checks minimum length (10 chars), rejects the user's email as password, and checks against a static blocklist of the top 10,000 most common passwords. Returns specific error messages indicating why a password was rejected.

**Prerequisites/Inputs**

- Task 1 (type extensions)
- Top 10k common passwords list (embedded as a Set for O(1) lookup)

**Implementation Details**

**File: `packages/sync-server/src/auth/password-validator.ts`** (new file)

```typescript
export interface PasswordValidationResult {
  valid: boolean;
  error?: string; // Human-readable reason
  code?: string;  // Machine-readable code
}

export function validatePassword(
  password: string,
  email: string,
): PasswordValidationResult;
```

Validation rules (checked in order, first failure returned):

1. **Type check**: Must be a non-empty string. Code: `invalid_password`.
2. **Minimum length**: At least 10 characters. Code: `password_too_short`. Message: "Password must be at least 10 characters".
3. **Maximum length**: At most 1024 characters. Code: `password_too_long`. Message: "Password exceeds maximum length".
4. **Email match**: Case-insensitive comparison against the email (and the local part of the email). Code: `password_is_email`. Message: "Password cannot be your email address".
5. **Common password check**: Lowercase the password, check against the blocklist Set. Code: `password_too_common`. Message: "This password is too common. Please choose a stronger password".

**Common password blocklist**:

Store as a static `Set<string>` in a separate file `packages/sync-server/src/auth/common-passwords.ts`. To keep the Worker bundle reasonable, include only the top 1,000 most common passwords (not 10k -- reduces bundle by ~80KB). The list is sourced from SecLists and embedded at build time as a string array.

```typescript
// common-passwords.ts
export const COMMON_PASSWORDS = new Set([
  'password', '123456', '12345678', 'qwerty', 'abc123',
  'monkey', '1234567', 'letmein', 'trustno1', 'dragon',
  // ... top 1000
]);
```

**Update existing `isValidPassword` in helpers.ts**: The old `isValidPassword` (12-char minimum, length-only) is replaced by the new validator. Keep the old function but mark it deprecated; callers will migrate to the new validator in Task 8.

**Acceptance Criteria**

- [ ] `validatePassword("short", "user@test.com")` returns `{ valid: false, code: "password_too_short" }`
- [ ] `validatePassword("user@test.com", "user@test.com")` returns `{ valid: false, code: "password_is_email" }`
- [ ] `validatePassword("password123", "user@test.com")` returns `{ valid: false, code: "password_too_common" }`
- [ ] `validatePassword("MyStr0ng!Pass#2026", "user@test.com")` returns `{ valid: true }`
- [ ] Common passwords set has at least 1,000 entries
- [ ] All checks run in < 1ms (no async, pure computation)
- [ ] 8+ unit tests covering all validation rules and edge cases

**Edge Cases**

- Password that is the email local part only (e.g., password "alice" for "alice@example.com") -- should be rejected
- Unicode passwords -- length check uses `.length` (UTF-16 code units), which is acceptable
- Empty string and null/undefined inputs -- return `invalid_password`
- Password that is a common password with mixed case (e.g., "Password") -- lowercase before blocklist check

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 3: Email Service (Resend Integration)

**Description**

Create a lightweight email sending service using the Resend HTTP API. No SDK -- just `fetch()` calls. Includes HTML + plaintext templates for: verification, welcome, password reset, security alert, and lockout notification.

**Prerequisites/Inputs**

- Task 1 (type extensions -- `Env` with `RESEND_API_KEY`)
- Resend API documentation: `POST https://api.resend.com/emails`

**Implementation Details**

**File: `packages/sync-server/src/email/service.ts`** (new file)

```typescript
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an email via the Resend API.
 * Fails silently (logs error, returns { success: false }) to avoid
 * blocking auth flows when email service is unavailable.
 */
export async function sendEmail(
  env: Env,
  options: SendEmailOptions,
): Promise<EmailResult>;
```

Implementation:
```typescript
const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    from: env.RESEND_FROM_EMAIL || 'Saqr <noreply@saqr.dev>',
    to: [options.to],
    subject: options.subject,
    html: options.html,
    text: options.text,
  }),
});
```

**File: `packages/sync-server/src/email/templates.ts`** (new file)

Template functions that return `{ subject, html, text }`:

```typescript
export function verificationEmail(params: {
  name?: string;
  verifyUrl: string;
  expiresIn: string; // e.g. "24 hours"
}): { subject: string; html: string; text: string };

export function welcomeEmail(params: {
  name?: string;
}): { subject: string; html: string; text: string };

export function passwordResetEmail(params: {
  name?: string;
  resetUrl: string;
  expiresIn: string; // e.g. "1 hour"
}): { subject: string; html: string; text: string };

export function securityAlertEmail(params: {
  name?: string;
  action: string;       // e.g. "Password changed", "New login from Chrome on macOS"
  timestamp: string;
  ipHash: string;       // Partial IP or hashed for privacy
  device?: string;
}): { subject: string; html: string; text: string };

export function lockoutNoticeEmail(params: {
  name?: string;
  unlockMinutes: number; // e.g. 15
}): { subject: string; html: string; text: string };
```

Templates use simple string interpolation (template literals). HTML is minimal, inline-styled for email client compatibility. Each template has both HTML and plaintext versions.

**File: `packages/sync-server/src/email/index.ts`** (new file)

Barrel export for the email module:
```typescript
export { sendEmail } from './service.js';
export * from './templates.js';
```

**Acceptance Criteria**

- [ ] `sendEmail` calls Resend API with correct headers and body
- [ ] `sendEmail` returns `{ success: false }` on network/API error (does not throw)
- [ ] All 5 template functions return valid HTML and plaintext
- [ ] Verification email includes the verify URL and expiry
- [ ] Password reset email includes the reset URL and expiry
- [ ] Security alert email includes action, timestamp, and device info
- [ ] Templates do not include any PII beyond the recipient's name
- [ ] 10+ unit tests (mock `fetch`, verify request body, test each template)

**Edge Cases**

- Resend API returns 429 (rate limited) -- return `{ success: false }`, do not retry (caller handles)
- Resend API returns 500 -- same as above
- Missing `RESEND_API_KEY` -- return `{ success: false, error: "Email service not configured" }`
- Empty name -- templates should gracefully fall back to "there" (e.g., "Hi there,")

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 4: Email Verification Flow

**Description**

Implement the email verification flow: on registration, create an unverified account and send a verification email with an HMAC-signed token. Provide endpoints to verify the token and resend the verification email. Unverified accounts cannot log in. Accounts that remain unverified for 7 days are auto-cleaned via KV TTL.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 3 (email service -- for sending verification emails)
- Existing HMAC-SHA256 signing via Web Crypto API (same pattern as JWT)

**Implementation Details**

**File: `packages/sync-server/src/auth/verification.ts`** (new file)

HMAC token generation and verification:

```typescript
/**
 * Generate a verification token.
 * Format: base64url(payload).base64url(hmac-sha256(payload, secret))
 * Payload: JSON { userId, email, purpose: "verify", exp: timestamp }
 */
export async function generateVerificationToken(
  userId: string,
  email: string,
  secret: string,
  ttlSeconds: number, // 86400 = 24 hours
): Promise<string>;

/**
 * Verify and decode a verification token.
 * Returns the decoded payload or null if invalid/expired.
 */
export async function verifyVerificationToken(
  token: string,
  secret: string,
): Promise<{ userId: string; email: string; purpose: string } | null>;
```

The HMAC approach: the token encodes a JSON payload (userId, email, purpose, exp) and appends an HMAC-SHA256 signature. This is stateless -- the server can verify without a database lookup. However, single-use enforcement requires a KV record.

**KV Storage Strategy**:

- On registration: store `verify:{tokenHash}` with TTL 86400 (24h). Value: `{ userId, email, createdAt }`.
- On verification: delete `verify:{tokenHash}`, set `user.verified = true`.
- On resend: delete old `verify:*` for this user (store `verify_user:{userId}` -> `tokenHash` for lookup), create new token.
- Unverified account cleanup: store `unverified:{userId}` with TTL 604800 (7 days). On TTL expiry, account is cleaned up. Since KV does not support TTL callbacks, the cleanup happens lazily: on any login attempt for an expired unverified account, delete it. Alternatively, store the user record itself with a 7-day TTL and only make it permanent on verification.

**Preferred cleanup approach**: Store the `user:{email}` KV entry with `expirationTtl: 604800` (7 days) on registration. When the user verifies, re-`PUT` the record without a TTL (making it permanent). This uses KV's built-in TTL for automatic cleanup with zero extra infrastructure.

**Endpoints** (handler functions, wired in Task 12):

```typescript
// POST /api/auth/verify-email
export async function handleVerifyEmail(
  request: Request,
  env: Env,
): Promise<Response>;

// POST /api/auth/resend-verification
export async function handleResendVerification(
  request: Request,
  env: Env,
): Promise<Response>;
```

`handleVerifyEmail`:
1. Parse `{ token }` from body.
2. Verify HMAC signature and expiry.
3. Check KV `verify:{tokenHash}` exists (single-use).
4. Load user record, set `verified: true`.
5. Re-PUT user record without TTL (permanent).
6. Delete `verify:{tokenHash}`.
7. Delete `unverified:{userId}`.
8. Issue access + refresh token pair (via Task 6).
9. Send welcome email (via Task 3).
10. Return `{ accessToken, refreshToken, user }`.

`handleResendVerification`:
1. Parse `{ email }` from body.
2. Always return 200 with generic message (no enumeration).
3. If user exists and `verified: false`: generate new token, delete old `verify:*` entries, send email.
4. If user does not exist or already verified: do nothing, still return 200.

**Acceptance Criteria**

- [ ] `generateVerificationToken` produces a valid HMAC-signed token
- [ ] `verifyVerificationToken` accepts valid tokens and rejects tampered/expired tokens
- [ ] Registration creates user with `verified: false` and 7-day KV TTL
- [ ] Verification sets `verified: true` and removes KV TTL
- [ ] Verification token is single-use (second use returns 400)
- [ ] Resend invalidates previous token and sends new one
- [ ] Unverified account cannot log in (Task 8 enforces this)
- [ ] 200 response for resend regardless of email existence
- [ ] 7+ unit tests

**Edge Cases**

- Token with valid HMAC but expired (`exp < now`) -- reject
- Token with valid HMAC but user already verified -- return 400 "Already verified"
- Token with valid HMAC but user deleted (TTL expired) -- return 400 "Invalid token"
- Resend for verified account -- do nothing, return 200
- Multiple rapid resend requests -- each invalidates the previous token, only latest works

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 5: Password Reset Flow

**Description**

Implement forgot-password and reset-password endpoints. Uses the same HMAC token pattern as email verification but with 1-hour TTL. After a successful reset, all refresh tokens for the user are revoked and a security alert email is sent.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 3 (email service -- for sending reset emails and security alerts)
- Task 4 (HMAC token utilities -- reuse `generateVerificationToken`/`verifyVerificationToken` with different purpose)
- Task 6 (refresh token rotation -- for revoking all sessions on reset)

**Implementation Details**

**File: `packages/sync-server/src/auth/password-reset.ts`** (new file)

```typescript
// POST /api/auth/forgot-password
export async function handleForgotPassword(
  request: Request,
  env: Env,
): Promise<Response>;

// POST /api/auth/reset-password
export async function handleResetPassword(
  request: Request,
  env: Env,
): Promise<Response>;
```

`handleForgotPassword`:
1. Parse `{ email }` from body.
2. Always return 200 with `{ message: "If the email exists, we sent a reset link" }`.
3. If user exists and is verified: generate HMAC token (purpose: "reset", TTL: 3600s), store `reset:{tokenHash}` in KV with TTL 3600, send reset email.
4. If user does not exist: do nothing. Return same 200.
5. If user is unverified: do nothing. Return same 200.

`handleResetPassword`:
1. Parse `{ token, newPassword }` from body.
2. Verify HMAC signature and expiry.
3. Check KV `reset:{tokenHash}` exists (single-use).
4. Validate new password via password validator (Task 2).
5. Hash new password.
6. Update user record with new `passwordHash` and `passwordChangedAt`.
7. Delete `reset:{tokenHash}`.
8. Revoke all refresh tokens for the user (Task 6 -- `revokeAllUserSessions`).
9. Reset lockout counter (Task 10 -- delete `lockout:{emailHash}`).
10. Send security alert email: "Your password was changed".
11. Return `{ message: "Password reset. Please log in." }`.

**KV Storage**:
- `reset:{tokenHash}` -> `{ userId, email, createdAt }` with TTL 3600 (1 hour)
- On successful reset, delete the KV entry

**Acceptance Criteria**

- [ ] Forgot-password returns 200 for both existing and non-existing emails
- [ ] Reset email sent only for existing, verified accounts
- [ ] Valid reset token allows password change
- [ ] Expired reset token (>1h) returns 400
- [ ] Used reset token returns 400 on second use
- [ ] New password is validated (rejects weak passwords)
- [ ] All active sessions revoked after password reset
- [ ] Security alert email sent after successful reset
- [ ] Lockout counter reset after successful password reset
- [ ] 7+ unit tests

**Edge Cases**

- User requests multiple resets in quick succession -- each creates a new token, all remain valid until used or expired
- Reset token for a deleted account -- return 400 generic error
- Reset with same password as current -- allowed (no same-password check)
- Reset when account is locked -- bypass lockout, allow the reset

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 6: Refresh Token Rotation

**Description**

Replace the single JWT approach with an access token (15-min, JWT) + refresh token (30-day, opaque) pair. Implement token rotation: each refresh issues a new pair and invalidates the old refresh token. Implement token family revocation: if a previously-used refresh token is presented, the entire token family is revoked (detecting token theft).

**Prerequisites/Inputs**

- Task 1 (types -- `KVRefreshTokenRecord`, `KVSessionRecord`)
- Existing JWT module at `/home/meywd/Saqr/packages/sync-server/src/auth/jwt.ts`

**Implementation Details**

**File: `packages/sync-server/src/auth/refresh-tokens.ts`** (new file)

```typescript
/**
 * Generate a cryptographically random refresh token.
 * Returns: { raw: string, hash: string }
 * raw = the token sent to the client (64 hex chars = 32 bytes entropy)
 * hash = SHA-256(raw) used as the KV key
 */
export async function generateRefreshToken(): Promise<{ raw: string; hash: string }>;

/**
 * Hash a raw refresh token for KV lookup.
 */
export async function hashRefreshToken(raw: string): Promise<string>;

/**
 * Issue a new access + refresh token pair.
 * Stores the refresh token record in KV and creates a session record.
 */
export async function issueTokenPair(
  env: Env,
  user: KVUserRecord,
  options: {
    family?: string;    // Existing family ID (for rotation) or undefined (new login)
    device?: string;    // Parsed User-Agent
    ipHash?: string;    // SHA-256 of client IP
    sessionId?: string; // Existing session ID (for rotation) or undefined (new login)
  },
): Promise<{
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number; // Access token lifetime in seconds (900)
}>;

/**
 * Refresh an access token using a refresh token.
 * Implements rotation: old refresh token is invalidated, new pair issued.
 * Implements family revocation: if the old token was already used, revoke the entire family.
 */
export async function refreshAccessToken(
  env: Env,
  rawRefreshToken: string,
  device?: string,
  ipHash?: string,
): Promise<
  | { success: true; accessToken: string; refreshToken: string; expiresIn: number }
  | { success: false; error: string; code: string; status: number }
>;

/**
 * Revoke a specific refresh token (logout).
 */
export async function revokeRefreshToken(
  env: Env,
  rawRefreshToken: string,
): Promise<void>;

/**
 * Revoke all refresh tokens for a user (password reset, revoke-all-sessions).
 * Lists all sessions for the user and deletes their refresh token records.
 */
export async function revokeAllUserSessions(
  env: Env,
  userId: string,
): Promise<number>; // Returns count of revoked sessions

/**
 * Revoke all tokens in a token family (theft detection).
 */
export async function revokeTokenFamily(
  env: Env,
  family: string,
): Promise<void>;
```

**KV Storage Layout**:

```
refresh:{tokenHash}     -> KVRefreshTokenRecord (TTL: 30 days)
                           { userId, family, issuedAt, expiresAt, device, ipHash, sessionId }

session:{sessionId}     -> KVSessionRecord (TTL: 30 days)
                           { sessionId, userId, family, device, ipHash, createdAt, lastActiveAt }

sessions:{userId}       -> JSON string[] of sessionIds (no TTL — updated on each login/logout)
                           Used to enumerate all sessions for a user

family:{family}         -> JSON string[] of tokenHashes (TTL: 30 days)
                           Used for family revocation — lists all tokens in this family

used_refresh:{tokenHash} -> "1" (TTL: 30 days)
                           Marker that this refresh token has been used (for reuse detection)
```

**Token rotation flow**:

1. Client sends `POST /api/auth/refresh` with `{ refreshToken }`.
2. Hash the token: `hash = SHA-256(refreshToken)`.
3. Check `used_refresh:{hash}` -- if present, this is a **reuse**. Revoke entire family via `family:{familyId}`. Return 401.
4. Look up `refresh:{hash}` -- if not found, return 401 (token revoked or expired).
5. Mark old token as used: `PUT used_refresh:{hash}` with TTL 30 days.
6. Delete old token: `DELETE refresh:{hash}`.
7. Generate new refresh token, store new `refresh:{newHash}` with same `family`.
8. Update `family:{familyId}` to include new hash.
9. Update session `lastActiveAt`.
10. Sign new access JWT (15 min).
11. Return new pair.

**Access token changes**:

Modify `signToken` call to use 900 seconds (15 min) instead of 3600 (1 hour). The JWT module itself does not change -- only the `expiresInSeconds` parameter.

**Acceptance Criteria**

- [ ] Login returns both access token (15-min) and refresh token (30-day)
- [ ] Refresh returns new access + refresh tokens, old refresh is invalidated
- [ ] Reuse of an already-rotated refresh token revokes the entire family
- [ ] Expired refresh token returns 401
- [ ] Revoking a token (logout) prevents its use
- [ ] `revokeAllUserSessions` deletes all sessions and refresh tokens for a user
- [ ] Session records are created and updated on refresh
- [ ] 10+ unit tests covering rotation, reuse detection, revocation

**Edge Cases**

- Race condition: two concurrent refresh requests with the same token -- the second should trigger family revocation (both requests see the token, but the first marks it used; the second sees `used_refresh` and revokes)
- Family with many tokens (user refreshed 100 times over 30 days) -- `family:{id}` list could be large; cap at 100 entries, remove oldest
- KV eventual consistency: a deleted token might still be readable for a few seconds. The `used_refresh` marker provides a secondary check for the reuse detection path.

**Estimated Effort**: L (Large) -- ~6 hours

---

### Task 7: Session Management

**Description**

Implement endpoints for users to view their active sessions, revoke a specific session, and revoke all sessions. Session data includes device name (parsed from User-Agent), hashed IP, and last active timestamp.

**Prerequisites/Inputs**

- Task 6 (refresh tokens -- session records, revocation functions)
- Task 1 (types -- `SessionInfo`)

**Implementation Details**

**File: `packages/sync-server/src/auth/sessions.ts`** (new file)

```typescript
/**
 * Parse a User-Agent string into a human-readable device name.
 * e.g., "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/120"
 *   -> "Chrome on macOS"
 * e.g., "SaqrMobile/1.0 (iOS 17.2)"
 *   -> "Saqr Mobile on iOS"
 */
export function parseDeviceName(userAgent: string | null): string;

/**
 * Hash an IP address for privacy-preserving storage.
 * Uses SHA-256 and truncates to first 16 hex chars.
 */
export async function hashIP(ip: string): Promise<string>;

// GET /api/auth/sessions
export async function handleListSessions(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response>;

// DELETE /api/auth/sessions/:id
export async function handleRevokeSession(
  request: Request,
  env: Env,
  authCtx: AuthContext,
  sessionId: string,
): Promise<Response>;

// DELETE /api/auth/sessions (no :id -> revoke all)
export async function handleRevokeAllSessions(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response>;
```

`handleListSessions`:
1. Requires authentication (access token in Authorization header).
2. Load `sessions:{userId}` to get list of session IDs.
3. For each session ID, load `session:{sessionId}`.
4. Determine which session is "current" by matching the access token's session ID (encode session ID in JWT claims or derive from the refresh token family).
5. Return `{ sessions: SessionInfo[] }`.

`handleRevokeSession`:
1. Load `session:{sessionId}`, verify it belongs to `authCtx.userId`.
2. Revoke the session's token family via `revokeTokenFamily`.
3. Delete `session:{sessionId}`.
4. Remove session ID from `sessions:{userId}` list.
5. Return `{ message: "Session revoked" }`.

`handleRevokeAllSessions`:
1. Call `revokeAllUserSessions(env, authCtx.userId)`.
2. Return `{ message: "All sessions revoked" }`.
3. Note: This revokes the caller's own session too. The client must re-login.

**Device name parsing**: Use a simple regex-based parser, not a full User-Agent library. Handle the top 5 browsers (Chrome, Firefox, Safari, Edge, Opera) and top 4 OS (Windows, macOS, Linux, iOS/Android). Unknown agents get "Unknown device".

**Acceptance Criteria**

- [ ] List sessions returns all active sessions for the authenticated user
- [ ] Current session is marked with `current: true`
- [ ] Revoking a specific session invalidates its refresh token family
- [ ] Revoking all sessions invalidates all refresh tokens for the user
- [ ] Device name is reasonably parsed from User-Agent
- [ ] IP is hashed (not stored in plain text)
- [ ] Cannot revoke another user's session (returns 404)
- [ ] 7+ unit tests

**Edge Cases**

- User has 0 sessions (should not happen if they are authenticated, but handle gracefully)
- Session record expired from KV before the sessions list was updated -- filter out missing sessions
- Revoking the current session -- allowed, client should handle 401 on next request
- Very long User-Agent strings -- truncate before parsing to prevent DoS

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 8: Auth Handler Rewrite (Register + Login)

**Description**

Rewrite the existing `handleRegister` and `handleLogin` functions to integrate all new auth features: password validation (Task 2), email verification (Task 4), refresh token issuance (Task 6), account lockout checks (Task 10), and security alert emails (Task 9). The existing handlers at `/home/meywd/Saqr/packages/sync-server/src/auth/handlers.ts` are replaced in-place.

**Prerequisites/Inputs**

- Task 2 (password validator)
- Task 3 (email service)
- Task 4 (email verification)
- Task 6 (refresh token rotation -- `issueTokenPair`)
- Task 10 (account lockout -- `checkLockout`, `recordFailedAttempt`, `resetLockout`)

**Implementation Details**

**File: `packages/sync-server/src/auth/handlers.ts`** (rewrite existing)

**`handleRegister` changes**:

1. Parse `{ email, password, name }` from body.
2. Validate email format (existing).
3. Validate password strength via `validatePassword(password, email)` (Task 2). Return specific error from validator.
4. Normalize email to lowercase, trim.
5. Check uniqueness via KV (existing). **Important anti-enumeration change**: Always return the same 201 response whether or not the email exists. If email exists, send a "someone tried to register with your email" security alert instead. This prevents enumeration via the register endpoint.
6. Generate user ID, hash password (existing).
7. Store user record with `verified: false`, `name`, and **7-day KV TTL** (`expirationTtl: 604800`).
8. Store `userid:{userId}` -> email mapping.
9. Generate verification token (Task 4).
10. Store `verify:{tokenHash}` in KV.
11. Send verification email (Task 3).
12. Return `201 { message: "Check your email to verify your account" }`.
13. **Do NOT issue a JWT on registration** -- user must verify first.

**`handleLogin` changes**:

1. Parse `{ email, password }` from body.
2. Normalize email.
3. **Check account lockout** (Task 10): call `checkLockout(env, email)`. If locked, return 423 with "Account temporarily locked. Try again in X minutes."
4. Look up user in KV (existing).
5. If user not found: **still run a dummy password hash** to prevent timing-based enumeration, then return 401 "Invalid email or password".
6. Verify password (existing).
7. If password invalid:
   a. Call `recordFailedAttempt(env, email)` (Task 10).
   b. If attempt count hits 5, send lockout notification email (Task 3).
   c. Return 401 "Invalid email or password".
8. **Check verified status**: if `user.verified === false`, return 401 "Please verify your email before logging in".
9. Reset lockout counter: `resetLockout(env, email)`.
10. Parse device name from User-Agent (Task 7).
11. Hash client IP (Task 7).
12. Issue access + refresh token pair via `issueTokenPair` (Task 6).
13. Update user record: `lastLoginAt = now`.
14. Check if this is a new device (compare device name against existing sessions). If new device, send security alert email (Task 9).
15. Return `{ access_token, refresh_token, token_type, expires_in, user }`.

**Anti-enumeration timing fix**: When user is not found (step 5), perform a dummy `hashPassword("dummy")` call so the response time is similar to a real password verification. This prevents attackers from distinguishing "user not found" from "wrong password" via timing.

**Acceptance Criteria**

- [ ] Registration uses the new password validator (Task 2)
- [ ] Registration creates unverified accounts with 7-day TTL
- [ ] Registration sends verification email instead of returning JWT
- [ ] Registration returns same response for existing and new emails (anti-enumeration)
- [ ] Login checks lockout before password verification
- [ ] Login rejects unverified accounts with clear message
- [ ] Login returns access + refresh token pair
- [ ] Login records failed attempts for lockout
- [ ] Login resets lockout counter on success
- [ ] Login sends new-device alert when appropriate
- [ ] Dummy hash on user-not-found prevents timing enumeration
- [ ] 10+ unit tests

**Edge Cases**

- Registration with an email that has an expired unverified account (TTL deleted the old record) -- treated as a new registration
- Login attempt for a user whose KV record has a corrupted JSON -- return 500 (existing behavior)
- Login with correct password but unverified account -- 401 with verification prompt, do NOT record as failed attempt
- Login from same device but different IP -- not treated as new device (device name matches)

**Estimated Effort**: L (Large) -- ~5 hours

---

### Task 9: Security Alert Emails

**Description**

Send security alert emails for critical account events: password changed (from Task 5), new device login (from Task 8), and all-sessions-revoked. These use the `securityAlertEmail` template from Task 3.

**Prerequisites/Inputs**

- Task 3 (email service and templates)
- Task 7 (device name parsing, IP hashing)

**Implementation Details**

**File: `packages/sync-server/src/auth/security-alerts.ts`** (new file)

```typescript
/**
 * Send a security alert for a password change.
 */
export async function sendPasswordChangedAlert(
  env: Env,
  user: KVUserRecord,
): Promise<void>;

/**
 * Send a security alert for a new device login.
 */
export async function sendNewDeviceLoginAlert(
  env: Env,
  user: KVUserRecord,
  device: string,
  ipHash: string,
): Promise<void>;

/**
 * Send a security alert when all sessions are revoked.
 */
export async function sendAllSessionsRevokedAlert(
  env: Env,
  user: KVUserRecord,
): Promise<void>;
```

Each function:
1. Builds the appropriate template parameters.
2. Calls `sendEmail` (which fails silently if email service is unavailable).
3. Does not block the calling flow -- fire-and-forget via `ctx.waitUntil` in the worker (but since we do not have `ctx` in the handler, we call synchronously and accept the minor latency; the Resend API call is fast).

**Integration points** (called from other tasks):
- `sendPasswordChangedAlert` -- called from `handleResetPassword` (Task 5)
- `sendNewDeviceLoginAlert` -- called from `handleLogin` (Task 8) when a new device is detected
- `sendAllSessionsRevokedAlert` -- called from `handleRevokeAllSessions` (Task 7)

**Acceptance Criteria**

- [ ] Password change triggers security alert email
- [ ] New device login triggers security alert email
- [ ] All-sessions-revoked triggers security alert email
- [ ] Alerts include timestamp, device info, and action description
- [ ] Email sending failure does not block the auth flow
- [ ] 5+ unit tests (mock sendEmail, verify template parameters)

**Estimated Effort**: S (Small) -- ~1.5 hours

---

### Task 10: Account Lockout

**Description**

Implement account lockout after 5 consecutive failed login attempts. The lockout lasts 15 minutes. A successful login resets the counter. Password reset bypasses the lockout. A notification email is sent when the account is locked.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 3 (email service -- for lockout notification)

**Implementation Details**

**File: `packages/sync-server/src/auth/lockout.ts`** (new file)

```typescript
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_SECONDS = 900; // 15 minutes

export interface LockoutStatus {
  locked: boolean;
  remainingMinutes?: number;
  attempts: number;
}

/**
 * Check if an account is locked.
 * KV key: lockout:{SHA-256(email)} -> { attempts, lockedUntil? }
 */
export async function checkLockout(
  env: Env,
  email: string,
): Promise<LockoutStatus>;

/**
 * Record a failed login attempt.
 * Returns true if this attempt caused a lockout.
 */
export async function recordFailedAttempt(
  env: Env,
  email: string,
): Promise<boolean>;

/**
 * Reset the lockout counter (on successful login or password reset).
 */
export async function resetLockout(
  env: Env,
  email: string,
): Promise<void>;
```

**KV Storage**:
```
lockout:{SHA-256(email)} -> JSON { attempts: number, lockedUntil?: string }
                            TTL: max(LOCKOUT_DURATION_SECONDS, 3600) = 3600
```

- `checkLockout`: Load the record. If `lockedUntil` is in the future, return `{ locked: true, remainingMinutes }`. If `lockedUntil` is in the past, reset the record and return `{ locked: false }`.
- `recordFailedAttempt`: Increment `attempts`. If `attempts >= 5`, set `lockedUntil = now + 15 min`. Return `true` if newly locked.
- `resetLockout`: Delete the KV entry.

**Integration** (consumed by Task 8):
- `handleLogin` calls `checkLockout` before password verification.
- `handleLogin` calls `recordFailedAttempt` on wrong password.
- `handleLogin` calls `resetLockout` on successful login.
- `handleResetPassword` (Task 5) calls `resetLockout` after successful reset.

**Lockout HTTP status**: Use `423 Locked` with body `{ error: "account_locked", message: "Account temporarily locked due to too many failed attempts. Try again in X minutes." }`.

**Acceptance Criteria**

- [ ] 5 failed login attempts lock the account for 15 minutes
- [ ] 4 failed attempts do not lock the account
- [ ] Successful login resets the attempt counter
- [ ] Locked account returns 423 with remaining minutes
- [ ] Lockout expires after 15 minutes
- [ ] Password reset bypasses and resets lockout
- [ ] Email hash is used as KV key (not plain email)
- [ ] 6+ unit tests

**Edge Cases**

- Failed attempt for non-existent user -- still track lockout (prevents brute-force enumeration by trying many emails)
- Lockout with exactly 15 minutes remaining (boundary condition)
- Lockout that expired 1 second ago -- should allow login
- KV write failure on `recordFailedAttempt` -- fail open (allow login)
- Concurrent login attempts racing to increment the counter -- KV is eventually consistent, so the counter might be slightly off. Acceptable: worst case, lockout triggers after 6 attempts instead of 5.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 11: Auth Rate Limiting

**Description**

Implement per-endpoint rate limiting for all auth endpoints. Each endpoint has its own limit, window, and key (IP, email, or user ID). This is separate from the existing tier-based rate limiter (which only applies to authenticated sync endpoints).

**Prerequisites/Inputs**

- Task 1 (types)
- Existing rate limiter at `/home/meywd/Saqr/packages/sync-server/src/middleware/rate-limiter.ts` (reference, not modified)

**Implementation Details**

**File: `packages/sync-server/src/auth/rate-limiter.ts`** (new file -- separate from existing middleware rate limiter)

```typescript
export interface AuthRateLimitConfig {
  endpoint: string;
  limit: number;
  windowSeconds: number;
  keyType: 'ip' | 'email' | 'ip+email' | 'userId';
}

const AUTH_RATE_LIMITS: Record<string, AuthRateLimitConfig> = {
  register:            { endpoint: 'register',            limit: 3,  windowSeconds: 3600, keyType: 'ip' },
  login:               { endpoint: 'login',               limit: 5,  windowSeconds: 900,  keyType: 'ip+email' },
  refresh:             { endpoint: 'refresh',             limit: 30, windowSeconds: 3600, keyType: 'userId' },
  'forgot-password':   { endpoint: 'forgot-password',     limit: 3,  windowSeconds: 3600, keyType: 'email' },
  'reset-password':    { endpoint: 'reset-password',      limit: 5,  windowSeconds: 3600, keyType: 'ip' },
  'verify-email':      { endpoint: 'verify-email',        limit: 10, windowSeconds: 3600, keyType: 'ip' },
  'resend-verification': { endpoint: 'resend-verification', limit: 3, windowSeconds: 3600, keyType: 'email' },
};

/**
 * Check auth-specific rate limit.
 * Returns a 429 Response if rate limited, null if allowed.
 *
 * @param env - Worker environment
 * @param endpointName - Key into AUTH_RATE_LIMITS
 * @param keys - { ip?, email?, userId? } — used to construct the rate limit key
 */
export async function checkAuthRateLimit(
  env: Env,
  endpointName: string,
  keys: { ip?: string; email?: string; userId?: string },
): Promise<Response | null>;
```

**KV key format**: `authratelimit:{endpoint}:{keyHash}:{windowId}`
- `keyHash` = SHA-256 of the composite key (IP, email, or both) -- truncated to 16 hex chars for compactness
- `windowId` = `Math.floor(Date.now() / (windowSeconds * 1000))` -- auto-rotates with the window

**Implementation**:
1. Construct the KV key.
2. Read current count (or 0).
3. If count >= limit, return 429 with `Retry-After` header.
4. Increment and store with TTL = windowSeconds + 60 (buffer for clock skew).
5. Return null (allowed).

**429 Response format**:
```json
{
  "error": "rate_limited",
  "message": "Too many requests. Please try again later.",
  "retry_after": 123
}
```
Headers: `Retry-After: 123` (seconds until window resets).

**Client IP extraction**: Use `request.headers.get('CF-Connecting-IP')` (Cloudflare provides this). Fall back to `request.headers.get('X-Forwarded-For')` (first IP) for local dev. Hash the IP before use.

**Acceptance Criteria**

- [ ] Each auth endpoint has its own rate limit config
- [ ] 6th login attempt in 15 min returns 429
- [ ] Rate limit resets after window expires
- [ ] Register limited to 3/hour per IP
- [ ] Different IPs have independent rate limits
- [ ] 429 response includes `Retry-After` header
- [ ] Same response format for rate-limited and genuinely failed requests (no information leakage)
- [ ] IP is hashed in the KV key (not stored in plain text)
- [ ] 7+ unit tests

**Edge Cases**

- Missing `CF-Connecting-IP` header (local dev) -- fall back to `X-Forwarded-For` or `127.0.0.1`
- KV read failure -- fail open (allow request)
- Window boundary: request arrives exactly at the window transition -- new window, counter resets
- IP+email composite key: same IP but different email counts separately; same email from different IPs also counts separately via composite hash

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 12: Worker Route Updates

**Description**

Update the main worker entry point to wire all new auth endpoints, apply auth rate limiting to each, and update the `requiresAuth` function to recognize session management routes.

**Prerequisites/Inputs**

- All tasks 2-11 (handlers and middleware)
- Existing worker at `/home/meywd/Saqr/packages/sync-server/src/worker.ts`

**Implementation Details**

**File: `packages/sync-server/src/worker.ts`** (modify existing)

**New public (unauthenticated) routes**:

```typescript
// Email verification
POST /api/auth/verify-email       -> handleVerifyEmail
POST /api/auth/resend-verification -> handleResendVerification

// Password reset
POST /api/auth/forgot-password    -> handleForgotPassword
POST /api/auth/reset-password     -> handleResetPassword

// Token refresh
POST /api/auth/refresh            -> handleRefreshToken
POST /api/auth/logout             -> handleLogout
```

**New authenticated routes**:

```typescript
// Session management
GET    /api/auth/sessions         -> handleListSessions
DELETE /api/auth/sessions/:id     -> handleRevokeSession
DELETE /api/auth/sessions         -> handleRevokeAllSessions
```

**Rate limiting integration**:

Each public auth route applies `checkAuthRateLimit` before calling the handler:

```typescript
if (url.pathname === '/api/auth/register' && request.method === 'POST') {
  const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const rl = await checkAuthRateLimit(env, 'register', { ip });
  if (rl) return respond(rl);
  return respond(await handleRegister(request, env));
}
```

For login, the rate limit key includes the email, which requires parsing the body first. However, we cannot consume the body twice. Solution: clone the request or parse the email from a query parameter. **Preferred**: Read the body once, pass both to the handler:

```typescript
if (url.pathname === '/api/auth/login' && request.method === 'POST') {
  const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  // Pre-parse body to extract email for rate limiting
  let body: LoginRequest;
  try {
    body = await request.json() as LoginRequest;
  } catch {
    return respond(errorResponse(400, 'invalid_body', 'Request body must be valid JSON'));
  }
  const email = body.email?.toLowerCase().trim();
  const rl = await checkAuthRateLimit(env, 'login', { ip, email });
  if (rl) return respond(rl);
  // Pass pre-parsed body to handler to avoid double-parsing
  return respond(await handleLogin(body, env));
}
```

This requires changing `handleLogin` to accept a pre-parsed body instead of a `Request`. Update the handler signature accordingly.

**Update `requiresAuth`**:

Add `/api/auth/sessions` to the authenticated paths:
```typescript
function requiresAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/api/sync/') ||
    pathname.startsWith('/api/account') ||
    pathname.startsWith('/api/machines') ||
    pathname.startsWith('/api/auth/sessions') ||
    pathname === '/api/codeguard/telemetry'
  );
}
```

**Update imports**: Add imports for all new handlers.

**`wrangler.toml` updates**: Add new environment variables:
```toml
[vars]
# ... existing vars ...
RESEND_FROM_EMAIL = "Saqr <noreply@saqr.dev>"
APP_URL = "https://app.saqr.dev"

# Secret (not in vars, use wrangler secret):
# RESEND_API_KEY
```

**Acceptance Criteria**

- [ ] All 6 new public auth routes are wired and functional
- [ ] All 3 session management routes require authentication
- [ ] Rate limiting is applied to every auth endpoint before the handler runs
- [ ] Login rate limit uses IP+email composite key
- [ ] Refresh rate limit uses userId (extracted from the refresh token record, not from auth header)
- [ ] CORS headers applied to all new endpoints
- [ ] Security headers applied to all new endpoints
- [ ] Body size check applied to POST endpoints
- [ ] 404 returned for unknown paths (existing behavior preserved)
- [ ] Health check still works without auth
- [ ] 5+ integration tests for route wiring

**Edge Cases**

- `DELETE /api/auth/sessions` (no path param) vs `DELETE /api/auth/sessions/:id` -- differentiate by checking if there is a session ID segment after `/sessions/`
- OPTIONS preflight for new endpoints -- already handled by existing CORS preflight handler
- POST to a GET-only route -- return 405 (not currently handled; consider adding)
- `handleLogin` signature change -- ensure the old import in any tests is updated

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 13: Integration Tests

**Description**

Write comprehensive integration tests covering all auth flows end-to-end. Tests use vitest with mocked KV, mocked `fetch` (for Resend API), and the worker's `fetch` handler. Target: 62+ tests organized by feature area.

**Prerequisites/Inputs**

- All tasks 1-12 complete
- Existing test patterns in `/home/meywd/Saqr/packages/sync-server/test/`

**Implementation Details**

**Test files** (all in `packages/sync-server/test/`):

```
test/
  auth/
    password-validator.test.ts    (8 tests)   -- Task 2
    email-service.test.ts         (10 tests)  -- Task 3
    email-templates.test.ts       (5 tests)   -- Task 3
    verification.test.ts          (7 tests)   -- Task 4
    password-reset.test.ts        (7 tests)   -- Task 5
    refresh-tokens.test.ts        (10 tests)  -- Task 6
    sessions.test.ts              (7 tests)   -- Task 7
    handlers.test.ts              (10 tests)  -- Task 8
    lockout.test.ts               (6 tests)   -- Task 10
    rate-limiter.test.ts          (7 tests)   -- Task 11
  integration/
    auth-flows.test.ts            (10 tests)  -- Full flow integration tests
```

**Test breakdown by story test cases**:

| Story TC | Test | File |
|----------|------|------|
| TC20.1 | Registration sends verification email | handlers.test.ts |
| TC20.2 | Valid verification token activates account | verification.test.ts |
| TC20.3 | Expired verification token returns 400 | verification.test.ts |
| TC20.4 | Used verification token returns 400 | verification.test.ts |
| TC20.5 | Unverified account cannot log in | handlers.test.ts |
| TC20.6 | Resend verification invalidates previous token | verification.test.ts |
| TC20.7 | Unverified accounts cleaned up after 7 days | verification.test.ts |
| TC20.8 | Forgot password sends reset email | password-reset.test.ts |
| TC20.9 | Forgot password 200 for non-existing email | password-reset.test.ts |
| TC20.10 | Valid reset token allows password change | password-reset.test.ts |
| TC20.11 | Expired reset token returns 400 | password-reset.test.ts |
| TC20.12 | Password reset revokes all sessions | password-reset.test.ts |
| TC20.13 | Security alert email sent after reset | password-reset.test.ts |
| TC20.14 | Login returns access + refresh token | handlers.test.ts |
| TC20.15 | Refresh returns new pair, invalidates old | refresh-tokens.test.ts |
| TC20.16 | Reuse of old refresh token revokes family | refresh-tokens.test.ts |
| TC20.17 | Expired refresh token returns 401 | refresh-tokens.test.ts |
| TC20.18 | Logout invalidates refresh token | refresh-tokens.test.ts |
| TC20.19 | Access token expires after 15 min | refresh-tokens.test.ts |
| TC20.20 | List sessions returns all active sessions | sessions.test.ts |
| TC20.21 | Current session marked in list | sessions.test.ts |
| TC20.22 | Revoking session invalidates refresh token | sessions.test.ts |
| TC20.23 | Revoke all invalidates all tokens | sessions.test.ts |
| TC20.24 | Device name parsed from User-Agent | sessions.test.ts |
| TC20.25 | 6th login attempt returns 429 | rate-limiter.test.ts |
| TC20.26 | Rate limit resets after window | rate-limiter.test.ts |
| TC20.27 | Register rate limited 3/hour per IP | rate-limiter.test.ts |
| TC20.28 | Different IPs independent rate limits | rate-limiter.test.ts |
| TC20.29 | 429 includes Retry-After header | rate-limiter.test.ts |
| TC20.30 | 5 failed logins lock account for 15 min | lockout.test.ts |
| TC20.31 | Successful login resets counter | lockout.test.ts |
| TC20.32 | Locked account returns 423 | lockout.test.ts |
| TC20.33 | Password reset bypasses lockout | lockout.test.ts |
| TC20.34 | Lockout notification email sent | lockout.test.ts |
| TC20.35 | Password under 10 chars rejected | password-validator.test.ts |
| TC20.36 | Common password rejected | password-validator.test.ts |
| TC20.37 | Password matching email rejected | password-validator.test.ts |
| TC20.38 | Strong password accepted | password-validator.test.ts |

**Integration flow tests** (`auth-flows.test.ts`):

1. **Full registration flow**: Register -> receive verification token -> verify -> login -> get access+refresh tokens
2. **Password reset flow**: Register -> verify -> login -> forgot-password -> reset -> old sessions revoked -> login with new password
3. **Token rotation flow**: Login -> refresh -> refresh -> old token fails -> new token works
4. **Token theft detection**: Login -> attacker steals refresh token -> legitimate user refreshes -> attacker tries stolen token -> family revoked -> both tokens fail
5. **Lockout and recovery flow**: 5 wrong passwords -> locked -> wait -> unlocked -> correct password works
6. **Session management flow**: Login from 3 devices -> list sessions -> revoke one -> revoke all
7. **Rate limiting flow**: Hit register 3 times -> 4th returns 429 -> wait for window reset
8. **Anti-enumeration**: Register existing email -> same 201 response -> login non-existing email -> same 401 response -> same timing
9. **Unverified account cleanup**: Register -> do not verify -> simulate 7-day TTL expiry -> login fails
10. **Concurrent refresh race**: Two refresh requests with same token -> one succeeds, one triggers family revocation

**Mock strategy**:

```typescript
// Mock KV namespace
function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && entry.expiration < Date.now() / 1000) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    delete: async (key: string) => { store.delete(key); },
    list: async (opts?: { prefix?: string }) => {
      const keys = [...store.keys()]
        .filter(k => !opts?.prefix || k.startsWith(opts.prefix))
        .map(k => ({ name: k }));
      return { keys, list_complete: true, cursor: '' };
    },
  } as unknown as KVNamespace;
}

// Mock fetch for Resend
function createMockFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const mockFetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify({ id: 'mock-msg-id' }), { status: 200 });
  };
  return { mockFetch, calls };
}
```

**Acceptance Criteria**

- [ ] 62+ tests total across all test files
- [ ] All 38 story test cases (TC20.1 - TC20.38) covered
- [ ] 10 integration flow tests covering complete end-to-end scenarios
- [ ] All tests pass with `vitest run`
- [ ] Mock KV correctly simulates TTL expiration
- [ ] Mock fetch captures Resend API calls for assertion
- [ ] No tests depend on external services (fully mocked)
- [ ] Test files organized by feature area
- [ ] Each test has a descriptive name matching the story test case ID

**Estimated Effort**: L (Large) -- ~8 hours

---

## Summary

| Task | Description | Depends On | Effort | Tests |
|------|-------------|------------|--------|-------|
| 1 | Type Extensions | -- | S (1h) | 0 |
| 2 | Password Validator | 1 | S (2h) | 8 |
| 3 | Email Service (Resend) | 1 | M (4h) | 15 |
| 4 | Email Verification Flow | 1, 3 | M (4h) | 7 |
| 5 | Password Reset Flow | 1, 3, 4, 6 | M (3h) | 7 |
| 6 | Refresh Token Rotation | 1 | L (6h) | 10 |
| 7 | Session Management | 6 | M (3h) | 7 |
| 8 | Auth Handler Rewrite | 2, 3, 4, 6, 10 | L (5h) | 10 |
| 9 | Security Alert Emails | 3, 7 | S (1.5h) | 5 |
| 10 | Account Lockout | 1, 3 | S (2h) | 6 |
| 11 | Auth Rate Limiting | 1 | M (3h) | 7 |
| 12 | Worker Route Updates | 2-11 | M (3h) | 5 |
| 13 | Integration Tests | 1-12 | L (8h) | 10+ |
| **Total** | | | **~45.5h** | **97+** |

**New files created**:
- `packages/sync-server/src/auth/password-validator.ts`
- `packages/sync-server/src/auth/common-passwords.ts`
- `packages/sync-server/src/auth/verification.ts`
- `packages/sync-server/src/auth/password-reset.ts`
- `packages/sync-server/src/auth/refresh-tokens.ts`
- `packages/sync-server/src/auth/sessions.ts`
- `packages/sync-server/src/auth/security-alerts.ts`
- `packages/sync-server/src/auth/lockout.ts`
- `packages/sync-server/src/auth/rate-limiter.ts`
- `packages/sync-server/src/email/service.ts`
- `packages/sync-server/src/email/templates.ts`
- `packages/sync-server/src/email/index.ts`

**Files modified**:
- `packages/sync-server/src/types.ts` (extended interfaces)
- `packages/sync-server/src/auth/handlers.ts` (rewritten)
- `packages/sync-server/src/worker.ts` (new routes, rate limiting)
- `packages/sync-server/wrangler.toml` (new env vars)
