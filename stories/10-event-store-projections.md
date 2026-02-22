# Story 10: Event Store & Projections (Enhanced) — Daemon Integration

## Overview

This story covers the **enhanced event store** that integrates the original GlobalContext event store (Stories 01-05) into the AgentContext daemon. The standalone GlobalContext system captures events from Claude Code hooks, stores them as immutable JSON files, and builds projections on demand. This story extends that foundation to support **daemon-integrated event ingestion**, **multi-agent sessions**, **cross-session projections**, **incremental projection builds**, **full-text search**, **live event monitoring**, and **projection caching**.

The standalone GC event pipeline remains fully functional — hooks still fire, `capture-event` still writes files, `gc-query` still reads them. This story adds a **parallel daemon-side path** that watches the event store for changes, receives direct notifications from the hook system, and provides enhanced capabilities that require a long-running process (live streaming, caching, cross-session aggregation).

**Key principle**: The event store on disk remains the single source of truth. The daemon is a **read-side accelerator** — it caches, indexes, and streams, but never owns data that does not also exist on disk. If the daemon restarts, it rebuilds state from the filesystem.

### Relationship to Existing Stories

| Story | Relationship |
|-------|-------------|
| Story 01 (Event Capture) | **Extended** — capture-event gains an optional daemon notification after writing to disk. |
| Story 02 (Hook Integration) | **Unchanged** — hooks fire into gc-hook as before. |
| Story 03 (Storage Layer) | **Extended** — session.json gains multi-agent fields (agent_provider, agent_model). |
| Story 04 (Projection Engine) | **Extended** — new projection types (usage, cross-session), incremental builds with checkpoints. |
| Story 05 (Context Recovery) | **Extended** — /recall works across agent types, cross-machine when sync is available. |
| Story 06 (Plugin Packaging) | **Unchanged** — plugin hooks feed into same pipeline. |

### What This Story Covers (and What It Does Not)

| Concern | Covered Here | Covered Elsewhere |
|---------|:---:|:---:|
| Daemon event bus integration | yes | -- |
| Filesystem watcher for new events | yes | -- |
| Multi-agent session metadata | yes | -- |
| Cross-session projections | yes | -- |
| Usage projections (tokens/model/day) | yes | -- |
| Incremental projection builds | yes | -- |
| Full-text search across sessions | yes | -- |
| Live event monitor (agentctx watch) | yes | -- |
| Projection cache with memory budget | yes | -- |
| Session chaining across agents | yes | -- |
| /recall skill enhancement | yes | -- |
| Core event capture (capture-event) | -- | Story 01 |
| Hook registration | -- | Story 02 |
| Filesystem layout fundamentals | -- | Story 03 |
| Base projection types (timeline, files, decisions, context, summary) | -- | Story 04 |
| gc-query CLI base commands | -- | Story 05 |

---

## Scope

### In Scope

- Daemon event bus: internal pub/sub for event notifications
- Filesystem watcher: inotify/fswatch on `~/.claude-context/events/`
- Dual ingestion: hook writes to disk AND notifies daemon
- Enhanced session.json with agent_provider, agent_model fields
- Cross-session projections (aggregated across sessions within a project)
- Usage projections (token counts per project, model, day)
- Incremental projection engine with checkpoint mechanism
- Full-text search index across all sessions
- `agentctx watch` live event monitor CLI
- WebSocket/SSE subscription for dashboard live streaming
- Projection cache with pre-warming and memory budget
- Session chaining across agent types (Claude Code -> OpenCode)
- Enhanced /recall skill for multi-agent context recovery

### Out of Scope (Non-Goals)

- Cloud sync of events (Story F5)
- Dashboard UI implementation (Story F4)
- Agent process orchestration (Story F3)
- Mobile/desktop app (Stories F6/F7)
- Event retention or cleanup policies
- Schema migration tooling for existing event stores
- Real-time event transformation or filtering on the write path

---

## Requirements

### 1. Daemon-Integrated Event Pipeline (F2.1)

The daemon integrates with the existing event capture pipeline without replacing it. Events flow through two parallel paths: the existing disk write path and a new daemon notification path.

#### Event Flow Architecture

```
Claude Code Session
  │
  ▼ (hook fires)
gc-hook
  │
  ▼ (pipes JSON)
capture-event
  │
  ├──► Write to disk: events/{project-id}/{session-id}/{seq}.json  (existing)
  │
  └──► Notify daemon: UDP localhost:$AGENTCTX_EVENT_PORT              (NEW)
         │
         ▼
   Daemon Event Bus
     │
     ├──► Update in-memory projection cache
     ├──► Push to WebSocket/SSE subscribers
     ├──► Update search index
     └──► Trigger incremental projection rebuild
```

#### Daemon Notification Protocol

After writing an event to disk, `capture-event` sends a lightweight UDP notification to the daemon. UDP is chosen because it is fire-and-forget — if the daemon is not running, the packet is silently dropped and `capture-event` incurs no latency penalty.

**Notification payload** (JSON, single UDP packet, max 1400 bytes):

```json
{
  "type": "event_written",
  "project_id": "my-project-a3f7b2",
  "session_id": "abc123-def456",
  "sequence": 42,
  "event_type": "ToolCallCompleted",
  "timestamp": "2026-02-21T10:30:00.000Z",
  "path": "/home/user/.claude-context/events/my-project-a3f7b2/abc123-def456/000042.json"
}
```

The notification contains enough metadata for the daemon to decide whether to read the full event from disk. For high-frequency events the daemon may batch reads.

#### Filesystem Watcher (Fallback)

If the daemon starts after events have already been written (or if UDP notifications are lost), the daemon also watches the event store directory tree using `inotify` (Linux) or `FSEvents` (macOS):

```typescript
import { watch } from 'fs';
import { EventEmitter } from 'events';

interface EventStoreWatcher {
  /** Start watching the event store for new files */
  start(eventsDir: string): void;

  /** Stop watching */
  stop(): void;

  /** Emitted when a new event file is detected */
  on(event: 'new_event', listener: (filePath: string) => void): this;

  /** Emitted when a new session directory is created */
  on(event: 'new_session', listener: (sessionDir: string) => void): this;
}
```

**Implementation details**:
- Watch `~/.claude-context/events/` recursively for `CREATE` events on `*.json` files
- Debounce: batch file creation events within a 50ms window to avoid per-event overhead
- Ignore `.lock` files and `session.json` updates (only numbered event files trigger processing)
- On startup, scan all session directories for events newer than the daemon's last known checkpoint

#### capture-event Enhancement

The existing `capture-event` script (Story 01) gains a single new block after the event file write, inside the flock scope:

```bash
# --- NEW: Daemon notification (fire-and-forget UDP) ---
if [ -n "$AGENTCTX_EVENT_PORT" ]; then
  _notify_json=$(jq -n -c \
    --arg type "event_written" \
    --arg pid "$project_id" \
    --arg sid "$session_id" \
    --argjson seq "$next_seq" \
    --arg etype "$event_type" \
    --arg ts "$timestamp" \
    --arg path "$SESSION_DIR/${padded}.json" \
    '{type:$type,project_id:$pid,session_id:$sid,sequence:$seq,event_type:$etype,timestamp:$ts,path:$path}')
  echo "$_notify_json" > /dev/udp/127.0.0.1/"$AGENTCTX_EVENT_PORT" 2>/dev/null || true
fi
```

**Requirements**:
- The notification MUST happen after the file write is complete (within the flock scope)
- The notification MUST NOT block or delay `capture-event` — the `|| true` ensures any failure is swallowed
- `AGENTCTX_EVENT_PORT` is set by the daemon when it installs hooks (or by `agentctx install`)
- If `AGENTCTX_EVENT_PORT` is not set, no notification is sent (standalone GC mode)

#### Daemon Event Bus (Internal)

The daemon maintains an internal event bus for distributing events to interested components:

```typescript
interface DaemonEventBus {
  /** Publish an event to all subscribers */
  publish(event: EventEnvelope): void;

  /** Subscribe to events, optionally filtered */
  subscribe(filter: EventFilter, handler: (event: EventEnvelope) => void): Unsubscribe;

  /** Subscribe to events for a specific project */
  subscribeProject(projectId: string, handler: (event: EventEnvelope) => void): Unsubscribe;

  /** Subscribe to events for a specific session */
  subscribeSession(sessionId: string, handler: (event: EventEnvelope) => void): Unsubscribe;
}

interface EventFilter {
  projectId?: string;
  sessionId?: string;
  eventTypes?: string[];
}

type Unsubscribe = () => void;
```

#### Acceptance Criteria

