# Platform Evaluation: Sync Server Infrastructure

> Evaluates Cloudflare Workers/DO/R2 vs alternatives for the AgentContext encrypted sync server.
> Includes Workers for Platforms analysis, cost modeling at scale, limits, and architectural recommendations.

---

## Executive Summary

**Recommendation: Cloudflare Workers + Durable Objects (SQLite) — skip R2 and Workers for Platforms.**

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Compute | Workers (standard) | WfP is for per-customer custom code, not data isolation |
| Per-user isolation | One DO per user | Natural fit, negligible cost, built-in SQLite |
| Primary storage | DO SQLite | 10GB/user, relational queries, eliminates R2 Class A costs |
| Blob overflow | R2 (optional) | Only for exports/backups exceeding 2MB row limit |
| Encryption | XChaCha20-Poly1305 (libsodium) | 192-bit nonce safety, NaCl compatibility with Paseo relay |
| KDF | Argon2id (libsodium crypto_pwhash) | Memory-hard, already bundled with libsodium WASM |

**Cost at scale (DO-only, no R2):**

| Users | Monthly Cost |
|-------|-------------|
| 100 | ~$5 (base plan only) |
| 1,000 | ~$8 |
| 10,000 | ~$35 |
| 100,000 | ~$349 |

---

## 1. Workers for Platforms — Not Needed

### What WfP Is
Workers for Platforms (WfP) provides **dispatch namespaces** — each customer gets their own Worker script that runs in isolation. Designed for platforms where customers upload custom code (e.g., Shopify Functions, Supabase Edge Functions).

### Why It Doesn't Fit Our Use Case
We need per-user **data** isolation, not per-user **code** isolation. All users run the same sync logic. The isolation boundary is the Durable Object (one DO per user with its own SQLite database).

| Concern | WfP | Regular Workers + DO |
|---------|-----|---------------------|
| Data isolation | Per-script, overkill | Per-DO, natural fit |
| Base cost | $25/mo | $5/mo |
| Per-script cost | $0.02/script (adds up) | N/A |
| CPU limit | 30s (reduced) | 5min (standard) |
| Complexity | Dispatch namespace routing | Simple `idFromName()` routing |
| Maintenance | Manage N script deployments | Single Worker deployment |

**At 100K users, WfP adds ~$2,000/mo in script fees alone.** Regular Workers + per-user DOs achieves identical isolation at $5/mo base.

### WfP — When You Would Need It
Only if AgentContext becomes a platform where users deploy custom sync logic or plugins. Not in current roadmap.

---

## 2. Cloudflare Architecture

### 2.1 Per-User Durable Objects

Each user gets a single DO instance with built-in SQLite. Routing:

```javascript
const id = env.USER_SYNC.idFromName(userId);
const stub = env.USER_SYNC.get(id);
return stub.fetch(request);
```

**Throughput per DO:** 500-1,000 req/sec (more than enough for individual user sync).

**Hibernation:** WebSocket Hibernation API means idle connections cost zero. DO sleeps between messages, wakes automatically. For a sync service where users are active sporadically, this eliminates duration billing for 95%+ of time.

**Lifecycle:**
- Evicted after 70-140s of inactivity
- Cold start: 100-300ms
- No shutdown hooks — write state incrementally
- Alarm API for scheduled work (one alarm per DO, at-least-once delivery)

### 2.2 DO Storage Limits

| Limit | Free | Paid |
|-------|------|------|
| Per-DO storage | 5GB (account total) | **10GB per DO** |
| Per-account storage | 5GB total | Unlimited |
| Max row/value size | 2MB | 2MB |
| Max columns/table | 100 | 100 |

**10GB per user on paid plan is generous.** A typical Claude Code session generates ~50KB of events. At 100 sessions/week, that's ~5MB/week or ~260MB/year. Users won't hit 10GB for years.

### 2.3 R2 — Optional, Not Primary

R2's zero-egress pricing is attractive, but **Class A operations (writes) at $4.50/M dominate costs** when every event write hits R2.

| Scenario (100K users) | DO-only | DO + R2 |
|----------------------|---------|---------|
| Storage cost | ~$50/mo | ~$50 + $150 = $200/mo |
| Write operations | Included in DO | $4.50/M = ~$680/mo |
| **Total** | **~$349/mo** | **~$1,038/mo** |

**Use R2 only for:**
- Data exports (user downloads full history as encrypted archive)
- Overflow blobs exceeding DO's 2MB row limit
- Cold storage / archival (with lifecycle policies for auto-deletion)

### 2.4 R2 Per-User Isolation

