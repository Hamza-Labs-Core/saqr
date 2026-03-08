# Story 20: Auth System Hardening

## Overview

Story 11 (Sync Server) implemented basic JWT authentication with registration and login endpoints. The current implementation handles the happy path but lacks critical production auth features: email verification, password reset, refresh token rotation, rate limiting on auth endpoints, and session management.

This story hardens the auth system to production quality. All changes are in the `sync-server` package (Cloudflare Worker) plus a new transactional email integration.

**Guiding principle**: Auth is the #1 attack surface. Every endpoint must be rate-limited, every token must expire, every email must be verified, and every error message must be generic (no user enumeration).

---

## Scope

### In Scope

- Email verification flow (registration → verification email → activate account)
- Password reset flow (request → email with token → set new password)
- Refresh token rotation (short-lived access JWT + long-lived refresh token)
- Session management (list active sessions, revoke session, revoke all)
- Rate limiting on auth endpoints (per-IP, per-email)
- Account lockout after repeated failed logins (5 attempts → 15 min cooldown)
- Password strength validation (server-side, min 10 chars, zxcvbn score ≥ 3)
- Generic error messages (no user enumeration via timing or response differences)
- Transactional email integration (Resend API)
- Email templates: verification, password reset, welcome, security alert
- CSRF protection for cookie-based auth (SameSite + double-submit token)

### Out of Scope

- OAuth / social login (GitHub, Google — separate story)
- Passkey / WebAuthn (future story)
- 2FA / TOTP (future story)
- Admin auth (Story 15 — already has role-based JWT)
- Client-side auth UI (Story 19 — web app)

---

## Requirements

### 1. Email Verification

#### Flow
1. User registers with email + password
2. Server creates account with `verified: false`
3. Server sends verification email with signed token (HMAC-SHA256, 24h expiry)
4. User clicks link → `POST /api/auth/verify-email` with token
5. Server sets `verified: true`, issues JWT

#### API
```
POST /api/auth/register
  Body: { email, password, name }
  Response: 201 { message: "Check your email to verify your account" }
  Rate limit: 3/hour per IP

POST /api/auth/verify-email
  Body: { token }
  Response: 200 { accessToken, refreshToken, user }
  Rate limit: 10/hour per IP

POST /api/auth/resend-verification
  Body: { email }
  Response: 200 { message: "If the email exists, we sent a new verification link" }
  Rate limit: 3/hour per email
```

#### Rules
- Unverified accounts cannot log in (401 with "Please verify your email")
- Verification tokens are single-use (stored in KV with TTL)
- Resend verification invalidates previous token
- Unverified accounts auto-deleted after 7 days

### 2. Password Reset

#### Flow
1. User requests reset → `POST /api/auth/forgot-password` with email
2. Server sends email with reset token (HMAC-SHA256, 1h expiry)
3. User clicks link → opens reset page → enters new password
4. `POST /api/auth/reset-password` with token + new password
5. All existing sessions revoked, user must log in again

#### API
```
POST /api/auth/forgot-password
  Body: { email }
  Response: 200 { message: "If the email exists, we sent a reset link" }
  Rate limit: 3/hour per email

POST /api/auth/reset-password
  Body: { token, newPassword }
  Response: 200 { message: "Password reset. Please log in." }
  Rate limit: 5/hour per IP
```

#### Rules
- Same response for existing and non-existing emails (no enumeration)
- Reset token is single-use
- After reset, all refresh tokens for the user are revoked
- Security alert email sent after password change

### 3. Refresh Token Rotation

Replace single JWT with access + refresh token pair.

#### Token Structure
| Token | Lifetime | Storage | Purpose |
|-------|----------|---------|---------|
| Access token | 15 min | Memory / Authorization header | API authentication |
| Refresh token | 30 days | httpOnly cookie (web) or secure storage (mobile) | Get new access token |

#### API
```
POST /api/auth/login
  Body: { email, password }
  Response: 200 { accessToken, refreshToken, user }

POST /api/auth/refresh
  Body: { refreshToken }
  Response: 200 { accessToken, refreshToken }
  Note: Old refresh token is invalidated (rotation)

POST /api/auth/logout
  Body: { refreshToken }
  Response: 200 { message: "Logged out" }
  Note: Refresh token added to denylist
```

#### Refresh Token Rotation
- Each refresh produces a new refresh token and invalidates the old one
- If a previously-used refresh token is presented → **token family revoked** (all tokens for that session)
- This detects token theft: attacker uses stolen refresh token → legitimate user's next refresh fails → entire family revoked

#### Storage
- Refresh tokens stored in KV: `refresh:{tokenHash}` → `{ userId, family, issuedAt, expiresAt }`
- Token family: all refresh tokens descended from one login form a family
- Revoke family: delete all KV entries matching family ID

### 4. Session Management

#### API
```
GET /api/auth/sessions
  Response: 200 { sessions: [{ id, device, ip, lastActive, current }] }

DELETE /api/auth/sessions/:id
  Response: 200 { message: "Session revoked" }

DELETE /api/auth/sessions
  Response: 200 { message: "All sessions revoked" }
  Note: Forces re-login on all devices
```

