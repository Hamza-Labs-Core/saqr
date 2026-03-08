# Implementation Plan: Story 21 -- Stripe Billing Integration

**Date**: 2026-02-25
**Story**: 21-stripe-billing
**Status**: Planning
**Estimated Total Effort**: ~10 days (40-50 hours)
**Prerequisites**: Story 11 (Sync Server) with existing tier enforcement, KV schema, and Worker routing. Stripe account with API keys. Products and prices configured in Stripe Dashboard.
**Architecture**: Stripe Checkout + Customer Portal (hosted by Stripe). Sync server (Cloudflare Worker) creates sessions and processes webhooks. No card data touches our infrastructure.

### Relationship to Other Stories

This is the **billing & monetization story**. It connects the existing tier enforcement (Story 11) to real payment processing via Stripe.

- **Story 11** (Sync Server): Provides the Worker, KV schema (`KVUserRecord`), tier enforcement middleware (`checkStorageQuota`, `checkDeviceLimit`, `checkFeatureAccess`), and `Env` type. This story extends all of these.
- **Story 19** (Web App): Consumes the billing API (`/api/billing/checkout`, `/api/billing/portal`, `/api/billing/status`) to render billing UI. Not blocked by this story -- can mock the API.
- **Story 16** (Mobile App): Same consumer relationship as Story 19.
- **Story 20** (Auth): JWT authentication used by all billing endpoints except the webhook.

### Key Design Decisions

1. **No card data on our server** -- Stripe Checkout hosts the payment page; Customer Portal hosts card management. Our Worker only stores `stripeCustomerId` and subscription metadata in KV.
2. **Webhook idempotency via KV event IDs** -- Each Stripe event ID is stored in KV with a 24-hour TTL. Duplicate deliveries are silently ignored.
3. **`past_due` subscription treated as free tier** -- When `invoice.payment_failed` fires, the effective tier drops to `free` even though the subscription object still exists. This incentivizes payment resolution.
4. **14-day trial with no card required** -- Stripe Checkout `subscription_data.trial_period_days: 14` and `payment_method_collection: "if_required"`. Users can try Pro/Team without entering a card.
5. **Grace period on downgrade** -- When a subscription is canceled, the user retains their paid tier until `currentPeriodEnd`. After that, enforcement reverts to free tier limits with read-only access for over-limit users.
6. **402 Payment Required responses** -- A new HTTP status code for tier limit violations, replacing the current 413/403 pattern. Includes `upgradeUrl` for client-side redirect.
7. **Webhook signature verification** -- HMAC-SHA256 via Stripe's `v1` scheme. Replay protection rejects events older than 5 minutes.

---

## Task Dependency Graph

```
Task 1: Stripe Type Definitions & Env Updates
  |
  +---> Task 2: Stripe Signature Verification & Helpers
  |       |
  |       +---> Task 3: Webhook Handler (routing + dispatch)
  |       |       |
  |       |       +---> Task 4: Webhook Event Processors (7 event types)
  |       |               |
  |       |               +---> Task 6: Tier Enforcement Updates (402 + effective tier)
  |       |
  |       +---> Task 5: Checkout Session & Customer Portal Endpoints
  |
  +---> Task 7: KV Schema Updates (billing fields on KVUserRecord)
  |       |
  |       +---> Task 4 (writes billing fields to KV)
  |       +---> Task 5 (reads billing fields from KV)
  |       +---> Task 8: Billing Status API
  |
  +---> Task 9: Grace Period & Downgrade Logic
  |       (needs Tasks 4, 6, 7)
  |
  +---> Task 10: Tests (25+ unit tests)
          (needs all)
```

---

## Tasks

### Task 1: Stripe Type Definitions & Env Updates

**Description**

Define all TypeScript types for Stripe billing integration and extend the existing `Env` interface with Stripe-related bindings. This is the foundation that all billing code imports.

**Prerequisites/Inputs**

- Existing `types.ts` with `Env`, `KVUserRecord`, `Tier`, `AuthContext`
- Stripe API reference for object shapes (Checkout Session, Subscription, Invoice)

**Implementation Details**

**File: `packages/sync-server/src/billing/types.ts`** (new file)

```typescript
// ---------------------------------------------------------------------------
// Stripe Billing Types
// ---------------------------------------------------------------------------

/** Subscription statuses we track (subset of Stripe's full list) */
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

/** Request body for POST /api/billing/checkout */
export interface CheckoutRequest {
  tier: 'pro' | 'team';
}

/** Response for POST /api/billing/checkout */
export interface CheckoutResponse {
  checkoutUrl: string;
}

/** Response for POST /api/billing/portal */
export interface PortalResponse {
  portalUrl: string;
}

/** Response for GET /api/billing/status */
export interface BillingStatusResponse {
  tier: 'free' | 'pro' | 'team';
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  usage: {
    machines: { used: number; limit: number };
    storage: { used: number; limit: number };
    syncFrequency: { current: number; limit: number };
  };
}

/** Billing fields stored on KVUserRecord */
export interface BillingFields {
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialUsed: boolean; // Has user ever had a trial? (prevents re-trials)
}

/** Stripe webhook event envelope (minimal, not full Stripe SDK type) */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: {
    object: Record<string, unknown>;
  };
  livemode: boolean;
}

/** Parsed Stripe Checkout Session (fields we use) */
export interface StripeCheckoutSession {
  id: string;
  customer: string;
  client_reference_id: string; // our userId
  subscription: string;
  mode: string;
}

/** Parsed Stripe Subscription (fields we use) */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  items: {
    data: Array<{
      price: { id: string; product: string };
    }>;
  };
  current_period_end: number;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
}

/** Parsed Stripe Invoice (fields we use) */
export interface StripeInvoice {
  id: string;
  customer: string;
  subscription: string;
  status: string;
  period_end: number;
}

/** 402 Payment Required response body */
export interface TierLimitError {
  error: 'tier_limit_exceeded';
  message: string;
  limit: 'machines' | 'storage' | 'sync_rate' | 'retention' | 'feature';
  current: number;
  max: number;
  upgradeUrl: string;
}
```

**File: `packages/sync-server/src/types.ts`** (extend existing `Env` interface)

Add Stripe-specific environment bindings:

```typescript
// Add to Env interface:
STRIPE_SECRET_KEY: string;
STRIPE_WEBHOOK_SECRET: string;
STRIPE_PRO_PRICE_ID: string;
STRIPE_TEAM_PRICE_ID: string;
BILLING_APP_URL: string; // e.g. "https://app.saqr.dev"
```

**File: `packages/sync-server/src/types.ts`** (extend existing `KVUserRecord`)

Add billing fields:

```typescript
// Add to KVUserRecord interface:
stripeCustomerId?: string | null;
subscriptionId?: string | null;
subscriptionStatus?: SubscriptionStatus | null;
currentPeriodEnd?: string | null;
trialEnd?: string | null;
cancelAtPeriodEnd?: boolean;
trialUsed?: boolean;
```

**Acceptance Criteria**

- [ ] All new types compile without errors alongside existing types
- [ ] `Env` interface includes all 5 Stripe bindings
- [ ] `KVUserRecord` includes all 7 billing fields as optional (backward compatible)
- [ ] `SubscriptionStatus` covers all Stripe subscription statuses we handle
- [ ] `TierLimitError` includes `upgradeUrl` field
- [ ] No import cycles between `billing/types.ts` and `types.ts`

**Edge Cases**

- Existing `KVUserRecord` entries in KV will not have billing fields. All new fields must be optional (`?`) so `JSON.parse()` of old records does not break.

**Estimated Effort**: S (Small) -- ~2 hours

---

### Task 2: Stripe Signature Verification & Helpers

**Description**

Implement Stripe webhook signature verification using the `v1` HMAC-SHA256 scheme, without importing the full Stripe SDK (which is too large for Cloudflare Workers). Also implement billing helper functions for Stripe API calls.

**Prerequisites/Inputs**

- Task 1 (type definitions)
- Stripe webhook signature docs: `v1` scheme uses `HMAC-SHA256(webhook_secret, timestamp.payload)`
- `STRIPE_WEBHOOK_SECRET` from env

**Implementation Details**

**File: `packages/sync-server/src/billing/stripe-helpers.ts`** (new file)

```typescript
/**
 * Verify Stripe webhook signature (v1 scheme).
 *
 * The Stripe-Signature header format:
 *   t=<timestamp>,v1=<signature>[,v0=<legacy>]
 *
 * Verification:
 *   1. Parse header to extract timestamp and v1 signature
 *   2. Compute expected = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *   3. Compare using timing-safe equality
 *   4. Check timestamp is within tolerance (300 seconds)
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds?: number,
): Promise<{ verified: boolean; eventTimestamp: number }>;

/**
 * Timing-safe comparison of two hex strings.
 * Uses Web Crypto subtle.timingSafeEqual where available,
 * falls back to constant-time byte comparison.
 */
function timingSafeEqual(a: string, b: string): boolean;

/**
 * Call the Stripe API (fetch-based, no SDK).
 *
 * All Stripe API calls use:
 *   - Base URL: https://api.stripe.com/v1
 *   - Auth: Bearer token (STRIPE_SECRET_KEY)
 *   - Content-Type: application/x-www-form-urlencoded (for POST)
 */
export async function stripeRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  secretKey: string,
  params?: Record<string, string>,
): Promise<T>;

/**
 * Map a Stripe price ID to our tier name.
 */
export function priceIdToTier(
  priceId: string,
  env: { STRIPE_PRO_PRICE_ID: string; STRIPE_TEAM_PRICE_ID: string },
): 'pro' | 'team' | null;

/**
 * Check idempotency: has this Stripe event already been processed?
 * Uses KV key `stripe_event:{eventId}` with 24h TTL.
 */
export async function isEventProcessed(
  eventId: string,
  kv: KVNamespace,
): Promise<boolean>;

/**
 * Mark a Stripe event as processed in KV.
 */
export async function markEventProcessed(
  eventId: string,
  kv: KVNamespace,
): Promise<void>;
```

Key implementation details:

- **HMAC-SHA256** via `crypto.subtle.importKey` + `crypto.subtle.sign` (Web Crypto API, available in Workers)
- **Timing-safe comparison**: convert both hex strings to `Uint8Array`, XOR all bytes, check if result is 0. Use `crypto.subtle.verify` if available.
- **Replay protection**: default tolerance is 300 seconds (5 minutes). Reject if `Math.abs(Date.now()/1000 - timestamp) > tolerance`.
- **Stripe API calls**: use native `fetch` with `application/x-www-form-urlencoded` body encoding. No SDK dependency.
- **Idempotency KV key**: `stripe_event:{eventId}` with `expirationTtl: 86400` (24 hours)

**Acceptance Criteria**

- [ ] `verifyStripeSignature` returns `{ verified: true }` for valid signatures
- [ ] `verifyStripeSignature` returns `{ verified: false }` for tampered payloads
- [ ] `verifyStripeSignature` returns `{ verified: false }` for expired timestamps (> 5 min)
- [ ] Timing-safe comparison prevents timing attacks on signature
- [ ] `stripeRequest` correctly encodes form-urlencoded params
- [ ] `stripeRequest` throws on non-2xx responses with error details
- [ ] `priceIdToTier` maps known price IDs; returns null for unknown
- [ ] `isEventProcessed` / `markEventProcessed` round-trip correctly via KV

**Edge Cases**

- Stripe-Signature header with multiple `v1` signatures (Stripe sends multiple during secret rotation): verify against all `v1` values, accept if any match.
- Missing `t=` in header: reject immediately.
- `stripeRequest` with network failure: throw with descriptive error (caller handles retry).
- Empty `rawBody`: reject (Stripe always sends a JSON body).

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 3: Webhook Handler (Routing & Dispatch)

**Description**

Implement the `POST /api/billing/webhook` endpoint in the Worker. This endpoint receives Stripe webhook events, verifies the signature, checks idempotency, and dispatches to the appropriate event processor. No JWT authentication -- Stripe calls this directly.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 2 (signature verification, idempotency helpers)
- Existing `worker.ts` routing pattern

**Implementation Details**

**File: `packages/sync-server/src/billing/webhook-handler.ts`** (new file)

