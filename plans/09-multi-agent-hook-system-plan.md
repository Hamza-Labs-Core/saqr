# Implementation Plan: Story 09 -- Multi-Agent Hook System

**Date**: 2026-02-22
**Story**: 09-multi-agent-hook-system
**Status**: Planning
**Estimated Total Effort**: ~12-16 days (60-80 hours)
**Prerequisites**: Stories 00-06 must be implemented (installation framework, event capture, hook integration, storage layer, projection engine, context recovery, plugin packaging). The existing `gc-hook`, `capture-event`, `gc-install-hooks`, and event store infrastructure provide the foundation that this story generalizes.
**Product Spec Reference**: F1 (Multi-Agent Hook System), F1.1-F1.7

---

### Relationship to Other Stories

This story **generalizes** the existing single-agent hook system (Stories 01-02) into a multi-agent platform. It is the foundation for the broader AgentContext product vision.

- **Story 01** (Event Capture): `capture-event` is enhanced with `--agent-provider` flag to tag events with provider metadata. The unified event envelope extends the Story 01 envelope with three additive fields.
- **Story 02** (Hook Integration): The existing 10-hook Claude Code system via `settings.json` is migrated from `gc-hook` to `agentctx-hook`. The `gc-install-hooks` logic is absorbed into `agentctx install --claude-code`.
- **Story 03** (Storage Layer): The event store directory structure (`~/.claude-context/events/{project-id}/{session-id}/`) is reused. A new `~/.agentctx/` directory tree is created for the daemon, integrations, and custom hooks.
- **Story 04** (Projection Engine): Existing projections consume unified events without modification (backward-compatible envelope).
- **Story 06** (Plugin Packaging): The packaging framework from Story 06 is extended for the `agentctx` CLI distribution.
- **Story 10** (Event Store & Projections -- enhanced): Downstream consumer. No changes required from this story.
- **Story 11** (Agent Process Orchestration): Depends on this story's unified event types and hook infrastructure. The daemon event intake API defined here is used by the orchestration layer.
- **Story 12** (Local Dashboard): Downstream consumer of multi-agent events. Benefits from `agent_provider` field for filtering.

### Amendment Impacts on This Plan

- **Amendment 3** (Project-ID layer): The `{basename}-{hash6}` project-id format is preserved. Multi-agent events from different agents on the same project share the same project-id directory, differentiated by `session_id` and `agent_provider`.
- **Backward Compatibility**: The unified event envelope is a strict superset of the Story 01 envelope. Existing events without `agent_provider` default to `"claude-code"`. No data migration is required.

---

## Task Dependency Graph

```
Task 1: Unified Event Type System & Envelope
  |
  +---> Task 2: agentctx-hook Wrapper Script (needs 1)
  |       |
  |       +---> Task 5: Claude Code Installer (needs 2, 4)
  |       |       |
  |       |       +---> Task 10: GC-to-AgentCtx Migration (needs 5)
  |       |
  |       +---> Task 9: Health Check System (needs 2, 5, 6, 7, 8)
  |
  +---> Task 3: capture-event Enhancement (needs 1)
  |       |
  |       +---> Task 2 (fallback path uses Task 3)
  |
  +---> Task 4: agentctx CLI Scaffolding (needs 1)
  |       |
  |       +---> Task 5: Claude Code Installer (needs 4)
  |       +---> Task 6: OpenCode Plugin Integration (needs 4)
  |       +---> Task 7: Codex Watcher Integration (needs 4)
  |       +---> Task 8: Custom Hook Extensions (needs 4)
  |
  +---> Task 6: OpenCode Plugin Integration (needs 1, 4)
  |
  +---> Task 7: Codex Watcher Integration (needs 1, 4)
  |
  +---> Task 8: Custom Hook Extensions (needs 1, 4)
  |
  +---> Task 11: Hot-Reload Configuration Watcher (needs 5, 6, 7)
  |
  +---> Task 12: Integration & End-to-End Tests (needs all)
```

---

## Tasks

### Task 1: Unified Event Type System & Envelope

**Description**

Define the 12 unified event types, the agent-to-unified mapping tables, and the unified event envelope format. This is the data contract that all integrations conform to. The implementation includes a JSON schema definition file, a shell-side mapping lookup, and a Node.js-side TypeScript definition (for the daemon and projections).

The unified event envelope extends the existing Story 01 envelope (7 fields) with three additive fields: `agent_provider`, `agent_native_event`, and `agent_metadata`. This makes it backward-compatible -- existing projections that read only the original 7 fields continue to work.

**Prerequisites/Inputs**

- Story 01 event envelope format (7 fields: event_id, event_type, project_id, session_id, sequence, timestamp, data)
- Story 09 requirements Section 1 (Unified Event Type System)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/lib/unified_events.sh` | Create | Shell-side event type constants, mapping lookup, envelope builder |
| `src/lib/unified_events.mjs` | Create | Node.js-side TypeScript-compatible definitions for daemon/projections |
| `src/schemas/unified-event.schema.json` | Create | JSON Schema for validation of unified event envelope |
| `src/schemas/agent-mapping.json` | Create | Agent-to-unified mapping table as structured data |

`src/lib/unified_events.sh`:

```bash
#!/usr/bin/env bash
# Unified Event Type System for AgentContext

# The 12 unified event types
UNIFIED_EVENT_TYPES=(
  "SessionStarted"
  "UserPromptReceived"
  "ToolCallRequested"
  "ToolCallCompleted"
  "ToolCallFailed"
  "AgentSpawned"
  "AgentCompleted"
  "TurnCompleted"
  "CompactionTriggered"
  "SessionEnded"
  "PermissionRequested"
  "PermissionResponded"
)

# Valid agent provider values
AGENT_PROVIDERS=("claude-code" "opencode" "codex" "custom")

# Reserved provider names that custom hooks cannot use
RESERVED_PROVIDERS=("claude-code" "opencode" "codex")

# Validate that an event type is one of the 12 unified types
# Returns 0 if valid, 1 if invalid
gc_validate_event_type() {
  local event_type="$1"
  for t in "${UNIFIED_EVENT_TYPES[@]}"; do
    [ "$t" = "$event_type" ] && return 0
  done
  return 1
}

# Validate that an agent provider is recognized
gc_validate_agent_provider() {
  local provider="$1"
  for p in "${AGENT_PROVIDERS[@]}"; do
    [ "$p" = "$provider" ] && return 0
  done
  return 1
}

# Check if a provider name is reserved (cannot be used by custom hooks)
gc_is_reserved_provider() {
  local provider="$1"
  for p in "${RESERVED_PROVIDERS[@]}"; do
    [ "$p" = "$provider" ] && return 0
  done
  return 1
}

# Build a unified event envelope JSON string
# Usage: gc_build_unified_envelope <event_type> <project_id> <session_id> <sequence> <agent_provider> <agent_native_event> <data_json>
# Optional env vars: AGENT_VERSION, AGENT_MODEL, AGENT_PID, AGENT_CWD
gc_build_unified_envelope() {
  local event_type="$1"
  local project_id="$2"
  local session_id="$3"
  local sequence="$4"
  local agent_provider="$5"
  local agent_native_event="$6"
  local data_json="$7"

  local event_id
  event_id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM $((RANDOM & 0x0fff | 0x4000)) $((RANDOM & 0x3fff | 0x8000)) $RANDOM $RANDOM $RANDOM)

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

  local metadata='{}'
  [ -n "${AGENT_VERSION:-}" ] && metadata=$(printf '%s' "$metadata" | jq --arg v "$AGENT_VERSION" '. + {agent_version: $v}')
  [ -n "${AGENT_MODEL:-}" ] && metadata=$(printf '%s' "$metadata" | jq --arg m "$AGENT_MODEL" '. + {model: $m}')
  [ -n "${AGENT_PID:-}" ] && metadata=$(printf '%s' "$metadata" | jq --argjson p "$AGENT_PID" '. + {agent_pid: $p}')
  [ -n "${AGENT_CWD:-}" ] && metadata=$(printf '%s' "$metadata" | jq --arg c "$AGENT_CWD" '. + {cwd: $c}')

  jq -n \
    --arg eid "$event_id" \
    --arg etype "$event_type" \
    --arg pid "$project_id" \
    --arg sid "$session_id" \
    --argjson seq "$sequence" \
    --arg ts "$timestamp" \
    --arg ap "$agent_provider" \
    --arg ane "$agent_native_event" \
    --argjson am "$metadata" \
    --argjson data "$data_json" \
    '{
      event_id: $eid,
      event_type: $etype,
      project_id: $pid,
      session_id: $sid,
      sequence: $seq,
      timestamp: $ts,
      agent_provider: $ap,
      agent_native_event: $ane,
      agent_metadata: $am,
      data: $data
    }'
}
```

`src/schemas/agent-mapping.json`:

```json
{
  "claude-code": {
    "SessionStart": "SessionStarted",
    "UserPromptSubmit": "UserPromptReceived",
    "PreToolUse": "ToolCallRequested",
    "PostToolUse": "ToolCallCompleted",
    "PostToolUseFailure": "ToolCallFailed",
    "SubagentStart": "AgentSpawned",
    "SubagentStop": "AgentCompleted",
    "Stop": "TurnCompleted",
    "PreCompact": "CompactionTriggered",
    "SessionEnd": "SessionEnded"
  },
  "opencode": {
    "session.created": "SessionStarted",
    "session.deleted": "SessionEnded",
    "session.idle": "TurnCompleted",
    "session.compacted": "CompactionTriggered",
    "message.updated": "UserPromptReceived",
    "tool.execute.before": "ToolCallRequested",
    "tool.execute.after": "ToolCallCompleted",
    "permission.asked": "PermissionRequested",
    "permission.replied": "PermissionResponded"
  },
  "codex": {
    "tool_use": "ToolCallRequested",
    "tool_result": "ToolCallCompleted",
    "tool_error": "ToolCallFailed",
    "turn_end": "TurnCompleted",
    "permission": "PermissionRequested",
    "permission_response": "PermissionResponded"
  }
}
```

`src/schemas/unified-event.schema.json`: A JSON Schema (draft-07) validating the envelope structure including required fields, type constraints, and enum values for `agent_provider` and `event_type`.

`src/lib/unified_events.mjs`: Node.js module exporting:
- `UNIFIED_EVENT_TYPES` -- array of the 12 types
- `AGENT_PROVIDERS` -- array of valid providers
- `AGENT_MAPPING` -- the mapping table from `agent-mapping.json`
- `validateUnifiedEvent(event)` -- validates an event object against the schema
- `buildUnifiedEnvelope(params)` -- creates a unified event object
- `getDefaultProvider(event)` -- returns `"claude-code"` for legacy events missing `agent_provider`

**Acceptance Criteria**

- [ ] All 12 unified event types are defined as constants in both shell and Node.js
- [ ] The agent-to-unified mapping table covers Claude Code (10 events), OpenCode (9 events), and Codex (6 events + 2 synthetic: SessionStarted, SessionEnded)
- [ ] `gc_validate_event_type` correctly accepts all 12 types and rejects unknown strings
- [ ] `gc_validate_agent_provider` accepts "claude-code", "opencode", "codex", "custom"
- [ ] `gc_build_unified_envelope` produces valid JSON with all 10 fields
- [ ] The JSON Schema validates correct envelopes and rejects envelopes with missing/invalid fields
- [ ] Backward compatibility: events without `agent_provider` default to `"claude-code"` in the Node.js module
- [ ] Events without `agent_metadata` default to `{}` in the Node.js module
- [ ] Reserved provider names are enforced by `gc_is_reserved_provider`

**Edge Cases**

- Event type string with leading/trailing whitespace: trim before validation
- Agent provider "Custom" (uppercase): reject; must be lowercase "custom"
- Empty `data` field: valid (empty object `{}`)
- Missing `agent_metadata` subfields: all subfields are optional; partial objects are valid
- `agent_pid` as string vs number: schema requires number type

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 2: agentctx-hook Wrapper Script

**Description**

Create the `agentctx-hook` wrapper script that replaces `gc-hook` as the entry point for all command-based hook integrations (primarily Claude Code). This script reads JSON from stdin, tags it with the agent provider, and sends it to the daemon's event intake via Unix socket. If the daemon is unavailable, it falls back to direct file write via `capture-event`.

The script must always exit 0, produce no stdout output, and suppress all stderr. It is invoked by `settings.json` hooks in Claude Code and potentially by other agents that use a command-based hook mechanism.

**Prerequisites/Inputs**

- Task 1 (unified event types and envelope format)
- Task 3 (enhanced `capture-event` with `--agent-provider` flag)
- Existing `gc-hook` implementation (`/home/meywd/GlobalContext/src/gc-hook`) as reference

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/bin/agentctx-hook` | Create | Hook wrapper script |
| `tests/bin/test_agentctx_hook.sh` | Create | Unit tests for the hook wrapper |