#### Device Fingerprint
- Derive device name from User-Agent parsing (e.g., "Chrome on macOS", "Saqr Mobile on iOS")
- Store IP (hashed for privacy) and last active timestamp
- Show in account settings for user review

### 5. Rate Limiting

#### Limits by Endpoint
| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| POST /api/auth/register | 3 | 1 hour | IP |
| POST /api/auth/login | 5 | 15 min | IP + email |
| POST /api/auth/refresh | 30 | 1 hour | User ID |
| POST /api/auth/forgot-password | 3 | 1 hour | email |
| POST /api/auth/reset-password | 5 | 1 hour | IP |
| POST /api/auth/verify-email | 10 | 1 hour | IP |

#### Implementation
- Cloudflare Worker KV with atomic increment + TTL
- Key format: `ratelimit:{endpoint}:{key}:{window}`
- Response: 429 Too Many Requests with `Retry-After` header
- No information leakage (same response for rate-limited vs. genuinely failed)

### 6. Account Lockout

- After 5 failed login attempts for an email: lock for 15 minutes
- Lockout counter stored in KV: `lockout:{emailHash}` → `{ attempts, lockedUntil }`
- Successful login resets counter
- Password reset bypasses lockout
- Lockout notification email sent to user

### 7. Transactional Email (Resend)

#### Integration
- Resend API via HTTP (no SDK — keep Worker bundle small)
- API key stored in Worker secret: `RESEND_API_KEY`
- From address: `noreply@saqr.dev` (or configurable)

#### Templates
| Email | Trigger | Content |
|-------|---------|---------|
| Verification | Registration | "Verify your email" + link with token |
| Welcome | Email verified | "Welcome to Saqr" + getting started guide |
| Password reset | Forgot password | "Reset your password" + link with token |
| Security alert | Password changed, new login from new device | "Security alert" + details |
| Lockout notice | 5 failed login attempts | "Your account was temporarily locked" |

#### Template Rendering
- Plain HTML templates (no template engine — simple string interpolation)
- Both HTML and plaintext versions
- Unsubscribe link not needed (transactional, not marketing)

### 8. Password Validation

Server-side password strength validation:
- Minimum 10 characters
- Cannot be the user's email address
- Cannot be in the top 10,000 common passwords list (static check)
- zxcvbn score ≥ 3 (use lightweight server-side implementation)

Error response includes specific weakness (e.g., "Password is too common", "Password is too short").

---

## Test Cases

### Email Verification
- TC20.1: Registration sends verification email
- TC20.2: Valid verification token activates account
- TC20.3: Expired verification token (>24h) returns 400
- TC20.4: Used verification token returns 400 on second use
- TC20.5: Unverified account cannot log in (401)
- TC20.6: Resend verification invalidates previous token
- TC20.7: Unverified accounts are cleaned up after 7 days

### Password Reset
- TC20.8: Forgot password sends reset email for existing account
- TC20.9: Forgot password returns 200 for non-existing email (no enumeration)
- TC20.10: Valid reset token allows password change
- TC20.11: Expired reset token (>1h) returns 400
- TC20.12: Password reset revokes all active sessions
- TC20.13: Security alert email sent after password change

### Refresh Token Rotation
- TC20.14: Login returns access token + refresh token
- TC20.15: Refresh returns new access + refresh, invalidates old refresh
- TC20.16: Reuse of old refresh token revokes entire token family
- TC20.17: Expired refresh token returns 401
- TC20.18: Logout invalidates refresh token
- TC20.19: Access token expires after 15 min

### Session Management
- TC20.20: List sessions returns all active sessions for user
- TC20.21: Current session is marked in list
- TC20.22: Revoking a session invalidates its refresh token
- TC20.23: "Revoke all" invalidates all refresh tokens
- TC20.24: Device name parsed from User-Agent

### Rate Limiting
- TC20.25: 6th login attempt in 15 min returns 429
- TC20.26: Rate limit resets after window expires
- TC20.27: Registration rate limited to 3/hour per IP
- TC20.28: Different IPs have independent rate limits
- TC20.29: 429 response includes Retry-After header

### Account Lockout
- TC20.30: 5 failed logins lock account for 15 min
- TC20.31: Successful login resets attempt counter
- TC20.32: Locked account returns 423 with "try again in X minutes"
- TC20.33: Password reset bypasses lockout
- TC20.34: Lockout notification email sent

### Password Validation
- TC20.35: Password under 10 chars rejected
- TC20.36: Common password ("password123") rejected
- TC20.37: Password matching email rejected
- TC20.38: Strong password accepted

---

## Dependencies

- Story 11 (Sync Server): existing auth endpoints to enhance
- Resend account + API key (secret)
- DNS: SPF/DKIM records for email deliverability

## Acceptance Criteria

- [ ] Email verification required before login
- [ ] Password reset flow works end-to-end
- [ ] Refresh token rotation with family revocation on reuse
- [ ] All auth endpoints rate-limited
- [ ] Account lockout after 5 failed attempts
- [ ] Transactional emails sent for verification, reset, security alerts
- [ ] No user enumeration possible via any endpoint
- [ ] 35+ unit tests passing