- [ ] `capture-event` sends a UDP notification to `AGENTCTX_EVENT_PORT` after writing an event file
- [ ] If `AGENTCTX_EVENT_PORT` is not set, no notification is sent and the script behaves identically to the original
- [ ] UDP notification does not add more than 5ms to `capture-event` execution time
- [ ] Daemon receives UDP notifications and publishes events to the internal bus
- [ ] Daemon filesystem watcher detects new event files within 200ms of creation
- [ ] Daemon catches up on missed events on startup by scanning event directories
- [ ] If both UDP and filesystem watcher detect the same event, it is deduplicated (by event_id or project_id + session_id + sequence)
- [ ] The event bus supports filtered subscriptions by project, session, and event type
- [ ] Events are delivered to subscribers in order within a session (no reordering)

---

### 2. Per-Session Metadata Enhancement (F2.2)

The existing `session.json` (Amendment 2) is extended with multi-agent fields and real-time update semantics.

#### Enhanced session.json Schema

```json
{
  "session_id": "abc-123",
  "project_id": "my-project-a3f7b2",
  "project_dir": "/home/user/my-project",
  "started_at": "2026-02-21T10:00:00.000Z",
  "source": "manual",
  "model": "claude-opus-4-6",
  "event_count": 142,
  "last_event_at": "2026-02-21T11:30:00.000Z",
  "last_event_type": "TurnCompleted",
  "last_prompt": "Fix the auth bug in handler.ts",
  "ended_at": null,
  "previous_session_id": null,

  "agent_provider": "claude-code",
  "agent_version": "1.0.23",
  "parent_session_id": null,
  "parent_agent_provider": null,
  "token_usage": {
    "input_tokens": 45230,
    "output_tokens": 12870,
    "cache_read_tokens": 8400,
    "cache_write_tokens": 3200
  },
  "tool_call_count": 67,
  "tool_call_errors": 2,
  "compaction_count": 0,
  "tags": []
}
```

#### New Fields

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `agent_provider` | string | SessionStarted | Agent that created this session: `"claude-code"`, `"opencode"`, `"codex"`, `"unknown"` |
| `agent_version` | string \| null | SessionStarted | Version of the agent, if available from hook payload |
| `parent_session_id` | string \| null | SessionStarted | If this session was resumed from another agent type, the originating session ID |
| `parent_agent_provider` | string \| null | SessionStarted | Agent provider of the parent session |
| `token_usage` | object | TurnCompleted | Cumulative token usage for the session |
| `token_usage.input_tokens` | number | TurnCompleted | Total input tokens consumed |
| `token_usage.output_tokens` | number | TurnCompleted | Total output tokens consumed |
| `token_usage.cache_read_tokens` | number | TurnCompleted | Total cache read tokens |
| `token_usage.cache_write_tokens` | number | TurnCompleted | Total cache write tokens |
| `tool_call_count` | number | ToolCallCompleted | Total number of completed tool calls |
| `tool_call_errors` | number | ToolCallFailed | Total number of failed tool calls |
| `compaction_count` | number | CompactionTriggered | Number of compactions during this session |
| `tags` | string[] | User-set | Optional user-defined tags for categorization |

#### Update Rules

The session.json is updated within the existing flock scope in `capture-event`. Each event type triggers specific field updates:

| Event Type | Fields Updated |
|------------|---------------|
| SessionStarted | All initial fields set: `session_id`, `project_id`, `project_dir`, `started_at`, `source`, `model`, `agent_provider`, `agent_version`, `parent_session_id`, `parent_agent_provider` |
| UserPromptReceived | `last_prompt`, `event_count`, `last_event_at`, `last_event_type` |
| ToolCallCompleted | `tool_call_count` (increment), `event_count`, `last_event_at`, `last_event_type` |
| ToolCallFailed | `tool_call_errors` (increment), `event_count`, `last_event_at`, `last_event_type` |
| TurnCompleted | `token_usage` (accumulate from `data.usage` if present), `event_count`, `last_event_at`, `last_event_type` |
| CompactionTriggered | `compaction_count` (increment), `event_count`, `last_event_at`, `last_event_type` |
| SessionEnded | `ended_at`, `event_count`, `last_event_at`, `last_event_type` |
| (all others) | `event_count`, `last_event_at`, `last_event_type` |

#### Agent Provider Detection

The `agent_provider` is determined from the SessionStarted event payload:

```bash
# In capture-event, during SessionStarted processing
agent_provider="unknown"
if echo "$payload" | jq -e '.hook_type' &>/dev/null; then
  # Claude Code hooks include a hook_type field
  agent_provider="claude-code"
elif echo "$payload" | jq -e '.opencode_plugin' &>/dev/null; then
  agent_provider="opencode"
elif echo "$payload" | jq -e '.codex_protocol' &>/dev/null; then
  agent_provider="codex"
fi
```

The daemon side has a richer detection mechanism using the hook installation source:

```typescript
function detectAgentProvider(event: EventEnvelope): AgentProvider {
  const data = event.data;

  // Claude Code: hooks provide specific fields
  if (data.hook_type || data.model?.startsWith('claude-')) {
    return 'claude-code';
  }

  // OpenCode: events routed through OpenCode plugin
  if (data.opencode_plugin || data.provider === 'opencode') {
    return 'opencode';
  }

  // Codex: JSONL protocol events
  if (data.codex_protocol || data.codex_session_id) {
    return 'codex';
  }

  return 'unknown';
}
```

#### Token Usage Accumulation

Token usage is extracted from TurnCompleted events. The `data.usage` field (when present) contains per-turn token counts:

```typescript
interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function accumulateTokenUsage(
  current: SessionTokenUsage,
  turnUsage: TurnUsage
): SessionTokenUsage {
  return {
    input_tokens: current.input_tokens + (turnUsage.input_tokens || 0),
    output_tokens: current.output_tokens + (turnUsage.output_tokens || 0),
    cache_read_tokens: current.cache_read_tokens + (turnUsage.cache_read_input_tokens || 0),
    cache_write_tokens: current.cache_write_tokens + (turnUsage.cache_creation_input_tokens || 0),
  };
}
```

#### Acceptance Criteria

- [ ] session.json includes all new fields (`agent_provider`, `agent_version`, `parent_session_id`, `parent_agent_provider`, `token_usage`, `tool_call_count`, `tool_call_errors`, `compaction_count`, `tags`)
- [ ] `agent_provider` is correctly detected for Claude Code, OpenCode, and Codex sessions
- [ ] `token_usage` accumulates across multiple TurnCompleted events within a session
- [ ] `tool_call_count` increments on every ToolCallCompleted event
- [ ] `tool_call_errors` increments on every ToolCallFailed event
- [ ] `compaction_count` increments on every CompactionTriggered event
- [ ] All updates happen within the existing flock scope (no additional lock contention)
- [ ] Missing `data.usage` in TurnCompleted does not crash or corrupt session.json
- [ ] Existing session.json files without new fields remain readable (backward compatibility)

---

### 3. Multi-Agent Project Organization (F2.3)

The existing project organization (`events/{project-id}/{session-id}/`) naturally supports multi-agent sessions. Sessions from different agent types that operate on the same project directory end up in the same project directory because the project-id is derived from the working directory path, not the agent type.

#### Directory Layout (Multi-Agent)

```
~/.claude-context/events/my-project-a3f7b2/
  ├── cc-session-001/              # Claude Code session
  │   ├── session.json             # agent_provider: "claude-code"
  │   ├── 000001.json
  │   └── ...
  ├── oc-session-002/              # OpenCode session (same project)
  │   ├── session.json             # agent_provider: "opencode"
  │   ├── 000001.json
  │   └── ...
  └── cc-session-003/              # Claude Code session (resumed from OpenCode)
      ├── session.json             # agent_provider: "claude-code", parent_session_id: "oc-session-002"
      ├── 000001.json
      └── ...
```

#### Project-Level Metadata

The daemon maintains an in-memory project index that aggregates across all sessions:

```typescript
interface ProjectIndex {
  projectId: string;
  projectDir: string;
  sessions: ProjectSessionEntry[];
  totalEvents: number;
  totalTokenUsage: TokenUsage;
  agentProviders: Set<string>;
  firstSessionAt: string;
  lastSessionAt: string;
}

interface ProjectSessionEntry {
  sessionId: string;
  agentProvider: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  tokenUsage: TokenUsage;
  model: string;
}
```

This index is built by scanning `session.json` files on daemon startup and kept current via the event bus.

#### Per-Agent Session Listing

The `agentctx sessions` command and API support filtering by agent provider:

```bash
# List all sessions for current project
agentctx sessions

# List only Claude Code sessions
agentctx sessions --agent claude-code

# List only OpenCode sessions
agentctx sessions --agent opencode

# List sessions across all projects
agentctx sessions --all-projects
```

#### Acceptance Criteria

