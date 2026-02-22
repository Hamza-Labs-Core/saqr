# Story 09: Multi-Agent Hook System

## Overview

The Multi-Agent Hook System extends GlobalContext from a Claude Code-only event capture system to a unified, multi-agent event platform. The AgentContext daemon attaches to multiple coding agents -- Claude Code, OpenCode, and Codex -- via per-integration hook installers, normalizing their disparate event formats into a single set of 12 unified event types. Every agent's lifecycle events flow through the same event store and projection pipeline, regardless of which agent produced them.

The existing GlobalContext implementation (Stories 00-06) captures events exclusively from Claude Code via its `settings.json` hook system. This story defines the architecture for a generalized hook layer that treats Claude Code as one of several agent integrations. Each integration has its own hook mechanism -- Claude Code uses `settings.json` command hooks, OpenCode uses a plugin-based event system with an HTTP API, and Codex uses JSONL protocol over session file watchers -- but all produce the same unified event envelope.

This story also introduces the `agentctx` CLI as the management interface for the multi-agent hook system. It provides per-integration installers (`agentctx install --claude-code`, `--opencode`, `--codex`), a health check system (`agentctx doctor`), hot-reload capabilities for updating hooks without restarting agents, and a custom hook extension protocol for community-contributed integrations with future agents.

The design follows the same CQRS principles established in the original GlobalContext: the hook layer is the write side -- fast, dumb, and reliable. It does not interpret or transform agent-specific payloads beyond wrapping them in a unified event envelope. All intelligence lives downstream in projections and the query layer.

---

## Scope

### In Scope

| Concern | Description |
|---------|-------------|
| Unified event type system | 12 event types with TypeScript interfaces and mapping tables |
| Claude Code hook integration (F1.1) | Existing 10-hook system via `settings.json`, migration to daemon |
| OpenCode hook integration (F1.2) | Plugin-based hooks via `.opencode/plugins/` and `opencode serve` HTTP API |
| Codex hook integration (F1.3) | JSONL protocol hooks via session file watcher |
| Per-integration installer (F1.4) | `agentctx install --claude-code`, `--opencode`, `--codex` |
| Hook health check (F1.5) | `agentctx doctor` with per-integration diagnostics |
| Hot-reload hooks (F1.6) | Update hook configs without restarting agents |
| Custom hook extensions (F1.7) | Generic stdin/stdout protocol for future agents |
| Event envelope format | Unified envelope wrapping agent-specific data |
| Agent detection | Auto-detection of installed agents on the system |

### Out of Scope (Non-Goals)

| Concern | Reason |
|---------|--------|
| Agent process orchestration (F3) | Covered by a separate story; this story only captures events |
| Local dashboard (F4) | Downstream consumer of events; separate story |
| Encrypted cloud sync (F5) | Separate story; this story produces local events only |
| Session attach mode (F12) | Separate story; hooks are passive observers, not interactive |
| Projection engine changes | Existing projection engine (Story 04) consumes unified events without modification |
| Event store schema changes | The unified event envelope is backward-compatible with the existing envelope from Story 01 |
| MCP server integration | Agent management as MCP tools is part of F3, not F1 |
| Mobile/desktop rendering | Downstream consumer; separate story (F13) |

---

## Requirements

### 1. Unified Event Type System

The unified event type system defines 12 event types that normalize across all supported coding agents. Every event captured by any integration is mapped to one of these types before being written to the event store.

#### 1.1 Unified Event Types

| # | Event Type | Description | Sync/Async |
|---|-----------|-------------|------------|
| 1 | `SessionStarted` | An agent session has begun | sync |
| 2 | `UserPromptReceived` | The user submitted a prompt to the agent | sync |
| 3 | `ToolCallRequested` | The agent intends to invoke a tool | async |
| 4 | `ToolCallCompleted` | A tool call finished successfully | async |
| 5 | `ToolCallFailed` | A tool call failed or was interrupted | async |
| 6 | `AgentSpawned` | A sub-agent was created | async |
| 7 | `AgentCompleted` | A sub-agent finished its work | async |
| 8 | `TurnCompleted` | The agent finished its response turn | async |
| 9 | `CompactionTriggered` | Context was compacted/summarized | sync |
| 10 | `SessionEnded` | The agent session has ended | async |
| 11 | `PermissionRequested` | The agent requested permission for an action | async |
| 12 | `PermissionResponded` | The user responded to a permission request | async |

#### 1.2 Agent-to-Unified Mapping Table

| Unified Event | Claude Code Source | OpenCode Source | Codex Source |
|---------------|-------------------|-----------------|--------------|
| `SessionStarted` | `SessionStart` hook | `session.created` event | Process spawn detected |
| `UserPromptReceived` | `UserPromptSubmit` hook | `message.updated` (role=user) | stdin message parse |
| `ToolCallRequested` | `PreToolUse` hook | `tool.execute.before` event | JSONL `tool_use` message |
| `ToolCallCompleted` | `PostToolUse` hook | `tool.execute.after` event | JSONL `tool_result` message |
| `ToolCallFailed` | `PostToolUseFailure` hook | `tool.execute.after` (error=true) | JSONL `tool_error` message |
| `AgentSpawned` | `SubagentStart` hook | N/A (not supported) | N/A (not supported) |
| `AgentCompleted` | `SubagentStop` hook | N/A (not supported) | N/A (not supported) |
| `TurnCompleted` | `Stop` hook | `session.idle` event | JSONL `turn_end` message |
| `CompactionTriggered` | `PreCompact` hook | `session.compacted` event | N/A (not supported) |
| `SessionEnded` | `SessionEnd` hook | `session.deleted` event | Process exit detected |
| `PermissionRequested` | N/A (inline in tool flow) | `permission.asked` event | JSONL `permission` message |
| `PermissionResponded` | N/A (inline in tool flow) | `permission.replied` event | JSONL `permission_response` message |

When an event type is listed as "N/A" for an agent, that agent does not produce that event. The hook integration must not synthesize events that the agent does not natively emit.

#### 1.3 TypeScript Interfaces

All unified events share a common envelope and include agent-specific metadata.

```typescript
/**
 * Identifies which agent integration produced this event.
 */
type AgentProvider = "claude-code" | "opencode" | "codex" | "custom";

/**
 * The 12 unified event types.
 */
type UnifiedEventType =
  | "SessionStarted"
  | "UserPromptReceived"
  | "ToolCallRequested"
  | "ToolCallCompleted"
  | "ToolCallFailed"
  | "AgentSpawned"
  | "AgentCompleted"
  | "TurnCompleted"
  | "CompactionTriggered"
  | "SessionEnded"
  | "PermissionRequested"
  | "PermissionResponded";

/**
 * Unified event envelope. Every event captured by any integration
 * is wrapped in this structure before being written to the event store.
 *
 * This is backward-compatible with the Story 01 event envelope:
 * the original 7 fields (event_id, event_type, project_id, session_id,
 * sequence, timestamp, data) are preserved. New fields are additive.
 */
interface UnifiedEvent {
  /** UUID v4, globally unique */
  event_id: string;

  /** One of the 12 unified event types */
  event_type: UnifiedEventType;

  /** Project identifier: {basename}-{hash6} */
  project_id: string;

  /** Session identifier from the agent */
  session_id: string;

  /** Per-session monotonically increasing counter (1-based) */
  sequence: number;

  /** ISO 8601 UTC timestamp with millisecond precision */
  timestamp: string;

  /** Which agent integration produced this event */
  agent_provider: AgentProvider;

  /** The agent's native event type before normalization */
  agent_native_event: string;

  /** Agent-specific metadata (model, version, etc.) */
  agent_metadata: AgentMetadata;

  /** The complete, unmodified payload from the agent's native hook */
  data: Record<string, unknown>;
}

/**
 * Agent-specific metadata included in every event.
 */
interface AgentMetadata {
  /** Agent name and version, e.g. "claude-code/1.0.38" */
  agent_version?: string;

  /** Model being used, e.g. "claude-opus-4-6" */
  model?: string;

  /** PID of the agent process, for correlation */
  agent_pid?: number;

  /** Working directory of the agent */
  cwd?: string;
}
```

#### 1.4 Event Envelope JSON Format

