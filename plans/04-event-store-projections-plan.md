# Implementation Plan: Story 04 -- Event Store & Projections (Enhanced) -- Daemon Integration

**Date**: 2026-02-22
**Story**: 10-event-store-projections
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (96-128 hours)
**Prerequisites**: Stories 01-05 implemented (capture-event, gc-hook, storage layer, projection engine, gc-query). Daemon bootstrap story (if any) should define the daemon process skeleton.
**Design References**: `docs/PRODUCT-SPEC.md` (F2.1-F2.10), `docs/PLATFORM-EVALUATION.md` (encryption/sync architecture), `stories/10-event-store-projections.md`.

### Relationship to Other Stories

This is the **daemon integration story**. It bridges the standalone GlobalContext event pipeline (Stories 01-05) with the AgentContext daemon, adding real-time capabilities that require a long-running process.

- **Story 01** (Event Capture): `capture-event` gains UDP daemon notification after disk write. session.json updated with new fields.
- **Story 02** (Hook Integration): Unchanged -- hooks fire into gc-hook as before.
- **Story 03** (Storage Layer): session.json gains multi-agent fields (`agent_provider`, `agent_model`, `token_usage`, etc.).
- **Story 04** (Projection Engine): New projection types (`usage`, cross-session projections), incremental builds with checkpoints. Existing `src/projections/lib/incremental.mjs` is extended.
- **Story 05** (Context Recovery): `/recall` extended for cross-agent context recovery. `context_loader.sh` and `format_context.sh` modified.
- **Story 06** (Plugin Packaging): Unchanged -- plugin hooks feed into the same pipeline.

### Key Constraints

1. **Disk is the single source of truth.** The daemon is a read-side accelerator only; it never owns data that does not also exist on disk.
2. **Standalone GC mode must remain fully functional.** Every daemon-dependent feature must have a graceful fallback.
3. **Write side stays fast and dumb.** The UDP notification from `capture-event` must add less than 5ms.
4. **TypeScript for daemon components, Bash for capture scripts.** Follows existing convention.

---

## Task Dependency Graph

```
Task 1: capture-event UDP Notification
  |
  +---> Task 2: Session Metadata Enhancement (needs 1)
  |       |
  |       +---> Task 5: Usage Projection -- Per-Session (needs 2)
  |       |       |
  |       |       +---> Task 6: Cross-Session Projections (needs 5)
  |       |       |       |
  |       |       |       +---> Task 7: Session Chaining (needs 6)
  |       |       |
  |       |       +---> Task 10: Incremental Projection Engine (needs 5)
  |       |
  |       +---> Task 3: Daemon Event Bus (needs 1, 2)
  |               |
  |               +---> Task 4: Filesystem Watcher (needs 3)
  |               |
  |               +---> Task 8: Full-Text Search (needs 3)
  |               |       |
  |               |       +---> Task 8b: Search CLI (needs 8)
  |               |
  |               +---> Task 9: Live Event Monitor (needs 3, 4)
  |               |       |
  |               |       +---> Task 9b: SSE/WebSocket Streaming (needs 9)
  |               |
  |               +---> Task 11: Projection Cache (needs 3, 10)
  |
  +---> Task 12: /recall Skill Enhancement (needs 2, 7)
  |
  +---> Task 13: Integration Tests (needs all)
```

---

## Tasks

### Task 1: capture-event UDP Daemon Notification

**Description**

Extend the existing `capture-event` script (at `/home/meywd/GlobalContext/src/capture-event`) to send a lightweight UDP notification to the daemon after writing an event file to disk. The notification is fire-and-forget: if the daemon is not running or the port is unset, no latency is added.

**Prerequisites/Inputs**

- Existing `capture-event` script (Story 01, fully implemented).
- `AGENTCTX_EVENT_PORT` environment variable (set by daemon or `agentctx install`).
- Fallback: daemon writes its port to `~/.claude-context/daemon.json`; `capture-event` can read this if env var is unset.

**Implementation Details**

File: `src/capture-event`

Add the following block **after** the event file write, **inside** the flock scope (after the atomic write completes but before flock releases):

```bash
# --- NEW: Daemon notification (fire-and-forget UDP) ---
_agentctx_port="${AGENTCTX_EVENT_PORT:-}"

# Fallback: read port from daemon.json if env var not set
if [ -z "$_agentctx_port" ]; then
  _daemon_json="$BASE_DIR/daemon.json"
  if [ -f "$_daemon_json" ]; then
    _agentctx_port=$(jq -r '.event_port // empty' "$_daemon_json" 2>/dev/null) || true
  fi
fi

if [ -n "$_agentctx_port" ]; then
  _notify_json=$(jq -n -c \
    --arg type "event_written" \
    --arg pid "$project_id" \
    --arg sid "$session_id" \
    --argjson seq "$next_seq" \
    --arg etype "$event_type" \
    --arg ts "$timestamp" \
    --arg path "$SESSION_DIR/${padded}.json" \
    '{type:$type,project_id:$pid,session_id:$sid,sequence:$seq,event_type:$etype,timestamp:$ts,path:$path}')
  echo "$_notify_json" > /dev/udp/127.0.0.1/"$_agentctx_port" 2>/dev/null || true
fi
```

**Variables referenced** (already defined in capture-event):
- `$project_id` -- derived project ID (basename-hash6)
- `$session_id` -- sanitized session ID
- `$next_seq` -- integer sequence number
- `$event_type` -- first argument to capture-event
- `$timestamp` -- ISO 8601 timestamp
- `$SESSION_DIR` -- full path to session event directory
- `$padded` -- zero-padded sequence string (e.g., `000042`)
- `$BASE_DIR` -- `~/.claude-context`

**Notification payload** (JSON, single UDP packet, max ~500 bytes):

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

**Acceptance Criteria**

- [ ] `capture-event` sends a UDP notification to `AGENTCTX_EVENT_PORT` after writing an event file
- [ ] If `AGENTCTX_EVENT_PORT` is not set AND `daemon.json` does not exist, no notification is sent
- [ ] The notification does not block or delay `capture-event` -- `|| true` ensures any failure is swallowed
- [ ] UDP notification adds less than 5ms to `capture-event` execution time (measured with `time` on 100 invocations)
- [ ] The notification JSON is valid and under 1400 bytes (single UDP packet)
- [ ] Existing tests for capture-event still pass (backward compatible)

**Edge Cases**

- `AGENTCTX_EVENT_PORT` set to a port where nothing is listening: UDP silently dropped, no error.
- `daemon.json` exists but is malformed: `jq` returns empty, no notification sent.
- `/dev/udp` not available (some restricted bash builds): `|| true` catches the error.

**Estimated Effort**: S (2-3 hours)

---

### Task 2: Session Metadata Enhancement

**Description**

Extend session.json with multi-agent fields and real-time counters. The session.json is updated within the existing flock scope in `capture-event`. Each event type triggers specific field updates.

**Prerequisites/Inputs**

- Task 1 (capture-event modifications are in progress).
- Existing session.json creation logic in `capture-event` and `src/lib/session_meta.sh`.
- Current session.json fields: `session_id`, `project_id`, `project_dir`, `started_at`, `source`, `model`, `event_count`, `last_event_at`, `last_event_type`, `last_prompt`, `ended_at`, `previous_session_id`.

**Implementation Details**

Files to modify:
- `src/capture-event` -- extend the session.json update block
- `src/lib/session_meta.sh` -- add helper functions for new fields

**New session.json fields:**

| Field | Type | Default | Updated By |
|-------|------|---------|-----------|
| `agent_provider` | string | `"unknown"` | SessionStarted |
| `agent_version` | string\|null | `null` | SessionStarted |
| `parent_session_id` | string\|null | `null` | SessionStarted |
| `parent_agent_provider` | string\|null | `null` | SessionStarted |
| `token_usage.input_tokens` | number | `0` | TurnCompleted (accumulate) |
| `token_usage.output_tokens` | number | `0` | TurnCompleted (accumulate) |
| `token_usage.cache_read_tokens` | number | `0` | TurnCompleted (accumulate) |
| `token_usage.cache_write_tokens` | number | `0` | TurnCompleted (accumulate) |
| `tool_call_count` | number | `0` | ToolCallCompleted (increment) |
| `tool_call_errors` | number | `0` | ToolCallFailed (increment) |
| `compaction_count` | number | `0` | CompactionTriggered (increment) |
| `tags` | string[] | `[]` | User-set (future) |

**Agent provider detection** (in `capture-event`, during SessionStarted processing):

```bash
_detect_agent_provider() {
  local payload="$1"
  # Claude Code: hooks include hook_type field or model starts with claude-
  if echo "$payload" | jq -e '.hook_type // .data.hook_type' &>/dev/null; then
    echo "claude-code"
    return
  fi
  if echo "$payload" | jq -e 'select(.model // .data.model | startswith("claude-"))' &>/dev/null; then
    echo "claude-code"
    return
  fi
  # OpenCode: events routed through OpenCode plugin
  if echo "$payload" | jq -e '.opencode_plugin // .data.opencode_plugin' &>/dev/null; then
    echo "opencode"
    return
  fi
  # Codex: JSONL protocol events
  if echo "$payload" | jq -e '.codex_protocol // .data.codex_protocol' &>/dev/null; then
    echo "codex"
    return
  fi
  echo "unknown"
}
```

**Token usage accumulation** (in `capture-event`, during TurnCompleted processing):

```bash
# Inside the flock scope, after event write, during session.json update
if [ "$event_type" = "TurnCompleted" ]; then
  _turn_input=$(echo "$payload" | jq -r '.data.usage.input_tokens // 0' 2>/dev/null)
  _turn_output=$(echo "$payload" | jq -r '.data.usage.output_tokens // 0' 2>/dev/null)
  _turn_cache_read=$(echo "$payload" | jq -r '.data.usage.cache_read_input_tokens // 0' 2>/dev/null)
  _turn_cache_write=$(echo "$payload" | jq -r '.data.usage.cache_creation_input_tokens // 0' 2>/dev/null)

  jq --argjson ti "$_turn_input" \
     --argjson to "$_turn_output" \
     --argjson cr "$_turn_cache_read" \
     --argjson cw "$_turn_cache_write" \
     '.token_usage.input_tokens += $ti |
      .token_usage.output_tokens += $to |
      .token_usage.cache_read_tokens += $cr |
      .token_usage.cache_write_tokens += $cw' \
     "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp" && \
     mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
fi
```

**SessionStarted initialization** (complete session.json creation):

