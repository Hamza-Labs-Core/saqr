# Product Specification: AgentContext Platform

> Unified agent management, session memory, and encrypted sync across machines.
> Built on Paseo (fork) + GlobalContext event store + Cloudflare edge infrastructure.

---

## 1. Product Vision

A self-hosted daemon that attaches to coding agents (Claude Code, OpenCode, future Codex), captures all session activity via hooks, provides a local dashboard, and optionally syncs encrypted data to a central server for cross-machine access. Users manage agents from phone, desktop, or web — with zero-knowledge encryption ensuring the server never sees user data.

**Two modes of operation:**

| Mode | Account Required | Features |
|------|-----------------|----------|
| **Local-only** | No | Daemon, hooks, event store, dashboard, /recall, agent management, GitHub integration |
| **Synced** | Yes (free or paid) | Everything above + cross-machine sync, mobile app, encrypted cloud storage, multi-device access |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Machine                           │
│                                                                 │
│  ┌──────────┐  hooks   ┌──────────────────────────────────┐    │
│  │Claude Code├────────►│                                  │    │
│  └──────────┘          │       AgentContext Daemon         │    │
│  ┌──────────┐  hooks   │                                  │    │
│  │ OpenCode ├────────►│  ┌─────────┐ ┌────────────────┐  │    │
│  └──────────┘          │  │  Event  │ │ Agent Manager  │  │    │
│  ┌──────────┐  hooks   │  │  Store  │ │ (Paseo fork)   │  │    │
│  │  Codex   ├────────►│  │ (GC)    │ │                │  │    │
│  └──────────┘          │  └────┬────┘ └───────┬────────┘  │    │
│                        │       │              │            │    │
│                        │  ┌────▼──────────────▼────────┐  │    │
│                        │  │   HTTP/WS/SSE Server       │  │    │
│                        │  │   Dashboard + APIs          │  │    │
│                        │  └────────────┬───────────────┘  │    │
│                        └───────────────┼──────────────────┘    │
│                                        │                        │
└────────────────────────────────────────┼────────────────────────┘
                                         │ E2EE WebSocket
                                         ▼
                              ┌──────────────────────┐
                              │  Cloudflare Relay     │
                              │  (Durable Objects)    │
                              └──────┬───────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐   ┌──────────┐   ┌──────────────┐
              │ Phone App│   │Desktop   │   │ Web Portal   │
              │ (Expo)   │   │ (Tauri)  │   │ (dashboard)  │
              └──────────┘   └──────────┘   └──────────────┘

                              ┌──────────────────────┐
                              │  Sync Server          │
                              │  (CF Workers + R2)    │
                              │  Stores encrypted     │
                              │  blobs only           │
                              └──────────────────────┘