Single bucket with key prefixes (not per-user buckets):

```
/users/{user-id}/exports/{timestamp}.enc
/users/{user-id}/overflow/{blob-id}.enc
```

Lifecycle rules (up to 1,000 per bucket) can target prefixes:
- Free tier: delete after 90 days
- Paid tier: delete after 365 days

### 2.5 Workers KV

For lightweight, eventually-consistent data:
- JWKS caching (auth provider public keys)
- Session token → user ID mapping
- Feature flags per tier
- Token revocation lists

Stale reads up to 60s globally — acceptable for auth metadata.

---

## 3. Platform Comparison

### 3.1 Cost Matrix

Assumptions per user: 50 syncs/day, 20MB DO storage, 100MB total data, WebSocket connected 8hr/day (hibernated).

| Platform | 100 users | 1K users | 10K users | 100K users |
|----------|-----------|----------|-----------|------------|
| **CF DO-only** | **$5** | **$8** | **$35** | **$349** |
| CF DO + R2 | $5 | $12 | $89 | $1,038 |
| CF WfP + DO + R2 | $25 | $45 | $289 | $3,038 |
| AWS (Lambda + DynamoDB + S3) | $10 | $25 | $280 | $1,697 |
| Fly.io (Machines + LiteFS) | $12 | $28 | $95 | $345 |
| Supabase (Postgres + Edge) | $25 | $45 | $190 | $570 |
| Self-hosted VPS | $8 | $15 | $35 | $63 |

### 3.2 Platform Pros/Cons

#### Cloudflare Workers + DO (Recommended)

**Pros:**
- Lowest cost at all scales (DO-only path)
- Zero-egress pricing
- Built-in WebSocket hibernation (zero idle cost)
- Jurisdictional restrictions for EU compliance (`jurisdiction("eu")`)
- Single deployment, global edge distribution
- SQLite per DO — relational queries, indexes, transactions
- Built-in rate limiting binding

**Cons:**
- JS/TS/WASM only (no Python, Go, Rust native)
- 128MB memory per isolate (hard limit)
- 2MB max row/value size
- 10GB per DO storage cap
- Vendor lock-in (DO API is proprietary)
- No native cron (use Alarm API, one alarm per DO)

#### AWS (Lambda + DynamoDB + API Gateway)

**Pros:**
- Mature ecosystem, extensive tooling
- DynamoDB auto-scales with no limits
- Lambda supports any runtime

**Cons:**
- API Gateway: $3.50/M requests dominates costs
- S3 PUT: $5.00/M — same Class A cost problem as R2
- DynamoDB: $1.25/M writes
- No built-in WebSocket hibernation (API Gateway WS: $1/M messages)
- Complex multi-service orchestration
- **Most expensive option at scale: $1,697/mo at 100K users**

#### Fly.io (Machines + LiteFS)

**Pros:**
- SQLite-native (LiteFS for replication)
- Run any language/runtime
- Geographic placement control
- Simple deployment model
- Competitive pricing at scale ($345/mo at 100K)

**Cons:**
- No built-in WebSocket hibernation (machines stay running)
- LiteFS is eventually consistent
- Less mature than CF for edge compute
- Manual scaling configuration

#### Supabase (Postgres + Edge Functions)

**Pros:**
- Full Postgres with Row Level Security
- Real-time subscriptions built-in
- Auth + storage bundled
- Good developer experience

**Cons:**
- Shared Postgres at lower tiers (noisy neighbor risk)
- Edge Functions have limited runtime (Deno)
- Pricing jumps at tier boundaries ($25 → $599 Pro → Team)
- Not designed for per-user isolated storage
- **$570/mo at 100K users**

#### Self-hosted VPS

**Pros:**
- **Cheapest: $63/mo at 100K users**
- Full control over runtime, storage, networking
- No vendor lock-in
- Any tech stack

**Cons:**
- Manual scaling, monitoring, security patching
- No built-in geographic distribution
- DDoS protection must be added separately
- Availability/uptime is your responsibility
- **High operational burden — not suitable for a small team**

### 3.3 Decision: Cloudflare DO-Only with Self-Hosted Escape Hatch

**Primary platform:** Cloudflare Workers + DO (SQLite). Best cost, simplest architecture, built-in edge distribution and WebSocket hibernation.

**Escape hatch design:** Abstract the storage layer behind an interface so we can migrate to Fly.io or self-hosted if:
- DO 10GB limit becomes a constraint
- 128MB memory limit blocks a feature
- Cloudflare pricing changes unfavorably
- We need a non-JS runtime for server-side processing