The on-disk JSON format for a unified event:

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "ToolCallCompleted",
  "project_id": "my-project-a3f7b2",
  "session_id": "abc123-def456",
  "sequence": 42,
  "timestamp": "2026-02-21T14:30:00.123Z",
  "agent_provider": "claude-code",
  "agent_native_event": "PostToolUse",
  "agent_metadata": {
    "agent_version": "claude-code/1.0.38",
    "model": "claude-opus-4-6",
    "agent_pid": 12345,
    "cwd": "/home/user/my-project"
  },
  "data": {
    "session_id": "abc123-def456",
    "tool_name": "Write",
    "tool_input": { "file_path": "/src/main.ts", "content": "..." },
    "tool_response": "File written successfully",
    "tool_use_id": "tu_abc123"
  }
}
```

#### 1.5 Backward Compatibility

The unified event envelope is a strict superset of the Story 01 envelope. The original 7 fields are preserved in the same positions. New fields (`agent_provider`, `agent_native_event`, `agent_metadata`) are additive. Existing projections that read only the original 7 fields continue to work without modification.

For Claude Code events captured by the existing GC hooks (before migration to the daemon), the `agent_provider` field defaults to `"claude-code"` and `agent_native_event` contains the Claude Code hook name (e.g., `"PostToolUse"`).

#### Acceptance Criteria

- [ ] All 12 unified event types are defined with clear descriptions
- [ ] The mapping table covers all supported agents (Claude Code, OpenCode, Codex) with N/A entries where events are not supported
- [ ] TypeScript interfaces are defined for `UnifiedEvent`, `AgentMetadata`, `AgentProvider`, and `UnifiedEventType`
- [ ] The unified event envelope is backward-compatible with the Story 01 envelope (all 7 original fields preserved)
- [ ] The `agent_provider` field correctly identifies which integration produced the event
- [ ] The `agent_native_event` field preserves the original event name from the agent's native system
- [ ] The `data` field contains the complete, unmodified agent-native payload
- [ ] Events without an agent equivalent (N/A) are never synthesized

---

### 2. Claude Code Hook Integration (F1.1)

Claude Code integration uses the existing 10-hook system via `~/.claude/settings.json`, as specified in Stories 01-02 and packaged in Story 06. This section defines how the existing hooks are adapted to feed into the AgentContext daemon.

#### 2.1 Existing Hook Architecture (Reference)

The current GlobalContext hooks operate standalone:

```
Claude Code Session
  |
  | settings.json hooks (10 events)
  v
gc-hook wrapper
  |
  | stdin passthrough
  v
capture-event
  |
  | atomic file write
  v
~/.claude-context/events/{project-id}/{session-id}/{sequence}.json
```

#### 2.2 Daemon-Integrated Architecture

In the daemon-integrated architecture, the hooks still fire via `settings.json`, but the `gc-hook` wrapper is replaced by `agentctx-hook` which writes to the daemon's event intake:

```
Claude Code Session
  |
  | settings.json hooks (10 events)
  v
agentctx-hook claude-code <EventType>
  |
  | stdin passthrough + agent_provider tagging
  v
daemon event intake (HTTP POST or Unix socket)
  |
  | normalize to unified event
  v
event store write
```

#### 2.3 Hook Configuration (settings.json)

The `settings.json` hooks are structurally identical to Story 02/06, but reference the new `agentctx-hook` wrapper:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code SessionStarted",
        "async": false,
        "timeout": 5000,
        "matcher": ""
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code UserPromptReceived",
        "async": false,
        "timeout": 5000
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallRequested",
        "async": true,
        "timeout": 5000,
        "matcher": ".*"
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallCompleted",
        "async": true,
        "timeout": 5000,
        "matcher": ".*"
      }
    ],
    "PostToolUseFailure": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallFailed",
        "async": true,
        "timeout": 5000,
        "matcher": ".*"
      }
    ],
    "SubagentStart": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code AgentSpawned",
        "async": true,
        "timeout": 5000,
        "matcher": ".*"
      }
    ],
    "SubagentStop": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code AgentCompleted",
        "async": true,
        "timeout": 5000,
        "matcher": ".*"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code TurnCompleted",
        "async": true,
        "timeout": 5000
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code CompactionTriggered",
        "async": false,
        "timeout": 5000
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "~/.agentctx/bin/agentctx-hook claude-code SessionEnded",
        "async": true,
        "timeout": 5000
      }
    ]
  }
}
```

#### 2.4 agentctx-hook Wrapper Script

```bash
#!/usr/bin/env bash
# AgentContext hook wrapper
# Usage: agentctx-hook <agent-provider> <UnifiedEventType>
# Reads JSON from stdin, tags with agent provider, sends to daemon intake

AGENT_PROVIDER="${1:?Missing agent provider}"
EVENT_TYPE="${2:?Missing event type}"
AGENTCTX_DIR="${AGENTCTX_HOME:-$HOME/.agentctx}"

# Read the full payload from stdin once
payload=$(cat)

# Try daemon intake first (HTTP POST to unix socket)
if [ -S "$AGENTCTX_DIR/daemon.sock" ]; then
  printf '%s' "$payload" | curl -s --unix-socket "$AGENTCTX_DIR/daemon.sock" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Provider: $AGENT_PROVIDER" \
    -H "X-Event-Type: $EVENT_TYPE" \
    -d @- \
    "http://localhost/api/events/intake" \
    >/dev/null 2>/dev/null || true
else
  # Fallback: write directly to event store (standalone mode)
  printf '%s' "$payload" | "$AGENTCTX_DIR/bin/capture-event" "$EVENT_TYPE" \
    --agent-provider "$AGENT_PROVIDER" \
    >/dev/null 2>/dev/null || true
fi

exit 0
```

#### 2.5 Migration Path from Standalone GC to Daemon

| Phase | Hook Command | Event Flow |
|-------|-------------|------------|
| Phase 0 (current GC) | `gc-hook <EventType>` | gc-hook -> capture-event -> file write |
| Phase 1 (agentctx standalone) | `agentctx-hook claude-code <EventType>` | agentctx-hook -> capture-event (with agent_provider) -> file write |
| Phase 2 (agentctx + daemon) | `agentctx-hook claude-code <EventType>` | agentctx-hook -> daemon socket -> event store |

The migration installer (`agentctx install --claude-code`) detects existing GlobalContext hooks in `settings.json` (identified by the `gc-hook` substring in the command field) and replaces them with `agentctx-hook` commands. Existing event data in `~/.claude-context/` is preserved and remains accessible.

```bash
# Migration detection logic
detect_gc_hooks() {
  local settings="$HOME/.claude/settings.json"
  if [ -f "$settings" ]; then
    if jq -e '.hooks // empty | to_entries[] | .value[] | select(.command | contains("gc-hook"))' "$settings" >/dev/null 2>&1; then
      return 0  # GC hooks found
    fi
  fi
  return 1  # No GC hooks
}
```

#### 2.6 Claude Code Native Event Payloads

The 10 Claude Code hook payloads are documented in Story 01 Section 8. Two additional unified events (`PermissionRequested`, `PermissionResponded`) do not have direct Claude Code hooks -- permission handling in Claude Code is inline within the tool flow. These events are not captured for Claude Code.

#### Acceptance Criteria

- [ ] Claude Code hooks are registered in `~/.claude/settings.json` using the `agentctx-hook` wrapper
- [ ] All 10 hook events are mapped to unified event types with `agent_provider: "claude-code"`
- [ ] The `agentctx-hook` wrapper always exits 0 regardless of errors
- [ ] The `agentctx-hook` wrapper produces no stdout output
- [ ] The hook wrapper attempts daemon socket first, falls back to direct file write
- [ ] Migration from standalone GC hooks (`gc-hook`) to `agentctx-hook` is automated
- [ ] Existing GC events in `~/.claude-context/` are preserved during migration
- [ ] The sync/async classification matches Story 02 exactly
- [ ] Matcher configuration matches Story 02 exactly
- [ ] All timeouts remain at 5000ms

---

### 3. OpenCode Hook Integration (F1.2)

OpenCode is an open-source terminal-based AI coding assistant that supports a plugin system and an HTTP API via `opencode serve`. The integration uses both mechanisms: a plugin for event capture and the HTTP API for session monitoring.

#### 3.1 OpenCode Plugin Architecture

OpenCode plugins live in `.opencode/plugins/` within a project directory or in `~/.opencode/plugins/` globally. Each plugin is a directory containing a `plugin.json` manifest and implementation files.

```
~/.opencode/plugins/agentctx/
  plugin.json           # Plugin manifest
  index.ts              # Plugin entry point
  event-handler.ts      # Event normalization logic
```

#### 3.2 Plugin Manifest

```json
{
  "name": "agentctx",
  "version": "1.0.0",
  "description": "AgentContext event capture for OpenCode sessions",
  "author": "AgentContext",
  "events": [
    "session.created",
    "session.deleted",
    "session.idle",
    "session.compacted",
    "message.updated",
    "tool.execute.before",
    "tool.execute.after",
    "permission.asked",
    "permission.replied"
  ],
  "entrypoint": "index.ts"
}
```

#### 3.3 Plugin Entry Point (index.ts)