```

### Component Responsibilities

| Component | Base | Role |
|-----------|------|------|
| **Daemon** | Paseo fork | Agent process orchestration, WebSocket API, MCP server, hook receiver, event store, projections, local dashboard |
| **Event Store** | GlobalContext | Append-only event capture, session metadata, projections, /recall skill |
| **Sync Client** | New | Encrypts events client-side, pushes to sync server, pulls for cross-machine access |
| **Sync Server** | New (CF Workers) | Stores encrypted blobs, routes to per-user DOs, manages auth/tiers |
| **Relay** | Paseo | E2EE WebSocket relay via Cloudflare Durable Objects |
| **Mobile App** | Paseo fork | Agent management, session history, usage analytics, encrypted data decryption |
| **Desktop App** | Paseo fork (Tauri) | Same as mobile, native OS integration |
| **CLI** | New + GC | `agentctx` CLI for daemon management, hook installation, query/recall |

---

## 3. Detailed Feature List

### F1: Multi-Agent Hook System

Attach to any supported coding agent via per-integration hook installers.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F1.1 | Claude Code hooks | 10 hook types via settings.json (existing GC implementation) |
| F1.2 | OpenCode hooks | Plugin-based hooks via `.opencode/plugins/` using OpenCode's event system |
| F1.3 | Codex hooks | JSONL protocol hooks via Codex's session file watcher |
| F1.4 | Per-integration installer | `agentctx install --claude-code`, `agentctx install --opencode` |
| F1.5 | Hook health check | `agentctx doctor` validates all installed hooks are working |
| F1.6 | Hot-reload hooks | Update hooks without restarting agents |
| F1.7 | Custom hook extensions | User-defined hooks for future agents (generic stdin/stdout protocol) |

#### Event Types (unified across all agents)

| Event | Claude Code Source | OpenCode Source | Codex Source |
|-------|-------------------|-----------------|--------------|
| SessionStarted | SessionStart hook | `session.created` | Process spawn |
| UserPromptReceived | UserPromptSubmit hook | `message.updated` (role=user) | stdin message |
| ToolCallRequested | PreToolUse hook | `tool.execute.before` | JSONL tool_use |
| ToolCallCompleted | PostToolUse hook | `tool.execute.after` | JSONL tool_result |
| ToolCallFailed | PostToolUseFailure hook | `tool.execute.after` (error) | JSONL tool_error |
| AgentSpawned | SubagentStart hook | N/A | N/A |
| AgentCompleted | SubagentStop hook | N/A | N/A |
| TurnCompleted | Stop hook | `session.idle` | JSONL turn_end |
| CompactionTriggered | PreCompact hook | `session.compacted` | N/A |
| SessionEnded | SessionEnd hook | `session.deleted` | Process exit |
| PermissionRequested | N/A (inline) | `permission.asked` | JSONL permission |
| PermissionResponded | N/A (inline) | `permission.replied` | JSONL permission_response |

#### Use Cases
- UC1.1: Developer installs hooks for Claude Code on Linux and OpenCode on Mac, both feed into the same daemon
- UC1.2: New agent integration added by community via custom hook plugin
- UC1.3: Doctor command detects broken OpenCode plugin and reinstalls
- UC1.4: Hook captures tool failure with full input/output for debugging

---

### F2: Local Event Store & Projections

Append-only event store with CQRS projections (existing GlobalContext, integrated into daemon).

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F2.1 | Event capture pipeline | gc-hook → capture-event → atomic write to event store |
| F2.2 | Per-session metadata | session.json with event count, last prompt, timestamps |
| F2.3 | Per-project organization | `events/{project-id}/{session-id}/` with project-id = `{basename}-{hash6}` |
| F2.4 | 5 projection types | context-snapshot, decisions, files-touched, summary, timeline |
| F2.5 | Incremental projections | Only process new events since last build |
| F2.6 | Session chaining | Follow parent session links for context recovery |
| F2.7 | /recall skill | Claude Code skill for retrieving previous session context |
| F2.8 | Full-text search | Search across all sessions by keyword, type, file path |
| F2.9 | Live event monitor | `agentctx watch` for real-time event tailing |
| F2.10 | Projection cache | Pre-warm projections on daemon start |

#### Use Cases
- UC2.1: Developer starts new session, /recall loads context from yesterday's session automatically
- UC2.2: Search for "why did we choose PostgreSQL" finds the decision across 50 sessions
- UC2.3: Watch mode shows live tool calls as Claude works on a feature

---

### F3: Agent Process Orchestration

Spawn, manage, and interact with multiple coding agents (from Paseo fork).

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F3.1 | Provider abstraction | Unified AgentClient/AgentSession interface across Claude/OpenCode/Codex |
| F3.2 | Agent lifecycle | initializing → idle → running → idle/error/closed |
| F3.3 | Multi-agent parallel | Multiple agents in separate worktrees on same machine |
| F3.4 | Worktree management | Auto-create git worktrees for parallel agent work |
| F3.5 | Permission handling | Approve/deny tool permissions from any connected client |
| F3.6 | Agent streaming | Real-time AsyncGenerator streaming of agent output |
| F3.7 | Agent interruption | Cancel running agent without killing session |
| F3.8 | Session persistence | Resume agents from saved state |
| F3.9 | MCP server | Expose agent management as MCP tools |
| F3.10 | Model selection | List and select models per provider |

#### Use Cases
- UC3.1: Spawn 3 Claude Code agents in parallel worktrees for feature/test/docs
- UC3.2: Agent requests file write permission → phone notification → approve from phone
- UC3.3: Resume yesterday's agent session with full context
- UC3.4: Use MCP tools to orchestrate agents from a parent agent

---

### F4: Local Dashboard

Single-file HTTP server with real-time UI (existing GC dashboard, enhanced).

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F4.1 | Event feed | Browse events by project/session with rich formatting |
| F4.2 | Usage analytics | Token usage per project, per model, per day |
| F4.3 | Daily timeline | 30-day bar chart of token consumption |
| F4.4 | Monthly views | Filter usage by month with aggregation |
| F4.5 | Per-project percentage | Show each project's share of total usage |
| F4.6 | SSE live streaming | Real-time event updates in browser |
| F4.7 | System prompt filtering | Categorize task notifications, system reminders vs real prompts |
| F4.8 | Agent status panel | Live view of all running agents with lifecycle state |
| F4.9 | Agent interaction | Send prompts, approve permissions from dashboard |
| F4.10 | Auto-start/restart | Dashboard starts on first session, restarts on install |

#### Use Cases
- UC4.1: Open dashboard to see which agents are running and their current activity
- UC4.2: Check monthly usage across all projects to understand consumption patterns
- UC4.3: Approve a pending permission request from the local dashboard

---

### F5: Encrypted Cloud Sync

Zero-knowledge encrypted sync to Cloudflare edge infrastructure.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F5.1 | Client-side encryption | XChaCha20-Poly1305 via libsodium before any data leaves machine |
| F5.2 | Key generation | Per-user master key generated locally on first setup |
| F5.3 | Key derivation | Argon2id from passphrase for cross-device recovery |
| F5.4 | Metadata separation | Cleartext: timestamps, token counts, event types, model names. Encrypted: prompts, responses, file paths, tool inputs/outputs |
| F5.5 | Push sync | Daemon pushes encrypted events to sync server after capture |
| F5.6 | Pull sync | Clients pull and decrypt events from other machines |
| F5.7 | Conflict resolution | Append-only events = no conflicts (last-writer-wins for metadata only) |
| F5.8 | Selective sync | Choose which projects to sync (privacy control) |
| F5.9 | Sync status indicator | Dashboard shows sync state per machine |
| F5.10 | Offline-first | Full functionality without sync; sync catches up when online |

#### Data Flow: Sync Push

```
Daemon (Machine A)
  │
  ├─ Event captured by hook
  ├─ Written to local event store (as today)
  ├─ Split into cleartext metadata + sensitive payload
  ├─ Encrypt sensitive payload with user's master key (XChaCha20-Poly1305)
  ├─ POST /api/sync/push { metadata: {...}, encrypted: "base64", nonce: "...", key_id: "..." }
  │
  ▼
Cloudflare Worker (API layer)
  │
  ├─ Verify JWT auth token
  ├─ Check rate limits (tier-based)
  ├─ Route to user's Durable Object via idFromName(userId)
  │
  ▼
Durable Object (per-user)
  │
  ├─ Store event metadata in SQLite (for aggregation queries)
  ├─ Store encrypted blob in R2 (for full event retrieval)
  ├─ Update sync cursors per machine
  ├─ Notify connected WebSocket clients of new events
  │
  ▼
R2 Bucket
  └─ /users/{user-id}/events/{machine-id}/{project-id}/{session-id}/{sequence}.enc
```

#### Data Flow: Sync Pull

```
Mobile App / Desktop / Dashboard
  │
  ├─ Connect to user's DO via WebSocket (through relay or direct)
  ├─ Send sync cursor: "give me events after sequence X from machine B"
  │
  ▼
Durable Object
  │
  ├─ Query SQLite for events matching cursor (cleartext metadata only)
  ├─ Fetch encrypted blobs from R2
  ├─ Stream to client
  │
  ▼
