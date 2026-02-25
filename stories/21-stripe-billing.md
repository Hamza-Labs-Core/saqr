# Story 21: Stripe Billing Integration

## Overview

The PRD defines three tiers (Free, Pro $5/mo, Team $15/mo) with different storage quotas, machine limits, sync frequency, and retention periods. Story 11 enforces tier limits server-side but has no payment processing. Users are stuck on the free tier.

This story integrates Stripe for subscription management. It adds a Stripe webhook handler to the sync server, Checkout session creation, customer portal access, and tier-gated API responses. The web app (Story 19) and mobile app (Story 16) consume these APIs to show billing UI.

**Architecture**: The sync server (Cloudflare Worker) creates Stripe Checkout sessions and handles webhooks. No payment card data touches our server — Stripe hosts the checkout page and customer portal. The Worker only stores Stripe customer ID and current tier in KV.

**Guiding principle**: We never handle card numbers. Stripe Checkout + Customer Portal handle all sensitive payment UI. Our server only reacts to webhook events to update tier status.

---

## Scope

### In Scope

- Stripe Checkout session creation (server-side)
- Stripe Customer Portal session creation (manage subscription)
- Stripe webhook handler (subscription lifecycle events)
- Tier sync: webhook updates KV user record with current tier
- 402 Payment Required responses when tier limits exceeded
- Trial period: 14-day free trial on Pro/Team (no card required)
- Graceful downgrade: notify user when exceeding free tier limits after cancellation
- Proration on tier change (upgrade mid-cycle)
- Cancellation: subscription ends at period end (not immediate)
- Invoice + receipt emails (handled by Stripe — no custom email needed)

### Out of Scope

- Payment form UI (Stripe Checkout handles this)
- Card management UI (Stripe Customer Portal handles this)
- Invoicing/receipts (Stripe handles this)
- EU VAT reverse charge (configure in Stripe Dashboard)
- Refunds (handle manually in Stripe Dashboard)
- Custom pricing / enterprise tier (future)
- Mobile in-app purchase (App Store / Play Store — separate story)

---

## Requirements

### 1. Stripe Products Setup

#### Products (configured in Stripe Dashboard)
| Product | Price ID (env var) | Amount | Billing |
|---------|-------------------|--------|---------|
| Saqr Pro | `STRIPE_PRO_PRICE_ID` | $5/month | Monthly recurring |
| Saqr Team | `STRIPE_TEAM_PRICE_ID` | $15/month | Monthly recurring |

#### Free Tier
- No Stripe subscription needed
- Default tier for all new accounts
- 14-day trial on Pro available (Stripe trial period)

### 2. API Endpoints

#### Create Checkout Session
```
POST /api/billing/checkout
  Auth: JWT required
  Body: { tier: "pro" | "team" }
  Response: 200 { checkoutUrl: "https://checkout.stripe.com/..." }

  Server:
  1. Find or create Stripe customer (by email)
  2. Create Checkout session with:
     - mode: "subscription"
     - price: STRIPE_PRO_PRICE_ID or STRIPE_TEAM_PRICE_ID
     - trial_period_days: 14 (if first subscription)
     - customer_email: user's email
     - client_reference_id: user's ID
     - success_url: "https://app.saqr.dev/billing?success=true"
     - cancel_url: "https://app.saqr.dev/billing?cancelled=true"
  3. Return Checkout URL for redirect
```

#### Create Customer Portal Session
```
POST /api/billing/portal
  Auth: JWT required
  Response: 200 { portalUrl: "https://billing.stripe.com/..." }

  Server:
  1. Look up Stripe customer ID from KV
  2. Create portal session with return_url
  3. Return portal URL for redirect
```

#### Get Billing Status
```
GET /api/billing/status
  Auth: JWT required
  Response: 200 {
    tier: "free" | "pro" | "team",
    stripeCustomerId: "cus_...",
    subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | null,
    currentPeriodEnd: "2026-04-01T00:00:00Z",
    trialEnd: "2026-03-11T00:00:00Z" | null,
    cancelAtPeriodEnd: boolean,
    usage: {
      machines: { used: 2, limit: 5 },
      storage: { used: 120_000_000, limit: 1_073_741_824 },
      syncFrequency: { used: 45, limit: null }
    }
  }
```

### 3. Webhook Handler

```
POST /api/billing/webhook
  Auth: Stripe signature verification (STRIPE_WEBHOOK_SECRET)
  No JWT required (Stripe calls this directly)
```