```bash
if [ "$event_type" = "SessionStarted" ]; then
  _agent_provider=$(_detect_agent_provider "$payload")
  _agent_version=$(echo "$payload" | jq -r '.data.agent_version // .agent_version // null' 2>/dev/null)
  _parent_session_id=$(echo "$payload" | jq -r '.data.parent_session_id // null' 2>/dev/null)
  _parent_agent_provider=$(echo "$payload" | jq -r '.data.parent_agent_provider // null' 2>/dev/null)

  jq -n \
    --arg sid "$session_id" \
    --arg pid "$project_id" \
    --arg pdir "$(pwd)" \
    --arg started "$timestamp" \
    --arg src "$(echo "$payload" | jq -r '.source // "manual"')" \
    --arg model "$(echo "$payload" | jq -r '.model // .data.model // "unknown"')" \
    --arg ap "$_agent_provider" \
    --arg av "$_agent_version" \
    --arg psid "$_parent_session_id" \
    --arg pap "$_parent_agent_provider" \
    '{
      session_id: $sid,
      project_id: $pid,
      project_dir: $pdir,
      started_at: $started,
      source: $src,
      model: $model,
      event_count: 1,
      last_event_at: $started,
      last_event_type: "SessionStarted",
      last_prompt: null,
      ended_at: null,
      previous_session_id: null,
      agent_provider: $ap,
      agent_version: (if $av == "null" then null else $av end),
      parent_session_id: (if $psid == "null" then null else $psid end),
      parent_agent_provider: (if $pap == "null" then null else $pap end),
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      tool_call_count: 0,
      tool_call_errors: 0,
      compaction_count: 0,
      tags: []
    }' > "$SESSION_DIR/session.json"
fi
```

**Per-event-type update rules** (within flock scope):

| Event Type | jq Update Expression |
|------------|---------------------|
| ToolCallCompleted | `.tool_call_count += 1` |
| ToolCallFailed | `.tool_call_errors += 1` |
| CompactionTriggered | `.compaction_count += 1` |
| SessionEnded | `.ended_at = $ts` |
| (all events) | `.event_count += 1 \| .last_event_at = $ts \| .last_event_type = $etype` |

**Backward Compatibility**

Existing session.json files without the new fields remain readable. All code that reads session.json must use `// 0` or `// null` defaults:

```bash
# Reading with defaults
tool_count=$(jq -r '.tool_call_count // 0' "$session_json")
agent_provider=$(jq -r '.agent_provider // "unknown"' "$session_json")
```

**Acceptance Criteria**

- [ ] session.json includes all new fields on SessionStarted
- [ ] `agent_provider` correctly detected for Claude Code payloads (has `hook_type` or `model` starting with `claude-`)
- [ ] `agent_provider` correctly detected for OpenCode payloads (has `opencode_plugin`)
- [ ] `agent_provider` defaults to `"unknown"` for unrecognized payloads
- [ ] `token_usage` accumulates correctly across multiple TurnCompleted events
- [ ] `tool_call_count` increments on every ToolCallCompleted
- [ ] `tool_call_errors` increments on every ToolCallFailed
- [ ] `compaction_count` increments on every CompactionTriggered
- [ ] Missing `data.usage` in TurnCompleted does not crash or corrupt session.json (defaults to 0)
- [ ] Existing session.json files without new fields remain readable (backward compatible)
- [ ] All updates happen within the existing flock scope (no additional lock contention)

**Edge Cases**

- TurnCompleted with no `data.usage` field: all token deltas default to 0.
- Pre-existing session.json from older version: missing fields default gracefully.
- Very large `token_usage` values (millions of tokens): jq handles arbitrary precision integers.

**Estimated Effort**: M (4-6 hours)

---

### Task 3: Daemon Event Bus (Internal)

**Description**

Implement the internal pub/sub event bus for the daemon. This is the backbone that distributes events received from UDP notifications and the filesystem watcher to all interested components (projection cache, search index, SSE subscribers, watch CLI).

**Prerequisites/Inputs**

- Task 1 (UDP notifications are sent from capture-event).
- Daemon process skeleton (assumed to exist or be created as part of this task).

**Implementation Details**

File: `src/daemon/event-bus.ts`

```typescript
import { EventEmitter } from 'events';

export interface EventEnvelope {
  type: 'event_written';
  project_id: string;
  session_id: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  path: string;
  /** Full event data, loaded lazily from disk */
  data?: Record<string, unknown>;
}

export interface EventFilter {
  projectId?: string;
  sessionId?: string;
  eventTypes?: string[];
  agentProvider?: string;
}

export type Unsubscribe = () => void;
type EventHandler = (event: EventEnvelope) => void;

interface Subscription {
  id: number;
  filter: EventFilter;
  handler: EventHandler;
}

export class DaemonEventBus {
  private emitter = new EventEmitter();
  private subscriptions: Map<number, Subscription> = new Map();
  private nextId = 1;
  private seen: Set<string> = new Set();  // Deduplication window
  private seenMaxSize = 10000;

  /** Publish an event to all matching subscribers */
  publish(event: EventEnvelope): boolean {
    // Deduplicate: key = project_id + session_id + sequence
    const dedupeKey = `${event.project_id}:${event.session_id}:${event.sequence}`;
    if (this.seen.has(dedupeKey)) {
      return false; // Already processed
    }
    this.seen.add(dedupeKey);
    if (this.seen.size > this.seenMaxSize) {
      // Evict oldest entries (convert to array, remove first 20%)
      const entries = [...this.seen];
      const evictCount = Math.floor(this.seenMaxSize * 0.2);
      for (let i = 0; i < evictCount; i++) {
        this.seen.delete(entries[i]);
      }
    }

    for (const sub of this.subscriptions.values()) {
      if (this.matchesFilter(event, sub.filter)) {
        try {
          sub.handler(event);
        } catch (err) {
          // Log but do not propagate subscriber errors
          console.error(`[event-bus] subscriber ${sub.id} error:`, err);
        }
      }
    }
    return true;
  }

  /** Subscribe to events with optional filter */
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const id = this.nextId++;
    this.subscriptions.set(id, { id, filter, handler });
    return () => { this.subscriptions.delete(id); };
  }

  /** Convenience: subscribe to a specific project */
  subscribeProject(projectId: string, handler: EventHandler): Unsubscribe {
    return this.subscribe({ projectId }, handler);
  }

  /** Convenience: subscribe to a specific session */
  subscribeSession(sessionId: string, handler: EventHandler): Unsubscribe {
    return this.subscribe({ sessionId }, handler);
  }

  /** Get current subscription count */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** Clear deduplication cache (for testing) */
  clearDedupeCache(): void {
    this.seen.clear();
  }

  private matchesFilter(event: EventEnvelope, filter: EventFilter): boolean {
    if (filter.projectId && event.project_id !== filter.projectId) return false;
    if (filter.sessionId && event.session_id !== filter.sessionId) return false;
    if (filter.eventTypes && !filter.eventTypes.includes(event.event_type)) return false;
    return true;
  }
}
```

File: `src/daemon/udp-receiver.ts`

```typescript
import dgram from 'node:dgram';
import { DaemonEventBus, EventEnvelope } from './event-bus';

export class UDPReceiver {
  private server: dgram.Socket | null = null;
  private bus: DaemonEventBus;
  private port: number;

  constructor(bus: DaemonEventBus, port: number) {
    this.bus = bus;
    this.port = port;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = dgram.createSocket('udp4');

      this.server.on('message', (msg) => {
        try {
          const event: EventEnvelope = JSON.parse(msg.toString());
          if (event.type === 'event_written') {
            this.bus.publish(event);
          }
        } catch {
          // Malformed packet -- silently ignore
        }
      });

      this.server.on('error', (err) => {
        if (this.server) {
          this.server.close();
          this.server = null;
        }
        reject(err);
      });

      this.server.bind(this.port, '127.0.0.1', () => {
        const addr = this.server!.address();
        resolve(typeof addr === 'string' ? this.port : addr.port);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
```

**Acceptance Criteria**

- [ ] Event bus supports filtered subscriptions by project, session, and event type
- [ ] Duplicate events (same project_id + session_id + sequence) are deduplicated
- [ ] Subscriber errors do not crash the bus or affect other subscribers
- [ ] UDP receiver parses valid notification JSON and publishes to the bus
- [ ] UDP receiver ignores malformed packets without crashing
- [ ] Events are delivered to subscribers in the order they are published
- [ ] Deduplication window is bounded (does not grow unbounded in memory)

**Edge Cases**

- Same event received from both UDP and filesystem watcher: deduplicated by composite key.
- Subscriber throws exception: caught and logged, other subscribers still receive the event.
- Rapid event burst (100 events in 50ms): all events processed, deduplication handles any duplicates.

**Estimated Effort**: M (4-6 hours)

---

### Task 4: Filesystem Watcher (Fallback)

**Description**

Implement a filesystem watcher that detects new event files in the event store directory tree. This serves as a fallback when UDP notifications are lost (daemon started after events were written, packet loss, etc.). On daemon startup, the watcher also performs a catch-up scan for events written during downtime.

**Prerequisites/Inputs**

- Task 3 (Daemon Event Bus to publish detected events).
- Event store directory layout: `~/.claude-context/events/{project-id}/{session-id}/{sequence}.json`.

**Implementation Details**

File: `src/daemon/event-watcher.ts`

```typescript
import { watch, FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DaemonEventBus, EventEnvelope } from './event-bus';

interface WatcherConfig {
  eventsDir: string;
  debounceMs: number;  // Default: 50
  bus: DaemonEventBus;
}

export class EventStoreWatcher {
  private config: WatcherConfig;
  private watchers: FSWatcher[] = [];
  private pendingFiles: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastCheckpoint: Map<string, number> = new Map(); // sessionKey -> lastSequence

  constructor(config: WatcherConfig) {
    this.config = config;
  }

  /** Start watching the event store recursively */
  async start(): Promise<void> {
    // 1. Catch-up scan: process events newer than last checkpoint
    await this.catchUpScan();

    // 2. Start recursive watch on events directory
    this.startWatch(this.config.eventsDir);
  }

  /** Stop all watchers */
  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Scan for events written during daemon downtime */
  private async catchUpScan(): Promise<void> {
    // Walk project directories
    // For each session, compare session.json event_count vs our checkpoint
    // Process any new events
  }

  /** Start fs.watch on a directory */
  private startWatch(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Only process numbered JSON files (not session.json, not .lock, not .tmp)
        if (!/\/\d{6}\.json$/.test(filename) && !/\\\d{6}\.json$/.test(filename)) return;

        const fullPath = path.join(dir, filename);
        this.pendingFiles.add(fullPath);
        this.scheduleBatchProcess();
      });
      this.watchers.push(watcher);
    } catch (err) {
      console.error(`[event-watcher] Failed to watch ${dir}:`, err);
    }
  }

  /** Debounce: batch file events within a window */
  private scheduleBatchProcess(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processBatch();
    }, this.config.debounceMs);
  }

  /** Process a batch of detected file paths */
  private async processBatch(): Promise<void> {
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const filePath of files.sort()) {
      // Parse path: events/{project-id}/{session-id}/{sequence}.json
      const parts = filePath.split(path.sep);
      const eventsIdx = parts.indexOf('events');
      if (eventsIdx === -1 || eventsIdx + 3 >= parts.length) continue;

      const projectId = parts[eventsIdx + 1];
      const sessionId = parts[eventsIdx + 2];
      const seqFile = parts[eventsIdx + 3];
      const sequence = parseInt(seqFile.replace('.json', ''), 10);
      if (isNaN(sequence)) continue;

      const envelope: EventEnvelope = {
        type: 'event_written',
        project_id: projectId,
        session_id: sessionId,
        sequence,
        event_type: 'unknown', // Will be enriched when full event is loaded
        timestamp: new Date().toISOString(),
        path: filePath,
      };

      this.config.bus.publish(envelope);
    }
  }
}
```

