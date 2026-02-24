# Story 14: Codeguard Registry — Server-Side Rule Discovery

## Overview

The Codeguard Registry moves rule discovery from a static local JSON file to a server-backed system with two lists:

1. **Curated List** — Hand-picked recommended rules managed by Saqr admins. Admins have full CRUD. These are the "you should have these" rules shown via `/codeguard browse`.

2. **Popular List** — Built from real telemetry data. Users who opt in send anonymous rule usage stats (which rules they have installed, how many times each rule blocked Claude). The server aggregates this into a ranked popularity list. Admins can hide problematic entries. Shown via `/codeguard popular`.

**Privacy constraint**: Telemetry must comply with GDPR and the platform's zero-knowledge encryption promise. Telemetry data is **anonymous aggregate counts only** — rule IDs and block counts. No file paths, no content, no project names, no user-identifiable data beyond the auth token (needed for dedup). The server stores per-user snapshots only for delta computation, keyed by userId, containing only rule IDs and counts.

**Consent**: A new `rule_telemetry` consent category is added to the existing GDPR consent system (Art. 7). Default false. Users must explicitly opt in. The install flow and settings UI surface this choice clearly.

---

## Scope

### In Scope

- Public read endpoints on sync-server for curated and popular lists
- Telemetry ingestion endpoint on sync-server (authed, consent-gated)
- Telemetry delta computation (avoid double-counting on re-sends)
- New `rule_telemetry` consent category in existing consent system
- Daemon-side periodic telemetry sender (opt-in, 1h interval)
- Server-backed RuleRegistry in daemon (fetch from server, cache locally, fallback to bundled JSON)
- ViolationTracker `getSnapshot()` for telemetry payload
- Installer/settings surfacing telemetry opt-in choice
- Skill updates (`/codeguard browse`, `/codeguard popular` note server-backed)
- REGISTRY_KV namespace binding on sync-server for shared storage with admin-server

### Out of Scope

- Admin CRUD for curated/popular (Story 15: Admin Server)
- Admin authentication and authorization (Story 15)
- Payment integration for tier upgrades
- Real-time WebSocket updates for list changes

---

## Requirements

### 1. Telemetry Data Shape (Privacy-Safe)

What clients send:
```json
{
  "rules": [
    { "id": "eval-usage", "scope": "global", "blocks": 42 },
    { "id": "no-any-type", "scope": "project", "blocks": 7 }
  ]
}
```

**No file paths, no content, no project names, no timestamps per-violation.** Just rule IDs, scope (global vs project), and cumulative block count.

What the server stores per-user (for delta dedup):
```
KV key: codeguard:telemetry:{userId}
Value: { rules: [...same shape...], updated_at: ISO8601 }
```

What the server aggregates into the popular list:
```
KV key: codeguard:popular
Value: {
  updated: ISO8601,
  rules: [
    {
      rule: { ...full CodeguardRule... },
      total_installs: 1234,
      total_blocks: 56789,
      hidden: false,
      first_seen: ISO8601,
      last_updated: ISO8601
    }
  ]
}
```

### 2. Consent — `rule_telemetry` Category

Added to existing ConsentManager (Art. 7 GDPR):
- New column `rule_telemetry INTEGER DEFAULT 0` in consent table
- Added to `ConsentCategory` union type
- Default: false (opt-in required)
- Surfaced during install: "Share anonymous rule usage stats to help improve recommendations?"
- Can be changed anytime via `POST /api/consent`
- Telemetry endpoint returns 403 `consent_required` if not opted in

### 3. Public Read Endpoints (sync-server)

- `GET /api/codeguard/curated` — No auth required. Returns curated rules from `REGISTRY_KV`. Clients cache with 1h TTL.
- `GET /api/codeguard/popular` — No auth required. Returns popular rules (hidden excluded), sorted by `total_installs` desc. Supports `?category=` filter and `?limit=` param.

### 4. Telemetry Ingestion (sync-server)

- `POST /api/codeguard/telemetry` — Authed (JWT), consent-gated (`rule_telemetry`)
- Accepts rule list with block counts
- Loads previous snapshot, computes delta
- Updates popular aggregation atomically
- Stores new snapshot for next delta
- Rate limited: max 1 push per 30 minutes per user

### 5. Daemon Telemetry Sender

- Periodic (default 1h, configurable)
- Reads installed rules from RuleManager
- Reads block counts from ViolationTracker
- Builds payload, POSTs to server
- Only if `rule_telemetry` consent is active
- Stores last-sent snapshot locally to avoid redundant sends

### 6. Server-Backed RuleRegistry

- `curated()` / `popular()` fetch from `{syncServerUrl}/api/codeguard/curated|popular`
- Local cache with 1h TTL
- Falls back to bundled `registry.json` if server unreachable
- `toLocalRule()` strips server metadata

### 7. Install-Time Consent Prompt

During `agentctx-codeguard-install` or `saqr install`:
- Ask: "Share anonymous rule usage stats? (rule IDs and block counts only, no file paths or content)"
- If yes: `POST /api/consent { preferences: { rule_telemetry: true } }`
- If no: telemetry disabled, local-only operation
- Can always change later via `/codeguard` skill or consent API

---

## KV Storage Layout (REGISTRY_KV)

| Key | Written by | Read by | Content |
|-----|-----------|---------|---------|
| `codeguard:curated` | admin-server | sync-server (public read) | Curated rules array |
| `codeguard:popular` | sync-server (telemetry aggregation) | sync-server (public read), admin-server (moderation) | Popular rules with counts + hidden flags |
| `codeguard:telemetry:{userId}` | sync-server (telemetry ingestion) | sync-server (delta computation) | Per-user rule snapshot |

---

## Privacy Checklist

- [ ] Telemetry contains only rule IDs, scope, block counts — no PII
- [ ] No file paths, project names, or content in telemetry
- [ ] Per-user snapshots stored only for delta dedup, deletable via account deletion
- [ ] Crypto-shredding includes telemetry KV keys
- [ ] Consent is explicit opt-in (Art. 7), default false
- [ ] User can withdraw consent anytime, telemetry stops immediately
- [ ] Popular list aggregation is anonymous (no user attribution)
- [ ] EU data residency: KV inherits Cloudflare's global edge, no personal data in values