- [ ] Sessions from different agent types for the same project directory are stored under the same project-id directory
- [ ] `session.json` for each session contains the correct `agent_provider` field
- [ ] Project-level metadata correctly aggregates across all sessions regardless of agent type
- [ ] Session listing can be filtered by `agent_provider`
- [ ] The `latest` symlink at `projections/{project-id}/latest` points to the most recent session regardless of agent type
- [ ] Cross-agent session counts and token totals are correctly summed in the project index

---

### 4. Enhanced Projection Types (F2.4)

This story adds two new projection types to the existing five and introduces the concept of cross-session projections.

#### Existing Projections (from Story 04 — unchanged)

| Type | File | Description |
|------|------|-------------|
| timeline | `timeline.json` | Ordered event summary |
| files | `files-touched.json` | All files interacted with |
| decisions | `decisions.json` | User prompt -> action chains |
| context | `context.json` | Full reconstructable state |
| summary | `summary.json` | High-level session summary |

#### New Per-Session Projection: Usage

Tracks token consumption and cost per turn within a session.

**Output Schema**:

```json
{
  "_projection_type": "usage",
  "_projection_version": 1,
  "_last_sequence": 142,
  "_rebuilt_at": "2026-02-21T10:45:00.000Z",
  "_session_id": "abc123",
  "model": "claude-opus-4-6",
  "agent_provider": "claude-code",
  "turns": [
    {
      "turn_number": 1,
      "sequence": 15,
      "timestamp": "2026-02-21T10:05:00.000Z",
      "input_tokens": 3200,
      "output_tokens": 850,
      "cache_read_tokens": 1200,
      "cache_write_tokens": 400,
      "tool_calls": 3,
      "prompt_preview": "Fix the auth bug..."
    }
  ],
  "totals": {
    "input_tokens": 45230,
    "output_tokens": 12870,
    "cache_read_tokens": 8400,
    "cache_write_tokens": 3200,
    "total_tokens": 69700,
    "turns": 12,
    "tool_calls": 67,
    "tool_errors": 2,
    "estimated_cost_usd": 0.42
  },
  "by_tool": {
    "Read": { "calls": 25, "errors": 0 },
    "Write": { "calls": 8, "errors": 0 },
    "Edit": { "calls": 15, "errors": 1 },
    "Bash": { "calls": 12, "errors": 1 },
    "Grep": { "calls": 5, "errors": 0 },
    "Glob": { "calls": 2, "errors": 0 }
  }
}
```

**Cost Estimation**:

```typescript
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  'claude-sonnet-4-20250514': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  // Additional models added as needed
};

function estimateCost(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-20250514'];
  return (
    (usage.input_tokens * pricing.inputPerMillion) / 1_000_000 +
    (usage.output_tokens * pricing.outputPerMillion) / 1_000_000 +
    (usage.cache_read_tokens * pricing.cacheReadPerMillion) / 1_000_000 +
    (usage.cache_write_tokens * pricing.cacheWritePerMillion) / 1_000_000
  );
}
```

#### New Cross-Session Projections

Cross-session projections aggregate data across multiple sessions within a project. They are stored at the project level rather than the session level:

```
~/.claude-context/projections/my-project-a3f7b2/
  ├── latest -> cc-session-003
  ├── cc-session-001/
  │   ├── timeline.json
  │   ├── usage.json
  │   └── ...
  ├── cross-session/
  │   ├── usage-daily.json        # Per-day token usage aggregation
  │   ├── usage-by-model.json     # Per-model aggregation
  │   ├── files-aggregate.json    # All files across all sessions
  │   └── session-chain.json      # Session chain graph
  └── _checkpoint.json            # Cross-session build checkpoint
```

#### Cross-Session Usage Projection (usage-daily.json)

```json
{
  "_projection_type": "usage-daily",
  "_projection_version": 1,
  "_rebuilt_at": "2026-02-21T23:59:00.000Z",
  "_project_id": "my-project-a3f7b2",
  "days": [
    {
      "date": "2026-02-21",
      "sessions": 3,
      "turns": 45,
      "input_tokens": 125000,
      "output_tokens": 38000,
      "cache_read_tokens": 22000,
      "cache_write_tokens": 8500,
      "total_tokens": 193500,
      "estimated_cost_usd": 1.85,
      "by_model": {
        "claude-opus-4-6": {
          "sessions": 2,
          "input_tokens": 95000,
          "output_tokens": 30000,
          "estimated_cost_usd": 1.62
        },
        "claude-sonnet-4-20250514": {
          "sessions": 1,
          "input_tokens": 30000,
          "output_tokens": 8000,
          "estimated_cost_usd": 0.23
        }
      },
      "by_agent": {
        "claude-code": { "sessions": 2, "total_tokens": 153500 },
        "opencode": { "sessions": 1, "total_tokens": 40000 }
      }
    }
  ],
  "totals": {
    "days_active": 14,
    "total_sessions": 42,
    "total_tokens": 2450000,
    "estimated_total_cost_usd": 28.50
  }
}
```

#### Cross-Session Usage By Model (usage-by-model.json)

```json
{
  "_projection_type": "usage-by-model",
  "_projection_version": 1,
  "_rebuilt_at": "2026-02-21T23:59:00.000Z",
  "_project_id": "my-project-a3f7b2",
  "models": {
    "claude-opus-4-6": {
      "sessions": 30,
      "total_tokens": 1800000,
      "input_tokens": 1200000,
      "output_tokens": 450000,
      "cache_read_tokens": 100000,
      "cache_write_tokens": 50000,
      "estimated_cost_usd": 22.50,
      "first_used": "2026-02-01T09:00:00.000Z",
      "last_used": "2026-02-21T18:00:00.000Z"
    },
    "claude-sonnet-4-20250514": {
      "sessions": 12,
      "total_tokens": 650000,
      "input_tokens": 450000,
      "output_tokens": 150000,
      "cache_read_tokens": 30000,
      "cache_write_tokens": 20000,
      "estimated_cost_usd": 6.00,
      "first_used": "2026-02-05T14:00:00.000Z",
      "last_used": "2026-02-20T11:00:00.000Z"
    }
  }
}
```

#### Cross-Session Files Aggregate (files-aggregate.json)

```json
{
  "_projection_type": "files-aggregate",
  "_projection_version": 1,
  "_rebuilt_at": "2026-02-21T23:59:00.000Z",
  "_project_id": "my-project-a3f7b2",
  "files": [
    {
      "path": "/home/user/my-project/src/auth.ts",
      "sessions_touched": ["cc-session-001", "cc-session-003"],
      "total_operations": 12,
      "operations_by_type": { "read": 5, "edit": 4, "write": 3 },
      "first_touched": "2026-02-15T10:00:00.000Z",
      "last_touched": "2026-02-21T16:30:00.000Z"
    }
  ],
  "stats": {
    "total_unique_files": 87,
    "total_operations": 342,
    "most_touched_file": "/home/user/my-project/src/auth.ts"
  }
}
```

#### TypeScript Interfaces for Projection Types

```typescript
/** Base metadata present on all projections */
interface ProjectionMeta {
  _projection_type: string;
  _projection_version: number;
  _rebuilt_at: string;
}

/** Per-session projection metadata */
interface SessionProjectionMeta extends ProjectionMeta {
  _session_id: string;
  _last_sequence: number;
}

/** Cross-session projection metadata */
interface CrossSessionProjectionMeta extends ProjectionMeta {
  _project_id: string;
}

/** Per-session usage projection */
interface UsageProjection extends SessionProjectionMeta {
  _projection_type: 'usage';
  model: string;
  agent_provider: string;
  turns: UsageTurn[];
  totals: UsageTotals;
  by_tool: Record<string, { calls: number; errors: number }>;
}

interface UsageTurn {
  turn_number: number;
  sequence: number;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  prompt_preview: string;
}

interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  estimated_cost_usd: number;
}

/** Cross-session daily usage projection */
interface UsageDailyProjection extends CrossSessionProjectionMeta {
  _projection_type: 'usage-daily';
  days: DailyUsage[];
  totals: {
    days_active: number;
    total_sessions: number;
    total_tokens: number;
    estimated_total_cost_usd: number;
  };
}

interface DailyUsage {
  date: string;
  sessions: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  by_model: Record<string, ModelDayUsage>;
  by_agent: Record<string, { sessions: number; total_tokens: number }>;
}

interface ModelDayUsage {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

/** Cross-session files aggregate projection */
interface FilesAggregateProjection extends CrossSessionProjectionMeta {
  _projection_type: 'files-aggregate';
  files: AggregateFileEntry[];
  stats: {
    total_unique_files: number;
    total_operations: number;
    most_touched_file: string;
  };
}

interface AggregateFileEntry {
  path: string;
  sessions_touched: string[];
  total_operations: number;
  operations_by_type: Record<string, number>;
  first_touched: string;
  last_touched: string;
}
```