```typescript
import { Plugin, PluginContext, EventPayload } from "opencode/plugin";
import { normalizeOpenCodeEvent } from "./event-handler";

const AGENTCTX_SOCKET = process.env.AGENTCTX_SOCKET
  || `${process.env.HOME}/.agentctx/daemon.sock`;

export default class AgentCtxPlugin implements Plugin {
  private ctx: PluginContext;

  async onLoad(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Subscribe to all relevant OpenCode events
    ctx.on("session.created", (e) => this.handleEvent("session.created", e));
    ctx.on("session.deleted", (e) => this.handleEvent("session.deleted", e));
    ctx.on("session.idle", (e) => this.handleEvent("session.idle", e));
    ctx.on("session.compacted", (e) => this.handleEvent("session.compacted", e));
    ctx.on("message.updated", (e) => this.handleEvent("message.updated", e));
    ctx.on("tool.execute.before", (e) => this.handleEvent("tool.execute.before", e));
    ctx.on("tool.execute.after", (e) => this.handleEvent("tool.execute.after", e));
    ctx.on("permission.asked", (e) => this.handleEvent("permission.asked", e));
    ctx.on("permission.replied", (e) => this.handleEvent("permission.replied", e));
  }

  async onUnload(): Promise<void> {
    // Cleanup: nothing to do
  }

  private async handleEvent(
    nativeEvent: string,
    payload: EventPayload
  ): Promise<void> {
    try {
      const unified = normalizeOpenCodeEvent(nativeEvent, payload);
      if (!unified) return; // Event not mappable (e.g., message.updated for non-user role)

      await this.sendToDaemon(unified.eventType, unified.data, nativeEvent);
    } catch {
      // Silent failure: never disrupt the OpenCode session
    }
  }

  private async sendToDaemon(
    eventType: string,
    data: Record<string, unknown>,
    nativeEvent: string
  ): Promise<void> {
    const body = JSON.stringify({
      agent_provider: "opencode",
      event_type: eventType,
      agent_native_event: nativeEvent,
      data,
    });

    // Attempt Unix socket POST to daemon
    try {
      const response = await fetch(
        `http://localhost/api/events/intake`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Provider": "opencode",
            "X-Event-Type": eventType,
          },
          body,
          // @ts-ignore -- Node.js fetch unix socket support
          dispatcher: new (await import("undici")).Agent({
            connect: { socketPath: AGENTCTX_SOCKET },
          }),
        }
      );
      if (!response.ok) {
        // Log but do not throw
        console.error(`[agentctx] Daemon returned ${response.status}`);
      }
    } catch {
      // Fallback: write to event store directly via CLI
      const { execSync } = await import("child_process");
      execSync(
        `echo '${body.replace(/'/g, "\\'")}' | ` +
        `~/.agentctx/bin/capture-event "${eventType}" --agent-provider opencode`,
        { timeout: 5000, stdio: "ignore" }
      );
    }
  }
}
```

#### 3.4 Event Normalization (event-handler.ts)

```typescript
import { EventPayload } from "opencode/plugin";

interface NormalizedEvent {
  eventType: string;
  data: Record<string, unknown>;
}

const EVENT_MAP: Record<string, string> = {
  "session.created": "SessionStarted",
  "session.deleted": "SessionEnded",
  "session.idle": "TurnCompleted",
  "session.compacted": "CompactionTriggered",
  "tool.execute.before": "ToolCallRequested",
  "permission.asked": "PermissionRequested",
  "permission.replied": "PermissionResponded",
};

/**
 * Normalize an OpenCode native event into a unified event type and payload.
 * Returns null if the event should not be captured (e.g., non-user messages).
 */
export function normalizeOpenCodeEvent(
  nativeEvent: string,
  payload: EventPayload
): NormalizedEvent | null {
  // Special handling for message.updated: only capture user-role messages
  if (nativeEvent === "message.updated") {
    if (payload.role !== "user") return null;
    return {
      eventType: "UserPromptReceived",
      data: {
        session_id: payload.session_id,
        prompt: payload.content,
        message_id: payload.message_id,
      },
    };
  }

  // Special handling for tool.execute.after: split into completed vs failed
  if (nativeEvent === "tool.execute.after") {
    if (payload.error) {
      return {
        eventType: "ToolCallFailed",
        data: {
          session_id: payload.session_id,
          tool_name: payload.tool_name,
          tool_input: payload.tool_input,
          error: payload.error,
          tool_use_id: payload.tool_use_id,
        },
      };
    }
    return {
      eventType: "ToolCallCompleted",
      data: {
        session_id: payload.session_id,
        tool_name: payload.tool_name,
        tool_input: payload.tool_input,
        tool_response: payload.tool_output,
        tool_use_id: payload.tool_use_id,
      },
    };
  }

  // Direct mapping for all other events
  const unifiedType = EVENT_MAP[nativeEvent];
  if (!unifiedType) return null;

  return {
    eventType: unifiedType,
    data: payload as Record<string, unknown>,
  };
}
```

#### 3.5 OpenCode HTTP API Integration

OpenCode provides `opencode serve` which exposes an HTTP API (OpenAPI 3.1 spec) for programmatic interaction. The daemon can use this API to:

1. **Monitor active sessions**: `GET /api/sessions` lists running sessions
2. **Stream session events**: `GET /api/sessions/{id}/events` (SSE) for real-time event streaming
3. **Query session state**: `GET /api/sessions/{id}` for session metadata

The HTTP API is used as a supplementary data source alongside the plugin hooks. If the plugin fails to load, the daemon can fall back to polling the HTTP API.

```
OpenCode Session
  |
  +-- Plugin hooks (primary) --> agentctx daemon
  |
  +-- opencode serve HTTP API (fallback/supplementary)
        |
        +-- GET /api/sessions         (list active sessions)
        +-- GET /api/sessions/{id}/events  (SSE stream)
```

#### 3.6 OpenCode Event Payloads

| OpenCode Event | Payload Fields | Notes |
|---------------|---------------|-------|
| `session.created` | `{ session_id, model, cwd, created_at }` | First event in a session |
| `session.deleted` | `{ session_id, reason }` | Session cleanup |
| `session.idle` | `{ session_id, last_message_id }` | Agent finished responding |
| `session.compacted` | `{ session_id, before_tokens, after_tokens }` | Context was compacted |
| `message.updated` | `{ session_id, message_id, role, content }` | Message created or updated; filter by role=user for prompts |
| `tool.execute.before` | `{ session_id, tool_name, tool_input, tool_use_id }` | Tool about to run |
| `tool.execute.after` | `{ session_id, tool_name, tool_input, tool_output, error, tool_use_id }` | Tool finished; check `error` field |
| `permission.asked` | `{ session_id, tool_name, description, permission_id }` | Agent needs permission |
| `permission.replied` | `{ session_id, permission_id, granted, always }` | User responded to permission request |

#### Acceptance Criteria

- [ ] OpenCode plugin directory is created at `~/.opencode/plugins/agentctx/` with manifest, entry point, and event handler
- [ ] Plugin subscribes to all 9 relevant OpenCode events
- [ ] `message.updated` events are filtered to only capture role=user (prompts)
- [ ] `tool.execute.after` events are correctly split into `ToolCallCompleted` and `ToolCallFailed`
- [ ] Plugin sends events to daemon via Unix socket with HTTP POST
- [ ] Plugin falls back to direct CLI invocation when daemon socket is unavailable
- [ ] Plugin never disrupts the OpenCode session on failure
- [ ] All OpenCode events are mapped to the correct unified event types
- [ ] Plugin manifest declares all subscribed events

---

### 4. Codex Hook Integration (F1.3)

Codex (OpenAI's CLI coding agent) uses a JSONL protocol for its session communication. Events are captured by watching Codex session files and parsing the JSONL output stream.

#### 4.1 Codex Session Architecture

Codex writes session data as JSONL (newline-delimited JSON) to its working directory. Each line is a message in the protocol:

```
~/.codex/sessions/{session-id}/
  messages.jsonl    # All session messages
  metadata.json     # Session metadata
```

#### 4.2 JSONL Message Types

| JSONL Type | Fields | Maps To |
|-----------|--------|---------|
| `tool_use` | `{ type: "tool_use", id, name, input }` | `ToolCallRequested` |
| `tool_result` | `{ type: "tool_result", tool_use_id, content }` | `ToolCallCompleted` |
| `tool_error` | `{ type: "tool_error", tool_use_id, error }` | `ToolCallFailed` |
| `turn_end` | `{ type: "turn_end", usage }` | `TurnCompleted` |
| `permission` | `{ type: "permission", tool, description, id }` | `PermissionRequested` |
| `permission_response` | `{ type: "permission_response", id, granted }` | `PermissionResponded` |

#### 4.3 File Watcher Implementation

The Codex integration uses a file watcher (inotify on Linux, FSEvents on macOS) to monitor for new Codex session directories and tail the JSONL message files.

```typescript
import { watch } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";