Client
  │
  ├─ Receive encrypted events
  ├─ Decrypt with master key (stored in Keychain/Keystore)
  ├─ Render in UI (dashboard, timeline, search)
```

#### Use Cases
- UC5.1: Developer works on Mac at office, opens phone on commute to review session history from Mac
- UC5.2: Developer switches from Linux to Windows, /recall finds sessions from Linux machine
- UC5.3: User loses phone — data on sync server is useless without encryption key
- UC5.4: User deletes account — crypto-shredding makes all data permanently unrecoverable
- UC5.5: Free tier user syncs 2 machines with 30-day retention
- UC5.6: Paid tier user syncs 5 machines with 1-year retention

---

### F6: Mobile App (Paseo Fork)

Native mobile experience for agent management and session history.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F6.1 | Multi-daemon registry | Register multiple machines (direct LAN or relay) |
| F6.2 | QR code pairing | Scan daemon's QR to establish E2EE connection |
| F6.3 | Unified agent view | See all agents across all machines in one list |
| F6.4 | Agent interaction | Send prompts, view streaming output, approve permissions |
| F6.5 | Session history | Browse past sessions with search across machines |
| F6.6 | Usage dashboard | Token usage, daily timeline, monthly views, per-project % |
| F6.7 | Push notifications | Agent needs attention (finished, error, permission request) |
| F6.8 | Diff viewer | View code changes with syntax-highlighted unified diffs |
| F6.9 | File explorer | Browse agent workspace files remotely |
| F6.10 | Voice input | Dictation mode for sending prompts hands-free |
| F6.11 | Encryption key management | Secure key storage in Keychain/Keystore, biometric unlock |
| F6.12 | QR key transfer | Transfer encryption key between devices via QR + ephemeral E2EE |
| F6.13 | Offline mode | Browse cached session history without network |

#### Use Cases
- UC6.1: Phone notification: "Claude finished feature on Linux VM" → open app → review diff → approve PR
- UC6.2: Scan QR code on new Mac to register it in the app
- UC6.3: Search "authentication" across all machines to find relevant sessions
- UC6.4: Transfer encryption key from Mac to phone via QR code pairing

---

### F7: Desktop App (Tauri)

Native desktop wrapper with OS integration.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F7.1 | Tauri 2 wrapper | Wraps web dashboard/app in native window |
| F7.2 | System tray | Background daemon status, quick actions |
| F7.3 | Native notifications | OS-level notifications for agent events |
| F7.4 | Secure key storage | macOS Keychain, Windows DPAPI, Linux Secret Service |
| F7.5 | Auto-update | Delta updates via Tauri updater |
| F7.6 | Multi-window | Open multiple agent views side-by-side |

#### Use Cases
- UC7.1: Desktop app in system tray, notification pops up when agent needs permission
- UC7.2: Open two agent windows side by side (feature agent + test agent)

---

### F8: GitHub Integration

First-class GitHub support for repository management and PR workflows.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F8.1 | GitHub App | Register as GitHub App for fine-grained repo access |
| F8.2 | Repository browser | List repos, branches, recent PRs from mobile/desktop |
| F8.3 | Worktree from branch | Create agent worktree from any branch |
| F8.4 | PR creation | Agent creates PR directly from worktree work |
| F8.5 | PR review notifications | Webhook-driven alerts when PRs get comments/reviews |
| F8.6 | Agent-from-issue | Create an agent task from a GitHub issue |
| F8.7 | Multiple repo instances | Same repo in multiple worktrees with branch-per-agent model |
| F8.8 | GitHub Actions trigger | Trigger agent workflows from CI events |

#### Data Flow: Agent-from-Issue

```
GitHub Issue #42: "Add dark mode support"
  │
  ├─ Webhook fires → Sync server → Push notification to mobile
  ├─ User opens app → taps "Start Agent"
  │
  ▼
Mobile App
  │
  ├─ Selects target machine (Linux VM)
  ├─ Selects provider (Claude Code)
  ├─ Agent created with worktree "agent/issue-42"
  ├─ Initial prompt: issue title + body + linked files
  │
  ▼
Daemon (Linux VM)
  │
  ├─ Creates worktree: git worktree add ../issue-42 -b agent/issue-42
  ├─ Spawns Claude Code in worktree directory
  ├─ Streams progress to mobile app via relay
  │
  ▼
Agent completes
  │
  ├─ Creates PR from worktree branch
  ├─ Links PR to issue #42
  ├─ Push notification: "PR ready for review"
