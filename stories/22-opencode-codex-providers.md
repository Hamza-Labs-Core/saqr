# Story 22: OpenCode & Codex Agent Providers

## Overview

Story 3 (Multi-Agent Hook System) and Story 5 (Agent Process Orchestration) defined a unified event system and provider abstraction supporting Claude Code, OpenCode, and Codex. The daemon's provider registry and event types are implemented, but **only Claude Code has a production-quality provider implementation**. OpenCode and Codex providers exist as interfaces and event mappings but lack tested integration with the actual tools.

This story builds production-ready provider implementations for:

1. **OpenCode** — Integrates via `opencode serve` HTTP API (OpenAPI 3.1 spec). The daemon spawns OpenCode in server mode and communicates via REST + SSE.
2. **Codex** — Integrates via Codex's JSONL protocol. The daemon watches session files and parses JSONL events.

Both providers emit the same 12 unified event types as Claude Code, enabling all downstream features (dashboard, mobile, desktop, sync) to work identically regardless of which agent is running.

**Guiding principle**: Provider implementations are thin adapters. They translate provider-specific APIs into our unified event stream. No business logic in the provider — that lives in the daemon's agent manager and event store.

---

## Scope

### In Scope

- OpenCode provider: HTTP client for `opencode serve`, SSE event subscription
- OpenCode hook installer: `saqr install --opencode` sets up plugin directory
- OpenCode event mapping: OpenCode events → 12 unified event types
- OpenCode health check: verify `opencode serve` is running and responsive
- Codex provider: JSONL file watcher, event parser
- Codex hook installer: `saqr install --codex` sets up session file watcher
- Codex event mapping: JSONL events → 12 unified event types
- Codex process management: detect running Codex instances, spawn new ones
- Provider selection UI: agent creation specifies provider (claude/opencode/codex)
- Integration tests with mock servers for both providers
- Error recovery: reconnect on connection loss, retry on transient errors

### Out of Scope

- Aider, Cursor, Windsurf, Cline providers (future — use generic hook F1.7)
- OpenCode voice features
- Codex sandbox/container management
- Provider-specific UI customization (all share the same timeline rendering)

---

## Requirements

### 1. OpenCode Provider

#### Architecture
```
Daemon
  │
  ├─ opencode-provider.ts
  │   ├─ spawn: start `opencode serve` on configured port
  │   ├─ health: GET /health → check readiness
  │   ├─ sessions: GET /sessions → list active sessions
  │   ├─ create: POST /sessions → create new session
  │   ├─ prompt: POST /sessions/:id/messages → send prompt
  │   ├─ stream: SSE /sessions/:id/events → subscribe to events
  │   └─ cancel: POST /sessions/:id/cancel → interrupt
  │
  └─ opencode-event-mapper.ts
      └─ Maps OpenCode events to unified types
```

#### OpenCode Event Mapping

| OpenCode Event | Unified Event Type | Notes |
|----------------|-------------------|-------|
| `session.created` | SessionStarted | Extract session ID, model, project path |
| `message.updated` (role=user) | UserPromptReceived | Extract prompt text |
| `message.updated` (role=assistant) | TurnCompleted | Extract response + token usage |
| `tool.execute.before` | ToolCallRequested | Map tool name + input |
| `tool.execute.after` (success) | ToolCallCompleted | Map tool output |
| `tool.execute.after` (error) | ToolCallFailed | Map error details |
| `session.idle` | TurnCompleted | Session waiting for input |
| `session.compacted` | CompactionTriggered | Context window compacted |
| `session.deleted` | SessionEnded | Session closed |
| `permission.asked` | PermissionRequested | Tool name + file path |
| `permission.replied` | PermissionResponded | Approved/denied + tool use ID |

#### Hook Installation
```bash
saqr install --opencode
```
Creates `.opencode/plugins/saqr/` with:
- `plugin.json`: Plugin manifest pointing to daemon webhook URL
- Sets `OPENCODE_PLUGINS_DIR` if not already set

#### Error Recovery
- SSE connection drops → exponential backoff reconnect (1s, 2s, 4s, max 30s)
- `opencode serve` crashes → restart up to 3 times, then mark agent as error
- HTTP 503 → retry with backoff
- Stale session detection: if no events for 5 min + health check passes → session may have ended externally

### 2. Codex Provider

#### Architecture
```
Daemon
  │
  ├─ codex-provider.ts
  │   ├─ spawn: start `codex` with JSONL output mode
  │   ├─ detect: find running Codex instances via process list
  │   ├─ watch: filesystem watcher on session directory
  │   ├─ parse: JSONL line parser with type discrimination
  │   └─ cancel: send SIGINT to Codex process
  │
  └─ codex-event-mapper.ts
      └─ Maps Codex JSONL events to unified types
```

#### Codex JSONL Event Mapping

| Codex JSONL Type | Unified Event Type | Notes |
|-----------------|-------------------|-------|
| `session_start` | SessionStarted | Process spawned |
| `user_message` | UserPromptReceived | stdin prompt |
| `tool_use` | ToolCallRequested | Tool name + arguments |
| `tool_result` | ToolCallCompleted | Tool output |
| `tool_error` | ToolCallFailed | Tool error message |
| `turn_end` | TurnCompleted | Response text + usage |
| `permission` | PermissionRequested | Tool permission request |
| `permission_response` | PermissionResponded | User response |
| Process exit | SessionEnded | Exit code + cleanup |