interface CodexWatcherConfig {
  codexSessionDir: string;  // e.g., ~/.codex/sessions/
  daemonSocket: string;
}

class CodexSessionWatcher {
  private activeWatchers: Map<string, AbortController> = new Map();

  constructor(private config: CodexWatcherConfig) {}

  /**
   * Start watching for new Codex sessions.
   * Uses fs.watch on the sessions directory to detect new session directories.
   */
  start(): void {
    watch(this.config.codexSessionDir, { recursive: false }, (event, filename) => {
      if (event === "rename" && filename && !this.activeWatchers.has(filename)) {
        this.watchSession(filename);
      }
    });

    // Also check for already-running sessions on startup
    this.scanExistingSessions();
  }

  /**
   * Watch a specific session's messages.jsonl file for new JSONL lines.
   */
  private async watchSession(sessionId: string): Promise<void> {
    const messagesPath = `${this.config.codexSessionDir}/${sessionId}/messages.jsonl`;
    const controller = new AbortController();
    this.activeWatchers.set(sessionId, controller);

    // Emit SessionStarted for new session detection
    await this.emitEvent("SessionStarted", sessionId, {
      session_id: sessionId,
      source: "process_spawn",
    });

    // Tail the JSONL file
    await this.tailJsonl(messagesPath, sessionId, controller.signal);
  }

  /**
   * Tail a JSONL file, parsing each new line and emitting events.
   */
  private async tailJsonl(
    filePath: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<void> {
    let offset = 0;

    const processNewLines = async (): Promise<void> => {
      const stream = createReadStream(filePath, { start: offset });
      const rl = createInterface({ input: stream });

      for await (const line of rl) {
        if (signal.aborted) break;
        offset += Buffer.byteLength(line, "utf8") + 1; // +1 for newline

        try {
          const message = JSON.parse(line);
          await this.handleCodexMessage(sessionId, message);
        } catch {
          // Skip malformed lines
        }
      }
    };

    // Watch for file changes and process new lines
    const watcher = watch(filePath, async () => {
      if (!signal.aborted) {
        await processNewLines();
      }
    });

    signal.addEventListener("abort", () => watcher.close());

    // Process any existing content
    await processNewLines();
  }

  /**
   * Map a Codex JSONL message to a unified event type and emit it.
   */
  private async handleCodexMessage(
    sessionId: string,
    message: Record<string, unknown>
  ): Promise<void> {
    const typeMap: Record<string, string> = {
      tool_use: "ToolCallRequested",
      tool_result: "ToolCallCompleted",
      tool_error: "ToolCallFailed",
      turn_end: "TurnCompleted",
      permission: "PermissionRequested",
      permission_response: "PermissionResponded",
    };

    const eventType = typeMap[message.type as string];
    if (!eventType) return;

    await this.emitEvent(eventType, sessionId, {
      session_id: sessionId,
      ...message,
    });
  }

  /**
   * Detect user prompts from stdin messages in the JSONL stream.
   * Codex stdin messages are identified by role=user in the message.
   */
  private isUserPrompt(message: Record<string, unknown>): boolean {
    return message.role === "user" && typeof message.content === "string";
  }

  /**
   * Send an event to the daemon intake.
   */
  private async emitEvent(
    eventType: string,
    sessionId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const body = JSON.stringify({
      agent_provider: "codex",
      event_type: eventType,
      agent_native_event: data.type || eventType,
      data,
    });

    try {
      await fetch("http://localhost/api/events/intake", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Provider": "codex",
          "X-Event-Type": eventType,
        },
        body,
        // Unix socket connection to daemon
      });
    } catch {
      // Silent failure
    }
  }

  /**
   * Scan for existing sessions on startup.
   */
  private async scanExistingSessions(): Promise<void> {
    // Read directory listing and start watching any active sessions
  }

  /**
   * Detect Codex process exit to emit SessionEnded.
   */
  monitorProcessExit(sessionId: string, pid: number): void {
    const interval = setInterval(() => {
      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
      } catch {
        // Process exited
        this.emitEvent("SessionEnded", sessionId, {
          session_id: sessionId,
          reason: "process_exit",
        });
        this.activeWatchers.get(sessionId)?.abort();
        this.activeWatchers.delete(sessionId);
        clearInterval(interval);
      }
    }, 1000);
  }
}
```

#### 4.4 Codex Session Detection

Codex sessions are detected via two mechanisms:

1. **Directory watcher**: The daemon watches `~/.codex/sessions/` for new directories (inotify/FSEvents). A new directory indicates a new session.
2. **Process scanner**: On daemon startup, scan for running `codex` processes and correlate with session directories.

```bash
# Detect running Codex processes
detect_codex_sessions() {
  # Find codex processes
  pgrep -f "codex" | while read pid; do
    # Get the session directory from /proc/{pid}/cwd or lsof
    local cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
    echo "$pid:$cwd"
  done
}
```

#### 4.5 Codex User Prompt Detection

Unlike Claude Code and OpenCode, Codex does not emit a dedicated "user prompt" event. User prompts are detected by monitoring stdin messages in the JSONL stream. When a message with `role: "user"` appears, it is mapped to `UserPromptReceived`.

#### Acceptance Criteria

- [ ] Codex integration watches `~/.codex/sessions/` for new session directories
- [ ] JSONL message file is tailed in real-time with proper offset tracking
- [ ] All 6 JSONL message types are mapped to the correct unified event types
- [ ] `SessionStarted` is emitted when a new session directory is detected
- [ ] `SessionEnded` is emitted when the Codex process exits
- [ ] User prompts are detected from stdin messages with `role: "user"`
- [ ] File watcher handles file truncation and rotation gracefully
- [ ] Existing sessions are detected on daemon startup
- [ ] The watcher cleans up resources when a session ends
- [ ] Silent failure on all error paths -- never crash the daemon

---

### 5. Per-Integration Installer (F1.4)

The `agentctx install` command provides per-integration hook installers that detect installed agents and configure the appropriate hooks for each.

#### 5.1 CLI Interface

```
agentctx install [--claude-code] [--opencode] [--codex] [--all] [--force]

Options:
  --claude-code    Install Claude Code hooks in ~/.claude/settings.json
  --opencode       Install OpenCode plugin in ~/.opencode/plugins/agentctx/
  --codex          Configure Codex session watcher in daemon config
  --all            Detect and install hooks for all found agents
  --force          Overwrite existing hook configurations without confirmation
```

If no flags are provided, `agentctx install --all` is the default behavior.

#### 5.2 Agent Detection

Before installing hooks, the installer detects which agents are present on the system:

```bash
detect_agents() {
  local found=()

  # Claude Code: check for claude binary and ~/.claude/ directory
  if command -v claude &>/dev/null || [ -d "$HOME/.claude" ]; then
    found+=("claude-code")
  fi

  # OpenCode: check for opencode binary and ~/.opencode/ directory
  if command -v opencode &>/dev/null || [ -d "$HOME/.opencode" ]; then
    found+=("opencode")
  fi

  # Codex: check for codex binary and ~/.codex/ directory
  if command -v codex &>/dev/null || [ -d "$HOME/.codex" ]; then
    found+=("codex")
  fi

  printf '%s\n' "${found[@]}"
}
```

#### 5.3 Claude Code Installer Steps

```
agentctx install --claude-code
  1. Verify prerequisites:
     - Check that ~/.agentctx/bin/agentctx-hook exists and is executable
     - Check that jq is available
  2. Detect existing hooks:
     - Read ~/.claude/settings.json
     - Check for existing GC hooks (gc-hook substring) -> offer migration
     - Check for existing agentctx hooks (agentctx-hook substring) -> update in place
  3. Backup settings.json:
     - Create ~/.claude/settings.json.bak.{YYYYMMDD-HHMMSS}
  4. Merge hooks:
     - Add/update all 10 agentctx-hook entries in settings.json
     - Preserve user-defined hooks (no gc-hook or agentctx-hook in command)
  5. Validate:
     - Parse the written file
     - Verify all 10 hooks are present
  6. Report:
     [agentctx] Claude Code hooks installed (10 events)
     [agentctx]   Settings: ~/.claude/settings.json
     [agentctx]   Backup:   ~/.claude/settings.json.bak.20260221-143000
```

#### 5.4 OpenCode Installer Steps

```
agentctx install --opencode
  1. Verify prerequisites:
     - Check that opencode is installed
     - Check that ~/.opencode/ directory exists (or create it)
  2. Create plugin directory:
     - mkdir -p ~/.opencode/plugins/agentctx/
  3. Install plugin files:
     - Copy plugin.json, index.ts, event-handler.ts from agentctx source
  4. Verify plugin loads:
     - Check that opencode recognizes the plugin (opencode plugins list)
  5. Configure HTTP API fallback:
     - Add opencode serve endpoint to daemon config
  6. Report:
     [agentctx] OpenCode plugin installed
     [agentctx]   Plugin: ~/.opencode/plugins/agentctx/
     [agentctx]   Events: 9 event subscriptions