**Key behaviors:**
- Watches `~/.claude-context/events/` recursively for `CREATE` events on `*.json` files.
- Debounces: batches file creation events within a 50ms window.
- Ignores `.lock` files, `session.json`, and `.tmp` files -- only numbered event files trigger processing.
- On startup, scans all session directories for events newer than the daemon's last known checkpoint.
- The catch-up scan reads `session.json` `event_count` and compares with the checkpoint.

**Acceptance Criteria**

- [ ] Filesystem watcher detects new event files within 200ms of creation
- [ ] Watcher ignores `.lock`, `.tmp`, and `session.json` files
- [ ] Debounce batches events within a 50ms window
- [ ] On daemon startup, catch-up scan finds events written during downtime
- [ ] Detected events are published to the event bus with correct project_id, session_id, sequence
- [ ] Watcher handles new project/session directories being created at runtime

**Edge Cases**

- New project directory created while watcher is running: recursive watch picks up new subdirectories.
- File created and immediately renamed (atomic write pattern): watcher picks up the final file.
- Thousands of events written during downtime: catch-up scan processes them without blocking daemon startup (use async iteration).

**Estimated Effort**: M (4-6 hours)

---

### Task 5: Usage Projection -- Per-Session

**Description**

Implement a new per-session projection type (`usage`) that tracks token consumption and cost per turn. This integrates with the existing projection engine at `src/projections/`.

**Prerequisites/Inputs**

- Task 2 (session.json has `token_usage` and `agent_provider` fields).
- Existing projection infrastructure: `src/projections/lib/incremental.mjs`, `src/projections/lib/registry.mjs`, `src/projections/lib/replay.mjs`.
- Model pricing data for cost estimation.

**Implementation Details**

File: `src/projections/handlers/usage.mjs`

```javascript
// usage.mjs -- Per-session usage projection handler
// Tracks token consumption per turn, tool call counts, and cost estimation.

const PROJECTION_VERSION = 1;
const OUTPUT_FILE = 'usage.json';

// Model pricing (input / output / cache_read / cache_write per million tokens)
const MODEL_PRICING = {
  'claude-opus-4-6': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-3-20250722': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
};
const DEFAULT_MODEL_KEY = 'claude-sonnet-4-20250514';

function estimateCost(usage, model) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL_KEY];
  return (
    (usage.input_tokens * pricing.input) / 1_000_000 +
    (usage.output_tokens * pricing.output) / 1_000_000 +
    (usage.cache_read_tokens * pricing.cacheRead) / 1_000_000 +
    (usage.cache_write_tokens * pricing.cacheWrite) / 1_000_000
  );
}

function createInitialState() {
  return {
    model: 'unknown',
    agent_provider: 'unknown',
    turns: [],
    totals: {
      input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0,
      total_tokens: 0, turns: 0,
      tool_calls: 0, tool_errors: 0,
      estimated_cost_usd: 0,
    },
    by_tool: {},
    _current_turn: null, // Internal: tracks current turn accumulator
    _current_prompt: null,
  };
}

function processEvent(state, event) {
  const { event_type, data, sequence, timestamp } = event;

  switch (event_type) {
    case 'SessionStarted':
      state.model = data?.model || 'unknown';
      state.agent_provider = data?.agent_provider || 'unknown';
      break;

    case 'UserPromptReceived':
      // Start a new turn
      state._current_turn = {
        turn_number: state.totals.turns + 1,
        sequence,
        timestamp,
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0,
        tool_calls: 0,
        prompt_preview: (data?.prompt || '').substring(0, 80),
      };
      state._current_prompt = (data?.prompt || '').substring(0, 80);
      break;

    case 'ToolCallCompleted': {
      const toolName = data?.tool_name || 'unknown';
      state.totals.tool_calls++;
      if (state._current_turn) state._current_turn.tool_calls++;
      if (!state.by_tool[toolName]) state.by_tool[toolName] = { calls: 0, errors: 0 };
      state.by_tool[toolName].calls++;
      break;
    }

    case 'ToolCallFailed': {
      const toolName = data?.tool_name || 'unknown';
      state.totals.tool_errors++;
      if (!state.by_tool[toolName]) state.by_tool[toolName] = { calls: 0, errors: 0 };
      state.by_tool[toolName].errors++;
      break;
    }

    case 'TurnCompleted': {
      const usage = data?.usage || {};
      const inputT = usage.input_tokens || 0;
      const outputT = usage.output_tokens || 0;
      const cacheReadT = usage.cache_read_input_tokens || 0;
      const cacheWriteT = usage.cache_creation_input_tokens || 0;

      state.totals.input_tokens += inputT;
      state.totals.output_tokens += outputT;
      state.totals.cache_read_tokens += cacheReadT;
      state.totals.cache_write_tokens += cacheWriteT;
      state.totals.total_tokens += inputT + outputT + cacheReadT + cacheWriteT;
      state.totals.turns++;

      if (state._current_turn) {
        state._current_turn.input_tokens = inputT;
        state._current_turn.output_tokens = outputT;
        state._current_turn.cache_read_tokens = cacheReadT;
        state._current_turn.cache_write_tokens = cacheWriteT;
        state.turns.push(state._current_turn);
        state._current_turn = null;
      }

      state.totals.estimated_cost_usd = parseFloat(
        estimateCost(state.totals, state.model).toFixed(4)
      );
      break;
    }
  }

  return state;
}

function finalize(state, meta) {
  // Remove internal tracking fields
  const { _current_turn, _current_prompt, ...cleanState } = state;
  return {
    _projection_type: 'usage',
    _projection_version: PROJECTION_VERSION,
    _last_sequence: meta.lastSequence,
    _rebuilt_at: new Date().toISOString(),
    _session_id: meta.sessionId,
    ...cleanState,
  };
}

export default {
  version: PROJECTION_VERSION,
  outputFile: OUTPUT_FILE,
  createInitialState,
  processEvent,
  finalize,
};
```

**Registration** in `src/projections/lib/registry.mjs`:

Add `usage` to the projection registry alongside the existing five types (timeline, files-touched, decisions, context-snapshot, summary).

```javascript
import usageHandler from '../handlers/usage.mjs';

// In the registry map:
registry.set('usage', {
  handler: usageHandler,
  version: usageHandler.version,
  outputFile: usageHandler.outputFile,
});
```

**Output location**: `projections/{project-id}/{session-id}/usage.json`

**Acceptance Criteria**

- [ ] Usage projection is built per-session with per-turn token breakdowns
- [ ] Cost estimation uses correct pricing for the session's model
- [ ] Unknown models fall back to Sonnet pricing
- [ ] `by_tool` correctly counts calls and errors per tool name
- [ ] `totals` correctly accumulates across all TurnCompleted events
- [ ] Projection integrates with existing incremental build system (`src/projections/lib/incremental.mjs`)
- [ ] Full rebuild and incremental build produce identical results
- [ ] Projection follows the `_projection_type`, `_projection_version`, `_rebuilt_at` metadata convention

**Edge Cases**

- Session with no TurnCompleted events: totals are all zeros, turns array is empty.
- TurnCompleted with no `data.usage`: all token counts default to 0.
- Model not in pricing table: falls back to Sonnet pricing.
- Turn without a preceding UserPromptReceived: turn is still recorded (with empty prompt_preview).

**Estimated Effort**: M (4-6 hours)

---

### Task 6: Cross-Session Projections

**Description**

Implement cross-session projections that aggregate data across all sessions within a project. Three new projection types: `usage-daily`, `usage-by-model`, and `files-aggregate`. These are stored at the project level, not the session level.

**Prerequisites/Inputs**

- Task 5 (per-session usage projection provides the data to aggregate).
- Task 2 (session.json provides per-session metadata).
- Existing projection infrastructure for writing JSON files atomically.

**Implementation Details**

**Directory layout:**

```
~/.claude-context/projections/{project-id}/
  cross-session/
    usage-daily.json
    usage-by-model.json
    files-aggregate.json
    session-chain.json       (Task 7)
  _checkpoint.json           (cross-session build checkpoint)
```

File: `src/projections/handlers/usage-daily.mjs`

**Cross-session checkpoint file** (`_checkpoint.json`):

```json
{
  "project_id": "my-project-a3f7b2",
  "last_build_at": "2026-02-22T10:00:00.000Z",
  "sessions_processed": {
    "session-001": { "last_sequence": 85, "event_count": 85 },
    "session-002": { "last_sequence": 42, "event_count": 42 }
  },
  "projection_version": 1
}
```

**Build algorithm** (shared across all cross-session projections):

```javascript
// src/projections/lib/cross-session.mjs

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { safeJsonParse } from './utils.mjs';

/**
 * Load the cross-session checkpoint for a project.
 * Returns null if no checkpoint exists.
 */
export async function loadCheckpoint(projectionsDir, projectId) {
  const checkpointPath = path.join(projectionsDir, projectId, '_checkpoint.json');
  try {
    const content = await readFile(checkpointPath, 'utf-8');
    return safeJsonParse(content, checkpointPath);
  } catch {
    return null;
  }
}

/**
 * Determine which sessions have new events since last checkpoint.
 * Returns array of { sessionId, sessionJson, isNew, newEventCount }.
 */
export async function findChangedSessions(eventsDir, projectId, checkpoint) {
  const projectEventsDir = path.join(eventsDir, projectId);
  const sessionDirs = await readdir(projectEventsDir).catch(() => []);
  const changed = [];

  for (const sessionId of sessionDirs) {
    const sessionJsonPath = path.join(projectEventsDir, sessionId, 'session.json');
    try {
      const content = await readFile(sessionJsonPath, 'utf-8');
      const sessionJson = JSON.parse(content);
      const checkpointEntry = checkpoint?.sessions_processed?.[sessionId];

      if (!checkpointEntry) {
        changed.push({ sessionId, sessionJson, isNew: true, newEventCount: sessionJson.event_count });
      } else if (sessionJson.event_count > checkpointEntry.event_count) {
        changed.push({
          sessionId, sessionJson, isNew: false,
          newEventCount: sessionJson.event_count - checkpointEntry.event_count,
        });
      }
    } catch {
      // Skip sessions with missing/corrupt session.json
    }
  }

  return changed;
}
```

**usage-daily.json builder** (`src/projections/handlers/usage-daily.mjs`):

- Reads per-session `usage.json` projections (or session.json as fallback).
- Groups token usage by date (extracted from `started_at` in session.json).
- Breaks down by model and agent provider per day.
- Calculates cost estimates using the same pricing table as the per-session usage projection.

**usage-by-model.json builder** (`src/projections/handlers/usage-by-model.mjs`):

- Aggregates token usage across all sessions, grouped by model name.
- Tracks first/last usage timestamps per model.

**files-aggregate.json builder** (`src/projections/handlers/files-aggregate.mjs`):

- Reads per-session `files-touched.json` projections.
- Deduplicates files across sessions.
- Records which sessions touched each file, total operations, operation type breakdown.
- Tracks first/last touched timestamps.

**CLI integration**: `gc-query usage [--daily] [--by-model]` and `gc-query files --aggregate`.

**Acceptance Criteria**

