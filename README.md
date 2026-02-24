# Saqr صقر

> Agent management platform by [Hamza Labs](https://github.com/Hamza-Labs-Core)

Orchestrate, observe, and control AI coding agents from anywhere — terminal, desktop, or phone. Zero-knowledge encrypted sync across machines.

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| `shared` | Event types, discriminated unions, sync protocol | 88 |
| `gc-core` | Event store foundation (bash+jq write, Node.js projections read) | 36 |
| `daemon` | AgentContext daemon — hooks, orchestration, security, codeguard | 757 |
| `sync-client` | E2EE push/pull sync (XChaCha20-Poly1305, Argon2id key recovery) | 107 |
| `sync-server` | Cloudflare Workers + Durable Objects — auth, sync, GDPR, telemetry | 317 |
| `admin-server` | Cloudflare Workers admin API — curated rules, user management | 31 |
| `dashboard` | Local web dashboard with SSE streaming | 109 |
| `cli` | `saqr` CLI — session rendering, themes, timeline | 260 |
| `mobile` | React Native / Expo data layer, voice input, offline sync | 269 |
| `desktop` | Tauri 2 IPC bridge, tray, notifications, secure key storage | 225 |
| `github` | GitHub App integration — webhooks, PRs, issues, repo browser | 147 |

**2,346 tests** across 11 packages (2,310 TypeScript + 36 bash).

## Architecture

```
You (phone / desktop / web)
       │
       ▼ E2EE (XChaCha20-Poly1305)
┌──────────────┐     ┌───────────────┐
│  Sync Server │     │  Admin Server │
│  (CF Worker) │     │  (CF Worker)  │
└──────┬───────┘     └───────────────┘
       │  Shared KV: AUTH_KV, REGISTRY_KV
       ▼
┌──────────────┐
│    Daemon    │  Your machine
│  ┌────────┐  │
│  │ Hooks  │◄─── Claude Code / Cursor / Codex
│  │ Events │  │
│  │ Agents │  │
│  │Codeguard│ │  Anti-pattern detection hooks
│  └────────┘  │
└──────────────┘
       │
       ▼
┌──────────────┐
│   gc-core    │  CQRS event store
│  bash write  │  (bash = fast writes,
│  node read   │   TS daemon = read-side)
└──────────────┘
```

## Key Technical Decisions

- **CQRS architecture** — bash scripts for fast write side, TypeScript daemon for read-side projections
- **XChaCha20-Poly1305** for E2EE via libsodium-wrappers-sumo
- **Argon2id** (m=64MB, t=3, p=1) for passphrase-based key recovery
- **HKDF** (Extract+Expand) for key derivation in e2ee-relay
- **12 unified event types** across all agent providers
- **GDPR Art. 7** consent management with opt-in telemetry
- **Codeguard** — anti-pattern detection hooks with server-backed rule registry

## Stories

All 15 stories implemented:

| # | Story | Package(s) |
|---|-------|------------|
| 01 | Session attach mode | daemon |
| 02 | CLI session rendering | cli |
| 03 | Multi-agent hook system | daemon, cli |
| 04 | Event store projections | gc-core, daemon |
| 05 | Agent process orchestration | daemon |
| 06 | Local dashboard | dashboard |
| 07 | Encrypted cloud sync | sync-client |
| 08 | Mobile app | mobile |
| 09 | Desktop app | desktop |
| 10 | GitHub integration | github |
| 11 | Sync server | sync-server |
| 12 | Security & encryption | daemon |
| 13 | GDPR compliance | sync-server, daemon |
| 14 | Codeguard registry | sync-server, daemon |
| 15 | Admin server | admin-server |

## Development

```bash
pnpm install
pnpm --filter <package> run test    # run tests for a package
pnpm --filter daemon run test       # example: daemon (757 tests)
```

## License

MIT