```

#### 5.5 Codex Installer Steps

```
agentctx install --codex
  1. Verify prerequisites:
     - Check that codex is installed
     - Check that ~/.codex/ directory exists (or create it)
  2. Configure session watcher:
     - Add codex watcher configuration to daemon config
     - Set session directory path: ~/.codex/sessions/
  3. Ensure daemon is configured to start watcher:
     - Write to ~/.agentctx/config.json:
       { "integrations": { "codex": { "enabled": true, "session_dir": "~/.codex/sessions/" } } }
  4. Report:
     [agentctx] Codex session watcher configured
     [agentctx]   Session dir: ~/.codex/sessions/
     [agentctx]   Watcher: enabled (starts with daemon)
```

#### 5.6 Auto-Detection Install (--all)

```
agentctx install --all
  1. Detect installed agents
  2. For each detected agent, run the corresponding installer
  3. Report summary:

     [agentctx] Agent detection results:
     [agentctx]   Claude Code .... found (claude v1.0.38)    -> installed
     [agentctx]   OpenCode ....... found (opencode v0.2.1)   -> installed
     [agentctx]   Codex .......... not found                 -> skipped
     [agentctx]
     [agentctx] 2 integrations installed.
```

#### 5.7 Installation Directory Structure

```
~/.agentctx/
  bin/
    agentctx             # Main CLI
    agentctx-hook        # Hook wrapper (Bash, for Claude Code)
    capture-event        # Event capture (from GC, enhanced)
  config.json            # Daemon and integration configuration
  daemon.sock            # Unix socket for daemon communication
  integrations/
    claude-code/
      hooks.json         # Reference copy of installed hooks
    opencode/
      plugin/            # Copy of OpenCode plugin source
    codex/
      watcher.json       # Watcher configuration
```

#### Acceptance Criteria

- [ ] `agentctx install --claude-code` installs all 10 hooks in `~/.claude/settings.json`
- [ ] `agentctx install --opencode` creates the plugin at `~/.opencode/plugins/agentctx/`
- [ ] `agentctx install --codex` configures the Codex session watcher in daemon config
- [ ] `agentctx install --all` auto-detects installed agents and installs hooks for each
- [ ] Agent detection checks both binary availability and config directory existence
- [ ] Existing GC hooks are detected and migration is offered
- [ ] Existing agentctx hooks are updated in place (idempotent)
- [ ] User-defined hooks are never modified or removed
- [ ] Backup of `settings.json` is created before modification
- [ ] Each installer validates its output before reporting success
- [ ] The `--force` flag skips confirmation prompts on overwrites

---

### 6. Hook Health Check (F1.5)

The `agentctx doctor` command validates that all installed hook integrations are functioning correctly.

#### 6.1 CLI Interface

```
agentctx doctor [--verbose] [--fix]

Options:
  --verbose    Show detailed output for each check
  --fix        Attempt to automatically fix detected issues
```

#### 6.2 Health Check Categories

| Category | Checks |
|----------|--------|
| System prerequisites | bash >= 4.0, jq >= 1.5, node >= 18.0, curl |
| Daemon status | daemon.sock exists, daemon process is running, PID file valid |
| Event store | `~/.agentctx/events/` exists and is writable, config.json valid |
| Claude Code integration | settings.json exists, all 10 hooks present, agentctx-hook executable, smoke test |
| OpenCode integration | plugin directory exists, plugin.json valid, event subscriptions registered |
| Codex integration | watcher config exists, session directory accessible |
| General health | Disk space >= 10MB free, recent events exist, no stale lock files |

#### 6.3 Per-Integration Health Checks

##### Claude Code Health Check

```bash
check_claude_code() {
  local status="ok"
  local issues=()

  # Check 1: settings.json exists
  if [ ! -f "$HOME/.claude/settings.json" ]; then
    issues+=("settings.json not found")
    status="fail"
  fi

  # Check 2: All 10 hooks present
  local hook_count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(.command | contains("agentctx-hook"))] | length' "$HOME/.claude/settings.json" 2>/dev/null)
  if [ "$hook_count" != "10" ]; then
    issues+=("Expected 10 hooks, found ${hook_count:-0}")
    status="fail"
  fi

  # Check 3: agentctx-hook is executable
  if [ ! -x "$HOME/.agentctx/bin/agentctx-hook" ]; then
    issues+=("agentctx-hook not executable")
    status="fail"
  fi

  # Check 4: Smoke test
  local test_result=$(echo '{"session_id":"doctor-test"}' | "$HOME/.agentctx/bin/agentctx-hook" claude-code SessionStarted 2>&1; echo "exit:$?")
  if [[ "$test_result" != *"exit:0"* ]]; then
    issues+=("Smoke test failed")
    status="fail"
  fi

  # Check 5: No stale GC hooks
  if jq -e '.hooks // {} | to_entries[] | .value[] | select(.command | contains("gc-hook"))' "$HOME/.claude/settings.json" >/dev/null 2>&1; then
    issues+=("Stale GlobalContext hooks detected (gc-hook). Run: agentctx install --claude-code")
    status="warn"
  fi

  echo "$status:claude-code:${issues[*]}"
}
```

##### OpenCode Health Check

```bash
check_opencode() {
  local status="ok"
  local issues=()

  # Check 1: Plugin directory exists
  if [ ! -d "$HOME/.opencode/plugins/agentctx" ]; then
    issues+=("Plugin not installed")
    status="fail"
  fi

  # Check 2: plugin.json is valid
  if ! jq . "$HOME/.opencode/plugins/agentctx/plugin.json" >/dev/null 2>&1; then
    issues+=("plugin.json is invalid JSON")
    status="fail"
  fi

  # Check 3: All event subscriptions present
  local events=$(jq -r '.events | length' "$HOME/.opencode/plugins/agentctx/plugin.json" 2>/dev/null)
  if [ "$events" != "9" ]; then
    issues+=("Expected 9 event subscriptions, found ${events:-0}")
    status="fail"
  fi

  # Check 4: Plugin files intact
  for f in index.ts event-handler.ts; do
    if [ ! -f "$HOME/.opencode/plugins/agentctx/$f" ]; then
      issues+=("Missing file: $f")
      status="fail"
    fi
  done

  echo "$status:opencode:${issues[*]}"
}
```

##### Codex Health Check

```bash
check_codex() {
  local status="ok"
  local issues=()

  # Check 1: Watcher configured in daemon config
  if ! jq -e '.integrations.codex.enabled' "$HOME/.agentctx/config.json" >/dev/null 2>&1; then
    issues+=("Codex watcher not configured")
    status="fail"
  fi

  # Check 2: Session directory accessible
  local session_dir=$(jq -r '.integrations.codex.session_dir // empty' "$HOME/.agentctx/config.json" 2>/dev/null)
  session_dir="${session_dir/#\~/$HOME}"
  if [ -n "$session_dir" ] && [ ! -d "$session_dir" ]; then
    issues+=("Session directory not found: $session_dir")
    status="warn"
  fi

  # Check 3: Codex binary available
  if ! command -v codex &>/dev/null; then
    issues+=("codex binary not found in PATH")
    status="warn"
  fi

  echo "$status:codex:${issues[*]}"
}
```

#### 6.4 Output Format

```
[agentctx doctor] AgentContext Health Check
[agentctx doctor] ────────────────────────────────────────

[agentctx doctor] System Prerequisites
[agentctx doctor]   bash ............. 5.2 (>= 4.0)         OK
[agentctx doctor]   jq ............... 1.7 (>= 1.5)         OK
[agentctx doctor]   node ............. 22.0.0 (>= 18.0)     OK
[agentctx doctor]   curl ............. 8.5.0                 OK

[agentctx doctor] Daemon
[agentctx doctor]   Process .......... running (PID 12345)   OK
[agentctx doctor]   Socket ........... ~/.agentctx/daemon.sock  OK
[agentctx doctor]   Uptime ........... 3h 42m                OK

[agentctx doctor] Event Store
[agentctx doctor]   Path ............. ~/.agentctx/events/   OK
[agentctx doctor]   Writable ......... yes                   OK
[agentctx doctor]   Config ........... valid                 OK
[agentctx doctor]   Disk space ....... 42 GB free            OK

[agentctx doctor] Claude Code (installed)
[agentctx doctor]   Settings ......... ~/.claude/settings.json  OK
[agentctx doctor]   Hooks ............ 10/10 registered      OK
[agentctx doctor]   Hook wrapper ..... executable             OK
[agentctx doctor]   Smoke test ....... passed                 OK