- [ ] Cross-session `usage-daily` projection aggregates token counts per day across all sessions
- [ ] Cross-session `usage-by-model` projection shows per-model totals
- [ ] Cross-session `files-aggregate` lists all files touched across all sessions with deduplication
- [ ] Cross-session projections stored at `projections/{project-id}/cross-session/`
- [ ] `_checkpoint.json` tracks per-session processing state
- [ ] Incremental: only sessions with new events are re-processed on subsequent builds
- [ ] Schema version mismatch triggers full cross-session rebuild
- [ ] All projections follow the `_projection_type`, `_projection_version`, `_rebuilt_at` metadata convention
- [ ] Projections handle sessions from different agent providers correctly
- [ ] Cost estimates use correct per-model pricing

**Edge Cases**

- Project with a single session: cross-session projections still generated correctly.
- Session with 0 events (empty session directory): skipped gracefully.
- New session added between builds: detected and processed in next incremental build.
- Session.json missing `token_usage` (old format): defaults to zero.

**Estimated Effort**: L (6-8 hours)

---

### Task 7: Session Chaining

**Description**

Implement session chain resolution and the `session-chain.json` cross-session projection. Session chains link sessions that form a logical task flow, including chains that cross agent type boundaries.

**Prerequisites/Inputs**

- Task 2 (session.json has `parent_session_id` and `parent_agent_provider` fields).
- Task 6 (cross-session projection infrastructure).
- Existing `src/lib/session_chain.sh` (if it exists, extend it; otherwise create).

**Implementation Details**

**Bash-side chain resolution** (for standalone mode):

File: `src/lib/session_chain.sh` (extend existing)

```bash
# resolve_session_chain(project_id, session_id)
# Walks parent_session_id links backward to root, outputs chain as JSON array.
# Max depth: 100 (circular reference protection).
resolve_session_chain() {
  local project_id="$1"
  local session_id="$2"
  local events_dir="$GC_EVENTS_DIR"
  local chain="[]"
  local current_id="$session_id"
  local depth=0
  local max_depth=100
  local visited=""

  while [ -n "$current_id" ] && [ "$depth" -lt "$max_depth" ]; do
    # Circular reference detection
    if echo "$visited" | grep -qF "|$current_id|"; then
      break
    fi
    visited="${visited}|${current_id}|"

    local session_json="$events_dir/$project_id/$current_id/session.json"
    if [ ! -f "$session_json" ]; then
      break  # Broken chain link
    fi

    local entry
    entry=$(jq -c '{
      session_id: .session_id,
      agent_provider: (.agent_provider // "unknown"),
      model: (.model // "unknown"),
      started_at: .started_at,
      ended_at: .ended_at,
      event_count: (.event_count // 0),
      source: (.source // "unknown"),
      parent_session_id: (.parent_session_id // .previous_session_id // null)
    }' "$session_json" 2>/dev/null) || break

    # Prepend to chain (building from current back to root)
    chain=$(echo "$chain" | jq --argjson entry "$entry" '[$entry] + .')

    # Walk backward
    current_id=$(echo "$entry" | jq -r '.parent_session_id // empty' 2>/dev/null)
    depth=$((depth + 1))
  done

  echo "$chain"
}
```

**TypeScript-side chain resolution** (for daemon):

File: `src/daemon/session-chain.ts`

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SessionChainEntry {
  sessionId: string;
  agentProvider: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  parentSessionId: string | null;
  source: string;
}

export interface SessionChain {
  sessions: SessionChainEntry[];
  totalEvents: number;
  totalDuration: string;
  agentProviders: string[];
}

export async function resolveSessionChain(
  sessionId: string,
  projectId: string,
  eventsDir: string,
  maxDepth = 100,
): Promise<SessionChain> {
  const chain: SessionChainEntry[] = [];
  let currentId: string | null = sessionId;
  const visited = new Set<string>();

  while (currentId && chain.length < maxDepth) {
    if (visited.has(currentId)) break; // Circular reference
    visited.add(currentId);

    const sessionJsonPath = path.join(eventsDir, projectId, currentId, 'session.json');
    try {
      const content = await readFile(sessionJsonPath, 'utf-8');
      const session = JSON.parse(content);

      chain.unshift({
        sessionId: currentId,
        agentProvider: session.agent_provider || 'unknown',
        model: session.model || 'unknown',
        startedAt: session.started_at,
        endedAt: session.ended_at || null,
        eventCount: session.event_count || 0,
        parentSessionId: session.parent_session_id || session.previous_session_id || null,
        source: session.source || 'unknown',
      });

      currentId = session.parent_session_id || session.previous_session_id || null;
    } catch {
      break; // Missing or corrupt session.json -- chain ends here
    }
  }

  return {
    sessions: chain,
    totalEvents: chain.reduce((sum, s) => sum + s.eventCount, 0),
    totalDuration: computeDuration(chain),
    agentProviders: [...new Set(chain.map(s => s.agentProvider))],
  };
}

function computeDuration(chain: SessionChainEntry[]): string {
  if (chain.length === 0) return '0s';
  const start = new Date(chain[0].startedAt).getTime();
  const lastSession = chain[chain.length - 1];
  const end = lastSession.endedAt
    ? new Date(lastSession.endedAt).getTime()
    : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
```

**Cross-session projection** (`session-chain.json`):

File: `src/projections/handlers/session-chain.mjs`

- Scans all sessions in a project.
- Identifies chain roots (sessions with no `parent_session_id`).
- Builds chain graph by following `parent_session_id` links forward.
- Identifies orphan sessions (sessions whose parent does not exist).
- Output includes: `chains` array (each with ordered session list), `orphan_sessions` array.

**CLI integration**: `gc-query sessions --chain <session-id>` and `agentctx sessions --chain <session-id>`.

**Acceptance Criteria**

- [ ] `parent_session_id` in session.json correctly links to the previous session
- [ ] `resolveSessionChain()` walks the parent chain and returns sessions in chronological order
- [ ] Chains work across agent types (Claude Code -> OpenCode -> Claude Code)
- [ ] Chains handle missing parent sessions gracefully (chain starts at the orphan)
- [ ] Circular chain references detected and broken (max depth: 100)
- [ ] `session-chain.json` cross-session projection built and updated incrementally
- [ ] `gc-query sessions --chain <session-id>` displays the full chain
- [ ] Orphan sessions with broken parent links listed in `orphan_sessions`

**Edge Cases**

- Single-session chain (no parent): chain contains just one entry.
- Chain with a deleted middle session (A -> B -> C, B deleted): chain for C starts at C; A is an orphan.
- Circular reference (A -> B -> A): detected and broken at max depth.
- Very long chain (100+ sessions from compactions): resolves up to max depth, truncates with a note.

**Estimated Effort**: M (4-6 hours)

---

### Task 8: Full-Text Search Index

**Description**

Implement both a grep-based search (always available, no daemon required) and an in-memory inverted index search (daemon-only, fast). The grep-based search extends `gc-query`, and the inverted index is a daemon component.

**Prerequisites/Inputs**

- Task 3 (Daemon Event Bus for incremental index updates).
- Event store directory with JSON event files.
- Existing `gc-query` CLI (Story 05).

**Implementation Details**

**Tier 1: Grep-based search** (standalone mode)

File: extend `src/bin/gc-query` with a `search` subcommand.

```bash
# gc-query search "keyword" [--project PROJECT_ID] [--type EVENT_TYPE] [--file PATH]
# [--all-projects] [--case-sensitive] [--limit N] [--offset N]

gc_query_search() {
  local query="$1"
  local project_id="${2:-}"
  local event_type="${3:-}"
  local file_pattern="${4:-}"
  local all_projects="${5:-false}"
  local case_flag="${6:--i}"  # Default: case-insensitive
  local limit="${7:-50}"
  local offset="${8:-0}"

  local search_dir="$GC_EVENTS_DIR"
  if [ -n "$project_id" ]; then
    search_dir="$GC_EVENTS_DIR/$project_id"
  elif [ "$all_projects" != "true" ]; then
    # Default to current project
    local current_project
    current_project=$(_derive_project_id "$(pwd)")
    search_dir="$GC_EVENTS_DIR/$current_project"
  fi

  # Use grep -r with fixed string matching by default
  local grep_flags="-rl $case_flag"
  local results
  results=$(grep $grep_flags -F "$query" "$search_dir"/*.json "$search_dir"/**/*.json 2>/dev/null | sort)

  # Filter by event type if specified
  if [ -n "$event_type" ]; then
    results=$(echo "$results" | while read -r f; do
      jq -e --arg t "$event_type" '.event_type == $t' "$f" &>/dev/null && echo "$f"
    done)
  fi

  # Apply offset and limit
  echo "$results" | tail -n +"$((offset + 1))" | head -n "$limit" | while read -r f; do
    _format_search_result "$f" "$query"
  done
}

_format_search_result() {
  local file="$1"
  local query="$2"
  local event_type session_id timestamp snippet

  event_type=$(jq -r '.event_type' "$file" 2>/dev/null)
  session_id=$(jq -r '.session_id' "$file" 2>/dev/null)
  timestamp=$(jq -r '.timestamp' "$file" 2>/dev/null)
  # Extract 80 chars of context around the match
  snippet=$(grep -oi ".\{0,40\}$query.\{0,40\}" "$file" 2>/dev/null | head -1)

  printf "[%s] %s | %s | %s\n  %s\n\n" \
    "${timestamp:0:19}" "$session_id" "$event_type" "$(basename "$file")" "$snippet"
}
```

**Tier 2: Inverted index** (daemon-only)

File: `src/daemon/search-index.ts`

```typescript
export interface SearchLocation {
  projectId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  field: string;
  timestamp: string;
}

export interface SearchResult {
  locations: SearchResultEntry[];
  totalMatches: number;
  searchTimeMs: number;
}

export interface SearchResultEntry extends SearchLocation {
  snippet: string;
  agentProvider: string;
  model: string;
  score: number;
}

// Stop words to exclude from indexing
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this',
  'it', 'its',
]);

export class SearchIndex {
  private tokens: Map<string, SearchLocation[]> = new Map();
  private filePaths: Map<string, SearchLocation[]> = new Map();
  private toolNames: Map<string, SearchLocation[]> = new Map();
  private totalEvents = 0;
  private builtAt: string = '';