#### Acceptance Criteria

- [ ] Usage projection is built per-session with per-turn token breakdowns
- [ ] Cost estimation uses correct pricing for the session's model
- [ ] Cross-session usage-daily projection aggregates token counts per day across all sessions in a project
- [ ] Cross-session usage-by-model projection shows per-model totals
- [ ] Cross-session files-aggregate projection lists all files touched across all sessions
- [ ] Cross-session projections are stored at `projections/{project-id}/cross-session/`
- [ ] All projections follow the `_projection_type`, `_projection_version`, `_rebuilt_at` metadata convention
- [ ] Projections handle sessions from different agent providers correctly
- [ ] Cost estimates are within 5% of actual API billing (for known models)

---

### 5. Incremental Projections (F2.5)

Projections must be buildable incrementally to avoid re-reading the entire event history on every build. This is critical for projects with thousands of events across many sessions.

#### Checkpoint Mechanism

Each projection maintains a checkpoint that records the last processed event. On the next build, only events after the checkpoint are processed.

**Per-session checkpoint** (embedded in the projection file):

```json
{
  "_projection_type": "timeline",
  "_projection_version": 1,
  "_last_sequence": 142,
  "_rebuilt_at": "2026-02-21T10:45:00.000Z",
  "_session_id": "abc123",
  "_checkpoint": {
    "last_processed_sequence": 142,
    "last_processed_event_id": "550e8400-e29b-41d4-a716-446655440000",
    "projection_hash": "a1b2c3d4"
  },
  "entries": [ ]
}
```

**Cross-session checkpoint** (separate file):

```json
{
  "project_id": "my-project-a3f7b2",
  "last_build_at": "2026-02-21T23:59:00.000Z",
  "sessions_processed": {
    "cc-session-001": { "last_sequence": 85, "event_count": 85 },
    "oc-session-002": { "last_sequence": 42, "event_count": 42 },
    "cc-session-003": { "last_sequence": 15, "event_count": 15 }
  },
  "projection_version": 1
}
```

#### Incremental Build Algorithm

```
1. Load existing projection file (if present)
2. Read checkpoint from projection metadata
3. If --rebuild flag is set:
     a. Discard existing projection data
     b. Set checkpoint to sequence 0
4. Determine new events: list *.json files with sequence > checkpoint.last_processed_sequence
5. If no new events: return existing projection unchanged
6. For each new event (in sequence order):
     a. Apply event to projection accumulator
     b. Update checkpoint
7. Write updated projection file with new checkpoint
8. Return updated projection
```

For cross-session projections:

```
1. Load _checkpoint.json for the project
2. For each session directory under events/{project-id}/:
     a. Read session.json to get event_count
     b. Compare with checkpoint.sessions_processed[session_id].event_count
     c. If new events exist, process them
     d. If session is not in checkpoint, process all events
3. Rebuild aggregation from accumulated per-session data
4. Write updated cross-session projection files
5. Write updated _checkpoint.json
```

#### Projection Invalidation

Projections must be invalidated when the projection schema changes (version bump):

```typescript
function shouldRebuild(existing: ProjectionMeta | null, targetVersion: number): boolean {
  if (!existing) return true;
  if (existing._projection_version < targetVersion) return true;
  return false;
}
```

When a projection version changes:
1. The projection engine detects the version mismatch
2. The existing projection is discarded
3. A full rebuild is triggered automatically
4. The new projection is written with the updated version

#### Performance Targets

| Operation | Target | Hard Limit |
|-----------|--------|------------|
| Incremental build (10 new events) | < 50ms | 200ms |
| Incremental build (100 new events) | < 200ms | 1s |
| Full rebuild (1000 events) | < 2s | 10s |
| Cross-session rebuild (50 sessions, 10000 events) | < 10s | 60s |

#### Acceptance Criteria

- [ ] Projections include a `_checkpoint` field tracking the last processed sequence
- [ ] Incremental builds only read event files newer than the checkpoint
- [ ] A projection with 1000 existing events and 10 new events rebuilds in under 200ms
- [ ] `--rebuild` flag forces a full rebuild from sequence 1
- [ ] Cross-session projections track per-session checkpoints in `_checkpoint.json`
- [ ] Schema version changes trigger automatic full rebuilds
- [ ] Projection files are atomically written (write to temp file, then rename)
- [ ] Corrupted projection files are detected and trigger a full rebuild
- [ ] Incremental builds produce identical results to full rebuilds (deterministic)

---

### 6. Session Chaining (F2.6)

Session chaining allows context to flow across session boundaries, including across different agent types. A session chain represents a logical task that spans multiple sessions.

#### Chain Structure

```
Session A (Claude Code, manual start)
  │
  ├── Compaction triggers new session
  ▼
Session B (Claude Code, source: compact, parent: A)
  │
  ├── User switches to OpenCode for same project
  ▼
Session C (OpenCode, manual start, parent: B)
  │
  ├── User resumes in Claude Code
  ▼
Session D (Claude Code, source: resume, parent: C)
```

Each session carries a `parent_session_id` field (and optionally `parent_agent_provider`) that links it to the previous session in the chain.

#### Chain Resolution

```typescript
interface SessionChain {
  /** Ordered list of sessions from root to current */
  sessions: SessionChainEntry[];

  /** Total events across all sessions in the chain */
  totalEvents: number;

  /** Total duration from first session start to last event */
  totalDuration: string;

  /** Agent providers used across the chain */
  agentProviders: string[];
}

interface SessionChainEntry {
  sessionId: string;
  agentProvider: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  parentSessionId: string | null;
  source: string;
}

/**
 * Resolve the full session chain for a given session.
 * Walks parent_session_id links backward to find the root,
 * then returns the chain in chronological order.
 */
async function resolveSessionChain(
  sessionId: string,
  projectId: string,
  eventsDir: string
): Promise<SessionChain> {
  const chain: SessionChainEntry[] = [];
  let currentId: string | null = sessionId;

  // Walk backward to root
  while (currentId) {
    const sessionDir = path.join(eventsDir, projectId, currentId);
    const sessionJson = await readSessionJson(sessionDir);
    if (!sessionJson) break;

    chain.unshift({
      sessionId: currentId,
      agentProvider: sessionJson.agent_provider || 'unknown',
      model: sessionJson.model || 'unknown',
      startedAt: sessionJson.started_at,
      endedAt: sessionJson.ended_at,
      eventCount: sessionJson.event_count,
      parentSessionId: sessionJson.parent_session_id || sessionJson.previous_session_id,
      source: sessionJson.source || 'unknown',
    });

    currentId = sessionJson.parent_session_id || sessionJson.previous_session_id || null;
  }

  return {
    sessions: chain,
    totalEvents: chain.reduce((sum, s) => sum + s.eventCount, 0),
    totalDuration: computeDuration(chain[0]?.startedAt, chain[chain.length - 1]?.endedAt),
    agentProviders: [...new Set(chain.map(s => s.agentProvider))],
  };
}
```

#### Cross-Agent Session Chain Graph (session-chain.json)

Stored as a cross-session projection:

```json
{
  "_projection_type": "session-chain",
  "_projection_version": 1,
  "_rebuilt_at": "2026-02-21T23:59:00.000Z",
  "_project_id": "my-project-a3f7b2",
  "chains": [
    {
      "chain_id": "chain-001",
      "root_session_id": "cc-session-001",
      "sessions": [
        {
          "session_id": "cc-session-001",
          "agent_provider": "claude-code",
          "model": "claude-opus-4-6",
          "started_at": "2026-02-20T09:00:00.000Z",
          "ended_at": "2026-02-20T11:30:00.000Z",
          "event_count": 85,
          "source": "manual"
        },
        {
          "session_id": "oc-session-002",
          "agent_provider": "opencode",
          "model": "claude-sonnet-4-20250514",
          "started_at": "2026-02-20T13:00:00.000Z",
          "ended_at": "2026-02-20T14:00:00.000Z",
          "event_count": 42,
          "source": "manual",
          "parent_session_id": "cc-session-001"
        }
      ],
      "total_events": 127,
      "agent_providers": ["claude-code", "opencode"],
      "started_at": "2026-02-20T09:00:00.000Z",
      "last_activity_at": "2026-02-20T14:00:00.000Z"
    }
  ],
  "orphan_sessions": ["cc-session-099"]
}
```

#### Acceptance Criteria

- [ ] `parent_session_id` in session.json correctly links to the previous session
- [ ] `resolveSessionChain()` walks the parent chain and returns sessions in chronological order
- [ ] Chains work across agent types (Claude Code session -> OpenCode session -> Claude Code session)
- [ ] Chains handle missing parent sessions gracefully (broken link = chain starts at the orphan)
- [ ] The session-chain.json cross-session projection is built and updated incrementally
- [ ] Circular chain references are detected and broken (max chain depth: 100)
- [ ] `agentctx sessions --chain <session-id>` displays the full chain for a session