[agentctx doctor] OpenCode (installed)
[agentctx doctor]   Plugin ........... ~/.opencode/plugins/agentctx/  OK
[agentctx doctor]   Manifest ......... valid                 OK
[agentctx doctor]   Subscriptions .... 9/9 events            OK
[agentctx doctor]   Files ............ all present            OK

[agentctx doctor] Codex (not installed)
[agentctx doctor]   Status ........... codex not detected     SKIP

[agentctx doctor] ────────────────────────────────────────
[agentctx doctor] Result: 16 checks passed, 0 warnings, 0 failures
```

#### 6.5 Auto-Fix (--fix)

When `--fix` is passed, doctor attempts to resolve common issues:

| Issue | Fix Action |
|-------|-----------|
| Missing hooks in settings.json | Re-run `agentctx install --claude-code` |
| agentctx-hook not executable | `chmod +x ~/.agentctx/bin/agentctx-hook` |
| Missing OpenCode plugin files | Re-copy from source |
| Stale GC hooks | Remove `gc-hook` entries, add `agentctx-hook` entries |
| Missing event store directories | `mkdir -p` |
| Stale lock files | Remove `.lock` files older than 1 hour |
| Invalid config.json | Regenerate with defaults |

#### Acceptance Criteria

- [ ] `agentctx doctor` runs health checks for all installed integrations
- [ ] Each integration has at least 4 specific checks
- [ ] Output uses a consistent format with OK/WARN/FAIL/SKIP status indicators
- [ ] Integrations that are not installed are reported as SKIP, not FAIL
- [ ] A smoke test is performed for Claude Code hooks (pipe test JSON and verify exit 0)
- [ ] `--verbose` shows additional detail for each check
- [ ] `--fix` attempts to resolve common issues and reports what was fixed
- [ ] Exit code is 0 when all checks pass, 1 when any check fails
- [ ] The summary line reports total passes, warnings, and failures

---

### 7. Hot-Reload Hooks (F1.6)

Hot-reload allows hook configurations to be updated without restarting the running agents. The daemon watches for configuration changes and applies them in real time.

#### 7.1 Configuration Watch Targets

| File | Agent | What Changes |
|------|-------|-------------|
| `~/.claude/settings.json` | Claude Code | Hook entries (updated by `agentctx install --claude-code`) |
| `~/.opencode/plugins/agentctx/plugin.json` | OpenCode | Event subscriptions, plugin config |
| `~/.agentctx/config.json` | All | Integration enable/disable, watcher paths |

#### 7.2 File Watcher Implementation

```typescript
import { watch, FSWatcher } from "fs";
import { readFile } from "fs/promises";
import { createHash } from "crypto";

interface WatchTarget {
  path: string;
  agent: AgentProvider;
  lastHash: string;
  handler: (content: string) => Promise<void>;
}

class HookConfigWatcher {
  private watchers: FSWatcher[] = [];
  private targets: WatchTarget[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Start watching all hook configuration files.
   */
  async start(): Promise<void> {
    const home = process.env.HOME!;

    this.addTarget({
      path: `${home}/.claude/settings.json`,
      agent: "claude-code",
      handler: this.handleClaudeCodeChange.bind(this),
    });

    this.addTarget({
      path: `${home}/.opencode/plugins/agentctx/plugin.json`,
      agent: "opencode",
      handler: this.handleOpenCodeChange.bind(this),
    });

    this.addTarget({
      path: `${home}/.agentctx/config.json`,
      agent: "claude-code", // Affects all
      handler: this.handleDaemonConfigChange.bind(this),
    });
  }

  private addTarget(target: Omit<WatchTarget, "lastHash">): void {
    const fullTarget: WatchTarget = { ...target, lastHash: "" };
    this.targets.push(fullTarget);

    try {
      const watcher = watch(target.path, () => {
        // Debounce: wait 500ms after last change before processing
        const existing = this.debounceTimers.get(target.path);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          target.path,
          setTimeout(() => this.processChange(fullTarget), 500)
        );
      });
      this.watchers.push(watcher);
    } catch {
      // File does not exist yet; will be picked up on install
    }
  }

  private async processChange(target: WatchTarget): Promise<void> {
    try {
      const content = await readFile(target.path, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");

      // Only process if content actually changed
      if (hash === target.lastHash) return;
      target.lastHash = hash;

      await target.handler(content);
      console.log(`[agentctx] Hot-reloaded ${target.agent} config from ${target.path}`);
    } catch (err) {
      console.error(`[agentctx] Failed to hot-reload ${target.path}: ${err}`);
    }
  }

  private async handleClaudeCodeChange(content: string): Promise<void> {
    // Validate JSON and verify agentctx hooks are still present
    const config = JSON.parse(content);
    const hooks = config.hooks || {};
    // Re-validate hook integrity
  }

  private async handleOpenCodeChange(content: string): Promise<void> {
    // Validate plugin manifest and update event subscriptions
    const manifest = JSON.parse(content);
    // Re-register event handlers if subscriptions changed
  }

  private async handleDaemonConfigChange(content: string): Promise<void> {
    // Apply integration enable/disable changes
    const config = JSON.parse(content);
    // Start/stop watchers as needed
  }

  stop(): void {
    this.watchers.forEach((w) => w.close());
    this.debounceTimers.forEach((t) => clearTimeout(t));
  }
}
```

#### 7.3 Reload Triggers

| Trigger | Action |
|---------|--------|
| `settings.json` modified | Validate hooks still present; warn if removed by another tool |
| OpenCode plugin files modified | Re-register event handlers with updated config |
| Daemon config modified | Enable/disable integrations, update watcher paths |
| `agentctx reload` command | Force re-read all config files and re-validate |
| SIGHUP signal to daemon | Same as `agentctx reload` |

#### 7.4 agentctx reload Command

```
agentctx reload

  Forces the daemon to re-read all hook configuration files and re-validate
  all integrations. Use this after manually editing configuration files.