`src/bin/agentctx-hook`:

```bash
#!/usr/bin/env bash
# AgentContext hook wrapper
# Usage: agentctx-hook <agent-provider> <UnifiedEventType>
# Reads JSON from stdin, tags with agent provider, sends to daemon intake.
# ALWAYS exits 0. NEVER produces stdout. NEVER produces visible stderr.
set -uo pipefail

AGENT_PROVIDER="${1:?Missing agent provider}"
EVENT_TYPE="${2:?Missing event type}"
AGENTCTX_DIR="${AGENTCTX_HOME:-$HOME/.agentctx}"
GC_BASE="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"

# Read the full payload from stdin once
payload=$(cat)

# Derive the agent native event from the mapping or use the event type itself
# For Claude Code, the native event is the settings.json hook name
# which is the inverse of the mapping table. We pass it via env or derive it.
AGENT_NATIVE_EVENT="${AGENT_NATIVE_EVENT:-$EVENT_TYPE}"

# Try daemon intake first (HTTP POST to Unix socket)
if [ -S "$AGENTCTX_DIR/daemon.sock" ]; then
  printf '%s' "$payload" | curl -s --max-time 4 \
    --unix-socket "$AGENTCTX_DIR/daemon.sock" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Provider: $AGENT_PROVIDER" \
    -H "X-Event-Type: $EVENT_TYPE" \
    -H "X-Agent-Native-Event: $AGENT_NATIVE_EVENT" \
    -d @- \
    "http://localhost/api/events/intake" \
    >/dev/null 2>/dev/null && exit 0
fi

# Fallback: write directly to event store (standalone mode)
if [ -x "$AGENTCTX_DIR/bin/capture-event" ]; then
  printf '%s' "$payload" | "$AGENTCTX_DIR/bin/capture-event" "$EVENT_TYPE" \
    --agent-provider "$AGENT_PROVIDER" \
    --agent-native-event "$AGENT_NATIVE_EVENT" \
    >/dev/null 2>/dev/null || true
elif [ -x "$GC_BASE/bin/capture-event" ]; then
  # Legacy GC fallback
  printf '%s' "$payload" | "$GC_BASE/bin/capture-event" "$EVENT_TYPE" \
    --agent-provider "$AGENT_PROVIDER" \
    --agent-native-event "$AGENT_NATIVE_EVENT" \
    >/dev/null 2>/dev/null || true
fi

exit 0
```

Key behaviors:
- **Always exits 0**: The `|| true` on every fallback path and the final `exit 0` guarantee this.
- **No stdout**: All output is redirected to `/dev/null`.
- **No stderr**: All error output is redirected to `/dev/null`.
- **Daemon-first**: Checks for `daemon.sock` Unix socket existence before attempting HTTP POST.
- **Fallback chain**: daemon socket -> agentctx capture-event -> legacy GC capture-event -> silently discard.
- **Timeout**: `curl --max-time 4` ensures the hook does not block the agent for more than 4 seconds (within the 5-second hook timeout).
- **stdin passthrough**: The full payload from the agent's hook is read once and forwarded without modification.

**Acceptance Criteria**

- [ ] `agentctx-hook claude-code SessionStarted` reads stdin and exits 0
- [ ] When daemon socket exists, event is sent via HTTP POST with correct headers
- [ ] When daemon socket does not exist, falls back to `capture-event` with `--agent-provider`
- [ ] When neither daemon nor capture-event are available, exits 0 silently
- [ ] Produces no stdout output under any circumstances
- [ ] Produces no stderr output under any circumstances
- [ ] Always exits 0 regardless of daemon or capture-event failures
- [ ] curl timeout is 4 seconds (within 5-second hook timeout budget)
- [ ] Works with both `AGENTCTX_HOME` override and default `~/.agentctx`

**Edge Cases**

- Empty stdin (no payload): should still exit 0 without error
- daemon.sock exists but daemon is not responding: curl times out, falls back to direct write
- daemon.sock is a regular file (not a socket): curl fails, falls back to direct write
- capture-event is not executable: `[ -x ]` check skips it; exits 0
- Very large stdin payload (>1MB): curl and capture-event handle streaming; no in-memory size limit beyond bash variable capacity
- Concurrent hook invocations: each invocation is independent; no shared state

**Estimated Effort**: S (Small) -- 2-3 hours

---

### Task 3: capture-event Enhancement

**Description**

Enhance the existing `capture-event` script to accept the three new unified event envelope fields: `--agent-provider`, `--agent-native-event`, and `--agent-metadata` (JSON string). When these flags are provided, the generated event envelope includes them. When omitted, the envelope defaults to `agent_provider: "claude-code"`, `agent_native_event: <event_type>`, and `agent_metadata: {}` for backward compatibility.

**Prerequisites/Inputs**

- Task 1 (unified event type definitions)
- Existing `capture-event` implementation (`/home/meywd/GlobalContext/src/capture-event`)

**Implementation Details**

Files to modify:

| File | Action | Purpose |
|---|---|---|
| `src/capture-event` | Modify | Add `--agent-provider`, `--agent-native-event`, `--agent-metadata` flags |
| `tests/test_capture_event_unified.sh` | Create | Tests for unified envelope generation |

Changes to `src/capture-event`:

1. **Flag parsing**: Add three new optional flags after the existing positional arguments:
   ```bash
   AGENT_PROVIDER="claude-code"          # default
   AGENT_NATIVE_EVENT=""                 # default: same as EVENT_TYPE
   AGENT_METADATA='{}'                    # default: empty object

   while [[ $# -gt 0 ]]; do
     case "$1" in
       --agent-provider)
         AGENT_PROVIDER="$2"; shift 2 ;;
       --agent-native-event)
         AGENT_NATIVE_EVENT="$2"; shift 2 ;;
       --agent-metadata)
         AGENT_METADATA="$2"; shift 2 ;;
       *)
         # existing positional arg handling
         ;;
     esac
   done

   # Default native event to event type if not specified
   AGENT_NATIVE_EVENT="${AGENT_NATIVE_EVENT:-$EVENT_TYPE}"
   ```

2. **Envelope construction**: Add the three new fields to the jq envelope builder:
   ```bash
   # In the jq command that builds the event JSON, add:
   --arg ap "$AGENT_PROVIDER" \
   --arg ane "$AGENT_NATIVE_EVENT" \
   --argjson am "$AGENT_METADATA" \
   # ... in the output template:
   # agent_provider: $ap,
   # agent_native_event: $ane,
   # agent_metadata: $am,
   ```

3. **Validation**: Before writing, validate that `AGENT_PROVIDER` is one of the recognized values. If it is an unrecognized value but non-empty, still write (to support "custom" providers from Task 8) but log a warning to the debug log.

4. **Backward compatibility**: If `--agent-provider` is not passed, the default `"claude-code"` is used. Existing callers (the current `gc-hook`) do not pass this flag and continue to work unchanged.

**Acceptance Criteria**

- [ ] `echo '{}' | capture-event ToolCallCompleted` produces an envelope with `agent_provider: "claude-code"` (default)
- [ ] `echo '{}' | capture-event ToolCallCompleted --agent-provider opencode` produces an envelope with `agent_provider: "opencode"`
- [ ] `echo '{}' | capture-event ToolCallCompleted --agent-native-event tool.execute.after` includes the native event name
- [ ] When `--agent-native-event` is omitted, it defaults to the event type value
- [ ] When `--agent-metadata '{"model":"gpt-4o"}'` is passed, the metadata is included in the envelope
- [ ] When `--agent-metadata` is omitted, it defaults to `{}`
- [ ] Existing callers that do not pass new flags continue to work unchanged
- [ ] The 7 original envelope fields are unchanged in position and content
- [ ] Invalid JSON for `--agent-metadata` is handled gracefully (defaults to `{}`)

**Edge Cases**

- `--agent-metadata` with invalid JSON: log warning, default to `{}`
- `--agent-provider` with empty string: use default `"claude-code"`
- Flags mixed with positional args: parser must handle both orderings
- `--agent-provider custom` with a non-reserved name like "cursor": accepted for custom hooks

**Estimated Effort**: M (Medium) -- 2-3 hours

---

### Task 4: agentctx CLI Scaffolding

**Description**

Create the `agentctx` CLI as the management interface for the multi-agent hook system. This task builds the CLI entry point with subcommand routing, the `~/.agentctx/` directory structure, and the `config.json` configuration file. Subsequent tasks (5-9) add the specific subcommands.

**Prerequisites/Inputs**

- Task 1 (event types referenced in config schema)
- Existing `gc-install` and `gc-query` as CLI design references

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/bin/agentctx` | Create | Main CLI entry point with subcommand routing |
| `src/lib/agentctx_config.sh` | Create | Config file management (read, write, merge) |
| `src/lib/agentctx_paths.sh` | Create | Path constants for `~/.agentctx/` tree |
| `src/lib/agentctx_detect.sh` | Create | Agent auto-detection functions |
| `src/lib/agentctx_output.sh` | Create | Consistent output formatting (prefix, colors, alignment) |

`src/bin/agentctx` -- CLI entry point:

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENTCTX_DIR="${AGENTCTX_HOME:-$HOME/.agentctx}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"

# Source common libraries
source "$LIB_DIR/agentctx_paths.sh"
source "$LIB_DIR/agentctx_output.sh"

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  install)   source "$LIB_DIR/../bin/agentctx-install"   && agentctx_install "$@" ;;
  doctor)    source "$LIB_DIR/../bin/agentctx-doctor"     && agentctx_doctor "$@" ;;
  reload)    source "$LIB_DIR/../bin/agentctx-reload"     && agentctx_reload "$@" ;;
  hooks)     source "$LIB_DIR/../bin/agentctx-hooks"      && agentctx_hooks "$@" ;;
  version)   agentctx_version ;;
  help|--help|-h)  agentctx_help ;;
  *)
    agentctx_err "Unknown command: $COMMAND"
    agentctx_help
    exit 1
    ;;
esac
```

`src/lib/agentctx_paths.sh`:

```bash
# Standard paths for the agentctx installation
AGENTCTX_DIR="${AGENTCTX_HOME:-$HOME/.agentctx}"
AGENTCTX_BIN="$AGENTCTX_DIR/bin"
AGENTCTX_CONFIG="$AGENTCTX_DIR/config.json"
AGENTCTX_DAEMON_SOCK="$AGENTCTX_DIR/daemon.sock"
AGENTCTX_DAEMON_PID="$AGENTCTX_DIR/daemon.pid"
AGENTCTX_HOOKS_DIR="$AGENTCTX_DIR/hooks.d"
AGENTCTX_INTEGRATIONS_DIR="$AGENTCTX_DIR/integrations"
AGENTCTX_LOG="$AGENTCTX_DIR/agentctx.log"

# Event store (shared with GC)
GC_BASE="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
```

`src/lib/agentctx_detect.sh`:

```bash
# Auto-detect installed coding agents
# Returns a newline-separated list of detected agent provider names

agentctx_detect_agents() {
  local found=()

  # Claude Code: check for claude binary or ~/.claude/ directory
  if command -v claude &>/dev/null || [ -d "$HOME/.claude" ]; then
    found+=("claude-code")
  fi

  # OpenCode: check for opencode binary or ~/.opencode/ directory
  if command -v opencode &>/dev/null || [ -d "$HOME/.opencode" ]; then
    found+=("opencode")
  fi

  # Codex: check for codex binary or ~/.codex/ directory
  if command -v codex &>/dev/null || [ -d "$HOME/.codex" ]; then
    found+=("codex")
  fi

  printf '%s\n' "${found[@]}"
}

# Get version string for a detected agent
agentctx_agent_version() {
  local agent="$1"
  case "$agent" in
    claude-code)
      claude --version 2>/dev/null | head -1 || echo "unknown"
      ;;
    opencode)
      opencode --version 2>/dev/null | head -1 || echo "unknown"
      ;;
    codex)
      codex --version 2>/dev/null | head -1 || echo "unknown"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}
```

`src/lib/agentctx_config.sh`:

```bash
# Config file management for ~/.agentctx/config.json

# Initialize config.json with default structure
agentctx_config_init() {
  local config_file="$AGENTCTX_CONFIG"
  if [ ! -f "$config_file" ]; then
    mkdir -p "$(dirname "$config_file")"
    cat > "$config_file" << 'CONFIGEOF'
{
  "version": "1.0.0",
  "created_at": "",
  "integrations": {
    "claude-code": { "enabled": false },
    "opencode": { "enabled": false },
    "codex": { "enabled": false }
  },
  "custom_hooks": {},
  "daemon": {
    "socket_path": "~/.agentctx/daemon.sock",
    "pid_file": "~/.agentctx/daemon.pid"
  }
}
CONFIGEOF
    # Set created_at
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg ts "$ts" '.created_at = $ts' "$config_file" > "$config_file.tmp" && mv "$config_file.tmp" "$config_file"
    chmod 600 "$config_file"
  fi
}

# Read a config value by jq path
agentctx_config_get() {
  local path="$1"
  jq -r "$path // empty" "$AGENTCTX_CONFIG" 2>/dev/null
}

# Set a config value by jq path
agentctx_config_set() {
  local path="$1"
  local value="$2"
  local config_file="$AGENTCTX_CONFIG"
  jq "$path = $value" "$config_file" > "$config_file.tmp" && mv "$config_file.tmp" "$config_file"
}
```

`src/lib/agentctx_output.sh`:

```bash
# Consistent output formatting for agentctx CLI

AGENTCTX_PREFIX="[agentctx]"

agentctx_msg() {
  echo "$AGENTCTX_PREFIX $*"
}

agentctx_err() {
  echo "$AGENTCTX_PREFIX ERROR: $*" >&2
}

agentctx_warn() {
  echo "$AGENTCTX_PREFIX WARN: $*" >&2
}

agentctx_ok() {
  printf '%-40s %s\n' "  $1" "OK"
}

agentctx_fail() {
  printf '%-40s %s\n' "  $1" "FAIL"
}

agentctx_skip() {
  printf '%-40s %s\n' "  $1" "SKIP"
}

# Dotted alignment for doctor output
# Usage: agentctx_status_line "Label" "Detail" "STATUS"
agentctx_status_line() {
  local label="$1"
  local detail="$2"
  local status="$3"
  local dots
  dots=$(printf '.%.0s' $(seq 1 $((30 - ${#label}))))
  printf '  %s %s %s  %s\n' "$label" "$dots" "$detail" "$status"
}
```

Directory structure created by `agentctx install`:

```
~/.agentctx/
  bin/
    agentctx              # CLI entry point (symlink or copy)
    agentctx-hook         # Hook wrapper
    capture-event         # Enhanced capture-event
  lib/                    # Shell libraries
  config.json             # Configuration
  integrations/
    claude-code/
      hooks.json          # Reference copy of installed hooks
    opencode/
      plugin/             # OpenCode plugin source files
    codex/
      watcher.json        # Watcher configuration
  hooks.d/                # Custom hook extensions
```

**Acceptance Criteria**

- [ ] `agentctx help` prints usage information with all subcommands
- [ ] `agentctx version` prints the installed version
- [ ] `agentctx install`, `agentctx doctor`, `agentctx reload`, `agentctx hooks` route to correct subcommands
- [ ] Unknown subcommands print error and usage
- [ ] `~/.agentctx/` directory tree is created on first run
- [ ] `config.json` is created with default structure on first run
- [ ] `config.json` is preserved on subsequent runs (never overwritten)
- [ ] `agentctx_detect_agents` correctly finds agents by binary and directory
- [ ] Output formatting is consistent across all subcommands
- [ ] `AGENTCTX_HOME` env var overrides the default `~/.agentctx` path

**Edge Cases**

- `~/.agentctx/` exists but `config.json` is missing: recreate config only
- `config.json` is malformed JSON: warn and recreate with defaults
- Running as root: warn about non-standard HOME
- `AGENTCTX_HOME` set to a path with spaces: must be quoted throughout

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 5: Claude Code Installer (`agentctx install --claude-code`)

**Description**

Implement the Claude Code hook installer that registers all 10 `agentctx-hook` commands in `~/.claude/settings.json`. This replaces and extends the existing `gc-install-hooks` from Story 02. It detects existing GC hooks (for migration) and existing agentctx hooks (for idempotent updates), backs up `settings.json`, merges hooks preserving user-defined entries, and validates the result.

**Prerequisites/Inputs**

- Task 2 (`agentctx-hook` wrapper must exist)
- Task 4 (CLI scaffolding for subcommand routing)
- Existing `gc-install-hooks` (`/home/meywd/GlobalContext/src/gc-install-hooks`) as reference
- Story 09 requirement Section 2 (Claude Code Hook Integration)
- Story 09 requirement Section 5.3 (Claude Code Installer Steps)

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/bin/agentctx-install` | Create | Install subcommand implementation |
| `src/lib/agentctx_claude_code.sh` | Create | Claude Code-specific install/detect/validate functions |
| `src/data/claude-code-hooks.json` | Create | Hook configuration template for settings.json |
| `tests/bin/test_agentctx_install_claude_code.sh` | Create | Claude Code installer tests |

`src/data/claude-code-hooks.json`:

This file contains the 10 hook entries in the format required by `~/.claude/settings.json`. Each entry references `agentctx-hook` instead of `gc-hook`:

```json
{
  "hooks": {
    "SessionStart": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code SessionStarted", "async": false, "timeout": 5000, "matcher": "" }],
    "UserPromptSubmit": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code UserPromptReceived", "async": false, "timeout": 5000 }],
    "PreToolUse": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallRequested", "async": true, "timeout": 5000, "matcher": ".*" }],
    "PostToolUse": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallCompleted", "async": true, "timeout": 5000, "matcher": ".*" }],
    "PostToolUseFailure": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code ToolCallFailed", "async": true, "timeout": 5000, "matcher": ".*" }],
    "SubagentStart": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code AgentSpawned", "async": true, "timeout": 5000, "matcher": ".*" }],
    "SubagentStop": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code AgentCompleted", "async": true, "timeout": 5000, "matcher": ".*" }],
    "Stop": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code TurnCompleted", "async": true, "timeout": 5000 }],
    "PreCompact": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code CompactionTriggered", "async": false, "timeout": 5000 }],
    "SessionEnd": [{ "type": "command", "command": "~/.agentctx/bin/agentctx-hook claude-code SessionEnded", "async": true, "timeout": 5000 }]
  }
}
```

`src/lib/agentctx_claude_code.sh`:

```bash
# Claude Code hook installation functions

# Detect existing hooks in settings.json
# Returns: "gc-hooks" | "agentctx-hooks" | "none"
agentctx_cc_detect_existing_hooks() {
  local settings="$HOME/.claude/settings.json"
  [ ! -f "$settings" ] && echo "none" && return

  if jq -e '.hooks // empty | to_entries[] | .value[] | select(.command | contains("agentctx-hook"))' "$settings" >/dev/null 2>&1; then
    echo "agentctx-hooks"
  elif jq -e '.hooks // empty | to_entries[] | .value[] | select(.command | contains("gc-hook"))' "$settings" >/dev/null 2>&1; then
    echo "gc-hooks"
  else
    echo "none"
  fi
}

# Backup settings.json before modification
agentctx_cc_backup_settings() {
  local settings="$HOME/.claude/settings.json"
  if [ -f "$settings" ]; then
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local backup="$settings.bak.$timestamp"
    cp "$settings" "$backup"
    echo "$backup"
  fi
}

# Merge agentctx hooks into settings.json, preserving user-defined hooks
# "User-defined" = any hook entry whose command does not contain "gc-hook" or "agentctx-hook"
agentctx_cc_merge_hooks() {
  local settings="$HOME/.claude/settings.json"
  local hooks_template="$1"  # path to claude-code-hooks.json

  if [ ! -f "$settings" ]; then
    mkdir -p "$(dirname "$settings")"
    echo '{}' > "$settings"
  fi

  # Build the merge: for each hook type in the template,
  # remove any existing gc-hook or agentctx-hook entries,
  # add the new agentctx-hook entries,
  # preserve user-defined entries
  local template_hooks
  template_hooks=$(jq '.hooks' "$hooks_template")

  local merged
  merged=$(jq --argjson new_hooks "$template_hooks" '
    # Ensure .hooks exists
    .hooks //= {} |
    # For each hook type in the template
    reduce ($new_hooks | to_entries[]) as $entry (.;
      # Get existing entries for this hook type, filtering out gc-hook and agentctx-hook
      .hooks[$entry.key] = (
        [(.hooks[$entry.key] // [])[] | select(
          (.command | contains("gc-hook") | not) and
          (.command | contains("agentctx-hook") | not)
        )] + $entry.value
      )
    )
  ' "$settings")

  printf '%s' "$merged" | jq '.' > "$settings.tmp"
  mv "$settings.tmp" "$settings"
}

# Validate that all 10 hooks are present
agentctx_cc_validate_hooks() {
  local settings="$HOME/.claude/settings.json"
  local count
  count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(.command | contains("agentctx-hook"))] | length' "$settings" 2>/dev/null || echo "0")
  [ "$count" -eq 10 ]
}
```

`src/bin/agentctx-install`:

```bash
# agentctx install subcommand
# Usage: agentctx install [--claude-code] [--opencode] [--codex] [--all] [--force]

agentctx_install() {
  local install_claude_code=false
  local install_opencode=false
  local install_codex=false
  local install_all=false
  local force=false

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --claude-code) install_claude_code=true; shift ;;
      --opencode)    install_opencode=true; shift ;;
      --codex)       install_codex=true; shift ;;
      --all)         install_all=true; shift ;;
      --force)       force=true; shift ;;
      *)             agentctx_err "Unknown option: $1"; return 1 ;;
    esac
  done

  # Default: --all if no specific flag
  if ! $install_claude_code && ! $install_opencode && ! $install_codex; then
    install_all=true
  fi

  # Initialize agentctx directory structure
  agentctx_init_dirs

  # Auto-detect agents if --all
  if $install_all; then
    local detected
    detected=$(agentctx_detect_agents)
    [[ "$detected" == *"claude-code"* ]] && install_claude_code=true
    [[ "$detected" == *"opencode"* ]] && install_opencode=true
    [[ "$detected" == *"codex"* ]] && install_codex=true
  fi

  local installed=0

  # Claude Code
  if $install_claude_code; then
    agentctx_install_claude_code "$force" && ((installed++)) || true
  fi

  # OpenCode
  if $install_opencode; then
    agentctx_install_opencode "$force" && ((installed++)) || true
  fi

  # Codex
  if $install_codex; then
    agentctx_install_codex "$force" && ((installed++)) || true
  fi

  agentctx_msg ""
  agentctx_msg "$installed integration(s) installed."
}