```typescript
/**
 * Handle POST /api/billing/webhook
 *
 * Flow:
 *   1. Read raw body as text (needed for signature verification)
 *   2. Verify Stripe-Signature header
 *   3. Parse JSON body as StripeWebhookEvent
 *   4. Check idempotency (skip if already processed)
 *   5. Dispatch to event-specific processor
 *   6. Mark event as processed
 *   7. Return 200 (Stripe expects 2xx within 10 seconds)
 *
 * IMPORTANT: Always return 200 for recognized events, even if
 * processing fails (log error internally). Returning non-2xx
 * causes Stripe to retry, which could amplify errors.
 * Exception: signature verification failure returns 400.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response>;
```

**File: `packages/sync-server/src/worker.ts`** (modify existing)

Add routing for billing endpoints. The webhook endpoint must be added **before** the `requiresAuth` check since it does not use JWT:

```typescript
// Add to worker.ts:
// --- Stripe webhook (no auth -- Stripe calls this directly) ---
if (url.pathname === '/api/billing/webhook' && request.method === 'POST') {
  return respond(await handleWebhook(request, env));
}

// Add to requiresAuth():
pathname.startsWith('/api/billing/') && pathname !== '/api/billing/webhook'
```

**Acceptance Criteria**

- [ ] `POST /api/billing/webhook` is accessible without JWT
- [ ] Invalid signature returns 400 with `invalid_signature` error
- [ ] Missing `Stripe-Signature` header returns 400
- [ ] Replay attack (timestamp > 5 min old) returns 400
- [ ] Duplicate event ID returns 200 (silently ignored)
- [ ] Valid event returns 200 with `{ received: true }`
- [ ] Unrecognized event types return 200 (don't reject unknown events)
- [ ] Worker routing correctly directs to webhook handler

**Edge Cases**

- Stripe sends test webhook during endpoint configuration: must return 200.
- Webhook body larger than 10MB: existing `checkBodySize` should NOT apply to webhooks (Stripe bodies are small, but the size check runs before routing). Add webhook path to size check exemption or apply size check only to authenticated routes.
- Worker cold start: signature verification must complete within Stripe's 10-second timeout.

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 4: Webhook Event Processors (7 Event Types)

**Description**

Implement individual processors for each of the 7 Stripe webhook events. Each processor reads the event payload, extracts relevant data, and updates the user's KV record with billing state.

**Prerequisites/Inputs**

- Task 1 (types: `StripeCheckoutSession`, `StripeSubscription`, `StripeInvoice`)
- Task 2 (`priceIdToTier`, `stripeRequest` for customer lookup)
- Task 3 (webhook dispatch)
- Task 7 (KV schema with billing fields)

**Implementation Details**

**File: `packages/sync-server/src/billing/event-processors.ts`** (new file)

```typescript
/**
 * Process checkout.session.completed
 *
 * Fired when the user completes Stripe Checkout.
 * Links Stripe customer ID to our user and sets initial tier.
 *
 * Steps:
 *   1. Extract client_reference_id (our userId) from session
 *   2. Extract customer ID and subscription ID
 *   3. Look up subscription to determine tier from price ID
 *   4. Update KV user record: stripeCustomerId, subscriptionId, tier, subscriptionStatus
 */
export async function processCheckoutCompleted(
  session: StripeCheckoutSession,
  env: Env,
): Promise<void>;

/**
 * Process customer.subscription.created
 *
 * Fired when a new subscription is created. May overlap with
 * checkout.session.completed -- idempotency ensures no conflict.
 *
 * Steps:
 *   1. Look up user by stripeCustomerId in KV
 *   2. Map subscription price ID to tier
 *   3. Update KV: tier, subscriptionId, subscriptionStatus, currentPeriodEnd, trialEnd
 */
export async function processSubscriptionCreated(
  subscription: StripeSubscription,
  env: Env,
): Promise<void>;

/**
 * Process customer.subscription.updated
 *
 * Fired on plan change (upgrade/downgrade), payment method update,
 * trial ending, or cancel_at_period_end change.
 *
 * Steps:
 *   1. Look up user by stripeCustomerId
 *   2. Map new price ID to tier (handles upgrade/downgrade)
 *   3. Update KV: tier, subscriptionStatus, currentPeriodEnd,
 *      trialEnd, cancelAtPeriodEnd
 */
export async function processSubscriptionUpdated(
  subscription: StripeSubscription,
  env: Env,
): Promise<void>;

/**
 * Process customer.subscription.deleted
 *
 * Fired when subscription is fully terminated (after period end
 * if cancel_at_period_end was true, or immediately if past_due too long).
 *
 * Steps:
 *   1. Look up user by stripeCustomerId
 *   2. Set tier to "free", clear subscription fields
 *   3. Retain stripeCustomerId (customer still exists in Stripe)
 */
export async function processSubscriptionDeleted(
  subscription: StripeSubscription,
  env: Env,
): Promise<void>;

/**
 * Process customer.subscription.trial_will_end
 *
 * Fired 3 days before trial expires. We flag this for notification
 * systems to pick up (dashboard banner, email via Stripe).
 *
 * Steps:
 *   1. Look up user by stripeCustomerId
 *   2. Set trialEndingSoon flag or store trialEnd date
 *   3. (Notification is handled by dashboard/mobile -- we just store the state)
 */
export async function processTrialWillEnd(
  subscription: StripeSubscription,
  env: Env,
): Promise<void>;

/**
 * Process invoice.payment_succeeded
 *
 * Fired after successful payment. Updates currentPeriodEnd to
 * the new billing period.
 *
 * Steps:
 *   1. Look up user by stripeCustomerId
 *   2. Update KV: subscriptionStatus = "active", currentPeriodEnd
 *   3. Clear any past_due state
 */
export async function processPaymentSucceeded(
  invoice: StripeInvoice,
  env: Env,
): Promise<void>;

/**
 * Process invoice.payment_failed
 *
 * Fired when a payment attempt fails. Sets subscriptionStatus to
 * "past_due", which causes tier enforcement to treat user as free.
 *
 * Steps:
 *   1. Look up user by stripeCustomerId
 *   2. Set subscriptionStatus = "past_due"
 *   3. Do NOT change tier field (subscription still exists in Stripe)
 *   4. Effective tier computation in enforcement will downgrade to free
 */
export async function processPaymentFailed(
  invoice: StripeInvoice,
  env: Env,
): Promise<void>;
```

**Helper for user lookup by Stripe customer ID:**

```typescript
/**
 * Find a KVUserRecord by stripeCustomerId.
 *
 * Since KV is keyed by email, we maintain a reverse index:
 *   stripe_customer:{customerId} -> email
 *
 * This allows O(1) lookup from webhook events.
 */
export async function findUserByStripeCustomer(
  customerId: string,
  kv: KVNamespace,
): Promise<{ email: string; record: KVUserRecord } | null>;

/**
 * Update KV user record with billing fields.
 * Performs read-modify-write on the users:{email} key.
 */
export async function updateUserBilling(
  email: string,
  kv: KVNamespace,
  fields: Partial<BillingFields>,
): Promise<void>;
```

**KV reverse index**: When `checkout.session.completed` fires, write `stripe_customer:{customerId}` -> `email` alongside the user record update. This ensures all subsequent webhook events (which only carry `customerId`) can find the user.

**Acceptance Criteria**

- [ ] `processCheckoutCompleted` stores `stripeCustomerId`, `subscriptionId`, tier on KV user record
- [ ] `processCheckoutCompleted` creates reverse index `stripe_customer:{id}` -> email
- [ ] `processSubscriptionCreated` sets correct tier from price ID
- [ ] `processSubscriptionUpdated` handles upgrade (free->pro, pro->team) and downgrade (team->pro)
- [ ] `processSubscriptionDeleted` reverts tier to `"free"` and clears subscription fields
- [ ] `processTrialWillEnd` stores trial end notification state
- [ ] `processPaymentSucceeded` resets `subscriptionStatus` to `"active"` and updates `currentPeriodEnd`
- [ ] `processPaymentFailed` sets `subscriptionStatus` to `"past_due"` without changing tier
- [ ] Unknown `stripeCustomerId` in webhook is handled gracefully (log warning, return)
- [ ] All processors use `updateUserBilling` to atomically update KV

**Edge Cases**

- `checkout.session.completed` arrives before `customer.subscription.created`: both set the tier, idempotency ensures consistency.
- `customer.subscription.updated` with same tier (e.g., payment method update): no-op for tier, still update other fields.
- User deletes account while subscription is active: `findUserByStripeCustomer` returns null, processor logs warning and returns (Stripe cancellation should be handled in account deletion flow).
- Stripe customer has multiple subscriptions: we only track one `subscriptionId`. If a second subscription is created, the most recent one wins.

**Estimated Effort**: L (Large) -- ~8 hours

---

### Task 5: Checkout Session & Customer Portal Endpoints

**Description**

Implement `POST /api/billing/checkout` and `POST /api/billing/portal` endpoints. Both require JWT authentication and interact with Stripe API to create hosted sessions.

**Prerequisites/Inputs**

- Task 1 (types)
- Task 2 (`stripeRequest` helper)
- Task 7 (KV billing fields for reading `stripeCustomerId`)
- Existing JWT auth in `worker.ts`

**Implementation Details**

**File: `packages/sync-server/src/billing/billing-handlers.ts`** (new file)

```typescript
/**
 * Handle POST /api/billing/checkout
 *
 * Creates a Stripe Checkout session for the requested tier.
 *
 * Flow:
 *   1. Parse request body: { tier: "pro" | "team" }
 *   2. Validate tier (reject invalid values with 400)
 *   3. Check if user already has an active subscription:
 *      - If active/trialing: return 409 with portal URL suggestion
 *   4. Find or create Stripe customer by email
 *   5. Determine if trial is available (first subscription ever)
 *   6. Create Checkout session via Stripe API:
 *      - mode: "subscription"
 *      - price: STRIPE_PRO_PRICE_ID or STRIPE_TEAM_PRICE_ID
 *      - subscription_data.trial_period_days: 14 (if eligible)
 *      - payment_method_collection: "if_required" (for trials)
 *      - customer: stripeCustomerId
 *      - client_reference_id: userId
 *      - success_url: BILLING_APP_URL + "/billing?success=true"
 *      - cancel_url: BILLING_APP_URL + "/billing?cancelled=true"
 *   7. Return { checkoutUrl: session.url }
 */
export async function handleCheckout(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response>;

/**
 * Handle POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session for managing subscription.
 *
 * Flow:
 *   1. Look up stripeCustomerId from KV user record
 *   2. If no stripeCustomerId: return 400 (no subscription to manage)
 *   3. Create portal session via Stripe API:
 *      - customer: stripeCustomerId
 *      - return_url: BILLING_APP_URL + "/billing"
 *   4. Return { portalUrl: session.url }
 */
export async function handlePortal(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response>;

/**
 * Find or create a Stripe customer for the given email.
 * Uses Stripe's customer list API with email filter.
 * If no customer exists, creates one with metadata.user_id.
 */
async function findOrCreateStripeCustomer(
  email: string,
  userId: string,
  secretKey: string,
): Promise<string>; // returns customer ID
```

**Stripe API calls (via fetch, no SDK):**

```
POST /v1/checkout/sessions
  - mode=subscription
  - line_items[0][price]=price_xxx
  - line_items[0][quantity]=1
  - customer=cus_xxx
  - client_reference_id=userId
  - subscription_data[trial_period_days]=14
  - payment_method_collection=if_required
  - success_url=https://app.saqr.dev/billing?success=true
  - cancel_url=https://app.saqr.dev/billing?cancelled=true

POST /v1/billing_portal/sessions
  - customer=cus_xxx
  - return_url=https://app.saqr.dev/billing

GET /v1/customers?email=user@example.com&limit=1

POST /v1/customers
  - email=user@example.com
  - metadata[user_id]=userId
```

**File: `packages/sync-server/src/worker.ts`** (modify existing)

Add routing for authenticated billing endpoints:

```typescript
// After existing authenticated route handling, before DO routing:
if (url.pathname === '/api/billing/checkout' && request.method === 'POST') {
  return respond(await handleCheckout(request, env, authCtx));
}

if (url.pathname === '/api/billing/portal' && request.method === 'POST') {
  return respond(await handlePortal(request, env, authCtx));
}

if (url.pathname === '/api/billing/status' && request.method === 'GET') {
  return respond(await handleBillingStatus(request, env, authCtx));
}
```

**Acceptance Criteria**

- [ ] `POST /api/billing/checkout` with `{ tier: "pro" }` returns `{ checkoutUrl: "https://checkout.stripe.com/..." }`
- [ ] `POST /api/billing/checkout` with `{ tier: "team" }` returns valid Team checkout URL
- [ ] `POST /api/billing/checkout` with invalid tier returns 400
- [ ] `POST /api/billing/checkout` without auth returns 401
- [ ] `POST /api/billing/checkout` for user with active subscription returns 409 with portal suggestion
- [ ] Trial period (14 days) is set for first-time subscribers
- [ ] Trial is NOT set for users with `trialUsed: true`
- [ ] `POST /api/billing/portal` returns `{ portalUrl: "https://billing.stripe.com/..." }`
- [ ] `POST /api/billing/portal` for user without `stripeCustomerId` returns 400
- [ ] `findOrCreateStripeCustomer` reuses existing customer by email

**Edge Cases**

- User has Stripe customer from a previous subscription but no active subscription: allow new checkout (do not redirect to portal).
- Stripe API rate limit (429): `stripeRequest` should throw, handler returns 502 with retry hint.
- Concurrent checkout requests: both create sessions, but only one subscription will be created (Stripe handles this).
- `BILLING_APP_URL` without trailing slash: ensure URL concatenation is correct.

**Estimated Effort**: M (Medium) -- ~5 hours

---

### Task 6: Tier Enforcement Updates (402 Responses & Effective Tier)

**Description**

Update the existing tier enforcement middleware to use "effective tier" logic that accounts for billing status (`past_due` = free) and return 402 Payment Required responses with upgrade URLs when limits are exceeded.

**Prerequisites/Inputs**

- Existing `middleware/tier-enforcement.ts` (`checkStorageQuota`, `checkDeviceLimit`, `checkFeatureAccess`)
- Task 1 (types: `TierLimitError`)
- Task 7 (KV billing fields for `subscriptionStatus`)

**Implementation Details**

**File: `packages/sync-server/src/billing/effective-tier.ts`** (new file)

```typescript
/**
 * Compute the effective tier for enforcement purposes.
 *
 * Rules:
 *   1. If subscriptionStatus is "past_due" or "unpaid" -> effective tier is "free"
 *   2. If subscriptionStatus is "canceled" and currentPeriodEnd is in the future -> keep paid tier (grace)
 *   3. If subscriptionStatus is "canceled" and currentPeriodEnd is in the past -> effective tier is "free"
 *   4. If subscriptionStatus is "trialing" -> use the subscription's tier
 *   5. If subscriptionStatus is "active" -> use the subscription's tier
 *   6. If no subscription -> tier is "free"
 */
export function computeEffectiveTier(
  record: KVUserRecord,
): Tier;

/**
 * Check if a user is in the grace period after cancellation.
 * True if subscription is canceled but currentPeriodEnd is in the future.
 */
export function isInGracePeriod(record: KVUserRecord): boolean;

/**
 * Check if a user is over their free tier limits (post-downgrade).
 * Used to determine read-only access.
 */
export function isOverFreeLimit(
  record: KVUserRecord,
  currentMachines: number,
  currentStorageBytes: number,
  env: Env,
): boolean;
```

**File: `packages/sync-server/src/middleware/tier-enforcement.ts`** (modify existing)

Update `checkStorageQuota` and `checkDeviceLimit` to:

1. Accept optional `billingRecord` parameter for effective tier computation
2. Return **402** instead of 413/403 when the violation is due to tier limits (not raw protocol errors)
3. Include `upgradeUrl` in the response body

```typescript
// Updated checkDeviceLimit signature:
export function checkDeviceLimit(
  currentMachineCount: number,
  tier: Tier,
  env: Env,
  options?: { upgradeUrl?: string },
): Response | null {
  const limits = getTierLimits(tier, env);
  const machineLimit = limits.machineLimit;

  if (machineLimit <= 0) return null;

  if (currentMachineCount >= machineLimit) {
    return errorResponse(
      402,  // Changed from 403
      'tier_limit_exceeded',
      `Your plan allows ${machineLimit} machines. Upgrade for more.`,
      {
        limit: 'machines',
        current: currentMachineCount,
        max: machineLimit,
        tier,
        upgradeUrl: options?.upgradeUrl ?? 'https://app.saqr.dev/billing/upgrade',
      },
    );
  }

  return null;
}
```

Similarly update `checkStorageQuota` to return 402 with upgrade info.

**File: `packages/sync-server/src/worker.ts`** (modify existing)

Update the auth flow to compute effective tier:

```typescript
// After JWT verification:
const userRecord = await env.AUTH_KV.get<KVUserRecord>(`users:${authCtx.email}`, 'json');
if (userRecord) {
  authCtx.tier = computeEffectiveTier(userRecord);
}
```

**Acceptance Criteria**

- [ ] `computeEffectiveTier` returns `"free"` when `subscriptionStatus === "past_due"`
- [ ] `computeEffectiveTier` returns paid tier when `subscriptionStatus === "active"`
- [ ] `computeEffectiveTier` returns paid tier when `subscriptionStatus === "trialing"`
- [ ] `computeEffectiveTier` returns paid tier during grace period (canceled + future `currentPeriodEnd`)
- [ ] `computeEffectiveTier` returns `"free"` after grace period ends
- [ ] `checkDeviceLimit` returns 402 (not 403) with `upgradeUrl`
- [ ] `checkStorageQuota` returns 402 (not 413) with `upgradeUrl`
- [ ] Response body matches `TierLimitError` shape
- [ ] `isInGracePeriod` returns true during grace, false after
- [ ] Worker computes effective tier from KV before routing to DO

**Edge Cases**

- `currentPeriodEnd` is exactly now: treat as expired (use `<` not `<=`).
- `KVUserRecord` with no billing fields (pre-Story 21 user): `computeEffectiveTier` returns the stored `tier` field as-is (backward compatible).
- Clock skew between Worker and Stripe: use 1-minute buffer on period end comparison.

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 7: KV Schema Updates (Billing Fields)

**Description**

Define the KV storage patterns for billing data, including the user record extensions, the Stripe customer reverse index, and the webhook event idempotency store.

**Prerequisites/Inputs**

- Task 1 (types)
- Existing KV key patterns: `users:{email}` for user records

**Implementation Details**

**KV Key Patterns (new):**

| Key Pattern | Value | TTL | Purpose |
|---|---|---|---|
| `users:{email}` | `KVUserRecord` (extended) | None | User record with billing fields |
| `stripe_customer:{customerId}` | `email` (plain string) | None | Reverse index: Stripe customer -> email |
| `stripe_event:{eventId}` | `"1"` | 86400 (24h) | Webhook idempotency deduplication |

**File: `packages/sync-server/src/billing/kv-billing.ts`** (new file)

```typescript
/**
 * KV operations for billing data.
 */

/** KV key for Stripe customer reverse index */
export function stripeCustomerKey(customerId: string): string {
  return `stripe_customer:${customerId}`;
}

/** KV key for webhook event idempotency */
export function stripeEventKey(eventId: string): string {
  return `stripe_event:${eventId}`;
}

/** KV key for user record */
export function userKey(email: string): string {
  return `users:${email}`;
}

/**
 * Read user record from KV.
 * Returns null if not found.
 */
export async function getUserRecord(
  email: string,
  kv: KVNamespace,
): Promise<KVUserRecord | null>;

/**
 * Update billing fields on a user record.
 * Read-modify-write pattern (KV is eventually consistent).
 */
export async function updateBillingFields(
  email: string,
  kv: KVNamespace,
  fields: Partial<BillingFields>,
): Promise<void>;

/**
 * Create the Stripe customer reverse index.
 */
export async function setStripeCustomerIndex(
  customerId: string,
  email: string,
  kv: KVNamespace,
): Promise<void>;

/**
 * Look up email by Stripe customer ID.
 */
export async function getEmailByStripeCustomer(
  customerId: string,
  kv: KVNamespace,
): Promise<string | null>;
```

**Migration strategy**: No migration needed. All new billing fields on `KVUserRecord` are optional (`?`). Existing records will have `undefined` for these fields, which `computeEffectiveTier` handles by falling back to the existing `tier` field.

**Acceptance Criteria**

- [ ] `getUserRecord` correctly parses KV JSON for both old and new record formats
- [ ] `updateBillingFields` performs atomic read-modify-write
- [ ] `setStripeCustomerIndex` creates `stripe_customer:{id}` -> email mapping
- [ ] `getEmailByStripeCustomer` returns email for known customer, null for unknown
- [ ] Idempotency keys use 24h TTL (`expirationTtl: 86400`)
- [ ] Old `KVUserRecord` entries without billing fields are handled without errors

**Edge Cases**

- Race condition on `updateBillingFields`: two concurrent webhooks for the same user. KV's last-writer-wins semantics mean one update could be lost. Mitigate by having each processor write only its specific fields and not overwrite unrelated fields.
- `stripe_customer:{id}` orphaned after account deletion: acceptable -- the key is small and has no TTL. Could add cleanup to account deletion flow.
- KV eventual consistency: a checkout completion followed by immediate billing status query might return stale data. Accept this as a known limitation; clients can retry after a short delay.

**Estimated Effort**: S (Small) -- ~3 hours

---

### Task 8: Billing Status API

**Description**

Implement `GET /api/billing/status` to return the user's current billing state, including tier, subscription status, period dates, and resource usage. This is the primary API for dashboard and mobile billing UI.

**Prerequisites/Inputs**

- Task 1 (types: `BillingStatusResponse`)
- Task 6 (`computeEffectiveTier`)
- Task 7 (KV billing read helpers)
- Existing DO for usage data (machine count, storage used)

**Implementation Details**

**File: `packages/sync-server/src/billing/billing-handlers.ts`** (add to existing file from Task 5)

```typescript
/**
 * Handle GET /api/billing/status
 *
 * Returns comprehensive billing status including:
 *   - Current effective tier
 *   - Stripe subscription metadata
 *   - Resource usage vs limits
 *
 * Flow:
 *   1. Read KV user record for billing fields
 *   2. Compute effective tier
 *   3. Get current usage from Durable Object:
 *      - Machine count (from DO machine registry)
 *      - Storage used bytes (from DO account row)
 *   4. Get tier limits for current effective tier
 *   5. Return BillingStatusResponse
 */
export async function handleBillingStatus(
  request: Request,
  env: Env,
  authCtx: AuthContext,
): Promise<Response>;
```

**Usage data retrieval**: The handler needs machine count and storage bytes from the DO. Two approaches:

1. **Forward a status request to the DO** (preferred): Route an internal `GET /api/account` request to the DO, which already returns `storage_used_bytes`. Add machine count to the account response if not already present.
2. **Read from KV cache**: If we cached usage in KV during push/pull operations (not currently done).

We use approach 1, forwarding to the DO via `routeToDO` with a special internal path or reusing the existing `/api/account` endpoint response.

**Response format:**

```json
{
  "tier": "pro",
  "stripeCustomerId": "cus_abc123",
  "subscriptionStatus": "active",
  "currentPeriodEnd": "2026-04-01T00:00:00Z",
  "trialEnd": null,
  "cancelAtPeriodEnd": false,
  "usage": {
    "machines": { "used": 2, "limit": 5 },
    "storage": { "used": 120000000, "limit": 524288000 },
    "syncFrequency": { "current": 45, "limit": 600 }
  }
}
```

**Acceptance Criteria**

- [ ] Free user: returns `tier: "free"`, null Stripe fields, correct free tier limits
- [ ] Pro user: returns `tier: "pro"`, Stripe customer ID, active status, period end
- [ ] Trial user: returns `subscriptionStatus: "trialing"`, `trialEnd` set
- [ ] Past-due user: returns `tier: "free"` (effective), `subscriptionStatus: "past_due"`
- [ ] Usage numbers reflect real machine count and storage from DO
- [ ] Limit of 0 (unlimited) is correctly represented
- [ ] `cancelAtPeriodEnd: true` is reflected when subscription will cancel
- [ ] 401 returned for unauthenticated requests

**Edge Cases**

- New user who never interacted with billing: all billing fields null, tier is "free".
- DO is unavailable (rare): return billing status from KV without usage numbers, or return 503.
- User has deleted account but JWT is still valid: KV record will be missing, return 404.

**Estimated Effort**: M (Medium) -- ~3 hours

---

### Task 9: Grace Period & Downgrade Logic

**Description**

Implement the grace period behavior when a subscription is canceled or payment fails. Users retain their paid tier until `currentPeriodEnd`. After that, enforcement reverts to free tier. Over-limit users get read-only access (writes blocked, reads allowed).

**Prerequisites/Inputs**

- Task 4 (event processors set `cancelAtPeriodEnd`, `currentPeriodEnd`)
- Task 6 (`computeEffectiveTier`, `isInGracePeriod`, `isOverFreeLimit`)
- Existing tier enforcement middleware

**Implementation Details**

**Grace period flow:**

```
1. User cancels subscription (via Stripe Portal)
   -> Stripe fires customer.subscription.updated with cancel_at_period_end: true
   -> Processor updates KV: cancelAtPeriodEnd = true
   -> User continues with paid tier until currentPeriodEnd

2. Period ends
   -> Stripe fires customer.subscription.deleted
   -> Processor sets tier = "free", clears subscription fields
   -> computeEffectiveTier now returns "free"

3. User exceeds free tier limits (e.g., has 5 machines but free allows 2)
   -> Write operations (push, register machine) return 402
   -> Read operations (pull, list machines, account info) still work
   -> Response includes message about downgrade
```

**File: `packages/sync-server/src/billing/effective-tier.ts`** (extend from Task 6)

```typescript
/**
 * Determine write access for a user.
 *
 * Rules:
 *   - Active/trialing subscription: full write access
 *   - Grace period (canceled, period not ended): full write access
 *   - Past-due: write access blocked (read-only)
 *   - Free tier over limit: write access blocked (read-only)
 *   - Free tier under limit: full write access
 */
export function canWrite(
  record: KVUserRecord,
  currentMachines: number,
  currentStorageBytes: number,
  env: Env,
): { allowed: boolean; reason?: string };
```

**File: `packages/sync-server/src/middleware/tier-enforcement.ts`** (modify)

Add a `checkWriteAccess` function that wraps `canWrite`:

```typescript
/**
 * Check if user has write access based on billing status.
 * Returns 402 with downgrade message if writes are blocked.
 */
export function checkWriteAccess(
  record: KVUserRecord,
  currentMachines: number,
  currentStorageBytes: number,
  env: Env,
): Response | null;
```

**30-day data retention**: When a subscription is deleted, existing data in R2 is NOT immediately purged. The retention logic in the DO already respects `retentionDays` from tier limits. After downgrade to free, the free tier retention (30 days) applies going forward. Data older than 30 days will be purged by the existing retention sweep.

**Acceptance Criteria**

- [ ] Canceled subscription with future `currentPeriodEnd` allows full read/write access
- [ ] Canceled subscription with past `currentPeriodEnd` enforces free tier limits
- [ ] Past-due subscription blocks writes, allows reads
- [ ] Over-limit free user (e.g., 5 machines on free tier) blocks new machine registration
- [ ] Over-limit free user can still pull events and list machines
- [ ] 402 response includes descriptive message about downgrade
- [ ] R2 data is not immediately deleted on downgrade (30-day retention)
- [ ] `canWrite` returns `{ allowed: true }` for users within their tier limits

**Edge Cases**

- User has exactly the free tier limit of machines (2) after downgrade: they are at the limit, not over it. New registrations are blocked, but existing machines work.
- User upgrades during grace period: `processSubscriptionCreated` fires, restoring the paid tier. Grace period logic becomes irrelevant.
- Clock skew: `currentPeriodEnd` from Stripe is authoritative. If Worker clock is slightly behind, user gets a few extra seconds of grace.

**Estimated Effort**: M (Medium) -- ~4 hours

---

### Task 10: Tests (25+ Unit Tests)

**Description**

Write comprehensive unit tests covering all billing functionality. Tests use vitest with mocked KV, mocked Stripe API responses, and mocked Worker `Env`. No actual Stripe API calls.

**Prerequisites/Inputs**

- All tasks 1-9 implemented
- Existing test infrastructure (`__tests__/helpers/mock-env.ts`)
- vitest configuration

**Implementation Details**

**Test file structure:**

```
packages/sync-server/src/__tests__/
  billing/
    stripe-helpers.test.ts     (signature verification, Stripe API helpers)
    webhook-handler.test.ts    (webhook routing, dispatch)
    event-processors.test.ts   (7 event type processors)
    billing-handlers.test.ts   (checkout, portal, status endpoints)
    effective-tier.test.ts     (tier computation, grace period)
    kv-billing.test.ts         (KV operations)
```

**Test categories and cases:**

**Checkout tests (5):**

| ID | Test | Assertion |
|---|---|---|
| TC21.1 | Create checkout for Pro tier | Returns 200 with `checkoutUrl` starting with `https://` |
| TC21.2 | Create checkout for Team tier | Returns 200 with different price ID in Stripe call |
| TC21.3 | Unauthenticated checkout request | Returns 401 |
| TC21.4 | Invalid tier in request body | Returns 400 with validation error |
| TC21.5 | User with active subscription | Returns 409 with portal suggestion |

**Webhook tests (7):**

| ID | Test | Assertion |
|---|---|---|
| TC21.6 | `checkout.session.completed` | KV user record has `stripeCustomerId`, correct tier |
| TC21.7 | `customer.subscription.updated` (upgrade) | KV tier updated to new tier |
| TC21.8 | `customer.subscription.deleted` | KV tier reverted to `"free"` |
| TC21.9 | `invoice.payment_failed` | KV `subscriptionStatus` set to `"past_due"` |
| TC21.10 | Invalid Stripe-Signature header | Returns 400 |
| TC21.11 | Replay attack (timestamp > 5 min old) | Returns 400 |
| TC21.12 | Duplicate event ID | Returns 200 (no KV mutation) |

**Tier enforcement tests (5):**

| ID | Test | Assertion |
|---|---|---|
| TC21.13 | Free user at machine limit | Returns 402 with `upgradeUrl` |
| TC21.14 | Pro user under machine limit | Returns null (allowed) |
| TC21.15 | Past-due subscription | `computeEffectiveTier` returns `"free"` |
| TC21.16 | Active trial | `computeEffectiveTier` returns paid tier |
| TC21.17 | Canceled with future period end | `computeEffectiveTier` returns paid tier |

**Billing status tests (4):**

| ID | Test | Assertion |
|---|---|---|
| TC21.18 | Free user billing status | Returns correct limits, null Stripe fields |
| TC21.19 | Pro user billing status | Returns correct limits, period end, customer ID |
| TC21.20 | Trial user billing status | Returns `trialEnd` date, `subscriptionStatus: "trialing"` |
| TC21.21 | Usage numbers | Machine count and storage reflect actual values |

**Customer portal tests (2):**

| ID | Test | Assertion |
|---|---|---|
| TC21.22 | Portal session creation | Returns 200 with `portalUrl` |
| TC21.23 | User without Stripe customer | Returns 400 |

**Downgrade grace tests (3):**

| ID | Test | Assertion |
|---|---|---|
| TC21.24 | Canceled subscription in grace period | Full access (writes allowed) |
| TC21.25 | Canceled subscription after period end | Effective tier is `"free"` |
| TC21.26 | Over-limit user after downgrade | Writes blocked (402), reads allowed |

**Signature verification tests (2+):**

| ID | Test | Assertion |
|---|---|---|
| TC21.27 | Valid signature verification | `verified: true` |
| TC21.28 | Tampered payload | `verified: false` |

**Mocking strategy:**

```typescript
// Mock KV namespace
function createMockKV(initialData?: Record<string, string>): KVNamespace;

// Mock Stripe API responses
function mockStripeCheckoutSession(overrides?: Partial<StripeCheckoutSession>): StripeCheckoutSession;
function mockStripeSubscription(overrides?: Partial<StripeSubscription>): StripeSubscription;
function mockStripeInvoice(overrides?: Partial<StripeInvoice>): StripeInvoice;

// Mock fetch for Stripe API calls
function mockStripeFetch(responses: Map<string, Response>): void;

// Mock Env with Stripe secrets
function createMockEnvWithBilling(overrides?: Partial<Env>): Env;
```

**Acceptance Criteria**

- [ ] 28+ tests pass (`vitest run`)
- [ ] All 26 test cases from the story are covered (TC21.1 through TC21.26)
- [ ] Additional tests for signature verification edge cases
- [ ] No real Stripe API calls (all mocked)
- [ ] Tests use existing `mock-env.ts` pattern, extended for billing
- [ ] Each test file is independently runnable
- [ ] Test descriptions clearly map to TC IDs from the story

**Edge Cases Tested**

- Webhook with unknown event type: returns 200, no processing
- Empty checkout request body: returns 400
- KV read returns null (user not found): graceful handling
- Stripe API returns 429: handler returns 502
- Multiple `v1` signatures in header (secret rotation): verify against all

**Estimated Effort**: L (Large) -- ~8 hours

---

## File Summary

### New Files

| File | Task | Purpose |
|---|---|---|
| `src/billing/types.ts` | 1 | Stripe-specific type definitions |
| `src/billing/stripe-helpers.ts` | 2 | Signature verification, Stripe API client, helpers |
| `src/billing/webhook-handler.ts` | 3 | Webhook endpoint handler |
| `src/billing/event-processors.ts` | 4 | 7 webhook event processors |
| `src/billing/billing-handlers.ts` | 5, 8 | Checkout, portal, and billing status handlers |
| `src/billing/effective-tier.ts` | 6, 9 | Effective tier computation, grace period logic |
| `src/billing/kv-billing.ts` | 7 | KV operations for billing data |
| `src/__tests__/billing/stripe-helpers.test.ts` | 10 | Signature verification tests |
| `src/__tests__/billing/webhook-handler.test.ts` | 10 | Webhook handler tests |
| `src/__tests__/billing/event-processors.test.ts` | 10 | Event processor tests |
| `src/__tests__/billing/billing-handlers.test.ts` | 10 | Checkout/portal/status tests |
| `src/__tests__/billing/effective-tier.test.ts` | 10 | Tier computation tests |
| `src/__tests__/billing/kv-billing.test.ts` | 10 | KV billing operation tests |

### Modified Files

| File | Task | Changes |
|---|---|---|
| `src/types.ts` | 1 | Add Stripe bindings to `Env`, billing fields to `KVUserRecord` |
| `src/worker.ts` | 3, 5 | Add billing route handlers, webhook exempt from auth |
| `src/middleware/tier-enforcement.ts` | 6 | 402 responses with `upgradeUrl`, optional billing-aware params |
| `wrangler.toml` | 1 | Document Stripe secret bindings (actual values via `wrangler secret`) |

---

## Environment Configuration

### Secrets (via `wrangler secret put`)

```bash
wrangler secret put STRIPE_SECRET_KEY        # sk_live_... or sk_test_...
wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_...
```

### Vars (in `wrangler.toml` `[vars]`)

```toml
STRIPE_PRO_PRICE_ID = "price_xxx"    # From Stripe Dashboard
STRIPE_TEAM_PRICE_ID = "price_yyy"   # From Stripe Dashboard
BILLING_APP_URL = "https://app.saqr.dev"
```

### Stripe Dashboard Configuration

1. Create Product "Saqr Pro" with monthly price $5
2. Create Product "Saqr Team" with monthly price $15
3. Configure Customer Portal (subscription management, cancellation)
4. Add webhook endpoint: `https://sync.saqr.dev/api/billing/webhook`
5. Subscribe to events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.payment_succeeded`, `invoice.payment_failed`

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| Stripe SDK too large for Workers | Use native `fetch` with Stripe REST API directly. No SDK dependency. |
| Webhook event ordering | Each processor is idempotent and uses KV read-modify-write. Out-of-order events converge to correct state. |
| KV eventual consistency | Billing status may lag a few seconds after webhook processing. Clients poll or retry. |
| Worker cold start vs Stripe 10s timeout | Signature verification uses Web Crypto (fast). KV reads are < 50ms. Total should be well under 10s. |
| User circumvents billing via stale JWT | Worker re-reads KV on each request to compute effective tier. JWT tier is overridden. |
| Trial abuse (create new account for new trial) | `trialUsed` flag on KV record. Could also tie to Stripe customer email for cross-account detection (future). |