  /** Tokenize text for indexing */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\t\n\r,.;:!?(){}\[\]"'\/\\|<>@#$%^&*+=~`]+/)
      .filter(t => t.length >= 2 && t.length <= 100 && !STOP_WORDS.has(t));
  }

  /** Index a single event */
  indexEvent(event: {
    project_id: string;
    session_id: string;
    sequence: number;
    event_type: string;
    timestamp: string;
    data: Record<string, unknown>;
  }): void {
    const loc: SearchLocation = {
      projectId: event.project_id,
      sessionId: event.session_id,
      sequence: event.sequence,
      eventType: event.event_type,
      field: '',
      timestamp: event.timestamp,
    };

    // Index based on event type
    switch (event.event_type) {
      case 'UserPromptReceived': {
        const prompt = String(event.data?.prompt || '');
        this.indexTokens(prompt, { ...loc, field: 'prompt' });
        break;
      }
      case 'ToolCallRequested':
      case 'ToolCallCompleted': {
        const toolName = String(event.data?.tool_name || '');
        if (toolName) {
          this.addToIndex(this.toolNames, toolName.toLowerCase(), { ...loc, field: 'tool_name' });
        }
        const filePath = String(event.data?.tool_input?.file_path || '');
        if (filePath) {
          this.indexFilePath(filePath, loc);
        }
        const command = String(event.data?.tool_input?.command || '');
        if (command) {
          this.indexTokens(command, { ...loc, field: 'command' });
        }
        // Index tool response (limited to 500 chars)
        if (event.event_type === 'ToolCallCompleted') {
          const response = String(event.data?.tool_response || '').substring(0, 500);
          this.indexTokens(response, { ...loc, field: 'tool_response' });
        }
        break;
      }
      case 'ToolCallFailed': {
        const toolName = String(event.data?.tool_name || '');
        if (toolName) {
          this.addToIndex(this.toolNames, toolName.toLowerCase(), { ...loc, field: 'tool_name' });
        }
        const error = String(event.data?.error || '');
        this.indexTokens(error, { ...loc, field: 'error' });
        break;
      }
    }

    this.totalEvents++;
  }

  /** Full-text keyword search */
  search(query: string, options?: {
    projectId?: string; sessionId?: string;
    eventTypes?: string[]; limit?: number; offset?: number;
  }): SearchResult {
    const start = Date.now();
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) {
      return { locations: [], totalMatches: 0, searchTimeMs: 0 };
    }

    // Find locations that match ALL query tokens (intersection)
    const locationSets = queryTokens.map(t => this.tokens.get(t) || []);
    let candidates = this.intersectLocations(locationSets);

    // Apply filters
    if (options?.projectId) {
      candidates = candidates.filter(l => l.projectId === options.projectId);
    }
    if (options?.sessionId) {
      candidates = candidates.filter(l => l.sessionId === options.sessionId);
    }
    if (options?.eventTypes) {
      const types = new Set(options.eventTypes);
      candidates = candidates.filter(l => types.has(l.eventType));
    }

    // Sort by timestamp descending (most recent first)
    candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    const totalMatches = candidates.length;

    return {
      locations: candidates.slice(offset, offset + limit).map(l => ({
        ...l,
        snippet: '', // Populated by caller from disk
        agentProvider: '',
        model: '',
        score: 1,
      })),
      totalMatches,
      searchTimeMs: Date.now() - start,
    };
  }

  /** Search by file path */
  searchByFile(pathPattern: string, options?: { projectId?: string; limit?: number }): SearchResult {
    const start = Date.now();
    const normalizedPattern = pathPattern.toLowerCase();
    const matches: SearchLocation[] = [];

    for (const [indexedPath, locations] of this.filePaths) {
      if (indexedPath.includes(normalizedPattern)) {
        matches.push(...locations);
      }
    }

    if (options?.projectId) {
      const filtered = matches.filter(l => l.projectId === options.projectId);
      return {
        locations: filtered.slice(0, options?.limit || 50).map(l => ({
          ...l, snippet: '', agentProvider: '', model: '', score: 1,
        })),
        totalMatches: filtered.length,
        searchTimeMs: Date.now() - start,
      };
    }

    return {
      locations: matches.slice(0, options?.limit || 50).map(l => ({
        ...l, snippet: '', agentProvider: '', model: '', score: 1,
      })),
      totalMatches: matches.length,
      searchTimeMs: Date.now() - start,
    };
  }

  /** Get index statistics */
  get stats() {
    return {
      totalEvents: this.totalEvents,
      uniqueTokens: this.tokens.size,
      uniqueFilePaths: this.filePaths.size,
      uniqueToolNames: this.toolNames.size,
      builtAt: this.builtAt,
    };
  }

  // --- Private helpers ---

  private indexTokens(text: string, loc: SearchLocation): void {
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      this.addToIndex(this.tokens, token, loc);
    }
  }

  private indexFilePath(filePath: string, loc: SearchLocation): void {
    const normalized = filePath.toLowerCase();
    this.addToIndex(this.filePaths, normalized, { ...loc, field: 'file_path' });
    // Also index individual path components
    const components = normalized.split('/').filter(c => c.length >= 2);
    for (const component of components) {
      this.addToIndex(this.filePaths, component, { ...loc, field: 'file_path' });
    }
  }

  private addToIndex(index: Map<string, SearchLocation[]>, key: string, loc: SearchLocation): void {
    let list = index.get(key);
    if (!list) {
      list = [];
      index.set(key, list);
    }
    list.push(loc);
  }

  private intersectLocations(sets: SearchLocation[][]): SearchLocation[] {
    if (sets.length === 0) return [];
    if (sets.length === 1) return sets[0];

    // Use the smallest set as the base for intersection
    sets.sort((a, b) => a.length - b.length);
    const base = sets[0];

    // Build location keys for other sets
    const otherKeys = sets.slice(1).map(s =>
      new Set(s.map(l => `${l.projectId}:${l.sessionId}:${l.sequence}`))
    );

    return base.filter(loc => {
      const key = `${loc.projectId}:${loc.sessionId}:${loc.sequence}`;
      return otherKeys.every(keys => keys.has(key));
    });
  }
}
```

**Acceptance Criteria**

- [ ] Grep-based search (`gc-query search`) finds keywords across all sessions in a project
- [ ] `--all-projects` flag searches across all projects
- [ ] Search results include 80-character context snippets around the match
- [ ] File path search matches partial paths
- [ ] Tool name search returns all events for that tool
- [ ] Case-insensitive search by default, `--case-sensitive` flag for exact matching
- [ ] Inverted index search completes in under 500ms for 100K events
- [ ] Grep-based fallback works without the daemon running
- [ ] Special characters in queries do not crash (quotes, backslashes, regex metacharacters)
- [ ] Pagination via `--limit` and `--offset` works correctly
- [ ] Empty search results return exit code 0 with "No results found" message

**Edge Cases**

- Query is a single common stop word (e.g., "the"): returns empty results (stop word is filtered).
- Query contains regex metacharacters (e.g., `[A-Z]+`): grep-based uses `-F` (fixed string) by default.
- Very large event file (>1MB tool response): inverted index only indexes first 500 chars of tool responses.
- Event file is malformed JSON: grep-based still finds text matches; index skips it.

**Estimated Effort**: L (8-10 hours)

---

### Task 8b: Search CLI and API

**Description**

Wire up the search functionality to both the `gc-query` CLI (standalone) and the daemon HTTP API.

**Prerequisites/Inputs**

- Task 8 (search index and grep-based search implemented).

**Implementation Details**

File: `src/bin/gc-query` -- add `search` subcommand.

File: `src/api/search.ts` -- daemon HTTP API endpoints.

**CLI interface:**

```
gc-query search "keyword" [options]
  --project ID       Limit to specific project
  --type TYPE        Filter by event type
  --file PATTERN     Search by file path
  --tool NAME        Search by tool name
  --all-projects     Search across all projects
  --case-sensitive   Case-sensitive matching
  --limit N          Max results (default: 50)
  --offset N         Pagination offset
  --since DATE       Only events after this date
  --agent PROVIDER   Filter by agent provider
  --format FORMAT    Output format: text (default), json
```

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search?q=keyword&project_id=X&limit=50` | Full-text search |
| GET | `/api/search/files?path=auth.ts&project_id=X` | File path search |
| GET | `/api/search/tools?tool=Bash&project_id=X` | Tool name search |

**Acceptance Criteria**

- [ ] `gc-query search "keyword"` works in standalone mode (no daemon)
- [ ] `agentctx search "keyword"` works in daemon mode (via HTTP API)
- [ ] Both modes return consistent result format
- [ ] JSON output format is valid JSONL (one result per line)
- [ ] Date range filtering works (`--since`, `--until`)
- [ ] Agent provider filtering works (`--agent`)

**Estimated Effort**: S (2-4 hours)

---

### Task 9: Live Event Monitor (CLI)

**Description**

Implement the `agentctx watch` CLI command for real-time event tailing. When the daemon is running, it connects to the event bus via a local connection. When the daemon is not running, it falls back to filesystem polling.

**Prerequisites/Inputs**

- Task 3 (Daemon Event Bus for subscription).
- Task 4 (Filesystem Watcher for fallback mode).
- Existing `gc-query watch` (Story 05 -- basic polling watcher).

**Implementation Details**

File: `src/cli/watch.ts` (daemon mode)
File: extend `src/bin/gc-query` `watch` subcommand (standalone mode)

**CLI interface:**

```
agentctx watch [options]
  --session ID       Watch specific session
  --type TYPE        Watch specific event types (repeatable)
  --all-projects     Watch all projects
  --format FORMAT    text (default), json, verbose
  --agent PROVIDER   Filter by agent provider
```

**Text output format:**

```
[10:30:15.123] my-project | cc-session-001 | SessionStarted
  Model: claude-opus-4-6, Source: manual

[10:30:20.456] my-project | cc-session-001 | UserPromptReceived
  Fix the auth bug in handler.ts

[10:30:21.789] my-project | cc-session-001 | ToolCallRequested
  Read: /home/user/project/src/handler.ts
```

**JSON output format** (JSONL, one object per line):

```json
{"timestamp":"...","project_id":"...","session_id":"...","event_type":"...","sequence":1,"summary":"..."}
```

**Event summarization** (for the `summary` field and text output):

```typescript
function summarizeEvent(event: EventEnvelope): string {
  switch (event.event_type) {
    case 'SessionStarted':
      return `Session started (model: ${event.data?.model || 'unknown'})`;
    case 'UserPromptReceived':
      return (event.data?.prompt || '').substring(0, 80);
    case 'ToolCallRequested':
      return `${event.data?.tool_name}: ${event.data?.tool_input?.file_path || event.data?.tool_input?.command || ''}`.substring(0, 80);
    case 'ToolCallCompleted':
      return `${event.data?.tool_name}: completed`;
    case 'ToolCallFailed':
      return `${event.data?.tool_name}: FAILED - ${(event.data?.error || '').substring(0, 60)}`;
    case 'TurnCompleted': {
      const u = event.data?.usage;
      if (u) return `Tokens: ${u.input_tokens} in / ${u.output_tokens} out`;
      return 'Turn completed';
    }
    case 'SessionEnded':
      return 'Session ended';
    default:
      return event.event_type;
  }
}
```

**Daemon mode**: Connect to daemon HTTP API SSE endpoint at `http://localhost:$AGENTCTX_HTTP_PORT/api/events/stream`.

**Standalone fallback mode** (extend existing `gc-query watch`):
- Poll event directories every 500ms for new files.
- Track last-seen sequence per session.
- Display new events as they appear.

**Graceful shutdown**: Handle SIGINT/SIGTERM to close connections cleanly.

**Acceptance Criteria**

- [ ] `agentctx watch` displays events in real-time as they arrive
- [ ] Text format shows timestamp, project name, session ID, event type, and summary
- [ ] JSON format outputs one valid JSONL object per event
- [ ] `--session` filter restricts output to a single session
- [ ] `--type` filter restricts output to specific event types (multiple allowed)
- [ ] `--all-projects` shows events from all projects
- [ ] `--agent` filter restricts output to a specific agent provider
- [ ] `--verbose` includes full event payloads (pretty-printed JSON)
- [ ] Daemon mode receives events within 200ms of file creation
- [ ] Standalone fallback polls every 500ms and displays new events
- [ ] Graceful shutdown on SIGINT/SIGTERM (no hanging connections)
- [ ] Backpressure: slow terminal does not cause event loss (buffer up to 1000 events)