  Output:
  [agentctx] Reloading hook configurations...
  [agentctx]   Claude Code .... reloaded (10 hooks)
  [agentctx]   OpenCode ....... reloaded (9 subscriptions)
  [agentctx]   Codex .......... reloaded (watcher active)
  [agentctx] All integrations reloaded.
```

#### Acceptance Criteria

- [ ] The daemon watches all hook configuration files for changes
- [ ] Changes to `settings.json` are detected and validated within 1 second
- [ ] Changes are debounced (500ms) to avoid processing partial writes
- [ ] Hash comparison prevents redundant re-processing of unchanged files
- [ ] `agentctx reload` forces a re-read of all configuration files
- [ ] SIGHUP to the daemon triggers a reload
- [ ] Config changes are applied without restarting any running agent processes
- [ ] Invalid config changes are logged as warnings but do not crash the daemon
- [ ] The reload process logs what was changed for diagnostic purposes

---

### 8. Custom Hook Extensions (F1.7)

Custom hook extensions allow users and the community to integrate future coding agents with AgentContext using a generic stdin/stdout protocol.

#### 8.1 Generic Hook Protocol

A custom hook is an executable that communicates with the daemon via a simple stdin/stdout protocol:

```
stdin:  Agent-native JSON events (one per line, JSONL format)
stdout: Acknowledgments (one per line, JSONL format)
stderr: Diagnostic logging (ignored by daemon)
```

#### 8.2 Custom Hook Manifest

Custom hooks are defined in `~/.agentctx/hooks.d/` with a JSON manifest:

```json
{
  "name": "cursor",
  "description": "Hook integration for Cursor IDE agent",
  "version": "1.0.0",
  "author": "Community",
  "agent_provider": "cursor",
  "executable": "./cursor-hook",
  "event_mapping": {
    "cursor.session.start": "SessionStarted",
    "cursor.completion.request": "UserPromptReceived",
    "cursor.tool.begin": "ToolCallRequested",
    "cursor.tool.end": "ToolCallCompleted",
    "cursor.tool.error": "ToolCallFailed",
    "cursor.session.end": "SessionEnded"
  },
  "config": {
    "watch_dir": "~/.cursor/sessions/",
    "protocol": "jsonl"
  }
}
```

#### 8.3 Custom Hook Executable Contract

The custom hook executable must adhere to this contract:

1. **Invocation**: The daemon starts the executable as a child process.
2. **Stdin**: The daemon does not write to the hook's stdin (the hook manages its own input sources).
3. **Stdout**: The hook writes JSONL events to stdout, one per line:

```jsonl
{"event_type":"SessionStarted","agent_native_event":"cursor.session.start","data":{"session_id":"abc","model":"gpt-4o"}}
{"event_type":"ToolCallRequested","agent_native_event":"cursor.tool.begin","data":{"session_id":"abc","tool_name":"file_edit","tool_input":{"path":"/src/main.ts"}}}
{"event_type":"ToolCallCompleted","agent_native_event":"cursor.tool.end","data":{"session_id":"abc","tool_name":"file_edit","tool_response":"success"}}
```

4. **Stderr**: Diagnostic messages; the daemon captures these for `agentctx doctor --verbose`.
5. **Lifecycle**: The daemon starts the hook on daemon start and restarts it if it exits unexpectedly (with exponential backoff: 1s, 2s, 4s, 8s, max 60s).
6. **Exit**: The hook should exit 0 on clean shutdown (SIGTERM). Non-zero exit triggers a restart.

#### 8.4 Custom Hook Directory Layout

```
~/.agentctx/hooks.d/
  cursor/
    manifest.json       # Hook manifest (see 8.2)
    cursor-hook         # Executable (must be chmod +x)
    README.md           # Optional documentation
  windsurf/
    manifest.json
    windsurf-hook
```

#### 8.5 Custom Hook Registration

```
agentctx hooks add ./my-hook-dir/
  1. Validate manifest.json exists and is valid
  2. Validate executable exists and is executable
  3. Validate event_mapping contains only valid unified event types
  4. Copy hook directory to ~/.agentctx/hooks.d/{name}/
  5. Register hook in daemon config
  6. Start the hook process (if daemon is running)

agentctx hooks remove cursor
  1. Stop the hook process
  2. Remove from daemon config
  3. Remove directory from ~/.agentctx/hooks.d/cursor/

agentctx hooks list
  NAME       VERSION  STATUS     EVENTS
  cursor     1.0.0    running    6 mapped
  windsurf   0.2.0    stopped    4 mapped
```

#### 8.6 Event Validation

The daemon validates custom hook events before writing them to the event store:

- `event_type` must be one of the 12 unified types
- `data` must be a valid JSON object
- `data.session_id` must be present (or the event is assigned to "unknown")
- Events with unknown `event_type` values are logged and dropped
- Events that exceed 10MB are logged and dropped

#### Acceptance Criteria

- [ ] Custom hooks are discovered from `~/.agentctx/hooks.d/` directories
- [ ] Each hook has a `manifest.json` with name, executable path, and event mapping
- [ ] The hook executable writes JSONL events to stdout
- [ ] The daemon reads stdout, validates events, and writes to the event store
- [ ] Events with invalid `event_type` are logged and dropped
- [ ] The daemon restarts crashed hooks with exponential backoff
- [ ] `agentctx hooks add` validates and installs a custom hook
- [ ] `agentctx hooks remove` stops and removes a custom hook
- [ ] `agentctx hooks list` shows all installed custom hooks with status
- [ ] The custom hook protocol is documented with a reference implementation

---

## Edge Cases

### E-1: Multiple Agents Producing Events for the Same Project

**Scenario**: A user has both Claude Code and OpenCode open on the same project directory. Both agents produce events with the same `project_id`.

**Expected behavior**: Events from both agents are written to the same project directory in the event store, distinguished by their `agent_provider` field and different `session_id` values. Sequence numbers are per-session, not per-project, so there is no collision. Projections include events from all agents, providing a unified view of work done on the project.

**Risk**: If both agents have the same session ID (extremely unlikely given UUID generation), events could interleave within the same session directory.

**Mitigation**: Session directories include a provider prefix when IDs are ambiguous: `{agent_provider}-{session_id}`. The event envelope's `agent_provider` field allows downstream consumers to filter by agent.

---

### E-2: Daemon Not Running When Hook Fires

**Scenario**: Claude Code fires a hook, but the AgentContext daemon is not running (user has not started it, or it crashed).

**Expected behavior**: The `agentctx-hook` wrapper detects that the Unix socket at `~/.agentctx/daemon.sock` does not exist. It falls back to direct file write via `capture-event`, bypassing the daemon entirely. The event is captured to the event store. When the daemon starts, it picks up the event from the store.

**Risk**: Direct file write does not go through the daemon's normalization pipeline.

**Mitigation**: The fallback `capture-event` script accepts `--agent-provider` flag and produces a valid unified event envelope. The daemon's startup reconciliation process re-indexes any events written during downtime.

---

### E-3: OpenCode Plugin Fails to Load

**Scenario**: The OpenCode plugin has a syntax error or references a missing dependency, and OpenCode skips it during startup.

**Expected behavior**: No events are captured from OpenCode. The `agentctx doctor` command detects this: it checks for plugin load errors in OpenCode's log file (`~/.opencode/logs/`) and reports:

```
[agentctx doctor] OpenCode (installed)
[agentctx doctor]   Plugin ........... load error          FAIL
[agentctx doctor]   Error: SyntaxError in index.ts line 42
[agentctx doctor]   Fix: agentctx install --opencode --force
```

**Risk**: User may not realize events are not being captured.

**Mitigation**: The daemon can detect the absence of OpenCode events when an OpenCode session is running (detected via process scanning) and emit a warning notification.

---

### E-4: Codex Session Directory Does Not Exist at Startup

**Scenario**: The user has Codex installed but has never run it. The `~/.codex/sessions/` directory does not exist.

**Expected behavior**: The Codex file watcher detects the missing directory and creates it with `mkdir -p`. If the parent directory (`~/.codex/`) also does not exist, the watcher creates that too. The watcher then enters a wait state, ready to detect the first session when Codex is started.

**Risk**: None. The watcher is designed to handle missing directories gracefully.

**Mitigation**: `agentctx doctor` reports the Codex integration as "installed, no sessions yet" rather than a failure.

---

### E-5: Claude Code settings.json Modified by Another Tool

**Scenario**: Another tool (e.g., a different Claude Code extension) modifies `~/.claude/settings.json` and removes or alters the agentctx hooks.

**Expected behavior**: The hot-reload watcher detects the change to `settings.json`. It validates that all 10 agentctx hooks are still present. If hooks are missing or altered, it logs a warning:

```
[agentctx] WARN: Claude Code hooks modified externally. 3 of 10 hooks missing.
[agentctx] WARN: Run 'agentctx install --claude-code' to restore.
```

The watcher does NOT automatically re-inject hooks (that would create an edit war with the other tool). It only warns.

**Risk**: Events are silently lost for the hooks that were removed.

**Mitigation**: The `agentctx doctor` command detects missing hooks. The dashboard shows a warning indicator when hook counts are below expected.

---

### E-6: Two Daemon Instances Running

**Scenario**: The user accidentally starts two daemon instances, or a stale daemon process is holding the socket.

**Expected behavior**: The second daemon instance detects that `~/.agentctx/daemon.sock` already exists and is in use. It checks the PID file at `~/.agentctx/daemon.pid`:

1. If the PID is valid (process exists): print "Daemon already running (PID XXXX)" and exit 1.
2. If the PID is stale (process does not exist): remove the stale socket and PID file, start normally.

**Risk**: If the stale socket is not cleaned up, no daemon can start.

**Mitigation**: `agentctx doctor --fix` detects and cleans up stale sockets.

---

### E-7: Very Large Codex Session (100K+ JSONL Lines)

**Scenario**: A long-running Codex session produces over 100,000 JSONL lines. The file watcher must handle this without excessive memory use.

**Expected behavior**: The JSONL tailer reads from the last-known offset, processing only new lines. It does not re-read the entire file on each change event. The offset is tracked in memory per active session and is resilient to file truncation (detected by comparing file size against offset).

**Risk**: If the JSONL file is truncated or rotated, the offset becomes invalid.

**Mitigation**: On file size decrease (truncation), reset the offset to 0 and re-process. Log a warning about the truncation.

---

### E-8: Custom Hook Executable Crashes Repeatedly

**Scenario**: A user-installed custom hook has a bug and crashes immediately on startup, every time.

**Expected behavior**: The daemon's exponential backoff prevents a restart storm:

```
Attempt 1: restart after 1s
Attempt 2: restart after 2s
Attempt 3: restart after 4s
Attempt 4: restart after 8s
Attempt 5: restart after 16s
...
Max: restart after 60s
```

After 10 consecutive failures, the daemon marks the hook as "disabled (crash loop)" and stops restarting it. A notification is emitted:

```
[agentctx] ERROR: Custom hook 'cursor' disabled after 10 consecutive crashes.
[agentctx] ERROR: Last error: Segmentation fault (core dumped)
[agentctx] ERROR: Fix the issue and re-enable: agentctx hooks enable cursor
```

**Risk**: A crashlooping hook consumes system resources.

**Mitigation**: The crash loop detector and auto-disable prevent resource waste. The hook can be manually re-enabled after fixing.

---

### E-9: Agent Provider String Collision

**Scenario**: Two different agents claim the same `agent_provider` string (e.g., a custom hook uses "claude-code" as its provider name).

**Expected behavior**: The manifest validator rejects custom hooks with reserved provider names. The reserved names are: `claude-code`, `opencode`, `codex`.

**Risk**: If validation is bypassed, events from different agents could be misattributed.

**Mitigation**: Reserved names are checked during `agentctx hooks add`. The event store includes both `agent_provider` and `agent_native_event` for disambiguation.

---

### E-10: Network Latency on Unix Socket

**Scenario**: The Unix socket communication between `agentctx-hook` and the daemon is slow (>100ms) because the daemon is under heavy load processing events from multiple agents.

**Expected behavior**: For async hooks (the majority), the latency is invisible to the agent. For sync hooks (SessionStart, UserPromptSubmit, PreCompact on Claude Code), the latency adds directly to the agent's perceived latency. The 5-second timeout provides headroom.

**Risk**: Under extreme load, sync hooks could approach the 5-second timeout.

**Mitigation**: The daemon uses a bounded event queue with separate threads for intake and processing. Intake (accepting events from hooks) is always fast; processing (writing to disk, updating projections) is asynchronous. The intake endpoint responds with 202 Accepted immediately.

---

### E-11: Migration from GC When Events Use Old Envelope Format

**Scenario**: During migration from standalone GC to agentctx, existing events lack the `agent_provider`, `agent_native_event`, and `agent_metadata` fields.

**Expected behavior**: The projection engine and query layer treat missing fields as defaults: `agent_provider` defaults to `"claude-code"`, `agent_native_event` defaults to the `event_type` value, and `agent_metadata` defaults to `{}`. No data migration is required.

**Risk**: None, due to additive-only schema changes.

**Mitigation**: TypeScript interfaces mark the new fields as optional for backward compatibility.

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| T-01 | Unified event type mapping covers all 12 types |
| T-02 | Claude Code native events map correctly to unified types |
| T-03 | OpenCode native events map correctly to unified types |
| T-04 | Codex JSONL message types map correctly to unified types |
| T-05 | `message.updated` with role != user is filtered out (OpenCode) |
| T-06 | `tool.execute.after` with error splits into ToolCallFailed (OpenCode) |
| T-07 | `tool.execute.after` without error maps to ToolCallCompleted (OpenCode) |
| T-08 | UnifiedEvent TypeScript interface validates correct events |
| T-09 | UnifiedEvent TypeScript interface rejects events with unknown types |
| T-10 | Event envelope includes all required fields (backward-compatible 7 + new 3) |
| T-11 | `agentctx-hook` exits 0 when daemon socket is missing |
| T-12 | `agentctx-hook` exits 0 when capture-event crashes |
| T-13 | `agentctx-hook` produces no stdout |
| T-14 | `agentctx-hook` produces no stderr (suppressed) |
| T-15 | `agentctx-hook` falls back to direct file write when daemon unavailable |
| T-16 | Agent detection finds Claude Code when `claude` binary is in PATH |
| T-17 | Agent detection finds OpenCode when `~/.opencode/` directory exists |
| T-18 | Agent detection finds Codex when `codex` binary is in PATH |
| T-19 | Agent detection returns empty when no agents are installed |
| T-20 | Claude Code installer detects existing GC hooks for migration |
| T-21 | Claude Code installer is idempotent (running twice produces same result) |
| T-22 | OpenCode plugin manifest is valid JSON with required fields |
| T-23 | Codex JSONL parser handles malformed lines without crashing |
| T-24 | Codex file watcher tracks offsets correctly across multiple reads |
| T-25 | Codex file watcher handles file truncation (offset reset) |
| T-26 | Custom hook manifest validation rejects reserved provider names |
| T-27 | Custom hook manifest validation rejects unknown event types |
| T-28 | Custom hook JSONL parsing handles malformed lines |
| T-29 | Hot-reload debounce prevents processing partial file writes |
| T-30 | Hot-reload hash comparison skips unchanged files |
| T-31 | Health check reports correct status for each integration |
| T-32 | Health check reports SKIP for uninstalled integrations |
| T-33 | Backward compatibility: events without `agent_provider` default to "claude-code" |
| T-34 | Backward compatibility: events without `agent_metadata` default to `{}` |
| T-35 | Custom hook exponential backoff respects max interval (60s) |

### Integration Tests

| Test | Description |
|------|-------------|
| T-36 | End-to-end: Claude Code hook fires, event reaches event store with correct envelope |
| T-37 | End-to-end: OpenCode plugin captures event and sends to daemon |
| T-38 | End-to-end: Codex JSONL file written, watcher captures event |
| T-39 | `agentctx install --claude-code` creates valid settings.json with 10 hooks |
| T-40 | `agentctx install --opencode` creates valid plugin at correct path |
| T-41 | `agentctx install --codex` configures watcher in daemon config |
| T-42 | `agentctx install --all` detects and installs all available integrations |
| T-43 | `agentctx doctor` passes all checks on a healthy installation |
| T-44 | `agentctx doctor` detects missing Claude Code hooks |
| T-45 | `agentctx doctor` detects broken OpenCode plugin |
| T-46 | `agentctx doctor --fix` restores missing hooks |
| T-47 | Hot-reload detects settings.json change and validates hooks |
| T-48 | Hot-reload detects OpenCode plugin change and re-registers |
| T-49 | `agentctx hooks add` installs a custom hook and starts it |
| T-50 | `agentctx hooks remove` stops and removes a custom hook |
| T-51 | Custom hook crash loop triggers disable after 10 failures |
| T-52 | Migration from GC hooks to agentctx hooks preserves all existing events |
| T-53 | Multiple agents on same project produce events with correct agent_provider tags |
| T-54 | Daemon fallback: events captured via direct file write when daemon is not running |
| T-55 | Daemon startup reconciliation indexes events written during downtime |

### Manual Verification

| Test | Description |
|------|-------------|
| M-01 | Install Claude Code hooks, start a Claude Code session, verify events appear with `agent_provider: "claude-code"` |
| M-02 | Install OpenCode plugin, start an OpenCode session, verify events appear with `agent_provider: "opencode"` |
| M-03 | Configure Codex watcher, start a Codex session, verify JSONL events are captured with `agent_provider: "codex"` |
| M-04 | Run `agentctx doctor` on a healthy system with all three agents installed |
| M-05 | Run `agentctx doctor` on a system with only Claude Code; verify OpenCode and Codex show SKIP |
| M-06 | Modify settings.json externally; verify hot-reload warning appears in daemon logs |
| M-07 | Run `agentctx install --all` on a fresh system; verify auto-detection and installation |
| M-08 | Migrate from standalone GlobalContext to agentctx; verify existing events are accessible |
| M-09 | Install a custom hook, verify events appear in the event store with the custom provider name |
| M-10 | Kill the daemon, fire a Claude Code hook, verify fallback file write works |
| M-11 | Run both Claude Code and OpenCode on the same project simultaneously; verify unified event stream |
| M-12 | Crash a custom hook repeatedly; verify exponential backoff and auto-disable |

---

## Definition of Done

- [ ] All 12 unified event types are defined with TypeScript interfaces and documented mapping tables
- [ ] Claude Code hook integration works via `agentctx-hook` wrapper with daemon-first, fallback-to-file architecture
- [ ] OpenCode hook integration works via plugin at `~/.opencode/plugins/agentctx/` with all 9 event subscriptions
- [ ] Codex hook integration works via JSONL session file watcher with process monitoring
- [ ] `agentctx install --claude-code` installs 10 hooks in `settings.json` with idempotency and GC migration support
- [ ] `agentctx install --opencode` installs the plugin with all required files
- [ ] `agentctx install --codex` configures the session watcher in daemon config
- [ ] `agentctx install --all` auto-detects installed agents and installs hooks for each
- [ ] `agentctx doctor` validates all installed integrations with per-integration checks and a smoke test
- [ ] `agentctx doctor --fix` resolves common issues automatically
- [ ] Hot-reload watcher detects configuration changes within 1 second and applies them
- [ ] `agentctx reload` and SIGHUP force configuration re-read
- [ ] Custom hook extension protocol is defined with manifest format and JSONL stdout contract
- [ ] `agentctx hooks add/remove/list` manages custom hooks
- [ ] Custom hook crash loop protection with exponential backoff and auto-disable after 10 failures
- [ ] Unified event envelope is backward-compatible with Story 01 (all original fields preserved)
- [ ] Events from all agents include `agent_provider`, `agent_native_event`, and `agent_metadata` fields
- [ ] Daemon fallback: events are captured via direct file write when daemon is not running
- [ ] Migration from standalone GC hooks works without data loss
- [ ] All 35 unit tests pass
- [ ] All 20 integration tests pass
- [ ] All 12 manual verification scenarios confirmed
- [ ] No agent session is ever disrupted by hook failures (exit 0 guarantee for all wrappers)
- [ ] Documentation includes the custom hook protocol specification for community integrators