---

### 7. /recall Skill Enhancement (F2.7)

The `/recall` skill (from Story 05 as `gc-query last`) is enhanced to work across all agent types and optionally across machines when sync is available.

#### Multi-Agent Recall

When `/recall` is invoked, it now considers sessions from all agent types, not just the current one:

```typescript
interface RecallOptions {
  /** Scope: current project (default) or all projects */
  scope: 'project' | 'all';

  /** Include sessions from all agent types, not just the current one */
  crossAgent: boolean;

  /** Follow session chains to include parent context */
  includeChain: boolean;

  /** Maximum number of sessions to include */
  maxSessions: number;

  /** Maximum total events to include across all sessions */
  maxEvents: number;

  /** Include sessions from other machines (requires sync) */
  crossMachine: boolean;
}
```

#### Recall Flow (Enhanced)

```
User invokes /recall
  │
  ├── 1. Determine current project-id from cwd
  ├── 2. Find the latest session(s) for this project
  │      - If crossAgent: include sessions from all agent types
  │      - Sort by last_event_at descending
  ├── 3. If includeChain: resolve session chain for the latest session
  ├── 4. For each session in scope:
  │      a. Load or build the context projection
  │      b. If session is from a different agent type, note it in the output
  ├── 5. If crossMachine and sync is available:
  │      a. Query sync server for sessions from other machines
  │      b. Decrypt and merge remote context
  ├── 6. Format combined context as markdown
  └── 7. Return to the agent for injection into the conversation
```

#### Cross-Agent Context Format

When recall includes sessions from different agent types, the context output makes this clear:

```markdown
## Previous Context (Recalled)

### Session cc-session-003 (Claude Code, claude-opus-4-6)
*2026-02-21 10:00 - 11:30 (85 events)*

**Last prompt**: Fix the auth bug in handler.ts

**Key decisions**:
- Chose JWT refresh token approach over session cookies
- Added rate limiting to /api/auth endpoint

**Files modified**: src/auth.ts, src/middleware/rateLimit.ts, tests/auth.test.ts

---

### Session oc-session-002 (OpenCode, claude-sonnet-4-20250514)
*2026-02-20 13:00 - 14:00 (42 events)*
*Note: This session was created with a different agent (OpenCode)*

**Last prompt**: Review the auth changes and add integration tests

**Key decisions**:
- Added Redis-backed session store for horizontal scaling
- Created test fixtures for JWT token generation

**Files modified**: src/session-store.ts, tests/integration/auth.integration.test.ts
```

#### Acceptance Criteria

- [ ] `/recall` returns context from the most recent session regardless of agent type
- [ ] Cross-agent context clearly identifies which agent type and model were used
- [ ] Session chain recall follows `parent_session_id` links across agent boundaries
- [ ] When sync is not available, cross-machine recall fails gracefully with a message
- [ ] Recall output is formatted as markdown suitable for injection into any agent conversation
- [ ] Recall performance: under 2 seconds for a single session, under 5 seconds with chain (up to 5 sessions)
- [ ] Recall gracefully handles sessions with missing or corrupted projection files

---

### 8. Full-Text Search (F2.8)

Full-text search allows finding information across all sessions by keyword, event type, or file path.

#### Search Architecture

The search system uses a two-tier approach:

1. **Simple grep-based search** (always available, no daemon required): Scans event files directly using `grep` or `jq` for exact and regex matching. Works in standalone GC mode.

2. **Inverted index search** (daemon-only, optional): The daemon maintains an in-memory inverted index for fast keyword lookups. Built on startup, updated incrementally via the event bus.

#### Search Index Structure

```typescript
interface SearchIndex {
  /** Total number of indexed events */
  totalEvents: number;

  /** Index build timestamp */
  builtAt: string;

  /** Inverted index: token -> list of locations */
  tokens: Map<string, SearchLocation[]>;

  /** File path index: normalized path -> list of locations */
  filePaths: Map<string, SearchLocation[]>;

  /** Tool name index: tool name -> list of locations */
  toolNames: Map<string, SearchLocation[]>;
}

interface SearchLocation {
  projectId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  field: string;  // Which field the match was in: "prompt", "tool_input", "tool_response", "file_path"
  timestamp: string;
}

interface SearchResult {
  locations: SearchResultEntry[];
  totalMatches: number;
  searchTime: number;  // milliseconds
}

interface SearchResultEntry {
  projectId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  field: string;
  timestamp: string;
  snippet: string;       // 80 chars of context around the match
  agentProvider: string;
  model: string;
}
```

#### Indexing Strategy

Events are indexed selectively based on field relevance:

| Event Type | Fields Indexed | Tokenization |
|------------|---------------|--------------|
| UserPromptReceived | `data.prompt` | Full-text (whitespace + punctuation split, lowercased) |
| ToolCallRequested | `data.tool_name`, `data.tool_input.file_path`, `data.tool_input.command`, `data.tool_input.pattern` | Tool name exact, paths normalized, command tokenized |
| ToolCallCompleted | `data.tool_name`, `data.tool_input.file_path`, `data.tool_response` (first 500 chars) | Same as above, response limited to prevent index bloat |
| ToolCallFailed | `data.tool_name`, `data.error` | Tool name exact, error message tokenized |
| SessionStarted | `data.cwd`, `data.model` | Path components, model name exact |

**Tokenization rules**:
- Split on whitespace and common punctuation: `[ \t\n\r,.;:!?(){}[\]"'/\\|<>@#$%^&*+=~` + backtick ]
- Lowercase all tokens
- Minimum token length: 2 characters
- Maximum token length: 100 characters
- Do not index stop words (the, a, an, is, are, was, were, etc.)
- File paths are indexed as both the full path and individual path components

#### Search API

```typescript
interface SearchAPI {
  /** Full-text keyword search */
  search(query: string, options?: SearchOptions): Promise<SearchResult>;

  /** Search by file path (partial match) */
  searchByFile(pathPattern: string, options?: SearchOptions): Promise<SearchResult>;

  /** Search by tool name */
  searchByTool(toolName: string, options?: SearchOptions): Promise<SearchResult>;
}

interface SearchOptions {
  /** Limit to specific project */
  projectId?: string;

  /** Limit to specific session */
  sessionId?: string;

  /** Limit to specific event types */
  eventTypes?: string[];

  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean;

  /** Maximum results to return (default: 50) */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Date range filter */
  since?: string;
  until?: string;

  /** Agent provider filter */
  agentProvider?: string;
}
```

#### CLI Interface

```bash
# Keyword search across current project
agentctx search "why did we choose PostgreSQL"

# Search across all projects
agentctx search "PostgreSQL" --all-projects

# Search only prompts
agentctx search "auth bug" --type UserPromptReceived

# Search by file path
agentctx search --file "auth.ts"

# Search by tool
agentctx search --tool Bash --since 2026-02-20

# Search with agent filter
agentctx search "migration" --agent opencode

# Standalone mode (no daemon, uses grep)
gc-query search "PostgreSQL"
```

#### Performance at Scale

| Scale | Grep-based | Inverted Index |
|-------|-----------|----------------|
| 100 sessions, 10K events | < 5s | < 100ms |
| 500 sessions, 50K events | < 30s | < 200ms |
| 1000 sessions, 100K events | > 60s (impractical) | < 500ms |

The inverted index consumes approximately 50-100 bytes per indexed event. For 100K events, the index is approximately 5-10MB in memory.

#### Acceptance Criteria

- [ ] Keyword search returns matching events across all sessions in the current project
- [ ] `--all-projects` flag searches across all projects
- [ ] Search results include a context snippet (80 characters around the match)
- [ ] Search results are sorted by relevance (number of token matches) then by timestamp
- [ ] File path search matches partial paths (e.g., "auth.ts" matches "/home/user/project/src/auth.ts")
- [ ] Tool name search returns all events for that tool
- [ ] Case-insensitive search by default, `--case-sensitive` flag for exact matching
- [ ] Inverted index search completes in under 500ms for 100K events
- [ ] Grep-based fallback works without the daemon running
- [ ] Search handles special characters in queries without crashing (quotes, backslashes, regex metacharacters)
- [ ] Pagination via `--limit` and `--offset` works correctly
- [ ] Empty search results return exit code 0 with "No results found" message

---

### 9. Live Event Monitor (F2.9)

The live event monitor provides real-time tailing of events as they arrive, both via CLI and via WebSocket/SSE for the dashboard.

#### CLI: `agentctx watch`