**Edge Cases**

- Daemon not running: falls back to polling mode with a warning message.
- Daemon crashes while watch is running: reconnect with exponential backoff (1s, 2s, 4s, max 30s).
- No events for 60 seconds: display a heartbeat indicator (optional, configurable).
- Very high event rate (50 events/second): batch display updates.

**Estimated Effort**: M (4-6 hours)

---

### Task 9b: SSE/WebSocket Event Streaming (Dashboard)

**Description**

Implement Server-Sent Events (SSE) and WebSocket endpoints on the daemon HTTP server for the dashboard and other real-time clients.

**Prerequisites/Inputs**

- Task 3 (Daemon Event Bus for subscription).
- Task 9 (Watch CLI defines the event format).
- Daemon HTTP server (assumed to exist or be created).

**Implementation Details**

File: `src/api/events-stream.ts`

**SSE endpoint**: `GET /api/events/stream`

```typescript
// Query parameters for filtering:
// ?project_id=X -- filter by project
// ?session_id=X -- filter by session
// ?event_type=X&event_type=Y -- filter by event types
// ?agent_provider=X -- filter by agent

// SSE protocol:
// event: event
// data: {"timestamp":"...","event_type":"...","summary":"..."}
//
// event: heartbeat
// data: {"timestamp":"..."}
```

**WebSocket endpoint**: `WS /api/events/ws`

```typescript
// Client -> Server: Subscribe
// { "type": "subscribe", "filter": { "projectId": "..." } }
//
// Server -> Client: Event
// { "type": "event", "data": { ... } }
//
// Server -> Client: Heartbeat (every 30s)
// { "type": "heartbeat", "timestamp": "..." }
//
// Client -> Server: Unsubscribe
// { "type": "unsubscribe" }
```

**Heartbeat**: Send heartbeat every 30 seconds to keep connections alive.

**Reconnection support**: SSE clients can send `Last-Event-ID` header to replay missed events.

**Implementation notes:**
- Use Node.js native `http` module (no external dependencies per project conventions).
- SSE: set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- WebSocket: use `ws` module (or Node.js native WebSocket if available in Node 22+).
- Each SSE/WS connection creates a subscription on the event bus; subscription is cleaned up on disconnect.
- Limit concurrent connections: max 50 SSE + 50 WS connections.

**Acceptance Criteria**

- [ ] SSE endpoint delivers events to subscribers in real-time
- [ ] WebSocket endpoint supports filtered subscriptions
- [ ] Heartbeat keeps connections alive (30-second interval)
- [ ] SSE clients receive correct `Content-Type` and `Cache-Control` headers
- [ ] Connection cleanup: bus subscription removed when client disconnects
- [ ] Max 50 concurrent SSE and 50 concurrent WS connections (reject with 503 above limit)
- [ ] Events are formatted consistently between SSE and WS

**Estimated Effort**: M (4-6 hours)

---

### Task 10: Incremental Projection Engine Enhancement

**Description**

Extend the existing incremental projection engine (`src/projections/lib/incremental.mjs`) to support checkpoint-based incremental builds for both per-session and cross-session projections, atomic writes, and corruption detection.

**Prerequisites/Inputs**

- Existing `src/projections/lib/incremental.mjs` (already implements basic incremental builds).
- Task 5 (new usage projection must integrate with the enhanced engine).
- Task 6 (cross-session projections need their own checkpoint mechanism).

**Implementation Details**

**Per-session checkpoint** (embedded in projection metadata -- already partially implemented):

The existing `_last_sequence` field in projections serves as the checkpoint. Enhancement: add a `_checkpoint` sub-object for richer tracking:

```json
{
  "_projection_type": "timeline",
  "_projection_version": 1,
  "_last_sequence": 142,
  "_rebuilt_at": "2026-02-21T10:45:00.000Z",
  "_session_id": "abc123",
  "_checkpoint": {
    "last_processed_sequence": 142,
    "projection_hash": "a1b2c3d4"
  }
}
```

**Corruption detection** (add to `src/projections/lib/incremental.mjs`):

```javascript
import { createHash } from 'node:crypto';

/**
 * Compute a lightweight hash of projection data for corruption detection.
 * Uses a hash of the JSON-serialized projection (excluding meta fields).
 */
function computeProjectionHash(projection) {
  const dataOnly = { ...projection };
  delete dataOnly._projection_type;
  delete dataOnly._projection_version;
  delete dataOnly._last_sequence;
  delete dataOnly._rebuilt_at;
  delete dataOnly._session_id;
  delete dataOnly._checkpoint;
  return createHash('sha256').update(JSON.stringify(dataOnly)).digest('hex').substring(0, 8);
}

/**
 * Detect if a projection file is corrupted.
 * Returns true if the file should be rebuilt.
 */
function isCorrupted(projection) {
  if (!projection) return true;
  if (!projection._projection_type) return true;
  if (!projection._projection_version) return true;
  if (typeof projection._last_sequence !== 'number') return true;
  if (projection._checkpoint) {
    const expectedHash = projection._checkpoint.projection_hash;
    const actualHash = computeProjectionHash(projection);
    if (expectedHash && expectedHash !== actualHash) return true;
  }
  return false;
}
```

**Atomic writes** (enhance existing write logic):

```javascript
import { writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/**
 * Write a projection file atomically (write to temp, then rename).
 */
async function atomicWriteProjection(filePath, projection) {
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
  const json = JSON.stringify(projection, null, 2);
  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, filePath);
}
```

**Schema version migration**: When `_projection_version` in the file does not match the handler's version, the existing projection is discarded and a full rebuild is triggered. This is already implemented in `incremental.mjs` -- verify and document.

**Performance targets:**

| Operation | Target | Hard Limit |
|-----------|--------|------------|
| Incremental build (10 new events) | < 50ms | 200ms |
| Incremental build (100 new events) | < 200ms | 1s |
| Full rebuild (1000 events) | < 2s | 10s |
| Cross-session rebuild (50 sessions) | < 10s | 60s |

**Acceptance Criteria**

- [ ] Projections include a `_checkpoint` field tracking the last processed sequence and hash
- [ ] Incremental builds only read event files newer than the checkpoint
- [ ] A projection with 1000 existing events and 10 new events rebuilds in under 200ms
- [ ] `--rebuild` flag forces a full rebuild from sequence 1
- [ ] Schema version changes trigger automatic full rebuilds
- [ ] Projection files are atomically written (write to temp file, then rename)
- [ ] Corrupted projection files are detected (hash mismatch) and trigger full rebuild
- [ ] Incremental builds produce identical results to full rebuilds (deterministic)

**Edge Cases**

- Projection file exists but is empty (0 bytes): detected as corrupt, full rebuild.
- Projection file is valid JSON but missing `_projection_type`: detected as corrupt.
- Temp file from a previous crashed write exists: cleaned up before writing new temp file.
- Disk full during write: temp file is written, rename fails, original projection is preserved.

**Estimated Effort**: M (3-5 hours)

---

### Task 11: Projection Cache

**Description**

Implement an in-memory LRU cache for frequently accessed projections in the daemon. The cache eliminates repeated disk reads and JSON parsing for hot projections.

**Prerequisites/Inputs**

- Task 3 (Daemon Event Bus for cache invalidation on new events).
- Task 10 (Projection engine for loading projections on cache miss).

**Implementation Details**

File: `src/daemon/projection-cache.ts`

```typescript
export interface ProjectionCacheKey {
  projectId: string;
  sessionId?: string;       // undefined for cross-session projections
  projectionType: string;
}

interface CachedEntry {
  data: unknown;
  sizeBytes: number;
  cachedAt: number;         // Date.now()
  lastAccessed: number;
  hits: number;
  lastSequence: number;
}

export interface CacheConfig {
  maxSizeBytes: number;         // Default: 50MB (50 * 1024 * 1024)
  maxEntries: number;           // Default: 500
  evictionPolicy: 'lru';       // Only LRU for now
  prewarmSessionsPerProject: number;  // Default: 10
  prewarmProjectionTypes: string[];   // Default: ['context', 'timeline', 'usage']
}

export interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  maxSizeBytes: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  hitRate: number;
}

export class ProjectionCache {
  private entries: Map<string, CachedEntry> = new Map();
  private config: CacheConfig;
  private totalSizeBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSizeBytes: config.maxSizeBytes || 50 * 1024 * 1024,
      maxEntries: config.maxEntries || 500,
      evictionPolicy: 'lru',
      prewarmSessionsPerProject: config.prewarmSessionsPerProject || 10,
      prewarmProjectionTypes: config.prewarmProjectionTypes || ['context', 'timeline', 'usage'],
    };
  }

  private keyString(key: ProjectionCacheKey): string {
    return `${key.projectId}:${key.sessionId || '__cross__'}:${key.projectionType}`;
  }

  get(key: ProjectionCacheKey): unknown | null {
    const entry = this.entries.get(this.keyString(key));
    if (!entry) {
      this.missCount++;
      return null;
    }
    entry.lastAccessed = Date.now();
    entry.hits++;
    this.hitCount++;
    return entry.data;
  }

  set(key: ProjectionCacheKey, data: unknown, sizeBytes: number, lastSequence: number): void {
    const ks = this.keyString(key);

    // Remove existing entry if present
    const existing = this.entries.get(ks);
    if (existing) {
      this.totalSizeBytes -= existing.sizeBytes;
      this.entries.delete(ks);
    }

    // Evict if needed
    this.evictIfNeeded(sizeBytes);

    const entry: CachedEntry = {
      data,
      sizeBytes,
      cachedAt: Date.now(),
      lastAccessed: Date.now(),
      hits: 0,
      lastSequence,
    };

    this.entries.set(ks, entry);
    this.totalSizeBytes += sizeBytes;
  }

  invalidate(key: ProjectionCacheKey): void {
    const ks = this.keyString(key);
    const entry = this.entries.get(ks);
    if (entry) {
      this.totalSizeBytes -= entry.sizeBytes;
      this.entries.delete(ks);
    }
  }

  invalidateSession(projectId: string, sessionId: string): void {
    const prefix = `${projectId}:${sessionId}:`;
    for (const [ks, entry] of this.entries) {
      if (ks.startsWith(prefix)) {
        this.totalSizeBytes -= entry.sizeBytes;
        this.entries.delete(ks);
      }
    }
  }

  invalidateProject(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const [ks, entry] of this.entries) {
      if (ks.startsWith(prefix)) {
        this.totalSizeBytes -= entry.sizeBytes;
        this.entries.delete(ks);
      }
    }
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.entries.size,
      totalSizeBytes: this.totalSizeBytes,
      maxSizeBytes: this.config.maxSizeBytes,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      hitRate: total > 0 ? this.hitCount / total : 0,
    };
  }

  /** Pre-warm cache with recent projections (async, non-blocking) */
  async prewarm(eventsDir: string, projectionsDir: string): Promise<void> {
    // Scan project directories, find N most recent sessions per project,
    // load their projection files into cache.
    // Implementation deferred to integration with projection engine.
  }

  private evictIfNeeded(incomingSizeBytes: number): void {
    const targetSize = this.config.maxSizeBytes * 0.8; // Evict to 80%

    while (
      (this.totalSizeBytes + incomingSizeBytes > this.config.maxSizeBytes ||
       this.entries.size >= this.config.maxEntries) &&
      this.entries.size > 0
    ) {
      // Find LRU entry
      let oldestKey = '';
      let oldestAccess = Infinity;
      for (const [ks, entry] of this.entries) {
        if (entry.lastAccessed < oldestAccess) {
          oldestAccess = entry.lastAccessed;
          oldestKey = ks;
        }
      }

      if (oldestKey) {
        const entry = this.entries.get(oldestKey)!;
        this.totalSizeBytes -= entry.sizeBytes;
        this.entries.delete(oldestKey);
        this.evictionCount++;
      }

      // Check if we've freed enough
      if (this.totalSizeBytes + incomingSizeBytes <= targetSize &&
          this.entries.size < this.config.maxEntries) {
        break;
      }
    }
  }
}
```

