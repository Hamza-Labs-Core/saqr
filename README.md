# Saqr صقر

> Agent management platform by [Hamza Labs](https://github.com/Hamza-Labs-Core)

Orchestrate, observe, and control AI coding agents from anywhere — terminal, desktop, or phone. Zero-knowledge encrypted sync across machines.

## Packages

| Package | Description | Story |
|---------|-------------|-------|
| `gc-core` | Event store foundation (bash+jq write, Node.js read) | — |
| `daemon` | AgentContext daemon — hooks, orchestration, streaming | 03-05 |
| `cli` | `saqr` CLI | 03 |
| `shared` | Event types, crypto, sync protocol | — |
| `sync-client` | Encrypted push/pull/queue | 07 |
| `sync-server` | Cloudflare Workers + Durable Objects | 11 |
| `dashboard` | Local web dashboard | 06 |
| `mobile` | React Native / Expo app | 08 |
| `desktop` | Tauri desktop app | 09 |
| `github` | GitHub integration (webhooks, PRs, issues→agents) | 10 |

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