```bash
# Watch all events for the current project
agentctx watch

# Watch specific session
agentctx watch --session abc123

# Watch specific event types
agentctx watch --type ToolCallCompleted --type ToolCallFailed

# Watch all projects
agentctx watch --all-projects

# Watch with JSON output (for piping)
agentctx watch --format json

# Watch with verbose output (full payloads)
agentctx watch --verbose

# Watch specific agent type
agentctx watch --agent opencode
```

#### CLI Output Format (Default Text)

```
[10:30:15.123] my-project | cc-session-001 | SessionStarted
  Model: claude-opus-4-6, Source: manual

[10:30:20.456] my-project | cc-session-001 | UserPromptReceived
  Fix the auth bug in handler.ts

[10:30:21.789] my-project | cc-session-001 | ToolCallRequested
  Read: /home/user/project/src/handler.ts

[10:30:22.012] my-project | cc-session-001 | ToolCallCompleted
  Read: 150 lines from handler.ts

[10:30:25.345] my-project | cc-session-001 | ToolCallRequested
  Edit: /home/user/project/src/handler.ts (replacing 3 lines)

[10:30:25.567] my-project | cc-session-001 | ToolCallCompleted
  Edit: handler.ts updated

[10:30:30.890] my-project | cc-session-001 | TurnCompleted
  Tokens: 3200 in / 850 out | Cost: ~$0.03
```

#### CLI Output Format (JSON)

One JSON object per line (JSONL), suitable for piping to `jq`:

```json
{"timestamp":"2026-02-21T10:30:15.123Z","project_id":"my-project-a3f7b2","session_id":"cc-session-001","event_type":"SessionStarted","sequence":1,"summary":"Session started (model: claude-opus-4-6)"}
```

#### Watch Implementation

The watch command connects to the daemon's event bus via a local Unix domain socket or HTTP SSE endpoint:

```typescript
interface WatchConnection {
  /** Connect to daemon event stream */
  connect(options: WatchOptions): AsyncGenerator<WatchEvent>;

  /** Graceful disconnect */
  disconnect(): void;
}

interface WatchOptions {
  projectId?: string;
  sessionId?: string;
  eventTypes?: string[];
  agentProvider?: string;
  allProjects?: boolean;
  format: 'text' | 'json' | 'verbose';
}

interface WatchEvent {
  timestamp: string;
  projectId: string;
  projectName: string;  // basename portion of project-id for display
  sessionId: string;
  eventType: string;
  sequence: number;
  summary: string;
  agentProvider: string;
  data?: Record<string, unknown>;  // Full payload (only in verbose mode)
}
```

#### Fallback: Standalone Watch (No Daemon)

When the daemon is not running, `agentctx watch` falls back to polling the filesystem:

```bash
# Standalone fallback: poll every 500ms
gc-query watch --poll-interval 500
```

The standalone watch polls the event store for new files using `ls` with timestamp comparison. This is less efficient than inotify-based watching but works without a daemon.

#### WebSocket/SSE Subscription (Dashboard)

The daemon exposes event streams for the dashboard via Server-Sent Events (SSE) on the HTTP API:

```
GET /api/events/stream?project_id=my-project-a3f7b2
GET /api/events/stream?session_id=abc123
GET /api/events/stream?event_type=ToolCallCompleted&event_type=ToolCallFailed
GET /api/events/stream
```

**SSE Protocol**:

```
event: event
data: {"timestamp":"2026-02-21T10:30:15.123Z","project_id":"my-project-a3f7b2","session_id":"cc-session-001","event_type":"SessionStarted","sequence":1,"summary":"Session started"}

event: event
data: {"timestamp":"2026-02-21T10:30:20.456Z","project_id":"my-project-a3f7b2","session_id":"cc-session-001","event_type":"UserPromptReceived","sequence":2,"summary":"User: Fix the auth bug..."}

event: heartbeat
data: {"timestamp":"2026-02-21T10:30:30.000Z"}
```

**WebSocket Protocol** (alternative to SSE):

```json
// Client -> Server: Subscribe
{ "type": "subscribe", "filter": { "projectId": "my-project-a3f7b2" } }

// Server -> Client: Event
{ "type": "event", "data": { "timestamp": "...", "event_type": "...", "summary": "..." } }

// Server -> Client: Heartbeat (every 30s)
{ "type": "heartbeat", "timestamp": "2026-02-21T10:30:30.000Z" }

// Client -> Server: Unsubscribe
{ "type": "unsubscribe" }
```

#### Heartbeat and Reconnection

- SSE sends a `heartbeat` event every 30 seconds to keep the connection alive
- WebSocket sends a `heartbeat` message every 30 seconds
- Clients should reconnect with exponential backoff on connection loss
- On reconnect, clients can send a `last_event_id` to replay missed events

#### Acceptance Criteria

- [ ] `agentctx watch` displays events in real-time as they arrive
- [ ] Text format shows timestamp, project name, session ID, event type, and a summary line
- [ ] JSON format outputs one JSONL object per event
- [ ] `--session` filter restricts output to a single session
- [ ] `--type` filter restricts output to specific event types
- [ ] `--all-projects` shows events from all projects
- [ ] `--agent` filter restricts output to a specific agent provider
- [ ] `--verbose` includes full event payloads
- [ ] Watch receives events within 200ms of file creation (daemon mode)
- [ ] Standalone fallback polls every 500ms and displays new events
- [ ] SSE endpoint delivers events to dashboard subscribers
- [ ] WebSocket endpoint supports filtered subscriptions
- [ ] Heartbeat keeps connections alive (30-second interval)
- [ ] Graceful shutdown: watch command exits cleanly on SIGINT/SIGTERM
- [ ] No events are lost when the terminal is slow to render (backpressure handling)

---

### 10. Projection Cache (F2.10)

The daemon maintains an in-memory cache of frequently accessed projections to avoid repeated disk reads and JSON parsing.

#### Cache Architecture

```typescript
interface ProjectionCache {
  /** Get a cached projection, or null if not cached / stale */
  get(key: ProjectionCacheKey): CachedProjection | null;

  /** Store a projection in the cache */
  set(key: ProjectionCacheKey, projection: unknown, sizeBytes: number): void;

  /** Invalidate a specific projection */
  invalidate(key: ProjectionCacheKey): void;

  /** Invalidate all projections for a session */
  invalidateSession(projectId: string, sessionId: string): void;

  /** Invalidate all projections for a project */
  invalidateProject(projectId: string): void;

  /** Get cache statistics */
  stats(): CacheStats;

  /** Pre-warm the cache with recent projections */
  prewarm(eventsDir: string, projectionsDir: string): Promise<void>;
}

interface ProjectionCacheKey {
  projectId: string;
  sessionId?: string;       // null for cross-session projections
  projectionType: string;   // "timeline", "usage", "usage-daily", etc.
}

interface CachedProjection {
  data: unknown;
  sizeBytes: number;
  cachedAt: string;
  lastAccessed: string;
  hits: number;
  lastSequence: number;     // For staleness detection
}

interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  maxSizeBytes: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  hitRate: number;           // hits / (hits + misses)
  oldestEntry: string;       // timestamp
  newestEntry: string;       // timestamp
}
```

#### Cache Invalidation Strategy

Projections in the cache are invalidated when new events arrive for the corresponding session or project:

```
New event arrives for session X in project P
  │
  ├── Invalidate all per-session projections for (P, X)
  │     timeline, files, decisions, context, summary, usage
  │
  └── Mark cross-session projections for P as stale
        usage-daily, usage-by-model, files-aggregate, session-chain
        (These are rebuilt lazily on next access, not eagerly)
```

**Staleness detection** without invalidation: Compare the `_last_sequence` in the cached projection with the current event count from `session.json`. If the session has more events than the cached projection has processed, the projection is stale.

```typescript
function isStale(cached: CachedProjection, sessionJson: SessionMetadata): boolean {
  return cached.lastSequence < sessionJson.event_count;
}
```

#### Memory Budget

The cache operates within a fixed memory budget (configurable):

```typescript
interface CacheConfig {
  /** Maximum cache size in bytes (default: 50MB) */
  maxSizeBytes: number;

  /** Maximum number of entries (default: 500) */
  maxEntries: number;

  /** Eviction policy: "lru" (least recently used) or "lfu" (least frequently used) */
  evictionPolicy: 'lru' | 'lfu';

  /** Pre-warm: number of recent sessions to cache on startup (default: 10 per project) */
  prewarmSessionsPerProject: number;

  /** Pre-warm: projection types to pre-warm (default: ["context", "timeline"]) */
  prewarmProjectionTypes: string[];
}
```

**Default memory budget**: 50MB. At an average of 50KB per projection, this supports approximately 1000 cached projections.

#### Eviction Policy

LRU (Least Recently Used) eviction:

```
1. On cache set, if totalSizeBytes > maxSizeBytes:
     a. Sort entries by lastAccessed ascending
     b. Evict oldest entries until totalSizeBytes < maxSizeBytes * 0.8 (evict to 80% to avoid thrashing)
2. On cache set, if totalEntries > maxEntries:
     a. Same eviction as above
```