```

#### Use Cases
- UC8.1: Assign an issue to an agent from the mobile app
- UC8.2: Agent works on feature branch, creates PR when done
- UC8.3: PR gets review comment → notification → spawn agent to address comment
- UC8.4: Three agents working on three different branches of same repo simultaneously

---

### F9: Sync Server (Cloudflare Edge)

Zero-knowledge sync infrastructure on Cloudflare's edge network.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F9.1 | Worker API layer | JWT auth, rate limiting, DO routing |
| F9.2 | Per-user Durable Object | SQLite metadata store + WebSocket hub (all tiers) |
| F9.3 | R2 encrypted blob storage | Per-user key prefix isolation |
| F9.4 | Machine registry | Track registered machines per user |
| F9.5 | Sync cursors | Per-machine sync position tracking |
| F9.6 | WebSocket notifications | Real-time push of new events to connected clients |
| F9.7 | Usage aggregation | Server-side aggregation of cleartext metadata (token counts) |
| F9.8 | Account management | Registration, auth, tier management |
| F9.9 | Crypto-shredding | Account deletion = encrypted data permanently unrecoverable |
| F9.10 | EU data residency | Jurisdiction hints on DO + R2 for EU users |
| F9.11 | Tier enforcement | Storage quotas, sync frequency, device limits per tier |
| F9.12 | Web portal | Account management only (no data viewing — zero knowledge) |

#### Tier Structure

| | Free | Pro ($5/mo) | Team ($15/mo) |
|-|------|-------------|---------------|
| Machines | 2 | 5 | Unlimited |
| Event storage (R2) | 50 MB | 1 GB | 10 GB |
| Retention | 30 days | 1 year | Unlimited |
| Sync frequency | 10/hour | Unlimited | Unlimited |
| WebSocket sync | Polling only | Real-time | Real-time |
| EU residency | No | Yes | Yes |
| Priority support | No | No | Yes |

#### Server Infrastructure Cost (per user)

| Component | Monthly Cost |
|-----------|-------------|
| DO requests | ~$0.0002 |
| DO storage (SQLite metadata) | ~$0.004 |
| R2 storage (encrypted blobs) | ~$0.002 |
| R2 operations | ~$0.015 |
| Worker requests | included |
| **Total per active user** | **~$0.02/month** |

#### Use Cases
- UC9.1: User registers, gets free tier, syncs 2 machines
- UC9.2: User upgrades to Pro, adds 3 more machines, data retention extends to 1 year
- UC9.3: User deletes account, all encrypted data becomes permanently unreadable
- UC9.4: EU user's data stays in EU via jurisdiction hints
- UC9.5: Free tier user hits sync limit, gets prompted to upgrade

---

### F10: Security & Encryption

End-to-end encryption with zero-knowledge server architecture.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F10.1 | Master key generation | 256-bit random key via libsodium, generated locally |
| F10.2 | Passphrase derivation | Argon2id (m=64MB, t=3, p=1) for cross-device key recovery |
| F10.3 | XChaCha20-Poly1305 | 192-bit nonce, safe random generation, AEAD |
| F10.4 | iOS Keychain storage | `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` + biometric ACL |
| F10.5 | Android Keystore | TEE/StrongBox-backed, biometric authentication |
| F10.6 | Desktop keychain | macOS Keychain / Windows DPAPI / Linux Secret Service |
| F10.7 | QR key transfer | Ephemeral Curve25519 exchange → encrypted key transfer |
| F10.8 | Key backup prompt | Force user to back up passphrase, warn about unrecoverability |
| F10.9 | E2EE relay | Paseo's existing NaCl-based encrypted WebSocket channel |
| F10.10 | Path sandboxing | File access scoped to agent workspace (no traversal) |
| F10.11 | Host allowlisting | DNS rebinding protection on daemon HTTP server |
| F10.12 | Download tokens | Single-use, time-limited tokens for file downloads |

#### Data Flow: Key Lifecycle

```
First Install (Machine A):
  1. Generate 256-bit master key (libsodium randombytes)
  2. Store in OS keychain (Keychain/Keystore/DPAPI)
  3. Prompt user to create recovery passphrase
  4. Derive recovery key via Argon2id(passphrase, salt)
  5. Encrypt master key with recovery key → store encrypted backup locally
  6. User writes down passphrase (or stores in password manager)

Add New Device (Phone):
  1. Machine A displays QR code (ephemeral Curve25519 public key + connection info)
  2. Phone scans QR, generates own ephemeral keypair
  3. Both derive shared key via ECDH
  4. Machine A encrypts master key with shared key, sends over encrypted channel
  5. Phone stores master key in Keychain/Keystore with biometric gating
  6. Both destroy ephemeral keys

Key Loss Scenario:
  - Lost phone: Key was device-only, cannot be extracted
  - Lost all devices: Enter recovery passphrase → Argon2id → decrypt master key backup
  - Lost passphrase + all devices: Data permanently encrypted, account can be deleted
```

#### Use Cases
- UC10.1: Setup encryption on first install with passphrase backup
- UC10.2: Transfer key to phone via QR scan
- UC10.3: Phone stolen — attacker cannot access key (biometric + device-only storage)
- UC10.4: Recover key on new laptop using passphrase
- UC10.5: Jailbroken device — TEE/StrongBox keys still protected from extraction

---

### F11: GDPR Compliance

Full EU data protection regulation compliance.

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F11.1 | Data minimization | Server stores only encrypted blobs + anonymous metadata |
| F11.2 | Right to erasure | Account deletion + crypto-shredding |
| F11.3 | Data portability | Export all encrypted data as JSON archive, decrypt client-side |
| F11.4 | Consent management | Explicit opt-in for sync, clear data processing explanation |
| F11.5 | DPA with Cloudflare | Standard Cloudflare DPA covers infrastructure |
| F11.6 | EU data residency | Jurisdiction hints ensure data stays in EU |
| F11.7 | Breach notification | Encrypted data breach = "unlikely to result in risk" exemption |
| F11.8 | Privacy policy | Clear documentation of what server can/cannot access |
| F11.9 | Cookie-free | No tracking cookies, no analytics on user data |

#### Use Cases
- UC11.1: EU user registers, data automatically pinned to EU region
- UC11.2: User exercises right to erasure, account + all blobs deleted, crypto-shredded
- UC11.3: User exports all data as JSON, decrypts locally, migrates to self-hosted

---

### F12: Session Attach Mode (Hybrid)

Detect, observe, and take over existing CLI sessions — or spawn managed sessions — with seamless continue-from-anywhere.

#### Operating Modes

| Mode | How it starts | Observation | Interaction | Resume from other device |
|------|--------------|-------------|-------------|--------------------------|
| **Observed** | User types `claude` in their terminal | Full read-only via GC hooks | Read-only (view only) | Stop → resume handoff |
| **Managed** | `agentctx agent start` or mobile "New Agent" | Full read-only + PTY streaming | Full: send prompts, approve perms, interrupt | Seamless — any client attaches to shared PTY |
| **Resumed** | "Take over" from mobile/desktop on an observed session | Full via SDK streaming | Full: same as managed | Seamless after takeover |

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F12.1 | Session auto-detection | Daemon watches `~/.claude-context/events/` for new session directories (inotify/fswatch). Any `claude` invocation triggers SessionStarted event → daemon registers an observed session. |
| F12.2 | Observed session timeline | Events captured by GC hooks are streamed to all connected clients in real time. Clients see user prompts, tool calls, Claude responses, token usage — identical content to the CLI session, read-only. |
| F12.3 | Session takeover (stop/resume) | User taps "Take Over" on observed session → daemon sends interrupt signal (platform-appropriate: check for Claude Code process via session metadata, `kill -SIGINT`) → waits for session to stop → spawns new SDK agent with `resume: sessionId` → session becomes Managed. Original terminal shows "Session resumed on another device." |
| F12.4 | Managed session (PTY proxy) | `agentctx agent start` spawns `claude` inside daemon-managed `node-pty`. Daemon owns the PTY, any client (terminal, mobile, desktop) connects as a render client. Multiple clients can be connected simultaneously. |
| F12.5 | Terminal client attachment | `agentctx agent attach <id>` connects the user's terminal to a managed session's PTY. Raw terminal I/O is forwarded — feels exactly like running `claude` directly. User can detach (Ctrl+B d, tmux-style) without stopping the agent. |
| F12.6 | Managed session detach/reattach | User closes terminal or laptop lid → PTY keeps running → reattach from any device. Same as tmux/screen but integrated into daemon lifecycle. |
| F12.7 | Resume handback | After working on mobile, user returns to machine → `agentctx agent attach <id>` reconnects terminal. Or: the managed session can be "released" back to a normal CLI via `agentctx agent release <id>` which spawns a foreground `claude --resume` in the user's terminal. |
| F12.8 | Session state indicator | CLI shows a status line when session is being observed: `[AgentCtx: observed by 2 clients]`. Managed sessions show `[AgentCtx: managed • 3 clients connected]`. |
| F12.9 | Auto-detect running sessions | On daemon startup, scan for existing `claude` processes and correlate with recent session events. Offer to observe already-running sessions. |
| F12.10 | Conflict prevention | Only one writer at a time. Observed sessions: CLI is the writer. Managed sessions: whichever client has input focus is the writer. Explicit "Request control" flow when multiple clients want to type. |

#### Data Flow: Session Takeover (Observed → Resumed)

```
User's Terminal (Machine A)
  │  Running: claude (direct CLI session)
  │  GC hooks capturing all events → daemon observing
  │
  ▼
