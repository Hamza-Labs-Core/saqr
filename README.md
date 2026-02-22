# Saqr صقر

> Agent management platform by [Hamza Labs](https://github.com/Hamza-Labs-Core)

Orchestrate, observe, and control AI coding agents from anywhere — terminal, desktop, or phone. Zero-knowledge encrypted sync across machines.

## Packages

| Package | Description | Story |
|---------|-------------|-------|
| `gc-core` | Event store foundation (bash+jq write, Node.js read) | 00-06 |
| `daemon` | AgentContext daemon — hooks, orchestration, streaming | 09-11 |
| `cli` | `saqr` CLI | 09 |
| `shared` | Event types, crypto, sync protocol | — |
| `sync-client` | Encrypted push/pull/queue | 13 |
| `sync-server` | Cloudflare Workers + Durable Objects | 17 |
| `dashboard` | Local web dashboard | 12 |
| `mobile` | React Native / Expo app | 14 |
| `desktop` | Tauri desktop app | 15 |
| `github` | GitHub integration (webhooks, PRs, issues→agents) | 16 |

## Architecture

```
You (phone/desktop/web)
       │
       ▼ E2EE
┌──────────────┐
│  Sync Server │  Cloudflare Workers + DO
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    Daemon    │  Your machine
│  ┌────────┐  │
│  │ Hooks  │◄─── Claude Code / OpenCode / Codex
│  │ Events │  │
│  │ Agents │  │
│  └────────┘  │
└──────────────┘
```

## License

MIT