#### Session File Watching
- Watch `~/.codex/sessions/` for new `.jsonl` files
- Tail new lines as they're appended (using `fs.watch` + read position tracking)
- Parse each line as JSON, map to unified event
- Handle file rotation / truncation gracefully

#### Process Management
- Spawn: `codex --session-dir ~/.codex/sessions/ --jsonl`
- Detect: scan process list for `codex` processes, match to session files
- Attach: start watching an existing Codex process's session file
- Kill: SIGINT for graceful shutdown, SIGTERM after 5s timeout

#### Error Recovery
- File watcher disconnects → re-watch with polling fallback
- Malformed JSONL line → skip with warning log
- Process crash → detect via exit code, emit SessionEnded with error
- Large JSONL output (>1MB single line) → truncate and warn

### 3. Provider Registry Updates

Update the daemon's provider registry to include OpenCode and Codex:

```typescript
// provider-registry.ts
export const PROVIDERS = {
  'claude-code': ClaudeCodeProvider,
  'opencode': OpenCodeProvider,
  'codex': CodexProvider,
} as const;

export type ProviderId = keyof typeof PROVIDERS;
```

#### Agent Creation
```typescript
// POST /api/agents
{
  "provider": "opencode",  // or "codex" or "claude-code"
  "model": "claude-sonnet-4-6",
  "project": "/path/to/repo",
  "prompt": "Add dark mode support"
}
```

### 4. CLI Commands

```bash
# Install hooks for a specific provider
saqr install --opencode
saqr install --codex
saqr install --claude-code  # existing

# Start agent with specific provider
saqr agent start --provider opencode --project /path/to/repo
saqr agent start --provider codex --project /path/to/repo

# Check provider health
saqr doctor
# Output:
#   claude-code: ✓ Hooks installed, claude CLI found
#   opencode:    ✓ Hooks installed, opencode serve available
#   codex:       ✗ codex CLI not found (install: npm i -g @openai/codex)

# List available providers
saqr providers
# Output:
#   claude-code  Claude Code (Anthropic)    ✓ installed
#   opencode     OpenCode (open-source)     ✓ installed
#   codex        Codex CLI (OpenAI)         ✗ not installed
```

### 5. Provider Health Checks

Each provider implements a `checkHealth()` method:

| Provider | Health Check |
|----------|-------------|
| Claude Code | `which claude` + verify hooks in `~/.claude/settings.json` |
| OpenCode | `which opencode` + verify plugin in `.opencode/plugins/saqr/` |
| Codex | `which codex` + verify session directory exists |

---

## Test Cases

### OpenCode Provider
- TC22.1: Spawn `opencode serve` and verify health check passes
- TC22.2: Create session via HTTP API and receive session ID
- TC22.3: Send prompt and receive SSE events
- TC22.4: Map `session.created` → SessionStarted with correct fields
- TC22.5: Map `tool.execute.before` → ToolCallRequested
- TC22.6: Map `tool.execute.after` (success) → ToolCallCompleted
- TC22.7: Map `tool.execute.after` (error) → ToolCallFailed
- TC22.8: Map `permission.asked` → PermissionRequested
- TC22.9: SSE reconnect after connection drop with backoff
- TC22.10: OpenCode process crash triggers restart (max 3 times)
- TC22.11: Hook installer creates plugin directory correctly
- TC22.12: Health check detects missing `opencode` binary

### Codex Provider
- TC22.13: Watch session directory for new JSONL files
- TC22.14: Parse JSONL line and map to unified event
- TC22.15: Map `tool_use` → ToolCallRequested
- TC22.16: Map `tool_result` → ToolCallCompleted
- TC22.17: Map `tool_error` → ToolCallFailed
- TC22.18: Handle malformed JSONL line gracefully (skip + warn)
- TC22.19: Detect process exit and emit SessionEnded
- TC22.20: Codex process crash emits SessionEnded with error
- TC22.21: Large JSONL output (>1MB) truncated
- TC22.22: Hook installer sets up session directory watcher

### Provider Registry
- TC22.23: Registry lists all 3 providers
- TC22.24: Agent creation with `provider: "opencode"` uses OpenCode provider
- TC22.25: Agent creation with `provider: "codex"` uses Codex provider
- TC22.26: Agent creation with invalid provider returns 400

### CLI Commands
- TC22.27: `saqr install --opencode` creates plugin directory
- TC22.28: `saqr install --codex` verifies codex binary exists
- TC22.29: `saqr doctor` reports correct status per provider
- TC22.30: `saqr providers` lists all with install status

---

## Dependencies

- Story 3 (Hook System): unified event types
- Story 5 (Agent Orchestration): provider registry, agent lifecycle
- OpenCode CLI installed (`npm i -g opencode`)
- Codex CLI installed (`npm i -g @openai/codex`)

## Acceptance Criteria

- [ ] OpenCode provider creates sessions and streams events via SSE
- [ ] Codex provider watches JSONL files and emits unified events
- [ ] All 12 unified event types mapped for both providers
- [ ] Hook installers set up provider-specific configuration
- [ ] `saqr doctor` checks health of all installed providers
- [ ] Error recovery handles connection drops and process crashes
- [ ] Dashboard/mobile/desktop show OpenCode and Codex agents identically to Claude Code
- [ ] 30+ unit tests passing