Mobile App (viewing observed session)
  │  User taps "Take Over"
  │
  ▼
Daemon (Machine A)
  │
  ├─ 1. Find Claude process PID from session metadata
  ├─ 2. Send SIGINT → Claude CLI enters graceful shutdown
  ├─ 3. Wait for SessionEnded event from hooks (or timeout 5s)
  ├─ 4. Read session ID from ~/.claude/projects/{project}/.session.json
  ├─ 5. Spawn new SDK agent: query({ resume: sessionId, ... })
  ├─ 6. Session transitions: Observed → Resumed (now Managed)
  ├─ 7. Mobile gets full SDK streaming (prompts, tool calls, responses)
  │
  ▼
User's Terminal
  └─ Shows: "Session taken over by AgentCtx (mobile). Run 'agentctx agent attach <id>' to reconnect."
```

#### Data Flow: Managed Session (PTY Proxy)

```
User starts:  agentctx agent start --project /path/to/repo
  │
  ▼
Daemon
  │
  ├─ 1. Creates node-pty: pty.spawn("claude", [], { cwd: "/path/to/repo" })
  ├─ 2. PTY output → xterm.js headless parser (server-side terminal state)
  ├─ 3. PTY output → ring buffer (8MB, for reconnection replay)
  ├─ 4. PTY output → all connected WebSocket clients
  ├─ 5. GC hooks ALSO capture events (dual path: PTY stream + structured events)
  │
  ▼
Connected clients (any number, any device):
  │
  ├─ Terminal client (agentctx agent attach):
  │    Raw PTY I/O forwarded — native terminal experience
  │    stdin → daemon → PTY input (only if client has input focus)
  │
  ├─ Mobile/Desktop app:
  │    Terminal rendering via xterm.js in WebView
  │    Structured event overlay (tool calls, usage)
  │    Touch/virtual keyboard input
  │
  └─ Web dashboard:
       xterm.js widget embedded in dashboard page
       Click-to-focus for input