**Event bus integration** (wire up cache invalidation):

```typescript
// In daemon initialization:
bus.subscribe({}, (event) => {
  // Invalidate per-session projections for this session
  cache.invalidateSession(event.project_id, event.session_id);
  // Note: cross-session projections are NOT eagerly invalidated.
  // They are checked for staleness on access.
});
```

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cache/stats` | Cache statistics |
| POST | `/api/cache/invalidate` | Force cache invalidation (body: `{ projectId, sessionId? }`) |
| POST | `/api/cache/prewarm` | Trigger cache pre-warming |

**Acceptance Criteria**

- [ ] Cache stores projections in memory with configurable size limit (default 50MB)
- [ ] Cache hit returns projection without disk I/O
- [ ] Cache miss triggers disk read and stores result
- [ ] New events invalidate all cached per-session projections for that session
- [ ] Cross-session projections are marked stale (not eagerly rebuilt) on new events
- [ ] LRU eviction removes least-recently-accessed entries when cache is full
- [ ] Eviction triggers at 100% capacity and frees to 80% (prevents thrashing)
- [ ] Pre-warming loads N most recent sessions' projections on daemon startup
- [ ] Pre-warming runs asynchronously and does not block daemon startup
- [ ] Cache statistics exposed via `/api/cache/stats`
- [ ] Cache never exceeds configured memory budget
- [ ] Cache operations (get, set, invalidate) complete in under 1ms

**Edge Cases**

- Single very large projection (>50MB): cannot be cached, served from disk always.
- All entries evicted in a single eviction cycle: cache is empty but functional.
- Pre-warming finds no projection files on disk: cache starts empty, populated on demand.
- Concurrent invalidation and read: use Map operations which are atomic in single-threaded Node.js.

**Estimated Effort**: M (4-6 hours)

---

### Task 12: /recall Skill Enhancement

**Description**

Extend the `/recall` skill to work across all agent types, follow session chains, and format cross-agent context clearly. This modifies the existing `src/lib/context_loader.sh` and `src/lib/format_context.sh`.

**Prerequisites/Inputs**

- Task 2 (session.json has `agent_provider` field).
- Task 7 (session chain resolution).
- Existing `/recall` implementation: `src/lib/context_loader.sh`, `src/lib/format_context.sh`, `src/skills/recall/SKILL.md`.

**Implementation Details**

File: `src/lib/context_loader.sh` -- extend `load_context()`

**Multi-agent recall flow:**

```bash
# recall_context(project_id, [options])
# Options:
#   --cross-agent     Include sessions from all agent types (default: false)
#   --include-chain   Follow session chains (default: false)
#   --max-sessions N  Maximum sessions to include (default: 3)
#   --max-events N    Maximum events across all sessions (default: 500)

recall_context() {
  local project_id="$1"
  shift
  local cross_agent=false
  local include_chain=false
  local max_sessions=3
  local max_events=500

  # Parse options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cross-agent)    cross_agent=true; shift ;;
      --include-chain)  include_chain=true; shift ;;
      --max-sessions)   max_sessions="$2"; shift 2 ;;
      --max-events)     max_events="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Find recent sessions, optionally across agent types
  local sessions
  sessions=$(_find_recent_sessions "$project_id" "$max_sessions" "$cross_agent")

  # If include-chain, resolve chain for the most recent session
  if [ "$include_chain" = "true" ]; then
    local latest_session
    latest_session=$(echo "$sessions" | jq -r '.[0].session_id')
    local chain
    chain=$(resolve_session_chain "$project_id" "$latest_session")
    # Merge chain sessions with recent sessions (deduplicate)
    sessions=$(_merge_sessions "$sessions" "$chain" "$max_sessions")
  fi

  # Load context for each session
  local combined_context="[]"
  local total_events=0
  echo "$sessions" | jq -c '.[]' | while read -r session_entry; do
    local sid
    sid=$(echo "$session_entry" | jq -r '.session_id')
    local agent_provider
    agent_provider=$(echo "$session_entry" | jq -r '.agent_provider // "unknown"')

    if [ "$total_events" -ge "$max_events" ]; then
      break
    fi

    local ctx
    ctx=$(load_context "$project_id" "$sid")
    if [ -n "$ctx" ]; then
      # Annotate with agent provider
      ctx=$(echo "$ctx" | jq --arg ap "$agent_provider" '. + {agent_provider: $ap}')
      combined_context=$(echo "$combined_context" | jq --argjson c "$ctx" '. + [$c]')
      local ec
      ec=$(echo "$ctx" | jq -r '.event_count // 0')
      total_events=$((total_events + ec))
    fi
  done

  echo "$combined_context"
}
```

File: `src/lib/format_context.sh` -- extend `format_markdown()`

**Cross-agent context formatting:**

```bash
# format_recall_markdown(combined_context_json)
# Formats multi-session, multi-agent context as markdown suitable for
# injection into any agent conversation.

format_recall_markdown() {
  local context="$1"
  local session_count
  session_count=$(echo "$context" | jq 'length')

  echo "## Previous Context (Recalled)"
  echo ""

  echo "$context" | jq -c '.[]' | while read -r session_ctx; do
    local sid model agent_provider started_at event_count last_prompt
    sid=$(echo "$session_ctx" | jq -r '.session_id // "unknown"')
    model=$(echo "$session_ctx" | jq -r '.model // "unknown"')
    agent_provider=$(echo "$session_ctx" | jq -r '.agent_provider // "unknown"')
    started_at=$(echo "$session_ctx" | jq -r '.started_at // "unknown"')
    event_count=$(echo "$session_ctx" | jq -r '.event_count // 0')
    last_prompt=$(echo "$session_ctx" | jq -r '.last_prompt // "N/A"')

    # Agent display name
    local agent_display
    case "$agent_provider" in
      claude-code) agent_display="Claude Code" ;;
      opencode)    agent_display="OpenCode" ;;
      codex)       agent_display="Codex" ;;
      *)           agent_display="Unknown Agent" ;;
    esac

    echo "### Session $sid ($agent_display, $model)"
    echo "*${started_at:0:16} ($event_count events)*"
    echo ""

    # Note for cross-agent sessions
    if [ "$agent_provider" != "claude-code" ] && [ "$agent_provider" != "unknown" ]; then
      echo "*Note: This session was created with a different agent ($agent_display)*"
      echo ""
    fi

    echo "**Last prompt**: $last_prompt"
    echo ""

    # Key decisions (if available in context projection)
    local decisions
    decisions=$(echo "$session_ctx" | jq -r '.decisions // [] | .[-3:] | .[] | "- " + .' 2>/dev/null)
    if [ -n "$decisions" ]; then
      echo "**Key decisions**:"
      echo "$decisions"
      echo ""
    fi

    # Files modified (if available)
    local files
    files=$(echo "$session_ctx" | jq -r '.files_modified // [] | .[-10:] | .[] // empty' 2>/dev/null)
    if [ -n "$files" ]; then
      echo "**Files modified**: $(echo "$files" | tr '\n' ', ' | sed 's/,$//')"
      echo ""
    fi

    echo "---"
    echo ""
  done
}
```

**Acceptance Criteria**

- [ ] `/recall` returns context from the most recent session regardless of agent type
- [ ] Cross-agent context clearly identifies which agent type and model were used
- [ ] Session chain recall follows `parent_session_id` links across agent boundaries
- [ ] When sessions from different agents exist, all are included (with `--cross-agent`)
- [ ] Recall output formatted as markdown suitable for injection into any agent conversation
- [ ] Recall performance: under 2 seconds for a single session, under 5 seconds with chain (up to 5 sessions)
- [ ] Recall gracefully handles sessions with missing or corrupted projection files

**Edge Cases**

- No previous sessions for the project: return empty context with a message.
- All previous sessions are from a different agent type: still returned with cross-agent enabled.
- Session chain has a broken link: partial chain is returned.
- Very large context projection (>100KB): truncate to most recent events.

**Estimated Effort**: M (4-6 hours)

---

### Task 13: Integration Tests

**Description**

Create a comprehensive integration test suite that validates the full event pipeline from capture-event through daemon notification, event bus, projections, search, watch, and recall.

**Prerequisites/Inputs**

- All previous tasks (1-12) implemented.

**Implementation Details**

**Test files to create:**

| File | Purpose |
|------|---------|
| `tests/10-udp-notification.sh` | capture-event UDP notification |
| `tests/10-session-metadata.sh` | Enhanced session.json fields |
| `tests/10-usage-projection.sh` | Per-session usage projection |
| `tests/10-cross-session.sh` | Cross-session projections |
| `tests/10-session-chain.sh` | Session chaining |
| `tests/10-search.sh` | Full-text search (grep-based) |
| `tests/10-recall.sh` | Enhanced /recall |
| `tests/daemon/event-bus.test.ts` | Event bus unit tests |
| `tests/daemon/search-index.test.ts` | Inverted index unit tests |
| `tests/daemon/projection-cache.test.ts` | Cache unit tests |
| `tests/daemon/event-watcher.test.ts` | Filesystem watcher tests |
| `tests/10-all.sh` | Runner for all Story 04 tests |

**Key test cases (from story testing plan):**

| ID | Test | Validates |
|----|------|-----------|
| T-1 | Event bus: publish event, verify subscriber receives it | Task 3 |
| T-2 | Event bus: filtered subscription only receives matching events | Task 3 |
| T-3 | Event bus: deduplicate same event from UDP + watcher | Task 3 |
| T-7 | Session metadata: agent_provider detection for Claude Code | Task 2 |
| T-10 | Token usage accumulation across multiple TurnCompleted events | Task 2 |
| T-12 | Usage projection: per-turn token breakdown correct | Task 5 |
| T-13 | Usage projection: cost estimation matches expected values | Task 5 |
| T-15 | Cross-session usage-daily: aggregates across 5 sessions | Task 6 |
| T-17 | Session chain: resolves 3-session chain in correct order | Task 7 |
| T-18 | Session chain: handles broken parent link | Task 7 |
| T-19 | Session chain: detects circular reference | Task 7 |
| T-20 | Search index: find keyword in prompt | Task 8 |
| T-21 | Search index: file path partial match | Task 8 |
| T-24 | Projection cache: get/set/invalidate lifecycle | Task 11 |
| T-25 | Projection cache: LRU eviction | Task 11 |
| T-28 | Incremental build: 10 new events same as full rebuild | Task 10 |
| T-31 | capture-event with AGENTCTX_EVENT_PORT sends UDP | Task 1 |
| T-32 | capture-event without AGENTCTX_EVENT_PORT works standalone | Task 1 |

**Test harness** (same pattern as Story 00 tests):

```bash
#!/usr/bin/env bash
set -euo pipefail
PASS=0; FAIL=0; TEST_TMPDIR=""