---

## 4. Security Architecture

### 4.1 Zero-Knowledge Model

```
Client                           Server (CF Worker + DO)
  │                                    │
  │ 1. Derive key from passphrase      │
  │    (Argon2id via libsodium)        │
  │                                    │
  │ 2. Encrypt events locally          │
  │    (XChaCha20-Poly1305)            │
  │                                    │
  │ 3. Send ciphertext ──────────────► │ 4. Store encrypted blob
  │                                    │    (cannot decrypt)
  │                                    │
  │ 5. Request data ◄──────────────── │ 6. Return encrypted blob
  │                                    │
  │ 7. Decrypt locally                 │
```

Server never holds decryption keys. Stores only: user identity (JWT), blob sizes, sync timestamps, usage metadata.

### 4.2 Encryption Choice: XChaCha20-Poly1305

| Criteria | AES-256-GCM | XChaCha20-Poly1305 |
|----------|-------------|-------------------|
| Nonce size | 96-bit (reuse risk at ~2^32 msgs) | **192-bit (safe random generation)** |
| WebCrypto native | Yes | No (requires libsodium WASM ~200KB) |
| Hardware accel | AES-NI (~6.4 GB/s) | Software (~4.2 GB/s, still fast) |
| Side-channel resistance | Needs careful impl | **Constant-time by default** |
| NaCl/Paseo compatibility | No | **Yes (same primitive family)** |

**XChaCha20-Poly1305 wins** because:
1. Sync services generate many messages per key — 192-bit nonce eliminates management concerns
2. libsodium WASM works in browsers, Workers, and native on mobile
3. Paseo's relay already uses NaCl — shared key types (Curve25519), compatible primitives

### 4.3 Key Derivation: Argon2id

Via libsodium's `crypto_pwhash` (bundled — no extra dependency):
- Memory-hard (resistant to GPU/ASIC attacks)
- Recommended params: m=64MB, t=3 iterations, p=1
- Fallback: PBKDF2 with 600K+ iterations (native WebCrypto) for constrained environments

### 4.4 Key Storage

| Platform | API | Properties |
|----------|-----|------------|
| iOS | Keychain Services | Secure Enclave backed, biometric-gated |
| Android | Android Keystore | TEE/Secure Element backed |
| macOS | Keychain + safeStorage | Per-app isolation |
| Windows | DPAPI + safeStorage | Encrypted with user login credential |
| Linux | Secret Service API | GNOME Keyring / KDE Wallet |

### 4.5 Device Pairing (QR Code)

```
Device A (has key)           Device B (needs key)
  │                              │
  │ 1. Generate ephemeral        │
  │    Curve25519 keypair        │
  │                              │
  │ 2. Display QR code ────────► │ 3. Scan QR (public key + connection info)
  │    (pubkey + relay addr)     │
  │                              │ 4. Generate own ephemeral keypair
  │                              │
  │ ◄──── NaCl crypto_box ─────► │ 5. Key exchange via relay
  │                              │
  │ 6. Send encrypted master     │
  │    key over secure channel   │ 7. Receive + store master key
  │                              │
  │ 8. Destroy ephemeral keys    │ 8. Destroy ephemeral keys
```

QR contains only a public key (safe if intercepted). Time-limited: 60 seconds.

---

## 5. GDPR Compliance

### 5.1 Encrypted Data Is Still Personal Data

Under GDPR, encrypted data ≈ pseudonymized data (not anonymized). Storage alone counts as "processing." However, zero-knowledge architecture significantly reduces practical obligations:

- **Breach notification:** If encrypted data is breached and server never held the key, the breach is "unlikely to result in a risk to rights and freedoms" — **exemption from notification** under Articles 33/34.
- **Data processor role:** Server is a processor (storing on behalf of user), with lighter obligations than a controller.

### 5.2 Right to Erasure — Crypto-Shredding

```
User requests deletion:
  1. Worker authenticates user (JWT)
  2. DO: deleteAll() — wipes SQLite
  3. Worker: delete all R2 objects under users/{user-id}/
  4. KV: delete session entries
  5. User: destroy local encryption key on all devices
  6. Result: encrypted blobs (even in backups) are irrecoverable
```

Crypto-shredding satisfies Article 17 when encryption is strong and key is truly destroyed.

### 5.3 EU Data Residency

Cloudflare supports jurisdictional restrictions:

```javascript
// Force DO to EU-only data centers
const euNamespace = env.USER_SYNC.jurisdiction("eu");
const id = euNamespace.idFromName(userId);
```