```

#### Use Cases
- UC12.1: Developer starts `claude` normally → opens phone → sees live session → reads along during commute
- UC12.2: Developer starts `claude` → leaves for meeting → opens phone → taps "Take Over" → continues conversation on phone → returns to desk → `agentctx agent attach` → back in terminal
- UC12.3: Developer starts managed session → works from terminal → closes laptop → opens desktop at home → reattaches seamlessly
- UC12.4: Two developers pair-programming: one types, other observes the same managed session from their machine
- UC12.5: Long-running agent overnight → developer checks progress from phone in morning without interrupting it

---

### F13: CLI Session Rendering on Mobile & Desktop

Faithful reproduction of the Claude Code CLI experience on non-terminal surfaces (mobile, desktop app, web dashboard). Every UI element visible in the CLI must have a corresponding mobile representation.

#### CLI Visual Elements → Mobile Mapping

| CLI Element | What it looks like in terminal | Mobile/Desktop Rendering |
|-------------|-------------------------------|--------------------------|
| **User prompt** | `> ` prefix, white text on dark bg | Chat bubble (right-aligned), full text, monospace font. Tap to expand if long. |
| **Claude response** | Streaming text, markdown rendered in terminal (bold, italic, lists, headers) | Chat bubble (left-aligned), rendered markdown. Streaming word-by-word with typing indicator. |
| **Thinking/reasoning** | Collapsible `Thinking...` block with grey text | Collapsible card with "Thinking..." header, expandable to show full reasoning text. Subtle animation while streaming. |
| **Tool calls** | `⏺ tool_name` with colored status indicator | Card with tool icon + name as header. Status badge: 🔵 running, ✅ completed, ❌ failed. Expandable for input/output details. |
| **Tool: Read file** | Shows file path, line range | Card: file icon + path. Tap → shows file content with syntax highlighting + line numbers. |
| **Tool: Edit file** | Shows file path + diff (red/green lines) | Card: edit icon + path. Inline unified diff with syntax highlighting. Red/green background for removed/added lines. Swipe for side-by-side diff view. |
| **Tool: Write file** | Shows file path + full content written | Card: create icon + path. Tap → shows full file content with syntax highlighting. Badge shows file size. |
| **Tool: Bash** | Shows command + output (scrollable) | Card: terminal icon + command as header. Output in monospace scrollable container with dark background. Truncated at 50 lines, "Show all" expander. |
| **Tool: Glob/Grep** | Shows pattern + matching files/lines | Card: search icon + pattern. Results as collapsible file list. Tap file → navigate to it. |
| **Tool: WebFetch** | Shows URL + summary | Card: globe icon + URL. Summary text below. |
| **Tool: Task (subagent)** | Shows subagent type + prompt + result | Nested card with agent icon. Expandable to show the subagent's full timeline as a nested view. |
| **Permission request** | Yellow `⚠ Allow tool_name?` with [y/n/a] | Alert card with amber border. Tool name + description + file affected. "Allow" / "Deny" / "Always Allow" buttons. Push notification triggers if app is backgrounded. |
| **Permission: auto-allowed** | Brief flash of allowed tool | Subtle inline note "Auto-allowed: Read" (collapsed by default, visible in detailed view). |
| **Error** | Red text, stack trace | Error card with red border. Error message prominent, stack trace in collapsible monospace block. |
| **Cost/token display** | Bottom status bar: model, tokens in/out, cost | Sticky footer bar: model badge, token counts (in/out/cache), session cost. Tap for detailed breakdown. |
| **Model indicator** | Status bar shows current model | Badge in header: "Opus 4.6" / "Sonnet 4.5" with model color coding. |
| **Context window** | Progress bar or percentage | Circular progress indicator in header. Color shifts from green → yellow → red as context fills. |
| **Compact notification** | "Compacting conversation..." | Inline notification card: "Context compacted" with before/after token counts. |
| **Task list (todos)** | Checklist with status indicators | Interactive checklist card. Items show status (pending/in-progress/done) with progress bar. |
| **Image output** | Inline image in terminal (iTerm2/Kitty) | Native image rendering, pinch-to-zoom, tap for fullscreen. |
| **Code blocks** | Syntax-highlighted fenced code | Syntax-highlighted code block with language badge, copy button, and line numbers. Horizontal scroll for long lines. |
| **Markdown tables** | ASCII table rendering | Native table rendering with proper columns, horizontal scroll if needed. |
| **Session timer** | Status bar clock or elapsed time | Header shows elapsed time. Background color indicates if session is active (green pulse) or idle (grey). |

#### Sub-features

| ID | Feature | Description |
|----|---------|-------------|
| F13.1 | Structured event renderer | Each GC event type (ToolCallRequested, ToolCallCompleted, etc.) maps to a dedicated React Native component with appropriate icons, colors, and expandable sections. |
| F13.2 | Streaming text renderer | Word-by-word streaming for Claude responses. Uses WebSocket chunks, not polling. Cursor blink animation at end of stream. |
| F13.3 | Diff viewer component | Unified diff renderer with syntax highlighting per language. Red/green line backgrounds. Line numbers. Swipe gesture for side-by-side mode on tablets. |
| F13.4 | Terminal emulator widget | For managed sessions: embedded xterm.js (WebView) renders actual PTY output. Handles ANSI colors, cursor movement, alternate screen buffer. Used when user wants raw terminal view instead of structured view. |
| F13.5 | Dual view mode | Toggle between "Structured" (card-based, pretty) and "Terminal" (raw PTY output) views. Structured is default on mobile, Terminal is default on desktop. |
| F13.6 | Syntax highlighting | Language detection from file extension. Highlight.js or Shiki for code blocks, file contents, and diffs. Dark/light theme support. |
| F13.7 | File navigator | Browse agent's working directory. Tap file → view with highlighting. Shows git status (modified, added, untracked) per file. |
| F13.8 | Prompt input | Multiline text input with markdown preview. Auto-suggest from prompt history. Voice input button (F6.10). File attachment for context. |
| F13.9 | Permission action sheet | Native action sheet for permission requests. Haptic feedback on approve/deny. "Always allow for this session" option. |
| F13.10 | Search within session | Search across all events in current session. Highlights matches in context. Filter by event type, tool name, file path. |
| F13.11 | Session scrubber | Timeline scrubber at bottom to jump to any point in session history. Like a video scrubber — drag to see events at that timestamp. |
| F13.12 | Notification badges | Per-event-type badge counts on the session tab. Unread prompt count, pending permission count, error count. |
| F13.13 | Responsive layout | Phone: single column chat-style. Tablet: two-panel (session list + session detail). Desktop: three-panel (agents + sessions + detail). |
| F13.14 | Theme matching | Detect user's terminal color scheme (from session metadata or config) and apply matching theme to mobile rendering. Dark mode default. |

#### Rendering Architecture

```
Event Source (one of):
  ├─ GC hooks (observed sessions)     → JSONL events
  ├─ SDK streaming (managed sessions) → AgentStreamEvent
  └─ PTY output (managed sessions)    → raw bytes + parsed grid

            │
            ▼