setup() {
  TEST_TMPDIR=$(mktemp -d)
  export HOME="$TEST_TMPDIR/home"
  export CLAUDE_CONTEXT_PATH="$TEST_TMPDIR/gc-store"
  mkdir -p "$HOME/.claude" "$CLAUDE_CONTEXT_PATH/events" "$CLAUDE_CONTEXT_PATH/projections"
  # Copy required scripts
  export PATH="/home/meywd/GlobalContext/src/bin:$PATH"
}

teardown() { rm -rf "$TEST_TMPDIR"; }
trap teardown EXIT
```

**Performance test** (bash-based, run separately):

```bash
# T-46: UDP notification latency
# Measure 100 invocations of capture-event with and without AGENTCTX_EVENT_PORT
# Verify delta is < 5ms average
```

**Acceptance Criteria**

- [ ] All bash-side tests pass (`tests/10-all.sh` exits 0)
- [ ] All TypeScript daemon tests pass (run with Node.js test runner)
- [ ] Tests use isolated temp directories (no real `~/.claude-context/` touched)
- [ ] Performance tests meet the targets defined in the story
- [ ] Tests cover all edge cases listed in the story (E-1 through E-10)

**Estimated Effort**: L (8-12 hours)

---

## File Summary

All paths relative to `/home/meywd/GlobalContext/`.

### New Files

| File | Task | Type | Purpose |
|------|------|------|---------|
| `src/daemon/event-bus.ts` | 3 | TypeScript | Internal pub/sub event bus |
| `src/daemon/udp-receiver.ts` | 3 | TypeScript | UDP notification listener |
| `src/daemon/event-watcher.ts` | 4 | TypeScript | Filesystem watcher for new events |
| `src/daemon/session-chain.ts` | 7 | TypeScript | Session chain resolution (daemon) |
| `src/daemon/search-index.ts` | 8 | TypeScript | Inverted index for full-text search |
| `src/daemon/projection-cache.ts` | 11 | TypeScript | In-memory LRU projection cache |
| `src/projections/handlers/usage.mjs` | 5 | JavaScript | Per-session usage projection builder |
| `src/projections/handlers/usage-daily.mjs` | 6 | JavaScript | Cross-session daily usage aggregation |
| `src/projections/handlers/usage-by-model.mjs` | 6 | JavaScript | Cross-session per-model aggregation |
| `src/projections/handlers/files-aggregate.mjs` | 6 | JavaScript | Cross-session files aggregate |
| `src/projections/handlers/session-chain.mjs` | 7 | JavaScript | Session chain graph builder |
| `src/projections/lib/cross-session.mjs` | 6 | JavaScript | Cross-session projection utilities |
| `src/api/events-stream.ts` | 9b | TypeScript | SSE/WebSocket event streaming endpoints |
| `src/api/search.ts` | 8b | TypeScript | Search API endpoints |
| `src/cli/watch.ts` | 9 | TypeScript | `agentctx watch` CLI command |
| `src/cli/search.ts` | 8b | TypeScript | `agentctx search` CLI command |
| `tests/10-udp-notification.sh` | 13 | Bash | UDP notification tests |
| `tests/10-session-metadata.sh` | 13 | Bash | Session metadata tests |
| `tests/10-usage-projection.sh` | 13 | Bash | Usage projection tests |
| `tests/10-cross-session.sh` | 13 | Bash | Cross-session projection tests |
| `tests/10-session-chain.sh` | 13 | Bash | Session chain tests |
| `tests/10-search.sh` | 13 | Bash | Search tests |
| `tests/10-recall.sh` | 13 | Bash | Enhanced /recall tests |
| `tests/daemon/event-bus.test.ts` | 13 | TypeScript | Event bus unit tests |
| `tests/daemon/search-index.test.ts` | 13 | TypeScript | Search index unit tests |
| `tests/daemon/projection-cache.test.ts` | 13 | TypeScript | Cache unit tests |
| `tests/daemon/event-watcher.test.ts` | 13 | TypeScript | Watcher unit tests |
| `tests/10-all.sh` | 13 | Bash | Test runner |

### Modified Files

| File | Task | Change |
|------|------|--------|
| `src/capture-event` | 1, 2 | Add UDP notification block; extend session.json updates with new fields |
| `src/lib/session_meta.sh` | 2 | Add helper functions for agent detection, token accumulation |
| `src/lib/session_chain.sh` | 7 | Extend with multi-agent chain resolution |
| `src/lib/context_loader.sh` | 12 | Support multi-agent recall, chain-based context loading |
| `src/lib/format_context.sh` | 12 | Cross-agent context formatting in markdown |
| `src/projections/lib/registry.mjs` | 5 | Register `usage` projection type |
| `src/projections/lib/incremental.mjs` | 10 | Add checkpoint hashing, corruption detection, atomic writes |
| `src/bin/gc-query` | 8b, 9 | Add `search` subcommand; extend `watch` for standalone fallback |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone | Estimate |
|-------|-------|-----------|----------|
| **Phase 1: Write-Side Enhancements** | Task 1 (UDP Notification), Task 2 (Session Metadata) | capture-event sends daemon notifications, session.json has all new fields | 1-2 days |
| **Phase 2: Daemon Core** | Task 3 (Event Bus), Task 4 (Filesystem Watcher) | Daemon can receive and distribute events | 1-2 days |
| **Phase 3: Projections** | Task 5 (Usage Projection), Task 10 (Incremental Engine Enhancement) | Per-session usage projection with enhanced incremental builds | 1-2 days |
| **Phase 4: Cross-Session** | Task 6 (Cross-Session Projections), Task 7 (Session Chaining) | Cross-session aggregation and chain resolution | 2-3 days |
| **Phase 5: Search & Watch** | Task 8 (Search Index), Task 8b (Search CLI/API), Task 9 (Watch CLI), Task 9b (SSE/WS) | Full-text search and live monitoring | 2-3 days |
| **Phase 6: Cache & Recall** | Task 11 (Projection Cache), Task 12 (/recall Enhancement) | Caching and cross-agent context recovery | 1-2 days |
| **Phase 7: Testing** | Task 13 (Integration Tests) | Full test coverage | 2-3 days |

Tasks within each phase can be partially parallelized. Phase 1 must complete before Phase 2. Phase 3 depends on Phase 1 but not Phase 2. Phases 5 and 6 can proceed in parallel after Phase 4.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `/dev/udp` not available on all bash builds | Medium | Low | Fallback: if `/dev/udp` fails, try `nc -u` or skip notification. `|| true` ensures no impact on capture-event. |
| `fs.watch` recursive mode inconsistent across platforms | Medium | Medium | Use platform detection: `fs.watch` with `recursive: true` on macOS (FSEvents) and Linux (inotify). Fall back to polling on unsupported platforms. |
| Inverted index memory usage exceeds 128MB Node.js default | Low | Medium | Index only selected fields (not full responses). Monitor memory usage. Add index size limit config. At 100K events, estimated 5-10MB. |
| jq performance bottleneck in session.json updates | Medium | Low | All jq operations are on small files (<10KB). At typical event rates (1-5/sec), jq latency is negligible. |
| Cross-session projection rebuild takes >60s for large projects | Low | Medium | Incremental builds with checkpoints. Only changed sessions are re-processed. Full rebuilds are rare (only on version bump). |
| WebSocket/SSE connections leak on daemon crash | Low | Low | OS cleans up sockets on process exit. Clients reconnect with backoff. |
| Circular session chains cause infinite loop | Very Low | High | Max depth limit (100) in chain resolution. Visited-set tracking. |
| Token usage data not available from non-Claude agents | High | Low | All token fields default to 0. Usage projections show $0.00 for sessions without data. Not an error. |
| Concurrent access to session.json from multiple processes | Low | Medium | All writes happen within existing flock scope. Reads tolerate stale data (eventually consistent). |
| Daemon and standalone mode produce inconsistent search results | Medium | Medium | Grep-based search is the ground truth. Inverted index is an acceleration layer. Both use same tokenization rules. |

---

## Notes for Implementation

1. **No external npm dependencies.** The daemon uses Node.js built-in modules only (net, dgram, fs, crypto, http, events). This follows the existing project convention established in Stories 01-05.

2. **TypeScript compilation.** Daemon files use `.ts` extension. Decide on build strategy: either use `tsx` for direct execution or compile to `.mjs` alongside existing projection handlers. The existing projection engine uses `.mjs` files directly with Node.js.

3. **daemon.json location.** The daemon writes its runtime config (PID, ports) to `~/.claude-context/daemon.json`. This file is ephemeral -- it is written on startup and deleted on clean shutdown. `capture-event` reads it as a fallback for the UDP port.

4. **Cross-session projection storage.** Cross-session projections live at `projections/{project-id}/cross-session/` to avoid collision with per-session projection directories.

5. **Model pricing updates.** The `MODEL_PRICING` table in `usage.mjs` will need updates as new models are released. Consider making this a config file (`~/.claude-context/model-pricing.json`) that can be updated independently of code.

6. **Event bus ordering guarantee.** Events are delivered to subscribers in publish order. Within a session, this matches sequence order because `capture-event` writes sequentially within a flock. Across sessions, ordering is best-effort (depends on arrival order from UDP/watcher).

7. **Backward compatibility.** All code that reads session.json must use `// 0` or `// null` jq defaults for new fields. Existing session.json files without the new fields must remain readable. The projection engine handles missing projections by triggering full rebuilds.

8. **Performance testing.** The story defines specific performance targets (T-46 through T-54). These should be measured in CI with a reproducible event store fixture (generated synthetically).

---

## Effort Estimates

| Task | Complexity | Estimate |
|------|------------|----------|
| Task 1: capture-event UDP Notification | S | 2-3 hours |
| Task 2: Session Metadata Enhancement | M | 4-6 hours |
| Task 3: Daemon Event Bus | M | 4-6 hours |
| Task 4: Filesystem Watcher | M | 4-6 hours |
| Task 5: Usage Projection -- Per-Session | M | 4-6 hours |
| Task 6: Cross-Session Projections | L | 6-8 hours |
| Task 7: Session Chaining | M | 4-6 hours |
| Task 8: Full-Text Search Index | L | 8-10 hours |
| Task 8b: Search CLI and API | S | 2-4 hours |
| Task 9: Live Event Monitor (CLI) | M | 4-6 hours |
| Task 9b: SSE/WebSocket Streaming | M | 4-6 hours |
| Task 10: Incremental Projection Engine Enhancement | M | 3-5 hours |
| Task 11: Projection Cache | M | 4-6 hours |
| Task 12: /recall Skill Enhancement | M | 4-6 hours |
| Task 13: Integration Tests | L | 8-12 hours |
| **Total** | | **~63-96 hours (~8-12 working days)** |