agentctx_install_claude_code() {
  local force="${1:-false}"
  local data_dir="$SCRIPT_DIR/../data"

  agentctx_msg ""
  agentctx_msg "Claude Code Integration"

  # Step 1: Verify prerequisites
  if [ ! -x "$AGENTCTX_BIN/agentctx-hook" ]; then
    agentctx_err "agentctx-hook not found at $AGENTCTX_BIN/agentctx-hook"
    return 1
  fi

  # Step 2: Detect existing hooks
  source "$LIB_DIR/agentctx_claude_code.sh"
  local existing
  existing=$(agentctx_cc_detect_existing_hooks)

  case "$existing" in
    gc-hooks)
      agentctx_msg "  Detected existing GlobalContext hooks -- migrating..."
      ;;
    agentctx-hooks)
      if [ "$force" != "true" ]; then
        agentctx_msg "  Hooks already installed -- updating in place..."
      fi
      ;;
    none)
      agentctx_msg "  Installing fresh hooks..."
      ;;
  esac

  # Step 3: Backup
  local backup
  backup=$(agentctx_cc_backup_settings)
  [ -n "$backup" ] && agentctx_msg "  Backup: $backup"

  # Step 4: Merge hooks
  agentctx_cc_merge_hooks "$data_dir/claude-code-hooks.json"

  # Step 5: Validate
  if agentctx_cc_validate_hooks; then
    agentctx_msg "  10 hooks registered in ~/.claude/settings.json"
  else
    agentctx_err "  Hook validation failed -- expected 10 hooks"
    return 1
  fi

  # Step 6: Update config
  agentctx_config_set '.integrations."claude-code".enabled' 'true'

  # Step 7: Save reference copy
  mkdir -p "$AGENTCTX_INTEGRATIONS_DIR/claude-code"
  cp "$HOME/.claude/settings.json" "$AGENTCTX_INTEGRATIONS_DIR/claude-code/hooks.json"

  agentctx_msg "  Claude Code hooks installed successfully"
  return 0
}
```

**Acceptance Criteria**

- [ ] `agentctx install --claude-code` installs all 10 hooks in `~/.claude/settings.json`
- [ ] Existing GC hooks (`gc-hook` commands) are replaced with `agentctx-hook` commands
- [ ] Existing agentctx hooks are updated in place (idempotent)
- [ ] User-defined hooks (not containing `gc-hook` or `agentctx-hook`) are preserved
- [ ] `settings.json` is backed up before modification with timestamp in filename
- [ ] Validation confirms all 10 hooks are present after merge
- [ ] `config.json` integration status is updated to `enabled: true`
- [ ] A reference copy of the hooks is saved to `~/.agentctx/integrations/claude-code/hooks.json`
- [ ] `--force` flag forces reinstallation even if hooks already exist
- [ ] The sync/async classification matches Story 02 exactly (SessionStart, UserPromptSubmit, PreCompact are sync; rest are async)
- [ ] All timeouts are 5000ms
- [ ] Matcher configuration matches Story 02 exactly

**Edge Cases**

- `~/.claude/` directory does not exist: created with mode 0700
- `settings.json` does not exist: created with `{}`
- `settings.json` is malformed JSON: abort with clear error, do not modify
- `settings.json` has nested hook arrays (multiple entries per hook type): agentctx entries are added alongside existing user entries
- Running install twice in quick succession: idempotent, no duplicates
- `settings.json` is read-only: error with clear message

**Estimated Effort**: L (Large) -- 4-6 hours

---

### Task 6: OpenCode Plugin Integration (`agentctx install --opencode`)

**Description**

Create the OpenCode plugin that integrates with OpenCode's plugin system to capture events. The installer creates the plugin directory at `~/.opencode/plugins/agentctx/` with the manifest file, TypeScript entry point, and event handler module.

**Prerequisites/Inputs**

- Task 1 (unified event types for mapping)
- Task 4 (CLI scaffolding)
- Story 09 requirement Section 3 (OpenCode Hook Integration)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/integrations/opencode/plugin.json` | Create | OpenCode plugin manifest |
| `src/integrations/opencode/index.ts` | Create | Plugin entry point |
| `src/integrations/opencode/event-handler.ts` | Create | Event normalization logic |
| `src/lib/agentctx_opencode.sh` | Create | OpenCode-specific install/detect/validate functions |
| `tests/bin/test_agentctx_install_opencode.sh` | Create | OpenCode installer tests |

The plugin files (`plugin.json`, `index.ts`, `event-handler.ts`) follow the exact specifications from Story 09 Section 3.2-3.4. Key implementation details:

`src/lib/agentctx_opencode.sh`:

```bash
# OpenCode plugin installation functions

OPENCODE_PLUGIN_DIR="$HOME/.opencode/plugins/agentctx"

agentctx_oc_detect_existing() {
  [ -d "$OPENCODE_PLUGIN_DIR" ] && [ -f "$OPENCODE_PLUGIN_DIR/plugin.json" ]
}

agentctx_oc_install_plugin() {
  local source_dir="$1"  # path to src/integrations/opencode/
  local force="${2:-false}"

  # Create plugin directory
  mkdir -p "$OPENCODE_PLUGIN_DIR"

  # Copy plugin files
  cp "$source_dir/plugin.json" "$OPENCODE_PLUGIN_DIR/"
  cp "$source_dir/index.ts" "$OPENCODE_PLUGIN_DIR/"
  cp "$source_dir/event-handler.ts" "$OPENCODE_PLUGIN_DIR/"

  # Update socket path in plugin config based on AGENTCTX_HOME
  local socket_path="${AGENTCTX_DIR}/daemon.sock"
  # The plugin reads AGENTCTX_SOCKET from environment, so no file patching needed
}

agentctx_oc_validate() {
  # Check plugin directory exists
  [ -d "$OPENCODE_PLUGIN_DIR" ] || return 1
  # Check plugin.json is valid
  jq . "$OPENCODE_PLUGIN_DIR/plugin.json" >/dev/null 2>&1 || return 1
  # Check event count
  local events
  events=$(jq -r '.events | length' "$OPENCODE_PLUGIN_DIR/plugin.json" 2>/dev/null)
  [ "$events" -eq 9 ] || return 1
  # Check required files exist
  [ -f "$OPENCODE_PLUGIN_DIR/index.ts" ] || return 1
  [ -f "$OPENCODE_PLUGIN_DIR/event-handler.ts" ] || return 1
  return 0
}
```

The `agentctx_install_opencode` function in `src/bin/agentctx-install`:

```bash
agentctx_install_opencode() {
  local force="${1:-false}"
  local source_dir="$SCRIPT_DIR/../integrations/opencode"

  agentctx_msg ""
  agentctx_msg "OpenCode Integration"

  # Verify source files exist
  if [ ! -d "$source_dir" ]; then
    agentctx_err "  OpenCode plugin source not found at $source_dir"
    return 1
  fi

  # Detect existing plugin
  source "$LIB_DIR/agentctx_opencode.sh"
  if agentctx_oc_detect_existing && [ "$force" != "true" ]; then
    agentctx_msg "  Plugin already installed -- updating..."
  fi

  # Install plugin files
  agentctx_oc_install_plugin "$source_dir" "$force"

  # Validate installation
  if agentctx_oc_validate; then
    agentctx_msg "  Plugin installed at ~/.opencode/plugins/agentctx/"
    agentctx_msg "  Events: 9 event subscriptions"
  else
    agentctx_err "  Plugin validation failed"
    return 1
  fi

  # Update config
  agentctx_config_set '.integrations.opencode.enabled' 'true'

  # Save reference copy
  mkdir -p "$AGENTCTX_INTEGRATIONS_DIR/opencode/plugin"
  cp -r "$OPENCODE_PLUGIN_DIR/"* "$AGENTCTX_INTEGRATIONS_DIR/opencode/plugin/"

  agentctx_msg "  OpenCode plugin installed successfully"
  return 0
}
```

**Acceptance Criteria**

- [ ] `agentctx install --opencode` creates `~/.opencode/plugins/agentctx/` with `plugin.json`, `index.ts`, `event-handler.ts`
- [ ] `plugin.json` manifest declares all 9 event subscriptions
- [ ] `index.ts` subscribes to all 9 OpenCode events and forwards to daemon
- [ ] `event-handler.ts` correctly maps all OpenCode events to unified types
- [ ] `message.updated` events are filtered to only capture `role=user` messages
- [ ] `tool.execute.after` events are split into `ToolCallCompleted` (no error) and `ToolCallFailed` (with error)
- [ ] Plugin falls back to CLI invocation when daemon socket is unavailable
- [ ] Plugin never throws or disrupts the OpenCode session
- [ ] Running installer twice is idempotent (files are overwritten, no duplicates)
- [ ] `config.json` integration status updated to `enabled: true`

**Edge Cases**

- `~/.opencode/` does not exist: create it and `~/.opencode/plugins/` with appropriate permissions
- OpenCode is not installed but user explicitly requests `--opencode`: install anyway (they might install OpenCode later)
- Plugin files are read-only: error with clear message
- `opencode` binary exists but `~/.opencode/plugins/` path is different: use standard path; if OpenCode uses a different plugin directory, the user must configure it manually

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 7: Codex Watcher Integration (`agentctx install --codex`)

**Description**

Implement the Codex integration that captures events from Codex's JSONL session files. Unlike Claude Code and OpenCode, Codex does not have a hook or plugin system. Instead, the daemon monitors `~/.codex/sessions/` for new session directories and tails `messages.jsonl` files in real time.

This task creates the watcher configuration and the watcher module itself. The watcher is a Node.js module that runs as part of the daemon.

**Prerequisites/Inputs**