┌──────────────────────────────────┐
│     Event Normalization Layer     │
│                                   │
│  Converts all sources to unified  │
│  TimelineItem[] for rendering     │
│                                   │
│  Types:                           │
│  - UserMessage                    │
│  - AssistantMessage (streaming)   │
│  - ThinkingBlock                  │
│  - ToolCall (with sub-type:       │
│      Read, Edit, Write, Bash,     │
│      Glob, Grep, WebFetch, Task)  │
│  - PermissionRequest              │
│  - Error                          │
│  - SystemNotification             │
│  - CompactNotification            │
│  - UsageUpdate                    │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│     Rendering Engine              │
│                                   │
│  Mobile (React Native):           │
│  ├─ FlashList (virtualized)       │
│  ├─ Per-type component registry   │
│  ├─ Memoized components           │
│  └─ Gesture handlers              │
│                                   │
│  Desktop (Tauri WebView):         │
│  ├─ Virtual scroll (tanstack)     │
│  ├─ Same component library        │
│  └─ Keyboard shortcuts            │
│                                   │
│  Web (Dashboard):                 │
│  ├─ Existing GC dashboard style   │
│  └─ Progressively enhanced        │
└──────────────────────────────────┘
```

#### Observed vs Managed Session Rendering Differences

| Aspect | Observed (GC hooks) | Managed (SDK + PTY) |
|--------|---------------------|---------------------|
| Update latency | ~100ms (hook fire → event write → daemon detect) | <10ms (direct SDK stream) |
| Claude response | Full text after turn completes (TurnCompleted enrichment) | Word-by-word streaming in real time |
| Tool call progress | Pre/Post events (before + after) | Live status updates (running → completed) |
| Terminal view | Not available (no PTY access) | Full raw terminal via xterm.js |
| Input capability | Read-only (can only "Take Over") | Full: send prompts, approve/deny, interrupt |
| Thinking blocks | Captured if in transcript | Streamed in real time with `thinking_delta` events |

#### Use Cases
- UC13.1: Developer reads Claude's code review on phone — sees diffs with syntax highlighting, same as they'd see in terminal
- UC13.2: Agent requests permission to delete a file — phone shows native alert with file path, "Allow"/"Deny" buttons, haptic on tap
- UC13.3: Long Claude response streaming — mobile shows word-by-word typing with cursor animation
- UC13.4: Developer switches to "Terminal" view on iPad — sees exact raw PTY output as if they were at their desk
- UC13.5: Developer scrubs back through a 200-event session to find where a bug was introduced
- UC13.6: Managed session shows agent working on 3 files — mobile shows file changes as inline diffs, each tool call as a card with expand/collapse
- UC13.7: Agent spawns a subagent (Task tool) — mobile shows nested timeline that expands to reveal the subagent's own tool calls and responses

---

## 4. Architecture Details

### 4.1 Daemon Architecture (Paseo Fork + GlobalContext)

The daemon is the core — it runs on each user machine and combines Paseo's agent management with GlobalContext's event store.

```
┌─────────────────────────────────────────────────────────┐
│                    AgentContext Daemon                    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Agent Manager (Paseo)                │   │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────┐ │   │
│  │  │Claude Agent│ │OpenCode    │ │ Codex Agent  │ │   │
│  │  │(SDK)       │ │(HTTP API)  │ │ (JSONL)      │ │   │
│  │  └────────────┘ └────────────┘ └──────────────┘ │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │ AgentStreamEvents              │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │              Event Store (GC)                     │   │
│  │  ┌──────────┐ ┌────────────┐ ┌────────────────┐ │   │
│  │  │ capture  │ │ session    │ │ projections    │ │   │
│  │  │ -event   │ │ metadata   │ │ (5 handlers)   │ │   │
│  │  └──────────┘ └────────────┘ └────────────────┘ │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │              Sync Client                          │   │
│  │  ┌──────────┐ ┌────────────┐ ┌────────────────┐ │   │
│  │  │ encrypt  │ │ push/pull  │ │ cursor mgmt    │ │   │
│  │  └──────────┘ └────────────┘ └────────────────┘ │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              HTTP/WS Server                       │   │
│  │  /api/*          REST APIs (events, usage, etc)   │   │
│  │  /ws             WebSocket (agent streaming)      │   │
│  │  /api/stream     SSE (event feed)                 │   │
│  │  /mcp/agents     MCP server                       │   │
│  │  /               Dashboard HTML                   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Relay Transport (Paseo)              │   │
│  │  Outbound E2EE WebSocket to relay.agentctx.dev   │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Sync Server Architecture (Cloudflare)

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Edge                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Worker (API Gateway)                 │   │
│  │                                                    │   │
│  │  POST /api/auth/register    → KV (user accounts)  │   │
│  │  POST /api/auth/login       → JWT issuance         │   │
│  │  POST /api/sync/push        → route to user DO     │   │
│  │  GET  /api/sync/pull        → route to user DO     │   │
│  │  WS   /api/sync/stream      → route to user DO     │   │
│  │  GET  /api/account          → KV (user metadata)   │   │
│  │  DELETE /api/account        → crypto-shred          │   │
│  │                                                    │   │
│  │  Middleware: JWT verify, rate limit, tier check     │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │         Durable Object (per user)                 │   │
│  │                                                    │   │
│  │  SQLite tables:                                    │   │
│  │    machines(id, name, last_sync, created_at)       │   │
│  │    events_meta(machine_id, project_id, session_id, │   │
│  │      sequence, event_type, timestamp,              │   │
│  │      input_tokens, output_tokens, model,           │   │
│  │      r2_key)                                       │   │
│  │    sync_cursors(machine_id, last_sequence)         │   │
│  │                                                    │   │
│  │  WebSocket: push new events to connected clients   │   │
│  │  Alarm: periodic cleanup of expired data           │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │              R2 Bucket                            │   │
│  │                                                    │   │
│  │  /users/{user-id}/                                 │   │
│  │    events/{machine-id}/{project-id}/               │   │
│  │      {session-id}/{sequence}.enc                   │   │
│  │    snapshots/{snapshot-id}.enc                      │   │
│  │                                                    │   │
│  │  Lifecycle rules:                                  │   │
│  │    Free tier: delete after 30 days                 │   │
│  │    Pro tier: delete after 365 days                 │   │
│  │    Team tier: no auto-deletion                     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              KV Namespace                         │   │
│  │                                                    │   │
│  │  users:{email} → { userId, tier, createdAt }       │   │
│  │  sessions:{token} → { userId, expiresAt }          │   │
│  │  jwks:public → { keys: [...] }                     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │         Relay Durable Object (existing Paseo)     │   │
│  │                                                    │   │
│  │  Per serverId: bridge daemon ↔ mobile WebSockets   │   │
│  │  E2EE passthrough (zero knowledge)                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Event Encryption Schema

```
Cleartext metadata (stored in DO SQLite):
{
  "machine_id": "macbook-a3f7b2",
  "project_id": "myapp-c9d1e4",
  "session_id_hash": "sha256(session_id)[:16]",
  "sequence": 42,
  "event_type": "ToolCallCompleted",
  "timestamp": "2026-02-21T14:30:00.123Z",
  "input_tokens": 1500,
  "output_tokens": 800,
  "cache_read_tokens": 5000,
  "model": "claude-opus-4-6",
  "r2_key": "users/uid/events/macbook-a3f7b2/myapp-c9d1e4/sess123/000042.enc"
}

Encrypted blob (stored in R2):
{
  "nonce": "base64(24 bytes)",
  "key_id": "sha256(master_key)[:8]",
  "ciphertext": "base64(XChaCha20-Poly1305(JSON.stringify({
    session_id: 'abc-123-def',
    prompt: 'Add dark mode support...',
    response: 'I will modify the theme...',
    tool_name: 'Write',
    tool_input: { file_path: '/src/theme.ts', content: '...' },
    tool_result: 'File written successfully',
    ... full event data
  })))"
}
```

---

## 5. Implementation Phases

### Phase 1: Core Integration (Weeks 1-4)
- Fork Paseo, strip voice/dictation (defer to later)
- Integrate GlobalContext event store into daemon
- Unified hook installer for Claude Code + OpenCode
- Local dashboard with agent management + event store
- CLI: `agentctx install`, `agentctx start`, `agentctx query`
- **Session auto-detection** (F12.1): daemon watches event store for new CLI sessions
- **Observed session streaming** (F12.2): relay hook events to connected clients in real time

### Phase 2: Encryption & Sync (Weeks 5-8)
- Implement client-side encryption (libsodium)
- Build Cloudflare Worker + DO + R2 sync server
- Sync push/pull from daemon
- Account registration (email + passphrase)
- Free tier with 2 machines, 30-day retention

### Phase 3: Mobile App + Session Rendering (Weeks 9-14)
- Fork Paseo mobile app
- **Structured event renderer** (F13.1): per-event-type React Native components
- **CLI-to-mobile element mapping** (F13): all tool call cards, diff viewer, permission action sheets, streaming text, syntax highlighting
- **Dual view mode** (F13.5): structured (card-based) + terminal (xterm.js WebView)
- **Prompt input** (F13.8): multiline text with history, voice input
- **Session scrubber** (F13.11): timeline navigation across events
- Add session history view with encrypted data decryption
- Add usage analytics dashboard
- Add encryption key management (Keychain/Keystore)
- QR code key transfer between devices
- Push notifications for agent events

### Phase 4: Session Attach Mode + GitHub (Weeks 15-20)
- **Session takeover** (F12.3): observed → resumed via SIGINT + SDK resume
- **Managed sessions** (F12.4): node-pty proxy, multi-client attachment
- **Terminal client attachment** (F12.5): `agentctx agent attach` for native terminal experience
- **Detach/reattach** (F12.6): tmux-style lifecycle without stopping agent
- **Conflict prevention** (F12.10): single-writer with explicit control handoff
- GitHub App registration and OAuth flow
- Repository browser, worktree-from-branch, PR creation
- Agent-from-issue workflow
- Desktop app (Tauri) with system tray
- Paid tier launch (Pro + Team)

### Phase 5: Advanced Features (Weeks 21+)
- Voice input (re-integrate Paseo's speech system)
- Codex agent provider
- GitHub Actions integration
- Cross-machine agent orchestration (agent on Machine A spawns agent on Machine B)
- Team features (shared projects, role-based access)
- **Resume handback** (F12.7): release managed session back to foreground CLI
- **Auto-detect running sessions** (F12.9): scan for existing claude processes on daemon startup

---

## 6. Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Base platform | Paseo fork | Saves 6+ months: E2EE relay, mobile app, agent orchestration, provider abstraction already built |
| Event store | GlobalContext (embedded) | Proven append-only store with projections, /recall, search — no external dependencies |
| Encryption | XChaCha20-Poly1305 (libsodium) | 192-bit nonce safety, NaCl compatibility with Paseo's existing crypto, cross-platform WASM |
| KDF | Argon2id | Memory-hard, built into libsodium's crypto_pwhash |
| Sync infrastructure | Cloudflare Workers + DO + R2 | $0.02/user/month, global edge, WebSocket hibernation, EU jurisdiction support |
| DO isolation | One DO per user (all tiers) | Simpler than shared DO, negligible cost difference, natural isolation |
| Mobile key storage | react-native-keychain | More granular control over biometric ACLs than expo-secure-store |
| GitHub integration | GitHub App (not OAuth) | Fine-grained permissions, per-repo scoping, scales with org size |
| Desktop | Tauri 2 | Smaller than Electron, native OS integration, already used by Paseo |
| Multi-instance | git worktree + branch-per-agent | Standard pattern, shared .git, Claude Code native support |
| OpenCode integration | `opencode serve` HTTP API | Official SDK, OpenAPI 3.1 spec, clean separation |
| Session attach mode | Hybrid (observe + managed + resume) | Covers all user workflows: zero-config observation for normal CLI use, full PTY proxy for power users, resume handoff for mobility |
| PTY management | node-pty + @xterm/headless | Proven in Paseo, server-side terminal emulation enables multi-client rendering without PTY sharing |
| Terminal rendering on mobile | xterm.js in WebView + structured view | Dual mode: structured cards for readability (default on phone), raw terminal for fidelity (default on desktop/tablet) |
| Session rendering source | GC hooks (observed) + SDK stream (managed) | Hook-based for zero-friction existing sessions; SDK for real-time streaming with word-by-word output |
| Virtualized timeline | FlashList (RN) + tanstack virtual (web) | Sessions can have 500+ events; must stay smooth at 60fps on phone |
| Diff rendering | react-native-diff (mobile) + custom (web) | Unified diff with syntax highlighting, same visual language as CLI terminal diffs |
