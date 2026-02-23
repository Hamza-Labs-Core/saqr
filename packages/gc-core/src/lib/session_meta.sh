#!/usr/bin/env bash
# session_meta.sh -- Per-session metadata (session.json) creation and update logic
# Each session directory contains its own session.json, updated within the
# existing per-session flock scope. No global shared state. No additional locks.
# Replaces the original global sessions.json design (Design Amendments 1 & 2).
set -euo pipefail

# Source dependencies
_SESSION_META_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_SESSION_META_DIR}/paths.sh"
# shellcheck source=atomic_write.sh
source "${_SESSION_META_DIR}/atomic_write.sh"

# gc_session_meta_create session_dir session_id project_id project_dir source model started_at
#
# Creates session.json in the session directory with initial values.
# Sets event_count to 1, last_event_at to started_at, last_event_type to "SessionStarted".
# Called when the first event (SessionStarted) for a session is written.
gc_session_meta_create() {
  local session_dir="$1"
  local session_id="$2"
  local project_id="$3"
  local project_dir="$4"
  local source_val="$5"
  local model="$6"
  local started_at="$7"

  local json
  json=$(jq -n \
    --arg sid "$session_id" \
    --arg pid "$project_id" \
    --arg pdir "$project_dir" \
    --arg sat "$started_at" \
    --arg src "$source_val" \
    --arg mdl "$model" \
    '{
      session_id: $sid,
      project_id: $pid,
      project_dir: $pdir,
      started_at: $sat,
      source: $src,
      model: $mdl,
      event_count: 1,
      last_event_at: $sat,
      last_event_type: "SessionStarted",
      last_prompt: null,
      ended_at: null,
      previous_session_id: null
    }')

  gc_atomic_write "${session_dir}/session.json" "$json" false
}

# gc_session_meta_update session_dir event_type timestamp [last_prompt]
#
# Increments event_count, updates last_event_at and last_event_type.
# If event_type is "UserPromptReceived": updates last_prompt (4th arg).
# If event_type is "SessionEnded": sets ended_at.
# Uses gc_atomic_write with fsync=false (performance).
gc_session_meta_update() {
  local session_dir="$1"
  local event_type="$2"
  local timestamp="$3"
  local last_prompt="${4:-}"

  local session_file="${session_dir}/session.json"

  if [[ ! -f "$session_file" ]]; then
    echo "gc_session_meta_update: session.json not found in $session_dir" >&2
    return 1
  fi

  local current
  current="$(< "$session_file")"

  local updated
  # Base update: increment event_count, update last_event_at, last_event_type
  updated=$(printf '%s' "$current" | jq \
    --arg etype "$event_type" \
    --arg ts "$timestamp" \
    '.event_count += 1 | .last_event_at = $ts | .last_event_type = $etype')

  # Conditional updates based on event_type
  if [[ "$event_type" == "UserPromptReceived" && -n "$last_prompt" ]]; then
    updated=$(printf '%s' "$updated" | jq \
      --arg lp "$last_prompt" \
      '.last_prompt = $lp')
  fi

  if [[ "$event_type" == "SessionEnded" ]]; then
    updated=$(printf '%s' "$updated" | jq \
      --arg ts "$timestamp" \
      '.ended_at = $ts')
  fi

  gc_atomic_write "$session_file" "$updated" false
}

# gc_session_meta_read session_dir -> json
#
# Reads and returns session.json content. No lock needed for reads.
gc_session_meta_read() {
  local session_dir="$1"
  local session_file="${session_dir}/session.json"

  if [[ ! -f "$session_file" ]]; then
    echo "gc_session_meta_read: session.json not found in $session_dir" >&2
    return 1
  fi

  cat "$session_file"
}