R2 buckets: set jurisdiction at creation time (cannot change after).

**Caveat:** Logs and billing metadata may be processed outside EU. The encrypted data itself stays within jurisdiction.

### 5.4 Data Portability (Article 20)

Client-side encryption inherently satisfies portability:
- Server provides export of all encrypted blobs (zip/tar)
- Client decrypts and presents in JSON/CSV
- User already owns the key and format definition

---

## 6. Auth & Rate Limiting

### 6.1 JWT at the Edge

```javascript
export default {
  async fetch(request, env) {
    const token = request.headers.get("Authorization")?.replace("Bearer ", "");
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload) return new Response("Unauthorized", { status: 401 });

    const doId = env.USER_SYNC.idFromName(payload.sub);
    const stub = env.USER_SYNC.get(doId);
    return stub.fetch(request);
  }
};
```

JWKS cached in KV. Session tokens for WebSocket: authenticate during HTTP upgrade, persist via `serializeAttachment()`.

### 6.2 Per-Tier Rate Limiting

Workers built-in Rate Limiting binding:

| Tier | Limit | Period |
|------|-------|--------|
| Free | 60 req/min | 60s |
| Pro | 600 req/min | 60s |
| Team | 6,000 req/min | 60s |

Eventually consistent, permissive, near-zero latency overhead.

---

## 7. Proposed Service Tiers

| | Free | Pro ($5/mo) | Team ($15/mo) |
|-|------|-------------|---------------|
| Event storage (DO) | 5MB | 500MB | 5GB |
| Blob storage (R2) | None | 1GB | 10GB |
| Retention | 30 days | 1 year | Unlimited |
| Sync frequency | 10/hour | Unlimited | Unlimited |
| Devices | 2 | 5 | Unlimited |
| WebSocket sync | Polling only | Yes | Yes |
| EU data residency | No | Yes | Yes |
| Priority support | No | No | Yes |

### 7.1 Cost per Paying User

At ~$0.02/month infrastructure cost per user, even the $5/mo Pro tier yields **99.6% margin** on infrastructure. The $5/mo Cloudflare base plan is the dominant cost until ~250 paying users.

---

## 8. Critical Limits Summary

### Account-Level Limits

| Resource | Free | Paid | Our Usage |
|----------|------|------|-----------|
| Worker scripts per account | 100 | 500 | **1** (sync API) |
| DO classes (namespaces) per account | 100 | 500 | **1** (`UserSync`) |
| DO instances per namespace | **Unlimited** | **Unlimited** | 1 per user |
| Cron triggers per account | 5 | 250 | ~1 |

**Key distinction:** DO classes ≠ DO instances. A class is defined in `wrangler.toml` (limited to 500). Instances are created at runtime via `idFromName()` (unlimited). We use 1 class that spawns N instances — one per user. 100K users = 1 class, 100K instances. No limit concern.

The "500 Workers" limit refers to deployable scripts (like separate microservices), not user connections or isolation units. Only if you needed >500 different Worker codebases would WfP become relevant.

### Per-Object / Per-Request Limits

| Limit | Value | Mitigation |
|-------|-------|------------|
| DO memory | 128MB per isolate (hard) | Stream data, don't buffer entire datasets |
| DO storage | 10GB per DO | Lifecycle policies, archive to R2 |
| DO row size | 2MB max | Chunk large events, overflow to R2 |
| DO columns | 100 per table | Sufficient for event schema |
| Worker CPU | 30s per request (paid) | Break work into smaller requests |
| Worker size | 10MB compressed | Sufficient (libsodium WASM is ~200KB) |
| R2 object | 5TB max | Not a concern |
| R2 lifecycle rules | 1,000 per bucket | Sufficient for tier-based prefixes |
| KV value | 25MB max | Sufficient for session metadata |
| WebSocket message | 1MB max | Chunk if needed |

---

## 9. Migration Path

If Cloudflare limits become constraining:

| Trigger | Migration Target | Effort |
|---------|-----------------|--------|
| 10GB/user exceeded | Fly.io + LiteFS | Medium (rewrite DO → SQLite server) |
| Need non-JS runtime | Fly.io or self-hosted | High (rewrite Workers) |
| Pricing changes | Self-hosted VPS | High (add infra management) |
| Regulatory requirement | Self-hosted in specific country | High |

**Design principle:** Keep the storage interface abstract. DO SQLite today, replaceable tomorrow.

---

## References

- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [DO Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 Object Lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [DO Jurisdiction Hints](https://developers.cloudflare.com/durable-objects/reference/data-location/)