- Task 1 (unified event types for mapping)
- Task 4 (CLI scaffolding and config management)
- Story 09 requirement Section 4 (Codex Hook Integration)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/integrations/codex/watcher.mjs` | Create | Codex session file watcher (Node.js) |
| `src/integrations/codex/codex-mapping.json` | Create | JSONL type to unified event mapping |
| `src/lib/agentctx_codex.sh` | Create | Codex-specific install/detect functions |
| `tests/integrations/test_codex_watcher.mjs` | Create | Codex watcher unit tests |

`src/integrations/codex/watcher.mjs`:

```javascript
import { watch, createReadStream, existsSync, mkdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { readdir } from 'fs/promises';

const TYPE_MAP = {
  tool_use: 'ToolCallRequested',
  tool_result: 'ToolCallCompleted',
  tool_error: 'ToolCallFailed',
  turn_end: 'TurnCompleted',
  permission: 'PermissionRequested',
  permission_response: 'PermissionResponded',
};

export class CodexSessionWatcher {
  constructor(config) {
    this.sessionDir = config.sessionDir;      // e.g., ~/.codex/sessions/
    this.daemonSocket = config.daemonSocket;
    this.captureEventBin = config.captureEventBin;
    this.activeWatchers = new Map();           // sessionId -> AbortController
    this.offsets = new Map();                  // filePath -> byte offset
    this.dirWatcher = null;
  }

  start() {
    // Ensure session directory exists
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    // Watch for new session directories
    this.dirWatcher = watch(this.sessionDir, { recursive: false }, (event, filename) => {
      if (event === 'rename' && filename && !this.activeWatchers.has(filename)) {
        this.watchSession(filename);
      }
    });

    // Scan for already-running sessions
    this.scanExistingSessions();
  }

  stop() {
    if (this.dirWatcher) this.dirWatcher.close();
    for (const [, controller] of this.activeWatchers) {
      controller.abort();
    }
    this.activeWatchers.clear();
    this.offsets.clear();
  }

  async scanExistingSessions() {
    try {
      const entries = await readdir(this.sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !this.activeWatchers.has(entry.name)) {
          this.watchSession(entry.name);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  async watchSession(sessionId) {
    const messagesPath = join(this.sessionDir, sessionId, 'messages.jsonl');
    const controller = new AbortController();
    this.activeWatchers.set(sessionId, controller);

    // Emit SessionStarted
    await this.emitEvent('SessionStarted', sessionId, {
      session_id: sessionId,
      source: 'directory_detected',
    }, 'process_spawn');

    // Wait for messages.jsonl to appear (may not exist yet)
    this.waitForFileAndTail(messagesPath, sessionId, controller.signal);
  }

  async waitForFileAndTail(filePath, sessionId, signal) {
    const checkInterval = setInterval(async () => {
      if (signal.aborted) {
        clearInterval(checkInterval);
        return;
      }
      if (existsSync(filePath)) {
        clearInterval(checkInterval);
        await this.tailJsonl(filePath, sessionId, signal);
      }
    }, 500);

    signal.addEventListener('abort', () => clearInterval(checkInterval));
  }

  async tailJsonl(filePath, sessionId, signal) {
    let offset = this.offsets.get(filePath) || 0;

    const processNewLines = async () => {
      try {
        // Check for file truncation
        const stats = statSync(filePath);
        if (stats.size < offset) {
          offset = 0; // Reset on truncation
        }

        const stream = createReadStream(filePath, { start: offset });
        const rl = createInterface({ input: stream });

        for await (const line of rl) {
          if (signal.aborted) break;
          offset += Buffer.byteLength(line, 'utf8') + 1;
          this.offsets.set(filePath, offset);

          try {
            const message = JSON.parse(line);
            await this.handleMessage(sessionId, message);
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // File might have been deleted
      }
    };

    // Watch for file changes
    try {
      const watcher = watch(filePath, async () => {
        if (!signal.aborted) await processNewLines();
      });
      signal.addEventListener('abort', () => watcher.close());
    } catch {
      // File might not exist
    }

    // Process existing content
    await processNewLines();
  }

  async handleMessage(sessionId, message) {
    // Check for user prompt (role=user)
    if (message.role === 'user' && typeof message.content === 'string') {
      await this.emitEvent('UserPromptReceived', sessionId, {
        session_id: sessionId,
        prompt: message.content,
      }, 'stdin_message');
      return;
    }

    const eventType = TYPE_MAP[message.type];
    if (!eventType) return;

    await this.emitEvent(eventType, sessionId, {
      session_id: sessionId,
      ...message,
    }, message.type || eventType);
  }

  async emitEvent(eventType, sessionId, data, nativeEvent) {
    // Implementation: POST to daemon socket or fall back to capture-event CLI
  }
}
```

`src/lib/agentctx_codex.sh`:

```bash
# Codex watcher installation functions

CODEX_SESSION_DIR="${HOME}/.codex/sessions"

agentctx_codex_install() {
  local force="${1:-false}"

  agentctx_msg ""
  agentctx_msg "Codex Integration"

  # Ensure session directory exists (or will be created by watcher)
  agentctx_msg "  Session directory: $CODEX_SESSION_DIR"

  # Write watcher configuration
  mkdir -p "$AGENTCTX_INTEGRATIONS_DIR/codex"
  cat > "$AGENTCTX_INTEGRATIONS_DIR/codex/watcher.json" << EOF
{
  "session_dir": "$CODEX_SESSION_DIR",
  "enabled": true,
  "poll_interval_ms": 500,
  "max_concurrent_watchers": 10
}
EOF

  # Update daemon config
  agentctx_config_set '.integrations.codex.enabled' 'true'
  agentctx_config_set '.integrations.codex.session_dir' "\"$CODEX_SESSION_DIR\""

  agentctx_msg "  Codex session watcher configured"
  agentctx_msg "  Watcher: enabled (starts with daemon)"
  return 0
}
```

**Acceptance Criteria**

- [ ] `agentctx install --codex` writes watcher configuration to `~/.agentctx/integrations/codex/watcher.json`
- [ ] `config.json` is updated with `integrations.codex.enabled: true` and `session_dir`
- [ ] The watcher module (`watcher.mjs`) watches `~/.codex/sessions/` for new directories
- [ ] `SessionStarted` is emitted when a new session directory is detected
- [ ] JSONL messages are tailed in real-time with correct byte offset tracking
- [ ] All 6 JSONL message types (`tool_use`, `tool_result`, `tool_error`, `turn_end`, `permission`, `permission_response`) are mapped correctly
- [ ] User prompts are detected from messages with `role: "user"`
- [ ] File truncation is detected (file size < offset) and offset is reset to 0
- [ ] Existing sessions are detected on watcher startup
- [ ] The watcher cleans up file watchers and intervals when a session ends
- [ ] Silent failure on all error paths -- malformed JSONL lines are skipped
- [ ] Max 10 concurrent session watchers to prevent resource exhaustion

**Edge Cases**

- `~/.codex/sessions/` does not exist at startup: watcher creates it and waits
- `messages.jsonl` does not exist when session directory appears: watcher polls until it appears
- `messages.jsonl` is truncated mid-session: offset reset, re-process from start
- Very large JSONL file (100K+ lines): offset tracking prevents re-reading; only new lines processed
- Codex process exits but session directory remains: `SessionEnded` emitted via process monitoring
- Multiple Codex sessions running simultaneously: each gets its own watcher instance

**Estimated Effort**: L (Large) -- 5-7 hours

---

### Task 8: Custom Hook Extensions (`agentctx hooks` subcommand)

**Description**

Implement the custom hook extension protocol that allows users to integrate future coding agents with AgentContext. Custom hooks are executables that communicate via a JSONL stdin/stdout protocol. The daemon manages their lifecycle with automatic restart and exponential backoff.

**Prerequisites/Inputs**

- Task 1 (event type validation for custom hook output)
- Task 4 (CLI scaffolding)
- Story 09 requirement Section 8 (Custom Hook Extensions)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/bin/agentctx-hooks` | Create | `agentctx hooks add/remove/list/enable/disable` subcommands |
| `src/lib/agentctx_custom_hooks.sh` | Create | Custom hook validation, registration, lifecycle |
| `src/integrations/custom/hook-runner.mjs` | Create | Node.js module that manages custom hook processes |
| `src/schemas/hook-manifest.schema.json` | Create | JSON Schema for custom hook manifests |
| `tests/bin/test_agentctx_hooks.sh` | Create | Custom hook management tests |

`src/bin/agentctx-hooks`:

```bash
# agentctx hooks subcommand
# Usage: agentctx hooks <add|remove|list|enable|disable>

agentctx_hooks() {
  local subcommand="${1:-list}"
  shift || true

  source "$LIB_DIR/agentctx_custom_hooks.sh"

  case "$subcommand" in
    add)     agentctx_hooks_add "$@" ;;
    remove)  agentctx_hooks_remove "$@" ;;
    list)    agentctx_hooks_list ;;
    enable)  agentctx_hooks_enable "$@" ;;
    disable) agentctx_hooks_disable "$@" ;;
    *)
      agentctx_err "Unknown hooks subcommand: $subcommand"
      echo "Usage: agentctx hooks <add|remove|list|enable|disable>"
      return 1
      ;;
  esac
}
```

`src/lib/agentctx_custom_hooks.sh`:

```bash
# Custom hook management functions

# Validate a hook manifest
agentctx_validate_hook_manifest() {
  local manifest_path="$1"

  # Check file exists and is valid JSON
  if [ ! -f "$manifest_path" ]; then
    agentctx_err "Manifest not found: $manifest_path"
    return 1
  fi

  if ! jq . "$manifest_path" >/dev/null 2>&1; then
    agentctx_err "Invalid JSON in manifest: $manifest_path"
    return 1
  fi

  # Required fields
  local name version agent_provider executable
  name=$(jq -r '.name // empty' "$manifest_path")
  version=$(jq -r '.version // empty' "$manifest_path")
  agent_provider=$(jq -r '.agent_provider // empty' "$manifest_path")
  executable=$(jq -r '.executable // empty' "$manifest_path")

  [ -z "$name" ] && agentctx_err "Manifest missing 'name'" && return 1
  [ -z "$version" ] && agentctx_err "Manifest missing 'version'" && return 1
  [ -z "$agent_provider" ] && agentctx_err "Manifest missing 'agent_provider'" && return 1
  [ -z "$executable" ] && agentctx_err "Manifest missing 'executable'" && return 1

  # Check reserved provider names
  source "$LIB_DIR/unified_events.sh"
  if gc_is_reserved_provider "$agent_provider"; then
    agentctx_err "Provider name '$agent_provider' is reserved. Choose a different name."
    return 1
  fi

  # Validate event_mapping values are valid unified event types
  local invalid_events
  invalid_events=$(jq -r '.event_mapping // {} | values[]' "$manifest_path" | while read -r etype; do
    if ! gc_validate_event_type "$etype"; then
      echo "$etype"
    fi
  done)

  if [ -n "$invalid_events" ]; then
    agentctx_err "Invalid event types in mapping: $invalid_events"
    return 1
  fi

  return 0
}

# Add a custom hook
agentctx_hooks_add() {
  local hook_dir="$1"

  if [ ! -d "$hook_dir" ]; then
    agentctx_err "Hook directory not found: $hook_dir"
    return 1
  fi

  local manifest="$hook_dir/manifest.json"
  agentctx_validate_hook_manifest "$manifest" || return 1

  local name
  name=$(jq -r '.name' "$manifest")

  # Check executable exists and is executable
  local executable
  executable=$(jq -r '.executable' "$manifest")
  local exec_path="$hook_dir/$executable"
  if [ ! -x "$exec_path" ]; then
    agentctx_err "Executable not found or not executable: $exec_path"
    return 1
  fi

  # Copy to hooks.d
  local target_dir="$AGENTCTX_HOOKS_DIR/$name"
  mkdir -p "$target_dir"
  cp -r "$hook_dir/"* "$target_dir/"
  chmod +x "$target_dir/$executable"

  # Register in config
  agentctx_config_set ".custom_hooks.\"$name\"" '{"enabled": true}'

  agentctx_msg "Custom hook '$name' installed at $target_dir"
  agentctx_msg "  Provider: $(jq -r '.agent_provider' "$manifest")"
  agentctx_msg "  Events: $(jq -r '.event_mapping | length' "$manifest") mapped"
  return 0
}

# Remove a custom hook
agentctx_hooks_remove() {
  local name="$1"

  local target_dir="$AGENTCTX_HOOKS_DIR/$name"
  if [ ! -d "$target_dir" ]; then
    agentctx_err "Hook '$name' not found"
    return 1
  fi

  # TODO: Signal daemon to stop the hook process if running

  rm -rf "$target_dir"
  agentctx_config_set ".custom_hooks.\"$name\"" 'null'

  agentctx_msg "Custom hook '$name' removed"
  return 0
}

# List all custom hooks
agentctx_hooks_list() {
  printf '%-15s %-10s %-10s %s\n' "NAME" "VERSION" "STATUS" "EVENTS"

  if [ ! -d "$AGENTCTX_HOOKS_DIR" ] || [ -z "$(ls -A "$AGENTCTX_HOOKS_DIR" 2>/dev/null)" ]; then
    agentctx_msg "No custom hooks installed."
    return 0
  fi

  for hook_dir in "$AGENTCTX_HOOKS_DIR"/*/; do
    [ ! -d "$hook_dir" ] && continue
    local manifest="$hook_dir/manifest.json"
    [ ! -f "$manifest" ] && continue

    local name version events status
    name=$(jq -r '.name' "$manifest")
    version=$(jq -r '.version' "$manifest")
    events=$(jq -r '.event_mapping | length' "$manifest")

    # Check if enabled in config
    local enabled
    enabled=$(agentctx_config_get ".custom_hooks.\"$name\".enabled" 2>/dev/null)
    status="${enabled:-stopped}"
    [ "$status" = "true" ] && status="enabled"
    [ "$status" = "false" ] && status="disabled"

    printf '%-15s %-10s %-10s %s mapped\n' "$name" "$version" "$status" "$events"
  done
}

# Enable/disable a custom hook
agentctx_hooks_enable() {
  local name="$1"
  agentctx_config_set ".custom_hooks.\"$name\".enabled" 'true'
  agentctx_msg "Hook '$name' enabled"
}

agentctx_hooks_disable() {
  local name="$1"
  agentctx_config_set ".custom_hooks.\"$name\".enabled" 'false'
  agentctx_msg "Hook '$name' disabled"
}
```

`src/integrations/custom/hook-runner.mjs`:

The hook runner is a Node.js module that the daemon uses to manage custom hook processes. Key behaviors:

- Spawns the hook executable as a child process
- Reads JSONL from the process's stdout, validates each event, and writes to the event store
- Captures stderr for diagnostic logging
- Implements exponential backoff restart: 1s, 2s, 4s, 8s, 16s, 32s, 60s (max)
- After 10 consecutive failures, marks the hook as "disabled (crash loop)" and stops restarting
- Responds to SIGTERM by sending SIGTERM to child processes

**Acceptance Criteria**

- [ ] `agentctx hooks add ./my-hook/` validates manifest, copies to `~/.agentctx/hooks.d/`, registers in config
- [ ] Manifest validation rejects missing required fields (name, version, agent_provider, executable)
- [ ] Manifest validation rejects reserved provider names (claude-code, opencode, codex)
- [ ] Manifest validation rejects unknown unified event types in `event_mapping`
- [ ] `agentctx hooks remove <name>` removes the hook directory and config entry
- [ ] `agentctx hooks list` displays all installed hooks with name, version, status, event count
- [ ] `agentctx hooks enable/disable <name>` updates the config
- [ ] The hook runner spawns the executable and reads JSONL from stdout
- [ ] Invalid JSONL lines are logged and skipped (not fatal)
- [ ] Events with unknown `event_type` are logged and dropped
- [ ] Events exceeding 10MB are logged and dropped
- [ ] Crashed hooks are restarted with exponential backoff (1s -> 60s max)
- [ ] After 10 consecutive crashes, the hook is auto-disabled with a log message

**Edge Cases**

- Hook executable is a script without shebang: may fail to execute; report clear error
- Hook produces non-JSONL output on stdout: each non-parseable line is skipped
- Hook writes to stderr: captured for diagnostics, not treated as events
- Hook process hangs (never exits, never writes): timeout after configurable period
- Two hooks with the same provider name: prevented by manifest validation
- Hook directory with no `manifest.json`: skipped during scanning

**Estimated Effort**: L (Large) -- 5-7 hours

---

### Task 9: Health Check System (`agentctx doctor`)

**Description**

Implement the `agentctx doctor` command that validates all installed hook integrations are functioning correctly. It checks system prerequisites, daemon status, event store health, and per-integration diagnostics. Each check produces a clear OK/WARN/FAIL/SKIP status.

**Prerequisites/Inputs**

- Task 2 (`agentctx-hook` for smoke testing)
- Task 5 (Claude Code hooks to validate)
- Task 6 (OpenCode plugin to validate)
- Task 7 (Codex watcher to validate)
- Task 8 (Custom hooks to validate)
- Story 09 requirement Section 6 (Hook Health Check)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/bin/agentctx-doctor` | Create | Health check implementation |
| `src/lib/agentctx_health.sh` | Create | Per-integration health check functions |
| `tests/bin/test_agentctx_doctor.sh` | Create | Health check tests |

`src/bin/agentctx-doctor`:

```bash
# agentctx doctor subcommand
# Usage: agentctx doctor [--verbose] [--fix] [--json]

agentctx_doctor() {
  local verbose=false
  local fix=false
  local json_output=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --verbose) verbose=true; shift ;;
      --fix)     fix=true; shift ;;
      --json)    json_output=true; shift ;;
      *)         shift ;;
    esac
  done

  source "$LIB_DIR/agentctx_health.sh"

  local passes=0 warnings=0 failures=0

  echo "[agentctx doctor] AgentContext Health Check"
  echo "[agentctx doctor] $(printf '%0.s-' {1..40})"

  # Category 1: System prerequisites
  echo ""
  echo "[agentctx doctor] System Prerequisites"
  check_prereq "bash" "4.0" && ((passes++)) || ((failures++))
  check_prereq "jq" "1.5" && ((passes++)) || ((failures++))
  check_prereq "node" "18.0" && ((passes++)) || ((failures++))
  check_prereq "curl" "" && ((passes++)) || ((failures++))

  # Category 2: Daemon status
  echo ""
  echo "[agentctx doctor] Daemon"
  check_daemon_status && ((passes++)) || ((warnings++))

  # Category 3: Event store
  echo ""
  echo "[agentctx doctor] Event Store"
  check_event_store && ((passes++)) || ((failures++))
  check_config_valid && ((passes++)) || ((failures++))

  # Category 4: Per-integration checks
  check_claude_code_integration "$verbose" "$fix"
  check_opencode_integration "$verbose" "$fix"
  check_codex_integration "$verbose" "$fix"
  check_custom_hooks "$verbose" "$fix"

  # Summary
  echo ""
  echo "[agentctx doctor] $(printf '%0.s-' {1..40})"
  echo "[agentctx doctor] Result: $passes checks passed, $warnings warnings, $failures failures"

  [ "$failures" -eq 0 ] && return 0 || return 1
}
```

`src/lib/agentctx_health.sh`:

Key health check functions for each integration (as specified in Story 09 Section 6.3). The Claude Code check includes:
1. `settings.json` exists
2. All 10 hooks present
3. `agentctx-hook` is executable
4. Smoke test (pipe test JSON, verify exit 0)
5. No stale GC hooks

The OpenCode check includes:
1. Plugin directory exists
2. `plugin.json` is valid JSON
3. All 9 event subscriptions present
4. All plugin files intact

The Codex check includes:
1. Watcher configured in daemon config
2. Session directory accessible
3. `codex` binary available

Integrations that are not installed are reported as SKIP, not FAIL.

The `--fix` flag attempts auto-repair:

| Issue | Fix Action |
|---|---|
| Missing hooks in `settings.json` | Re-run `agentctx install --claude-code` |
| `agentctx-hook` not executable | `chmod +x` |
| Missing OpenCode plugin files | Re-copy from source |
| Stale GC hooks | Replace with agentctx hooks |
| Missing event store directories | `mkdir -p` |
| Stale lock files | Remove `.lock` files older than 1 hour |
| Invalid `config.json` | Regenerate with defaults |

**Acceptance Criteria**

- [ ] `agentctx doctor` runs health checks across all categories
- [ ] System prerequisites check validates bash, jq, node, curl with version minimums
- [ ] Daemon status check verifies socket and PID file
- [ ] Event store check verifies directory exists and is writable
- [ ] Claude Code check verifies `settings.json`, 10 hooks, executable wrapper, smoke test
- [ ] OpenCode check verifies plugin directory, manifest, subscriptions, files
- [ ] Codex check verifies watcher config, session directory
- [ ] Integrations not installed are reported as SKIP, not FAIL
- [ ] Output uses consistent `OK`/`WARN`/`FAIL`/`SKIP` status indicators
- [ ] `--verbose` shows additional detail per check
- [ ] `--fix` attempts to resolve common issues and reports what was fixed
- [ ] Exit code is 0 when all checks pass, 1 when any check fails
- [ ] Summary line reports total passes, warnings, and failures

**Edge Cases**

- No integrations installed: all integration checks show SKIP, overall passes
- Daemon not running: daemon check shows WARN (not FAIL -- daemon is optional for fallback mode)
- `settings.json` owned by another user: permission error; report clearly
- Smoke test leaves no residual files
- `--fix` with no fixable issues: reports "nothing to fix"

**Estimated Effort**: L (Large) -- 5-7 hours

---

### Task 10: GC-to-AgentCtx Migration

**Description**

Implement the migration logic that transitions an existing GlobalContext installation (Stories 00-06) to the new AgentContext multi-agent system. This includes replacing `gc-hook` references in `settings.json` with `agentctx-hook`, preserving existing event data, and ensuring backward compatibility for events that lack the new unified envelope fields.

**Prerequisites/Inputs**

- Task 5 (Claude Code installer, which performs the actual hook replacement)
- Task 3 (enhanced `capture-event` with backward-compatible defaults)
- Existing GC installation at `~/.claude-context/`

**Implementation Details**

Files to create/modify:

| File | Action | Purpose |
|---|---|---|
| `src/lib/agentctx_migrate.sh` | Create | Migration detection and execution functions |
| `tests/bin/test_agentctx_migrate.sh` | Create | Migration tests |

`src/lib/agentctx_migrate.sh`:

```bash
# Migration from standalone GlobalContext to AgentContext

# Detect if GlobalContext is installed
agentctx_detect_gc() {
  local gc_base="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"
  [ -d "$gc_base" ] && [ -f "$gc_base/VERSION" ]
}

# Detect if gc-hook entries exist in settings.json
agentctx_detect_gc_hooks() {
  local settings="$HOME/.claude/settings.json"
  [ -f "$settings" ] && \
    jq -e '.hooks // empty | to_entries[] | .value[] | select(.command | contains("gc-hook"))' "$settings" >/dev/null 2>&1
}

# Perform migration
agentctx_migrate_from_gc() {
  local gc_base="${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}"

  agentctx_msg "Migration from GlobalContext"
  agentctx_msg "  GC store: $gc_base"

  # Step 1: Verify GC event data exists
  local event_count
  event_count=$(find "$gc_base/events" -name '*.json' -type f 2>/dev/null | wc -l)
  agentctx_msg "  Existing events: $event_count"

  # Step 2: GC event data stays in place -- no data migration needed
  # The unified envelope is backward-compatible. Events without agent_provider
  # default to "claude-code" when read by projections (Task 1 Node.js module).
  agentctx_msg "  Event data preserved at $gc_base (no migration needed)"

  # Step 3: Replace gc-hook with agentctx-hook in settings.json
  # This is handled by agentctx_install_claude_code (Task 5) which
  # detects gc-hook entries and replaces them.
  if agentctx_detect_gc_hooks; then
    agentctx_msg "  Replacing gc-hook entries in settings.json..."
    # Task 5's merge logic handles this
  fi

  # Step 4: Copy GC bin/lib to agentctx (so the fallback path works)
  if [ -f "$gc_base/bin/capture-event" ]; then
    mkdir -p "$AGENTCTX_BIN"
    cp "$gc_base/bin/capture-event" "$AGENTCTX_BIN/capture-event"
    chmod 755 "$AGENTCTX_BIN/capture-event"
    agentctx_msg "  Copied capture-event to agentctx bin/"
  fi

  # Step 5: Create symlink from agentctx event store to GC event store
  # (or configure agentctx to use the same path)
  agentctx_config_set '.event_store_path' "\"$gc_base\""
  agentctx_msg "  Event store path configured: $gc_base"

  agentctx_msg "  Migration complete. Existing events are accessible."
  return 0
}
```

The migration is triggered automatically during `agentctx install --claude-code` when GC hooks are detected. The key principle is that **no data migration occurs** -- the unified event envelope is backward-compatible, and the projection engine handles missing fields with defaults.

**Acceptance Criteria**

- [ ] `agentctx_detect_gc` correctly identifies an existing GC installation
- [ ] `agentctx_detect_gc_hooks` correctly identifies `gc-hook` entries in `settings.json`
- [ ] Existing GC events at `~/.claude-context/` are preserved (never modified or deleted)
- [ ] `gc-hook` entries in `settings.json` are replaced with `agentctx-hook` entries
- [ ] User-defined hooks in `settings.json` are preserved during migration
- [ ] The event store path is configured in `config.json` to point to the existing GC store
- [ ] `capture-event` is copied to `~/.agentctx/bin/` for fallback use
- [ ] Events without `agent_provider` default to `"claude-code"` when read by the Node.js module
- [ ] Events without `agent_metadata` default to `{}` when read by the Node.js module
- [ ] `agentctx doctor` passes after migration

**Edge Cases**

- GC is installed but has zero events: migration still completes (just replaces hooks)
- GC `capture-event` has been modified by user: copy overwrites with the agentctx version
- GC store is at a non-default path (via `CLAUDE_CONTEXT_PATH`): migration uses the same env var
- Both GC and agentctx hooks already exist in `settings.json`: GC hooks are removed, agentctx hooks are updated
- GC VERSION file missing (very old install): treat as unversioned; proceed anyway

**Estimated Effort**: M (Medium) -- 2-3 hours

---

### Task 11: Hot-Reload Configuration Watcher

**Description**

Implement the hot-reload system that watches hook configuration files for changes and applies updates without restarting running agents. This includes file watchers with debouncing, content-hash comparison to avoid redundant processing, and the `agentctx reload` command for manual triggering.

**Prerequisites/Inputs**

- Task 5 (Claude Code hooks to watch/validate)
- Task 6 (OpenCode plugin config to watch)
- Task 7 (Codex watcher config to watch)
- Story 09 requirement Section 7 (Hot-Reload Hooks)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `src/daemon/config-watcher.mjs` | Create | Node.js file watcher with debounce and hash comparison |
| `src/bin/agentctx-reload` | Create | `agentctx reload` command (signals daemon via socket or direct) |
| `tests/daemon/test_config_watcher.mjs` | Create | Config watcher tests |

`src/daemon/config-watcher.mjs`:

The implementation follows Story 09 Section 7.2 exactly:

```javascript
import { watch } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';

export class HookConfigWatcher {
  constructor(options = {}) {
    this.watchers = [];
    this.targets = [];
    this.debounceTimers = new Map();
    this.debounceMs = options.debounceMs || 500;
    this.onReload = options.onReload || (() => {});
  }

  async start() {
    const home = process.env.HOME;
    const agentctxDir = process.env.AGENTCTX_HOME || `${home}/.agentctx`;

    this.addTarget({
      path: `${home}/.claude/settings.json`,
      agent: 'claude-code',
      handler: this.handleClaudeCodeChange.bind(this),
    });

    this.addTarget({
      path: `${home}/.opencode/plugins/agentctx/plugin.json`,
      agent: 'opencode',
      handler: this.handleOpenCodeChange.bind(this),
    });

    this.addTarget({
      path: `${agentctxDir}/config.json`,
      agent: 'all',
      handler: this.handleDaemonConfigChange.bind(this),
    });
  }

  addTarget(target) {
    const fullTarget = { ...target, lastHash: '' };
    this.targets.push(fullTarget);

    try {
      const watcher = watch(target.path, () => {
        const existing = this.debounceTimers.get(target.path);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          target.path,
          setTimeout(() => this.processChange(fullTarget), this.debounceMs)
        );
      });
      this.watchers.push(watcher);
    } catch {
      // File does not exist yet
    }
  }

  async processChange(target) {
    try {
      const content = await readFile(target.path, 'utf8');
      const hash = createHash('sha256').update(content).digest('hex');

      if (hash === target.lastHash) return;
      target.lastHash = hash;

      await target.handler(content);
      this.onReload(target.agent, target.path);
    } catch (err) {
      console.error(`[agentctx] Failed to hot-reload ${target.path}: ${err.message}`);
    }
  }

  async handleClaudeCodeChange(content) {
    try {
      const config = JSON.parse(content);
      const hooks = config.hooks || {};
      const agentctxHooks = Object.values(hooks)
        .flat()
        .filter(h => h.command && h.command.includes('agentctx-hook'));

      if (agentctxHooks.length < 10) {
        console.warn(
          `[agentctx] WARN: Claude Code hooks modified externally. ${agentctxHooks.length} of 10 hooks present.`
        );
        console.warn("[agentctx] WARN: Run 'agentctx install --claude-code' to restore.");
      }
    } catch {
      console.error('[agentctx] WARN: settings.json is not valid JSON');
    }
  }

  async handleOpenCodeChange(content) {
    try {
      const manifest = JSON.parse(content);
      const events = manifest.events || [];
      if (events.length !== 9) {
        console.warn(`[agentctx] WARN: OpenCode plugin subscriptions changed: ${events.length}/9`);
      }
    } catch {
      console.error('[agentctx] WARN: OpenCode plugin.json is not valid JSON');
    }
  }

  async handleDaemonConfigChange(content) {
    try {
      const config = JSON.parse(content);
      // Apply integration enable/disable changes
      // Start/stop watchers as needed
      this.onReload('all', 'config.json');
    } catch {
      console.error('[agentctx] WARN: config.json is not valid JSON');
    }
  }

  stop() {
    this.watchers.forEach(w => w.close());
    this.debounceTimers.forEach(t => clearTimeout(t));
    this.watchers = [];
    this.debounceTimers.clear();
  }
}
```

`src/bin/agentctx-reload`:

```bash
# agentctx reload -- force re-read of all hook configuration files

agentctx_reload() {
  agentctx_msg "Reloading hook configurations..."

  # If daemon is running, send SIGHUP
  if [ -f "$AGENTCTX_DAEMON_PID" ]; then
    local pid
    pid=$(cat "$AGENTCTX_DAEMON_PID")
    if kill -0 "$pid" 2>/dev/null; then
      kill -HUP "$pid"
      agentctx_msg "  Sent SIGHUP to daemon (PID $pid)"
      sleep 1
      agentctx_msg "  All integrations reloaded."
      return 0
    fi
  fi

  # If daemon is not running, validate configs directly
  agentctx_msg "  Daemon not running -- validating configs directly..."

  # Validate Claude Code hooks
  if [ -f "$HOME/.claude/settings.json" ]; then
    source "$LIB_DIR/agentctx_claude_code.sh"
    if agentctx_cc_validate_hooks; then
      agentctx_msg "  Claude Code .... valid (10 hooks)"
    else
      agentctx_warn "  Claude Code .... hooks incomplete"
    fi
  fi

  # Validate OpenCode plugin
  if [ -d "$HOME/.opencode/plugins/agentctx" ]; then
    source "$LIB_DIR/agentctx_opencode.sh"
    if agentctx_oc_validate; then
      agentctx_msg "  OpenCode ....... valid (9 subscriptions)"
    else
      agentctx_warn "  OpenCode ....... plugin invalid"
    fi
  fi

  # Validate Codex config
  local codex_enabled
  codex_enabled=$(agentctx_config_get '.integrations.codex.enabled' 2>/dev/null)
  if [ "$codex_enabled" = "true" ]; then
    agentctx_msg "  Codex .......... config valid"
  fi

  agentctx_msg "  Validation complete."
  return 0
}
```

**Acceptance Criteria**

- [ ] The config watcher monitors `~/.claude/settings.json`, `~/.opencode/plugins/agentctx/plugin.json`, and `~/.agentctx/config.json`
- [ ] Changes are detected within 1 second of file modification
- [ ] Debounce (500ms) prevents processing partial file writes
- [ ] SHA-256 hash comparison skips unchanged files
- [ ] Missing hooks in `settings.json` are detected and a warning is logged (not auto-fixed)
- [ ] OpenCode plugin subscription changes are detected
- [ ] `agentctx reload` sends SIGHUP to the daemon if running
- [ ] `agentctx reload` validates configs directly if daemon is not running
- [ ] Invalid config changes are logged as warnings but do not crash the watcher
- [ ] The watcher logs what was changed for diagnostic purposes
- [ ] `stop()` cleans up all file watchers and timers

**Edge Cases**

- Watched file does not exist when watcher starts: silently skip; it will be detected on next install
- File is deleted while being watched: watcher handles the error gracefully
- File is replaced atomically (write to temp + rename): watcher detects the rename event
- Multiple rapid changes (editor save + format): debounce coalesces them
- Daemon PID file exists but process is dead: `agentctx reload` detects stale PID and reports

**Estimated Effort**: M (Medium) -- 3-4 hours

---

### Task 12: Integration & End-to-End Tests

**Description**

Create a comprehensive test suite covering all multi-agent hook system functionality. Tests are organized by integration and cover unit, integration, and end-to-end scenarios. All tests use isolated temporary directories and never touch the real user environment.

**Prerequisites/Inputs**

- All tasks (1-11)
- Existing test harness pattern from Story 00 (`plans/00-installation-plan.md` Task 8)

**Implementation Details**

Files to create:

| File | Action | Purpose |
|---|---|---|
| `tests/09-unified-events.sh` | Create | Unified event type validation tests |
| `tests/09-agentctx-hook.sh` | Create | Hook wrapper tests |
| `tests/09-capture-event-unified.sh` | Create | Enhanced capture-event tests |
| `tests/09-install-claude-code.sh` | Create | Claude Code installer tests |
| `tests/09-install-opencode.sh` | Create | OpenCode installer tests |
| `tests/09-install-codex.sh` | Create | Codex installer tests |
| `tests/09-custom-hooks.sh` | Create | Custom hook management tests |
| `tests/09-doctor.sh` | Create | Health check tests |
| `tests/09-migration.sh` | Create | GC-to-AgentCtx migration tests |
| `tests/09-hot-reload.mjs` | Create | Config watcher tests (Node.js) |
| `tests/09-codex-watcher.mjs` | Create | Codex JSONL watcher tests (Node.js) |
| `tests/09-end-to-end.sh` | Create | Full lifecycle end-to-end tests |
| `tests/09-all.sh` | Create | Runner script for all test files |

**Test Cases by Category**

#### Unified Events (tests/09-unified-events.sh)
| # | Test | Story Ref |
|---|---|---|
| 1 | All 12 unified event types validate | T-01 |
| 2 | Unknown event type is rejected | T-09 |
| 3 | All 4 agent providers validate | Req 1.1 |
| 4 | Reserved provider names are detected | E-9 |
| 5 | Unified envelope includes all 10 fields | T-10 |
| 6 | Envelope backward-compatible with Story 01 (7 original fields) | Req 1.5 |
| 7 | Claude Code mapping covers 10 events | T-02 |
| 8 | OpenCode mapping covers 9 events | T-03 |
| 9 | Codex mapping covers 6 events | T-04 |

#### Hook Wrapper (tests/09-agentctx-hook.sh)
| # | Test | Story Ref |
|---|---|---|
| 10 | Hook exits 0 when daemon socket missing | T-11 |
| 11 | Hook exits 0 when capture-event crashes | T-12 |
| 12 | Hook produces no stdout | T-13 |
| 13 | Hook produces no stderr | T-14 |
| 14 | Hook falls back to direct file write | T-15 |
| 15 | Hook reads stdin payload correctly | Req 2.4 |

#### Capture-Event Unified (tests/09-capture-event-unified.sh)
| # | Test | Story Ref |
|---|---|---|
| 16 | Default agent_provider is "claude-code" | T-33 |
| 17 | --agent-provider flag overrides default | Req 1.3 |
| 18 | --agent-native-event is included in envelope | Req 1.3 |
| 19 | Default agent_metadata is {} | T-34 |
| 20 | --agent-metadata JSON is included | Req 1.3 |
| 21 | Invalid --agent-metadata defaults to {} | Edge case |

#### Claude Code Installer (tests/09-install-claude-code.sh)
| # | Test | Story Ref |
|---|---|---|
| 22 | Fresh install creates all 10 hooks | T-39 |
| 23 | Detects and migrates GC hooks | T-20 |
| 24 | Idempotent: running twice produces same result | T-21 |
| 25 | Preserves user-defined hooks | Req 5.3 |
| 26 | Backup of settings.json is created | Req 5.3 |
| 27 | Validates 10 hooks after merge | Req 5.3 |

#### OpenCode Installer (tests/09-install-opencode.sh)
| # | Test | Story Ref |
|---|---|---|
| 28 | Creates plugin directory with all files | T-40 |
| 29 | Plugin manifest has 9 event subscriptions | T-22 |
| 30 | Plugin files are all present | Req 3.1 |
| 31 | Running twice overwrites cleanly | Req 5.4 |

#### Codex Installer (tests/09-install-codex.sh)
| # | Test | Story Ref |
|---|---|---|
| 32 | Writes watcher config | T-41 |
| 33 | Updates daemon config with enabled + session_dir | Req 5.5 |

#### Custom Hooks (tests/09-custom-hooks.sh)
| # | Test | Story Ref |
|---|---|---|
| 34 | Valid manifest is accepted | Req 8.2 |
| 35 | Missing required fields rejected | Req 8.2 |
| 36 | Reserved provider names rejected | T-26, E-9 |
| 37 | Unknown event types in mapping rejected | T-27 |
| 38 | add copies to hooks.d and registers | Req 8.5 |
| 39 | remove deletes directory and config | Req 8.5 |
| 40 | list shows all installed hooks | Req 8.5 |

#### Health Check (tests/09-doctor.sh)
| # | Test | Story Ref |
|---|---|---|
| 41 | Passes on healthy installation | T-43 |
| 42 | Detects missing Claude Code hooks | T-44 |
| 43 | Detects broken OpenCode plugin | T-45 |
| 44 | Reports SKIP for uninstalled integrations | T-32 |
| 45 | --fix restores missing hooks | T-46 |
| 46 | Summary reports correct counts | Req 6.4 |
| 47 | Exit 0 on all pass, exit 1 on failure | Req 6.2 |

#### Migration (tests/09-migration.sh)
| # | Test | Story Ref |
|---|---|---|
| 48 | Detects existing GC installation | T-52 |
| 49 | Preserves existing GC events | T-52 |
| 50 | Replaces gc-hook with agentctx-hook | T-52 |
| 51 | Events without agent_provider default correctly | T-33 |

#### End-to-End (tests/09-end-to-end.sh)
| # | Test | Story Ref |
|---|---|---|
| 52 | Claude Code hook fires, event reaches store with correct envelope | T-36 |
| 53 | agentctx install --all detects and installs all integrations | T-42 |
| 54 | Daemon fallback: events captured via file write when daemon is down | T-54 |
| 55 | Multiple agents same project: events tagged with correct provider | T-53 |

**Test Harness**

All shell tests use the same isolated setup/teardown pattern from Story 00 (Task 8), with `$HOME`, `AGENTCTX_HOME`, and `CLAUDE_CONTEXT_PATH` overridden to temp directories. Node.js tests use a similar pattern with `os.tmpdir()` and environment variable overrides.

**Acceptance Criteria**

- [ ] All 55 test cases pass
- [ ] All tests run in isolated temp directories (no real environment modification)
- [ ] `tests/09-all.sh` runs all test files and reports aggregate results
- [ ] Node.js tests can be run independently with `node --test`
- [ ] Shell tests produce clear PASS/FAIL output per test case
- [ ] No test depends on external agent binaries being installed (mocked/stubbed)

**Edge Cases**

- Tests must work on both Linux and macOS
- Tests must not assume the presence of `claude`, `opencode`, or `codex` binaries
- Tests that need process monitoring must use test helper processes

**Estimated Effort**: XL (Extra Large) -- 8-12 hours

---

## File Summary

All file paths are relative to `/home/meywd/GlobalContext/`.

| File | Action | Task(s) |
|---|---|---|
| `src/lib/unified_events.sh` | Create | 1 |
| `src/lib/unified_events.mjs` | Create | 1 |
| `src/schemas/unified-event.schema.json` | Create | 1 |
| `src/schemas/agent-mapping.json` | Create | 1 |
| `src/bin/agentctx-hook` | Create | 2 |
| `src/capture-event` | Modify | 3 |
| `src/bin/agentctx` | Create | 4 |
| `src/lib/agentctx_config.sh` | Create | 4 |
| `src/lib/agentctx_paths.sh` | Create | 4 |
| `src/lib/agentctx_detect.sh` | Create | 4 |
| `src/lib/agentctx_output.sh` | Create | 4 |
| `src/bin/agentctx-install` | Create | 5, 6, 7 |
| `src/lib/agentctx_claude_code.sh` | Create | 5 |
| `src/data/claude-code-hooks.json` | Create | 5 |
| `src/integrations/opencode/plugin.json` | Create | 6 |
| `src/integrations/opencode/index.ts` | Create | 6 |
| `src/integrations/opencode/event-handler.ts` | Create | 6 |
| `src/lib/agentctx_opencode.sh` | Create | 6 |
| `src/integrations/codex/watcher.mjs` | Create | 7 |
| `src/integrations/codex/codex-mapping.json` | Create | 7 |
| `src/lib/agentctx_codex.sh` | Create | 7 |
| `src/bin/agentctx-hooks` | Create | 8 |
| `src/lib/agentctx_custom_hooks.sh` | Create | 8 |
| `src/integrations/custom/hook-runner.mjs` | Create | 8 |
| `src/schemas/hook-manifest.schema.json` | Create | 8 |
| `src/bin/agentctx-doctor` | Create | 9 |
| `src/lib/agentctx_health.sh` | Create | 9 |
| `src/lib/agentctx_migrate.sh` | Create | 10 |
| `src/daemon/config-watcher.mjs` | Create | 11 |
| `src/bin/agentctx-reload` | Create | 11 |
| `tests/09-unified-events.sh` | Create | 12 |
| `tests/09-agentctx-hook.sh` | Create | 12 |
| `tests/09-capture-event-unified.sh` | Create | 12 |
| `tests/09-install-claude-code.sh` | Create | 12 |
| `tests/09-install-opencode.sh` | Create | 12 |
| `tests/09-install-codex.sh` | Create | 12 |
| `tests/09-custom-hooks.sh` | Create | 12 |
| `tests/09-doctor.sh` | Create | 12 |
| `tests/09-migration.sh` | Create | 12 |
| `tests/09-hot-reload.mjs` | Create | 12 |
| `tests/09-codex-watcher.mjs` | Create | 12 |
| `tests/09-end-to-end.sh` | Create | 12 |
| `tests/09-all.sh` | Create | 12 |

---

## Implementation Order (Recommended)

| Phase | Tasks | Milestone | Est. Time |
|-------|-------|-----------|-----------|
| **Phase 1: Data Contract** | Task 1 (Unified Events) | Event types, mapping, schema defined | 3-4 hours |
| **Phase 2: Core Infrastructure** | Task 3 (capture-event), Task 4 (CLI scaffold) | Enhanced capture-event, agentctx CLI skeleton | 5-7 hours |
| **Phase 3: Claude Code Integration** | Task 2 (agentctx-hook), Task 5 (CC installer), Task 10 (migration) | Claude Code hooks working via agentctx-hook | 8-12 hours |
| **Phase 4: OpenCode Integration** | Task 6 (OpenCode plugin) | OpenCode plugin installed and validated | 3-4 hours |
| **Phase 5: Codex Integration** | Task 7 (Codex watcher) | Codex JSONL watcher running | 5-7 hours |
| **Phase 6: Extensions & Management** | Task 8 (Custom hooks), Task 9 (Doctor), Task 11 (Hot-reload) | Full management CLI working | 13-18 hours |
| **Phase 7: Validation** | Task 12 (Tests) | All 55 test cases pass | 8-12 hours |

Tasks 3 and 4 can be parallelized (Phase 2). Tasks 6 and 7 can be parallelized if started after Phase 2. Tasks 8, 9, and 11 can be partially parallelized (Task 9 depends on Tasks 5-8 but can be developed concurrently with stubs).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenCode plugin API is unstable or undocumented | Medium | High (plugin may not work) | Plugin code is isolated; can be updated independently. Fallback to HTTP API polling if plugin system changes. |
| Codex session directory structure differs from expected | Medium | Medium (watcher fails) | Configurable `session_dir` path in watcher config. `agentctx doctor` detects missing directories. |
| `settings.json` format changes in a Claude Code update | Low | High (hooks silently lost) | Hot-reload watcher detects changes and warns. `agentctx doctor` validates hook presence. Backup before every modification. |
| Custom hook executables consume excessive resources | Low | Medium (system slowdown) | Exponential backoff + auto-disable after 10 crashes. Daemon monitors child process resource usage. |
| Unix socket communication fails on certain OS configurations | Low | Medium (daemon mode unavailable) | Fallback to direct file write always available. Socket path is configurable. |
| Migration from GC breaks existing projections | Very Low | High (data loss perception) | Unified envelope is strictly additive. No fields are removed or renamed. Default values fill missing fields. |
| curl not available on all systems | Low | Medium (daemon mode unavailable) | `agentctx doctor` checks for curl. Fallback path does not require curl. Could use Node.js HTTP client instead. |
| Codex JSONL file grows unbounded in long sessions | Medium | Low (memory/disk) | Offset tracking prevents re-reading. Only new lines are processed. File truncation detection resets offset. |

---

## Notes for Implementation

1. **The unified event envelope is the foundation** -- every other task depends on the data contract from Task 1. Get this right first; everything else builds on it.

2. **Backward compatibility is mandatory** -- existing GC events (Stories 01-06) must continue to work. The three new envelope fields (`agent_provider`, `agent_native_event`, `agent_metadata`) are always optional when reading. Defaults fill in missing values.

3. **agentctx-hook must be bulletproof** -- it runs inside agent hook timeouts (5 seconds for Claude Code). It must never block, never produce output, and always exit 0. Defensive coding with `|| true` and `/dev/null` redirects on every command.

4. **The daemon is optional** -- the entire system must work in "standalone mode" where the daemon is not running. The fallback path (direct file write via `capture-event`) is the safety net. The daemon adds hot-reload, custom hook management, and real-time event streaming, but is not required for basic event capture.

5. **Each integration is independently installable** -- `agentctx install --claude-code` works without OpenCode or Codex being installed, and vice versa. The config tracks which integrations are enabled.

6. **Custom hooks are a future-proofing mechanism** -- the initial implementation provides the protocol and management commands. Real custom hooks will be developed by the community. The reference implementation in the tests serves as documentation.

7. **AGENTCTX_HOME is respected everywhere** -- all scripts use `${AGENTCTX_HOME:-$HOME/.agentctx}` for the installation directory, parallel to how GC uses `${CLAUDE_CONTEXT_PATH:-$HOME/.claude-context}` for the event store.

8. **The event store location is shared with GC** -- by default, both GC and agentctx use `~/.claude-context/` for the event store. This may need to be reconsidered in a future story if agentctx needs its own store path (e.g., `~/.agentctx/events/`), but for now backward compatibility with GC takes priority.

9. **Platform compatibility** -- all shell scripts must work on both Linux and macOS. Key differences to handle: `stat` flags, `sha256sum` vs `shasum`, `inotifywait` vs `fswatch` for file monitoring (the Node.js `fs.watch` abstracts this for the daemon).

10. **No npm dependencies** -- following the GC convention, the Node.js modules (watcher, config-watcher, hook-runner) use only Node.js built-in APIs. No `package.json` or `node_modules` required.

---

## Effort Estimates

| Task | Complexity | Estimate |
|---|---|---|
| Task 1: Unified Event Type System & Envelope | M | 3-4 hours |
| Task 2: agentctx-hook Wrapper Script | S | 2-3 hours |
| Task 3: capture-event Enhancement | M | 2-3 hours |
| Task 4: agentctx CLI Scaffolding | M | 3-4 hours |
| Task 5: Claude Code Installer | L | 4-6 hours |
| Task 6: OpenCode Plugin Integration | M | 3-4 hours |
| Task 7: Codex Watcher Integration | L | 5-7 hours |
| Task 8: Custom Hook Extensions | L | 5-7 hours |
| Task 9: Health Check System | L | 5-7 hours |
| Task 10: GC-to-AgentCtx Migration | M | 2-3 hours |
| Task 11: Hot-Reload Configuration Watcher | M | 3-4 hours |
| Task 12: Integration & End-to-End Tests | XL | 8-12 hours |
| **Total** | | **~45-64 hours (~6-8 working days)** |

Note: The upper range of the total estimate (80 hours / 16 days in the header) accounts for debugging, integration issues between tasks, and platform-specific compatibility work that is difficult to estimate precisely.