#### Pre-Warming

On daemon startup, the cache is pre-warmed with the most recent projections:

```
1. List all project directories under events/
2. For each project:
     a. Find the N most recent sessions (by last_event_at in session.json)
     b. For each session, for each pre-warm projection type:
          i. Load the projection file from disk (if it exists)
          ii. Insert into cache
3. Build cross-session projections for each project and cache them
```

Pre-warming runs asynchronously and does not block daemon startup. The daemon is fully functional before pre-warming completes.

#### Cache Configuration (in daemon config)

```json
{
  "projection_cache": {
    "max_size_mb": 50,
    "max_entries": 500,
    "eviction_policy": "lru",
    "prewarm_sessions_per_project": 10,
    "prewarm_projection_types": ["context", "timeline", "usage"]
  }
}
```

#### Acceptance Criteria

- [ ] Projection cache stores projections in memory with a configurable size limit
- [ ] Cache hit returns a projection without disk I/O
- [ ] Cache miss triggers a disk read and stores the result in the cache
- [ ] New events for a session invalidate all cached per-session projections for that session
- [ ] Cross-session projections are marked stale (not eagerly rebuilt) when new events arrive
- [ ] LRU eviction removes least-recently-accessed entries when the cache is full
- [ ] Eviction triggers at 100% capacity and frees to 80% capacity (prevents thrashing)
- [ ] Pre-warming loads the N most recent sessions' projections on daemon startup
- [ ] Pre-warming runs asynchronously and does not block daemon startup
- [ ] Cache statistics (hit rate, size, eviction count) are exposed via the daemon API
- [ ] The cache never exceeds the configured memory budget
- [ ] Cache operations (get, set, invalidate) complete in under 1ms

---

## Edge Cases

### E-1: Daemon Not Running (Standalone GC Mode)

**Scenario**: The user has GlobalContext installed but the AgentContext daemon is not running. Events are captured normally but daemon-dependent features are unavailable.

**Expected behavior**: `capture-event` writes events to disk as always. The UDP notification to `AGENTCTX_EVENT_PORT` silently fails (port not set or daemon not listening). All file-based functionality works: `gc-query` commands, projections, search (grep-based). The `agentctx watch` command falls back to filesystem polling. The inverted index and projection cache are not available.

**Mitigation**: All daemon-dependent features have a graceful fallback that works without the daemon. The system degrades gracefully rather than failing.

---

### E-2: Daemon Restarts Mid-Session

**Scenario**: The daemon crashes and restarts while an active Claude Code session is producing events.

**Expected behavior**: On restart, the daemon scans the event store to rebuild its in-memory state. The filesystem watcher starts fresh and detects any files created during the downtime. The inverted index is rebuilt from scratch. The projection cache is pre-warmed. No events are lost because they are always written to disk first.

**Risk**: There may be a brief window (< 5 seconds) where the daemon is catching up and live watch subscribers do not receive events in real-time.

**Mitigation**: The daemon tracks a "last seen" checkpoint per session. On restart, it replays events from the checkpoint forward, sending them to the event bus so subscribers receive any missed events.

---

### E-3: Concurrent Sessions from Different Agents

**Scenario**: A Claude Code session and an OpenCode session are both active on the same project simultaneously.

**Expected behavior**: Both sessions write to the same project directory but different session subdirectories. The flock mechanism ensures no write conflicts. The daemon's event bus receives events from both sessions and dispatches them to appropriate subscribers. The project index correctly reflects both active sessions. Cross-session projections are incrementally updated as events arrive from either session.

**Risk**: The `latest` symlink may flip between sessions rapidly.

**Mitigation**: The `latest` symlink points to the session with the most recent event, which is correct behavior. Consumers of `latest` should be aware it may change during concurrent sessions.

---

### E-4: Very Large Event Store (1000+ Sessions, 100K+ Events)

**Scenario**: A power user has been using the system for months across multiple projects with heavy usage.

**Expected behavior**: The inverted index is approximately 10MB for 100K events. Pre-warming the cache takes approximately 5-10 seconds. Grep-based search becomes impractical (> 60 seconds). The daemon startup time is under 30 seconds including full index rebuild.

**Mitigation**: The inverted index makes search fast. Pre-warming is asynchronous and does not block daemon startup. Cross-session projection rebuilds are incremental and only process new events.

---

### E-5: Corrupted Projection File

**Scenario**: A projection file on disk contains invalid JSON (due to a crash during write, disk error, or manual tampering).

**Expected behavior**: The projection loader detects the parse error, logs a warning, discards the corrupted file, and triggers a full rebuild from events. The rebuilt projection is written atomically (write to temp file, then `rename()`) to prevent future corruption.

**Mitigation**: All projection writes use atomic rename. The `_checkpoint` field allows detection of incomplete writes (missing or inconsistent checkpoint = rebuild needed).

---

### E-6: UDP Notification Port Conflict

**Scenario**: `AGENTCTX_EVENT_PORT` is set but another process is already using that port.

**Expected behavior**: The daemon detects the port conflict on startup and picks a different port, updating the environment variable in its hook configuration. The `capture-event` script uses whichever port is set in `AGENTCTX_EVENT_PORT` at invocation time. If the port is wrong, UDP packets are silently dropped and the daemon relies on the filesystem watcher as fallback.

**Mitigation**: The daemon writes its actual port to a well-known file (`~/.claude-context/daemon.json`) that `capture-event` can read as a fallback if `AGENTCTX_EVENT_PORT` is not set.

---

### E-7: Token Usage Data Not Available

**Scenario**: An agent (especially non-Claude Code agents) does not provide token usage data in TurnCompleted events.

**Expected behavior**: The `token_usage` field in session.json remains at zero. The usage projection shows zero tokens for turns without usage data. Cost estimation correctly shows $0.00 for sessions without token data. The system does not crash or produce errors.

**Mitigation**: All token usage accumulation checks for the presence of `data.usage` before attempting to read it. Missing usage data is logged as a debug-level message, not a warning.

---

### E-8: Search Query with Special Characters

**Scenario**: User searches for `console.log("error")` or `path/to/file.ts` or a regex-like pattern `[A-Z]+`.

**Expected behavior**: The search system escapes special characters appropriately. For the inverted index, the query is tokenized using the same rules as indexing. For grep-based search, the query is properly escaped for use with `grep -F` (fixed string) by default, with an optional `--regex` flag for regex matching.

**Mitigation**: Grep-based search defaults to fixed-string matching (`grep -F`). The inverted index tokenizes the query identically to how it tokenizes content, so special characters that are treated as token delimiters simply produce multiple search tokens.

---

### E-9: Cross-Agent Session Chain with Missing Middle Session

**Scenario**: Session chain A -> B -> C exists, but session B's directory is deleted or corrupted.

**Expected behavior**: Chain resolution walks from C backward. When it hits B, it finds no session.json (or a corrupted one). The chain is broken at B — session A becomes an orphan in the chain graph, and the resolved chain for C starts at C itself. The session-chain.json cross-session projection records the broken link.

**Mitigation**: Chain resolution catches errors per-session and reports partial chains. The `orphan_sessions` field in session-chain.json lists sessions with broken parent links for manual investigation.

---

### E-10: Projection Cache Exceeds Memory Budget Under Load

**Scenario**: Many sessions are active simultaneously, each generating frequent events that trigger cache invalidation and re-caching.

**Expected behavior**: The LRU eviction policy keeps the cache within its memory budget by evicting the least-recently-accessed entries. Under high churn, the cache may have a low hit rate, but it never exceeds the budget. The eviction-to-80% threshold prevents constant eviction.

**Mitigation**: Under extreme load, the daemon can temporarily disable cache writes for specific projection types (e.g., skip caching cross-session projections during heavy concurrent activity). This is automatic based on eviction rate: if more than 50 evictions per minute, reduce pre-warming aggressiveness.

---

## Technical Specifications

### New Files

| File | Type | Purpose |
|------|------|---------|
| `src/daemon/event-bus.ts` | TypeScript | Internal pub/sub event bus |
| `src/daemon/event-watcher.ts` | TypeScript | Filesystem watcher for new events |
| `src/daemon/udp-receiver.ts` | TypeScript | UDP notification listener |
| `src/daemon/projection-cache.ts` | TypeScript | In-memory LRU projection cache |
| `src/daemon/search-index.ts` | TypeScript | Inverted index for full-text search |
| `src/projections/usage.ts` | TypeScript | Per-session usage projection builder |
| `src/projections/usage-daily.ts` | TypeScript | Cross-session daily usage aggregation |
| `src/projections/usage-by-model.ts` | TypeScript | Cross-session per-model aggregation |
| `src/projections/files-aggregate.ts` | TypeScript | Cross-session files aggregate |
| `src/projections/session-chain.ts` | TypeScript | Session chain graph builder |
| `src/api/events-stream.ts` | TypeScript | SSE/WebSocket event streaming endpoints |
| `src/api/search.ts` | TypeScript | Search API endpoints |
| `src/cli/watch.ts` | TypeScript | `agentctx watch` CLI command |
| `src/cli/search.ts` | TypeScript | `agentctx search` CLI command |