#### Events Handled

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Link Stripe customer to user, set tier |
| `customer.subscription.created` | Set tier to subscription's product |
| `customer.subscription.updated` | Update tier (upgrade/downgrade) |
| `customer.subscription.deleted` | Revert to free tier |
| `customer.subscription.trial_will_end` | (3 days before) — flag for notification |
| `invoice.payment_succeeded` | Update `currentPeriodEnd` |
| `invoice.payment_failed` | Set `subscriptionStatus: "past_due"` |

#### Webhook Verification
- Verify `Stripe-Signature` header using `STRIPE_WEBHOOK_SECRET`
- Replay protection: check event timestamp (reject if > 5 min old)
- Idempotency: store processed event IDs in KV with TTL (deduplicate)

### 4. Tier Enforcement Updates

Enhance existing tier enforcement in sync-server:

```typescript
// Before (Story 11): static tier from KV
const tier = userRecord.tier; // "free" | "pro" | "team"

// After (Story 21): live tier from subscription status
const billing = await getBillingStatus(userId);
const effectiveTier = billing.subscriptionStatus === "past_due"
  ? "free"  // Downgrade on payment failure
  : billing.tier;
```

#### 402 Responses
When a user exceeds their tier limit, return:
```json
{
  "error": "tier_limit_exceeded",
  "message": "Your plan allows 2 machines. Upgrade to Pro for up to 5.",
  "limit": "machines",
  "current": 2,
  "max": 2,
  "upgradeUrl": "https://app.saqr.dev/billing/upgrade"
}
```

### 5. KV Schema Updates

```
users:{email} → {
  userId: string,
  tier: "free" | "pro" | "team",
  stripeCustomerId: string | null,
  subscriptionId: string | null,
  subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | null,
  currentPeriodEnd: string | null,
  trialEnd: string | null,
  cancelAtPeriodEnd: boolean,
  ...existing fields
}
```

### 6. Grace Period on Downgrade

When subscription is canceled or payment fails:
1. User keeps current tier until `currentPeriodEnd`
2. After period ends: revert to free tier
3. If user exceeds free tier limits: allow read-only access, block writes
4. Send email: "Your plan has been downgraded. You have X machines over the limit."
5. 30-day data retention grace: don't delete R2 blobs immediately

---

## Test Cases

### Checkout
- TC21.1: Create checkout session returns valid Stripe URL for Pro
- TC21.2: Create checkout session returns valid Stripe URL for Team
- TC21.3: Unauthenticated request returns 401
- TC21.4: Invalid tier returns 400
- TC21.5: Existing subscriber redirected to portal instead of checkout

### Webhooks
- TC21.6: `checkout.session.completed` links customer and sets tier
- TC21.7: `customer.subscription.updated` updates tier on upgrade
- TC21.8: `customer.subscription.deleted` reverts to free tier
- TC21.9: `invoice.payment_failed` sets status to past_due
- TC21.10: Invalid signature returns 400
- TC21.11: Replay attack (old timestamp) returns 400
- TC21.12: Duplicate event ID is ignored (idempotent)

### Tier Enforcement
- TC21.13: Free user hitting machine limit gets 402 with upgrade URL
- TC21.14: Pro user with 5 machines can add a 5th
- TC21.15: Past-due subscription treated as free tier
- TC21.16: Active trial treated as paid tier
- TC21.17: Canceled subscription with future period end still works

### Billing Status
- TC21.18: Free user shows correct limits
- TC21.19: Pro user shows correct limits and period end
- TC21.20: Trial user shows trial end date
- TC21.21: Usage numbers reflect actual resource consumption

### Customer Portal
- TC21.22: Portal session creation returns valid Stripe URL
- TC21.23: User without subscription gets error

### Downgrade Grace
- TC21.24: Canceled subscription works until period end
- TC21.25: After period end, user reverts to free tier
- TC21.26: Over-limit user gets read-only access

---

## Dependencies

- Story 11 (Sync Server): existing KV schema and tier enforcement
- Story 20 (Auth): JWT authentication
- Stripe account + API keys (secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
- Stripe products/prices created in Dashboard

## Secrets Required

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` | Server-side Stripe API calls |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PRO_PRICE_ID` | Pro tier price lookup |
| `STRIPE_TEAM_PRICE_ID` | Team tier price lookup |

## Acceptance Criteria

- [ ] User can upgrade from Free to Pro/Team via Stripe Checkout
- [ ] Webhook correctly updates tier on subscription changes
- [ ] Payment failure downgrades to free tier behavior
- [ ] 14-day free trial with no card required
- [ ] 402 responses with upgrade URL when tier limits exceeded
- [ ] Webhook signature verification prevents spoofing
- [ ] Idempotent webhook processing (no duplicate actions)
- [ ] Customer portal accessible for subscription management
- [ ] 25+ unit tests passing