### Modified Files

| File | Change |
|------|--------|
| `src/capture-event` | Add UDP notification block after file write |
| `src/capture-event` | Extend session.json update with new fields |
| `src/lib/context_loader.sh` | Support multi-agent recall |
| `src/lib/format_context.sh` | Cross-agent context formatting |

### Configuration

**daemon.json** (written by daemon on startup):

```json
{
  "pid": 12345,
  "event_port": 9847,
  "http_port": 3847,
  "started_at": "2026-02-21T08:00:00.000Z",
  "version": "1.0.0"
}
```

**Daemon config section** (in main config):

```json
{
  "event_store": {
    "notification_port": 9847,
    "watcher_debounce_ms": 50,
    "watcher_fallback_poll_ms": 500
  },
  "projection_cache": {
    "max_size_mb": 50,
    "max_entries": 500,
    "eviction_policy": "lru",
    "prewarm_sessions_per_project": 10,
    "prewarm_projection_types": ["context", "timeline", "usage"]
  },
  "search_index": {
    "enabled": true,
    "max_response_index_chars": 500,
    "stop_words": true,
    "min_token_length": 2
  }
}
```

### API Endpoints (New)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events/stream` | SSE event stream (filtered by query params) |
| WS | `/api/events/ws` | WebSocket event stream |
| GET | `/api/search` | Full-text search |
| GET | `/api/search/files` | Search by file path |
| GET | `/api/search/tools` | Search by tool name |
| GET | `/api/projects/:id/usage` | Project usage summary |
| GET | `/api/projects/:id/usage/daily` | Daily usage breakdown |
| GET | `/api/projects/:id/sessions` | Session listing with agent filter |
| GET | `/api/sessions/:id/chain` | Session chain resolution |
| GET | `/api/cache/stats` | Projection cache statistics |
| POST | `/api/cache/invalidate` | Force cache invalidation |
| POST | `/api/cache/prewarm` | Trigger cache pre-warming |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTCTX_EVENT_PORT` | (unset) | UDP port for capture-event notifications to daemon |
| `AGENTCTX_HTTP_PORT` | 3847 | HTTP API port for daemon |
| `AGENTCTX_CACHE_SIZE_MB` | 50 | Projection cache memory budget |

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-1 | Event bus: publish event, verify subscriber receives it |
| T-2 | Event bus: filtered subscription only receives matching events |
| T-3 | Event bus: session subscription ignores events from other sessions |
| T-4 | UDP receiver: parse valid notification JSON |
| T-5 | UDP receiver: handle malformed UDP packet gracefully |
| T-6 | UDP receiver: deduplicate event received via both UDP and filesystem watcher |
| T-7 | Session metadata: agent_provider detection for Claude Code payload |
| T-8 | Session metadata: agent_provider detection for OpenCode payload |
| T-9 | Session metadata: agent_provider detection for unknown payload |
| T-10 | Session metadata: token_usage accumulation across multiple TurnCompleted events |
| T-11 | Session metadata: tool_call_count and tool_call_errors tracking |
| T-12 | Usage projection: per-turn token breakdown is correct |
| T-13 | Usage projection: cost estimation matches expected values for known models |
| T-14 | Usage projection: unknown model falls back to default pricing |
| T-15 | Cross-session usage-daily: aggregates across 5 sessions correctly |
| T-16 | Cross-session files-aggregate: deduplicates files across sessions |
| T-17 | Session chain: resolves 3-session chain in correct order |
| T-18 | Session chain: handles broken parent link gracefully |
| T-19 | Session chain: detects circular reference and breaks at depth 100 |
| T-20 | Search index: tokenize prompt text and find by keyword |
| T-21 | Search index: file path search matches partial paths |
| T-22 | Search index: case-insensitive search returns correct results |
| T-23 | Search index: special characters in query do not crash |
| T-24 | Projection cache: get/set/invalidate lifecycle |
| T-25 | Projection cache: LRU eviction removes oldest entry |
| T-26 | Projection cache: memory budget is not exceeded |
| T-27 | Projection cache: invalidation on new event clears session projections |
| T-28 | Incremental build: 10 new events produce same result as full rebuild |
| T-29 | Incremental build: schema version change triggers full rebuild |
| T-30 | Incremental build: corrupted checkpoint triggers full rebuild |

### Integration Tests

| Test | Description |
|------|-------------|
| T-31 | capture-event with AGENTCTX_EVENT_PORT sends UDP notification after file write |
| T-32 | capture-event without AGENTCTX_EVENT_PORT works identically to standalone mode |
| T-33 | Daemon startup: scans existing event store and builds index |
| T-34 | Daemon restart: catches up on events created during downtime |
| T-35 | Filesystem watcher: detects new event file within 200ms |
| T-36 | Two concurrent sessions for same project: both correctly tracked |
| T-37 | SSE endpoint: subscriber receives events in real-time |
| T-38 | WebSocket endpoint: filtered subscription works correctly |
| T-39 | agentctx watch: displays events in real-time (text format) |
| T-40 | agentctx watch: JSON format produces valid JSONL |
| T-41 | agentctx search: finds keyword in prompt across 10 sessions |
| T-42 | gc-query search (standalone): finds keyword without daemon |
| T-43 | /recall across agent types: includes context from OpenCode session |
| T-44 | Pre-warming: loads 10 most recent sessions on daemon startup |
| T-45 | Pre-warming: does not block daemon startup (async) |

### Performance Tests

| Test | Description | Target |
|------|-------------|--------|
| T-46 | UDP notification latency | < 5ms added to capture-event |
| T-47 | Incremental projection build (10 new events) | < 200ms |
| T-48 | Full projection rebuild (1000 events) | < 2s |
| T-49 | Cross-session projection build (50 sessions) | < 10s |
| T-50 | Inverted index search (100K events) | < 500ms |
| T-51 | Projection cache get latency | < 1ms |
| T-52 | Daemon startup with 100 sessions | < 10s |
| T-53 | SSE event delivery latency | < 100ms from file write |
| T-54 | Pre-warm 50 projections | < 5s (async, non-blocking) |

### Manual Verification

| Test | Description |
|------|-------------|
| M-1 | Start daemon, start Claude Code session, verify events appear in `agentctx watch` |
| M-2 | Start two sessions (different agents, same project), verify both visible in project index |
| M-3 | Run `agentctx search "keyword"` and verify results match grep-based search |
| M-4 | Stop daemon, create events, restart daemon, verify events are recovered |
| M-5 | Run `/recall` after switching from OpenCode to Claude Code, verify cross-agent context |
| M-6 | Open dashboard, verify SSE stream shows live events |
| M-7 | Check `agentctx cache stats` after 30 minutes of usage, verify hit rate > 50% |

---

## Definition of Done

- [ ] Daemon event bus receives events from both UDP notifications and filesystem watcher
- [ ] Events are deduplicated when received from both sources
- [ ] `capture-event` sends UDP notification without adding more than 5ms latency
- [ ] session.json includes all enhanced fields (agent_provider, token_usage, tool counts, etc.)
- [ ] Agent provider detection works for Claude Code, OpenCode, and Codex sessions
- [ ] Usage projection tracks per-turn token usage with cost estimation
- [ ] Cross-session projections (usage-daily, usage-by-model, files-aggregate, session-chain) are built incrementally
- [ ] Incremental projections produce identical results to full rebuilds
- [ ] Projection schema version changes trigger automatic full rebuilds
- [ ] Session chains resolve across agent types with graceful handling of broken links
- [ ] `/recall` returns context from the most recent session regardless of agent type
- [ ] Full-text search returns results in under 500ms for 100K events (inverted index)
- [ ] Grep-based search fallback works without daemon
- [ ] `agentctx watch` displays events in real-time with filtering support
- [ ] SSE and WebSocket endpoints deliver events to dashboard subscribers
- [ ] Projection cache operates within memory budget with LRU eviction
- [ ] Cache pre-warming loads recent projections asynchronously on daemon startup
- [ ] All 54 test cases from the testing plan pass
- [ ] The system degrades gracefully when the daemon is not running (standalone GC mode)
- [ ] All new files follow the existing project conventions (TypeScript for daemon, Bash for capture scripts)
- [ ] All output uses consistent prefixes (`[agentctx]`, `[capture-event]`) for grep-ability
